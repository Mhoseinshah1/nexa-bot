import { describe, expect, it } from 'vitest';
import {
  BUSINESS_HANDOFF_REASONS,
  BUSINESS_HANDOFF_WIRE_REASONS,
  SUPPORT_AI_AUTO_OUTCOMES,
  SUPPORT_AI_AUTO_WIRE_OUTCOMES,
  businessHandoffReasonOf,
  businessHandoffWireReason,
  supportAutoOutcomeCountsOf,
  supportAutoWireOutcome,
  supportHandoffCountsOf,
  BUSINESS_OUTBOUND_ORIGINS,
  BUSINESS_OUTBOUND_STATES,
  businessChatDetailResponseSchema,
  businessOutboundOriginOf,
  businessOutboundView,
} from '@nexa/contracts';
import {
  frozenPreA4DetailOutbound,
  frozenPreA4OutboundView,
} from '../support/frozen-business-chat-outbound';
import {
  MAIN_AUTO_OUTCOMES,
  MAIN_HANDOFF_REASONS,
  frozenPreA3Analytics,
} from '../support/frozen-pre-a3-schemas';
import { assembleSupportAnalytics } from '../../apps/api/src/modules/control/support-ai/domain/support-analytics';

/**
 * Review of PR #248, CX1 — a rolling deploy serves the business-chat detail from a new replica to
 * a Web Admin bundle built before roadmap A4, whose outbound view is frozen in
 * `tests/support/frozen-business-chat-outbound.ts`. One row it cannot parse fails the whole
 * conversation detail, so the server's projection must stay inside it.
 */
const PRE_A4_OUTBOUND_VIEW = frozenPreA4OutboundView;
const PRE_A4_DETAIL_OUTBOUND = frozenPreA4DetailOutbound;

const AT = new Date('2026-10-08T10:00:00.000Z');
const row = (origin: (typeof BUSINESS_OUTBOUND_ORIGINS)[number], i: number) => ({
  id: `00000000-0000-7000-8000-00000000000${String(i)}`,
  origin,
  state: 'DELIVERED' as const,
  body: origin === 'HANDOFF_NOTICE' ? null : 'متن',
  createdAt: AT,
  resolvedAt: AT,
  failureCode: null,
});

describe('CX1 — the outbound view a pre-A4 bundle reads during a rolling deploy', () => {
  const outbound = BUSINESS_OUTBOUND_ORIGINS.map((origin, i) =>
    businessOutboundView(row(origin, i)),
  );

  it('parses under the frozen pre-A4 schema for every lane origin, the handoff notice included', () => {
    const parsed = PRE_A4_DETAIL_OUTBOUND.safeParse(
      JSON.parse(JSON.stringify({ outbound })) as unknown,
    );
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    // The notice is shown to the old bundle as automatic, never as a person's message.
    const notice = outbound.find((view) => view.laneOrigin === 'HANDOFF_NOTICE');
    expect(notice?.origin).toBe('AUTO');
    // The pre-A4 bundle states the full set it accepts; the old enum is not widened by accident.
    expect(PRE_A4_OUTBOUND_VIEW.shape.state.options).toEqual([...BUSINESS_OUTBOUND_STATES]);
  });

  it('the new bundle reads the real origin back; an older replica that sends none still parses', () => {
    const detail = {
      conversation: {
        id: 'c',
        state: 'HANDOFF_REQUIRED',
        takeoverReason: null,
        handoffReason: 'LOOP_GUARD',
        peerTelegramUserId: '1',
        customer: null,
        connectionStatus: 'ACTIVE',
        lastMessageAt: null,
        lastInboundAt: null,
        preview: null,
        unansweredSince: null,
        ticketId: null,
        controlEpoch: 1,
        lastHumanAt: null,
      },
      messages: [],
      outbound: JSON.parse(JSON.stringify(outbound)) as unknown,
      escalations: [],
    };
    const parsed = businessChatDetailResponseSchema.parse(detail);
    expect(parsed.outbound.map(businessOutboundOriginOf)).toEqual([...BUSINESS_OUTBOUND_ORIGINS]);
    // An older replica: no `laneOrigin` at all.
    const older = businessChatDetailResponseSchema.parse({
      ...detail,
      outbound: outbound.map(({ laneOrigin: _dropped, ...rest }) => rest),
    });
    expect(older.outbound.map(businessOutboundOriginOf)).toEqual([
      'OPERATOR',
      'ASSIST',
      'AUTO',
      'AUTO',
    ]);
    // A newer replica's origin this bundle does not know reads as absent, never as a failure.
    const newer = businessChatDetailResponseSchema.parse({
      ...detail,
      outbound: [{ ...outbound[0], laneOrigin: 'SOMETHING_LATER' }],
    });
    expect(newer.outbound.map(businessOutboundOriginOf)).toEqual(['OPERATOR']);
  });
});

describe('the handoff-reason follow-up to CX1 — reasons and outcomes a pre-A3 bundle reads', () => {
  it('pins the wire sets to what main shipped, so neither can be widened by accident', () => {
    expect([...BUSINESS_HANDOFF_WIRE_REASONS]).toEqual([...MAIN_HANDOFF_REASONS]);
    expect([...SUPPORT_AI_AUTO_WIRE_OUTCOMES]).toEqual([...MAIN_AUTO_OUTCOMES]);
  });

  it('projects every reason into the old set: the three progress guards as LOOP_GUARD, the rest as they are', () => {
    for (const reason of BUSINESS_HANDOFF_REASONS) {
      const wire = businessHandoffWireReason(reason);
      expect((MAIN_HANDOFF_REASONS as readonly string[]).includes(wire), reason).toBe(true);
      expect(wire, reason).toBe(
        ['NO_PROGRESS', 'REPEATED_ADVICE', 'INBOUND_FLOOD'].includes(reason)
          ? 'LOOP_GUARD'
          : reason,
      );
      expect(businessHandoffReasonOf(wire, reason)).toBe(reason);
    }
    // An older replica sends no detail; a newer one may send one this bundle does not know.
    expect(businessHandoffReasonOf('LOOP_GUARD', undefined)).toBe('LOOP_GUARD');
    expect(businessHandoffReasonOf(null, null)).toBeNull();
  });

  it('projects every automatic outcome into the old set or leaves it out (no_action)', () => {
    for (const outcome of SUPPORT_AI_AUTO_OUTCOMES) {
      const wire = supportAutoWireOutcome(outcome);
      if (outcome === 'no_action') expect(wire).toBeNull();
      else
        expect((MAIN_AUTO_OUTCOMES as readonly string[]).includes(wire ?? ''), outcome).toBe(true);
    }
  });

  it('assembles analytics the pre-A3 bundle parses, with the true counts beside the folded ones', () => {
    const result = assembleSupportAnalytics(
      'TODAY',
      { start: AT, end: new Date(AT.getTime() + 86_400_000) },
      {
        conversations: [],
        handoffs: BUSINESS_HANDOFF_REASONS.map((reason) => ({ reason, count: 1 })),
        jobs: SUPPORT_AI_AUTO_OUTCOMES.map((outcome) => ({
          kind: 'AUTO_DECISION' as const,
          state: 'DISCARDED' as const,
          outcome,
          count: 1,
        })),
        runs: [],
        candidates: [],
        articles: [],
      },
    );
    const old = frozenPreA3Analytics.safeParse(JSON.parse(JSON.stringify(result)) as unknown);
    expect(old.success, JSON.stringify(old.error?.issues)).toBe(true);
    // Folded: LOOP_GUARD carries its own handoff and the three guards'; the sum is unchanged.
    expect(result.handoffsByReason.find((row) => row.reason === 'LOOP_GUARD')?.count).toBe(4);
    const sum = (rows: readonly { count: number }[]) => rows.reduce((n, row) => n + row.count, 0);
    expect(sum(result.handoffsByReason)).toBe(BUSINESS_HANDOFF_REASONS.length);
    expect(supportHandoffCountsOf(result)).toHaveLength(BUSINESS_HANDOFF_REASONS.length);
    expect(result.auto.byOutcome.find((row) => row.outcome === 'guard_consecutive')?.count).toBe(4);
    // no_action is left out of the folded list only; the detail and the totals keep it.
    expect(sum(result.auto.byOutcome)).toBe(SUPPORT_AI_AUTO_OUTCOMES.length - 1);
    expect(supportAutoOutcomeCountsOf(result)).toHaveLength(SUPPORT_AI_AUTO_OUTCOMES.length);
  });
});
