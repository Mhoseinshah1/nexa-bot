import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { ActorContext } from '@nexa/contracts';
import {
  settingValues,
  templateOverrides,
} from '../../apps/api/src/infrastructure/persistence/schema';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Two tenants, deterministically, and what happens when two administrators
 * write at once.
 *
 * A cross-tenant test with one tenant seeded proves nothing, so every case here
 * writes as A and reads as B, or the reverse. The concurrency cases drive the
 * services rather than the repositories, because the guarantee under test is
 * the one an administrator experiences: the second save is refused rather than
 * silently discarding the first.
 */
describe('control-plane isolation and concurrency', () => {
  let ctx: TestContext;
  let ownerA: ActorContext;
  let ownerB: ActorContext;

  let counter = 0;
  const key = () => `iso-${(counter += 1)}-${Date.now()}`;

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
    ownerA = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-a', roleKeys: ['owner'] }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-b', roleKeys: ['owner'] }),
    );
  });

  afterAll(async () => {
    await ctx?.close();
  });

  describe('settings', () => {
    it('keeps one tenant’s value invisible to the other', async () => {
      await ctx.container.settingsService.set(tenantA, ownerA, {
        key: 'ops.notifications.max_attempts',
        value: 7,
        expectedVersion: null,
        idempotencyKey: key(),
      });

      const seenByB = await ctx.container.settingsService.get(
        tenantB,
        ownerB,
        'ops.notifications.max_attempts',
      );
      // B sees the DEFAULT, not A's value and not an error.
      expect(seenByB.value).toBe(5);
      expect(seenByB.source).toBe('DEFAULT');
    });

    it('lets both tenants hold different values for one key', async () => {
      await ctx.container.settingsService.set(tenantA, ownerA, {
        key: 'ops.notifications.max_attempts',
        value: 7,
        expectedVersion: null,
        idempotencyKey: key(),
      });
      await ctx.container.settingsService.set(tenantB, ownerB, {
        key: 'ops.notifications.max_attempts',
        value: 2,
        expectedVersion: null,
        idempotencyKey: key(),
      });

      const rows = await ctx.container.database.db.select().from(settingValues);
      expect(rows).toHaveLength(2);
      expect(
        (await ctx.container.settingsService.get(tenantA, ownerA, 'ops.notifications.max_attempts'))
          .value,
      ).toBe(7);
      expect(
        (await ctx.container.settingsService.get(tenantB, ownerB, 'ops.notifications.max_attempts'))
          .value,
      ).toBe(2);
    });

    it('refuses tenant B’s administrator acting in tenant A’s scope', async () => {
      // The scope comes from the session, never from the request — but if it
      // ever did, this is what would stop it: the permission resolver finds no
      // roles for that administrator in that tenant.
      await expect(
        ctx.container.settingsService.set(tenantA, ownerB, {
          key: 'ops.notifications.max_attempts',
          value: 9,
          expectedVersion: null,
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
    });

    it('refuses the second of two concurrent first writes', async () => {
      // Both read "unset", both submit expectedVersion null. Exactly one may
      // win; the other must be told, not silently dropped.
      const attempts = await Promise.allSettled([
        ctx.container.settingsService.set(tenantA, ownerA, {
          key: 'ops.notifications.max_attempts',
          value: 3,
          expectedVersion: null,
          idempotencyKey: key(),
        }),
        ctx.container.settingsService.set(tenantA, ownerA, {
          key: 'ops.notifications.max_attempts',
          value: 4,
          expectedVersion: null,
          idempotencyKey: key(),
        }),
      ]);

      const rejected = attempts.filter((a) => a.status === 'rejected');
      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'control.version_conflict',
      });
    });

    it('refuses a write built on a version that has moved', async () => {
      await ctx.container.settingsService.set(tenantA, ownerA, {
        key: 'ops.notifications.max_attempts',
        value: 3,
        expectedVersion: null,
        idempotencyKey: key(),
      });
      await ctx.container.settingsService.set(tenantA, ownerA, {
        key: 'ops.notifications.max_attempts',
        value: 4,
        expectedVersion: 1,
        idempotencyKey: key(),
      });

      await expect(
        ctx.container.settingsService.set(tenantA, ownerA, {
          key: 'ops.notifications.max_attempts',
          value: 5,
          expectedVersion: 1,
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({ code: 'control.version_conflict' });
    });

    it('replays an idempotency key instead of writing twice', async () => {
      const idempotencyKey = key();
      const first = await ctx.container.settingsService.set(tenantA, ownerA, {
        key: 'ops.notifications.max_attempts',
        value: 3,
        expectedVersion: null,
        idempotencyKey,
      });
      const replay = await ctx.container.settingsService.set(tenantA, ownerA, {
        key: 'ops.notifications.max_attempts',
        value: 3,
        expectedVersion: null,
        idempotencyKey,
      });

      expect(first.replayed).toBe(false);
      expect(replay.replayed).toBe(true);
      // One row, one version. The replay did not increment anything.
      expect(replay.setting.version).toBe(first.setting.version);
    });
  });

  describe('templates', () => {
    const templateKey = 'bot.ping.reply';

    it('keeps one tenant’s override out of the other’s rendering', async () => {
      await ctx.container.templatesService.set(tenantA, ownerA, {
        key: templateKey,
        body: 'A: {correlationId}',
        expectedVersion: null,
        idempotencyKey: key(),
      });

      expect(
        await ctx.container.templateResolver.render(tenantA, templateKey, { correlationId: 'x' }),
      ).toBe('A: x');
      // B renders the built-in default, which still contains the placeholder.
      const forB = await ctx.container.templateResolver.render(tenantB, templateKey, {
        correlationId: 'x',
      });
      expect(forB).not.toBe('A: x');
      expect(forB).toContain('x');
    });

    it('numbers revisions per tenant, not globally', async () => {
      await ctx.container.templatesService.set(tenantA, ownerA, {
        key: templateKey,
        body: 'A: {correlationId}',
        expectedVersion: null,
        idempotencyKey: key(),
      });
      const b = await ctx.container.templatesService.set(tenantB, ownerB, {
        key: templateKey,
        body: 'B: {correlationId}',
        expectedVersion: null,
        idempotencyKey: key(),
      });

      // B's first override is B's revision 1, whatever A has done.
      expect(b.revision).toBe(1);
    });

    it('shows one tenant nothing of the other’s revision history', async () => {
      await ctx.container.templatesService.set(tenantA, ownerA, {
        key: templateKey,
        body: 'A: {correlationId}',
        expectedVersion: null,
        idempotencyKey: key(),
      });
      expect(
        await ctx.container.templatesService.revisions(tenantB, ownerB, templateKey),
      ).toHaveLength(0);
    });

    it('refuses the second of two concurrent edits', async () => {
      const attempts = await Promise.allSettled([
        ctx.container.templatesService.set(tenantA, ownerA, {
          key: templateKey,
          body: 'first {correlationId}',
          expectedVersion: null,
          idempotencyKey: key(),
        }),
        ctx.container.templatesService.set(tenantA, ownerA, {
          key: templateKey,
          body: 'second {correlationId}',
          expectedVersion: null,
          idempotencyKey: key(),
        }),
      ]);

      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
      expect(
        (attempts.find((a) => a.status === 'rejected') as PromiseRejectedResult).reason,
      ).toMatchObject({ code: 'control.version_conflict' });

      // And exactly one override row exists, with revision 1. A rolled-back
      // transaction must not leave a revision behind claiming a number.
      const rows = await ctx.container.database.db
        .select()
        .from(templateOverrides)
        .where(
          and(
            eq(templateOverrides.tenantId, tenantA.tenantId),
            eq(templateOverrides.templateKey, templateKey),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(
        await ctx.container.templatesService.revisions(tenantA, ownerA, templateKey),
      ).toHaveLength(1);
    });

    it('refuses a revert built on a stale version', async () => {
      await ctx.container.templatesService.set(tenantA, ownerA, {
        key: templateKey,
        body: 'one {correlationId}',
        expectedVersion: null,
        idempotencyKey: key(),
      });
      await ctx.container.templatesService.set(tenantA, ownerA, {
        key: templateKey,
        body: 'two {correlationId}',
        expectedVersion: 1,
        idempotencyKey: key(),
      });

      await expect(
        ctx.container.templatesService.revert(tenantA, ownerA, {
          key: templateKey,
          expectedVersion: 1,
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({ code: 'control.version_conflict' });
    });

    it('continues revision numbering after a revert', async () => {
      // Numbering comes from the revision table, not from the override row, so
      // removing the override cannot make two different bodies share a number.
      await ctx.container.templatesService.set(tenantA, ownerA, {
        key: templateKey,
        body: 'one {correlationId}',
        expectedVersion: null,
        idempotencyKey: key(),
      });
      await ctx.container.templatesService.revert(tenantA, ownerA, {
        key: templateKey,
        expectedVersion: 1,
        idempotencyKey: key(),
      });
      const third = await ctx.container.templatesService.set(tenantA, ownerA, {
        key: templateKey,
        body: 'three {correlationId}',
        expectedVersion: null,
        idempotencyKey: key(),
      });

      expect(third.revision).toBe(3);
      const history = await ctx.container.templatesService.revisions(tenantA, ownerA, templateKey);
      expect(history.map((entry) => entry.revision)).toEqual([3, 2, 1]);
      expect(history.map((entry) => entry.action)).toEqual(['SET', 'REVERT', 'SET']);
    });

    it('falls back to the default when overrides are switched off, without losing them', async () => {
      await ctx.container.templatesService.set(tenantA, ownerA, {
        key: templateKey,
        body: 'A: {correlationId}',
        expectedVersion: null,
        idempotencyKey: key(),
      });
      await ctx.container.featureFlags.set(tenantA, ownerA, {
        key: 'template_overrides',
        enabled: false,
        expectedVersion: null,
        idempotencyKey: key(),
        confirmKey: 'template_overrides',
        reason: 'A bad override is going out; fall back while we fix it.',
      });

      // The message reverts to the default…
      expect(
        await ctx.container.templateResolver.render(tenantA, templateKey, { correlationId: 'x' }),
      ).not.toBe('A: x');

      // …and the override is still there, still editable, and says why it is
      // not being applied.
      const view = await ctx.container.templatesService.get(tenantA, ownerA, templateKey);
      expect(view.overrideBody).toBe('A: {correlationId}');
      expect(view.overrideSuppressed).toBe(true);
      expect(view.source).toBe('DEFAULT');
    });
  });

  describe('feature flags', () => {
    it('keeps one tenant’s state invisible to the other', async () => {
      await ctx.container.featureFlags.set(tenantA, ownerA, {
        key: 'ops_notifications',
        enabled: true,
        expectedVersion: null,
        idempotencyKey: key(),
        confirmKey: 'ops_notifications',
        reason: 'Enabling for tenant A only.',
      });

      expect(await ctx.container.featureFlagResolver.isEnabled(tenantA, 'ops_notifications')).toBe(
        true,
      );
      expect(await ctx.container.featureFlagResolver.isEnabled(tenantB, 'ops_notifications')).toBe(
        false,
      );
    });

    it('refuses the second of two concurrent toggles', async () => {
      const toggle = (reason: string) =>
        ctx.container.featureFlags.set(tenantA, ownerA, {
          key: 'ops_notifications',
          enabled: true,
          expectedVersion: null,
          idempotencyKey: key(),
          confirmKey: 'ops_notifications',
          reason,
        });

      const attempts = await Promise.allSettled([toggle('first'), toggle('second')]);
      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
      expect(
        (attempts.find((a) => a.status === 'rejected') as PromiseRejectedResult).reason,
      ).toMatchObject({ code: 'control.version_conflict' });
    });
  });

  describe('background work holds no surface powers', () => {
    it('refuses a SYSTEM_JOB actor on every control-plane read', async () => {
      // SYSTEM_JOB holds `maintenance.run` and nothing else. A job that needs
      // configuration uses the unguarded resolver, which has no actor at all —
      // it does not borrow a surface's permissions.
      const job: ActorContext = {
        type: 'SYSTEM_JOB',
        id: null,
        label: 'test-job',
        surface: 'WORKER',
        correlationId: 'test-correlation' as never,
      };

      await expect(ctx.container.settingsService.list(tenantA, job)).rejects.toMatchObject({
        kind: 'PERMISSION_DENIED',
      });
      await expect(ctx.container.templatesService.list(tenantA, job)).rejects.toMatchObject({
        kind: 'PERMISSION_DENIED',
      });
      await expect(ctx.container.opsLogService.list(tenantA, job)).rejects.toMatchObject({
        kind: 'PERMISSION_DENIED',
      });

      // And the resolver, which is the path a job actually uses, still works
      // and is still scoped to the tenant it was given.
      expect(
        await ctx.container.settingsResolver.valueOf(tenantA, 'ops.notifications.max_attempts'),
      ).toBe(5);
    });
  });
});
