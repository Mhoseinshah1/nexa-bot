import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { customerActionVerdict, resolvePanelPolicy, type ActorContext } from '@nexa/contracts';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * R11 A4: «فقط فایل، بدون لینک ساب» is a per-panel option, off by default, accepted only for
 * a panel whose provider hands over connection files, and audited with before and after.
 * Real database, real panel write path.
 */
describe('panel option: files only, no subscription link', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  const FILES = '01a0c400-0000-7000-8000-00000000000a';
  const NO_FILES = '01a0c400-0000-7000-8000-00000000000b';
  let n = 0;
  const key = () => `files-only-key-${(n += 1)}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-fo', roleKeys: ['owner'] }),
    );
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${FILES}, ${tenantA.tenantId}, 'Files', 'rickpanel', 'https://files.example.test', 'ACTIVE'),
             (${NO_FILES}, ${tenantA.tenantId}, 'Plain', 'sanaei', 'https://plain.example.test', 'ACTIVE')`);
  });

  const setOption = (panelId: string, filesOnlyDelivery: boolean) =>
    ctx.container.panels.update(tenantA, owner, panelId, {
      filesOnlyDelivery,
      idempotencyKey: key(),
    });

  const stored = async (panelId: string): Promise<boolean> =>
    (await ctx.container.panels.get(tenantA, owner, panelId)).panel.filesOnlyDelivery;

  const setFilesAction = (customerEnabled: boolean, expectedRevision = 0) =>
    ctx.container.panelAdvanced.updatePolicy(tenantA, owner, FILES, {
      policy: {
        delivery: { mode: 'CARD_WITH_QR' },
        actions: { SUBSCRIPTION_FILES: { customerEnabled } },
      },
      expectedRevision,
      idempotencyKey: key(),
    });

  it('is off by default, for a new column on an existing panel', async () => {
    expect(await stored(FILES)).toBe(false);
    expect(await stored(NO_FILES)).toBe(false);
  });

  it('switches on for a panel whose provider hands over files, and back off', async () => {
    await setOption(FILES, true);
    expect(await stored(FILES)).toBe(true);
    await setOption(FILES, false);
    expect(await stored(FILES)).toBe(false);
  });

  it('refuses it for a panel whose provider hands over no files, storing nothing', async () => {
    await expect(setOption(NO_FILES, true)).rejects.toMatchObject({
      code: 'panel.files_only_unsupported',
    });
    expect(await stored(NO_FILES)).toBe(false);
    const audits = await ctx.container.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'panel.update' AND entity_id = ${NO_FILES}`,
    );
    expect(audits.rows[0]?.n).toBe(0);
  });

  it('always allows switching it off, even on a panel that cannot have it on', async () => {
    await ctx.container.database.db.execute(
      sql`UPDATE panels SET files_only_delivery = true WHERE id = ${NO_FILES}`,
    );
    await setOption(NO_FILES, false);
    expect(await stored(NO_FILES)).toBe(false);
  });

  it('refuses switching on when the saved policy disables customer files', async () => {
    await setFilesAction(false);
    await expect(setOption(FILES, true)).rejects.toMatchObject({
      code: 'panel.files_only_policy_conflict',
      details: { reason: 'POLICY_DISABLED' },
    });
    expect(await stored(FILES)).toBe(false);
  });

  it('refuses turning customer files off on a files-only panel, including concurrent edits', async () => {
    const results = await Promise.allSettled([setOption(FILES, true), setFilesAction(false)]);
    expect(results.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((one) => one.status === 'rejected')).toMatchObject({
      reason: { code: 'panel.files_only_policy_conflict' },
    });
    const advanced = await ctx.container.panelAdvanced.advanced(tenantA, owner, FILES);
    const action = customerActionVerdict(
      resolvePanelPolicy(advanced.policy.policy),
      'SUBSCRIPTION_FILES',
    );
    expect(await stored(FILES)).toBe(action.allowed);
  });

  it('repairs a legacy conflict by enabling files while keeping the link hidden', async () => {
    const disabled = await setFilesAction(false);
    await ctx.container.database.db.execute(
      sql`UPDATE panels SET files_only_delivery = true WHERE id = ${FILES}`,
    );
    const view = await ctx.container.panelAdvanced.advanced(tenantA, owner, FILES);
    expect(view.registry.find((one) => one.row === 'SUBSCRIPTION_FILES')?.customer).toEqual({
      available: false,
      blocker: 'POLICY_DISABLED',
    });
    const repaired = await setFilesAction(true, disabled.advanced.policy.revision);
    expect(repaired.changed).toBe(true);
    expect(await stored(FILES)).toBe(true);
  });

  it('fails closed on an unreadable policy and permits an explicit change away from files-only', async () => {
    await setOption(FILES, true);
    await setFilesAction(true);
    await ctx.container.database.db.execute(
      sql`UPDATE panel_policies SET policy = '{"unreadable":true}'::jsonb WHERE panel_id = ${FILES}`,
    );
    await expect(setOption(FILES, true)).rejects.toMatchObject({
      code: 'panel.files_only_policy_conflict',
      details: { reason: 'POLICY_UNREADABLE' },
    });
    expect(await stored(FILES)).toBe(true);
    await setOption(FILES, false);
    expect(await stored(FILES)).toBe(false);
  });

  it('does not resolve a files-only conflict against another tenant’s panel', async () => {
    const outsider = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'outside-fo', roleKeys: ['owner'] }),
    );
    await expect(
      ctx.container.panelAdvanced.updatePolicy(tenantB, outsider, FILES, {
        policy: {
          delivery: { mode: 'CARD_WITH_QR' },
          actions: { SUBSCRIPTION_FILES: { customerEnabled: false } },
        },
        expectedRevision: 0,
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: 'panel.not_found' });
    expect(await stored(FILES)).toBe(false);
  });

  it('audits the change with the value before and after, and only when it changed', async () => {
    await setOption(FILES, true);
    await setOption(FILES, true);
    await setOption(FILES, false);
    const audits = await ctx.container.database.db.execute<{
      before: { filesOnlyDelivery: boolean };
      after: { filesOnlyDelivery: boolean };
    }>(sql`SELECT before, after FROM audit_logs
            WHERE action = 'panel.update' AND entity_id = ${FILES} ORDER BY occurred_at, id`);
    expect(
      audits.rows.map((row) => [row.before.filesOnlyDelivery, row.after.filesOnlyDelivery]),
    ).toEqual([
      [false, true],
      [true, false],
    ]);
  });

  it('replays a retried request with the same key without a second write', async () => {
    const k = key();
    const body = { filesOnlyDelivery: true, idempotencyKey: k };
    await ctx.container.panels.update(tenantA, owner, FILES, body);
    await ctx.container.panels.update(tenantA, owner, FILES, body);
    const audits = await ctx.container.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'panel.update' AND entity_id = ${FILES}`,
    );
    expect(audits.rows[0]?.n).toBe(1);
  });

  it('refuses an actor without panels.edit', async () => {
    const reader = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'viewer-fo', roleKeys: ['support'] }),
    );
    await expect(
      ctx.container.panels.update(tenantA, reader, FILES, {
        filesOnlyDelivery: true,
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
    expect(await stored(FILES)).toBe(false);
  });

  // ---- «نوع بارکد» (R11 A4, second part) ---------------------------------------------

  const qrOf = async (panelId: string) => {
    const { panel } = await ctx.container.panels.get(tenantA, owner, panelId);
    return { kind: panel.qrKind, minutes: panel.singboxIntervalMinutes };
  };

  it('QR kind defaults to the plain link with a 360-minute sing-box interval', async () => {
    expect(await qrOf(FILES)).toEqual({ kind: 'SUB_LINK', minutes: 360 });
    expect(await qrOf(NO_FILES)).toEqual({ kind: 'SUB_LINK', minutes: 360 });
  });

  it('sets the QR kind and a custom interval on a RickPanel, audited with before and after', async () => {
    await ctx.container.panels.update(tenantA, owner, FILES, {
      qrKind: 'BOTH',
      singboxIntervalMinutes: 90,
      idempotencyKey: key(),
    });
    expect(await qrOf(FILES)).toEqual({ kind: 'BOTH', minutes: 90 });
    const audits = await ctx.container.database.db.execute<{
      before: { qrKind: string; singboxIntervalMinutes: number };
      after: { qrKind: string; singboxIntervalMinutes: number };
    }>(sql`SELECT before, after FROM audit_logs
            WHERE action = 'panel.update' AND entity_id = ${FILES} ORDER BY occurred_at, id`);
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]?.before).toMatchObject({
      qrKind: 'SUB_LINK',
      singboxIntervalMinutes: 360,
    });
    expect(audits.rows[0]?.after).toMatchObject({ qrKind: 'BOTH', singboxIntervalMinutes: 90 });
  });

  it('refuses a QR kind or an interval for a panel that is not a RickPanel, storing nothing', async () => {
    for (const body of [
      { qrKind: 'SINGBOX' as const },
      { qrKind: 'BOTH' as const },
      { singboxIntervalMinutes: 60 },
    ]) {
      await expect(
        ctx.container.panels.update(tenantA, owner, NO_FILES, { ...body, idempotencyKey: key() }),
      ).rejects.toMatchObject({ code: 'panel.qr_kind_unsupported' });
    }
    expect(await qrOf(NO_FILES)).toEqual({ kind: 'SUB_LINK', minutes: 360 });
  });

  it('accepts the values a non-RickPanel already holds, so a form can send every field back', async () => {
    await ctx.container.panels.update(tenantA, owner, NO_FILES, {
      qrKind: 'SUB_LINK',
      singboxIntervalMinutes: 360,
      idempotencyKey: key(),
    });
    expect(await qrOf(NO_FILES)).toEqual({ kind: 'SUB_LINK', minutes: 360 });
  });

  it('refuses an interval outside 1..10080 minutes, a fraction and an unknown kind', async () => {
    for (const body of [
      { singboxIntervalMinutes: 0 },
      { singboxIntervalMinutes: 10_081 },
      { singboxIntervalMinutes: 1.5 },
      { qrKind: 'NOPE' },
    ]) {
      await expect(
        ctx.container.panels.update(tenantA, owner, FILES, {
          ...body,
          idempotencyKey: key(),
        } as never),
      ).rejects.toMatchObject({ code: 'panel.request_invalid' });
    }
    expect(await qrOf(FILES)).toEqual({ kind: 'SUB_LINK', minutes: 360 });
  });

  it('the database refuses a kind or interval the service would have', async () => {
    await expect(
      ctx.container.database.db.execute(
        sql`UPDATE panels SET qr_kind = 'NOPE' WHERE id = ${FILES}`,
      ),
    ).rejects.toThrow();
    await expect(
      ctx.container.database.db.execute(
        sql`UPDATE panels SET singbox_interval_minutes = 0 WHERE id = ${FILES}`,
      ),
    ).rejects.toThrow();
  });

  // ---- «نام پروفایل در sing-box» -----------------------------------------------------

  const nameOf = async (panelId: string) => {
    const { panel } = await ctx.container.panels.get(tenantA, owner, panelId);
    return { mode: panel.singboxNameMode, custom: panel.singboxNameCustom };
  };

  it('profile name defaults to «پیش‌فرض (نام دامنه)» with no text', async () => {
    expect(await nameOf(FILES)).toEqual({ mode: 'DEFAULT', custom: null });
  });

  it('stores a trimmed custom name on a RickPanel and audits before and after', async () => {
    await ctx.container.panels.update(tenantA, owner, FILES, {
      singboxNameMode: 'CUSTOM',
      singboxNameCustom: '  اشتراک {username}  ',
      idempotencyKey: key(),
    });
    expect(await nameOf(FILES)).toEqual({ mode: 'CUSTOM', custom: 'اشتراک {username}' });
    const audits = await ctx.container.database.db.execute<{
      before: { singboxNameMode: string; singboxNameCustom: string | null };
      after: { singboxNameMode: string; singboxNameCustom: string | null };
    }>(sql`SELECT before, after FROM audit_logs
            WHERE action = 'panel.update' AND entity_id = ${FILES} ORDER BY occurred_at, id`);
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]?.before).toMatchObject({
      singboxNameMode: 'DEFAULT',
      singboxNameCustom: null,
    });
    expect(audits.rows[0]?.after).toMatchObject({
      singboxNameMode: 'CUSTOM',
      singboxNameCustom: 'اشتراک {username}',
    });
  });

  it('an empty custom text is stored as none; USERNAME and DEFAULT round-trip', async () => {
    await ctx.container.panels.update(tenantA, owner, FILES, {
      singboxNameMode: 'CUSTOM',
      singboxNameCustom: '   ',
      idempotencyKey: key(),
    });
    expect(await nameOf(FILES)).toEqual({ mode: 'CUSTOM', custom: null });
    await ctx.container.panels.update(tenantA, owner, FILES, {
      singboxNameMode: 'USERNAME',
      idempotencyKey: key(),
    });
    expect((await nameOf(FILES)).mode).toBe('USERNAME');
    await ctx.container.panels.update(tenantA, owner, FILES, {
      singboxNameMode: 'DEFAULT',
      idempotencyKey: key(),
    });
    expect(await nameOf(FILES)).toEqual({ mode: 'DEFAULT', custom: null });
  });

  it('refuses a text with a line break or over 64 characters, storing nothing', async () => {
    for (const text of ['سلام\nدنیا', 'x'.repeat(65)]) {
      await expect(
        ctx.container.panels.update(tenantA, owner, FILES, {
          singboxNameMode: 'CUSTOM',
          singboxNameCustom: text,
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({ code: 'panel.request_invalid' });
    }
    expect(await nameOf(FILES)).toEqual({ mode: 'DEFAULT', custom: null });
  });

  it('refuses a profile name for a panel that is not a RickPanel; the default is always accepted', async () => {
    await expect(
      ctx.container.panels.update(tenantA, owner, NO_FILES, {
        singboxNameMode: 'USERNAME',
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: 'panel.qr_kind_unsupported' });
    await ctx.container.panels.update(tenantA, owner, NO_FILES, {
      singboxNameMode: 'DEFAULT',
      singboxNameCustom: null,
      idempotencyKey: key(),
    });
    expect(await nameOf(NO_FILES)).toEqual({ mode: 'DEFAULT', custom: null });
  });

  it('the database refuses a mode, a line break or an over-long text', async () => {
    for (const set of [
      sql`singbox_name_mode = 'NOPE'`,
      sql`singbox_name_custom = E'a\nb'`,
      sql`singbox_name_custom = ${'x'.repeat(65)}`,
      sql`singbox_name_custom = ''`,
    ]) {
      await expect(
        ctx.container.database.db.execute(sql`UPDATE panels SET ${set} WHERE id = ${FILES}`),
      ).rejects.toThrow();
    }
  });
});
