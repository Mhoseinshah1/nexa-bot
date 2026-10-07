import { describe, expect, it } from 'vitest';
import {
  SUPPORT_AI_INBOUND_FLOOD,
  SUPPORT_AI_NO_PROGRESS_LIMIT,
  SUPPORT_AI_REPEAT_SIMILARITY,
  supportAutoOutcomeClass,
  businessOutboundSendable,
  type SupportAiDecision,
} from '@nexa/contracts';
import {
  adviceSimilarity,
  autoInboundFloodGuard,
  autoNoActionAllowed,
  autoNoProgressGuard,
  autoRepeatedAdviceGuard,
  failureFeedbackRun,
  isClosingAcknowledgement,
  isFailureFeedback,
  type AutoContextFlags,
  type ProgressLine,
} from '../../apps/api/src/modules/control/support-ai/domain/auto-reply-guards';

/**
 * Roadmap A3/A6 — the deterministic progress guards and the silent NO_ACTION, pure. The
 * integration file drives each through the real AUTO path; this pins the matchers and walks.
 */

const T0 = new Date('2026-10-07T10:00:00Z').getTime();
let clock = 0;
const at = (seconds?: number) => new Date(T0 + (seconds ?? (clock += 30)) * 1000);
const customer = (text: string | null, seconds?: number): ProgressLine => ({
  origin: 'INBOUND',
  text,
  sentAt: at(seconds),
});
const ai = (
  text = 'لطفاً برنامه را ببندید و دوباره باز کنید.',
  seconds?: number,
): ProgressLine => ({
  origin: 'OWN_ECHO',
  text,
  sentAt: at(seconds),
});
const person = (seconds?: number): ProgressLine => ({
  origin: 'HUMAN',
  text: 'سلام، من همکار پشتیبانی هستم',
  sentAt: at(seconds),
});

describe('A3: failure feedback (Persian, Finglish, English)', () => {
  const failures = [
    'نشد',
    'نشد!',
    'درست نشد',
    'حل نشد',
    'هنوز وصل نمیشه',
    'هنوز وصل نمی‌شه',
    'هنوز وصل نمي شه',
    'بازم همونه',
    'باز هم همینه',
    'هنوز همونه',
    'جواب نداد',
    'کار نکرد',
    'فرقی نکرد',
    'همون مشکل رو دارم',
    'هنوز درست نشده',
    'nashod',
    'dorost nashod',
    'hanooz vasl nemishe',
    'bazam hamoone',
    'javab nadad',
    'kar nakard',
    'still not working',
    "it didn't work",
    'same error',
  ];
  for (const text of failures) {
    it(`«${text}» is failure feedback`, () => expect(isFailureFeedback(text)).toBe(true));
  }
  const not = [
    'درست شد',
    'حل شد مرسی',
    'وصل شد',
    'سلام',
    'با Sing-box وصل می‌شم',
    'چطور اشتراکم رو تمدید کنم؟',
    'بشد',
  ];
  for (const text of not) {
    it(`«${text}» is not failure feedback`, () => expect(isFailureFeedback(text)).toBe(false));
  }
  it('null and blank are not failure feedback', () => {
    expect(isFailureFeedback(null)).toBe(false);
    expect(isFailureFeedback('   ')).toBe(false);
  });
});

describe('A3: no_progress', () => {
  it(`hands off at ${SUPPORT_AI_NO_PROGRESS_LIMIT} failure messages in a row, each after an AI reply`, () => {
    expect(SUPPORT_AI_NO_PROGRESS_LIMIT).toBe(3);
    const lines = [
      customer('وصل نمیشم'),
      ai(),
      customer('نشد'),
      ai('گزینهٔ دیگری را امتحان کنید.'),
      customer('هنوز وصل نمیشه'),
      ai('اشتراک را به‌روز کنید.'),
      customer('بازم همونه'),
    ];
    expect(failureFeedbackRun(lines, null)).toBe(3);
    expect(autoNoProgressGuard(lines, null)).toMatchObject({
      pass: false,
      outcome: 'guard_no_progress',
      reason: 'NO_PROGRESS',
    });
    // two are not enough
    expect(autoNoProgressGuard(lines.slice(0, 5), null)).toEqual({ pass: true });
  });

  it('three quick failure messages after one reply count as three', () => {
    const lines = [
      customer('مشکل دارم'),
      ai(),
      customer('نشد'),
      customer('نشد'),
      customer('جواب نداد'),
    ];
    expect(failureFeedbackRun(lines, null)).toBe(3);
  });

  it('failure messages BEFORE any AI reply are not feedback on advice', () => {
    const lines = [customer('نشد'), customer('نشد'), ai(), customer('نشد')];
    expect(failureFeedbackRun(lines, null)).toBe(1);
  });

  it('any other customer message ends the run, and so does a person', () => {
    const base = [customer('مشکل'), ai(), customer('نشد'), ai(), customer('نشد')];
    expect(
      failureFeedbackRun(
        [...base, ai(), customer('با Sing-box هستم'), ai(), customer('نشد')],
        null,
      ),
    ).toBe(1);
    expect(failureFeedbackRun([...base, person(), ai(), customer('نشد')], null)).toBe(1);
  });

  it('nothing before the epoch began (`since`) is read', () => {
    clock = 0;
    const lines = [
      customer('مشکل', 10),
      ai(undefined, 20),
      customer('نشد', 30),
      ai(undefined, 40),
      customer('نشد', 50),
      ai(undefined, 60),
      customer('نشد', 70),
    ];
    expect(failureFeedbackRun(lines, null)).toBe(3);
    expect(failureFeedbackRun(lines, at(45))).toBe(1);
  });
});

describe('A3: inbound_flood', () => {
  it(`the same message ${SUPPORT_AI_INBOUND_FLOOD.sameMessage} times in the epoch hands off`, () => {
    clock = 0;
    const lines = [customer('سلام؟'), ai(), customer('سلام ؟'), ai(), customer('سلام')];
    expect(autoInboundFloodGuard(lines, null)).toMatchObject({
      pass: false,
      outcome: 'guard_inbound_flood',
      reason: 'INBOUND_FLOOD',
    });
    expect(autoInboundFloodGuard(lines.slice(0, 3), null)).toEqual({ pass: true });
    // the first one belongs to an earlier epoch: two in this one
    expect(autoInboundFloodGuard(lines, lines[1]!.sentAt)).toEqual({ pass: true });
  });

  it(`more than ${SUPPORT_AI_INBOUND_FLOOD.maxInbound} messages within ${SUPPORT_AI_INBOUND_FLOOD.windowSeconds} s hands off`, () => {
    const burst = (n: number, spacing: number) =>
      Array.from({ length: n }, (_, i) => customer(`پیام شمارهٔ ${i}`, 1000 + i * spacing));
    expect(autoInboundFloodGuard(burst(8, 5), null)).toEqual({ pass: true });
    expect(autoInboundFloodGuard(burst(9, 5), null)).toMatchObject({
      outcome: 'guard_inbound_flood',
    });
    // nine, but spread over more than a minute
    expect(autoInboundFloodGuard(burst(9, 8), null)).toEqual({ pass: true });
    // nine in a minute, but a person took the first ones (the epoch began later)
    expect(autoInboundFloodGuard(burst(9, 5), at(1000 + 2 * 5))).toEqual({ pass: true });
  });

  it('photos without a caption are never "the same message"', () => {
    const lines = [customer(null), customer(null), customer(null)];
    expect(autoInboundFloodGuard(lines, null)).toEqual({ pass: true });
  });
});

describe('A3: repeated_advice', () => {
  const reply = (
    replyText: string,
    topic: SupportAiDecision['topic'] = 'CONNECTION_TROUBLESHOOTING',
  ) => ({
    replyText,
    topic,
  });
  const advice = 'لطفاً برنامه را کامل ببندید، لینک اشتراک را به‌روز کنید و دوباره وصل شوید.';
  it(`a reply at least ${SUPPORT_AI_REPEAT_SIMILARITY} similar to a delivered one is not sent`, () => {
    expect(SUPPORT_AI_REPEAT_SIMILARITY).toBe(0.8);
    const lines = [customer('وصل نمیشم'), ai(advice), customer('نشد')];
    // the same advice with a joiner, Arabic letters and punctuation changed
    const again = 'لطفا برنامه را کامل ببنديد، لينک اشتراک را بهروز کنيد و دوباره وصل شويد';
    expect(adviceSimilarity(again, [advice])).toBeGreaterThanOrEqual(0.8);
    expect(autoRepeatedAdviceGuard(reply(again), lines, null)).toMatchObject({
      pass: false,
      outcome: 'guard_repeated_advice',
      reason: 'REPEATED_ADVICE',
    });
  });

  it('different advice passes, and so does a repeat from before the epoch', () => {
    clock = 0;
    const lines = [customer('وصل نمیشم', 10), ai(advice, 20), customer('نشد', 30)];
    const other = 'از تنظیمات برنامه، پروتکل را روی TCP بگذارید و سرور دیگری را انتخاب کنید.';
    expect(adviceSimilarity(other, [advice])).toBeLessThan(0.8);
    expect(autoRepeatedAdviceGuard(reply(other), lines, null)).toEqual({ pass: true });
    expect(autoRepeatedAdviceGuard(reply(advice), lines, at(25))).toEqual({ pass: true });
  });

  it('a greeting is not advice: the same greeting twice passes', () => {
    const hello = 'سلام! چطور کمکتون کنم؟';
    expect(autoRepeatedAdviceGuard(reply(hello, 'GREETING'), [ai(hello)], null)).toEqual({
      pass: true,
    });
    expect(autoRepeatedAdviceGuard(reply(hello), [ai(hello)], null)).toMatchObject({ pass: false });
  });

  it('only the AI side is compared: the customer quoting the advice is not a repeat', () => {
    const lines = [customer(advice)];
    expect(autoRepeatedAdviceGuard(reply(advice), lines, null)).toEqual({ pass: true });
  });
});

describe('A6: closing acknowledgements and the silent NO_ACTION', () => {
  for (const text of [
    'مرسی',
    'ممنون',
    'خیلی ممنون',
    'حل شد',
    'اوکی درست شد',
    'درست شد مرسی',
    'وصل شد، دمت گرم',
    'merci',
    'mamnoon',
    'thanks',
    'ok, solved',
  ]) {
    it(`«${text}» closes`, () => expect(isClosingAcknowledgement(text)).toBe(true));
  }
  for (const text of [
    'نشد',
    'مرسی ولی هنوز وصل نمیشه',
    'حل شد؟',
    'اوکی، حالا چطور تمدید کنم',
    'خیلی',
    'سلام',
    '',
    'باشه',
  ]) {
    it(`«${text}» does not close`, () => expect(isClosingAcknowledgement(text)).toBe(false));
  }

  const decision: SupportAiDecision = {
    decision: 'NO_ACTION',
    replyText: '',
    topic: 'CONNECTION_TROUBLESHOOTING',
    confidence: 'HIGH',
    factRefs: [],
    knowledgeRefs: [],
    ticketAction: 'NONE',
    summary: 'مشکل حل شد.',
    intent: 'تشکر',
  } as SupportAiDecision;
  const flags: AutoContextFlags = {
    identityLinked: true,
    customerBlocked: false,
    hasUnderReviewPayment: false,
    hasUnreconciledService: false,
  };
  const config: Parameters<typeof autoNoActionAllowed>[0]['config'] = {
    autoTopics: ['CONNECTION_TROUBLESHOOTING', 'GREETING'],
    autoMinConfidence: 'HIGH',
  };
  const allowed = (over: Partial<Parameters<typeof autoNoActionAllowed>[0]> = {}) =>
    autoNoActionAllowed({ decision, config, flags, customerTexts: ['مرسی، حل شد'], ...over });

  it('ends silently on an allowlisted topic when every customer line closes', () => {
    expect(allowed()).toBe(true);
    expect(supportAutoOutcomeClass('no_action')).toBe('DROPPED');
  });

  it('never for another decision, a sensitive or unlisted topic, low confidence or a flagged account', () => {
    expect(allowed({ decision: { ...decision, decision: 'REPLY' } })).toBe(false);
    expect(allowed({ decision: { ...decision, topic: 'REFUND' } })).toBe(false);
    expect(allowed({ decision: { ...decision, topic: 'HUMAN_REQUESTED' } })).toBe(false);
    expect(allowed({ decision: { ...decision, topic: 'APP_SETUP' } })).toBe(false);
    expect(allowed({ decision: { ...decision, confidence: 'MEDIUM' } })).toBe(false);
    expect(allowed({ flags: { ...flags, hasUnderReviewPayment: true } })).toBe(false);
    expect(allowed({ flags: { ...flags, customerBlocked: true } })).toBe(false);
    expect(
      allowed({
        decision: { ...decision, topic: 'SERVICE_INFO' },
        config: { ...config, autoTopics: ['SERVICE_INFO'] },
        flags: { ...flags, identityLinked: false },
      }),
    ).toBe(false);
  });

  it('never when any customer line it would answer is not a closing one', () => {
    expect(allowed({ customerTexts: ['مرسی', 'یه سؤال دیگه دارم'] })).toBe(false);
    expect(allowed({ customerTexts: [] })).toBe(false);
    expect(allowed({ customerTexts: [null] })).toBe(false);
  });
});

describe('A4: the handoff notice is sendable only while the handoff stands', () => {
  it('HANDOFF_REQUIRED at its own epoch, and nothing else', () => {
    const base = { origin: 'HANDOFF_NOTICE', rowEpoch: 3, conversationEpoch: 3 } as const;
    expect(businessOutboundSendable({ ...base, conversationState: 'HANDOFF_REQUIRED' })).toBe(true);
    for (const state of ['AI_ACTIVE', 'HUMAN_ACTIVE', 'PAUSED'] as const) {
      expect(businessOutboundSendable({ ...base, conversationState: state }), state).toBe(false);
    }
    expect(
      businessOutboundSendable({
        ...base,
        conversationEpoch: 4,
        conversationState: 'HANDOFF_REQUIRED',
      }),
    ).toBe(false);
  });
});
