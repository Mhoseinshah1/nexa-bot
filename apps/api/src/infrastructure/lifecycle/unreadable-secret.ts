import { NexaError, PLATFORM_ERROR_CODES } from '@nexa/contracts';

/**
 * NEXA-FIX-RESTORE-SECRETS §2.6: whether an error means "a stored secret cannot be read" —
 * its ciphertext failed authenticated decryption, or it names a key this installation does
 * not hold. Either way nothing a loop does on its next tick changes it: only re-entering the
 * value does. `UnreadableSecretReporter` turns the first such failure into ONE log line and
 * ONE Web Admin alert per secret kind, so a loop that meets it says nothing more itself.
 *
 * Follows `cause` (a few links), because an adapter may wrap the cipher's error in its own.
 */
const UNREADABLE_CODES: ReadonlySet<string> = new Set([
  PLATFORM_ERROR_CODES.SECRET_AUTH_FAILED,
  PLATFORM_ERROR_CODES.SECRET_KEY_UNKNOWN,
]);

export function isUnreadableSecretError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof NexaError && UNREADABLE_CODES.has(current.code)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
