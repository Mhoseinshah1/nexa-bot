import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CreateProviderUserInput,
  ProviderServiceTarget,
  ProviderUserRef,
} from '@nexa/contracts';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { RickpanelAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel.adapter';
import {
  fetchSubscription,
  observeUser,
  observerDelete,
  observerToken,
  requireRealRickpanel,
  type RealRickpanel,
} from './real-rickpanel-harness';

/**
 * The SHIPPED RickPanel adapter, over the REAL `SafeHttpClient`, against a REAL
 * RickPanel.
 *
 * Nothing is mocked or hand-rolled on the Nexa side: no request in this suite is
 * constructed by hand. The one hand-written thing is the OBSERVER, which reads
 * the panel back on plain `fetch` and shares no code with the adapter — because
 * the thing under test may not also be the thing that checks the answer.
 *
 * ## Why this suite exists, and its status
 *
 * **It has not been run.** The adapter was written from
 * `rickpanel-openapi.json`, a per-admin document whose schemas are lossy: every
 * `UserCreate` property is typed `"string"`, `required` is empty, no `username`
 * is declared, and `components.schemas` is empty so no response has a shape at
 * all. `docs/rickpanel-adapter-audit.md` §1 lists what had to be inferred from
 * the prose, and §4 states the gap: RickPanel acceptance is UNPROVEN, and a
 * Marzban result is not a substitute for it.
 *
 * `docs/real-panel-acceptance.md` is what makes that worth saying twice: a fake
 * this repository wrote and an adapter this repository wrote can only prove they
 * agree with each other, and four defects reached `main` that way.
 *
 * ## Running it
 *
 * `pnpm test:acceptance`, with a disposable RickPanel and its three environment
 * variables. It FAILS rather than skips without one, and it must never be
 * pointed at an installation carrying real customers.
 */
let panel: RealRickpanel;
let observer: string;

// The real defaults, deliberately: the poll's real timing is part of what this
// suite measures, and a test that shortened it would not be testing the adapter
// that ships.
const adapter = new RickpanelAdapter();

const http = () =>
  new SafeHttpClient({
    allowLoopback: true,
    totalTimeoutMs: 20_000,
    maxResponseBytes: 512 * 1024,
    maxRetries: 0,
  }).forBase(panel.baseUrl);

const target = (): ProviderServiceTarget => ({
  baseUrl: panel.baseUrl,
  credentials: panel.credentials,
  // EMPTY, and that is half the point of the run: a RickPanel is sellable with
  // nothing configured, and the accounts created below have to serve traffic to
  // prove it.
  activation: {},
});

const created: string[] = [];

const nameFor = (suffix: string): string => `nxacc${panel.runId}${suffix}`.toLowerCase();

const refFor = (username: string): ProviderUserRef => ({
  username,
  subscriptionRef: `${username}-ref`,
  clientId: '019250ab-cdef-7012-8345-6789abcdef01',
});

const createFor = (username: string): CreateProviderUserInput => ({
  ...refFor(username),
  serviceId: '019240ab-cdef-7012-8345-6789abcdef01' as CreateProviderUserInput['serviceId'],
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  volumeBytes: 1_073_741_824n,
  durationDays: 1,
  deviceLimit: null,
});

beforeAll(async () => {
  panel = await requireRealRickpanel();
  const token = await observerToken(panel);
  if (token === null) throw new Error('observer could not authenticate');
  observer = token;
}, 60_000);

afterAll(async () => {
  // This run's accounts and nothing else. Never a sweep by prefix over the
  // panel: `runId` is what keeps a cleanup from deleting a previous run's
  // evidence, or somebody's real customer.
  for (const username of created) await observerDelete(panel, observer, username);
}, 60_000);

describe('RickPanel acceptance', () => {
  /**
   * A1 — a create with NO activation produces an account that actually serves.
   *
   * The single most important assertion here, and the one the Marzban defect
   * teaches: a 200 with a subscription URL is not a delivery. What makes this a
   * pass is the BYTES the subscription serves, read by the observer rather than
   * by the adapter.
   *
   * It also settles `OQ-RP-01` by demonstration: whichever field the adapter
   * found the URL in, it was the right one.
   */
  it('A1: creates a serving account with no protocol or inbound configured', async () => {
    const username = nameFor('a1');
    created.push(username);

    const outcome = await adapter.createUser(target(), http(), createFor(username));
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.delivery.kind).toBe('SUBSCRIPTION_LINK');
    if (outcome.delivery.kind !== 'SUBSCRIPTION_LINK') return;

    // The panel's own record, read independently.
    const record = await observeUser(panel, observer, username);
    expect(record, 'the panel does not hold the account the adapter reported').not.toBeNull();

    // And what the customer would actually receive.
    const served = await fetchSubscription(outcome.delivery.url);
    expect(served.status).toBe(200);
    expect(
      served.bytes,
      'the subscription is empty: the account exists and serves nothing',
    ).toBeGreaterThan(0);
  }, 120_000);

  /**
   * A2 — a create for a name that already exists is REFUSED, and the account is untouched.
   *
   * This used to assert the opposite — that a replayed create adopted the account —
   * and went stale when Codex C2 (P1) on PR #58 made a 409 a refusal: a name match
   * cannot prove an account is ours, and on a panel that already had customers it
   * would hand one customer's subscription to another. So the second call must
   * answer `PROVIDER_REFUSED` with 409, and the observer must see ONE account whose
   * subscription is exactly what the first call delivered.
   *
   * Assertion messages carry the failure kind only. An outcome that went wrong in
   * the dangerous direction would carry a subscription URL, and a test log is not a
   * place for one.
   */
  it('A2: a create for an existing name is refused, never adopted', async () => {
    const username = nameFor('a2');
    created.push(username);

    const first = await adapter.createUser(target(), http(), createFor(username));
    expect(first.ok, first.ok ? 'ok' : first.failure).toBe(true);
    if (!first.ok || first.delivery.kind !== 'SUBSCRIPTION_LINK') return;
    const before = await observeUser(panel, observer, username);

    const second = await adapter.createUser(target(), http(), createFor(username));
    expect(second.ok, 'a 409 was adopted: a name match handed over an existing account').toBe(
      false,
    );
    if (second.ok) return;
    expect(second.failure).toBe('PROVIDER_REFUSED');
    expect(second.status).toBe(409);

    const after = await observeUser(panel, observer, username);
    expect(after?.['subscription_url']).toBe(before?.['subscription_url']);
    expect(after?.['expire']).toBe(before?.['expire']);
    expect(after?.['data_limit']).toBe(before?.['data_limit']);
  }, 120_000);

  /**
   * A7 — the NEW_SERVICE hotfix, measured: a seeded create delivers what was sold.
   *
   * `docs/rickpanel-create-hotfix.md`. The owner's direct calls showed an unseeded
   * create failing and a create seeded with `{"vless": {}}` succeeding. This is the
   * same thing through the SHIPPED adapter: one limited plan and one unlimited plan,
   * each read back by the observer, each carrying exactly the entitlement the order
   * froze — a traffic cap is not dropped and no term is invented to get a create
   * through — and each with a subscription the panel generated.
   */
  it('A7: creates limited and unlimited plans with exactly the entitlement sold', async () => {
    const limited = nameFor('a7l');
    const unlimited = nameFor('a7u');
    created.push(limited, unlimited);

    const one = await adapter.createUser(target(), http(), createFor(limited));
    expect(one.ok, one.ok ? 'ok' : one.failure).toBe(true);
    const oneRecord = await observeUser(panel, observer, limited);
    expect(oneRecord?.['data_limit']).toBe(1_073_741_824);
    expect(oneRecord?.['status']).toBe('active');
    expect(typeof oneRecord?.['subscription_url']).toBe('string');

    const two = await adapter.createUser(target(), http(), {
      ...createFor(unlimited),
      volumeBytes: null,
      expiresAt: null,
    });
    expect(two.ok, two.ok ? 'ok' : two.failure).toBe(true);
    const twoRecord = await observeUser(panel, observer, unlimited);
    // The panel's own "unlimited" for both, per the create's description.
    expect(twoRecord?.['data_limit'] ?? 0).toBe(0);
    expect(twoRecord?.['expire'] ?? 0).toBe(0);
    expect(twoRecord?.['status']).toBe('active');
  }, 180_000);

  /**
   * A3 — suspend, resume, and what the panel says about each.
   *
   * Checked on the observer's record rather than on the adapter's own report,
   * and on the SIBLING too: an adapter that disabled every account this admin
   * owns would pass a single-account assertion.
   */
  it('A3: suspends one account and leaves its sibling serving', async () => {
    const one = nameFor('a3x');
    const other = nameFor('a3y');
    created.push(one, other);
    expect((await adapter.createUser(target(), http(), createFor(one))).ok).toBe(true);
    expect((await adapter.createUser(target(), http(), createFor(other))).ok).toBe(true);

    const suspended = await adapter.suspendUser(target(), http(), refFor(one));
    expect(suspended.ok, JSON.stringify(suspended)).toBe(true);
    expect((await observeUser(panel, observer, one))?.['status']).toBe('disabled');
    expect((await observeUser(panel, observer, other))?.['status']).toBe('active');

    const resumed = await adapter.resumeUser(target(), http(), refFor(one));
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    expect((await observeUser(panel, observer, one))?.['status']).toBe('active');
  }, 180_000);

  /**
   * A4 — an allowance is applied absolutely, and a replay changes nothing.
   *
   * This is what `RENEW`, `ADD_TRAFFIC` and `ADD_TIME` being in
   * `IDEMPOTENT_MUTATIONS` rests on. The sibling is read again for the same
   * reason as A3.
   */
  it('A4: applies an allowance absolutely, and replaying it changes nothing', async () => {
    const one = nameFor('a4x');
    const other = nameFor('a4y');
    created.push(one, other);
    expect((await adapter.createUser(target(), http(), createFor(one))).ok).toBe(true);
    expect((await adapter.createUser(target(), http(), createFor(other))).ok).toBe(true);
    const untouched = await observeUser(panel, observer, other);

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const plan = { expiresAt, trafficLimitBytes: 5_368_709_120n };
    expect((await adapter.applyAllowance(target(), http(), refFor(one), plan)).ok).toBe(true);

    const after = await observeUser(panel, observer, one);
    expect(after?.['expire']).toBe(Math.floor(expiresAt.getTime() / 1000));
    expect(after?.['data_limit']).toBe(5_368_709_120);

    expect((await adapter.applyAllowance(target(), http(), refFor(one), plan)).ok).toBe(true);
    const replayed = await observeUser(panel, observer, one);
    expect(replayed?.['expire']).toBe(after?.['expire']);
    expect(replayed?.['data_limit']).toBe(after?.['data_limit']);

    // The sibling's two numbers are exactly where they were.
    const stillUntouched = await observeUser(panel, observer, other);
    expect(stillUntouched?.['expire']).toBe(untouched?.['expire']);
    expect(stillUntouched?.['data_limit']).toBe(untouched?.['data_limit']);
  }, 180_000);

  /**
   * A5 — a delete removes one account and only that one.
   *
   * The account is deleted by the ADAPTER and its absence confirmed by the
   * observer, which is the only combination that proves the delete reached the
   * panel rather than the adapter reporting its own intention.
   */
  it('A5: deletes one account and leaves its sibling', async () => {
    const one = nameFor('a5x');
    const other = nameFor('a5y');
    created.push(other);
    expect((await adapter.createUser(target(), http(), createFor(one))).ok).toBe(true);
    expect((await adapter.createUser(target(), http(), createFor(other))).ok).toBe(true);

    const removed = await adapter.terminateUser(target(), http(), refFor(one));
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    if (!removed.ok) return;
    expect(removed.wasPresent).toBe(true);
    expect(await observeUser(panel, observer, one)).toBeNull();
    expect(await observeUser(panel, observer, other)).not.toBeNull();

    // A replayed delete finds nothing and says so, rather than failing.
    const again = await adapter.terminateUser(target(), http(), refFor(one));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.wasPresent).toBe(false);
  }, 180_000);

  /**
   * A6 — a username shaped like a path cannot reach a sibling.
   *
   * The adapter percent-encodes the name into the path. If it did not, a name
   * containing a slash would address a different account, which is a customer's
   * operation landing on somebody else's service. `assertSendableProviderUsername`
   * refuses such a name three layers earlier; this proves the encoding underneath
   * it rather than trusting the layer above.
   */
  it('A6: a path-shaped username does not reach another account', async () => {
    const other = nameFor('a6y');
    created.push(other);
    expect((await adapter.createUser(target(), http(), createFor(other))).ok).toBe(true);

    const hostile = await adapter.lookupUser(target(), http(), refFor(`..%2F${other}`));
    // Either the panel does not have it, or the read failed. What must NOT
    // happen is finding the sibling.
    if (hostile.ok && hostile.found) {
      expect.fail('a path-shaped username reached another account');
    }
    expect(await observeUser(panel, observer, other)).not.toBeNull();
  }, 120_000);
});
