'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import PaymentBadge from '@/components/PaymentBadge';
import { DeleteButton, Field, Pagination, StatusBadge } from '@/components/ui';
import { adminApi } from '@/lib/api';
import { dirLabel, fmtDateTime, fmtMoney } from '@/lib/format';

interface Row {
  bookingId: string; reference: string; status: string; rescheduled: boolean; name: string; phone: string; email: string;
  travellers: { adults: number; children: number; infants: number };
  flights: { direction: string; flightNumber: string; from: string; to: string; departureAt: string }[];
  nextDeparture: string | null;
  payment: { status: string; total: string; paid: string; balance: string };
}
interface Page { items: Row[]; total: number; page: number; pageSize: number; capped: boolean }
type Scope = 'travelling' | 'cancelled' | 'leads';

const TABS: { scope: Scope; label: string; hint: string }[] = [
  { scope: 'travelling', label: 'Travelling', hint: 'Customers with a confirmed booking: the real flights. Nearest flight first, so you can see who is flying next. Open a booking to record a payment.' },
  { scope: 'cancelled', label: 'Cancelled', hint: 'Bookings cancelled after confirmation. Use "Refund due" to see who still has money to be returned.' },
  { scope: 'leads', label: 'Enquiries only', hint: 'People who asked but are not confirmed with the airline yet. They are not flying until you confirm.' },
];

const daysTo = (iso: string | null) => {
  if (!iso) return '';
  const d = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  return d <= 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
};

export default function Customers() {
  const [scope, setScope] = useState<Scope>('travelling');
  const [q, setQ] = useState('');
  const [payment, setPayment] = useState('');
  const [rescheduled, setRescheduled] = useState(false);
  const [flyFrom, setFlyFrom] = useState('');
  const [flyTo, setFlyTo] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    const p = new URLSearchParams({ scope, page: String(page), ...(q.trim() ? { q: q.trim() } : {}), ...(payment && scope !== 'leads' ? { payment } : {}), ...(rescheduled ? { rescheduled: 'true' } : {}), ...(flyFrom ? { flyFrom } : {}), ...(flyTo ? { flyTo } : {}) });
    adminApi<Page>(`/admin/customers?${p}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message));
  }, [scope, page, q, payment, rescheduled, flyFrom, flyTo]);
  useEffect(load, [load]);

  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  const tab = TABS.find((t) => t.scope === scope)!;

  return (
    <>
      <h1>Customers</h1>
      <div className="row" style={{ marginBottom: 8 }}>
        {TABS.map((t) => <button key={t.scope} className={t.scope === scope ? '' : 'secondary'} onClick={() => { setScope(t.scope); setPage(1); if (t.scope === 'leads') setPayment(''); }}>{t.label}</button>)}
      </div>
      <p className="muted sm tab-hint">{tab.hint}</p>

      <div className="panel grid">
        <Field label="Search customer"><input placeholder="Name, phone, email or reference" value={q} maxLength={60} onChange={(e) => reset(setQ)(e.target.value)} /></Field>
        {(
          <Field label="Payment">
            <select disabled={scope === 'leads'} value={scope === 'leads' ? '' : payment} onChange={(e) => reset(setPayment)(e.target.value)}>
              <option value="">Any</option><option value="UNPAID">Not paid yet</option><option value="PARTIAL">Partly paid</option><option value="PAID">Paid in full</option>
              <option value="OVERPAID">Overpaid</option><option value="REFUND_DUE">Refund due</option><option value="REFUNDED">Refunded</option>
            </select>
          </Field>
        )}
        <Field label="Flying from"><input type="date" value={flyFrom} onChange={(e) => reset(setFlyFrom)(e.target.value)} /></Field>
        <Field label="Flying to"><input type="date" value={flyTo} onChange={(e) => reset(setFlyTo)(e.target.value)} /></Field>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}><input type="checkbox" style={{ width: 'auto' }} checked={rescheduled} onChange={(e) => reset(setRescheduled)(e.target.checked)} />Rescheduled only</label>
      </div>
      {err && <p className="error">{err}</p>}
      {data?.capped && <p className="notice sm">Showing the most recent 5,000 records. Narrow the search to see older ones.</p>}

      <div className="table-scroll">
        <table className="compact">
          <thead><tr><th>Customer</th><th>Phone</th><th>Email</th><th>Flights</th><th>Flying</th><th>Travellers</th><th className="narrow">Payment</th><th className="narrow">Status</th><th className="col-actions">Actions</th></tr></thead>
          <tbody>
            {data?.items.map((r) => (
              <tr key={r.bookingId}>
                <td><b>{r.name}</b><div className="muted">{r.reference}</div></td>
                <td className="narrow">{r.phone}</td><td>{r.email}</td>
                <td>{r.flights.map((f) => <div key={f.direction}><span className="muted">{dirLabel(f.direction)}:</span> {f.flightNumber} {f.from}-{f.to}</div>)}</td>
                <td className="narrow">{r.flights.map((f) => <div key={f.direction}>{fmtDateTime(f.departureAt)}</div>)}{r.nextDeparture && <div className="muted">{daysTo(r.nextDeparture)}</div>}</td>
                <td className="narrow">{r.travellers.adults + r.travellers.children + r.travellers.infants}</td>
                {scope === 'leads' ? <td className="narrow muted">Not confirmed</td> : (
                  <td className="narrow"><PaymentBadge status={r.payment.status} />{r.payment.status !== 'NONE' && Number(r.payment.balance) > 0 ? <div className="muted">due {fmtMoney(r.payment.balance)}</div> : null}{r.payment.status === 'REFUND_DUE' ? <div className="muted">return {fmtMoney(r.payment.paid)}</div> : null}</td>
                )}
                <td className="narrow"><StatusBadge status={r.status} />{r.rescheduled && <><br /><span className="badge s-HELD" title="Moved to another flight after it was made">RESCH.</span></>}</td>
                <td className="col-actions"><span className="actions">{r.status === 'TICKETED' ? <span className="muted sm" title="A ticketed booking cannot be deleted">Ticketed</span> : <DeleteButton what={`customer ${r.name} (${r.reference})`} extra="This deletes their booking or inquiry, and any payment records need a Super Admin." onDelete={async () => { await adminApi(`/admin/bookings/${r.bookingId}`, 'DELETE'); load(); }} />}<Link className="btn" href={`/admin/bookings/${r.bookingId}`}>{scope === 'leads' ? 'Open' : r.payment.status === 'PAID' ? 'Open' : 'Open / take payment'}</Link></span></td>
              </tr>
            ))}
            {data?.items.length === 0 && <tr><td colSpan={9} className="muted">No customers match.</td></tr>}
          </tbody>
        </table>
      </div>
      {data && <Pagination page={data.page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </>
  );
}
