import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import { json, raw, urlencoded } from 'express';
import helmet from 'helmet';
import { AirlinesModule } from './airlines/airlines.module';
import { AirportsModule } from './airports/airports.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BookingsModule } from './bookings/bookings.module';
import { JwtAuthGuard, RolesGuard } from './common/auth/guards';
import { friendlyValidation } from './common/validation/friendly';
import { ConfigModule } from './common/config/config.module';
import { Env } from './common/config/env';
import { CryptoModule } from './common/crypto/field-crypto.service';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { DatabaseModule } from './database/prisma.service';
import { FlightsModule } from './flights/flights.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PaymentsModule } from './payments/payments.module';
import { ReportsModule } from './reports/reports.module';
import { SectorsModule } from './sectors/sectors.module';
import { HealthModule } from './health/health.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    CryptoModule,
    AuditModule,
    NotificationsModule,
    // Rate limiting is only bypassed under NODE_ENV=test (the integration suite logs in far more than 10x/min).
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 120 }], skipIf: () => process.env.NODE_ENV === 'test' }),
    UsersModule,
    AuthModule,
    AirlinesModule,
    AirportsModule,
    SectorsModule,
    FlightsModule,
    BookingsModule,
    PaymentsModule,
    ReportsModule,
    HealthModule,
  ],
  providers: [
    // Order matters: throttle → authenticate → authorize. Authorization is default-deny (see RolesGuard).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}

/** Shared by main.ts and the integration tests so tests exercise the real HTTP configuration. */
export function configureApp(app: INestApplication, env: Env): void {
  const server = app.getHttpAdapter().getInstance();
  server.disable('x-powered-by');
  if (env.TRUST_PROXY > 0) server.set('trust proxy', env.TRUST_PROXY); // so rate limits use the real client IP behind the reverse proxy

  app.use(helmet());
  app.use('/api/admin/bookings', raw({ type: 'application/pdf', limit: '6mb' })); // airline ticket PDF upload: raw bytes, 5 MB enforced in the service
  app.use('/api/admin/airlines', raw({ type: 'image/*', limit: '1mb' })); // airline logo upload: raw image bytes, 1 MB max
  app.use(json({ limit: '100kb' }));
  app.use(urlencoded({ extended: false, limit: '100kb' }));
  app.use(cookieParser());
  app.enableCors({
    origin: env.FRONTEND_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory: friendlyValidation }));
  app.useGlobalFilters(new AllExceptionsFilter());
}
