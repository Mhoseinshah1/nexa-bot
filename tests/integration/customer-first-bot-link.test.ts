import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { systemJobActor, type CorrelationId, type UserId } from '@nexa/contracts';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { LINK_BOT_CONFIRM_ENV, parseLinkBotArgs } from '../../apps/api/src/customers-link-bot.cli';
import { SEED_IDS, createTestContext, tenantA, testConfig, type TestContext } from './harness';

/**
 * OI-1 — imported customers have `first_bot_instance_id = NULL`, and every customer
 * notification drops a NULL.
 *
 * Part 1: the customer upsert fills the link ON CONTACT, once, only when
 * `CUSTOMER_FIRST_BOT_FILL_ON_CONTACT` is on (default off).
 * Part 2: the cutover command (`customers-link-bot`) links customers the legacy importer
 * created and nobody has linked.
 *
 * MUTATION: replacing `coalesce(customers.first_bot_instance_id, excluded…)` with a plain
 * `excluded.first_bot_instance_id` makes "never overwrites an existing link" fail.
 */
const BOT1 = SEED_IDS.botA1;
const BOT2 = SEED_IDS.botA2;
const RUN = '01900000-0000-7000-8000-0000000000f1';
const HASH = 'a'.repeat(64);
const ACTOR = systemJobActor('customers-link-bot-test', 'corr-link-bot' as CorrelationId);

describe('customer first-bot link (OI-1)', () => {
  let ctx: TestContext;
  const db = () => ctx.container.database.db;
  const repo = (fill: boolean) =>
    new DrizzleCustomerRepository(db(), { fillFirstBotOnContact: fill });
  const service = () => ctx.container.customerBotLink;

  let nextTelegram = 700_000_000;
  /** A customer row, optionally created by the importer (a map row names it). */
  const customer = async (opts: {
    bot?: string | null;
    imported?: boolean;
  }): Promise<{ id: string; telegramUserId: string }> => {
    const id = randomUUID();
    const telegramUserId = String((nextTelegram += 1));
    await db().execute(sql`
      INSERT INTO customers (id, tenant_id, telegram_user_id, status, first_bot_instance_id, created_at)
      VALUES (${id}, ${tenantA.tenantId}, ${telegramUserId}, 'ACTIVE', ${opts.bot ?? null}, now())`);
    if (opts.imported === true) {
      await db().execute(sql`
        INSERT INTO legacy_import_map (tenant_id, legacy_table, legacy_id, run_id, checksum, status,
                                       entity_type, entity_id, created_at, updated_at)
        VALUES (${tenantA.tenantId}, 'user', ${telegramUserId}, ${RUN}, ${HASH}, 'IMPORTED',
                'CUSTOMER', ${id}, now(), now())`);
    }
    return { id, telegramUserId };
  };
  const botOf = async (id: string): Promise<string | null> => {
    const r = await db().execute(
      sql`SELECT first_bot_instance_id AS b FROM customers WHERE id = ${id}`,
    );
    return (r.rows[0] as { b: string | null }).b;
  };
  const contact = (fill: boolean, telegramUserId: string, bot: string) =>
    repo(fill).resolve(tenantA, {
      id: randomUUID() as UserId,
      telegramUserId,
      profile: { username: null, firstName: null, lastName: null, languageCode: null },
      botInstanceId: bot as never,
      now: new Date(),
    });

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 600_000);
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await ctx.reset();
    await db().execute(sql`
      INSERT INTO legacy_import_runs (id, tenant_id, mode, status, source_fingerprint, started_at,
                                      last_progress_at, finished_at)
      VALUES (${RUN}, ${tenantA.tenantId}, 'APPLY', 'COMPLETED', ${HASH}, now(), now(), now())`);
  });

  describe('part 1: fill on contact', () => {
    it('is off by default in the configuration', () => {
      expect(testConfig().CUSTOMER_FIRST_BOT_FILL_ON_CONTACT).toBe(false);
      expect(
        testConfig({ CUSTOMER_FIRST_BOT_FILL_ON_CONTACT: 'true' })
          .CUSTOMER_FIRST_BOT_FILL_ON_CONTACT,
      ).toBe(true);
    });

    it('flag off: a NULL link stays NULL after contact (behaviour unchanged)', async () => {
      const c = await customer({ imported: true });
      await contact(false, c.telegramUserId, BOT1);
      expect(await botOf(c.id)).toBeNull();
    });

    it('flag off: a new customer still gets the contacting bot on INSERT', async () => {
      const r = await contact(false, '799000001', BOT1);
      expect(await botOf(r.customer.id)).toBe(BOT1);
    });

    it('flag on: a NULL link is filled with the contacting bot', async () => {
      const c = await customer({ imported: true });
      await contact(true, c.telegramUserId, BOT1);
      expect(await botOf(c.id)).toBe(BOT1);
    });

    it('flag on: an existing link is never overwritten (COALESCE, not assignment)', async () => {
      const c = await customer({ bot: BOT1 });
      await contact(true, c.telegramUserId, BOT2);
      expect(await botOf(c.id)).toBe(BOT1);
      await contact(true, c.telegramUserId, BOT2);
      expect(await botOf(c.id)).toBe(BOT1);
    });

    it('flag on: concurrent first contacts from two bots leave exactly one stable value', async () => {
      const c = await customer({ imported: true });
      const results = await Promise.allSettled([
        contact(true, c.telegramUserId, BOT1),
        contact(true, c.telegramUserId, BOT2),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const winner = await botOf(c.id);
      expect([BOT1, BOT2]).toContain(winner);
      await contact(true, c.telegramUserId, winner === BOT1 ? BOT2 : BOT1);
      expect(await botOf(c.id)).toBe(winner);
    });
  });

  describe('part 2: the cutover command', () => {
    const countAudit = async (): Promise<number> => {
      const r = await db().execute(sql`SELECT count(*)::int AS n FROM audit_logs
        WHERE action = 'customers.link_imported_to_bot' AND result = 'SUCCESS'`);
      return Number((r.rows[0] as { n: number }).n);
    };

    it('refuses --apply without the environment confirmation (no database touched)', () => {
      expect(() => parseLinkBotArgs(['--bot', BOT1, '--apply'], {})).toThrow(LINK_BOT_CONFIRM_ENV);
    });

    it('dry run reports the count and writes nothing', async () => {
      const a = await customer({ imported: true });
      await customer({ imported: true });
      const report = await service().dryRun(tenantA, ACTOR, BOT1 as never);
      expect(report).toMatchObject({ mode: 'DRY_RUN', eligible: 2, linked: 0 });
      expect(await botOf(a.id)).toBeNull();
      expect(await countAudit()).toBe(0);
    });

    it('apply links only NULL + imported rows; re-run links 0; audited with counts', async () => {
      const nullImported = [
        await customer({ imported: true }),
        await customer({ imported: true }),
        await customer({ imported: true }),
      ];
      const linkedImported = await customer({ imported: true, bot: BOT2 });
      const organic = await customer({});
      const report = await service().apply(tenantA, ACTOR, BOT1 as never, 2);
      expect(report).toMatchObject({ mode: 'APPLY', eligible: 3, linked: 3, batches: 2 });
      for (const c of nullImported) expect(await botOf(c.id)).toBe(BOT1);
      expect(await botOf(linkedImported.id)).toBe(BOT2);
      expect(await botOf(organic.id)).toBeNull();
      expect(await countAudit()).toBe(2);

      const again = await service().apply(tenantA, ACTOR, BOT1 as never, 2);
      expect(again).toMatchObject({ linked: 0, batches: 0 });
      expect(await countAudit()).toBe(2);
    });

    it('does not link a customer whose map row is not an IMPORTED CUSTOMER entry', async () => {
      const c = await customer({});
      await db().execute(sql`
        INSERT INTO legacy_import_map (tenant_id, legacy_table, legacy_id, run_id, checksum, status,
                                       reason_code, created_at, updated_at)
        VALUES (${tenantA.tenantId}, 'user', ${c.telegramUserId}, ${RUN}, ${HASH}, 'SKIPPED',
                'HISTORY_NOT_IMPORTED', now(), now())`);
      expect((await service().apply(tenantA, ACTOR, BOT1 as never)).linked).toBe(0);
      expect(await botOf(c.id)).toBeNull();
    });

    it('audit rows carry counts and the bot id, never a customer or Telegram id', async () => {
      const c = await customer({ imported: true });
      await service().apply(tenantA, ACTOR, BOT1 as never);
      const r = await db().execute(sql`SELECT entity_id, before, after FROM audit_logs
        WHERE action = 'customers.link_imported_to_bot'`);
      const text = JSON.stringify(r.rows);
      expect(text).toContain(BOT1);
      expect(text).not.toContain(c.id);
      expect(text).not.toContain(c.telegramUserId);
    });

    it('links no one on an installation that has stopped accepting work', async () => {
      const c = await customer({ imported: true });
      await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`);
      try {
        await expect(service().apply(tenantA, ACTOR, BOT1 as never)).rejects.toThrow(
          /stopped accepting work/u,
        );
        expect(await botOf(c.id)).toBeNull();
        expect(await countAudit()).toBe(0);
      } finally {
        await db().execute(
          sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${tenantA.tenantId}`,
        );
      }
    });

    it('refuses a bot that is not ACTIVE, before linking anyone', async () => {
      const c = await customer({ imported: true });
      await db().execute(sql`UPDATE bot_instances SET status = 'STOPPED' WHERE id = ${BOT1}`);
      try {
        await expect(service().apply(tenantA, ACTOR, BOT1 as never)).rejects.toThrow(/not active/u);
        await expect(service().dryRun(tenantA, ACTOR, BOT1 as never)).rejects.toThrow(
          /not active/u,
        );
        expect(await botOf(c.id)).toBeNull();
      } finally {
        await db().execute(sql`UPDATE bot_instances SET status = 'ACTIVE' WHERE id = ${BOT1}`);
      }
    });

    it('never splits the imported audience between two bots', async () => {
      // A first run links to BOT1; a later run (a resume, a second operator) naming BOT2 is
      // refused, because a link is never overwritten and the split could not be repaired.
      const first = await customer({ imported: true });
      await service().apply(tenantA, ACTOR, BOT1 as never);
      expect(await botOf(first.id)).toBe(BOT1);
      const late = await customer({ imported: true });
      const before = await db().execute(sql`SELECT status FROM bot_instances WHERE id = ${BOT2}`);
      const statusBefore = (before.rows[0] as { status: string }).status;
      // BOT2 active too, so only the split rule can refuse it.
      await db().execute(sql`UPDATE bot_instances SET status = 'ACTIVE' WHERE id = ${BOT2}`);
      try {
        await expect(service().apply(tenantA, ACTOR, BOT2 as never)).rejects.toThrow(
          /another bot/u,
        );
      } finally {
        await db().execute(
          sql`UPDATE bot_instances SET status = ${statusBefore} WHERE id = ${BOT2}`,
        );
      }
      expect(await botOf(late.id)).toBeNull();
      // The same bot again finishes the job.
      expect((await service().apply(tenantA, ACTOR, BOT1 as never)).linked).toBe(1);
      expect(await botOf(late.id)).toBe(BOT1);
    });

    it('refuses a bot that does not exist in the tenant', async () => {
      await expect(service().dryRun(tenantA, ACTOR, randomUUID() as never)).rejects.toThrow();
    });
  });
});
