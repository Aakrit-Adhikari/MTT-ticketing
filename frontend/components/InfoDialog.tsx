'use client';
import { ReactNode, useEffect, useRef } from 'react';

/** Read-only pop-up with a Close button (native dialog: focus trap and Esc come from the browser). */
export function InfoDialog({ open, title, onClose, children, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={wide ? 'wide' : undefined} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="dlg-head">
        <h2 style={{ margin: 0, border: 0, padding: 0 }}>{title}</h2>
        <button type="button" className="secondary" onClick={onClose}>Close</button>
      </div>
      {children}
    </dialog>
  );
}
