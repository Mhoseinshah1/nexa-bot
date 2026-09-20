import { describe, expect, it } from 'vitest';
import { providerUsernameFor } from '@nexa/contracts';
import { providerRefFor } from '../../apps/api/src/modules/commerce/provisioning/application/provision-executor';

/**
 * What this installation tells a provider a service is called.
 *
 * One rule, and it is the rule `docs/phase6c-audit.md` A-4 was written about: the ref
 * READS the stored name. It used to recompute it from the service id while
 * `services.provider_username` sat beside it unread, and the two agreed only because
 * generation happened to be deterministic.
 *
 * That identity is exactly what the username policy removes. This file exists so the
 * divergence is caught here rather than by a customer holding a subscription link for an
 * account created under a different name.
 */
describe('the name a provider is asked for', () => {
  it('is the one stored on the service, not one recomputed from its id', () => {
    /*
     * The mutation target. Restoring `providerUsernameFor(service.id)` makes this fail
     * with the derived `nx…` name — which is the exact silent divergence a CUSTOM or
     * template-rendered username would have produced in production.
     */
    const ref = providerRefFor({
      providerUsername: 'ali_2024',
      subscriptionRef: 'a'.repeat(32),
      providerClientId: '0192ab34-cd56-7890-1234-5678901234ef',
    });
    expect(ref.username).toBe('ali_2024');
  });

  it('passes a legacy derived name through unchanged', () => {
    // A service sold before this phase carries a 34-character derived name. Reading the
    // column rather than recomputing must not disturb it — every existing service keeps
    // the name its provider account already has.
    const derived = providerUsernameFor('0192ab34-cd56-7890-1234-5678901234ef');
    const ref = providerRefFor({
      providerUsername: derived,
      subscriptionRef: 'b'.repeat(32),
      providerClientId: '0192ab34-cd56-7890-1234-5678901234ef',
    });
    expect(ref.username).toBe(derived);
    expect(ref.username).toBe('nx0192ab34cd56789012345678901234ef');
  });

  it('carries the two capabilities from the row, as it always did', () => {
    // Asserted beside the username so a change that "simplified" the ref by deriving
    // things again has to break this too.
    const ref = providerRefFor({
      providerUsername: 'ali_2024',
      subscriptionRef: 'c'.repeat(32),
      providerClientId: 'client-id-value',
    });
    expect(ref.subscriptionRef).toBe('c'.repeat(32));
    expect(ref.clientId).toBe('client-id-value');
  });

  it('does not accept a service id at all any more', () => {
    /*
     * A type-level rule, asserted at runtime because a cast can defeat the compiler.
     * `providerRefFor` takes `providerUsername`; a caller passing the old shape gets
     * `undefined` rather than a quietly derived name, which is loud at the boundary
     * instead of silent on a panel.
     */
    const ref = providerRefFor({
      id: '0192ab34-cd56-7890-1234-5678901234ef',
      subscriptionRef: 'd'.repeat(32),
      providerClientId: 'client',
    } as unknown as Parameters<typeof providerRefFor>[0]);
    expect(ref.username).toBeUndefined();
  });
});
