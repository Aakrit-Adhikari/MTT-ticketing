'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Field, StatusBadge } from '@/components/ui';
import { adminApi } from '@/lib/api';
import { fmtDateTime, routeCode, routeWords } from '@/lib/format';

interface FlightRow {
  id: string; flightNumber: string; status: string; departureAt: string; airline: { code: string };
  origin: { iata: string } | null; destination: { iata: string } | null; sector: { name: string } | null;
  inventory: { total: number; held: number; confirmed: number; ticketed: number } | null;
}
interface Manifest {
  flight: { id: string; flightNumber: string; departureAt: string; origin: { iata: string; city: string } | null; destination: { iata: string; city: string } | null; sector: { name: string } | null };
  inventory: { total: number; held: number; confirmed: number; ticketed: number; available: number };
  entries: { state: 'HELD' | 'CONFIRMED' | 'TICKETED'; seats: number; bookingId: string; reference: string; customer: string; phone: string; holdExpiresAt: string | null; pnr: string | null; passengers: { name: string; type: string; ticketNumber: string | null }[] }[];
}

const GROUPS: { state: 'HELD' | 'CONFIRMED' | 'TICKETED'; title: string; hint: string }[] = [
  { state: 'HELD', title: 'On hold', hint: 'Seats kept temporarily while you check with the airline. They go back on sale when the hold expires.' },
  { state: 'CONFIRMED', title: 'Confirmed (not ticketed yet)', hint: 'Seats secured with the airline. Issue the ticket next.' },
  { state: 'TICKETED', title: 'Ticketed', hint: 'Tickets issued.' },
];

export default function Seats() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState('');
  const [route, setRoute] = useState({ origin: '', destination: '' });
  const [airports, setAirports] = useState<{ iata: string }[]>([]);
  const [flights, setFlights] = useState<FlightRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [m, setM] = useState<Manifest | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => { adminApi<{ iata: string }[]>('/admin/airports').then(setAirports).catch(() => undefined); }, []);
  const load = useCallback(() => {
    const p = new URLSearchParams({ status: 'SCHEDULED', from, ...(to ? { to } : {}), ...(route.origin ? { origin: route.origin } : {}), ...(route.destination ? { destination: route.destination } : {}) });
    adminApi<{ items: FlightRow[] }>(`/admin/flights?${p}`).then((d) => { setFlights(d.items); setErr(''); }).catch((e) => setErr(e.message));
  }, [from, to, route]);
  useEffect(load, [load]);

  useEffect(() => {
    if (!open) { setM(null); return; }
    adminApi<Manifest>(`/admin/flights/${open}/manifest`).then(setM).catch((e) => setErr(e.message));
  }, [open]);

  return (
    <>
      <h1>Seats</h1>
      <p className="muted sm">Your seat allocation, flight by flight. Click a flight to see who has the seats: on hold, confirmed or ticketed.</p>
      <div className="panel grid">
        <Field label="Flying from"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="to"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="From airport"><select value={route.origin} onChange={(e) => setRoute({ ...route, origin: e.target.value })}><option value="">Any</option>{airports.map((a) => <option key={a.iata}>{a.iata}</option>)}</select></Field>
        <Field label="To airport"><select value={route.destination} onChange={(e) => setRoute({ ...route, destination: e.target.value })}><option value="">Any</option>{airports.map((a) => <option key={a.iata}>{a.iata}</option>)}</select></Field>
      </div>
      {err && <p className="error">{err}</p>}
      <div className="table-scroll">
        <table className="compact">
          <thead><tr><th>Flight</th><th>Route</th><th>Departs (Nepal time)</th><th>Allocated</th><th>On hold</th><th>Confirmed</th><th>Ticketed</th><th>Left to sell</th><th></th></tr></thead>
          <tbody>
            {flights.map((f) => {
              const i = f.inventory ?? { total: 0, held: 0, confirmed: 0, ticketed: 0 };
              const left = i.total - i.held - i.confirmed - i.ticketed;
              return (
                <tr key={f.id} style={open === f.id ? { background: 'var(--bg)' } : undefined}>
                  <td>{f.flightNumber}</td><td>{routeCode(f)}</td><td>{fmtDateTime(f.departureAt)}</td>
                  <td>{i.total}</td><td>{i.held}</td><td>{i.confirmed}</td><td>{i.ticketed}</td><td><b>{left}</b></td>
                  <td><button className="secondary" onClick={() => setOpen(open === f.id ? null : f.id)}>{open === f.id ? 'Hide' : 'Who has seats'}</button></td>
                </tr>
              );
            })}
            {flights.length === 0 && <tr><td colSpan={9} className="muted">No scheduled flights in this range.</td></tr>}
          </tbody>
        </table>
      </div>

      {m && (
        <div className="panel" style={{ marginTop: 14 }}>
          <h2 style={{ marginTop: 0 }}>{m.flight.flightNumber} · {routeWords(m.flight)} · {fmtDateTime(m.flight.departureAt)}</h2>
          <div className="kpis">
            <div className="kpi"><b>{m.inventory.total}</b>allocated</div><div className="kpi"><b>{m.inventory.held}</b>on hold</div>
            <div className="kpi"><b>{m.inventory.confirmed}</b>confirmed</div><div className="kpi"><b>{m.inventory.ticketed}</b>ticketed</div>
            <div className="kpi"><b>{m.inventory.available}</b>left to sell</div>
          </div>
          {GROUPS.map((g) => {
            const rows = m.entries.filter((e) => e.state === g.state);
            return (
              <div key={g.state}>
                <h2>{g.title} <StatusBadge status={g.state} /> <span className="muted sm">{rows.reduce((t, r) => t + r.seats, 0)} seats</span></h2>
                <p className="muted sm" style={{ marginTop: 0 }}>{g.hint}</p>
                <table className="compact">
                  <thead><tr><th>Booking</th><th>Customer</th><th>Phone</th><th>Seats</th><th>Passengers</th>{g.state === 'HELD' && <th>Hold ends</th>}{g.state === 'TICKETED' && <th>PNR / tickets</th>}</tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.bookingId + r.state}>
                        <td><Link href={`/admin/bookings/${r.bookingId}`}>{r.reference}</Link></td><td>{r.customer}</td><td>{r.phone}</td><td><b>{r.seats}</b></td>
                        <td>{r.passengers.map((p) => <div key={p.name + p.type}>{p.name} <span className="muted">({p.type.toLowerCase()})</span></div>)}</td>
                        {g.state === 'HELD' && <td>{fmtDateTime(r.holdExpiresAt)}</td>}
                        {g.state === 'TICKETED' && <td>{r.pnr}{r.passengers.map((p) => <div key={p.name}>{p.ticketNumber}</div>)}</td>}
                      </tr>
                    ))}
                    {rows.length === 0 && <tr><td colSpan={6} className="muted">None.</td></tr>}
                  </tbody>
                </table>
              </div>
            );
          })}
          <p className="muted sm">Seat <i>numbers</i> are assigned by the airline at check-in, so they are not tracked here.</p>
        </div>
      )}
    </>
  );
}
