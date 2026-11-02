import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';

// Environment must be set before the app modules read it.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;
process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('base64url');
process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.FRONTEND_ORIGIN = 'http://localhost:3000';
process.env.STAFF_NOTIFY_EMAIL = 'staff1@agency.test, staff2@agency.test';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { getEnv } from '../src/common/config/env';
import { BookingsService } from '../src/bookings/bookings.service';

const PASSWORD = 'correct-horse-battery';
const CSRF = { 'X-Requested-With': 'mtt-admin' };

describe('API (integration, real PostgreSQL)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: PrismaClient;
  let bookings: BookingsService;
  let admin: string; // access tokens
  let staff: string;
  let finance: string;
  let ktm: string, pkr: string, airline: string;

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function mkUser(email: string, role: Role, isActive = true) {
    return prisma.user.create({ data: { email, name: email, role, isActive, passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }) } });
  }
  async function login(email: string, password = PASSWORD) {
    return request(server()).post('/api/auth/login').send({ email, password });
  }

  const departure = (daysAhead: number, hour = 9) => {
    const d = new Date(Date.now() + daysAhead * 86_400_000);
    d.setUTCHours(hour, 0, 0, 0);
    return d;
  };
  /** Search dates are Nepal-local calendar days. */
  const nepalDate = (d: Date) => new Date(d.getTime() + 5.75 * 3_600_000).toISOString().slice(0, 10);

  async function mkFlight(opts: { seats: number; number: string; from?: string; to?: string; dep?: Date; arrMins?: number }) {
    const dep = opts.dep ?? departure(7);
    const res = await request(server())
      .post('/api/admin/flights')
      .set(auth(staff))
      .send({
        airlineId: airline,
        flightNumber: opts.number,
        originId: opts.from ?? ktm,
        destinationId: opts.to ?? pkr,
        departureAt: dep.toISOString(),
        arrivalAt: new Date(dep.getTime() + (opts.arrMins ?? 35) * 60_000).toISOString(),
        adultFare: '5500.00',
        childFare: '4200',
        seatsAllocated: opts.seats,
      });
    expect(res.status).toBe(201);
    return { id: res.body.id as string, dep };
  }

  const passengers = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ type: 'ADULT', firstName: `Test${String.fromCharCode(65 + i)}`, lastName: 'Traveller', documentNumber: `NP${1000000 + i}`, nationality: 'Nepal' }));

  async function inquire(flightId: string, n = 1, extra: Record<string, unknown> = {}) {
    const res = await request(server())
      .post('/api/public/bookings/inquiry')
      .send({
        tripType: 'ONE_WAY',
        outboundFlightId: flightId,
        contactName: 'Sita Sharma',
        contactEmail: 'Sita@Example.com',
        contactPhone: '+977 9800000000',
        passengers: passengers(n),
        ...extra,
      });
    if (res.status === 201) {
      // The API deliberately does not return the reference (it is emailed). Tests read it from the database.
      const b = await prisma.booking.findFirstOrThrow({ where: { segments: { some: { flightId } } }, orderBy: { createdAt: 'desc' } });
      res.body.reference = b.reference;
    }
    return res;
  }
  const inventoryOf = (flightId: string) => prisma.flightInventory.findUniqueOrThrow({ where: { flightId } });

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, getEnv());
    await app.init();
    http = request(server());
    bookings = app.get(BookingsService);

    await mkUser('admin@test.local', 'SUPER_ADMIN');
    await mkUser('staff@test.local', 'BOOKING_STAFF');
    await mkUser('finance@test.local', 'FINANCE_STAFF');
    admin = (await login('admin@test.local')).body.accessToken;
    staff = (await login('staff@test.local')).body.accessToken;
    finance = (await login('finance@test.local')).body.accessToken;

    airline = (await http.post('/api/admin/airlines').set(auth(admin)).send({ code: 'RA', name: 'Nepal Airlines' })).body.id;
    ktm = (await http.post('/api/admin/airports').set(auth(admin)).send({ iata: 'KTM', name: 'Tribhuvan Intl', city: 'Kathmandu' })).body.id;
    pkr = (await http.post('/api/admin/airports').set(auth(admin)).send({ iata: 'PKR', name: 'Pokhara Intl', city: 'Pokhara' })).body.id;
    expect([airline, ktm, pkr].every(Boolean)).toBe(true);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  // ───────────── authentication & token handling ─────────────

  describe('authentication', () => {
    it('rejects missing, malformed, tampered and wrong-algorithm tokens', async () => {
      expect((await http.get('/api/admin/flights')).status).toBe(401);
      expect((await http.get('/api/admin/flights').set(auth('not.a.jwt'))).status).toBe(401);
      expect((await http.get('/api/admin/flights').set(auth(staff.slice(0, -3) + 'abc'))).status).toBe(401);
      const none = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url');
      const body = staff.split('.')[1];
      expect((await http.get('/api/admin/flights').set(auth(`${none}.${body}.`))).status).toBe(401);
    });

    it('uses one generic error for unknown email, wrong password and disabled account', async () => {
      await mkUser('disabled@test.local', 'BOOKING_STAFF', false);
      const a = await login('nobody@test.local');
      const b = await login('staff@test.local', 'wrong-password-123');
      const c = await login('disabled@test.local');
      for (const r of [a, b, c]) expect(r.status).toBe(401);
      expect(a.body).toEqual(b.body);
      expect(b.body).toEqual(c.body);
    });

    it('sets an HttpOnly SameSite=Strict refresh cookie and never returns the refresh token in the body', async () => {
      const r = await login('finance@test.local');
      const cookie = (r.headers['set-cookie'] as unknown as string[])[0];
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\/api\/auth/);
      expect(JSON.stringify(r.body)).not.toMatch(/refresh/i);
    });

    it('rotates refresh tokens, detects reuse and revokes the whole family', async () => {
      await mkUser('rot@test.local', 'BOOKING_STAFF');
      const l = await login('rot@test.local');
      const rt1 = (l.headers['set-cookie'] as unknown as string[])[0].split(';')[0];

      const r1 = await http.post('/api/auth/refresh').set(CSRF).set('Cookie', rt1);
      expect(r1.status).toBe(200);
      const rt2 = (r1.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
      expect(rt2).not.toEqual(rt1);

      // Replaying the already-rotated token = theft signal.
      expect((await http.post('/api/auth/refresh').set(CSRF).set('Cookie', rt1)).status).toBe(401);
      // …and the legitimate descendant is now dead too.
      expect((await http.post('/api/auth/refresh').set(CSRF).set('Cookie', rt2)).status).toBe(401);
    });

    it('logout revokes the session; refresh requires the CSRF header', async () => {
      await mkUser('out@test.local', 'BOOKING_STAFF');
      const l = await login('out@test.local');
      const rt = (l.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
      expect((await http.post('/api/auth/refresh').set('Cookie', rt)).status).toBe(403); // no X-Requested-With
      expect((await http.post('/api/auth/refresh').set(CSRF).set('Origin', 'https://evil.example').set('Cookie', rt)).status).toBe(403);
      expect((await http.post('/api/auth/logout').set(CSRF).set('Cookie', rt)).status).toBe(204);
      expect((await http.post('/api/auth/refresh').set(CSRF).set('Cookie', rt)).status).toBe(401);
    });

    it('disabling a user invalidates their existing access token and refresh sessions immediately', async () => {
      const u = await mkUser('victim@test.local', 'BOOKING_STAFF');
      const l = await login('victim@test.local');
      const token = l.body.accessToken as string;
      const rt = (l.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
      expect((await http.get('/api/admin/flights').set(auth(token))).status).toBe(200);

      expect((await http.patch(`/api/admin/users/${u.id}`).set(auth(admin)).send({ isActive: false })).status).toBe(200);
      expect((await http.get('/api/admin/flights').set(auth(token))).status).toBe(401);
      expect((await http.post('/api/auth/refresh').set(CSRF).set('Cookie', rt)).status).toBe(401);
    });

    it('locks an account after repeated failures', async () => {
      await mkUser('lock@test.local', 'BOOKING_STAFF');
      await prisma.user.update({ where: { email: 'lock@test.local' }, data: { failedLogins: 4 } });
      await login('lock@test.local', 'wrong-password-123');
      const r = await login('lock@test.local'); // correct password, but locked
      expect(r.status).toBe(401);
    });
  });

  // ───────────── role-based access control ─────────────

  describe('role-based access control', () => {
    it('blocks every role from endpoints it should not reach, server-side', async () => {
      expect((await http.get('/api/admin/users').set(auth(staff))).status).toBe(403);
      expect((await http.get('/api/admin/users').set(auth(finance))).status).toBe(403);
      expect((await http.get('/api/admin/audit-logs').set(auth(staff))).status).toBe(403);
      expect((await http.post('/api/admin/airlines').set(auth(staff)).send({ code: 'YT', name: 'Yeti' })).status).toBe(403);
      expect((await http.post('/api/admin/flights').set(auth(finance)).send({})).status).toBe(403);
      expect((await http.get('/api/admin/users').set(auth(admin))).status).toBe(200);
    });

    it('does not let finance staff change bookings or adjust inventory, and hides passenger documents from them', async () => {
      const { id } = await mkFlight({ seats: 5, number: 'RA 101' });
      const inq = await inquire(id, 1, {
        passengers: [{ type: 'ADULT', firstName: 'Ram', lastName: 'Thapa', dateOfBirth: '1990-01-01', documentNumber: 'NP1234567', nationality: 'Nepal', documentExpiry: '2040-01-01' }],
      });
      const b = await prisma.booking.findUniqueOrThrow({ where: { reference: inq.body.reference } });
      expect((await http.post(`/api/admin/bookings/${b.id}/confirm`).set(auth(finance))).status).toBe(403);
      expect((await http.post(`/api/admin/flights/${id}/inventory/adjust`).set(auth(staff)).send({ delta: 1, reason: 'extra block' })).status).toBe(403);

      const asStaff = await http.get(`/api/admin/bookings/${b.id}`).set(auth(staff));
      expect(asStaff.body.passengers[0].documentNumberMasked).toBe('******567');
      const asFinance = await http.get(`/api/admin/bookings/${b.id}`).set(auth(finance));
      expect(asFinance.status).toBe(200);
      expect(asFinance.body.passengers[0].documentNumberMasked).toBeUndefined();
      expect(asFinance.body.passengers[0].dateOfBirth).toBeUndefined();
      // Stored encrypted, never plaintext.
      const stored = await prisma.passenger.findFirstOrThrow({ where: { bookingId: b.id } });
      expect(stored.documentNumberEnc).toMatch(/^v1\./);
      expect(stored.documentNumberEnc).not.toContain('NP1234567');
    });
  });

  describe('passport details', () => {
    const pax = { type: 'ADULT', firstName: 'Pass', lastName: 'Port', documentNumber: 'NP1234567', nationality: 'Nepal', documentExpiry: '2040-01-01' };

    it('stores number, nationality and expiry encrypted and lets staff view the full number only through an audited reveal', async () => {
      const { id } = await mkFlight({ seats: 5, number: 'RA 731' });
      const inq = await inquire(id, 1, { passengers: [pax] });
      expect(inq.status).toBe(201);
      const b = await prisma.booking.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
      const stored = await prisma.passenger.findFirstOrThrow({ where: { bookingId: b.id } });
      for (const v of [stored.documentNumberEnc, stored.nationalityEnc, stored.documentExpiryEnc]) {
        expect(v).toMatch(/^v1./);
      }
      expect(JSON.stringify(stored)).not.toContain('NP1234567');
      expect(JSON.stringify(stored)).not.toContain('2040-01-01');

      const view = await http.get(`/api/admin/bookings/${b.id}`).set(auth(staff));
      expect(view.body.passengers[0]).toMatchObject({ documentNumberMasked: '******567', nationality: 'Nepal', documentExpiry: '2040-01-01' });
      expect(JSON.stringify(view.body)).not.toContain('NP1234567');

      const pid = stored.id;
      expect((await http.post(`/api/admin/bookings/${b.id}/passengers/${pid}/passport/reveal`).set(auth(finance))).status).toBe(403);
      const rev = await http.post(`/api/admin/bookings/${b.id}/passengers/${pid}/passport/reveal`).set(auth(staff));
      expect(rev.status).toBe(200);
      expect(rev.body).toEqual({ documentNumber: 'NP1234567', nationality: 'Nepal', documentExpiry: '2040-01-01' });
      const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'passenger.passport_view', entityId: b.id } });
      expect(JSON.stringify(log.detail)).not.toContain('NP1234567');
    });

    it('lets staff add a passport to an inquiry that came without one, and rejects an expired or partial passport', async () => {
      const { id } = await mkFlight({ seats: 5, number: 'RA 732' });
      expect((await inquire(id, 1, { passengers: [{ ...pax, nationality: undefined }] })).status).toBe(400); // number without nationality
      expect((await inquire(id, 1, { passengers: [{ ...pax, documentExpiry: '2020-01-01' }] })).status).toBe(400); // expired before travel
      const inq = await inquire(id, 1, { passengers: [{ type: 'ADULT', firstName: 'No', lastName: 'Passport' }] });
      expect(inq.status).toBe(201);
      const b = await prisma.booking.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
      const p = await prisma.passenger.findFirstOrThrow({ where: { bookingId: b.id } });
      expect(p.documentNumberEnc).toBeNull();
      const url = `/api/admin/bookings/${b.id}/passengers/${p.id}/passport`;
      expect((await http.patch(url).set(auth(finance)).send({ documentNumber: 'AB123456', nationality: 'India', documentExpiry: '2035-05-05' })).status).toBe(403);
      expect((await http.patch(url).set(auth(staff)).send({ documentNumber: 'AB123456', nationality: 'India', documentExpiry: '2020-05-05' })).status).toBe(400);
      const ok = await http.patch(url).set(auth(staff)).send({ documentNumber: 'ab123456', nationality: 'India', documentExpiry: '2035-05-05' });
      expect(ok.status).toBe(200);
      expect(ok.body.passengers[0]).toMatchObject({ documentNumberMasked: '*****456', nationality: 'India', documentExpiry: '2035-05-05' });
      expect(JSON.stringify(ok.body)).not.toContain('AB123456');
    });
  });

  describe('passports, ticketed customers, calendar and reschedule history', () => {
    it('lets an inquiry exist without a passport but refuses to confirm it until every passenger has one', async () => {
      const { id } = await mkFlight({ seats: 4, number: 'RA 761' });
      const inq = await inquire(id, 1, { passengers: [{ type: 'ADULT', firstName: 'No', lastName: 'Passport' }] });
      expect(inq.status).toBe(201);
      const b = await prisma.booking.findUniqueOrThrow({ where: { reference: inq.body.reference } });
      const blocked = await http.post(`/api/admin/bookings/${b.id}/confirm`).set(auth(staff));
      expect(blocked.status).toBe(409);
      expect(blocked.body.message).toMatch(/passport/i);
      const p = await prisma.passenger.findFirstOrThrow({ where: { bookingId: b.id } });
      await http.patch(`/api/admin/bookings/${b.id}/passengers/${p.id}/passport`).set(auth(staff)).send({ documentNumber: 'AB1234567', nationality: 'India' });
      expect((await http.post(`/api/admin/bookings/${b.id}/confirm`).set(auth(staff))).status).toBe(200);
      // a booking created directly by staff needs the passport up front
      const walk = await http.post('/api/admin/bookings').set(auth(staff)).send({ tripType: 'ONE_WAY', outboundFlightId: id, contactName: 'Walk In', contactEmail: 'w@example.com', contactPhone: '9800000009', passengers: [{ type: 'ADULT', firstName: 'No', lastName: 'Pass' }] });
      expect(walk.status).toBe(400);
    });

    it('does not let a ticketed booking be deleted, lists it with its PNR, and shows it on the calendar', async () => {
      const dep = departure(95, 6);
      const { id } = await mkFlight({ seats: 4, number: 'RA 762', dep });
      const inq = await inquire(id, 1);
      const b = await prisma.booking.findUniqueOrThrow({ where: { reference: inq.body.reference } });
      await http.post(`/api/admin/bookings/${b.id}/confirm`).set(auth(staff));
      const pax = await prisma.passenger.findMany({ where: { bookingId: b.id } });
      const t = await http.post(`/api/admin/bookings/${b.id}/ticket`).set(auth(staff)).send({ pnr: 'ZXC123', tickets: pax.map((x, i) => ({ passengerId: x.id, ticketNumber: `1234567890${i}` })) });
      expect(t.status).toBe(200);
      const del = await http.delete(`/api/admin/bookings/${b.id}`).set(auth(admin));
      expect(del.status).toBe(409);
      const list = await http.get('/api/admin/ticketed').query({ q: 'ZXC123' }).set(auth(finance));
      expect(list.status).toBe(200);
      expect(list.body.items[0]).toMatchObject({ reference: b.reference, pnr: 'ZXC123' });
      expect(list.body.items[0].flights[0].flightNumber).toBe('RA 762');
      const month = nepalDate(dep).slice(0, 7);
      const cal = await http.get('/api/admin/calendar').query({ month }).set(auth(staff));
      expect(cal.status).toBe(200);
      const day = cal.body.days.find((d: { date: string }) => d.date === nepalDate(dep));
      expect(day.ticketed).toBeGreaterThanOrEqual(1);
      expect(day.flights.find((f: { flightNumber: string }) => f.flightNumber === 'RA 762').bookings[0].reference).toBe(b.reference);
      expect((await http.get('/api/admin/calendar').query({ month: 'nope' }).set(auth(staff))).status).toBe(400);
    });

    it('records when and to what a booking was rescheduled, and the calendar follows the new flight', async () => {
      const a = await mkFlight({ seats: 4, number: 'RA 763', dep: departure(97, 6) });
      const c = await mkFlight({ seats: 4, number: 'RA 764', dep: departure(99, 9) });
      const inq = await inquire(a.id, 1);
      const b = await prisma.booking.findUniqueOrThrow({ where: { reference: inq.body.reference } });
      await http.post(`/api/admin/bookings/${b.id}/confirm`).set(auth(staff));
      const r = await http.post(`/api/admin/bookings/${b.id}/reschedule`).set(auth(staff)).send({ changes: [{ direction: 'OUTBOUND', newFlightId: c.id }], note: 'Customer asked for later' });
      expect(r.status).toBe(200);
      expect(r.body.reschedules[0]).toMatchObject({ fromFlightNumber: 'RA 763', toFlightNumber: 'RA 764', note: 'Customer asked for later' });
      const feed = await http.get('/api/admin/reschedules').query({ q: b.reference }).set(auth(staff));
      expect(feed.body.items[0]).toMatchObject({ reference: b.reference, fromFlightNumber: 'RA 763', toFlightNumber: 'RA 764' });
      const oldDay = await http.get('/api/admin/calendar').query({ month: nepalDate(departure(97, 6)).slice(0, 7) }).set(auth(staff));
      const onOld = oldDay.body.days.find((d: { date: string }) => d.date === nepalDate(departure(97, 6)));
      expect(JSON.stringify(onOld ?? {})).not.toContain(b.reference);
      const newDay = await http.get('/api/admin/calendar').query({ month: nepalDate(departure(99, 9)).slice(0, 7) }).set(auth(staff));
      expect(JSON.stringify(newDay.body)).toContain(b.reference);
    });
  });

  describe('friendly errors, ticket time, ticket PDFs and payments', () => {
    it('explains a bad contact name in plain words (no regular expression)', async () => {
      const { id } = await mkFlight({ seats: 3, number: 'RA 771' });
      const r = await inquire(id, 1, { contactName: 'Ram 123' });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body.message)).toContain('Contact name can only contain letters');
      expect(JSON.stringify(r.body.message)).not.toMatch(/regular expression|\\p\{L\}/);
      const e = await inquire(id, 1, { contactEmail: 'nope', passengers: [{ type: 'ADULT', firstName: '', lastName: 'X' }] });
      const text = JSON.stringify(e.body.message);
      expect(text).toContain('Email address is not a valid email');
      expect(text).toContain('Passenger 1: First name is required');
    });

    it('adjusts the time of one ticket on the same flight and shows it everywhere, without touching the flight', async () => {
      const dep = departure(101, 6);
      const { id } = await mkFlight({ seats: 4, number: 'RA 772', dep });
      const a = await inquire(id, 1);
      const b = await prisma.booking.findUniqueOrThrow({ where: { reference: a.body.reference } });
      await http.post(`/api/admin/bookings/${b.id}/confirm`).set(auth(staff));
      const later = new Date(dep.getTime() + 3 * 3_600_000).toISOString();
      expect((await http.post(`/api/admin/bookings/${b.id}/reschedule`).set(auth(staff)).send({})).status).toBe(400);
      const r = await http.post(`/api/admin/bookings/${b.id}/reschedule`).set(auth(staff)).send({ retimes: [{ direction: 'OUTBOUND', departureAt: later }], note: 'Flight delayed 3 hours' });
      expect(r.status).toBe(200);
      expect(r.body.segments[0].flight.departureAt).toBe(later);
      expect(r.body.segments[0].flight.scheduledDepartureAt).toBe(dep.toISOString());
      expect(r.body.reschedules[0]).toMatchObject({ fromFlightNumber: 'RA 772', toFlightNumber: 'RA 772', note: 'Flight delayed 3 hours' });
      expect((await prisma.flight.findUniqueOrThrow({ where: { id } })).departureAt.toISOString()).toBe(dep.toISOString());
      expect((await http.post(`/api/admin/bookings/${b.id}/reschedule`).set(auth(staff)).send({ retimes: [{ direction: 'OUTBOUND', departureAt: later }] })).status).toBe(400); // same time again
      const cal = await http.get('/api/admin/calendar').query({ month: nepalDate(new Date(later)).slice(0, 7) }).set(auth(staff));
      const day = cal.body.days.find((d: { date: string }) => d.date === nepalDate(new Date(later)));
      expect(JSON.stringify(day)).toContain(b.reference);
      // setting it back to the flight's own time clears the adjustment
      const back = await http.post(`/api/admin/bookings/${b.id}/reschedule`).set(auth(staff)).send({ retimes: [{ direction: 'OUTBOUND', departureAt: dep.toISOString() }] });
      expect(back.body.segments[0].actualDepartureAt).toBeNull();
    });

    it('stores an optional ticket PDF, checks it really is a PDF, and serves it back to booking staff only', async () => {
      const { id } = await mkFlight({ seats: 3, number: 'RA 773', dep: departure(102, 6) });
      const a = await inquire(id, 1);
      const b = await prisma.booking.findUniqueOrThrow({ where: { reference: a.body.reference } });
      const url = `/api/admin/bookings/${b.id}/ticket-files`;
      expect((await http.post(`${url}?filename=t.pdf`).set(auth(staff)).set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.4 test'))).status).toBe(409); // inquiry: too early
      await http.post(`/api/admin/bookings/${b.id}/confirm`).set(auth(staff));
      expect((await http.post(`${url}?filename=t.pdf`).set(auth(staff)).set('Content-Type', 'application/pdf').send(Buffer.from('not a pdf at all'))).status).toBe(400);
      expect((await http.post(`${url}?filename=t.pdf`).set(auth(finance)).set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.4 test'))).status).toBe(403);
      const ok = await http.post(`${url}?filename=Airline ticket.pdf`).set(auth(staff)).set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.4 hello'));
      expect(ok.status).toBe(201);
      const view = await http.get(`/api/admin/bookings/${b.id}`).set(auth(staff));
      expect(view.body.ticketFiles[0]).toMatchObject({ filename: 'Airline ticket.pdf' });
      const dl = await http.get(`${url}/${ok.body.id}`).set(auth(staff));
      expect(dl.status).toBe(200);
      expect(dl.headers['content-type']).toContain('application/pdf');
      expect((await http.get(`${url}/${ok.body.id}`).set(auth(finance))).status).toBe(403);
      expect((await http.delete(`${url}/${ok.body.id}`).set(auth(staff))).status).toBe(204);
    });

    it('counts new website inquiries and open requests for the sidebar red dots', async () => {
      const before = new Date(Date.now() - 1000).toISOString();
      const { id } = await mkFlight({ seats: 3, number: 'RA 775', dep: departure(104, 6) });
      await inquire(id, 1);
      const r = await http.get('/api/admin/badges').query({ inquiriesSince: before, requestsSince: before }).set(auth(staff));
      expect(r.status).toBe(200);
      expect(r.body.inquiries).toBeGreaterThanOrEqual(1);
      const later = await http.get('/api/admin/badges').query({ inquiriesSince: new Date(Date.now() + 60_000).toISOString() }).set(auth(staff));
      expect(later.body.inquiries).toBe(0); // opening the page moves "seen" forward, which clears the dot
      expect((await http.get('/api/admin/badges').set(auth(finance))).status).toBe(403);
    });

    it('lets the customer download their own ticket PDF once ticketed, and nobody else', async () => {
      const { id } = await mkFlight({ seats: 3, number: 'RA 774', dep: departure(103, 6) });
      const a = await inquire(id, 1);
      const ref = a.body.reference as string;
      const b = await prisma.booking.findUniqueOrThrow({ where: { reference: ref } });
      await http.post(`/api/admin/bookings/${b.id}/confirm`).set(auth(staff));
      const up = await http.post(`/api/admin/bookings/${b.id}/ticket-files?filename=mine.pdf`).set(auth(staff)).set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.4 customer copy'));
      const who = { reference: ref, email: 'sita@example.com' };
      expect((await http.post('/api/public/bookings/ticket-file').send({ ...who, fileId: up.body.id })).status).toBe(404); // not ticketed yet
      const pax = await prisma.passenger.findMany({ where: { bookingId: b.id } });
      await http.post(`/api/admin/bookings/${b.id}/ticket`).set(auth(staff)).send({ pnr: 'QWE123', tickets: pax.map((x, i) => ({ passengerId: x.id, ticketNumber: `5551234567${i}` })) });
      const look = await http.post('/api/public/bookings/lookup').send(who);
      expect(look.body.ticketFiles).toEqual([expect.objectContaining({ id: up.body.id, filename: 'mine.pdf' })]);
      const dl = await http.post('/api/public/bookings/ticket-file').send({ ...who, fileId: up.body.id });
      expect(dl.status).toBe(200);
      expect(dl.headers['content-type']).toContain('application/pdf');
      expect((await http.post('/api/public/bookings/ticket-file').send({ ...who, email: 'other@example.com', fileId: up.body.id })).status).toBe(404);
      // the ticket email carries the PDF
      const sent = await prisma.notification.findFirst({ where: { bookingId: b.id, template: 'ticket_issued' } });
      expect(sent).not.toBeNull();
    });

  });

  describe('releasing a hold', () => {
    it('gives held seats back, keeps the inquiry open and can be held again', async () => {
      const { id } = await mkFlight({ seats: 3, number: 'RA 751' });
      const inq = await inquire(id, 2);
      const b = await prisma.booking.findUniqueOrThrow({ where: { reference: inq.body.reference } });
      expect((await http.post(`/api/admin/bookings/${b.id}/release`).set(auth(staff))).status).toBe(200); // not held: unchanged
      expect((await http.post(`/api/admin/bookings/${b.id}/hold`).set(auth(staff)).send({})).status).toBe(200);
      expect((await inventoryOf(id)).held).toBe(2);
      expect((await http.post(`/api/admin/bookings/${b.id}/release`).set(auth(finance))).status).toBe(403);
      const rel = await http.post(`/api/admin/bookings/${b.id}/release`).set(auth(staff));
      expect(rel.status).toBe(200);
      expect(rel.body.status).toBe('INQUIRY');
      expect((await inventoryOf(id)).held).toBe(0);
      const seg = await prisma.bookingSegment.findFirstOrThrow({ where: { bookingId: b.id } });
      expect(seg.seatState).toBe('REQUESTED');
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).holdExpiresAt).toBeNull();
      expect((await http.post(`/api/admin/bookings/${b.id}/hold`).set(auth(staff)).send({})).status).toBe(200); // can hold again
      expect((await inventoryOf(id)).held).toBe(2);
    });
  });

  describe('departure-only flights and passports without expiry', () => {
    it('accepts a route flight with no arrival time and a passport without expiry', async () => {
      const { id } = await mkFlight({ seats: 5, number: 'RA 741' });
      await prisma.flight.update({ where: { id }, data: { arrivalAt: null } });
      const inq = await inquire(id, 1, { passengers: [{ type: 'ADULT', firstName: 'No', lastName: 'Expiry', documentNumber: 'NP7654321', nationality: 'Nepal' }] });
      expect(inq.status).toBe(201);
    });
    it('creates a route flight through the API with a departure time only', async () => {
      const f = await mkFlight({ seats: 3, number: 'RA 742' });
      const full = await prisma.flight.findUniqueOrThrow({ where: { id: f.id } });
      const r = await http.post('/api/admin/flights').set(auth(staff)).send({ airlineId: full.airlineId, flightNumber: 'RA 743', originId: full.originId, destinationId: full.destinationId, departureAt: new Date(Date.now() + 40 * 86_400_000).toISOString(), adultFare: '5000', childFare: '3000', seatsAllocated: 4 });
      expect(r.status).toBe(201);
      expect(r.body.arrivalAt).toBeNull();
    });
  });

  // ───────────── input validation ─────────────

  describe('input validation', () => {
    it('rejects unknown fields (mass assignment) and invalid values', async () => {
      const { id } = await mkFlight({ seats: 5, number: 'RA 102' });
      const r = await inquire(id, 1, { status: 'CONFIRMED' });
      expect(r.status).toBe(400);
      expect((await inquire(id, 1, { contactEmail: 'nope' })).status).toBe(400);
      expect((await http.post('/api/admin/users').set(auth(admin)).send({ email: 'a@b.co', name: 'x', password: 'short', role: 'SUPER_ADMIN' })).status).toBe(400);
      expect((await http.get('/api/public/flights/search').query({ origin: 'ktm' })).status).toBe(400);
    });

    it('answers oversized and malformed bodies with 413 / 400, not 500', async () => {
      const big = await http.post('/api/public/bookings/lookup').set('Content-Type', 'application/json').send(JSON.stringify({ reference: 'a'.repeat(200_000), email: 'a@b.co' }));
      expect(big.status).toBe(413);
      const bad = await http.post('/api/public/bookings/lookup').set('Content-Type', 'application/json').send('{"reference": ');
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).not.toMatch(/SyntaxError|at\s|node_modules/);
    });

    it('never leaks internals in error responses', async () => {
      const r = await http.get('/api/admin/bookings/not-a-uuid').set(auth(staff));
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).not.toMatch(/prisma|postgres|node_modules|at\s.+\(/i);
    });
  });

  // ───────────── search & inventory filtering ─────────────

  describe('flight search', () => {
    it('shows only matching, bookable departures with enough seats', async () => {
      const day = departure(20, 5);
      const plenty = await mkFlight({ seats: 20, number: 'RA 201', dep: day });
      await mkFlight({ seats: 2, number: 'RA 202', dep: departure(20, 7) });
      await mkFlight({ seats: 0, number: 'RA 203', dep: departure(20, 9) });
      const closed = await mkFlight({ seats: 20, number: 'RA 204', dep: departure(20, 11) });
      await http.patch(`/api/admin/flights/${closed.id}`).set(auth(staff)).send({ status: 'CLOSED' });
      await mkFlight({ seats: 20, number: 'RA 205', dep: departure(20, 13), from: pkr, to: ktm }); // wrong direction

      const q = { origin: 'KTM', destination: 'PKR', departureDate: nepalDate(day), tripType: 'ONE_WAY' };
      const one = await http.get('/api/public/flights/search').query({ ...q, adults: 1 });
      expect(one.body.outbound.map((f: { flightNumber: string }) => f.flightNumber).sort()).toEqual(['RA 201', 'RA 202']);

      const three = await http.get('/api/public/flights/search').query({ ...q, adults: 2, children: 1 });
      // a flight with too few seats is still listed (flagged), so the site can say "only 2 remaining"
      const byNo3 = Object.fromEntries(three.body.outbound.map((f: { flightNumber: string }) => [f.flightNumber, f]));
      expect(Object.keys(byNo3).sort()).toEqual(['RA 201', 'RA 202']);
      expect(byNo3['RA 201'].estimatedTotal).toBe('15200.00'); // 2×5500 + 1×4200
      expect(byNo3['RA 201'].id).toBe(plenty.id);
      expect(byNo3['RA 201'].fitsParty).toBe(true);
      expect(byNo3['RA 202'].fitsParty).toBe(false);
      expect(byNo3['RA 202'].seatsAvailable).toBe(2);
      expect(one.body.outbound.every((f: { fitsParty: boolean }) => f.fitsParty)).toBe(true);
    });

    it('without a date lists every upcoming departure on the route with the real seats left', async () => {
      await mkFlight({ seats: 14, number: 'RA 251', dep: departure(40, 5) });
      await mkFlight({ seats: 3, number: 'RA 252', dep: departure(45, 7) });
      const r = await http.get('/api/public/flights/search').query({ origin: 'KTM', destination: 'PKR', tripType: 'ONE_WAY', adults: 1 });
      expect(r.status).toBe(200);
      const byNo = Object.fromEntries(r.body.outbound.map((f: { flightNumber: string; seatsAvailable: number }) => [f.flightNumber, f]));
      expect(byNo['RA 251'].seatsAvailable).toBe(14); // exact count, not capped
      expect(byNo['RA 252'].seatsAvailable).toBe(3);
      expect(byNo['RA 251'].airline).toEqual(expect.objectContaining({ code: expect.any(String), name: expect.any(String), logoUrl: null }));
      const dates = r.body.outbound.map((f: { departureAt: string }) => f.departureAt);
      expect([...dates].sort()).toEqual(dates); // soonest first
    });

    it('validates each round-trip leg independently and returns nothing if either leg is unavailable', async () => {
      const out = departure(30, 5);
      const back = departure(33, 5);
      await mkFlight({ seats: 10, number: 'RA 301', dep: out });
      const q = { origin: 'KTM', destination: 'PKR', departureDate: nepalDate(out), returnDate: nepalDate(back), tripType: 'ROUND_TRIP', adults: 1 };
      const none = await http.get('/api/public/flights/search').query(q);
      expect(none.body).toEqual({ outbound: [], return: [] }); // no return flight exists

      await mkFlight({ seats: 10, number: 'RA 302', dep: back, from: pkr, to: ktm });
      const both = await http.get('/api/public/flights/search').query(q);
      expect(both.body.outbound).toHaveLength(1);
      expect(both.body.return).toHaveLength(1);
      expect((await http.get('/api/public/flights/search').query({ ...q, returnDate: undefined })).status).toBe(400);
    });
  });

  // ───────────── sectors (mountain flights) and the customer's wanted date ─────────────

  describe('sector flights', () => {
    let sectorId: string;
    const mkSectorFlight = (number: string, dep: Date, seats = 6) =>
      request(server()).post('/api/admin/flights').set(auth(staff)).send({ airlineId: airline, flightNumber: number, sectorId, departureAt: dep.toISOString(), adultFare: '9000', childFare: '9000', seatsAllocated: seats });

    it('lets staff add a sector with a single name, and shows it publicly', async () => {
      const r = await request(server()).post('/api/admin/sectors').set(auth(staff)).send({ name: 'Everest Mountain Flight' });
      expect(r.status).toBe(201);
      sectorId = r.body.id;
      expect((await request(server()).post('/api/admin/sectors').set(auth(staff)).send({ name: 'Everest Mountain Flight' })).status).toBe(409);
      expect((await request(server()).post('/api/admin/sectors').set(auth(finance)).send({ name: 'Other' })).status).toBe(403);
      const pub = await request(server()).get('/api/public/sectors');
      expect(pub.body).toEqual([{ id: sectorId, name: 'Everest Mountain Flight' }]);
    });

    it('creates a sector flight with no airports or arrival, and rejects mixed or incomplete flights', async () => {
      const ok = await mkSectorFlight('RA 901', departure(12, 6));
      expect(ok.status).toBe(201);
      expect(ok.body.origin).toBeNull();
      expect(ok.body.destination).toBeNull();
      expect(ok.body.arrivalAt).toBeNull();
      expect(ok.body.sector.name).toBe('Everest Mountain Flight');
      const mixed = await request(server()).post('/api/admin/flights').set(auth(staff)).send({ airlineId: airline, flightNumber: 'RA 902', sectorId, originId: ktm, departureAt: departure(12, 8).toISOString(), adultFare: '1', childFare: '1', seatsAllocated: 1 });
      expect(mixed.status).toBe(400);
      const incomplete = await request(server()).post('/api/admin/flights').set(auth(staff)).send({ airlineId: airline, flightNumber: 'RA 903', originId: ktm, destinationId: pkr, departureAt: departure(12, 8).toISOString(), adultFare: '1', childFare: '1', seatsAllocated: 1 });
      expect(incomplete.status).toBe(201); // arrival time is optional on a route flight
      const noDestination = await request(server()).post('/api/admin/flights').set(auth(staff)).send({ airlineId: airline, flightNumber: 'RA 904', originId: ktm, departureAt: departure(12, 9).toISOString(), adultFare: '1', childFare: '1', seatsAllocated: 1 });
      expect(noDestination.status).toBe(400); // but origin and destination are still required
    });

    it('is found by sector (with or without a date), one way only', async () => {
      await mkSectorFlight('RA 911', departure(14, 6), 4);
      const q = { sectorId, tripType: 'ONE_WAY', adults: 1 };
      const all = await request(server()).get('/api/public/flights/search').query(q);
      expect(all.status).toBe(200);
      const f = all.body.outbound.find((x: { flightNumber: string }) => x.flightNumber === 'RA 911');
      expect(f.seatsAvailable).toBe(4);
      expect(f.sector.name).toBe('Everest Mountain Flight');
      expect(f.origin).toBeNull();
      const dated = await request(server()).get('/api/public/flights/search').query({ ...q, departureDate: nepalDate(departure(14, 6)) });
      expect(dated.body.outbound.map((x: { flightNumber: string }) => x.flightNumber)).toEqual(['RA 911']);
      expect((await request(server()).get('/api/public/flights/search').query({ ...q, tripType: 'ROUND_TRIP' })).status).toBe(400);
      expect((await request(server()).get('/api/public/flights/search').query({ tripType: 'ONE_WAY', adults: 1 })).status).toBe(400); // needs a route or a sector
    });

    it('keeps the wanted date, lets staff edit it, and moves the booking only to another flight of the same sector', async () => {
      const a = await mkSectorFlight('RA 921', departure(20, 6));
      const b = await mkSectorFlight('RA 922', departure(21, 6));
      const wanted = nepalDate(departure(21, 6));
      const inq = await inquire(a.body.id, 1, { requestedDate: wanted });
      expect(inq.status).toBe(201);
      expect((await inquire(a.body.id, 1, { tripType: 'ROUND_TRIP', returnFlightId: b.body.id })).status).toBe(400); // sector flights are one way
      const row = await prisma.booking.findFirstOrThrow({ where: { reference: inq.body.reference } });
      expect(row.requestedDate?.toISOString().slice(0, 10)).toBe(wanted);

      const detail = await request(server()).get(`/api/admin/bookings/${row.id}`).set(auth(staff));
      expect(detail.body.requestedDate.slice(0, 10)).toBe(wanted);
      expect(detail.body.segments[0].flight.sector.name).toBe('Everest Mountain Flight');

      const edited = await request(server()).patch(`/api/admin/bookings/${row.id}/dates`).set(auth(staff)).send({ requestedDate: nepalDate(departure(20, 6)) });
      expect(edited.status).toBe(200);
      expect(edited.body.requestedDate.slice(0, 10)).toBe(nepalDate(departure(20, 6)));
      const cleared = await request(server()).patch(`/api/admin/bookings/${row.id}/dates`).set(auth(staff)).send({ requestedDate: '' });
      expect(cleared.body.requestedDate).toBeNull();
      expect((await request(server()).patch(`/api/admin/bookings/${row.id}/dates`).set(auth(finance)).send({ requestedDate: wanted })).status).toBe(403);

      const move = await request(server()).post(`/api/admin/bookings/${row.id}/reschedule`).set(auth(staff)).send({ changes: [{ direction: 'OUTBOUND', newFlightId: b.body.id }] });
      expect(move.status).toBe(200);
      expect(move.body.segments[0].flight.flightNumber).toBe('RA 922');
      const route = await mkFlight({ seats: 5, number: 'RA 923', dep: departure(22, 6) });
      const wrong = await request(server()).post(`/api/admin/bookings/${row.id}/reschedule`).set(auth(staff)).send({ changes: [{ direction: 'OUTBOUND', newFlightId: route.id }] });
      expect(wrong.status).toBe(400); // a route flight is not on the same sector
    });
  });

  // ───────────── deleting ─────────────

  describe('deleting records', () => {
    const idOf = async (reference: string) => (await prisma.booking.findFirstOrThrow({ where: { reference } })).id;

    it('deletes an inquiry, gives its held seats back, and answers 404 afterwards', async () => {
      const f = await mkFlight({ seats: 5, number: 'RA 951', dep: departure(25) });
      const inq = await inquire(f.id, 2);
      const id = await idOf(inq.body.reference);
      expect((await http.post(`/api/admin/bookings/${id}/hold`).set(auth(staff)).send({})).status).toBe(200);
      expect((await inventoryOf(f.id)).held).toBe(2);
      expect((await http.delete(`/api/admin/bookings/${id}`).set(auth(finance))).status).toBe(403);
      expect((await http.delete(`/api/admin/bookings/${id}`).set(auth(staff))).status).toBe(204);
      expect((await inventoryOf(f.id)).held).toBe(0);
      expect((await http.get(`/api/admin/bookings/${id}`).set(auth(staff))).status).toBe(404);
      expect((await http.delete(`/api/admin/bookings/${id}`).set(auth(staff))).status).toBe(404);
      expect((await prisma.auditLog.findFirst({ where: { action: 'booking.delete', entityId: id } }))?.detail).toMatchObject({ reference: inq.body.reference });
    });

    it('lets only a Super Admin delete a booking that has payment records, and removes them with it', async () => {
      const f = await mkFlight({ seats: 5, number: 'RA 952', dep: departure(26) });
      const inq = await inquire(f.id, 1);
      const id = await idOf(inq.body.reference);
      expect((await http.post(`/api/admin/bookings/${id}/confirm`).set(auth(staff))).status).toBe(200);
      expect((await http.post(`/api/admin/bookings/${id}/payments`).set(auth(finance)).send({ amount: '1000', method: 'CASH', idempotencyKey: randomUUID() })).status).toBe(201);
      expect((await http.delete(`/api/admin/bookings/${id}`).set(auth(staff))).status).toBe(403);
      expect((await http.delete(`/api/admin/bookings/${id}`).set(auth(admin))).status).toBe(204);
      expect(await prisma.payment.count({ where: { bookingId: id } })).toBe(0);
      expect((await inventoryOf(f.id)).confirmed).toBe(0);
    });

    it('refuses to delete something that is still in use, and deletes it once it is free', async () => {
      const f = await mkFlight({ seats: 5, number: 'RA 953', dep: departure(27) });
      const inq = await inquire(f.id, 1);
      const id = await idOf(inq.body.reference);
      const busy = await http.delete(`/api/admin/flights/${f.id}`).set(auth(staff));
      expect(busy.status).toBe(409);
      expect(busy.body.message).toMatch(/Delete or move/);
      expect((await http.delete(`/api/admin/bookings/${id}`).set(auth(staff))).status).toBe(204);
      expect((await http.delete(`/api/admin/flights/${f.id}`).set(auth(staff))).status).toBe(204);
      expect(await prisma.flight.count({ where: { id: f.id } })).toBe(0);

      const sec = (await http.post('/api/admin/sectors').set(auth(staff)).send({ name: 'Delete Me Sector' })).body.id;
      const sf = await http.post('/api/admin/flights').set(auth(staff)).send({ airlineId: airline, flightNumber: 'RA 954', sectorId: sec, departureAt: departure(28).toISOString(), adultFare: '1', childFare: '1', seatsAllocated: 2 });
      expect((await http.delete(`/api/admin/sectors/${sec}`).set(auth(staff))).status).toBe(409);
      expect((await http.delete(`/api/admin/flights/${sf.body.id}`).set(auth(staff))).status).toBe(204);
      expect((await http.delete(`/api/admin/sectors/${sec}`).set(auth(staff))).status).toBe(204);
    });

    it('deletes unused airlines and airports, but only for a Super Admin, and not while flights use them', async () => {
      const al = (await http.post('/api/admin/airlines').set(auth(admin)).send({ code: 'ZX', name: 'Temp Air' })).body.id;
      const ap = (await http.post('/api/admin/airports').set(auth(admin)).send({ iata: 'ZZZ', name: 'Temp Airport', city: 'Temp' })).body.id;
      expect((await http.delete(`/api/admin/airlines/${al}`).set(auth(staff))).status).toBe(403);
      expect((await http.delete(`/api/admin/airlines/${airline}`).set(auth(admin))).status).toBe(409); // the shared test airline has flights
      expect((await http.delete(`/api/admin/airports/${ktm}`).set(auth(admin))).status).toBe(409);
      expect((await http.delete(`/api/admin/airlines/${al}`).set(auth(admin))).status).toBe(204);
      expect((await http.delete(`/api/admin/airports/${ap}`).set(auth(admin))).status).toBe(204);
    });
  });

  // ───────────── inventory integrity ─────────────

  describe('inventory', () => {
    it('does not touch inventory on an inquiry, and confirmation is idempotent', async () => {
      const { id } = await mkFlight({ seats: 4, number: 'RA 401' });
      const ref = (await inquire(id, 2)).body.reference;
      expect(await inventoryOf(id)).toMatchObject({ total: 4, held: 0, confirmed: 0, ticketed: 0 });

      const b = await prisma.booking.findUniqueOrThrow({ where: { reference: ref } });
      expect((await http.post(`/api/admin/bookings/${b.id}/confirm`).set(auth(staff))).body.status).toBe('CONFIRMED');
      expect((await http.post(`/api/admin/bookings/${b.id}/confirm`).set(auth(staff))).status).toBe(200); // repeat
      expect(await inventoryOf(id)).toMatchObject({ total: 4, held: 0, confirmed: 2 }); // counted once
    });

    it('never overbooks under concurrent confirmations', async () => {
      const { id } = await mkFlight({ seats: 3, number: 'RA 402' });
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const ref = (await inquire(id, 1)).body.reference;
        ids.push((await prisma.booking.findUniqueOrThrow({ where: { reference: ref } })).id);
      }
      const results = await Promise.all(ids.map((b) => http.post(`/api/admin/bookings/${b}/confirm`).set(auth(staff))));
      const ok = results.filter((r) => r.status === 200).length;
      const conflict = results.filter((r) => r.status === 409).length;
      expect(ok).toBe(3);
      expect(conflict).toBe(7);
      expect(await inventoryOf(id)).toMatchObject({ total: 3, confirmed: 3, held: 0 });
    });

    it('survives concurrent duplicate confirmation of the SAME booking without double counting', async () => {
      const { id } = await mkFlight({ seats: 5, number: 'RA 403' });
      const ref = (await inquire(id, 2)).body.reference;
      const b = await prisma.booking.findUniqueOrThrow({ where: { reference: ref } });
      const rs = await Promise.all(Array.from({ length: 6 }, () => http.post(`/api/admin/bookings/${b.id}/confirm`).set(auth(staff))));
      expect(rs.every((r) => r.status === 200)).toBe(true);
      expect(await inventoryOf(id)).toMatchObject({ confirmed: 2 });
    });

    it('does not let a two-leg booking half-commit when one leg is full (atomic)', async () => {
      const out = await mkFlight({ seats: 5, number: 'RA 404', dep: departure(40, 5) });
      const back = await mkFlight({ seats: 1, number: 'RA 405', dep: departure(43, 5), from: pkr, to: ktm });
      const ref = (await inquire(out.id, 1, { tripType: 'ROUND_TRIP', returnFlightId: back.id })).body.reference;
      const other = (await inquire(back.id, 1)).body.reference;
      const ob = await prisma.booking.findUniqueOrThrow({ where: { reference: other } });
      await http.post(`/api/admin/bookings/${ob.id}/confirm`).set(auth(staff)); // takes the last return seat

      const rt = await prisma.booking.findUniqueOrThrow({ where: { reference: ref } });
      const r = await http.post(`/api/admin/bookings/${rt.id}/confirm`).set(auth(staff));
      expect(r.status).toBe(409);
      expect(await inventoryOf(out.id)).toMatchObject({ confirmed: 0, held: 0 }); // outbound leg rolled back
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: rt.id } })).status).toBe('INQUIRY');
    });

    it('holds, expires and releases seats; cancellation returns seats to the pool', async () => {
      const { id } = await mkFlight({ seats: 2, number: 'RA 406' });
      const ref = (await inquire(id, 2)).body.reference;
      const b = await prisma.booking.findUniqueOrThrow({ where: { reference: ref } });

      expect((await http.post(`/api/admin/bookings/${b.id}/hold`).set(auth(staff)).send({ minutes: 30 })).body.status).toBe('HELD');
      expect(await inventoryOf(id)).toMatchObject({ held: 2 });
      // Seats are really unavailable to others now: a new inquiry is refused, not silently over-promised.
      expect((await inquire(id, 1)).status).toBe(400);

      await prisma.booking.update({ where: { id: b.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
      expect(await bookings.releaseExpiredHolds()).toBe(1);
      expect(await bookings.releaseExpiredHolds()).toBe(0); // idempotent sweep
      expect(await inventoryOf(id)).toMatchObject({ held: 0 });
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('EXPIRED');

      const ref2 = (await inquire(id, 2)).body.reference;
      const b2 = await prisma.booking.findUniqueOrThrow({ where: { reference: ref2 } });
      await http.post(`/api/admin/bookings/${b2.id}/confirm`).set(auth(staff));
      expect(await inventoryOf(id)).toMatchObject({ confirmed: 2 });
      expect((await http.post(`/api/admin/bookings/${b2.id}/cancel`).set(auth(staff)).send({ reason: 'customer request' })).body.status).toBe('CANCELLED');
      expect(await inventoryOf(id)).toMatchObject({ confirmed: 0 });
    });

    it('refuses to reduce the allocation below existing commitments and records adjustments', async () => {
      const { id } = await mkFlight({ seats: 5, number: 'RA 407' });
      const b = await prisma.booking.findUniqueOrThrow({ where: { reference: (await inquire(id, 3)).body.reference } });
      await http.post(`/api/admin/bookings/${b.id}/confirm`).set(auth(staff));

      const bad = await http.post(`/api/admin/flights/${id}/inventory/adjust`).set(auth(admin)).send({ delta: -3, reason: 'airline reclaimed seats' });
      expect(bad.status).toBe(409);
      const good = await http.post(`/api/admin/flights/${id}/inventory/adjust`).set(auth(admin)).send({ delta: -2, reason: 'airline reclaimed seats' });
      expect(good.status).toBe(201);
      expect(good.body.inventory.total).toBe(3);
      expect(good.body.adjustments[0]).toMatchObject({ delta: -2, totalBefore: 5, totalAfter: 3, reason: 'airline reclaimed seats' });
      expect((await http.post(`/api/admin/flights/${id}/inventory/adjust`).set(auth(admin)).send({ delta: -1 })).status).toBe(400); // reason mandatory
    });

    it('database CHECK constraints reject overbooking even if application code is bypassed', async () => {
      const { id } = await mkFlight({ seats: 2, number: 'RA 408' });
      await expect(prisma.$executeRaw`UPDATE "FlightInventory" SET confirmed = 3 WHERE "flightId" = ${id}::uuid`).rejects.toBeTruthy();
    });
  });

  // ───────────── customer lookup ─────────────

  describe('booking lookup', () => {
    it('requires reference AND matching email, with identical failures', async () => {
      const { id } = await mkFlight({ seats: 5, number: 'RA 501' });
      const ref = (await inquire(id, 1)).body.reference as string;
      const ok = await http.post('/api/public/bookings/lookup').send({ reference: ref.toLowerCase(), email: 'sita@example.com' });
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('PENDING');
      expect(JSON.stringify(ok.body)).not.toMatch(/sita@example|9800000000/); // contact data not echoed back

      const wrongEmail = await http.post('/api/public/bookings/lookup').send({ reference: ref, email: 'other@example.com' });
      const wrongRef = await http.post('/api/public/bookings/lookup').send({ reference: 'MT-AAAAA-BBBBB', email: 'sita@example.com' });
      expect(wrongEmail.status).toBe(404);
      expect(wrongRef.status).toBe(404);
      expect(wrongEmail.body).toEqual(wrongRef.body);
    });

    it('validates itinerary rules on inquiry', async () => {
      const a = await mkFlight({ seats: 5, number: 'RA 502', dep: departure(50, 5) });
      const sameDirection = await mkFlight({ seats: 5, number: 'RA 503', dep: departure(52, 5) });
      expect((await inquire(a.id, 1, { tripType: 'ROUND_TRIP', returnFlightId: sameDirection.id })).status).toBe(400);
      expect((await inquire(a.id, 1, { tripType: 'ROUND_TRIP' })).status).toBe(400);
      expect((await inquire(a.id, 1, { passengers: [{ type: 'INFANT', firstName: 'Baby', lastName: 'X' }] })).status).toBe(400);
      expect((await inquire(a.id, 20)).status).toBe(400);
    });
  });

  // ───────────── email + tickets ─────────────

  describe('customer emails and ticketing', () => {
    const waitFor = async <T>(fn: () => Promise<T | null | undefined>, ms = 3000): Promise<T> => {
      const end = Date.now() + ms;
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    it('does not show the reference in the response; it is recorded as an email to the customer', async () => {
      const { id } = await mkFlight({ seats: 5, number: 'RA 601' });
      const res = await request(server()).post('/api/public/bookings/inquiry').send({
        tripType: 'ONE_WAY', outboundFlightId: id, contactName: 'Mina Rai', contactEmail: 'Mina@Example.com', contactPhone: '9800000001', passengers: passengers(1),
      });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ received: true });
      expect(JSON.stringify(res.body)).not.toMatch(/MT-/);
      const b = await prisma.booking.findFirstOrThrow({ where: { contactEmail: 'mina@example.com' } });
      const n = await waitFor(() => prisma.notification.findFirst({ where: { bookingId: b.id, template: 'inquiry_received', status: { not: 'PENDING' } } }));
      expect(n.toEmail).toBe('mina@example.com');
      expect(JSON.stringify(await prisma.notification.findMany({ where: { bookingId: b.id } }))).not.toContain('NaN');
      expect(n.status).toBe('NOT_CONFIGURED'); // no SMTP in tests: honestly recorded as not sent
    });

    it('walks Pending -> Approved -> Ticketed for the customer, emailing at each step, and records PNR and ticket numbers', async () => {
      const { id } = await mkFlight({ seats: 5, number: 'RA 602' });
      const ref = (await inquire(id, 2)).body.reference as string;
      const b = await prisma.booking.findUniqueOrThrow({ where: { reference: ref }, include: { passengers: true } });
      const look = () => http.post('/api/public/bookings/lookup').send({ reference: ref, email: 'sita@example.com' });

      expect((await look()).body.status).toBe('PENDING');
      // Cannot ticket before approval, and finance cannot ticket.
      const tkts = b.passengers.map((p, i) => ({ passengerId: p.id, ticketNumber: `1234567890${i}` }));
      expect((await http.post(`/api/admin/bookings/${b.id}/ticket`).set(auth(staff)).send({ pnr: 'ABC123', tickets: tkts })).status).toBe(409);

      await http.post(`/api/admin/bookings/${b.id}/confirm`).set(auth(staff));
      const approved = await look();
      expect(approved.body.status).toBe('APPROVED');
      expect(approved.body.pnr).toBeNull(); // never shown before a ticket exists
      await waitFor(() => prisma.notification.findFirst({ where: { bookingId: b.id, template: 'booking_approved' } }));

      expect((await http.post(`/api/admin/bookings/${b.id}/ticket`).set(auth(finance)).send({ pnr: 'ABC123', tickets: tkts })).status).toBe(403);
      // Validation: every passenger needs a number; numbers must differ; PNR format.
      expect((await http.post(`/api/admin/bookings/${b.id}/ticket`).set(auth(staff)).send({ pnr: 'ABC123', tickets: tkts.slice(0, 1) })).status).toBe(400);
      expect((await http.post(`/api/admin/bookings/${b.id}/ticket`).set(auth(staff)).send({ pnr: 'ABC123', tickets: tkts.map((t) => ({ ...t, ticketNumber: '1234567890' })) })).status).toBe(400);
      expect((await http.post(`/api/admin/bookings/${b.id}/ticket`).set(auth(staff)).send({ pnr: '!!', tickets: tkts })).status).toBe(400);

      const issued = await http.post(`/api/admin/bookings/${b.id}/ticket`).set(auth(staff)).send({ pnr: 'abc123', tickets: tkts });
      expect(issued.status).toBe(200);
      expect(issued.body.status).toBe('TICKETED');
      expect(await inventoryOf(id)).toMatchObject({ confirmed: 0, ticketed: 2 }); // moved, not double counted

      const done = await look();
      expect(done.body.status).toBe('TICKETED');
      expect(done.body.pnr).toBe('ABC123');
      expect(done.body.passengers.map((p: { ticketNumber: string }) => p.ticketNumber).sort()).toEqual(['12345678900', '12345678901']);

      const mail = await waitFor(() => prisma.notification.findFirst({ where: { bookingId: b.id, template: 'ticket_issued' } }));
      expect(mail.toEmail).toBe('sita@example.com');
      // Re-submitting is a no-op: recorded numbers are never overwritten.
      await http.post(`/api/admin/bookings/${b.id}/ticket`).set(auth(staff)).send({ pnr: 'ZZZ999', tickets: tkts.map((t) => ({ ...t, ticketNumber: `9999999${t.ticketNumber.slice(-1)}` })) });
      expect((await look()).body.pnr).toBe('ABC123');
      expect(await prisma.notification.count({ where: { bookingId: b.id, template: 'ticket_issued' } })).toBe(1);
      // Staff may cancel a ticketed booking (refund is decided manually); the ticketed seats return to the pool.
      expect((await http.post(`/api/admin/bookings/${b.id}/cancel`).set(auth(staff)).send({ reason: 'test cancel' })).body.status).toBe('CANCELLED');
      expect(await inventoryOf(id)).toMatchObject({ confirmed: 0, ticketed: 0 });
    });

    it('maps rejection to Declined for the customer', async () => {
      const { id } = await mkFlight({ seats: 5, number: 'RA 603' });
      const ref = (await inquire(id, 1)).body.reference as string;
      const b = await prisma.booking.findUniqueOrThrow({ where: { reference: ref } });
      await http.post(`/api/admin/bookings/${b.id}/reject`).set(auth(staff)).send({ reason: 'no seats with airline' });
      expect((await http.post('/api/public/bookings/lookup').send({ reference: ref, email: 'sita@example.com' })).body.status).toBe('DECLINED');
    });
  });

  // ───────────── customer requests + rescheduling ─────────────

  describe('cancellation / refund and reschedule requests', () => {
    const waitFor = async <T>(fn: () => Promise<T | null | undefined>, ms = 3000): Promise<T> => {
      const end = Date.now() + ms;
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const ask = (reference: string, type: string, extra: Record<string, unknown> = {}, email = 'sita@example.com') =>
      http.post('/api/public/bookings/request').send({ reference, email, type, message: 'I cannot travel any more', ...extra });
    const approved = async (flightId: string, n = 1) => {
      const ref = (await inquire(flightId, n)).body.reference as string;
      const b = await prisma.booking.findUniqueOrThrow({ where: { reference: ref } });
      await http.post(`/api/admin/bookings/${b.id}/confirm`).set(auth(staff));
      return { ref, id: b.id };
    };

    it('lets a customer ask for a refund without stating an amount, emails staff and the customer, and allows one open request only', async () => {
      const f = await mkFlight({ seats: 5, number: 'RA 701' });
      const { ref, id } = await approved(f.id);

      expect((await ask(ref, 'CANCEL_REFUND', { refundAmount: '9999' })).status).toBe(400); // customers cannot name an amount
      expect((await ask(ref, 'CANCEL_REFUND', {}, 'wrong@example.com')).status).toBe(404); // must verify like lookup
      expect((await ask(ref, 'CANCEL_REFUND')).status).toBe(201);
      expect((await ask(ref, 'CANCEL_REFUND')).status).toBe(409); // no duplicates

      await waitFor(async () => ((await prisma.notification.count({ where: { bookingId: id, template: 'request_staff_alert' } })) === 2 ? true : null));
      const to = (await prisma.notification.findMany({ where: { bookingId: id, template: 'request_staff_alert' } })).map((n) => n.toEmail).sort();
      expect(to).toEqual(['staff1@agency.test', 'staff2@agency.test']);
      await waitFor(() => prisma.notification.findFirst({ where: { bookingId: id, template: 'request_received', toEmail: 'sita@example.com' } }));

      const look = await http.post('/api/public/bookings/lookup').send({ reference: ref, email: 'sita@example.com' });
      expect(look.body.requests).toEqual([expect.objectContaining({ type: 'CANCEL_REFUND', status: 'OPEN' })]);
      expect((await ask(ref, 'RESCHEDULE', { preferredDate: '2030-01-05' })).status).toBe(201); // a different type is allowed
    });

    it('protects the staff queue and enforces the workflow: cancel first, then mark done with a staff-decided refund', async () => {
      const f = await mkFlight({ seats: 5, number: 'RA 702' });
      const { ref, id } = await approved(f.id);
      await ask(ref, 'CANCEL_REFUND');
      const reqId = (await prisma.changeRequest.findFirstOrThrow({ where: { bookingId: id } })).id;

      expect((await http.get('/api/admin/requests')).status).toBe(401);
      expect((await http.get('/api/admin/requests').set(auth(finance))).status).toBe(403);
      const open = await http.get('/api/admin/requests?status=OPEN').set(auth(staff));
      expect(open.body.some((r: { id: string }) => r.id === reqId)).toBe(true);

      // cannot mark done while the booking is still active
      expect((await http.post(`/api/admin/requests/${reqId}/resolve`).set(auth(staff)).send({ status: 'DONE' })).status).toBe(409);
      await http.post(`/api/admin/bookings/${id}/cancel`).set(auth(staff)).send({ reason: 'customer requested' });
      expect((await http.post(`/api/admin/requests/${reqId}/resolve`).set(auth(staff)).send({ status: 'DONE', refundAmount: '-5' })).status).toBe(400);
      const done = await http.post(`/api/admin/requests/${reqId}/resolve`).set(auth(staff)).send({ status: 'DONE', refundAmount: '4000', note: 'Refund by bank transfer in 7 days' });
      expect(done.status).toBe(200);
      expect((await http.post(`/api/admin/requests/${reqId}/resolve`).set(auth(staff)).send({ status: 'DONE' })).status).toBe(409); // closed once
      const row = await prisma.changeRequest.findUniqueOrThrow({ where: { id: reqId } });
      expect(row.status).toBe('DONE');
      expect(row.refundAmount?.toString()).toBe('4000');
      const mail = await waitFor(() => prisma.notification.findFirst({ where: { bookingId: id, template: 'request_resolved' } }));
      expect(mail.toEmail).toBe('sita@example.com');
      // a cancelled booking cannot raise new requests
      expect((await ask(ref, 'CANCEL_REFUND')).status).toBe(409);
    });

    it('reschedules atomically between flights, marks the booking rescheduled and keeps the original flight', async () => {
      const dayA = departure(60, 4), dayB = departure(61, 4);
      const a = await mkFlight({ seats: 5, number: 'RA 711', dep: dayA });
      const b2 = await mkFlight({ seats: 5, number: 'RA 712', dep: dayB });
      const full = await mkFlight({ seats: 0, number: 'RA 713', dep: dayB });
      const wrongRoute = await mkFlight({ seats: 5, number: 'RA 714', dep: dayB, from: pkr, to: ktm });
      const { ref, id } = await approved(a.id, 2);
      const re = (flight: string, extra = {}) => http.post(`/api/admin/bookings/${id}/reschedule`).set(auth(staff)).send({ changes: [{ direction: 'OUTBOUND', newFlightId: flight }], ...extra });

      expect((await re(full.id)).status).toBe(409); // no seats: nothing changes
      expect((await re(wrongRoute.id)).status).toBe(400);
      expect((await re(a.id)).status).toBe(400); // same flight
      expect((await http.post(`/api/admin/bookings/${id}/reschedule`).set(auth(finance)).send({ changes: [] })).status).toBe(403);
      expect(await inventoryOf(a.id)).toMatchObject({ confirmed: 2 });

      const ok = await re(b2.id, { note: 'customer asked for next day' });
      expect(ok.status).toBe(200);
      expect(ok.body.rescheduledCount).toBe(1);
      expect(ok.body.segments[0].flight.flightNumber).toBe('RA 712');
      expect(await inventoryOf(a.id)).toMatchObject({ confirmed: 0 }); // old seats released
      expect(await inventoryOf(b2.id)).toMatchObject({ confirmed: 2 }); // new seats taken
      expect(await inventoryOf(full.id)).toMatchObject({ confirmed: 0 });
      const seg = await prisma.bookingSegment.findFirstOrThrow({ where: { bookingId: id } });
      expect(seg.originalFlightId).toBe(a.id); // original itinerary preserved

      const look = await http.post('/api/public/bookings/lookup').send({ reference: ref, email: 'sita@example.com' });
      expect(look.body.rescheduled).toBe(true);
      expect(look.body.status).toBe('APPROVED');
      await waitFor(() => prisma.notification.findFirst({ where: { bookingId: id, template: 'booking_rescheduled' } }));

      // Rescheduling again keeps the FIRST original flight and counts twice.
      await re(a.id);
      expect((await prisma.bookingSegment.findFirstOrThrow({ where: { bookingId: id } })).originalFlightId).toBe(a.id);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id } })).rescheduledCount).toBe(2);
      expect(await inventoryOf(a.id)).toMatchObject({ confirmed: 2 });
      expect(await inventoryOf(b2.id)).toMatchObject({ confirmed: 0 });
    });

    it('never oversells when two reschedules race for the last seats', async () => {
      const target = await mkFlight({ seats: 2, number: 'RA 721', dep: departure(70, 4) });
      const src = await mkFlight({ seats: 10, number: 'RA 722', dep: departure(69, 4) });
      const bookings = [] as string[];
      for (let i = 0; i < 4; i++) bookings.push((await approved(src.id, 1)).id);
      const rs = await Promise.all(bookings.map((bid) => http.post(`/api/admin/bookings/${bid}/reschedule`).set(auth(staff)).send({ changes: [{ direction: 'OUTBOUND', newFlightId: target.id }] })));
      expect(rs.filter((r) => r.status === 200)).toHaveLength(2);
      expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
      expect(await inventoryOf(target.id)).toMatchObject({ confirmed: 2 });
      expect(await inventoryOf(src.id)).toMatchObject({ confirmed: 2 }); // the two that failed still hold their original seats
    });

    it('reschedules a ticketed booking and can record reissued ticket numbers', async () => {
      const a = await mkFlight({ seats: 5, number: 'RA 731', dep: departure(75, 4) });
      const b2 = await mkFlight({ seats: 5, number: 'RA 732', dep: departure(76, 4) });
      const { id } = await approved(a.id, 1);
      const pax = await prisma.passenger.findMany({ where: { bookingId: id } });
      await http.post(`/api/admin/bookings/${id}/ticket`).set(auth(staff)).send({ pnr: 'OLD111', tickets: [{ passengerId: pax[0].id, ticketNumber: 'T-OLD-0001' }] });
      expect(await inventoryOf(a.id)).toMatchObject({ ticketed: 1 });

      const r = await http.post(`/api/admin/bookings/${id}/reschedule`).set(auth(staff)).send({
        changes: [{ direction: 'OUTBOUND', newFlightId: b2.id }], pnr: 'NEW222', tickets: [{ passengerId: pax[0].id, ticketNumber: 'T-NEW-0002' }],
      });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('TICKETED');
      expect(r.body.pnr).toBe('NEW222');
      expect(await inventoryOf(a.id)).toMatchObject({ ticketed: 0 });
      expect(await inventoryOf(b2.id)).toMatchObject({ ticketed: 1 });
    });
  });

  describe('inquiries vs bookings, and staff-created bookings', () => {
    const body = (flightId: string, n = 1) => ({
      tripType: 'ONE_WAY', outboundFlightId: flightId, contactName: 'Walk In', contactEmail: 'Walkin@Example.com', contactPhone: '9800000009', passengers: passengers(n),
    });

    it('keeps unconfirmed inquiries out of the bookings list until staff confirm them', async () => {
      const { id } = await mkFlight({ seats: 5, number: 'RA 801' });
      const ref = (await inquire(id, 1)).body.reference as string;
      const row = await prisma.booking.findUniqueOrThrow({ where: { reference: ref } });
      const inInq = async () => (await http.get('/api/admin/bookings?kind=inquiry').set(auth(staff))).body.items.some((b: { id: string }) => b.id === row.id);
      const inBk = async () => (await http.get('/api/admin/bookings?kind=booking').set(auth(staff))).body.items.some((b: { id: string }) => b.id === row.id);
      expect([await inInq(), await inBk()]).toEqual([true, false]);
      await http.post(`/api/admin/bookings/${row.id}/hold`).set(auth(staff)).send({});
      expect([await inInq(), await inBk()]).toEqual([true, false]); // a hold is still an inquiry
      await http.post(`/api/admin/bookings/${row.id}/confirm`).set(auth(staff));
      expect([await inInq(), await inBk()]).toEqual([false, true]); // converted
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: row.id } })).confirmedAt).not.toBeNull();
    });

    it('groups statuses: OPEN = new + on hold, CLOSED = rejected / expired / cancelled', async () => {
      const f = await mkFlight({ seats: 10, number: 'RA 805' });
      const mk = async () => (await prisma.booking.findUniqueOrThrow({ where: { reference: (await inquire(f.id, 1)).body.reference } })).id;
      const fresh = await mk(), held = await mk(), rejected = await mk();
      await http.post(`/api/admin/bookings/${held}/hold`).set(auth(staff)).send({});
      await http.post(`/api/admin/bookings/${rejected}/reject`).set(auth(staff)).send({ reason: 'not possible' });
      const ids = async (s: string) => (await http.get(`/api/admin/bookings?kind=inquiry&status=${s}`).set(auth(staff))).body.items.map((b: { id: string }) => b.id);
      const open = await ids('OPEN');
      expect(open).toEqual(expect.arrayContaining([fresh, held]));
      expect(open).not.toContain(rejected);
      expect(await ids('CLOSED')).toContain(rejected);
      expect(await ids('CLOSED')).not.toContain(fresh);
      expect((await http.get('/api/admin/bookings?status=NOPE').set(auth(staff))).status).toBe(400);
    });

    it('lets staff create a confirmed booking directly, commits seats and emails the customer', async () => {
      const { id } = await mkFlight({ seats: 3, number: 'RA 802' });
      expect((await http.post('/api/admin/bookings').set(auth(finance)).send(body(id))).status).toBe(403);
      expect((await http.post('/api/admin/bookings').send(body(id))).status).toBe(401);
      expect((await http.post('/api/admin/bookings').set(auth(staff)).send({ ...body(id), status: 'TICKETED' })).status).toBe(400); // no mass-assignment

      const r = await http.post('/api/admin/bookings').set(auth(staff)).send(body(id, 2));
      expect(r.status).toBe(201);
      expect(r.body.status).toBe('CONFIRMED');
      expect(r.body.source).toBe('STAFF');
      expect(r.body.confirmedAt).toBeTruthy();
      expect(await inventoryOf(id)).toMatchObject({ confirmed: 2 });
      const mail = await prisma.notification.findFirst({ where: { bookingId: r.body.id, template: 'booking_approved' } });
      expect(mail?.toEmail).toBe('walkin@example.com');
      expect(await prisma.notification.count({ where: { bookingId: r.body.id, template: 'inquiry_received' } })).toBe(0);
      const log = await prisma.auditLog.findFirst({ where: { entityId: r.body.id, action: 'booking.staff_create' } });
      expect(log?.actorId).toBeTruthy();
      // appears under bookings
      expect((await http.get('/api/admin/bookings?kind=booking').set(auth(staff))).body.items.some((b: { id: string }) => b.id === r.body.id)).toBe(true);
    });

    it('refuses a staff booking when seats are not available and leaves nothing behind', async () => {
      const { id } = await mkFlight({ seats: 1, number: 'RA 803' });
      const before = await prisma.booking.count();
      expect((await http.post('/api/admin/bookings').set(auth(staff)).send(body(id, 2))).status).toBe(400);
      expect(await prisma.booking.count()).toBe(before);
      expect(await inventoryOf(id)).toMatchObject({ confirmed: 0, held: 0 });
    });

    it('never oversells when staff bookings race for the last seats', async () => {
      const { id } = await mkFlight({ seats: 2, number: 'RA 804' });
      const rs = await Promise.all(Array.from({ length: 5 }, () => http.post('/api/admin/bookings').set(auth(staff)).send(body(id, 1))));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(2);
      expect(await inventoryOf(id)).toMatchObject({ confirmed: 2 });
      expect(await prisma.booking.count({ where: { segments: { some: { flightId: id } } } })).toBe(2); // failures were cleaned up
    });
  });

  describe('finding bookings, customers and lost references', () => {
    it('searches by phone, filters by route / flight number / departure date, and lists customers', async () => {
      const dep = departure(90, 4);
      const f = await mkFlight({ seats: 5, number: 'RA 901', dep });
      const res = await request(server()).post('/api/admin/bookings').set(auth(staff)).send({
        tripType: 'ONE_WAY', outboundFlightId: f.id, contactName: 'Findable Person', contactEmail: 'findme@example.com', contactPhone: '+977 98-55-1234', passengers: passengers(1),
      });
      expect(res.status).toBe(201);
      const find = async (qs: string) => (await http.get(`/api/admin/bookings?${qs}`).set(auth(staff))).body.items.map((b: { id: string }) => b.id);
      expect(await find('q=9855')).toContain(res.body.id);
      expect(await find('q=+977 98-55-1234')).toContain(res.body.id);
      expect(await find('q=findme@')).toContain(res.body.id);
      expect(await find('flightNumber=ra 901')).toContain(res.body.id);
      expect(await find('origin=KTM&destination=PKR')).toContain(res.body.id);
      expect(await find('origin=PKR&destination=KTM')).not.toContain(res.body.id);
      expect(await find(`flightFrom=${nepalDate(dep)}&flightTo=${nepalDate(dep)}`)).toContain(res.body.id);
      expect(await find(`flightFrom=${nepalDate(departure(95))}`)).not.toContain(res.body.id);

      const cust = await http.get('/api/admin/customers?q=findable').set(auth(staff));
      expect(cust.status).toBe(200);
      expect(cust.body.items).toEqual([expect.objectContaining({ email: 'findme@example.com', name: 'Findable Person', bookingId: res.body.id, payment: expect.objectContaining({ status: 'UNPAID' }) })]);
      expect(cust.body.items[0].flights).toEqual([expect.objectContaining({ flightNumber: 'RA 901', from: 'KTM', to: 'PKR' })]);
      expect((await http.get('/api/admin/customers')).status).toBe(401);
    });

    it('resends the reference email for a caller who lost it (staff only, audited)', async () => {
      const f = await mkFlight({ seats: 5, number: 'RA 902' });
      const ref = (await inquire(f.id, 1)).body.reference as string;
      const b = await prisma.booking.findUniqueOrThrow({ where: { reference: ref } });
      expect((await http.post(`/api/admin/bookings/${b.id}/resend-email`).set(auth(finance))).status).toBe(403);
      const r = await http.post(`/api/admin/bookings/${b.id}/resend-email`).set(auth(staff));
      expect(r.body).toEqual({ sent: true, to: 'sita@example.com' });
      expect(await prisma.notification.count({ where: { bookingId: b.id, template: 'inquiry_received' } })).toBe(2); // original + resend
      expect(await prisma.auditLog.count({ where: { entityId: b.id, action: 'booking.resend_email' } })).toBe(1);
    });

    it('does not show finance staff passenger dates of birth or documents in LISTS either', async () => {
      const f = await mkFlight({ seats: 5, number: 'RA 903' });
      const created = await request(server()).post('/api/admin/bookings').set(auth(staff)).send({
        tripType: 'ONE_WAY', outboundFlightId: f.id, contactName: 'Priv Acy', contactEmail: 'priv@example.com', contactPhone: '9800000077',
        passengers: [{ type: 'ADULT', firstName: 'Priv', lastName: 'Acy', dateOfBirth: '1985-05-05', documentNumber: 'PP7654321', nationality: 'Nepal', documentExpiry: '2040-01-01' }],
      });
      const asFinance = await http.get('/api/admin/bookings?q=priv@example.com').set(auth(finance));
      expect(asFinance.status).toBe(200);
      const row = asFinance.body.items.find((b: { id: string }) => b.id === created.body.id);
      expect(row.passengers[0].dateOfBirth).toBeUndefined();
      expect(row.passengers[0].documentNumberMasked).toBeUndefined();
      const asStaff = await http.get('/api/admin/bookings?q=priv@example.com').set(auth(staff));
      expect(asStaff.body.items[0].passengers[0].documentNumberMasked).toBe('******321');
    });
  });

  // ───────────── payments, receipts, refunds ─────────────

  describe('payments and receipts', () => {
    const pay = (bookingId: string, who: string, body: Record<string, unknown> = {}) =>
      http.post(`/api/admin/bookings/${bookingId}/payments`).set(auth(who)).send({ amount: '1000', method: 'CASH', idempotencyKey: randomUUID(), ...body });
    const refund = (bookingId: string, who: string, body: Record<string, unknown> = {}) =>
      http.post(`/api/admin/bookings/${bookingId}/refunds`).set(auth(who)).send({ amount: '500', method: 'BANK_TRANSFER', idempotencyKey: randomUUID(), ...body });
    const summary = async (id: string) => (await http.get(`/api/admin/bookings/${id}`).set(auth(staff))).body.payment;
    /** 2 adults x 5500 = 11000 */
    const booked = async (flightId: string) => {
      const ref = (await inquire(flightId, 2)).body.reference as string;
      const b = await prisma.booking.findUniqueOrThrow({ where: { reference: ref } });
      return { ref, id: b.id };
    };
    const confirmed = async (flightId: string) => {
      const x = await booked(flightId);
      await http.post(`/api/admin/bookings/${x.id}/confirm`).set(auth(staff));
      return x;
    };

    it('shows unpaid -> partial -> paid, and exposes only the status (not amounts) to the customer', async () => {
      const f = await mkFlight({ seats: 10, number: 'RA 1001' });
      const { id, ref } = await confirmed(f.id);
      expect(await summary(id)).toMatchObject({ total: '11000.00', paid: '0.00', balance: '11000.00', status: 'UNPAID' });

      const first = await pay(id, staff, { amount: '4000', method: 'ESEWA', reference: 'ESW-TXN-1' });
      expect(first.status).toBe(201);
      expect(first.body.receiptNumber).toMatch(/^RC-\d{4}-\d{6}$/);
      expect(await summary(id)).toMatchObject({ paid: '4000.00', balance: '7000.00', status: 'PARTIAL' });
      const look = await http.post('/api/public/bookings/lookup').send({ reference: ref, email: 'sita@example.com' });
      expect(look.body.payment).toBe('PARTIAL');
      expect(JSON.stringify(look.body)).not.toMatch(/4000|7000|ESW-TXN|RC-/);

      expect((await pay(id, staff, { amount: '7000' })).status).toBe(201);
      expect(await summary(id)).toMatchObject({ balance: '0.00', status: 'PAID' });
    });

    it('records nothing for an unconfirmed inquiry and never from the public side', async () => {
      const f = await mkFlight({ seats: 10, number: 'RA 1002' });
      const { id } = await booked(f.id);
      expect((await pay(id, staff)).status).toBe(409); // still only an inquiry
      expect((await http.post(`/api/admin/bookings/${id}/payments`).send({ amount: '1', method: 'CASH', idempotencyKey: randomUUID() })).status).toBe(401);
      expect((await http.post('/api/public/bookings/payments').send({ amount: '1' })).status).toBe(404);
    });

    it('blocks overpayment, bad amounts and future dates', async () => {
      const f = await mkFlight({ seats: 10, number: 'RA 1003' });
      const { id } = await confirmed(f.id);
      expect((await pay(id, staff, { amount: '11000.01' })).status).toBe(409);
      for (const bad of ['0', '-5', '12.345', 'abc', '']) expect((await pay(id, staff, { amount: bad })).status).toBe(400);
      expect((await pay(id, staff, { receivedAt: new Date(Date.now() + 86_400_000).toISOString() })).status).toBe(400);
      expect(await summary(id)).toMatchObject({ paid: '0.00' });
    });

    it('is idempotent: the same submission key never records twice, even when sent in parallel', async () => {
      const f = await mkFlight({ seats: 10, number: 'RA 1004' });
      const { id } = await confirmed(f.id);
      const key = randomUUID();
      const rs = await Promise.all(Array.from({ length: 6 }, () => pay(id, staff, { amount: '2000', idempotencyKey: key })));
      expect(rs.every((r) => r.status === 201)).toBe(true);
      expect(new Set(rs.map((r) => r.body.receiptNumber)).size).toBe(1);
      expect(await summary(id)).toMatchObject({ paid: '2000.00' });
      expect(await prisma.payment.count({ where: { bookingId: id } })).toBe(1);
    });

    it('rejects a duplicate bank/wallet transaction reference, but allows it on another method', async () => {
      const f = await mkFlight({ seats: 10, number: 'RA 1005' });
      const a = await confirmed(f.id);
      const b = await confirmed(f.id);
      expect((await pay(a.id, staff, { amount: '1000', method: 'BANK_TRANSFER', reference: 'BNK-998877' })).status).toBe(201);
      expect((await pay(b.id, staff, { amount: '1000', method: 'BANK_TRANSFER', reference: 'BNK-998877' })).status).toBe(409); // same txn, other booking
      expect((await pay(a.id, staff, { amount: '1000', method: 'BANK_TRANSFER', reference: 'BNK-998877' })).status).toBe(409);
      expect((await pay(b.id, staff, { amount: '1000', method: 'KHALTI', reference: 'BNK-998877' })).status).toBe(201);
    });

    it('gives every receipt a unique number even when many are recorded at once', async () => {
      const f = await mkFlight({ seats: 20, number: 'RA 1006' });
      const ids = [] as string[];
      for (let i = 0; i < 6; i++) ids.push((await confirmed(f.id)).id);
      const rs = await Promise.all(ids.map((id) => pay(id, staff, { amount: '500' })));
      expect(rs.every((r) => r.status === 201)).toBe(true);
      expect(new Set(rs.map((r) => r.body.receiptNumber)).size).toBe(6);
    });

    it('lets only finance refund or void, caps refunds at what was paid, and voids correctly', async () => {
      const f = await mkFlight({ seats: 10, number: 'RA 1007' });
      const { id } = await confirmed(f.id);
      const p1 = await pay(id, staff, { amount: '6000' });
      expect((await refund(id, staff)).status).toBe(403); // counter staff cannot refund
      expect((await refund(id, finance, { amount: '6000.01' })).status).toBe(409);
      expect((await refund(id, finance, { amount: '1000' })).status).toBe(201);
      expect(await summary(id)).toMatchObject({ paid: '6000.00', refunded: '1000.00', net: '5000.00', status: 'PARTIAL' });

      expect((await http.post(`/api/admin/payments/${p1.body.id}/void`).set(auth(staff)).send({ reason: 'entered twice' })).status).toBe(403);
      // voiding the payment would leave a refund bigger than payments
      expect((await http.post(`/api/admin/payments/${p1.body.id}/void`).set(auth(finance)).send({ reason: 'entered twice' })).status).toBe(409);

      const p2 = await pay(id, finance, { amount: '2000' });
      const v = await http.post(`/api/admin/payments/${p2.body.id}/void`).set(auth(finance)).send({ reason: 'cash was not actually handed over' });
      expect(v.body.status).toBe('VOIDED');
      expect((await http.post(`/api/admin/payments/${p2.body.id}/void`).set(auth(finance)).send({ reason: 'again please' })).status).toBe(409);
      expect(await summary(id)).toMatchObject({ paid: '6000.00', net: '5000.00' }); // voided money is ignored
      expect(await prisma.payment.count({ where: { bookingId: id } })).toBe(3); // nothing deleted
    });

    it('flags REFUND_DUE after cancellation and stops further payments', async () => {
      const f = await mkFlight({ seats: 10, number: 'RA 1008' });
      const { id } = await confirmed(f.id);
      await pay(id, staff, { amount: '3000' });
      await http.post(`/api/admin/bookings/${id}/cancel`).set(auth(staff)).send({ reason: 'customer request' });
      expect(await summary(id)).toMatchObject({ total: '0.00', net: '3000.00', status: 'REFUND_DUE' });
      expect((await pay(id, staff)).status).toBe(409);
      expect((await refund(id, finance, { amount: '3000' })).status).toBe(201);
      expect(await summary(id)).toMatchObject({ net: '0.00', status: 'REFUNDED' });
    });

    it('prints a receipt, emails the customer, and audits the money movement', async () => {
      const f = await mkFlight({ seats: 10, number: 'RA 1009' });
      const { id } = await confirmed(f.id);
      const r = await pay(id, staff, { amount: '2500', method: 'CASH', note: 'paid at counter' });
      const rc = await http.get(`/api/admin/payments/${r.body.id}/receipt`).set(auth(finance));
      expect(rc.status).toBe(200);
      expect(rc.body).toMatchObject({ receiptNumber: r.body.receiptNumber, amount: '2500.00', method: 'CASH', recordedBy: 'staff@test.local' });
      expect(rc.body.booking).toMatchObject({ contactName: 'Sita Sharma', total: '11000.00', balance: '8500.00' });
      expect((await http.get(`/api/admin/payments/${r.body.id}/receipt`)).status).toBe(401);
      const end = Date.now() + 3000;
      let mail = null;
      while (!mail && Date.now() < end) { mail = await prisma.notification.findFirst({ where: { bookingId: id, template: 'payment_received' } }); if (!mail) await new Promise((x) => setTimeout(x, 50)); }
      expect(mail?.toEmail).toBe('sita@example.com');
      const log = await prisma.auditLog.findFirst({ where: { entityId: id, action: 'payment.record' } });
      expect(JSON.stringify(log?.detail)).toContain(r.body.receiptNumber);
    });
  });

  // ───────────── reports + CSV ─────────────

  describe('reports and CSV exports', () => {
    const today = () => nepalDate(new Date());
    const rng = () => `from=${nepalDate(departure(-1))}&to=${nepalDate(departure(2))}`;

    it('exports bookings as CSV with the right headers', async () => {
      const f = await mkFlight({ seats: 5, number: 'RA 1101' });
      await request(server()).post('/api/admin/bookings').set(auth(staff)).send({
        tripType: 'ONE_WAY', outboundFlightId: f.id, contactName: 'Csv Person', contactEmail: 'csv@example.com', contactPhone: '9800000055', passengers: passengers(1),
      });
      const r = await http.get(`/api/admin/reports/bookings?${rng()}&format=csv`).set(auth(staff));
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/text\/csv/);
      expect(r.headers['content-disposition']).toMatch(/attachment; filename="bookings_/);
      expect(r.text.charCodeAt(0)).toBe(0xfeff);
      expect(r.text).toContain('"Reference","Type","Status"');
      expect(r.text).toContain('Csv Person');
    });

    it('neutralises spreadsheet formulas typed into free-text fields that reach the payments CSV', async () => {
      // names/emails/phones are validated at the form; the payment NOTE is free text, so it is the real vector.
      const f = await mkFlight({ seats: 5, number: 'RA 1104' });
      const ref = (await inquire(f.id, 1)).body.reference as string;
      const b = await prisma.booking.findUniqueOrThrow({ where: { reference: ref } });
      await http.post(`/api/admin/bookings/${b.id}/confirm`).set(auth(staff));
      const evil = '=HYPERLINK("http://evil.example","click")';
      const r = await http.post(`/api/admin/bookings/${b.id}/payments`).set(auth(finance)).send({ amount: '500', method: 'CASH', note: evil, idempotencyKey: randomUUID() });
      expect(r.status).toBe(201);
      const csv = await http.get(`/api/admin/reports/payments?from=${today()}&to=${today()}&format=csv`).set(auth(finance));
      expect(csv.text).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
      expect(csv.text).not.toMatch(/,"=HYPERLINK/);
    });

    it('lists flight load and keeps money reports finance-only', async () => {
      await mkFlight({ seats: 8, number: 'RA 1102', dep: departure(1, 10) });
      const inv = await http.get(`/api/admin/reports/inventory?${rng()}&format=json`).set(auth(staff));
      expect(inv.status).toBe(200);
      expect(inv.body.rows.some((x: { flight: string }) => x.flight === 'RA 1102')).toBe(true);
      expect((await http.get(`/api/admin/reports/payments?${rng()}`).set(auth(staff))).status).toBe(403); // counter staff: no money report
      expect((await http.get(`/api/admin/reports/payments?${rng()}`)).status).toBe(401);
    });

    it('totals payments by method, excludes voided money, and records who exported what', async () => {
      const f = await mkFlight({ seats: 10, number: 'RA 1103' });
      const ref = (await inquire(f.id, 2)).body.reference as string;
      const b = await prisma.booking.findUniqueOrThrow({ where: { reference: ref } });
      await http.post(`/api/admin/bookings/${b.id}/confirm`).set(auth(staff));
      const mk = (amount: string, method: string) => http.post(`/api/admin/bookings/${b.id}/payments`).set(auth(finance)).send({ amount, method, idempotencyKey: randomUUID() });
      await mk('1000', 'CASH');
      const gone = await mk('2000', 'ESEWA');
      await http.post(`/api/admin/payments/${gone.body.id}/void`).set(auth(finance)).send({ reason: 'bounced' });
      const q = `from=${today()}&to=${today()}`;
      const rep = await http.get(`/api/admin/reports/payments?${q}&format=json`).set(auth(finance));
      expect(rep.status).toBe(200);
      const dbSum = async (method: 'ESEWA' | 'CASH') => {
        const rows = await prisma.payment.findMany({ where: { method, status: 'RECORDED' } });
        return rows.reduce((t, x) => t + (x.type === 'PAYMENT' ? 1 : -1) * Number(x.amount), 0);
      };
      expect(Number(rep.body.totals.byMethod.ESEWA)).toBeCloseTo(await dbSum('ESEWA'), 2); // the voided 2000 is not in it
      expect(Number(rep.body.totals.byMethod.CASH)).toBeCloseTo(await dbSum('CASH'), 2);
      expect(await prisma.payment.count({ where: { id: gone.body.id, status: 'VOIDED' } })).toBe(1);
      const csv = await http.get(`/api/admin/reports/payments?${q}&format=csv`).set(auth(finance));
      expect(csv.text).toContain('"Receipt","Date (Nepal)","Type"');
      expect(csv.text).toContain('VOIDED');
      expect(await prisma.auditLog.count({ where: { action: 'report.export', entityId: 'payments' } })).toBeGreaterThan(0);
    });

    it('validates the date range', async () => {
      expect((await http.get('/api/admin/reports/bookings?from=2026-01-01&to=2025-01-01').set(auth(staff))).status).toBe(400);
      expect((await http.get('/api/admin/reports/bookings?from=2020-01-01&to=2026-01-01').set(auth(staff))).status).toBe(400); // > 1 year
      expect((await http.get('/api/admin/reports/bookings?from=bad&to=bad').set(auth(staff))).status).toBe(400);
    });
  });

  describe('customers (travellers) and the seat manifest', () => {
    const staffBooking = (flightId: string, name: string, n = 1, extra: Record<string, unknown> = {}) =>
      request(server()).post('/api/admin/bookings').set(auth(staff)).send({
        tripType: 'ONE_WAY', outboundFlightId: flightId, contactName: name, contactEmail: `${name.toLowerCase().replace(/\W/g, '')}@trav.example.com`, contactPhone: '9800000100', passengers: passengers(n), ...extra,
      });
    const customers = async (qs: string, who = staff) => (await http.get(`/api/admin/customers?${qs}`).set(auth(who))).body;

    it('lists travellers nearest flight first, flights already flown last, and keeps inquiries apart', async () => {
      const far = await mkFlight({ seats: 5, number: 'RA 1201', dep: departure(120, 4) });
      const near = await mkFlight({ seats: 5, number: 'RA 1202', dep: departure(100, 4) });
      const farBk = await staffBooking(far.id, 'Zed Far');
      const nearBk = await staffBooking(near.id, 'Ann Near');
      const inquiryRef = (await inquire(far.id, 1, { contactName: 'Lead Only', contactEmail: 'leadonly@example.com' })).body.reference;

      const t = await customers('scope=travelling&q=trav.example.com');
      const order = t.items.map((r: { bookingId: string }) => r.bookingId);
      expect(order.indexOf(nearBk.body.id)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(nearBk.body.id)).toBeLessThan(order.indexOf(farBk.body.id)); // nearest flight at the top
      expect(t.items.some((r: { reference: string }) => r.reference === inquiryRef)).toBe(false); // an inquiry is not a traveller

      const leads = await customers('scope=leads&q=leadonly');
      expect(leads.items.map((r: { reference: string }) => r.reference)).toEqual([inquiryRef]);
    });

    it('filters by payment status and flying date, and flags rescheduled bookings', async () => {
      const dep = departure(110, 4);
      const f = await mkFlight({ seats: 10, number: 'RA 1203', dep });
      const f2 = await mkFlight({ seats: 10, number: 'RA 1204', dep: departure(111, 4) });
      const unpaid = await staffBooking(f.id, 'Una Paid');
      const partial = await staffBooking(f.id, 'Pat Partial');
      const full = await staffBooking(f.id, 'Fay Full');
      const pay = (id: string, amount: string) => http.post(`/api/admin/bookings/${id}/payments`).set(auth(finance)).send({ amount, method: 'CASH', idempotencyKey: randomUUID() });
      await pay(partial.body.id, '1000');
      await pay(full.body.id, '5500'); // 1 adult x 5500
      await http.post(`/api/admin/bookings/${full.body.id}/reschedule`).set(auth(staff)).send({ changes: [{ direction: 'OUTBOUND', newFlightId: f2.id }] });

      const day = `flyFrom=${nepalDate(dep)}&flyTo=${nepalDate(departure(111, 4))}`;
      const ids = async (qs: string) => (await customers(`${day}&${qs}`)).items.map((r: { bookingId: string }) => r.bookingId);
      expect(await ids('payment=PARTIAL')).toEqual([partial.body.id]);
      expect(await ids('payment=PAID')).toEqual([full.body.id]);
      expect(await ids('payment=UNPAID')).toEqual([unpaid.body.id]);
      expect((await ids('rescheduled=true'))).toEqual([full.body.id]);
      const row = (await customers(`${day}&payment=PAID`)).items[0];
      expect(row.rescheduled).toBe(true);
      expect(row.flights[0].flightNumber).toBe('RA 1204');
      expect((await customers(`flyFrom=${nepalDate(departure(300))}`)).items).toEqual([]);
      expect((await http.get('/api/admin/customers?payment=NOPE').set(auth(staff))).status).toBe(400);
    });

    it('moves cancelled-but-paid customers into the cancelled scope with REFUND_DUE', async () => {
      const f = await mkFlight({ seats: 5, number: 'RA 1205', dep: departure(105, 4) });
      const b = await staffBooking(f.id, 'Cara Cancel');
      await http.post(`/api/admin/bookings/${b.body.id}/payments`).set(auth(finance)).send({ amount: '2000', method: 'CASH', idempotencyKey: randomUUID() });
      await http.post(`/api/admin/bookings/${b.body.id}/cancel`).set(auth(staff)).send({ reason: 'customer request' });
      expect((await customers('scope=travelling&q=caracancel')).items).toHaveLength(0);
      const c = await customers('scope=cancelled&payment=REFUND_DUE&q=caracancel');
      expect(c.items).toEqual([expect.objectContaining({ bookingId: b.body.id, payment: expect.objectContaining({ status: 'REFUND_DUE', net: '2000.00' }) })]);
    });

    it('shows who holds, has confirmed and is ticketed on a flight, with the seats left', async () => {
      const f = await mkFlight({ seats: 10, number: 'RA 1206', dep: departure(106, 4) });
      const held = (await inquire(f.id, 2, { contactName: 'Hold Person' })).body.reference as string;
      const heldId = (await prisma.booking.findUniqueOrThrow({ where: { reference: held } })).id;
      await http.post(`/api/admin/bookings/${heldId}/hold`).set(auth(staff)).send({});
      await staffBooking(f.id, 'Conf Person', 3);
      const tkt = await staffBooking(f.id, 'Tkt Person', 1);
      const pax = await prisma.passenger.findMany({ where: { bookingId: tkt.body.id } });
      await http.post(`/api/admin/bookings/${tkt.body.id}/ticket`).set(auth(staff)).send({ pnr: 'TKT111', tickets: [{ passengerId: pax[0].id, ticketNumber: 'TICKET-0001' }] });

      const m = await http.get(`/api/admin/flights/${f.id}/manifest`).set(auth(finance));
      expect(m.status).toBe(200);
      expect(m.body.inventory).toEqual({ total: 10, held: 2, confirmed: 3, ticketed: 1, available: 4 });
      const by = (state: string) => m.body.entries.filter((e: { state: string }) => e.state === state);
      expect(by('HELD')).toEqual([expect.objectContaining({ customer: 'Hold Person', seats: 2, reference: held })]);
      expect(by('CONFIRMED')).toEqual([expect.objectContaining({ customer: 'Conf Person', seats: 3 })]);
      expect(by('TICKETED')[0]).toMatchObject({ customer: 'Tkt Person', pnr: 'TKT111' });
      expect(by('TICKETED')[0].passengers[0].ticketNumber).toBe('TICKET-0001');
      expect(by('HELD')[0].holdExpiresAt).toBeTruthy();
      expect((await http.get(`/api/admin/flights/${f.id}/manifest`)).status).toBe(401);

      // the booking page reports the flight's remaining seats, not just this booking's count
      const detail = await http.get(`/api/admin/bookings/${heldId}`).set(auth(staff));
      expect(detail.body.segments[0].seats).toBe(2);
      expect(detail.body.segments[0].flight.seatsAtFlight).toEqual({ total: 10, held: 2, confirmed: 3, ticketed: 1, available: 4 });
      // lead/inquiry-only customers cannot leak into the manifest after rejection
      await http.post(`/api/admin/bookings/${heldId}/reject`).set(auth(staff)).send({ reason: 'no longer needed' });
      expect((await http.get(`/api/admin/flights/${f.id}/manifest`).set(auth(staff))).body.entries.some((e: { reference: string }) => e.reference === held)).toBe(false);
    });
  });

  describe('audit trail', () => {
    it('records privileged actions with the acting admin', async () => {
      const logs = await prisma.auditLog.findMany({ where: { action: 'booking.confirm' }, include: { actor: { select: { email: true } } } });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.every((l) => l.actor?.email === 'staff@test.local')).toBe(true);
      expect(JSON.stringify(logs)).not.toMatch(/passwordHash|accessToken/);
    });
  });
});
