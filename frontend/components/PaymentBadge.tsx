const LABEL: Record<string, string> = {
  NONE: '', UNPAID: 'UNPAID', PARTIAL: 'PARTLY PAID', PAID: 'PAID', OVERPAID: 'OVERPAID', REFUND_DUE: 'REFUND DUE', REFUNDED: 'REFUNDED',
};
const CLS: Record<string, string> = { UNPAID: 'CANCELLED', PARTIAL: 'HELD', PAID: 'CONFIRMED', OVERPAID: 'HELD', REFUND_DUE: 'CANCELLED', REFUNDED: 'INQUIRY' };

export default function PaymentBadge({ status }: { status: string }) {
  if (!LABEL[status]) return <span className="muted">-</span>;
  return <span className={`badge s-${CLS[status]}`}>{LABEL[status]}</span>;
}
