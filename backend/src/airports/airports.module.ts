import { Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.module';
import { AuthUser, CurrentUser, Public, Roles } from '../common/auth/decorators';
import { PrismaService } from '../database/prisma.service';

export class CreateAirportDto {
  @Matches(/^[A-Z]{3}$/, { message: 'iata must be 3 uppercase letters' }) iata!: string;
  @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @IsString() @MinLength(2) @MaxLength(100) city!: string;
}

@Injectable()
export class AirportsRepository {
  constructor(private readonly prisma: PrismaService) {}
  list() {
    return this.prisma.airport.findMany({ orderBy: { iata: 'asc' } });
  }
  create(data: CreateAirportDto) {
    return this.prisma.airport.create({ data });
  }
  countFlights(id: string) {
    return this.prisma.flight.count({ where: { OR: [{ originId: id }, { destinationId: id }] } });
  }
  async delete(id: string) {
    const r = await this.prisma.airport.deleteMany({ where: { id } });
    if (r.count === 0) throw new NotFoundException('Airport not found');
  }
}

@Injectable()
export class AirportsService {
  constructor(
    private readonly repo: AirportsRepository,
    private readonly audit: AuditService,
  ) {}
  list() {
    return this.repo.list();
  }
  async remove(actor: AuthUser, id: string) {
    const n = await this.repo.countFlights(id);
    if (n > 0) throw new ConflictException(`This airport is used by ${n} flight${n === 1 ? '' : 's'}. Delete ${n === 1 ? 'it' : 'them'} first.`);
    await this.repo.delete(id);
    await this.audit.record({ actorId: actor.id, action: 'airport.delete', entityType: 'Airport', entityId: id });
  }
  async create(actor: AuthUser, dto: CreateAirportDto) {
    const airport = await this.repo.create({ iata: dto.iata, name: dto.name.trim(), city: dto.city.trim() });
    await this.audit.record({ actorId: actor.id, action: 'airport.create', entityType: 'Airport', entityId: airport.id });
    return airport;
  }
}

@Controller()
export class AirportsController {
  constructor(private readonly service: AirportsService) {}

  /** Public: used to populate the search form. Exposes only non-sensitive reference data. */
  @Public()
  @Get('public/airports')
  async publicList() {
    return (await this.service.list()).map(({ iata, name, city }) => ({ iata, name, city }));
  }

  @Get('admin/airports')
  @Roles(Role.BOOKING_STAFF, Role.FINANCE_STAFF)
  list() {
    return this.service.list();
  }

  @Delete('admin/airports/:id')
  @HttpCode(204)
  @Roles(Role.SUPER_ADMIN)
  async remove(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(actor, id);
  }

  @Post('admin/airports')
  @Roles(Role.SUPER_ADMIN)
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateAirportDto) {
    return this.service.create(actor, dto);
  }
}

@Module({ controllers: [AirportsController], providers: [AirportsRepository, AirportsService] })
export class AirportsModule {}
