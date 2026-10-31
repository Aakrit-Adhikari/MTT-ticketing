'use client';
import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import Logo from '@/components/Logo';
import { Field } from '@/components/ui';

export default function LoginPage() {
  const { user, ready, signIn } = useAuth();
  const router = useRouter();
  const [f, setF] = useState({ email: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (ready && user) router.replace('/admin'); }, [ready, user, router]);

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await signIn(f.email, f.password); router.replace('/admin'); }
    catch { setErr('Invalid email or password.'); } // generic by design
    finally { setBusy(false); }
  }

  return (
    <div className="wrap" style={{ maxWidth: 380, paddingTop: 80 }}>
      <form className="panel" onSubmit={submit}>
        <Logo on="auto" className="login-logo" />
        <h1>Staff sign in</h1>
        <Field label="Email"><input type="email" autoComplete="username" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <div style={{ height: 10 }} />
        <Field label="Password"><input type="password" autoComplete="current-password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        {err && <p className="error" role="alert">{err}</p>}
        <p><button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></p>
      </form>
    </div>
  );
}
