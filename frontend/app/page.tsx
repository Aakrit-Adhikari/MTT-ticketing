'use client';
import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import SiteShell from '@/components/SiteShell';
import { Airport } from '@/components/booking';
import { NumInput } from '@/components/ui';
import { publicApi } from '@/lib/api';

type Mode = 'ONE_WAY' | 'ROUND_TRIP' | 'SECTOR';
interface SectorOpt { id: string; name: string }

const today = () => new Date().toISOString().slice(0, 10);

function Hero() {
  return (
    <div className="pub-hero">
      <div className="in">
        <h1>Find your flight.<br />See the seats we hold for you.</h1>
        <p>Pick a route to see every upcoming departure, the airline and how many seats are left. Choosing a date is optional.</p>
      </div>
    </div>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [airports, setAirports] = useState<Airport[]>([]);
  const [sectors, setSectors] = useState<SectorOpt[]>([]);
  const [mode, setMode] = useState<Mode>('ONE_WAY');
  const [q, setQ] = useState({ origin: '', destination: '', sectorId: '', departureDate: '', returnDate: '', adults: 1, children: 0, infants: 0 });
  const [err, setErr] = useState('');

  useEffect(() => {
    publicApi.get<Airport[]>('/public/airports').then(setAirports).catch(() => setErr('Could not load airports.'));
    publicApi.get<SectorOpt[]>('/public/sectors').then(setSectors).catch(() => undefined);
  }, []);

  function search(e: FormEvent) {
    e.preventDefault(); setErr('');
    if (mode === 'ROUND_TRIP' && q.departureDate && !q.returnDate) { setErr('Choose a return date, or clear the departure date to see all flights.'); return; }
    // Dates are optional: leave them out and the results page lists every upcoming departure.
    const p = new URLSearchParams({
      tripType: mode === 'ROUND_TRIP' ? 'ROUND_TRIP' : 'ONE_WAY',
      adults: String(q.adults), children: String(q.children), infants: String(q.infants),
      ...(mode === 'SECTOR' ? { sectorId: q.sectorId, sectorName: sectors.find((s) => s.id === q.sectorId)?.name ?? '' } : { origin: q.origin, destination: q.destination }),
      ...(q.departureDate ? { departureDate: q.departureDate } : {}),
      ...(mode === 'ROUND_TRIP' && q.returnDate ? { returnDate: q.returnDate } : {}),
    });
    router.push(`/results?${p}`); // always a page of its own, with or without flights
  }

  const set = <K extends keyof typeof q>(k: K, v: (typeof q)[K]) => setQ((s) => ({ ...s, [k]: v }));
  const swap = () => setQ((s) => ({ ...s, origin: s.destination, destination: s.origin }));
  const people = q.adults + q.children + q.infants;
  const modes: [Mode, string][] = [['ONE_WAY', 'One way'], ['ROUND_TRIP', 'Round trip'], ...(sectors.length ? [['SECTOR', 'Mountain / sector flight'] as [Mode, string]] : [])];

  return (
    <SiteShell hero={<><Hero />
      <div className="pub-search">
        <form onSubmit={search}>
          <div className="seg" role="radiogroup" aria-label="Trip type">
            {modes.map(([m, label]) => (
              <label key={m}>
                <input type="radio" name="trip" checked={mode === m} onChange={() => { setMode(m); setErr(''); }} />
                {label}
              </label>
            ))}
          </div>
          {/* The same seven cells in every mode, so the card never changes size when the mode changes. */}
          <div className="pub-fields">
            {mode === 'SECTOR' ? (
              <div className="f-route">
                <label htmlFor="sector">Sector</label>
                <select id="sector" required value={q.sectorId} onChange={(e) => set('sectorId', e.target.value)}>
                  <option value="">Choose a sector</option>
                  {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            ) : (
              <>
                <div>
                  <label htmlFor="from">From</label>
                  <select id="from" required value={q.origin} onChange={(e) => set('origin', e.target.value)}>
                    <option value="">Select city</option>
                    {airports.filter((a) => a.iata !== q.destination).map((a) => <option key={a.iata} value={a.iata}>{a.city} ({a.iata})</option>)}
                  </select>
                </div>
                <button type="button" className="swap" onClick={swap} aria-label="Swap origin and destination" title="Swap">⇄</button>
                <div>
                  <label htmlFor="to">To</label>
                  <select id="to" required value={q.destination} onChange={(e) => set('destination', e.target.value)}>
                    <option value="">Select city</option>
                    {airports.filter((a) => a.iata !== q.origin).map((a) => <option key={a.iata} value={a.iata}>{a.city} ({a.iata})</option>)}
                  </select>
                </div>
              </>
            )}
            <div>
              <label htmlFor="dep">Departure <span className="opt">(optional)</span></label>
              <input id="dep" type="date" min={today()} value={q.departureDate} onChange={(e) => set('departureDate', e.target.value)} />
            </div>
            <div>
              <label htmlFor="ret">Return <span className="opt">{mode === 'ROUND_TRIP' ? '(optional)' : '(round trip only)'}</span></label>
              <input id="ret" type="date" min={q.departureDate || today()} disabled={mode !== 'ROUND_TRIP'} value={mode === 'ROUND_TRIP' ? q.returnDate : ''} onChange={(e) => set('returnDate', e.target.value)} />
            </div>
            <div>
              <label>Travellers</label>
              <details className="pax">
                <summary>{people} passenger{people === 1 ? '' : 's'}</summary>
                <div className="pop">
                  <div className="line"><div>Adults<small>12 years and over</small></div><div className="num"><NumInput min={1} max={9} value={q.adults} onChange={(n) => set('adults', n)} /></div></div>
                  <div className="line"><div>Children<small>2 to 11 years</small></div><div className="num"><NumInput min={0} max={8} value={q.children} onChange={(n) => set('children', n)} /></div></div>
                  <div className="line"><div>Infants<small>Under 2, on a lap</small></div><div className="num"><NumInput min={0} max={9} value={q.infants} onChange={(n) => set('infants', n)} /></div></div>
                </div>
              </details>
            </div>
            <button className="go">Search flights</button>
          </div>
          <p className="hint" role={err ? 'alert' : undefined} style={err ? { color: 'var(--danger)' } : undefined}>
            {err || `${q.adults + q.children} seat${q.adults + q.children === 1 ? '' : 's'} needed (infants travel on a lap). Leave the dates empty to see every upcoming flight.`}
          </p>
        </form>
      </div></>}>
      <p className="pub-notice" style={{ marginTop: 6 }}>
        Fares and seat counts are managed manually by our staff. Submitting a form sends an <b>inquiry</b>; your seats are
        <b> not reserved or ticketed</b> until our staff confirm with the airline and contact you.
      </p>
      <h2 className="pub-h2" id="how-it-works">How it works</h2>
      <div className="steps-how">
        <div className="s"><div className="n">1</div><b>Search</b><span className="t">Choose where you are flying. Add a date if you have one, or browse every upcoming departure.</span></div>
        <div className="s"><div className="n">2</div><b>Choose a flight</b><span className="t">Compare airlines, times, fares and how many seats are left.</span></div>
        <div className="s"><div className="n">3</div><b>Send your inquiry</b><span className="t">Enter passenger and contact details. You get a booking reference by email straight away.</span></div>
        <div className="s"><div className="n">4</div><b>We confirm with the airline</b><span className="t">Our staff confirm the seats and contact you. If your date is full we offer the nearest reserved flight. Track progress with “Find my booking”.</span></div>
      </div>
    </SiteShell>
  );
}
