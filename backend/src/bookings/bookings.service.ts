import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BookingSource, BookingStatus, Prisma, Role, SeatState } from '@prisma/client';
import { randomInt } from 'crypto';
import { AuditService } from '../audit/audit.module';
import { AuthUser } from '../common/auth/decorators';
import { APP_ENV } from '../common/config/config.module';
import { Env } from '../common/config/env';
import { FieldCryptoService } from '../common/crypto/field-crypto.service';
import { PrismaService, Tx } from '../database/prisma.service';
import { FlightsRepository } from '../flights/flights.repository';
import { InventoryRepository, availableSeats } from '../inventory/inventory.repository';
import { NotificationsService, OutgoingEmail } from '../notifications/notifications.module';
import { bookingApproved, bookingClosed, inquiryReceived, ticketIssued } from '../notifications/templates';
import { nepalDayStart } from '../flights/flights.service';
import { money, summarize, summaryView } from '../payments/payments.util';
import { assertTicketLines } from './tickets.util';
import { BOOKING_INCLUDE, BookingFull, BookingsRepository, withActualTimes } from './bookings.repository';
import { AdminBookingQuery, CreateInquiryDto, CustomerQuery, IssueTicketDto, PassengerDto, UpdateBookingDatesDto, UpdatePassportDto } from './dto/booking.dto';

const PAGE_SIZE = 25;
// No 0/O/1/I/L to avoid misreading a reference read over the phone.
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** What customers see. Staff-side statuses (e.g. HELD) are internal detail. */
const CUSTOMER_STATUS: Record<BookingStatus, string> = {
  INQUIRY: 'PENDING',
  HELD: 'PENDING',
  CONFIRMED: 'APPROVED',
  TICKETED: 'TICKETED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'DECLINED',
  EXPIRED: 'EXPIRED',
};
const COMMITTED: SeatState[] = ['HELD', 'CONFIRMED', 'TICKETED'];

const randomChunk = (n: number): string => Array.from({ length: n }, () => REF_ALPHABET[randomInt(REF_ALPHABET.length)]).join('');
/** ~49 bits of entropy; combined with the contact email on lookup and rate limiting. */
export const newReference = (): string => `MT-${randomChunk(5)}-${randomChunk(5)}`;
export const normalizeReference = (r: string): string => r.trim().toUpperCase().replace(/\s+/g, '');

@Injectable()
export class BookingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingsService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly repo: BookingsRepository,
    private readonly flights: FlightsRepository,
    private readonly inventory: InventoryRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: FieldCryptoService,
    private readonly mail: NotificationsService,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test') return; // tests call releaseExpiredHolds() explicitly
    this.timer = setInterval(() => void this.releaseExpiredHolds().catch(() => this.logger.error('Hold sweep failed')), 60_000);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ───────────────────────── public ─────────────────────────

  /** Website inquiry. No inventory is touched: an inquiry is never a reservation. */
  async createInquiry(dto: CreateInquiryDto) {
    const booking = await this.persistInquiry(dto, 'WEBSITE', null);
    // The reference is deliberately NOT returned to the browser: it is emailed to the contact address only.
    await this.mail.send(inquiryReceived(booking, this.env.FRONTEND_ORIGIN));
    return { received: true };
  }

  /**
   * Staff create a booking directly (walk-in / phone customer): no inquiry stage. The seats are committed and checked
   * immediately, exactly as in a normal confirmation. Staff are asserting that the airline has already agreed.
   */
  async createByStaff(actor: AuthUser, dto: CreateInquiryDto) {
    const booking = await this.persistInquiry(dto, 'STAFF', actor.id);
    try {
      return await this.confirm(actor, booking.id); // commits inventory, sets confirmedAt, emails the customer
    } catch (e) {
      await this.prisma.booking.delete({ where: { id: booking.id } }).catch(() => undefined); // leave no half-made booking behind
      throw e;
    }
  }

  private async persistInquiry(dto: CreateInquiryDto, source: BookingSource, actorId: string | null) {
    const adults = dto.passengers.filter((p) => p.type === 'ADULT').length;
    const infants = dto.passengers.filter((p) => p.type === 'INFANT').length;
    const seats = dto.passengers.filter((p) => p.type !== 'INFANT').length;
    if (adults < 1) throw new BadRequestException('At least one adult is required');
    if (infants > adults) throw new BadRequestException('Each infant must travel with an adult');
    if (seats > 9) throw new BadRequestException('Maximum 9 seats per inquiry');

    if (dto.tripType === 'ROUND_TRIP' && !dto.returnFlightId) throw new BadRequestException('Return flight is required for round trips');
    if (dto.tripType === 'ONE_WAY' && dto.returnFlightId) throw new BadRequestException('Return flight not allowed for one-way trips');

    const outbound = await this.requireBookableFlight(dto.outboundFlightId, seats, 'Outbound');
    const ret = dto.returnFlightId ? await this.requireBookableFlight(dto.returnFlightId, seats, 'Return') : null;
    if (outbound.sectorId && dto.tripType === 'ROUND_TRIP') throw new BadRequestException('Sector flights are one way only');
    if (ret) {
      if (!outbound.originId || !ret.originId || ret.originId !== outbound.destinationId || ret.destinationId !== outbound.originId) {
        throw new BadRequestException('Return flight must be the reverse of the outbound route');
      }
      if (ret.departureAt <= outbound.departureAt) throw new BadRequestException('Return flight must depart after the outbound departs');
      if (outbound.arrivalAt && ret.departureAt <= outbound.arrivalAt) throw new BadRequestException('Return flight must depart after the outbound arrives');
    }

    this.assertPassports(dto.passengers, (ret ?? outbound).departureAt);
    if (source === 'STAFF') this.assertPassportsOnFile(dto.passengers.map((p) => ({ name: `${p.firstName} ${p.lastName}`, has: !!p.documentNumber && !!p.nationality })));

    const data = (reference: string): Prisma.BookingCreateInput => ({
      reference,
      source,
      tripType: dto.tripType,
      contactName: dto.contactName.trim(),
      contactEmail: dto.contactEmail.trim().toLowerCase(),
      contactPhone: dto.contactPhone.replace(/[\s-]/g, ''), // digits only: so staff can find it however it was typed
      notes: dto.notes?.trim() || null,
      requestedDate: dto.requestedDate ? new Date(dto.requestedDate) : null,
      requestedReturnDate: dto.tripType === 'ROUND_TRIP' && dto.requestedReturnDate ? new Date(dto.requestedReturnDate) : null,
      segments: {
        create: [outbound, ...(ret ? [ret] : [])].map((f, i) => ({
          direction: i === 0 ? ('OUTBOUND' as const) : ('RETURN' as const),
          seats,
          adultFare: f.adultFare, // snapshot
          childFare: f.childFare,
          flight: { connect: { id: f.id } },
        })),
      },
      passengers: {
        create: dto.passengers.map((p) => ({
          type: p.type,
          firstName: p.firstName.trim(),
          lastName: p.lastName.trim(),
          dateOfBirth: p.dateOfBirth ? new Date(p.dateOfBirth) : null,
          ...this.encryptPassport(p),
        })),
      },
    });

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const booking = await this.repo.create(data(newReference()));
        await this.audit.record({ actorId, action: source === 'STAFF' ? 'booking.staff_create' : 'booking.inquiry', entityType: 'Booking', entityId: booking.id });
        return booking;
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e; // retry only on reference collision
      }
    }
    throw new ConflictException('Could not allocate a booking reference, please retry');
  }

  /** A passport is all-or-nothing, and must still be valid on the last day of travel. */
  private assertPassports(passengers: PassengerDto[], lastDeparture: Date): void {
    passengers.forEach((p, i) => {
      const who = `Passenger ${i + 1}`;
      if (!!p.documentNumber !== !!p.nationality) throw new BadRequestException(`${who}: enter the passport number and nationality together, or leave both empty`);
      if (p.documentExpiry && !p.documentNumber) throw new BadRequestException(`${who}: a passport expiry needs a passport number`);
      if (p.documentExpiry) this.assertExpiry(p.documentExpiry, lastDeparture, who);
    });
  }

  /** A booking (unlike an inquiry) needs a passport number and nationality for every passenger. */
  private assertPassportsOnFile(list: { name: string; has: boolean }[]): void {
    const missing = list.filter((p) => !p.has).map((p) => p.name);
    if (missing.length) throw new BadRequestException(`Passport number and nationality are needed before this becomes a booking. Missing for: ${missing.join(', ')}`);
  }

  private assertExpiry(expiry: string, lastDeparture: Date, who: string): void {
    const d = new Date(`${expiry}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== expiry) throw new BadRequestException(`${who}: passport expiry is not a real date`);
    if (d.getTime() <= lastDeparture.getTime()) throw new BadRequestException(`${who}: the passport expires before the travel date`);
  }

  private encryptPassport(p: { documentNumber?: string; nationality?: string; documentExpiry?: string }) {
    if (!p.documentNumber || !p.nationality) return { documentNumberEnc: null, nationalityEnc: null, documentExpiryEnc: null };
    return {
      documentNumberEnc: this.crypto.encrypt(p.documentNumber.trim().toUpperCase()),
      nationalityEnc: this.crypto.encrypt(p.nationality.trim()),
      documentExpiryEnc: p.documentExpiry ? this.crypto.encrypt(p.documentExpiry) : null,
    };
  }

  /** Decrypts one stored field; an unreadable value (e.g. wrong key) shows as empty instead of breaking the whole page. */
  private open(envelope: string | null): string | null {
    if (!envelope) return null;
    try { return this.crypto.decrypt(envelope); } catch { this.logger.error('A passport field could not be decrypted (wrong FIELD_ENCRYPTION_KEY?)'); return null; }
  }

  /** Staff add or correct a passport after the booking exists (e.g. a website inquiry that came without one). */
  async updatePassport(actor: AuthUser, bookingId: string, passengerId: string, dto: UpdatePassportDto) {
    const b = await this.repo.findById(bookingId);
    const pax = b?.passengers.find((p) => p.id === passengerId);
    if (!b || !pax) throw new NotFoundException('Passenger not found');
    if (['CANCELLED', 'REJECTED', 'EXPIRED'].includes(b.status)) throw new ConflictException('This booking is closed');
    const last = new Date(Math.max(...b.segments.map((s) => s.flight.departureAt.getTime())));
    if (dto.documentExpiry) this.assertExpiry(dto.documentExpiry, last, 'Passenger');
    await this.prisma.passenger.update({ where: { id: passengerId }, data: this.encryptPassport(dto) });
    // The audit record says WHO changed WHICH passenger's passport, never the passport values.
    await this.audit.record({ actorId: actor.id, action: 'passenger.passport_update', entityType: 'Booking', entityId: bookingId, detail: { passengerId } });
    return this.get(actor, bookingId);
  }

  /** The only way to read a full passport number. Every view is written to the audit log. */
  async revealPassport(actor: AuthUser, bookingId: string, passengerId: string) {
    const b = await this.repo.findById(bookingId);
    const p = b?.passengers.find((x) => x.id === passengerId);
    if (!b || !p) throw new NotFoundException('Passenger not found');
    await this.audit.record({ actorId: actor.id, action: 'passenger.passport_view', entityType: 'Booking', entityId: bookingId, detail: { passengerId } });
    return { documentNumber: this.open(p.documentNumberEnc), nationality: this.open(p.nationalityEnc), documentExpiry: this.open(p.documentExpiryEnc) };
  }

  /** Reference + contact email must both match; every failure returns the same response. */
  async lookup(reference: string, email: string) {
    const b = await this.repo.findByReference(normalizeReference(reference));
    if (!b || b.contactEmail !== email.trim().toLowerCase()) throw new NotFoundException('No booking found for these details');
    return {
      reference: b.reference,
      status: CUSTOMER_STATUS[b.status],
      tripType: b.tripType,
      createdAt: b.createdAt,
      requestedDate: b.requestedDate,
      pnr: b.status === 'TICKETED' ? b.pnr : null,
      rescheduled: b.rescheduledCount > 0,
      payment: b.confirmedAt ? summarize(b).status : null, // status only; amounts are never shown on the public site
      requests: (await this.prisma.changeRequest.findMany({ where: { bookingId: b.id }, orderBy: { createdAt: 'desc' }, select: { type: true, status: true, createdAt: true } })),
      ticketFiles: b.status === 'TICKETED'
        ? await this.prisma.ticketFile.findMany({ where: { bookingId: b.id }, orderBy: { createdAt: 'asc' }, select: { id: true, filename: true, size: true } })
        : [],
      segments: b.segments.map((s) => ({
        direction: s.direction,
        airline: s.flight.airline,
        flightNumber: s.flight.flightNumber,
        origin: s.flight.origin,
        destination: s.flight.destination,
        sector: s.flight.sector,
        departureAt: s.flight.departureAt,
        arrivalAt: s.flight.arrivalAt,
      })),
      passengers: b.passengers.map((p) => ({
        type: p.type,
        firstName: p.firstName,
        lastName: p.lastName,
        ticketNumber: b.status === 'TICKETED' ? p.ticketNumber : null,
      })),
    };
  }

  /** The customer downloads their own airline ticket PDF: reference + email must match, and the booking must be ticketed. */
  async publicTicketFile(reference: string, email: string, fileId: string) {
    const b = await this.repo.findByReference(normalizeReference(reference));
    if (!b || b.contactEmail !== email.trim().toLowerCase() || b.status !== 'TICKETED') throw new NotFoundException('No ticket found for these details');
    return this.ticketFile(b.id, fileId);
  }

  // ───────────────────────── admin: read ─────────────────────────

  async list(actor: AuthUser, q: AdminBookingQuery) {
    const term = q.q?.trim();
    const statusFilter: Prisma.BookingWhereInput =
      q.status === 'OPEN' ? { status: { in: ['INQUIRY', 'HELD'] } }
      : q.status === 'CLOSED' ? { status: { in: ['REJECTED', 'EXPIRED', 'CANCELLED'] } }
      : q.status ? { status: q.status }
      : {};
    const where: Prisma.BookingWhereInput = {
      ...statusFilter,
      ...(q.kind === 'inquiry' ? { confirmedAt: null } : q.kind === 'booking' ? { confirmedAt: { not: null } } : {}),
      ...(q.flightNumber || q.origin || q.destination || q.flightFrom || q.flightTo
        ? {
            segments: {
              some: {
                flight: {
                  ...(q.flightNumber ? { flightNumber: { contains: q.flightNumber, mode: 'insensitive' as const } } : {}),
                  ...(q.origin ? { origin: { iata: q.origin } } : {}),
                  ...(q.destination ? { destination: { iata: q.destination } } : {}),
                  ...(q.flightFrom || q.flightTo
                    ? {
                        departureAt: {
                          ...(q.flightFrom ? { gte: nepalDayStart(q.flightFrom) } : {}),
                          ...(q.flightTo ? { lt: new Date(nepalDayStart(q.flightTo).getTime() + 86_400_000) } : {}),
                        },
                      }
                    : {}),
                },
              },
            },
          }
        : {}),
      ...(term
        ? {
            OR: [
              { reference: { contains: term.toUpperCase() } },
              { contactEmail: { contains: term.toLowerCase() } },
              { contactName: { contains: term, mode: 'insensitive' } },
              { contactPhone: { contains: term.replace(/[\s-]/g, '') } },
              { contactPhone: { contains: term } },
            ],
          }
        : {}),
    };
    const page = await this.repo.list(where, q.page ?? 1, PAGE_SIZE);
    return { ...page, items: page.items.map((b) => this.present(b, actor.role)) };
  }

  /**
   * The people actually travelling (confirmed bookings), one row per booking, nearest flight first.
   * Inquiries that were never confirmed are "leads" and kept apart: they are interest, not flights.
   * Payment status is computed from the payment records, so the filter runs in memory over a capped candidate set.
   */
  async customers(q: CustomerQuery) {
    const page = q.page ?? 1;
    const scope = q.scope ?? 'travelling';
    const term = q.q?.trim();
    const where: Prisma.BookingWhereInput = {
      ...(scope === 'leads' ? { confirmedAt: null, status: { in: ['INQUIRY', 'HELD'] } }
        : scope === 'cancelled' ? { confirmedAt: { not: null }, status: 'CANCELLED' }
        : { confirmedAt: { not: null }, status: { in: ['CONFIRMED', 'TICKETED'] } }),
      ...(q.rescheduled ? { rescheduledCount: { gt: 0 } } : {}),
      ...(q.flyFrom || q.flyTo
        ? { segments: { some: { flight: { departureAt: {
            ...(q.flyFrom ? { gte: nepalDayStart(q.flyFrom) } : {}),
            ...(q.flyTo ? { lt: new Date(nepalDayStart(q.flyTo).getTime() + 86_400_000) } : {}),
          } } } } }
        : {}),
      ...(term ? { OR: [
        { reference: { contains: term.toUpperCase() } },
        { contactEmail: { contains: term.toLowerCase() } },
        { contactName: { contains: term, mode: 'insensitive' } },
        { contactPhone: { contains: term.replace(/[\s-]/g, '') } },
      ] } : {}),
    };
    const found = (await this.prisma.booking.findMany({ where, include: BOOKING_INCLUDE, orderBy: { createdAt: 'desc' }, take: 5000 })).map((b) => withActualTimes(b));
    const now = Date.now();
    const rows = found
      .map((b) => {
        const s = summarize(b);
        const times = b.segments.map((x) => x.flight.departureAt.getTime());
        const upcoming = times.filter((t) => t >= now);
        const n = (t: string) => b.passengers.filter((p) => p.type === t).length;
        return {
          bookingId: b.id, reference: b.reference, status: b.status, rescheduled: b.rescheduledCount > 0,
          name: b.contactName, phone: b.contactPhone, email: b.contactEmail,
          travellers: { adults: n('ADULT'), children: n('CHILD'), infants: n('INFANT') },
          flights: b.segments.map((x) => ({ direction: x.direction, flightNumber: x.flight.flightNumber, from: x.flight.origin?.iata ?? x.flight.sector?.name ?? '', to: x.flight.destination?.iata ?? '', departureAt: x.flight.departureAt })),
          nextDeparture: upcoming.length ? new Date(Math.min(...upcoming)) : null,
          lastDeparture: times.length ? new Date(Math.max(...times)) : null,
          payment: summaryView(s),
        };
      })
      .filter((r) => !q.payment || r.payment.status === q.payment);
    // Nearest upcoming flight first; flights already flown go below, most recent first.
    rows.sort((x, y) => {
      if (x.nextDeparture && y.nextDeparture) return x.nextDeparture.getTime() - y.nextDeparture.getTime();
      if (x.nextDeparture) return -1;
      if (y.nextDeparture) return 1;
      return (y.lastDeparture?.getTime() ?? 0) - (x.lastDeparture?.getTime() ?? 0);
    });
    return { items: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: rows.length, page, pageSize: PAGE_SIZE, capped: found.length >= 5000 };
  }

  /**
   * Month view for the dashboard calendar: every confirmed or ticketed customer on the day their flight leaves (Nepal
   * calendar day). It reads each booking's CURRENT flights, so a rescheduled customer appears on the new day only.
   */
  async calendar(month: string) {
    const [y, m] = month.split('-').map(Number);
    const start = nepalDayStart(`${month}-01`);
    const next = nepalDayStart(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`);
    const segs = await this.prisma.bookingSegment.findMany({
      where: {
        booking: { status: { in: ['CONFIRMED', 'TICKETED'] } },
        OR: [{ actualDepartureAt: { gte: start, lt: next } }, { actualDepartureAt: null, flight: { departureAt: { gte: start, lt: next } } }],
      },
      include: {
        booking: { include: { passengers: { select: { id: true } } } },
        flight: { include: { airline: { select: { name: true } }, origin: { select: { iata: true } }, destination: { select: { iata: true } }, sector: { select: { name: true } } } },
      },
      orderBy: { flight: { departureAt: 'asc' } },
    });
    const when = (s: (typeof segs)[number]) => s.actualDepartureAt ?? s.flight.departureAt;
    const dayOf = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(d);
    type Day = { date: string; bookingIds: Set<string>; passengers: number; ticketed: number; rescheduled: number; flights: Map<string, { flightId: string; flightNumber: string; airline: string; route: string; departureAt: Date; passengers: number; bookings: { bookingId: string; reference: string; name: string; phone: string; status: string; pnr: string | null; passengers: number; rescheduled: boolean; delayed: boolean; direction: string }[] }> };
    const days = new Map<string, Day>();
    for (const s of segs) {
      const key = dayOf(when(s));
      const d = days.get(key) ?? { date: key, bookingIds: new Set<string>(), passengers: 0, ticketed: 0, rescheduled: 0, flights: new Map() };
      days.set(key, d);
      const pax = s.booking.passengers.length;
      if (!d.bookingIds.has(s.bookingId)) {
        d.bookingIds.add(s.bookingId);
        d.passengers += pax;
        if (s.booking.status === 'TICKETED') d.ticketed++;
        if (s.booking.rescheduledCount > 0) d.rescheduled++;
      }
      const fkey = `${s.flightId}|${when(s).toISOString()}`;
      const f = d.flights.get(fkey) ?? { flightId: s.flightId, flightNumber: s.flight.flightNumber, airline: s.flight.airline.name, route: s.flight.origin && s.flight.destination ? `${s.flight.origin.iata}-${s.flight.destination.iata}` : (s.flight.sector?.name ?? 'Sector flight'), departureAt: when(s), passengers: 0, bookings: [] };
      d.flights.set(fkey, f);
      f.passengers += pax;
      f.bookings.push({ bookingId: s.bookingId, reference: s.booking.reference, name: s.booking.contactName, phone: s.booking.contactPhone, status: s.booking.status, pnr: s.booking.pnr, passengers: pax, rescheduled: s.booking.rescheduledCount > 0, delayed: s.actualDepartureAt !== null, direction: s.direction });
    }
    return {
      month,
      days: [...days.values()].map((d) => ({ date: d.date, customers: d.bookingIds.size, passengers: d.passengers, ticketed: d.ticketed, confirmed: d.bookingIds.size - d.ticketed, rescheduled: d.rescheduled, flights: [...d.flights.values()] })),
    };
  }

  /** Customers whose tickets are issued: airline, flight, PNR and ticket numbers in one place. Nearest flight first. */
  async ticketed(q: { q?: string; page?: number }) {
    const page = q.page ?? 1;
    const term = q.q?.trim();
    const found = (await this.prisma.booking.findMany({
      where: {
        status: 'TICKETED',
        ...(term ? { OR: [
          { reference: { contains: term.toUpperCase() } }, { pnr: { contains: term.toUpperCase() } },
          { contactEmail: { contains: term.toLowerCase() } }, { contactName: { contains: term, mode: 'insensitive' } },
          { contactPhone: { contains: term.replace(/[\s-]/g, '') } },
          { passengers: { some: { ticketNumber: { contains: term.toUpperCase() } } } },
        ] } : {}),
      },
      include: BOOKING_INCLUDE, orderBy: { updatedAt: 'desc' }, take: 2000,
    })).map((b) => withActualTimes(b));
    const now = Date.now();
    const rows = found.map((b) => {
      const times = b.segments.map((s) => s.flight.departureAt.getTime());
      const upcoming = times.filter((t) => t >= now);
      return {
        bookingId: b.id, reference: b.reference, name: b.contactName, phone: b.contactPhone, email: b.contactEmail, pnr: b.pnr, rescheduled: b.rescheduledCount > 0,
        nextDeparture: upcoming.length ? new Date(Math.min(...upcoming)) : null, lastDeparture: times.length ? new Date(Math.max(...times)) : null,
        flights: b.segments.map((s) => ({ direction: s.direction, airline: s.flight.airline.name, flightNumber: s.flight.flightNumber, route: s.flight.origin && s.flight.destination ? `${s.flight.origin.iata}-${s.flight.destination.iata}` : (s.flight.sector?.name ?? 'Sector flight'), departureAt: s.flight.departureAt })),
        passengers: b.passengers.map((p) => ({ name: `${p.firstName} ${p.lastName}`, type: p.type, ticketNumber: p.ticketNumber })),
        payment: summaryView(summarize(b)),
      };
    });
    rows.sort((x, y) => (x.nextDeparture && y.nextDeparture ? x.nextDeparture.getTime() - y.nextDeparture.getTime() : x.nextDeparture ? -1 : y.nextDeparture ? 1 : (y.lastDeparture?.getTime() ?? 0) - (x.lastDeparture?.getTime() ?? 0)));
    return { items: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: rows.length, page, pageSize: PAGE_SIZE };
  }

  /** Every reschedule, newest first: who moved from which flight (date and time) to which, and the note staff left. */
  async reschedules(q: { q?: string; page?: number }) {
    const page = q.page ?? 1;
    const term = q.q?.trim();
    const where: Prisma.RescheduleWhereInput = term
      ? { booking: { OR: [{ reference: { contains: term.toUpperCase() } }, { contactName: { contains: term, mode: 'insensitive' } }, { contactPhone: { contains: term.replace(/[\s-]/g, '') } }, { contactEmail: { contains: term.toLowerCase() } }] } }
      : {};
    const [total, rows] = await Promise.all([
      this.prisma.reschedule.count({ where }),
      this.prisma.reschedule.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE, include: { booking: { select: { id: true, reference: true, contactName: true, contactPhone: true, status: true } }, doneBy: { select: { name: true } } } }),
    ]);
    return {
      total, page, pageSize: PAGE_SIZE,
      items: rows.map((r) => ({ id: r.id, bookingId: r.booking.id, reference: r.booking.reference, name: r.booking.contactName, phone: r.booking.contactPhone, status: r.booking.status, direction: r.direction, fromFlightNumber: r.fromFlightNumber, fromDepartureAt: r.fromDepartureAt, toFlightNumber: r.toFlightNumber, toDepartureAt: r.toDepartureAt, note: r.note, doneBy: r.doneBy?.name ?? null, rescheduledAt: r.createdAt })),
    };
  }

  // ───────────────────────── ticket PDFs (optional) ─────────────────────────

  /** Stores the airline's own ticket PDF for a booking. The type is decided from the bytes, not from what the browser claims. */
  async addTicketFile(actor: AuthUser, bookingId: string, filename: string, body: unknown) {
    const b = await this.repo.findById(bookingId);
    if (!b) throw new NotFoundException('Booking not found');
    if (!['CONFIRMED', 'TICKETED'].includes(b.status)) throw new ConflictException('Ticket files can only be added to a confirmed or ticketed booking.');
    if (!Buffer.isBuffer(body) || body.length === 0) throw new BadRequestException('No file was received. Choose the PDF the airline sent and try again.');
    if (body.length > 5 * 1024 * 1024) throw new BadRequestException('That PDF is larger than 5 MB. Please use a smaller file.');
    if (body.toString('latin1', 0, 5) !== '%PDF-') throw new BadRequestException('That file is not a PDF. Please upload the PDF ticket the airline sent.');
    if ((await this.prisma.ticketFile.count({ where: { bookingId } })) >= 10) throw new ConflictException('A booking can have at most 10 ticket files. Remove one first.');
    const name = filename.replace(/[^\w .()-]/g, '_').slice(0, 80) || 'ticket.pdf';
    const user = await this.prisma.user.findUnique({ where: { id: actor.id }, select: { name: true } });
    const f = await this.prisma.ticketFile.create({ data: { bookingId, filename: name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`, size: body.length, data: new Uint8Array(body), uploadedByName: user?.name ?? actor.email } });
    await this.audit.record({ actorId: actor.id, action: 'ticket_file.add', entityType: 'Booking', entityId: bookingId, detail: { fileId: f.id, bytes: body.length } });
    return { id: f.id, filename: f.filename, size: f.size, uploadedByName: f.uploadedByName, createdAt: f.createdAt };
  }

  async ticketFile(bookingId: string, fileId: string) {
    const f = await this.prisma.ticketFile.findFirst({ where: { id: fileId, bookingId } });
    if (!f) throw new NotFoundException('That ticket file was not found');
    return { filename: f.filename, data: Buffer.from(f.data) };
  }

  async removeTicketFile(actor: AuthUser, bookingId: string, fileId: string): Promise<void> {
    const f = await this.prisma.ticketFile.findFirst({ where: { id: fileId, bookingId }, select: { id: true } });
    if (!f) throw new NotFoundException('That ticket file was not found');
    await this.prisma.ticketFile.delete({ where: { id: fileId } });
    await this.audit.record({ actorId: actor.id, action: 'ticket_file.remove', entityType: 'Booking', entityId: bookingId, detail: { fileId } });
  }

  /** Who holds which seats on one flight: on hold, confirmed, ticketed. */
  async manifest(flightId: string) {
    const flight = await this.flights.findById(flightId);
    if (!flight) throw new NotFoundException('Flight not found');
    const segs = await this.prisma.bookingSegment.findMany({
      where: { flightId, seatState: { in: ['HELD', 'CONFIRMED', 'TICKETED'] } },
      include: { booking: { include: { passengers: true } } },
      orderBy: { booking: { createdAt: 'asc' } },
    });
    const i = flight.inventory ?? { total: 0, held: 0, confirmed: 0, ticketed: 0 };
    return {
      flight: { id: flight.id, flightNumber: flight.flightNumber, airline: flight.airline, origin: flight.origin, destination: flight.destination, sector: flight.sector, departureAt: flight.departureAt, status: flight.status },
      inventory: { total: i.total, held: i.held, confirmed: i.confirmed, ticketed: i.ticketed, available: availableSeats(i) },
      entries: segs.map((s) => ({
        state: s.seatState, seats: s.seats, bookingId: s.bookingId, reference: s.booking.reference, bookingStatus: s.booking.status,
        customer: s.booking.contactName, phone: s.booking.contactPhone, holdExpiresAt: s.seatState === 'HELD' ? s.booking.holdExpiresAt : null, pnr: s.booking.pnr,
        passengers: s.booking.passengers.map((p) => ({ name: `${p.firstName} ${p.lastName}`, type: p.type, ticketNumber: p.ticketNumber })),
      })),
    };
  }

  /**
   * Permanently deletes an inquiry or booking (and its passengers, requests and payment records).
   * Seats it held are given back first. A booking that has payment records can only be deleted by a Super Admin.
   */
  async remove(actor: AuthUser, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.repo.lock(tx, id);
      const b = await this.repo.findById(id, tx);
      if (!b) throw new NotFoundException('Booking not found');
      if (b.status === 'TICKETED') throw new ConflictException('A ticketed booking cannot be deleted. Cancel it first if the airline has cancelled the ticket.');
      if (b.payments.length > 0 && actor.role !== 'SUPER_ADMIN') {
        throw new ForbiddenException('This booking has payment records. Only a Super Admin can delete it.');
      }
      await this.releaseAll(tx, b);
      await tx.payment.deleteMany({ where: { bookingId: id } });
      await tx.booking.delete({ where: { id } });
      await this.audit.record(
        { actorId: actor.id, action: 'booking.delete', entityType: 'Booking', entityId: id, detail: { reference: b.reference, status: b.status, payments: b.payments.length } },
        tx,
      );
    });
  }

  /** Staff correct the day(s) the customer wants to fly. The flight itself is changed with a reschedule. */
  async updateDates(actor: AuthUser, id: string, dto: UpdateBookingDatesDto) {
    const b = await this.repo.findById(id);
    if (!b) throw new NotFoundException('Booking not found');
    const day = (v: string | undefined) => (v === undefined ? undefined : v === '' ? null : new Date(v));
    await this.prisma.booking.update({ where: { id }, data: { requestedDate: day(dto.requestedDate), requestedReturnDate: day(dto.requestedReturnDate) } });
    await this.audit.record({ actorId: actor.id, action: 'booking.dates', entityType: 'Booking', entityId: id, detail: { requestedDate: dto.requestedDate ?? null, requestedReturnDate: dto.requestedReturnDate ?? null } });
    return this.get(actor, id);
  }

  /** Re-sends the customer's current-status email (which contains their reference). For callers who lost it. */
  async resendEmail(actor: AuthUser, id: string) {
    const b = await this.repo.findById(id);
    if (!b) throw new NotFoundException('Booking not found');
    const site = this.env.FRONTEND_ORIGIN;
    const mail =
      b.status === 'TICKETED' ? ticketIssued(b, site)
      : b.status === 'CONFIRMED' ? bookingApproved(b, site)
      : b.status === 'CANCELLED' || b.status === 'REJECTED' ? bookingClosed(b, b.status, site)
      : inquiryReceived(b, site);
    await this.mail.send(b.status === 'TICKETED' ? await this.withTicketPdfs(mail, id) : mail);
    await this.audit.record({ actorId: actor.id, action: 'booking.resend_email', entityType: 'Booking', entityId: id, detail: { template: mail.template } });
    return { sent: true, to: b.contactEmail };
  }

  /** Sidebar red dots: website inquiries still New, and customer requests still open, that arrived after the given times. */
  async badges(inquiriesSince?: string, requestsSince?: string) {
    const when = (v?: string) => { const d = v ? new Date(v) : new Date(); return Number.isNaN(d.getTime()) ? new Date() : d; };
    const [inquiries, requests] = await Promise.all([
      this.prisma.booking.count({ where: { source: 'WEBSITE', status: 'INQUIRY', createdAt: { gt: when(inquiriesSince) } } }),
      this.prisma.changeRequest.count({ where: { status: 'OPEN', createdAt: { gt: when(requestsSince) } } }),
    ]);
    return { inquiries, requests };
  }

  /** Operational counts for the dashboard. */
  async summary() {
    const [byStatus, lapsing, upcoming] = await Promise.all([
      this.prisma.booking.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.booking.count({ where: { status: 'HELD', holdExpiresAt: { lte: new Date(Date.now() + 2 * 3_600_000) } } }),
      this.prisma.flight.count({ where: { status: 'SCHEDULED', departureAt: { gte: new Date() } } }),
    ]);
    return {
      bookingsByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      holdsExpiringWithin2h: lapsing,
      upcomingFlights: upcoming,
    };
  }

  async get(actor: AuthUser, id: string) {
    const b = await this.repo.findById(id);
    if (!b) throw new NotFoundException('Booking not found');
    const notifications = await this.prisma.notification.findMany({
      where: { bookingId: id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, template: true, subject: true, status: true, error: true, createdAt: true },
    });
    const requests = await this.prisma.changeRequest.findMany({ where: { bookingId: id }, orderBy: { createdAt: 'desc' } });
    const reschedules = await this.prisma.reschedule.findMany({ where: { bookingId: id }, orderBy: { createdAt: 'desc' }, include: { doneBy: { select: { name: true } } } });
    const ticketFiles = await this.prisma.ticketFile.findMany({ where: { bookingId: id }, orderBy: { createdAt: 'asc' }, select: { id: true, filename: true, size: true, uploadedByName: true, createdAt: true } });
    return { ...this.present(b, actor.role), notifications, requests, ticketFiles, reschedules: reschedules.map((r) => ({ id: r.id, direction: r.direction, fromFlightNumber: r.fromFlightNumber, fromDepartureAt: r.fromDepartureAt, toFlightNumber: r.toFlightNumber, toDepartureAt: r.toDepartureAt, note: r.note, doneBy: r.doneBy?.name ?? null, createdAt: r.createdAt })) };
  }

  // ───────────────────────── admin: state transitions ─────────────────────────

  /** INQUIRY → HELD: reserve seats in the agency's own inventory for a limited time. */
  hold(actor: AuthUser, id: string, minutes?: number) {
    return this.transition(actor, id, 'booking.hold', async (tx, b) => {
      if (b.status === 'HELD') return b; // idempotent
      if (b.status !== 'INQUIRY') throw new ConflictException(`Cannot hold a booking in status ${b.status}`);
      await this.assertFlightsSellable(tx, b);
      for (const s of this.ordered(b)) {
        await this.inventory.move(tx, s.flightId, s.seats, 'REQUESTED', 'HELD');
        await this.repo.setSegmentState(tx, s.id, 'HELD');
      }
      const until = new Date(Date.now() + (minutes ?? this.env.HOLD_DEFAULT_MINUTES) * 60_000);
      await this.repo.setStatus(tx, id, 'HELD', until);
      return { until };
    });
  }

  /**
   * HELD → INQUIRY: give the held seats back early and keep the inquiry open as New. The customer is not emailed
   * (nothing they were told has changed). Safe to call on an inquiry that is not held: it is returned unchanged.
   */
  release(actor: AuthUser, id: string) {
    return this.transition(actor, id, 'booking.release', async (tx, b) => {
      if (b.status === 'INQUIRY') return b; // idempotent
      if (b.status !== 'HELD') throw new ConflictException(`Only a held booking can be released (this one is ${b.status})`);
      for (const s of this.ordered(b)) {
        await this.inventory.move(tx, s.flightId, s.seats, 'HELD', 'REQUESTED');
        await this.repo.setSegmentState(tx, s.id, 'REQUESTED');
      }
      await this.repo.setStatus(tx, id, 'INQUIRY', null);
      return {};
    });
  }

  /**
   * INQUIRY|HELD → CONFIRMED. Inventory is validated again inside the transaction (the conditional UPDATE
   * fails if seats are no longer available). Safe to call repeatedly: a CONFIRMED booking is returned unchanged.
   * "Confirmed" here means STAFF HAVE secured the seats with the airline; the system never does that itself.
   */
  confirm(actor: AuthUser, id: string) {
    return this.transition(actor, id, 'booking.confirm', async (tx, b) => {
      if (b.status === 'CONFIRMED') return b; // idempotent
      if (b.status !== 'INQUIRY' && b.status !== 'HELD') throw new ConflictException(`Cannot confirm a booking in status ${b.status}`);
      const missing = b.passengers.filter((p) => !p.documentNumberEnc || !p.nationalityEnc).map((p) => `${p.firstName} ${p.lastName}`);
      if (missing.length) throw new ConflictException(`Add the passport number and nationality before confirming. Missing for: ${missing.join(', ')}`);
      await this.assertFlightsSellable(tx, b);
      const now = new Date();
      for (const s of this.ordered(b)) {
        let from: SeatState = s.seatState;
        if (from === 'HELD' && b.holdExpiresAt && b.holdExpiresAt <= now) {
          await this.inventory.move(tx, s.flightId, s.seats, 'HELD', 'RELEASED'); // lapsed: give back, then re-acquire with a fresh check
          from = 'REQUESTED';
        }
        await this.inventory.move(tx, s.flightId, s.seats, from, 'CONFIRMED');
        await this.repo.setSegmentState(tx, s.id, 'CONFIRMED');
      }
      await this.repo.setStatus(tx, id, 'CONFIRMED');
      await tx.booking.update({ where: { id }, data: { confirmedAt: b.confirmedAt ?? new Date() } }); // inquiry -> booking
      return {};
    });
  }

  /**
   * CONFIRMED -> TICKETED. Staff type in the PNR and ticket numbers exactly as issued by the airline; the system never invents them.
   * Moves the seats from the confirmed counter to the ticketed counter and emails the customer.
   */
  issueTicket(actor: AuthUser, id: string, dto: IssueTicketDto) {
    return this.transition(actor, id, 'booking.ticket', async (tx, b) => {
      if (b.status === 'TICKETED') return b; // idempotent: never overwrites recorded numbers
      if (b.status !== 'CONFIRMED') throw new ConflictException('Only a confirmed booking can be ticketed');
      assertTicketLines(b.passengers.map((p) => p.id), dto.tickets);
      for (const s of this.ordered(b)) {
        await this.inventory.move(tx, s.flightId, s.seats, 'CONFIRMED', 'TICKETED');
        await this.repo.setSegmentState(tx, s.id, 'TICKETED');
      }
      for (const t of dto.tickets) {
        await tx.passenger.update({ where: { id: t.passengerId }, data: { ticketNumber: t.ticketNumber.toUpperCase() } });
      }
      await tx.booking.update({ where: { id }, data: { status: 'TICKETED', pnr: dto.pnr.toUpperCase() } });
      return {};
    });
  }

  /** Seats return to the pool. Any refund is decided and paid manually by staff, outside this action. */
  cancel(actor: AuthUser, id: string, reason: string) {
    return this.transition(actor, id, 'booking.cancel', async (tx, b) => {
      if (b.status === 'CANCELLED') return b;
      if (!['INQUIRY', 'HELD', 'CONFIRMED', 'TICKETED'].includes(b.status)) throw new ConflictException(`Cannot cancel a booking in status ${b.status}`);
      await this.releaseAll(tx, b);
      await this.repo.setStatus(tx, id, 'CANCELLED');
      return { reason };
    });
  }

  reject(actor: AuthUser, id: string, reason: string) {
    return this.transition(actor, id, 'booking.reject', async (tx, b) => {
      if (b.status === 'REJECTED') return b;
      if (b.status !== 'INQUIRY' && b.status !== 'HELD') throw new ConflictException(`Cannot reject a booking in status ${b.status}`);
      await this.releaseAll(tx, b);
      await this.repo.setStatus(tx, id, 'REJECTED');
      return { reason };
    });
  }

  /** Releases lapsed holds. Per-booking transactions with row locks make this safe across several instances. */
  async releaseExpiredHolds(now = new Date()): Promise<number> {
    let released = 0;
    for (const id of await this.repo.expiredHoldIds(now)) {
      await this.prisma.$transaction(async (tx) => {
        await this.repo.lock(tx, id);
        const b = await this.repo.findById(id, tx);
        if (!b || b.status !== 'HELD' || !b.holdExpiresAt || b.holdExpiresAt > now) return; // changed under us
        await this.releaseAll(tx, b);
        await this.repo.setStatus(tx, id, 'EXPIRED');
        await this.audit.record({ action: 'booking.hold_expired', entityType: 'Booking', entityId: id }, tx);
        released++;
      });
    }
    return released;
  }

  // ───────────────────────── internals ─────────────────────────

  /** Common envelope: lock booking row → re-read inside the tx → mutate → audit, all atomically. */
  private async transition(
    actor: AuthUser,
    id: string,
    action: string,
    work: (tx: Tx, b: BookingFull) => Promise<unknown>,
  ) {
    let changedTo: BookingStatus | null = null;
    await this.prisma.$transaction(async (tx) => {
      await this.repo.lock(tx, id);
      const b = await this.repo.findById(id, tx);
      if (!b) throw new NotFoundException('Booking not found');
      const before = b.status;
      const detail = await work(tx, b);
      const after = await tx.booking.findUniqueOrThrow({ where: { id }, select: { status: true } });
      if (before !== after.status) {
        changedTo = after.status;
        const extra = detail && typeof detail === 'object' && 'reason' in detail ? { reason: String((detail as { reason: unknown }).reason) } : {};
        await this.audit.record({ actorId: actor.id, action, entityType: 'Booking', entityId: id, detail: { from: before, to: after.status, ...extra } }, tx);
      }
    });
    if (changedTo) await this.emailStatusChange(id, changedTo);
    return this.get(actor, id);
  }

  /** Attaches the airline's ticket PDFs (if any were uploaded) to the customer's ticket email. */
  private async withTicketPdfs(mail: OutgoingEmail, bookingId: string): Promise<OutgoingEmail> {
    const files = await this.prisma.ticketFile.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' } });
    if (!files.length) return mail;
    return { ...mail, attachments: files.map((f) => ({ filename: f.filename, content: Buffer.from(f.data), contentType: 'application/pdf' })) };
  }

  /** Runs after the transaction commits; an email problem can never undo or fail the booking change. */
  private async emailStatusChange(id: string, status: BookingStatus): Promise<void> {
    try {
      const b = await this.repo.findById(id);
      if (!b) return;
      const site = this.env.FRONTEND_ORIGIN;
      if (status === 'CONFIRMED') await this.mail.send(bookingApproved(b, site));
      else if (status === 'TICKETED') await this.mail.send(await this.withTicketPdfs(ticketIssued(b, site), id));
      else if (status === 'CANCELLED' || status === 'REJECTED') await this.mail.send(bookingClosed(b, status, site));
    } catch {
      this.logger.error('Could not queue customer email');
    }
  }

  private ordered(b: BookingFull) {
    return [...b.segments].sort((x, y) => (x.flightId < y.flightId ? -1 : 1)); // consistent lock order → no deadlocks
  }

  private async releaseAll(tx: Tx, b: BookingFull): Promise<void> {
    for (const s of this.ordered(b)) {
      if (COMMITTED.includes(s.seatState)) await this.inventory.move(tx, s.flightId, s.seats, s.seatState, 'RELEASED');
      await this.repo.setSegmentState(tx, s.id, 'RELEASED');
    }
  }

  private async assertFlightsSellable(tx: Tx, b: BookingFull): Promise<void> {
    const now = new Date();
    for (const s of b.segments) {
      const f = await this.flights.findById(s.flightId, tx);
      if (!f || f.status !== 'SCHEDULED' || f.departureAt <= now) {
        throw new ConflictException(`Flight ${s.flight.flightNumber} is no longer available for sale`);
      }
    }
  }

  private async requireBookableFlight(id: string, seats: number, label: string) {
    const f = await this.flights.findById(id);
    if (!f || f.status !== 'SCHEDULED' || f.departureAt <= new Date()) throw new BadRequestException(`${label} flight is not available`);
    if (!f.inventory || availableSeats(f.inventory) < seats) throw new BadRequestException(`${label} flight does not have enough seats`);
    return f;
  }

  /** Role-based view: Finance sees what it needs for payments but not dates of birth or document data. */
  private present(b: BookingFull, role: Role) {
    const finance = role === Role.FINANCE_STAFF;
    return {
      id: b.id,
      reference: b.reference,
      status: b.status,
      tripType: b.tripType,
      holdExpiresAt: b.holdExpiresAt,
      payment: summaryView(summarize(b)),
      payments: b.payments.map((p) => ({
        id: p.id, receiptNumber: p.receiptNumber, type: p.type, method: p.method, amount: money(p.amount), reference: p.reference,
        receivedAt: p.receivedAt, note: p.note, status: p.status, voidReason: p.voidReason, recordedBy: p.recordedBy.name,
      })),
      pnr: b.pnr,
      source: b.source,
      confirmedAt: b.confirmedAt,
      rescheduledCount: b.rescheduledCount,
      requestedDate: b.requestedDate,
      requestedReturnDate: b.requestedReturnDate,
      createdAt: b.createdAt,
      contactName: b.contactName,
      contactEmail: b.contactEmail,
      contactPhone: b.contactPhone,
      notes: b.notes,
      segments: b.segments.map((s) => ({
        id: s.id,
        direction: s.direction,
        seats: s.seats,
        seatState: s.seatState,
        actualDepartureAt: s.actualDepartureAt,
        adultFare: s.adultFare.toString(),
        childFare: s.childFare.toString(),
        flight: {
          id: s.flight.id,
          flightNumber: s.flight.flightNumber,
          airline: s.flight.airline,
          origin: s.flight.origin,
          destination: s.flight.destination,
          sector: s.flight.sector,
          departureAt: s.flight.departureAt,
          scheduledDepartureAt: (s.flight as { scheduledDepartureAt?: Date }).scheduledDepartureAt ?? s.flight.departureAt,
          arrivalAt: s.flight.arrivalAt,
          seatsAtFlight: s.flight.inventory
            ? { total: s.flight.inventory.total, held: s.flight.inventory.held, confirmed: s.flight.inventory.confirmed, ticketed: s.flight.inventory.ticketed, available: availableSeats(s.flight.inventory) }
            : null,
        },
      })),
      passengers: b.passengers.map((p) => ({
        id: p.id,
        type: p.type,
        firstName: p.firstName,
        lastName: p.lastName,
        ticketNumber: p.ticketNumber,
        ...(finance
          ? {}
          : {
              dateOfBirth: p.dateOfBirth,
              documentNumberMasked: (() => { const n = this.open(p.documentNumberEnc); return n ? FieldCryptoService.mask(n) : null; })(),
              nationality: this.open(p.nationalityEnc),
              documentExpiry: this.open(p.documentExpiryEnc),
            }),
      })),
    };
  }
}

