import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  SUPPORT_AI_CREDENTIAL_REJECTED_CODE,
  SUPPORT_AI_DEFAULT_CONFIG,
  isNexaError,
  type ActorContext,
  type SupportAiConfigInput,
  type SupportAiOutcome,
  type SupportAiProvider,
} from '@nexa/contracts';
import { SupportAiConfigService } from '../../apps/api/src/modules/control/support-ai/application/support-ai-config.service';
import type { SupportAiAdapter } from '../../apps/api/src/modules/control/support-ai/application/ports';
import {
  DrizzleSupportAiConfigRepository,
  DrizzleSupportAiCredentialStore,
  DrizzleSupportAiRunRecorder,
} from '../../apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai.repository';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * TB4 — the support AI's configuration and keys against a real database (ADR-0034 §8).
 *
 * What runs for real: the default (OFF, no row), the permission split (configure HIGH;
 * ENTERING automatic replies CRITICAL), optimistic versioning, the one-way key, the CHECK
 * constraints, and the credential alert's transitions.
 */

const KEY = 'sk-live-super-secret-value-123';

class ScriptedAdapter implements SupportAiAdapter {
  readonly capabilities = {
    structuredOutput: true,
    vision: false,
    maxImageBytes: 0,
    imageMediaTypes: [],
  };
  next: SupportAiOutcome = {
    outcome: 'OK',
    output: {},
    usage: { inputTokens: null, outputTokens: null },
    model: 'm',
  };
  seenKeys: string[] = [];
  constructor(readonly provider: SupportAiProvider) {}
  async generate() {
    return this.next;
  }
  async testConnection(credential: { apiKey: string }) {
    this.seenKeys.push(credential.apiKey);
    return this.next;
  }
}

describe('the support AI configuration (TB4)', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let service: SupportAiConfigService;
  let openai: ScriptedAdapter;
  let keySeq = 0;
  const key = (label: string) => `${label}-${Date.now()}-${(keySeq += 1)}`;

  const assist = (overrides: Partial<SupportAiConfigInput> = {}): SupportAiConfigInput => ({
    ...SUPPORT_AI_DEFAULT_CONFIG,
    mode: 'ASSIST_ONLY',
    primary: { provider: 'OPENAI', model: 'gpt-5.5' },
    ...overrides,
  });

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
    const c = ctx.container;
    owner = adminActorFor(
      await createAdmin(c, tenantA, { username: 'owner', roleKeys: ['owner'] }),
    );
    openai = new ScriptedAdapter('OPENAI');
    service = new SupportAiConfigService({
      configs: new DrizzleSupportAiConfigRepository(c.database.db),
      credentials: new DrizzleSupportAiCredentialStore(c.database.db, c.cipher, () => c.ids.uuid()),
      runs: new DrizzleSupportAiRunRecorder(c.database.db),
      adapters: new Map<SupportAiProvider, SupportAiAdapter>([
        ['OPENAI', openai],
        ['ANTHROPIC', new ScriptedAdapter('ANTHROPIC')],
        ['ZAI', new ScriptedAdapter('ZAI')],
      ]),
      guard: c.guard,
      uow: c.uow,
      audit: c.audit,
      opsLog: c.opsLogWriter,
      sessions: c.sessions,
      idempotency: c.idempotency,
      scopeActivity: c.tenants,
      clock: c.clock,
      ids: c.ids,
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('starts every tenant OFF with no row and no key', async () => {
    const view = await service.view(tenantA, owner);
    expect(view.config).toEqual(SUPPORT_AI_DEFAULT_CONFIG);
    expect(view.config.mode).toBe('OFF');
    expect(view.version).toBe(0);
    expect(view.credentials.every((credential) => !credential.configured)).toBe(true);
    const rows = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM support_ai_configs`,
    );
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });

  it('saves a configuration under optimistic versioning', async () => {
    const first = await service.update(tenantA, owner, {
      idempotencyKey: key('a'),
      expectedVersion: null,
      config: assist(),
    });
    expect(first.version).toBe(1);
    const second = await service.update(tenantA, owner, {
      idempotencyKey: key('b'),
      expectedVersion: 1,
      config: assist({ settleDelaySeconds: 10 }),
    });
    expect(second.version).toBe(2);
    // Somebody saved meanwhile: refused, not overwritten.
    await expect(
      service.update(tenantA, owner, {
        idempotencyKey: key('c'),
        expectedVersion: 1,
        config: assist(),
      }),
    ).rejects.toSatisfy(isNexaError);
  });

  it('refuses a settle delay outside 3–30 seconds, at the schema and at the table', async () => {
    await expect(
      service.update(tenantA, owner, {
        idempotencyKey: key('a'),
        expectedVersion: null,
        config: assist({ settleDelaySeconds: 2 }),
      }),
    ).rejects.toThrow();
    await service.update(tenantA, owner, {
      idempotencyKey: key('b'),
      expectedVersion: null,
      config: assist(),
    });
    await expect(
      ctx.container.database.db.execute(
        sql`UPDATE support_ai_configs SET settle_delay_seconds = 31`,
      ),
    ).rejects.toThrow();
  });

  it('lets entering automatic replies require support_ai.auto_reply, but never leaving them', async () => {
    const admin = await createAdmin(ctx.container, tenantA, {
      username: 'cfg',
      roleKeys: ['owner'],
    });
    await ctx.container.database.db.execute(
      sql`INSERT INTO admin_permission_overrides (tenant_id, admin_id, permission_key, effect, reason, created_by_admin_id)
          VALUES (${SEED_IDS.tenantA}, ${admin.id}, 'support_ai.auto_reply', 'DENY', 'test', ${owner.id})`,
    );
    const configurer = adminActorFor(admin);
    await service.update(tenantA, configurer, {
      idempotencyKey: key('a'),
      expectedVersion: null,
      config: assist(),
    });
    await expect(
      service.update(tenantA, configurer, {
        idempotencyKey: key('b'),
        expectedVersion: 1,
        config: assist({ mode: 'AUTO_REPLY_SAFE' }),
      }),
    ).rejects.toSatisfy(isNexaError);
    // The owner may enter it…
    await service.update(tenantA, owner, {
      idempotencyKey: key('c'),
      expectedVersion: 1,
      config: assist({ mode: 'AUTO_REPLY_SAFE' }),
    });
    // …and the configurer may leave it.
    const left = await service.update(tenantA, configurer, {
      idempotencyKey: key('d'),
      expectedVersion: 2,
      config: assist(),
    });
    expect(left.config.mode).toBe('ASSIST_ONLY');
  });

  it('refuses configuration to a role without support_ai.configure', async () => {
    const support = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'sup', roleKeys: ['support'] }),
    );
    await expect(service.view(tenantA, support)).rejects.toSatisfy(isNexaError);
    await expect(
      service.setCredential(tenantA, support, 'OPENAI', { idempotencyKey: key('a'), apiKey: KEY }),
    ).rejects.toSatisfy(isNexaError);
  });

  it('stores a key one way: never in a view, an audit row or a log, and only the adapter sees it', async () => {
    await service.setCredential(tenantA, owner, 'OPENAI', {
      idempotencyKey: key('a'),
      apiKey: KEY,
    });
    const view = await service.view(tenantA, owner);
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(view.credentials.find((c) => c.provider === 'OPENAI')?.configured).toBe(true);
    const leaks = await ctx.container.database.db.execute(
      sql`SELECT (SELECT count(*) FROM audit_logs WHERE before::text LIKE ${'%' + KEY + '%'} OR after::text LIKE ${'%' + KEY + '%'})
              + (SELECT count(*) FROM operational_events WHERE context::text LIKE ${'%' + KEY + '%'})
              + (SELECT count(*) FROM support_ai_provider_credentials WHERE api_key_ciphertext LIKE ${'%' + KEY + '%'}) AS n`,
    );
    expect(Number((leaks.rows[0] as { n: number | string }).n)).toBe(0);
    await service.test(tenantA, owner, 'OPENAI', 'gpt-5.5');
    expect(openai.seenKeys).toEqual([KEY]);
  });

  it('refuses a region for a provider that has none', async () => {
    await expect(
      service.setCredential(tenantA, owner, 'OPENAI', {
        idempotencyKey: key('a'),
        apiKey: KEY,
        region: 'CHINA',
      }),
    ).rejects.toSatisfy(isNexaError);
  });

  it('a rejected test opens credential_rejected once; replacing the key closes it', async () => {
    await service.setCredential(tenantA, owner, 'OPENAI', {
      idempotencyKey: key('a'),
      apiKey: KEY,
    });
    openai.next = { outcome: 'AUTH_FAILED', quota: false, code: 'openai.http_401' };
    await service.test(tenantA, owner, 'OPENAI', 'gpt-5.5');
    await service.test(tenantA, owner, 'OPENAI', 'gpt-5.5');
    const open = async () =>
      (
        await ctx.container.database.db.execute(
          sql`SELECT count(*)::int AS n FROM operational_events WHERE code = ${SUPPORT_AI_CREDENTIAL_REJECTED_CODE} AND resolved_at IS NULL`,
        )
      ).rows[0] as { n: number };
    expect((await open()).n).toBe(1);
    await service.setCredential(tenantA, owner, 'OPENAI', {
      idempotencyKey: key('b'),
      apiKey: `${KEY}-new`,
    });
    expect((await open()).n).toBe(0);
  });

  it('deleting a key deletes the row and its breaker state', async () => {
    await service.setCredential(tenantA, owner, 'ANTHROPIC', {
      idempotencyKey: key('a'),
      apiKey: KEY,
    });
    const removed = await service.deleteCredential(tenantA, owner, 'ANTHROPIC', key('b'));
    expect(removed.removed).toBe(true);
    const view = await service.view(tenantA, owner);
    expect(view.credentials.find((c) => c.provider === 'ANTHROPIC')?.configured).toBe(false);
  });

  it('the breaker opens on the third consecutive transient failure and closes on a success', async () => {
    const store = new DrizzleSupportAiCredentialStore(
      ctx.container.database.db,
      ctx.container.cipher,
      () => ctx.container.ids.uuid(),
    );
    await service.setCredential(tenantA, owner, 'ZAI', { idempotencyKey: key('a'), apiKey: KEY });
    const now = new Date();
    expect(
      (await store.recordResult(tenantA, 'ZAI', 'TRANSIENT_FAILURE', now))?.trippedUntil,
    ).toBeNull();
    expect(
      (await store.recordResult(tenantA, 'ZAI', 'TRANSIENT_FAILURE', now))?.trippedUntil,
    ).toBeNull();
    expect(
      (await store.recordResult(tenantA, 'ZAI', 'TRANSIENT_FAILURE', now))?.trippedUntil,
    ).not.toBeNull();
    expect(await store.recordResult(tenantA, 'ZAI', 'SUCCESS', now)).toEqual({
      trippedUntil: null,
      consecutiveFailures: 0,
    });
  });

  it('records a telemetry row for a connection test, with no prompt and no key', async () => {
    await service.setCredential(tenantA, owner, 'OPENAI', {
      idempotencyKey: key('a'),
      apiKey: KEY,
    });
    await service.test(tenantA, owner, 'OPENAI', 'gpt-5.5');
    const usage = await service.usage(tenantA, owner);
    expect(usage.rows).toEqual([
      expect.objectContaining({
        provider: 'OPENAI',
        operation: 'CONNECTION_TEST',
        calls: 1,
        failures: 0,
      }),
    ]);
  });
});
