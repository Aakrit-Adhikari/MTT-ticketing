'use client';
import { ReactNode, useEffect, useRef, useState } from 'react';

// Short labels keep the status column narrow; the full word is in the tooltip.
const SHORT: Record<string, string> = { INQUIRY: 'NEW', HELD: 'HOLD', REJECTED: 'REJECT', CANCELLED: 'CANCEL', CONFIRMED: 'CONFIRMED' };
export const StatusBadge = ({ status }: { status: string }) => <span className={`badge s-${status}`} title={status}>{SHORT[status] ?? status}</span>;

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label>{label}</label>
      {children}
    </div>
  );
}

export function Pagination({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="row sm" style={{ marginTop: 8 }}>
      <button className="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Prev</button>
      <span>Page {page} of {pages} · {total} records</span>
      <button className="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </div>
  );
}

/** Native <dialog> confirmation: focus trap and Esc handling come from the platform. */
export function ConfirmDialog({ open, title, body, confirmLabel, danger, onConfirm, onCancel, children }: {
  open: boolean; title: string; body?: string; confirmLabel: string; danger?: boolean;
  onConfirm: () => void; onCancel: () => void; children?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onCancel={(e) => { e.preventDefault(); onCancel(); }}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      {body && <p>{body}</p>}
      {children}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="secondary" onClick={onCancel}>Cancel</button>
        <button className={danger ? 'danger' : ''} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </dialog>
  );
}

/**
 * "Delete" with a confirmation. `what` names the thing ("inquiry RAB123"). The server refuses when something still depends
 * on it, and that message is shown here instead of silently failing.
 */
export function DeleteButton({ what, extra, onDelete, label = 'Delete' }: { what: string; extra?: string; onDelete: () => Promise<void>; label?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go() {
    setBusy(true); setErr('');
    try { await onDelete(); setOpen(false); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <>
      <button type="button" className="secondary danger-text" onClick={() => { setErr(''); setOpen(true); }}>{label}</button>
      <ConfirmDialog open={open} danger title={`Delete ${what}?`} confirmLabel={busy ? 'Deleting…' : 'Delete permanently'}
        body={`This cannot be undone.${extra ? ' ' + extra : ''}`} onCancel={() => setOpen(false)} onConfirm={go}>
        {err && <p className="error" role="alert">{err}</p>}
      </ConfirmDialog>
    </>
  );
}

/**
 * Number box that can be emptied while typing (a plain controlled <input type="number" value={n}> snaps back to 0 on backspace).
 * The parent always receives a valid number (empty counts as `min`); the text is tidied up when the box loses focus.
 */
export function NumInput({ value, onChange, min = 0, max, allowNegative = false, required }: {
  value: number; onChange: (n: number) => void; min?: number; max?: number; allowNegative?: boolean; required?: boolean;
}) {
  const [text, setText] = useState(String(value));
  const emitted = useRef(value);
  useEffect(() => { if (value !== emitted.current) { emitted.current = value; setText(String(value)); } }, [value]);

  const emit = (n: number) => { emitted.current = n; onChange(n); };
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(allowNegative ? -Infinity : min, n));

  return (
    <input
      inputMode="numeric" required={required} value={text}
      onChange={(e) => {
        const t = e.target.value.replace(allowNegative ? /[^\d-]/g : /[^\d]/g, '');
        setText(t);
        if (t === '' || t === '-') emit(allowNegative ? 0 : min);
        else emit(clamp(Number(t)));
      }}
      onBlur={() => { const n = text === '' || text === '-' ? (allowNegative ? 0 : min) : clamp(Number(text)); setText(String(n)); emit(n); }}
    />
  );
}
