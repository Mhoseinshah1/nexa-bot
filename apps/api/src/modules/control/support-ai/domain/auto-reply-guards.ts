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

/** Zero-width and invisible format marks (U+200B–U+200F, ZWNJ among them; U+2060; U+FEFF). */
const INVISIBLE_MARKS = /[\u200B-\u200F\u2060\uFEFF]/gu;

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

/**
 * After the decision: every guard must pass for a lane row to be enqueued.
 *
 * Two decisions may be sent (hotfix 2026-10-06): `REPLY`, and `ASK_CLARIFYING_QUESTION`, whose
 * question is `replyText`. Both pass EVERY guard below — the allowlist, identity, account
 * review, confidence, bounds (an empty question is never sent) and grounding — and a question
 * passes one more: the clarifying streak is below the tenant's limit. `NO_ACTION` is never a
 * customer message; `HANDOFF` and `CREATE_OR_LINK_TICKET` are the model asking for a person.
 */
export function autoDecisionGuards(input: {
  readonly decision: SupportAiDecision;
  readonly config: Pick<
    SupportAiConfigInput,
    'autoTopics' | 'autoMinConfidence' | 'maxOutputChars' | 'maxConsecutiveClarifyingQuestions'
  >;
  readonly flags: AutoContextFlags;
  /** The FACT aliases (`S…`, `O…`, `P…`) the NEXA payload actually contained. */
  readonly knownAliases: ReadonlySet<string>;
  /** The KNOWLEDGE aliases (`K…`) the NEXA payload actually contained. */
  readonly knownKnowledgeAliases: ReadonlySet<string>;
  /**
   * Automatic clarifying questions sent in a row at the job's epoch, since the last automatic
   * REPLY (`clarifyingStreakOf`). Read by NEXA from the rows, never from the model.
   */
  readonly clarifyingStreak: number;
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
  if (decision.decision !== 'REPLY' && decision.decision !== 'ASK_CLARIFYING_QUESTION') {
    return fail('decision', 'DECISION_NOT_REPLY');
  }
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
  // N7 (review of PR #228): a text of nothing but zero-width or invisible marks is empty too —
  // for a reply and a question alike. Judged here only; the trimmed original is what is sent.
  if (
    reply.replace(INVISIBLE_MARKS, '').trim() === '' ||
    reply.length > config.maxOutputChars ||
    reply.length > BUSINESS_MESSAGE_TEXT_MAX
  ) {
    return fail('reply_bounds', 'REPLY_OUT_OF_BOUNDS');
  }
  // A fact the payload did not contain is not evidence of anything (support-ai.ts), and neither
  // is a knowledge entry it did not carry: a citation of either is fake grounding.
  if (
    decision.factRefs.some((ref) => !input.knownAliases.has(ref)) ||
    decision.knowledgeRefs.some((ref) => !input.knownKnowledgeAliases.has(ref))
  ) {
    return fail('grounding', 'INSUFFICIENT_GROUNDING');
  }
  if (
    decision.decision === 'ASK_CLARIFYING_QUESTION' &&
    input.clarifyingStreak >= config.maxConsecutiveClarifyingQuestions
  ) {
    return fail('clarifying_limit', 'CLARIFYING_LIMIT');
  }
  return PASS;
}

/**
 * The clarifying streak: walking back from the newest, the automatic replies that count (see
 * the repository), how many are `ASK_CLARIFYING_QUESTION` before the first `REPLY`. A REPLY
 * ends the streak; a customer message does not (the point is a question, an answer, a question).
 */
export function clarifyingStreakOf(
  newestFirst: readonly { readonly decision: string | null }[],
): number {
  let streak = 0;
  for (const row of newestFirst) {
    if (row.decision === 'ASK_CLARIFYING_QUESTION') streak += 1;
    else if (row.decision === 'REPLY') break;
  }
  return streak;
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
 * a wrong answer about money. The text is folded first — Arabic `ي`/`ك` to Persian, a ZWNJ to a
 * space, the other zero-width marks, diacritics, accents and tatweel dropped, lower case — so
 * «پول‌مو», «پولمو», «کیف‌پولم», «پس‌بدید» and «پس بدید» all match.
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
  // A currency, money taken from the account, a top-up.
  /(?<!\p{L})(?:تومن|تومان|ریال)/u,
  /حساب\S{0,3}\s*کم\s*(?:شد|شده|کرد|کردن|کردید)(?!\p{L})/u,
  /شارژ\s*(?:کردم|کرده|کردیم)/u,
  // The same in English and in Latin-letter Persian (Finglish).
  /\b(?:refund\w*|reimburs\w*|money\s*back|charge\s*back|chargeback|wallet|payments?|paid|pay|deducted|transactions?|balance|my\s+money|pool\w*|pul\w*|pardakht\w*|variz\w*|kife?\s*pool|re\s+fund\w*|toman|tomen|rial)\b/u,
];

/** The text a customer typed, folded so a spelling or joiner variant matches the same term. */
export function foldCustomerText(text: string): string {
  return (
    text
      // NFKD then no combining marks: Persian diacritics and a Latin accent («réfund») alike.
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .normalize('NFC')
      .toLowerCase()
      .replace(/[\u064A\u0649]/gu, '\u06CC')
      .replace(/\u0643/gu, '\u06A9')
      .replace(/\u0629/gu, '\u0647')
      .replace(/[\u0623\u0625\u0671]/gu, '\u0627')
      .replace(/\u0640/gu, '')
      // B2: a ZWNJ separates the parts of a compound («کیف‌پولم», «پس‌بدید»): it becomes a space,
      // so a term at the start of a part still starts a word. Other zero-width marks go.
      .replace(/\u200C/gu, ' ')
      .replace(/[\u200B\u200D-\u200F\u2060\uFEFF]/gu, '')
      .replace(/\s+/gu, ' ')
  );
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

/** The origins that mean the business answered: a walk back for the customer's lines stops there. */
const REPLY_ORIGINS: ReadonlySet<BusinessMessageOrigin> = new Set([
  'OWN_ECHO',
  'HUMAN',
  'OTHER_BOT',
]);

/**
 * What the reply would answer: the trigger's text and every customer message after the business
 * last REPLIED (a customer who writes «پولمو پس بدید» and then «وصل نمیشه» is answered once, on
 * the newer trigger, and the older line is still theirs to be answered about).
 *
 * Fail closed in two ways (review B1, item 4): an away or greeting message (`OFFLINE`) is not a
 * reply, so the walk goes past it; and a customer line in the SAME second as the reply that ends
 * the walk counts as after it — a message's time is Telegram's, in whole seconds, and a reply's
 * is ours, in milliseconds, so the order inside one second is not known.
 */
export function customerTextsSinceReply(
  lines: readonly {
    readonly origin: BusinessMessageOrigin;
    readonly text: string | null;
    readonly sentAt?: Date;
  }[],
  triggerText: string | null,
): readonly (string | null)[] {
  const texts: (string | null)[] = [triggerText];
  let index = lines.length - 1;
  for (; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (REPLY_ORIGINS.has(line.origin)) break;
    if (line.origin === 'INBOUND') texts.push(line.text);
  }
  const reply = index >= 0 ? lines[index] : undefined;
  const second = (at: Date) => Math.floor(at.getTime() / 1000);
  if (reply?.sentAt !== undefined) {
    const replySecond = second(reply.sentAt);
    for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
      const line = lines[earlier];
      if (line?.sentAt === undefined || second(line.sentAt) !== replySecond) break;
      if (line.origin === 'INBOUND') texts.push(line.text);
    }
  }
  return texts;
}
