import { describe, expect, it, vi } from 'vitest';
import {
  SUPPORT_AI_HANDOFF_RATE_WINDOW,
  supportAiConfigIsRestrictive,
  supportAiRecommendedPreset,
  SUPPORT_AI_DEFAULT_CONFIG,
  SUPPORT_AI_SAFE_TOPICS,
  supportContextPayloadSchema,
  type TenantContext,
} from '@nexa/contracts';
import { autoResumeTrigger } from '../../apps/api/src/modules/commerce/business-chats/domain/auto-resume';
import {
  checkOutputPolicy,
  outputPolicyAllowanceFromContext,
} from '../../apps/api/src/modules/control/support-ai/domain/output-policy';
import { transcriptMessages } from '../../apps/api/src/modules/control/support-ai/domain/prompt';
import { handoffRateVerdict } from '../../apps/api/src/modules/control/support-ai/application/handoff-rate-alert';
import { AssistantLoop } from '../../apps/api/src/modules/control/support-ai/application/assistant-loop';
import type { SupportAiJobRecord } from '../../apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai-job.repository';

/**
 * Phase 4 PR-1 (`fix/sai-handoff-policy`) — the pure rules of the new handoff policy, the
 * output validator, the transcript's last turn, the handoff-rate alert and the loop's resilience.
 * Synthetic data only.
 */

const NOW = new Date('2026-11-01T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describe('soft-handoff auto-resume (autoResumeTrigger)', () => {
  const soft = {
    state: 'HANDOFF_REQUIRED' as const,
    handoffKind: 'SOFT' as const,
    windowMinutes: 30,
    previousMessageAt: minutesAgo(5),
    lastHumanAt: null,
    holdActivityAt: minutesAgo(5),
    ticketClosed: false,
    now: NOW,
  };

  it('trigger 1 — HUMAN_SILENT: no person wrote for the window since the handoff', () => {
    expect(autoResumeTrigger({ ...soft, holdActivityAt: minutesAgo(31) })).toBe('HUMAN_SILENT');
    expect(autoResumeTrigger({ ...soft, holdActivityAt: minutesAgo(29) })).toBeNull();
    // A person's word in Telegram inside the window keeps the hold.
    expect(
      autoResumeTrigger({ ...soft, holdActivityAt: minutesAgo(40), lastHumanAt: minutesAgo(10) }),
    ).toBeNull();
  });

  it('trigger 2 — RESOLVED: the handoff’s ticket was closed', () => {
    expect(autoResumeTrigger({ ...soft, ticketClosed: true })).toBe('RESOLVED');
    // A person's message (HUMAN_ACTIVE) carries no ticket of its own: an old ticket never counts.
    expect(
      autoResumeTrigger({ ...soft, state: 'HUMAN_ACTIVE', ticketClosed: true, lastHumanAt: NOW }),
    ).toBeNull();
  });

  it('trigger 3 — NEW_SESSION: the customer writes after a silence of the window', () => {
    expect(
      autoResumeTrigger({
        ...soft,
        previousMessageAt: minutesAgo(45),
        holdActivityAt: minutesAgo(45),
      }),
    ).toBe('NEW_SESSION');
  });

  it('a person’s message pauses the AI for the window only', () => {
    const paused = { ...soft, state: 'HUMAN_ACTIVE' as const, holdActivityAt: null };
    expect(autoResumeTrigger({ ...paused, lastHumanAt: minutesAgo(10) })).toBeNull();
    expect(autoResumeTrigger({ ...paused, lastHumanAt: minutesAgo(31) })).toBe('HUMAN_SILENT');
  });

  it('a HARD handoff, a hold from before the kind existed, and a window of 0 stay sticky', () => {
    const due = { ...soft, holdActivityAt: minutesAgo(600), ticketClosed: true };
    expect(autoResumeTrigger({ ...due, handoffKind: 'HARD' })).toBeNull();
    expect(autoResumeTrigger({ ...due, handoffKind: null })).toBeNull();
    expect(autoResumeTrigger({ ...due, windowMinutes: 0 })).toBeNull();
    expect(autoResumeTrigger({ ...due, state: 'PAUSED' })).toBeNull();
    // Without a known start the hold stays (fail sticky).
    expect(autoResumeTrigger({ ...soft, holdActivityAt: null, lastHumanAt: null })).toBeNull();
  });
});

describe('the output validator (cross-cutting item 3)', () => {
  const context = JSON.stringify({
    services: [{ alias: 'S1', label: 'user_8823', remainingTrafficBytes: '5368709120' }],
    payments: [{ alias: 'P1', amount: { amountMinor: '1500000', currency: 'IRT' } }],
    clientApps: [{ name: 'v2rayNG', officialUrl: 'https://github.com/2dust/v2rayNG/releases' }],
    knowledge: [
      {
        alias: 'K1',
        question: 'تست رایگان',
        answer: 'تست رایگان یک‌روزه از منوی ربات فعال می‌شود. کارت: 6037-9912-3456-7893',
      },
    ],
    supportAccounts: ['@nexa_support'],
  });
  const allowance = outputPolicyAllowanceFromContext(context, {
    links: ['https://t.me/nexa_bot?start=support'],
  });
  const check = (reply: string) => checkOutputPolicy(reply, allowance);

  it('passes what the context holds', () => {
    for (const reply of [
      'برنامه v2rayNG را از https://github.com/2dust/v2rayNG/releases نصب کنید.',
      'وارد ربات شوید: https://t.me/nexa_bot?start=support',
      'مبلغ پرداخت شما ۱٬۵۰۰٬۰۰۰ تومان بود و در حال بررسی است.',
      'مبلغ ۱۵۰,۰۰۰ تومان',
      'با پشتیبانی @nexa_support در تماس باشید.',
      'تست رایگان یک‌روزه از منوی ربات فعال می‌شود.',
      'کارت به کارت به شماره 6037991234567893',
      'کارت به کارت به شماره 6037 9912 3456 7893',
      'مرحلهٔ ۲: برنامه را ببندید و ۳۰ ثانیه صبر کنید.',
    ]) {
      expect(check(reply), reply).toEqual({ ok: true });
    }
  });

  it('refuses links, numbers, handles and promises the context does not hold (attacks)', () => {
    const attacks: [string, string][] = [
      ['از این لینک دانلود کنید https://evil.example/app.apk', 'link'],
      ['t.me/scam_channel را ببینید', 'link'],
      ['مبلغ ۲۰۰٬۰۰۰ تومان واریز کنید', 'number'],
      ['به کارت 6219861034567890 واریز کنید', 'number'],
      ['با شماره 09121234567 تماس بگیرید', 'number'],
      ['آیدی تلگرام ادمین 123456789 است', 'number'],
      ['به @admin_real پیام بدهید', 'handle'],
      ['پولتان را برمی‌گردونیم', 'promise'],
      ['یک ماه مجانی برایتان فعال می‌کنیم', 'promise'],
      ['به کارت 6219 8610 3456 7890 واریز کنید', 'number'],
      ['۵۰ درصد تخفیف می‌دم', 'promise'],
      ['خسارتتان را جبران می‌کنیم', 'promise'],
      ['We will refund you', 'promise'],
      ['you get a free month', 'promise'],
      ['pooleton ro bargardoonim', 'promise'],
      ['takhfif midim', 'promise'],
    ];
    for (const [reply, violation] of attacks) {
      expect(check(reply), reply).toEqual({ ok: false, violation });
    }
  });

  it('a promise word is allowed when approved knowledge carries it', () => {
    // «رایگان» is in K1; «تخفیف» is not.
    expect(check('تست رایگان دارید.')).toEqual({ ok: true });
    expect(check('تخفیف دارید.')).toEqual({ ok: false, violation: 'promise' });
  });

  it('a price family plugs in (PR-2’s live catalogue)', () => {
    const priced = outputPolicyAllowanceFromContext(context, {
      priceFamily: { has: (digits) => digits === '250000' },
    });
    expect(checkOutputPolicy('قیمت ۲۵۰٬۰۰۰ تومان است', priced)).toEqual({ ok: true });
    expect(checkOutputPolicy('قیمت ۳۵۰٬۰۰۰ تومان است', priced)).toEqual({
      ok: false,
      violation: 'number',
    });
  });

  it('no context at all: only links, numbers and handles NEXA whitelisted', () => {
    const bare = outputPolicyAllowanceFromContext(null);
    expect(checkOutputPolicy('برنامه را دوباره باز کنید.', bare)).toEqual({ ok: true });
    expect(checkOutputPolicy('https://example.com', bare)).toEqual({
      ok: false,
      violation: 'link',
    });
  });
});

describe('the transcript always ends with the customer (runtime fix)', () => {
  it('drops a trailing away/greeting (OFFLINE) message', () => {
    const turns = transcriptMessages([
      { origin: 'INBOUND', author: 'CUSTOMER', text: 'سلام وصل نمیشه', kind: 'TEXT' },
      { origin: 'OFFLINE', author: 'AUTOMATED', text: 'در ساعت کاری پاسخ می‌دهیم', kind: 'TEXT' },
    ]);
    expect(turns.at(-1)?.role).toBe('user');
    expect(turns.map((turn) => turn.text).join('\n')).not.toContain('در ساعت کاری');
  });

  it('keeps an away message that is not last', () => {
    const turns = transcriptMessages([
      { origin: 'INBOUND', author: 'CUSTOMER', text: 'سلام', kind: 'TEXT' },
      { origin: 'OFFLINE', author: 'AUTOMATED', text: 'خوش آمدید', kind: 'TEXT' },
      { origin: 'INBOUND', author: 'CUSTOMER', text: 'وصل نمیشه', kind: 'TEXT' },
    ]);
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user']);
  });
});

describe('the handoff-rate alert (item 9)', () => {
  const row = (reason: string | null, topic: string | null = null) => ({
    outcome: reason === null ? 'sent' : 'guard_x',
    handoffReason: reason,
    topic,
  });
  const window = (soft: number, hard = 0) => [
    ...Array.from({ length: soft }, () => row('TOPIC_NOT_ALLOWED')),
    ...Array.from({ length: hard }, () => row('HUMAN_REQUESTED')),
    ...Array.from({ length: SUPPORT_AI_HANDOFF_RATE_WINDOW - soft - hard }, () => row(null)),
  ];

  it('alerts above the threshold of soft handoffs, with the top reasons', () => {
    const verdict = handoffRateVerdict(window(16), 30);
    expect(verdict.alert).toBe(true);
    expect(verdict.top[0]).toEqual({ reason: 'TOPIC_NOT_ALLOWED', count: 16 });
  });

  it('never at or below it, never counting hard handoffs, never on a small sample, never at 0', () => {
    expect(handoffRateVerdict(window(15), 30).alert).toBe(false);
    expect(handoffRateVerdict(window(5, 40), 30).alert).toBe(false);
    expect(handoffRateVerdict(window(16).slice(0, 49), 30).alert).toBe(false);
    expect(handoffRateVerdict(window(50), 0).alert).toBe(false);
  });
});

describe('the recommended preset (item 6)', () => {
  it('is every safe topic, MEDIUM, vision when a step can see — applied only on request', () => {
    const preset = supportAiRecommendedPreset(SUPPORT_AI_DEFAULT_CONFIG, true);
    expect(preset.autoTopics).toEqual([...SUPPORT_AI_SAFE_TOPICS]);
    expect(preset.autoMinConfidence).toBe('MEDIUM');
    expect(preset.visionEnabled).toBe(true);
    expect(supportAiRecommendedPreset(SUPPORT_AI_DEFAULT_CONFIG, false).visionEnabled).toBe(false);
    // The mode is never changed by it.
    expect(preset.mode).toBe(SUPPORT_AI_DEFAULT_CONFIG.mode);
  });

  it('the old restrictive configuration is recognised for the banner, the preset is not', () => {
    expect(supportAiConfigIsRestrictive(SUPPORT_AI_DEFAULT_CONFIG)).toBe(true);
    expect(
      supportAiConfigIsRestrictive({ autoTopics: ['APP_SETUP'], autoMinConfidence: 'MEDIUM' }),
    ).toBe(true);
    expect(
      supportAiConfigIsRestrictive(supportAiRecommendedPreset(SUPPORT_AI_DEFAULT_CONFIG, false)),
    ).toBe(false);
  });
});

describe('the context carries nothing secret (cross-cutting item 2)', () => {
  /** Every key the payload schema allows, at any depth. */
  function keysOf(schema: unknown, out = new Set<string>()): Set<string> {
    let current = schema as { _def?: Record<string, unknown>; shape?: Record<string, unknown> };
    // Unwrap optional / nullable / array / effects.
    for (let i = 0; i < 6; i += 1) {
      const def = current?._def as Record<string, unknown> | undefined;
      const inner = (def?.innerType ?? def?.type ?? def?.schema) as typeof current | undefined;
      if (inner === undefined || typeof inner !== 'object' || current.shape !== undefined) break;
      current = inner;
    }
    const shape = current?.shape;
    if (shape !== undefined) {
      for (const [key, value] of Object.entries(shape)) {
        out.add(key);
        keysOf(value, out);
      }
    }
    return out;
  }

  it('the payload schema has no key for other customers, staff, credentials, notes or ids', () => {
    const keys = [...keysOf(supportContextPayloadSchema)];
    expect(keys.length).toBeGreaterThan(10);
    const forbidden =
      /admin|operator|staff|note|tag|token|secret|password|credential|apikey|api_key|cardnumber|pan$|phone|telegram|chatid|email|otherCustomer|panelUrl|gatewayKey/iu;
    expect(keys.filter((key) => forbidden.test(key))).toEqual([]);
    // Strict objects: an unknown key (an operator's note slipped in) fails the parse.
    expect(supportContextPayloadSchema.safeParse({ adminNote: 'x' } as unknown).success).toBe(
      false,
    );
  });
});

describe('a throwing job does not stall the assistant loop (item 8)', () => {
  const scope = { tenantId: 't', botInstanceId: null } as unknown as TenantContext;
  const job = (id: string, kind: 'AUTO_DECISION' | 'ASSIST_DRAFT') =>
    ({ id, attempts: 1, kind, conversationId: 'c' }) as unknown as SupportAiJobRecord;

  it('a context builder that throws: logged, released for one retry, and the next job runs', async () => {
    const queue = [job('a', 'AUTO_DECISION'), job('b', 'AUTO_DECISION'), job('c', 'ASSIST_DRAFT')];
    const logger = { info: vi.fn(), error: vi.fn() };
    const auto = {
      produce: vi.fn(async (_scope: TenantContext, claimed: SupportAiJobRecord) => {
        if (claimed.id === 'a') throw new Error('context builder exploded');
        return 'sent' as const;
      }),
      giveUp: vi.fn(async () => 'handoff_ai_unavailable' as const),
      recoverFromException: vi.fn(
        async (_scope: TenantContext, _job: SupportAiJobRecord) => 'RETRY' as const,
      ),
    };
    const assist = {
      claimNext: vi.fn(async () => queue.shift() ?? null),
      produce: vi.fn(async () => {
        throw new Error('assist exploded too');
      }),
      abandon: vi.fn(async () => 'FAILED' as const),
      purgeExpired: vi.fn(async () => 0),
    };
    const loop = new AssistantLoop(assist, {
      auto,
      scope: () => scope,
      intervalMs: 2_000,
      now: () => NOW,
      logger,
    });
    await loop.tick();
    expect(auto.produce).toHaveBeenCalledTimes(2);
    expect(auto.recoverFromException).toHaveBeenCalledTimes(1);
    expect(auto.recoverFromException.mock.calls[0]?.[1]).toMatchObject({ id: 'a' });
    expect(assist.produce).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'a' }),
      'assistant: a job failed',
    );
    // The pass itself completed.
    expect(logger.error).not.toHaveBeenCalledWith(expect.anything(), 'assistant pass failed');
  });
});
