import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  canAddTime,
  canAddVolume,
  canDeleteUser,
  canDisableUser,
  canEnableUser,
  canRenewUser,
  providerDescriptor,
  type CreateProviderUserInput,
  type ProviderServiceTarget,
  type ProviderUserRef,
} from '@nexa/contracts';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { MarzbanAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/marzban.adapter';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';

/**
 * The Marzban SERVICE half — create, look up, read usage, suspend, resume, terminate.
 *
 * Until this file existed there was no test of any of them. `marzban-adapter.test.ts`
 * covers authentication and the probe against an inline fake that implements two
 * endpoints; `createUser`, `lookupUser` and `readUsage` shipped in Phase 4D with
 * nothing exercising them at all, which is how the `inbounds` defect in
 * `docs/providers/marzban.md` survived a green suite.
 *
 * What this proves and what it does not: the fake is
 * `tests/support/fake-marzban.ts`, written from the pinned upstream AND corrected
 * against a panel built from it. That makes these cases a real regression net for
 * adapter drift. It still does not make them evidence about Marzban —
 * `tests/acceptance/real-panel-marzban.test.ts` is, and it runs this same adapter
 * against the binary.
 */
let panel: FakeMarzban;

const adapter = new MarzbanAdapter();

const client = (): SafeHttpClient =>
  new SafeHttpClient({
    allowLoopback: true,
    totalTimeoutMs: 2_000,
    maxResponseBytes: 256 * 1024,
    maxRetries: 0,
  });

const http = () => client().forBase(panel.baseUrl);

const target = (): ProviderServiceTarget => ({
  baseUrl: panel.baseUrl,
  credentials: {
    shape: 'USERNAME_PASSWORD',
    username: panel.username,
    password: panel.password,
  },
  activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
});

const ref = (username: string): ProviderUserRef => ({
  username,
  subscriptionRef: `sub-${username}`,
  clientId: `client-${username}`,
});

const createInput = (username: string, over: Partial<CreateProviderUserInput> = {}) =>
  ({
    ...ref(username),
    serviceId: `svc-${username}`,
    volumeBytes: null,
    durationDays: null,
    expiresAt: null,
    deviceLimit: null,
    ...over,
  }) as CreateProviderUserInput;

beforeAll(async () => {
  panel = await startFakeMarzban();
});

afterEach(() => {
  panel.reset();
});

afterAll(async () => {
  await panel.close();
});

describe('the Marzban adapter — creating an account', () => {
  it('names the operator’s inbound tags, so the account is not excluded from every inbound', async () => {
    /*
     * The regression from `docs/providers/marzban.md`. `excluded_inbounds` excludes
     * every inbound NOT named, so a create that omits the key produces an account the
     * panel reports as created and a customer cannot connect with. Asserted through the
     * SUBSCRIPTION rather than the payload, because a payload assertion would pass
     * against an adapter that sent the key with the wrong contents.
     */
    const outcome = await adapter.createUser(target(), http(), createInput('nx_a'));
    expect(outcome.ok).toBe(true);
    expect(panel.subscriptionFor('nx_a')).not.toBe('');
    expect(panel.users.get('nx_a')?.inbounds['vless']).toEqual(['VLESS TCP']);
  });

  it('reports the panel’s subscription URL made absolute against the panel’s own base', async () => {
    const outcome = await adapter.createUser(target(), http(), createInput('nx_b'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.delivery.kind).toBe('SUBSCRIPTION_LINK');
    if (outcome.delivery.kind !== 'SUBSCRIPTION_LINK') return;
    expect(outcome.delivery.url.startsWith(panel.baseUrl.replace(/\/$/, ''))).toBe(true);
    // Marzban keys by the name we chose and carries no second id that outlives it.
    expect(outcome.providerUserId).toBeNull();
  });

  it('sends an unlimited allowance as Marzban’s own zero, not as an absent field', async () => {
    await adapter.createUser(target(), http(), createInput('nx_c'));
    const created = panel.requests.find(
      (request) => request.method === 'POST' && request.path === '/api/user',
    );
    const payload = JSON.parse(created?.body ?? '{}') as Record<string, unknown>;
    expect(payload['expire']).toBe(0);
    expect(payload['data_limit']).toBe(0);
    // And it reads back as "no limit", never as an allowance of nothing.
    const usage = await adapter.readUsage(target(), http(), ref('nx_c'));
    expect(usage.ok).toBe(true);
    if (!usage.ok) return;
    expect(usage.usage.totalBytes).toBeNull();
    expect(usage.usage.expiresAt).toBeNull();
  });

  it('sends an expiry in epoch SECONDS', async () => {
    const expiresAt = new Date('2030-01-02T03:04:05.000Z');
    await adapter.createUser(target(), http(), createInput('nx_d', { expiresAt }));
    const created = panel.requests.find(
      (request) => request.method === 'POST' && request.path === '/api/user',
    );
    const payload = JSON.parse(created?.body ?? '{}') as Record<string, unknown>;
    expect(payload['expire']).toBe(Math.floor(expiresAt.getTime() / 1000));
  });

  it('routes a duplicate username to reconciliation rather than assuming anything', async () => {
    await adapter.createUser(target(), http(), createInput('nx_e'));
    const again = await adapter.createUser(target(), http(), createInput('nx_e'));
    expect(again.ok).toBe(false);
    if (again.ok) return;
    // 409 is the panel's own error, and PROVIDER_ERROR is UNKNOWN for a mutation.
    expect(again.failure).toBe('PROVIDER_ERROR');
    expect(again.status).toBe(409);
  });
});

describe('the Marzban adapter — suspend and resume', () => {
  it('disables an existing account and reports the panel’s own resulting status', async () => {
    panel.seed({ username: 'nx_s' });
    const outcome = await adapter.suspendUser(target(), http(), ref('nx_s'));
    expect(outcome).toMatchObject({ ok: true, found: true });
    expect(panel.users.get('nx_s')?.status).toBe('disabled');
  });

  it('sends the status and NOTHING else, so a suspend cannot rewrite an allowance', async () => {
    /*
     * `UserModify` applies every field that is PRESENT. An adapter that echoed the
     * service's expiry or volume here would silently reset a customer's allowance on
     * every suspend, and sending `proxies` would delete every proxy not named.
     */
    panel.seed({ username: 'nx_s2', expire: 1893456000, dataLimit: 1024 });
    await adapter.suspendUser(target(), http(), ref('nx_s2'));
    const modify = panel.requests.find((request) => request.method === 'PUT');
    expect(JSON.parse(modify?.body ?? '{}')).toEqual({ status: 'disabled' });
    expect(panel.users.get('nx_s2')?.expire).toBe(1893456000);
    expect(panel.users.get('nx_s2')?.dataLimit).toBe(1024);
  });

  it('is idempotent: suspending twice is two successes and one state', async () => {
    panel.seed({ username: 'nx_s3' });
    expect(await adapter.suspendUser(target(), http(), ref('nx_s3'))).toMatchObject({ ok: true });
    expect(await adapter.suspendUser(target(), http(), ref('nx_s3'))).toMatchObject({ ok: true });
    expect(panel.users.get('nx_s3')?.status).toBe('disabled');
  });

  it('re-enables a disabled account, and is idempotent the same way', async () => {
    panel.seed({ username: 'nx_r', status: 'disabled' });
    expect(await adapter.resumeUser(target(), http(), ref('nx_r'))).toMatchObject({
      ok: true,
      found: true,
    });
    expect(panel.users.get('nx_r')?.status).toBe('active');
    expect(await adapter.resumeUser(target(), http(), ref('nx_r'))).toMatchObject({ ok: true });
    expect(panel.users.get('nx_r')?.status).toBe('active');
  });

  it('reports an account the panel does not have as ABSENT, never as a failure', async () => {
    /*
     * `found: false` is a positive statement and the caller acts on it differently from
     * every other outcome: Nexa believes this service has an account on this panel and
     * the panel says it does not, which is a divergence an operator has to see.
     */
    const outcome = await adapter.suspendUser(target(), http(), ref('nx_missing'));
    expect(outcome).toEqual({ ok: true, found: false });
  });

  it('never reports absence because a request failed', async () => {
    panel.seed({ username: 'nx_s4' });
    panel.behaviour = 'server-error';
    const outcome = await adapter.suspendUser(target(), http(), ref('nx_s4'));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toBe('PROVIDER_ERROR');
    // Still active: nothing was applied, and nothing claimed it was.
    expect(panel.users.get('nx_s4')?.status).toBe('active');
  });

  it('refuses a 200 whose record does not carry the status that was asked for', async () => {
    /*
     * The guard that makes "the panel agreed" mean something. Without it a panel that
     * answers 200 and changes nothing reports a suspension that did not happen, and the
     * service goes SUSPENDED in Nexa while the customer keeps connecting.
     */
    panel.seed({ username: 'nx_s5' });
    panel.behaviour = 'modify-ignores-status';
    const outcome = await adapter.suspendUser(target(), http(), ref('nx_s5'));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toBe('MALFORMED_RESPONSE');
    expect(panel.users.get('nx_s5')?.status).toBe('active');
  });

  it('reports a 200 that is not JSON as malformed, not as success', async () => {
    panel.seed({ username: 'nx_s6' });
    panel.behaviour = 'modify-html';
    const outcome = await adapter.suspendUser(target(), http(), ref('nx_s6'));
    expect(outcome).toMatchObject({ ok: false, failure: 'MALFORMED_RESPONSE' });
  });

  it('keeps RATE_LIMITED separate from the panel being broken', async () => {
    panel.seed({ username: 'nx_s7' });
    panel.behaviour = 'rate-limited';
    expect(await adapter.suspendUser(target(), http(), ref('nx_s7'))).toMatchObject({
      ok: false,
      failure: 'RATE_LIMITED',
    });
    expect(await adapter.resumeUser(target(), http(), ref('nx_s7'))).toMatchObject({
      ok: false,
      failure: 'RATE_LIMITED',
    });
    expect(await adapter.terminateUser(target(), http(), ref('nx_s7'))).toMatchObject({
      ok: false,
      failure: 'RATE_LIMITED',
    });
  });

  it('never reports an authentication failure after the token exchange succeeded', async () => {
    /*
     * It would send an operator to replace a password that just worked. The fake's
     * `server-error` answers every authenticated route 500, and a 500 must not be read
     * as a credential problem.
     */
    panel.seed({ username: 'nx_s8' });
    panel.behaviour = 'server-error';
    for (const outcome of [
      await adapter.suspendUser(target(), http(), ref('nx_s8')),
      await adapter.resumeUser(target(), http(), ref('nx_s8')),
      await adapter.terminateUser(target(), http(), ref('nx_s8')),
    ]) {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.failure).not.toBe('AUTHENTICATION_FAILED');
    }
  });

  it('stops at a refused credential without touching the user routes', async () => {
    panel.seed({ username: 'nx_s9' });
    panel.behaviour = 'bad-credentials';
    expect(await adapter.suspendUser(target(), http(), ref('nx_s9'))).toMatchObject({
      ok: false,
      failure: 'AUTHENTICATION_FAILED',
    });
    expect(panel.requests.some((request) => request.method === 'PUT')).toBe(false);
  });
});

describe('the Marzban adapter — terminate', () => {
  it('deletes the account it was asked for and leaves every sibling alone', async () => {
    panel.seed({ username: 'nx_t1' });
    panel.seed({ username: 'nx_t2' });
    const outcome = await adapter.terminateUser(target(), http(), ref('nx_t1'));
    expect(outcome).toEqual({ ok: true, wasPresent: true });
    expect(panel.users.has('nx_t1')).toBe(false);
    expect(panel.users.get('nx_t2')?.status).toBe('active');
  });

  it('treats a replayed delete as a success that did no work', async () => {
    panel.seed({ username: 'nx_t3' });
    expect(await adapter.terminateUser(target(), http(), ref('nx_t3'))).toEqual({
      ok: true,
      wasPresent: true,
    });
    /*
     * A replay after a lost answer is the NORMAL case, and the goal — this account is
     * not on this panel — holds. `wasPresent` is what keeps the record able to say
     * which call did it instead of implying the second one did.
     */
    expect(await adapter.terminateUser(target(), http(), ref('nx_t3'))).toEqual({
      ok: true,
      wasPresent: false,
    });
  });

  it('does not make an English sentence load-bearing', async () => {
    /*
     * v0.8.4 answers `{"detail": "User successfully deleted"}`. Reading it would turn a
     * locale, a body-rewriting proxy or an upstream wording change into a failed
     * delete. The 2xx is the statement.
     */
    panel.seed({ username: 'nx_t4' });
    panel.behaviour = 'delete-nonjson-2xx';
    expect(await adapter.terminateUser(target(), http(), ref('nx_t4'))).toEqual({
      ok: true,
      wasPresent: true,
    });
    expect(panel.users.has('nx_t4')).toBe(false);
  });

  it('addresses the username it was given, escaped, and not a path of its own', async () => {
    /*
     * The username comes off the stored service row and never from client input, but a
     * path built by concatenation is one refactor away from being reachable. Encoding
     * it means a hostile value cannot become extra path segments.
     */
    panel.seed({ username: 'nx/../system' });
    await adapter.terminateUser(target(), http(), ref('nx/../system'));
    const deletes = panel.requests.filter((request) => request.method === 'DELETE');
    expect(deletes[0]?.path).toBe('/api/user/nx%2F..%2Fsystem');
  });
});

describe('the Marzban adapter — what it may be asked to do', () => {
  it('is callable for all three management operations, method and capability together', () => {
    /*
     * The pairing, asserted on the SHIPPED adapter rather than a stub. A descriptor
     * edit that dropped a capability, or a refactor that dropped a method, fails here.
     *
     * This case replaced one asserting the opposite. Between the commit that wrote the
     * three methods and the commit that ran the acceptance, all three were present and
     * all three were refused, because the descriptor did not claim them — which is the
     * owner's ordering made mechanical rather than remembered.
     */
    expect(canDisableUser(adapter)).toBe(true);
    expect(canEnableUser(adapter)).toBe(true);
    expect(canDeleteUser(adapter)).toBe(true);
  });

  it('is callable for all three commercial operations too', () => {
    /*
     * Three predicates over ONE method, and each asks its own capability. A descriptor
     * edit that dropped `ADD_VOLUME` would leave `canRenewUser` true and this false,
     * which is the distinction the three exist to preserve: a panel may extend a window
     * and refuse to raise a limit.
     */
    expect(canRenewUser(adapter)).toBe(true);
    expect(canAddVolume(adapter)).toBe(true);
    expect(canAddTime(adapter)).toBe(true);
  });

  it('declares each capability it implements, and nothing it does not', () => {
    const declared = providerDescriptor('marzban')?.capabilities ?? [];
    for (const capability of [
      'DISABLE_USER',
      'ENABLE_USER',
      'DELETE_USER',
      'RENEW_USER',
      'ADD_VOLUME',
      'ADD_TIME',
    ]) {
      expect(declared).toContain(capability);
    }
    // Still absent, because no code performs them.
    for (const capability of ['RESET_USAGE', 'ROTATE_SUBSCRIPTION_LINK', 'LIMIT_DEVICES']) {
      expect(declared).not.toContain(capability);
    }
  });
});

describe('the Marzban adapter — applying an allowance', () => {
  const DAY = 86_400_000;
  const future = (days: number): Date => new Date(Date.now() + days * DAY);

  it('sends an absolute expiry in SECONDS, and reports what the panel then holds', async () => {
    await adapter.createUser(target(), http(), createInput('alw-1'));
    const expiresAt = future(30);
    const outcome = await adapter.applyAllowance(target(), http(), ref('alw-1'), {
      expiresAt,
      trafficLimitBytes: null,
    });
    expect(outcome).toMatchObject({ ok: true, found: true });
    /*
     * Seconds, not milliseconds. The panel would take a millisecond value without
     * complaint and store a date in the year 58,000, so the unit is asserted against
     * the fake's own record rather than against the adapter's arithmetic.
     */
    expect(panel.users.get('alw-1')?.expire).toBe(Math.floor(expiresAt.getTime() / 1000));
  });

  it('leaves a field the plan did not buy exactly as it was', async () => {
    await adapter.createUser(
      target(),
      http(),
      createInput('alw-2', { volumeBytes: 5_000n, expiresAt: future(10) }),
    );
    /*
     * A COPY. `panel.users.get` hands back the live record, so `before` and `after`
     * would otherwise be the same object and the comparison below could not fail —
     * measured by F4F-11, which reverted the omitted-key rule and watched this case
     * stay green.
     */
    const before = { ...panel.users.get('alw-2') };
    await adapter.applyAllowance(target(), http(), ref('alw-2'), {
      expiresAt: null,
      trafficLimitBytes: 9_000n,
    });
    const after = panel.users.get('alw-2');
    expect(after?.dataLimit).toBe(9_000);
    // An omitted key is no change, never a reset — the property that lets one operation
    // carry exactly the field it bought.
    expect(after?.expire).toBe(before?.expire);
  });

  it('replays to the same two numbers', async () => {
    await adapter.createUser(target(), http(), createInput('alw-3'));
    const plan = { expiresAt: future(45), trafficLimitBytes: 7_000n };
    await adapter.applyAllowance(target(), http(), ref('alw-3'), plan);
    const once = { ...panel.users.get('alw-3') };
    await adapter.applyAllowance(target(), http(), ref('alw-3'), plan);
    const twice = panel.users.get('alw-3');
    expect(twice?.expire).toBe(once.expire);
    expect(twice?.dataLimit).toBe(once.dataLimit);
  });

  it('keeps consumption when the allowance is raised', async () => {
    panel.seed({ username: 'alw-4', status: 'limited', dataLimit: 1_000, usedTraffic: 1_000 });
    await adapter.applyAllowance(target(), http(), ref('alw-4'), {
      expiresAt: null,
      trafficLimitBytes: 3_000n,
    });
    const after = panel.users.get('alw-4');
    expect(after?.dataLimit).toBe(3_000);
    /*
     * The counter is untouched, which is why nothing here calls
     * `POST /api/user/{name}/reset`: replayed after the customer had consumed more, a
     * reset would destroy real evidence of consumption.
     */
    expect(after?.usedTraffic).toBe(1_000);
  });

  it('does not re-enable an account somebody switched off', async () => {
    panel.seed({ username: 'alw-5', status: 'disabled', dataLimit: 1_000 });
    await adapter.applyAllowance(target(), http(), ref('alw-5'), {
      expiresAt: future(30),
      trafficLimitBytes: 9_000n,
    });
    /*
     * Measured on the real panel and mirrored by the fake: neither field re-enables a
     * `disabled` account. A commercial action on a SUSPENDED service tops up an
     * allowance and leaves it suspended, so nothing afterwards may report it ACTIVE.
     */
    expect(panel.users.get('alw-5')?.status).toBe('disabled');
  });

  it('takes zero as unlimited, the sentinel this codebase already uses', async () => {
    await adapter.createUser(target(), http(), createInput('alw-6', { volumeBytes: 5_000n }));
    await adapter.applyAllowance(target(), http(), ref('alw-6'), {
      expiresAt: null,
      trafficLimitBytes: 0n,
    });
    // The panel stores 0 as SQL NULL, so unlimited is an absent value and never an
    // allowance of nothing.
    expect(panel.users.get('alw-6')?.dataLimit).toBeNull();
  });

  it('reports an absent account as absent, and creates nothing', async () => {
    const outcome = await adapter.applyAllowance(target(), http(), ref('alw-missing'), {
      expiresAt: future(1),
      trafficLimitBytes: 1n,
    });
    expect(outcome).toMatchObject({ ok: true, found: false });
    expect(panel.users.has('alw-missing')).toBe(false);
  });

  it('refuses a plan that asks for nothing, without calling the panel', async () => {
    await adapter.createUser(target(), http(), createInput('alw-7'));
    const before = panel.requests.length;
    const outcome = await adapter.applyAllowance(target(), http(), ref('alw-7'), {
      expiresAt: null,
      trafficLimitBytes: null,
    });
    expect(outcome.ok).toBe(false);
    /*
     * Not one request, not even the token exchange. An empty PUT would answer 200 and
     * be recorded as a commercial action that succeeded, so the refusal is before the
     * socket rather than after it.
     */
    expect(panel.requests.length).toBe(before);
  });

  it('reads the response rather than assuming the request succeeded', async () => {
    await adapter.createUser(target(), http(), createInput('alw-8'));
    /*
     * A 200 the adapter cannot read is a refusal, not a success.
     *
     * `modify-html` is what a misconfigured reverse proxy in front of a panel actually
     * returns: the right status code and a login page. An adapter that inferred the
     * outcome from the status would report a renewal that never happened.
     *
     * The other half of the same rule — a 200 whose record carries the OLD numbers — is
     * `appliedPlan`, and it is the case below rather than this one.
     */
    panel.behaviour = 'modify-html';
    const outcome = await adapter.applyAllowance(target(), http(), ref('alw-8'), {
      expiresAt: future(5),
      trafficLimitBytes: null,
    });
    panel.behaviour = 'healthy';
    expect(outcome).toMatchObject({ ok: false, failure: 'MALFORMED_RESPONSE' });
  });

  it('refuses a 200 whose record did not move, rather than reporting a renewal', async () => {
    await adapter.createUser(
      target(),
      http(),
      createInput('alw-9', { volumeBytes: 5_000n, expiresAt: future(3) }),
    );
    // A copy, for the reason the omitted-key case above gives.
    const before = { ...panel.users.get('alw-9') };
    /*
     * The half of the response check a faithful panel cannot exercise.
     *
     * v0.8.4 applies what it is sent, so the only way to produce a 200 that did NOT do
     * the work is to ask the fake for one. It is not a hypothetical shape: a proxy, a
     * fork, or a future Marzban that silently ignores a field it no longer honours all
     * answer exactly this way — and inferring success from the status code would record
     * a renewal that never happened, advance the service's stored allowance, and leave
     * the customer cut off on a panel that still holds yesterday's numbers.
     */
    panel.behaviour = 'modify-ignores-allowance';
    const outcome = await adapter.applyAllowance(target(), http(), ref('alw-9'), {
      expiresAt: future(33),
      trafficLimitBytes: 90_000n,
    });
    panel.behaviour = 'healthy';
    expect(outcome).toMatchObject({ ok: false, failure: 'MALFORMED_RESPONSE' });
    // And the adapter reported no usage it could not stand behind.
    expect(panel.users.get('alw-9')?.expire).toBe(before?.expire);
    expect(panel.users.get('alw-9')?.dataLimit).toBe(before?.dataLimit);
  });
});
