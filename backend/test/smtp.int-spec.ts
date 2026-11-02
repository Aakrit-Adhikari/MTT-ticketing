import { PrismaClient } from '@prisma/client';
import { SMTPServer } from 'smtp-server';
import { NotificationsService } from '../src/notifications/notifications.module';
import { Env } from '../src/common/config/env';

/** Proves the real delivery path (nodemailer -> SMTP) works and is recorded, using a fake in-process mail server. */
describe('email delivery over SMTP', () => {
  let server: SMTPServer;
  let port: number;
  const received: { from: string; to: string[]; body: string; auth?: string }[] = [];
  let prisma: PrismaClient;
  let bookingId: string;

  beforeAll(async () => {
    server = new SMTPServer({
      authOptional: false,
      allowInsecureAuth: true,
      disabledCommands: ['STARTTLS'],
      onAuth(auth, _s, cb) { cb(auth.username === 'agency@example.com' && auth.password === 'app-password' ? null : new Error('bad credentials'), auth.username ? { user: auth.username } : undefined); },
      onData(stream, session, cb) {
        let body = '';
        stream.on('data', (c) => (body += c));
        stream.on('end', () => { received.push({ from: String(session.envelope.mailFrom && session.envelope.mailFrom.address), to: session.envelope.rcptTo.map((r) => r.address), body, auth: session.user as string }); cb(); });
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.server.address() as { port: number }).port;
    prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
    const user = await prisma.user.create({ data: { email: 'smtp@test.local', name: 'x', passwordHash: 'x', role: 'BOOKING_STAFF' } });
    const airline = await prisma.airline.create({ data: { code: 'ZZ', name: 'Z' } });
    const a = await prisma.airport.create({ data: { iata: 'AAA', name: 'a', city: 'a' } });
    const b = await prisma.airport.create({ data: { iata: 'BBB', name: 'b', city: 'b' } });
    void user; void airline; void a; void b;
    const booking = await prisma.booking.create({ data: { reference: 'MT-SMTP1-TEST1', tripType: 'ONE_WAY', contactName: 'T', contactEmail: 't@example.com', contactPhone: '9800000000' } });
    bookingId = booking.id;
  });
  afterAll(async () => { await prisma.$disconnect(); await new Promise((r) => server.close(() => r(null))); });

  const svc = (over: Partial<Env>) => new NotificationsService(prisma as never, { NODE_ENV: 'test', SMTP_HOST: '127.0.0.1', SMTP_PORT: port, SMTP_USER: 'agency@example.com', SMTP_PASSWORD: 'app-password', MAIL_FROM: 'Agency <agency@example.com>', ...over } as Env);
  const waitStatus = async (template: string) => {
    for (let i = 0; i < 80; i++) { const n = await prisma.notification.findFirst({ where: { bookingId, template } }); if (n && n.status !== 'PENDING') return n; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error('timeout');
  };

  it('delivers the message with the right sender/recipient and marks it SENT', async () => {
    await svc({}).send({ bookingId, to: 't@example.com', template: 'ok_mail', subject: 'Hello', text: 'Your reference is MT-SMTP1-TEST1' });
    const n = await waitStatus('ok_mail');
    expect(n.status).toBe('SENT');
    expect(n.sentAt).not.toBeNull();
    expect(received.at(-1)?.to).toEqual(['t@example.com']);
    expect(received.at(-1)?.from).toBe('agency@example.com');
    expect(received.at(-1)?.body).toContain('MT-SMTP1-TEST1');
  });

  it('attaches PDF files to the message', async () => {
    await svc({}).send({ bookingId, to: 't@example.com', template: 'with_pdf', subject: 'Ticket', text: 'see attached', attachments: [{ filename: 'ticket.pdf', content: Buffer.from('%PDF-1.4 attach-me'), contentType: 'application/pdf' }] });
    expect((await waitStatus('with_pdf')).status).toBe('SENT');
    const body = received.at(-1)!.body;
    expect(body).toContain('filename=ticket.pdf');
    expect(body).toContain('application/pdf');
  });

  it('records FAILED (without leaking credentials) when the server rejects the login', async () => {
    await svc({ SMTP_PASSWORD: 'wrong-password' }).send({ bookingId, to: 't@example.com', template: 'bad_login', subject: 'x', text: 'x' });
    const n = await waitStatus('bad_login');
    expect(n.status).toBe('FAILED');
    expect(`${n.error}`).not.toContain('wrong-password');
  });

  it('records FAILED when the mail server is unreachable', async () => {
    await svc({ SMTP_PORT: 1 }).send({ bookingId, to: 't@example.com', template: 'down', subject: 'x', text: 'x' });
    expect((await waitStatus('down')).status).toBe('FAILED');
  });
});
