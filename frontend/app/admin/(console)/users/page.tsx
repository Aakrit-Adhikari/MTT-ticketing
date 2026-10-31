'use client';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ConfirmDialog, Field } from '@/components/ui';
import { adminApi } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

interface U { id: string; email: string; name: string; role: string; isActive: boolean; createdAt: string }
const ROLES = ['BOOKING_STAFF', 'FINANCE_STAFF', 'SUPER_ADMIN'];

export default function Users() {
  const [users, setUsers] = useState<U[]>([]);
  const [f, setF] = useState({ email: '', name: '', password: '', role: 'BOOKING_STAFF' });
  const [err, setErr] = useState('');
  const [target, setTarget] = useState<U | null>(null);

  const load = useCallback(() => { adminApi<U[]>('/admin/users').then(setUsers).catch((e) => setErr(e.message)); }, []);
  useEffect(load, [load]);

  async function create(e: FormEvent) {
    e.preventDefault(); setErr('');
    try { await adminApi('/admin/users', 'POST', f); setF({ email: '', name: '', password: '', role: 'BOOKING_STAFF' }); load(); } catch (x) { setErr((x as Error).message); }
  }
  async function toggle() {
    if (!target) return;
    try { await adminApi(`/admin/users/${target.id}`, 'PATCH', { isActive: !target.isActive }); } catch (x) { setErr((x as Error).message); }
    setTarget(null); load();
  }

  return (
    <>
      <h1>Users</h1>
      {err && <p className="error" role="alert">{err}</p>}
      <form className="panel grid" onSubmit={create}>
        <Field label="Email"><input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Name"><input required maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Temporary password (min 12)"><input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <Field label="Role"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></Field>
        <button>Create user</button>
      </form>
      <table>
        <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Active</th><th>Created</th><th></th></tr></thead>
        <tbody>{users.map((u) => (
          <tr key={u.id}><td>{u.email}</td><td>{u.name}</td><td>{u.role}</td><td>{u.isActive ? 'Yes' : 'No'}</td><td>{fmtDateTime(u.createdAt)}</td>
            <td><button className="secondary" onClick={() => setTarget(u)}>{u.isActive ? 'Disable' : 'Enable'}</button></td></tr>
        ))}</tbody>
      </table>
      <ConfirmDialog open={!!target} danger={!!target?.isActive} title={target?.isActive ? 'Disable this user?' : 'Re-enable this user?'}
        body={target?.isActive ? `${target.email} will be signed out everywhere immediately.` : ''} confirmLabel={target?.isActive ? 'Disable' : 'Enable'} onCancel={() => setTarget(null)} onConfirm={toggle} />
    </>
  );
}
