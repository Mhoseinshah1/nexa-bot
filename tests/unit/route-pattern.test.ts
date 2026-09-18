import { describe, expect, it } from 'vitest';
import {
  PAYMENT_ACCOUNT_ROUTES,
  PAYMENT_GATEWAY_ROUTES,
  REFUND_ROUTES,
  routePattern,
} from '@nexa/contracts';

/**
 * `routePattern`, on its own.
 *
 * This is the SMALL half of the proof and it is stated plainly: the defect it addresses
 * lived in Nest's route table, so `route-registration.test.ts` — which boots the real
 * application — is what actually guards against it. What is worth checking here is the
 * helper's own contract, which that test cannot isolate: the exact patterns it derives,
 * and that it refuses rather than guesses when a builder does not cooperate.
 */

describe('routePattern', () => {
  it('derives the Nest pattern for every route that was broken', () => {
    expect(routePattern(PAYMENT_GATEWAY_ROUTES.update, 'provider')).toBe(
      '/payment-gateways/:provider',
    );
    expect(routePattern(PAYMENT_GATEWAY_ROUTES.status, 'provider')).toBe(
      '/payment-gateways/:provider/status',
    );
    expect(routePattern(PAYMENT_ACCOUNT_ROUTES.update, 'id')).toBe('/payment-accounts/:id');
    expect(routePattern(PAYMENT_ACCOUNT_ROUTES.enabled, 'id')).toBe(
      '/payment-accounts/:id/enabled',
    );
    expect(routePattern(PAYMENT_ACCOUNT_ROUTES.makeDefault, 'id')).toBe(
      '/payment-accounts/:id/default',
    );
    expect(routePattern(REFUND_ROUTES.list, 'paymentId')).toBe('/payments/:paymentId/refunds');
    expect(routePattern(REFUND_ROUTES.request, 'paymentId')).toBe('/payments/:paymentId/refunds');
    expect(routePattern(REFUND_ROUTES.complete, 'refundId')).toBe('/refunds/:refundId/completion');
    expect(routePattern(REFUND_ROUTES.fail, 'refundId')).toBe('/refunds/:refundId/failure');
  });

  it('never leaves a percent-encoded colon in a pattern', () => {
    /*
     * The literal signature of the bug. `%3A` in a registered path is a path SEGMENT
     * that no real request contains, which is how nine routes came to exist and match
     * nothing.
     */
    for (const pattern of [
      routePattern(PAYMENT_GATEWAY_ROUTES.update, 'provider'),
      routePattern(PAYMENT_ACCOUNT_ROUTES.enabled, 'id'),
      routePattern(REFUND_ROUTES.complete, 'refundId'),
    ]) {
      expect(pattern).not.toContain('%3A');
      expect(pattern).not.toContain('%3a');
    }
  });

  it('leaves the client builders encoding real values', () => {
    // The fix must not have touched this. A provider name or id with a slash or a
    // space still has to survive being put in a path.
    expect(PAYMENT_ACCOUNT_ROUTES.update('a b/c')).toBe('/payment-accounts/a%20b%2Fc');
    expect(PAYMENT_GATEWAY_ROUTES.status('MANUAL_TRANSFER')).toBe(
      '/payment-gateways/MANUAL_TRANSFER/status',
    );
  });

  it('throws when a builder does not pass its argument through verbatim', () => {
    /*
     * Fails LOUDLY, and at module load, because a decorator runs then: the process
     * refuses to start rather than starting with a route that is quietly not there.
     * That is the whole difference between this bug being a boot failure and being a
     * staging incident.
     */
    expect(() => routePattern((value) => `/x/${value.toUpperCase()}`, 'id')).toThrow(
      /did not pass its argument through verbatim/u,
    );
    expect(() => routePattern(() => '/x/fixed', 'id')).toThrow(/verbatim/u);
  });
});
