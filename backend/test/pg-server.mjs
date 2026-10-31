// Dev/test-only: throwaway local PostgreSQL (no Docker needed). Prints "READY <url>" once migrated.
import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.TEST_PG_PORT ?? 54329);
// PG_DATA_DIR set -> data survives restarts (local dev). Unset -> throwaway database (tests).
const persist = process.env.PG_DATA_DIR;
if (persist) mkdirSync(persist, { recursive: true });
const dir = persist ?? mkdtempSync(join(tmpdir(), 'mtt-pg-'));
const fresh = !persist || !existsSync(join(dir, 'PG_VERSION'));
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'test', password: 'test', port, persistent: !!persist, onLog: () => {}, onError: () => {} });
if (fresh) await pg.initialise();
await pg.start();
try { await pg.createDatabase('mtt'); } catch { /* already exists */ }
const url = `postgresql://test:test@localhost:${port}/mtt`;
execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
console.log(`READY ${url}`);
if (process.env.READY_FILE) (await import('node:fs')).writeFileSync(process.env.READY_FILE, 'ok');
const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.resume();
process.stdin.on('end', stop); // parent exit closes the pipe → clean shutdown
