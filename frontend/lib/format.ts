const TZ = 'Asia/Kathmandu';
export const fmtDateTime = (iso: string | null | undefined): string =>
  iso ? new Intl.DateTimeFormat('en-GB', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : 'null';
export const fmtTime = (iso: string): string => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, timeStyle: 'short' }).format(new Date(iso));
export const fmtMoney = (amount: string | number, currency = 'NPR'): string => `${currency} ${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
/** <input type="datetime-local"> value (Nepal wall-clock) → ISO instant. Nepal Standard Time is UTC+05:45 with no DST. */
export const nepalLocalToIso = (local: string): string => new Date(`${local}:00+05:45`).toISOString();

export const fmtDay = (iso: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
/** Calendar day in Nepal (YYYY-MM-DD), used to group flights under one date heading. */
export const dayKey = (iso: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
export const fmtDuration = (fromIso: string, toIso: string): string => {
  const m = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};

/** The two flights of a trip, in plain words. */
export const dirLabel = (d: string): string => (d === 'OUTBOUND' ? 'Going' : 'Return');

/** A flight is a route (origin to destination) or a sector (one name, e.g. a mountain flight). */
export interface RouteLike {
  origin?: { iata: string; city?: string } | null;
  destination?: { iata: string; city?: string } | null;
  sector?: { name: string } | null;
}
/** "KTM-PKR", or the sector name. */
export const routeCode = (f: RouteLike): string => (f.origin && f.destination ? `${f.origin.iata}-${f.destination.iata}` : (f.sector?.name ?? 'Sector flight'));
/** "Kathmandu → Pokhara", or the sector name. */
export const routeWords = (f: RouteLike): string =>
  f.origin && f.destination ? `${f.origin.city ?? f.origin.iata} → ${f.destination.city ?? f.destination.iata}` : (f.sector?.name ?? 'Sector flight');
/** Calendar day (Nepal) as "12 Nov 2026" from a date-only value like "2026-11-12T00:00:00.000Z". */
export const fmtDateOnly = (v: string | null | undefined): string => {
  if (!v) return 'null';
  const [y, m, d] = v.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
};

/** ISO instant → value for <input type="datetime-local"> in Nepal wall-clock time. */
export const isoToNepalLocal = (iso: string): string => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
};
