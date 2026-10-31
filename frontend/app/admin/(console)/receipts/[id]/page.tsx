'use client';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { adminApi } from '@/lib/api';
import Logo from '@/components/Logo';
import { fmtDateTime, fmtMoney } from '@/lib/format';

interface Receipt {
  agencyName: string; receiptNumber: string; type: 'PAYMENT' | 'REFUND'; status: string; voidReason: string | null; amount: string; method: string;
  reference: string | null; receivedAt: string; note: string | null; recordedBy: string;
  booking: { reference: string; contactName: string; itinerary: string[]; passengers: string[]; total: string; paid: string; refunded: string; balance: string };
}

export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const [r, setR] = useState<Receipt | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { adminApi<Receipt>(`/admin/payments/${id}/receipt`).then(setR).catch((e) => setErr(e.message)); }, [id]);
  if (err) return <p className="error">{err}</p>;
  if (!r) return <p>Loading…</p>;
  const refund = r.type === 'REFUND';
  return (
    <>
      <p className="no-print"><button onClick={() => window.print()}>Print receipt</button></p>
      <div className="panel receipt">
        <Logo on="light" className="receipt-logo" />
        <h1 style={{ marginBottom: 0 }}>{r.agencyName}</h1>
        <p className="muted" style={{ marginTop: 2 }}>{refund ? 'REFUND VOUCHER' : 'PAYMENT RECEIPT'}</p>
        {r.status === 'VOIDED' && <p className="error"><b>VOID</b>{r.voidReason ? ` · ${r.voidReason}` : ''}</p>}
        <table>
          <tbody>
            <tr><th>Receipt no.</th><td>{r.receiptNumber}</td></tr>
            <tr><th>Date</th><td>{fmtDateTime(r.receivedAt)} (Nepal time)</td></tr>
            <tr><th>{refund ? 'Refunded to' : 'Received from'}</th><td>{r.booking.contactName}</td></tr>
            <tr><th>Booking reference</th><td>{r.booking.reference}</td></tr>
            <tr><th>Travel</th><td>{r.booking.itinerary.map((x) => <div key={x}>{x}</div>)}</td></tr>
            <tr><th>Passengers</th><td>{r.booking.passengers.join(', ')}</td></tr>
            <tr><th>Method</th><td>{r.method.replace('_', ' ')}{r.reference ? ` · ${r.reference}` : ''}</td></tr>
            <tr><th>Amount {refund ? 'refunded' : 'received'}</th><td><b style={{ fontSize: '1.3rem' }}>{fmtMoney(r.amount)}</b></td></tr>
            {r.note && <tr><th>Note</th><td>{r.note}</td></tr>}
          </tbody>
        </table>
        <p className="sm">Booking total {fmtMoney(r.booking.total)} · paid to date {fmtMoney(r.booking.paid)}{Number(r.booking.refunded) > 0 ? ` · refunded ${fmtMoney(r.booking.refunded)}` : ''} · balance <b>{fmtMoney(r.booking.balance)}</b></p>
        <p className="sm muted">Received by {r.recordedBy}. This receipt records money received by the agency. It is not an airline ticket.</p>
      </div>
    </>
  );
}
