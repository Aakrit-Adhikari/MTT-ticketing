import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { APP_ENV } from '../config/config.module';
import { Env } from '../config/env';

/**
 * Application-level authenticated encryption (AES-256-GCM, Node built-in crypto) for
 * recoverable sensitive fields. Envelope format: "v1.<iv>.<tag>.<ciphertext>" (base64url).
 * The version prefix lets a future key rotation re-encrypt lazily. Not searchable by design.
 */
@Injectable()
export class FieldCryptoService {
  private readonly key: Buffer;

  constructor(@Inject(APP_ENV) env: Env) {
    this.key = Buffer.from(env.FIELD_ENCRYPTION_KEY, 'base64');
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(envelope: string): string {
    const [v, iv, tag, ct] = envelope.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported ciphertext envelope');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }

  /** For display: never expose more than the last 3 characters. */
  static mask(plain: string): string {
    return plain.length <= 3 ? '***' : `${'*'.repeat(plain.length - 3)}${plain.slice(-3)}`;
  }
}

@Global()
@Module({ providers: [FieldCryptoService], exports: [FieldCryptoService] })
export class CryptoModule {}
