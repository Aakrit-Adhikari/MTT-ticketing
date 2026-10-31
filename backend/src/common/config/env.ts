import { z } from 'zod';

const base64Key32 = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be base64 encoding of exactly 32 bytes');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(4000),
    DATABASE_URL: z.string().startsWith('postgres'),
    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_ISSUER: z.string().min(1).default('mtt-api'),
    JWT_AUDIENCE: z.string().min(1).default('mtt-admin'),
    ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    FRONTEND_ORIGIN: z.string().url(),
    FIELD_ENCRYPTION_KEY: base64Key32,
    COOKIE_SECURE: z.enum(['true', 'false']).optional(),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    HOLD_DEFAULT_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
    // Email. Without SMTP_HOST nothing is sent (dev: emails are printed in the backend window instead).
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    MAIL_FROM: z.string().optional(),
    // Comma-separated staff addresses that receive customer cancellation / reschedule requests.
    STAFF_NOTIFY_EMAIL: z.string().optional(),
    // Printed on receipts and emails.
    AGENCY_NAME: z.string().min(1).default('Mountain Tours and Travels Ticketing'),
  })
  .superRefine((e, ctx) => {
    if (e.JWT_ACCESS_SECRET === e.FIELD_ENCRYPTION_KEY) {
      ctx.addIssue({ code: 'custom', message: 'JWT and encryption secrets must differ' });
    }
    if (e.SMTP_HOST && !e.MAIL_FROM) ctx.addIssue({ code: 'custom', path: ['MAIL_FROM'], message: 'required when SMTP_HOST is set' });
    if (e.NODE_ENV === 'production') {
      if (!e.STAFF_NOTIFY_EMAIL) ctx.addIssue({ code: 'custom', path: ['STAFF_NOTIFY_EMAIL'], message: 'required in production: staff are emailed customer requests' });
      if (!e.SMTP_HOST) ctx.addIssue({ code: 'custom', path: ['SMTP_HOST'], message: 'required in production: customers receive their booking reference by email' });
      if (e.COOKIE_SECURE === 'false') {
        ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'must not be false in production' });
      }
      if (!e.FRONTEND_ORIGIN.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: ['FRONTEND_ORIGIN'], message: 'must be https in production' });
      }
    }
  });

export type Env = z.infer<typeof schema> & { cookieSecure: boolean };

let cached: Env | undefined;

/** Validates process.env once; throws a readable error (never printing values) when misconfigured. */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  cached = { ...e, cookieSecure: e.COOKIE_SECURE ? e.COOKIE_SECURE === 'true' : e.NODE_ENV === 'production' };
  return cached;
}

export function resetEnvCacheForTests(): void {
  cached = undefined;
}
