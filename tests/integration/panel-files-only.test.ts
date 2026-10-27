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
});
