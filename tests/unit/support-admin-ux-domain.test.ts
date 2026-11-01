import { describe, expect, it } from 'vitest';
import {
  SUPPORT_READINESS_CHECKS,
  supportReadinessResponseSchema,
  supportTestConsoleRequestSchema,
  type SupportAiConfigResponse,
} from '@nexa/contracts';
import {
  normalizeHandle,
  supportReadiness,
  type SupportReadinessFacts,
} from '../../apps/api/src/modules/control/support-ai/domain/support-readiness';
import {
  clusterKnowledgeGaps,
  normalizeIntent,
  type GapRow,
} from '../../apps/api/src/modules/control/support-ai/domain/support-gaps';

/**
 * Phase 4 PR-5 — the readiness card's rules and the knowledge-gaps clustering, pure.
 */

const credential = (
  over: Partial<SupportAiConfigResponse['credentials'][number]> = {},
): SupportAiConfigResponse['credentials'][number] => ({
  provider: 'OPENAI',
  configured: true,
  setAt: '2026-11-01T00:00:00.000Z',
  region: null,
  trippedUntil: null,
  lastTestOutcome: 'OK',
  lastTestFailureClass: null,
  lastTestedAt: '2026-11-01T00:00:00.000Z',
  breaker: 'CLOSED',
  consecutiveFailures: 0,
  rejectedAt: null,
  ...over,
});

function facts(over: Partial<SupportReadinessFacts> = {}): SupportReadinessFacts {
  return {
    config: {
      mode: 'AUTO_REPLY_SAFE',
      primary: { provider: 'OPENAI', model: 'gpt-5.5' },
      autoTopics: ['PLAN_INFO'] as never,
      visionEnabled: false,
    },
    credentials: [credential()],
    capabilities: {
      OPENAI: { structuredOutput: true, vision: true },
      ANTHROPIC: { structuredOutput: true, vision: true },
      ZAI: { structuredOutput: true, vision: false },
    },
    connections: [{ status: 'ACTIVE' }],
    supportHandles: ['@MyShop'],
    connectedUsernames: ['myshop'],
    assistant: {
      startedAt: new Date('2026-11-01T10:00:00Z'),
      stableAt: new Date('2026-11-01T10:01:00Z'),
      stoppedAt: null,
      restarts: 0,
    },
    assistantStalled: false,
    approvedKnowledge: 12,
    ...over,
  };
}

const lineOf = (f: SupportReadinessFacts, check: (typeof SUPPORT_READINESS_CHECKS)[number]) => {
  const response = supportReadiness(f);
  expect(supportReadinessResponseSchema.safeParse(response).success).toBe(true);
  return response.checks.find((line) => line.check === check)!;
};

describe('support readiness card', () => {
  it('has one line per check, in the card order, all OK when everything is in place', () => {
    const response = supportReadiness(facts());
    expect(response.checks.map((line) => line.check)).toEqual([...SUPPORT_READINESS_CHECKS]);
    expect(response.checks.every((line) => line.status === 'OK')).toBe(true);
  });

  it('BUSINESS_CONNECTION: none, disabled, no reply right, superseded ignored', () => {
    expect(lineOf(facts({ connections: [] }), 'BUSINESS_CONNECTION').detail).toBe('NO_CONNECTION');
    expect(
      lineOf(facts({ connections: [{ status: 'SUPERSEDED' }] }), 'BUSINESS_CONNECTION').detail,
    ).toBe('NO_CONNECTION');
    expect(
      lineOf(facts({ connections: [{ status: 'DISABLED' }] }), 'BUSINESS_CONNECTION').detail,
    ).toBe('CONNECTION_DISABLED');
    expect(
      lineOf(facts({ connections: [{ status: 'RIGHTS_INSUFFICIENT' }] }), 'BUSINESS_CONNECTION')
        .detail,
    ).toBe('CANNOT_REPLY');
  });

  it('SUPPORT_HANDLE: matches case- and @-insensitively; missing, mismatch, unverified are warnings', () => {
    expect(normalizeHandle(' @MyShop ')).toBe('myshop');
    expect(lineOf(facts(), 'SUPPORT_HANDLE')).toMatchObject({
      status: 'OK',
      detail: 'HANDLE_MATCHES',
    });
    expect(lineOf(facts({ supportHandles: [] }), 'SUPPORT_HANDLE').detail).toBe('HANDLE_MISSING');
    expect(lineOf(facts({ supportHandles: ['@other'] }), 'SUPPORT_HANDLE')).toMatchObject({
      status: 'WARN',
      detail: 'HANDLE_MISMATCH',
      handles: ['@other'],
    });
    expect(lineOf(facts({ connectedUsernames: [] }), 'SUPPORT_HANDLE').detail).toBe(
      'HANDLE_UNVERIFIED',
    );
  });

  it('PROVIDER_KEY and STRUCTURED_OUTPUT follow the primary step and its last capability test', () => {
    expect(
      lineOf(facts({ config: { ...facts().config, primary: null } }), 'PROVIDER_KEY').detail,
    ).toBe('NO_PRIMARY');
    expect(lineOf(facts({ credentials: [] }), 'PROVIDER_KEY').detail).toBe('NO_KEY');
    expect(
      lineOf(
        facts({ credentials: [credential({ rejectedAt: '2026-11-01T00:00:00.000Z' })] }),
        'PROVIDER_KEY',
      ).detail,
    ).toBe('KEY_REJECTED');
    expect(
      lineOf(facts({ credentials: [credential({ breaker: 'OPEN' })] }), 'PROVIDER_KEY').detail,
    ).toBe('BREAKER_OPEN');
    expect(
      lineOf(facts({ credentials: [credential({ lastTestOutcome: null })] }), 'STRUCTURED_OUTPUT')
        .detail,
    ).toBe('NOT_TESTED');
    expect(
      lineOf(
        facts({ credentials: [credential({ lastTestOutcome: 'INVALID_OUTPUT' })] }),
        'STRUCTURED_OUTPUT',
      ).detail,
    ).toBe('TEST_FAILED');
    expect(
      lineOf(
        facts({
          capabilities: {
            ...facts().capabilities,
            OPENAI: { structuredOutput: false, vision: false },
          },
        }),
        'STRUCTURED_OUTPUT',
      ).detail,
    ).toBe('UNSUPPORTED');
  });

  it('ASSISTANT_ROLE: never started, stopped, restarting, stalled, running', () => {
    const at = (iso: string) => new Date(iso);
    expect(lineOf(facts({ assistant: null }), 'ASSISTANT_ROLE').detail).toBe('NEVER_STARTED');
    expect(
      lineOf(
        facts({
          assistant: {
            startedAt: at('2026-11-01T10:00:00Z'),
            stableAt: at('2026-11-01T10:01:00Z'),
            stoppedAt: at('2026-11-01T11:00:00Z'),
            restarts: 0,
          },
        }),
        'ASSISTANT_ROLE',
      ).detail,
    ).toBe('STOPPED');
    // A stop BEFORE the latest start is a previous life.
    expect(
      lineOf(
        facts({
          assistant: {
            startedAt: at('2026-11-01T12:00:00Z'),
            stableAt: at('2026-11-01T12:01:00Z'),
            stoppedAt: at('2026-11-01T11:00:00Z'),
            restarts: 0,
          },
        }),
        'ASSISTANT_ROLE',
      ).detail,
    ).toBe('RUNNING');
    expect(
      lineOf(
        facts({
          assistant: {
            startedAt: at('2026-11-01T10:00:00Z'),
            stableAt: null,
            stoppedAt: null,
            restarts: 3,
          },
        }),
        'ASSISTANT_ROLE',
      ).detail,
    ).toBe('RESTARTING');
    expect(lineOf(facts({ assistantStalled: true }), 'ASSISTANT_ROLE').detail).toBe('STALLED');
  });

  it('TOPICS, KNOWLEDGE and VISION', () => {
    expect(
      lineOf(facts({ config: { ...facts().config, autoTopics: [] } }), 'TOPICS'),
    ).toMatchObject({
      status: 'WARN',
      detail: 'NO_TOPICS',
    });
    expect(lineOf(facts(), 'TOPICS').count).toBe(1);
    expect(lineOf(facts({ approvedKnowledge: 0 }), 'KNOWLEDGE').detail).toBe('NO_KNOWLEDGE');
    expect(lineOf(facts(), 'KNOWLEDGE').count).toBe(12);
    expect(lineOf(facts(), 'VISION').detail).toBe('VISION_OFF');
    expect(
      lineOf(facts({ config: { ...facts().config, visionEnabled: true } }), 'VISION').detail,
    ).toBe('VISION_ON');
    expect(
      lineOf(
        facts({
          config: {
            ...facts().config,
            visionEnabled: true,
            primary: { provider: 'ZAI', model: 'glm-4.6' },
          },
          credentials: [credential({ provider: 'ZAI' })],
        }),
        'VISION',
      ),
    ).toMatchObject({ status: 'WARN', detail: 'VISION_UNSUPPORTED' });
  });
});

describe('knowledge gaps clustering', () => {
  const row = (over: Partial<GapRow> = {}): GapRow => ({
    topic: 'PLAN_INFO' as never,
    intent: 'قیمت اشتراک سه ماهه',
    reason: 'INSUFFICIENT_GROUNDING',
    question: 'سه ماهه چنده؟',
    ...over,
  });

  it('normalises the model label so punctuation and spacing do not split a gap', () => {
    expect(normalizeIntent('  قیمت،  اشتراک! ')).toBe('قیمت اشتراک');
    expect(normalizeIntent(null)).toBe('');
  });

  it('groups by topic and label, biggest first, with distinct examples and reasons', () => {
    const { gaps } = clusterKnowledgeGaps([
      row(),
      row({ question: 'قیمت سه ماه؟', intent: 'قیمت اشتراک سه ماهه!' }),
      row({ question: 'سه ماهه چنده؟', reason: 'LOW_CONFIDENCE' }),
      row({ topic: 'RENEWAL_INFO' as never, intent: 'تمدید', question: 'چطور تمدید کنم' }),
    ]);
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toMatchObject({ topic: 'PLAN_INFO', count: 3 });
    expect(gaps[0]!.examples).toEqual(['سه ماهه چنده؟', 'قیمت سه ماه؟']);
    expect(gaps[0]!.reasons).toEqual(['INSUFFICIENT_GROUNDING', 'LOW_CONFIDENCE']);
    expect(gaps[1]).toMatchObject({ topic: 'RENEWAL_INFO', count: 1 });
  });

  it('a purged label and question still count (by topic alone) and cap the examples', () => {
    const { gaps } = clusterKnowledgeGaps([
      row({ intent: null, question: null }),
      row({ intent: null, question: null }),
      ...[1, 2, 3, 4, 5].map((n) => row({ intent: null, question: `q${n}` })),
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ count: 7, intent: null });
    expect(gaps[0]!.examples).toHaveLength(3);
  });
});

describe('test console request', () => {
  it('needs a trimmed question and defaults to no customer', () => {
    expect(
      supportTestConsoleRequestSchema.parse({ idempotencyKey: 'abcdefgh', question: '  سلام ' }),
    ).toEqual({ idempotencyKey: 'abcdefgh', question: 'سلام', customerId: null });
    expect(
      supportTestConsoleRequestSchema.safeParse({ idempotencyKey: 'abcdefgh', question: '  ' })
        .success,
    ).toBe(false);
  });
});
