import { routeCode } from '../flights/route.util';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PaymentType, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.module';
import { AuthUser } from '../common/auth/decorators';
import { APP_ENV } from '../common/config/config.module';
import { Env } from '../common/config/env';
import { BookingsRepository } from '../bookings/bookings.repository';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.module';
import { paymentReceived, refundRecorded } from '../notifications/templates';
import { RecordPaymentDto } from './dto/payment.dto';
import { money, receiptNumber, summarize, summaryView } from './payments.util';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly bookings: BookingsRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: NotificationsService,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  /**
   * Records money that staff have ACTUALLY received (type PAYMENT) or handed back (type REFUND).
   * Never called from the public site. Safe against double submission, duplicate transaction references,
   * overpayment and over-refund, all decided inside one transaction under a lock on the booking.
   */
  async record(actor: AuthUser, bookingId: string, dto: RecordPaymentDto, type: PaymentType) {
    const amount = new Prisma.Decimal(dto.amount);
    const receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : new Date();
    if (Number.isNaN(receivedAt.getTime()) || receivedAt.getTime() > Date.now() + 5 * 60_000) {
      throw new BadRequestException('The date received cannot be in the future');
    }

    const replay = await this.prisma.payment.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
    if (replay) return this.replayOrConflict(replay, bookingId);

    let paymentId: string;
    try {
      paymentId = await this.prisma.$transaction(async (tx) => {
        await this.bookings.lock(tx, bookingId);
        const b = await this.bookings.findById(bookingId, tx);
        if (!b) throw new NotFoundException('Booking not found');
        if (!b.confirmedAt) throw new ConflictException('Payments can only be recorded against a confirmed booking');
        const s = summarize(b);

        if (type === 'PAYMENT') {
          if (!s.active) throw new ConflictException('This booking is cancelled; no further payment can be recorded');
          if (amount.gt(s.balance)) throw new ConflictException(`Amount exceeds the outstanding balance (NPR ${money(s.balance)})`);
        } else if (amount.gt(s.net)) {
          throw new ConflictException(`Refund exceeds the net amount paid (NPR ${money(s.net)})`);
        }

        const [{ n }] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('receipt_number_seq') AS n`;
        const p = await tx.payment.create({
          data: {
            bookingId, type, method: dto.method, amount, reference: dto.reference?.trim() || null, receivedAt,
            note: dto.note?.trim() || null, idempotencyKey: dto.idempotencyKey, recordedById: actor.id,
            receiptNumber: receiptNumber(Number(n), receivedAt),
          },
        });
        await this.audit.record(
          { actorId: actor.id, action: type === 'PAYMENT' ? 'payment.record' : 'refund.record', entityType: 'Booking', entityId: bookingId, detail: { receipt: p.receiptNumber, amount: money(amount), method: dto.method } },
          tx,
        );
        return p.id;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await this.prisma.payment.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
        if (again) return this.replayOrConflict(again, bookingId); // same click arrived twice
        throw new ConflictException('A payment with this method and reference number has already been recorded');
      }
      throw e;
    }

    const full = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    await this.emailReceipt(full.id).catch(() => undefined); // an email problem never undoes a recorded payment
    return this.view(full);
  }

  /** Mark a mistaken entry as void. Totals ignore it; the row and its receipt number stay on record. */
  async voidPayment(actor: AuthUser, paymentId: string, reason: string) {
    const existing = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!existing) throw new NotFoundException('Payment not found');
    await this.prisma.$transaction(async (tx) => {
      await this.bookings.lock(tx, existing.bookingId);
      const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      if (p.status !== 'RECORDED') throw new ConflictException('This entry is already void');
      const b = await this.bookings.findById(p.bookingId, tx);
      if (!b) throw new NotFoundException('Booking not found');
      // After voiding, refunds must still be covered by payments.
      const after = summarize({ ...b, payments: b.payments.map((x) => (x.id === p.id ? { ...x, status: 'VOIDED' as const } : x)) });
      if (after.net.lt(0)) throw new ConflictException('Voiding this payment would leave refunds larger than payments. Void the refund first.');
      await tx.payment.update({ where: { id: paymentId }, data: { status: 'VOIDED', voidedById: actor.id, voidedAt: new Date(), voidReason: reason.trim() } });
      await this.audit.record({ actorId: actor.id, action: 'payment.void', entityType: 'Booking', entityId: p.bookingId, detail: { receipt: p.receiptNumber, reason: reason.trim() } }, tx);
    });
    return this.view(await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }));
  }

  /** Everything needed to print a receipt. */
  async receipt(paymentId: string) {
    const p = await this.prisma.payment.findUnique({ where: { id: paymentId }, include: { recordedBy: { select: { name: true } } } });
    if (!p) throw new NotFoundException('Receipt not found');
    const b = await this.bookings.findById(p.bookingId);
    if (!b) throw new NotFoundException('Booking not found');
    const s = summarize(b);
    return {
      agencyName: this.env.AGENCY_NAME,
      receiptNumber: p.receiptNumber,
      type: p.type,
      status: p.status,
      voidReason: p.voidReason,
      amount: money(p.amount),
      method: p.method,
      reference: p.reference,
      receivedAt: p.receivedAt,
      note: p.note,
      recordedBy: p.recordedBy.name,
      booking: {
        reference: b.reference,
        contactName: b.contactName,
        itinerary: b.segments.map((x) => `${x.flight.airline.name} ${x.flight.flightNumber}  ${routeCode(x.flight)}`),
        passengers: b.passengers.map((x) => `${x.firstName} ${x.lastName}`),
        ...summaryView(s),
      },
    };
  }

  private view(p: { id: string; receiptNumber: string; type: PaymentType; amount: Prisma.Decimal; method: string; status: string; receivedAt: Date; bookingId: string }) {
    return { id: p.id, receiptNumber: p.receiptNumber, type: p.type, amount: money(p.amount), method: p.method, status: p.status, receivedAt: p.receivedAt, bookingId: p.bookingId };
  }

  private replayOrConflict(p: { bookingId: string } & Parameters<PaymentsService['view']>[0], bookingId: string) {
    if (p.bookingId !== bookingId) throw new ConflictException('This submission key was already used for a different booking');
    return this.view(p); // idempotent: the earlier result, no second payment
  }

  private async emailReceipt(paymentId: string): Promise<void> {
    const p = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const b = await this.bookings.findById(p.bookingId);
    if (!b) return;
    const s = summarize(b);
    const args = { receipt: p.receiptNumber, amount: money(p.amount), method: p.method, balance: money(s.balance), at: p.receivedAt };
    await this.mail.send(p.type === 'PAYMENT' ? paymentReceived(b, args, this.env.FRONTEND_ORIGIN) : refundRecorded(b, args, this.env.FRONTEND_ORIGIN));
  }
}
