'use client';
import { FormEvent, useState } from 'react';
import SiteShell from '@/components/SiteShell';
import { Field } from '@/components/ui';
import { downloadPublicFile, publicApi } from '@/lib/api';
import { dirLabel, fmtDateTime, routeWords } from '@/lib/format';

interface Result {
  reference: string; status: string; tripType: string; createdAt: string; pnr: string | null;
  rescheduled: boolean; payment: string | null; requests: { type: 'CANCEL_REFUND' | 'RESCHEDULE'; status: 'OPEN' | 'DONE' | 'REJECTED'; createdAt: string }[];
  segments: { direction: string; airline: { name: string }; flightNumber: string; origin: { city: string; iata: string } | null; destination: { city: string; iata: string } | null; sector: { name: string } | null; departureAt: string }[];
  passengers: { type: string; firstName: string; lastName: string; ticketNumber: string | null }[];
  ticketFiles?: { id: string; filename: string; size: number }[];
}

const MEANING: Record<string, { label: string; text: string; cls: string }> = {
  PENDING: { label: 'Pending', cls: 's-HELD', text: 'We have received your request and are checking with the airline. Seats are not confirmed yet. We will email you when this changes.' },
  APPROVED: { label: 'Approved', cls: 's-CONFIRMED', text: 'Your booking is approved and your seats are confirmed. Your ticket will be emailed to you once it is issued.' },
  TICKETED: { label: 'Ticket issued', cls: 's-TICKETED', text: 'Your ticket has been issued. The details are below and have also been emailed to you.' },
  CANCELLED: { label: 'Cancelled', cls: 's-CANCELLED', text: 'This booking was cancelled.' },
  DECLINED: { label: 'Declined', cls: 's-REJECTED', text: 'We were unable to accept this request. Please contact us if you have questions.' },
  EXPIRED: { label: 'Expired', cls: 's-EXPIRED', text: 'The hold on your seats expired. Please contact us if you still wish to travel.' },
};

export default function LookupPage() {
  const [f, setF] = useState({ reference: '', email: '' });
  const [r, setR] = useState<Result | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<null | 'CANCEL_REFUND' | 'RESCHEDULE'>(null);
  const [msg, setMsg] = useState({ message: '', preferredDate: '' });
  const [askErr, setAskErr] = useState('');
  const [sent, setSent] = useState(false);

  async function sendRequest(e: FormEvent) {
    e.preventDefault(); setAskErr('');
    try {
      await publicApi.post('/public/bookings/request', { ...f, type: ask, message: msg.message, ...(ask === 'RESCHEDULE' && msg.preferredDate ? { preferredDate: msg.preferredDate } : {}) });
      setSent(true); setAsk(null); setMsg({ message: '', preferredDate: '' });
      setR(await publicApi.post<Result>('/public/bookings/lookup', f));
    } catch (x) { setAskErr((x as Error).message); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(''); setR(null); setSent(false); setAsk(null); setBusy(true);
    try { setR(await publicApi.post<Result>('/public/bookings/lookup', f)); }
    catch { setErr('No booking found for these details. Check the reference from your email and the email address you used when booking.'); }
    finally { setBusy(false); }
  }

  const m = r ? MEANING[r.status] : null;

  return (
    <SiteShell>
      <h1>Find my booking</h1>
      <p className="muted sm">Your booking reference was sent to your email when you submitted the inquiry.</p>
      <form className="panel grid" onSubmit={submit}>
        <Field label="Booking reference"><input required placeholder="MT-XXXXX-XXXXX" maxLength={30} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
        <Field label="Email used when booking"><input type="email" required maxLength={254} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <button disabled={busy}>{busy ? 'Checking…' : 'Look up'}</button>
      </form>
      {err && <p className="error" role="alert">{err}</p>}
      {r && m && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>{r.reference}</h2>
          <p style={{ fontSize: '1.15rem' }}>Status: <span className={`badge ${m.cls}`}>{m.label.toUpperCase()}</span></p>
          {r.payment && r.payment !== 'NONE' && <p>Payment: <b>{({ UNPAID: 'Awaiting payment', PARTIAL: 'Partly paid', PAID: 'Paid in full', OVERPAID: 'Paid', REFUND_DUE: 'Refund being reviewed by our team', REFUNDED: 'Refunded' } as Record<string, string>)[r.payment]}</b></p>}
          {r.rescheduled && <p><span className="badge s-HELD">RESCHEDULED</span> <span className="sm muted">This booking was moved to a different flight after it was made. The flights below are your current ones.</span></p>}
          <p>{m.text}</p>
          {r.status === 'TICKETED' && r.pnr && <p>Airline reservation code (PNR): <b style={{ fontSize: '1.15rem' }}>{r.pnr}</b></p>}
          <div className="table-scroll">
            <table>
              <thead><tr><th>Trip</th><th>Flight</th><th>Route</th><th>Departure (Nepal time)</th></tr></thead>
              <tbody>
                {r.segments.map((s) => (
                  <tr key={s.direction}><td>{dirLabel(s.direction)}</td><td>{s.airline.name} {s.flightNumber}</td><td>{routeWords(s)}</td><td>{fmtDateTime(s.departureAt)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.status === 'TICKETED' && (r.ticketFiles?.length ?? 0) > 0 && (
            <>
              <h2>Your ticket</h2>
              <div className="row">
                {r.ticketFiles!.map((t) => (
                  <button key={t.id} className="secondary" onClick={async () => { setErr(''); try { await downloadPublicFile('/public/bookings/ticket-file', { ...f, fileId: t.id }, t.filename); } catch (x) { setErr((x as Error).message); } }}>Download {t.filename}</button>
                ))}
              </div>
            </>
          )}
          <h2>Passengers ({r.passengers.length})</h2>
          <table>
            <thead><tr><th>Name</th><th>Type</th>{r.status === 'TICKETED' && <th>Ticket number</th>}</tr></thead>
            <tbody>
              {r.passengers.map((p, i) => (
                <tr key={i}><td>{p.firstName} {p.lastName}</td><td>{p.type.toLowerCase()}</td>{r.status === 'TICKETED' && <td>{p.ticketNumber ?? '—'}</td>}</tr>
              ))}
            </tbody>
          </table>
          {r.requests.length > 0 && (
            <>
              <h2>Your requests</h2>
              <ul>
                {r.requests.map((q, i) => (
                  <li key={i}>{q.type === 'CANCEL_REFUND' ? 'Cancellation / refund' : 'Date change'}: <b>{q.status === 'OPEN' ? 'waiting for our staff' : q.status === 'DONE' ? 'processed (see your email)' : 'not approved (see your email)'}</b></li>
                ))}
              </ul>
            </>
          )}
          {['PENDING', 'APPROVED', 'TICKETED'].includes(r.status) && (
            <>
              <h2>Need to change something?</h2>
              <div className="row">
                <button className="secondary" onClick={() => { setAsk('CANCEL_REFUND'); setSent(false); }}>Request cancellation / refund</button>
                <button className="secondary" onClick={() => { setAsk('RESCHEDULE'); setSent(false); }}>Request a date change</button>
              </div>
              {sent && <p className="ok" role="status">Your request has been sent. Our team will contact you after reviewing it (for refunds, this is when we tell you what applies). We have also emailed you a confirmation.</p>}
              {ask && (
                <form onSubmit={sendRequest} style={{ marginTop: 10 }}>
                  <p className="muted sm">{ask === 'CANCEL_REFUND' ? 'Our team will contact you about your refund after your request. The amount depends on the airline\'s rules, so you do not need to enter one.' : 'A date change depends on availability and the airline\'s rules. Our staff will confirm.'}</p>
                  {ask === 'RESCHEDULE' && <Field label="Preferred new date (optional)"><input type="date" value={msg.preferredDate} onChange={(e) => setMsg({ ...msg, preferredDate: e.target.value })} /></Field>}
                  <Field label="Message"><textarea required minLength={3} maxLength={1000} rows={3} value={msg.message} onChange={(e) => setMsg({ ...msg, message: e.target.value })} /></Field>
                  {askErr && <p className="error" role="alert">{askErr}</p>}
                  <p><button>Send request</button> <button type="button" className="secondary" onClick={() => setAsk(null)}>Close</button></p>
                </form>
              )}
            </>
          )}
          <p className="sm muted">Changes are reviewed manually under our <a href="/policies">policies</a>. For anything urgent, <a href="/contact">contact us</a> quoting {r.reference}.</p>
        </div>
      )}
    </SiteShell>
  );
}
