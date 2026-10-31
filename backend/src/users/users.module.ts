import { Body, Controller, Get, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, ConflictException, NotFoundException } from '@nestjs/common';
import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Role, User } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuditService } from '../audit/audit.module';
import { AuthUser, CurrentUser, Roles } from '../common/auth/decorators';
import { PrismaService } from '../database/prisma.service';

export const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
export const MIN_PASSWORD_LENGTH = 12;

type SafeUser = Omit<User, 'passwordHash'>;
const toSafe = ({ passwordHash: _omit, ...rest }: User): SafeUser => rest;

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}
  findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }
  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }
  list() {
    return this.prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
  }
  create(data: { email: string; name: string; passwordHash: string; role: Role }) {
    return this.prisma.user.create({ data });
  }
  update(id: string, data: Partial<Pick<User, 'name' | 'role' | 'isActive' | 'failedLogins' | 'lockedUntil' | 'passwordHash'>> & { tokenVersion?: { increment: number } }) {
    return this.prisma.user.update({ where: { id }, data });
  }
}

@Injectable()
export class UsersService {
  constructor(
    private readonly repo: UsersRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(actor: AuthUser | null, input: { email: string; name: string; password: string; role: Role }): Promise<SafeUser> {
    const email = input.email.trim().toLowerCase();
    if (await this.repo.findByEmail(email)) throw new ConflictException('A user with this email already exists');
    const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS);
    const user = await this.repo.create({ email, name: input.name.trim(), passwordHash, role: input.role });
    await this.audit.record({ actorId: actor?.id, action: 'user.create', entityType: 'User', entityId: user.id, detail: { role: user.role } });
    return toSafe(user);
  }

  async list(): Promise<SafeUser[]> {
    return (await this.repo.list()).map(toSafe);
  }

  /** Disabling or changing a role invalidates outstanding access tokens and revokes every refresh session. */
  async update(actor: AuthUser, id: string, patch: { role?: Role; isActive?: boolean; name?: string }): Promise<SafeUser> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('User not found');
    if (id === actor.id && (patch.isActive === false || (patch.role && patch.role !== actor.role))) {
      throw new ConflictException('You cannot disable or demote your own account');
    }
    const securityChange = patch.isActive === false || (patch.role !== undefined && patch.role !== existing.role);
    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id },
        data: { ...patch, ...(securityChange ? { tokenVersion: { increment: 1 } } : {}) },
      });
      if (securityChange) await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record({ actorId: actor.id, action: 'user.update', entityType: 'User', entityId: id, detail: { ...patch } }, tx);
      return u;
    });
    return toSafe(user);
  }
}

export class CreateUserDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsString() @MinLength(MIN_PASSWORD_LENGTH) @MaxLength(128) password!: string;
  @IsEnum(Role) role!: Role;
}

export class UpdateUserDto {
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
}

@Controller('admin/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN)
  list() {
    return this.users.list();
  }

  @Post()
  @Roles(Role.SUPER_ADMIN)
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateUserDto) {
    return this.users.create(actor, dto);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN)
  update(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(actor, id, dto);
  }
}

@Module({
  controllers: [UsersController],
  providers: [UsersRepository, UsersService],
  exports: [UsersRepository, UsersService],
})
export class UsersModule {}
