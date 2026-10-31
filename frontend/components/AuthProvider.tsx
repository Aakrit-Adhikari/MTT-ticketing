'use client';
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { SessionUser, login as apiLogin, logout as apiLogout, refreshSession } from '@/lib/api';

interface AuthCtx { user: SessionUser | null; ready: boolean; signIn: (e: string, p: string) => Promise<void>; signOut: () => Promise<void> }
const Ctx = createContext<AuthCtx | null>(null);

export const useAuth = (): AuthCtx => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
};

export default function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);

  // On load, trade the HttpOnly refresh cookie for an in-memory access token (if a session exists).
  useEffect(() => {
    refreshSession().then((s) => { setUser(s?.user ?? null); setReady(true); });
  }, []);

  const signIn = useCallback(async (email: string, password: string) => { setUser((await apiLogin(email, password)).user); }, []);
  const signOut = useCallback(async () => { await apiLogout().catch(() => undefined); setUser(null); }, []);

  return <Ctx.Provider value={{ user, ready, signIn, signOut }}>{children}</Ctx.Provider>;
}
