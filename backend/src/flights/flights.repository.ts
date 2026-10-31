import { Injectable } from '@nestjs/common';
import { FlightStatus, Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../database/prisma.service';

export const FLIGHT_INCLUDE = {
  airline: { select: { id: true, code: true, name: true, logoUpdatedAt: true } },
  origin: { select: { iata: true, city: true, name: true } },
  destination: { select: { iata: true, city: true, name: true } },
  sector: { select: { id: true, name: true } },
  inventory: true,
} satisfies Prisma.FlightInclude;

export type FlightWithRefs = Prisma.FlightGetPayload<{ include: typeof FLIGHT_INCLUDE }>;

@Injectable()
export class FlightsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(tx: Tx, data: Prisma.FlightUncheckedCreateInput) {
    return tx.flight.create({ data });
  }

  findById(id: string, tx?: Tx) {
    return (tx ?? this.prisma).flight.findUnique({ where: { id }, include: FLIGHT_INCLUDE });
  }

  async listAdmin(where: Prisma.FlightWhereInput, page: number, pageSize: number) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.flight.findMany({
        where,
        include: FLIGHT_INCLUDE,
        orderBy: { departureAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.flight.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  update(id: string, data: Prisma.FlightUpdateInput) {
    return this.prisma.flight.update({ where: { id }, data, include: FLIGHT_INCLUDE });
  }

  countActiveSegments(flightId: string) {
    return this.prisma.bookingSegment.count({ where: { flightId, seatState: { in: ['HELD', 'CONFIRMED', 'TICKETED'] } } });
  }

  /** Candidate departures for a route/day. Seat sufficiency is applied by the service from the inventory row. */
  searchDay(route: Prisma.FlightWhereInput, start: Date, end: Date, now: Date, take?: number) {
    return this.prisma.flight.findMany({
      where: {
        status: FlightStatus.SCHEDULED,
        ...route,
        departureAt: { gte: start > now ? start : now, lt: end },
        airline: { isActive: true },
      },
      include: FLIGHT_INCLUDE,
      orderBy: { departureAt: 'asc' },
      ...(take ? { take } : {}),
    });
  }
}
