import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ActorContext } from '@nexa/contracts';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
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
});
