// Basic post-deploy smoke test (read-only; creates no data).
//   BASE_URL=https://tickets.example.com node scripts/smoke.mjs
//   SMOKE_EMAIL=... SMOKE_PASSWORD=... also verifies admin login (password via env, not argv).
const base = (process.env.BASE_URL ?? 'http://localhost').replace(/\/$/, '');
const H = { 'X-Requested-With': 'mtt-admin' };
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const j = async (r) => r.json().catch(() => null);

const ready = await fetch(`${base}/api/health/ready`);
check('backend ready (database reachable)', ready.ok && (await j(ready))?.status === 'ok', `HTTP ${ready.status}`);

const home = await fetch(`${base}/`);
check('frontend serves /', home.ok, `HTTP ${home.status}`);
check('security headers present', !!home.headers.get('content-security-policy') && home.headers.get('x-frame-options') === 'DENY');
check('server does not advertise framework', !home.headers.get('x-powered-by'));

const airports = await fetch(`${base}/api/public/airports`);
const list = airports.ok ? await j(airports) : null;
check('public airports endpoint', Array.isArray(list), Array.isArray(list) ? `${list.length} airports` : `HTTP ${airports.status}`);

check('admin API rejects anonymous requests', (await fetch(`${base}/api/admin/flights`)).status === 401);
check('admin API rejects forged token', (await fetch(`${base}/api/admin/flights`, { headers: { Authorization: 'Bearer a.b.c' } })).status === 401);

if (Array.isArray(list) && list.length >= 2) {
  const d = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const s = await fetch(`${base}/api/public/flights/search?origin=${list[0].iata}&destination=${list[1].iata}&departureDate=${d}&tripType=ONE_WAY&adults=1`);
  check('flight search responds', s.ok && Array.isArray((await j(s))?.outbound), `HTTP ${s.status}`);
} else console.log('SKIP  flight search (need at least 2 airports configured)');

const { SMOKE_EMAIL: email, SMOKE_PASSWORD: password } = process.env;
if (email && password) {
  const l = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const body = await j(l);
  check('admin login', l.ok && !!body?.accessToken, `HTTP ${l.status}`);
  const cookie = l.headers.get('set-cookie') ?? '';
  check('refresh cookie is HttpOnly + SameSite=Strict', /httponly/i.test(cookie) && /samesite=strict/i.test(cookie));
  if (body?.accessToken) {
    const sum = await fetch(`${base}/api/admin/bookings-summary`, { headers: { Authorization: `Bearer ${body.accessToken}` } });
    check('authenticated admin call', sum.ok, `HTTP ${sum.status}`);
    const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { ...H, Cookie: cookie.split(';')[0] } });
    check('logout', out.status === 204, `HTTP ${out.status}`);
  }
} else console.log('SKIP  admin login (set SMOKE_EMAIL and SMOKE_PASSWORD)');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
