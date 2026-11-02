'use client';
import { FormEvent, useState } from 'react';
import { PassportFields, PassportValue, noPassport, passportPayload } from '@/components/passport';
import { Field } from '@/components/ui';
import { publicApi } from '@/lib/api';
import { dayKey, fmtDay, fmtDuration, fmtMoney, fmtTime } from '@/lib/format';

export interface Airport { iata: string; city: string; name: string }
export interface Flight {
  id: string; flightNumber: string; airline: { code: string; name: string; logoUrl: string | null };
  origin: Airport | null; destination: Airport | null; sector: { id: string; name: string } | null; departureAt: string; arrivalAt: string | null;
  adultFare: string; childFare: string; currency: string; estimatedTotal: string; seatsAvailable: number; fitsParty?: boolean;
}
export interface Results { outbound: Flight[]; return: Flight[] }
interface Pax extends PassportValue { type: 'ADULT' | 'CHILD' | 'INFANT'; firstName: string; lastName: string }

export function AirlineMark({ airline }: { airline: Flight['airline'] }) {
  return airline.logoUrl
    ? <img src={airline.logoUrl} alt={`${airline.name} logo`} loading="lazy" />
    : <span className="ph" aria-hidden="true">{airline.code}</span>;
}

export function Stepper({ step }: { step: 1 | 2 | 3 | 4 }) {
  const labels = ['Search', 'Choose flight', 'Passenger details', 'Inquiry sent'];
  return (
    <ol className="stepper" aria-label="Progress">
      {labels.map((l, i) => (
        <li key={l} className={i + 1 < step ? 'done' : i + 1 === step ? 'now' : ''} aria-current={i + 1 === step ? 'step' : undefined}>
          <span className="no">{i + 1 < step ? '✓' : i + 1}</span>{l}
        </li>
      ))}
    </ol>
  );
}

/** Flights grouped under a heading per day, each showing the airline, times and how many seats are left. */
export function FlightList({ title, flights, chosen, onPick, people }: { title: string; flights: Flight[]; chosen?: Flight; onPick: (f: Flight) => void; people: number }) {
  const days: { key: string; at: string; items: Flight[] }[] = [];
  for (const f of flights) {
    const k = dayKey(f.departureAt);
    const g = days.find((d) => d.key === k);
    if (g) g.items.push(f); else days.push({ key: k, at: f.departureAt, items: [f] });
  }
  return (
    <section aria-label={title}>
      <h2 className="leg-title">{title}</h2>
      {days.map((d) => (
        <div key={d.key}>
          <div className="day-head">{fmtDay(d.at)}</div>
          {d.items.map((f) => (
            <label key={f.id} className={`fcard${chosen?.id === f.id ? ' picked' : ''}${f.fitsParty === false ? ' short' : ''}`}>
              <input type="radio" name={title} checked={chosen?.id === f.id} disabled={f.fitsParty === false} onChange={() => onPick(f)} />
              <div className="al">
                <AirlineMark airline={f.airline} />
                <div><b>{f.airline.name}</b><small>{f.flightNumber}</small></div>
              </div>
              {f.origin && f.destination && !f.arrivalAt ? (
                <div className="times">
                  <div><div className="t">{fmtTime(f.departureAt)}</div><div className="c">Departs {f.origin.city} ({f.origin.iata})</div></div>
                  <div className="mid"><div className="line" /></div>
                  <div style={{ textAlign: 'right' }}><div className="t">&nbsp;</div><div className="c">{f.destination.city} ({f.destination.iata})</div></div>
                </div>
              ) : f.origin && f.destination && f.arrivalAt ? (
                <div className="times">
                  <div><div className="t">{fmtTime(f.departureAt)}</div><div className="c">{f.origin.city} ({f.origin.iata})</div></div>
                  <div className="mid">{fmtDuration(f.departureAt, f.arrivalAt)}<div className="line" /></div>
                  <div style={{ textAlign: 'right' }}><div className="t">{fmtTime(f.arrivalAt)}</div><div className="c">{f.destination.city} ({f.destination.iata})</div></div>
                </div>
              ) : (
                <div className="times sector">
                  <div><div className="t">{fmtTime(f.departureAt)}</div><div className="c">Departs</div></div>
                  <div className="c"><b>{f.sector?.name ?? 'Sector flight'}</b><br />Scenic sector flight, one way</div>
                </div>
              )}
              <div><span className={`chip${f.seatsAvailable <= 5 ? ' low' : ''}`}>{f.seatsAvailable} seat{f.seatsAvailable === 1 ? '' : 's'} left</span>{f.fitsParty === false && <small className="short-note">Only {f.seatsAvailable} seat{f.seatsAvailable === 1 ? '' : 's'} remaining on this flight. Please <a href="/contact">contact us</a> or change the number of passengers.</small>}</div>
              <div className="price">
                <b>{fmtMoney(f.estimatedTotal, f.currency)}</b>
                <small>for {people} passenger{people === 1 ? '' : 's'}</small>
              </div>
            </label>
          ))}
        </div>
      ))}
    </section>
  );
}

export function InquiryForm({ q, out, ret, wanted, onDone }: { q: { tripType: string; adults: number; children: number; infants: number }; out: Flight; ret?: Flight; wanted?: { date?: string; returnDate?: string }; onDone: (email: string) => void }) {
  const make = (type: Pax['type'], n: number): Pax[] => Array.from({ length: n }, () => ({ type, firstName: '', lastName: '', ...noPassport() }));
  const [pax, setPax] = useState<Pax[]>([...make('ADULT', q.adults), ...make('CHILD', q.children), ...make('INFANT', q.infants)]);
  const [c, setC] = useState({ contactName: '', contactEmail: '', contactPhone: '', notes: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      await publicApi.post<{ received: boolean }>('/public/bookings/inquiry', {
        tripType: q.tripType, outboundFlightId: out.id, ...(ret ? { returnFlightId: ret.id } : {}),
        ...c, notes: c.notes || undefined,
        passengers: pax.map((p) => ({ type: p.type, firstName: p.firstName, lastName: p.lastName, ...passportPayload(p) })),
        // The day the customer asked for (if they chose one) is kept so staff can find a nearby flight if this one changes.
        ...(wanted?.date ? { requestedDate: wanted.date } : {}), ...(ret && wanted?.returnDate ? { requestedReturnDate: wanted.returnDate } : {}),
      });
      onDone(c.contactEmail);
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  const upd = (i: number, patch: Partial<Pax>) => setPax((p) => p.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <form className="panel" id="details" onSubmit={submit}>
      <h2 style={{ marginTop: 0 }}>Passenger and contact details</h2>
      <p><b>{pax.length} {pax.length === 1 ? 'person' : 'people'} travelling</b> <span className="muted">({[q.adults && `${q.adults} adult${q.adults > 1 ? 's' : ''}`, q.children && `${q.children} child${q.children > 1 ? 'ren' : ''}`, q.infants && `${q.infants} infant${q.infants > 1 ? 's' : ''}`].filter(Boolean).join(', ')})</span></p>
      <p className="muted sm">Enter names exactly as printed on the passport. Passport details are optional here, but if you give the number, also choose the nationality. They are stored encrypted and only our booking staff can read them.</p>
      {pax.map((p, i) => (
        <fieldset className="pax-block" key={i}>
          <legend>{p.type[0]}{p.type.slice(1).toLowerCase()} {i + 1}</legend>
          <div className="grid pax-grid">
            <Field label="First name"><input required maxLength={60} value={p.firstName} onChange={(e) => upd(i, { firstName: e.target.value })} /></Field>
            <Field label="Last name"><input required maxLength={60} value={p.lastName} onChange={(e) => upd(i, { lastName: e.target.value })} /></Field>
            <PassportFields value={p} onChange={(v) => upd(i, v)} showExpiry={false} />
          </div>
        </fieldset>
      ))}
      <h3 className="form-sub">Contact details</h3>
      <div className="grid">
        <Field label="Contact name"><input required maxLength={100} title="Letters and spaces only (no digits or symbols)" value={c.contactName} onChange={(e) => setC({ ...c, contactName: e.target.value })} /></Field>
        <Field label="Email"><input type="email" required maxLength={254} value={c.contactEmail} onChange={(e) => setC({ ...c, contactEmail: e.target.value })} /></Field>
        <Field label="Phone"><input type="tel" required pattern="\+?[0-9][0-9 \-]{6,18}" title="Digits, optionally starting with +" value={c.contactPhone} onChange={(e) => setC({ ...c, contactPhone: e.target.value })} /></Field>
      </div>
      <Field label="Notes (optional)"><textarea maxLength={1000} rows={2} value={c.notes} onChange={(e) => setC({ ...c, notes: e.target.value })} /></Field>
      {err && <p className="error" role="alert">{err}</p>}
      <p style={{ marginBottom: 0 }}><button disabled={busy}>{busy ? 'Sending…' : 'Send booking inquiry'}</button></p>
    </form>
  );
}
