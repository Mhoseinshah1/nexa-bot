import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  isNexaError,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type UserId,
  money,
} from '@nexa/contracts';
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
 * Payment routes: what an operator may configure, and what it does to a customer.
 *
 * Every case here is one of the ways a route could come to promise something it cannot
 * do, or refuse something it should allow:
 *
 *   - a route is `(tenant, provider)`, so one tenant's configuration is unreachable
 *     with the other tenant's actor and a provider outside the catalogue is refused
 *     before any query runs;
 *   - a view-only role can read and cannot write, and the refusal is the guard's rather
 *     than a missing button's;
 *   - a configuration that admits nothing — crossed bounds either side — is refused by
 *     the schema AND by the table;
 *   - the eligibility thresholds decide what the TOP-UP path does, not just what a read
 *     model reports;
 *   - the amount bounds bind together with `wallet.topup.minimum`, most-restrictive
 *     either side;
 *   - a status change is conditional, so a replay and a double-click both produce one
 *     change and one audit row;
 *   - and migration 0071 leaves an upgraded installation indistinguishable from a fresh
 *     one, applied twice.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

/** Every condition off, so each case turns on exactly the one it is about. */
const OPEN = {
  displayName: null,
  instructions: null,
  minAmountMinor: 0n,
  maxAmountMinor: 0n,
  eligibility: {
    activateAfterPayments: 0,
    deactivateAfterPayments: 0,
    activateAfterAccountDays: 0,
  },
  sortOrder: 0,
} as const;

describe('payment routes', () => {
  let ctx: TestContext;
  let ownerA: ActorContext;
  let ownerB: ActorContext;
  let viewerA: ActorContext;
  let customerA: UserId;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    await ctx.container.roles.ensureSystemRoles(tenantA);
    await ctx.container.roles.ensureSystemRoles(tenantB);

    ownerA = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-pg', roleKeys: ['owner'] }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-pgb', roleKeys: ['owner'] }),
    );
    // `operator` holds `payments.gateways.view` and not the edit key — the pair the
    // seed contract defines, used here rather than a hand-built custom role so the
    // case fails if that contract changes.
    viewerA = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'viewer-pg', roleKeys: ['operator'] }),
    );

    const { customer } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor('resolve-880001'),
      {
        idempotencyKey: 'resolve-880001',
        telegramUserId: '880001',
        from: { id: 880001, first_name: 'نیما' },
        botInstanceId: BOT_A,
      },
    );
    customerA = customer.id;

    /*
     * The presets, because `offeredTopup` runs BEFORE the route is consulted and a
     * tenant with none refuses with `TOPUP_UNAVAILABLE` first. That ordering is right —
     * an amount has to be one this installation offers before asking which route could
     * carry it — so the fixture configures presets and the cases below are about the
     * route rather than about the amount being on the menu.
     */
    await setSetting('wallet.topup.presets', [
      { amountMinor: '100000', currency: 'IRT' },
      { amountMinor: '500000', currency: 'IRT' },
    ]);
  });

  // -------------------------------------------------------------------------
  // The roster, and who may touch it
  // -------------------------------------------------------------------------

  it('seeds each tenant exactly the routes this release can operate', async () => {
    const { gateways, currency } = await ctx.container.paymentGateways.list(tenantA, ownerA);
    expect(gateways.map((gateway) => gateway.provider)).toEqual(['MANUAL_TRANSFER']);
    const [route] = gateways;
    expect(route?.status).toBe('ACTIVE');
    // NULL, not a name: provisioning does not invent customer-facing copy.
    expect(route?.displayName).toBeNull();
    expect(route?.minAmountMinor).toBe(0n);
    expect(route?.maxAmountMinor).toBe(0n);
    expect(route?.activateAfterPayments).toBe(0);
    // The denomination travels with the list, so a surface cannot pair them wrongly.
    expect(currency).toBe('IRT');
  });

  it('refuses a provider outside the catalogue before it reaches a query', async () => {
    await expect(
      ctx.container.paymentGateways.configure(tenantA, ownerA, {
        idempotencyKey: 'gw-bogus-1',
        provider: 'ZARINPAL',
        config: { ...OPEN },
      }),
    ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID });
  });

  it('lets a view-only role read and refuses its writes at the guard', async () => {
    const { gateways } = await ctx.container.paymentGateways.list(tenantA, viewerA);
    expect(gateways).toHaveLength(1);

    const refused = await ctx.container.paymentGateways
      .setStatus(tenantA, viewerA, {
        idempotencyKey: 'gw-viewer-1',
        provider: 'MANUAL_TRANSFER',
        status: 'DISABLED',
      })
      .catch((error: unknown) => error);
    expect(isNexaError(refused)).toBe(true);

    // And nothing moved: the refusal is the guard's, not a missing button's.
    const after = await ctx.container.paymentGateways.list(tenantA, ownerA);
    expect(after.gateways[0]?.status).toBe('ACTIVE');
  });

  it('cannot configure or read across tenants', async () => {
    await ctx.container.paymentGateways.configure(tenantA, ownerA, {
      idempotencyKey: 'gw-iso-1',
      provider: 'MANUAL_TRANSFER',
      config: { ...OPEN, displayName: 'Only tenant A', sortOrder: 7 },
    });

    // Tenant B's own route is untouched — the key is `(tenant, provider)`, so the two
    // rows cannot be confused however identical their provider is.
    const { gateways } = await ctx.container.paymentGateways.list(tenantB, ownerB);
    expect(gateways[0]?.displayName).toBeNull();
    expect(gateways[0]?.sortOrder).toBe(0);

    // And tenant A's actor reaches nothing in tenant B.
    await expect(ctx.container.paymentGateways.list(tenantB, ownerA)).rejects.toSatisfy(
      isNexaError,
    );
  });

  // -------------------------------------------------------------------------
  // The configuration a route refuses to hold
  // -------------------------------------------------------------------------

  it('refuses a maximum below the minimum, and the table refuses it too', async () => {
    await expect(
      ctx.container.paymentGateways.configure(tenantA, ownerA, {
        idempotencyKey: 'gw-window-1',
        provider: 'MANUAL_TRANSFER',
        // Built past the schema on purpose: this case is about the LAST line of
        // defence, and a hand-written UPDATE is what meets it.
        config: { ...OPEN, minAmountMinor: 500_000n, maxAmountMinor: 100_000n },
      }),
    ).rejects.toSatisfy(() => true);

    const direct = await ctx.container.database.db
      .execute(
        sql`UPDATE payment_gateways SET min_amount_minor = 500000, max_amount_minor = 100000
            WHERE tenant_id = ${tenantA.tenantId} AND provider = 'MANUAL_TRANSFER'`,
      )
      .then(() => null)
      .catch((error: unknown) => error);
    expect(direct).not.toBeNull();
  });

  it('refuses payment-count bounds that cross, in the schema and in the table', async () => {
    await expect(
      ctx.container.paymentGateways.configure(tenantA, ownerA, {
        idempotencyKey: 'gw-cross-1',
        provider: 'MANUAL_TRANSFER',
        config: {
          ...OPEN,
          eligibility: {
            activateAfterPayments: 5,
            deactivateAfterPayments: 5,
            activateAfterAccountDays: 0,
          },
        },
      }),
    ).rejects.toSatisfy(() => true);

    const direct = await ctx.container.database.db
      .execute(
        sql`UPDATE payment_gateways
               SET activate_after_payments = 5, deactivate_after_payments = 5
             WHERE tenant_id = ${tenantA.tenantId} AND provider = 'MANUAL_TRANSFER'`,
      )
      .then(() => null)
      .catch((error: unknown) => error);
    expect(direct).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // What the thresholds do to a real payment
  // -------------------------------------------------------------------------

  it('refuses a top-up when no route is eligible for this customer', async () => {
    // Two confirmed payments are needed and the customer has none.
    await ctx.container.paymentGateways.configure(tenantA, ownerA, {
      idempotencyKey: 'gw-elig-1',
      provider: 'MANUAL_TRANSFER',
      config: {
        ...OPEN,
        eligibility: {
          activateAfterPayments: 2,
          deactivateAfterPayments: 0,
          activateAfterAccountDays: 0,
        },
      },
    });

    const refused = await ctx.container.payments
      .requestWalletTopup(
        { ...tenantA, botInstanceId: BOT_A },
        systemActor('gw-elig-turn'),
        customerA,
        { idempotencyKey: 'topup-elig-1', amountMinor: 500_000n },
      )
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE,
    });

    // No payment was issued. A refusal that left an invoice behind would be the worst
    // of both: a customer holding bank details for a route they may not use.
    const { rows } = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS total FROM payments WHERE tenant_id = ${tenantA.tenantId}`,
    )) as unknown as { rows: { total: number }[] };
    expect(rows[0]?.total).toBe(0);
  });

  it('refuses a route whose bounds were written in another currency, until they are re-saved', async () => {
    // Bounds saved while the installation sells in IRT: they MEAN IRT.
    await ctx.container.paymentGateways.configure(tenantA, ownerA, {
      idempotencyKey: 'gw-cur-1',
      provider: 'MANUAL_TRANSFER',
      config: { ...OPEN, minAmountMinor: 100_000n },
    });
    const before = (await ctx.container.paymentGateways.list(tenantA, ownerA)).gateways.find(
      (gateway) => gateway.provider === 'MANUAL_TRANSFER',
    );
    expect(before?.boundsCurrency).toBe('IRT');

    /*
     * The installation switches to IRR. The bounds used to be relabelled with whatever
     * `sales.currency` was at comparison time, so `100000` silently became 100000 IRR —
     * a tenth of what the operator had set, with no bound edited and no conversion
     * performed. The route now fails closed on the mismatch its own error code always
     * named, and the record shows the operator why.
     */
    await setSetting('sales.currency', 'IRR');
    await setSetting('wallet.topup.presets', [{ amountMinor: '500000', currency: 'IRR' }]);

    const refused = await ctx.container.payments
      .requestWalletTopup(
        { ...tenantA, botInstanceId: BOT_A },
        systemActor('gw-cur-turn-1'),
        customerA,
        { idempotencyKey: 'topup-cur-1', amountMinor: 500_000n },
      )
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE });
    const stale = (await ctx.container.paymentGateways.list(tenantA, ownerA)).gateways.find(
      (gateway) => gateway.provider === 'MANUAL_TRANSFER',
    );
    expect(stale?.boundsCurrency).toBe('IRT');

    // Re-saving the bounds is the operator confirming what they mean now.
    await ctx.container.paymentGateways.configure(tenantA, ownerA, {
      idempotencyKey: 'gw-cur-2',
      provider: 'MANUAL_TRANSFER',
      config: { ...OPEN, minAmountMinor: 100_000n },
    });
    const after = (await ctx.container.paymentGateways.list(tenantA, ownerA)).gateways.find(
      (gateway) => gateway.provider === 'MANUAL_TRANSFER',
    );
    expect(after?.boundsCurrency).toBe('IRR');

    const issued = await ctx.container.payments.requestWalletTopup(
      { ...tenantA, botInstanceId: BOT_A },
      systemActor('gw-cur-turn-2'),
      customerA,
      { idempotencyKey: 'topup-cur-2', amountMinor: 500_000n },
    );
    expect(issued.payment.amount.currency).toBe('IRR');
  });

  it('refuses a top-up when the only route is DISABLED', async () => {
    await ctx.container.paymentGateways.setStatus(tenantA, ownerA, {
      idempotencyKey: 'gw-off-1',
      provider: 'MANUAL_TRANSFER',
      status: 'DISABLED',
    });

    const refused = await ctx.container.payments
      .requestWalletTopup(
        { ...tenantA, botInstanceId: BOT_A },
        systemActor('gw-off-turn'),
        customerA,
        { idempotencyKey: 'topup-off-1', amountMinor: 500_000n },
      )
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE,
    });
  });

  it('refuses an amount above the route maximum, and names which side it fell on', async () => {
    await ctx.container.paymentGateways.configure(tenantA, ownerA, {
      idempotencyKey: 'gw-max-1',
      provider: 'MANUAL_TRANSFER',
      config: { ...OPEN, maxAmountMinor: 100_000n },
    });

    const refused = await ctx.container.payments
      .requestWalletTopup(
        { ...tenantA, botInstanceId: BOT_A },
        systemActor('gw-max-turn'),
        customerA,
        { idempotencyKey: 'topup-max-1', amountMinor: 500_000n },
      )
      .catch((error: unknown) => error);
    /*
     * Its own code, and the detail says ABOVE_MAXIMUM. A preset outside a route's
     * bounds is a misconfiguration an operator fixes, and answering it as "no route
     * available" would send them to the eligibility thresholds instead of to the two
     * numbers that actually refused.
     */
    expect(refused).toMatchObject({
      code: COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_AMOUNT_REJECTED,
      details: { side: 'ABOVE_MAXIMUM' },
    });
  });

  it('issues a top-up when the route admits both the customer and the amount', async () => {
    await ctx.container.paymentGateways.configure(tenantA, ownerA, {
      idempotencyKey: 'gw-ok-1',
      provider: 'MANUAL_TRANSFER',
      config: { ...OPEN, minAmountMinor: 100_000n, maxAmountMinor: 1_000_000n },
    });

    const instruction = await ctx.container.payments.requestWalletTopup(
      { ...tenantA, botInstanceId: BOT_A },
      systemActor('gw-ok-turn'),
      customerA,
      { idempotencyKey: 'topup-ok-1', amountMinor: 500_000n },
    );
    expect(instruction.payment.state).toBe('PENDING');
    expect(instruction.payment.method).toBe('MANUAL_TRANSFER');
    expect(instruction.payment.amount).toEqual(money(500_000n, 'IRT'));
  });

  // -------------------------------------------------------------------------
  // The status transition
  // -------------------------------------------------------------------------

  it('answers a repeated status change once, with one audit row', async () => {
    const first = await ctx.container.paymentGateways.setStatus(tenantA, ownerA, {
      idempotencyKey: 'gw-idem-1',
      provider: 'MANUAL_TRANSFER',
      status: 'DISABLED',
    });
    expect(first.status).toBe('DISABLED');

    // The same key and the same payload: a replay, answered from the store.
    const replayed = await ctx.container.paymentGateways.setStatus(tenantA, ownerA, {
      idempotencyKey: 'gw-idem-1',
      provider: 'MANUAL_TRANSFER',
      status: 'DISABLED',
    });
    expect(replayed.status).toBe('DISABLED');

    // A DIFFERENT key asking for the state it is already in: a no-op, and it must not
    // write an audit row for a change that did not happen.
    const again = await ctx.container.paymentGateways.setStatus(tenantA, ownerA, {
      idempotencyKey: 'gw-idem-2',
      provider: 'MANUAL_TRANSFER',
      status: 'DISABLED',
    });
    expect(again.status).toBe('DISABLED');

    const { rows } = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS total FROM audit_logs
           WHERE tenant_id = ${tenantA.tenantId} AND action = 'payment_gateway.set_status'`,
    )) as unknown as { rows: { total: number }[] };
    expect(rows[0]?.total).toBe(1);
  });

  it('audits a configuration change with a before and an after', async () => {
    await ctx.container.paymentGateways.configure(tenantA, ownerA, {
      idempotencyKey: 'gw-audit-1',
      provider: 'MANUAL_TRANSFER',
      config: { ...OPEN, displayName: 'کارت به کارت', minAmountMinor: 200_000n },
    });

    const { rows } = (await ctx.container.database.db.execute(
      sql`SELECT before, after FROM audit_logs
           WHERE tenant_id = ${tenantA.tenantId} AND action = 'payment_gateway.configure'`,
    )) as unknown as {
      rows: { before: Record<string, unknown>; after: Record<string, unknown> }[];
    };
    expect(rows).toHaveLength(1);
    // The amounts are STRINGS in the payload, because a bigint does not survive JSON.
    expect(rows[0]?.before).toMatchObject({ displayName: null, minAmountMinor: '0' });
    expect(rows[0]?.after).toMatchObject({
      displayName: 'کارت به کارت',
      minAmountMinor: '200000',
    });
  });

  it('refuses every write once the scope has stopped accepting work', async () => {
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
    );

    const refused = await ctx.container.paymentGateways
      .setStatus(tenantA, ownerA, {
        idempotencyKey: 'gw-stopped-1',
        provider: 'MANUAL_TRANSFER',
        status: 'DISABLED',
      })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID });
  });

  // -------------------------------------------------------------------------
  // The upgrade path
  // -------------------------------------------------------------------------

  describe('migration 0071', () => {
    /**
     * The shipped FILE, sliced at its first statement.
     *
     * Reading the file rather than restating its SQL is the rule
     * `payment-accounts.test.ts` and `recovery-permission-backfill.test.ts` both
     * follow: a test carrying its own copy would pass while the shipped file said
     * something else.
     */
    const backfill = () => {
      const file = readFileSync('apps/api/drizzle/0071_payment_gateway_backfill.sql', 'utf8');
      const start = file.indexOf('INSERT INTO "payment_gateways"');
      expect(start).toBeGreaterThan(-1);
      return file.slice(start);
    };

    /**
     * The shipped 0078, the same way: the statement that gives 0071's rows their
     * denomination, which is what an installation upgrading through both releases runs.
     */
    const denominate = () => {
      const file = readFileSync(
        'apps/api/drizzle/0078_payment_gateway_bounds_currency_backfill.sql',
        'utf8',
      );
      const start = file.indexOf('UPDATE "payment_gateways"');
      expect(start).toBeGreaterThan(-1);
      return file.slice(start);
    };

    /**
     * 0071 ran in a schema with no `bounds_currency`; 0077 added it nullable, 0078
     * filled it, 0079 made it NOT NULL. Replaying 0071 against today's schema would
     * meet 0079's constraint before `ON CONFLICT` could apply, which is a state no
     * installation is ever in. So the replay is run in the order the releases run.
     */
    async function asUpgradeThrough0071(fn: () => Promise<void>): Promise<void> {
      const raw = (text: string) =>
        ctx.container.database.withClient((client) => client.query(text));
      await raw('ALTER TABLE payment_gateways ALTER COLUMN bounds_currency DROP NOT NULL');
      try {
        await fn();
        await raw(denominate());
      } finally {
        await raw('ALTER TABLE payment_gateways ALTER COLUMN bounds_currency SET NOT NULL');
      }
    }

    /**
     * What the role half must produce, written out rather than derived from
     * `ROLE_SEEDS`. Deriving it would run the same computation the migration
     * implements and agree with it however wrong both were.
     */
    const EXPECTED_GRANTS = [
      'finance:payments.gateways.edit',
      'finance:payments.gateways.view',
      'observer:payments.gateways.view',
      'operator:payments.gateways.view',
      'owner:payments.gateways.edit',
      'owner:payments.gateways.view',
    ];

    it('reaches an installation that predates this release, and is safe to apply twice', async () => {
      // As a pre-5C installation: no routes, and no gateway grant on any role.
      await ctx.container.database.db.execute(
        sql`DELETE FROM payment_gateways WHERE tenant_id = ${tenantA.tenantId}`,
      );
      await ctx.container.database.db.execute(
        sql`DELETE FROM role_permissions
             WHERE tenant_id = ${tenantA.tenantId}
               AND permission_key LIKE 'payments.gateways.%'`,
      );
      expect(await grantsIn(tenantA.tenantId)).toEqual([]);

      await asUpgradeThrough0071(async () => {
        await ctx.container.database.withClient((client) => client.query(backfill()));
        await ctx.container.database.withClient((client) => client.query(backfill()));
      });

      expect(await grantsIn(tenantA.tenantId)).toEqual(EXPECTED_GRANTS);

      const { gateways } = await ctx.container.paymentGateways.list(tenantA, ownerA);
      expect(gateways).toHaveLength(1);
      expect(gateways[0]?.status).toBe('ACTIVE');
      expect(gateways[0]?.displayName).toBeNull();
      expect(gateways[0]?.minAmountMinor).toBe(0n);
      // 0078 gave the upgraded row the denomination its bounds always meant: the
      // registry default, since this tenant has no `sales.currency` row.
      expect(gateways[0]?.boundsCurrency).toBe('IRT');
    });

    it('never resets a route an operator has already tuned', async () => {
      await ctx.container.paymentGateways.configure(tenantA, ownerA, {
        idempotencyKey: 'gw-tuned-1',
        provider: 'MANUAL_TRANSFER',
        config: { ...OPEN, displayName: 'Tuned', minAmountMinor: 750_000n, sortOrder: 3 },
      });

      await asUpgradeThrough0071(async () => {
        await ctx.container.database.withClient((client) => client.query(backfill()));
      });

      const { gateways } = await ctx.container.paymentGateways.list(tenantA, ownerA);
      expect(gateways[0]?.displayName).toBe('Tuned');
      expect(gateways[0]?.minAmountMinor).toBe(750_000n);
      expect(gateways[0]?.sortOrder).toBe(3);
    });
  });

  async function setSetting(key: string, value: unknown): Promise<void> {
    await ctx.container.database.db.execute(sql`
      INSERT INTO setting_values (id, tenant_id, setting_key, value, version, updated_at)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${key},
              ${JSON.stringify(value)}::jsonb, 1, now())
      ON CONFLICT (tenant_id, setting_key)
        DO UPDATE SET value = ${JSON.stringify(value)}::jsonb, version = setting_values.version + 1`);
  }

  async function grantsIn(tenantId: string): Promise<string[]> {
    const rows = (await ctx.container.database.db.execute(
      sql`
      SELECT r.key AS role_key, rp.permission_key
      FROM role_permissions rp JOIN roles r ON r.id = rp.role_id AND r.tenant_id = rp.tenant_id
      WHERE rp.tenant_id = ${tenantId} AND rp.permission_key LIKE 'payments.gateways.%'
      ORDER BY r.key, rp.permission_key` as never,
    )) as unknown as {
      rows: { role_key: string; permission_key: string }[];
    };
    return rows.rows.map((row) => `${row.role_key}:${row.permission_key}`);
  }
  /**
   * The toggle has to switch something off, and before this it half did.
   *
   * `FBR-002` records the enable/disable control as deciding "whether customers can pay
   * through that route at all". 5C bound it to the wallet top-up path and nowhere else,
   * so an operator could switch MANUAL_TRANSFER off and watch ORDER payments keep
   * arriving through it. This is the read that both surfaces now consult; the order path
   * itself is proved in `payments.test.ts`.
   *
   * STATUS only, deliberately: the route's bounds and eligibility thresholds are
   * `OQ-5C-01`, an open product decision, and this case would pass either way.
   */
  it('stops offering the manual transfer once the operator switches the route off', async () => {
    expect(await ctx.container.payments.manualTransferOffered(tenantA)).toBe(true);

    await ctx.container.database.db.execute(
      sql`UPDATE payment_gateways SET status = 'DISABLED'
           WHERE tenant_id = ${tenantA.tenantId} AND provider = 'MANUAL_TRANSFER'`,
    );
    expect(await ctx.container.payments.manualTransferOffered(tenantA)).toBe(false);

    await ctx.container.database.db.execute(
      sql`UPDATE payment_gateways SET status = 'ACTIVE'
           WHERE tenant_id = ${tenantA.tenantId} AND provider = 'MANUAL_TRANSFER'`,
    );
    expect(await ctx.container.payments.manualTransferOffered(tenantA)).toBe(true);
  });

  /** The other half of the same answer: no destination, nothing offered. */
  it('stops offering it when the last enabled account goes away', async () => {
    await ctx.container.database.db.execute(
      sql`UPDATE payment_accounts SET enabled = false, is_default = false
           WHERE tenant_id = ${tenantA.tenantId}`,
    );
    expect(await ctx.container.payments.manualTransferOffered(tenantA)).toBe(false);
  });
});
