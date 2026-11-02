'use client';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import Link from 'next/link';
import PaymentBadge from '@/components/PaymentBadge';
import { RequestActions, Req } from '@/components/RequestActions';
import { ChangeDateDialog } from '@/components/ChangeDateDialog';
import { PassportFields, PassportValue, noPassport } from '@/components/passport';
import { ConfirmDialog, DeleteButton, NumInput, StatusBadge } from '@/components/ui';
import { adminApi, adminUpload, downloadFile } from '@/lib/api';
import { dayKey, dirLabel, fmtDateOnly, fmtDateTime, fmtMoney, isoToNepalLocal, nepalLocalToIso, routeCode } from '@/lib/format';

interface Booking {
  id: string; reference: string; status: string; tripType: string; holdExpiresAt: string | null; createdAt: string; pnr: string | null; rescheduledCount: number; source: string; confirmedAt: string | null; requestedDate: string | null; requestedReturnDate: string | null;
  requests: Req[];
  reschedules: { id: string; direction: string; fromFlightNumber: string; fromDepartureAt: string; toFlightNumber: string; toDepartureAt: string; note: string | null; doneBy: string | null; createdAt: string }[];
  payment: { total: string; paid: string; refunded: string; net: string; balance: string; status: string };
  payments: { id: string; receiptNumber: string; type: 'PAYMENT' | 'REFUND'; method: string; amount: string; reference: string | null; receivedAt: string; note: string | null; status: string; voidReason: string | null; recordedBy: string }[];
  notifications: { id: string; template: string; subject: string; status: string; error?: string | null; createdAt: string }[];
  contactName: string; contactEmail: string; contactPhone: string; notes: string | null;
  ticketFiles: { id: string; filename: string; size: number; uploadedByName: string; createdAt: string }[];
  segments: { id: string; direction: string; seats: number; seatState: string; adultFare: string; childFare: string; actualDepartureAt: string | null;
    flight: { id: string; scheduledDepartureAt: string; seatsAtFlight: { total: number; held: number; confirmed: number; ticketed: number; available: number } | null; flightNumber: string; airline: { name: string }; origin: { iata: string } | null; destination: { iata: string } | null; sector: { id: string; name: string } | null; departureAt: string } }[];
  passengers: { id: string; type: string; firstName: string; lastName: string; ticketNumber: string | null; dateOfBirth?: string | null; documentNumberMasked?: string | null; nationality?: string | null; documentExpiry?: string | null }[];
}
type Action = 'hold' | 'release' | 'confirm' | 'ticket' | 'reschedule' | 'cancel' | 'reject';
interface Choice { id: string; flightNumber: string; departureAt: string; seats: number; gapDays: number | null }

const COPY: Record<Action, { title: string; body: string; label: string; danger?: boolean; reason?: boolean }> = {
  hold: { title: 'Place a temporary hold?', body: 'Seats are taken from the agency allocation until the hold expires. Only do this once you are arranging the airline reservation.', label: 'Hold seats' },
  release: { title: 'Release the held seats?', body: 'The seats go back on sale right away and this stays an open inquiry (status New). The customer is not emailed. You can hold the seats again later.', label: 'Release seats' },
  confirm: { title: 'Confirm and turn into a booking?', body: 'Confirm ONLY after the seats are secured with the airline. This commits the seats, moves it from Inquiries to Bookings, and emails the customer. It can only be undone by cancelling.', label: 'Confirm booking' },
  ticket: { title: 'Record issued ticket', body: 'Type the PNR and ticket numbers exactly as issued by the airline. The customer is emailed these details.', label: 'Issue ticket' },
  reschedule: { title: 'Reschedule booking', body: 'Pick the new date AND time by choosing another departure on the same route (or sector); each choice shows its day, time and flight. Seats are released on the old flight and taken on the new one in one step, the customer is emailed, and the original flight stays on record.', label: 'Reschedule' },
  cancel: { title: 'Cancel this booking?', body: 'Seats are released back to the pool.', label: 'Cancel booking', danger: true, reason: true },
  reject: { title: 'Reject this inquiry?', body: 'Held seats (if any) are released.', label: 'Reject', danger: true, reason: true },
};

export default function BookingDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const [b, setB] = useState<Booking | null>(null);
  const [err, setErr] = useState('');
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(120);
  const [busy, setBusy] = useState(false);
  const [pnr, setPnr] = useState('');
  const [choices, setChoices] = useState<Record<string, Choice[]>>({});
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [rnote, setRnote] = useState('');
  const [resent, setResent] = useState('');
  const [payDlg, setPayDlg] = useState<null | 'PAYMENT' | 'REFUND'>(null);
  const [pay, setPay] = useState({ amount: '', method: 'CASH', reference: '', note: '', key: '' });
  const [payErr, setPayErr] = useState('');
  const [voidDlg, setVoidDlg] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [tickets, setTickets] = useState<Record<string, string>>({});
  const [dateDlg, setDateDlg] = useState(false);
  const [ticketPdfs, setTicketPdfs] = useState<File[]>([]);
  const [retime, setRetime] = useState<Record<string, string>>({}); // direction -> datetime-local (Nepal), for "keep this flight, change its time"
  const [fileMsg, setFileMsg] = useState('');
  const [autoOpened, setAutoOpened] = useState(false);
  const [shown, setShown] = useState<Record<string, string | null>>({}); // passengerId -> full passport number, only while revealed
  const [passDlg, setPassDlg] = useState<null | { id: string; name: string; v: PassportValue }>(null);
  const [passErr, setPassErr] = useState('');

  const load = useCallback(() => { adminApi<Booking>(`/admin/bookings/${id}`).then(setB).catch((e) => setErr(e.message)); }, [id]);
  useEffect(load, [load]);

  // A revealed passport number is hidden again after 30 seconds, and whenever the page is left.
  useEffect(() => {
    const ids = Object.keys(shown);
    if (ids.length === 0) return;
    const t = setTimeout(() => setShown({}), 30_000);
    return () => clearTimeout(t);
  }, [shown]);

  async function reveal(pid: string) {
    setErr('');
    try {
      const r = await adminApi<{ documentNumber: string | null }>(`/admin/bookings/${id}/passengers/${pid}/passport/reveal`, 'POST');
      setShown((s) => ({ ...s, [pid]: r.documentNumber }));
    } catch (e) { setErr((e as Error).message); }
  }
  async function openPassport(p: Booking['passengers'][number]) {
    setPassErr('');
    let v = noPassport();
    if (p.documentNumberMasked) { // editing: start from the stored values (this reveal is audited like any other)
      try { const r = await adminApi<PassportValue>(`/admin/bookings/${id}/passengers/${p.id}/passport/reveal`, 'POST'); v = { documentNumber: r.documentNumber ?? '', nationality: r.nationality ?? '', documentExpiry: r.documentExpiry ?? '' }; }
      catch (e) { setErr((e as Error).message); return; }
    }
    setPassDlg({ id: p.id, name: `${p.firstName} ${p.lastName}`, v });
  }
  async function savePassport() {
    if (!passDlg) return;
    const { v } = passDlg;
    if (!v.documentNumber || !v.nationality.trim()) { setPassErr('Enter the passport number and choose the nationality.'); return; }
    setBusy(true); setPassErr('');
    try {
      const nb = await adminApi<Booking>(`/admin/bookings/${id}/passengers/${passDlg.id}/passport`, 'PATCH', { documentNumber: v.documentNumber.trim(), nationality: v.nationality.trim(), ...(v.documentExpiry ? { documentExpiry: v.documentExpiry } : {}) });
      setB((old) => (old ? { ...old, passengers: nb.passengers } : old));
      setShown((s) => { const { [passDlg.id]: _gone, ...rest } = s; return rest; });
      setPassDlg(null);
    } catch (e) { setPassErr((e as Error).message); } finally { setBusy(false); }
  }

  // Opened from a list or a customer's date-change request: go straight to the reschedule picker, once.
  useEffect(() => {
    if (b && !autoOpened && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('reschedule') && user?.role !== 'FINANCE_STAFF') {
      setAutoOpened(true);
      void openReschedule();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b, autoOpened, user]);

  function openPay(type: 'PAYMENT' | 'REFUND') {
    // A fresh key per opened form: a double click or retry can then never record the money twice.
    setPay({ amount: type === 'PAYMENT' && b && Number(b.payment.balance) > 0 ? b.payment.balance : '', method: type === 'PAYMENT' ? 'CASH' : 'BANK_TRANSFER', reference: '', note: '', key: crypto.randomUUID() });
    setPayErr(''); setPayDlg(type);
  }

  async function submitPay() {
    if (!payDlg) return;
    setBusy(true); setPayErr('');
    try {
      await adminApi(`/admin/bookings/${id}/${payDlg === 'PAYMENT' ? 'payments' : 'refunds'}`, 'POST', {
        amount: pay.amount, method: pay.method, idempotencyKey: pay.key, ...(pay.reference ? { reference: pay.reference } : {}), ...(pay.note ? { note: pay.note } : {}),
      });
      setPayDlg(null); load();
    } catch (e) { setPayErr((e as Error).message); } finally { setBusy(false); }
  }

  async function doVoid() {
    if (!voidDlg) return;
    try { await adminApi(`/admin/payments/${voidDlg}/void`, 'POST', { reason: voidReason }); setVoidDlg(null); setVoidReason(''); load(); }
    catch (e) { setErr((e as Error).message); setVoidDlg(null); }
  }

  async function resend() {
    setResent('');
    try { const r = await adminApi<{ to: string }>(`/admin/bookings/${id}/resend-email`, 'POST'); setResent(`Email with the reference sent to ${r.to}`); load(); }
    catch (e) { setResent((e as Error).message); }
  }

  async function openReschedule() {
    if (!b) return;
    setAction('reschedule'); setPicked({});
    setRetime(Object.fromEntries(b.segments.map((s) => [s.direction, isoToNepalLocal(s.flight.departureAt)])));
    const out: Record<string, Choice[]> = {};
    for (const s of b.segments) {
      const want = (s.direction === 'RETURN' ? b.requestedReturnDate : b.requestedDate)?.slice(0, 10) ?? null;
      const today = new Date().toISOString().slice(0, 10);
      const shift = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
      const from = want && shift(want, -21) > today ? shift(want, -21) : today;
      const q = new URLSearchParams({ status: 'SCHEDULED', ...(s.flight.sector ? { sectorId: s.flight.sector.id } : { origin: s.flight.origin?.iata ?? '', destination: s.flight.destination?.iata ?? '' }), from, ...(want ? { to: shift(want, 60) } : {}) });
      const page = await adminApi<{ items: { id: string; flightNumber: string; departureAt: string; inventory: { total: number; held: number; confirmed: number; ticketed: number } | null }[] }>(`/admin/flights?${q}`);
      const gap = (iso: string) => (want ? Math.abs((Date.parse(`${dayKey(iso)}T00:00:00Z`) - Date.parse(`${want}T00:00:00Z`)) / 86_400_000) : null);
      out[s.direction] = page.items.filter((f) => f.id !== s.flight.id)
        .map((f) => ({ id: f.id, flightNumber: f.flightNumber, departureAt: f.departureAt, gapDays: gap(f.departureAt), seats: f.inventory ? f.inventory.total - f.inventory.held - f.inventory.confirmed - f.inventory.ticketed : 0 }))
        .sort((x, y) => (x.gapDays ?? 0) - (y.gapDays ?? 0) || x.departureAt.localeCompare(y.departureAt));
    }
    setChoices(out);
  }

  async function run() {
    if (!action) return;
    setBusy(true); setErr('');
    try {
      const body = action === 'reschedule' ? {
          changes: Object.entries(picked).filter(([, v]) => v).map(([direction, newFlightId]) => ({ direction, newFlightId })),
          retimes: (b?.segments ?? []).filter((s) => !picked[s.direction] && retime[s.direction] && nepalLocalToIso(retime[s.direction]) !== new Date(s.flight.departureAt).toISOString()).map((s) => ({ direction: s.direction, departureAt: nepalLocalToIso(retime[s.direction]) })),
          note: rnote || undefined,
        }
        : action === 'hold' ? { minutes }
        : action === 'ticket' ? { pnr, tickets: (b?.passengers ?? []).map((p) => ({ passengerId: p.id, ticketNumber: tickets[p.id] ?? '' })) }
        : COPY[action].reason ? { reason } : {};
      if (action === 'ticket' && ticketPdfs.length) {
        // Saved BEFORE the ticket is issued so the customer's ticket email can attach them. A bad file stops here, before anything is issued.
        for (const f of ticketPdfs) {
          try { await adminUpload(`/admin/bookings/${id}/ticket-files?filename=${encodeURIComponent(f.name)}`, f); } catch (x) { throw new Error(`${f.name}: ${(x as Error).message}`); }
          setTicketPdfs((p) => p.filter((q) => q !== f)); // uploaded: a retry must not upload it twice
        }
      }
      const nb = await adminApi<Booking>(`/admin/bookings/${id}/${action}`, 'POST', body);
      setB(nb);
      setAction(null); setReason(''); setPnr(''); setTickets({}); setTicketPdfs([]);
    } catch (e) { setErr((e as Error).message); setAction(null); load(); }
    finally { setBusy(false); }
  }

  if (!b) return <>{err ? <p className="error">{err}</p> : <p>Loading…</p>}</>;
  const canAct = user?.role !== 'FINANCE_STAFF';
  const missingPassports = b.confirmedAt ? [] : b.passengers.filter((p) => !p.documentNumberMasked && p.dateOfBirth !== undefined);
  const can = (a: Action) => canAct && (
    (a === 'hold' && b.status === 'INQUIRY') ||
    (a === 'release' && b.status === 'HELD') ||
    (a === 'confirm' && ['INQUIRY', 'HELD'].includes(b.status) && missingPassports.length === 0) ||
    (a === 'ticket' && b.status === 'CONFIRMED') ||
    (a === 'reschedule' && ['INQUIRY', 'HELD', 'CONFIRMED', 'TICKETED'].includes(b.status)) ||
    (a === 'cancel' && ['INQUIRY', 'HELD', 'CONFIRMED'].includes(b.status)) ||
    (a === 'reject' && ['INQUIRY', 'HELD'].includes(b.status)));

  return (
    <>
      <p className="muted sm">{b.confirmedAt ? (b.source === 'STAFF' ? 'Booking · created by staff' : 'Booking · converted from a website inquiry') : 'Inquiry · not yet a booking'}</p>
      <h1>{b.reference} <StatusBadge status={b.status} />{b.rescheduledCount > 0 && <> <span className="badge s-HELD" title="Moved to another flight after it was made">RESCHEDULED{b.rescheduledCount > 1 ? ` ×${b.rescheduledCount}` : ''}</span></>}</h1>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row action-bar" style={{ marginBottom: 12 }}>
        {([b.status === 'HELD' ? 'release' : 'hold', 'confirm', 'ticket', 'reschedule', 'cancel', 'reject'] as Action[]).map((a) => (
          <button key={a} className={a === 'cancel' || a === 'reject' ? 'secondary' : ''} disabled={!can(a)} onClick={() => (a === 'reschedule' ? openReschedule() : setAction(a))}>{a === 'reschedule' ? 'Change date / reschedule' : COPY[a].label}</button>
        ))}
      </div>

      {canAct && ['INQUIRY', 'HELD'].includes(b.status) && missingPassports.length > 0 && (
        <p className="pax-missing sm" role="status"><b>Passport needed before this can be confirmed.</b> Add the passport number and nationality for {missingPassports.map((p) => `${p.firstName} ${p.lastName}`).join(', ')} in the Passengers table below (button “Add”). Until then the inquiry can be held or rejected, but not confirmed.</p>
      )}
      {canAct && <div className="sm row"><button type="button" className="secondary" onClick={resend}>Email reference to customer again</button> <span className="muted">{resent}</span>
        <span style={{ marginLeft: 'auto' }}>{b.status === 'TICKETED' ? <span className="muted sm">Ticketed bookings cannot be deleted</span> : <DeleteButton what={`${b.confirmedAt ? 'booking' : 'inquiry'} ${b.reference}`} label="Delete permanently" extra={b.payments.length ? `Its ${b.payments.length} payment record(s) are deleted with it (Super Admin only).` : 'Seats it holds are given back.'} onDelete={async () => { await adminApi(`/admin/bookings/${id}`, 'DELETE'); router.replace(b.confirmedAt ? '/admin/bookings' : '/admin/inquiries'); }} />}</span></div>}
      <p className="muted sm">Customer sees: <b>{({ INQUIRY: 'Pending', HELD: 'Pending', CONFIRMED: 'Approved', TICKETED: 'Ticket issued', CANCELLED: 'Cancelled', REJECTED: 'Declined', EXPIRED: 'Expired' } as Record<string, string>)[b.status]}</b>{b.pnr ? ` · PNR ${b.pnr}` : ''}</p>
      <div className="cards">
        <section className="panel card">
          <h3 className="card-title">Customer contact</h3>
          <dl className="facts">
            <dt>Name</dt><dd>{b.contactName}</dd>
            <dt>Email</dt><dd>{b.contactEmail}</dd>
            <dt>Phone</dt><dd>{b.contactPhone}</dd>
            <dt>Notes from customer</dt><dd>{b.notes ?? 'None'}</dd>
          </dl>
        </section>
        <section className="panel card">
          <div className="card-head">
            <h3 className="card-title">Travel date</h3>
            {canAct && ['INQUIRY', 'HELD', 'CONFIRMED', 'TICKETED'].includes(b.status) && <button type="button" onClick={() => setDateDlg(true)}>Change date</button>}
          </div>
          <dl className="facts">
            <dt>Date customer wants to fly</dt>
            <dd>
              {fmtDateOnly(b.requestedDate)}
              {b.requestedDate && b.segments[0] && dayKey(b.segments[0].flight.departureAt) !== b.requestedDate.slice(0, 10) && <> <span className="badge s-HELD" title="The booked flight is on a different day">DIFFERENT DAY</span></>}
            </dd>
            {b.tripType === 'ROUND_TRIP' && <><dt>Return date wanted</dt><dd>{fmtDateOnly(b.requestedReturnDate)}</dd></>}
            <dt>Actual flight</dt><dd><b>{b.segments.map((x) => `${dirLabel(x.direction)}: ${x.flight.flightNumber} · ${fmtDateTime(x.flight.departureAt)}`).join('  |  ')}</b></dd>
            {b.reschedules?.length > 0 && <><dt>Rescheduled</dt><dd>{b.rescheduledCount} time{b.rescheduledCount === 1 ? '' : 's'}. Last on {fmtDateTime(b.reschedules[0].createdAt)}</dd></>}
            <dt>Received</dt><dd>{fmtDateTime(b.createdAt)}</dd>
            {b.holdExpiresAt && b.status === 'HELD' && <><dt>Hold expires</dt><dd>{fmtDateTime(b.holdExpiresAt)}</dd></>}
          </dl>
          {canAct && <p className="muted sm" style={{ margin: '8px 0 0' }}>“Change date” updates the day the customer asked for. To move them onto a different flight, use “Change date / reschedule” at the top.</p>}
        </section>
      </div>

      <h2>Flight</h2>
      <table>
        <thead><tr><th>Trip</th><th>Flight</th><th>Route</th><th>Departs</th><th>Seats for this booking</th><th>Status of these seats</th><th>Seats on this flight</th><th>Adult fare</th><th>Child fare</th></tr></thead>
        <tbody>
          {b.segments.map((s) => (
            <tr key={s.id}><td>{dirLabel(s.direction)}</td><td>{s.flight.airline.name} {s.flight.flightNumber}</td><td>{routeCode(s.flight)}</td>
              <td>{fmtDateTime(s.flight.departureAt)}{s.actualDepartureAt && <><br /><span className="badge s-HELD" title={`The flight is scheduled for ${fmtDateTime(s.flight.scheduledDepartureAt)}; this ticket was adjusted`}>TIME ADJUSTED</span><div className="muted sm">scheduled {fmtDateTime(s.flight.scheduledDepartureAt)}</div></>}</td>
              <td><b>{s.seats}</b> {s.seats === 1 ? 'seat' : 'seats'}</td>
              <td><StatusBadge status={s.seatState} /></td>
              <td className="sm">{s.flight.seatsAtFlight ? (
                <>
                  <b>{s.flight.seatsAtFlight.available} left</b> of {s.flight.seatsAtFlight.total}
                  <div className="muted">{s.flight.seatsAtFlight.held} on hold · {s.flight.seatsAtFlight.confirmed} confirmed · {s.flight.seatsAtFlight.ticketed} ticketed</div>
                </>
              ) : 'null'}</td>
              <td>{fmtMoney(s.adultFare)}</td><td>{fmtMoney(s.childFare)}</td></tr>
          ))}
        </tbody>
      </table>

      <h2>Passengers</h2>
      <table>
        <thead><tr><th>Type</th><th>Name</th><th>Ticket no.</th>{canAct && <><th>Date of birth</th><th>Nationality</th><th>Passport no.</th><th>Passport expiry</th><th className="col-actions">Passport</th></>}</tr></thead>
        <tbody>
          {b.passengers.map((p) => (
            <tr key={p.id}><td>{p.type}</td><td>{p.firstName} {p.lastName}</td><td>{p.ticketNumber ?? 'null'}</td>{canAct && <>
              <td>{p.dateOfBirth ? p.dateOfBirth.slice(0, 10) : 'null'}</td>
              <td>{p.nationality ?? 'null'}</td>
              <td className="mono">{p.id in shown ? (shown[p.id] ?? 'null') : (p.documentNumberMasked ?? 'null')}</td>
              <td>{p.documentExpiry ?? 'null'}</td>
              <td className="col-actions"><div className="actions">
                {p.documentNumberMasked && (p.id in shown
                  ? <button className="secondary" onClick={() => setShown(({ [p.id]: _x, ...rest }) => rest)}>Hide</button>
                  : <button className="secondary" onClick={() => reveal(p.id)}>Show</button>)}
                {!['CANCELLED', 'REJECTED', 'EXPIRED'].includes(b.status) && <button className="secondary" onClick={() => openPassport(p)}>{p.documentNumberMasked ? 'Edit' : 'Add'}</button>}
              </div></td></>}</tr>
          ))}
        </tbody>
      </table>
      {b.reschedules?.length > 0 && (
        <>
          <h2>Reschedule history</h2>
          <table>
            <thead><tr><th>Done on</th><th>Leg</th><th>Was (original flight)</th><th>Now (actual flight)</th><th>By</th><th>Note</th></tr></thead>
            <tbody>
              {b.reschedules.map((r) => (
                <tr key={r.id}><td>{fmtDateTime(r.createdAt)}</td><td>{dirLabel(r.direction)}</td><td><b>{r.fromFlightNumber}</b> · {fmtDateTime(r.fromDepartureAt)}</td><td><b>{r.toFlightNumber}</b> · {fmtDateTime(r.toDepartureAt)}</td><td>{r.doneBy ?? 'null'}</td><td>{r.note ?? 'null'}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {canAct && ['CONFIRMED', 'TICKETED'].includes(b.status) && (
        <>
          <h2>Airline ticket files</h2>
          <table>
            <thead><tr><th>File</th><th>Size</th><th>Added by</th><th>Added on</th><th className="col-actions">Actions</th></tr></thead>
            <tbody>
              {b.ticketFiles.map((f) => (
                <tr key={f.id}>
                  <td>{f.filename}</td><td>{(f.size / 1024).toFixed(0)} KB</td><td>{f.uploadedByName}</td><td>{fmtDateTime(f.createdAt)}</td>
                  <td className="col-actions"><span className="actions">
                    <button className="secondary" onClick={async () => { setFileMsg(''); try { await downloadFile(`/admin/bookings/${id}/ticket-files/${f.id}`, f.filename); } catch (e) { setFileMsg((e as Error).message); } }}>Download</button>
                    <button className="secondary danger-text" onClick={async () => { setFileMsg(''); try { await adminApi(`/admin/bookings/${id}/ticket-files/${f.id}`, 'DELETE'); load(); } catch (e) { setFileMsg((e as Error).message); } }}>Remove</button>
                  </span></td>
                </tr>
              ))}
              {b.ticketFiles.length === 0 && <tr><td colSpan={5} className="muted">No PDF added. This is optional.</td></tr>}
            </tbody>
          </table>
          <div className="row" style={{ margin: '8px 0' }}>
            <label className="btn secondary" style={{ margin: 0, cursor: 'pointer' }}>
              Add airline PDF
              <input type="file" accept="application/pdf,.pdf" style={{ display: 'none' }} onChange={async (e) => {
                const file = e.target.files?.[0]; e.target.value = '';
                if (!file) return;
                setFileMsg('');
                try { await adminUpload(`/admin/bookings/${id}/ticket-files?filename=${encodeURIComponent(file.name)}`, file); load(); } catch (x) { setFileMsg((x as Error).message); }
              }} />
            </label>
            {fileMsg && <span className="error">{fileMsg}</span>}
          </div>
        </>
      )}
      {canAct && <p className="muted sm">Passport details are stored encrypted. “Show” and “Edit” reveal the full number and are written to the audit log.</p>}
      <h2>Payments <PaymentBadge status={b.payment.status} /></h2>
      {b.confirmedAt ? (
        <>
          <div className="kpis">
            <div className="kpi"><b>{fmtMoney(b.payment.total)}</b>total due</div>
            <div className="kpi"><b>{fmtMoney(b.payment.paid)}</b>paid</div>
            {Number(b.payment.refunded) > 0 && <div className="kpi"><b>{fmtMoney(b.payment.refunded)}</b>refunded</div>}
            <div className="kpi"><b>{fmtMoney(b.payment.balance)}</b>balance</div>
          </div>
          <div className="row" style={{ marginBottom: 8 }}>
            {<button disabled={!['CONFIRMED', 'TICKETED'].includes(b.status) || Number(b.payment.balance) <= 0} onClick={() => openPay('PAYMENT')}>Record payment received</button>}
            {(user?.role === 'FINANCE_STAFF' || user?.role === 'SUPER_ADMIN') && <button className="secondary" disabled={Number(b.payment.net) <= 0} onClick={() => openPay('REFUND')}>Record refund given</button>}
          </div>
          <table>
            <thead><tr><th>Receipt</th><th>Date</th><th>Type</th><th>Method</th><th>Reference</th><th>Amount</th><th>By</th><th></th></tr></thead>
            <tbody>
              {b.payments.map((p) => (
                <tr key={p.id} style={p.status === 'VOIDED' ? { opacity: 0.55, textDecoration: 'line-through' } : undefined}>
                  <td><Link href={`/admin/receipts/${p.id}`}>{p.receiptNumber}</Link></td><td>{fmtDateTime(p.receivedAt)}</td><td>{p.type === 'REFUND' ? 'Refund' : 'Payment'}{p.status === 'VOIDED' ? ' (void)' : ''}</td>
                  <td>{p.method.replace('_', ' ')}</td><td>{p.reference ?? 'null'}</td><td>{fmtMoney(p.amount)}</td><td>{p.recordedBy}</td>
                  <td>{p.status === 'RECORDED' && (user?.role === 'FINANCE_STAFF' || user?.role === 'SUPER_ADMIN') && <button className="secondary" onClick={() => setVoidDlg(p.id)}>Void</button>}</td>
                </tr>
              ))}
              {b.payments.length === 0 && <tr><td colSpan={8} className="muted">No payment recorded yet.</td></tr>}
            </tbody>
          </table>
          <p className="muted sm">Only record money you have actually received. The customer is emailed a receipt. Mistakes are voided (never deleted) so the history stays complete.</p>
        </>
      ) : <p className="muted sm">Payments can be recorded once the inquiry is confirmed and becomes a booking.</p>}

      <h2>Customer requests</h2>
      <table>
        <thead><tr><th>Received</th><th>Request</th><th>Message</th><th>Status</th></tr></thead>
        <tbody>
          {(b.requests ?? []).map((r) => (
            <tr key={r.id}><td>{fmtDateTime(r.createdAt)}</td><td>{r.type === 'CANCEL_REFUND' ? 'Cancel / refund' : 'Date change'}{r.preferredDate ? ` (wants ${r.preferredDate})` : ''}</td><td>{r.message}</td><td><RequestActions r={{ ...r, booking: { id: b.id, reference: b.reference, status: b.status, contactName: b.contactName, rescheduledCount: b.rescheduledCount } }} onChanged={load} /></td></tr>
          ))}
          {(b.requests ?? []).length === 0 && <tr><td colSpan={4} className="muted">None.</td></tr>}
        </tbody>
      </table>

      <h2>Emails to customer</h2>
      <table>
        <thead><tr><th>When</th><th>Email</th><th>Delivery</th></tr></thead>
        <tbody>
          {(b.notifications ?? []).map((n) => <tr key={n.id}><td>{fmtDateTime(n.createdAt)}</td><td>{n.subject}</td><td>{n.status === 'NOT_CONFIGURED' ? 'NOT SENT (email server not set up)' : n.status}{n.status === 'FAILED' && n.error ? <div className="muted sm">{n.error}</div> : null}</td></tr>)}
          {(b.notifications ?? []).length === 0 && <tr><td colSpan={3} className="muted">None yet.</td></tr>}
        </tbody>
      </table>

      <ConfirmDialog open={!!payDlg} title={payDlg === 'REFUND' ? 'Record a refund given to the customer' : 'Record a payment received'} confirmLabel={busy ? 'Saving…' : 'Save'}
        body={payDlg === 'REFUND' ? 'Only record this after the money has actually been returned.' : 'Only record this after you have actually received the money.'} onCancel={() => setPayDlg(null)} onConfirm={submitPay}>
        <label>Amount (NPR)</label><input inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
        <label>Method</label>
        <select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
          {['CASH', 'BANK_TRANSFER', 'ESEWA', 'KHALTI', 'CARD_POS', 'OTHER'].map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
        </select>
        <label>Transaction / reference no. (needed for bank, eSewa, Khalti)</label><input maxLength={60} value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
        <label>Note (optional)</label><input maxLength={300} value={pay.note} onChange={(e) => setPay({ ...pay, note: e.target.value })} />
        {payErr && <p className="error" role="alert">{payErr}</p>}
      </ConfirmDialog>
      <ChangeDateDialog target={dateDlg ? { id: b.id, reference: b.reference, tripType: b.tripType, requestedDate: b.requestedDate, requestedReturnDate: b.requestedReturnDate } : null} onClose={() => setDateDlg(false)} onSaved={load} />
      <ConfirmDialog open={!!passDlg} title={passDlg ? `Passport: ${passDlg.name}` : ''} confirmLabel={busy ? 'Saving…' : 'Save passport'}
        body="Type the details exactly as printed on the passport. They are stored encrypted." onCancel={() => setPassDlg(null)} onConfirm={savePassport}>
        {passDlg && <div className="stack"><PassportFields required value={passDlg.v} onChange={(v) => setPassDlg({ ...passDlg, v })} /></div>}
        {passErr && <p className="error" role="alert">{passErr}</p>}
      </ConfirmDialog>
      <ConfirmDialog open={!!voidDlg} danger title="Void this entry?" body="It stays on record but no longer counts. Use this only for a mistake." confirmLabel="Void entry" onCancel={() => setVoidDlg(null)} onConfirm={doVoid}>
        <label>Reason (required, audited)</label><input value={voidReason} maxLength={300} onChange={(e) => setVoidReason(e.target.value)} />
      </ConfirmDialog>

      <ConfirmDialog open={!!action} title={action ? COPY[action].title : ''} body={action ? COPY[action].body : ''} confirmLabel={busy ? 'Working…' : action ? COPY[action].label : ''}
        danger={action ? COPY[action].danger : false} onCancel={() => setAction(null)} onConfirm={run}>
        {action === 'ticket' && b && (
          <>
            <label>PNR (airline reservation code)</label><input value={pnr} maxLength={8} onChange={(e) => setPnr(e.target.value.toUpperCase())} />
            {b.passengers.map((p) => (
              <div key={p.id}><label>Ticket number: {p.firstName} {p.lastName}</label><input value={tickets[p.id] ?? ''} maxLength={20} onChange={(e) => setTickets({ ...tickets, [p.id]: e.target.value })} /></div>
            ))}
            <div>
              <label>Airline ticket PDF (optional, up to 5 MB each)</label>
              <input type="file" accept="application/pdf,.pdf" multiple onChange={(e) => setTicketPdfs(Array.from(e.target.files ?? []))} />
              {ticketPdfs.length > 0 && <p className="muted sm" style={{ margin: '4px 0 0' }}>{ticketPdfs.map((f) => f.name).join(', ')}</p>}
            </div>
          </>
        )}
        {action === 'reschedule' && b && (
          <>
            {b.segments.map((s) => (
              <div key={s.id}>
                <label>{dirLabel(s.direction)} flight (now {s.flight.flightNumber}, {fmtDateTime(s.flight.departureAt)})</label>
                <select value={picked[s.direction] ?? ''} onChange={(e) => setPicked({ ...picked, [s.direction]: e.target.value })}>
                  <option value="">Keep current flight (you can adjust its time below)</option>
                  {(choices[s.direction] ?? []).map((c) => <option key={c.id} value={c.id} disabled={c.seats < s.seats}>{fmtDateTime(c.departureAt)} · {c.flightNumber} · {c.seats} seats free{c.gapDays === 0 ? ' · wanted day' : c.gapDays ? ` · ${c.gapDays} day${c.gapDays === 1 ? '' : 's'} from wanted` : ''}</option>)}
                  {choices[s.direction] && choices[s.direction].length === 0 && <option disabled>No other scheduled flights found nearby: add one under Flights</option>}
                </select>
                {!picked[s.direction] && (
                  <div style={{ marginTop: 6 }}>
                    <label>Or keep this flight but change the date and time for this ticket (for example, the flight is running late)</label>
                    <input type="datetime-local" value={retime[s.direction] ?? ''} onChange={(e) => setRetime({ ...retime, [s.direction]: e.target.value })} />
                  </div>
                )}
              </div>
            ))}
            <label>Note (saved in the reschedule history)</label><input value={rnote} maxLength={500} onChange={(e) => setRnote(e.target.value)} />
            <p className="muted sm">Any fare difference is settled with the customer by staff.</p>
          </>
        )}
        {action === 'hold' && <><label>Hold duration (minutes)</label><NumInput min={5} max={1440} value={minutes} onChange={setMinutes} /></>}
        {action && COPY[action].reason && <><label>Reason (required, recorded in audit log)</label><input value={reason} minLength={3} maxLength={500} onChange={(e) => setReason(e.target.value)} /></>}
      </ConfirmDialog>
    </>
  );
}
