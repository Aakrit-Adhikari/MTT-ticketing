import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { NotificationStatus } from '@prisma/client';
import { createTransport, Transporter } from 'nodemailer';
import { APP_ENV } from '../common/config/config.module';
import { Env } from '../common/config/env';
import { PrismaService } from '../database/prisma.service';

export interface OutgoingEmail {
  bookingId: string;
  to: string;
  template: string;
  subject: string;
  text: string;
}

/**
 * Sends plain-text customer emails and records each one. Plain text on purpose: customer-supplied names can never inject markup.
 * Delivery never blocks or fails the booking action that triggered it.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Email');
  private readonly transport?: Transporter;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: Env,
  ) {
    if (env.SMTP_HOST) {
      this.transport = createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        requireTLS: env.SMTP_PORT !== 465 && env.NODE_ENV !== 'test', // never send credentials unencrypted
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
        connectionTimeout: 10_000,
        socketTimeout: 15_000,
      });
    } else if (env.NODE_ENV !== 'test') {
      this.logger.warn('SMTP_HOST not set: emails are NOT delivered (local dev prints them in this window).');
    }
  }

  /** Records the email, then delivers in the background. Resolves once the record exists. */
  async send(mail: OutgoingEmail): Promise<void> {
    const rec = await this.prisma.notification.create({
      data: { bookingId: mail.bookingId, toEmail: mail.to, template: mail.template, subject: mail.subject },
    });
    void this.deliver(rec.id, mail);
  }

  private async deliver(id: string, mail: OutgoingEmail): Promise<void> {
    const finish = (status: NotificationStatus, error?: string) =>
      this.prisma.notification
        .update({ where: { id }, data: { status, error: error?.slice(0, 300), sentAt: status === 'SENT' ? new Date() : undefined } })
        .catch(() => undefined);

    if (!this.transport) {
      if (this.env.NODE_ENV === 'development') {
        console.log(`\n---- EMAIL (not sent: no SMTP configured) ----\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n----------------------------------------------\n`);
      }
      await finish('NOT_CONFIGURED');
      return;
    }
    try {
      await this.transport.sendMail({ from: this.env.MAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text });
      await finish('SENT');
    } catch (e) {
      this.logger.error(`Delivery failed for ${mail.template}`); // never log message content or SMTP credentials
      await finish('FAILED', e instanceof Error ? e.message : 'send failed');
    }
  }
}

@Global()
@Module({ providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}
