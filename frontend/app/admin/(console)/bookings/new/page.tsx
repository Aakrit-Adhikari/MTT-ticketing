'use client';
import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import { PassportFields, PassportValue, noPassport, passportPayload } from '@/components/passport';
import { Field } from '@/components/ui';
import { adminApi } from '@/lib/api';
import { fmtDateTime, fmtMoney } from '@/lib/format';

interface Airport { id: string; iata: string; city: string }
interface FlightRow { id: string; flightNumber: string; departureAt: string; adultFare: string; airline: { code: string }; inventory: { total: number; held: number; confirmed: number; ticketed: number } | null }
interface Pax extends PassportValue { type: 'ADULT' | 'CHILD' | 'INFANT'; firstName: string; lastName: string; dateOfBirth: string }
const blank = (): Pax => ({ type: 'ADULT', firstName: '', lastName: '', dateOfBirth: '', ...noPassport() });
const free = (f: FlightRow) => (f.inventory ? f.inventory.total - f.inventory.held - f.inventory.confirmed - f.inventory.ticketed : 0);
const day = (d: string) => d || new Date().toISOString().slice(0, 10);

function LegPicker({ label, origin, destination, sectorId, date, chosen, onChoose, seats }: {
  label: string; origin: string; destination: string; sectorId?: string; date: string; chosen: string; onChoose: (id: string) => void; seats: number;
}) {
  const [flights, setFlights] = useState<FlightRow[]>([]);
  useEffect(() => {
    if ((!sectorId && (!origin || !destination)) || !date) { setFlights([]); return; }
    const q = new URLSearchParams({ status: 'SCHEDULED', ...(sectorId ? { sectorId } : { origin, destination }), from: day(date), to: day(date) });
    adminApi<{ items: FlightRow[] }>(`/admin/flights?${q}`).then((d) => setFlights(d.items.filter((f) => new Date(f.departureAt) > new Date()))).catch(() => setFlights([]));
  }, [origin, destination, sectorId, date]);
  return (
    <Field label={`${label}: flight`}>
      <select required value={chosen} onChange={(e) => onChoose(e.target.value)}>
        <option value="">{flights.length ? 'Select a flight…' : 'No scheduled flights for this route/date'}</option>
        {flights.map((f) => <option key={f.id} value={f.id} disabled={free(f) < seats}>{f.airline.code} {f.flightNumber} · {fmtDateTime(f.departureAt)} · {fmtMoney(f.adultFare)} · {free(f)} seats free</option>)}
      </select>
    </Field>
  );
}

export default function NewBooking() {
  const router = useRouter();
  const [airports, setAirports] = useState<Airport[]>([]);
  const [sectors, setSectors] = useState<{ id: string; name: string; isActive: boolean }[]>([]);
  const [sectorId, setSectorId] = useState('');
  const [sectorMode, setSectorMode] = useState(false);
  const [trip, setTrip] = useState<'ONE_WAY' | 'ROUND_TRIP'>('ONE_WAY');
  const [route, setRoute] = useState({ origin: '', destination: '', outDate: '', retDate: '' });
  const [out, setOut] = useState('');
  const [ret, setRet] = useState('');
  const [pax, setPax] = useState<Pax[]>([blank()]);
  const [c, setC] = useState({ contactName: '', contactEmail: '', contactPhone: '', notes: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminApi<Airport[]>('/admin/airports').then(setAirports).catch((e) => setErr(e.message));
    adminApi<{ id: string; name: string; isActive: boolean }[]>('/admin/sectors').then((s) => setSectors(s.filter((x) => x.isActive))).catch(() => undefined);
  }, []);
  const seats = pax.filter((p) => p.type !== 'INFANT').length;
  const upd = (i: number, patch: Partial<Pax>) => setPax((p) => p.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const created = await adminApi<{ id: string }>('/admin/bookings', 'POST', {
        tripType: trip, outboundFlightId: out, ...(trip === 'ROUND_TRIP' ? { returnFlightId: ret } : {}),
        ...c, notes: c.notes || undefined,
        ...(route.outDate ? { requestedDate: route.outDate } : {}), ...(trip === 'ROUND_TRIP' && route.retDate ? { requestedReturnDate: route.retDate } : {}),
        passengers: pax.map((p) => ({ type: p.type, firstName: p.firstName, lastName: p.lastName, ...(p.dateOfBirth ? { dateOfBirth: p.dateOfBirth } : {}), ...passportPayload(p) })),
      });
      router.push(`/admin/bookings/${created.id}`);
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  return (
    <>
      <h1>New booking</h1>
      <p className="notice sm">For walk-in or phone customers. The booking is created as <b>Confirmed</b> straight away and the seats are taken from your allocation, so only use this once the airline has agreed. The customer is emailed their reference.</p>
      <form onSubmit={submit}>
        <div className="panel">
          <div className="row" style={{ marginBottom: 8 }}>
            {(['ONE_WAY', 'ROUND_TRIP'] as const).map((t) => (
              <label key={t} style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
                <input type="radio" style={{ width: 'auto' }} disabled={!!sectorId && t === 'ROUND_TRIP'} checked={trip === t} onChange={() => { setTrip(t); setRet(''); }} />{t === 'ONE_WAY' ? 'One way' : 'Round trip'}
              </label>
            ))}
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={!!sectorId || sectorMode} onChange={(e) => { setSectorMode(e.target.checked); setSectorId(''); setOut(''); setRet(''); if (e.target.checked) setTrip('ONE_WAY'); }} />Sector flight (e.g. mountain flight)
            </label>
          </div>
          <div className="grid">
            {sectorMode ? (
              <Field label="Sector"><select required value={sectorId} onChange={(e) => { setSectorId(e.target.value); setOut(''); }}><option value="">{sectors.length ? 'Select…' : 'No sectors yet'}</option>{sectors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
            ) : (
              <>
                <Field label="From"><select required value={route.origin} onChange={(e) => { setRoute({ ...route, origin: e.target.value }); setOut(''); setRet(''); }}><option value="">Select…</option>{airports.map((a) => <option key={a.id} value={a.iata}>{a.city} ({a.iata})</option>)}</select></Field>
                <Field label="To"><select required value={route.destination} onChange={(e) => { setRoute({ ...route, destination: e.target.value }); setOut(''); setRet(''); }}><option value="">Select…</option>{airports.filter((a) => a.iata !== route.origin).map((a) => <option key={a.id} value={a.iata}>{a.city} ({a.iata})</option>)}</select></Field>
              </>
            )}
            <Field label="Departure date"><input type="date" required value={route.outDate} onChange={(e) => { setRoute({ ...route, outDate: e.target.value }); setOut(''); }} /></Field>
            {trip === 'ROUND_TRIP' && <Field label="Return date"><input type="date" required min={route.outDate} value={route.retDate} onChange={(e) => { setRoute({ ...route, retDate: e.target.value }); setRet(''); }} /></Field>}
          </div>
          <LegPicker label="Outbound" origin={route.origin} destination={route.destination} sectorId={sectorMode ? sectorId : undefined} date={route.outDate} chosen={out} onChoose={setOut} seats={seats} />
          {trip === 'ROUND_TRIP' && <LegPicker label="Return" origin={route.destination} destination={route.origin} date={route.retDate} chosen={ret} onChoose={setRet} seats={seats} />}
        </div>

        <div className="panel">
          <b>Passengers</b> <span className="muted sm">({seats} seat{seats === 1 ? '' : 's'}; infants travel on a lap). A passport number and nationality are required for a booking and are stored encrypted. Expiry is optional.</span>
          {pax.map((p, i) => (
            <div className="grid pax-grid admin-pax" key={i} style={{ marginTop: 8 }}>
              <Field label="Type"><select value={p.type} onChange={(e) => upd(i, { type: e.target.value as Pax['type'] })}><option value="ADULT">Adult</option><option value="CHILD">Child</option><option value="INFANT">Infant</option></select></Field>
              <Field label="First name"><input required maxLength={60} value={p.firstName} onChange={(e) => upd(i, { firstName: e.target.value })} /></Field>
              <Field label="Last name"><input required maxLength={60} value={p.lastName} onChange={(e) => upd(i, { lastName: e.target.value })} /></Field>
              <Field label="Date of birth (optional)"><input type="date" value={p.dateOfBirth} onChange={(e) => upd(i, { dateOfBirth: e.target.value })} /></Field>
              <PassportFields required value={p} onChange={(v) => upd(i, v)} />
              {pax.length > 1 ? <button type="button" className="secondary" onClick={() => setPax(pax.filter((_, j) => j !== i))}>Remove</button> : <span />}
            </div>
          ))}
          {pax.length < 9 && <p><button type="button" className="secondary" onClick={() => setPax([...pax, blank()])}>+ Add passenger</button></p>}
        </div>

        <div className="panel">
          <b>Customer contact</b> <span className="muted sm">(booking reference and tickets are emailed here)</span>
          <div className="grid" style={{ marginTop: 8 }}>
            <Field label="Name"><input required maxLength={100} value={c.contactName} onChange={(e) => setC({ ...c, contactName: e.target.value })} /></Field>
            <Field label="Email"><input type="email" required maxLength={254} value={c.contactEmail} onChange={(e) => setC({ ...c, contactEmail: e.target.value })} /></Field>
            <Field label="Phone"><input type="tel" required pattern="\+?[0-9][0-9 \-]{6,18}" value={c.contactPhone} onChange={(e) => setC({ ...c, contactPhone: e.target.value })} /></Field>
          </div>
          <Field label="Notes (optional)"><textarea rows={2} maxLength={1000} value={c.notes} onChange={(e) => setC({ ...c, notes: e.target.value })} /></Field>
        </div>

        {err && <p className="error" role="alert">{err}</p>}
        <button disabled={busy || !out || (trip === 'ROUND_TRIP' && !ret)}>{busy ? 'Creating…' : 'Create confirmed booking'}</button>
      </form>
    </>
  );
}
