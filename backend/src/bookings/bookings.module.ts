import { Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { AuthUser, CurrentUser, Public, Roles } from '../common/auth/decorators';
import { FlightsModule } from '../flights/flights.module';
import { BookingsRepository } from './bookings.repository';
import { ChangeRequestsService } from './change-requests.service';
import { ReschedulingService } from './rescheduling.service';
import { BookingsService } from './bookings.service';
import { AdminBookingQuery, CustomerQuery, CreateInquiryDto, CreateRequestDto, HoldDto, IssueTicketDto, LookupDto, PublicTicketFileDto, ReasonDto, RescheduleDto, ResolveRequestDto, UpdateBookingDatesDto, UpdatePassportDto, MonthQuery, SimpleListQuery, FileNameQuery } from './dto/booking.dto';

@Controller()
export class BookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly requests: ChangeRequestsService,
    private readonly rescheduling: ReschedulingService,
  ) {}

  @Public()
  @Post('public/bookings/inquiry')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  inquiry(@Body() dto: CreateInquiryDto) {
    return this.bookings.createInquiry(dto);
  }

  @Public()
  @Post('public/bookings/lookup')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  lookup(@Body() dto: LookupDto) {
    return this.bookings.lookup(dto.reference, dto.email);
  }

  @Public()
  @Post('public/bookings/ticket-file')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async publicTicketFile(@Body() dto: PublicTicketFileDto, @Res() res: Response) {
    const f = await this.bookings.publicTicketFile(dto.reference, dto.email, dto.fileId);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${f.filename}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    res.send(f.data);
  }

  @Public()
  @Post('public/bookings/request')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  request(@Body() dto: CreateRequestDto) {
    return this.requests.create(dto);
  }

  @Get('admin/badges')
  @Roles(Role.BOOKING_STAFF)
  badges(@Query('inquiriesSince') inquiriesSince?: string, @Query('requestsSince') requestsSince?: string) {
    return this.bookings.badges(inquiriesSince, requestsSince);
  }

  @Get('admin/requests')
  @Roles(Role.BOOKING_STAFF)
  listRequests(@Query('status') status?: 'OPEN' | 'DONE' | 'REJECTED') {
    return this.requests.list(status);
  }

  @Post('admin/requests/:id/resolve')
  @HttpCode(200)
  @Roles(Role.BOOKING_STAFF)
  resolveRequest(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveRequestDto) {
    return this.requests.resolve(actor, id, dto);
  }

  @Delete('admin/bookings/:id')
  @HttpCode(204)
  @Roles(Role.BOOKING_STAFF)
  async remove(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.bookings.remove(actor, id);
  }

  @Patch('admin/bookings/:id/dates')
  @Roles(Role.BOOKING_STAFF)
  updateDates(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBookingDatesDto) {
    return this.bookings.updateDates(actor, id, dto);
  }

  @Patch('admin/bookings/:id/passengers/:passengerId/passport')
  @Roles(Role.BOOKING_STAFF)
  updatePassport(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('passengerId', ParseUUIDPipe) passengerId: string, @Body() dto: UpdatePassportDto) {
    return this.bookings.updatePassport(actor, id, passengerId, dto);
  }

  /** POST, not GET: a reveal is an audited action and must never be cached or prefetched. */
  @Post('admin/bookings/:id/passengers/:passengerId/passport/reveal')
  @HttpCode(200)
  @Roles(Role.BOOKING_STAFF)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  revealPassport(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('passengerId', ParseUUIDPipe) passengerId: string) {
    return this.bookings.revealPassport(actor, id, passengerId);
  }

  @Post('admin/bookings/:id/reschedule')
  @HttpCode(200)
  @Roles(Role.BOOKING_STAFF)
  async reschedule(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RescheduleDto) {
    await this.rescheduling.reschedule(actor, id, dto);
    return this.bookings.get(actor, id);
  }

  @Post('admin/bookings')
  @Roles(Role.BOOKING_STAFF)
  createByStaff(@CurrentUser() actor: AuthUser, @Body() dto: CreateInquiryDto) {
    return this.bookings.createByStaff(actor, dto);
  }

  @Get('admin/bookings')
  @Roles(Role.BOOKING_STAFF, Role.FINANCE_STAFF)
  list(@CurrentUser() actor: AuthUser, @Query() q: AdminBookingQuery) {
    return this.bookings.list(actor, q);
  }

  @Get('admin/customers')
  @Roles(Role.BOOKING_STAFF, Role.FINANCE_STAFF)
  customers(@Query() q: CustomerQuery) {
    return this.bookings.customers(q);
  }

  @Get('admin/calendar')
  @Roles(Role.BOOKING_STAFF, Role.FINANCE_STAFF)
  calendar(@Query() q: MonthQuery) {
    return this.bookings.calendar(q.month);
  }

  /** Raw PDF bytes in the body (application/pdf), file name in the query. Optional: staff add the airline's ticket after issuing it. */
  @Post('admin/bookings/:id/ticket-files')
  @Roles(Role.BOOKING_STAFF)
  addTicketFile(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: FileNameQuery, @Req() req: Request) {
    return this.bookings.addTicketFile(actor, id, q.filename, req.body);
  }

  @Get('admin/bookings/:id/ticket-files/:fileId')
  @Roles(Role.BOOKING_STAFF)
  async downloadTicketFile(@Param('id', ParseUUIDPipe) id: string, @Param('fileId', ParseUUIDPipe) fileId: string, @Res() res: Response) {
    const f = await this.bookings.ticketFile(id, fileId);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${f.filename}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    res.send(f.data);
  }

  @Delete('admin/bookings/:id/ticket-files/:fileId')
  @HttpCode(204)
  @Roles(Role.BOOKING_STAFF)
  async removeTicketFile(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('fileId', ParseUUIDPipe) fileId: string) {
    await this.bookings.removeTicketFile(actor, id, fileId);
  }

  @Get('admin/ticketed')
  @Roles(Role.BOOKING_STAFF, Role.FINANCE_STAFF)
  ticketed(@Query() q: SimpleListQuery) {
    return this.bookings.ticketed(q);
  }

  @Get('admin/reschedules')
  @Roles(Role.BOOKING_STAFF, Role.FINANCE_STAFF)
  reschedules(@Query() q: SimpleListQuery) {
    return this.bookings.reschedules(q);
  }

  @Get('admin/flights/:id/manifest')
  @Roles(Role.BOOKING_STAFF, Role.FINANCE_STAFF)
  manifest(@Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.manifest(id);
  }

  @Post('admin/bookings/:id/resend-email')
  @HttpCode(200)
  @Roles(Role.BOOKING_STAFF)
  resend(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.resendEmail(actor, id);
  }

  @Get('admin/bookings-summary')
  @Roles(Role.BOOKING_STAFF, Role.FINANCE_STAFF)
  summary() {
    return this.bookings.summary();
  }

  @Get('admin/bookings/:id')
  @Roles(Role.BOOKING_STAFF, Role.FINANCE_STAFF)
  get(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.get(actor, id);
  }

  @Post('admin/bookings/:id/hold')
  @HttpCode(200)
  @Roles(Role.BOOKING_STAFF)
  hold(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: HoldDto) {
    return this.bookings.hold(actor, id, dto.minutes);
  }

  @Post('admin/bookings/:id/release')
  @HttpCode(200)
  @Roles(Role.BOOKING_STAFF)
  release(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.release(actor, id);
  }

  @Post('admin/bookings/:id/confirm')
  @HttpCode(200)
  @Roles(Role.BOOKING_STAFF)
  confirm(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.confirm(actor, id);
  }

  @Post('admin/bookings/:id/ticket')
  @HttpCode(200)
  @Roles(Role.BOOKING_STAFF)
  ticket(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: IssueTicketDto) {
    return this.bookings.issueTicket(actor, id, dto);
  }

  @Post('admin/bookings/:id/cancel')
  @HttpCode(200)
  @Roles(Role.BOOKING_STAFF)
  cancel(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.bookings.cancel(actor, id, dto.reason);
  }

  @Post('admin/bookings/:id/reject')
  @HttpCode(200)
  @Roles(Role.BOOKING_STAFF)
  reject(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.bookings.reject(actor, id, dto.reason);
  }
}

@Module({
  imports: [FlightsModule],
  controllers: [BookingsController],
  providers: [BookingsRepository, BookingsService, ChangeRequestsService, ReschedulingService],
  exports: [BookingsService, BookingsRepository],
})
export class BookingsModule {}
