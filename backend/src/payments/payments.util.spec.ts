import { Prisma } from '@prisma/client';
import { summarize } from './payments.util';

const D = (v: string) => new Prisma.Decimal(v);
const base = (over: Partial<Parameters<typeof summarize>[0]> = {}) => ({
  status: 'CONFIRMED' as const,
  confirmedAt: new Date(),
  segments: [{ adultFare: D('5500'), childFare: D('4200') }, { adultFare: D('5000'), childFare: D('3900') }],
  passengers: [{ type: 'ADULT' as const }, { type: 'ADULT' as const }, { type: 'CHILD' as const }, { type: 'INFANT' as const }],
  payments: [],
  ...over,
});
const pay = (amount: string, type: 'PAYMENT' | 'REFUND' = 'PAYMENT', status: 'RECORDED' | 'VOIDED' = 'RECORDED') => ({ amount: D(amount), type, status });

describe('payment summary', () => {
  it('prices adults and children per leg using the snapshotted fares; infants are free', () => {
    // leg1: 2x5500 + 4200 = 15200 ; leg2: 2x5000 + 3900 = 13900
    expect(summarize(base()).total.toFixed(2)).toBe('29100.00');
  });

  it('walks UNPAID -> PARTIAL -> PAID -> OVERPAID', () => {
    expect(summarize(base()).status).toBe('UNPAID');
    expect(summarize(base({ payments: [pay('10000')] })).status).toBe('PARTIAL');
    expect(summarize(base({ payments: [pay('10000')] })).balance.toFixed(2)).toBe('19100.00');
    expect(summarize(base({ payments: [pay('29100')] })).status).toBe('PAID');
    expect(summarize(base({ payments: [pay('29100'), pay('1')] })).status).toBe('OVERPAID');
  });

  it('ignores voided entries completely', () => {
    expect(summarize(base({ payments: [pay('29100', 'PAYMENT', 'VOIDED')] })).status).toBe('UNPAID');
  });

  it('subtracts refunds', () => {
    const s = summarize(base({ payments: [pay('29100'), pay('5000', 'REFUND')] }));
    expect(s.net.toFixed(2)).toBe('24100.00');
    expect(s.status).toBe('PARTIAL');
  });

  it('shows REFUND_DUE for a cancelled booking that still holds money, then REFUNDED', () => {
    const cancelled = { status: 'CANCELLED' as const };
    expect(summarize(base({ ...cancelled, payments: [pay('10000')] })).status).toBe('REFUND_DUE');
    expect(summarize(base({ ...cancelled, payments: [pay('10000'), pay('10000', 'REFUND')] })).status).toBe('REFUNDED');
    expect(summarize(base({ ...cancelled })).status).toBe('NONE');
  });

  it('treats an unconfirmed inquiry as not payable yet', () => {
    expect(summarize(base({ status: 'INQUIRY', confirmedAt: null })).status).toBe('NONE');
  });

  it('is exact with decimals (no floating-point drift)', () => {
    const s = summarize(base({ segments: [{ adultFare: D('0.10'), childFare: D('0.20') }], passengers: [{ type: 'ADULT' }, { type: 'ADULT' }, { type: 'ADULT' }], payments: [pay('0.30')] }));
    expect(s.status).toBe('PAID');
  });
});
