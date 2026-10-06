import type { ProviderLastSeen } from '@nexa/contracts';

/**
 * How far past the read a panel's "last connection" may lie and still be shown (C1).
 *
 * A last connection is in the past by definition. A panel whose clock runs a little fast
 * can put it slightly after our read, which is tolerated; a time further ahead than this
 * is a misread time zone (naive Tehran read as UTC is +3:30) or a broken panel, and is
 * not a time the customer should be shown.
 */
export const LAST_SEEN_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * The provider's answer, refused when it is a time more than the tolerance after
 * `readAt` — the Clock's time of the read, never a `new Date()` here. Refused means
 * UNSUPPORTED, which stores nothing: the card keeps the last value a read proved.
 */
export function boundedLastSeen(lastSeen: ProviderLastSeen, readAt: Date): ProviderLastSeen {
  if (lastSeen.kind !== 'AT') return lastSeen;
  return lastSeen.at.getTime() > readAt.getTime() + LAST_SEEN_FUTURE_TOLERANCE_MS
    ? { kind: 'UNSUPPORTED' }
    : lastSeen;
}
