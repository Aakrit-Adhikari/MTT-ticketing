# Manual Airline Ticketing & Inventory System

Back-office and customer site for a travel agency that holds **blocks of seats** with airlines and sells them **manually**.
Staff enter departures and the agency's seat allocation; customers search and send *inquiries*; staff confirm with the
airline themselves. The system never contacts an airline, never issues tickets, and never invents schedules,
confirmations, PNRs or payments.

| Part | Stack |
|---|---|
| `backend/` | NestJS 11, Prisma 6, PostgreSQL, Argon2id, JWT |
| `frontend/` | Next.js 16 (App Router), React 19 |
| `infra/` | Caddy (HTTPS), PostgreSQL role setup |

Docs: [Security](docs/SECURITY.md) · [Inventory rules](docs/INVENTORY.md) · [Operations, backup & restore](docs/OPERATIONS.md)

## Status (Phase 1)

**Implemented and tested:** admin login with refresh rotation/reuse detection/logout/lockout, RBAC (Super Admin / Booking
Staff / Finance Staff), users, airlines, airports, flights with seat allocation, inventory adjustments (audited), public
search (one-way and round trip, each leg checked independently), booking inquiry, customer lookup (reference + email),
hold / confirm / cancel / reject with expiring holds, audit log, health endpoints, Docker deployment, backup scripts.

**Not yet built** (see "Remaining work"): payments & receipts, ticket/PNR recording, refunds & policies, rescheduling,
cancellation *requests* from customers, customer records, notifications, reports/CSV, system settings, sectors/routes.
The booking page says so; nothing pretends these exist.

## Local development

```bash
# Backend (needs a PostgreSQL you control; or see "Tests" for a throwaway one)
cd backend && npm ci
export DATABASE_URL=postgresql://user:pass@localhost:5432/mtt
export JWT_ACCESS_SECRET=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')
export FIELD_ENCRYPTION_KEY=$(openssl rand -base64 32)
export FRONTEND_ORIGIN=http://localhost:3000
npx prisma migrate deploy && npm run build
ADMIN_EMAIL=you@agency.example ADMIN_PASSWORD='a-long-password-here' npm run admin:create
npm run start:dev                       # API on :4000

cd ../frontend && npm ci && npm run dev  # site on :3000, proxies /api to :4000
```

### Tests

```bash
cd backend
npm test                # unit tests
npm run test:int        # integration tests against real PostgreSQL
npm audit --omit=dev    # dependency audit (also run in frontend/)
npx tsc --noEmit        # type check
```

`test:int` starts a throwaway embedded PostgreSQL automatically (no Docker needed), applies the committed migrations with
`migrate deploy`, and tears it down. Set `TEST_DATABASE_URL` to use your own server instead.

## Production deployment (Docker Compose)

Prerequisites: a Linux host with Docker Compose v2, a domain whose DNS points at it, ports 80/443 open. **Do not treat the
deployment as production-ready until every item in the checklist at the end is true.**

**0. Choose how people will reach the site** (no domain yet? ports 80/443 taken?). See the top of `.env.example`:
(A) a domain, (B) a free `<ip-with-dashes>.sslip.io` name, or (C) the bare IP with your own ports and a self-signed certificate.
Ports are set in `.env` (`HTTP_PORT`, `HTTPS_PORT`); only the proxy publishes ports, the frontend (3000), backend (4000) and
database (5432) are internal to Docker and cannot clash with anything on the server.

**1. Configure secrets**
```bash
cp .env.example .env && chmod 600 .env
# Edit .env: set SITE_DOMAIN / FRONTEND_ORIGIN / PUBLIC_APP_URL, then generate each secret:
openssl rand -hex 24                                        # POSTGRES_SUPERUSER_PASSWORD, MIGRATOR_DB_PASSWORD, APP_DB_PASSWORD (three different values)
openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n'        # JWT_ACCESS_SECRET
openssl rand -base64 32                                     # FIELD_ENCRYPTION_KEY  (store a copy in your password manager NOW)
```

**2. Build images**
```bash
docker compose build
```

**3. Start the database and verify it**
```bash
docker compose up -d db
docker compose ps db                        # wait for "healthy"
docker compose exec db sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```
Database roles (`mtt_migrator`, `mtt_app`) are created automatically **only the first time** the empty volume initialises.

**4. Apply migrations (explicit, never on app start)**
```bash
docker compose --profile ops run --rm migrate
```

**5. Start the application**
```bash
docker compose up -d backend frontend proxy
docker compose ps                           # backend, frontend: healthy
```

**6. Create the first administrator (one time; credentials come from `.env`)**
```bash
# .env must contain ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD (min 12 characters)
docker compose --profile ops run --rm create-admin
```
It does nothing if a Super Admin already exists, so running it again is harmless. Afterwards **delete `ADMIN_PASSWORD` from
`.env`** and sign in. Create further staff in **Admin → Users**.

**7. Check health**
```bash
curl -fsS https://YOUR_DOMAIN/api/health/ready
curl -fsSI https://YOUR_DOMAIN/ | head -1
```

**8. Smoke test: login and a basic search**
```bash
BASE_URL=https://YOUR_DOMAIN SMOKE_EMAIL=you@agency.example SMOKE_PASSWORD="$(read -rs p; echo $p)" node scripts/smoke.mjs
```
Then sign in at `https://YOUR_DOMAIN/admin/login`, add an airline, two airports and a flight, and search for it on the home page.

**9. Logs without leaking secrets**
```bash
docker compose logs --since 1h backend frontend proxy
```
The backend logs no request bodies, tokens or passwords. Do **not** run `docker compose config` or `docker inspect` into
shared channels: they print resolved environment values.

