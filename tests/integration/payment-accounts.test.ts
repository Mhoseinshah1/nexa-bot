import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isNexaError,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type PaymentAccountId,
  type ProductId,
  type UserId,
  money,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { PaymentDestinationRenderer } from '../../apps/api/src/modules/commerce/payments/infrastructure/destination-renderer';
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
 * Manual-transfer accounts, and the snapshot a payment keeps of one.
 *
 * Every case here is one of the ways a destination and an instruction could come to
 * disagree, which is the whole of what 5A exists to prevent:
 *
 *   - the destination is CHOSEN inside the issuing transaction and FROZEN in the same
 *     one, so a payment either has one or was never created;
 *   - editing, disabling or replacing an account changes what sells next and NOTHING
 *     about what was already sold;
 *   - a disabled account cannot be selected, promoted, or left holding the default;
 *   - one tenant's card number is unreachable with the other tenant's id;
 *   - a structurally invalid card or Sheba is refused by the schema AND by the table.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

/**
 * Fabricated, and each satisfies its own check digits.
 *
 * Luhn for the cards and mod-97 for the Sheba, so these exercise the real validation
 * rather than a version of it with the checks turned off. None addresses an account.
 */
const CARD_ONE = '6037991234567893';
const CARD_TWO = '6037991234567992';
const CARD_THREE = '6037991234567810';
const SHEBA = 'IR429600000001003242000012';

/**
 * A driver error's text, wherever Drizzle wrapped it.
 *
 * `db.execute` throws a `DrizzleQueryError` whose message is the failed SQL; the trigger
 * message and the constraint name are on `cause`. Asserting against the outer message
 * would pass for ANY failure of that statement, including a typo in the test.
 */
async function rejectsWith(run: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown = null;
  try {
    await run;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected the statement to be refused').not.toBeNull();
  const chain: string[] = [];
  for (let node = caught, depth = 0; node !== null && node !== undefined && depth < 5; depth += 1) {
    if (node instanceof Error) chain.push(node.message);
    node = (node as { cause?: unknown }).cause ?? null;
  }
  expect(chain.join('\n')).toMatch(pattern);
}

describe('payment accounts and the destination a payment freezes', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let panelA: string;
  let customerA: UserId;
  let owner: ActorContext;
  let ownerB: ActorContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    products = new DrizzleProductRepository(ctx.container.database.db);
    panelA = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    customerA = await customer(tenantA, BOT_A, '900800');
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-pa', roleKeys: ['owner'] }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-pb', roleKeys: ['owner'] }),
    );
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function customer(
    scope: typeof tenantA,
    botInstanceId: BotInstanceId,
    telegramUserId: string,
  ): Promise<UserId> {
    const { customer: record } = await ctx.container.customers.resolveFromUpdate(
      scope,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'زهرا' },
        botInstanceId,
      },
    );
    return record.id;
  }

  const fields = (overrides: Partial<Record<string, unknown>> = {}) => ({
    label: 'ملی',
    bankName: 'بانک ملی ایران',
    holderName: 'فروشگاه آکمی',
    cardNumber: CARD_ONE,
    iban: SHEBA,
    sortOrder: 0,
    ...overrides,
  });

  const addAccount = (
    scope: typeof tenantA,
    actor: ActorContext,
    key: string,
    overrides: Partial<Record<string, unknown>> = {},
    disposition: { enabled?: boolean; makeDefault?: boolean } = {},
  ) =>
    ctx.container.paymentAccounts.create(scope, actor, {
      idempotencyKey: key,
      fields: fields(overrides) as never,
      enabled: disposition.enabled ?? true,
      makeDefault: disposition.makeDefault ?? false,
    });

  /** An order in `AWAITING_PAYMENT`, made the way a customer makes one. */
  async function awaitingPayment(key: string): Promise<string> {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: 'یک ماهه',
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelA as PanelId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(250_000n, 'IRT'),
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const order = await ctx.container.orders.createDraft(tenantA, systemActor(`${key}-d`), {
      idempotencyKey: `${key}-draft`,
      customerId: customerA,
      productId: created.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(`${key}-c`), {
      idempotencyKey: `${key}-confirm`,
      customerId: customerA,
      orderId: order.id,
    });
    return confirmed.id;
  }

  const issue = (key: string, orderId: string) =>
    ctx.container.payments.requestManualTransfer(tenantA, systemActor(key), customerA, {
      idempotencyKey: key,
      orderId,
    });

  /** The seeded destination each tenant starts with, removed so a case can stand alone. */
  const clearSeededAccounts = async (tenantId: string) => {
    await ctx.container.database.db.execute(
      sql`UPDATE payment_accounts SET is_default = false WHERE tenant_id = ${tenantId}`,
    );
    await ctx.container.database.db.execute(
      sql`UPDATE payment_accounts SET enabled = false WHERE tenant_id = ${tenantId}`,
    );
  };

  // -------------------------------------------------------------------------

  describe('the destination a payment is issued against', () => {
    it('freezes the account onto the payment in the issuing transaction', async () => {
      const orderId = await awaitingPayment('freeze');
      const { payment, destination } = await issue('freeze-pay', orderId);

      expect(destination).not.toBeNull();
      // The SEEDED default for tenant A, not the first row by any other ordering.
      expect(destination?.cardNumber).toBe(CARD_ONE);
      expect(destination?.bankName).toBe('بانک ملی ایران');

      const rows = (await ctx.container.database.db.execute(
        sql`SELECT card_number, account_id FROM payment_destinations WHERE payment_id = ${payment.id}` as never,
      )) as unknown as { rows: { card_number: string; account_id: string }[] };
      expect(rows.rows[0]?.card_number).toBe(CARD_ONE);
      expect(rows.rows[0]?.account_id).toBe(SEED_IDS.paymentAccountA);
    });

    it('survives an edit of the account it was taken from', async () => {
      // THE rule 5A exists for. Before it, the card number lived in a template body and
      // editing it rewrote what every already-issued instruction said.
      const orderId = await awaitingPayment('edit');
      const { payment } = await issue('edit-pay', orderId);

      await ctx.container.paymentAccounts.update(tenantA, owner, {
        idempotencyKey: 'edit-acct',
        accountId: SEED_IDS.paymentAccountA,
        fields: fields({ cardNumber: CARD_THREE, holderName: 'یک نام دیگر' }) as never,
      });

      const after = await ctx.container.payments.requestManualTransfer(
        tenantA,
        systemActor('edit-pay'),
        customerA,
        { idempotencyKey: 'edit-pay', orderId },
      );
      expect(after.payment.id).toBe(payment.id);
      expect(after.destination?.cardNumber).toBe(CARD_ONE);
      // The SEED's holder name, not the one the edit wrote.
      expect(after.destination?.holderName).toBe('Acme Store');
    });

    it('survives the account being disabled', async () => {
      const orderId = await awaitingPayment('disable');
      const { payment } = await issue('disable-pay', orderId);

      const other = await addAccount(tenantA, owner, 'disable-other', { cardNumber: CARD_TWO });
      await ctx.container.paymentAccounts.setDefault(tenantA, owner, {
        idempotencyKey: 'disable-promote',
        accountId: other.id,
      });
      await ctx.container.paymentAccounts.setEnabled(tenantA, owner, {
        idempotencyKey: 'disable-off',
        accountId: SEED_IDS.paymentAccountA,
        enabled: false,
      });

      const again = await ctx.container.payments.requestManualTransfer(
        tenantA,
        systemActor('disable-pay'),
        customerA,
        { idempotencyKey: 'disable-pay', orderId },
      );
      expect(again.payment.id).toBe(payment.id);
      expect(again.destination?.cardNumber).toBe(CARD_ONE);
    });

    it('refuses to update or delete a snapshot, in the database', async () => {
      // Migration 0063. An application rule would not survive a repair script.
      const orderId = await awaitingPayment('frozen');
      const { payment } = await issue('frozen-pay', orderId);

      await rejectsWith(
        ctx.container.database.db.execute(
          sql`UPDATE payment_destinations SET card_number = ${CARD_TWO} WHERE payment_id = ${payment.id}`,
        ),
        /append-only/i,
      );
      await rejectsWith(
        ctx.container.database.db.execute(
          sql`DELETE FROM payment_destinations WHERE payment_id = ${payment.id}`,
        ),
        /append-only/i,
      );
    });

    it('refuses a manual transfer when no enabled account exists', async () => {
      await clearSeededAccounts(tenantA.tenantId);
      const orderId = await awaitingPayment('none');

      await expect(issue('none-pay', orderId)).rejects.toSatisfy(
        (error: unknown) =>
          isNexaError(error) && error.code === 'commerce.payment_destination_unconfigured',
      );

      const rows = (await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM payments WHERE order_id = ${orderId}` as never,
      )) as unknown as { rows: { n: number }[] };
      // No payment row, no reference handed out, nothing to reconcile later.
      expect(rows.rows[0]?.n).toBe(0);
    });

    it('prefers the default over the lowest-ordered enabled account', async () => {
      // The selection rule, pinned. `sort_order` 0 would win on ordering alone; the
      // default is what decides.
      const promoted = await addAccount(
        tenantA,
        owner,
        'prefer-new',
        { cardNumber: CARD_TWO, sortOrder: 90 },
        { makeDefault: true },
      );
      const orderId = await awaitingPayment('prefer');
      const { destination } = await issue('prefer-pay', orderId);
      expect(destination?.cardNumber).toBe(CARD_TWO);
      expect(promoted.isDefault).toBe(true);
    });
  });

  describe('what an operator may and may not do to an account', () => {
    it('refuses to disable the default, from either end', async () => {
      await expect(
        ctx.container.paymentAccounts.setEnabled(tenantA, owner, {
          idempotencyKey: 'no-disable-default',
          accountId: SEED_IDS.paymentAccountA,
          enabled: false,
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          isNexaError(error) && error.code === 'commerce.payment_account_disabled',
      );
    });

    it('refuses to promote a disabled account', async () => {
      const spare = await addAccount(
        tenantA,
        owner,
        'spare',
        { cardNumber: CARD_TWO },
        { enabled: false },
      );
      await expect(
        ctx.container.paymentAccounts.setDefault(tenantA, owner, {
          idempotencyKey: 'promote-disabled',
          accountId: spare.id,
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          isNexaError(error) && error.code === 'commerce.payment_account_disabled',
      );
    });

    it('refuses a second live account holding the same card', async () => {
      await expect(
        addAccount(tenantA, owner, 'dup', { cardNumber: CARD_ONE, label: 'دوم' }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          isNexaError(error) && error.code === 'commerce.payment_account_duplicate',
      );
    });

    it('allows the same card again once the live one is disabled', async () => {
      const other = await addAccount(tenantA, owner, 'swap-other', { cardNumber: CARD_TWO });
      await ctx.container.paymentAccounts.setDefault(tenantA, owner, {
        idempotencyKey: 'swap-promote',
        accountId: other.id,
      });
      await ctx.container.paymentAccounts.setEnabled(tenantA, owner, {
        idempotencyKey: 'swap-off',
        accountId: SEED_IDS.paymentAccountA,
        enabled: false,
      });
      const readded = await addAccount(tenantA, owner, 'swap-readd', { cardNumber: CARD_ONE });
      expect(readded.cardNumber).toBe(CARD_ONE);
    });

    it('writes no audit row when a disable changes nothing', async () => {
      // A record of something that did not happen is worse than no record.
      const spare = await addAccount(tenantA, owner, 'noop', { cardNumber: CARD_TWO });
      await ctx.container.paymentAccounts.setEnabled(tenantA, owner, {
        idempotencyKey: 'noop-1',
        accountId: spare.id,
        enabled: false,
      });
      const before = await auditCount('payment_account.set_enabled');
      await ctx.container.paymentAccounts.setEnabled(tenantA, owner, {
        idempotencyKey: 'noop-2',
        accountId: spare.id,
        enabled: false,
      });
      expect(await auditCount('payment_account.set_enabled')).toBe(before);
    });

    it('leaves exactly one default when two promotions race', async () => {
      const second = await addAccount(tenantA, owner, 'race-2', { cardNumber: CARD_TWO });
      const third = await addAccount(tenantA, owner, 'race-3', { cardNumber: CARD_THREE });

      const outcomes = await Promise.allSettled([
        ctx.container.paymentAccounts.setDefault(tenantA, owner, {
          idempotencyKey: 'race-a',
          accountId: second.id,
        }),
        ctx.container.paymentAccounts.setDefault(tenantA, owner, {
          idempotencyKey: 'race-b',
          accountId: third.id,
        }),
      ]);

      // At least one must succeed; a loser is a CONFLICT the operator can retry, never
      // a second default and never a 500.
      expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          expect(isNexaError(outcome.reason)).toBe(true);
        }
      }

      const rows = (await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM payment_accounts
            WHERE tenant_id = ${tenantA.tenantId} AND is_default` as never,
      )) as unknown as { rows: { n: number }[] };
      expect(rows.rows[0]?.n).toBe(1);
    });

    it('refuses a malformed card number and a malformed Sheba at the table too', async () => {
      // The schema refuses these at the boundary; these are the CHECKs underneath, which
      // is what a repair script meets.
      await rejectsWith(
        ctx.container.database.db.execute(sql`
          INSERT INTO payment_accounts (id, tenant_id, label, bank_name, holder_name, card_number)
          VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, 'x', 'y', 'z', '12345')`),
        /payment_accounts_card_number_check/,
      );
      await rejectsWith(
        ctx.container.database.db.execute(sql`
          INSERT INTO payment_accounts (id, tenant_id, label, bank_name, holder_name, card_number, iban)
          VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, 'x', 'y', 'z', ${CARD_THREE}, 'DE00')`),
        /payment_accounts_iban_check/,
      );
    });
  });

  describe('tenancy', () => {
    it('does not let one tenant read, edit or promote the other tenant’s account', async () => {
      const theirs = SEED_IDS.paymentAccountB as PaymentAccountId;

      // There is no read-one route and no `get`: the list carries every field a surface
      // needs, and a service method with only a test caller is a placeholder. Isolation
      // is asserted on the three paths that exist.
      const mine = await ctx.container.paymentAccounts.list(tenantA, owner);
      expect(mine.map((account) => account.id)).not.toContain(theirs);

      await expect(
        ctx.container.paymentAccounts.update(tenantA, owner, {
          idempotencyKey: 'cross-edit',
          accountId: theirs,
          fields: fields({ cardNumber: CARD_THREE }) as never,
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          isNexaError(error) && error.code === 'commerce.payment_account_not_found',
      );
      await expect(
        ctx.container.paymentAccounts.setDefault(tenantA, owner, {
          idempotencyKey: 'cross-promote',
          accountId: theirs,
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          isNexaError(error) && error.code === 'commerce.payment_account_not_found',
      );
    });

    it('lists only its own accounts', async () => {
      await addAccount(tenantA, owner, 'mine', { cardNumber: CARD_TWO });
      const mine = await ctx.container.paymentAccounts.list(tenantA, owner);
      const theirs = await ctx.container.paymentAccounts.list(tenantB, ownerB);

      expect(mine.map((account) => account.cardNumber)).toEqual([CARD_ONE, CARD_TWO]);
      expect(theirs.map((account) => account.cardNumber)).toEqual([CARD_TWO]);
      expect(theirs.map((account) => account.id)).toEqual([SEED_IDS.paymentAccountB]);
    });

    it('issues a payment against the paying tenant’s own destination', async () => {
      const orderId = await awaitingPayment('iso');
      const { destination } = await issue('iso-pay', orderId);
      // Tenant B's seeded card is CARD_TWO. If scoping were broken this could be it.
      expect(destination?.cardNumber).toBe(CARD_ONE);
    });
  });

  describe('what reaches the customer and the operator', () => {
    it('renders every configured line and omits the absent one', async () => {
      const renderer = new PaymentDestinationRenderer(ctx.container.templateResolver);

      const withSheba = await renderer.render(tenantA, {
        bankName: 'بانک ملی ایران',
        holderName: 'فروشگاه آکمی',
        cardNumber: CARD_ONE,
        iban: SHEBA,
        label: 'ملی',
      });
      expect(withSheba.split('\n')).toHaveLength(4);
      expect(withSheba).toContain(CARD_ONE);
      expect(withSheba).toContain(SHEBA);

      const withoutSheba = await renderer.render(tenantA, {
        bankName: 'بانک ملی ایران',
        holderName: 'فروشگاه آکمی',
        cardNumber: CARD_ONE,
        iban: null,
        label: 'ملی',
      });
      expect(withoutSheba.split('\n')).toHaveLength(3);
      // The failure this whole composition exists to prevent.
      expect(withoutSheba).not.toContain('{');
      expect(withoutSheba).not.toContain('شبا');
    });

    it('leaves the operator review path working, end to end', async () => {
      const orderId = await awaitingPayment('review');
      const { payment } = await issue('review-pay', orderId);

      const confirmed = await ctx.container.payments.confirmManualTransfer(
        tenantA,
        owner,
        payment.id,
        { idempotencyKey: 'review-confirm', note: 'دیده شد در صورتحساب بانکی' },
      );
      expect(confirmed.payment.state).toBe('CONFIRMED');
      expect(confirmed.payment.evidenceKind).toBe('OPERATOR_REVIEW');
    });
  });

  describe('migration 0064 — the payment-account permission backfill', () => {
    /**
     * The statement under test is READ FROM THE MIGRATION, never retyped. A copy here
     * would pass while the shipped file said something else — which is the defect
     * `recovery-permission-backfill.test.ts` records for 0031.
     */
    const backfill = () => {
      const file = readFileSync('apps/api/drizzle/0064_payment_account_permissions.sql', 'utf8');
      const start = file.indexOf('INSERT INTO "role_permissions"');
      expect(start).toBeGreaterThan(-1);
      return file.slice(start);
    };

    /**
     * What it must produce, written out rather than derived from `ROLE_SEEDS`.
     * Deriving it would run the same computation the migration implements and agree
     * with it however wrong both were.
     */
    const EXPECTED = [
      'finance:payments.accounts.edit',
      'finance:payments.accounts.view',
      'observer:payments.accounts.view',
      'operator:payments.accounts.view',
      'owner:payments.accounts.edit',
      'owner:payments.accounts.view',
      'receipt_reviewer:payments.accounts.view',
    ];

    it('reaches an installation whose roles predate this release', async () => {
      await ctx.container.roles.ensureSystemRoles(tenantA);
      await ctx.container.database.db.execute(sql`
        DELETE FROM role_permissions
        WHERE tenant_id = ${tenantA.tenantId} AND permission_key LIKE 'payments.accounts.%'`);

      const empty = await grantsIn(tenantA.tenantId);
      expect(empty).toEqual([]);

      await ctx.container.database.withClient((client) => client.query(backfill()));

      expect(await grantsIn(tenantA.tenantId)).toEqual(EXPECTED);
    });

    it('is safe to apply twice', async () => {
      await ctx.container.roles.ensureSystemRoles(tenantA);
      await ctx.container.database.withClient((client) => client.query(backfill()));
      await ctx.container.database.withClient((client) => client.query(backfill()));
      expect(await grantsIn(tenantA.tenantId)).toEqual(EXPECTED);
    });
  });

  async function grantsIn(tenantId: string): Promise<string[]> {
    const rows = (await ctx.container.database.db.execute(
      sql`
      SELECT r.key AS role_key, rp.permission_key
      FROM role_permissions rp JOIN roles r ON r.id = rp.role_id AND r.tenant_id = rp.tenant_id
      WHERE rp.tenant_id = ${tenantId} AND rp.permission_key LIKE 'payments.accounts.%'
      ORDER BY r.key, rp.permission_key` as never,
    )) as unknown as {
      rows: { role_key: string; permission_key: string }[];
    };
    return rows.rows.map((row) => `${row.role_key}:${row.permission_key}`);
  }

  async function auditCount(action: string): Promise<number> {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = ${action}` as never,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  }
});
