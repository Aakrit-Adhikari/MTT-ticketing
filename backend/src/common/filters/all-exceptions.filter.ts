import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';

const isClientHttpError = (e: unknown): e is { status: number } =>
  typeof e === 'object' && e !== null && typeof (e as { status?: unknown }).status === 'number' &&
  (e as { status: number }).status >= 400 && (e as { status: number }).status < 500;

/** Centralized error handling: clients get a safe message; details go only to server logs. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      message = typeof body === 'string' ? body : ((body as { message?: string | string[] }).message ?? exception.message);
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        message = 'A record with these details already exists';
      } else if (exception.code === 'P2003') {
        status = HttpStatus.CONFLICT;
        message = 'Operation conflicts with related records';
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        message = 'Record not found';
      } else if (exception.code === 'P2010' || exception.code === 'P2004') {
        // Raw-query / DB-constraint failure (e.g. inventory CHECK): safe generic conflict.
        status = HttpStatus.CONFLICT;
        message = 'Operation rejected by data integrity rules';
        this.logger.warn(`Prisma ${exception.code}`);
      } else {
        this.logger.error(`Prisma ${exception.code}`);
      }
    } else if (isClientHttpError(exception)) {
      // Errors raised by Express middleware (body too large, malformed JSON): safe, generic 4xx.
      status = exception.status;
      message = status === 413 ? 'Request body too large' : 'Bad request';
    } else {
      // Log class + message only; never request bodies, tokens or stack traces to the client.
      this.logger.error(exception instanceof Error ? `${exception.name}: ${exception.message}` : 'Unknown error');
    }

    // Framework default texts are meant for developers; say what a person should do instead.
    if (status === 429) message = 'Too many attempts in a short time. Please wait a minute and try again.';
    else if (status === 401 && (message === 'Unauthorized' || message === 'Unauthorized Exception')) message = 'Please sign in again.';
    else if (status === 403 && message === 'Forbidden') message = 'You do not have permission to do this.';
    else if (status === 404 && typeof message === 'string' && message.startsWith('Cannot ')) message = 'That page or record was not found.';
    res.status(status).json({ statusCode: status, message });
  }
}
