import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CreateProviderUserInput,
  ProviderServiceTarget,
  ProviderUserRef,
} from '@nexa/contracts';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { RickpanelAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel.adapter';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';

/**
 * Item C3 (`docs/c3-subscription-ref-rickpanel.md`): for RickPanel, `services.subscription_ref`
 * is a NEXA-LOCAL value. No adapter operation sends it, and the link a customer receives is
 * the one the panel's own record carries — never one built from the ref.
 *
 * That is the code-side half of "NEXA can assign a random local ref to an adopted account
 * without a provider write": if the ref never reaches the panel, a ref the panel never saw
 * cannot disagree with it. A real panel is not needed for this half — the adapter is ours —
 * and the provider-dependent half is listed in the document as manual acceptance.
 */

const REF_A = 'a'.repeat(8) + '0123456789abcdef' + 'b'.repeat(8);
const REF_B = 'c'.repeat(8) + 'fedcba9876543210' + 'd'.repeat(8);

let panel: FakeRickpanel;
let target: ProviderServiceTarget;
const adapter = new RickpanelAdapter({
  readBackAttempts: 1,
  readBackDelayMs: 0,
  sleep: async () => {},
});

const http = () =>
  new SafeHttpClient({
    allowLoopback: true,
    totalTimeoutMs: 2_000,
    maxResponseBytes: 512 * 1024,
    maxRetries: 0,
  }).forBase(panel.baseUrl);

beforeEach(async () => {
  panel = await startFakeRickpanel();
  target = {
    baseUrl: panel.baseUrl,
    credentials: { shape: 'USERNAME_PASSWORD', username: panel.username, password: panel.password },
    activation: {} as ProviderServiceTarget['activation'],
  };
});
afterEach(async () => {
  await panel.close();
});

function sentRef(ref: string): boolean {
  return panel.requests.some((r) => r.path.includes(ref) || r.body.includes(ref));
}

describe('C3: subscription_ref is local to NEXA for RickPanel', () => {
  it('no operation on a NEXA-created account sends the ref', async () => {
    const ref: ProviderUserRef = {
      username: 'c3user',
      subscriptionRef: REF_A,
      clientId: '11111111-2222-4333-8444-555555555555',
    };
    const create: CreateProviderUserInput = {
      ...ref,
      serviceId: '019240ab-cdef-7012-8345-6789abcdef01' as CreateProviderUserInput['serviceId'],
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      volumeBytes: 1_073_741_824n,
      durationDays: 30,
      deviceLimit: null,
    };
    const created = await adapter.createUser(target, http(), create);
    expect(created.ok).toBe(true);
    await adapter.lookupUser(target, http(), ref);
    await adapter.readUsage(target, http(), ref);
    await adapter.suspendUser(target, http(), ref);
    await adapter.resumeUser(target, http(), ref);
    await adapter.fetchSubscriptionFiles(target, http(), ref);
    expect(panel.requests.length).toBeGreaterThan(5);
    expect(sentRef(REF_A)).toBe(false);
  });

  it('an account NEXA did not create reads back under ANY local ref, with the panel link', async () => {
    // What adoption would see: an account already on the panel, a fresh local ref.
    panel.seedUser('legacyacct', { subToken: 'panel-own-token-1', usedTraffic: 42 });
    const before = panel.requests.length;
    const results = [];
    for (const subscriptionRef of [REF_A, REF_B]) {
      results.push(
        await adapter.lookupUser(target, http(), {
          username: 'legacyacct',
          subscriptionRef,
          clientId: '11111111-2222-4333-8444-555555555555',
        }),
      );
    }
    for (const result of results) {
      expect(result).toMatchObject({
        ok: true,
        found: true,
        delivery: { kind: 'SUBSCRIPTION_LINK' },
        usage: { usedBytes: 42n },
      });
      if (result.ok && result.found && result.delivery.kind === 'SUBSCRIPTION_LINK') {
        // The panel's own token, never the ref.
        expect(result.delivery.url).toContain('panel-own-token-1');
        expect(result.delivery.url).not.toContain(REF_A);
        expect(result.delivery.url).not.toContain(REF_B);
      }
    }
    // Reading changed nothing on the panel and wrote nothing.
    const sinceSeed = panel.requests.slice(before);
    expect(sinceSeed.every((r) => r.method === 'GET' || r.path === '/api/admin/token')).toBe(true);
    expect(panel.users.get('legacyacct')?.subToken).toBe('panel-own-token-1');
    expect(sentRef(REF_A) || sentRef(REF_B)).toBe(false);
  });
});
