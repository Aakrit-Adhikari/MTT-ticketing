import { randomBytes } from 'crypto';
import { getEnv, resetEnvCacheForTests } from './env';

const good = () => ({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@db:5432/x',
  JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'),
  FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  FRONTEND_ORIGIN: 'https://tickets.example.com',
  SMTP_HOST: 'smtp.example.com',
  MAIL_FROM: 'Agency <tickets@example.com>',
  STAFF_NOTIFY_EMAIL: 'staff@example.com',
});

describe('environment validation', () => {
  const saved = process.env;
  beforeEach(() => { resetEnvCacheForTests(); process.env = {} as NodeJS.ProcessEnv; });
  afterAll(() => { process.env = saved; resetEnvCacheForTests(); });

  it('accepts a complete production config and defaults cookies to Secure', () => {
    Object.assign(process.env, good());
    expect(getEnv().cookieSecure).toBe(true);
  });

  it('fails fast and names the variables without echoing secret values', () => {
    const bad = { ...good(), JWT_ACCESS_SECRET: 'short-secret-value', FIELD_ENCRYPTION_KEY: 'not-base64-32' };
    Object.assign(process.env, bad);
    let msg = '';
    try { getEnv(); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('JWT_ACCESS_SECRET');
    expect(msg).toContain('FIELD_ENCRYPTION_KEY');
    expect(msg).not.toContain('short-secret-value');
  });

  it('requires SMTP in production because customers get their reference by email', () => {
    const g: Record<string, string> = { ...good() };
    delete g.SMTP_HOST;
    Object.assign(process.env, g);
    expect(() => getEnv()).toThrow(/SMTP_HOST/);
  });

  it('rejects missing variables, reused secrets, insecure origin and Secure=false in production', () => {
    expect(() => getEnv()).toThrow(/DATABASE_URL/);
    resetEnvCacheForTests();
    const g = good();
    Object.assign(process.env, g, { JWT_ACCESS_SECRET: g.FIELD_ENCRYPTION_KEY + 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' });
    expect(() => getEnv()).not.toThrow(); // different strings → fine
    resetEnvCacheForTests();
    Object.assign(process.env, g, { FRONTEND_ORIGIN: 'http://tickets.example.com' });
    expect(() => getEnv()).toThrow(/FRONTEND_ORIGIN/);
    resetEnvCacheForTests();
    Object.assign(process.env, g, { FRONTEND_ORIGIN: 'https://x.com', COOKIE_SECURE: 'false' });
    expect(() => getEnv()).toThrow(/COOKIE_SECURE/);
  });
});
