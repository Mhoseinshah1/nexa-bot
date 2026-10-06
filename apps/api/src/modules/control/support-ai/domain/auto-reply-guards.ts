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

/**
 * D9 — the money guard: a deterministic look at what the CUSTOMER wrote, before any provider is
 * asked. The topic guard above trusts the model's `topic`, and a model can label «وصل نمیشه،
 * پولمو پس بدید» `CONNECTION_TROUBLESHOOTING` and answer the half it likes. Anything that
 * mentions money coming back, a payment, a wallet or a balance is a person's to answer, so a
 * match hands off as a hard topic (`HANDOFF_TOPIC`, which opens or links the ticket) and no
 * automatic reply is ever produced for it.
 *
 * Fail closed by design: a false positive (a customer asking how to pay) costs a handoff, never
 * a wrong answer about money. The text is folded first — Arabic `ي`/`ك` to Persian, ZWNJ and the
 * other zero-width joiners removed, diacritics and tatweel dropped, lower case — so «پول‌مو»,
 * «پولمو», «پس‌بدید» and «پس بدید» read alike.
 */
const MONEY_TERMS: readonly RegExp[] = [
  // Money itself, an amount, and the wallet («کیف پول»): پول, پولم, پولمو, پولامو, مبلغ …
  /(?<!\p{L})(?:پول|مبلغ)/u,
  // «وجه» alone is also «به هیچ وجه» (by no means): only the possessive forms are money.
  /(?<!\p{L})وجه(?:م|مو|مون|مان|تان|ش)(?!\p{L})/u,
  // Money coming back: refund in every common spelling, and «پس بدید / پسش بدید / پس بگیرم».
  /(?<!\p{L})(?:ری?فا?ند|ریفند|عودت|استرداد)/u,
  /(?<!\p{L})(?:باز|بر)گشت\s*(?:وجه|هزینه)/u,
  /(?<!\p{L})پس\S{0,3}\s*(?:بده|بدید|بدهید|بدین|بدن|بدیم|بگیر\S*|گرفتن)(?!\p{L})/u,
  // Payment, deposit, transaction, a deduction, the balance.
  /پرداخت|واریز|تراکنش|کارت\s*به\s*کارت|(?<!\p{L})فیش|کسر\s*(?:شد|شده|کرد)|برداشت\s*(?:شد|شده|کرد)|موجودی|شارژ\s*(?:حساب|کیف)/u,
  // The same in English and in Latin-letter Persian (Finglish).
  /\b(?:refund\w*|reimburs\w*|money\s*back|charge\s*back|chargeback|wallet|payments?|paid|pay|deducted|transactions?|balance|my\s+money|pool\w*|pardakht\w*|variz\w*|kife?\s*pool)\b/u,
];

/** The text a customer typed, folded so a spelling or joiner variant matches the same term. */
export function foldCustomerText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[يى]/gu, 'ی')
    .replace(/ك/gu, 'ک')
    .replace(/ة/gu, 'ه')
    .replace(/[أإٱ]/gu, 'ا')
    .replace(/[ً-ٰٟـ]/gu, '')
    .replace(/[​-‏⁠﻿]/gu, '')
    .replace(/\s+/gu, ' ');
}

/** Whether a customer's text mentions a refund, money, a payment, a wallet or a balance. */
export function mentionsMoneyTopic(text: string | null): boolean {
  if (text === null) return false;
  const folded = foldCustomerText(text);
  return MONEY_TERMS.some((term) => term.test(folded));
}

/**
 * Before the provider call: every customer text the reply would answer (the trigger and the
 * customer's messages since the business last spoke). A money mention in any of them hands off.
 */
export function autoMoneyGuard(customerTexts: readonly (string | null)[]): AutoVerdict {
  return customerTexts.some(mentionsMoneyTopic) ? fail('handoff_topic', 'HANDOFF_TOPIC') : PASS;
}

/**
 * What the reply would answer: the trigger's text and every customer message after the business
 * last spoke (a customer who writes «پولمو پس بدید» and then «وصل نمیشه» is answered once, on
 * the newer trigger, and the older line is still theirs to be answered about).
 */
export function customerTextsSinceReply(
  lines: readonly { readonly origin: BusinessMessageOrigin; readonly text: string | null }[],
  triggerText: string | null,
): readonly (string | null)[] {
  const texts: (string | null)[] = [triggerText];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || line.origin !== 'INBOUND') break;
    texts.push(line.text);
  }
  return texts;
}
