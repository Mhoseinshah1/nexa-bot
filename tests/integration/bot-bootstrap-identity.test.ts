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
  const bootstrap = (username: string): BotBootstrapService => bootstrapFor(SAME_BOT, username);

  /**
   * The same service, for a bot that is NOT `SAME_BOT`.
   *
   * Needed by the username-collision case, which is about the OTHER unique index:
   * two different bots claiming one name. Every other case here is about one bot
   * and two tenants, so they keep the shorter spelling.
   */
  const bootstrapFor = (botId: string, username: string): BotBootstrapService =>
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
      /*
       * The stub is cast, so the COMPILER does not keep it in step with the port.
       *
       * 4H added `registerCommands` and this object went on typechecking and started
       * throwing `is not a function` at run time in three cases here. The cast is kept
       * because the real gateway reaches Telegram and these tests must not, but every
       * method the port declares is now present — an `as never` stub is a promise the
       * test makes on its own behalf and has to keep by hand.
       *
       * It happened AGAIN in 4I, with `commandsRevision`, in six cases. Same file, same
       * cast, same class of failure, and the comment above had already named it. That is
       * worth recording rather than quietly fixing twice: the cost of the cast is a
       * run-time break every time the port grows, and the only thing standing between
       * this file and a silent one is that every method here is called on every path.
       */
      telegram: {
        // `identify` answers with the SAME numeric id and a DIFFERENT username —
        // the post-rename state, which is what slips past the username index.
        identify: async () => ({ outcome: 'IDENTIFIED', botId, username }) as never,
        registerWebhook: async () => ({ outcome: 'REGISTERED' }) as never,
        // The command menu. Answering `true` is the ordinary case; the bootstrap
        // service's own unit test covers a refusal, which must not fail an install.
        registerCommands: async () => true,
        // Constant: nothing here is about the menu, and a fresh bootstrap
        // registers it once whatever this answers.
        commandsRevision: () => 'integration-revision',
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
    // And the FRESH-INSERT remedy, which is right here and wrong on the legacy
    // fill path below: this tenant's row rolled back, so it has nothing, and a
    // second bot in BotFather genuinely resolves it.
    await expect(attempt).rejects.toThrowError(/Use a separate bot for this tenant/);
    await expect(attempt).rejects.not.toThrowError(/OQ-TG-01/);

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
    const attempt = bootstrap('acme_support_bot').execute(second, {
      token: null,
      publicBaseUrl: 'https://bot.example.com',
    });
    await expect(attempt).rejects.toThrowError(/already configured for another tenant/);

    /*
     * `OQ-TG-04` item 5. One code, two situations, and until 4I one sentence:
     * "Use a separate bot for this tenant." That is right from the fresh INSERT,
     * where the row rolled back. It is wrong HERE — this tenant already holds a
     * legacy row AND an encrypted token for the duplicated bot, and no operation
     * in this release replaces a stored credential, so reconciliation resolves
     * that same token and hits the same violation for ever.
     */
    await expect(attempt).rejects.not.toThrowError(/Use a separate bot for this tenant/);
    await expect(attempt).rejects.toThrowError(/OQ-TG-01/);
    await expect(attempt).rejects.toThrowError(/Decide which tenant keeps this bot/);
  });

  /*
   * `OQ-TG-04` item 10. The OTHER constraint on this table, which had no
   * translation at all and reached the CLI as a raw PostgreSQL 23505.
   *
   * Two DIFFERENT bots, one username. That is a rename nobody reconciled — a
   * name freed in BotFather and taken by another bot, while the first row still
   * stores it — and it is not the bot being bound twice, which is why it gets
   * its own code rather than the already-bound one. The comment on
   * `rethrowAlreadyBound` has argued that since before either branch existed.
   */
  it('names a stale username collision instead of leaking a raw 23505', async () => {
    const first = tenantA as TenantContext;
    const second = tenantB as TenantContext;

    await bootstrap('acme_bot').execute(first, {
      token: `${SAME_BOT}:AAH-first`,
      publicBaseUrl: 'https://bot.example.com',
    });

    // A different bot id entirely, so `bot_instances_telegram_bot_id_key` is not
    // what fires — the SAME username is, which is the point.
    const OTHER_BOT = '9987654321';
    const attempt = bootstrapFor(OTHER_BOT, 'acme_bot').execute(second, {
      token: `${OTHER_BOT}:AAH-second`,
      publicBaseUrl: 'https://bot.example.com',
    });

    await expect(attempt).rejects.toSatisfy(
      (error: unknown) =>
        isNexaError(error) && error.code === PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_USERNAME_TAKEN,
    );
    // And it does NOT claim the bot is bound twice, which is the confident wrong
    // answer a widened first branch would have given.
    await expect(attempt).rejects.not.toThrowError(/already configured for another tenant/);
    await expect(attempt).rejects.toThrowError(/@acme_bot/);

    // Nothing was written for the second tenant.
    const rows = await ctx.container.database.db
      .select()
      .from(botInstances)
      .where(eq(botInstances.tenantId, second.tenantId));
    expect(rows).toHaveLength(0);
  });

  /*
   * `OQ-TG-04` item 3. The legacy identity fill COMMITS — an UPDATE and an audit
   * row — before the second `refuseRepointing` can refuse, because the first one
   * returns early on a NULL `telegram_bot_id` and has nothing to compare. The
   * refusal is right; "Nothing was changed." was not.
   */
  it('does not claim nothing changed after it filled a legacy identity', async () => {
    const first = tenantA as TenantContext;
    await bootstrap('acme_bot').execute(first, {
      token: `${SAME_BOT}:AAH-first`,
      publicBaseUrl: 'https://bot.example.com',
    });
    // The pre-0038 shape: a row with a stored token and no recorded identity.
    await ctx.container.database.db.update(botInstances).set({ telegramBotId: null });

    // A token for a DIFFERENT bot, supplied to a rerun. `getMe` reads the STORED
    // token, fills the blank from its answer, and only then is there an id to
    // refuse against.
    const attempt = bootstrap('acme_bot').execute(first, {
      token: '9987654321:AAH-someone-elses',
      publicBaseUrl: 'https://bot.example.com',
    });

    await expect(attempt).rejects.toSatisfy(
      (error: unknown) =>
        isNexaError(error) && error.code === PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_DIFFERENT_BOT,
    );
    await expect(attempt).rejects.not.toThrowError(/Nothing was changed\./);
    await expect(attempt).rejects.toThrowError(/bot identity was recorded from its stored token/);

    // And the fill really did commit, which is what makes the old clause false.
    const rows = await ctx.container.database.db.select().from(botInstances);
    expect(rows[0]?.telegramBotId).toBe(SAME_BOT);
  });

  it('still says nothing changed when no fill happened', async () => {
    // The other side, so the new sentence cannot be printed unconditionally: on
    // a row that already names its bot there is no migration to report, and
    // claiming one would be the same untruth in the opposite direction.
    const first = tenantA as TenantContext;
    await bootstrap('acme_bot').execute(first, {
      token: `${SAME_BOT}:AAH-first`,
      publicBaseUrl: 'https://bot.example.com',
    });

    const attempt = bootstrap('acme_bot').execute(first, {
      token: '9987654321:AAH-someone-elses',
      publicBaseUrl: 'https://bot.example.com',
    });

    await expect(attempt).rejects.toThrowError(/Nothing was changed\./);
    await expect(attempt).rejects.not.toThrowError(/recorded from its stored token/);
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
