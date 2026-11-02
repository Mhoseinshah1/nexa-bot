import type {
  BusinessAutoResumeTrigger,
  BusinessConversationState,
  BusinessHandoffKind,
} from '@nexa/contracts';

/**
 * Phase 4 PR-1 — whether a person's SOFT hold on a conversation has ended, decided when the
 * customer next writes (under the conversation's lock, before any automatic work is enqueued).
 * Pure: no clock, no database.
 *
 * Only a `SOFT` hold returns. A `HARD` one (money dispute, refund, credentials, security, a
 * request for a person, abuse, an operator's takeover) and every hold from before the kind
 * existed (`null`) stay with the person until an operator returns the conversation. A window of
 * zero (`support.ai.resume_after_minutes = 0`) means never, for every trigger.
 *
 * The triggers, most specific first:
 *
 * - `RESOLVED` — the handoff's ticket was closed (a handed-off conversation only: a person's
 *   message carries no ticket of its own, so an old closed ticket never counts for it);
 * - `NEW_SESSION` — the customer writes after the conversation was silent for the window
 *   (and no person wrote in it either);
 * - `HUMAN_SILENT` — no person wrote for the window since the hold began (the handoff, the
 *   person's last word in Telegram, or their last reply from the Web Admin).
 *   Without a known start the hold stays (fail sticky).
 */
export function autoResumeTrigger(input: {
  readonly state: BusinessConversationState;
  readonly handoffKind: BusinessHandoffKind | null;
  readonly windowMinutes: number;
  /** The conversation's last message before this one; null when none. */
  readonly previousMessageAt: Date | null;
  /** The person's last word (`last_human_at`). */
  readonly lastHumanAt: Date | null;
  /**
   * The hold's own latest activity at the current epoch: when its handoff was recorded, or the
   * latest reply a person sent from the Web Admin (an operator's or a reviewed draft).
   */
  readonly holdActivityAt: Date | null;
  readonly ticketClosed: boolean;
  readonly now: Date;
}): BusinessAutoResumeTrigger | null {
  if (input.windowMinutes <= 0) return null;
  if (input.handoffKind !== 'SOFT') return null;
  if (input.state !== 'HANDOFF_REQUIRED' && input.state !== 'HUMAN_ACTIVE') return null;
  const windowMs = input.windowMinutes * 60_000;
  const now = input.now.getTime();
  if (input.state === 'HANDOFF_REQUIRED' && input.ticketClosed) return 'RESOLVED';
  // A person who wrote inside the window still holds it, however long the customer was quiet.
  const starts = [input.lastHumanAt, input.holdActivityAt]
    .filter((at): at is Date => at !== null)
    .map((at) => at.getTime());
  if (starts.length === 0) return null;
  if (now - Math.max(...starts) < windowMs) return null;
  if (input.previousMessageAt !== null && now - input.previousMessageAt.getTime() >= windowMs) {
    return 'NEW_SESSION';
  }
  return 'HUMAN_SILENT';
}
