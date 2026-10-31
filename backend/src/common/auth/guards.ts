import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../../database/prisma.service';
import { APP_ENV } from '../config/config.module';
import { Env } from '../config/env';
import { AuthUser, IS_PUBLIC, ROLES_KEY } from './decorators';

interface AccessClaims {
  sub: string;
  tv: number;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException();

    let claims: AccessClaims;
    try {
      // Algorithm, issuer, audience and expiry are all pinned/validated.
      claims = await this.jwt.verifyAsync<AccessClaims>(token, {
        secret: this.env.JWT_ACCESS_SECRET,
        algorithms: ['HS256'],
        issuer: this.env.JWT_ISSUER,
        audience: this.env.JWT_AUDIENCE,
      });
    } catch {
      throw new UnauthorizedException();
    }

    // Re-check the account on every request so disablement / token-version bump is immediate.
    const user = await this.prisma.user.findUnique({ where: { id: claims.sub } });
    if (!user || !user.isActive || user.tokenVersion !== claims.tv) throw new UnauthorizedException();

    req.user = { id: user.id, email: user.email, role: user.role };
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const allowed = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    const user: AuthUser | undefined = ctx.switchToHttp().getRequest().user;
    if (!user || !allowed || allowed.length === 0) throw new ForbiddenException(); // default-deny
    if (user.role === Role.SUPER_ADMIN || allowed.includes(user.role)) return true;
    throw new ForbiddenException();
  }
}
