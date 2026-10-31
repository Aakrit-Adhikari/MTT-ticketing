import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser, CurrentUser, Roles } from '../common/auth/decorators';
import { BookingsModule } from '../bookings/bookings.module';
import { RecordPaymentDto, VoidPaymentDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';

@Controller('admin')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** Counter staff may take payments; only finance may refund or void. */
  @Post('bookings/:id/payments')
  @Roles(Role.BOOKING_STAFF, Role.FINANCE_STAFF)
  record(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordPaymentDto) {
    return this.payments.record(actor, id, dto, 'PAYMENT');
  }

  @Post('bookings/:id/refunds')
  @Roles(Role.FINANCE_STAFF)
  refund(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordPaymentDto) {
    return this.payments.record(actor, id, dto, 'REFUND');
  }

  @Post('payments/:id/void')
  @HttpCode(200)
  @Roles(Role.FINANCE_STAFF)
  void(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VoidPaymentDto) {
    return this.payments.voidPayment(actor, id, dto.reason);
  }

  @Get('payments/:id/receipt')
  @Roles(Role.BOOKING_STAFF, Role.FINANCE_STAFF)
  receipt(@Param('id', ParseUUIDPipe) id: string) {
    return this.payments.receipt(id);
  }
}

@Module({ imports: [BookingsModule], controllers: [PaymentsController], providers: [PaymentsService] })
export class PaymentsModule {}
