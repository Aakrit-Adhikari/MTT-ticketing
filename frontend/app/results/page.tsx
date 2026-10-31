'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import SiteShell from '@/components/SiteShell';
import { Flight, FlightList, InquiryForm, Results, Stepper } from '@/components/booking';
import { publicApi } from '@/lib/api';
import { fmtDateTime, fmtMoney, routeCode } from '@/lib/format';

const niceDate = (ymd: string | null) => (ymd ? new Date(`${ymd}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null);

function ResultsView() {
  const params = useSearchParams();
  const qs = params.toString();
  const [results, setResults] = useState<Results | null>(null);
  const [pick, setPick] = useState<{ out?: Flight; ret?: Flight }>({});
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ email: string; people: number } | null>(null);

  useEffect(() => {
    setResults(null); setPick({}); setDone(null); setErr('');
    // sectorName is only for the heading; the API never sees it.
    const p = new URLSearchParams(qs); p.delete('sectorName');
    publicApi.get<Results>(`/public/flights/search?${p}`).then(setResults).catch((e) => setErr(e.message));
  }, [qs]);

  const sectorId = params.get('sectorId');
  const tripType = params.get('tripType') ?? 'ONE_WAY';
  const round = tripType === 'ROUND_TRIP' && !sectorId;
  const ready = pick.out && (!round || pick.ret);
  const party = { tripType, adults: Number(params.get('adults') ?? 1), children: Number(params.get('children') ?? 0), infants: Number(params.get('infants') ?? 0) };
  const people = party.adults + party.children + party.infants;
  const dep = niceDate(params.get('departureDate'));
  const ret = niceDate(params.get('returnDate'));
  const step = done ? 4 : ready ? 3 : 2;
  const anyDate = (() => { const p = new URLSearchParams(qs); p.delete('departureDate'); p.delete('returnDate'); return p.toString(); })();
  const title = sectorId ? (params.get('sectorName') ?? 'Sector flight') : `${params.get('origin')} → ${params.get('destination')}`;

  return (
    <SiteShell>
      <Stepper step={step} />
      <div className="trip-head">
        <h1>{title}</h1>
        <span className="muted">{dep ? `${dep}${round && ret ? ` · return ${ret}` : ''}` : 'All upcoming departures'}</span>
      </div>
      <p className="sm muted" style={{ marginTop: 0 }}>
        <b>{people} travelling</b>: {party.adults} adult{party.adults === 1 ? '' : 's'}{party.children ? `, ${party.children} child${party.children === 1 ? '' : 'ren'}` : ''}{party.infants ? `, ${party.infants} infant${party.infants === 1 ? '' : 's'}` : ''} · <Link href="/">Change search</Link>
      </p>
      {err && <p className="error" role="alert">{err}</p>}
      {!results && !err && <p>Searching…</p>}
      {results && results.outbound.length === 0 && (
        <div className="panel empty">
          <h2 style={{ marginTop: 0 }}>No flights found</h2>
          <p>We have no flights with {people === 1 ? 'a seat' : `${party.adults + party.children} seats`} for this search{dep ? ' on that date' : ''}{round ? ' (a round trip needs flights in both directions)' : ''}.</p>
          {dep && (
            <div className="pub-notice">
              <b>Can&apos;t find a flight on {dep}{round && ret ? ` / ${ret}` : ''}?</b> Want to see the available flights on other dates?
              <p style={{ margin: '8px 0 0' }}><Link className="btn" href={`/results?${anyDate}`}>Show all available flights</Link></p>
            </div>
          )}
          <p className="row"><Link className="btn secondary" href="/">Search again</Link><Link className="btn secondary" href="/contact">Contact us</Link></p>
        </div>
      )}
      {results && results.outbound.length > 0 && !done && (
        <>
          <FlightList title={round ? 'Going flight' : 'Available flights'} flights={results.outbound} chosen={pick.out} onPick={(f) => setPick((p) => ({ ...p, out: f }))} people={people} />
          {round && <FlightList title="Return flight" flights={results.return} chosen={pick.ret} onPick={(f) => setPick((p) => ({ ...p, ret: f }))} people={people} />}
          <p className="muted sm">Seat counts are the seats our staff currently hold for this flight. Fares are estimates; staff confirm everything with the airline.</p>
        </>
      )}
      {ready && !done && (
        <div className="pick-bar" role="status">
          <div className="grow">
            <b>{pick.out!.airline.name} {pick.out!.flightNumber}</b> · {fmtDateTime(pick.out!.departureAt)}
            {pick.ret && <> &nbsp;|&nbsp; <b>Return {pick.ret.flightNumber}</b> · {fmtDateTime(pick.ret.departureAt)}</>}
            <br />{pick.ret ? `Going ${fmtMoney(pick.out!.estimatedTotal, pick.out!.currency)} + Return ${fmtMoney(pick.ret.estimatedTotal, pick.ret.currency)} = ` : 'Estimated total '}<b>{fmtMoney(Number(pick.out!.estimatedTotal) + Number(pick.ret?.estimatedTotal ?? 0), pick.out!.currency)}</b>
          </div>
          <button type="button" onClick={() => document.getElementById('details')?.scrollIntoView({ behavior: 'smooth' })}>Enter passenger details ↓</button>
        </div>
      )}
      {ready && !done && (
        <InquiryForm q={party} out={pick.out!} ret={pick.ret} wanted={{ date: params.get('departureDate') ?? undefined, returnDate: params.get('returnDate') ?? undefined }} onDone={(email) => setDone({ email, people })} />
      )}
      {done && (
        <div className="panel" role="status">
          <h2 style={{ marginTop: 0 }}>Inquiry received</h2>
          <p>We have emailed your <b>booking reference</b> to <b>{done.email}</b>. Please check your inbox (and spam folder).</p>
          <p className="sm">Request for <b>{done.people} passenger{done.people === 1 ? '' : 's'}</b>: {pick.out?.flightNumber} {pick.out && routeCode(pick.out)}{pick.ret ? `, return ${pick.ret.flightNumber}` : ''}.</p>
          <p className="pub-notice">Status: <b>Pending</b>. This is <b>not</b> a confirmed booking or ticket. Our staff will check availability with the airline and email you when it is approved. If your date is not available we will offer the nearest reserved flight. You can check progress any time on <Link href="/lookup">Find my booking</Link> using the reference and this email address.</p>
        </div>
      )}
    </SiteShell>
  );
}

export default function ResultsPage() {
  return <Suspense fallback={<SiteShell><p>Loading…</p></SiteShell>}><ResultsView /></Suspense>;
}
