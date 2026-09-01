import { Catch, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { isNexaError, type ErrorResponse } from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { currentCorrelationId } from '../../infrastructure/logging/logger.js';

/**
 * Maps failures to HTTP responses from the error KIND, never from the message.
 *
 * Two rules matter here. Internal failures never leak their message to a
 * client — the legacy system's `کد خطا : 0` distinguished nothing, but leaking a
 * stack trace is the opposite failure. And every response carries the
 * correlation id, so a user-reported failure can be found in the logs.
 */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const correlationId = currentCorrelationId() ?? 'unknown';

    const status = this.toStatus(exception);
    const body = this.toBody(exception, correlationId, status);

    if (status >= 500) {
      this.container.logger.error(
        { err: exception instanceof Error ? exception.stack : String(exception) },
        'Unhandled failure',
      );
    }

    void reply.status(status).send(body);
  }

  private toStatus(exception: unknown): number {
    if (isNexaError(exception)) return exception.httpStatus;
    if (exception instanceof ZodError) return 400;
    if (exception instanceof HttpException) return exception.getStatus();
    return 500;
  }

  private toBody(exception: unknown, correlationId: string, status: number): ErrorResponse {
    // Anything answering 5xx keeps its message for the log and not for the
    // client, whatever class it is. Checking the class instead of the status
    // let framework exceptions carry their message out on a 500.
    const serverError = status >= 500;

    if (isNexaError(exception)) {
      return {
        error: {
          kind: exception.kind,
          code: exception.code,
          // A server-side failure's message is for the log, not for the client.
          // Keying on the status rather than on `kind === 'INTERNAL'` also
          // covers CONFIGURATION, whose message names environment variables.
          message: serverError ? 'An internal error occurred.' : exception.message,
          ...(serverError ? {} : { details: exception.details }),
          correlationId,
        },
      };
    }

    if (exception instanceof ZodError) {
      return {
        error: {
          kind: 'VALIDATION',
          code: 'request.invalid',
          message: 'The request payload is invalid.',
          details: {
            issues: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
          correlationId,
        },
      };
    }

    if (exception instanceof HttpException) {
      return {
        error: {
          kind: serverError ? 'INTERNAL' : 'VALIDATION',
          code: 'http.error',
          message: serverError ? 'An internal error occurred.' : exception.message,
          correlationId,
        },
      };
    }

    return {
      error: {
        kind: 'INTERNAL',
        code: 'internal.unhandled',
        message: 'An internal error occurred.',
        correlationId,
      },
    };
  }
}
