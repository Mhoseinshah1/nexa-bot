import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  isNexaError,
  systemJobActor,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
} from '@nexa/contracts';
import {
  confirmationAccepted,
  describeFailure,
  listingText,
  parsePruneArgs,
  PruneArgsError,
} from '../../apps/api/src/customers-prune.cli';
import { discoverDependents } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer-prune.repository';
import { SEED_IDS, createTestContext, tenantA, type TestContext } from './harness';

/**
 * `botctl customers prune-empty`, against a real database.
 *
 * The rules, each with the mutation that must break a test here:
 *
 *   discovery   the dependents come from the FOREIGN KEY GRAPH and from every `*customer_id`
 *               column, not from a list. MUTATION: drop the `pg_constraint` query (the
 *               composite-key and probe-table cases fail); drop the column query (the
 *               table-without-a-foreign-key cases fail).
 *   listing     changes nothing and shows only customers with no dependent anywhere.
 *   apply       deletes exactly those, in one transaction, with one audit row.
 *               MUTATION: drop the `noDependents` predicate from `lockAndRecheck` (the
 *               "others remain" cases fail).
 *   re-check    a dependent committed while apply waited for its lock is seen. MUTATION:
 *               delete the second statement in `lockAndRecheck` (the held-lock case fails).
 *   confirmed   never more than the operator confirmed. MUTATION: remove the
 *               `empty.length > expectedCount` refusal.
 *   standing    blocked / imported customers stay. MUTATION: remove the `status`/`source`
 *               conditions from `pruneable`.
 *   typed word  MUTATION: make `confirmationAccepted` return true.
 */

const BOT = SEED_IDS.botA1 as BotInstanceId;
const ACTOR: ActorContext = systemJobActor('customers-prune-test', 'corr-prune' as CorrelationId);

let ctx: TestContext;
const db = () => ctx.container.database.db;
const prune = () => ctx.container.customerPrune;

let nextTelegram = 810_000_000;

/** A customer exactly as a group join made it: through the real `resolveFromUpdate`. */
async function groupJoin(): Promise<string> {
  nextTelegram += 1;
  const { customer } = await ctx.container.customers.resolveFromUpdate(tenantA, ACTOR, {
    intake: 'INTERNAL',
    idempotencyKey: `prune-${String(nextTelegram)}`,
    telegramUserId: String(nextTelegram),
    from: { id: nextTelegram, first_name: 'کاربر', last_name: String(nextTelegram) },
    botInstanceId: BOT,
  });
  return customer.id;
}

async function exists(id: string): Promise<boolean> {
  const r = await db().execute(sql`SELECT 1 FROM customers WHERE id = ${id}`);
  return r.rows.length === 1;
}
async function customerCount(): Promise<number> {
  const r = await db().execute(sql`SELECT count(*)::int AS n FROM customers`);
  return (r.rows[0] as { n: number }).n;
}
const addNote = (customerId: string) =>
  db().execute(sql`
    INSERT INTO customer_notes (id, tenant_id, customer_id, body, author_label)
    VALUES (${randomUUID()}, ${tenantA.tenantId}, ${customerId}, 'یادداشت', 'test')`);
const addLedger = (customerId: string) =>
  db().execute(sql`
    INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount, currency, reference)
    VALUES (${randomUUID()}, ${tenantA.tenantId}, ${customerId}, 'CREDIT', 'ADMIN_CREDIT', 1000, 'IRT',
            ${`prune-test:${randomUUID()}`})`);
const addReferral = (referrerId: string, refereeId: string) =>
  db().execute(sql`
    INSERT INTO referrals (id, tenant_id, referrer_id, referee_id, trigger)
    VALUES (${randomUUID()}, ${tenantA.tenantId}, ${referrerId}, ${refereeId}, 'ON_SIGNUP')`);
async function addTicket(customerId: string): Promise<void> {
  const category = randomUUID();
  await db().execute(sql`
    INSERT INTO ticket_categories (id, tenant_id, title) VALUES (${category}, ${tenantA.tenantId}, 'عمومی')`);
  await db().execute(sql`
    INSERT INTO tickets (id, tenant_id, customer_id, bot_instance_id, category_id, category_title, opening_key)
    VALUES (${randomUUID()}, ${tenantA.tenantId}, ${customerId}, ${BOT}, ${category}, 'عمومی', ${`open:${randomUUID()}`})`);
}

async function listedIds(): Promise<string[]> {
  const listing = await prune().list(tenantA, ACTOR);
  return listing.candidates.map((c) => c.id).sort();
}

beforeAll(async () => {
  ctx = await createTestContext();
}, 600_000);
afterAll(async () => {
  await ctx?.close();
});
beforeEach(async () => {
  await ctx.reset();
});

describe('dependent discovery', () => {
  it('reads the foreign-key graph: composite keys, and every table that names a customer', async () => {
    const found = await discoverDependents(db());
    const byTable = new Map(found.map((d) => [d.table, d]));
    // The ledger and a table with two customer keys.
    expect(byTable.get('wallet_entries')?.pairs.map((p) => p.child)).toEqual([
      'tenant_id',
      'customer_id',
    ]);
    expect(byTable.get('referrals')).toBeDefined();
    expect(found.filter((d) => d.table === 'referrals').length).toBe(2);
    expect(byTable.has('tickets')).toBe(true);
    expect(byTable.has('orders')).toBe(true);
    // Every foreign key into customers is represented (compared with the catalogue itself).
    const fks = await db().execute(sql`
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE contype = 'f' AND confrelid = 'public.customers'::regclass`);
    const fromGraph = found.filter((d) => d.pairs.length > 0 && d.where === undefined).length;
    expect(fromGraph).toBeGreaterThanOrEqual((fks.rows[0] as { n: number }).n);
  });

  it('covers a customer_id column that has NO foreign key, and the two fixed references', async () => {
    const found = await discoverDependents(db());
    const tables = new Set(found.map((d) => d.table));
    // None of these three declares a foreign key to customers (checked against the catalogue
    // below, so this test cannot go stale if one later gains one).
    for (const table of ['order_cashback', 'refunds', 'service_username_reservations']) {
      expect(tables.has(table), table).toBe(true);
    }
    expect(tables.has('telegram_wizards')).toBe(true);
    expect(tables.has('legacy_import_map')).toBe(true);
    // And EVERY column named customer_id in the schema is represented, one way or the other.
    const columns = await db().execute(sql`
      SELECT cl.relname::text AS tbl, a.attname::text AS col
        FROM pg_attribute a JOIN pg_class cl ON cl.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
       WHERE cl.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
         AND a.attname ~ '(^|_)customer_id$' AND cl.relname <> 'customers'`);
    for (const row of columns.rows as { tbl: string; col: string }[]) {
      const covered = found.some(
        (d) => d.table === row.tbl && d.pairs.some((p) => p.child === row.col),
      );
      expect(covered, `${row.tbl}.${row.col}`).toBe(true);
    }
  });

  it('picks up a table added later, with or without a foreign key', async () => {
    await db().execute(sql`
      CREATE TABLE prune_probe_fk (id serial PRIMARY KEY, tenant_id uuid NOT NULL, owner uuid NOT NULL,
        FOREIGN KEY (tenant_id, owner) REFERENCES customers (tenant_id, id))`);
    await db().execute(
      sql`CREATE TABLE prune_probe_nofk (id serial PRIMARY KEY, customer_id uuid)`,
    );
    await db().execute(
      sql`CREATE TABLE prune_probe_text (id serial PRIMARY KEY, legacy_customer_id text)`,
    );
    try {
      const withFk = await groupJoin();
      const withoutFk = await groupJoin();
      const withText = await groupJoin();
      const empty = await groupJoin();
      await db().execute(sql`
        INSERT INTO prune_probe_fk (tenant_id, owner) VALUES (${tenantA.tenantId}, ${withFk})`);
      await db().execute(sql`INSERT INTO prune_probe_nofk (customer_id) VALUES (${withoutFk})`);
      await db().execute(
        sql`INSERT INTO prune_probe_text (legacy_customer_id) VALUES (${withText})`,
      );

      const tables = (await discoverDependents(db())).map((d) => d.table);
      expect(tables).toContain('prune_probe_fk');
      expect(tables).toContain('prune_probe_nofk');
      expect(tables).toContain('prune_probe_text');
      expect(await listedIds()).toEqual([empty]);

      const result = await prune().apply(tenantA, ACTOR, { expectedCount: 1 });
      expect(result.deleted).toBe(1);
      expect(await exists(empty)).toBe(false);
      for (const kept of [withFk, withoutFk, withText]) expect(await exists(kept)).toBe(true);
    } finally {
      await db().execute(
        sql`DROP TABLE IF EXISTS prune_probe_fk, prune_probe_nofk, prune_probe_text`,
      );
    }
  });
});

describe('the listing', () => {
  it('shows only customers with no dependent anywhere, and changes nothing', async () => {
    const empty1 = await groupJoin();
    const empty2 = await groupJoin();
    const withLedger = await groupJoin();
    const withNote = await groupJoin();
    const withTicket = await groupJoin();
    const referrer = await groupJoin();
    const referee = await groupJoin();
    await addLedger(withLedger);
    await addNote(withNote);
    await addTicket(withTicket);
    await addReferral(referrer, referee);

    const before = await customerCount();
    const auditBefore = await db().execute(sql`SELECT count(*)::int AS n FROM audit_logs`);
    expect(await listedIds()).toEqual([empty1, empty2].sort());
    expect(await customerCount()).toBe(before);
    expect((await db().execute(sql`SELECT count(*)::int AS n FROM audit_logs`)).rows).toEqual(
      auditBefore.rows,
    );

    const text = listingText(await prune().list(tenantA, ACTOR));
    expect(text).toContain('2 مورد');
    expect(text).toContain(empty1);
    expect(text).not.toContain(withLedger);
    expect(text).not.toContain(referrer);
  });

  it('keeps blocked, imported and personally-edited customers off the list, and says so', async () => {
    const plain = await groupJoin();
    const blocked = await groupJoin();
    const imported = await groupJoin();
    const withPhone = await groupJoin();
    await db().execute(sql`
      UPDATE customers SET status = 'BLOCKED', blocked_at = now() WHERE id = ${blocked}`);
    await db().execute(sql`
      UPDATE customers SET source = 'MIRZA', source_ref = 'user:1' WHERE id = ${imported}`);
    await db().execute(sql`
      UPDATE customers SET phone_number = '+989121234567', phone_verified_at = now() WHERE id = ${withPhone}`);
    const listing = await prune().list(tenantA, ACTOR);
    expect(listing.candidates.map((c) => c.id)).toEqual([plain]);
    expect(listing.keptForStanding).toBe(3);
    expect(listingText(listing)).toContain('3 مشتریِ دیگر');

    expect((await prune().apply(tenantA, ACTOR, { expectedCount: 1 })).deleted).toBe(1);
    for (const kept of [blocked, imported, withPhone]) expect(await exists(kept)).toBe(true);
  });

  it('treats the import map as a dependent even for a bot-registered row', async () => {
    const mapped = await groupJoin();
    await db().execute(sql`
      INSERT INTO legacy_import_runs (id, tenant_id, mode, status, source_fingerprint, started_at,
                                      last_progress_at, finished_at)
      VALUES (${'01900000-0000-7000-8000-0000000000f2'}, ${tenantA.tenantId}, 'APPLY', 'COMPLETED',
              ${'a'.repeat(64)}, now(), now(), now())`);
    await db().execute(sql`
      INSERT INTO legacy_import_map (tenant_id, legacy_table, legacy_id, run_id, checksum, status,
                                     reason_code, entity_type, entity_id, created_at, updated_at)
      VALUES (${tenantA.tenantId}, 'user', '1', ${'01900000-0000-7000-8000-0000000000f2'},
              ${'a'.repeat(64)}, 'IMPORTED', NULL, 'CUSTOMER', ${mapped}, now(), now())`);
    expect(await listedIds()).toEqual([]);
  });

  it('is empty on a fresh installation, with nothing to delete', async () => {
    expect(await listedIds()).toEqual([]);
    expect((await prune().apply(tenantA, ACTOR, { expectedCount: 0 })).deleted).toBe(0);
  });
});

describe('apply', () => {
  it('deletes exactly the empty customers, keeps the rest, and writes one audit row', async () => {
    const empty1 = await groupJoin();
    const empty2 = await groupJoin();
    const kept = await groupJoin();
    await addLedger(kept);

    const result = await prune().apply(tenantA, ACTOR, { expectedCount: 2 });
    expect(result.deleted).toBe(2);
    expect(await exists(empty1)).toBe(false);
    expect(await exists(empty2)).toBe(false);
    expect(await exists(kept)).toBe(true);

    const audit = await db().execute(sql`
      SELECT actor_type, result, after FROM audit_logs WHERE action = 'customers.prune_empty'`);
    expect(audit.rows).toHaveLength(1);
    const row = audit.rows[0] as {
      actor_type: string;
      result: string;
      after: { deleted: number; customerIds: string[] };
    };
    expect(row.actor_type).toBe('SYSTEM_JOB');
    expect(row.result).toBe('SUCCESS');
    expect(row.after.deleted).toBe(2);
    expect([...row.after.customerIds].sort()).toEqual([empty1, empty2].sort());
  });

  it('leaves the audit and outbox history in place, drops the idempotency row, and a replayed update registers again', async () => {
    const id = await groupJoin();
    const events = await db().execute(sql`
      SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id = ${id}`);
    await prune().apply(tenantA, ACTOR, { expectedCount: 1 });
    expect(await exists(id)).toBe(false);
    // Audit (append-only) and the outbox event are history keyed by an id; neither blocks it.
    const audit = await db().execute(sql`
      SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = ${id} AND action = 'customer.registered'`);
    expect((audit.rows[0] as { n: number }).n).toBe(1);
    expect(
      (
        await db().execute(
          sql`SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id = ${id}`,
        )
      ).rows,
    ).toEqual(events.rows);
    // The update's idempotency row went with the customer, so a redelivery of that update
    // registers again instead of colliding with its own old key.
    expect(
      (
        await db().execute(sql`
        SELECT count(*)::int AS n FROM request_idempotency WHERE result ->> 'customerId' = ${id}`)
      ).rows,
    ).toEqual([{ n: 0 }]);
    const { customer } = await ctx.container.customers.resolveFromUpdate(tenantA, ACTOR, {
      intake: 'INTERNAL',
      idempotencyKey: `prune-${String(nextTelegram)}`,
      telegramUserId: String(nextTelegram),
      from: { id: nextTelegram, first_name: 'کاربر', last_name: String(nextTelegram) },
      botInstanceId: BOT,
    });
    expect(await exists(customer.id)).toBe(true);
  });

  it('does not delete a customer that gained a dependent after the listing', async () => {
    const stays = await groupJoin();
    const goes = await groupJoin();
    expect(await listedIds()).toEqual([stays, goes].sort());
    await addNote(stays); // between the listing and the apply

    const result = await prune().apply(tenantA, ACTOR, { expectedCount: 2 });
    expect(result.deleted).toBe(1);
    expect(await exists(stays)).toBe(true);
    expect(await exists(goes)).toBe(false);
  });

  it('sees a dependent that commits while apply waits for its lock', async () => {
    const stays = await groupJoin();
    const goes = await groupJoin();
    // A transaction that has inserted a child row (it holds FOR KEY SHARE on the parent) but
    // not committed. The apply's FOR UPDATE queues behind it.
    const client = await ctx.container.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO customer_notes (id, tenant_id, customer_id, body, author_label)
         VALUES ($1, $2, $3, 'x', 'test')`,
        [randomUUID(), tenantA.tenantId, stays],
      );
      const pending = prune().apply(tenantA, ACTOR, { expectedCount: 2 });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await client.query('COMMIT');
      const result = await pending;
      expect(result.deleted).toBe(1);
    } finally {
      client.release();
    }
    expect(await exists(stays)).toBe(true);
    expect(await exists(goes)).toBe(false);
  });

  it('refuses, and deletes nothing, when more customers are empty than were confirmed', async () => {
    await groupJoin();
    await groupJoin();
    const before = await customerCount();
    let thrown: unknown;
    try {
      await prune().apply(tenantA, ACTOR, { expectedCount: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(isNexaError(thrown)).toBe(true);
    expect(await customerCount()).toBe(before);
    expect(describeFailure(thrown)).toContain('فهرست را دوباره بگیرید');
    const audit = await db().execute(sql`
      SELECT count(*)::int AS n FROM audit_logs WHERE action = 'customers.prune_empty' AND result = 'SUCCESS'`);
    expect((audit.rows[0] as { n: number }).n).toBe(0);
  });

  it('refuses an installation that has stopped accepting work', async () => {
    await groupJoin();
    await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`);
    await expect(prune().apply(tenantA, ACTOR, { expectedCount: 1 })).rejects.toBeDefined();
    expect(await customerCount()).toBe(1);
  });

  it('is not granted to an actor without the permission', async () => {
    await groupJoin();
    const stranger: ActorContext = {
      type: 'WEB_ADMIN',
      id: randomUUID() as never,
      label: 'nobody',
      surface: 'WEB',
      correlationId: 'corr-nobody' as CorrelationId,
    };
    await expect(prune().apply(tenantA, stranger, { expectedCount: 1 })).rejects.toBeDefined();
    expect(await customerCount()).toBe(1);
  });
});

describe('the command line', () => {
  it('accepts the word or the count, in Persian or ASCII digits, and nothing else', () => {
    expect(confirmationAccepted('حذف', 12)).toBe(true);
    expect(confirmationAccepted(' حذف \n', 12)).toBe(true);
    expect(confirmationAccepted('12', 12)).toBe(true);
    expect(confirmationAccepted('۱۲', 12)).toBe(true);
    expect(confirmationAccepted('13', 12)).toBe(false);
    expect(confirmationAccepted('yes', 12)).toBe(false);
    expect(confirmationAccepted('بله', 12)).toBe(false);
    expect(confirmationAccepted('', 12)).toBe(false);
    expect(confirmationAccepted('0', 0)).toBe(false);
  });

  it('defaults to the listing, and an apply needs the count and the typed answer', () => {
    expect(parsePruneArgs([])).toEqual({ kind: 'list', countOnly: false, tenantSlug: null });
    expect(parsePruneArgs(['list', '--count', '--tenant', 'acme'])).toEqual({
      kind: 'list',
      countOnly: true,
      tenantSlug: 'acme',
    });
    expect(() => parsePruneArgs(['apply'])).toThrow(PruneArgsError);
    expect(() => parsePruneArgs(['apply', '--expect-count', 'x', '--typed', 'حذف'])).toThrow(
      PruneArgsError,
    );
    expect(() => parsePruneArgs(['--delete-everything'])).toThrow(PruneArgsError);
    expect(parsePruneArgs(['apply', '--expect-count', '3', '--typed', 'حذف'])).toEqual({
      kind: 'apply',
      expectedCount: 3,
      typed: 'حذف',
      tenantSlug: null,
    });
  });
});
