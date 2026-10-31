import { Global, Module } from '@nestjs/common';
import { Env, getEnv } from './env';

export const APP_ENV = 'APP_ENV';

@Global()
@Module({
  providers: [{ provide: APP_ENV, useFactory: (): Env => getEnv() }],
  exports: [APP_ENV],
})
export class ConfigModule {}
