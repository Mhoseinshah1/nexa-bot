import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PAYMENT_AMOUNT_MAX_MINOR,
  money,
  type ActorContext,
  type BotInstanceId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import { signedMinor } from '../../apps/api/src/modules/commerce/wallet/domain/balance';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * The wallet ledger — the only financial truth in this system.
 *
 * Every case here is one of the ways the legacy wallet went wrong, expressed as
 * something that must now be impossible rather than unlikely:
 *
 *   - the BALANCE is derived. There is no column to disagree with the entries, which is
 *     what left `2,659,767` with an unexplained residual of `916,550` (`UNK-RSV2-012`).
 *   - the SIGN lives in `direction`, applied once. `RSV2-BR-019` records a report that
 *     ADDS administrative debits to the top-up total instead of subtracting them.
 *   - HISTORY is append-only, enforced by triggers rather than by intention.
 *   - a MOVEMENT is idempotent at a unique index, so a retry, a double-click and two
 *     replicas produce one entry.
 *   - a balance is per CURRENCY. Summing across currencies is an implicit conversion at
 *     a rate nobody chose, and no rate exists anywhere in this system (`FBR-010`).
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

describe('the wallet ledger', () => {
  let ctx: TestContext;
  let repository: DrizzleWalletRepository;
  let customerA: UserId;
  let owner: ActorContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    repository = new DrizzleWalletRepository(ctx.container.database.db);
    customerA = await customer(tenantA, '900500');
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-wallet', roleKeys: ['owner'] }),
    );
  });

  async function customer(scope: typeof tenantA, telegramUserId: string): Promise<UserId> {
    const resolved = await ctx.container.customers.resolveFromUpdate(
      scope,
      {
        type: 'SYSTEM_JOB',
        id: null,
        label: 'telegram-update:test',
        surface: 'TELEGRAM',
        correlationId: `resolve-${telegramUserId}` as never,
      },
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'زهرا' },
        botInstanceId: scope === tenantA ? BOT_A : (SEED_IDS.botB1 as BotInstanceId),
      },
    );
    return resolved.customer.id;
  }

  /** Appends directly, for the cases about the LEDGER rather than about the service. */
  const appendResult = (
    scope: typeof tenantA,
    customerId: UserId,
    direction: 'CREDIT' | 'DEBIT',
    amountMinor: bigint,
    reference: string,
    currency: 'IRT' | 'IRR' = 'IRT',
  ) =>
    repository.append(scope, {
      id: ctx.container.ids.uuid(),
      customerId,
      direction,
      reason: direction === 'CREDIT' ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT',
      amount: money(amountMinor, currency),
      reference,
      note: 'test',
      now: ctx.container.clock.now(),
    });

  /**
   * The ENTRY, which is what nearly every case here is about.
   *
   * `appendResult` above exposes `inserted` as well — the flag that tells a caller
   * whether this call WROTE, so a domain event follows the movement rather than the
   * command. One case below is about that flag; the rest want the row.
   */
  const append = async (
    scope: typeof tenantA,
    customerId: UserId,
    direction: 'CREDIT' | 'DEBIT',
    amountMinor: bigint,
    reference: string,
    currency: 'IRT' | 'IRR' = 'IRT',
  ) => (await appendResult(scope, customerId, direction, amountMinor, reference, currency)).entry;

  const balance = (scope: typeof tenantA, customerId: UserId, currency: 'IRT' | 'IRR' = 'IRT') =>
    repository.balanceOf(scope, customerId, currency);

  // -------------------------------------------------------------------------
  // The balance is derived, and the sign is applied once
  // -------------------------------------------------------------------------

  it('derives a balance from the entries, and reports how many produced it', async () => {
    expect(await balance(tenantA, customerA)).toEqual({
      currency: 'IRT',
      amountMinor: 0n,
      entryCount: 0,
    });

    await append(tenantA, customerA, 'CREDIT', 500_000n, 'ref-1');
    await append(tenantA, customerA, 'DEBIT', 120_000n, 'ref-2');
    await append(tenantA, customerA, 'CREDIT', 20_000n, 'ref-3');

    // 500,000 − 120,000 + 20,000. A DEBIT subtracts; the legacy report adds it.
    expect(await balance(tenantA, customerA)).toEqual({
      currency: 'IRT',
      amountMinor: 400_000n,
      entryCount: 3,
    });
  });

  it('agrees with the TypeScript sign rule over every direction', async () => {
    /*
     * Two statements of one rule — `signedMinor` in TypeScript, a CASE in SQL — and
     * this is what makes the duplication safe. The same shape the catalogue predicate
     * uses, for the same reason: without it the SQL is free to drift into a second
     * vocabulary, and the drift would be a sign error on somebody's money.
     */
    const moves: readonly (readonly ['CREDIT' | 'DEBIT', bigint])[] = [
      ['CREDIT', 1n],
      ['DEBIT', 7n],
      ['CREDIT', 999_999_999n],
      ['DEBIT', 2n],
      ['CREDIT', 40n],
    ];
    let expected = 0n;
    for (const [index, [direction, amount]] of moves.entries()) {
      await append(tenantA, customerA, direction, amount, `agree-${String(index)}`);
      expected += signedMinor(direction, amount);
    }
    expect((await balance(tenantA, customerA)).amountMinor).toBe(expected);
  });

  it('keeps a balance EXACT past the precision of a JavaScript number', async () => {
    // 2^53 + 1. A balance routed through `Number` loses this, and IRR minor units put
    // it within reach of an ordinary tenant.
    const past = 9_007_199_254_740_993n;
    await append(tenantA, customerA, 'CREDIT', past, 'big-1');
    const read = await balance(tenantA, customerA);
    expect(read.amountMinor).toBe(past);
    expect(read.amountMinor.toString()).toBe('9007199254740993');
  });

  it('answers per CURRENCY, and never sums across them', async () => {
    await append(tenantA, customerA, 'CREDIT', 100n, 'irt-1', 'IRT');
    await append(tenantA, customerA, 'CREDIT', 900n, 'irr-1', 'IRR');

    // Two balances, not one of 1000. A single figure would be a conversion at a rate
    // nobody chose, and no rate exists on any gateway the research inspected.
    expect((await balance(tenantA, customerA, 'IRT')).amountMinor).toBe(100n);
    expect((await balance(tenantA, customerA, 'IRR')).amountMinor).toBe(900n);
  });

  /*
   * The HISTORY answers about the same money as the balance above it.
   *
   * `balanceOf` has always filtered by currency; `list` did not. So a page that renders
   * a balance over a ledger table showed «موجودی: ۰» above rows adding to 5,000,000 as
   * soon as a tenant changed `sales.currency` — the legacy "residual nobody can
   * explain" shape, reproduced by a setting with a picker in the Web Admin.
   *
   * Two currencies in one customer's ledger is exactly what that change leaves behind:
   * `WalletService.adjust` refuses a non-selling currency, so this is written through
   * the repository, which is what the rows look like afterwards.
   */
  it('lists the movements the balance is computed from, and no others', async () => {
    await append(tenantA, customerA, 'CREDIT', 100n, 'mixed-irt-1', 'IRT');
    await append(tenantA, customerA, 'CREDIT', 900n, 'mixed-irr-1', 'IRR');
    await append(tenantA, customerA, 'DEBIT', 40n, 'mixed-irt-2', 'IRT');

    const page = await repository.list(tenantA, customerA, 'IRT', 50, null);
    expect(page.items.map((e) => e.reference).sort()).toEqual(['mixed-irt-1', 'mixed-irt-2']);
    // Stated as the invariant rather than as a row count: the history and the balance
    // must agree about WHICH movements exist, not merely about how many.
    expect(page.items.every((e) => e.amount.currency === 'IRT')).toBe(true);

    const other = await repository.list(tenantA, customerA, 'IRR', 50, null);
    expect(other.items.map((e) => e.reference)).toEqual(['mixed-irr-1']);
  });

  // -------------------------------------------------------------------------
  // Append-only, and idempotent
  // -------------------------------------------------------------------------

  it('refuses an UPDATE and a DELETE of a historical entry, in the database', async () => {
    const entry = await append(tenantA, customerA, 'CREDIT', 250n, 'frozen-1');

    /*
     * The RAW client: drizzle's `execute` wraps a driver error and drops the message,
     * so a test asserting through it could not tell this trigger from a typo.
     *
     * `wallet_entries_no_update` / `_no_delete` (migration 0033) are what make the
     * ledger append-only for application code. Tests reset with TRUNCATE, which
     * bypasses row triggers deliberately — the guard protects the application, which is
     * the only thing it is protecting against.
     */
    await expect(
      ctx.container.database.withClient((client) =>
        client.query('UPDATE wallet_entries SET amount = 1 WHERE id = $1', [entry.id]),
      ),
    ).rejects.toThrowError(/append-only|immutable|not allowed|reject/i);

    await expect(
      ctx.container.database.withClient((client) =>
        client.query('DELETE FROM wallet_entries WHERE id = $1', [entry.id]),
      ),
    ).rejects.toThrowError(/append-only|immutable|not allowed|reject/i);

    expect((await balance(tenantA, customerA)).amountMinor).toBe(250n);
  });

  it('moves money ONCE for a repeated reference, and returns the first entry', async () => {
    const first = await append(tenantA, customerA, 'DEBIT', 90n, 'once-1');
    const again = await append(tenantA, customerA, 'DEBIT', 90n, 'once-1');

    expect(again.id).toBe(first.id);
    const read = await balance(tenantA, customerA);
    expect(read.entryCount, 'a repeated reference wrote a second entry').toBe(1);
    expect(read.amountMinor).toBe(-90n);
  });

  it('moves money ONCE when two appends race the same reference', async () => {
    /*
     * The insert is `ON CONFLICT DO NOTHING` and then a re-read, so the loser of the
     * race returns the winner's row rather than throwing an integrity error at a
     * customer or — worse — catching it and retrying into a second movement.
     */
    const [a, b] = await Promise.all([
      append(tenantA, customerA, 'CREDIT', 1_000n, 'race-1'),
      append(tenantA, customerA, 'CREDIT', 1_000n, 'race-1'),
    ]);

    expect(a.id).toBe(b.id);
    const read = await balance(tenantA, customerA);
    expect(read.entryCount).toBe(1);
    expect(read.amountMinor).toBe(1_000n);
  });

  // -------------------------------------------------------------------------
  // Tenancy
  // -------------------------------------------------------------------------

  /*
   * `inserted` tells the caller whether this call WROTE, and that is what a domain
   * event has to follow.
   *
   * Self-review finding S3: both services emitted `WalletEntryRecorded` unconditionally
   * after `append`, so a retry that re-read an existing entry — the fall-through
   * `WalletService.adjust` documents when an idempotency row has outlived its entry,
   * which a restore can produce — put a SECOND event on one movement. A consumer
   * acting per event would act twice.
   */
  it('reports whether an append actually WROTE, so an event can follow the movement', async () => {
    const first = await appendResult(tenantA, customerA, 'CREDIT', 500n, 'once');
    const again = await appendResult(tenantA, customerA, 'CREDIT', 500n, 'once');

    expect(first.inserted).toBe(true);
    expect(again.inserted, 'a re-read reported itself as a write').toBe(false);
    expect(again.entry.id).toBe(first.entry.id);
  });

  it('cannot see, sum or address another tenant’s entries', async () => {
    const customerB = await customer(tenantB, '900600');
    await append(tenantA, customerA, 'CREDIT', 400n, 'mine-1');
    await append(tenantB, customerB, 'CREDIT', 7_000n, 'theirs-1');

    // A's balance holds only A's money...
    expect((await balance(tenantA, customerA)).amountMinor).toBe(400n);
    expect((await balance(tenantB, customerB)).amountMinor).toBe(7_000n);

    // ...asking for B's customer under A's scope finds nothing rather than B's money.
    expect((await balance(tenantA, customerB)).amountMinor).toBe(0n);

    // ...the history is scoped the same way...
    expect((await repository.list(tenantA, customerB, 'IRT', 50, null)).items).toEqual([]);

    // ...and so is the reference lookup, which is what a replay reads back. A shared
    // reference string across tenants is two different movements.
    expect(await repository.findByReference(tenantA, 'theirs-1')).toBeNull();
    expect(await repository.findByReference(tenantB, 'theirs-1')).not.toBeNull();
  });

  it('lets two tenants hold the same reference independently', async () => {
    const customerB = await customer(tenantB, '900700');
    const a = await append(tenantA, customerA, 'CREDIT', 11n, 'shared-ref');
    const b = await append(tenantB, customerB, 'CREDIT', 22n, 'shared-ref');

    // `wallet_entries_tenant_reference_key` is per TENANT. One installation's
    // idempotency key must not silently dedupe another's movement.
    expect(a.id).not.toBe(b.id);
    expect((await balance(tenantA, customerA)).amountMinor).toBe(11n);
    expect((await balance(tenantB, customerB)).amountMinor).toBe(22n);
  });

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  it('pages newest first over an immutable key, without repeating or skipping', async () => {
    for (let i = 0; i < 5; i += 1) {
      await append(tenantA, customerA, 'CREDIT', BigInt(i + 1), `page-${String(i)}`);
    }

    const first = await repository.list(tenantA, customerA, 'IRT', 2, null);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await repository.list(tenantA, customerA, 'IRT', 2, first.nextCursor);
    const third = await repository.list(tenantA, customerA, 'IRT', 2, second.nextCursor);

    const seen = [...first.items, ...second.items, ...third.items].map((e) => e.reference);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size, 'a row appeared on two pages').toBe(5);
    // Newest first: a ledger is read backwards from the last thing that happened.
    expect(seen[0]).toBe('page-4');
    expect(seen[4]).toBe('page-0');
    expect(third.nextCursor).toBeNull();
  });

  it('pages over MICROSECONDS, so two entries inside one millisecond do not straddle', async () => {
    /*
     * Written through raw SQL on purpose: `Clock.now()` is a JavaScript `Date` and
     * holds milliseconds, so the application can never produce the row that breaks
     * this. `timestamptz` holds microseconds, and a backfill, a restore or a hand-run
     * statement can. Formatting the cursor through `Date.toISOString()` truncates to
     * `.123Z`, and then NO row matches `created_at < .123Z` or `= .123Z` — the second
     * page comes back empty and two movements vanish from the history of somebody's
     * money.
     */
    await ctx.container.database.withClient(async (client) => {
      for (const [i, micros] of ['123456', '123457', '123458'].entries()) {
        await client.query(
          `INSERT INTO wallet_entries
             (id, tenant_id, customer_id, direction, reason, amount, currency, reference,
              note, created_at)
           VALUES ($1, $2, $3, 'CREDIT', 'ADMIN_CREDIT', 10, 'IRT', $4, 'micro',
                   $5::timestamptz)`,
          [
            ctx.container.ids.uuid(),
            SEED_IDS.tenantA,
            customerA,
            `micro-${String(i)}`,
            `2026-01-01T00:00:00.${micros}Z`,
          ],
        );
      }
    });

    const first = await repository.list(tenantA, customerA, 'IRT', 2, null);
    expect(first.nextCursor?.createdAt).toMatch(/\.\d{6}Z$/u);

    const second = await repository.list(tenantA, customerA, 'IRT', 2, first.nextCursor);
    const seen = [...first.items, ...second.items].map((e) => e.reference);
    expect(seen, 'a microsecond-distinct entry was skipped or repeated').toEqual([
      'micro-2',
      'micro-1',
      'micro-0',
    ]);
  });

  it('reassembles an amount with its currency, never one without the other', async () => {
    await append(tenantA, customerA, 'DEBIT', 12_345n, 'shape-1');
    const [entry] = (await repository.list(tenantA, customerA, 'IRT', 1, null)).items;

    expect(entry?.amount).toEqual(money(12_345n, 'IRT'));
    expect(entry?.direction).toBe('DEBIT');
    expect(entry?.reason).toBe('ADMIN_DEBIT');
    // Positive on the row. The sign is `direction`'s job and nothing else's.
    const raw = await ctx.container.database.db.execute(
      sql`SELECT amount FROM wallet_entries WHERE reference = 'shape-1'`,
    );
    expect(String((raw.rows[0] as { amount: string }).amount)).toBe('12345');
  });

  it('records the administrator behind an adjustment, and nobody behind a flow', async () => {
    const { entry: byAdmin } = await repository.append(tenantA, {
      id: ctx.container.ids.uuid(),
      customerId: customerA,
      direction: 'CREDIT',
      reason: 'ADMIN_CREDIT',
      amount: money(5n, 'IRT'),
      reference: 'who-1',
      actorAdminId: owner.id,
      note: 'goodwill',
      now: ctx.container.clock.now(),
    });
    const byFlow = await append(tenantA, customerA, 'DEBIT', 5n, 'who-2');

    /*
     * The difference IS the answer to "did a person do this". `LGR-BR-063` records the
     * legacy log as naming the actor but never the reason, and `LGR-BR-083` that no
     * admin mutation other than a wallet adjustment and a receipt approval is logged
     * at all. Here the reason is a constrained column and the actor is a foreign key.
     */
    expect(byAdmin.actorAdminId).toBe(owner.id);
    expect(byAdmin.note).toBe('goodwill');
    expect(byFlow.actorAdminId).toBeNull();
  });
  // -------------------------------------------------------------------------
  // WalletService — the one place an operator may move money by hand
  // -------------------------------------------------------------------------

  describe('an administrative adjustment', () => {
    const adjust = (
      actor: ActorContext,
      input: {
        key: string;
        direction: 'CREDIT' | 'DEBIT';
        amountMinor: bigint;
        currency?: 'IRT' | 'IRR';
        customerId?: UserId;
      },
    ) =>
      ctx.container.wallet.adjust(tenantA, actor, input.customerId ?? customerA, {
        idempotencyKey: input.key,
        direction: input.direction,
        amountMinor: input.amountMinor,
        currency: input.currency ?? 'IRT',
        note: 'by hand',
      });

    it('credits once for a repeated command, and commits the audit and the event with it', async () => {
      const first = await adjust(owner, {
        key: 'adj-key-0001',
        direction: 'CREDIT',
        amountMinor: 500n,
      });
      const again = await adjust(owner, {
        key: 'adj-key-0001',
        direction: 'CREDIT',
        amountMinor: 500n,
      });

      expect(again.id).toBe(first.id);
      expect(first.reason).toBe('ADMIN_CREDIT');
      expect(first.actorAdminId).toBe(owner.id);
      expect(await balance(tenantA, customerA)).toMatchObject({ amountMinor: 500n, entryCount: 1 });

      const audit = (await ctx.container.database.db.execute(
        sql`SELECT action, result FROM audit_logs WHERE entity_type = 'Wallet'` as never,
      )) as unknown as { rows: { action: string; result: string }[] };
      expect(audit.rows).toEqual([{ action: 'wallet.credit', result: 'SUCCESS' }]);

      const events = (await ctx.container.database.db.execute(
        sql`SELECT event_type FROM outbox_messages WHERE aggregate_type = 'Wallet'` as never,
      )) as unknown as { rows: { event_type: string }[] };
      expect(events.rows.map((r) => r.event_type)).toEqual(['WalletEntryRecorded']);
    });

    /*
     * The reference is DERIVED from the idempotency key, so it is the same value in
     * any process after any restart. A generated one would have to be stored to
     * survive a retry, and the retry that missed that row would move the money twice.
     */
    it('derives the same reference from the same key, with no lookup', async () => {
      const entry = await adjust(owner, {
        key: 'adj-key-0002',
        direction: 'CREDIT',
        amountMinor: 7n,
      });
      expect(entry.reference).toMatch(/^[0-9a-f]{16}:adjust$/u);

      const again = await ctx.container.wallet.adjust(tenantA, owner, customerA, {
        idempotencyKey: 'adj-key-0002',
        direction: 'CREDIT',
        amountMinor: 7n,
        currency: 'IRT',
        note: 'by hand',
      });
      expect(again.reference).toBe(entry.reference);
    });

    it('refuses a debit the balance cannot cover, and names the SHORTFALL', async () => {
      await adjust(owner, { key: 'adj-key-0003', direction: 'CREDIT', amountMinor: 100n });

      await expect(
        adjust(owner, { key: 'adj-key-0004', direction: 'DEBIT', amountMinor: 250n }),
      ).rejects.toMatchObject({
        code: 'commerce.wallet_insufficient_funds',
        // The shortfall and not the balance: `bot.wallet.insufficient` declares exactly
        // that one placeholder, because it is the number a customer can act on.
        details: { shortfallMinor: '150' },
      });

      expect(await balance(tenantA, customerA)).toMatchObject({ amountMinor: 100n, entryCount: 1 });
    });

    it('refuses an amount of zero or past the ceiling, as a refusal and not a 500', async () => {
      for (const amountMinor of [0n, -1n, PAYMENT_AMOUNT_MAX_MINOR + 1n]) {
        await expect(
          adjust(owner, {
            key: `adj-key-amt-${String(amountMinor)}`,
            direction: 'CREDIT',
            amountMinor,
          }),
        ).rejects.toMatchObject({ code: 'commerce.request_invalid' });
      }
      expect(await balance(tenantA, customerA)).toMatchObject({ entryCount: 0 });
    });

    it('refuses a currency this installation does not sell in', async () => {
      await expect(
        adjust(owner, {
          key: 'adj-key-0005',
          direction: 'CREDIT',
          amountMinor: 10n,
          currency: 'IRR',
        }),
      ).rejects.toMatchObject({ code: 'commerce.wallet_currency_unsupported' });
      expect(await balance(tenantA, customerA, 'IRR')).toMatchObject({ entryCount: 0 });
    });

    /*
     * A stopped installation refuses the write INSIDE the transaction, not in the
     * controller.
     *
     * `CLAUDE.md` makes this a non-negotiable and names why: a surface checks activity
     * when the request arrives and a stop can commit in between. Panels was the module
     * that skipped it, which let a tenant an operator had stopped be given new panels
     * and a background monitor. Here it would be new money.
     */
    it('refuses an installation that has stopped accepting work', async () => {
      await ctx.container.database.db.execute(
        sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}` as never,
      );

      await expect(
        adjust(owner, { key: 'adj-key-stopped', direction: 'CREDIT', amountMinor: 10n }),
      ).rejects.toThrow();

      const entries = (await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM wallet_entries` as never,
      )) as unknown as { rows: { n: number }[] };
      expect(entries.rows[0]?.n).toBe(0);
    });

    /*
     * The fall-through `adjust` documents, PRODUCED: an idempotency row that outlived
     * its entry, which a restore can produce.
     *
     * This is the only path on which `inserted` is load-bearing rather than defensive.
     * The replay lookup finds nothing, the command runs again, and the append re-reads
     * the entry already sitting under the derived reference — so the movement did not
     * happen twice and the EVENT must not either. Without the gate a consumer acting
     * per event acts twice on one movement.
     *
     * Reaching it needs the row removed deliberately, because nothing in ordinary
     * operation separates the two: they commit in one transaction.
     */
    it('emits no second event when a replay re-reads an entry it did not write', async () => {
      await adjust(owner, { key: 'adj-key-restore', direction: 'CREDIT', amountMinor: 400n });
      await ctx.container.database.db.execute(
        sql`DELETE FROM request_idempotency WHERE key = 'adj-key-restore'` as never,
      );

      // The same command, with its remembered answer gone.
      await adjust(owner, { key: 'adj-key-restore', direction: 'CREDIT', amountMinor: 400n });

      expect(await balance(tenantA, customerA)).toMatchObject({
        amountMinor: 400n,
        entryCount: 1,
      });
      const events = (await ctx.container.database.db.execute(
        sql`SELECT event_type FROM outbox_messages WHERE aggregate_type = 'Wallet'` as never,
      )) as unknown as { rows: { event_type: string }[] };
      expect(events.rows, 'one movement produced two events').toHaveLength(1);
    });

    /*
     * CREDIT and DEBIT are SEPARATE permissions with different risk labels, and this
     * proves the direction picks which one rather than merely that some permission is
     * charged. `finance` is the actor that can tell them apart: it holds
     * `users.wallet.credit` and not `users.wallet.debit`, so an implementation that
     * charged CREDIT for both would let it take money away. An actor holding neither
     * — `support` — is refused either way and proves nothing about which was asked.
     *
     * The refusal also leaves an audit row: an early `guard.check` that merely throws
     * never reaches `runAuthorizedMutation`, which is what records a denial.
     */
    it('charges the direction’s OWN permission, and audits the refusal', async () => {
      const finance = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'finance-wallet',
          roleKeys: ['finance'],
        }),
      );

      const credited = await adjust(finance, {
        key: 'adj-key-0006',
        direction: 'CREDIT',
        amountMinor: 50n,
      });
      expect(credited.actorAdminId).toBe(finance.id);

      await expect(
        adjust(finance, { key: 'adj-key-0007', direction: 'DEBIT', amountMinor: 1n }),
      ).rejects.toMatchObject({ code: 'platform.permission_denied' });

      const audit = (await ctx.container.database.db.execute(
        sql`SELECT action, result FROM audit_logs WHERE entity_type = 'Wallet'
            ORDER BY occurred_at ASC, id ASC` as never,
      )) as unknown as { rows: { action: string; result: string }[] };
      expect(audit.rows).toEqual([
        { action: 'wallet.credit', result: 'SUCCESS' },
        { action: 'wallet.debit', result: 'DENIED' },
      ]);
      // The refused debit moved nothing.
      expect(await balance(tenantA, customerA)).toMatchObject({
        amountMinor: 50n,
        entryCount: 1,
      });
    });
  });
});
