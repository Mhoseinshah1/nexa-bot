import { describe, expect, it } from 'vitest';
import {
  GATEWAY_CLAIM_LEASE_MS,
  GATEWAY_LEASE_MARGIN_MS,
  GATEWAY_ROW_BOUND_MS,
  gatewayClaimLeaseMs,
  GATEWAY_ROW_FAILURE_RETRY_MAX_MS,
  GATEWAY_ROW_FAILURE_RETRY_MIN_MS,
  errorFacts,
  rowFailureRetryAt,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';

/**
 * FIX10 BUG-1: the two pure pieces of the gateway lane's per-row isolation — how far a row
 * that threw is pushed back, and what a log line may say about the exception.
 */
describe('a gateway row that threw', () => {
  const now = new Date('2026-10-10T10:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const delay = (since: Date | null) => rowFailureRetryAt(now, since).getTime() - now.getTime();

  it('is retried no sooner than the floor, half the time since its last progress, and no later than the cap', () => {
    expect(delay(null)).toBe(GATEWAY_ROW_FAILURE_RETRY_MIN_MS);
    expect(delay(now)).toBe(GATEWAY_ROW_FAILURE_RETRY_MIN_MS);
    // A clock that moved backwards is not a negative delay.
    expect(delay(new Date(now.getTime() + 60_000))).toBe(GATEWAY_ROW_FAILURE_RETRY_MIN_MS);
    expect(delay(ago(4 * 60_000))).toBe(2 * 60_000);
    expect(delay(ago(60 * 60_000))).toBe(GATEWAY_ROW_FAILURE_RETRY_MAX_MS);
    // Always strictly in the future, so the row leaves the head of the queue.
    expect(GATEWAY_ROW_FAILURE_RETRY_MIN_MS).toBeGreaterThan(0);
  });

  it('is logged by class and machine code only — never by message, detail or a wrapped message', () => {
    const pg = Object.assign(new Error('duplicate key value (provider_charge_id)=(REF-1)'), {
      code: '23505',
      detail: 'Key (provider_charge_id)=(REF-1) already exists.',
    });
    expect(errorFacts(pg)).toEqual({ error: 'Error', code: '23505' });
    const wrapped = new Error('Failed query: update ... params: REF-1', { cause: pg });
    expect(errorFacts(wrapped)).toEqual({ error: 'Error', code: '23505' });
    // A "code" that is free text is not a code.
    expect(
      errorFacts(Object.assign(new Error('x'), { code: 'key tp_live_secret leaked' })),
    ).toEqual({ error: 'Error', code: null });
    expect(errorFacts('a string')).toEqual({ error: 'unknown', code: null });
    expect(JSON.stringify(errorFacts(wrapped))).not.toContain('REF-1');
  });
});

/** FIX10 R1: a claim's lease always covers one whole row, with a margin, whatever the bound. */
describe('the gateway claim lease', () => {
  it('is never shorter than the row bound plus the margin, nor than the base lease', () => {
    expect(gatewayClaimLeaseMs(GATEWAY_ROW_BOUND_MS)).toBeGreaterThanOrEqual(
      GATEWAY_ROW_BOUND_MS + GATEWAY_LEASE_MARGIN_MS,
    );
    expect(gatewayClaimLeaseMs(1_000)).toBe(GATEWAY_CLAIM_LEASE_MS);
    // An operator who raises the Telegram timeout to its maximum still gets a lease that covers a row.
    const slow = 15_000 + 3 * 120_000;
    expect(gatewayClaimLeaseMs(slow)).toBe(slow + GATEWAY_LEASE_MARGIN_MS);
  });
});
