import { describe, expect, it } from 'vitest';
import {
  SUPPORT_AI_INBOUND_FLOOD,
  SUPPORT_AI_NO_PROGRESS_LIMIT,
  SUPPORT_AI_REPEAT_SIMILARITY,
  supportAutoOutcomeClass,
  businessOutboundSendable,
  type SupportAiAutoOutcome,
  type SupportAiDecision,
} from '@nexa/contracts';
import {
  adviceSimilarity,
  autoInboundFloodGuard,
  autoNoActionAllowed,
  autoNoActionVerdict,
  autoNoProgressGuard,
  autoRepeatedAdviceGuard,
  failureFeedbackRun,
  isClosingAcknowledgement,
  isFailureFeedback,
  repeatsEarlierAdvice,
  type AutoContextFlags,
  type ProgressLine,
} from '../../apps/api/src/modules/control/support-ai/domain/auto-reply-guards';

/**
 * Roadmap A3/A6 — the deterministic progress guards and the silent NO_ACTION, pure. The
 * integration file drives each through the real AUTO path; this pins the matchers and walks.
 * Review of PR #246: CX3 (only AI_AUTO is the AI's advice), m1, m2, m3, m7, m9.
 */

const T0 = new Date('2026-10-07T10:00:00Z').getTime();
let clock = 0;
const at = (seconds?: number) => new Date(T0 + (seconds ?? (clock += 30)) * 1000);
const customer = (text: string | null, seconds?: number): ProgressLine => ({
  origin: 'INBOUND',
  author: 'CUSTOMER',
  text,
  sentAt: at(seconds),
});
const ai = (
  text = 'لطفاً برنامه را ببندید و دوباره باز کنید.',
  seconds?: number,
): ProgressLine => ({ origin: 'OWN_ECHO', author: 'AI_AUTO', text, sentAt: at(seconds) });
const echo = (author: ProgressLine['author'], text = 'یک پیام از سمت کسب‌وکار'): ProgressLine => ({
  origin: 'OWN_ECHO',
  author,
  text,
  sentAt: at(),
});
const person = (seconds?: number): ProgressLine => ({
  origin: 'HUMAN',
  author: 'STAFF',
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
    // m7
    'نمیتونم وصل بشم',
    'نمی‌تونم وصل شم',
    'هنوزم مشکل داره',
    'not connecting',
    'it did not connect',
    'still no',
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
  for (const text of [
    'درست شد',
    'حل شد مرسی',
    'وصل شد',
    'سلام',
    'با Sing-box وصل می‌شم',
    'چطور اشتراکم رو تمدید کنم؟',
    'بشد',
  ]) {
    it(`«${text}» is not failure feedback`, () => expect(isFailureFeedback(text)).toBe(false));
  }
  it('null and blank are not failure feedback', () => {
    expect(isFailureFeedback(null)).toBe(false);
    expect(isFailureFeedback('   ')).toBe(false);
  });
});

describe('A3: no_progress, in rounds', () => {
  it(`hands off at ${SUPPORT_AI_NO_PROGRESS_LIMIT} rounds: each «it did not work» after a different AI reply`, () => {
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
    expect(autoNoProgressGuard(lines.slice(0, 5), null)).toEqual({ pass: true });
  });

  it('m7: several «نشد» after ONE reply are one round, not three', () => {
    const lines = [
      customer('مشکل دارم'),
      ai(),
      customer('نشد'),
      customer('نشد'),
      customer('جواب نداد'),
    ];
    expect(failureFeedbackRun(lines, null)).toBe(1);
    expect(autoNoProgressGuard(lines, null)).toEqual({ pass: true });
  });

  it('m7: a reply nobody answered with «it did not work» is not a round', () => {
    // Several automatic replies in a row and then one «نشد»: one round, not three. Counting the
    // replies instead of the feedback would hand off at the first failure.
    const split = [customer('مشکل دارم'), ai('اول'), ai('دوم'), ai('سوم'), customer('نشد')];
    expect(failureFeedbackRun(split, null)).toBe(1);
    expect(autoNoProgressGuard(split, null)).toEqual({ pass: true });
    // The newest reply has not been answered yet: two rounds, not three.
    const unanswered = [
      customer('مشکل دارم'),
      ai('اول'),
      customer('نشد'),
      ai('دوم'),
      customer('نشد'),
      ai('سوم'),
    ];
    expect(failureFeedbackRun(unanswered, null)).toBe(2);
    expect(autoNoProgressGuard(unanswered, null)).toEqual({ pass: true });
  });

  it('failure messages BEFORE any AI reply are not feedback on advice', () => {
    expect(
      failureFeedbackRun([customer('نشد'), customer('نشد'), ai(), customer('نشد')], null),
    ).toBe(1);
  });

  it('any other customer message ends the run, and so does a person', () => {
    const base = [customer('مشکل'), ai(), customer('نشد'), ai('دوم'), customer('نشد')];
    expect(
      failureFeedbackRun(
        [...base, ai('سوم'), customer('با Sing-box هستم'), ai('چهارم'), customer('نشد')],
        null,
      ),
    ).toBe(1);
    expect(failureFeedbackRun([...base, person(), ai('سوم'), customer('نشد')], null)).toBe(1);
  });

  it('CX3: only AI_AUTO is the AI’s advice — a person’s send, an Assist draft or an unattributed echo is not', () => {
    for (const author of ['STAFF', 'AI_ASSIST'] as const) {
      const lines = [
        customer('مشکل'),
        ai(),
        customer('نشد'),
        ai('دوم'),
        customer('نشد'),
        echo(author),
        customer('نشد'),
      ];
      expect(failureFeedbackRun(lines, null), author).toBe(0);
    }
    for (const author of ['UNATTRIBUTED', 'AUTOMATED'] as const) {
      const lines = [customer('مشکل'), ai(), customer('نشد'), echo(author), customer('نشد')];
      // not a round of its own: the two «نشد» belong to the one AI reply
      expect(failureFeedbackRun(lines, null), author).toBe(1);
    }
  });

  it('nothing before the epoch began (`since`) is read', () => {
    clock = 0;
    const lines = [
      customer('مشکل', 10),
      ai(undefined, 20),
      customer('نشد', 30),
      ai('دوم', 40),
      customer('نشد', 50),
      ai('سوم', 60),
      customer('نشد', 70),
    ];
    expect(failureFeedbackRun(lines, null)).toBe(3);
    expect(failureFeedbackRun(lines, at(45))).toBe(1);
  });
});

describe('A3: inbound_flood', () => {
  it(`the same message ${SUPPORT_AI_INBOUND_FLOOD.sameMessage} times within ${SUPPORT_AI_INBOUND_FLOOD.windowSeconds} s hands off`, () => {
    const lines = [
      customer('کسی هست؟', 1000),
      ai(undefined, 1005),
      customer('کسی هست ؟', 1010),
      ai('دوم', 1015),
      customer('کسی هست', 1020),
    ];
    expect(autoInboundFloodGuard(lines, null)).toMatchObject({
      pass: false,
      outcome: 'guard_inbound_flood',
      reason: 'INBOUND_FLOOD',
    });
    expect(autoInboundFloodGuard(lines.slice(0, 3), null)).toEqual({ pass: true });
    // the first one belongs to an earlier epoch: two in this one
    expect(autoInboundFloodGuard(lines, at(1005))).toEqual({ pass: true });
  });

  it('m1: the same message spread over more than the window is a conversation, not a flood', () => {
    const lines = [
      customer('ok', 2000),
      ai(undefined, 2030),
      customer('ok', 2100),
      ai('دوم', 2130),
      customer('OK!', 2200),
    ];
    expect(autoInboundFloodGuard(lines, null)).toEqual({ pass: true });
  });

  it('m1: a closing acknowledgement repeated inside the window is still not a flood (A6 may close it)', () => {
    const lines = [
      customer('مرسی', 3000),
      ai(undefined, 3005),
      customer('مرسی', 3010),
      ai('دوم', 3015),
      customer('مرسی', 3020),
    ];
    expect(autoInboundFloodGuard(lines, null)).toEqual({ pass: true });
  });

  it(`more than ${SUPPORT_AI_INBOUND_FLOOD.maxInbound} messages within ${SUPPORT_AI_INBOUND_FLOOD.windowSeconds} s hands off`, () => {
    const burst = (n: number, spacing: number) =>
      Array.from({ length: n }, (_, i) => customer(`پیام شمارهٔ ${i}`, 4000 + i * spacing));
    expect(autoInboundFloodGuard(burst(8, 5), null)).toEqual({ pass: true });
    expect(autoInboundFloodGuard(burst(9, 5), null)).toMatchObject({
      outcome: 'guard_inbound_flood',
    });
    expect(autoInboundFloodGuard(burst(9, 8), null)).toEqual({ pass: true });
    // nine in a minute, but a person took the first ones (the epoch began later)
    expect(autoInboundFloodGuard(burst(9, 5), at(4000 + 2 * 5))).toEqual({ pass: true });
  });

  it('photos without a caption are never "the same message"', () => {
    expect(
      autoInboundFloodGuard(
        [customer(null, 5000), customer(null, 5001), customer(null, 5002)],
        null,
      ),
    ).toEqual({ pass: true });
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

  it(`a reply ≥ ${SUPPORT_AI_REPEAT_SIMILARITY} similar AND of the same words is not sent`, () => {
    expect(SUPPORT_AI_REPEAT_SIMILARITY).toBe(0.8);
    const lines = [customer('وصل نمیشم'), ai(advice), customer('نشد')];
    const again = 'لطفا برنامه را کامل ببنديد، لينک اشتراک را بهروز کنيد و دوباره وصل شويد';
    expect(adviceSimilarity(again, [advice])).toBeGreaterThanOrEqual(0.8);
    expect(autoRepeatedAdviceGuard(reply(again), lines, null)).toMatchObject({
      pass: false,
      outcome: 'guard_repeated_advice',
      reason: 'REPEATED_ADVICE',
    });
  });

  it('m9: a correction (کنید → نکنید) is above the similarity threshold but not a repeat, and is sent', () => {
    const before = 'لطفاً برنامه را به‌روزرسانی کنید و دوباره وصل شوید.';
    const corrected = 'لطفاً برنامه را به‌روزرسانی نکنید و دوباره وصل شوید.';
    expect(adviceSimilarity(corrected, [before])).toBeGreaterThanOrEqual(
      SUPPORT_AI_REPEAT_SIMILARITY,
    );
    expect(repeatsEarlierAdvice(corrected, [before])).toBe(false);
    expect(autoRepeatedAdviceGuard(reply(corrected), [ai(before)], null)).toEqual({ pass: true });
  });

  it('different advice passes, and so does a repeat from before the epoch', () => {
    clock = 0;
    const lines = [customer('وصل نمیشم', 10), ai(advice, 20), customer('نشد', 30)];
    const other = 'از تنظیمات برنامه، پروتکل را روی TCP بگذارید و سرور دیگری را انتخاب کنید.';
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

  it('CX3: only the AI’s automatic replies are compared — a person’s or a customer’s identical text is not', () => {
    for (const line of [
      customer(advice),
      echo('STAFF', advice),
      echo('AI_ASSIST', advice),
      echo('UNATTRIBUTED', advice),
    ]) {
      expect(autoRepeatedAdviceGuard(reply(advice), [line], null), line.author).toEqual({
        pass: true,
      });
    }
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
    // m2
    'ok is it working now',
    'ok？',
    'مرسی⁇',
    'وصل',
    'درست',
    'الان درست شد',
    'آیا حل شد',
    'solved',
    // every other word closing vocabulary, one question word: a question, with no mark
    'کی درست شد',
    'چطور وصل شد',
    'why ok',
  ]) {
    it(`«${text}» does not close`, () => expect(isClosingAcknowledgement(text)).toBe(false));
  }

  const decision = {
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
  const input = (over: Partial<Parameters<typeof autoNoActionAllowed>[0]> = {}) => ({
    decision,
    config,
    flags,
    customerTexts: ['مرسی، حل شد'],
    ...over,
  });
  const allowed = (over: Partial<Parameters<typeof autoNoActionAllowed>[0]> = {}) =>
    autoNoActionAllowed(input(over));

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
    // m3
    expect(allowed({ flags: { ...flags, hasUnreconciledService: true } })).toBe(false);
    expect(allowed({ flags: { ...flags, customerBlocked: true } })).toBe(false);
    expect(
      allowed({
        decision: { ...decision, topic: 'SERVICE_INFO' },
        config: { ...config, autoTopics: ['SERVICE_INFO'] },
        flags: { ...flags, identityLinked: false },
      }),
    ).toBe(false);
  });

  it('CX2: the refusal names the most specific reason — the handoff the in-transaction recheck makes', () => {
    expect(
      autoNoActionVerdict(input({ flags: { ...flags, customerBlocked: true } })),
    ).toMatchObject({
      outcome: 'guard_customer_blocked',
      reason: 'CUSTOMER_BLOCKED',
    });
    for (const flag of ['hasUnderReviewPayment', 'hasUnreconciledService'] as const) {
      expect(autoNoActionVerdict(input({ flags: { ...flags, [flag]: true } })), flag).toMatchObject(
        {
          outcome: 'guard_account_review',
          reason: 'ACCOUNT_UNDER_REVIEW',
        },
      );
    }
    expect(
      autoNoActionVerdict(input({ decision: { ...decision, topic: 'WALLET' } })),
    ).toMatchObject({
      reason: 'HANDOFF_TOPIC',
    });
    expect(
      autoNoActionVerdict(input({ decision: { ...decision, topic: 'HUMAN_REQUESTED' } })),
    ).toMatchObject({
      reason: 'HUMAN_REQUESTED',
    });
    expect(autoNoActionVerdict(input({ customerTexts: ['یه سؤال دیگه'] }))).toMatchObject({
      reason: 'DECISION_NOT_REPLY',
    });
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

describe('m8: the outcome classifier is total at run time', () => {
  it('a newer replica’s unknown outcome is classified by its family, never thrown', () => {
    const unknown = (code: string) => supportAutoOutcomeClass(code as SupportAiAutoOutcome);
    expect(unknown('guard_something_new')).toBe('HANDED_OFF');
    expect(unknown('handoff_something_new')).toBe('HANDED_OFF');
    expect(unknown('sent_something_new')).toBe('SENT');
    expect(unknown('something_else')).toBe('DROPPED');
  });
});
