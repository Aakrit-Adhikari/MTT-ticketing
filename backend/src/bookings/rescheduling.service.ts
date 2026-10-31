import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { SeatState } from '@prisma/client';
import { AuditService } from '../audit/audit.module';
import { AuthUser } from '../common/auth/decorators';
import { APP_ENV } from '../common/config/config.module';
import { Env } from '../common/config/env';
import { PrismaService } from '../database/prisma.service';
import { FlightsRepository } from '../flights/flights.repository';
import { InventoryRepository } from '../inventory/inventory.repository';
import { NotificationsService } from '../notifications/notifications.module';
import { bookingRescheduled } from '../notifications/templates';
import { BookingsRepository } from './bookings.repository';
import { RescheduleDto } from './dto/booking.dto';
import { assertTicketLines } from './tickets.util';

interface SeatMove {
  flightId: string;
  seats: number;
  from: SeatState;
  to: SeatState;
}

/**
 * Moves a booking to another flight on the SAME route. All seat movements (release old, take new) happen in one
 * transaction, so a failure leaves the booking exactly as it was. The original flight stays on record.
 * Fare differences are not calculated here; staff settle them with the customer (payments arrive in a later phase).
 */
@Injectable()
export class ReschedulingService {
  constructor(
    private readonly repo: BookingsRepository,
    private readonly flights: FlightsRepository,
    private readonly inventory: InventoryRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: NotificationsService,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  async reschedule(actor: AuthUser, bookingId: string, dto: RescheduleDto): Promise<void> {
    let ticketsChanged = false;
    await this.prisma.$transaction(async (tx) => {
      await this.repo.lock(tx, bookingId);
      const b = await this.repo.findById(bookingId, tx);
      if (!b) throw new NotFoundException('Booking not found');
      if (!['INQUIRY', 'HELD', 'CONFIRMED', 'TICKETED'].includes(b.status)) throw new ConflictException(`Cannot reschedule a booking in status ${b.status}`);
      const changes = dto.changes ?? [];
      const retimes = dto.retimes ?? [];
      if (changes.length + retimes.length === 0) throw new BadRequestException('Choose a different flight, or a new date and time, for at least one leg.');
      const legs = [...changes, ...retimes].map((c) => c.direction);
      if (new Set(legs).size !== legs.length) throw new BadRequestException('Each leg can be changed only once: either move it to another flight or change its time, not both.');

      const now = new Date();
      const moves: SeatMove[] = [];
      const finalLeg = new Map<string, { dep: Date; arr: Date | null }>(b.segments.map((s) => [s.direction, { dep: s.flight.departureAt, arr: s.flight.arrivalAt }]));
      const updates: { segmentId: string; direction: 'OUTBOUND' | 'RETURN'; flightId: string; originalFlightId: string; adultFare: string; childFare: string; from: string; to: string; fromAt: Date; toAt: Date }[] = [];

      for (const c of changes) {
        const seg = b.segments.find((s) => s.direction === c.direction);
        if (!seg) throw new BadRequestException(`This booking has no ${c.direction.toLowerCase()} leg`);
        if (c.newFlightId === seg.flightId) throw new BadRequestException('Choose a different flight');
        const nf = await this.flights.findById(c.newFlightId, tx);
        if (!nf || nf.status !== 'SCHEDULED' || nf.departureAt <= now) throw new BadRequestException('The new flight is not available for sale');
        if (nf.originId !== seg.flight.originId || nf.destinationId !== seg.flight.destinationId || nf.sectorId !== seg.flight.sectorId) {
          throw new BadRequestException(seg.flight.sectorId ? 'The new flight must be on the same sector' : 'The new flight must be on the same route');
        }
        finalLeg.set(seg.direction, { dep: nf.departureAt, arr: nf.arrivalAt });
        moves.push({ flightId: seg.flightId, seats: seg.seats, from: seg.seatState, to: 'RELEASED' });
        moves.push({ flightId: nf.id, seats: seg.seats, from: 'REQUESTED', to: seg.seatState });
        updates.push({
          segmentId: seg.id, direction: seg.direction, fromAt: seg.flight.departureAt, toAt: nf.departureAt, flightId: nf.id, originalFlightId: seg.originalFlightId ?? seg.flightId,
          adultFare: nf.adultFare.toString(), childFare: nf.childFare.toString(), from: seg.flight.flightNumber, to: nf.flightNumber,
        });
      }

      // Same flight, different time for this ticket (e.g. the flight is running late).
      const retimed: { segmentId: string; direction: 'OUTBOUND' | 'RETURN'; at: Date | null; flightNumber: string; fromAt: Date; toAt: Date }[] = [];
      for (const r of retimes) {
        const seg = b.segments.find((s) => s.direction === r.direction);
        if (!seg) throw new BadRequestException(`This booking has no ${r.direction.toLowerCase()} leg`);
        const at = new Date(r.departureAt);
        if (Number.isNaN(at.getTime())) throw new BadRequestException('The new date and time is not valid.');
        if (at.getTime() === seg.flight.departureAt.getTime()) throw new BadRequestException('That is already the time for this ticket. Enter a different date or time.');
        const scheduled = (seg.flight as { scheduledDepartureAt?: Date }).scheduledDepartureAt ?? seg.flight.departureAt;
        retimed.push({ segmentId: seg.id, direction: seg.direction, at: at.getTime() === scheduled.getTime() ? null : at, flightNumber: seg.flight.flightNumber, fromAt: seg.flight.departureAt, toAt: at });
        finalLeg.set(seg.direction, { dep: at, arr: null });
      }

      const out = finalLeg.get('OUTBOUND');
      const ret = finalLeg.get('RETURN');
      if (out && ret && out.arr && ret.dep <= out.arr) throw new BadRequestException('The return flight must depart after the outbound flight arrives');
      if (out && ret && ret.dep <= out.dep) throw new BadRequestException('The return must be later than the going flight.');

      if (dto.tickets) {
        if (b.status !== 'TICKETED') throw new BadRequestException('Ticket numbers only apply to a ticketed booking');
        assertTicketLines(b.passengers.map((p) => p.id), dto.tickets);
      }

      // Consistent lock order across all flights touched => no deadlocks with other bookings.
      for (const m of moves.sort((x, y) => (x.flightId < y.flightId ? -1 : x.flightId > y.flightId ? 1 : 0))) {
        await this.inventory.move(tx, m.flightId, m.seats, m.from, m.to);
      }
      for (const u of updates) {
        await tx.bookingSegment.update({
          where: { id: u.segmentId },
          data: { flightId: u.flightId, originalFlightId: u.originalFlightId, adultFare: u.adultFare, childFare: u.childFare, actualDepartureAt: null }, // a new flight starts on its own schedule
        });
      }
      for (const u of updates) {
        await tx.reschedule.create({ data: { bookingId, direction: u.direction, fromFlightNumber: u.from, fromDepartureAt: u.fromAt, toFlightNumber: u.to, toDepartureAt: u.toAt, note: dto.note?.trim() || null, doneById: actor.id } });
      }
      for (const r of retimed) {
        await tx.bookingSegment.update({ where: { id: r.segmentId }, data: { actualDepartureAt: r.at } });
        await tx.reschedule.create({ data: { bookingId, direction: r.direction, fromFlightNumber: r.flightNumber, fromDepartureAt: r.fromAt, toFlightNumber: r.flightNumber, toDepartureAt: r.toAt, note: dto.note?.trim() || null, doneById: actor.id } });
      }
      if (dto.tickets && dto.pnr) {
        for (const t of dto.tickets) await tx.passenger.update({ where: { id: t.passengerId }, data: { ticketNumber: t.ticketNumber.toUpperCase() } });
        ticketsChanged = true;
      }
      await tx.booking.update({ where: { id: bookingId }, data: { rescheduledCount: { increment: 1 }, ...(dto.pnr && dto.tickets ? { pnr: dto.pnr.toUpperCase() } : {}) } });
      await this.audit.record(
        { actorId: actor.id, action: 'booking.reschedule', entityType: 'Booking', entityId: bookingId, detail: { moves: [...updates.map((u) => `${u.from} -> ${u.to}`), ...retimed.map((r) => `${r.flightNumber} time ${r.toAt.toISOString()}`)], note: dto.note ?? null } },
        tx,
      );
    });

    try {
      const b = await this.repo.findById(bookingId);
      if (b) await this.mail.send(bookingRescheduled(b, this.env.FRONTEND_ORIGIN, ticketsChanged));
    } catch {
      /* an email problem never undoes the reschedule */
    }
  }
}
