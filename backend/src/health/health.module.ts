import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { HealthCheck, HealthCheckService, HealthIndicatorService, TerminusModule } from '@nestjs/terminus';
import { Public } from '../common/auth/decorators';
import { PrismaService } from '../database/prisma.service';

@Injectable()
class DbIndicator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly indicators: HealthIndicatorService,
  ) {}
  async check(key: string) {
    const i = this.indicators.check(key);
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return i.up();
    } catch {
      return i.down(); // no error detail leaked
    }
  }
}

@Controller('health')
class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: DbIndicator,
  ) {}

  /** Liveness: process is up. */
  @Public()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: database reachable. */
  @Public()
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([() => this.db.check('database')]);
  }
}

@Module({ imports: [TerminusModule], controllers: [HealthController], providers: [DbIndicator] })
export class HealthModule {}
