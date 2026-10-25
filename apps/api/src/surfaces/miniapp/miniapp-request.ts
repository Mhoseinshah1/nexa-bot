import type { FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import {
  MINIAPP_ERROR_CODES,
  MINIAPP_IDEMPOTENCY_HEADER,
  MINIAPP_RATE_LIMIT_REQUESTS,
  MINIAPP_SESSION_RATE_LIMIT_REQUESTS,
  NexaError,
  errors,
  miniAppIdempotencyKeySchema,
  type ActorContext,
  type CorrelationId,
} from '@nexa/contracts';
import type { Container } from '../../container.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import {
  miniAppActor,
  type MiniAppContext,
} from '../../modules/commerce/miniapp/application/miniapp-session.service.js';

/**
 * The one door every mini-app request passes, in this order: who (the session), how often
 * (the per-customer budget), and — unless the route is one the bot also exempts — the
 * bot's gates. A surface reads nothing it was not handed by these three.
 */
export interface MiniAppCall {
  readonly context: MiniAppContext;
  readonly actor: ActorContext;
  readonly correlationId: CorrelationId;
}

function correlationOf(container: Container): CorrelationId {
  return currentCorrelationId() ?? newCorrelationId(container.ids.uuid());
}

/**
 * Authenticates, counts and (for a gated route) gates one request.
 *
 * `gated: false` is for exactly the routes the bot exempts from its gates or that read the
 * gate itself: `/me` (which reports it), the membership re-check, accepting the terms, and
 * the support screen. Every other route refuses while a gate holds the customer — in the
 * bot a held turn never reaches `act`, and here a held request never reaches a service.
 */
export async function miniAppCall(
  container: Container,
  request: FastifyRequest,
  options: { readonly gated: boolean },
): Promise<MiniAppCall> {
  const correlationId = correlationOf(container);
  const header = request.headers['authorization'];
  const context = await container.miniApp.sessions.authenticate(
    typeof header === 'string' ? header : undefined,
  );
  await container.miniApp.rateLimit.check(
    {
      tenantId: context.scope.tenantId,
      botInstanceId: context.botInstanceId,
      subject: `customer:${context.customer.id}`,
    },
    MINIAPP_RATE_LIMIT_REQUESTS,
  );
  if (options.gated) await container.miniApp.sessions.assertUngated(context, correlationId);
  return {
    context,
    actor: miniAppActor(`miniapp:${context.sessionId}`, correlationId),
    correlationId,
  };
}

/** The session endpoint's own budget: per client address, before anything is verified. */
export async function sessionRateLimit(
  container: Container,
  request: FastifyRequest,
  botInstanceId: string,
): Promise<void> {
  await container.miniApp.rateLimit.check(
    { tenantId: 'session', botInstanceId, subject: `ip:${request.ip}` },
    MINIAPP_SESSION_RATE_LIMIT_REQUESTS,
  );
}

export function sessionCorrelation(container: Container): CorrelationId {
  return correlationOf(container);
}

/**
 * The client's idempotency key, namespaced to this bot, this customer and this operation:
 * `miniapp:<bot>:<customer>:<key>:<operation>`. So a key a client invents can only ever
 * replay its own customer's own operation, and never collides with the bot's
 * `telegram:<bot>:update:<id>` keys in the namespaces both surfaces share.
 */
export function miniAppKey(request: FastifyRequest, call: MiniAppCall, operation: string): string {
  const raw = request.headers[MINIAPP_IDEMPOTENCY_HEADER];
  const parsed = miniAppIdempotencyKeySchema.safeParse(typeof raw === 'string' ? raw : undefined);
  if (!parsed.success) {
    throw errors.validation(
      MINIAPP_ERROR_CODES.MINIAPP_REQUEST_INVALID,
      `A state-changing request carries an ${MINIAPP_IDEMPOTENCY_HEADER} header.`,
    );
  }
  return `miniapp:${call.context.botInstanceId}:${call.context.customer.id}:${parsed.data}:${operation}`;
}

/** A body or query parsed against its contract, refused with the mini app's own code. */
export function parseWith<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    throw errors.validation(
      MINIAPP_ERROR_CODES.MINIAPP_REQUEST_INVALID,
      'The request is invalid.',
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    );
  }
  return parsed.data;
}

/** One not-found answer for "not yours" and "does not exist". */
export function notFound(): NexaError {
  return errors.notFound(MINIAPP_ERROR_CODES.MINIAPP_NOT_FOUND, 'Not found.');
}

/**
 * Runs a read that names an id the customer sent, and turns the services' own not-found
 * refusals for it into the mini app's one not-found answer.
 */
export async function owned<T>(read: () => Promise<T | null>): Promise<T> {
  let value: T | null;
  try {
    value = await read();
  } catch (error) {
    if (error instanceof NexaError && error.kind === 'NOT_FOUND') throw notFound();
    throw error;
  }
  if (value === null) throw notFound();
  return value;
}
