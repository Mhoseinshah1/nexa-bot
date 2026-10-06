import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  categoryButtonIconOf,
  categoryIconOf,
  type ActorContext,
  type CategoryIcons,
  type InlineButtonIcons,
} from '@nexa/contracts';
import { auditLogs, outboxMessages } from '../../apps/api/src/infrastructure/persistence/schema';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Phase 2 UX wave, Item 2 over the real settings service and tables: `bot.category_icons`.
 *
 * A category created by an operator takes decorations with no code change (the key is its
 * id); they persist and are what the bot's reader resolves; the id and the emoji are
 * validated on the write path; the write is permissioned, versioned, audited with values,
 * announced in the outbox, and the tenant's own.
 */
describe('category decorations (bot.category_icons)', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let n = 0;
  const key = (): string => `ci-${(n += 1)}-${Math.random()}`;
  const ICON = '5368324170671202286';

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-ci', roleKeys: ['owner'] }),
    );
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const db = () => ctx.container.database.db;
  const createCategory = async (name: string) =>
    ctx.container.productCategories.create(tenantA, owner, {
      idempotencyKey: key(),
      draft: { name, description: null, emoji: '🌐', sortOrder: 5 },
    });
  const setIcons = (actor: ActorContext, value: unknown, expectedVersion: number | null) =>
    ctx.container.settingsService.set(tenantA, actor, {
      key: 'bot.category_icons',
      value,
      expectedVersion,
      idempotencyKey: key(),
    });
  const resolved = (scope = tenantA) =>
    ctx.container.settingsResolver.valueOf<CategoryIcons>(scope, 'bot.category_icons');

  it('decorates a category created after the release; before, after and both are read back', async () => {
    const before = await createCategory('Gaming');
    const after = await createCategory('Streaming');
    const both = await createCategory('VPN');
    const plain = await createCategory('Other');
    const value = {
      [before.id]: { before: ICON },
      [after.id]: { after: '🔥' },
      [both.id]: { before: ICON, after: '🇮🇷' },
    };
    expect((await setIcons(owner, value, null)).changed).toBe(true);
    const read = await ctx.container.settingsService.get(tenantA, owner, 'bot.category_icons');
    expect(read.value).toEqual(value);
    expect(read.version).toBe(1);
    const icons = await resolved();
    const generic = await ctx.container.settingsResolver.valueOf<InlineButtonIcons>(
      tenantA,
      'bot.inline_button_icons',
    );
    expect(categoryButtonIconOf(before.id, icons, generic)).toBe(ICON);
    expect(categoryIconOf(after.id, icons)).toEqual({ before: null, after: '🔥' });
    expect(categoryIconOf(both.id, icons)).toEqual({ before: ICON, after: '🇮🇷' });
    // Neither: nothing of its own, and no generic icon out of the box.
    expect(categoryIconOf(plain.id, icons)).toEqual({ before: null, after: null });
    expect(categoryButtonIconOf(plain.id, icons, generic)).toBeNull();
  });

  it('removing one decoration keeps the other; removing both is removing the key', async () => {
    const fresh = await createCategory('VPN');
    await setIcons(owner, { [fresh.id]: { before: ICON, after: '🔥' } }, null);
    await setIcons(owner, { [fresh.id]: { after: '🔥' } }, 1);
    expect(categoryIconOf(fresh.id, await resolved())).toEqual({ before: null, after: '🔥' });
    await setIcons(owner, {}, 2);
    expect(await resolved()).toEqual({});
  });

  it('keeps the icons of an id whose category was deleted, harmlessly', async () => {
    const gone = '0190a5d6-1c2b-7e3f-8a4b-5c6d7e8f9aff';
    await setIcons(owner, { [gone]: { after: '🔥' } }, null);
    expect(await resolved()).toEqual({ [gone]: { after: '🔥' } });
  });

  it('refuses an invalid id and an invalid after emoji, and writes nothing', async () => {
    const fresh = await createCategory('VPN');
    for (const entry of [
      { before: 'abc' },
      { before: '' },
      { before: '🔥' },
      { before: '1'.repeat(33) },
      { after: '<b>🔥</b>' },
      { after: 'hot' },
      { after: '🔥'.repeat(9) },
      { after: '🔥\n' },
      {},
      { before: ICON, html: '<b>x</b>' },
    ]) {
      await expect(setIcons(owner, { [fresh.id]: entry }, null)).rejects.toMatchObject({
        code: 'control.invalid_value',
      });
    }
    expect(await resolved()).toEqual({});
  });

  it('refuses a stale version rather than overwriting a colleague', async () => {
    const fresh = await createCategory('VPN');
    await setIcons(owner, { [fresh.id]: { after: '🔥' } }, null);
    await expect(setIcons(owner, { [fresh.id]: { after: '⭐' } }, null)).rejects.toMatchObject({
      code: 'control.version_conflict',
    });
    expect(await resolved()).toEqual({ [fresh.id]: { after: '🔥' } });
  });

  it("is the tenant's own: tenant B reads none of tenant A's decorations", async () => {
    const fresh = await createCategory('VPN');
    await setIcons(owner, { [fresh.id]: { before: ICON, after: '🔥' } }, null);
    expect(await resolved(tenantB)).toEqual({});
    const ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-ci-b', roleKeys: ['owner'] }),
    );
    const readB = await ctx.container.settingsService.get(tenantB, ownerB, 'bot.category_icons');
    expect(readB.value).toEqual({});
    expect(readB.version).toBeNull();
  });

  it('is refused without settings.edit, and the refusal is audited', async () => {
    const technical = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'technical-ci',
        roleKeys: ['technical'],
      }),
    );
    const fresh = await createCategory('VPN');
    await expect(setIcons(technical, { [fresh.id]: { before: ICON } }, null)).rejects.toMatchObject(
      { kind: 'PERMISSION_DENIED' },
    );
    expect(await resolved()).toEqual({});
    const denied = await db()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'settings.set'), eq(auditLogs.result, 'DENIED')));
    expect(denied.length).toBe(1);
  });

  it('audits the change with values and announces it in the outbox', async () => {
    const fresh = await createCategory('VPN');
    await setIcons(owner, { [fresh.id]: { before: ICON } }, null);
    const [audit] = await db()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'settings.set'), eq(auditLogs.result, 'SUCCESS')));
    expect(audit?.entityId).toBe('bot.category_icons');
    expect(audit?.before).toMatchObject({ value: {}, source: 'DEFAULT' });
    expect(audit?.after).toMatchObject({
      value: { [fresh.id]: { before: ICON } },
      source: 'TENANT',
    });
    const events = await db()
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.aggregateId, 'bot.category_icons'));
    expect(events.map((event) => event.eventType)).toEqual(['SettingChanged']);
  });
});
