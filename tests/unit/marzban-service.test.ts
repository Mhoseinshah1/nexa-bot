import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  canDeleteUser,
  canDisableUser,
  canEnableUser,
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

describe('the Marzban adapter — what it may NOT yet be asked to do', () => {
  it('has all three methods and is still refused, because the descriptor does not claim them', () => {
    /*
     * The intermediate state the owner's ordering requires: implement, then prove
     * against a real panel, then advertise. `canDisableUser` and its siblings require
     * the method AND the capability, so until the acceptance run adds the capabilities
     * nothing can dispatch to these methods — `decideOperability` refuses a SUSPEND
     * against a Marzban panel with CAPABILITY_UNSUPPORTED, exactly as it does for 3X-UI.
     *
     * This case is replaced, not deleted, by the commit that adds the capabilities: the
     * pairing is then asserted the other way round, against the shipped adapter.
     */
    expect(typeof adapter.suspendUser).toBe('function');
    expect(typeof adapter.resumeUser).toBe('function');
    expect(typeof adapter.terminateUser).toBe('function');

    const declared = providerDescriptor('marzban')?.capabilities ?? [];
    for (const capability of ['DISABLE_USER', 'ENABLE_USER', 'DELETE_USER']) {
      expect(declared).not.toContain(capability);
    }
    expect(canDisableUser(adapter)).toBe(false);
    expect(canEnableUser(adapter)).toBe(false);
    expect(canDeleteUser(adapter)).toBe(false);
  });
});
