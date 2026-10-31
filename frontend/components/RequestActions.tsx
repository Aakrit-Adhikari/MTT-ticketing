'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ui';
import { adminApi } from '@/lib/api';

export interface Req {
  id: string; type: 'CANCEL_REFUND' | 'RESCHEDULE'; status: 'OPEN' | 'DONE' | 'REJECTED'; message: string; preferredDate: string | null;
  staffNote: string | null; refundAmount: string | null; createdAt: string; resolvedAt: string | null;
  booking: { id: string; reference: string; status: string; contactName: string; rescheduledCount: number };
}

export function RequestActions({ r, onChanged }: { r: Req; onChanged: () => void }) {
  const [open, setOpen] = useState<null | 'DONE' | 'REJECTED'>(null);
  const [note, setNote] = useState('');
  const [refund, setRefund] = useState('');
  const [err, setErr] = useState('');

  async function go() {
    if (!open) return;
    try {
      await adminApi(`/admin/requests/${r.id}/resolve`, 'POST', { status: open, ...(note ? { note } : {}), ...(refund && r.type === 'CANCEL_REFUND' ? { refundAmount: refund } : {}) });
      setOpen(null); setNote(''); setRefund(''); setErr(''); onChanged();
    } catch (e) { setErr((e as Error).message); }
  }

  if (r.status !== 'OPEN') return <span className="muted sm">{r.status === 'DONE' ? 'Done' : 'Rejected'}{r.refundAmount ? ` · refund NPR ${r.refundAmount}` : ''}{r.staffNote ? ` · "${r.staffNote}"` : ''}</span>;
  return (
    <>
      <div className="row">
        {r.type === 'RESCHEDULE' && r.booking.status !== 'CANCELLED' && <Link className="btn" href={`/admin/bookings/${r.booking.id}?reschedule=1`}>Change date</Link>}
        <button className={r.type === 'RESCHEDULE' ? 'secondary' : ''} onClick={() => setOpen('DONE')}>Mark done</button>
        <button className="secondary" onClick={() => setOpen('REJECTED')}>Reject</button>
      </div>
      <ConfirmDialog open={!!open} danger={open === 'REJECTED'} title={open === 'DONE' ? 'Mark request as done?' : 'Reject this request?'}
        body={open === 'DONE' ? (r.type === 'CANCEL_REFUND' ? 'Cancel the booking first (on the booking page). Then record the refund you decided, if any.' : 'Reschedule the booking first (on the booking page).') : 'The customer is emailed.'}
        confirmLabel={open === 'DONE' ? 'Mark done' : 'Reject'} onCancel={() => { setOpen(null); setErr(''); }} onConfirm={go}>
        {open === 'DONE' && r.type === 'CANCEL_REFUND' && <><label>Refund amount decided (NPR, optional)</label><input inputMode="decimal" pattern="\d{1,10}(\.\d{1,2})?" value={refund} onChange={(e) => setRefund(e.target.value)} /></>}
        <label>Message to customer (emailed, optional)</label><textarea rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        {err && <p className="error" role="alert">{err}</p>}
      </ConfirmDialog>
    </>
  );
}

