import { BadRequestException, Controller, Get, Injectable, Module, Query, Res } from '@nestjs/common';
import { BookingStatus, Prisma, Role } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, Matches } from 'class-validator';
import { Response } from 'express';
import { AuditService } from '../audit/audit.module';
import { AuthUser, CurrentUser, Roles } from '../common/auth/decorators';
import { BOOKING_INCLUDE } from '../bookings/bookings.repository';
import { PrismaService } from '../database/prisma.service';
import { nepalDayStart } from '../flights/flights.service';
import { routeCode } from '../flights/route.util';
import { availableSeats } from '../inventory/inventory.repository';
import { money, summarize } from '../payments/payments.util';
import { nepalText, toCsv } from './csv';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 10_000; // hard cap so an export can never exhaust memory
const PREVIEW_ROWS = 200;

export class ReportQuery {
  @Matches(DATE) from!: string;
  @Matches(DATE) to!: string;
  @IsOptional() @IsIn(['csv', 'json']) format?: 'csv' | 'json';
  @IsOptional() @IsEnum(BookingStatus) status?: BookingStatus;
}

const range = (q: ReportQuery) => {
  const gte = nepalDayStart(q.from);
  const lt = new Date(nepalDayStart(q.to).getTime() + 86_400_000);
  if (lt <= gte) throw new BadRequestException('"to" must not be before "from"');
  if (lt.getTime() - gte.getTime() > 366 * 86_400_000) throw new BadRequestException('Choose a range of at most one year');
  return { gte, lt };
};

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async bookings(actor: AuthUser, q: ReportQuery) {
    const rows = await this.prisma.booking.findMany({
      where: { createdAt: range(q), ...(q.status ? { status: q.status } : {}) },
      include: BOOKING_INCLUDE,
      orderBy: { createdAt: 'asc' },
      take: MAX_ROWS,
    });
    const data = rows.map((b) => {
      const s = summarize(b);
      return {
        reference: b.reference, kind: b.confirmedAt ? 'Booking' : 'Inquiry', status: b.status, source: b.source, createdAt: b.createdAt, confirmedAt: b.confirmedAt,
        rescheduled: b.rescheduledCount > 0 ? 'Yes' : 'No',
        customer: b.contactName, email: b.contactEmail, phone: b.contactPhone,
        flights: b.segments.map((x) => `${x.flight.flightNumber} ${routeCode(x.flight)} ${nepalText(x.flight.departureAt)}`).join(' ; '),
        passengers: b.passengers.length, total: money(s.total), paid: money(s.paid), refunded: money(s.refunded), balance: money(s.balance), payment: s.status,
      };
    });
    return this.out('bookings', actor, q, data, [
      { header: 'Reference', value: (r) => r.reference }, { header: 'Type', value: (r) => r.kind }, { header: 'Status', value: (r) => r.status },
      { header: 'Source', value: (r) => r.source }, { header: 'Received (Nepal)', value: (r) => nepalText(r.createdAt) }, { header: 'Confirmed (Nepal)', value: (r) => nepalText(r.confirmedAt) },
      { header: 'Rescheduled', value: (r) => r.rescheduled }, { header: 'Customer', value: (r) => r.customer }, { header: 'Email', value: (r) => r.email }, { header: 'Phone', value: (r) => r.phone },
      { header: 'Flights', value: (r) => r.flights }, { header: 'Passengers', value: (r) => r.passengers }, { header: 'Total NPR', value: (r) => r.total },
      { header: 'Paid NPR', value: (r) => r.paid }, { header: 'Refunded NPR', value: (r) => r.refunded }, { header: 'Balance NPR', value: (r) => r.balance }, { header: 'Payment status', value: (r) => r.payment },
    ]);
  }

  async payments(actor: AuthUser, q: ReportQuery) {
    const rows = await this.prisma.payment.findMany({
      where: { receivedAt: range(q) },
      include: { booking: { select: { reference: true, contactName: true } }, recordedBy: { select: { name: true } } },
      orderBy: { receivedAt: 'asc' },
      take: MAX_ROWS,
    });
    const live = rows.filter((r) => r.status === 'RECORDED');
    const sum = (f: (r: (typeof rows)[number]) => boolean) => live.filter(f).reduce((s, r) => s.plus(r.amount), new Prisma.Decimal(0));
    const totals = {
      received: money(sum((r) => r.type === 'PAYMENT')),
      refunded: money(sum((r) => r.type === 'REFUND')),
      net: money(sum((r) => r.type === 'PAYMENT').minus(sum((r) => r.type === 'REFUND'))),
      byMethod: Object.fromEntries(['CASH', 'BANK_TRANSFER', 'ESEWA', 'KHALTI', 'CARD_POS', 'OTHER'].map((m) => [m, money(sum((r) => r.method === m && r.type === 'PAYMENT').minus(sum((r) => r.method === m && r.type === 'REFUND')))])),
    };
    return this.out('payments', actor, q, rows, [
      { header: 'Receipt', value: (r) => r.receiptNumber }, { header: 'Date (Nepal)', value: (r) => nepalText(r.receivedAt) }, { header: 'Type', value: (r) => r.type },
      { header: 'Status', value: (r) => r.status }, { header: 'Booking', value: (r) => r.booking.reference }, { header: 'Customer', value: (r) => r.booking.contactName },
      { header: 'Method', value: (r) => r.method }, { header: 'Reference', value: (r) => r.reference }, { header: 'Amount NPR', value: (r) => money(r.amount) },
      { header: 'Recorded by', value: (r) => r.recordedBy.name }, { header: 'Note', value: (r) => r.note }, { header: 'Void reason', value: (r) => r.voidReason },
    ], { totals }, (r) => ({ receiptNumber: r.receiptNumber, date: r.receivedAt, type: r.type, status: r.status, booking: r.booking.reference, customer: r.booking.contactName, method: r.method, reference: r.reference, amount: money(r.amount), recordedBy: r.recordedBy.name }));
  }

  async inventory(actor: AuthUser, q: ReportQuery) {
    const rows = await this.prisma.flight.findMany({
      where: { departureAt: range(q) },
      include: { airline: { select: { code: true } }, origin: { select: { iata: true } }, destination: { select: { iata: true } }, sector: { select: { name: true } }, inventory: true },
      orderBy: { departureAt: 'asc' },
      take: MAX_ROWS,
    });
    const data = rows.map((f) => {
      const i = f.inventory ?? { total: 0, held: 0, confirmed: 0, ticketed: 0 };
      const sold = i.confirmed + i.ticketed;
      return { flight: f.flightNumber, route: routeCode(f), departure: f.departureAt, status: f.status, total: i.total, held: i.held, confirmed: i.confirmed, ticketed: i.ticketed, available: availableSeats(i), soldPct: i.total ? Math.round((sold / i.total) * 100) : 0 };
    });
    return this.out('inventory', actor, q, data, [
      { header: 'Flight', value: (r) => r.flight }, { header: 'Route', value: (r) => r.route }, { header: 'Departs (Nepal)', value: (r) => nepalText(r.departure) }, { header: 'Status', value: (r) => r.status },
      { header: 'Seats allocated', value: (r) => r.total }, { header: 'Held', value: (r) => r.held }, { header: 'Confirmed', value: (r) => r.confirmed }, { header: 'Ticketed', value: (r) => r.ticketed },
      { header: 'Available', value: (r) => r.available }, { header: 'Sold %', value: (r) => r.soldPct },
    ]);
  }

  /** CSV (complete, capped) or JSON preview (first rows + the same totals). Every export is audited. */
  private async out<T, V = T>(
    name: string, actor: AuthUser, q: ReportQuery, rows: T[], columns: { header: string; value: (r: T) => unknown }[], extra: object = {}, preview?: (r: T) => V,
  ) {
    await this.audit.record({ actorId: actor.id, action: q.format === 'csv' ? 'report.export' : 'report.view', entityType: 'Report', entityId: name, detail: { from: q.from, to: q.to, rows: rows.length } });
    if (q.format === 'csv') return { csv: toCsv(columns, rows), filename: `${name}_${q.from}_to_${q.to}.csv` };
    return { total: rows.length, truncated: rows.length >= MAX_ROWS, rows: (preview ? rows.slice(0, PREVIEW_ROWS).map(preview) : rows.slice(0, PREVIEW_ROWS)), ...extra };
  }
}

@Controller('admin/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  private async send(res: Response, r: Promise<{ csv?: string; filename?: string } & object>) {
    const out = await r;
    if (out.csv !== undefined) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      return out.csv;
    }
    return out;
  }

  @Get('bookings')
  @Roles(Role.BOOKING_STAFF, Role.FINANCE_STAFF)
  bookings(@CurrentUser() a: AuthUser, @Query() q: ReportQuery, @Res({ passthrough: true }) res: Response) {
    return this.send(res, this.reports.bookings(a, q));
  }

  /** Money reports are for Finance (and Super Admin) only. */
  @Get('payments')
  @Roles(Role.FINANCE_STAFF)
  payments(@CurrentUser() a: AuthUser, @Query() q: ReportQuery, @Res({ passthrough: true }) res: Response) {
    return this.send(res, this.reports.payments(a, q));
  }

  @Get('inventory')
  @Roles(Role.BOOKING_STAFF, Role.FINANCE_STAFF)
  inventory(@CurrentUser() a: AuthUser, @Query() q: ReportQuery, @Res({ passthrough: true }) res: Response) {
    return this.send(res, this.reports.inventory(a, q));
  }
}

@Module({ controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
