import type {
  BusinessAutoResumeTrigger,
  BusinessHandoffKind,
  SupportAiTicketHoldState,
} from '@nexa/contracts';
import { autoResumeTrigger } from '../../../commerce/business-chats/domain/auto-resume.js';

/**
 * Phase 4 PR-4 — whether the support AI may answer a ticket now. Pure: no clock, no database.
 *
 * It is the Business chats' resume rule (`autoResumeTrigger`), fed by a ticket's own facts, so
 * one rule decides both channels:
 *
 * - A HARD handoff is sticky. Nothing a customer writes returns the ticket to the AI.
 * - A person's reply in the ticket (an `ADMIN` message after the AI last took the ticket) holds
 *   it SOFT: the AI waits `support.ai.resume_after_minutes` of the person's silence (or a
 *   customer's return after that long a quiet), then answers again. A window of 0 means never.
 * - A SOFT handoff by the AI itself is held the same way, from the moment it was recorded.
 * - No hold row and no person's reply: the AI answers.
 *
 * A person's reply is DERIVED from the ticket's messages, not stored: it works when the owner
 * switches the AI on after a person already answered, and it needs no hook in the reply path.
 */
export interface TicketAiHold {
  readonly state: SupportAiTicketHoldState;
  readonly epoch: number;
  readonly handoffKind: BusinessHandoffKind | null;
  readonly heldAt: Date;
}

export type TicketAiGate =
  /** The AI answers, under this epoch. */
  | { readonly kind: 'ANSWER'; readonly epoch: number }
  /** The AI takes the ticket back: the caller writes `AI_ACTIVE` at `epoch`. */
  | {
      readonly kind: 'RESUME';
      readonly epoch: number;
      readonly trigger: BusinessAutoResumeTrigger;
    }
  | {
      readonly kind: 'PAUSED';
      readonly why: 'HARD_HANDOFF' | 'SOFT_HANDOFF' | 'PERSON_REPLIED';
      readonly epoch: number;
    };

export function ticketAiGate(input: {
  readonly hold: TicketAiHold | null;
  /** The newest `ADMIN` message of the ticket; null when no person replied. */
  readonly lastAdminAt: Date | null;
  /** The message before the one being answered; null when it is the first. */
  readonly previousMessageAt: Date | null;
  /** `support.ai.resume_after_minutes` (0 = never). */
  readonly windowMinutes: number;
  readonly now: Date;
}): TicketAiGate {
  const { hold } = input;
  const epoch = hold?.epoch ?? 0;
  if (hold !== null && hold.state !== 'AI_ACTIVE' && hold.handoffKind !== 'SOFT') {
    // HARD, or a kind that is somehow missing: sticky, fail closed.
    return { kind: 'PAUSED', why: 'HARD_HANDOFF', epoch };
  }
  // A person's reply counts only if it came after the AI last took the ticket (a resume).
  const personAt =
    input.lastAdminAt !== null &&
    (hold === null ||
      hold.state !== 'AI_ACTIVE' ||
      input.lastAdminAt.getTime() > hold.heldAt.getTime())
      ? input.lastAdminAt
      : null;
  const handedOff = hold !== null && hold.state === 'HANDOFF_REQUIRED';
  if (!handedOff && personAt === null) return { kind: 'ANSWER', epoch };
  const trigger = autoResumeTrigger({
    state: handedOff ? 'HANDOFF_REQUIRED' : 'HUMAN_ACTIVE',
    handoffKind: 'SOFT',
    windowMinutes: input.windowMinutes,
    previousMessageAt: input.previousMessageAt,
    lastHumanAt: personAt,
    holdActivityAt: handedOff ? hold.heldAt : null,
    ticketClosed: false,
    now: input.now,
  });
  if (trigger === null) {
    return { kind: 'PAUSED', why: handedOff ? 'SOFT_HANDOFF' : 'PERSON_REPLIED', epoch };
  }
  return { kind: 'RESUME', epoch: epoch + 1, trigger };
}
