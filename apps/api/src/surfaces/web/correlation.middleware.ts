import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CORRELATION_ID_HEADER } from '@nexa/contracts';
import { uuidv7 } from 'uuidv7';
import { newCorrelationId, runWithContext } from '../../infrastructure/logging/logger.js';

/**
 * Establishes a correlation id for every request, honouring one supplied by the
 * caller so a trace survives a hop between services. It is echoed on the
 * response and travels into audit rows, outbox messages and log lines.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(request: FastifyRequest['raw'], response: FastifyReply['raw'], next: () => void): void {
    const incoming = request.headers[CORRELATION_ID_HEADER];
    const value = (Array.isArray(incoming) ? incoming[0] : incoming) ?? uuidv7();
    response.setHeader(CORRELATION_ID_HEADER, value);
    runWithContext({ correlationId: newCorrelationId(value) }, () => next());
  }
}
