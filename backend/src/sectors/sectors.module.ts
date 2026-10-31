import { Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.module';
import { AuthUser, CurrentUser, Public, Roles } from '../common/auth/decorators';
import { PrismaService } from '../database/prisma.service';

/** A sector is just a name: a mountain flight, a scenic flight... It has no origin, destination or arrival. */
export class CreateSectorDto {
  @IsString() @MinLength(2) @MaxLength(100) name!: string;
}

export class UpdateSectorDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@Injectable()
export class SectorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(onlyActive = false) {
    return this.prisma.sector.findMany({ where: onlyActive ? { isActive: true } : {}, orderBy: { name: 'asc' } });
  }

  async create(actor: AuthUser, dto: CreateSectorDto) {
    const sector = await this.prisma.sector.create({ data: { name: dto.name.trim() } });
    await this.audit.record({ actorId: actor.id, action: 'sector.create', entityType: 'Sector', entityId: sector.id });
    return sector;
  }

  async remove(actor: AuthUser, id: string) {
    const n = await this.prisma.flight.count({ where: { sectorId: id } });
    if (n > 0) throw new ConflictException(`This sector has ${n} flight${n === 1 ? '' : 's'}. Delete ${n === 1 ? 'it' : 'them'} first.`);
    const r = await this.prisma.sector.deleteMany({ where: { id } });
    if (r.count === 0) throw new NotFoundException('Sector not found');
    await this.audit.record({ actorId: actor.id, action: 'sector.delete', entityType: 'Sector', entityId: id });
  }

  async update(actor: AuthUser, id: string, dto: UpdateSectorDto) {
    const data = { ...(dto.name !== undefined ? { name: dto.name.trim() } : {}), ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}) };
    const r = await this.prisma.sector.updateMany({ where: { id }, data });
    if (r.count === 0) throw new NotFoundException('Sector not found');
    await this.audit.record({ actorId: actor.id, action: 'sector.update', entityType: 'Sector', entityId: id, detail: data });
    return this.prisma.sector.findUniqueOrThrow({ where: { id } });
  }
}

@Controller()
export class SectorsController {
  constructor(private readonly service: SectorsService) {}

  /** Public: fills the single "sector" box on the search form. */
  @Public()
  @Get('public/sectors')
  async publicList() {
    return (await this.service.list(true)).map(({ id, name }) => ({ id, name }));
  }

  @Get('admin/sectors')
  @Roles(Role.BOOKING_STAFF, Role.FINANCE_STAFF)
  list() {
    return this.service.list();
  }

  @Post('admin/sectors')
  @Roles(Role.SUPER_ADMIN, Role.BOOKING_STAFF)
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateSectorDto) {
    return this.service.create(actor, dto);
  }

  @Delete('admin/sectors/:id')
  @HttpCode(204)
  @Roles(Role.SUPER_ADMIN, Role.BOOKING_STAFF)
  async remove(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(actor, id);
  }

  @Patch('admin/sectors/:id')
  @Roles(Role.SUPER_ADMIN, Role.BOOKING_STAFF)
  update(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSectorDto) {
    return this.service.update(actor, id, dto);
  }
}

@Module({ controllers: [SectorsController], providers: [SectorsService] })
export class SectorsModule {}
