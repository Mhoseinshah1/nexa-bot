import type { FastifyRequest } from 'fastify';
import {
  errors,
  IDENTITY_ERROR_CODES,
  SESSION_COOKIE_NAME,
  type ActorContext,
  type Admin,
  type AdminSession,
  type CorrelationId,
  type TenantContext,
} from '@nexa/contracts';

/**
 * Turning an HTTP request into an authenticated actor.
 *
 * The session is presented either as an httpOnly cookie (the browser admin) or
 * as a bearer token (a script or a test). Both resolve to the same session row;
 * neither carries any authority of its own, because permissions are resolved
 * per request from the database rather than read out of the credential.
 */

export interface AuthenticatedContext {
  readonly scope: TenantContext;
  readonly actor: ActorContext;
  readonly admin: Admin;
  readonly session: AdminSession;
}

/**
 * Reads the session token. The cookie is the ONLY transport.
 *
 * An earlier version also accepted `Authorization: Bearer`, for non-browser
 * callers. Login no longer returns the token in its body, so nothing can obtain
 * one to present — which made bearer an authentication path that no legitimate
 * client could use and an attacker could still try. An unreachable way in is
 * not a feature.
 *
 * A CLI or API credential, if one is ever wanted, is a separate surface with
 * its own issuance, scope, lifetime and revocation. It is not this cookie
 * wearing a different header name.
 */
export function readSessionToken(request: FastifyRequest): string | null {
  return parseCookies(request.headers.cookie).get(SESSION_COOKIE_NAME) ?? null;
}

export function requireSessionToken(request: FastifyRequest): string {
  const token = readSessionToken(request);
  if (token === null) {
    throw errors.unauthenticated(
      IDENTITY_ERROR_CODES.AUTH_REQUIRED,
      'Authentication is required for this endpoint.',
    );
  }
  return token;
}

/**
 * The second half of the CSRF defence, behind `SameSite=Strict`.
 *
 * SameSite alone is a browser-side control: it is enforced by the client, and
 * an older or unusual client that does not enforce it leaves the cookie
 * exposed. Checking the Origin server-side does not depend on the browser
 * behaving.
 *
 * It now applies to every state-changing request without exception. While
 * bearer tokens were accepted there was a carve-out for them — sound at the
 * time, since a cross-origin page cannot set that header, but a carve-out all
 * the same. With the cookie as the only transport, there is nothing to carve
 * out.
 */
export function assertOriginAllowed(
  request: FastifyRequest,
  allowedOrigins: readonly string[],
): void {
  const method = (request.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  // Empty only outside production; the config schema requires a list there.
  if (allowedOrigins.length === 0) return;

  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !allowedOrigins.includes(origin)) {
    throw errors.permissionDenied(
      IDENTITY_ERROR_CODES.AUTH_ORIGIN_REJECTED,
      'The request origin is not permitted for this write.',
    );
  }
}

/** Builds the actor for an authenticated administrator. */
export function adminActor(
  admin: Admin,
  correlationId: CorrelationId,
  request: FastifyRequest,
): ActorContext {
  return {
    type: 'WEB_ADMIN',
    id: admin.id,
    // Captured now, so an audit row still names them after a rename.
    label: admin.username,
    surface: 'WEB',
    correlationId,
    ...(request.ip ? { ip: request.ip } : {}),
    ...(typeof request.headers['user-agent'] === 'string'
      ? { userAgent: request.headers['user-agent'] }
      : {}),
  };
}

/**
 * The anonymous actor a login attempt runs as.
 *
 * Deliberately not a fabricated administrator: nobody is authenticated yet, and
 * an audit row naming an admin who has not proved who they are would be worse
 * than one naming nobody.
 */
export function anonymousActor(
  correlationId: CorrelationId,
  request: FastifyRequest,
): ActorContext {
  return {
    type: 'API',
    id: null,
    label: null,
    surface: 'WEB',
    correlationId,
    ...(request.ip ? { ip: request.ip } : {}),
    ...(typeof request.headers['user-agent'] === 'string'
      ? { userAgent: request.headers['user-agent'] }
      : {}),
  };
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (name.length === 0) continue;
    // First occurrence wins, matching every conventional cookie parser. It is
    // not a defence on its own — an attacker who can set a cookie for this host
    // can also choose a Path that sorts theirs first — but differing from the
    // convention buys nothing and surprises the next reader.
    if (cookies.has(name)) continue;
    cookies.set(name, decodeValue(part.slice(index + 1).trim()));
  }
  return cookies;
}

/**
 * A malformed percent-escape must fail authentication, not the request.
 *
 * `decodeURIComponent('%')` throws, and an unhandled throw here turns what
 * should be a 401 into a 500 — a worse answer, and one that says a header the
 * client controls can reach the error path.
 */
function decodeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
