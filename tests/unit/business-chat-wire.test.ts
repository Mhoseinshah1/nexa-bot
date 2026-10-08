import { describe, expect, it } from 'vitest';
import {
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
