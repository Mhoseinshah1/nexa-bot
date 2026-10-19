import { discountSourceRef as catalogDiscountSourceRef } from '../../apps/api/src/modules/platform/legacy-materialize/application/catalog-records';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { systemJobActor, type CorrelationId, type UserId } from '@nexa/contracts';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import { DrizzleDiscountRepository } from '../../apps/api/src/modules/commerce/pricing/infrastructure/drizzle-discount.repository';
import {
  exactMatchHolds,
  type ExactMatchRow,
  type MaterializeContext,
  type MaterializeStep,
} from '../../apps/api/src/modules/platform/legacy-materialize/application/ports';
import { DrizzleHistoryRecordReader } from '../../apps/api/src/modules/platform/legacy-materialize/infrastructure/drizzle-history-record.reader';
import { DrizzleTicketHistoryRepository } from '../../apps/api/src/modules/platform/legacy-materialize/infrastructure/drizzle-ticket-history.repository';
import { TicketHistoryStep } from '../../apps/api/src/modules/platform/legacy-materialize/application/ticket-history.step';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * The one-time Mirza import, history steps (plan §5, §9): payments, wallet history, tickets,
 * referrals and discount usage written to NORMAL tables as `source = 'MIRZA'`.
 *
 * The rules under test, each a way to touch money twice or to wake something that should stay
 * asleep:
 * - a history step never changes a balance: Σ wallet_entries and every customer's balance are
 *   the same before and after;
 * - a second run writes nothing and every count and sum is identical;
 * - nothing is triggered: no outbox event, notification, provisioning, gift, commission,
 *   cashback;
 * - the exact-match rows hold on a package with deliberate gaps, each gap counted by reason.
 *
 * SYNTHETIC records only, shaped like the converter's (`PACKAGE_CONTRACT.md`).
 *
 * MUTATION CHECKS (each was run; the test that fails is named):
 * - drop `ne(orders.origin, 'LEGACY_HISTORY')` from `DrizzleDiscountRepository.usage`:
 *   "a history redemption does not consume a limit";
 * - drop the `ADMIN_METHODS` gap in `planPayment`: "payments: ... gaps" (an admin debit
 *   would be written as money received);
 * - drop `notLegacyImport` from the reporting repository: "reports do not count ...".
 */

type Rec = Record<string, unknown>;

const TG_A = '7000000001';
const TG_B = '7000000002';
const TG_NOBODY = '5000000999';
const JOB = systemJobActor('legacy-materialize:test', 'corr-materialize' as CorrelationId);

describe('Mirza import: history into the normal tables', () => {
  let ctx: TestContext;
  let importId: string;
  let customerA: UserId;
  let customerB: UserId;
  let run = 0;
  const db = () => ctx.container.database.db;
  const steps = () => ctx.container.legacyMaterializeHistory;
  const walletRepository = () => new DrizzleWalletRepository(db());

  const q = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
    (await db().execute<T>(query)).rows;
  const n = async (query: ReturnType<typeof sql>) =>
    Number((await q<{ n: string }>(query))[0]?.n ?? 0);

  const materializeCtx = (): MaterializeContext => ({
    scope: tenantA,
    actor: JOB,
    packageImportId: importId,
    sourceFingerprint: 'f'.repeat(64),
    now: new Date('2026-10-17T00:00:00.000Z'),
  });

  // --- fixtures ------------------------------------------------------------------------

  async function customer(telegramUserId: string): Promise<UserId> {
    const id = ctx.container.ids.uuid();
    await db().execute(sql`
      INSERT INTO customers (id, tenant_id, telegram_user_id, status, created_at)
      VALUES (${id}, ${tenantA.tenantId}, ${telegramUserId}, 'ACTIVE', now())`);
    run += 1;
    const runId = '01900000-0000-7000-8000-0000000000a1';
    if (run === 1) {
      await db().execute(sql`
        INSERT INTO legacy_import_runs (id, tenant_id, mode, status, source_fingerprint,
                                        started_at, last_progress_at, finished_at)
        VALUES (${runId}, ${tenantA.tenantId}, 'APPLY', 'COMPLETED', ${'a'.repeat(64)},
                now(), now(), now())`);
    }
    await db().execute(sql`
      INSERT INTO legacy_import_map (tenant_id, legacy_table, legacy_id, run_id, checksum, status,
                                     entity_type, entity_id, created_at, updated_at)
      VALUES (${tenantA.tenantId}, 'user', ${telegramUserId}, ${runId}, ${'a'.repeat(64)},
              'IMPORTED', 'CUSTOMER', ${id}, now(), now())`);
    return id as UserId;
  }

  async function record(type: string, key: string, payload: Rec, tg: string | null): Promise<void> {
    await db().execute(sql`
      INSERT INTO legacy_history_records
        (id, tenant_id, nxpkg_import_id, package_import_id, record_type, idempotency_key,
         legacy_user_id, customer_id, occurred_at, payload, created_at)
      VALUES (${randomUUID()}, ${tenantA.tenantId}, ${importId}, 'pkg-1', ${type}, ${key}, ${tg},
              NULL, NULL, ${JSON.stringify(payload)}::jsonb, now())`);
  }

  const payment = (id: number, over: Rec, tg: string | null = TG_A) =>
    record(
      'payment',
      `legacy:payment:${id}`,
      {
        record_type: 'legacy_payment_history',
        payment_id: String(id),
        customer: { telegram_user_id: tg, relation: 'CUSTOMER_IMPORTED' },
        order: {
          source_order_id: 'abc1234567',
          relation: 'PAYMENT_REFERENCE',
          relation_proven: true,
        },
        amount: { amount_minor: '1000', currency: 'IRT' },
        method: { raw: 'cart to cart', normalized: 'CARD_TO_CARD' },
        status: { raw: 'paid', outcome: 'SUCCEEDED', reason: 'PAID' },
        times: {
          created: { unix: 1_735_700_000, local: null, note: 'OK_UNIX_SECONDS' },
          updated: { unix: 1_735_700_600, local: null, note: 'OK_UNIX_SECONDS' },
        },
        provenance: { source_table: 'Payment_report', source_pk: String(id) },
        ...over,
      },
      tg,
    );

  const walletTx = (id: number, over: Rec, tg: string | null = TG_A) =>
    record(
      'wallet_transaction',
      `legacy:wallet-tx:${id}`,
      {
        record_type: 'legacy_wallet_transaction',
        transaction_id: String(id),
        customer: { telegram_user_id: tg },
        type: { raw: 'charge', normalized: 'UNKNOWN' },
        reason: 'synthetic reason',
        amount: { value_minor: '5000', currency: 'IRT' },
        arithmetic: 'ARITHMETIC_CREDIT',
        created_at: { unix: 1_735_600_000 + id, local: null },
        provenance: { source_table: 'wallet_transaction', source_pk: String(id) },
        ...over,
      },
      tg,
    );

  const wheel = (id: number, over: Rec, tg: string | null = TG_A) =>
    record(
      'wheel_result',
      `legacy:wheel:${id}`,
      {
        record_type: 'legacy_wheel_spin',
        customer: { telegram_user_id: tg },
        dice_value_raw: '3',
        prize: { amount_minor: '1000', currency: 'IRT' },
        spun_at: '2024-08-01T10:00:00',
        prize_already_in_legacy_balance: true,
        source_pk: String(id),
        provenance: { source_table: 'wheel_list', source_pk: String(id) },
        ...over,
      },
      tg,
    );

  const supportMsg = (
    pk: number,
    thread: string,
    seq: number,
    over: Rec,
    tg: string | null = TG_A,
  ) =>
    record(
      'support_message',
      `legacy:support:message:${pk}`,
      {
        record_type: 'legacy_support_message',
        source_pk: String(pk),
        thread_ref: `legacy:support:thread:${thread}`,
        seq,
        customer: { telegram_user_id: tg },
        department_name: 'عمومی',
        customer_text: `question ${pk}`,
        admin_answer: '0',
        sent_at: `2024-07-0${seq}T10:00:00`,
        ...over,
      },
      tg,
    );

  const forkTicket = (pk: string, over: Rec, tg: string | null = TG_B) =>
    record(
      'ticket',
      `legacy:support:ticket:${pk}`,
      {
        record_type: 'legacy_ticket',
        source_pk: pk,
        customer: { telegram_user_id: tg },
        status: 'OPEN',
        fields_raw: { subject: `subject ${pk}`, created_at: '2024-08-01 09:00:00' },
        ...over,
      },
      tg,
    );

  const forkMessage = (
    pk: string,
    ticket: string,
    seq: number,
    fields: Rec,
    sentAt: string | null,
  ) =>
    record(
      'ticket_message',
      `legacy:support:ticket_message:${pk}`,
      {
        record_type: 'legacy_ticket_message',
        source_pk: pk,
        ticket_ref: { column: 'ticket_id', raw: ticket, ticket_exists: true },
        sent_at: sentAt,
        seq,
        fields_raw: fields,
      },
      null,
    );

  const referral = (pk: number, referrer: string | null, referee: string | null, over: Rec = {}) =>
    record(
      'referral',
      `legacy:referral:${pk}`,
      {
        record_type: 'legacy_referral',
        source_pk: String(pk),
        referrer: { telegram_user_id: referrer },
        referee: { telegram_user_id: referee },
        referrer_gift_paid: true,
        attributed_at: '2024-06-01T12:00:00',
        ...over,
      },
      referee,
    );

  async function walletFacts() {
    const [sum] = await q<{ total: string; entries: string }>(sql`
      SELECT coalesce(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS total,
             count(*)::text AS entries
        FROM wallet_entries`);
    const perCustomer = await q<{ customer_id: string; b: string }>(sql`
      SELECT customer_id, sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)::text AS b
        FROM wallet_entries GROUP BY customer_id ORDER BY customer_id`);
    return { ...sum, perCustomer };
  }

  /** The tables an automatic path would write; every count must stay put. */
  async function triggered() {
    const tables = [
      'outbox_messages',
      'customer_notifications',
      'notifications',
      'provisioning_operations',
      'referral_signup_gifts',
      'order_referral_commissions',
      'order_cashback',
      'wallet_entries',
      'gateway_invoices',
      'refunds',
      'payment_receipts',
    ];
    const out: Record<string, number> = {};
    for (const t of tables) {
      out[t] = await n(sql.raw(`SELECT count(*)::text AS n FROM ${t}`));
    }
    return out;
  }

  const gaps = (row: ExactMatchRow): Record<string, number> =>
    Object.fromEntries(row.explained.map((g) => [g.reason, g.rows]));

  const matchOf = async (step: MaterializeStep) => step.match(materializeCtx());

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 600_000);
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await ctx.reset();
    run = 0;
    const owner = await createAdmin(ctx.container, tenantA, {
      username: 'owner-hana',
      roleKeys: ['owner'],
    });
    void adminActorFor(owner);
    importId = randomUUID();
    await db().execute(sql`
      INSERT INTO legacy_nxpkg_imports
        (id, tenant_id, status, file_name, file_path, file_sha256, file_bytes, package_import_id,
         requested_by_admin_id, created_at, updated_at)
      VALUES (${importId}, ${tenantA.tenantId}, 'VERIFIED', 'synthetic.nxpkg', '/nonexistent',
              ${'a'.repeat(64)}, 1, 'pkg-1', ${owner.id}, now(), now())`);
    customerA = await customer(TG_A);
    customerB = await customer(TG_B);
  });

  // ---------------------------------------------------------------------------------------
  describe('payments', () => {
    async function seed() {
      await payment(1, { amount: { amount_minor: '100000', currency: 'IRT' } }); // paid card: CONFIRMED
      await payment(
        2,
        {
          amount: { amount_minor: '50000', currency: 'IRT' },
          method: { raw: 'zarinpal', normalized: 'GATEWAY_ZARINPAL' },
          status: { raw: 'reject', outcome: 'FAILED', reason: 'REJECTED_BY_ADMIN' },
        },
        TG_B,
      );
      await payment(3, {
        amount: { amount_minor: '30000', currency: 'IRT' },
        status: { raw: 'expire', outcome: 'CANCELLED', reason: 'EXPIRED_UNPAID' },
      });
      await payment(
        4,
        {
          amount: { amount_minor: '20000', currency: 'IRT' },
          status: { raw: 'Unpaid', outcome: 'PENDING', reason: 'AWAITING_PAYMENT' },
        },
        TG_B,
      );
      await payment(5, {
        amount: { amount_minor: '777', currency: 'IRT' },
        method: { raw: 'low balance by admin', normalized: 'ADMIN_DEBIT_ADJUSTMENT' },
      });
      await payment(6, { amount: { amount_minor: null, currency: null } });
      await payment(7, { amount: { amount_minor: '4000', currency: 'IRT' } }, TG_NOBODY);
      await payment(8, {
        amount: { amount_minor: '1500', currency: 'IRT' },
        status: {
          raw: 'refunded',
          outcome: 'UNKNOWN',
          reason: 'STATUS_NOT_IN_EVIDENCED_VOCABULARY',
        },
      });
      await payment(9, {
        amount: { amount_minor: '800', currency: 'IRT' },
        times: { created: { unix: null, local: null, note: 'FORMAT_UNKNOWN' }, updated: {} },
      });
      await payment(10, {
        amount: { amount_minor: '12345', currency: 'IRT' },
        method: { raw: 'weird gateway', normalized: 'UNKNOWN' },
        // Local wall time only: Mirza's server clock is Asia/Tehran (UTC+03:30 in 2024-01).
        times: {
          created: {
            unix: null,
            local: '2024-01-15T12:00:00',
            note: 'OK_LOCAL_TIME_ZONE_UNPROVEN',
          },
          updated: { unix: null, local: null, note: 'ABSENT' },
        },
      });
      await payment(11, { amount: { amount_minor: '0', currency: 'IRT' } });
    }

    it('writes direct, terminal, evidence-marked rows; every gap is counted by reason', async () => {
      await seed();
      const before = await triggered();
      const out = await steps().payments.apply(materializeCtx());
      expect(out).toMatchObject({ written: 5, alreadyPresent: 0, diverged: 0 });
      expect(out.skipped).toEqual({
        ADMIN_ADJUSTMENT_NOT_A_PAYMENT: 1,
        CUSTOMER_NOT_IMPORTED: 1,
        NON_POSITIVE_AMOUNT: 1,
        STATUS_UNKNOWN: 1,
        UNPARSEABLE_AMOUNT: 1,
        UNPARSEABLE_TIME: 1,
      });
      const rows = await q<Record<string, unknown>>(sql`
        SELECT source_ref, state, method, amount::text AS amount, evidence_kind, order_id,
               confirmed_at, resolved_at, created_at, source
          FROM payments ORDER BY source_ref`);
      const by = Object.fromEntries(rows.map((r) => [r['source_ref'] as string, r]));
      expect(Object.keys(by)).toEqual([
        'payment:1',
        'payment:10',
        'payment:2',
        'payment:3',
        'payment:4',
      ]);
      expect(by['payment:1']).toMatchObject({
        state: 'CONFIRMED',
        method: 'MANUAL_TRANSFER',
        evidence_kind: 'LEGACY_IMPORT',
        order_id: null,
        source: 'MIRZA',
      });
      expect(new Date(by['payment:1']?.['confirmed_at'] as string).toISOString()).toBe(
        new Date(1_735_700_600 * 1000).toISOString(),
      );
      expect(new Date(by['payment:1']?.['created_at'] as string).toISOString()).toBe(
        new Date(1_735_700_000 * 1000).toISOString(),
      );
      expect(by['payment:2']).toMatchObject({
        state: 'FAILED',
        method: 'GATEWAY',
        evidence_kind: null,
      });
      expect(by['payment:3']).toMatchObject({ state: 'EXPIRED' });
      // A payment Mirza still held open is over: no open historical payment, ever.
      expect(by['payment:4']).toMatchObject({ state: 'EXPIRED' });
      expect(by['payment:4']?.['resolved_at']).not.toBeNull();
      // An unknown method is the neutral one, and the local time is read in Tehran.
      expect(by['payment:10']).toMatchObject({ state: 'CONFIRMED', method: 'MANUAL_TRANSFER' });
      expect(new Date(by['payment:10']?.['created_at'] as string).toISOString()).toBe(
        '2024-01-15T08:30:00.000Z',
      );
      // Nothing was woken and no money moved.
      expect(await triggered()).toEqual(before);
    });

    it('applied twice, the second run writes nothing and every count and sum is the same', async () => {
      await seed();
      await steps().payments.apply(materializeCtx());
      const snapshot = await q(sql`SELECT * FROM payments ORDER BY source_ref`);
      const second = await steps().payments.apply(materializeCtx());
      expect(second).toMatchObject({ written: 0, alreadyPresent: 5, diverged: 0 });
      expect(await q(sql`SELECT * FROM payments ORDER BY source_ref`)).toEqual(snapshot);
    });

    it('a stored row with different content is diverged, never rewritten', async () => {
      await seed();
      await steps().payments.apply(materializeCtx());
      // The confirmation guard freezes a resolved payment, so the tamper is done the way only
      // a superuser could: with the user triggers off for the statement.
      await db().execute(sql`ALTER TABLE payments DISABLE TRIGGER USER`);
      await db().execute(
        sql`UPDATE payments SET amount = amount + 1 WHERE source_ref = 'payment:2'`,
      );
      await db().execute(sql`ALTER TABLE payments ENABLE TRIGGER USER`);
      const second = await steps().payments.apply(materializeCtx());
      expect(second).toMatchObject({ written: 0, alreadyPresent: 4, diverged: 1 });
      const [row] = await q<{ amount: string }>(
        sql`SELECT amount::text AS amount FROM payments WHERE source_ref = 'payment:2'`,
      );
      expect(row?.amount).toBe('50001');
    });

    it('the exact-match row holds, with rows and money, once the gaps are added back', async () => {
      await seed();
      const [before] = await matchOf(steps().payments);
      expect(before && exactMatchHolds(before)).toBe(false);
      await steps().payments.apply(materializeCtx());
      const [row] = await matchOf(steps().payments);
      expect(row).toBeDefined();
      if (row === undefined) return;
      expect(exactMatchHolds(row)).toBe(true);
      expect(row).toMatchObject({ mirzaRows: 11, nexaRows: 5 });
      expect(row.nexaSumMinor).toBe(212_345n);
      expect(row.mirzaSumMinor).toBe(219_422n);
      expect(gaps(row)).toEqual({
        ADMIN_ADJUSTMENT_NOT_A_PAYMENT: 1,
        CUSTOMER_NOT_IMPORTED: 1,
        NON_POSITIVE_AMOUNT: 1,
        STATUS_UNKNOWN: 1,
        UNPARSEABLE_AMOUNT: 1,
        UNPARSEABLE_TIME: 1,
      });
    });

    it('reports do not count LEGACY_IMPORT payments as NEXA payments or cash', async () => {
      await seed();
      await steps().payments.apply(materializeCtx());
      const from = new Date('2000-01-01T00:00:00Z');
      const to = new Date('2100-01-01T00:00:00Z');
      const { DrizzleReportingRepository } =
        await import('../../apps/api/src/modules/commerce/reporting/infrastructure/drizzle-reporting.repository');
      const repo = new DrizzleReportingRepository(db());
      expect(await repo.paymentGroups(tenantA, { from, to })).toEqual([]);
      expect(await repo.paymentFailures(tenantA, { from, to })).toEqual({
        failed: 0,
        cancelled: 0,
        expired: 0,
      });
      const page = await repo.paymentAttempts(tenantA, { from, to }, {}, 50, null);
      expect(page.rows).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe('wallet history', () => {
    async function seed() {
      await walletTx(1, {}); // +5000 credit
      await walletTx(2, {
        amount: { value_minor: '-3000', currency: 'IRT' },
        arithmetic: 'ARITHMETIC_DEBIT',
      });
      await walletTx(3, { amount: { value_minor: null, currency: null } });
      await walletTx(4, {}, TG_NOBODY);
      await walletTx(5, {
        amount: { value_minor: '0', currency: 'IRT' },
        arithmetic: 'ARITHMETIC_NO_CHANGE',
      });
      await walletTx(6, { created_at: { unix: null, local: null } });
      await wheel(1, {}); // +1000
      await wheel(2, { prize: { amount_minor: '0', currency: 'IRT' } });
      await wheel(3, { prize: { amount_minor: null, currency: null } });
      await wheel(4, {}, TG_NOBODY);
    }

    /** The importer's one opening entry per customer, written the way it writes it. */
    async function openingBalance(customerId: UserId, amount: bigint) {
      await db().execute(sql`
        INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount, currency, reference, created_at)
        VALUES (${randomUUID()}, ${tenantA.tenantId}, ${customerId}, 'CREDIT', 'MIGRATION_OPENING_BALANCE',
                ${amount.toString()}::bigint, 'IRT', ${`legacy:opening:${customerId}`}, now())`);
    }

    it('never changes a balance: the ledger and every customer balance are the same after', async () => {
      await openingBalance(customerA, 7_000n);
      await openingBalance(customerB, 250n);
      await seed();
      const before = await walletFacts();
      const triggeredBefore = await triggered();

      const out = await steps().walletHistory.apply(materializeCtx());
      expect(out).toMatchObject({ written: 5, alreadyPresent: 0, diverged: 0 });
      expect(out.skipped).toEqual({
        CUSTOMER_NOT_IMPORTED: 2,
        UNPARSEABLE_AMOUNT: 2,
        UNPARSEABLE_TIME: 1,
      });

      expect(await walletFacts()).toEqual(before);
      expect(await triggered()).toEqual(triggeredBefore);
      // The repository's own balance ignores the history table as well.
      for (const [id, expected] of [
        [customerA, 7_000n],
        [customerB, 250n],
      ] as const) {
        const balance = await walletRepository().balanceOf(tenantA, id, 'IRT');
        expect(balance.amountMinor).toBe(expected);
        expect(balance.entryCount).toBe(1);
      }
    });

    it('is shown beside the ledger rows, marked MIRZA, and is not part of the history page', async () => {
      await seed();
      await steps().walletHistory.apply(materializeCtx());
      const owner = await createAdmin(ctx.container, tenantA, {
        username: 'reader',
        roleKeys: ['owner'],
      });
      const actor = adminActorFor(owner);
      const ledger = await ctx.container.wallet.history(tenantA, actor, customerA, {});
      expect(ledger.items).toHaveLength(0);
      const imported = await ctx.container.wallet.importedHistory(tenantA, actor, customerA, {});
      expect(
        imported.items.map((i) => [
          i.origin,
          i.source,
          i.direction,
          i.amountMinor,
          i.signedAmountMinor,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ['WALLET_TRANSACTION', 'MIRZA', 'CREDIT', 5000n, 5000n],
          ['WALLET_TRANSACTION', 'MIRZA', 'DEBIT', 3000n, -3000n],
          ['WALLET_TRANSACTION', 'MIRZA', null, 0n, 0n],
          ['WHEEL_SPIN', 'MIRZA', 'CREDIT', 1000n, 1000n],
          ['WHEEL_SPIN', 'MIRZA', null, 0n, 0n],
        ]),
      );
      // Newest first, with a cursor that pages without repeating.
      const first = await ctx.container.wallet.importedHistory(tenantA, actor, customerA, {
        limit: 2,
      });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await ctx.container.wallet.importedHistory(tenantA, actor, customerA, {
        limit: 2,
        ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
      });
      const ids = [...first.items, ...second.items].map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('applied twice, writes nothing the second time', async () => {
      await seed();
      await steps().walletHistory.apply(materializeCtx());
      const snapshot = await q(sql`SELECT * FROM wallet_history_imports ORDER BY source_ref`);
      const second = await steps().walletHistory.apply(materializeCtx());
      expect(second).toMatchObject({ written: 0, alreadyPresent: 5, diverged: 0 });
      expect(await q(sql`SELECT * FROM wallet_history_imports ORDER BY source_ref`)).toEqual(
        snapshot,
      );
    });

    it('the rows are append-only: an UPDATE and a DELETE are refused by the database', async () => {
      await seed();
      await steps().walletHistory.apply(materializeCtx());
      await expect(
        db().execute(sql`UPDATE wallet_history_imports SET note = 'x'`),
      ).rejects.toThrow();
      await expect(db().execute(sql`DELETE FROM wallet_history_imports`)).rejects.toThrow();
    });

    it('the exact-match rows hold: rows and Σ|amount| per Mirza table', async () => {
      await seed();
      await steps().walletHistory.apply(materializeCtx());
      const rows = await matchOf(steps().walletHistory);
      expect(rows.map((r) => r.mirzaTable)).toEqual(['wallet_transaction', 'wheel_list']);
      for (const row of rows) expect(exactMatchHolds(row)).toBe(true);
      const [tx, wh] = rows as [ExactMatchRow, ExactMatchRow];
      expect(tx).toMatchObject({ mirzaRows: 6, nexaRows: 3, nexaSumMinor: 8_000n });
      expect(gaps(tx)).toEqual({
        CUSTOMER_NOT_IMPORTED: 1,
        UNPARSEABLE_AMOUNT: 1,
        UNPARSEABLE_TIME: 1,
      });
      expect(wh).toMatchObject({ mirzaRows: 4, nexaRows: 2, nexaSumMinor: 1_000n });
      expect(gaps(wh)).toEqual({ CUSTOMER_NOT_IMPORTED: 1, UNPARSEABLE_AMOUNT: 1 });
    });
  });

  // ---------------------------------------------------------------------------------------
  describe('tickets and messages', () => {
    async function seed() {
      // Thread X: three rows, one answered (A), out of id order on purpose.
      await supportMsg(10, 'aaaaaaaaaaaaaaaaaaaaaaaa', 1, { admin_answer: 'answer 10' });
      await supportMsg(9, 'aaaaaaaaaaaaaaaaaaaaaaaa', 2, {});
      await supportMsg(11, 'aaaaaaaaaaaaaaaaaaaaaaaa', 3, { customer_text: '' });
      // Thread Y: nobody we know.
      await supportMsg(12, 'bbbbbbbbbbbbbbbbbbbbbbbb', 1, { admin_answer: 'answer 12' }, TG_NOBODY);
      // Thread Z: rows without any text.
      await supportMsg(
        13,
        'cccccccccccccccccccccccc',
        1,
        { customer_text: '', admin_answer: '0' },
        TG_B,
      );
      // The fork: ticket 1 with three messages (one unreadable), ticket 2 of nobody, an orphan.
      await forkTicket('1', {});
      await forkMessage('1', '1', 1, { sender: 'user', message: 'hello' }, '2024-08-01T10:05:00');
      await forkMessage(
        '2',
        '1',
        2,
        { sender: 'admin', message: 'hi there' },
        '2024-08-01T10:06:00',
      );
      await forkMessage('3', '1', 3, { sender: 'robot', message: 'beep' }, '2024-08-01T10:07:00');
      await forkTicket('2', {}, TG_NOBODY);
      await forkMessage('4', '2', 1, { sender: 'user', message: 'lost' }, '2024-08-02T10:00:00');
      await forkMessage('5', '77', 1, { sender: 'user', message: 'orphan' }, '2024-08-03T10:00:00');
    }

    it('writes closed history with the original times and order; answers are signed by a system admin that cannot sign in', async () => {
      await seed();
      const before = await triggered();
      const out = await steps().tickets.apply(materializeCtx());
      expect(out.diverged).toBe(0);
      expect(out.written).toBe(2 + 5);

      const tickets = await q<Record<string, unknown>>(sql`
        SELECT source_ref, status, customer_id, subject, created_at, closed_at, last_message_at, source
          FROM tickets ORDER BY source_ref`);
      expect(tickets.map((t) => t['source_ref'])).toEqual([
        'support-thread:aaaaaaaaaaaaaaaaaaaaaaaa',
        'ticket:1',
      ]);
      for (const t of tickets) {
        expect(t['status']).toBe('CLOSED');
        expect(t['source']).toBe('MIRZA');
        expect(t['closed_at']).not.toBeNull();
      }
      const messages = await q<Record<string, unknown>>(sql`
        SELECT m.source_ref, m.sender_type, m.body, m.created_at, m.seq::int AS seq, a.username, a.status
          FROM ticket_messages m
          JOIN tickets t ON t.id = m.ticket_id AND t.tenant_id = m.tenant_id
          LEFT JOIN admins a ON a.id = m.author_admin_id
         WHERE t.source_ref = 'support-thread:aaaaaaaaaaaaaaaaaaaaaaaa'
         ORDER BY m.seq`);
      // seq 1,2: row 10's question and answer; then row 9's question (row 11 had no text).
      expect(messages.map((m) => [m['source_ref'], m['sender_type']])).toEqual([
        ['support-msg:10', 'CUSTOMER'],
        ['support-msg:10:answer', 'ADMIN'],
        ['support-msg:9', 'CUSTOMER'],
      ]);
      const created = messages.map((m) => new Date(m['created_at'] as string).getTime());
      expect([...created].sort((a, b) => a - b)).toEqual(created);
      expect(messages[1]).toMatchObject({ username: 'mirza-import', status: 'DISABLED' });
      const importAdmin = await q<{ roles: string; hash: string }>(sql`
        SELECT (SELECT count(*) FROM admin_roles r WHERE r.admin_id = a.id)::text AS roles,
               a.password_hash AS hash
          FROM admins a WHERE username = 'mirza-import'`);
      expect(importAdmin[0]?.roles).toBe('0');
      expect(await ctx.container.hasher.verify('', importAdmin[0]?.hash ?? '')).toBe(false);
      expect(await ctx.container.hasher.verify('locked', importAdmin[0]?.hash ?? '')).toBe(false);

      // The category customers are never offered, and no event left the building.
      // Neutral wording (owner rule 2026-10-18): no previous-bot name on the ticket pages.
      const [category] = await q<{ is_active: boolean }>(sql`
        SELECT is_active FROM ticket_categories WHERE title = 'منتقل‌شده از ربات قبلی'`);
      expect(category?.is_active).toBe(false);
      expect(await q(sql`SELECT id FROM ticket_categories WHERE title ILIKE '%mirza%'`)).toEqual(
        [],
      );
      const [author] = await q<{ display_name: string }>(sql`
        SELECT display_name FROM admins WHERE username = 'mirza-import'`);
      expect(author?.display_name).toBe('انتقال از ربات قبلی (سیستم)');
      expect(await triggered()).toEqual(before);
      expect(
        await n(
          sql`SELECT count(*)::text AS n FROM outbox_messages WHERE aggregate_type ILIKE '%ticket%'`,
        ),
      ).toBe(0);
    });

    it('applied twice, writes nothing the second time', async () => {
      await seed();
      await steps().tickets.apply(materializeCtx());
      const snapshot = await q(
        sql`SELECT id, seq, body, created_at FROM ticket_messages ORDER BY seq`,
      );
      const second = await steps().tickets.apply(materializeCtx());
      expect(second).toMatchObject({ written: 0, diverged: 0 });
      expect(second.alreadyPresent).toBe(7);
      expect(
        await q(sql`SELECT id, seq, body, created_at FROM ticket_messages ORDER BY seq`),
      ).toEqual(snapshot);
    });

    // An upgraded installation: an earlier release filed imported tickets under
    // 'Mirza (imported)' and snapshotted that title on each ticket. The neutral title must
    // reach the ticket pages without losing or copying a ticket (Codex on #292).
    const OLD_TITLE = 'Mirza (imported)';
    const NEUTRAL = 'منتقل‌شده از ربات قبلی';
    /** Imports, then puts the category and its tickets back the way the earlier release left them. */
    async function importUnderOldTitle(): Promise<{ categoryId: string; ticketIds: string[] }> {
      await seed();
      await steps().tickets.apply(materializeCtx());
      const [cat] = await q<{ id: string }>(sql`
        SELECT id FROM ticket_categories WHERE title = ${NEUTRAL}`);
      await q(sql`UPDATE ticket_categories SET title = ${OLD_TITLE} WHERE id = ${cat!.id}`);
      await q(sql`UPDATE tickets SET category_title = ${OLD_TITLE} WHERE category_id = ${cat!.id}`);
      const ids = await q<{ id: string }>(sql`SELECT id FROM tickets ORDER BY id`);
      return { categoryId: cat!.id, ticketIds: ids.map((r) => r.id) };
    }
    const ticketRows = () =>
      q<{ id: string; category_id: string; category_title: string }>(sql`
        SELECT id, category_id, category_title FROM tickets ORDER BY id`);

    it('renames the old category in place on a rerun with nothing left to import', async () => {
      // MUTATION: not calling retitleLegacyCategory at the start of apply (only from
      // ensureCategory, which runs only when a ticket is fresh) leaves the old title and fails this.
      const { categoryId, ticketIds } = await importUnderOldTitle();
      const again = await steps().tickets.apply(materializeCtx());
      expect(again).toMatchObject({ written: 0, diverged: 0 });
      expect(await q(sql`SELECT id, title FROM ticket_categories ORDER BY title`)).toEqual([
        { id: categoryId, title: NEUTRAL },
      ]);
      expect(await ticketRows()).toEqual(
        ticketIds.map((id) => ({ id, category_id: categoryId, category_title: NEUTRAL })),
      );
      // Idempotent: a third run changes nothing.
      await steps().tickets.apply(materializeCtx());
      expect(await q(sql`SELECT id, title FROM ticket_categories`)).toEqual([
        { id: categoryId, title: NEUTRAL },
      ]);
    });

    it('when a neutral category already exists, moves the old one’s tickets there and removes it', async () => {
      // MUTATION: dropping the re-point (or renaming into the neutral title) fails this: the
      // tickets would keep the old category, or the rename would violate the unique title.
      const { categoryId: oldId, ticketIds } = await importUnderOldTitle();
      const neutralId = randomUUID();
      await q(sql`
        INSERT INTO ticket_categories (id, tenant_id, title, sort_order, is_active, created_at, updated_at)
        VALUES (${neutralId}, ${tenantA.tenantId}, ${NEUTRAL}, 0, false, now(), now())`);
      await steps().tickets.apply(materializeCtx());
      expect(await q(sql`SELECT id, title FROM ticket_categories`)).toEqual([
        { id: neutralId, title: NEUTRAL },
      ]);
      expect(oldId).not.toBe(neutralId);
      expect(await ticketRows()).toEqual(
        ticketIds.map((id) => ({ id, category_id: neutralId, category_title: NEUTRAL })),
      );
      expect(await n(sql`SELECT count(*)::text AS n FROM ticket_messages`)).toBe(5);
    });

    it('a fresh import into a database holding only the old category files new tickets under it, renamed', async () => {
      await seed();
      const oldId = randomUUID();
      await q(sql`
        INSERT INTO ticket_categories (id, tenant_id, title, sort_order, is_active, created_at, updated_at)
        VALUES (${oldId}, ${tenantA.tenantId}, ${OLD_TITLE}, 0, false, now(), now())`);
      await steps().tickets.apply(materializeCtx());
      expect(await q(sql`SELECT id, title FROM ticket_categories`)).toEqual([
        { id: oldId, title: NEUTRAL },
      ]);
      const used = await q<{ category_id: string; category_title: string }>(sql`
        SELECT DISTINCT category_id, category_title FROM tickets WHERE source = 'MIRZA'`);
      expect(used).toEqual([{ category_id: oldId, category_title: NEUTRAL }]);
    });

    it('never makes a real administrator named mirza-import the author of Mirza answers', async () => {
      // Codex on #288: the name is an ordinary admin username. An ACTIVE operator who took it
      // stops the step; nothing is attributed to them and no ticket is written.
      // MUTATION: dropping the DISABLED/unusable-hash check in ensureImportAdmin fails this.
      await seed();
      await createAdmin(ctx.container, tenantA, {
        username: 'mirza-import',
        roleKeys: ['support'],
      });
      await expect(steps().tickets.apply(materializeCtx())).rejects.toThrow(/mirza-import/u);
      expect(await q(sql`SELECT id FROM tickets WHERE source = 'MIRZA'`)).toEqual([]);
      expect(await q(sql`SELECT id FROM ticket_messages WHERE source = 'MIRZA'`)).toEqual([]);
    });

    it('the exact-match rows hold, each gap counted by reason', async () => {
      await seed();
      await steps().tickets.apply(materializeCtx());
      const rows = await matchOf(steps().tickets);
      expect(rows.map((r) => r.mirzaTable)).toEqual([
        'support_message (threads)',
        'support_message (customer text)',
        'support_message (admin answer)',
        'ticket',
        'ticket_message',
      ]);
      for (const row of rows) expect(exactMatchHolds(row)).toBe(true);
      const [threads, texts, answers, fork, forkMessages] = rows as [
        ExactMatchRow,
        ExactMatchRow,
        ExactMatchRow,
        ExactMatchRow,
        ExactMatchRow,
      ];
      expect(threads).toMatchObject({ mirzaRows: 3, nexaRows: 1 });
      expect(gaps(threads)).toEqual({ CUSTOMER_NOT_IMPORTED: 1, NO_MESSAGE_TEXT: 1 });
      expect(texts).toMatchObject({ mirzaRows: 5, nexaRows: 2 });
      expect(gaps(texts)).toEqual({
        CUSTOMER_NOT_IMPORTED: 1,
        NO_CUSTOMER_TEXT: 1,
        NO_MESSAGE_TEXT: 1,
      });
      expect(answers).toMatchObject({ mirzaRows: 2, nexaRows: 1 });
      expect(fork).toMatchObject({ mirzaRows: 2, nexaRows: 1 });
      expect(gaps(fork)).toEqual({ CUSTOMER_NOT_IMPORTED: 1 });
      expect(forkMessages).toMatchObject({ mirzaRows: 5, nexaRows: 2 });
      expect(gaps(forkMessages)).toEqual({
        TICKET_MESSAGE_SHAPE_UNPROVEN: 1,
        TICKET_NOT_CARRIED: 1,
        TICKET_NOT_IN_PACKAGE: 1,
      });
    });

    it('with no bot to attribute to, nothing is written and the reason is counted; a rerun then writes', async () => {
      await seed();
      const real = new DrizzleTicketHistoryRepository(db(), ctx.container.ids);
      const botless = Object.create(real, {
        resolveBot: { value: async () => null },
      }) as DrizzleTicketHistoryRepository;
      const step = new TicketHistoryStep(
        {
          records: new DrizzleHistoryRecordReader(db()),
          uow: ctx.container.uow,
          scopeActivity: ctx.container.tenants,
          ids: ctx.container.ids,
        },
        botless,
      );
      const out = await step.apply(materializeCtx());
      expect(out.written).toBe(0);
      expect(out.skipped['NO_BOT_INSTANCE']).toBe(2);
      expect(await n(sql`SELECT count(*)::text AS n FROM tickets`)).toBe(0);
      expect(
        (await step.match(materializeCtx())).map((r) => r.explained.map((g) => g.reason)),
      ).toEqual(expect.arrayContaining([expect.arrayContaining(['NO_BOT_INSTANCE'])]));
      const later = await steps().tickets.apply(materializeCtx());
      expect(later.written).toBe(7);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe('referrals', () => {
    async function seed() {
      await referral(1, TG_A, TG_B); // A invited B
      await referral(2, TG_NOBODY, TG_B);
      await referral(3, TG_A, TG_A);
      await referral(4, TG_A, TG_B, { attributed_at: '2024-06-02T12:00:00' }); // B again
      await referral(5, TG_B, TG_A, { attributed_at: null });
    }

    it('links the two customers with the original time; pays nothing and creates nothing', async () => {
      await seed();
      const before = await triggered();
      const walletBefore = await walletFacts();
      const out = await steps().referrals.apply(materializeCtx());
      expect(out).toMatchObject({ written: 1, alreadyPresent: 0, diverged: 0 });
      expect(out.skipped).toEqual({
        REFEREE_ALREADY_REFERRED: 1,
        REFERRAL_PARTY_MISSING: 1,
        REFERRAL_SELF: 1,
        UNPARSEABLE_TIME: 1,
      });
      const rows = await q<Record<string, unknown>>(sql`
        SELECT referrer_id, referee_id, trigger, rewarded_at, reward_entry_id, source, source_ref, created_at
          FROM referrals`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        referrer_id: customerA,
        referee_id: customerB,
        trigger: 'ON_SIGNUP',
        rewarded_at: null,
        reward_entry_id: null,
        source: 'MIRZA',
        source_ref: 'referral:1',
      });
      expect(new Date(rows[0]?.['created_at'] as string).toISOString()).toBe(
        '2024-06-01T08:30:00.000Z',
      );
      expect(await triggered()).toEqual(before);
      expect(await walletFacts()).toEqual(walletBefore);
    });

    it('applied twice, writes nothing; the exact-match row holds', async () => {
      await seed();
      await steps().referrals.apply(materializeCtx());
      const second = await steps().referrals.apply(materializeCtx());
      expect(second).toMatchObject({ written: 0, alreadyPresent: 1, diverged: 0 });
      const [row] = await matchOf(steps().referrals);
      expect(row && exactMatchHolds(row)).toBe(true);
      expect(row).toMatchObject({ mirzaRows: 5, nexaRows: 1, mirzaSumMinor: null });
    });

    it('of several rows for one referee carries the earliest, whatever order the records are read in', async () => {
      // Mirza id 1 is the LATER attribution; id 2 the earlier. Record ids are random uuids, so
      // a rule that depended on read order would pick either one on different runs.
      await referral(1, TG_A, TG_B, { attributed_at: '2024-06-09T12:00:00' });
      await referral(2, TG_A, TG_B, { attributed_at: '2024-06-01T12:00:00' });
      await referral(3, TG_A, TG_B, { attributed_at: '2024-06-05T12:00:00' });
      const out = await steps().referrals.apply(materializeCtx());
      expect(out).toMatchObject({ written: 1, diverged: 0 });
      expect(out.skipped).toEqual({ REFEREE_ALREADY_REFERRED: 2 });
      expect(
        (await q<{ source_ref: string }>(sql`SELECT source_ref FROM referrals`))[0]?.source_ref,
      ).toBe('referral:2');
      const second = await steps().referrals.apply(materializeCtx());
      expect(second).toMatchObject({ written: 0, alreadyPresent: 1, diverged: 0 });
    });

    it('does not create a second attribution for a referee who already has a NEXA one', async () => {
      await db().execute(sql`
        INSERT INTO referrals (id, tenant_id, referrer_id, referee_id, trigger, created_at)
        VALUES (${randomUUID()}, ${tenantA.tenantId}, ${customerB}, ${customerA}, 'ON_SIGNUP', now())`);
      await referral(1, TG_B, TG_A);
      const out = await steps().referrals.apply(materializeCtx());
      expect(out.written).toBe(0);
      expect(out.skipped).toEqual({ REFEREE_ALREADY_REFERRED: 1 });
    });
  });

  // ---------------------------------------------------------------------------------------
  describe('discount usage', () => {
    const CODE_REF = 'code:0123456789abcdef01234567';

    async function seedCatalogue() {
      const discountId = randomUUID();
      await db().execute(sql`
        INSERT INTO discounts (id, tenant_id, kind, code, label, type, status, value, currency,
                               applies_to, total_redemptions_limit, source, source_ref)
        VALUES (${discountId}, ${tenantA.tenantId}, 'CODE', 'MZ77', 'Mirza 77', 'PERCENTAGE',
                'INACTIVE', 10, NULL, ARRAY['NEW_SERVICE'], 1, 'MIRZA',
                ${catalogDiscountSourceRef('legacy:discount:77')})`);
      await record(
        'discount',
        'legacy:discount:77',
        { record_type: 'legacy_discount_code', source_pk: '77', code_ref: CODE_REF },
        null,
      );
      // A TRIAL-shaped order: the order shape checks need a product for any other purpose, and
      // the limit rules under test read only the order's state and origin.
      const orderId = randomUUID();
      await db().execute(sql`
        INSERT INTO orders (id, tenant_id, customer_id, state, purpose, origin, panel_id, line_title,
                            line_duration_days, line_traffic_bytes, line_unit_price_amount,
                            subtotal_amount, discount_amount, total_amount, currency, quote,
                            settled_at, source, source_ref)
        VALUES (${orderId}, ${tenantA.tenantId}, ${customerA}, 'PAID', 'TRIAL', 'LEGACY_HISTORY',
                ${randomUUID()}, 'Mirza plan', 30, 1073741824, 0, 0, 0, 0, 'IRT', '{}'::jsonb,
                '2024-05-01T10:00:00Z', 'MIRZA', 'invoice:abcd1234')`);
      return { discountId, orderId };
    }

    async function usage(pk: number, over: Rec, tg: string | null = TG_A) {
      await record(
        'discount_usage',
        `legacy:discount-usage:${pk}`,
        {
          record_type: 'legacy_discount_usage',
          source_pk: String(pk),
          code_ref: CODE_REF,
          code_match: 'EXACT_STRING_DIGEST',
          customer: { telegram_user_id: tg },
          fields_raw: { id_invoice: 'abcd1234', price: '9000' },
          ...over,
        },
        tg,
      );
    }

    async function seed() {
      const facts = await seedCatalogue();
      await usage(1, {}); // everything known
      await usage(2, {
        code_ref: null,
        code_match: 'UNAVAILABLE_CODE_SECRET',
        fields_raw: undefined,
      }); // documented table
      await usage(3, { fields_raw: { id_invoice: 'ffff0000', price: '9000' } }); // order unknown
      await usage(4, { fields_raw: { id_invoice: 'abcd1234' } }); // no amount
      await usage(5, {}, TG_NOBODY);
      await usage(6, {}); // the same order and discount again
      return facts;
    }

    it('carries a redemption only where the discount, the order and the amount are known; counts the rest', async () => {
      const { discountId, orderId } = await seed();
      const before = await triggered();
      const out = await steps().discountUsage.apply(materializeCtx());
      expect(out).toMatchObject({ written: 1, alreadyPresent: 0, diverged: 0 });
      expect(out.skipped).toEqual({
        AMOUNT_UNKNOWN: 1,
        CUSTOMER_NOT_IMPORTED: 1,
        DISCOUNT_UNKNOWN: 1,
        DUPLICATE_REDEMPTION: 1,
        ORDER_UNKNOWN: 1,
      });
      const rows = await q<Record<string, unknown>>(sql`
        SELECT discount_id, order_id, customer_id, amount::text AS amount, currency FROM discount_redemptions`);
      expect(rows).toEqual([
        {
          discount_id: discountId,
          order_id: orderId,
          customer_id: customerA,
          amount: '9000',
          currency: 'IRT',
        },
      ]);
      expect(await triggered()).toEqual(before);
      const second = await steps().discountUsage.apply(materializeCtx());
      expect(second).toMatchObject({ written: 0, alreadyPresent: 1, diverged: 0 });
      const [row] = await matchOf(steps().discountUsage);
      expect(row && exactMatchHolds(row)).toBe(true);
      expect(row).toMatchObject({ mirzaRows: 6, nexaRows: 1 });
    });

    it('matches after an apply over the SAME context object, as the executor passes it', async () => {
      // Codex on #288: the dedupe set was keyed by the context, so the match that follows an
      // apply with the same object saw every carried pair as a DUPLICATE_REDEMPTION.
      // MUTATION: dropping the per-traversal context copy in apply/match fails this.
      await seed();
      const ctx = materializeCtx();
      await steps().discountUsage.apply(ctx);
      const [row] = await steps().discountUsage.match(ctx);
      expect(
        row && exactMatchHolds(row),
        JSON.stringify(row, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
      ).toBe(true);
      expect(row).toMatchObject({ mirzaRows: 6, nexaRows: 1 });
    });

    it('a history redemption does not consume a limit (and a NEXA one does)', async () => {
      const { discountId } = await seed();
      await steps().discountUsage.apply(materializeCtx());
      const repo = new DrizzleDiscountRepository(db());
      expect(
        (await repo.usage(tenantA, [discountId], customerA, null)).get(discountId),
      ).toBeUndefined();

      // Contrast, so the assertion above is not vacuous: an ordinary PAID order does count.
      const nexaOrder = randomUUID();
      await db().execute(sql`
        INSERT INTO orders (id, tenant_id, customer_id, state, purpose, origin, panel_id, line_title,
                            line_duration_days, line_traffic_bytes, line_unit_price_amount,
                            subtotal_amount, discount_amount, total_amount, currency, quote, settled_at)
        VALUES (${nexaOrder}, ${tenantA.tenantId}, ${customerA}, 'PAID', 'TRIAL', 'STANDARD',
                ${randomUUID()}, 'plan', 30, 1073741824, 0, 0, 0, 0, 'IRT', '{}'::jsonb, now())`);
      await db().execute(sql`
        INSERT INTO discount_redemptions (id, tenant_id, discount_id, customer_id, order_id, amount, currency)
        VALUES (${randomUUID()}, ${tenantA.tenantId}, ${discountId}, ${customerA}, ${nexaOrder}, 9000, 'IRT')`);
      expect((await repo.usage(tenantA, [discountId], customerA, null)).get(discountId)).toEqual({
        live: 1,
        liveForCustomer: 1,
      });
    });
  });

  // ---------------------------------------------------------------------------------------
  it('all five steps together change no balance and trigger nothing', async () => {
    await customer('7000000003');
    await ctx.container.database.db.execute(sql`
      INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount, currency, reference, created_at)
      VALUES (${randomUUID()}, ${tenantA.tenantId}, ${customerA}, 'CREDIT', 'MIGRATION_OPENING_BALANCE',
              9000, 'IRT', ${'legacy:opening:a'}, now())`);
    await payment(1, {});
    await walletTx(1, {});
    await wheel(1, {});
    await supportMsg(1, 'dddddddddddddddddddddddd', 1, { admin_answer: 'ok' });
    await referral(1, TG_A, TG_B);
    const before = await triggered();
    const wallet = await walletFacts();
    for (const step of Object.values(steps())) await step.apply(materializeCtx());
    expect(await walletFacts()).toEqual(wallet);
    expect(await triggered()).toEqual(before);
    // …and a second pass over everything writes nothing.
    for (const step of Object.values(steps())) {
      const again = await step.apply(materializeCtx());
      expect(again.written).toBe(0);
      expect(again.diverged).toBe(0);
    }
  });
});
