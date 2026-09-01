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
 * Reads the session token.
 *
 * Cookie first: it is the browser path and cannot be read by script. A bearer
 * header is accepted for non-browser callers, and accepting it does NOT weaken
 * the CSRF story — a cross-origin page can cause a cookie to be sent, but it
 * cannot set an Authorization header.
 */
export function readSessionToken(request: FastifyRequest): string | null {
  const cookies = parseCookies(request.headers.cookie);
  const fromCookie = cookies.get(SESSION_COOKIE_NAME);
  if (fromCookie) return fromCookie;

  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    const token = authorization.slice('Bearer '.length).trim();
    return token.length > 0 ? token : null;
  }
  return null;
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
 * behaving. Requests carrying a bearer token skip it, because a cross-origin
 * page cannot set that header in the first place.
 */
export function assertOriginAllowed(
  request: FastifyRequest,
  allowedOrigins: readonly string[],
  usedCookie: boolean,
): void {
  const method = (request.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  if (!usedCookie) return;
  if (allowedOrigins.length === 0) return;

  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !allowedOrigins.includes(origin)) {
    throw errors.permissionDenied(
      IDENTITY_ERROR_CODES.AUTH_ORIGIN_REJECTED,
      'The request origin is not permitted for a cookie-authenticated write.',
    );
  }
}

export function usedCookieAuth(request: FastifyRequest): boolean {
  return parseCookies(request.headers.cookie).has(SESSION_COOKIE_NAME);
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
    const value = part.slice(index + 1).trim();
    if (name.length > 0) cookies.set(name, decodeURIComponent(value));
  }
  return cookies;
}
