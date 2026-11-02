import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { FlightStatus, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.module';
import { AuthUser } from '../common/auth/decorators';
import { PrismaService } from '../database/prisma.service';
import { InventoryRepository, availableSeats } from '../inventory/inventory.repository';
import { AdjustInventoryDto, AdminFlightQuery, CreateFlightDto, SearchFlightsQuery, UpdateFlightDto } from './dto/flight.dto';
import { logoUrl } from '../airlines/airlines.module';
import { FlightWithRefs, FlightsRepository } from './flights.repository';

const PAGE_SIZE = 25;
/** With no date chosen, the public search lists upcoming departures within this window. */
const BROWSE_DAYS = 120;
const BROWSE_MAX = 100;
const NEPAL_OFFSET = '+05:45'; // Nepal Standard Time, no DST

/** Start of a calendar day in Nepal time (departure dates are local). */
export const nepalDayStart = (ymd: string): Date => {
  const d = new Date(`${ymd}T00:00:00${NEPAL_OFFSET}`);
  if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid date');
  return d;
};

@Injectable()
export class FlightsService {
  constructor(
    private readonly repo: FlightsRepository,
    private readonly inventory: InventoryRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(actor: AuthUser, dto: CreateFlightDto) {
    const departureAt = new Date(dto.departureAt);
    let arrivalAt: Date | null = null;
    if (dto.sectorId) {
      // Sector flight (e.g. a mountain flight): one name, no airports, no arrival time.
      if (dto.originId || dto.destinationId || dto.arrivalAt) throw new BadRequestException('A sector flight has no origin, destination or arrival');
      const sector = await this.prisma.sector.findUnique({ where: { id: dto.sectorId } });
      if (!sector?.isActive) throw new BadRequestException('Sector not found or inactive');
    } else {
      if (!dto.originId || !dto.destinationId) throw new BadRequestException('Choose a sector, or give origin and destination');
      // Arrival is optional: many flights are entered with a departure time only.
      if (dto.arrivalAt) {
        arrivalAt = new Date(dto.arrivalAt);
        if (arrivalAt <= departureAt) throw new BadRequestException('Arrival must be after departure');
      }
      if (dto.originId === dto.destinationId) throw new BadRequestException('Origin and destination must differ');
    }

    const airline = await this.prisma.airline.findUnique({ where: { id: dto.airlineId } });
    if (!airline?.isActive) throw new BadRequestException('Airline not found or inactive');

    const flightId = await this.prisma.$transaction(async (tx) => {
      const flight = await this.repo.create(tx, {
        airlineId: dto.airlineId,
        flightNumber: dto.flightNumber.replace(/\s+/g, ' ').trim(),
        originId: dto.sectorId ? null : dto.originId,
        destinationId: dto.sectorId ? null : dto.destinationId,
        sectorId: dto.sectorId ?? null,
        departureAt,
        arrivalAt,
        adultFare: dto.adultFare,
        childFare: dto.childFare,
      });
      await this.inventory.create(flight.id, dto.seatsAllocated, tx);
      await this.audit.record(
        { actorId: actor.id, action: 'flight.create', entityType: 'Flight', entityId: flight.id, detail: { seatsAllocated: dto.seatsAllocated } },
        tx,
      );
      return flight.id;
    });
    return this.repo.findById(flightId);
  }

  listAdmin(q: AdminFlightQuery) {
    const where: Prisma.FlightWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.origin ? { origin: { iata: q.origin } } : {}),
      ...(q.destination ? { destination: { iata: q.destination } } : {}),
      ...(q.sectorId ? { sectorId: q.sectorId } : {}),
      ...((q.from || q.to) && {
        departureAt: {
          ...(q.from ? { gte: nepalDayStart(q.from) } : {}),
          ...(q.to ? { lt: new Date(nepalDayStart(q.to).getTime() + 86_400_000) } : {}),
        },
      }),
    };
    return this.repo.listAdmin(where, q.page ?? 1, PAGE_SIZE);
  }

  async get(id: string) {
    const flight = await this.repo.findById(id);
    if (!flight) throw new NotFoundException('Flight not found');
    return { ...flight, adjustments: await this.inventory.listAdjustments(id) };
  }

  async update(actor: AuthUser, id: string, dto: UpdateFlightDto) {
    if (!(await this.repo.findById(id))) throw new NotFoundException('Flight not found');
    if (dto.status === FlightStatus.CANCELLED && (await this.repo.countActiveSegments(id)) > 0) {
      // Airline-initiated cancellations must go through the (later-phase) rebooking/refund workflow.
      throw new ConflictException('Flight has held/confirmed/ticketed bookings; cancel or move them first');
    }
    const flight = await this.repo.update(id, dto);
    await this.audit.record({ actorId: actor.id, action: 'flight.update', entityType: 'Flight', entityId: id, detail: { ...dto } });
    return flight;
  }

  /** Deletes a flight that nobody is booked on. Flights with bookings or inquiries must have those deleted or moved first. */
  async remove(actor: AuthUser, id: string): Promise<void> {
    const flight = await this.repo.findById(id);
    if (!flight) throw new NotFoundException('Flight not found');
    const used = await this.prisma.bookingSegment.count({ where: { flightId: id } });
    if (used > 0) throw new ConflictException(`${used} booking${used === 1 ? '' : 's'} or inquir${used === 1 ? 'y is' : 'ies are'} on this flight. Delete or move ${used === 1 ? 'it' : 'them'} first.`);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.inventoryAdjustment.deleteMany({ where: { flightId: id } });
        await tx.flight.delete({ where: { id } });
        await this.audit.record({ actorId: actor.id, action: 'flight.delete', entityType: 'Flight', entityId: id, detail: { flightNumber: flight.flightNumber } }, tx);
      });
    } catch {
      // Production keeps seat-adjustment history append-only, so a flight that has any cannot be erased.
      throw new ConflictException('This flight has seat-adjustment history that must be kept. Stop sales on it instead.');
    }
  }

  async adjustInventory(actor: AuthUser, id: string, dto: AdjustInventoryDto) {
    if (dto.delta === 0) throw new BadRequestException('Adjustment must be non-zero');
    await this.prisma.$transaction(async (tx) => {
      // The conditional UPDATE in setTotal takes the row lock; read-after-lock gives a consistent before/after.
      const before = await this.inventory.get(id, tx);
      if (!before) throw new NotFoundException('Flight inventory not found');
      const totalAfter = before.total + dto.delta;
      if (totalAfter < 0) throw new ConflictException('Total allocation cannot be negative');
      await this.inventory.setTotal(tx, id, totalAfter);
      await this.inventory.addAdjustment(tx, {
        flightId: id,
        adminId: actor.id,
        delta: dto.delta,
        totalBefore: before.total,
        totalAfter,
        reason: dto.reason.trim(),
      });
      await this.audit.record(
        { actorId: actor.id, action: 'inventory.adjust', entityType: 'Flight', entityId: id, detail: { delta: dto.delta, totalAfter } },
        tx,
      );
    });
    return this.get(id);
  }

  /**
   * Public search. Each leg is evaluated independently against its own inventory.
   * A round trip returns results only if BOTH directions have at least one bookable flight.
   */
  async search(q: SearchFlightsQuery) {
    const seats = q.adults + q.children;
    if (q.infants > q.adults) throw new BadRequestException('Each infant must travel with an adult');
    if (seats > 9) throw new BadRequestException('Maximum 9 seats per inquiry');
    const route: Prisma.FlightWhereInput | null = q.sectorId
      ? { sectorId: q.sectorId, sector: { isActive: true } }
      : q.origin && q.destination ? { origin: { iata: q.origin }, destination: { iata: q.destination } } : null;
    if (!route) throw new BadRequestException('Choose where you are flying from and to, or a sector');
    if (q.sectorId && q.tripType === 'ROUND_TRIP') throw new BadRequestException('Sector flights are one way only');
    if (q.origin && q.origin === q.destination) throw new BadRequestException('Origin and destination must differ');
    // Dates are optional: without one, every upcoming departure on the route is listed with its seats left.
    if (q.tripType === 'ROUND_TRIP' && q.departureDate && !q.returnDate) throw new BadRequestException('Return date is required for round trips');
    if (q.departureDate && q.returnDate && q.returnDate < q.departureDate) throw new BadRequestException('Return date cannot precede departure date');

    const now = new Date();
    const outbound = await this.searchLeg(route, q.departureDate, seats, q, now);
    let ret: ReturnType<FlightsService['present']>[] = [];
    if (q.tripType === 'ROUND_TRIP') {
      ret = await this.searchLeg({ origin: { iata: q.destination! }, destination: { iata: q.origin! } }, q.returnDate, seats, q, now);
      if (outbound.length === 0 || ret.length === 0) return { outbound: [], return: [] };
    }
    return { outbound, return: ret };
  }

  private async searchLeg(route: Prisma.FlightWhereInput, ymd: string | undefined, seats: number, q: SearchFlightsQuery, now: Date) {
    const start = ymd ? nepalDayStart(ymd) : now;
    const end = ymd ? new Date(start.getTime() + 86_400_000) : new Date(now.getTime() + BROWSE_DAYS * 86_400_000);
    const rows = await this.repo.searchDay(route, start, end, now, ymd ? undefined : BROWSE_MAX);
    return rows
      .filter((f) => f.inventory && availableSeats(f.inventory) >= 1) // too-few-seats flights are still listed, flagged fitsParty=false
      .map((f) => this.present(f, q));
  }

  private present(f: FlightWithRefs, q: SearchFlightsQuery) {
    const avail = availableSeats(f.inventory!);
    const total = new Prisma.Decimal(f.adultFare).mul(q.adults).add(new Prisma.Decimal(f.childFare).mul(q.children));
    return {
      id: f.id,
      airline: { code: f.airline.code, name: f.airline.name, logoUrl: logoUrl(f.airline) },
      flightNumber: f.flightNumber,
      origin: f.origin,
      destination: f.destination,
      sector: f.sector,
      departureAt: f.departureAt,
      arrivalAt: f.arrivalAt,
      adultFare: f.adultFare.toString(),
      childFare: f.childFare.toString(),
      currency: f.currency,
      estimatedTotal: total.toFixed(2),
      seatsAvailable: avail,
      fitsParty: avail >= q.adults + q.children,
    };
  }
}
