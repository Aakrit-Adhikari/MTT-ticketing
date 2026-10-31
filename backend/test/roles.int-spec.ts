import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

/** Applies the REAL infra/db/roles.sql to a fresh database, migrates as mtt_migrator, then proves mtt_app is least-privilege. */
describe('database roles (least privilege)', () => {
  const superUrl = process.env.TEST_DATABASE_URL!;
  const base = superUrl.replace(/\/[^/]+$/, '');
  const MIG = 'm'.repeat(24), APP = 'a'.repeat(24);
  let app: PrismaClient;

  beforeAll(async () => {
    const su = new PrismaClient({ datasources: { db: { url: superUrl } } });
    await su.$executeRawUnsafe('CREATE DATABASE mtt_roles');
    await su.$disconnect();

    const sql = readFileSync(join(__dirname, '../../infra/db/roles.sql'), 'utf8')
      .replace('__MIGRATOR_PW__', MIG).replace('__APP_PW__', APP).replace(/__DB__/g, 'mtt_roles');
    const admin = new PrismaClient({ datasources: { db: { url: `${base}/mtt_roles` } } });
    for (const stmt of sql.replace(/^\s*--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean)) await admin.$executeRawUnsafe(stmt);
    await admin.$disconnect();

    execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: `postgresql://mtt_migrator:${MIG}@${base.split('@')[1]}/mtt_roles` }, stdio: 'pipe' });
    app = new PrismaClient({ datasources: { db: { url: `postgresql://mtt_app:${APP}@${base.split('@')[1]}/mtt_roles` } } });
  });
  afterAll(() => app.$disconnect());

  it('can read and write ordinary data', async () => {
    const a = await app.airline.create({ data: { code: 'XX', name: 'Test' } });
    expect(await app.airline.count()).toBe(1);
    await app.airline.update({ where: { id: a.id }, data: { name: 'Renamed' } });
  });

  it('cannot alter schema', async () => {
    await expect(app.$executeRawUnsafe('DROP TABLE "Airline" CASCADE')).rejects.toBeTruthy();
    await expect(app.$executeRawUnsafe('CREATE TABLE evil (id int)')).rejects.toBeTruthy();
    await expect(app.$executeRawUnsafe('ALTER TABLE "User" ADD COLUMN x int')).rejects.toBeTruthy();
  });

  it('audit and inventory-adjustment history is append-only', async () => {
    await app.auditLog.create({ data: { action: 'x', entityType: 'T', entityId: '1' } });
    await expect(app.$executeRawUnsafe(`UPDATE "AuditLog" SET action = 'tampered'`)).rejects.toBeTruthy();
    await expect(app.$executeRawUnsafe(`DELETE FROM "AuditLog"`)).rejects.toBeTruthy();
    await expect(app.$executeRawUnsafe(`TRUNCATE "InventoryAdjustment"`)).rejects.toBeTruthy();
  });
});
