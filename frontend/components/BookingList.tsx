'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import PaymentBadge from '@/components/PaymentBadge';
import { ChangeDateDialog, DateTarget } from '@/components/ChangeDateDialog';
import { DeleteButton, Field, Pagination, StatusBadge } from '@/components/ui';
import { adminApi } from '@/lib/api';
import { dayKey, fmtDateOnly, fmtDateTime, routeCode } from '@/lib/format';

interface Row {
  id: string; reference: string; status: string; source: string; rescheduledCount: number; contactName: string; contactEmail: string; contactPhone: string; createdAt: string; confirmedAt: string | null; holdExpiresAt: string | null;
  requestedDate: string | null; requestedReturnDate: string | null; tripType: string;
  segments: { direction: string; flight: { flightNumber: string; origin: { iata: string } | null; destination: { iata: string } | null; sector: { name: string } | null; departureAt: string } }[];
  passengers: { type: string }[];
  payment: { status: string; balance: string };
}
interface Page { items: Row[]; total: number; page: number; pageSize: number }

/** Inquiries = not yet confirmed by staff. Bookings = confirmed (or created directly by staff). */
export default function BookingList({ kind }: { kind: 'inquiry' | 'booking' }) {
  const { user } = useAuth();
  const isInquiry = kind === 'inquiry';
  const statuses: [string, string][] = isInquiry
    ? [['OPEN', 'Open (new + on hold)'], ['INQUIRY', 'New only'], ['HELD', 'On hold only'], ['CLOSED', 'Closed (rejected / expired / cancelled)'], ['', 'Everything']]
    : [['', 'All'], ['CONFIRMED', 'Confirmed'], ['TICKETED', 'Ticketed'], ['CANCELLED', 'Cancelled']];
  const [status, setStatus] = useState(isInquiry ? 'OPEN' : '');
  const party = (ps: { type: string }[]) => {
    const n = (t: string) => ps.filter((p) => p.type === t).length;
    return [n('ADULT') && `${n('ADULT')} adult`, n('CHILD') && `${n('CHILD')} child`, n('INFANT') && `${n('INFANT')} infant`].filter(Boolean).join(', ');
  };
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [f, setF] = useState({ flightNumber: '', origin: '', destination: '', flightFrom: '', flightTo: '' });
  const [showAll, setShowAll] = useState(false);
  const [airports, setAirports] = useState<{ iata: string; city: string }[]>([]);
  const [data, setData] = useState<Page | null>(null);
  const [err, setErr] = useState('');
  const [dateFor, setDateFor] = useState<DateTarget | null>(null);

  // Links from the Customers page open this list pre-searched, across inquiries and bookings.
  useEffect(() => {
    const u = new URLSearchParams(window.location.search);
    if (u.get('q')) { setQ(u.get('q')!); setStatus(''); }
    if (u.get('all')) setShowAll(true);
    adminApi<{ iata: string; city: string }[]>('/admin/airports').then(setAirports).catch(() => undefined);
  }, []);

  const load = useCallback(() => {
    const extra = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
    const p = new URLSearchParams({ ...(showAll ? {} : { kind }), page: String(page), ...(status ? { status } : {}), ...(q.trim() ? { q: q.trim() } : {}), ...extra });
    adminApi<Page>(`/admin/bookings?${p}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message));
  }, [kind, page, status, q, f, showAll]);
  useEffect(load, [load]);

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>{isInquiry ? 'Inquiries' : 'Bookings'}</h1>
        {!isInquiry && user?.role !== 'FINANCE_STAFF' && <Link className="btn" href="/admin/bookings/new">+ New booking</Link>}
      </div>
      <p className="muted sm">
        {isInquiry
          ? 'Requests from the website. Nothing is reserved yet. Check with the airline, then open one and press Confirm to turn it into a booking.'
          : 'Confirmed bookings, including ones you create directly for walk-in or phone customers.'}
      </p>
      <div className="panel grid">
        <Field label="Status"><select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>{statuses.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Search reference / name / email / phone"><input value={q} maxLength={60} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></Field>
        <Field label="Flight no."><input value={f.flightNumber} maxLength={10} onChange={(e) => { setF({ ...f, flightNumber: e.target.value.toUpperCase() }); setPage(1); }} /></Field>
        <Field label="From"><select value={f.origin} onChange={(e) => { setF({ ...f, origin: e.target.value }); setPage(1); }}><option value="">Any</option>{airports.map((a) => <option key={a.iata} value={a.iata}>{a.iata}</option>)}</select></Field>
        <Field label="To"><select value={f.destination} onChange={(e) => { setF({ ...f, destination: e.target.value }); setPage(1); }}><option value="">Any</option>{airports.map((a) => <option key={a.iata} value={a.iata}>{a.iata}</option>)}</select></Field>
        <Field label="Flies from"><input type="date" value={f.flightFrom} onChange={(e) => { setF({ ...f, flightFrom: e.target.value }); setPage(1); }} /></Field>
        <Field label="Flies to"><input type="date" value={f.flightTo} onChange={(e) => { setF({ ...f, flightTo: e.target.value }); setPage(1); }} /></Field>
        <button className="secondary" onClick={() => { setF({ flightNumber: '', origin: '', destination: '', flightFrom: '', flightTo: '' }); setQ(''); setPage(1); }}>Clear</button>
      </div>
      {showAll && <p className="notice sm">Showing this customer&apos;s inquiries <b>and</b> bookings.</p>}
      {isInquiry && (
        <details className="panel sm">
          <summary><b>What do the statuses mean, and what changes them?</b></summary>
          <ul>
            <li><b>NEW</b>: a request from the website. Nothing is reserved yet. Open it (click the reference) to act on it.</li>
            <li><b>HOLD</b>: you pressed <i>Hold seats</i>. This is a <u>temporary reservation</u>: the seats are taken off sale for a few hours while you phone the airline. It is optional. If you do nothing it expires by itself.</li>
            <li><b>EXPIRED</b>: a hold ran out. The seats went back on sale automatically.</li>
            <li><b>REJECT</b>: you pressed <i>Reject</i> because you cannot accept it. The customer is emailed.</li>
            <li><b>CANCEL</b>: you pressed <i>Cancel</i>. Seats are released and the customer is emailed.</li>
            <li><i>Confirm</i> (after the airline agrees) turns it into a booking. It leaves this list and appears under <b>Bookings</b>.</li>
          </ul>
          <p className="muted">All of these buttons are on the inquiry&apos;s own page. Click its reference in the table.</p>
        </details>
      )}
      {err && <p className="error">{err}</p>}
      <div className="table-scroll">
        <table className="compact">
          <thead><tr><th>Reference</th><th className="narrow">Status</th><th>Name</th><th>Phone</th><th>Email</th><th>Itinerary</th><th>Flight date</th><th>Wanted date</th><th>Travellers</th>{!isInquiry && <th>Payment</th>}<th>{isInquiry ? 'Received' : 'Confirmed'}</th>{isInquiry && <th>Hold until</th>}{user?.role !== 'FINANCE_STAFF' && <th className="col-actions">Actions</th>}</tr></thead>
          <tbody>
            {data?.items.map((b) => (
              <tr key={b.id}>
                <td><Link href={`/admin/bookings/${b.id}`}>{b.reference}</Link></td>
                <td className="narrow">
                  <StatusBadge status={b.status} />
                  {b.rescheduledCount > 0 && <><br /><span className="badge s-HELD" title="Moved to another flight after it was made">RESCH.</span></>}
                  {b.source === 'STAFF' && <><br /><span className="badge s-INQUIRY" title="Created by staff">STAFF</span></>}
                </td>
                <td>{b.contactName}</td>
                <td className="narrow">{b.contactPhone}</td>
                <td>{b.contactEmail}</td>
                <td>{b.segments.map((s) => <div key={s.direction}>{s.flight.flightNumber} {routeCode(s.flight)}</div>)}</td>
                <td className="narrow">{b.segments.map((s) => <div key={s.direction}><b>{fmtDateTime(s.flight.departureAt)}</b></div>)}</td>
                <td className="narrow">
                  {fmtDateOnly(b.requestedDate)}
                  {b.requestedDate && b.segments[0] && dayKey(b.segments[0].flight.departureAt) !== b.requestedDate.slice(0, 10) && <div><span className="badge s-HELD" title="The flight is on a different day from the one the customer asked for">DIFFERENT DAY</span></div>}
                  {user?.role !== 'FINANCE_STAFF' && ['INQUIRY', 'HELD', 'CONFIRMED', 'TICKETED'].includes(b.status) && <div><button type="button" className="linklike" onClick={() => setDateFor({ id: b.id, reference: b.reference, tripType: b.tripType, requestedDate: b.requestedDate, requestedReturnDate: b.requestedReturnDate })}>Change date</button></div>}
                </td>
                <td className="narrow"><b>{b.passengers.length}</b> <span className="muted">({party(b.passengers)})</span></td>
                {!isInquiry && <td><PaymentBadge status={b.payment.status} />{Number(b.payment.balance) > 0 && b.payment.status !== 'UNPAID' ? <div className="muted sm">due {b.payment.balance}</div> : null}</td>}
                <td>{fmtDateTime(isInquiry ? b.createdAt : b.confirmedAt)}</td>
                {isInquiry && <td>{fmtDateTime(b.holdExpiresAt)}</td>}
                {user?.role !== 'FINANCE_STAFF' && <td className="col-actions">{b.status === 'TICKETED' ? <span className="muted sm" title="A ticketed booking cannot be deleted">Ticketed</span> : <DeleteButton what={`${isInquiry ? 'inquiry' : 'booking'} ${b.reference}`} extra="Seats it holds are given back." onDelete={async () => { await adminApi(`/admin/bookings/${b.id}`, 'DELETE'); load(); }} />}</td>}
              </tr>
            ))}
            {data?.items.length === 0 && <tr><td colSpan={13} className="muted">Nothing here.</td></tr>}
          </tbody>
        </table>
      </div>
      {data && <Pagination page={data.page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
      <ChangeDateDialog target={dateFor} onClose={() => setDateFor(null)} onSaved={load} />
    </>
  );
}
