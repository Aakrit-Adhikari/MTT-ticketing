'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { InfoDialog } from '@/components/InfoDialog';
import { StatusBadge } from '@/components/ui';
import { adminApi } from '@/lib/api';
import { fmtTime } from '@/lib/format';

interface DayBooking { bookingId: string; reference: string; name: string; phone: string; status: string; pnr: string | null; passengers: number; rescheduled: boolean; delayed: boolean; direction: string }
interface DayFlight { flightId: string; flightNumber: string; airline: string; route: string; departureAt: string; passengers: number; bookings: DayBooking[] }
interface Day { date: string; customers: number; passengers: number; ticketed: number; confirmed: number; rescheduled: number; flights: DayFlight[] }

const pad = (n: number) => String(n).padStart(2, '0');
const nepalToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(new Date());
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Month calendar of customer flights (confirmed bookings and issued tickets). A rescheduled customer shows on the day of
 * the NEW flight. Click a day for the flights, who is on them, and a link (opens in a new tab) to each booking.
 */
export default function Calendar() {
  const today = nepalToday();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [days, setDays] = useState<Record<string, Day>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    adminApi<{ days: Day[] }>(`/admin/calendar?month=${month}`).then((d) => { setDays(Object.fromEntries(d.days.map((x) => [x.date, x]))); setErr(''); }).catch((e) => setErr(e.message));
  }, [month]);
  useEffect(load, [load]);

  const [y, m] = month.split('-').map(Number);
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => `${month}-${pad(i + 1)}`)];
  while (cells.length % 7) cells.push(null);
  const shift = (by: number) => { const d = new Date(Date.UTC(y, m - 1 + by, 1)); setMonth(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`); setOpen(null); };
  const title = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  const totals = Object.values(days).reduce((a, d) => ({ c: a.c + d.customers, p: a.p + d.passengers }), { c: 0, p: 0 });
  const sel = open ? days[open] : undefined;

  return (
    <section className="calendar" aria-label="Flight calendar">
      <div className="cal-head">
        <h2 style={{ margin: 0, border: 0, padding: 0 }}>Flight calendar</h2>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => shift(-1)} aria-label="Previous month">‹ Prev</button>
          <b className="cal-title">{title}</b>
          <button type="button" className="secondary" onClick={() => shift(1)} aria-label="Next month">Next ›</button>
          <button type="button" className="secondary" onClick={() => setMonth(today.slice(0, 7))}>Today</button>
        </div>
      </div>
      <p className="muted sm" style={{ margin: '4px 0 8px' }}>
        Customers with a confirmed booking or an issued ticket, on the day they fly. {totals.c} customer{totals.c === 1 ? '' : 's'} · {totals.p} passenger{totals.p === 1 ? '' : 's'} this month. Click a day for details.
      </p>
      {err && <p className="error">{err}</p>}
      <div className="cal-grid" role="grid">
        {WEEK.map((w) => <div key={w} className="cal-dow" role="columnheader">{w}</div>)}
        {cells.map((date, i) => {
          if (!date) return <div key={i} className="cal-cell empty" />;
          const d = days[date];
          return (
            <button key={date} type="button" className={`cal-cell${date === today ? ' today' : ''}${d ? ' has' : ''}`} onClick={() => d && setOpen(date)} disabled={!d} aria-label={`${date}${d ? `: ${d.customers} customers` : ''}`}>
              <span className="cal-num">{Number(date.slice(8))}</span>
              {d && (
                <span className="cal-info">
                  <b>{d.customers} customer{d.customers === 1 ? '' : 's'}</b>
                  <span>{d.passengers} pax</span>
                  <span className="cal-dots">
                    {d.ticketed > 0 && <i className="dot tk" title={`${d.ticketed} ticketed`}>{d.ticketed} T</i>}
                    {d.confirmed > 0 && <i className="dot cf" title={`${d.confirmed} confirmed, no ticket yet`}>{d.confirmed} C</i>}
                    {d.rescheduled > 0 && <i className="dot rs" title={`${d.rescheduled} rescheduled`}>{d.rescheduled} R</i>}
                  </span>
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="cal-legend muted sm"><i className="dot tk">T</i> ticketed · <i className="dot cf">C</i> confirmed, ticket not issued yet · <i className="dot rs">R</i> rescheduled</p>

      <InfoDialog wide open={!!sel} onClose={() => setOpen(null)} title={open ? new Date(`${open}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : ''}>
        {sel && (
          <>
            <p style={{ margin: '8px 0 12px' }}><b>{sel.customers} customer{sel.customers === 1 ? '' : 's'}</b> · {sel.passengers} passenger{sel.passengers === 1 ? '' : 's'} · {sel.ticketed} ticketed · {sel.confirmed} confirmed{sel.rescheduled ? ` · ${sel.rescheduled} rescheduled` : ''}</p>
            {sel.flights.map((f) => (
              <div key={f.flightId} className="cal-flight">
                <div className="cal-flight-head"><b>{f.flightNumber}</b> · {f.airline} · {f.route} · departs {fmtTime(f.departureAt)} <span className="muted">({f.passengers} passenger{f.passengers === 1 ? '' : 's'})</span></div>
                <table className="compact">
                  <thead><tr><th>Reference</th><th>Customer</th><th>Phone</th><th>Status</th><th>PNR</th><th>Pax</th><th className="col-actions">Open</th></tr></thead>
                  <tbody>
                    {f.bookings.map((b) => (
                      <tr key={b.bookingId + b.direction}>
                        <td>{b.reference}</td>
                        <td>{b.name}{b.rescheduled && <> <span className="badge s-HELD" title="Moved to this flight from another, or its time was adjusted">RESCH.</span></>}{b.delayed && <> <span className="badge s-HELD" title="This ticket's time differs from the flight's scheduled time">TIME ADJ.</span></>}</td>
                        <td>{b.phone}</td>
                        <td><StatusBadge status={b.status} /></td>
                        <td>{b.pnr ?? '-'}</td>
                        <td>{b.passengers}</td>
                        <td className="col-actions"><Link className="btn" href={`/admin/bookings/${b.bookingId}`} target="_blank" rel="noopener">Open booking ↗</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </>
        )}
      </InfoDialog>
    </section>
  );
}
