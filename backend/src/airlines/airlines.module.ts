import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req, Res } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Request, Response } from 'express';
import { AuditService } from '../audit/audit.module';
import { AuthUser, CurrentUser, Public, Roles } from '../common/auth/decorators';
import { PrismaService } from '../database/prisma.service';
import { MAX_LOGO_BYTES, sniffImage } from './image-sniff';

export class CreateAirlineDto {
  @Matches(/^[A-Z0-9]{2,3}$/, { message: 'code must be 2-3 uppercase letters/digits (IATA)' }) code!: string;
  @IsString() @MinLength(2) @MaxLength(100) name!: string;
}

export class UpdateAirlineDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/** Cache-busting URL: changes whenever the logo changes, so browsers can cache it for a long time. */
export const logoUrl = (a: { id: string; logoUpdatedAt: Date | null }): string | null =>
  a.logoUpdatedAt ? `/api/public/airlines/${a.id}/logo?v=${a.logoUpdatedAt.getTime()}` : null;

@Injectable()
export class AirlinesRepository {
  constructor(private readonly prisma: PrismaService) {}
  // The image bytes are never loaded for lists; clients get `logoUrl` and fetch the image separately.
  list() {
    return this.prisma.airline.findMany({ orderBy: { code: 'asc' }, omit: { logoData: true } });
  }
  create(data: CreateAirlineDto) {
    return this.prisma.airline.create({ data, omit: { logoData: true } });
  }
  async update(id: string, data: UpdateAirlineDto) {
    const r = await this.prisma.airline.updateMany({ where: { id }, data });
    if (r.count === 0) throw new NotFoundException('Airline not found');
    return this.prisma.airline.findUniqueOrThrow({ where: { id }, omit: { logoData: true } });
  }
  async setLogo(id: string, logo: { data: Buffer; mime: string } | null) {
    const r = await this.prisma.airline.updateMany({
      where: { id },
      data: logo
        ? { logoData: new Uint8Array(logo.data), logoMime: logo.mime, logoUpdatedAt: new Date() }
        : { logoData: null, logoMime: null, logoUpdatedAt: null },
    });
    if (r.count === 0) throw new NotFoundException('Airline not found');
    return this.prisma.airline.findUniqueOrThrow({ where: { id }, omit: { logoData: true } });
  }
  countFlights(id: string) {
    return this.prisma.flight.count({ where: { airlineId: id } });
  }
  async delete(id: string) {
    const r = await this.prisma.airline.deleteMany({ where: { id } });
    if (r.count === 0) throw new NotFoundException('Airline not found');
  }
  logo(id: string) {
    return this.prisma.airline.findUnique({ where: { id }, select: { logoData: true, logoMime: true } });
  }
}

@Injectable()
export class AirlinesService {
  constructor(
    private readonly repo: AirlinesRepository,
    private readonly audit: AuditService,
  ) {}
  private view<T extends { id: string; logoUpdatedAt: Date | null }>(a: T) {
    return { ...a, logoUrl: logoUrl(a) };
  }
  async list() {
    return (await this.repo.list()).map((a) => this.view(a));
  }
  async create(actor: AuthUser, dto: CreateAirlineDto) {
    const airline = await this.repo.create({ code: dto.code, name: dto.name.trim() });
    await this.audit.record({ actorId: actor.id, action: 'airline.create', entityType: 'Airline', entityId: airline.id });
    return this.view(airline);
  }
  async update(actor: AuthUser, id: string, dto: UpdateAirlineDto) {
    const airline = await this.repo.update(id, dto);
    await this.audit.record({ actorId: actor.id, action: 'airline.update', entityType: 'Airline', entityId: id, detail: { ...dto } });
    return this.view(airline);
  }
  async uploadLogo(actor: AuthUser, id: string, body: unknown) {
    if (!Buffer.isBuffer(body) || body.length === 0) throw new BadRequestException('Send the image file as the request body (Content-Type: image/*)');
    if (body.length > MAX_LOGO_BYTES) throw new BadRequestException('Logo must be smaller than 1 MB');
    const mime = sniffImage(body);
    if (!mime) throw new BadRequestException('Unsupported file. Use a PNG, JPG, GIF, WebP, AVIF, BMP, ICO or SVG image');
    const airline = await this.repo.setLogo(id, { data: body, mime });
    await this.audit.record({ actorId: actor.id, action: 'airline.logo.set', entityType: 'Airline', entityId: id, detail: { bytes: body.length, mime } });
    return this.view(airline);
  }
  async remove(actor: AuthUser, id: string) {
    const n = await this.repo.countFlights(id);
    if (n > 0) throw new ConflictException(`This airline has ${n} flight${n === 1 ? '' : 's'}. Delete ${n === 1 ? 'it' : 'them'} first.`);
    await this.repo.delete(id);
    await this.audit.record({ actorId: actor.id, action: 'airline.delete', entityType: 'Airline', entityId: id });
  }
  async removeLogo(actor: AuthUser, id: string) {
    const airline = await this.repo.setLogo(id, null);
    await this.audit.record({ actorId: actor.id, action: 'airline.logo.remove', entityType: 'Airline', entityId: id });
    return this.view(airline);
  }
  async logo(id: string) {
    const a = await this.repo.logo(id);
    if (!a?.logoData || !a.logoMime) throw new NotFoundException('No logo');
    return { data: Buffer.from(a.logoData), mime: a.logoMime };
  }
}

@Controller('admin/airlines')
export class AirlinesController {
  constructor(private readonly service: AirlinesService) {}

  @Get()
  @Roles(Role.BOOKING_STAFF, Role.FINANCE_STAFF)
  list() {
    return this.service.list();
  }

  @Post()
  @Roles(Role.SUPER_ADMIN)
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateAirlineDto) {
    return this.service.create(actor, dto);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN)
  update(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAirlineDto) {
    return this.service.update(actor, id, dto);
  }

  /** Raw image bytes in the body (parsed by the `image/*` raw parser set up in configureApp, capped at 1 MB). */
  @Post(':id/logo')
  @Roles(Role.SUPER_ADMIN)
  uploadLogo(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.service.uploadLogo(actor, id, req.body);
  }

  @Delete(':id')
  @HttpCode(204)
  @Roles(Role.SUPER_ADMIN)
  async remove(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(actor, id);
  }

  @Delete(':id/logo')
  @Roles(Role.SUPER_ADMIN)
  removeLogo(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.removeLogo(actor, id);
  }
}

@Controller('public/airlines')
export class PublicAirlinesController {
  constructor(private readonly service: AirlinesService) {}

  @Public()
  @Get(':id/logo')
  async logo(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { data, mime } = await this.service.logo(id);
    res.set({
      'Content-Type': mime,
      'Content-Length': String(data.length),
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      // An SVG opened directly (not through <img>) must not be able to run script.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    res.end(data);
  }
}

@Module({ controllers: [AirlinesController, PublicAirlinesController], providers: [AirlinesRepository, AirlinesService] })
export class AirlinesModule {}
