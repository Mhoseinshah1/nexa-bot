import { readFileSync } from 'node:fs';
import type { ProductCategoryId } from '@nexa/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PAYMENT_ACCOUNT_MAX_PER_TENANT,
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
import { PAYMENT_ACCOUNT_LOCK_CLASS } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment-account.repository';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
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

/**
 * A distinct sixteen-digit card whose check digit is correct, for filler rows.
 *
 * Computed rather than listed, because forty-nine hand-written numbers is forty-nine
 * chances to get a check digit wrong — and `payment_accounts_card_luhn_check` would
 * then fail the FIXTURE and report it as the behaviour under test. The prefix is the
 * same fabricated BIN the other constants use; none of these addresses an account.
 */
function luhnCard(seed: number): string {
  const body = `603799${String(1000000000 + seed).slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const digit = Number(body[body.length - 1 - i]);
    // The check digit will sit at the far right, so a body digit at even distance from
    // it is the one that doubles. Getting this backwards is the classic Luhn mistake.
    const doubled = i % 2 === 0 ? digit * 2 : digit;
    sum += doubled > 9 ? doubled - 9 : doubled;
  }
  return `${body}${String((10 - (sum % 10)) % 10)}`;
}
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
    /*
     * Made GENUINELY sellable, not left as a bare row.
     *
     * A panel with no credentials, no activation and no probe cannot create an
     * account, and since this hotfix `decideEligibility` refuses to take money
     * for one. A fixture that expects a sale therefore has to describe a panel
     * that could deliver it; `makePanelSellable` writes the three things a sale
     * now requires, using the production identity function so it cannot drift.
     */
    await makePanelSellable(ctx.container, tenantA, panelA);
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
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
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
      //
      // EITHER name, because a five-digit string fails the shape check and the Luhn
      // check alike and PostgreSQL does not promise which it reports. The case that
      // pins the Luhn one on its own is in the Codex block below, where the card is
      // sixteen digits and only the check digit is wrong.
      await rejectsWith(
        ctx.container.database.db.execute(sql`
          INSERT INTO payment_accounts (id, tenant_id, label, bank_name, holder_name, card_number)
          VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, 'x', 'y', 'z', '12345')`),
        /payment_accounts_card_(number|luhn)_check/,
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

  // -------------------------------------------------------------------------
  // The Codex round on PR #34. Seven confirmed findings, seven cases.
  // -------------------------------------------------------------------------

  describe('the Codex findings on PR #34', () => {
    /*
     * C2. Two creates, one key, different dispositions.
     *
     * The hash covered the fields and `enabled` and not `makeDefault`, so the second
     * request — the one asking for the new account to become the destination — hashed
     * identically to the first and was answered with its row. The default never moved
     * and nothing said so.
     */
    it('treats a create differing only in makeDefault as a MISMATCH, not a replay', async () => {
      await addAccount(tenantA, owner, 'c2-first', { cardNumber: CARD_TWO });
      await expect(
        addAccount(tenantA, owner, 'c2-first', { cardNumber: CARD_TWO }, { makeDefault: true }),
      ).rejects.toSatisfy(
        (error: unknown) => isNexaError(error) && /idempot/iu.test(error.message + error.code),
      );
    });

    /*
     * C7. `enabled: false` with `makeDefault: true`.
     *
     * The expression evaluated to false and a disabled, non-default account was created
     * successfully — success for a command half of which was discarded. The same
     * service reports `PAYMENT_ACCOUNT_DISABLED` when an existing disabled account is
     * promoted, so the contradiction now gets the same name.
     */
    it('refuses to create a disabled account as the default', async () => {
      const before = await accountCount(tenantA.tenantId);
      await expect(
        addAccount(
          tenantA,
          owner,
          'c7-contradiction',
          { cardNumber: CARD_TWO },
          { enabled: false, makeDefault: true },
        ),
      ).rejects.toSatisfy(
        (error: unknown) =>
          isNexaError(error) && error.code === 'commerce.payment_account_disabled',
      );
      // Nothing was written. Before the fix this created a disabled, non-default row.
      expect(await accountCount(tenantA.tenantId)).toBe(before);
    });

    /*
     * C3. A disable that races a promotion.
     *
     * The service's pre-check reads the row, another operator promotes it, and the
     * UPDATE then met `payment_accounts_default_enabled_check`. A CHECK violation is not
     * a unique violation, so it escaped `guardDuplicates` as a 500 for a race the
     * conditional exists to absorb. The promotion is applied by raw SQL here because
     * that is precisely the interleaving: committed between the read and the statement.
     */
    it('answers a disable that lost to a promotion with a refusal, not a constraint error', async () => {
      await clearSeededAccounts(tenantA.tenantId);
      const keep = await addAccount(tenantA, owner, 'c3-keep', { cardNumber: CARD_TWO });
      const target = await addAccount(tenantA, owner, 'c3-target', { cardNumber: CARD_THREE });
      expect(keep.isDefault).toBe(true);
      expect(target.isDefault).toBe(false);

      /*
       * Driven by a ROW LOCK, the technique `customer-order-actions.test.ts` uses for
       * the same shape of window — and for the same reason: started as two concurrent
       * calls the promotion simply finished first, the service's own pre-check refused,
       * and the branch under test was never reached. The test passed with the fix
       * reverted, which is a test that proves nothing.
       *
       * Holding the row makes the ordering a fact. `require`'s plain SELECT is not
       * blocked and reads a non-default row, so the pre-check passes; the UPDATE blocks,
       * and by the time it is granted the promotion has committed — so in READ
       * COMMITTED its predicate is re-evaluated against a row that is now the default.
       */
      const attempt = await ctx.container.database.withClient(async (holder) => {
        await holder.query('BEGIN');
        try {
          await holder.query('SELECT id FROM payment_accounts WHERE id = $1 FOR UPDATE', [
            target.id,
          ]);

          const running = ctx.container.paymentAccounts.setEnabled(tenantA, owner, {
            idempotencyKey: 'c3-disable',
            accountId: target.id,
            enabled: false,
          });
          const outcome = running.then(
            (record) => ({ ok: true, record }) as const,
            (error: unknown) => ({ ok: false, error }) as const,
          );

          await new Promise((resolve) => setTimeout(resolve, 250));
          // Another operator's promotion: the default must move, so both rows change.
          await holder.query(
            'UPDATE payment_accounts SET is_default = false, updated_at = now() WHERE id = $1',
            [keep.id],
          );
          await holder.query(
            'UPDATE payment_accounts SET is_default = true, updated_at = now() WHERE id = $1',
            [target.id],
          );
          await holder.query('COMMIT');
          return outcome;
        } catch (error: unknown) {
          await holder.query('ROLLBACK');
          throw error;
        }
      });

      const result = await attempt;
      expect(result.ok, 'disabling the new default must be refused').toBe(false);
      /*
       * A NexaError with the frozen code, and that is the whole finding: without the
       * predicate the UPDATE matched, met `payment_accounts_default_enabled_check`, and
       * a CHECK violation is not a unique violation — so it escaped `guardDuplicates`
       * as a raw driver error rather than the refusal that names the remedy.
       */
      expect(result.ok ? null : isNexaError(result.error)).toBe(true);
      expect(result.ok || !isNexaError(result.error) ? null : result.error.code).toBe(
        'commerce.payment_account_disabled',
      );
      // And it is still enabled, because the refusal rolled its transaction back.
      expect((await accountById(target.id)).enabled).toBe(true);
    });

    /*
     * C4. The loser of two concurrent disables.
     *
     * Both read `enabled === true`, one wins, and the loser's UPDATE matched nothing.
     * Returning the row it had READ reported the account as still enabled while the
     * database said otherwise — and remembered that answer under its own key.
     */
    it('returns the CURRENT row when a concurrent disable won', async () => {
      await clearSeededAccounts(tenantA.tenantId);
      await addAccount(tenantA, owner, 'c4-default', { cardNumber: CARD_TWO });
      const target = await addAccount(tenantA, owner, 'c4-target', { cardNumber: CARD_THREE });
      expect(target.enabled).toBe(true);
      expect(target.isDefault).toBe(false);

      /*
       * The same row lock, and it is what makes this case bite: the loser must have READ
       * the row as enabled. Sequenced the other way round its own read already sees
       * `enabled = false`, `before` and the current row agree, and returning either is
       * indistinguishable — which is how this defect survived the first version of
       * this test.
       */
      const attempt = await ctx.container.database.withClient(async (holder) => {
        await holder.query('BEGIN');
        try {
          await holder.query('SELECT id FROM payment_accounts WHERE id = $1 FOR UPDATE', [
            target.id,
          ]);

          const running = ctx.container.paymentAccounts.setEnabled(tenantA, owner, {
            idempotencyKey: 'c4-loser',
            accountId: target.id,
            enabled: false,
          });
          const outcome = running.then(
            (record) => ({ ok: true, record }) as const,
            (error: unknown) => ({ ok: false, error }) as const,
          );

          await new Promise((resolve) => setTimeout(resolve, 250));
          // The winner: a different request, its own idempotency key, already committed.
          await holder.query(
            'UPDATE payment_accounts SET enabled = false, updated_at = now() WHERE id = $1',
            [target.id],
          );
          await holder.query('COMMIT');
          return outcome;
        } catch (error: unknown) {
          await holder.query('ROLLBACK');
          throw error;
        }
      });

      const result = await attempt;
      expect(result.ok, 'a lost disable is not an error').toBe(true);
      /*
       * `false`, from the row as it now is. Returning the row this call had READ
       * reported the account as still enabled while the database said otherwise — and
       * remembered that answer under this key, so a retry would repeat it.
       */
      expect(result.ok ? result.record.enabled : null).toBe(false);
      // No audit row: this call decided nothing.
      expect(await auditCount('payment_account.set_enabled')).toBe(0);
    });

    /*
     * C10. The default race has its own code.
     *
     * `PAYMENT_ACCOUNT_DUPLICATE` is documented as another ENABLED account holding the
     * same card number — a different fact and the only one of the two that is not
     * retryable. The 23505 is produced here by removing the row `clearDefault` would
     * have locked, which is the no-current-default case the comment describes.
     */
    it('names a lost default-selection race distinctly from a duplicate card', async () => {
      await clearSeededAccounts(tenantA.tenantId);
      const first = await addAccount(tenantA, owner, 'c10-first', { cardNumber: CARD_TWO });
      const second = await addAccount(tenantA, owner, 'c10-second', { cardNumber: CARD_THREE });
      expect(first.isDefault).toBe(true);

      /*
       * The state the 23505 needs: a default still held by ANOTHER row when this
       * request's SET runs.
       *
       * `setDefault` clears the current default and then sets its own, in one
       * transaction, so the index can only refuse when the clear did not take effect —
       * which is what a concurrent promotion produces. A trigger that reverts the clear
       * puts the transaction in exactly that state deterministically, in one row and
       * one statement, instead of depending on two connections interleaving.
       */
      await ctx.container.database.db.execute(sql`
        CREATE FUNCTION nexa_test_keep_default() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          NEW.is_default := true;
          RETURN NEW;
        END $$`);
      await ctx.container.database.db.execute(sql`
        CREATE TRIGGER nexa_test_keep_default
        BEFORE UPDATE OF is_default ON payment_accounts
        FOR EACH ROW WHEN (OLD.is_default AND NOT NEW.is_default)
        EXECUTE FUNCTION nexa_test_keep_default()`);
      try {
        await expect(
          ctx.container.paymentAccounts.setDefault(tenantA, owner, {
            idempotencyKey: 'c10-promote',
            accountId: second.id,
          }),
        ).rejects.toSatisfy(
          (error: unknown) =>
            isNexaError(error) && error.code === 'commerce.payment_account_default_conflict',
        );
      } finally {
        await ctx.container.database.db.execute(
          sql`DROP TRIGGER nexa_test_keep_default ON payment_accounts`,
        );
        await ctx.container.database.db.execute(sql`DROP FUNCTION nexa_test_keep_default()`);
      }
    });

    /*
     * C6. Check digits at the TABLE.
     *
     * The regular expressions are shape-only, and their own comment says these
     * constraints exist for "a repair script run at 3am". A wrong Luhn digit and a wrong
     * mod-97 checksum both satisfied them, so that script could poison the default
     * account — and every destination frozen from it — with a number no bank accepts.
     *
     * Asserted through raw SQL on purpose: the service already refuses these, and the
     * layer under test is the one the service cannot be asked about.
     */
    it('refuses a shape-valid card or Sheba with wrong check digits, in SQL', async () => {
      // The seeded account holds CARD_ONE and its Sheba, so this case writes its own.
      const before = await accountCount(tenantA.tenantId);
      const id = ctx.container.ids.uuid();
      await rejectsWith(
        ctx.container.database.db.execute(sql`
          INSERT INTO payment_accounts
            (id, tenant_id, label, bank_name, holder_name, card_number, iban)
          VALUES (${id}, ${tenantA.tenantId}, 'x', 'b', 'h', '6037991234567892', NULL)`),
        /payment_accounts_card_luhn_check/u,
      );
      await rejectsWith(
        ctx.container.database.db.execute(sql`
          INSERT INTO payment_accounts
            (id, tenant_id, label, bank_name, holder_name, card_number, iban)
          VALUES (${id}, ${tenantA.tenantId}, 'x', 'b', 'h', ${CARD_THREE},
                  'IR439600000001003242000012')`),
        /payment_accounts_iban_mod97_check/u,
      );
      // The valid pair goes in, so the case cannot pass by refusing everything.
      await ctx.container.database.db.execute(sql`
        INSERT INTO payment_accounts
          (id, tenant_id, label, bank_name, holder_name, card_number, iban)
        VALUES (${id}, ${tenantA.tenantId}, 'x', 'b', 'h', ${CARD_THREE}, NULL)`);
      expect(await accountCount(tenantA.tenantId)).toBe(before + 1);
    });

    /*
     * C5. The reissue audit named no account.
     *
     * `account` is null on the reissue path — nothing is selected, because the
     * destination was chosen when the reference was issued — and writing that null
     * through made a post-5A payment's audit row indistinguishable from a legacy one
     * with no captured destination. The snapshot was in hand one statement above.
     */
    it('records the frozen account id on a reissued manual transfer', async () => {
      await clearSeededAccounts(tenantA.tenantId);
      const account = await addAccount(tenantA, owner, 'c5-account', { cardNumber: CARD_TWO });
      const orderId = await awaitingPayment('c5-order');
      await issue('c5-first', orderId);
      await issue('c5-second', orderId);

      const rows = (await ctx.container.database.db.execute(
        sql`SELECT "after" ->> 'reissued' AS reissued,
                   "after" ->> 'destinationAccountId' AS account_id
              FROM audit_logs
             WHERE action = 'payment.manual_request'
             ORDER BY occurred_at, id` as never,
      )) as unknown as { rows: { reissued: string; account_id: string | null }[] };
      expect(rows.rows.map((row) => row.reissued)).toEqual(['false', 'true']);
      // BOTH name the account. Before the fix the second was null.
      expect(rows.rows.map((row) => row.account_id)).toEqual([account.id, account.id]);
    });

    /*
     * C9. The destination reaches an operator.
     *
     * `findByPayment` had one caller, the customer's own instructions, so after an
     * account was renamed or disabled nothing an operator could open said which account
     * a payment had named. `destinationFor` is the read the payment detail uses.
     */
    it('answers which account a payment was issued against, after it was renamed', async () => {
      await clearSeededAccounts(tenantA.tenantId);
      const account = await addAccount(tenantA, owner, 'c9-account', { cardNumber: CARD_TWO });
      const orderId = await awaitingPayment('c9-order');
      const { payment } = await issue('c9-pay', orderId);

      await ctx.container.paymentAccounts.update(tenantA, owner, {
        idempotencyKey: 'c9-rename',
        accountId: account.id,
        fields: fields({ cardNumber: CARD_TWO, label: 'renamed', bankName: 'other' }) as never,
      });
      /*
       * Renamed, not disabled. Disabling it is impossible here and that is the rule
       * working: it is the tenant's only enabled account and therefore the default, and
       * `PAYMENT_ACCOUNT_DISABLED` refuses disabling a default. The rename is what the
       * case needs anyway — it is the edit that made the legacy system rewrite history.
       */

      const frozen = await ctx.container.payments.destinationFor(tenantA, owner, payment.id);
      expect(frozen).not.toBeNull();
      expect(frozen?.accountId).toBe(account.id);
      // The VALUES are the ones the customer was told, not the ones the account holds now.
      expect(frozen?.label).toBe('\u0645\u0644\u06cc');
      expect(frozen?.cardNumber).toBe(CARD_TWO);

      // And the other tenant cannot read it with the same id.
      await expect(
        ctx.container.payments.destinationFor(tenantB, ownerB, payment.id),
      ).resolves.toBeNull();
    });
  });

  /*
   * C8, on the owner's ruling. The limit HOLDS under concurrency.
   *
   * Driven by the advisory lock itself rather than by `Promise.all` timing, and that is
   * the difference between this case and a flake: a holder connection takes the same
   * advisory key, and the suite waits until each create is provably WAITING on it
   * before releasing. `pg_locks` is the evidence, not a sleep.
   *
   * The wait is also the falsification detector. With `lockForCreate` removed a create
   * does not wait — it runs straight through and settles — so `awaitWaiters` fails by
   * name instead of leaving the case to a row count that might happen to be right.
   */
  it('refuses the second of two concurrent creates at the ceiling', async () => {
    /*
     * To ONE BELOW the ceiling, counting what the seed already put there.
     *
     * `clearSeededAccounts` disables the seeded account rather than deleting it — it
     * cannot delete it, because a payment's destination snapshot names the row — so it
     * still counts towards the limit. Deriving the filler count from the live count is
     * what keeps this case correct when the seed changes.
     */
    await clearSeededAccounts(tenantA.tenantId);
    const seeded = await accountCount(tenantA.tenantId);
    await fillToCeiling(tenantA.tenantId, PAYMENT_ACCOUNT_MAX_PER_TENANT - 1 - seeded);
    expect(await accountCount(tenantA.tenantId)).toBe(PAYMENT_ACCOUNT_MAX_PER_TENANT - 1);

    const settled = await ctx.container.database.withClient(async (holder) => {
      await holder.query('BEGIN');
      try {
        await holder.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
          PAYMENT_ACCOUNT_LOCK_CLASS,
          tenantA.tenantId,
        ]);

        const first = outcomeOf(
          addAccount(tenantA, owner, 'c8-first', { cardNumber: CARD_TWO }, { enabled: false }),
        );
        await awaitWaiters(1, 'the first create');
        const second = outcomeOf(
          addAccount(tenantA, owner, 'c8-second', { cardNumber: CARD_THREE }, { enabled: false }),
        );
        await awaitWaiters(2, 'the second create');

        await holder.query('COMMIT');
        return Promise.all([first, second]);
      } catch (error: unknown) {
        await holder.query('ROLLBACK');
        throw error;
      }
    });

    /*
     * EXACTLY one of each. Which one wins is the planner's business and the test does
     * not care; that one wins and one is refused is the invariant.
     */
    const won = settled.filter((outcome) => outcome.ok);
    const lost = settled.filter((outcome) => !outcome.ok);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const refusal = lost[0];
    expect(refusal !== undefined && !refusal.ok && isNexaError(refusal.error)).toBe(true);
    expect(
      refusal === undefined || refusal.ok || !isNexaError(refusal.error)
        ? null
        : refusal.error.code,
    ).toBe('commerce.payment_account_limit_reached');

    // Fifty, never fifty-one. The number the constant names.
    expect(await accountCount(tenantA.tenantId)).toBe(PAYMENT_ACCOUNT_MAX_PER_TENANT);
    // And the other tenant is untouched: the lock is keyed on the tenant.
    expect(await accountCount(tenantB.tenantId)).toBe(1);
  });

  /*
   * The other half of C8's requirement: the lock must not serialise UNRELATED tenants.
   *
   * Asserted by holding tenant A's advisory key and then creating an account for tenant
   * B, which must complete while A's key is held. A lock keyed on a constant rather
   * than on the tenant would pass every other case in this file and fail only here.
   *
   * `withTimeout` rather than a bare await, because the failure mode being tested IS a
   * wait: without the key in the lock, this would hang until the holder released and the
   * case would pass for the wrong reason.
   */
  it('lets another tenant create while this tenant holds the lock', async () => {
    const before = await accountCount(tenantB.tenantId);

    const created = await ctx.container.database.withClient(async (holder) => {
      await holder.query('BEGIN');
      try {
        await holder.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
          PAYMENT_ACCOUNT_LOCK_CLASS,
          tenantA.tenantId,
        ]);
        const outcome = await withTimeout(
          outcomeOf(
            // CARD_THREE, because tenant B's SEEDED account already holds CARD_TWO and
            // `payment_accounts_tenant_card_key` would refuse it — a duplicate-card
            // refusal reported as a lock problem is exactly the false signal this case
            // must not produce.
            addAccount(tenantB, ownerB, 'c8-other-tenant', { cardNumber: CARD_THREE }),
          ),
          3_000,
          "tenant B's create waited on tenant A's advisory key",
        );
        await holder.query('COMMIT');
        return outcome;
      } catch (error: unknown) {
        await holder.query('ROLLBACK');
        throw error;
      }
    });

    expect(created.ok ? null : created.error, 'another tenant must not be blocked').toBeNull();
    expect(await accountCount(tenantB.tenantId)).toBe(before + 1);
  });

  /** Fails with a sentence rather than hanging, because the failure here IS a wait. */
  async function withTimeout<T>(running: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        running,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Waits until `expected` transactions are BLOCKED on this tenant's advisory key.
   *
   * The deterministic alternative to a sleep, and the only thing in this file that
   * polls: `pg_locks` reports a row with `granted = false` for each waiter, so the
   * condition is the thing the test needs rather than an interval somebody guessed.
   *
   * The timeout is a FAILURE with a sentence, not a silent give-up. It is the message
   * that appears when `lockForCreate` is removed — the create never waits because
   * there is nothing to wait for — which is what makes this case falsifiable.
   */
  async function awaitWaiters(expected: number, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const rows = (await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n
              FROM pg_locks
             WHERE locktype = 'advisory'
               AND classid = ${PAYMENT_ACCOUNT_LOCK_CLASS}
               AND objid = (SELECT hashtext(${tenantA.tenantId})::oid)
               AND NOT granted` as never,
      )) as unknown as { rows: { n: number }[] };
      if ((rows.rows[0]?.n ?? 0) >= expected) return;
      if (Date.now() > deadline) {
        throw new Error(
          `${what} never blocked on the payment-account advisory lock. ` +
            'Either `lockForCreate` is not taken inside the create transaction, or it ' +
            'is keyed on something other than this tenant.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** A promise turned into an outcome, so two of them can be awaited together. */
  function outcomeOf(
    running: Promise<unknown>,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }> {
    return running.then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
  }

  /**
   * Raw INSERTs up to `wanted` rows, bypassing the service.
   *
   * Deliberately not forty-nine `create` calls: those would take the very lock under
   * test forty-nine times and turn a three-second case into a slow one, and the rows
   * only need to EXIST for the count to reach the ceiling. Every card satisfies Luhn,
   * because `payment_accounts_card_luhn_check` refuses anything else — which is the
   * constraint from C6 proving itself useful one case later.
   */
  async function fillToCeiling(tenantId: string, wanted: number): Promise<void> {
    for (let index = 0; index < wanted; index += 1) {
      await ctx.container.database.db.execute(sql`
        INSERT INTO payment_accounts
          (id, tenant_id, label, bank_name, holder_name, card_number, enabled, is_default)
        VALUES (${ctx.container.ids.uuid()}, ${tenantId}, ${`filler-${String(index)}`},
                'b', 'h', ${luhnCard(index)}, false, false)`);
    }
  }

  async function accountById(id: PaymentAccountId): Promise<{ enabled: boolean }> {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT enabled FROM payment_accounts WHERE id = ${id}` as never,
    )) as unknown as { rows: { enabled: boolean }[] };
    const row = rows.rows[0];
    if (row === undefined) throw new Error(`no payment account ${id}`);
    return row;
  }

  async function accountCount(tenantId: string): Promise<number> {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM payment_accounts WHERE tenant_id = ${tenantId}` as never,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  }

  async function auditCount(action: string): Promise<number> {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = ${action}` as never,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  }
});
