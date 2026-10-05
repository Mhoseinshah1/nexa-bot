import { describe, expect, it, vi } from 'vitest';
import {
  BUSINESS_CONVERSATION_STATES,
  NOTIFICATION_CATEGORY_PERMISSIONS,
  ROLE_SEEDS,
  SUPPORT_AI_AUTO_OUTCOMES,
  businessInboxPriority,
  businessUnansweredSince,
  isNotification,
  notificationRuleFor,
  supportAiBreakerState,
  supportAnalyticsQuerySchema,
  supportAutoOutcomeClass,
  visibleNotificationCategories,
} from '@nexa/contracts';
import { linkFor } from '../../apps/api/src/modules/platform/opslog/application/notification-center.service';
import {
  SUPPORT_ANALYTICS_CUSTOM_MAX_DAYS,
  SupportAnalyticsService,
} from '../../apps/api/src/modules/control/support-ai/application/support-analytics.service';
import {
  assembleSupportAnalytics,
  type SupportAnalyticsFacts,
} from '../../apps/api/src/modules/control/support-ai/domain/support-analytics';

/**
 * TB10 — the pure rules under the inbox, the provider health panel, the support analytics
 * and the support notifications. Each `it` names one rule; the mutation driver
 * (`scripts/mutate-tb10.py`) reverts each and expects its test to fail.
 */

const at = (iso: string) => new Date(iso);

describe('the customer’s wait (businessUnansweredSince)', () => {
  const base = {
    lastInboundAt: at('2026-10-05T10:10:00Z'),
    lastHumanAt: null,
    lastAiAt: null,
    firstUnansweredAt: at('2026-10-05T10:00:00Z'),
  };

  it('is the OLDEST customer message nobody answered, not the latest', () => {
    expect(businessUnansweredSince(base)).toEqual(at('2026-10-05T10:00:00Z'));
  });

  it('is nothing when a person or the AI replied after the customer’s last message', () => {
    expect(businessUnansweredSince({ ...base, lastHumanAt: at('2026-10-05T10:11:00Z') })).toBe(
      null,
    );
    expect(businessUnansweredSince({ ...base, lastAiAt: at('2026-10-05T10:10:01Z') })).toBe(null);
  });

  /*
   * PR #205 review, S1: Telegram dates the customer's message in whole seconds; a reply the
   * server stamped carries milliseconds. On one grain, a reply in the customer's own second
   * does not say who spoke first — so the customer is still waiting.
   */
  it('is still waiting for a customer message in the same Telegram second as a reply (one clock, one grain)', () => {
    const sameSecond = {
      lastInboundAt: at('2026-10-05T10:10:00.000Z'),
      lastHumanAt: null,
      firstUnansweredAt: at('2026-10-05T10:10:00.000Z'),
    };
    // The reply confirmed at a sub-second server `now`, inside the customer's second.
    expect(
      businessUnansweredSince({ ...sameSecond, lastAiAt: at('2026-10-05T10:10:00.400Z') }),
    ).toEqual(at('2026-10-05T10:10:00.000Z'));
    // The reply's own Telegram date, the same second: still waiting.
    expect(
      businessUnansweredSince({ ...sameSecond, lastAiAt: at('2026-10-05T10:10:00.000Z') }),
    ).toEqual(at('2026-10-05T10:10:00.000Z'));
    // From the next second on, the reply answers the customer.
    expect(
      businessUnansweredSince({ ...sameSecond, lastAiAt: at('2026-10-05T10:10:01.000Z') }),
    ).toBe(null);
    // The held message in the reply's second is the start of the wait, not the inbound stamp.
    expect(
      businessUnansweredSince({
        lastInboundAt: at('2026-10-05T10:12:00.000Z'),
        lastHumanAt: at('2026-10-05T10:10:00.700Z'),
        lastAiAt: null,
        firstUnansweredAt: at('2026-10-05T10:10:00.000Z'),
      }),
    ).toEqual(at('2026-10-05T10:10:00.000Z'));
  });

  it('counts the LATER of a person’s and the AI’s replies', () => {
    // The AI answered at 10:05 and the customer wrote again at 10:10; an older human reply
    // does not hide that the customer is waiting.
    const since = businessUnansweredSince({
      ...base,
      lastHumanAt: at('2026-10-05T09:00:00Z'),
      lastAiAt: at('2026-10-05T10:05:00Z'),
      firstUnansweredAt: at('2026-10-05T10:10:00Z'),
    });
    expect(since).toEqual(at('2026-10-05T10:10:00Z'));
  });

  it('falls back to the latest inbound stamp when the held messages predate the reply (an edit)', () => {
    const since = businessUnansweredSince({
      ...base,
      lastAiAt: at('2026-10-05T10:05:00Z'),
      firstUnansweredAt: at('2026-10-05T10:00:00Z'),
    });
    expect(since).toEqual(at('2026-10-05T10:10:00Z'));
    expect(
      businessUnansweredSince({
        ...base,
        lastAiAt: at('2026-10-05T10:05:00Z'),
        firstUnansweredAt: null,
      }),
    ).toEqual(at('2026-10-05T10:10:00Z'));
  });

  it('is nothing for a conversation the customer never wrote in', () => {
    expect(businessUnansweredSince({ ...base, lastInboundAt: null })).toBe(null);
  });
});

describe('the inbox priority', () => {
  it('puts only a conversation waiting for a person first', () => {
    for (const state of BUSINESS_CONVERSATION_STATES) {
      expect(businessInboxPriority(state), state).toBe(state === 'HANDOFF_REQUIRED' ? 1 : 0);
    }
  });
});

describe('the breaker as the operator reads it', () => {
  const now = at('2026-10-05T12:00:00Z');
  it('is CLOSED with no trip, OPEN until the instant, HALF_OPEN from it on', () => {
    expect(supportAiBreakerState(null, now)).toBe('CLOSED');
    expect(supportAiBreakerState(at('2026-10-05T12:00:01Z'), now)).toBe('OPEN');
    expect(supportAiBreakerState(at('2026-10-05T12:00:00Z'), now)).toBe('HALF_OPEN');
    expect(supportAiBreakerState(at('2026-10-05T11:00:00Z'), now)).toBe('HALF_OPEN');
  });
});

describe('the automatic outcome classes', () => {
  it('classifies every outcome: sent, every guard and handoff as HANDED_OFF, every drop as DROPPED', () => {
    for (const outcome of SUPPORT_AI_AUTO_OUTCOMES) {
      const expected =
        outcome === 'sent'
          ? 'SENT'
          : outcome.startsWith('dropped_')
            ? 'DROPPED'
            : outcome.startsWith('guard_') || outcome.startsWith('handoff_')
              ? 'HANDED_OFF'
              : 'UNCLASSIFIED';
      expect(supportAutoOutcomeClass(outcome), outcome).toBe(expected);
    }
  });
});

describe('the analytics query', () => {
  it('is the reports’ range: a preset alone, or CUSTOM with both dates', () => {
    expect(supportAnalyticsQuerySchema.safeParse({ range: 'LAST_7_DAYS' }).success).toBe(true);
    expect(
      supportAnalyticsQuerySchema.safeParse({ range: 'LAST_7_DAYS', from: '1405-07-01' }).success,
    ).toBe(false);
    expect(supportAnalyticsQuerySchema.safeParse({ range: 'CUSTOM' }).success).toBe(false);
    expect(supportAnalyticsQuerySchema.safeParse({ range: 'ALL_TIME' }).success).toBe(false);
  });
});

describe('assembling the analytics', () => {
  const window = { start: at('2026-09-28T20:30:00Z'), end: at('2026-10-05T20:30:00Z') };
  const empty: SupportAnalyticsFacts = {
    conversations: [],
    handoffs: [],
    jobs: [],
    runs: [],
    candidates: [],
    articles: [],
  };

  it('states the half-open window it was counted in', () => {
    expect(assembleSupportAnalytics('LAST_7_DAYS', window, empty).period).toEqual({
      range: 'LAST_7_DAYS',
      start: '2026-09-28T20:30:00.000Z',
      end: '2026-10-05T20:30:00.000Z',
    });
  });

  it('shows every conversation and learning state, zero when no row has it', () => {
    const result = assembleSupportAnalytics('TODAY', window, {
      ...empty,
      conversations: [{ state: 'HANDOFF_REQUIRED', count: 2 }],
      candidates: [{ state: 'APPROVED', count: 1 }],
    });
    expect(result.conversationsNow).toEqual([
      { state: 'AI_ACTIVE', count: 0 },
      { state: 'HUMAN_ACTIVE', count: 0 },
      { state: 'HANDOFF_REQUIRED', count: 2 },
      { state: 'PAUSED', count: 0 },
    ]);
    expect(result.learningByState).toEqual([
      { state: 'PENDING', count: 0 },
      { state: 'APPROVED', count: 1 },
      { state: 'REJECTED', count: 0 },
    ]);
  });

  it('counts an AUTO job with no outcome as pending — never as sent — and classes the rest', () => {
    const result = assembleSupportAnalytics('TODAY', window, {
      ...empty,
      jobs: [
        { kind: 'AUTO_DECISION', state: 'QUEUED', outcome: null, count: 3 },
        { kind: 'AUTO_DECISION', state: 'SENT', outcome: 'sent', count: 5 },
        { kind: 'AUTO_DECISION', state: 'DISCARDED', outcome: 'guard_confidence', count: 2 },
        { kind: 'AUTO_DECISION', state: 'FAILED', outcome: 'handoff_ai_unavailable', count: 1 },
        { kind: 'AUTO_DECISION', state: 'DISCARDED', outcome: 'dropped_epoch', count: 4 },
      ],
    });
    expect(result.auto).toMatchObject({ sent: 5, handedOff: 3, dropped: 4, pending: 3 });
    expect(result.auto.byOutcome).toEqual([
      { outcome: 'sent', count: 5 },
      { outcome: 'dropped_epoch', count: 4 },
      { outcome: 'guard_confidence', count: 2 },
      { outcome: 'handoff_ai_unavailable', count: 1 },
    ]);
    // An automatic job is never an Assist draft.
    expect(result.assist.requested).toBe(0);
  });

  it('counts every Assist draft as requested, and each by the state it is in now', () => {
    const result = assembleSupportAnalytics('TODAY', window, {
      ...empty,
      jobs: [
        { kind: 'ASSIST_DRAFT', state: 'SENT', outcome: null, count: 6 },
        { kind: 'ASSIST_DRAFT', state: 'DISCARDED', outcome: null, count: 2 },
        { kind: 'ASSIST_DRAFT', state: 'FAILED', outcome: null, count: 1 },
        { kind: 'ASSIST_DRAFT', state: 'READY', outcome: null, count: 3 },
        { kind: 'ASSIST_DRAFT', state: 'QUEUED', outcome: null, count: 1 },
      ],
    });
    expect(result.assist).toEqual({ requested: 13, sent: 6, discarded: 2, failed: 1, open: 4 });
    expect(result.auto).toMatchObject({ sent: 0, handedOff: 0, dropped: 0, pending: 0 });
  });

  it('lists handoffs most frequent first and omits a reason with none', () => {
    const result = assembleSupportAnalytics('TODAY', window, {
      ...empty,
      handoffs: [
        { reason: 'LOW_CONFIDENCE', count: 1 },
        { reason: 'HANDOFF_TOPIC', count: 4 },
        { reason: 'AI_UNAVAILABLE', count: 0 },
      ],
    });
    expect(result.handoffsByReason).toEqual([
      { reason: 'HANDOFF_TOPIC', count: 4 },
      { reason: 'LOW_CONFIDENCE', count: 1 },
    ]);
  });
});

describe('the support notifications', () => {
  const event = (code: string, severity = 'WARN', recoversCode: string | null = null) => ({
    code,
    severity,
    recoversCode,
  });

  it('routes a handoff and an unusable connection to SUPPORT, a key and the chain to SUPPORT_AI', () => {
    expect(notificationRuleFor('support.handoff_required')?.category).toBe('SUPPORT');
    expect(notificationRuleFor('support.business_connection.unusable')?.category).toBe('SUPPORT');
    expect(notificationRuleFor('support.ai_provider.credential_rejected')?.category).toBe(
      'SUPPORT_AI',
    );
    expect(notificationRuleFor('support.ai_provider.unavailable')?.category).toBe('SUPPORT_AI');
    expect(NOTIFICATION_CATEGORY_PERMISSIONS.SUPPORT).toBe('business_chats.view');
    expect(NOTIFICATION_CATEGORY_PERMISSIONS.SUPPORT_AI).toBe('support_ai.configure');
  });

  it('never admits a support recovery, nor a support code nobody decided belongs here', () => {
    for (const code of [
      'support.handoff_resolved',
      'support.business_connection.usable',
      'support.ai_provider.credential_accepted',
      'support.ai_provider.available',
      'support.something_new',
    ]) {
      expect(notificationRuleFor(code), code).toBeNull();
    }
    expect(
      isNotification(event('support.handoff_required', 'INFO', 'support.handoff_required')),
    ).toBe(false);
    expect(isNotification(event('support.handoff_required'))).toBe(true);
    // Below the rule's severity, a support code is no notification.
    expect(isNotification(event('support.ai_provider.unavailable', 'INFO'))).toBe(false);
  });

  it('links a handoff to its conversation, and only by a UUID', () => {
    const id = '019210ab-cdef-7012-8345-6789abcdef01';
    expect(linkFor('support.handoff_required', { conversationId: id })).toEqual({
      target: 'BUSINESS_CHAT',
      id,
    });
    expect(linkFor('support.handoff_required', { conversationId: 'not-a-uuid' })).toEqual({
      target: 'BUSINESS_CHATS',
      id: null,
    });
    expect(linkFor('support.business_connection.unusable', { connectionRowId: id })).toEqual({
      target: 'BUSINESS_CHATS',
      id: null,
    });
    expect(linkFor('support.ai_provider.credential_rejected', null)).toEqual({
      target: 'SUPPORT_AI',
      id: null,
    });
  });

  it('shows support the conversations and the owner the provider alerts too', () => {
    const role = (key: string) => ROLE_SEEDS.find((seed) => seed.key === key)?.permissions ?? [];
    expect(visibleNotificationCategories(role('support'))).toContain('SUPPORT');
    expect(visibleNotificationCategories(role('support'))).not.toContain('SUPPORT_AI');
    expect(visibleNotificationCategories(role('owner'))).toEqual(
      expect.arrayContaining(['SUPPORT', 'SUPPORT_AI']),
    );
    expect(visibleNotificationCategories(role('finance'))).not.toContain('SUPPORT');
  });
});

/*
 * PR #205 review, N5: the provider-run statement sorts every run in the window for its
 * percentiles. A CUSTOM window is capped at the longest preset's span (a leap year), not the
 * reports' 731 days, and the cap is decided before anything is read.
 */
describe('the support analytics’ CUSTOM window', () => {
  const DAY = 86_400_000;
  const nothing: SupportAnalyticsFacts = {
    conversations: [],
    handoffs: [],
    jobs: [],
    runs: [],
    candidates: [],
    articles: [],
  };
  const serviceFor = (days: number, extraMs = 0) => {
    const start = new Date('2025-01-01T00:00:00.000Z');
    const end = new Date(start.getTime() + days * DAY + extraMs);
    const read = vi.fn(async () => nothing);
    const service = new SupportAnalyticsService({
      guard: { check: async () => undefined },
      reader: { read },
      windows: { resolve: async () => ({ start, end }) },
    });
    return { service, read };
  };
  const custom = { range: 'CUSTOM' as const, from: '2025-01-01', to: '2026-01-01' };

  it('is capped at a leap year — a longer one is refused before anything is read', async () => {
    expect(SUPPORT_ANALYTICS_CUSTOM_MAX_DAYS).toBe(366);
    // 366 local days, an hour longer across a DST change: read.
    const ok = serviceFor(366, 3_600_000);
    await ok.service.analytics({} as never, {} as never, custom);
    expect(ok.read).toHaveBeenCalledTimes(1);
    // 367 days: refused as a validation error, and nothing is read.
    const long = serviceFor(367);
    await expect(long.service.analytics({} as never, {} as never, custom)).rejects.toMatchObject({
      kind: 'VALIDATION',
    });
    expect(long.read).not.toHaveBeenCalled();
    // A preset is never refused by it (THIS_YEAR is at most a leap year).
    const year = serviceFor(366);
    await year.service.analytics({} as never, {} as never, { range: 'THIS_YEAR' });
    expect(year.read).toHaveBeenCalledTimes(1);
  });
});
