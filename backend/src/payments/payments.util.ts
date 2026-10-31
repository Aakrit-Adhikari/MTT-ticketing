import { BookingStatus, PaymentStatus, PaymentType, PassengerType, Prisma } from '@prisma/client';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

export interface SummaryInput {
  status: BookingStatus;
  confirmedAt: Date | null;
  segments: { adultFare: Prisma.Decimal; childFare: Prisma.Decimal }[];
  passengers: { type: PassengerType }[];
  payments: { type: PaymentType; status: PaymentStatus; amount: Prisma.Decimal }[];
}

export type PayState = 'NONE' | 'UNPAID' | 'PARTIAL' | 'PAID' | 'OVERPAID' | 'REFUND_DUE' | 'REFUNDED';

export interface Summary {
  total: Prisma.Decimal;
  paid: Prisma.Decimal;
  refunded: Prisma.Decimal;
  net: Prisma.Decimal;
  balance: Prisma.Decimal;
  status: PayState;
  active: boolean;
}

/**
 * What the customer owes = sum over legs of (adults x adult fare + children x child fare), using the fares
 * snapshotted on the booking. Infants (lap) are not charged by this system. Voided payments never count.
 */
export function summarize(b: SummaryInput): Summary {
  const adults = b.passengers.filter((p) => p.type === 'ADULT').length;
  const children = b.passengers.filter((p) => p.type === 'CHILD').length;
  const active = !['CANCELLED', 'REJECTED', 'EXPIRED'].includes(b.status);
  const fare = b.segments.reduce((sum, s) => sum.plus(D(s.adultFare).mul(adults)).plus(D(s.childFare).mul(children)), D(0));
  const live = b.payments.filter((p) => p.status === 'RECORDED');
  const paid = live.filter((p) => p.type === 'PAYMENT').reduce((s, p) => s.plus(D(p.amount)), D(0));
  const refunded = live.filter((p) => p.type === 'REFUND').reduce((s, p) => s.plus(D(p.amount)), D(0));
  const net = paid.minus(refunded);
  const total = active ? fare : D(0);

  let status: PayState;
  if (!b.confirmedAt && active) status = 'NONE'; // an inquiry is not payable yet
  else if (!active) status = net.gt(0) ? 'REFUND_DUE' : refunded.gt(0) ? 'REFUNDED' : 'NONE';
  else if (net.lte(0)) status = 'UNPAID';
  else if (net.lt(total)) status = 'PARTIAL';
  else if (net.eq(total)) status = 'PAID';
  else status = 'OVERPAID';

  return { total, paid, refunded, net, balance: total.minus(net), status, active };
}

export const money = (d: Prisma.Decimal) => d.toFixed(2);

export const summaryView = (s: Summary) => ({
  total: money(s.total),
  paid: money(s.paid),
  refunded: money(s.refunded),
  net: money(s.net),
  balance: money(s.balance),
  status: s.status,
});

export const receiptNumber = (n: number, at = new Date()): string => `RC-${at.getUTCFullYear()}-${String(n).padStart(6, '0')}`;
