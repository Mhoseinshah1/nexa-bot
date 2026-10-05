import {
  BUSINESS_MESSAGE_TEXT_MAX,
  SUPPORT_AI_GENERAL_TOPICS,
  SUPPORT_AI_HANDOFF_TOPICS,
  type BusinessHandoffReason,
  type BusinessMessageKind,
  type BusinessMessageOrigin,
  type SupportAiAutoGuard,
  type SupportAiAutoOutcome,
  type SupportAiConfidence,
  type SupportAiConfigInput,
  type SupportAiDecision,
} from '@nexa/contracts';

/**
 * TB7 — the deterministic guards between a model's decision and an automatic reply (program
 * §26). Pure: no clock, no database, no provider. The model proposes; THIS decides, and every
 * guard must pass for anything to be sent.
 *
 * Fail closed, always: a guard that fails hands the conversation to a person, including the
 * one that merely means "this topic is not on the allowlist" — an empty allowlist therefore
 * means no automatic reply is ever sent.
 */

export type AutoVerdict =
  | { readonly pass: true }
  | {
      readonly pass: false;
      readonly guard: SupportAiAutoGuard | null;
      readonly outcome: SupportAiAutoOutcome;
      readonly reason: BusinessHandoffReason;
    };

const PASS: AutoVerdict = { pass: true };

function fail(guard: SupportAiAutoGuard, reason: BusinessHandoffReason): AutoVerdict {
  return { pass: false, guard, outcome: `guard_${guard}`, reason };
}

/** The facts the guards read from the TB3 payload (`supportContextFlagsSchema`). */
export interface AutoContextFlags {
  readonly identityLinked: boolean;
  readonly customerBlocked: boolean;
  readonly hasUnderReviewPayment: boolean;
  readonly hasUnreconciledService: boolean;
}

/**
 * Before the provider is called (no cost is spent on a reply that could never be sent):
 * the trigger is a customer's own readable text, the customer is not blocked, and the loop
 * guard has room.
 */
export function autoPreflight(input: {
  /** The trigger message as stored now; null when it is gone. */
  readonly trigger: {
    readonly origin: BusinessMessageOrigin;
    readonly kind: BusinessMessageKind;
    readonly text: string | null;
    readonly deleted: boolean;
  } | null;
  readonly customerBlocked: boolean;
  /** AUTO replies since a person last acted (at the current epoch). */
  readonly autoAtEpoch: number;
  /** AUTO replies in the window, whatever the epoch. */
  readonly autoInWindow: number;
  readonly maxConsecutiveReplies: number;
  readonly maxPerWindow: number;
}): AutoVerdict {
  const trigger = input.trigger;
  // Only a customer's own message is ever answered — never our echo, an away message or a
  // human's message (the trigger is recorded INBOUND or it is not a trigger at all). It is
  // readable text, or a photo (TB6): whether the photo can actually be SEEN is decided after
  // it is fetched, and an unseen one hands off too. Anything else (a file, a sticker) cannot
  // be read at all.
  const readable =
    trigger !== null &&
    !trigger.deleted &&
    ((trigger.kind === 'TEXT' && trigger.text !== null && trigger.text.trim() !== '') ||
      trigger.kind === 'PHOTO');
  if (trigger === null || trigger.origin !== 'INBOUND' || !readable) {
    return fail('content', 'UNSUPPORTED_CONTENT');
  }
  if (input.customerBlocked) return fail('customer_blocked', 'CUSTOMER_BLOCKED');
  if (input.autoAtEpoch >= input.maxConsecutiveReplies) return fail('consecutive', 'LOOP_GUARD');
  if (input.autoInWindow >= input.maxPerWindow) return fail('window', 'LOOP_GUARD');
  return PASS;
}

const CONFIDENCE_RANK: Readonly<Record<SupportAiConfidence, number>> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
};

/**
 * TB6 × TB7 — the image rule, after the images were fetched: a customer image the reply would
 * be about (the trigger, or the customer's latest message) that no model could SEE hands off.
 * A model that cannot see it would answer the caption, or nothing, as though it had looked.
 */
export function autoImageGuard(input: {
  /** The message ids of the images that must be seen: the trigger's and the latest inbound. */
  readonly required: readonly string[];
  /** The images actually loaded (sniffed, bounded) for this request. */
  readonly loaded: ReadonlySet<string>;
}): AutoVerdict {
  if (input.required.some((id) => !input.loaded.has(id))) {
    return fail('content', 'UNSUPPORTED_CONTENT');
  }
  return PASS;
}

/** After the decision: every guard must pass for a lane row to be enqueued. */
export function autoDecisionGuards(input: {
  readonly decision: SupportAiDecision;
  readonly config: Pick<
    SupportAiConfigInput,
    'autoTopics' | 'autoMinConfidence' | 'maxOutputChars'
  >;
  readonly flags: AutoContextFlags;
  /** The aliases the NEXA payload actually contained. */
  readonly knownAliases: ReadonlySet<string>;
}): AutoVerdict {
  const { decision, config, flags } = input;
  // The model itself asked for a person: never second-guessed into a reply.
  if (decision.decision === 'HANDOFF' || decision.decision === 'CREATE_OR_LINK_TICKET') {
    return { pass: false, guard: null, outcome: 'handoff_ai_requested', reason: 'AI_REQUESTED' };
  }
  if (decision.topic === 'HUMAN_REQUESTED') return fail('human_requested', 'HUMAN_REQUESTED');
  if ((SUPPORT_AI_HANDOFF_TOPICS as readonly string[]).includes(decision.topic)) {
    return fail('handoff_topic', 'HANDOFF_TOPIC');
  }
  if (decision.decision !== 'REPLY') return fail('decision', 'DECISION_NOT_REPLY');
  if (!(config.autoTopics as readonly string[]).includes(decision.topic)) {
    return fail('topic_allowlist', 'TOPIC_NOT_ALLOWED');
  }
  if (
    !flags.identityLinked &&
    !(SUPPORT_AI_GENERAL_TOPICS as readonly string[]).includes(decision.topic)
  ) {
    return fail('identity', 'IDENTITY_UNVERIFIED');
  }
  if (flags.hasUnderReviewPayment || flags.hasUnreconciledService) {
    return fail('account_review', 'ACCOUNT_UNDER_REVIEW');
  }
  if (CONFIDENCE_RANK[decision.confidence] < CONFIDENCE_RANK[config.autoMinConfidence]) {
    return fail('confidence', 'LOW_CONFIDENCE');
  }
  const reply = decision.replyText.trim();
  if (
    reply === '' ||
    reply.length > config.maxOutputChars ||
    reply.length > BUSINESS_MESSAGE_TEXT_MAX
  ) {
    return fail('reply_bounds', 'REPLY_OUT_OF_BOUNDS');
  }
  // A fact the payload did not contain is not evidence of anything (support-ai.ts).
  if (decision.factRefs.some((ref) => !input.knownAliases.has(ref))) {
    return fail('grounding', 'INSUFFICIENT_GROUNDING');
  }
  return PASS;
}
