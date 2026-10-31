import { Injectable } from '@nestjs/common';
import { BookingStatus, Prisma, SeatState } from '@prisma/client';
import { PrismaService, Tx } from '../database/prisma.service';

export const BOOKING_INCLUDE = {
  passengers: true,
  payments: { orderBy: { createdAt: 'asc' }, include: { recordedBy: { select: { name: true } } } },
  segments: {
    include: {
      flight: {
        include: {
          inventory: true,
          airline: { select: { code: true, name: true } },
          origin: { select: { iata: true, city: true } },
          destination: { select: { iata: true, city: true } },
          sector: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { direction: 'asc' },
  },
} satisfies Prisma.BookingInclude;

export type BookingFull = Prisma.BookingGetPayload<{ include: typeof BOOKING_INCLUDE }>;

/**
 * A ticket's own departure time wins over the flight's (staff can adjust one ticket, e.g. for a delay). Applying it here,
 * where bookings are loaded, means every list, email, calendar and customer page shows the actual time. The flight's own
 * time stays available as scheduledDepartureAt.
 */
export function withActualTimes<T extends { segments: { actualDepartureAt: Date | null; flight: { departureAt: Date } }[] }>(b: T): T;
export function withActualTimes<T extends { segments: { actualDepartureAt: Date | null; flight: { departureAt: Date } }[] }>(b: T | null): T | null;
export function withActualTimes<T extends { segments: { actualDepartureAt: Date | null; flight: { departureAt: Date } }[] }>(b: T | null): T | null {
  if (!b) return b;
  return { ...b, segments: b.segments.map((s) => ({ ...s, flight: { ...s.flight, departureAt: s.actualDepartureAt ?? s.flight.departureAt, scheduledDepartureAt: s.flight.departureAt } })) } as T;
}

@Injectable()
export class BookingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.BookingCreateInput) {
    return this.prisma.booking.create({ data, include: BOOKING_INCLUDE });
  }

  /** Serialises concurrent actions on one booking (double-click, two staff members, sweeper vs. staff). */
  async lock(tx: Tx, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${id}::uuid FOR UPDATE`;
  }

  async findById(id: string, tx?: Tx) {
    return withActualTimes(await (tx ?? this.prisma).booking.findUnique({ where: { id }, include: BOOKING_INCLUDE }));
  }

  async findByReference(reference: string) {
    return withActualTimes(await this.prisma.booking.findUnique({ where: { reference }, include: BOOKING_INCLUDE }));
  }

  async list(where: Prisma.BookingWhereInput, page: number, pageSize: number) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.booking.findMany({ where, include: BOOKING_INCLUDE, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.booking.count({ where }),
    ]);
    return { items: items.map((b) => withActualTimes(b)), total, page, pageSize };
  }

  setStatus(tx: Tx, id: string, status: BookingStatus, holdExpiresAt: Date | null = null) {
    return tx.booking.update({ where: { id }, data: { status, holdExpiresAt } });
  }

  setSegmentState(tx: Tx, segmentId: string, seatState: SeatState) {
    return tx.bookingSegment.update({ where: { id: segmentId }, data: { seatState } });
  }

  expiredHoldIds(now: Date, take = 100) {
    return this.prisma.booking
      .findMany({ where: { status: 'HELD', holdExpiresAt: { lte: now } }, select: { id: true }, take })
      .then((rows) => rows.map((r) => r.id));
  }
}
