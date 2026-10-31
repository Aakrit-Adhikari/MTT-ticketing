/**
 * One-time bootstrap of the first Super Admin. No default credentials exist anywhere.
 *
 *   ADMIN_EMAIL=you@example.com node dist/scripts/create-admin.js < password.txt
 *
 * The password is read from ADMIN_PASSWORD or, preferably, from stdin (keeps it out of shell history and `ps`).
 * Does nothing (exit 0) if a Super Admin already exists, so it is safe to leave in a deploy script; further users are
 * created in the admin UI.
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const name = process.env.ADMIN_NAME?.trim() || 'Administrator';
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('ADMIN_EMAIL is required and must be a valid email');

  const password = process.env.ADMIN_PASSWORD || (process.stdin.isTTY ? '' : await readStdin());
  if (password.length < 12) throw new Error('Password (ADMIN_PASSWORD or stdin) must be at least 12 characters');

  const prisma = new PrismaClient();
  try {
    if ((await prisma.user.count({ where: { role: 'SUPER_ADMIN' } })) > 0) {
      console.log('A Super Admin already exists: nothing to do. Create further users in Admin > Users.');
      return;
    }
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const user = await prisma.user.create({ data: { email, name, passwordHash, role: 'SUPER_ADMIN' } });
    await prisma.auditLog.create({ data: { actorId: user.id, action: 'user.bootstrap_admin', entityType: 'User', entityId: user.id } });
    console.log(`Super Admin created: ${email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
