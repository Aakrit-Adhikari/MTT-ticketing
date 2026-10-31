// Sends one test email using the SMTP settings in the environment and prints the mail server's exact answer.
// Usage: node dist/scripts/mail-test.js someone@example.com
import { createTransport } from 'nodemailer';

async function main(): Promise<void> {
  const to = process.argv[2];
  const { SMTP_HOST, SMTP_PORT = '587', SMTP_USER, SMTP_PASSWORD, MAIL_FROM } = process.env;
  if (!to) throw new Error('Give the recipient address: node dist/scripts/mail-test.js someone@example.com');
  if (!SMTP_HOST || !MAIL_FROM) throw new Error('SMTP_HOST and MAIL_FROM must be set');
  const port = Number(SMTP_PORT);
  const t = createTransport({ host: SMTP_HOST, port, secure: port === 465, requireTLS: port !== 465, auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASSWORD } : undefined });
  const r = await t.sendMail({ from: MAIL_FROM, to, subject: `Email test ${new Date().toISOString()}`, text: 'This is a test from the ticketing system. If you can read this, delivery works.' });
  console.log({ accepted: r.accepted, rejected: r.rejected, response: r.response });
  if (r.rejected.length) process.exitCode = 1;
}
main().catch((e) => { console.error('FAILED:', e instanceof Error ? e.message : e); process.exit(1); });
