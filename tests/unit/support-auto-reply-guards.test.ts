import { describe, expect, it } from 'vitest';
import {
  SUPPORT_AI_DEFAULT_CONFIG,
  SUPPORT_AI_GENERAL_TOPICS,
  SUPPORT_AI_HANDOFF_TOPICS,
  SUPPORT_AI_LIMITS,
  SUPPORT_AI_SAFE_TOPICS,
  SUPPORT_AI_SESSION_INACTIVITY_SECONDS,
  SUPPORT_AI_AUTO_WINDOW,
  supportAiConfigInputSchema,
  supportAiConfigSaveSchema,
  type SupportAiDecision,
} from '@nexa/contracts';
import {
  autoDecisionGuards,
  autoImageGuard,
  autoMoneyGuard,
  autoPreflight,
  clarifyingStreakOf,
  customerTextsSinceReply,
  foldCustomerText,
  mentionsMoneyTopic,
  type AutoContextFlags,
} from '../../apps/api/src/modules/control/support-ai/domain/auto-reply-guards';

/**
 * TB7 — the pure guard evaluator (program §26). Every guard must pass for an automatic reply,
 * and each one, alone, refuses it with its own outcome and handoff reason.
 */

const decision: SupportAiDecision = {
  decision: 'REPLY',
  replyText: 'لطفاً برنامه را دوباره باز کنید.',
  topic: 'CONNECTION_TROUBLESHOOTING',
  confidence: 'HIGH',
  factRefs: ['S1'],
  knowledgeRefs: [],
  ticketAction: 'NONE',
  summary: 'وصل نمی‌شود',
  intent: 'اتصال',
};
const flags: AutoContextFlags = {
  identityLinked: true,
  customerBlocked: false,
  hasUnderReviewPayment: false,
  hasUnreconciledService: false,
};
const config = {
  autoTopics: [...SUPPORT_AI_SAFE_TOPICS],
  autoMinConfidence: 'HIGH' as 'MEDIUM' | 'HIGH',
  maxOutputChars: 1200,
  maxConsecutiveClarifyingQuestions: 2,
};
const known = new Set(['S1', 'P1']);
const knownKnowledge = new Set(['K1', 'K2']);

const guards = (over: {
  decision?: Partial<SupportAiDecision>;
  config?: Partial<typeof config>;
  flags?: Partial<AutoContextFlags>;
  clarifyingStreak?: number;
}) =>
  autoDecisionGuards({
    decision: { ...decision, ...over.decision },
    config: { ...config, ...over.config },
    flags: { ...flags, ...over.flags },
    knownAliases: known,
    knownKnowledgeAliases: knownKnowledge,
    clarifyingStreak: over.clarifyingStreak ?? 0,
  });

/** A safe clarifying question (hotfix 2026-10-06): the question is `replyText`. */
const ask: Partial<SupportAiDecision> = {
  decision: 'ASK_CLARIFYING_QUESTION',
  replyText: 'حتماً. با چه برنامه‌ای وصل می‌شید و موقع اتصال چه خطایی می‌بینید؟',
  factRefs: [],
};
const askWith = (over: Partial<SupportAiDecision>) => ({ ...ask, ...over });
const INVISIBLE_ONLY = '\u200b\u200c\u200d\u200e\u200f\u2060\ufeff';

const preflight = (over: Partial<Parameters<typeof autoPreflight>[0]> = {}) =>
  autoPreflight({
    trigger: { origin: 'INBOUND', kind: 'TEXT', text: 'سلام', deleted: false },
    customerBlocked: false,
    sessionReplies: 0,
    autoInWindow: 0,
    sessionReplyBudget: 20,
    maxPerWindow: 30,
    ...over,
  });

describe('automatic-reply guards (TB7)', () => {
  it('passes a grounded, confident REPLY on an allowlisted topic for a linked customer', () => {
    expect(guards({})).toEqual({ pass: true });
    expect(preflight()).toEqual({ pass: true });
  });

  it('the default allowlist is EMPTY, and an empty allowlist passes nothing', () => {
    expect(SUPPORT_AI_DEFAULT_CONFIG.autoTopics).toEqual([]);
    expect(SUPPORT_AI_DEFAULT_CONFIG.mode).toBe('OFF');
    // A client that does not know the field saves the safe value.
    const parsed = supportAiConfigInputSchema.parse({
      ...SUPPORT_AI_DEFAULT_CONFIG,
      autoTopics: undefined,
      autoMinConfidence: undefined,
    });
    expect(parsed.autoTopics).toEqual([]);
    expect(parsed.autoMinConfidence).toBe('HIGH');
    for (const topic of SUPPORT_AI_SAFE_TOPICS) {
      expect(guards({ decision: { topic }, config: { autoTopics: [] } })).toMatchObject({
        pass: false,
        outcome: 'guard_topic_allowlist',
        reason: 'TOPIC_NOT_ALLOWED',
      });
    }
  });

  it('the allowlist cannot name a hard-handoff topic, nor list one twice', () => {
    expect(
      supportAiConfigInputSchema.safeParse({ ...SUPPORT_AI_DEFAULT_CONFIG, autoTopics: ['REFUND'] })
        .success,
    ).toBe(false);
    expect(
      supportAiConfigInputSchema.safeParse({
        ...SUPPORT_AI_DEFAULT_CONFIG,
        autoTopics: ['GREETING', 'GREETING'],
      }).success,
    ).toBe(false);
  });

  it('the model asking for a person is never second-guessed', () => {
    for (const kind of ['HANDOFF', 'CREATE_OR_LINK_TICKET'] as const) {
      expect(guards({ decision: { decision: kind } })).toMatchObject({
        pass: false,
        outcome: 'handoff_ai_requested',
        reason: 'AI_REQUESTED',
      });
    }
  });

  it('every hard-handoff topic hands off, whatever the confidence or the allowlist says', () => {
    for (const topic of SUPPORT_AI_HANDOFF_TOPICS) {
      const verdict = guards({
        decision: { topic },
        config: { autoTopics: [...SUPPORT_AI_SAFE_TOPICS] },
      });
      expect(verdict.pass).toBe(false);
      expect(verdict).toMatchObject(
        topic === 'HUMAN_REQUESTED'
          ? { outcome: 'guard_human_requested', reason: 'HUMAN_REQUESTED' }
          : { outcome: 'guard_handoff_topic', reason: 'HANDOFF_TOPIC' },
      );
    }
  });

  it('a safe clarifying question passes; NO_ACTION still hands off (hotfix 2026-10-06)', () => {
    expect(guards({ decision: ask })).toEqual({ pass: true });
    // NO_ACTION is never a customer message, whatever replyText it carries.
    for (const replyText of ['', 'متن']) {
      expect(guards({ decision: { decision: 'NO_ACTION', replyText } })).toMatchObject({
        pass: false,
        outcome: 'guard_decision',
        reason: 'DECISION_NOT_REPLY',
      });
    }
  });

  it('a clarifying question passes through EVERY guard a REPLY does', () => {
    // allowlist
    expect(guards({ decision: ask, config: { autoTopics: ['GREETING'] } })).toMatchObject({
      outcome: 'guard_topic_allowlist',
      reason: 'TOPIC_NOT_ALLOWED',
    });
    // a hard topic, and a person asked for, whatever the decision kind
    for (const topic of SUPPORT_AI_HANDOFF_TOPICS) {
      expect(guards({ decision: askWith({ topic }) }), topic).toMatchObject({
        pass: false,
        outcome: topic === 'HUMAN_REQUESTED' ? 'guard_human_requested' : 'guard_handoff_topic',
      });
    }
    // identity: an unlinked customer is asked only on a general topic
    expect(
      guards({ decision: askWith({ topic: 'SERVICE_INFO' }), flags: { identityLinked: false } }),
    ).toMatchObject({ outcome: 'guard_identity', reason: 'IDENTITY_UNVERIFIED' });
    expect(guards({ decision: ask, flags: { identityLinked: false } })).toEqual({ pass: true });
    // account review
    expect(guards({ decision: ask, flags: { hasUnderReviewPayment: true } })).toMatchObject({
      outcome: 'guard_account_review',
    });
    expect(guards({ decision: ask, flags: { hasUnreconciledService: true } })).toMatchObject({
      outcome: 'guard_account_review',
    });
    // confidence
    expect(guards({ decision: askWith({ confidence: 'MEDIUM' }) })).toMatchObject({
      outcome: 'guard_confidence',
      reason: 'LOW_CONFIDENCE',
    });
    expect(
      guards({ decision: askWith({ confidence: 'LOW' }), config: { autoMinConfidence: 'MEDIUM' } }),
    ).toMatchObject({ outcome: 'guard_confidence' });
    // bounds: an empty or blank question is never sent; neither is an over-long one
    for (const replyText of ['', '   ', 'ب'.repeat(1201), INVISIBLE_ONLY]) {
      expect(guards({ decision: askWith({ replyText }) })).toMatchObject({
        outcome: 'guard_reply_bounds',
        reason: 'REPLY_OUT_OF_BOUNDS',
      });
    }
    // grounding: a fact or a knowledge entry the payload did not carry
    expect(guards({ decision: askWith({ factRefs: ['Z9'] }) })).toMatchObject({
      outcome: 'guard_grounding',
      reason: 'INSUFFICIENT_GROUNDING',
    });
    expect(guards({ decision: askWith({ knowledgeRefs: ['K9'] }) })).toMatchObject({
      outcome: 'guard_grounding',
      reason: 'INSUFFICIENT_GROUNDING',
    });
  });

  it('the clarifying limit: a question at the streak limit hands off; a REPLY never does', () => {
    expect(guards({ decision: ask, clarifyingStreak: 1 })).toEqual({ pass: true });
    expect(guards({ decision: ask, clarifyingStreak: 2 })).toEqual({
      pass: false,
      guard: 'clarifying_limit',
      outcome: 'guard_clarifying_limit',
      reason: 'CLARIFYING_LIMIT',
    });
    expect(
      guards({
        decision: ask,
        clarifyingStreak: 3,
        config: { maxConsecutiveClarifyingQuestions: 4 },
      }),
    ).toEqual({ pass: true });
    expect(
      guards({
        decision: ask,
        clarifyingStreak: 4,
        config: { maxConsecutiveClarifyingQuestions: 4 },
      }),
    ).toMatchObject({ outcome: 'guard_clarifying_limit' });
    // A REPLY at (or past) the limit is the answer the streak was waiting for.
    expect(guards({ clarifyingStreak: 10 })).toEqual({ pass: true });
  });

  it('the clarifying streak counts questions back to the newest REPLY, never past it', () => {
    const q = { decision: 'ASK_CLARIFYING_QUESTION' };
    const r = { decision: 'REPLY' };
    expect(clarifyingStreakOf([])).toBe(0);
    expect(clarifyingStreakOf([q])).toBe(1);
    expect(clarifyingStreakOf([q, q])).toBe(2);
    // newest first: ASK, ASK, REPLY, ASK — the REPLY ends the streak
    expect(clarifyingStreakOf([q, r, q, q])).toBe(1);
    expect(clarifyingStreakOf([r, q, q])).toBe(0);
    // a greeting is a REPLY: it never adds to the streak
    expect(clarifyingStreakOf([r])).toBe(0);
    // a REPLY with any topic but GREETING is real, and resets
    expect(clarifyingStreakOf([q, { decision: 'REPLY', topic: 'APP_SETUP' }, q])).toBe(1);
  });

  it('A2: a GREETING reply neither counts nor resets the clarifying streak', () => {
    const q = { decision: 'ASK_CLARIFYING_QUESTION', topic: 'CONNECTION_TROUBLESHOOTING' };
    const hello = { decision: 'REPLY', topic: 'GREETING' };
    const real = { decision: 'REPLY', topic: 'CONNECTION_TROUBLESHOOTING' };
    // newest first: ASK, GREETING, ASK — the greeting is walked past
    expect(clarifyingStreakOf([q, hello, q])).toBe(2);
    expect(clarifyingStreakOf([hello])).toBe(0);
    expect(clarifyingStreakOf([hello, q, q])).toBe(2);
    // a real REPLY still ends it, with a greeting on either side
    expect(clarifyingStreakOf([q, hello, real, q, q])).toBe(1);
  });

  it('the clarifying limit is a tenant setting: default 3 (A2), bounds 1–10', () => {
    expect(SUPPORT_AI_LIMITS.maxConsecutiveClarifyingQuestions).toEqual({
      min: 1,
      max: 10,
      default: 3,
    });
    expect(SUPPORT_AI_DEFAULT_CONFIG.maxConsecutiveClarifyingQuestions).toBe(3);
    // N4: a configuration always carries it (no schema default to widen a tenant at 1)…
    const absent = { ...SUPPORT_AI_DEFAULT_CONFIG, maxConsecutiveClarifyingQuestions: undefined };
    expect(supportAiConfigInputSchema.safeParse(absent).success).toBe(false);
    // …while a SAVE may omit it, and then carries nothing the service could mistake for a value.
    const saved = supportAiConfigSaveSchema.parse(absent);
    expect(saved.maxConsecutiveClarifyingQuestions).toBeUndefined();
    expect(
      supportAiConfigSaveSchema.safeParse({
        ...SUPPORT_AI_DEFAULT_CONFIG,
        maxConsecutiveClarifyingQuestions: 11,
      }).success,
    ).toBe(false);
    for (const value of [0, 11, 2.5]) {
      expect(
        supportAiConfigInputSchema.safeParse({
          ...SUPPORT_AI_DEFAULT_CONFIG,
          maxConsecutiveClarifyingQuestions: value,
        }).success,
        String(value),
      ).toBe(false);
    }
    for (const value of [1, 10]) {
      expect(
        supportAiConfigInputSchema.safeParse({
          ...SUPPORT_AI_DEFAULT_CONFIG,
          maxConsecutiveClarifyingQuestions: value,
        }).success,
      ).toBe(true);
    }
  });

  it('an unlinked customer is answered only on general topics', () => {
    for (const topic of SUPPORT_AI_SAFE_TOPICS) {
      const general = (SUPPORT_AI_GENERAL_TOPICS as readonly string[]).includes(topic);
      const verdict = guards({
        decision: { topic, factRefs: [] },
        flags: { identityLinked: false },
      });
      expect(verdict.pass, topic).toBe(general);
      if (!general)
        expect(verdict).toMatchObject({ outcome: 'guard_identity', reason: 'IDENTITY_UNVERIFIED' });
    }
  });

  it('a payment under review or an unreconciled service hands off', () => {
    expect(guards({ flags: { hasUnderReviewPayment: true } })).toMatchObject({
      outcome: 'guard_account_review',
    });
    expect(guards({ flags: { hasUnreconciledService: true } })).toMatchObject({
      outcome: 'guard_account_review',
    });
  });

  it('confidence below the configured minimum hands off; LOW never passes', () => {
    expect(guards({ decision: { confidence: 'MEDIUM' } })).toMatchObject({
      outcome: 'guard_confidence',
      reason: 'LOW_CONFIDENCE',
    });
    expect(
      guards({ decision: { confidence: 'MEDIUM' }, config: { autoMinConfidence: 'MEDIUM' } }),
    ).toEqual({ pass: true });
    expect(
      guards({ decision: { confidence: 'LOW' }, config: { autoMinConfidence: 'MEDIUM' } }),
    ).toMatchObject({ outcome: 'guard_confidence' });
  });

  it('an empty, blank or over-long reply hands off', () => {
    for (const replyText of ['', '   ', 'ب'.repeat(1201)]) {
      expect(guards({ decision: { replyText } })).toMatchObject({
        outcome: 'guard_reply_bounds',
        reason: 'REPLY_OUT_OF_BOUNDS',
      });
    }
    expect(guards({ decision: { replyText: 'ب'.repeat(1200) } })).toEqual({ pass: true });
  });

  it('N7: a reply or question of only zero-width or invisible marks is empty, and hands off', () => {
    for (const replyText of [
      '\u200b',
      '\u200c\u200c',
      '\u200d \u200e\u200f',
      '\u2060',
      '\ufeff',
      ` ${INVISIBLE_ONLY} `,
    ]) {
      for (const kind of ['REPLY', 'ASK_CLARIFYING_QUESTION'] as const) {
        expect(
          guards({ decision: { decision: kind, replyText } }),
          `${kind} ${JSON.stringify(replyText)}`,
        ).toMatchObject({
          outcome: 'guard_reply_bounds',
          reason: 'REPLY_OUT_OF_BOUNDS',
        });
      }
    }
    // A real word joined by a ZWNJ is text, not invisible.
    expect(guards({ decision: { replyText: 'می\u200cشود' } })).toEqual({ pass: true });
    expect(guards({ decision: askWith({ replyText: 'چه\u200cبرنامه‌ای؟' }) })).toEqual({
      pass: true,
    });
  });

  it('a citation the payload did not contain hands off', () => {
    expect(guards({ decision: { factRefs: ['S1', 'Z9'] } })).toMatchObject({
      outcome: 'guard_grounding',
      reason: 'INSUFFICIENT_GROUNDING',
    });
    expect(guards({ decision: { factRefs: [] } })).toEqual({ pass: true });
    // A knowledge citation is grounding too: one the payload did not carry is fake.
    expect(guards({ decision: { knowledgeRefs: ['K1', 'K7'] } })).toMatchObject({
      outcome: 'guard_grounding',
      reason: 'INSUFFICIENT_GROUNDING',
    });
    expect(guards({ decision: { knowledgeRefs: ['K1', 'K2'] } })).toEqual({ pass: true });
  });

  it('preflight: only a customer message with readable text is ever answered', () => {
    const cases = [
      null,
      { origin: 'OWN_ECHO' as const, kind: 'TEXT' as const, text: 'x', deleted: false },
      { origin: 'HUMAN' as const, kind: 'TEXT' as const, text: 'x', deleted: false },
      { origin: 'OFFLINE' as const, kind: 'TEXT' as const, text: 'x', deleted: false },
      { origin: 'INBOUND' as const, kind: 'OTHER' as const, text: null, deleted: false },
      { origin: 'INBOUND' as const, kind: 'PHOTO' as const, text: null, deleted: true },
      { origin: 'INBOUND' as const, kind: 'TEXT' as const, text: null, deleted: true },
      { origin: 'INBOUND' as const, kind: 'TEXT' as const, text: '  ', deleted: false },
    ];
    for (const trigger of cases) {
      expect(preflight({ trigger })).toMatchObject({
        outcome: 'guard_content',
        reason: 'UNSUPPORTED_CONTENT',
      });
    }
  });

  it('preflight: a customer photo is not refused before it is fetched (TB6)', () => {
    expect(
      preflight({ trigger: { origin: 'INBOUND', kind: 'PHOTO', text: null, deleted: false } }),
    ).toEqual({ pass: true });
  });

  it('an image the reply would be about that was not loaded hands off', () => {
    expect(autoImageGuard({ required: ['m1'], loaded: new Set() })).toMatchObject({
      pass: false,
      outcome: 'guard_content',
      reason: 'UNSUPPORTED_CONTENT',
    });
    expect(autoImageGuard({ required: ['m1', 'm2'], loaded: new Set(['m1']) })).toMatchObject({
      pass: false,
    });
    expect(autoImageGuard({ required: ['m1'], loaded: new Set(['m1']) })).toEqual({ pass: true });
    expect(autoImageGuard({ required: [], loaded: new Set() })).toEqual({ pass: true });
  });

  it('preflight: a blocked customer, and the loop guard', () => {
    expect(preflight({ customerBlocked: true })).toMatchObject({
      outcome: 'guard_customer_blocked',
      reason: 'CUSTOMER_BLOCKED',
    });
    expect(preflight({ sessionReplies: 20 })).toMatchObject({
      outcome: 'guard_consecutive',
      reason: 'LOOP_GUARD',
    });
    expect(preflight({ sessionReplies: 19 })).toEqual({ pass: true });
    expect(preflight({ autoInWindow: 30 })).toMatchObject({
      outcome: 'guard_window',
      reason: 'LOOP_GUARD',
    });
    expect(preflight({ autoInWindow: 29 })).toEqual({ pass: true });
    // each limit is the tenant's, not a constant
    expect(preflight({ sessionReplies: 5, sessionReplyBudget: 5 })).toMatchObject({
      outcome: 'guard_consecutive',
    });
    expect(preflight({ autoInWindow: 10, maxPerWindow: 10 })).toMatchObject({
      outcome: 'guard_window',
    });
    expect(preflight({ sessionReplies: 39, sessionReplyBudget: 40 })).toEqual({ pass: true });
  });

  it('A1: the session budget and the hourly limit are tenant settings with their bounds', () => {
    expect(SUPPORT_AI_LIMITS.sessionReplyBudget).toEqual({ min: 5, max: 40, default: 20 });
    expect(SUPPORT_AI_LIMITS.maxAutoRepliesPerHour).toEqual({ min: 10, max: 60, default: 30 });
    expect(SUPPORT_AI_DEFAULT_CONFIG.sessionReplyBudget).toBe(20);
    expect(SUPPORT_AI_DEFAULT_CONFIG.maxAutoRepliesPerHour).toBe(30);
    expect(SUPPORT_AI_SESSION_INACTIVITY_SECONDS).toBe(6 * 3600);
    expect(SUPPORT_AI_AUTO_WINDOW.windowSeconds).toBe(3600);
    const cases: [keyof typeof SUPPORT_AI_DEFAULT_CONFIG, number[], number[]][] = [
      ['sessionReplyBudget', [4, 41, 0, 20.5], [5, 40]],
      ['maxAutoRepliesPerHour', [9, 61, 0, 30.5], [10, 60]],
    ];
    for (const [field, bad, good] of cases) {
      for (const value of bad) {
        expect(
          supportAiConfigInputSchema.safeParse({ ...SUPPORT_AI_DEFAULT_CONFIG, [field]: value })
            .success,
          `${field}=${value}`,
        ).toBe(false);
      }
      for (const value of good) {
        expect(
          supportAiConfigInputSchema.safeParse({ ...SUPPORT_AI_DEFAULT_CONFIG, [field]: value })
            .success,
          `${field}=${value}`,
        ).toBe(true);
      }
      // A configuration always carries it; a SAVE may omit it (the stored value is kept).
      const absent = { ...SUPPORT_AI_DEFAULT_CONFIG, [field]: undefined };
      expect(supportAiConfigInputSchema.safeParse(absent).success).toBe(false);
      expect(supportAiConfigSaveSchema.parse(absent)[field]).toBeUndefined();
    }
    // The retired per-epoch limit is no longer part of the configuration.
    expect('maxConsecutiveReplies' in SUPPORT_AI_DEFAULT_CONFIG).toBe(false);
  });
});

/**
 * D9 — the deterministic money guard over what the customer wrote. A table, so a term that
 * stops matching (or a troubleshooting phrase that starts to) fails one named row.
 */
describe('automatic-reply money guard (D9)', () => {
  const ZWNJ = '\u200c';
  const money: readonly string[] = [
    'وصل نمیشه، پولمو پس بدید',
    'پولم رو پس بدید',
    'پول‌مو پس بدین',
    'پولامو برگردونید',
    'میخوام پولم برگرده',
    'پسش بدید لطفا',
    `پس${ZWNJ}بدید`,
    'پس بدهید',
    'می‌خوام پس بگیرم',
    'درخواست بازپرداخت دارم',
    'بازگشت وجه',
    'برگشت هزینه',
    'استرداد وجه',
    'عودت مبلغ',
    'ریفاند می‌خوام',
    'رفاند کنید',
    'ریفند',
    'رفند بزنید',
    'پرداخت کردم ولی سرویس نیومد',
    'پرداختم انجام نشد',
    'واریز کردم',
    'تراکنش ناموفق بود',
    'کارت به کارت کردم',
    'فیش واریزی رو فرستادم',
    'پول از حسابم کسر شد',
    'از کارتم برداشت شد',
    'موجودی کیف پولم چقدره',
    'کیف پول',
    'كيف پول', // Arabic kaf and yeh
    'شارژ حساب',
    'وجهم رو برگردونید',
    'I want a refund',
    'REFUND please',
    'give my money back',
    'I paid twice',
    'payment failed',
    'my wallet balance',
    'chargeback',
    'transaction declined',
    'poolamo pas bedid',
    'pardakht kardam',
    // B2: ZWNJ compounds.
    `کیف${ZWNJ}پولم خالی شد`,
    `کیف${ZWNJ}پولم`,
    `پول${ZWNJ}مو`,
    `پس${ZWNJ}بدید`,
    // Review item 3: currency, money taken from the account, a top-up, Finglish, accents.
    'صد تومن کم شد',
    '۵۰ هزار تومان',
    'ریال',
    'از حسابم کم شد',
    'شارژ کردم ولی نیومد',
    'pulamo bedid',
    're fund',
    'réfund please',
  ];
  const safe: readonly (string | null)[] = [
    'سلام، سرویس من وصل نمیشه',
    'سلام، اینترنتم وصل نمی‌شود',
    'پس چرا وصل نمیشه؟',
    'پس بدونید که من اندرویدم',
    'پس بد شد',
    'اپ رو آپدیت کردم',
    'ترفند اتصال چیه؟',
    'لینک اشتراک رو بفرستید',
    'حجمم چقدر مونده؟',
    'به هیچ وجه وصل نمیشه',
    'پسورد وای فای',
    'my app does not connect',
    'how do I update the subscription',
    // Hotfix item 3: short connection troubleshooting is the model's, never a money handoff.
    'وصل نمیشه',
    'مشکل اتصال دارم',
    'مشکل در اتصال دارم',
    `کانفیگ کار نمی${ZWNJ}کنه`,
    'کانفیگ کار نمیکنه',
    'Sing-box وصل نمیشه',
    'Sing-box',
    'sing-box connection error',
    'خطای اتصال میده',
    null,
  ] as const;

  it.each(money)('hands off «%s»', (text) => {
    expect(mentionsMoneyTopic(text)).toBe(true);
    const verdict = autoMoneyGuard([text]);
    expect(verdict).toEqual({
      pass: false,
      guard: 'handoff_topic',
      outcome: 'guard_handoff_topic',
      reason: 'HANDOFF_TOPIC',
    });
  });

  it.each(safe)('leaves «%s» to the model', (text) => {
    expect(mentionsMoneyTopic(text)).toBe(false);
    expect(autoMoneyGuard([text]).pass).toBe(true);
  });

  it('any one of the customer texts is enough', () => {
    expect(autoMoneyGuard(['سلام', 'وصل نمیشه', 'پولمو پس بدید']).pass).toBe(false);
    expect(autoMoneyGuard([]).pass).toBe(true);
  });

  it('B1: an away message (OFFLINE) is not a reply; the walk goes past it', () => {
    const lines = [
      { origin: 'OWN_ECHO' as const, text: 'پاسخ قبلی' },
      { origin: 'INBOUND' as const, text: 'پولمو پس بدید' },
      { origin: 'OFFLINE' as const, text: 'در ساعت کاری پاسخ می‌دهیم' },
      { origin: 'INBOUND' as const, text: 'وصل نمیشه' },
    ];
    expect(customerTextsSinceReply(lines, 'وصل نمیشه')).toContain('پولمو پس بدید');
    expect(autoMoneyGuard(customerTextsSinceReply(lines, 'وصل نمیشه')).pass).toBe(false);
    // A real reply (the owner, or another bot) still ends it.
    for (const origin of ['HUMAN', 'OTHER_BOT'] as const) {
      const replied = [lines[1]!, { origin, text: 'پاسخ' }, lines[3]!];
      expect(autoMoneyGuard(customerTextsSinceReply(replied, 'وصل نمیشه')).pass).toBe(true);
    }
  });

  it('item 4: a customer line in the same second as the reply counts as after it', () => {
    const at = (ms: number) => new Date(Date.UTC(2026, 9, 6, 10, 0, 0) + ms);
    const lines = [
      // Telegram's whole second, which sorts before our reply's 10:00:00.400.
      { origin: 'INBOUND' as const, text: 'پولمو پس بدید', sentAt: at(0) },
      { origin: 'OWN_ECHO' as const, text: 'پاسخ', sentAt: at(400) },
      { origin: 'INBOUND' as const, text: 'وصل نمیشه', sentAt: at(5_000) },
    ];
    expect(autoMoneyGuard(customerTextsSinceReply(lines, 'وصل نمیشه')).pass).toBe(false);
    // A line a whole second earlier was answered by that reply.
    const older = [{ ...lines[0]!, sentAt: at(-1_000) }, lines[1]!, lines[2]!];
    expect(autoMoneyGuard(customerTextsSinceReply(older, 'وصل نمیشه')).pass).toBe(true);
  });

  it('reads the trigger and every customer line after the business last spoke', () => {
    const lines = [
      { origin: 'INBOUND' as const, text: 'قبلی' },
      { origin: 'OWN_ECHO' as const, text: 'پاسخ ما' },
      { origin: 'INBOUND' as const, text: 'پولمو پس بدید' },
      { origin: 'INBOUND' as const, text: 'وصل نمیشه' },
    ];
    expect(customerTextsSinceReply(lines, 'وصل نمیشه')).toEqual([
      'وصل نمیشه',
      'وصل نمیشه',
      'پولمو پس بدید',
    ]);
    expect(autoMoneyGuard(customerTextsSinceReply(lines, 'وصل نمیشه')).pass).toBe(false);
  });

  it('folds Arabic letters, joiners and diacritics', () => {
    // B2: a ZWNJ is a word boundary inside a compound, so it folds to a space.
    expect(foldCustomerText(`كيف${ZWNJ}پولِ`)).toBe('کیف پول');
    expect(foldCustomerText('réfund')).toBe('refund');
  });
});
