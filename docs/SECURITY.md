# Security design, data classification and residual risks

This system has been tested as described below. **It is not claimed to be free of vulnerabilities.** See "Residual risks".

## Data classification

| Class | Fields | Protection |
|---|---|---|
| Credentials | `User.passwordHash`, `RefreshToken.tokenHash` | Argon2id (m=19 MiB, t=2); refresh tokens stored only as SHA-256 of a 256-bit random value. Never returned or logged. |
| Sensitive PII | Passport number, nationality and expiry (`Passenger.documentNumberEnc`, `nationalityEnc`, `documentExpiryEnc`), date of birth, contact email/phone | Passport fields: AES-256-GCM application-level encryption (key outside DB). Listed masked (last 3) to Super Admin/Booking Staff; the full number is only returned by an explicit **Show/Edit** action whose use is written to the audit log (who/which passenger, never the value). **Hidden from Finance Staff**, who also don't see DOB. Public lookup never echoes email/phone. |
| Operational | flights, inventory, booking status, audit | Role-restricted; audit/adjustment tables append-only for the app DB role. |
| Not collected | card numbers/CVV, passport scans | Document numbers are optional and uploads are not implemented. |

Contact email is stored in plaintext because lookup, uniqueness and search need it; it is protected by access control and TLS.

## Authentication

* Login: email + password; one generic error for unknown email / wrong password / disabled / locked accounts; a dummy Argon2
  verification runs for unknown emails to flatten timing. 5 failures → 15-minute lock. Rate limit 10/min/IP on login.
* **Access token:** JWT, HS256 pinned, `iss`/`aud`/`exp` validated, **15 min** (`ACCESS_TTL_SECONDS`). Held **in browser memory
  only**, sent as `Authorization: Bearer`. Every request re-checks the user is active and `tokenVersion` matches, so disabling
  a user or changing their role takes effect immediately, not after expiry.
* **Refresh token:** opaque random value in an `HttpOnly; Secure; SameSite=Strict; Path=/api/auth` cookie, **7 days**
  (`REFRESH_TTL_DAYS`), stored hashed. **Single use**: each refresh rotates it. Presenting an already-used or revoked token
  revokes the whole family (reuse detection); concurrent use is resolved by an atomic claim.
* **CSRF:** SameSite=Strict, plus refresh/logout require the custom header `X-Requested-With: mtt-admin` and (if present) an
  `Origin` equal to `FRONTEND_ORIGIN`. All other admin calls use the Bearer header, which browsers don't attach automatically.
* **Logout** revokes the session family. Disabling a user or changing role bumps `tokenVersion` and revokes all their sessions.
* Authorization is **default-deny**: a handler with no `@Roles` is rejected. Roles are enforced server-side on every route.

## Secrets and keys

`JWT_ACCESS_SECRET` and `FIELD_ENCRYPTION_KEY` are separate, validated at startup (length/format; must differ; the process
refuses to start otherwise and never prints values). The backend container receives an explicit allow-list of variables, **not**
the superuser or migrator DB passwords.

* **Rotating `JWT_ACCESS_SECRET`:** change it and restart; all access tokens become invalid (users refresh transparently).
* **Rotating `FIELD_ENCRYPTION_KEY`:** ciphertext carries a `v1.` version prefix, but **multi-key decryption is not yet
  implemented**. Rotation today means a scripted re-encrypt of `Passenger.documentNumberEnc`, `nationalityEnc` and `documentExpiryEnc` with old+new keys. **Losing the
  key makes those values unrecoverable** — back it up separately from DB backups.

## Database

* Roles: `mtt_migrator` (owns schema, used only by the one-shot migrate job) and `mtt_app` (DML only: cannot create/alter/drop;
  cannot UPDATE/DELETE/TRUNCATE `AuditLog` or `InventoryAdjustment`). The bootstrap superuser is used by no application.
  Verified by `backend/test/roles.int-spec.ts` against the real `infra/db/roles.sql`.
* PostgreSQL is not published on any host port; only the Caddy proxy publishes 80/443.
* All queries use Prisma or parameterised raw SQL (identifiers in raw SQL come from a fixed internal whitelist).

## HTTP hardening

Helmet headers on the API; CSP, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` on the site;
CORS restricted to `FRONTEND_ORIGIN`; 100 KB body limit (413 above); global rate limit 120/min/IP, stricter on login (10),
refresh (20), inquiry (10), lookup (10), search (60); DTOs use `whitelist` + `forbidNonWhitelisted` (mass-assignment
fields such as `status`/`role` are rejected, tested); errors never expose stack traces, SQL or paths (filter + tests).

## Dependency checks
`npm audit --omit=dev` is clean for backend and frontend as of the last run. Two transitive advisories (multer DoS, deepmerge-ts)
are fixed via `overrides` in `backend/package.json`; multer isn't used by any endpoint. Re-run on every release.

## Residual risks and gaps (be aware)

1. **CSP allows `'unsafe-inline'` scripts** (Next.js inline bootstrap). A nonce-based CSP is a recommended hardening step.
2. **No MFA** for staff. Strongly recommended before wide rollout.
3. **No email verification/OTP on customer lookup**: possession of reference + email is the secret. References have ~49 bits of
   entropy and lookup is rate-limited per IP, but a distributed attacker is not stopped by IP limits.
4. **Rate limiting is in-memory per backend instance**; run one instance or add a shared store (Redis) before scaling out.
5. Field-encryption key rotation is manual (above). Contact data is not field-encrypted.
6. The Docker images, Caddy HTTPS flow and backup scripts were **written but not executed** in the authoring environment
   (Docker daemon unavailable); compose syntax was validated. Run the go-live checklist and a restore drill.
7. Account lockout can be used to lock a known staff email out for 15 minutes (a deliberate trade-off).
8. No automated vulnerability scanning of container images; add Trivy/Grype in CI.
