import { createHash, randomBytes } from 'node:crypto';
import {
  RESELLER_WEB_LINK_TTL_SECONDS,
  RESELLER_WEB_LOGIN_PAGE_PATH,
  RESELLER_WEB_SECOND_FACTOR_TTL_SECONDS,
  RESELLER_WEB_SESSION_ABSOLUTE_SECONDS,
  RESELLER_WEB_SESSION_IDLE_SECONDS,
  type ResellerWebSessionState,
} from '@nexa/contracts';

/**
 * PR-4 — the reseller panel's two bearer secrets: the one-time sign-in link's token and the
 * session token in the cookie. Both are 256 random bits, base64url (43 characters); only a
 * DOMAIN-SEPARATED SHA-256 is stored, so a database read cannot be replayed as either, and a
 * token of another kind (an admin session, a hosting enter link) never hashes to one of these.
 * A plain hash is right: the input is already uniform randomness, there is nothing to guess.
 */
export function generateAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashLinkToken(token: string): string {
  return createHash('sha256').update(`nexa.reseller_web_link.v1\n${token}`, 'utf8').digest('hex');
}

export function hashResellerSessionToken(token: string): string {
  return createHash('sha256')
    .update(`nexa.reseller_web_session.v1\n${token}`, 'utf8')
    .digest('hex');
}

/** Ten minutes from `now`, by the injected `Clock`. */
export function linkExpiry(now: Date): Date {
  return new Date(now.getTime() + RESELLER_WEB_LINK_TTL_SECONDS * 1000);
}

/**
 * The address the reseller opens: the tenant's own web origin, the token in the FRAGMENT so it
 * is never sent to a server, logged by a proxy or kept in a Referer.
 */
export function loginUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/u, '')}${RESELLER_WEB_LOGIN_PAGE_PATH}#token=${token}`;
}

/** The end a NEW session gets: five minutes while its code is owed, else 90 days. */
export function sessionAbsoluteEnd(now: Date, state: ResellerWebSessionState): Date {
  const seconds =
    state === 'PENDING_SECOND_FACTOR'
      ? RESELLER_WEB_SECOND_FACTOR_TTL_SECONDS
      : RESELLER_WEB_SESSION_ABSOLUTE_SECONDS;
  return new Date(now.getTime() + seconds * 1000);
}

/** What decides whether a session row still authorises a request. */
export interface SessionLifeFacts {
  readonly state: ResellerWebSessionState;
  readonly lastSeenAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly endedAt: Date | null;
}

/**
 * Live = not ended, before its absolute end, and seen within the idle window (30 days). The
 * state is the caller's question: an ACTIVE session for every route but the code step, a
 * PENDING one for the code step only.
 */
export function sessionLive(
  session: SessionLifeFacts,
  now: Date,
  state: ResellerWebSessionState,
): boolean {
  if (session.endedAt !== null || session.state !== state) return false;
  if (now.getTime() >= session.absoluteExpiresAt.getTime()) return false;
  return now.getTime() < session.lastSeenAt.getTime() + RESELLER_WEB_SESSION_IDLE_SECONDS * 1000;
}

/** `last_seen_at` is written at most once a minute per session, not once per request. */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;
