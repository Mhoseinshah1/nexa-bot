import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLogs,
  operationalEvents,
  panelCredentials,
} from '../../apps/api/src/infrastructure/persistence/schema';
import { CANARY, startFake3xUi, type Fake3xUi, type Fake3xUiOptions } from '../support/fake-3xui';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type SeededAdmin,
  type TestContext,
} from './harness';

/**
 * A Sanaei / 3X-UI panel end to end: the real service, the real repository, the
 * real credential store, the real database, the real `SafeHttpClient`, and a
 * deterministic fake 3X-UI on a real socket.
 *
 * The unit suite proves the adapter speaks v3.7.0. This one proves the things
 * that only exist once a panel is a row: which credential the resolver picks
 * and what happens when the chosen one is wrong, that a ciphertext cannot be
 * moved between panels or tenants, that a real secret never surfaces in a
 * response, an event or an audit record, and that the accepted probe
 * orchestration — the per-panel claim and the tenant-wide budget — still
 * bounds a provider that authenticates differently.
 */

let ctx: TestContext;
let owner: SeededAdmin;
let ownerB: SeededAdmin;
let fake: Fake3xUi | null = null;

const TOKENS = {
  [CANARY.token]: 'admin',
  'monitor-token-cccccccccccc': 'monitor',
} as const;

let seq = 0;
const key = (): string => `sanaei-int-${(seq += 1)}`;

beforeEach(async () => {
  ctx ??= await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
  await ctx.reset();
  owner = await createAdmin(ctx.container, tenantA, {
    username: 'owner_sanaei_a',
    roleKeys: ['owner'],
  });
  ownerB = await createAdmin(ctx.container, tenantB, {
    username: 'owner_sanaei_b',
    roleKeys: ['owner'],
  });
});

afterEach(async () => {
  await fake?.close();
  fake = null;
});

afterAll(async () => {
  await ctx?.close();
});

/**
 * A panel at 127.0.0.2, not 127.0.0.1.
 *
 * The container's real URL policy denies the hostnames in DATABASE_URL and
 * REDIS_URL, and in this environment that is 127.0.0.1. Binding elsewhere on
 * loopback is not a way around the policy — it is the production case, and
 * these tests run against the SAME policy a deployment uses rather than a
 * relaxed one: a self-hosted panel in private space is reachable while this
 * installation's own data services are refused.
 */
async function panel(options: Fake3xUiOptions = {}): Promise<Fake3xUi> {
  fake = await startFake3xUi({ host: '127.0.0.2', ...options });
  return fake;
}

const create = (
  admin: SeededAdmin,
  scope: typeof tenantA,
  baseUrl: string,
  credentials?: Record<string, string>,
  name = 'Sanaei panel',
) =>
  ctx.container.panels.create(scope, adminActorFor(admin), {
    name,
    providerType: 'sanaei',
    baseUrl,
    idempotencyKey: key(),
    ...(credentials === undefined ? {} : { credentials }),
  });

const test = (admin: SeededAdmin, scope: typeof tenantA, panelId: string) =>
  ctx.container.panels.testConnection(scope, adminActorFor(admin), panelId, {
    idempotencyKey: key(),
  });

// ===========================================================================
// Credential selection
// ===========================================================================
describe('a Sanaei panel chooses its authentication mode deterministically', () => {
  it('uses the API token even when a username and password are also configured', async () => {
    // ALL THREE credentials, deliberately. With only a token configured, both
    // orderings of the resolver pick the token, so a panel like that cannot
    // tell a correct precedence from a reversed one — and the precedence is
    // the most security-relevant decision in the resolver.
    const server = await panel({ tokens: TOKENS });
    const { view } = await create(owner, tenantA, server.baseUrl, {
      apiToken: CANARY.token,
      username: CANARY.username,
      password: CANARY.password,
    });

    const result = await test(owner, tenantA, view.panel.id);
    expect(result.view.health).not.toBeNull();
    expect(result.view.health?.state).toBe('HEALTHY');
    expect(result.view.health?.providerVersion).toBe('3.7.0');
    // Bearer mode: one request, carrying the token, and no login at all.
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.headers['authorization']).toBe(`Bearer ${CANARY.token}`);
    expect(server.requests.map((r) => r.path)).not.toContain('/login');
    expect(JSON.stringify(server.requests)).not.toContain(CANARY.password);
  });

  it('uses username and password when no token is configured', async () => {
    const server = await panel();
    const { view } = await create(owner, tenantA, server.baseUrl, {
      username: CANARY.username,
      password: CANARY.password,
    });

    const result = await test(owner, tenantA, view.panel.id);
    expect(result.view.health?.state).toBe('HEALTHY');
    expect(server.requests.map((r) => r.path.replace(/^\//, ''))).toEqual([
      'csrf-token',
      'getTwoFactorEnable',
      'login',
      'panel/api/server/status',
    ]);
  });

  it('NEVER falls back from a wrong API token to the password', async () => {
    // The escalation this rule exists to prevent: an operator configured a
    // token, the token is wrong, and a fallback would silently authenticate
    // with the more powerful credential they did not point at this job.
    const server = await panel({ tokens: TOKENS });
    const { view } = await create(owner, tenantA, server.baseUrl, {
      apiToken: 'a-token-that-is-not-accepted',
      username: CANARY.username,
      password: CANARY.password,
    });

    const result = await test(owner, tenantA, view.panel.id);
    expect(result.view.health?.state).toBe('AUTH_FAILED');
    expect(result.view.health?.failure).toBe('AUTHENTICATION_FAILED');
    // One request, and no login was ever attempted.
    expect(server.requests).toHaveLength(1);
    expect(server.requests.map((r) => r.path)).not.toContain('/login');
    expect(JSON.stringify(server.requests)).not.toContain(CANARY.password);
  });

  it('records a wrong session password as AUTH_FAILED, never as degraded', async () => {
    // The health row is where an operator reads what to do, and the two answers
    // are opposite instructions: DEGRADED says the credentials are fine and
    // something else is wrong, AUTH_FAILED says replace them. A login that
    // returns HTTP 200 with success:false must land on the second — falsification
    // showed the unit suite catching that inversion alone, which left the layer
    // that actually writes the row unprotected.
    const server = await panel();
    const { view } = await create(owner, tenantA, server.baseUrl, {
      username: CANARY.username,
      password: 'the-wrong-password-entirely',
    });

    const result = await test(owner, tenantA, view.panel.id);
    expect(result.view.health?.state).toBe('AUTH_FAILED');
    expect(result.view.health?.failure).toBe('AUTHENTICATION_FAILED');
    expect(result.view.health?.state).not.toBe('DEGRADED');
    // It stopped at the login: no status read followed.
    expect(server.requests.map((r) => r.path.replace(/^\//, ''))).toEqual([
      'csrf-token',
      'getTwoFactorEnable',
      'login',
    ]);
  });

  it('refuses before contacting anything when no usable credential exists', async () => {
    const server = await panel({ tokens: TOKENS });
    // A username with no password is not a usable pair.
    const { view } = await create(owner, tenantA, server.baseUrl, {
      username: CANARY.username,
    });
    await expect(test(owner, tenantA, view.panel.id)).rejects.toMatchObject({
      code: 'panel.credentials_missing',
    });
    expect(server.requests).toHaveLength(0);
  });

  it('records a 2FA panel as AUTH_FAILED with the interaction kind, having sent no credential', async () => {
    const server = await panel({ twoFactorEnabled: true });
    const { view } = await create(owner, tenantA, server.baseUrl, {
      username: CANARY.username,
      password: CANARY.password,
    });

    const result = await test(owner, tenantA, view.panel.id);
    expect(result.view.health?.state).toBe('AUTH_FAILED');
    expect(result.view.health?.failure).toBe('AUTHENTICATION_REQUIRES_INTERACTION');
    expect(JSON.stringify(server.requests)).not.toContain(CANARY.password);
  });
});

// ===========================================================================
// Secrets
// ===========================================================================
describe('a Sanaei panel keeps its credentials sealed and unquotable', () => {
  it('never returns a credential, and reports only that one is configured', async () => {
    const server = await panel({ tokens: TOKENS });
    const { view } = await create(owner, tenantA, server.baseUrl, { apiToken: CANARY.token });
    const result = await test(owner, tenantA, view.panel.id);

    for (const payload of [view, result.view]) {
      const text = JSON.stringify(payload);
      expect(text).not.toContain(CANARY.token);
      expect(text).not.toContain('ciphertext');
    }
    expect(view.credentials.apiTokenSetAt).toBeInstanceOf(Date);
  });

  it('does not leak a reflected secret into health, events or audit', async () => {
    // A hostile panel that echoes the token back in its status body.
    const server = await panel({ tokens: TOKENS, behaviour: 'status-reflects-token' });
    const { view } = await create(owner, tenantA, server.baseUrl, { apiToken: CANARY.token });
    const result = await test(owner, tenantA, view.panel.id);

    expect(result.view.health?.state).toBe('HEALTHY');
    // Read from the tables directly: what matters is what was STORED, not what
    // a reader would choose to project.
    const audits = await ctx.container.database.db.select().from(auditLogs);
    const events = await ctx.container.database.db.select().from(operationalEvents);
    const everything = JSON.stringify({ result, audits, events });
    expect(everything).not.toContain(CANARY.token);
  });

  it('refuses an api_token ciphertext moved to another panel', async () => {
    const server = await panel({ tokens: TOKENS });
    const source = await create(owner, tenantA, server.baseUrl, { apiToken: CANARY.token }, 'Src');
    const target = await create(owner, tenantA, server.baseUrl, undefined, 'Dst');

    const [row] = await ctx.container.database.db
      .select()
      .from(panelCredentials)
      .where(eq(panelCredentials.panelId, source.view.panel.id));

    // Written directly, as an attacker holding the database would.
    await ctx.container.database.db.insert(panelCredentials).values({
      panelId: target.view.panel.id,
      tenantId: tenantA.tenantId,
      apiTokenCiphertext: row?.apiTokenCiphertext ?? null,
      apiTokenKeyId: row?.apiTokenKeyId ?? null,
      apiTokenSetAt: new Date(),
    });

    // The envelope is bound to (purpose, tenant, panel); a different panel is a
    // different context and the unwrap fails rather than authenticating.
    await expect(test(owner, tenantA, target.view.panel.id)).rejects.toThrow();
    // And it failed BEFORE the network: the unwrap happens first, so a stolen
    // ciphertext never becomes an outbound authentication attempt.
    expect(server.requests).toHaveLength(0);
  });

  it('refuses an api_token ciphertext moved to another tenant', async () => {
    const server = await panel({ tokens: TOKENS });
    const source = await create(owner, tenantA, server.baseUrl, { apiToken: CANARY.token }, 'Src');
    const target = await create(ownerB, tenantB, server.baseUrl, undefined, 'Dst B');

    const [row] = await ctx.container.database.db
      .select()
      .from(panelCredentials)
      .where(eq(panelCredentials.panelId, source.view.panel.id));

    await ctx.container.database.db.insert(panelCredentials).values({
      panelId: target.view.panel.id,
      tenantId: tenantB.tenantId,
      apiTokenCiphertext: row?.apiTokenCiphertext ?? null,
      apiTokenKeyId: row?.apiTokenKeyId ?? null,
      apiTokenSetAt: new Date(),
    });

    await expect(test(ownerB, tenantB, target.view.panel.id)).rejects.toThrow();
  });
});

// ===========================================================================
// The accepted probe orchestration still applies
// ===========================================================================
describe('a Sanaei panel is bound by the same probe orchestration as any other', () => {
  it('replays the per-panel cooldown instead of probing again', async () => {
    const server = await panel({ tokens: TOKENS });
    const { view } = await create(owner, tenantA, server.baseUrl, { apiToken: CANARY.token });

    const first = await test(owner, tenantA, view.panel.id);
    const second = await test(owner, tenantA, view.panel.id);
    expect(first.probed).toBe(true);
    expect(second.probed).toBe(false);
    // The replay sent nothing: one probe, one request.
    expect(server.requests).toHaveLength(1);
  });

  it('cannot be used to escape the tenant-wide budget by alternating credentials', async () => {
    // Replacing a credential legitimately bypasses the stale per-config
    // cooldown — that is the point of the cooldown being configuration-aware.
    // The tenant-wide bucket is what still bounds it, and this provider's two
    // auth modes must not be a way around that.
    const server = await panel({ tokens: TOKENS });
    const { view } = await create(owner, tenantA, server.baseUrl, { apiToken: CANARY.token });
    const panelId = view.panel.id;

    let probes = 0;
    let limited = 0;
    for (let round = 0; round < 40; round += 1) {
      // Alternate the token, so every attempt is a fresh configuration.
      await ctx.container.panels.setCredentials(tenantA, adminActorFor(owner), panelId, {
        credentials: { apiToken: round % 2 === 0 ? CANARY.token : 'monitor-token-cccccccccccc' },
        idempotencyKey: key(),
      });
      try {
        const result = await test(owner, tenantA, panelId);
        if (result.probed) probes += 1;
      } catch (error) {
        if ((error as { code?: string }).code === 'panel.probe_limited') limited += 1;
        else throw error;
      }
    }

    // The default bucket is 30 real probes per five minutes, and the clock does
    // not move inside this test, so the refusals begin and never stop.
    expect(probes).toBeLessThanOrEqual(30);
    expect(limited).toBeGreaterThan(0);
    expect(probes + limited).toBe(40);
    // What the panel actually saw matches what Nexa believes it permitted.
    expect(server.requests).toHaveLength(probes);
  });
});
