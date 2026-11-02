'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { adminApi } from '@/lib/api';
import Logo from '@/components/Logo';

// Navigation visibility is a convenience only; every endpoint enforces roles on the server.
const NAV: { group: string; items: { href: string; label: string; superOnly?: boolean }[] }[] = [
  { group: 'Operations', items: [
    { href: '/admin', label: 'Dashboard' },
    { href: '/admin/inquiries', label: 'Inquiries' },
    { href: '/admin/bookings', label: 'Bookings' },
    { href: '/admin/seats', label: 'Seats' },
  ] },
  { group: 'Customers', items: [
    { href: '/admin/customers', label: 'Customers' },
    { href: '/admin/ticketed', label: 'Ticketed customers' },
    { href: '/admin/rescheduled', label: 'Rescheduled' },
    { href: '/admin/requests', label: 'Customer requests' },
  ] },
  { group: 'Analysis', items: [
    { href: '/admin/reports', label: 'Reports' },
  ] },
  { group: 'Setup', items: [
    { href: '/admin/flights', label: 'Flights & inventory' },
    { href: '/admin/masters', label: 'Airlines & airports' },
    { href: '/admin/users', label: 'Users', superOnly: true },
  ] },
];

type BadgeKey = 'inquiries' | 'requests';
const BADGE_OF: Record<string, BadgeKey> = { '/admin/inquiries': 'inquiries', '/admin/requests': 'requests' };
const seenKey = (uid: string, k: BadgeKey) => `mtt-seen-${uid}-${k}`;
/** When this staff member last opened the page (this browser). First time ever = now, so old backlog does not light up. */
const readSeen = (uid: string, k: BadgeKey): string => {
  try { const v = localStorage.getItem(seenKey(uid, k)); if (v) return v; const now = new Date().toISOString(); localStorage.setItem(seenKey(uid, k), now); return now; } catch { return new Date().toISOString(); }
};

export default function Console({ children }: { children: React.ReactNode }) {
  const { user, ready, signOut } = useAuth();
  const path = usePathname();
  const router = useRouter();
  const [menu, setMenu] = useState(false); // phone menu
  const [badges, setBadges] = useState<Record<BadgeKey, number>>({ inquiries: 0, requests: 0 });

  useEffect(() => { if (ready && !user) router.replace('/admin/login'); }, [ready, user, router]);
  useEffect(() => setMenu(false), [path]);

  // Red dots: opening a page marks it as seen; new arrivals after that light it up again. Checked every 30 seconds.
  useEffect(() => {
    if (!user || user.role === 'FINANCE_STAFF') return;
    const key = Object.entries(BADGE_OF).find(([href]) => path === href || path.startsWith(href + '/'))?.[1];
    if (key) { try { localStorage.setItem(seenKey(user.id, key), new Date().toISOString()); } catch { /* ignore */ } setBadges((b) => ({ ...b, [key]: 0 })); }
    let stop = false;
    const poll = () => {
      const p = new URLSearchParams({ inquiriesSince: readSeen(user.id, 'inquiries'), requestsSince: readSeen(user.id, 'requests') });
      adminApi<Record<BadgeKey, number>>(`/admin/badges?${p}`).then((b) => { if (!stop) setBadges(b); }).catch(() => undefined);
    };
    poll();
    const t = setInterval(poll, 30_000);
    return () => { stop = true; clearInterval(t); };
  }, [user, path]);
  if (!ready || !user) return <p style={{ padding: 20 }}>Loading…</p>;

  const isActive = (href: string) => (href === '/admin' ? path === href : path === href || path.startsWith(href + '/'));
  const current = NAV.flatMap((g) => g.items).find((i) => isActive(i.href));

  return (
    <div className="admin">
      <div className={`nav-backdrop${menu ? ' open' : ''}`} onClick={() => setMenu(false)} />
      <nav aria-label="Back office" className={menu ? 'open' : undefined}>
        <div className="nav-brand"><Logo on="dark" /></div>
        {NAV.map((g) => {
          const items = g.items.filter((n) => !n.superOnly || user.role === 'SUPER_ADMIN');
          if (items.length === 0) return null;
          return (
            <div key={g.group} className="nav-group">
              <div className="nav-title">{g.group}</div>
              {items.map((n) => (
                <Link key={n.href} href={n.href} aria-current={isActive(n.href) ? 'page' : undefined}>
                  {n.label}
                  {BADGE_OF[n.href] && badges[BADGE_OF[n.href]] > 0 && !isActive(n.href) && <span className="nav-badge" aria-label={`${badges[BADGE_OF[n.href]]} new`}>{badges[BADGE_OF[n.href]] > 99 ? '99+' : badges[BADGE_OF[n.href]]}</span>}
                </Link>
              ))}
            </div>
          );
        })}
      </nav>
      <div className="admin-body">
        <header className="topbar">
          <button type="button" className="menu-btn secondary" aria-label="Open menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>☰</button>
          <span className="crumb">{current?.label ?? 'Back office'}</span>
          <span className="spacer" />
          <span className="user"><b>{user.name}</b> · {user.role.replace('_', ' ').toLowerCase()}</span>
          <button className="secondary" onClick={async () => { await signOut(); router.replace('/admin/login'); }}>Sign out</button>
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}
