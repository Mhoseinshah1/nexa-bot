import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  categoryButtonStyleOf,
  type ActorContext,
  type CategoryColors,
  type InlineButtonStyles,
} from '@nexa/contracts';
import { auditLogs, outboxMessages } from '../../apps/api/src/infrastructure/persistence/schema';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * UX Batch 01, item 2 over the real settings service and tables: `bot.category_colors`.
 *
 * A category created by an operator gets a colour with no code change (the key is its id);
 * the colour persists and is what the bot's reader resolves; the palette is enforced on the
 * write path; the write is permissioned, audited with values, and announced in the outbox.
 */
describe('category colours (bot.category_colors)', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let n = 0;
  const key = (): string => `cc-${(n += 1)}-${Math.random()}`;

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-cc', roleKeys: ['owner'] }),
    );
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const db = () => ctx.container.database.db;
  const createCategory = async (name: string) =>
    ctx.container.productCategories.create(tenantA, owner, {
      idempotencyKey: key(),
      draft: { name, description: null, emoji: null, sortOrder: 5 },
    });
  const setColors = (actor: ActorContext, value: unknown, expectedVersion: number | null) =>
    ctx.container.settingsService.set(tenantA, actor, {
      key: 'bot.category_colors',
      value,
      expectedVersion,
      idempotencyKey: key(),
    });
  const resolved = () =>
    ctx.container.settingsResolver.valueOf<CategoryColors>(tenantA, 'bot.category_colors');

  it('colours a category created after the release, and the bot reads the colour back', async () => {
    const fresh = await createCategory('Gaming');
    const other = await createCategory('Streaming');
    const result = await setColors(owner, { [fresh.id]: 'success' }, null);
    expect(result.changed).toBe(true);

    // Persisted: a fresh read (what a refresh shows) and the bot's own reader agree.
    const read = await ctx.container.settingsService.get(tenantA, owner, 'bot.category_colors');
    expect(read.value).toEqual({ [fresh.id]: 'success' });
    expect(read.version).toBe(1);
    const colors = await resolved();
    const styles = await ctx.container.settingsResolver.valueOf<InlineButtonStyles>(
      tenantA,
      'bot.inline_buttons',
    );
    expect(categoryButtonStyleOf(fresh.id, colors, styles)).toBe('success');
    // No colour of its own: the generic category button's style, `default` out of the box.
    expect(categoryButtonStyleOf(other.id, colors, styles)).toBe('default');
  });

  it('keeps a colour on an inactive category, and an id of a deleted one harmlessly', async () => {
    const kept = await createCategory('Old');
    const gone = '0190a5d6-1c2b-7e3f-8a4b-5c6d7e8f9aff';
    await setColors(owner, { [kept.id]: 'danger', [gone]: 'primary' }, null);
    await ctx.container.productCategories.deactivate(tenantA, owner, {
      idempotencyKey: key(),
      categoryId: kept.id,
    });
    expect(await resolved()).toEqual({ [kept.id]: 'danger', [gone]: 'primary' });
  });

  it('refuses a colour outside the palette, and writes nothing', async () => {
    const fresh = await createCategory('VPN');
    await expect(setColors(owner, { [fresh.id]: '#00ff00' }, null)).rejects.toMatchObject({
      code: 'control.invalid_value',
    });
    await expect(setColors(owner, { [fresh.id]: 'green' }, null)).rejects.toMatchObject({
      code: 'control.invalid_value',
    });
    expect(await resolved()).toEqual({});
  });

  it('refuses a stale version rather than overwriting a colleague', async () => {
    const fresh = await createCategory('VPN');
    await setColors(owner, { [fresh.id]: 'success' }, null);
    await expect(setColors(owner, { [fresh.id]: 'danger' }, null)).rejects.toMatchObject({
      code: 'control.version_conflict',
    });
    expect(await resolved()).toEqual({ [fresh.id]: 'success' });
  });

  it('is refused without settings.edit, and the refusal is audited', async () => {
    const technical = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'technical-cc',
        roleKeys: ['technical'],
      }),
    );
    const fresh = await createCategory('VPN');
    await expect(setColors(technical, { [fresh.id]: 'success' }, null)).rejects.toMatchObject({
      kind: 'PERMISSION_DENIED',
    });
    expect(await resolved()).toEqual({});
    const denied = await db()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'settings.set'), eq(auditLogs.result, 'DENIED')));
    expect(denied.length).toBe(1);
  });

  it('audits the change with values and announces it in the outbox', async () => {
    const fresh = await createCategory('VPN');
    await setColors(owner, { [fresh.id]: 'primary' }, null);
    const [audit] = await db()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'settings.set'), eq(auditLogs.result, 'SUCCESS')));
    expect(audit?.entityId).toBe('bot.category_colors');
    expect(audit?.before).toMatchObject({ value: {}, source: 'DEFAULT' });
    expect(audit?.after).toMatchObject({ value: { [fresh.id]: 'primary' }, source: 'TENANT' });
    const events = await db()
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.aggregateId, 'bot.category_colors'));
    expect(events.map((event) => event.eventType)).toEqual(['SettingChanged']);
  });
});
