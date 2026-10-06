import { describe, expect, it } from 'vitest';
import {
  SUPPORT_AI_DEFAULT_CONFIG,
  SUPPORT_AI_GENERAL_TOPICS,
  SUPPORT_AI_HANDOFF_TOPICS,
  SUPPORT_AI_SAFE_TOPICS,
  supportAiConfigInputSchema,
  type SupportAiDecision,
} from '@nexa/contracts';
import {
  autoDecisionGuards,
  autoImageGuard,
  autoMoneyGuard,
  autoPreflight,
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
};
const known = new Set(['S1', 'P1']);

const guards = (over: {
  decision?: Partial<SupportAiDecision>;
  config?: Partial<typeof config>;
  flags?: Partial<AutoContextFlags>;
}) =>
  autoDecisionGuards({
    decision: { ...decision, ...over.decision },
    config: { ...config, ...over.config },
    flags: { ...flags, ...over.flags },
    knownAliases: known,
  });

const preflight = (over: Partial<Parameters<typeof autoPreflight>[0]> = {}) =>
  autoPreflight({
    trigger: { origin: 'INBOUND', kind: 'TEXT', text: 'سلام', deleted: false },
    customerBlocked: false,
    autoAtEpoch: 0,
    autoInWindow: 0,
    maxConsecutiveReplies: 4,
    maxPerWindow: 10,
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

  it('only a REPLY is sent; a clarifying question or no action hands off', () => {
    for (const kind of ['ASK_CLARIFYING_QUESTION', 'NO_ACTION'] as const) {
      expect(guards({ decision: { decision: kind } })).toMatchObject({
        outcome: 'guard_decision',
        reason: 'DECISION_NOT_REPLY',
      });
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

  it('a citation the payload did not contain hands off', () => {
    expect(guards({ decision: { factRefs: ['S1', 'Z9'] } })).toMatchObject({
      outcome: 'guard_grounding',
      reason: 'INSUFFICIENT_GROUNDING',
    });
    expect(guards({ decision: { factRefs: [] } })).toEqual({ pass: true });
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
    expect(preflight({ autoAtEpoch: 4 })).toMatchObject({
      outcome: 'guard_consecutive',
      reason: 'LOOP_GUARD',
    });
    expect(preflight({ autoAtEpoch: 3 })).toEqual({ pass: true });
    expect(preflight({ autoInWindow: 10 })).toMatchObject({
      outcome: 'guard_window',
      reason: 'LOOP_GUARD',
    });
    expect(preflight({ autoInWindow: 9 })).toEqual({ pass: true });
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
    expect(foldCustomerText(`كيف${ZWNJ}پولِ`)).toBe('کیفپول');
  });
});
