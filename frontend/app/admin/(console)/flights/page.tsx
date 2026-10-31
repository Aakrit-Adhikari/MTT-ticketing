'use client';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { ConfirmDialog, DeleteButton, Field, NumInput, Pagination, StatusBadge } from '@/components/ui';
import { adminApi } from '@/lib/api';
import { fmtDateTime, fmtMoney, nepalLocalToIso, routeCode } from '@/lib/format';

interface Ref { id: string; code?: string; iata?: string; name: string; city?: string }
interface Flight {
  id: string; flightNumber: string; status: string; departureAt: string; adultFare: string; childFare: string;
  airline: { code: string }; origin: { iata: string } | null; destination: { iata: string } | null; sector: { name: string } | null;
  inventory: { total: number; held: number; confirmed: number; ticketed: number } | null;
}
interface Page { items: Flight[]; total: number; page: number; pageSize: number }

export default function Flights() {
  const { user } = useAuth();
  const canEdit = user?.role !== 'FINANCE_STAFF';
  const [data, setData] = useState<Page | null>(null);
  const [status, setStatus] = useState('SCHEDULED');
  const [page, setPage] = useState(1);
  const [airlines, setAirlines] = useState<Ref[]>([]);
  const [airports, setAirports] = useState<Ref[]>([]);
  const [sectors, setSectors] = useState<(Ref & { isActive?: boolean })[]>([]);
  const [kind, setKind] = useState<'ROUTE' | 'SECTOR'>('ROUTE');
  const [departureOnly, setDepartureOnly] = useState(true); // most flights are entered with a departure time only
  const [err, setErr] = useState('');
  const [adj, setAdj] = useState<{ flight: Flight; delta: number; reason: string } | null>(null);
  const [form, setForm] = useState({ airlineId: '', flightNumber: '', originId: '', destinationId: '', sectorId: '', departure: '', arrival: '', adultFare: '', childFare: '', seatsAllocated: 0 });

  const load = useCallback(() => {
    const p = new URLSearchParams({ page: String(page), ...(status ? { status } : {}) });
    adminApi<Page>(`/admin/flights?${p}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message));
  }, [page, status]);
  useEffect(load, [load]);
  useEffect(() => {
    adminApi<Ref[]>('/admin/airlines').then(setAirlines).catch(() => undefined);
    adminApi<Ref[]>('/admin/airports').then(setAirports).catch(() => undefined);
    adminApi<(Ref & { isActive?: boolean })[]>('/admin/sectors').then((s) => setSectors(s.filter((x) => x.isActive !== false))).catch(() => undefined);
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault(); setErr('');
    try {
      await adminApi('/admin/flights', 'POST', {
        airlineId: form.airlineId, flightNumber: form.flightNumber,
        ...(kind === 'SECTOR' ? { sectorId: form.sectorId } : { originId: form.originId, destinationId: form.destinationId, ...(!departureOnly && form.arrival ? { arrivalAt: nepalLocalToIso(form.arrival) } : {}) }),
        departureAt: nepalLocalToIso(form.departure),
        adultFare: form.adultFare, childFare: form.childFare, seatsAllocated: form.seatsAllocated,
      });
      setForm({ ...form, flightNumber: '', departure: '', arrival: '' });
      load();
    } catch (x) { setErr((x as Error).message); }
  }

  async function setFlightStatus(f: Flight, s: string) {
    try { await adminApi(`/admin/flights/${f.id}`, 'PATCH', { status: s }); load(); } catch (x) { setErr((x as Error).message); }
  }

  async function adjust() {
    if (!adj) return;
    try { await adminApi(`/admin/flights/${adj.flight.id}/inventory/adjust`, 'POST', { delta: adj.delta, reason: adj.reason }); setAdj(null); load(); }
    catch (x) { setErr((x as Error).message); setAdj(null); }
  }

  return (
    <>
      <h1>Flights &amp; seat inventory</h1>
      {err && <p className="error" role="alert">{err}</p>}

      {canEdit && (
        <form className="panel" onSubmit={create}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span><b>Add departure with agency seat allocation</b> <span className="muted sm">(times are Nepal time)</span></span>
            <span className="seg" role="radiogroup" aria-label="Flight type" style={{ margin: 0 }}>
              {([['ROUTE', 'Route flight'], ['SECTOR', 'Sector (e.g. mountain flight)']] as const).map(([k, l]) => (
                <label key={k} style={{ margin: 0 }}><input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} />{l}</label>
              ))}
            </span>
          </div>
          <div className="grid" style={{ marginTop: 8 }}>
            <Field label="Airline"><select required value={form.airlineId} onChange={(e) => setForm({ ...form, airlineId: e.target.value })}><option value="">Select…</option>{airlines.map((a) => <option key={a.id} value={a.id}>{a.code} – {a.name}</option>)}</select></Field>
            <Field label="Flight no."><input required placeholder="RA 301" value={form.flightNumber} onChange={(e) => setForm({ ...form, flightNumber: e.target.value.toUpperCase() })} /></Field>
            {kind === 'ROUTE' ? (
              <>
                <Field label="From"><select required value={form.originId} onChange={(e) => setForm({ ...form, originId: e.target.value })}><option value="">Select…</option>{airports.map((a) => <option key={a.id} value={a.id}>{a.iata}</option>)}</select></Field>
                <Field label="To"><select required value={form.destinationId} onChange={(e) => setForm({ ...form, destinationId: e.target.value })}><option value="">Select…</option>{airports.map((a) => <option key={a.id} value={a.id}>{a.iata}</option>)}</select></Field>
              </>
            ) : (
              <Field label="Sector"><select required value={form.sectorId} onChange={(e) => setForm({ ...form, sectorId: e.target.value })}><option value="">{sectors.length ? 'Select…' : 'Add a sector first (Airlines & airports)'}</option>{sectors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
            )}
            <Field label="Departs"><input type="datetime-local" required min={new Date(Date.now() + 5.75 * 3600000).toISOString().slice(0, 16)} value={form.departure} onChange={(e) => setForm({ ...form, departure: e.target.value })} /></Field>
            {kind === 'ROUTE' && !departureOnly && <Field label="Arrives"><input type="datetime-local" required min={form.departure} value={form.arrival} onChange={(e) => setForm({ ...form, arrival: e.target.value })} /></Field>}
            <Field label="Adult fare (NPR)"><input required inputMode="decimal" pattern="\d{1,10}(\.\d{1,2})?" value={form.adultFare} onChange={(e) => setForm({ ...form, adultFare: e.target.value })} /></Field>
            <Field label="Child fare (NPR)"><input required inputMode="decimal" pattern="\d{1,10}(\.\d{1,2})?" value={form.childFare} onChange={(e) => setForm({ ...form, childFare: e.target.value })} /></Field>
            <Field label="Seats allocated"><NumInput required min={0} max={1000} value={form.seatsAllocated} onChange={(n) => setForm({ ...form, seatsAllocated: n })} /></Field>
            <button>Add flight</button>
          </div>
          {kind === 'ROUTE' && (
            <label className="check"><input type="checkbox" checked={departureOnly} onChange={(e) => setDepartureOnly(e.target.checked)} />Departure time only (no arrival time). Enter the way back, e.g. KTM to BHA, as its own flight with this form again.</label>
          )}
        </form>
      )}

      <div className="row" style={{ marginBottom: 8 }}>
        <label style={{ margin: 0 }}>Status</label>
        <select style={{ width: 'auto' }} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          {['', 'SCHEDULED', 'CLOSED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s || 'All'}</option>)}
        </select>
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Flight</th><th>Route</th><th>Departs (NPT)</th><th>Adult / Child</th><th>Total</th><th>Held</th><th>Conf.</th><th>Tkt</th><th>Avail.</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {data?.items.map((f) => {
              const i = f.inventory;
              return (
                <tr key={f.id}>
                  <td>{f.airline.code} {f.flightNumber.replace(/^[A-Z0-9]{2,3}\s?/, '')}</td><td>{routeCode(f)}</td><td>{fmtDateTime(f.departureAt)}</td>
                  <td>{fmtMoney(f.adultFare)} / {fmtMoney(f.childFare)}</td>
                  <td>{i?.total ?? 'null'}</td><td>{i?.held ?? 'null'}</td><td>{i?.confirmed ?? 'null'}</td><td>{i?.ticketed ?? 'null'}</td>
                  <td><b>{i ? i.total - i.held - i.confirmed - i.ticketed : 'null'}</b></td>
                  <td><StatusBadge status={f.status} /></td>
                  <td className="row">
                    {user?.role === 'SUPER_ADMIN' && <button className="secondary" onClick={() => setAdj({ flight: f, delta: 0, reason: '' })}>Adjust</button>}
                    {canEdit && f.status === 'SCHEDULED' && <button className="secondary" onClick={() => setFlightStatus(f, 'CLOSED')}>Stop sales</button>}
                    {canEdit && f.status === 'CLOSED' && <button className="secondary" onClick={() => setFlightStatus(f, 'SCHEDULED')}>Reopen</button>}
                    {canEdit && <DeleteButton what={`flight ${f.flightNumber}`} extra="Only possible when nobody is booked on it." onDelete={async () => { await adminApi(`/admin/flights/${f.id}`, 'DELETE'); load(); }} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data && <Pagination page={data.page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}

      <ConfirmDialog open={!!adj} title="Adjust seat allocation" confirmLabel="Apply adjustment" onCancel={() => setAdj(null)} onConfirm={adjust}
        body={adj ? `Flight ${adj.flight.flightNumber}: positive adds seats, negative removes. Cannot go below held + confirmed + ticketed.` : ''}>
        {adj && (
          <>
            <label>Change (± seats)</label><NumInput allowNegative value={adj.delta} onChange={(n) => setAdj({ ...adj, delta: n })} />
            <label>Reason (required, audited)</label><input value={adj.reason} maxLength={500} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} />
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
