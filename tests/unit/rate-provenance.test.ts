import { describe, expect, it } from 'vitest';
import { gatewayRateProvenanceOf, gatewayRateProvenanceSchema } from '@nexa/contracts';

/**
 * Roadmap E5 — where an attempt's conversion rate came from (`gatewayRateProvenanceOf`).
 *
 * What this file defends: one shape for every policy; a market rate carries its whole
 * evidence (source, book time, fetch time, state, id, policy version); an operator rate is
 * the frozen fixed rate and nothing about a market; a same-unit attempt claims no rate; and
 * a policy whose snapshot is missing reports NO rate rather than borrowing another policy's.
 */

const createdAt = new Date('2026-10-07T10:00:00.000Z');

describe('the rate provenance', () => {
  it('names the market quote with its whole evidence for a central-rate attempt', () => {
    const provenance = gatewayRateProvenanceOf({
      policy: 'CENTRAL_FX',
      fixedRateMinor: 1300n,
      fx: {
        source: 'NOBITEX',
        quoteId: 'v1:NOBITEX:USDTIRT:103500e-0:-:1700000000000',
        policyVersion: 1,
        sourceAt: new Date('2026-10-07T09:59:58.000Z'),
        fetchedAt: new Date('2026-10-07T09:59:59.000Z'),
        quoteState: 'STALE_ALLOWED',
        effectiveRateText: '1035.0000',
      },
      createdAt,
    });
    expect(gatewayRateProvenanceSchema.parse(provenance)).toEqual({
      authority: 'MARKET',
      policy: 'CENTRAL_FX',
      rate: '1035.0000',
      source: 'NOBITEX',
      quoteId: 'v1:NOBITEX:USDTIRT:103500e-0:-:1700000000000',
      policyVersion: 1,
      quotedAt: '2026-10-07T09:59:58.000Z',
      fetchedAt: '2026-10-07T09:59:59.000Z',
      quoteState: 'STALE_ALLOWED',
      frozenAt: '2026-10-07T10:00:00.000Z',
    });
  });

  it('names the operator’s frozen fixed rate, and nothing about a market', () => {
    const provenance = gatewayRateProvenanceOf({
      policy: 'FIXED_RATE',
      fixedRateMinor: 1300n,
      fx: null,
      createdAt,
    });
    expect(provenance).toMatchObject({
      authority: 'OPERATOR',
      rate: '1300',
      source: null,
      quoteId: null,
      quoteState: null,
    });
  });

  it('claims no rate for a same-unit attempt', () => {
    expect(
      gatewayRateProvenanceOf({ policy: 'SAME_UNIT', fixedRateMinor: null, fx: null, createdAt }),
    ).toMatchObject({ authority: 'NONE', rate: null });
  });

  it('fails closed: a central-rate attempt with no snapshot reports no rate, never the fixed one', () => {
    const provenance = gatewayRateProvenanceOf({
      policy: 'CENTRAL_FX',
      fixedRateMinor: 1300n,
      fx: null,
      createdAt,
    });
    expect(provenance.authority).toBe('MARKET');
    expect(provenance.rate).toBeNull();
  });
});
