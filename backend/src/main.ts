import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule, configureApp } from './app.module';
import { getEnv } from './common/config/env';

async function bootstrap(): Promise<void> {
  const env = getEnv(); // fail fast on bad configuration, before anything listens
  const app = await NestFactory.create(AppModule, { logger: env.NODE_ENV === 'production' ? ['log', 'warn', 'error'] : undefined });
  configureApp(app, env);
  app.enableShutdownHooks(); // SIGTERM → drain connections, disconnect Prisma
  await app.listen(env.PORT, '0.0.0.0');
  new Logger('Bootstrap').log(`API listening on :${env.PORT}`);
}

bootstrap().catch((err: Error) => {
  console.error(err.message); // config errors list variable names only, never values
  process.exit(1);
});
