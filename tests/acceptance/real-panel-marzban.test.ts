import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CreateProviderUserInput,
  ProviderServiceTarget,
  ProviderUserRef,
} from '@nexa/contracts';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { MarzbanAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/marzban.adapter';
import {
  fetchSubscription,
  observeUser,
  observerDelete,
  observerToken,
  requireRealMarzban,
  type ObservedUser,
  type RealMarzban,
} from './real-marzban-harness';

/**
 * The SHIPPED Marzban adapter, over the REAL `SafeHttpClient`, against a REAL
 * Gozargah/Marzban v0.8.4.
 *
 * Nothing is mocked, stubbed or hand-rolled on the Nexa side: no request in this
 * suite is constructed by hand. The one hand-written thing is the OBSERVER, in
 * `real-marzban-harness.ts`, which reads the panel back on plain `fetch` and shares
 * no code with the adapter — because the thing under test may not also be the thing
 * that checks the answer.
 *
 * ## Why this suite exists
 *
 * The Marzban adapter's create path asserted that omitting `inbounds` means "every
 * inbound for those protocols, which is Marzban's own documented default". It is the
 * opposite: `UserCreate.excluded_inbounds` excludes every inbound NOT named. The panel
 * answered 200 with a subscription URL and the customer's subscription was zero bytes.
 * No amount of re-reading caught it and no fake could have, because the fake had been
 * written from the same sentence. Only a panel disagreed.
 *
 * ## What it does NOT prove
 *
 * Three of the acceptance items are about Nexa's own machinery rather than the wire:
 * that an UNKNOWN outcome reconciles instead of guessing, that no provider call happens
 * inside a database transaction, and that one tenant's operation cannot touch another
 * tenant's service. Those are proved in `tests/integration/provisioning-delivery.test.ts`
 * against a real PostgreSQL, because they are properties of the executor and a panel
 * cannot observe them.
 *
 * ## Running it
 *
 * `pnpm test:acceptance`, with a disposable panel. `docs/real-panel-acceptance.md`.
 * It FAILS rather than skips without one.
 */
let panel: RealMarzban;
let observer: string;

const adapter = new MarzbanAdapter();

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
  activation: panel.activation,
});

/** Disposable, run-scoped, and obviously not a customer's. */
const nameFor = (suffix: string): string => `nxacc_${panel.runId}_${suffix}`;

const ref = (suffix: string): ProviderUserRef => ({
  username: nameFor(suffix),
  subscriptionRef: `sub-${panel.runId}-${suffix}`,
  clientId: `client-${panel.runId}-${suffix}`,
});

const createInput = (
  suffix: string,
  over: Partial<CreateProviderUserInput> = {},
): CreateProviderUserInput =>
  ({
    ...ref(suffix),
    serviceId: `svc-${panel.runId}-${suffix}`,
    volumeBytes: null,
    durationDays: null,
    expiresAt: null,
    deviceLimit: null,
    ...over,
  }) as CreateProviderUserInput;

const observe = (suffix: string): Promise<ObservedUser | null> =>
  observeUser(panel, observer, nameFor(suffix));

/** Every account this run created, so the panel is left as it was found. */
const created = new Set<string>();

beforeAll(async () => {
  panel = await requireRealMarzban();
  const token = await observerToken(panel);
  if (token === null) throw new Error('the observer could not authenticate');
  observer = token;
});

afterAll(async () => {
  for (const name of created) await observerDelete(panel, observer, name);
});

describe('A1 — two accounts exist, and each is the one that was asked for', () => {
  it('creates A and B, and the panel holds exactly those two names', async () => {
    for (const suffix of ['a', 'b']) {
      created.add(nameFor(suffix));
      const outcome = await adapter.createUser(target(), http(), createInput(suffix));
      expect(outcome.ok, `creating ${suffix}`).toBe(true);
    }
    expect((await observe('a'))?.username).toBe(nameFor('a'));
    expect((await observe('b'))?.username).toBe(nameFor('b'));
    // Distinct accounts, not one account read twice.
    expect((await observe('a'))?.proxyIds).not.toEqual((await observe('b'))?.proxyIds);
  });

  it('gives each account a subscription that actually carries its own configuration', async () => {
    /*
     * The end of the chain, and the check the `inbounds` defect defeated. Every status
     * code said success for an account whose subscription served nothing, so the only
     * assertion that distinguishes them is fetching the subscription a customer would.
     */
    const a = await observe('a');
    expect(a).not.toBeNull();
    if (a === null) return;
    expect(a.links.length).toBeGreaterThan(0);
    const body = await fetchSubscription(panel, a.subscriptionUrl);
    expect(body.length).toBeGreaterThan(0);
    // And it is A's own credential in it, not merely SOME configuration.
    const decoded = Buffer.from(body, 'base64').toString('utf8');
    const identity = Object.values(a.proxyIds)[0];
    expect(identity).toBeDefined();
    expect(decoded).toContain(identity);
  });
});

describe('A2 — lookup and usage read the account that was asked for', () => {
  it('looks A up and reports what the panel holds for A', async () => {
    const outcome = await adapter.lookupUser(target(), http(), ref('a'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !outcome.found) throw new Error('A was not found');
    expect(outcome.delivery.kind).toBe('SUBSCRIPTION_LINK');
    // Marzban keys by the name and carries no second id that outlives it.
    expect(outcome.providerUserId).toBeNull();
  });

  it('reports an absent account as ABSENT, which is what makes a fresh create legal', async () => {
    const outcome = await adapter.lookupUser(target(), http(), ref('never-created'));
    expect(outcome).toEqual({ ok: true, found: false });
  });

  it('reads usage back, with unlimited as no limit rather than a limit of zero', async () => {
    const outcome = await adapter.readUsage(target(), http(), ref('a'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.usage.usedBytes).toBe(0n);
    /*
     * Created with `expire: 0` and `data_limit: 0`, which Marzban stores as NULL. If
     * these came back as 0n the customer would be told they have an allowance of
     * nothing, and a usage sweep would read every fresh service as exhausted.
     */
    expect(outcome.usage.totalBytes).toBeNull();
    expect(outcome.usage.expiresAt).toBeNull();
  });
});

describe('A3 — suspend applies to one account and only that account', () => {
  it('suspends A while B keeps serving', async () => {
    const outcome = await adapter.suspendUser(target(), http(), ref('a'));
    expect(outcome).toMatchObject({ ok: true, found: true });
    expect((await observe('a'))?.status).toBe('disabled');
    expect((await observe('b'))?.status).toBe('active');
    // B's subscription is untouched, not merely its status row.
    const b = await observe('b');
    expect((await fetchSubscription(panel, b?.subscriptionUrl ?? '')).length).toBeGreaterThan(0);
  });

  it('does not rewrite A’s allowance while suspending it', async () => {
    /*
     * `UserModify` applies every field that is PRESENT. An adapter echoing the service's
     * expiry or volume here would silently reset the customer's allowance on every
     * suspend, and this is the panel-side proof that it does not.
     */
    const a = await observe('a');
    expect(a?.expire).toBeNull();
    expect(a?.dataLimit).toBeNull();
  });

  it('is idempotent: suspending an already-suspended account succeeds and changes nothing', async () => {
    const again = await adapter.suspendUser(target(), http(), ref('a'));
    expect(again).toMatchObject({ ok: true, found: true });
    expect((await observe('a'))?.status).toBe('disabled');
    expect((await observe('b'))?.status).toBe('active');
  });
});

describe('A4 — resume applies to one account and only that account', () => {
  it('resumes A while B is unaffected', async () => {
    const outcome = await adapter.resumeUser(target(), http(), ref('a'));
    expect(outcome).toMatchObject({ ok: true, found: true });
    expect((await observe('a'))?.status).toBe('active');
    expect((await observe('b'))?.status).toBe('active');
  });

  it('is idempotent, and A is usable again afterwards', async () => {
    expect(await adapter.resumeUser(target(), http(), ref('a'))).toMatchObject({ ok: true });
    const a = await observe('a');
    expect(a?.status).toBe('active');
    expect((await fetchSubscription(panel, a?.subscriptionUrl ?? '')).length).toBeGreaterThan(0);
  });

  it('reports an account the panel does not have as ABSENT rather than inventing one', async () => {
    /*
     * A divergence an operator has to see, not a failure to reach the panel and not a
     * reason to create anything. `found: false` is the only outcome that says it.
     */
    expect(await adapter.suspendUser(target(), http(), ref('never-created'))).toEqual({
      ok: true,
      found: false,
    });
    expect(await adapter.resumeUser(target(), http(), ref('never-created'))).toEqual({
      ok: true,
      found: false,
    });
    expect(await observe('never-created')).toBeNull();
  });
});

describe('A5 — terminate removes one account and leaves the other', () => {
  it('terminates A, and B is still there and still serving', async () => {
    const outcome = await adapter.terminateUser(target(), http(), ref('a'));
    expect(outcome).toEqual({ ok: true, wasPresent: true });
    expect(await observe('a')).toBeNull();
    const b = await observe('b');
    expect(b?.status).toBe('active');
    expect((await fetchSubscription(panel, b?.subscriptionUrl ?? '')).length).toBeGreaterThan(0);
  });

  it('treats a replayed terminate as a success that did no work', async () => {
    /*
     * The normal case after a lost answer. If this reported a failure, a TERMINATE whose
     * response was lost would be stuck for ever; if it reported `wasPresent: true`, the
     * record would claim the second call did the deletion.
     */
    expect(await adapter.terminateUser(target(), http(), ref('a'))).toEqual({
      ok: true,
      wasPresent: false,
    });
    expect(await observe('b')).not.toBeNull();
  });
});

describe('A6 — the account addressed is the stored one, never a value shaped like a path', () => {
  it('cannot be steered to another account by a username that looks like a path', async () => {
    /*
     * The provider username is read off the stored service row and a customer addresses
     * a service by id, so this is not reachable today. It is asserted anyway because a
     * path built by concatenation is one refactor away from being reachable, and the
     * consequence would be one customer terminating another's account.
     *
     * `b` is the target the traversal aims at. It survives.
     */
    const hostile: ProviderUserRef = {
      username: `../${nameFor('b')}`,
      subscriptionRef: 'x',
      clientId: 'x',
    };
    const outcome = await adapter.terminateUser(target(), http(), hostile);
    // Either the panel has no such literal name, or it refuses it. Never B's deletion.
    expect(outcome.ok === true ? outcome.wasPresent : true).toBe(false);
    expect(await observe('b')).not.toBeNull();

    const suspended = await adapter.suspendUser(target(), http(), hostile);
    expect(suspended.ok === true ? suspended.found : true).toBe(false);
    expect((await observe('b'))?.status).toBe('active');
  });
});

describe('A7 — nothing this adapter returns carries a credential', () => {
  it('never puts the password, the username or an authorization header into any outcome', async () => {
    /*
     * Searched across every outcome shape the management half can produce, including
     * the failures, because a failure is where a message is most likely to be built by
     * concatenating whatever was to hand.
     */
    const credentials = panel.credentials;
    if (credentials.shape !== 'USERNAME_PASSWORD') throw new Error('unexpected shape');

    const outcomes: unknown[] = [
      await adapter.lookupUser(target(), http(), ref('b')),
      await adapter.readUsage(target(), http(), ref('b')),
      await adapter.suspendUser(target(), http(), ref('b')),
      await adapter.resumeUser(target(), http(), ref('b')),
      await adapter.suspendUser(target(), http(), ref('never-created')),
      await adapter.terminateUser(target(), http(), ref('never-created')),
      // A refused credential: the one call that definitely handled a password.
      await adapter.suspendUser(
        {
          ...target(),
          credentials: { ...credentials, password: `${credentials.password}-wrong` },
        },
        http(),
        ref('b'),
      ),
    ];
    // `usedBytes` is a bigint, which JSON.stringify refuses. Stringified rather than
    // dropped: a value skipped by the serializer is a value this search never sees.
    const serialized = JSON.stringify(outcomes, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialized).not.toContain(credentials.password);
    expect(serialized).not.toContain(credentials.username);
    expect(serialized.toLowerCase()).not.toContain('bearer ');
    expect(serialized.toLowerCase()).not.toContain('authorization');
  });

  it('stops at a refused credential without touching the account', async () => {
    const credentials = panel.credentials;
    if (credentials.shape !== 'USERNAME_PASSWORD') throw new Error('unexpected shape');
    const outcome = await adapter.terminateUser(
      { ...target(), credentials: { ...credentials, password: 'definitely-not-it' } },
      http(),
      ref('b'),
    );
    expect(outcome).toMatchObject({ ok: false, failure: 'AUTHENTICATION_FAILED' });
    expect(await observe('b')).not.toBeNull();
  });
});
