import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CORRELATION_ID_HEADER } from '@nexa/contracts';
import { uuidv7 } from 'uuidv7';
import { newCorrelationId, runWithContext } from '../../infrastructure/logging/logger.js';

/** The shape we mint: a UUID. Anything else is replaced rather than stored. */
const CORRELATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Establishes a correlation id for every request, honouring one supplied by the
 * caller so a trace survives a hop between services. It is echoed on the
 * response and travels into audit rows, outbox messages and log lines.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(request: FastifyRequest['raw'], response: FastifyReply['raw'], next: () => void): void {
    // A caller may supply an id so a trace survives a hop, but it lands in
    // append-only columns, so it is accepted only in the shape we mint. An
    // unbounded caller-controlled string would otherwise be undeletable.
    const incoming = request.headers[CORRELATION_ID_HEADER];
    const supplied = Array.isArray(incoming) ? incoming[0] : incoming;
    const value = supplied && CORRELATION_ID_PATTERN.test(supplied) ? supplied : uuidv7();
    response.setHeader(CORRELATION_ID_HEADER, value);
    runWithContext({ correlationId: newCorrelationId(value) }, () => next());
  }
}
