import { randomBytes } from 'crypto';
import { FieldCryptoService } from './field-crypto.service';
import { Env } from '../config/env';

const make = () => new FieldCryptoService({ FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64') } as Env);

describe('FieldCryptoService (AES-256-GCM)', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const c = make();
    const a = c.encrypt('NP1234567');
    expect(c.decrypt(a)).toBe('NP1234567');
    expect(c.encrypt('NP1234567')).not.toBe(a);
    expect(a).not.toContain('NP1234567');
  });
  it('detects tampering and wrong keys', () => {
    const c = make();
    const [v, iv, tag, ct] = c.encrypt('secret').split('.');
    const flipped = Buffer.from(ct, 'base64url'); flipped[0] ^= 1;
    expect(() => c.decrypt([v, iv, tag, flipped.toString('base64url')].join('.'))).toThrow();
    expect(() => make().decrypt(c.encrypt('secret'))).toThrow();
  });
  it('masks all but the last three characters', () => {
    expect(FieldCryptoService.mask('NP1234567')).toBe('******567');
    expect(FieldCryptoService.mask('ab')).toBe('***');
  });
});
