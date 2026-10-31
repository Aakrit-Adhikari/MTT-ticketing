'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Req, RequestActions } from '@/components/RequestActions';
import { adminApi } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';


export default function Requests() {
  const [status, setStatus] = useState<'OPEN' | 'DONE' | 'REJECTED'>('OPEN');
  const [items, setItems] = useState<Req[]>([]);
  const [err, setErr] = useState('');
  const load = useCallback(() => { adminApi<Req[]>(`/admin/requests?status=${status}`).then((d) => { setItems(d); setErr(''); }).catch((e) => setErr(e.message)); }, [status]);
  useEffect(load, [load]);

  return (
    <>
      <h1>Customer requests</h1>
      <div className="row" style={{ marginBottom: 8 }}>
        <label style={{ margin: 0 }}>Show</label>
        <select style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="OPEN">Open</option><option value="DONE">Done</option><option value="REJECTED">Rejected</option>
        </select>
      </div>
      {err && <p className="error">{err}</p>}
      <div className="table-scroll">
        <table>
          <thead><tr><th>Received</th><th>Booking</th><th>Request</th><th>Customer message</th><th>Action</th></tr></thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td>{fmtDateTime(r.createdAt)}</td>
                <td><Link href={`/admin/bookings/${r.booking.id}`}>{r.booking.reference}</Link><div className="muted sm">{r.booking.contactName} · {r.booking.status}</div></td>
                <td>{r.type === 'CANCEL_REFUND' ? 'Cancel / refund' : 'Date change'}{r.preferredDate ? <div className="muted sm">wants {r.preferredDate}</div> : null}</td>
                <td style={{ maxWidth: 320 }}>{r.message}</td>
                <td><RequestActions r={r} onChanged={load} /></td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={5} className="muted">Nothing here.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted sm">Workflow: open the booking, cancel it (or reschedule it), then come back and mark the request done.</p>
    </>
  );
}
