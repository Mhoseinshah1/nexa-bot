import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { isNexaError, PLATFORM_ERROR_CODES, type TenantContext } from '@nexa/contracts';
import { BotBootstrapService } from '../../apps/api/src/modules/platform/tenancy/application/bot-bootstrap.service';
import {
  DrizzleBotInstanceRepository,
  DrizzleTenantRepository,
} from '../../apps/api/src/modules/platform/tenancy/infrastructure/drizzle-tenant.repository';
import { botInstances } from '../../apps/api/src/infrastructure/persistence/schema';
import { createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * One Telegram bot, one row — held by the database, not by a service.
 *
 * `refuseRepointing` asks a related question and cannot answer this one: it
 * compares a supplied token against the tenant's OWN bot, and a second tenant
 * has none to compare against. `bot_instances_username_key` looked like it
 * covered the gap and does not, which is the whole finding: a username is
 * changed in BotFather at will and the stored copy goes stale the moment it is
 * (OQ-TG-02), so bootstrapping a second tenant with the same token AFTER a
 * rename collides with nothing.
 *
 * What that costs is not a duplicate row. Telegram keeps one webhook per bot, so
 * the second registration MOVES the delivery and the first tenant goes on
 * reporting `ready` for a URL that receives nothing.
 *
 * Against a real database, because the rule is a partial unique index. A fake
 * repository would assert the fake.
 */
describe('a Telegram bot belongs to one tenant', () => {
  let ctx: TestContext;

  const SAME_BOT = '8123456789';

  /** The service with Telegram faked and everything below it real. */
  const bootstrap = (username: string): BotBootstrapService =>
    new BotBootstrapService({
      uow: ctx.container.uow,
      bots: new DrizzleBotInstanceRepository(
        ctx.container.database.db,
        ctx.container.cipher,
      ) as never,
      scopeActivity: new DrizzleTenantRepository(ctx.container.database.db) as never,
      audit: ctx.container.audit,
      clock: ctx.container.clock,
      ids: ctx.container.ids,
      telegram: {
        // `identify` answers with the SAME numeric id and a DIFFERENT username —
        // the post-rename state, which is what slips past the username index.
        identify: async () => ({ outcome: 'IDENTIFIED', botId: SAME_BOT, username }) as never,
        registerWebhook: async () => ({ outcome: 'REGISTERED' }) as never,
      } as never,
      // A value of Telegram's own alphabet and past the schema's minimum. The test
      // config does not set one, and the service refuses a short secret on purpose.
      webhookSecret: () => 'integration-webhook-secret-not-a-real-one',
      webhookEnabled: () => true,
    });

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
    // The seed gives both tenants a bot instance already, and this is about the
    // FIRST one: `findBootstrapTarget` would otherwise find the seeded row and
    // reconcile it, so nothing would ever be inserted and the constraint would
    // never be reached. Cleared rather than worked around, so both tenants start
    // in the state a fresh install is actually in.
    await ctx.container.database.db.delete(botInstances);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('refuses a second tenant binding the same bot, even under a new username', async () => {
    const first = tenantA as TenantContext;
    const second = tenantB as TenantContext;

    await bootstrap('acme_bot').execute(first, {
      token: `${SAME_BOT}:AAH-first`,
      publicBaseUrl: 'https://bot.example.com',
    });

    // The rename: same bot, new name, so the username index sees no collision.
    const attempt = bootstrap('acme_support_bot').execute(second, {
      token: `${SAME_BOT}:AAH-second`,
      publicBaseUrl: 'https://bot.example.com',
    });

    await expect(attempt).rejects.toSatisfy(
      (error: unknown) =>
        isNexaError(error) &&
        error.code === PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_BOT_ALREADY_BOUND,
    );

    // Named, not a bare 23505 out through the CLI as a stack trace.
    await expect(attempt).rejects.toThrowError(/already configured for another tenant/);

    // And the refusal left exactly one binding: the first tenant's, untouched.
    const rows = await ctx.container.database.db
      .select()
      .from(botInstances)
      .where(eq(botInstances.telegramBotId, SAME_BOT));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(first.tenantId);
    expect(rows[0]?.username).toBe('acme_bot');
  });

  it('names the collision when a LEGACY row learns an id another row holds', async () => {
    /*
     * The second writer of `telegram_bot_id`, and only the first was translated.
     *
     * Two rows predating migration 0038 can hold credentials for the same bot —
     * the username index never stopped that, which is why 0041 exists. The first
     * reconciliation fills its id; the second reaches the UPDATE and collides.
     * That path emitted a raw 23505, so the CLI printed a stack trace and the
     * installer fell through to the webhook summary whose suggested retry
     * repeats it exactly.
     */
    const first = tenantA as TenantContext;
    const second = tenantB as TenantContext;

    // Two legacy rows: same bot, no identity recorded, different usernames.
    for (const [scope, username] of [
      [first, 'acme_bot'],
      [second, 'acme_support_bot'],
    ] as const) {
      await new DrizzleBotInstanceRepository(
        ctx.container.database.db,
        ctx.container.cipher,
      ).createFromBootstrap(
        scope,
        {
          id: ctx.container.ids.uuid() as never,
          username,
          token: `${SAME_BOT}:AAH-${username}`,
          now: new Date(),
        } as never,
        undefined,
      );
    }
    // Clear the identities the create path recorded, which is the shape a row
    // written before 0038 actually has.
    await ctx.container.database.db.update(botInstances).set({ telegramBotId: null });

    await bootstrap('acme_bot').execute(first, {
      token: null,
      publicBaseUrl: 'https://bot.example.com',
    });

    // The SECOND row's own username, which is the rename scenario: if both runs
    // reported the same name the UPDATE would collide on
    // `bot_instances_username_key` instead, and that is a genuinely different
    // mistake this refusal must not claim.
    await expect(
      bootstrap('acme_support_bot').execute(second, {
        token: null,
        publicBaseUrl: 'https://bot.example.com',
      }),
    ).rejects.toThrowError(/already configured for another tenant/);
  });

  it('still lets the tenant that owns the bot reconcile it', async () => {
    // The other half. A constraint that refused the owner's own rerun would be
    // the same defect from the other side — and a rerun is the documented
    // recovery path for a webhook that did not register.
    const first = tenantA as TenantContext;
    await bootstrap('acme_bot').execute(first, {
      token: `${SAME_BOT}:AAH-first`,
      publicBaseUrl: 'https://bot.example.com',
    });
    const again = await bootstrap('acme_bot').execute(first, {
      token: null,
      publicBaseUrl: 'https://bot.example.com',
    });
    expect(again.kind).toBe('ALREADY_COMPLETE');
  });
});
