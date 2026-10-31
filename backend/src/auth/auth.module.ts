import { Body, Controller, ForbiddenException, Get, HttpCode, Inject, Module, Post, Req, Res } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, MaxLength } from 'class-validator';
import { Request, Response } from 'express';
import { AuthUser, CurrentUser, Public, Roles } from '../common/auth/decorators';
import { APP_ENV } from '../common/config/config.module';
import { Env } from '../common/config/env';
import { UsersModule } from '../users/users.module';
import { AuthService, IssuedSession } from './auth.service';
import { Role } from '@prisma/client';

export const REFRESH_COOKIE = 'mtt_rt';
const REFRESH_PATH = '/api/auth';

class LoginDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MaxLength(128) password!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.login(dto.email, dto.password));
  }

  /**
   * The refresh credential is an HttpOnly, SameSite=Strict cookie scoped to /api/auth. As CSRF defence in depth
   * we also require a custom header (cannot be sent cross-site without CORS preflight) and a matching Origin.
   */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.assertSameOrigin(req);
    try {
      return this.respond(res, await this.auth.refresh(req.cookies?.[REFRESH_COOKIE]));
    } catch (e) {
      this.clearCookie(res);
      throw e;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    this.assertSameOrigin(req);
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    this.clearCookie(res);
  }

  @Get('me')
  @Roles(Role.BOOKING_STAFF, Role.FINANCE_STAFF)
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  private assertSameOrigin(req: Request): void {
    const origin = req.headers.origin;
    const hasHeader = req.headers['x-requested-with'] === 'mtt-admin';
    if (!hasHeader || (origin && origin !== this.env.FRONTEND_ORIGIN)) throw new ForbiddenException();
  }

  private respond(res: Response, s: IssuedSession) {
    res.cookie(REFRESH_COOKIE, s.refreshToken, {
      httpOnly: true,
      secure: this.env.cookieSecure,
      sameSite: 'strict',
      path: REFRESH_PATH,
      expires: s.refreshExpiresAt,
    });
    res.setHeader('Cache-Control', 'no-store');
    return { accessToken: s.accessToken, expiresIn: s.expiresIn, user: s.user };
  }

  private clearCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: this.env.cookieSecure, sameSite: 'strict', path: REFRESH_PATH });
  }
}

@Module({
  imports: [UsersModule, JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [JwtModule],
})
export class AuthModule {}
