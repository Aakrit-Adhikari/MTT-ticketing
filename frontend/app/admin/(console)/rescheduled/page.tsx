'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Field, Pagination, StatusBadge } from '@/components/ui';
import { adminApi } from '@/lib/api';
import { dirLabel, fmtDateTime } from '@/lib/format';

interface Row {
  id: string; bookingId: string; reference: string; name: string; phone: string; status: string; direction: string;
  fromFlightNumber: string; fromDepartureAt: string; toFlightNumber: string; toDepartureAt: string; note: string | null; doneBy: string | null; rescheduledAt: string;
}
interface Page { items: Row[]; total: number; page: number; pageSize: number }

/** Every reschedule, newest first: from which flight (date and time) to which, when it was done, and the note. */
export default function Rescheduled() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams({ page: String(page), ...(q.trim() ? { q: q.trim() } : {}) });
    adminApi<Page>(`/admin/reschedules?${p}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message));
  }, [page, q]);
  useEffect(load, [load]);

  return (
    <>
      <h1>Rescheduled bookings</h1>
      <p className="muted sm">Each row is one flight that was moved: the original flight, the new flight (both with date and time), when it was done and why. To reschedule someone, open their booking and press “Change date / reschedule”.</p>
      <div className="panel grid">
        <Field label="Search"><input placeholder="Name, phone, email or reference" value={q} maxLength={60} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></Field>
      </div>
      {err && <p className="error">{err}</p>}
      <div className="table-scroll">
        <table className="compact">
          <thead><tr><th>Customer</th><th>Leg</th><th>Was (original flight)</th><th>Now (actual flight)</th><th>Rescheduled on</th><th>By</th><th>Note</th><th className="col-actions">Actions</th></tr></thead>
          <tbody>
            {data?.items.map((r) => (
              <tr key={r.id}>
                <td><b>{r.name}</b><div className="muted">{r.reference} · {r.phone}</div><StatusBadge status={r.status} /></td>
                <td className="narrow">{dirLabel(r.direction)}</td>
                <td><b>{r.fromFlightNumber}</b><div>{fmtDateTime(r.fromDepartureAt)}</div></td>
                <td><b>{r.toFlightNumber}</b><div>{fmtDateTime(r.toDepartureAt)}</div></td>
                <td className="narrow">{fmtDateTime(r.rescheduledAt)}</td>
                <td className="narrow">{r.doneBy ?? 'null'}</td>
                <td>{r.note ?? 'null'}</td>
                <td className="col-actions"><Link className="btn" href={`/admin/bookings/${r.bookingId}`}>Open</Link></td>
              </tr>
            ))}
            {data?.items.length === 0 && <tr><td colSpan={8} className="muted">Nothing has been rescheduled yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {data && <Pagination page={data.page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </>
  );
}
