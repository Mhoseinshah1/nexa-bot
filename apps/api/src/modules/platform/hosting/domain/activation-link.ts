import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  HOSTED_ACTIVATION_LINK_TTL_SECONDS,
  type HostedActivationLinkState,
} from '@nexa/contracts';

/**
 * Phase 6A PR-4 — the one-time activation link's token.
 *
 * 32 bytes from the CSPRNG, base64url, with a recognisable prefix (a leaked one is easy to
 * grep for and easy to tell from a session token). Only a domain-separated SHA-256 is stored:
 * the input is 256 bits of randomness, so a plain hash is right (nothing to brute-force) and a
 * database read cannot be replayed as a link.
 */
export const ACTIVATION_TOKEN_PREFIX = 'nxact_';

export function generateActivationToken(): string {
  return `${ACTIVATION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashActivationToken(token: string): string {
  return createHash('sha256').update(`nexa.hosted_activation.v1\n${token}`, 'utf8').digest('hex');
}

/** Constant-time equality of two hex digests of the same length. */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function activationLinkExpiry(now: Date): Date {
  return new Date(now.getTime() + HOSTED_ACTIVATION_LINK_TTL_SECONDS * 1000);
}

export interface ActivationLinkFacts {
  readonly usedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date;
}

/** A revoked link reads as expired: it was replaced by a newer one, and is no longer good. */
export function activationLinkState(
  link: ActivationLinkFacts,
  now: Date,
): HostedActivationLinkState {
  if (link.usedAt !== null) return 'USED';
  if (link.revokedAt !== null || link.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'ACTIVE';
}
