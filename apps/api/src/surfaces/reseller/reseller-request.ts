import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import {
  RESELLER_IDEMPOTENCY_HEADER,
  RESELLER_SESSION_COOKIE_NAME,
  RESELLER_SESSION_COOKIE_NAME_SECURE,
  RESELLER_WEB_ERROR_CODES,
  errors,
  resellerIdempotencyKeySchema,
  type CorrelationId,
  type TenantContext,
  type TenantId,
} from '@nexa/contracts';
import type { Container } from '../../container.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type {
  RequestFacts,
  ResellerWebContext,
} from '../../modules/commerce/reseller-panel/application/reseller-web-access.service.js';
import { assertOriginOrHostedDomain, readCookie } from '../web/authenticated-request.js';

/**
 * PR-4 — the one door every reseller panel request passes.
 *
 * The TENANT is the one the request's Host names: a hosted tenant's verified domain resolves
 * to that tenant, and every other host to the installation. Never the body, never the cookie.
 * Then the flag (off: the route does not exist), the Origin of a write (the CSRF layer behind
 * `SameSite=Strict`), and the session — read from the reseller cookie ONLY, so the Web Admin's
 * cookie can never authorise a reseller route, and nothing here is read by an admin route.
 */
export function isProduction(container: Container): boolean {
  return container.config.NODE_ENV === 'production';
}

export function correlationOf(container: Container): CorrelationId {
  return currentCorrelationId() ?? newCorrelationId(container.ids.uuid());
}

export function requestFacts(container: Container, request: FastifyRequest): RequestFacts {
  return {
    ip: request.ip ?? null,
    userAgent:
      typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    correlationId: correlationOf(container),
  };
}

/** The tenant this request's Host belongs to; the panel answers 404 when there is none. */
export async function resellerTenant(
  container: Container,
  request: FastifyRequest,
): Promise<TenantContext> {
  const hosted = await container.hostedOwnerActivation.resolveHost(request.hostname);
  const tenantId = hosted?.hostedTenantId ?? container.installationTenantId;
  if (tenantId === null || tenantId === undefined) {
    throw errors.notFound(RESELLER_WEB_ERROR_CODES.UNAVAILABLE, 'Not available.');
  }
  return { tenantId: tenantId as TenantId, botInstanceId: null };
}

/** The reseller session cookie, by its own names only (production: `__Host-` only). */
export function readResellerToken(container: Container, request: FastifyRequest): string | null {
  return readCookie(
    request,
    isProduction(container)
      ? [RESELLER_SESSION_COOKIE_NAME_SECURE]
      : [RESELLER_SESSION_COOKIE_NAME_SECURE, RESELLER_SESSION_COOKIE_NAME],
  );
}

/** The tenant, the flag, the Origin of a write — everything before a session is looked at. */
export async function resellerGate(
  container: Container,
  request: FastifyRequest,
): Promise<TenantContext> {
  const tenant = await resellerTenant(container, request);
  if (!(await container.resellerWeb.access.panelEnabled(tenant))) {
    throw errors.notFound(RESELLER_WEB_ERROR_CODES.UNAVAILABLE, 'Not available.');
  }
  await assertOriginOrHostedDomain(container, request);
  return tenant;
}

/** An authenticated reseller request: who, re-checked now (ACTIVE reseller, live session). */
export async function resellerCall(
  container: Container,
  request: FastifyRequest,
): Promise<ResellerWebContext> {
  const tenant = await resellerGate(container, request);
  return container.resellerWeb.access.authenticate(
    tenant,
    requestFacts(container, request),
    readResellerToken(container, request),
  );
}

/**
 * The session cookie: its own name, `HttpOnly`, `SameSite=Strict`, `Path=/`, the session's
 * absolute end; `Secure` and the `__Host-` prefix wherever the deployment has TLS (production),
 * exactly as the admin cookie (a plain-HTTP development server could not store it otherwise).
 */
export function resellerCookie(production: boolean, token: string, expiresAt: Date): string {
  const attributes = [
    `${production ? RESELLER_SESSION_COOKIE_NAME_SECURE : RESELLER_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (production) attributes.push('Secure');
  return attributes.join('; ');
}

export function setResellerCookie(
  container: Container,
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
): void {
  void reply.header('set-cookie', resellerCookie(isProduction(container), token, expiresAt));
}

export function clearResellerCookie(container: Container, reply: FastifyReply): void {
  void reply.header('set-cookie', resellerCookie(isProduction(container), '', new Date(0)));
}

/**
 * The client's idempotency key, namespaced to this tenant, this reseller and this operation:
 * `reseller:<tenant>:<customer>:<key>:<operation>`. A key a browser invents can only ever replay
 * its own reseller's own operation.
 */
export function resellerKey(
  request: FastifyRequest,
  context: ResellerWebContext,
  operation: string,
): string {
  const raw = request.headers[RESELLER_IDEMPOTENCY_HEADER];
  const parsed = resellerIdempotencyKeySchema.safeParse(typeof raw === 'string' ? raw : undefined);
  if (!parsed.success) {
    throw errors.validation(
      RESELLER_WEB_ERROR_CODES.REQUEST_INVALID,
      `A state-changing request carries an ${RESELLER_IDEMPOTENCY_HEADER} header.`,
    );
  }
  return `reseller:${context.scope.tenantId}:${context.customer.id}:${parsed.data}:${operation}`;
}

/** A body or query parsed against its contract, refused with the panel's own code. */
export function parseWith<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    throw errors.validation(RESELLER_WEB_ERROR_CODES.REQUEST_INVALID, 'The request is invalid.', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}
