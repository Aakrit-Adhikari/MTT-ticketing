import { Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { AuthUser, CurrentUser, Public, Roles } from '../common/auth/decorators';
import { InventoryModule } from '../inventory/inventory.module';
import { AdjustInventoryDto, AdminFlightQuery, CreateFlightDto, SearchFlightsQuery, UpdateFlightDto } from './dto/flight.dto';
import { FlightsRepository } from './flights.repository';
import { FlightsService } from './flights.service';

@Controller()
export class FlightsController {
  constructor(private readonly flights: FlightsService) {}

  @Public()
  @Get('public/flights/search')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  search(@Query() q: SearchFlightsQuery) {
    return this.flights.search(q);
  }

  @Get('admin/flights')
  @Roles(Role.BOOKING_STAFF, Role.FINANCE_STAFF)
  list(@Query() q: AdminFlightQuery) {
    return this.flights.listAdmin(q);
  }

  @Get('admin/flights/:id')
  @Roles(Role.BOOKING_STAFF, Role.FINANCE_STAFF)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.flights.get(id);
  }

  @Delete('admin/flights/:id')
  @HttpCode(204)
  @Roles(Role.BOOKING_STAFF)
  async remove(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.flights.remove(actor, id);
  }

  @Post('admin/flights')
  @Roles(Role.BOOKING_STAFF)
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateFlightDto) {
    return this.flights.create(actor, dto);
  }

  @Patch('admin/flights/:id')
  @Roles(Role.BOOKING_STAFF)
  update(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFlightDto) {
    return this.flights.update(actor, id, dto);
  }

  /** Changing the agency's allocation is a high-impact action, so it is limited to Super Admin. */
  @Post('admin/flights/:id/inventory/adjust')
  @Roles(Role.SUPER_ADMIN)
  adjust(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdjustInventoryDto) {
    return this.flights.adjustInventory(actor, id, dto);
  }
}

@Module({
  controllers: [FlightsController],
  imports: [InventoryModule],
  providers: [FlightsRepository, FlightsService],
  exports: [FlightsRepository, InventoryModule],
})
export class FlightsModule {}
