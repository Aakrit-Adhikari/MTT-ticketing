import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ChangeRequestStatus, ChangeRequestType, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.module';
import { AuthUser } from '../common/auth/decorators';
import { APP_ENV } from '../common/config/config.module';
import { Env } from '../common/config/env';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.module';
import { requestAckToCustomer, requestAlertToStaff, requestResolved } from '../notifications/templates';
import { BookingsRepository } from './bookings.repository';
import { normalizeReference } from './bookings.service';
import { CreateRequestDto, ResolveRequestDto } from './dto/booking.dto';

/** States in which a customer may still ask for a change. Terminal states have nothing left to change. */
const CHANGEABLE = ['INQUIRY', 'HELD', 'CONFIRMED', 'TICKETED'];

@Injectable()
export class ChangeRequestsService {
  constructor(
    private readonly bookings: BookingsRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: NotificationsService,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  /** Customer asks (reference + email, like lookup). Nothing about the booking changes; staff are emailed. */
  async create(dto: CreateRequestDto) {
    const b = await this.bookings.findByReference(normalizeReference(dto.reference));
    if (!b || b.contactEmail !== dto.email.trim().toLowerCase()) throw new NotFoundException('No booking found for these details');
    if (!CHANGEABLE.includes(b.status)) throw new ConflictException('This booking can no longer be changed online. Please contact us.');

    try {
      await this.prisma.changeRequest.create({
        data: { bookingId: b.id, type: dto.type, message: dto.message.trim(), preferredDate: dto.type === 'RESCHEDULE' ? (dto.preferredDate ?? null) : null },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('You already have an open request of this kind for this booking. Our staff will respond soon.');
      }
      throw e;
    }
    await this.audit.record({ action: 'request.create', entityType: 'Booking', entityId: b.id, detail: { type: dto.type } });

    const site = this.env.FRONTEND_ORIGIN;
    await this.mail.send(requestAckToCustomer(b, dto.type, site));
    for (const to of (this.env.STAFF_NOTIFY_EMAIL ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
      await this.mail.send(requestAlertToStaff(b, to, dto.type, dto.message.trim(), dto.type === 'RESCHEDULE' ? (dto.preferredDate ?? null) : null, site));
    }
    return { received: true };
  }

  list(status?: ChangeRequestStatus) {
    return this.prisma.changeRequest.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: status === 'OPEN' ? 'asc' : 'desc' },
      take: 200,
      include: { booking: { select: { id: true, reference: true, status: true, contactName: true, rescheduledCount: true } } },
    });
  }

  forBooking(bookingId: string) {
    return this.prisma.changeRequest.findMany({ where: { bookingId }, orderBy: { createdAt: 'desc' } });
  }

  /**
   * Staff close a request. Cancelling the booking / moving it to another flight is done with the normal booking actions
   * first; this records the outcome, the refund staff decided (if any), and tells the customer.
   */
  async resolve(actor: AuthUser, id: string, dto: ResolveRequestDto) {
    const req = await this.prisma.changeRequest.findUnique({ where: { id }, include: { booking: true } });
    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'OPEN') throw new ConflictException('This request was already closed');
    if (req.type === ChangeRequestType.CANCEL_REFUND && dto.status === 'DONE' && req.booking.status !== 'CANCELLED') {
      throw new ConflictException('Cancel the booking first, then mark the request as done');
    }
    if (req.type === ChangeRequestType.RESCHEDULE && dto.status === 'DONE' && req.booking.rescheduledCount === 0) {
      throw new ConflictException('Reschedule the booking first, then mark the request as done');
    }
    if (dto.refundAmount && req.type !== 'CANCEL_REFUND') throw new ConflictException('A refund amount only applies to cancellation requests');

    const claimed = await this.prisma.$transaction(async (tx) => {
      const r = await tx.changeRequest.updateMany({
        where: { id, status: 'OPEN' }, // atomic: only one staff member can close it
        data: { status: dto.status, staffNote: dto.note?.trim() || null, refundAmount: dto.refundAmount ?? null, resolvedById: actor.id, resolvedAt: new Date() },
      });
      if (r.count !== 1) throw new ConflictException('This request was already closed');
      await this.audit.record({ actorId: actor.id, action: 'request.resolve', entityType: 'Booking', entityId: req.bookingId, detail: { type: req.type, outcome: dto.status } }, tx);
      return r.count;
    });
    if (claimed) {
      const b = await this.bookings.findById(req.bookingId);
      if (b) await this.mail.send(requestResolved(b, req.type, dto.status, dto.note?.trim() || null, dto.refundAmount ?? null, this.env.FRONTEND_ORIGIN));
    }
    return this.list('OPEN');
  }
}
