import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CreateProviderUserInput,
  ProviderServiceTarget,
  ProviderUserRef,
  SanaeiActivation,
} from '@nexa/contracts';
import { sanaeiActivationSchema } from '@nexa/contracts';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { SanaeiAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/sanaei.adapter';
import {
  countClientsNamed,
  readClientAsOperator,
  requireRealPanel,
  subscriptionPayload,
  type RealPanel,
} from './real-panel-harness';

/**
 * The SHIPPED Sanaei adapter against a REAL MHSanaei/3x-ui v3.7.0 panel.
 *
 * ## Why this project exists, and why it is not in `pnpm verify`
 *
 * Every other test of this adapter runs against `tests/support/fake-3xui.ts` —
 * a fake this repository wrote from the same reading of upstream that the
 * adapter was written from. That circularity is the defect
 * `tests/unit/provider-wire-routes.test.ts` names and cannot close: a fake and
 * an adapter that agree with each other prove agreement, not correctness. Phase
 * 4D shipped two routes v3.7.0 does not have, with 42 green fake-server tests.
 *
 * This file closes it from the other side. It drives the adapter that ships
 * against the panel that ships — the upstream Go binary built from
 * `MHSanaei/3x-ui` at tag `v3.7.0`, commit
 * `f727d04f6522bb94a8fb52e8352fdcafb51c11e1`, with a real `xray-core` behind
 * it. Nothing here is faked, mocked or stubbed, and no request is constructed
 * by hand: what talks to the panel is `SanaeiAdapter` over the real
 * `SafeHttpClient`.
 *
 * It is a SEPARATE vitest project, named by `pnpm test:acceptance` and by
 * nothing else, because it needs a panel to exist. CI has no panel, so a test
 * that silently passed without one would be worse than no test — it would
 * report a compatibility this installation had not checked. Absent
 * `NEXA_ACCEPTANCE_PANEL_URL` the suite FAILS with an explanation rather than
 * skipping: `docs/real-panel-acceptance.md` records how to stand one up.
 *
 * ## Disposable only
 *
 * Every account this file creates is named from a random service id under an
 * `acc-` prefix, on a panel stood up for the run. Nothing here may be pointed
 * at an installation carrying real customers, and the destructive half — the
 * one that suspends, resumes and terminates — is deliberately not in this file.
 */

let panel: RealPanel;
const adapter = new SanaeiAdapter();

beforeAll(async () => {
  panel = await requireRealPanel();
});

afterAll(async () => {
  await panel?.close();
});

function http(base: string = panel.baseUrl) {
  return new SafeHttpClient({
    allowLoopback: true,
    totalTimeoutMs: 15_000,
    maxResponseBytes: 256 * 1024,
    maxRetries: 0,
  }).forBase(base);
}

function activation(overrides: Partial<SanaeiActivation> = {}): SanaeiActivation {
  // Through the real schema, not as a literal: an activation this suite could
  // construct but a panel row could not would prove nothing about production.
  return sanaeiActivationSchema.parse({
    subscriptionDomain: panel.subscriptionDomain,
    inboundId: panel.inboundId,
    ...overrides,
  });
}

function target(overrides: Partial<SanaeiActivation> = {}): ProviderServiceTarget {
  return {
    baseUrl: panel.baseUrl,
    credentials: panel.credentials,
    activation: activation(overrides),
  };
}

/** The three derived identities, as `providerUsernameFor` and friends produce them. */
let refSeq = 0;
function disposableRef(): ProviderUserRef {
  refSeq += 1;
  const stamp = `${panel.runId}-${refSeq}`;
  return {
    username: `acc-${stamp}`,
    subscriptionRef: `accsub${panel.runId.replace(/-/g, '')}${refSeq}`,
    clientId: crypto.randomUUID(),
  };
}

const GIB = 1024n * 1024n * 1024n;

function createInput(
  ref: ProviderUserRef,
  overrides: Partial<CreateProviderUserInput> = {},
): CreateProviderUserInput {
  return {
    ...ref,
    serviceId: crypto.randomUUID() as CreateProviderUserInput['serviceId'],
    volumeBytes: 5n * GIB,
    durationDays: 30,
    expiresAt: new Date(panel.startedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
    deviceLimit: 3,
    ...overrides,
  };
}

/** Everything an outcome carries, flattened, for a secret search. */
const asText = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));

// ===========================================================================
// A1 — create a disposable account successfully
// ===========================================================================
describe('A1. a create reaches a real v3.7.0 panel', () => {
  it('creates an account and returns the subscription link', async () => {
    const ref = disposableRef();
    const outcome = await adapter.createUser(target(), http(), createInput(ref));

    expect(outcome).toEqual({
      ok: true,
      providerUserId: ref.clientId,
      delivery: {
        kind: 'SUBSCRIPTION_LINK',
        url: `https://${panel.subscriptionDomain}/sub/${ref.subscriptionRef}`,
      },
      usage: null,
    });

    // The panel, asked independently of the adapter, holds the client.
    const client = await readClientAsOperator(panel, ref.username);
    expect(client).not.toBeNull();
    expect(client?.email).toBe(ref.username);
  });

  it('a create against an inbound the panel does not have is a provider error, not a success', async () => {
    const ref = disposableRef();
    const outcome = await adapter.createUser(
      target({ inboundId: 999_999 }),
      http(),
      createInput(ref),
    );
    expect(outcome.ok).toBe(false);
    // And nothing was created under that name.
    expect(await readClientAsOperator(panel, ref.username)).toBeNull();
  });
});

// ===========================================================================
// A2 — lookup that exact account
// ===========================================================================
describe('A2. a lookup finds that exact account and no other', () => {
  it('finds the account just created', async () => {
    const ref = disposableRef();
    await adapter.createUser(target(), http(), createInput(ref));

    const found = await adapter.lookupUser(target(), http(), ref);
    expect(found).toMatchObject({ ok: true, found: true });
  });

  it('reports a name the panel does not have as a POSITIVE absence', async () => {
    // The distinction the whole unknown-outcome design rests on: v3.7.0 answers
    // an unknown email `success: true, obj: null`, and `found: false` is what
    // makes a fresh create legal. A transport failure must never read this way.
    const absent = await adapter.lookupUser(target(), http(), disposableRef());
    expect(absent).toEqual({ ok: true, found: false });
  });

  it('does not answer one account with another account', async () => {
    const one = disposableRef();
    const two = disposableRef();
    await adapter.createUser(
      target(),
      http(),
      createInput(one, { volumeBytes: 7n * GIB, deviceLimit: 1 }),
    );
    await adapter.createUser(
      target(),
      http(),
      createInput(two, { volumeBytes: 11n * GIB, deviceLimit: 2 }),
    );

    const readOne = await adapter.readUsage(target(), http(), one);
    const readTwo = await adapter.readUsage(target(), http(), two);
    expect(readOne).toMatchObject({ ok: true, usage: { totalBytes: 7n * GIB } });
    expect(readTwo).toMatchObject({ ok: true, usage: { totalBytes: 11n * GIB } });
  });
});

// ===========================================================================
// A3 — read usage correctly
// ===========================================================================
describe('A3. usage read back from the panel is the panel’s figure', () => {
  it('reads zero used against the promised total on a brand new account', async () => {
    const ref = disposableRef();
    const input = createInput(ref, { volumeBytes: 3n * GIB });
    await adapter.createUser(target(), http(), input);

    const read = await adapter.readUsage(target(), http(), ref);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.usage.usedBytes).toBe(0n);
    expect(read.usage.totalBytes).toBe(3n * GIB);
    expect(read.usage.expiresAt?.getTime()).toBe(input.expiresAt?.getTime());
  });

  it('an unlimited-volume account reads back as unlimited, not as zero remaining', async () => {
    // 3X-UI stores "no limit" as totalGB 0. Reporting that as a 0-byte
    // allowance would make every unlimited service look exhausted.
    const ref = disposableRef();
    await adapter.createUser(
      target(),
      http(),
      createInput(ref, { volumeBytes: null, durationDays: null, expiresAt: null }),
    );
    const read = await adapter.readUsage(target(), http(), ref);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.usage.totalBytes).toBeNull();
    expect(read.usage.expiresAt).toBeNull();
  });

  it('reading a name the panel does not have is a failure, never zero usage', async () => {
    const read = await adapter.readUsage(target(), http(), disposableRef());
    expect(read).toEqual({ ok: false, failure: 'PROVIDER_ERROR', status: null });
  });
});

// ===========================================================================
// A4 — the generated subscription is usable
// ===========================================================================
describe('A4. the subscription Nexa hands the customer actually works', () => {
  it('the subscription listener serves a config carrying this client’s own id', async () => {
    const ref = disposableRef();
    const created = await adapter.createUser(target(), http(), createInput(ref));
    expect(created.ok).toBe(true);

    const served = await subscriptionPayload(panel, ref.subscriptionRef);
    expect(served.status).toBe(200);

    // 3X-UI serves subscriptions base64-encoded.
    const decoded = Buffer.from(served.body, 'base64').toString('utf8');
    expect(decoded).toContain('vless://');
    // The config authenticates with the UUID Nexa chose and sent. If the panel
    // had stored a different id, the customer would receive a link that cannot
    // connect, and every adapter-side assertion would still pass.
    expect(decoded).toContain(ref.clientId);
    expect(decoded).toContain(`:${panel.inboundPort}`);
  });

  it('another customer’s subscriptionRef does not serve this customer’s config', async () => {
    const mine = disposableRef();
    await adapter.createUser(target(), http(), createInput(mine));
    const theirs = disposableRef();

    const served = await subscriptionPayload(panel, theirs.subscriptionRef);
    const decoded = Buffer.from(served.body, 'base64').toString('utf8');
    expect(decoded).not.toContain(mine.clientId);
  });

  it('the link is built from the activation’s subscription domain, not the panel address', async () => {
    // A link built from the panel's own address points the customer at the
    // admin login. The activation names the subscription listener separately
    // because 3X-UI does not derive it.
    const ref = disposableRef();
    const created = await adapter.createUser(
      target({ subscriptionDomain: 'subs.example.test:8443' }),
      http(),
      createInput(ref),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.delivery).toEqual({
      kind: 'SUBSCRIPTION_LINK',
      url: `https://subs.example.test:8443/sub/${ref.subscriptionRef}`,
    });
    expect(created.delivery.kind === 'SUBSCRIPTION_LINK' && created.delivery.url).not.toContain(
      new URL(panel.baseUrl).host,
    );
  });
});

// ===========================================================================
// A5 — what Nexa promised is what the panel stored
// ===========================================================================
describe('A5. expiry, traffic and device settings match what Nexa promised', () => {
  it('stores the volume, the expiry and the device limit as sent', async () => {
    const ref = disposableRef();
    const input = createInput(ref, {
      volumeBytes: 17n * GIB,
      durationDays: 14,
      expiresAt: new Date(panel.startedAt.getTime() + 14 * 24 * 60 * 60 * 1000),
      deviceLimit: 4,
    });
    await adapter.createUser(target(), http(), input);

    // Read through the PANEL's operator API, not through the adapter.
    const stored = await readClientAsOperator(panel, ref.username);
    expect(stored).not.toBeNull();
    if (stored === null) return;
    expect(BigInt(stored.totalGB)).toBe(17n * GIB);
    expect(stored.expiryTime).toBe(input.expiresAt?.getTime());
    expect(stored.limitIp).toBe(4);
    expect(stored.uuid).toBe(ref.clientId);
    expect(stored.subId).toBe(ref.subscriptionRef);
    expect(stored.enable).toBe(true);
  });

  it('no device limit is stored as 3X-UI’s own "no limit", which is 0', async () => {
    const ref = disposableRef();
    await adapter.createUser(target(), http(), createInput(ref, { deviceLimit: null }));
    const stored = await readClientAsOperator(panel, ref.username);
    expect(stored?.limitIp).toBe(0);
  });

  it('a durationDays of null is stored as no expiry, not as an expiry in 1970', async () => {
    const ref = disposableRef();
    await adapter.createUser(
      target(),
      http(),
      createInput(ref, { durationDays: null, expiresAt: null }),
    );
    const stored = await readClientAsOperator(panel, ref.username);
    expect(stored?.expiryTime).toBe(0);
  });
});

// ===========================================================================
// A6 — retries and reconciliation do not duplicate
// ===========================================================================
describe('A6. a retry does not give the customer two accounts', () => {
  it('a replay of the same create is an idempotent no-op, reported as success', async () => {
    // What a lost response actually produces: same ref, same input, sent again.
    // v3.7.0 exempts a matching subId from the duplicate check and then filters
    // out anything already on the inbound, returning `(false, nil)` — success.
    // The adapter's docblock used to assert the opposite and the fake enforced
    // the opposite, so 42 green scenarios agreed with each other and not with
    // the panel.
    const ref = disposableRef();
    const input = createInput(ref);

    const first = await adapter.createUser(target(), http(), input);
    expect(first.ok).toBe(true);

    const second = await adapter.createUser(target(), http(), input);
    expect(second.ok).toBe(true);

    // The point of the whole rule: one account, not two.
    expect(await countClientsNamed(panel, ref.username)).toBe(1);
  });

  it('a DIFFERENT identity claiming a taken name is refused, not silently adopted', async () => {
    // The other half of the same v3.7.0 rule. `checkEmailsExistForClients`
    // exempts a MATCHING subId; a different one is a real duplicate and is
    // rejected. If it were not, two services would share one panel account and
    // each would believe it had its own.
    const ref = disposableRef();
    await adapter.createUser(target(), http(), createInput(ref));

    const impostor = { ...disposableRef(), username: ref.username };
    const outcome = await adapter.createUser(target(), http(), createInput(impostor));
    expect(outcome).toMatchObject({ ok: false, failure: 'PROVIDER_ERROR' });

    // And the original account is untouched — same UUID, same subId.
    const stored = await readClientAsOperator(panel, ref.username);
    expect(stored?.uuid).toBe(ref.clientId);
    expect(stored?.subId).toBe(ref.subscriptionRef);
    expect(await countClientsNamed(panel, ref.username)).toBe(1);
  });

  it('reconciliation after a lost create adopts the account instead of making another', async () => {
    // The real shape: the create landed, Nexa never learned the answer. What
    // the provisioner does next is lookupUser on the SAME derived name.
    const ref = disposableRef();
    await adapter.createUser(target(), http(), createInput(ref));

    const reconcile = await adapter.lookupUser(target(), http(), ref);
    expect(reconcile).toMatchObject({ ok: true, found: true });
    expect(await countClientsNamed(panel, ref.username)).toBe(1);
  });

  it('two concurrent creates of the same name leave exactly one account', async () => {
    // Both may report success — the second is the idempotent no-op above. What
    // must hold regardless is the count, because that is what the customer
    // has: `AddInboundClient` takes `lockInbound(data.Id)` for exactly this.
    const ref = disposableRef();
    const input = createInput(ref);
    const [a, b] = await Promise.all([
      adapter.createUser(target(), http(), input),
      adapter.createUser(target(), http(), input),
    ]);
    expect(a.ok || b.ok).toBe(true);
    expect(await countClientsNamed(panel, ref.username)).toBe(1);
  });
});

// ===========================================================================
// A7 — nothing leaks
// ===========================================================================
describe('A7. no credential reaches an outcome, an error or a log', () => {
  const secrets = (): readonly string[] => {
    const credentials = panel.credentials;
    switch (credentials.shape) {
      case 'USERNAME_PASSWORD':
        return [credentials.password];
      case 'OPAQUE_TOKEN':
        return [credentials.token];
      // `NONE` carries nothing to leak, and a panel configured that way is not
      // one this suite can authenticate against in the first place.
      case 'NONE':
        return [];
    }
  };

  it('a successful create carries no credential', async () => {
    const outcome = await adapter.createUser(target(), http(), createInput(disposableRef()));
    for (const secret of secrets()) expect(asText(outcome)).not.toContain(secret);
  });

  it('a REJECTED login carries neither the password nor the panel’s message about it', async () => {
    const wrong: ProviderServiceTarget = {
      ...target(),
      credentials: { shape: 'USERNAME_PASSWORD', username: 'nobody-acc', password: 'wrong-pass' },
    };
    const outcome = await adapter.probe(wrong, http());
    expect(outcome).toMatchObject({ ok: false, failure: 'AUTHENTICATION_FAILED' });
    expect(asText(outcome)).not.toContain('wrong-pass');
    for (const secret of secrets()) expect(asText(outcome)).not.toContain(secret);
  });

  it('a create against an unreachable panel carries no credential in the failure', async () => {
    const unreachable: ProviderServiceTarget = { ...target(), baseUrl: 'http://127.0.0.9:1/' };
    const outcome = await adapter.createUser(
      unreachable,
      http('http://127.0.0.9:1/'),
      createInput(disposableRef()),
    );
    expect(outcome.ok).toBe(false);
    for (const secret of secrets()) expect(asText(outcome)).not.toContain(secret);
  });

  it('a thrown error, if the adapter ever throws, carries no credential either', async () => {
    let captured = '';
    try {
      await adapter.createUser(
        { ...target(), baseUrl: 'http://127.0.0.9:1/' },
        http('http://127.0.0.9:1/'),
        createInput(disposableRef()),
      );
    } catch (error) {
      captured = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
    }
    for (const secret of secrets()) expect(captured).not.toContain(secret);
  });
});

// ===========================================================================
// A8 — panel identity stays correct
// ===========================================================================
describe('A8. the panel and the inbound come from the row, never from the caller', () => {
  it('two services with different derived names do not collide on one panel', async () => {
    // The tenancy property at this layer: names are derived per service, so two
    // tenants' services on a SHARED panel cannot be confused for each other.
    const a = disposableRef();
    const b = disposableRef();
    expect(a.username).not.toBe(b.username);
    expect(a.subscriptionRef).not.toBe(b.subscriptionRef);
    expect(a.clientId).not.toBe(b.clientId);

    await adapter.createUser(target(), http(), createInput(a, { volumeBytes: 2n * GIB }));
    await adapter.createUser(target(), http(), createInput(b, { volumeBytes: 9n * GIB }));

    const storedA = await readClientAsOperator(panel, a.username);
    const storedB = await readClientAsOperator(panel, b.username);
    expect(BigInt(storedA?.totalGB ?? -1)).toBe(2n * GIB);
    expect(BigInt(storedB?.totalGB ?? -1)).toBe(9n * GIB);
    expect(storedA?.uuid).toBe(a.clientId);
    expect(storedB?.uuid).toBe(b.clientId);
  });

  it('a lookup addressed at a DIFFERENT panel does not answer with this panel’s account', async () => {
    const ref = disposableRef();
    await adapter.createUser(target(), http(), createInput(ref));

    const elsewhere: ProviderServiceTarget = { ...target(), baseUrl: 'http://127.0.0.9:1/' };
    const outcome = await adapter.lookupUser(elsewhere, http('http://127.0.0.9:1/'), ref);
    // Unreachable is a FAILURE, never `found: false` — not knowing must never
    // read as absent, because absent is what makes a fresh create legal.
    expect(outcome.ok).toBe(false);
  });

  it('the panel’s own webBasePath is honoured — a leading-slash path would miss it', async () => {
    // Every adapter path is relative for this reason. The disposable panel is
    // deliberately served under a non-root base path so this is a real check.
    expect(new URL(panel.baseUrl).pathname).not.toBe('/');
    const outcome = await adapter.probe(target(), http());
    expect(outcome).toMatchObject({ ok: true });
  });
});
