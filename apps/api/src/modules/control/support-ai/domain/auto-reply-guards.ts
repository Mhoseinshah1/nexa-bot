import {
  BUSINESS_MESSAGE_TEXT_MAX,
  SUPPORT_AI_GENERAL_TOPICS,
  SUPPORT_AI_HANDOFF_TOPICS,
  SUPPORT_AI_INBOUND_FLOOD,
  SUPPORT_AI_NO_PROGRESS_LIMIT,
  SUPPORT_AI_REPEAT_SIMILARITY,
  type BusinessHandoffReason,
  type BusinessMessageKind,
  type BusinessMessageOrigin,
  type SupportAiAutoGuard,
  type SupportAiAutoOutcome,
  type SupportAiConfidence,
  type SupportAiConfigInput,
  type SupportAiDecision,
} from '@nexa/contracts';
import { normalizeTitle, trigramSimilarity } from '../../support-knowledge/domain/dedupe.js';
import type { SupportTranscriptAuthor } from './transcript.js';

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
  /**
   * Roadmap A1 — AUTO replies in this session (`sessionReplyCount`): at the current epoch,
   * since the conversation's last six-hour silence, GREETING replies not counted.
   */
  readonly sessionReplies: number;
  /** AUTO replies in the window, whatever the epoch and the topic. */
  readonly autoInWindow: number;
  /** The tenant's `sessionReplyBudget`. */
  readonly sessionReplyBudget: number;
  /** The tenant's `maxAutoRepliesPerHour`. */
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
  if (input.sessionReplies >= input.sessionReplyBudget) return fail('consecutive', 'LOOP_GUARD');
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
 * the repository), how many are `ASK_CLARIFYING_QUESTION` before the first real `REPLY`. A
 * REPLY ends the streak; a customer message does not (the point is a question, an answer, a
 * question). Roadmap A2: a REPLY whose topic is `GREETING` is not a real answer — a «سلام» in
 * the middle of the questions neither counts nor resets, so it cannot launder a streak.
 */
export function clarifyingStreakOf(
  newestFirst: readonly { readonly decision: string | null; readonly topic?: string | null }[],
): number {
  let streak = 0;
  for (const row of newestFirst) {
    if (row.decision === 'ASK_CLARIFYING_QUESTION') streak += 1;
    else if (row.decision === 'REPLY' && row.topic !== 'GREETING') break;
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

// ---------------------------------------------------------------------------------------------
// Roadmap A3 (2026-10-07) — three deterministic progress guards. Each reads only what NEXA
// recorded: the transcript (`SupportTranscriptLine`s, oldest first, with A7's `author`) and when
// the AI's part in this epoch began (`since`, the first automatic job's trigger:
// `epochStartedAt`). None is the model's opinion, and each hands off with its own code.
// ---------------------------------------------------------------------------------------------

/** A transcript line as the progress guards read it. */
export interface ProgressLine {
  readonly origin: BusinessMessageOrigin;
  /**
   * A7 — who wrote it, decided by NEXA. Only `AI_AUTO` is the AI's own automatic advice (review
   * of PR #246, CX3): a person's message, a reviewed Assist draft, Telegram's away message or a
   * send whose author the window does not show is never "the advice" these guards are about.
   */
  readonly author: SupportTranscriptAuthor;
  readonly text: string | null;
  readonly sentAt: Date;
}

/** The authors that mean a person has the conversation: a run never reads past them. */
const PERSON_AUTHORS: ReadonlySet<SupportTranscriptAuthor> = new Set(['STAFF', 'AI_ASSIST']);

/**
 * What a customer writes when the advice did not work, on FOLDED text (`foldCustomerText`:
 * Arabic ي/ك to Persian, a ZWNJ to a space, marks dropped, lower case), so «نمی‌شه», «نمیشه»
 * and «نمي شه» are one form. Persian first, then Finglish and English.
 */
const FAILURE_FEEDBACK: readonly RegExp[] = [
  // نشد / نشده — «درست نشد», «حل نشد», «وصل نشد», «هنوز نشده»
  /(?<!\p{L})نشد(?:ه|ش)?(?!\p{L})/u,
  // نمیشه / نمی شه / نمیشود / نمیره — «هنوز وصل نمیشه», «باز نمیشه»
  /(?<!\p{L})نمی ?(?:شه|شود|ره|رود)(?!\p{L})/u,
  // «نمیتونم وصل بشم», «نمی تونم وصل شم» (review of PR #246, m7)
  /(?<!\p{L})نمی ?(?:تونم|توانم)\s*(?:وصل|کانکت)/u,
  // «بازم همونه», «باز هم همینه», «هنوز همونه», «همون مشکل»
  /(?<!\p{L})(?:بازم|باز هم|هنوز|هنوزم)\s*(?:همونه|همون|همینه|همین|همان|همانه)(?!\p{L})/u,
  /(?<!\p{L})همون\s*(?:مشکل|خطا|ارور)/u,
  // «هنوزم مشکل داره», «هنوز مشکل دارم» (m7)
  /(?<!\p{L})(?:هنوز|هنوزم|بازم|باز هم)\s*مشکل\s*(?:داره|دارم|دارد|هست)(?!\p{L})/u,
  // «جواب نداد», «جواب نمیده», «کار نکرد», «فرقی نکرد», «اتفاقی نیفتاد»
  /(?<!\p{L})جواب\s*(?:نداد|نمیده|نمی ده|نداده)(?!\p{L})/u,
  /(?<!\p{L})کار\s*(?:نکرد|نمیکنه|نمی کنه|نکرده)(?!\p{L})/u,
  /(?<!\p{L})فرقی\s*(?:نکرد|نکرده)(?!\p{L})/u,
  /(?<!\p{L})اتفاقی\s*نیفتاد(?!\p{L})/u,
  // Finglish and English
  /\b(?:nashod\w*|na\s*shod\w*|nemi\s*she|nemishe|nmishe|nemishod|nemire)\b/u,
  /\b(?:bazam|baz\s*ham|hanooz|hanuz|hanoz)\s*(?:hamoon\w*|hamun\w*|hamin\w*)\b/u,
  /\b(?:javab|kar)\s*(?:nadad|nadade|nemide|nakard|nakarde|nemikone)\b/u,
  /\b(?:farghi|farqi)\s*nakard\b/u,
  /\b(?:not\s+working|not\s+connecting|doesn'?t\s+work|does\s+not\s+work|didn'?t\s+work|did\s+not\s+work|did\s+not\s+connect|didn'?t\s+connect|still\s+(?:not|no|the\s+same|broken)|same\s+(?:problem|issue|error)|no\s+luck)\b/u,
];

/** Whether a customer's message says the advice did not help. */
export function isFailureFeedback(text: string | null): boolean {
  if (text === null) return false;
  const folded = foldCustomerText(text);
  return FAILURE_FEEDBACK.some((pattern) => pattern.test(folded));
}

/**
 * The failure feedback in a row, in ROUNDS: walking back from the newest line within the epoch
 * (`since`), each automatic AI reply (`AI_AUTO`) followed by the customer's «it did not work» —
 * one or several messages — is one round (review of PR #246, m7: three «نشد» after a single
 * reply are one attempt, not three). Any other customer message ends the run, and so does a
 * person. Lines from before `since` belong to an earlier epoch and are never read.
 */
export function failureFeedbackRun(lines: readonly ProgressLine[], since: Date | null): number {
  let rounds = 0;
  let pending = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (since !== null && line.sentAt.getTime() < since.getTime()) break;
    if (line.origin === 'INBOUND') {
      if (!isFailureFeedback(line.text)) break;
      pending = true;
    } else if (line.author === 'AI_AUTO') {
      if (pending) rounds += 1;
      pending = false;
    } else if (
      PERSON_AUTHORS.has(line.author) ||
      line.origin === 'HUMAN' ||
      line.origin === 'OTHER_BOT'
    ) {
      break;
    }
  }
  return rounds;
}

/**
 * `no_progress` — before the provider: `SUPPORT_AI_NO_PROGRESS_LIMIT` rounds of «it did not work»,
 * each after a different automatic reply of this epoch, hand off. Asking the model a fourth time
 * is the loop this exists to stop.
 */
export function autoNoProgressGuard(
  lines: readonly ProgressLine[],
  since: Date | null,
): AutoVerdict {
  return failureFeedbackRun(lines, since) >= SUPPORT_AI_NO_PROGRESS_LIMIT
    ? fail('no_progress', 'NO_PROGRESS')
    : PASS;
}

/** A message reduced to what makes two sends "the same message" (`normalizeTitle`, TB8). */
function sameMessageKey(text: string | null): string {
  return text === null ? '' : normalizeTitle(foldCustomerText(text));
}

/**
 * `inbound_flood` — before the provider, both counted within `windowSeconds` of the customer's
 * newest message and within the epoch:
 * - the newest message repeated `sameMessage` times (normalised) — unless it is a closing
 *   acknowledgement: a customer who thanks after each step is not flooding, and A6 may close
 *   their third «مرسی» silently (review of PR #246, m1);
 * - more than `maxInbound` customer messages.
 */
export function autoInboundFloodGuard(
  lines: readonly ProgressLine[],
  since: Date | null,
): AutoVerdict {
  const inbound = lines.filter((line) => line.origin === 'INBOUND');
  const newest = inbound.at(-1);
  if (newest === undefined) return PASS;
  const windowStart = Math.max(
    newest.sentAt.getTime() - SUPPORT_AI_INBOUND_FLOOD.windowSeconds * 1000,
    since === null ? Number.NEGATIVE_INFINITY : since.getTime(),
  );
  const recent = inbound.filter((line) => line.sentAt.getTime() >= windowStart);
  const key = sameMessageKey(newest.text);
  if (key !== '' && !isClosingAcknowledgement(newest.text)) {
    const repeats = recent.filter((line) => sameMessageKey(line.text) === key).length;
    if (repeats >= SUPPORT_AI_INBOUND_FLOOD.sameMessage)
      return fail('inbound_flood', 'INBOUND_FLOOD');
  }
  return recent.length > SUPPORT_AI_INBOUND_FLOOD.maxInbound
    ? fail('inbound_flood', 'INBOUND_FLOOD')
    : PASS;
}

/**
 * A text's word set after the same folding and normalisation. A ZWNJ joins a compound rather
 * than splitting it here («به‌روز» and «بهروز» are one word), so a joiner is not a new word.
 */
function tokenSet(text: string): ReadonlySet<string> {
  return new Set(
    normalizeTitle(foldCustomerText(text.replace(/\u200C/gu, '')))
      .split(' ')
      .filter((word) => word !== ''),
  );
}

function sameTokens(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const word of left) if (!right.has(word)) return false;
  return true;
}

/**
 * Whether a reply repeats one already given: at least `SUPPORT_AI_REPEAT_SIMILARITY` similar in
 * character trigrams AND made of the same words after normalisation. The second condition is
 * review of PR #246, m9: «… را به‌روز نکنید» after «… را به‌روز کنید» is 0.94 similar but a
 * correction, and a correction must be sendable.
 */
export function repeatsEarlierAdvice(reply: string, earlier: readonly string[]): boolean {
  const left = normalizeTitle(foldCustomerText(reply));
  if (left === '') return false;
  const words = tokenSet(reply);
  return earlier.some((text) => {
    const right = normalizeTitle(foldCustomerText(text));
    return (
      right !== '' &&
      trigramSimilarity(left, right) >= SUPPORT_AI_REPEAT_SIMILARITY &&
      sameTokens(words, tokenSet(text))
    );
  });
}

/** The similarity of a new reply to the closest earlier one, normalised as TB8 normalises. */
export function adviceSimilarity(reply: string, earlier: readonly string[]): number {
  const left = normalizeTitle(foldCustomerText(reply));
  if (left === '') return 0;
  let best = 0;
  for (const text of earlier) {
    const right = normalizeTitle(foldCustomerText(text));
    if (right === '') continue;
    best = Math.max(best, trigramSimilarity(left, right));
  }
  return best;
}

/**
 * `repeated_advice` — after the decision guards: a reply (or question) that repeats an automatic
 * reply (`AI_AUTO`, CX3) the customer already received in this epoch is not sent; a person
 * continues. A greeting is not advice and is exempt.
 */
export function autoRepeatedAdviceGuard(
  decision: Pick<SupportAiDecision, 'replyText' | 'topic'>,
  lines: readonly ProgressLine[],
  since: Date | null,
): AutoVerdict {
  // A greeting is not advice: «سلام! چطور کمکتون کنم؟» twice is courtesy, not a loop (a
  // customer repeating «سلام» is the flood guard's).
  if (decision.topic === 'GREETING') return PASS;
  const earlier = lines
    .filter(
      (line) =>
        line.author === 'AI_AUTO' &&
        line.text !== null &&
        (since === null || line.sentAt.getTime() >= since.getTime()),
    )
    .map((line) => line.text as string);
  return repeatsEarlierAdvice(decision.replyText, earlier)
    ? fail('repeated_advice', 'REPEATED_ADVICE')
    : PASS;
}

// ---------------------------------------------------------------------------------------------
// Roadmap A6 — NO_ACTION: a customer who closed the matter is not handed to a person.
// ---------------------------------------------------------------------------------------------

/**
 * The words a closing acknowledgement is made of, folded. A message is a closing one only when
 * EVERY word is in this set and at least one is a thanks, an OK, or a status word paired with a
 * completion («حل شد», «درست شد», «وصل شد»): «مرسی», «حل شد», «اوکی درست شد», «خیلی ممنون»…
 * Any other word — «ولی», «نشد», a question word — and it is not.
 */
const THANKS_OR_OK: ReadonlySet<string> = new Set([
  'مرسی',
  'ممنون',
  'ممنونم',
  'متشکرم',
  'متشکر',
  'تشکر',
  'سپاس',
  'سپاسگزارم',
  'مچکرم',
  'مچکر',
  'merci',
  'mersi',
  'mrc',
  'mamnoon',
  'mamnun',
  'mamnoonam',
  'mamnunam',
  'moteshakeram',
  'thanks',
  'thank',
  'thx',
  'tnx',
  'ty',
  'اوکی',
  'اوکیه',
  'اوک',
  'اکی',
  'ok',
  'okay',
  'oki',
  'okey',
  'عالی',
  'عالیه',
  'great',
  'perfect',
]);
/** A status word closes only with a completion: «وصل» alone may be "connect me" (m2). */
const STATUS_WORDS: ReadonlySet<string> = new Set([
  'حل',
  'درست',
  'وصل',
  'hal',
  'dorost',
  'vasl',
  'solved',
  'fixed',
  'works',
  'working',
]);
const COMPLETION_WORDS: ReadonlySet<string> = new Set(['شد', 'شده', 'shod', 'shode']);
const SOFTENERS: ReadonlySet<string> = new Set([
  'دمت',
  'دمتون',
  'گرم',
  'دستت',
  'دستتون',
  'درد',
  'نکنه',
  'لطف',
  'کردی',
  'کردید',
  'کردین',
  'you',
  'خیلی',
  'دیگه',
  'هم',
  'همه',
  'چی',
  'چیز',
  'خوبه',
  'باشه',
  'kheili',
  'khyli',
  'dige',
  'very',
  'much',
  'so',
  'all',
  'good',
  'ali',
  'aali',
  'khoobe',
  'bashe',
]);
/** A question word anywhere makes it a question, whatever else it says (m2). */
const QUESTION_WORDS: ReadonlySet<string> = new Set([
  'آیا',
  'چرا',
  'چطور',
  'چطوری',
  'چگونه',
  'کی',
  'کجا',
  'کدوم',
  'کدام',
  'چند',
  'چه',
  'is',
  'are',
  'does',
  'do',
  'did',
  'can',
  'could',
  'why',
  'how',
  'what',
  'when',
  'where',
  'which',
  'aya',
  'chera',
  'chetor',
  'chetori',
  'koja',
]);
/** Every question mark a customer may type: ASCII, Arabic, fullwidth, and the doubled ones (m2). */
const QUESTION_MARKS = /[?؟？⁇⁈⁉❓❔]/u;

/** Whether a customer's message only says thanks, or that the problem is solved. */
export function isClosingAcknowledgement(text: string | null): boolean {
  if (text === null || QUESTION_MARKS.test(text)) return false;
  const words = normalizeTitle(foldCustomerText(text))
    .split(' ')
    .filter((word) => word !== '');
  if (words.length === 0 || words.length > 8) return false;
  if (words.some((word) => QUESTION_WORDS.has(word))) return false;
  const known = (word: string) =>
    THANKS_OR_OK.has(word) ||
    STATUS_WORDS.has(word) ||
    COMPLETION_WORDS.has(word) ||
    SOFTENERS.has(word);
  if (!words.every(known)) return false;
  const thanked = words.some((word) => THANKS_OR_OK.has(word));
  const completed =
    words.some((word) => STATUS_WORDS.has(word)) &&
    words.some((word) => COMPLETION_WORDS.has(word));
  return thanked || completed;
}

/**
 * A6 — why a `NO_ACTION` decision may NOT end the job silently, or PASS when it may: every
 * customer text the reply would have answered is a closing acknowledgement, and the decision
 * passes every guard a reply passes that can apply to silence. The verdict is the handoff to make
 * otherwise, with the most specific reason (review of PR #246, CX2: decided again in the job's
 * transaction on the facts of then).
 */
export function autoNoActionVerdict(input: {
  readonly decision: SupportAiDecision;
  readonly config: Pick<SupportAiConfigInput, 'autoTopics' | 'autoMinConfidence'>;
  readonly flags: AutoContextFlags;
  readonly customerTexts: readonly (string | null)[];
}): AutoVerdict {
  const { decision, config, flags } = input;
  if (decision.decision !== 'NO_ACTION') return fail('decision', 'DECISION_NOT_REPLY');
  if (decision.topic === 'HUMAN_REQUESTED') return fail('human_requested', 'HUMAN_REQUESTED');
  if ((SUPPORT_AI_HANDOFF_TOPICS as readonly string[]).includes(decision.topic)) {
    return fail('handoff_topic', 'HANDOFF_TOPIC');
  }
  if (flags.customerBlocked) return fail('customer_blocked', 'CUSTOMER_BLOCKED');
  if (flags.hasUnderReviewPayment || flags.hasUnreconciledService) {
    return fail('account_review', 'ACCOUNT_UNDER_REVIEW');
  }
  const closes =
    (config.autoTopics as readonly string[]).includes(decision.topic) &&
    (flags.identityLinked ||
      (SUPPORT_AI_GENERAL_TOPICS as readonly string[]).includes(decision.topic)) &&
    CONFIDENCE_RANK[decision.confidence] >= CONFIDENCE_RANK[config.autoMinConfidence] &&
    input.customerTexts.length > 0 &&
    input.customerTexts.every((text) => isClosingAcknowledgement(text));
  return closes ? PASS : fail('decision', 'DECISION_NOT_REPLY');
}

/** Whether a `NO_ACTION` decision may end the job silently (`autoNoActionVerdict` passes). */
export function autoNoActionAllowed(input: Parameters<typeof autoNoActionVerdict>[0]): boolean {
  return autoNoActionVerdict(input).pass;
}
