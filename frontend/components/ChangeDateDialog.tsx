'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/ui';
import { adminApi } from '@/lib/api';
import { fmtDateOnly } from '@/lib/format';

export interface DateTarget { id: string; reference: string; tripType: string; requestedDate: string | null; requestedReturnDate: string | null }

/**
 * Pop-up to change the day the customer wants to fly. Saves straight to the booking, so every list and page shows the new
 * date. It does not move the booking to another flight: that is the separate "Move to another flight" step.
 */
export function ChangeDateDialog({ target, onClose, onSaved }: { target: DateTarget | null; onClose: () => void; onSaved: () => void }) {
  const [out, setOut] = useState('');
  const [ret, setRet] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setOut(target?.requestedDate?.slice(0, 10) ?? ''); setRet(target?.requestedReturnDate?.slice(0, 10) ?? ''); setErr('');
  }, [target]);

  async function save() {
    if (!target) return;
    setBusy(true); setErr('');
    try {
      await adminApi(`/admin/bookings/${target.id}/dates`, 'PATCH', { requestedDate: out, ...(target.tripType === 'ROUND_TRIP' ? { requestedReturnDate: ret } : {}) });
      onSaved(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <ConfirmDialog open={!!target} title={target ? `Change travel date · ${target.reference}` : ''} confirmLabel={busy ? 'Saving…' : 'Save date'}
      body={target ? `Currently wanted: ${fmtDateOnly(target.requestedDate)}${target.tripType === 'ROUND_TRIP' ? ` → return ${fmtDateOnly(target.requestedReturnDate)}` : ''}. Saving updates it everywhere.` : ''}
      onCancel={onClose} onConfirm={save}>
      <div className="stack">
        <div><label>Date the customer wants to fly</label><input type="date" value={out} onChange={(e) => setOut(e.target.value)} /></div>
        {target?.tripType === 'ROUND_TRIP' && <div><label>Return date</label><input type="date" min={out} value={ret} onChange={(e) => setRet(e.target.value)} /></div>}
        {err && <p className="error" role="alert">{err}</p>}
        {target && <p className="muted sm" style={{ margin: 0 }}>This records the day the customer asked for. To put them on a different flight, use <Link href={`/admin/bookings/${target.id}?reschedule=1`}>Move to another flight</Link>.</p>}
      </div>
    </ConfirmDialog>
  );
}
