import { createHash, randomBytes } from 'node:crypto';
import { HOSTED_ENTER_PAGE_PATH, HOSTED_ENTER_TOKEN_TTL_SECONDS } from '@nexa/contracts';

/**
 * Phase 6B «ورود به پنل» (ADR-0039 § 9 refinement 2): the token that carries the owner from
 * «میزبانی‌ها» to a hosted bot's own domain.
 *
 * 256 random bits, base64url; only a domain-separated SHA-256 is stored, so a database read
 * cannot be replayed as an entry, and a token of another kind (a session, an activation link)
 * never hashes to one of these.
 */
export function generateEnterToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashEnterToken(token: string): string {
  return createHash('sha256').update(`nexa.hosting_enter.v1\n${token}`, 'utf8').digest('hex');
}

/** Fifteen minutes from `now`, by the injected `Clock`. */
export function enterTokenExpiry(now: Date): Date {
  return new Date(now.getTime() + HOSTED_ENTER_TOKEN_TTL_SECONDS * 1000);
}

/** The address the owner opens: the hosted domain, the token in the FRAGMENT (never sent). */
export function enterUrl(domain: string, token: string): string {
  return `https://${domain}${HOSTED_ENTER_PAGE_PATH}#token=${token}`;
}

/**
 * The HOST principal's username: fixed per principal id, inside the admins' username shape.
 * It never signs in (no password), so it only has to be unique in its tenant.
 */
export function hostPrincipalUsername(adminId: string): string {
  return `host.${adminId.replace(/-/g, '').slice(-12)}`;
}
