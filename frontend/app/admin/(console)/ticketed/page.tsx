'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import PaymentBadge from '@/components/PaymentBadge';
import { Field, Pagination } from '@/components/ui';
import { adminApi } from '@/lib/api';
import { dirLabel, fmtDateTime } from '@/lib/format';

interface Row {
  bookingId: string; reference: string; name: string; phone: string; email: string; pnr: string | null; rescheduled: boolean; nextDeparture: string | null;
  flights: { direction: string; airline: string; flightNumber: string; route: string; departureAt: string }[];
  passengers: { name: string; type: string; ticketNumber: string | null }[];
  payment: { status: string; balance: string };
}
interface Page { items: Row[]; total: number; page: number; pageSize: number }

/** Customers whose tickets are issued. They cannot be deleted from here (a ticketed booking is only ever cancelled). */
export default function Ticketed() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams({ page: String(page), ...(q.trim() ? { q: q.trim() } : {}) });
    adminApi<Page>(`/admin/ticketed?${p}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message));
  }, [page, q]);
  useEffect(load, [load]);

  return (
    <>
      <h1>Ticketed customers</h1>
      <p className="muted sm">Customers whose tickets have been issued, nearest flight first: airline, flight, PNR and every ticket number in one place. Ticketed bookings cannot be deleted.</p>
      <div className="panel grid">
        <Field label="Search"><input placeholder="Name, phone, email, reference, PNR or ticket no." value={q} maxLength={60} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></Field>
      </div>
      {err && <p className="error">{err}</p>}
      <div className="table-scroll">
        <table className="compact">
          <thead><tr><th>Customer</th><th>Contact</th><th>Airline &amp; flight</th><th>Departs</th><th>PNR</th><th>Tickets</th><th className="narrow">Payment</th><th className="col-actions">Actions</th></tr></thead>
          <tbody>
            {data?.items.map((r) => (
              <tr key={r.bookingId}>
                <td><b>{r.name}</b><div className="muted">{r.reference}</div>{r.rescheduled && <span className="badge s-HELD" title="Moved to another flight after it was made">RESCH.</span>}</td>
                <td>{r.phone}<div className="muted">{r.email}</div></td>
                <td>{r.flights.map((f) => <div key={f.direction}><span className="muted">{dirLabel(f.direction)}:</span> <b>{f.airline}</b> {f.flightNumber} · {f.route}</div>)}</td>
                <td className="narrow">{r.flights.map((f) => <div key={f.direction}>{fmtDateTime(f.departureAt)}</div>)}</td>
                <td className="narrow"><b className="mono">{r.pnr ?? '-'}</b></td>
                <td>{r.passengers.map((p, i) => <div key={i}>{p.name}: <span className="mono">{p.ticketNumber ?? '-'}</span></div>)}</td>
                <td className="narrow"><PaymentBadge status={r.payment.status} />{Number(r.payment.balance) > 0 ? <div className="muted">due {r.payment.balance}</div> : null}</td>
                <td className="col-actions"><Link className="btn" href={`/admin/bookings/${r.bookingId}`}>Open</Link></td>
              </tr>
            ))}
            {data?.items.length === 0 && <tr><td colSpan={8} className="muted">No ticketed customers yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {data && <Pagination page={data.page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </>
  );
}
