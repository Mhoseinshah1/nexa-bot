import { Catch, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  INTERNAL_UNHANDLED_CODE,
  OPS_ERROR_CLASS_POLICY,
  isNexaError,
  opsAggregationKey,
  type CorrelationId,
  type ErrorResponse,
} from '@nexa/contracts';
import { recordQuietly } from '../../modules/platform/opslog/application/error-events.js';
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
      // FIX-05: and to the operations log. Not awaited — the answer to the client never
      // waits on it — and it never throws (`recordQuietly`).
      void this.reportUnhandled(exception, host, status, correlationId);
    }

    void reply.status(status).send(body);
  }

  /**
   * One row per route and failure name per aggregation window: a broken endpoint hit a
   * thousand times is one message with a counter. The ROUTE PATTERN (`/api/payments/:id`),
   * never the URL — a URL carries ids and, on the webhook paths, tenant ids — and the
   * failure's NAME, never its message, which is for the process log alone.
   */
  private async reportUnhandled(
    exception: unknown,
    host: ArgumentsHost,
    status: number,
    correlationId: string,
  ): Promise<void> {
    const tenantId = this.container.installationTenantId;
    if (tenantId === null) return;
    const request = host.switchToHttp().getRequest<FastifyRequest | undefined>();
    const route = request?.routeOptions?.url ?? 'unrouted';
    const name = exception instanceof Error ? exception.name : 'unknown';
    await recordQuietly(
      this.container.opsLog,
      { tenantId, botInstanceId: null },
      {
        code: INTERNAL_UNHANDLED_CODE,
        severity: OPS_ERROR_CLASS_POLICY.ERROR.storedSeverity,
        message: `An API request failed with ${String(status)}.`,
        dedupeKey: opsAggregationKey(
          `${INTERNAL_UNHANDLED_CODE}:${route}:${name}`,
          this.container.clock.now(),
        ),
        ...(correlationId === 'unknown' ? {} : { correlationId: correlationId as CorrelationId }),
        context: {
          method: `${request?.method ?? 'UNKNOWN'} ${route}`,
          kind: name,
          httpStatus: status,
        },
      },
      this.container.logger,
    );
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
