import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTROL_ERROR_CODES,
  PANEL_ERROR_CODES,
  PANEL_SETTING_KEYS,
  PLATFORM_ERROR_CODES,
  type ActorContext,
} from '@nexa/contracts';
import {
  auditLogs,
  outboxMessages,
  panelSettingValues,
} from '../../apps/api/src/infrastructure/persistence/schema';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Track 3 §2: PANEL-scoped settings through the shipped container — the store, the guarded
 * service and the tenant surface's refusal of a panel key, and the send-time policy the
 * caption reads.
 */
const TEMPLATE = 'panel.connection_files.caption_template';
const MODE = 'panel.connection_files.caption_mode';

describe('panel-scoped settings', () => {
  let ctx: TestContext;
  let panel: FakeRickpanel;
  let panelId: string;
  let owner: ActorContext;

  beforeAll(async () => {
    ctx = await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-ps', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Rick',
      providerType: 'rickpanel',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: {},
      idempotencyKey: 'panel-ps-create',
    });
    panelId = created.view.panel.id;
  });

  const refusalOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as { code?: string; details?: Record<string, unknown> };
    }
    throw new Error('expected a refusal');
  };

  const set = (
    key: string,
    value: unknown,
    expectedVersion: number | null,
    idem: string = randomUUID(),
  ) =>
    ctx.container.panelSettings.set(tenantA, owner, panelId, key, {
      value,
      expectedVersion,
      idempotencyKey: `ps-${idem}`,
    });

  it('lists the three keys at their registry defaults', async () => {
    const listed = await ctx.container.panelSettings.list(tenantA, owner, panelId);
    expect(listed.map((setting) => setting.key)).toEqual([...PANEL_SETTING_KEYS]);
    expect(Object.fromEntries(listed.map((setting) => [setting.key, setting.value]))).toEqual({
      'panel.connection_files.caption_mode': 'CUSTOM',
      'panel.connection_files.caption_template': null,
      'panel.connection_files.caption_placement': 'LAST_FILE',
    });
    expect(listed.every((setting) => setting.source === 'DEFAULT')).toBe(true);
  });

  it('stores a template raw, audits it and emits SettingChanged in the same write', async () => {
    const raw = '<b>{username}</b> — {sub_link}';
    const result = await set(TEMPLATE, raw, null);
    expect(result).toMatchObject({ changed: true, replayed: false });
    expect(result.setting).toMatchObject({ value: raw, source: 'PANEL', version: 1 });

    const rows = await ctx.container.database.db
      .select()
      .from(panelSettingValues)
      .where(eq(panelSettingValues.panelId, panelId));
    expect(rows.map((row) => row.value)).toEqual([raw]);

    const audit = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'panel.setting_set'), eq(auditLogs.entityId, panelId)));
    expect(audit).toHaveLength(1);
    const events = await ctx.container.database.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.aggregateId, `panel:${panelId}:${TEMPLATE}`));
    expect(events.map((event) => event.eventType)).toEqual(['SettingChanged']);

    // The send reads it back: the policy the caption is rendered from.
    const values = await ctx.container.panelSettings.list(tenantA, owner, panelId);
    expect(values.find((setting) => setting.key === TEMPLATE)?.value).toBe(raw);
  });

  it('refuses an unknown variable on the server and stores nothing', async () => {
    const refusal = await refusalOf(set(TEMPLATE, 'سلام {usrname}', null));
    expect(refusal.code).toBe(CONTROL_ERROR_CODES.INVALID_VALUE);
    expect(JSON.stringify(refusal.details)).toContain('{usrname}');
    const rows = await ctx.container.database.db.select().from(panelSettingValues);
    expect(rows).toHaveLength(0);
  });

  it('refuses a stale version, replays a key, and reports a no-op as one', async () => {
    await set(MODE, 'NONE', null, 'first');
    expect((await refusalOf(set(MODE, 'CUSTOM', null))).code).toBe(
      CONTROL_ERROR_CODES.VERSION_CONFLICT,
    );
    const replay = await set(MODE, 'NONE', null, 'first');
    expect(replay).toMatchObject({ replayed: true, changed: true });
    const noop = await set(MODE, 'NONE', 1);
    expect(noop).toMatchObject({ changed: false, replayed: false });
  });

  it('keeps the two scopes apart: a TENANT key here and a PANEL key there are unknown', async () => {
    expect((await refusalOf(set('sales.currency', 'IRT', null))).code).toBe(
      CONTROL_ERROR_CODES.UNKNOWN_KEY,
    );
    const tenantWrite = ctx.container.settingsService.set(tenantA, owner, {
      key: MODE,
      value: 'NONE',
      expectedVersion: null,
      idempotencyKey: 'tenant-panel-key',
    });
    expect((await refusalOf(tenantWrite)).code).toBe(CONTROL_ERROR_CODES.UNKNOWN_KEY);
    const tenantList = await ctx.container.settingsService.list(tenantA, owner);
    expect(tenantList.some((setting) => PANEL_SETTING_KEYS.includes(setting.key))).toBe(false);
  });

  it('charges panels.edit for a write, and keeps another tenant out', async () => {
    const operator = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'operator-ps',
        roleKeys: ['operator'],
      }),
    );
    await ctx.container.panelSettings.list(tenantA, operator, panelId);
    const denied = await refusalOf(
      ctx.container.panelSettings.set(tenantA, operator, panelId, MODE, {
        value: 'NONE',
        expectedVersion: null,
        idempotencyKey: 'ps-operator',
      }),
    );
    expect(denied.code).toBe(PLATFORM_ERROR_CODES.PERMISSION_DENIED);
    const ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-ps-b', roleKeys: ['owner'] }),
    );
    expect((await refusalOf(ctx.container.panelSettings.list(tenantB, ownerB, panelId))).code).toBe(
      PANEL_ERROR_CODES.PANEL_NOT_FOUND,
    );
    const rows = await ctx.container.database.db.select().from(panelSettingValues);
    expect(rows).toHaveLength(0);
  });
});
