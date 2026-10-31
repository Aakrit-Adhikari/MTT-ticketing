import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'crypto';
import * as argon2 from 'argon2';
import { AuditService } from '../audit/audit.module';
import { APP_ENV } from '../common/config/config.module';
import { Env } from '../common/config/env';
import { PrismaService } from '../database/prisma.service';
import { ARGON2_OPTIONS, UsersRepository } from '../users/users.module';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

export interface IssuedSession {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: { id: string; email: string; name: string; role: string };
}

export const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex');

@Injectable()
export class AuthService {
  // Verified against when the account does not exist, so response time doesn't reveal which emails are registered.
  private dummyHash?: Promise<string>;

  constructor(
    private readonly users: UsersRepository,
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  async login(email: string, password: string): Promise<IssuedSession> {
    const user = await this.users.findByEmail(email.trim().toLowerCase());
    this.dummyHash ??= argon2.hash('not-a-real-password', ARGON2_OPTIONS);
    const hash = user?.passwordHash ?? (await this.dummyHash);
    const passwordOk = await argon2.verify(hash, password).catch(() => false);
    const locked = !!user?.lockedUntil && user.lockedUntil > new Date();

    // One generic failure for: unknown email, wrong password, disabled account, locked account.
    if (!user || !passwordOk || !user.isActive || locked) {
      if (user && user.isActive && !passwordOk && !locked) await this.registerFailure(user.id, user.failedLogins);
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.failedLogins > 0 || user.lockedUntil) await this.users.update(user.id, { failedLogins: 0, lockedUntil: null });
    await this.audit.record({ actorId: user.id, action: 'auth.login', entityType: 'User', entityId: user.id });
    return this.issue(user, randomUUID());
  }

  /**
   * Rotation with reuse detection. Each refresh token is single-use. Presenting one that was already
   * rotated (or revoked) means it leaked or was replayed, so the whole family is revoked.
   */
  async refresh(rawToken: string | undefined): Promise<IssuedSession> {
    if (!rawToken) throw new UnauthorizedException();
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(rawToken) }, include: { user: true } });
    if (!row) throw new UnauthorizedException();

    if (row.usedAt || row.revokedAt) {
      await this.revokeFamily(row.familyId);
      await this.audit.record({ actorId: row.userId, action: 'auth.refresh_reuse_detected', entityType: 'User', entityId: row.userId });
      throw new UnauthorizedException();
    }
    if (row.expiresAt <= new Date() || !row.user.isActive) throw new UnauthorizedException();

    // Atomic claim: only one concurrent request can flip usedAt from null; the loser is treated as reuse.
    const claimed = await this.prisma.refreshToken.updateMany({ where: { id: row.id, usedAt: null, revokedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) {
      await this.revokeFamily(row.familyId);
      throw new UnauthorizedException();
    }
    return this.issue(row.user, row.familyId);
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
    if (row) await this.revokeFamily(row.familyId);
  }

  private revokeFamily(familyId: string) {
    return this.prisma.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  private async registerFailure(userId: string, current: number): Promise<void> {
    const failedLogins = current + 1;
    const lockedUntil = failedLogins >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null;
    await this.users.update(userId, { failedLogins: lockedUntil ? 0 : failedLogins, lockedUntil });
    if (lockedUntil) await this.audit.record({ actorId: userId, action: 'auth.account_locked', entityType: 'User', entityId: userId });
  }

  private async issue(user: { id: string; email: string; name: string; role: string; tokenVersion: number }, familyId: string): Promise<IssuedSession> {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, role: user.role, tv: user.tokenVersion },
      {
        secret: this.env.JWT_ACCESS_SECRET,
        algorithm: 'HS256',
        issuer: this.env.JWT_ISSUER,
        audience: this.env.JWT_AUDIENCE,
        expiresIn: this.env.ACCESS_TTL_SECONDS,
      },
    );
    const refreshToken = randomBytes(32).toString('base64url');
    const refreshExpiresAt = new Date(Date.now() + this.env.REFRESH_TTL_DAYS * 86_400_000);
    await this.prisma.refreshToken.create({
      data: { userId: user.id, familyId, tokenHash: hashToken(refreshToken), expiresAt: refreshExpiresAt },
    });
    return {
      accessToken,
      expiresIn: this.env.ACCESS_TTL_SECONDS,
      refreshToken,
      refreshExpiresAt,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  }
}
