'use client';
import { useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { Field } from '@/components/ui';
import { ApiError, adminApi, currentToken } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

type Kind = 'bookings' | 'payments' | 'inventory';
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Download needs the Authorization header, so we fetch then save the blob (a plain link cannot send the token). */
async function download(kind: Kind, q: string, token: () => Promise<string | null>) {
  const t = await token();
  const res = await fetch(`/api/admin/reports/${kind}?${q}&format=csv`, { headers: { Authorization: `Bearer ${t}` }, cache: 'no-store' });
  if (!res.ok) throw new ApiError(res.status, 'Download failed');
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `${kind}.csv`;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

export default function Reports() {
  const { user } = useAuth();
  const isFinance = user?.role === 'FINANCE_STAFF' || user?.role === 'SUPER_ADMIN';
  const [kind, setKind] = useState<Kind>('bookings');
  const [from, setFrom] = useState(iso(new Date(Date.now() - 29 * 86_400_000)));
  const [to, setTo] = useState(iso(new Date()));
  const [data, setData] = useState<{ total: number; truncated: boolean; rows: Record<string, unknown>[]; totals?: { received: string; refunded: string; net: string; byMethod: Record<string, string> } } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const q = new URLSearchParams({ from, to }).toString();

  async function run() {
    setErr(''); setBusy(true); setData(null);
    try { setData(await adminApi(`/admin/reports/${kind}?${q}&format=json`)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function csv() {
    setErr('');
    try {
      await download(kind, q, async () => { await adminApi('/auth/me'); return currentToken(); }); // /auth/me refreshes an expired token first
    } catch (e) { setErr((e as Error).message); }
  }

  const cols = data?.rows[0] ? Object.keys(data.rows[0]) : [];
  const cell = (k: string, v: unknown) => (/At$|date|departure/i.test(k) && typeof v === 'string' && v.includes('T') ? fmtDateTime(v) : String(v ?? ''));

  return (
    <>
      <h1>Reports</h1>
      <div className="panel grid">
        <Field label="Report">
          <select value={kind} onChange={(e) => { setKind(e.target.value as Kind); setData(null); }}>
            <option value="bookings">Bookings and inquiries</option>
            {isFinance && <option value="payments">Payments and refunds</option>}
            <option value="inventory">Flights and seat load</option>
          </select>
        </Field>
        <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <div className="row"><button onClick={run} disabled={busy}>{busy ? 'Loading…' : 'Show'}</button><button className="secondary" onClick={csv}>Download CSV</button></div>
      </div>
      <p className="muted sm">
        {kind === 'bookings' && 'Filtered by the date the inquiry or booking was received. Dates are Nepal calendar days.'}
        {kind === 'payments' && 'Filtered by the date money was received or refunded. Voided entries are listed but never counted in totals.'}
        {kind === 'inventory' && 'Filtered by flight departure date.'}
      </p>
      {err && <p className="error" role="alert">{err}</p>}
      {data?.totals && (
        <div className="kpis">
          <div className="kpi"><b>{data.totals.received}</b>received (NPR)</div>
          <div className="kpi"><b>{data.totals.refunded}</b>refunded (NPR)</div>
          <div className="kpi"><b>{data.totals.net}</b>net (NPR)</div>
          {Object.entries(data.totals.byMethod).filter(([, v]) => Number(v) !== 0).map(([m, v]) => <div className="kpi" key={m}><b>{v}</b>{m.replace('_', ' ').toLowerCase()}</div>)}
        </div>
      )}
      {data && (
        <>
          <p className="sm">{data.total} record(s){data.total > data.rows.length ? ` · showing the first ${data.rows.length}. Download the CSV for all of them.` : ''}{data.truncated ? ' · capped at 10,000 rows: narrow the dates.' : ''}</p>
          <div className="table-scroll">
            <table>
              <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{data.rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c}>{cell(c, r[c])}</td>)}</tr>)}{data.rows.length === 0 && <tr><td className="muted">Nothing in this range.</td></tr>}</tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
