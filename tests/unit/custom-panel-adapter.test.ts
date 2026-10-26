import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  operationFailureOutcome,
  type CreateProviderUserInput,
  type OperationType,
  type ProviderFailureKind,
  type ProviderServiceTarget,
  type ProviderUserRef,
  type ServiceId,
} from '@nexa/contracts';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { CustomPanelAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/custom-panel.adapter';
import {
  BRIDGE_SECRET,
  bridgeTls,
  startFakeCustomBridge,
  type BadPayload,
  type FakeCustomBridge,
} from '../support/fake-custom-bridge';

/**
 * The `custom` provider against a mock bridge, every operation × every failure mode
 * (R10 C2, `docs/protocols/custom-panel.md`).
 *
 * The bridge enforces the document — it verifies every request's signature and signs
 * every answer — over a real HTTPS socket and the real `SafeHttpClient`, so a timeout
 * is a real deadline. Each case also states what the provisioner will make of the
 * failure (`operationFailureOutcome`), because that is where a wrong kind costs money:
 * a create read as REFUSED is refunded, one read as UNKNOWN waits for a READ.
 */

const tls = bridgeTls();
const adapter = new CustomPanelAdapter();
let bridge: FakeCustomBridge;

const http = (timeoutMs = 3_000) =>
  new SafeHttpClient({
    allowLoopback: true,
    totalTimeoutMs: timeoutMs,
    maxResponseBytes: 256 * 1024,
    maxRetries: 0,
    caCertificates: [tls.ca],
  }).forBase(bridge.baseUrl);

const target = (secret: string = BRIDGE_SECRET, baseUrl?: string): ProviderServiceTarget => ({
  baseUrl: baseUrl ?? bridge.baseUrl,
  credentials: { shape: 'OPAQUE_TOKEN', token: secret },
  activation: {},
});

const REF: ProviderUserRef = {
  username: 'nx7k2m9p4qwe',
  subscriptionRef: 'sub-ref-not-sent',
  clientId: '5f0c9a7e-2b1d-4e6f-8a3c-9d2e1f0a7b6c',
};
const OTHER_REF = '9a9a9a9a-1111-4222-8333-444444444444';
let opCounter = 0;
const op = () => `0b6f3c1e-8f3a-4c2d-9a51-${String(++opCounter).padStart(12, '0')}`;
const EXPIRY = new Date('2026-11-25T08:13:20.000Z');

const createInput = (over: Partial<CreateProviderUserInput> = {}): CreateProviderUserInput => ({
  ...REF,
  serviceId: '11111111-2222-4333-8444-555555555555' as ServiceId,
  volumeBytes: 53_687_091_200n,
  durationDays: 30,
  expiresAt: EXPIRY,
  deviceLimit: 2,
  operationId: op(),
  ...over,
});

const outcomeOf = (failure: ProviderFailureKind, type: OperationType) =>
  operationFailureOutcome(failure, type);

const created = async () => {
  const result = await adapter.createUser(target(), http(), createInput());
  if (!result.ok) throw new Error(`fixture create failed: ${result.failure}`);
  return result;
};

beforeAll(() => {
  bridgeTls();
});

beforeEach(async () => {
  bridge = await startFakeCustomBridge({ tls });
});

afterEach(async () => {
  await bridge.close();
});

afterAll(() => undefined);

describe('probe — GET v1/health', () => {
  it('a signed health naming the protocol is a healthy panel, with the bridge version', async () => {
    expect(await adapter.probe(target(), http())).toEqual({
      ok: true,
      providerVersion: '1.4.2',
      degraded: false,
    });
    expect(bridge.count('health')).toBe(1);
  });

  it('upstream DOWN is degraded: the secret is right and something behind the bridge is not', async () => {
    bridge.behave('health', 'upstream-down');
    expect(await adapter.probe(target(), http())).toMatchObject({ ok: true, degraded: true });
  });

  it('a wrong secret is AUTHENTICATION_FAILED (the 401 is signed with a key we do not hold)', async () => {
    expect(await adapter.probe(target('x'.repeat(40)), http())).toEqual({
      ok: false,
      failure: 'AUTHENTICATION_FAILED',
      status: 401,
    });
  });

  it('a skewed bridge clock is AUTHENTICATION_FAILED via the signed TIMESTAMP_OUT_OF_WINDOW', async () => {
    bridge.setSkewSeconds(1_000);
    expect(await adapter.probe(target(), http())).toEqual({
      ok: false,
      failure: 'AUTHENTICATION_FAILED',
      status: 401,
    });
  });

  it('an unsigned 404 (a wrong base URL) is a malformed answer, not a working panel', async () => {
    bridge.behave('health', 'unsigned-404');
    expect(await adapter.probe(target(), http())).toEqual({
      ok: false,
      failure: 'MALFORMED_RESPONSE',
      status: 404,
    });
  });

  it('a 200 with a signature that does not verify is malformed', async () => {
    bridge.behave('health', 'bad-signature');
    expect(await adapter.probe(target(), http())).toMatchObject({
      ok: false,
      failure: 'MALFORMED_RESPONSE',
    });
  });

  it('a bridge that never answers is a TIMEOUT', async () => {
    bridge.behave('health', 'hang');
    expect(await adapter.probe(target(), http(400))).toMatchObject({
      ok: false,
      failure: 'TIMEOUT',
    });
  });

  it('refuses an http:// base URL before sending anything', async () => {
    const plain = bridge.baseUrl.replace(/^https:/, 'http:');
    expect(await adapter.probe(target(BRIDGE_SECRET, plain), http())).toEqual({
      ok: false,
      failure: 'BLOCKED_TARGET',
      status: null,
    });
    expect(bridge.requests).toHaveLength(0);
  });

  it('signs the PROTOCOL path, so a bridge behind a path prefix verifies', async () => {
    await bridge.close();
    bridge = await startFakeCustomBridge({ tls, prefix: '/nexa/' });
    expect(bridge.baseUrl.endsWith('/nexa/')).toBe(true);
    expect(await adapter.probe(target(), http())).toMatchObject({ ok: true });
    expect(bridge.requests[0]).toMatchObject({ path: '/v1/health', verified: true });
  });
});

describe('createUser — POST v1/accounts', () => {
  it('creates the account and delivers the link from the signed answer', async () => {
    const result = await adapter.createUser(target(), http(), createInput());
    expect(result).toEqual({
      ok: true,
      providerUserId: null,
      delivery: { kind: 'SUBSCRIPTION_LINK', url: bridge.subscriptionUrl(REF.username) },
      usage: {
        usedBytes: 0n,
        totalBytes: 53_687_091_200n,
        expiresAt: EXPIRY,
        lastSeen: { kind: 'NEVER' },
      },
    });
    expect(bridge.accounts.get(REF.username)?.nexaRef).toBe(REF.clientId);
  });

  it('sends Bytes as strings, a seconds-precision Z timestamp, the binding and the operation id', async () => {
    const operationId = op();
    await adapter.createUser(
      target(),
      http(),
      createInput({ operationId, expiresAt: new Date('2026-11-25T08:13:20.987Z') }),
    );
    const sent = bridge.requests.find((one) => one.route === 'create');
    expect(sent?.verified).toBe(true);
    expect(sent?.body).toEqual({
      operationId,
      username: REF.username,
      nexaRef: REF.clientId,
      trafficLimitBytes: '53687091200',
      expiresAt: '2026-11-25T08:13:20Z',
      deviceLimit: 2,
    });
    // The subscription ref is a bearer capability of Nexa's own and never leaves.
    expect(sent?.rawBody).not.toContain(REF.subscriptionRef);
  });

  it('sends unlimited traffic as "0" and no expiry as null', async () => {
    await adapter.createUser(
      target(),
      http(),
      createInput({ volumeBytes: null, expiresAt: null, deviceLimit: null }),
    );
    expect(bridge.requests.find((one) => one.route === 'create')?.body).toMatchObject({
      trafficLimitBytes: '0',
      expiresAt: null,
      deviceLimit: null,
    });
  });

  it('the same operation id again is a REPLAY: answered, and nothing is created twice', async () => {
    const input = createInput();
    const first = await adapter.createUser(target(), http(), input);
    const second = await adapter.createUser(target(), http(), input);
    expect(first.ok && second.ok).toBe(true);
    expect(bridge.count('create')).toBe(2);
    expect(bridge.operations.size).toBe(1);
    expect(bridge.accounts.size).toBe(1);
  });

  it('refuses to send a create without an operation id', async () => {
    const { operationId: _omitted, ...input } = createInput();
    expect(await adapter.createUser(target(), http(), input)).toEqual({
      ok: false,
      failure: 'UNSUPPORTED_CAPABILITY',
      status: null,
    });
    expect(bridge.requests).toHaveLength(0);
  });

  it.each([
    ['hang', 'TIMEOUT'],
    ['hang-after-apply', 'TIMEOUT'],
    ['500-before-apply', 'PROVIDER_ERROR'],
    ['500-after-apply', 'PROVIDER_ERROR'],
    ['upstream-down', 'PROVIDER_ERROR'],
  ] as const)('%s is UNKNOWN for a create — never a refund', async (behaviour, kind) => {
    bridge.behave('create', behaviour);
    const result = await adapter.createUser(target(), http(400), createInput());
    expect(result).toMatchObject({ ok: false, failure: kind });
    if (result.ok) return;
    expect(outcomeOf(result.failure, 'PROVISION')).toBe('UNKNOWN');
  });

  it('a connection dropped after the create applied is UNKNOWN, and the account exists', async () => {
    bridge.behave('create', 'drop-after-apply');
    const result = await adapter.createUser(target(), http(), createInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(outcomeOf(result.failure, 'PROVISION')).toBe('UNKNOWN');
    expect(bridge.accounts.has(REF.username)).toBe(true);
  });

  it.each(['unsigned', 'bad-signature'] as const)(
    'a %s 2xx is MALFORMED_RESPONSE: UNKNOWN, and carries no provenance',
    async (behaviour) => {
      bridge.behave('create', behaviour);
      const result = await adapter.createUser(target(), http(), createInput());
      expect(result).toEqual({ ok: false, failure: 'MALFORMED_RESPONSE', status: 201 });
      if (result.ok) return;
      expect(outcomeOf(result.failure, 'PROVISION')).toBe('UNKNOWN');
    },
  );

  it('an UNSIGNED 404 is never read as anything definitive', async () => {
    bridge.behave('create', 'unsigned-404');
    const result = await adapter.createUser(target(), http(), createInput());
    expect(result).toEqual({ ok: false, failure: 'MALFORMED_RESPONSE', status: 404 });
    if (result.ok) return;
    expect(outcomeOf(result.failure, 'PROVISION')).toBe('UNKNOWN');
  });

  it('an UNKNOWN error code under a 4xx is PROVIDER_ERROR — UNKNOWN, never a refusal', async () => {
    bridge.behave('create', 'unknown-code');
    const result = await adapter.createUser(target(), http(), createInput());
    expect(result).toEqual({ ok: false, failure: 'PROVIDER_ERROR', status: 409 });
    if (result.ok) return;
    expect(outcomeOf(result.failure, 'PROVISION')).toBe('UNKNOWN');
  });

  it('a known code under the wrong status is PROVIDER_ERROR too', async () => {
    bridge.behave('create', 'wrong-status-code');
    expect(await adapter.createUser(target(), http(), createInput())).toEqual({
      ok: false,
      failure: 'PROVIDER_ERROR',
      status: 409,
    });
  });

  it('a signed 422 RULE_REFUSED is a definitive refusal: FAILED, nothing created', async () => {
    bridge.behave('create', 'rule-refused');
    const result = await adapter.createUser(target(), http(), createInput());
    expect(result).toEqual({ ok: false, failure: 'PROVIDER_REFUSED', status: 422 });
    if (result.ok) return;
    expect(outcomeOf(result.failure, 'PROVISION')).toBe('FAILED');
    expect(bridge.accounts.size).toBe(0);
  });

  it('a name already held is a signed 409 ALREADY_EXISTS: refused, and never adopted', async () => {
    bridge.seed({ username: REF.username, nexaRef: OTHER_REF });
    expect(await adapter.createUser(target(), http(), createInput())).toEqual({
      ok: false,
      failure: 'PROVIDER_REFUSED',
      status: 409,
    });
    expect(bridge.accounts.get(REF.username)?.nexaRef).toBe(OTHER_REF);
  });

  it('an operation id reused for a different account is a signed 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const operationId = op();
    await adapter.createUser(target(), http(), createInput({ operationId }));
    const reused = await adapter.createUser(
      target(),
      http(),
      createInput({ operationId, username: 'nxother1234' }),
    );
    expect(reused).toEqual({ ok: false, failure: 'PROVIDER_REFUSED', status: 409 });
    expect(bridge.accounts.has('nxother1234')).toBe(false);
  });

  it('a signed 429 is RATE_LIMITED: the bridge did nothing, so a retry is safe', async () => {
    bridge.behave('create', 'rate-limited');
    const result = await adapter.createUser(target(), http(), createInput());
    expect(result).toEqual({ ok: false, failure: 'RATE_LIMITED', status: 429 });
    if (result.ok) return;
    expect(outcomeOf(result.failure, 'PROVISION')).toBe('FAILED');
  });

  it.each([
    'non-json',
    'missing-field',
    'bytes-as-number',
    'negative',
    'leading-zero',
    'offset-timestamp',
    'unknown-status',
    'http-link',
    'wrong-username',
  ] as const satisfies readonly BadPayload[])(
    'a signed 2xx with a bad payload (%s) is MALFORMED_RESPONSE with provenance: UNKNOWN',
    async (badPayload) => {
      bridge.behave('create', { badPayload });
      const result = await adapter.createUser(target(), http(), createInput());
      expect(result).toEqual({
        ok: false,
        failure: 'MALFORMED_RESPONSE',
        status: 201,
        accepted: true,
      });
      if (result.ok) return;
      expect(outcomeOf(result.failure, 'PROVISION')).toBe('UNKNOWN');
    },
  );

  it('a success about an account bound to another ref is malformed and carries no provenance', async () => {
    bridge.behave('create', { badPayload: 'other-nexaRef' });
    expect(await adapter.createUser(target(), http(), createInput())).toEqual({
      ok: false,
      failure: 'MALFORMED_RESPONSE',
      status: 201,
    });
  });
});

describe('lookupUser / readUsage — GET v1/accounts/{username}', () => {
  it('finds the bound account, with usage, expiry, link and last connection', async () => {
    await created();
    bridge.useTraffic(REF.username, 1_073_741_824n);
    bridge.setLastConnection(REF.username, '2026-10-27T19:02:11Z');
    expect(await adapter.lookupUser(target(), http(), REF)).toEqual({
      ok: true,
      found: true,
      providerUserId: null,
      delivery: { kind: 'SUBSCRIPTION_LINK', url: bridge.subscriptionUrl(REF.username) },
      usage: {
        usedBytes: 1_073_741_824n,
        totalBytes: 53_687_091_200n,
        expiresAt: EXPIRY,
        lastSeen: { kind: 'AT', at: new Date('2026-10-27T19:02:11Z') },
      },
    });
    expect(await adapter.readUsage(target(), http(), REF)).toMatchObject({
      ok: true,
      usage: { usedBytes: 1_073_741_824n },
    });
  });

  it('a SIGNED 404 ACCOUNT_NOT_FOUND is absent', async () => {
    expect(await adapter.lookupUser(target(), http(), REF)).toEqual({ ok: true, found: false });
  });

  it('an UNSIGNED 404 is NEVER absent — a wrong base URL must not allow a second create', async () => {
    bridge.behave('get', 'unsigned-404');
    expect(await adapter.lookupUser(target(), http(), REF)).toEqual({
      ok: false,
      failure: 'MALFORMED_RESPONSE',
      status: 404,
    });
  });

  it('a 404 whose signature does not verify is never absent either', async () => {
    bridge.behave('get', 'bad-signature');
    expect(await adapter.lookupUser(target(), http(), REF)).toEqual({
      ok: false,
      failure: 'MALFORMED_RESPONSE',
      status: 404,
    });
  });

  it.each([
    ['another ref', OTHER_REF],
    ['no ref (an account not created through this protocol)', null],
  ])('an account bound to %s is a refusal: neither found nor absent', async (_label, nexaRef) => {
    bridge.seed({ username: REF.username, nexaRef });
    expect(await adapter.lookupUser(target(), http(), REF)).toEqual({
      ok: false,
      failure: 'PROVIDER_REFUSED',
      status: 409,
    });
  });

  it('upstream unavailable is PROVIDER_ERROR, not absent', async () => {
    bridge.behave('get', 'upstream-down');
    expect(await adapter.lookupUser(target(), http(), REF)).toEqual({
      ok: false,
      failure: 'PROVIDER_ERROR',
      status: 503,
    });
  });

  it('a timeout is a TIMEOUT, not absent', async () => {
    bridge.behave('get', 'hang');
    expect(await adapter.lookupUser(target(), http(400), REF)).toMatchObject({
      ok: false,
      failure: 'TIMEOUT',
    });
  });

  it.each(['missing-field', 'bytes-as-number', 'offset-timestamp', 'http-link'] as const)(
    'a bad payload (%s) is MALFORMED_RESPONSE',
    async (badPayload) => {
      await created();
      bridge.behave('get', { badPayload });
      expect(await adapter.lookupUser(target(), http(), REF)).toMatchObject({
        ok: false,
        failure: 'MALFORMED_RESPONSE',
      });
    },
  );

  it('readUsage of an account the bridge does not have is a divergence, never zero', async () => {
    expect(await adapter.readUsage(target(), http(), REF)).toEqual({
      ok: false,
      failure: 'PROVIDER_ERROR',
      status: null,
    });
  });
});

describe('applyAllowance — POST …/allowance', () => {
  const NEW_EXPIRY = new Date('2026-12-25T08:13:20.000Z');

  it('renews with ABSOLUTE targets and reads them back from the answer', async () => {
    await created();
    const operationId = op();
    const result = await adapter.applyAllowance(
      target(),
      http(),
      REF,
      { expiresAt: NEW_EXPIRY, trafficLimitBytes: 107_374_182_400n },
      { operationId },
    );
    expect(result).toMatchObject({
      ok: true,
      found: true,
      usage: { totalBytes: 107_374_182_400n, expiresAt: NEW_EXPIRY },
    });
    expect(bridge.requests.at(-1)?.body).toEqual({
      operationId,
      nexaRef: REF.clientId,
      expiresAt: '2026-12-25T08:13:20Z',
      trafficLimitBytes: '107374182400',
    });
  });

  it('an omitted field is NOT sent, so it stays as it was', async () => {
    await created();
    await adapter.applyAllowance(
      target(),
      http(),
      REF,
      { expiresAt: NEW_EXPIRY, trafficLimitBytes: null },
      { operationId: op() },
    );
    expect(bridge.requests.at(-1)?.body).not.toHaveProperty('trafficLimitBytes');
    expect(bridge.accounts.get(REF.username)?.limitBytes).toBe(53_687_091_200n);

    await adapter.applyAllowance(
      target(),
      http(),
      REF,
      { expiresAt: null, trafficLimitBytes: 1n },
      { operationId: op() },
    );
    expect(bridge.requests.at(-1)?.body).not.toHaveProperty('expiresAt');
    expect(bridge.accounts.get(REF.username)?.expiresAt).toBe('2026-12-25T08:13:20Z');
  });

  it('a lost answer, retried under the SAME operation id, is applied once', async () => {
    await created();
    const operationId = op();
    const plan = { expiresAt: NEW_EXPIRY, trafficLimitBytes: 107_374_182_400n };
    bridge.behave('allowance', '500-after-apply', 1);
    const first = await adapter.applyAllowance(target(), http(), REF, plan, { operationId });
    expect(first).toEqual({ ok: false, failure: 'PROVIDER_ERROR', status: 500 });
    if (first.ok) return;
    // An idempotent mutation: the executor retries the same operation.
    expect(outcomeOf(first.failure, 'RENEW')).toBe('FAILED');
    const retried = await adapter.applyAllowance(
      target(),
      http(),
      REF,
      // The first application wins: a replay is not re-applied, whatever it carries.
      { expiresAt: new Date('2030-01-01T00:00:00Z'), trafficLimitBytes: 1n },
      { operationId },
    );
    expect(retried).toMatchObject({ ok: true, found: true });
    expect(bridge.accounts.get(REF.username)).toMatchObject({
      expiresAt: '2026-12-25T08:13:20Z',
      limitBytes: 107_374_182_400n,
    });
  });

  it('a missing account is found: false; one bound elsewhere is refused and untouched', async () => {
    expect(
      await adapter.applyAllowance(
        target(),
        http(),
        REF,
        { expiresAt: NEW_EXPIRY, trafficLimitBytes: null },
        { operationId: op() },
      ),
    ).toEqual({ ok: true, found: false });
    bridge.seed({ username: REF.username, nexaRef: OTHER_REF, expiresAt: null });
    expect(
      await adapter.applyAllowance(
        target(),
        http(),
        REF,
        { expiresAt: NEW_EXPIRY, trafficLimitBytes: null },
        { operationId: op() },
      ),
    ).toEqual({ ok: false, failure: 'PROVIDER_REFUSED', status: 409 });
    expect(bridge.accounts.get(REF.username)?.expiresAt).toBeNull();
  });

  it('refuses without an operation id, and refuses an empty plan, sending nothing', async () => {
    expect(
      await adapter.applyAllowance(target(), http(), REF, {
        expiresAt: NEW_EXPIRY,
        trafficLimitBytes: null,
      }),
    ).toMatchObject({ ok: false, failure: 'UNSUPPORTED_CAPABILITY' });
    expect(
      await adapter.applyAllowance(
        target(),
        http(),
        REF,
        { expiresAt: null, trafficLimitBytes: null },
        { operationId: op() },
      ),
    ).toMatchObject({ ok: false, failure: 'PROVIDER_ERROR' });
    expect(bridge.requests).toHaveLength(0);
  });

  it('an unknown code is PROVIDER_ERROR and a bad payload is MALFORMED_RESPONSE', async () => {
    await created();
    bridge.behave('allowance', 'unknown-code', 1);
    expect(
      await adapter.applyAllowance(
        target(),
        http(),
        REF,
        { expiresAt: NEW_EXPIRY, trafficLimitBytes: null },
        { operationId: op() },
      ),
    ).toEqual({ ok: false, failure: 'PROVIDER_ERROR', status: 409 });
    bridge.behave('allowance', { badPayload: 'negative' }, 1);
    expect(
      await adapter.applyAllowance(
        target(),
        http(),
        REF,
        { expiresAt: NEW_EXPIRY, trafficLimitBytes: null },
        { operationId: op() },
      ),
    ).toMatchObject({ ok: false, failure: 'MALFORMED_RESPONSE' });
  });
});

describe('suspendUser / resumeUser — POST …/disable, …/enable', () => {
  it('disables and enables, reading the state back from the answer', async () => {
    await created();
    expect(await adapter.suspendUser(target(), http(), REF, { operationId: op() })).toMatchObject({
      ok: true,
      found: true,
    });
    expect(bridge.accounts.get(REF.username)?.disabled).toBe(true);
    expect(await adapter.resumeUser(target(), http(), REF, { operationId: op() })).toMatchObject({
      ok: true,
      found: true,
    });
    expect(bridge.accounts.get(REF.username)?.disabled).toBe(false);
    expect(bridge.requests.at(-1)?.body).toEqual({
      operationId: expect.any(String),
      nexaRef: REF.clientId,
    });
  });

  it('a missing account is found: false; one bound elsewhere is refused and NOT disabled', async () => {
    expect(await adapter.suspendUser(target(), http(), REF, { operationId: op() })).toEqual({
      ok: true,
      found: false,
    });
    bridge.seed({ username: REF.username, nexaRef: OTHER_REF });
    expect(await adapter.suspendUser(target(), http(), REF, { operationId: op() })).toEqual({
      ok: false,
      failure: 'PROVIDER_REFUSED',
      status: 409,
    });
    expect(bridge.accounts.get(REF.username)?.disabled).toBe(false);
  });

  it('a timeout is TIMEOUT and an unsigned answer is MALFORMED_RESPONSE', async () => {
    await created();
    bridge.behave('disable', 'hang', 1);
    expect(
      await adapter.suspendUser(target(), http(400), REF, { operationId: op() }),
    ).toMatchObject({ ok: false, failure: 'TIMEOUT' });
    bridge.behave('disable', 'unsigned', 1);
    expect(await adapter.suspendUser(target(), http(), REF, { operationId: op() })).toEqual({
      ok: false,
      failure: 'MALFORMED_RESPONSE',
      status: 200,
    });
  });

  it('refuses without an operation id, sending nothing', async () => {
    expect(await adapter.suspendUser(target(), http(), REF)).toMatchObject({
      failure: 'UNSUPPORTED_CAPABILITY',
    });
    expect(await adapter.resumeUser(target(), http(), REF)).toMatchObject({
      failure: 'UNSUPPORTED_CAPABILITY',
    });
    expect(bridge.requests).toHaveLength(0);
  });
});

describe('terminateUser — POST …/delete', () => {
  it('deletes, and a delete repeated after it is "already gone"', async () => {
    await created();
    expect(await adapter.terminateUser(target(), http(), REF, { operationId: op() })).toEqual({
      ok: true,
      wasPresent: true,
    });
    expect(bridge.accounts.has(REF.username)).toBe(false);
    expect(await adapter.terminateUser(target(), http(), REF, { operationId: op() })).toEqual({
      ok: true,
      wasPresent: false,
    });
  });

  it('an account bound to another ref is REFUSED, never "already gone", and survives', async () => {
    bridge.seed({ username: REF.username, nexaRef: OTHER_REF });
    expect(await adapter.terminateUser(target(), http(), REF, { operationId: op() })).toEqual({
      ok: false,
      failure: 'PROVIDER_REFUSED',
      status: 409,
    });
    expect(bridge.accounts.has(REF.username)).toBe(true);
  });

  it('an unsigned 404 is NOT "already gone"', async () => {
    await created();
    bridge.behave('delete', 'unsigned-404', 1);
    expect(await adapter.terminateUser(target(), http(), REF, { operationId: op() })).toEqual({
      ok: false,
      failure: 'MALFORMED_RESPONSE',
      status: 404,
    });
    expect(bridge.accounts.has(REF.username)).toBe(true);
  });

  it('5xx after applying is PROVIDER_ERROR; the retry under the same id is a replay', async () => {
    await created();
    const operationId = op();
    bridge.behave('delete', '500-after-apply', 1);
    expect(await adapter.terminateUser(target(), http(), REF, { operationId })).toEqual({
      ok: false,
      failure: 'PROVIDER_ERROR',
      status: 500,
    });
    expect(await adapter.terminateUser(target(), http(), REF, { operationId })).toEqual({
      ok: true,
      wasPresent: false,
    });
  });

  it('refuses without an operation id, sending nothing', async () => {
    expect(await adapter.terminateUser(target(), http(), REF)).toMatchObject({
      failure: 'UNSUPPORTED_CAPABILITY',
    });
    expect(bridge.requests).toHaveLength(0);
  });
});

describe('rotateSubscription — POST …/rotate-link, proven by a read', () => {
  it('rotates, and takes the new link from the READ', async () => {
    const before = await created();
    const previous = before.delivery.kind === 'SUBSCRIPTION_LINK' ? before.delivery.url : null;
    const result = await adapter.rotateSubscription(target(), http(), REF, previous, {
      operationId: op(),
    });
    expect(result).toEqual({
      ok: true,
      found: true,
      subscriptionUrl: bridge.subscriptionUrl(REF.username),
    });
    expect(result.ok && result.found && result.subscriptionUrl).not.toBe(previous);
    expect(bridge.count('get')).toBe(1);
  });

  it('a 200 whose link did not change is refused: no rotation happened', async () => {
    await created();
    bridge.behave('rotate', 'rotate-same-link', 1);
    expect(
      await adapter.rotateSubscription(
        target(),
        http(),
        REF,
        bridge.subscriptionUrl(REF.username),
        { operationId: op() },
      ),
    ).toEqual({ ok: false, failure: 'MALFORMED_RESPONSE', status: 200 });
  });

  it('a dropped answer after the rotation applied is settled by the read: rotated', async () => {
    await created();
    const previous = bridge.subscriptionUrl(REF.username);
    bridge.behave('rotate', 'drop-after-apply', 1);
    expect(
      await adapter.rotateSubscription(target(), http(), REF, previous, { operationId: op() }),
    ).toMatchObject({ ok: true, found: true });
  });

  it('a 5xx before applying is settled by the read: not rotated, the 5xx is returned', async () => {
    await created();
    bridge.behave('rotate', '500-before-apply', 1);
    expect(
      await adapter.rotateSubscription(
        target(),
        http(),
        REF,
        bridge.subscriptionUrl(REF.username),
        { operationId: op() },
      ),
    ).toEqual({ ok: false, failure: 'PROVIDER_ERROR', status: 500 });
  });

  it('a replay of the same operation id does not rotate twice', async () => {
    await created();
    const previous = bridge.subscriptionUrl(REF.username);
    const operationId = op();
    await adapter.rotateSubscription(target(), http(), REF, previous, { operationId });
    const after = bridge.subscriptionUrl(REF.username);
    expect(
      await adapter.rotateSubscription(target(), http(), REF, previous, { operationId }),
    ).toEqual({ ok: true, found: true, subscriptionUrl: after });
    expect(bridge.accounts.get(REF.username)?.linkSeq).toBe(2);
  });

  it('missing is found: false; bound elsewhere is refused; no operation id sends nothing', async () => {
    expect(
      await adapter.rotateSubscription(target(), http(), REF, null, { operationId: op() }),
    ).toEqual({ ok: true, found: false });
    bridge.seed({ username: REF.username, nexaRef: OTHER_REF });
    expect(
      await adapter.rotateSubscription(target(), http(), REF, null, { operationId: op() }),
    ).toEqual({ ok: false, failure: 'PROVIDER_REFUSED', status: 409 });
    const sent = bridge.requests.length;
    expect(await adapter.rotateSubscription(target(), http(), REF, null)).toMatchObject({
      failure: 'UNSUPPORTED_CAPABILITY',
    });
    expect(bridge.requests).toHaveLength(sent);
  });
});
