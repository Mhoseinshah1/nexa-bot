import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  GIFT_CARD_EXPORT_TTL_MS,
  GIFT_CARD_MAX_FAILED_ATTEMPTS,
  giftCardReference,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type DomainEvent,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { GiftCardAdminService } from '../../apps/api/src/modules/commerce/gift-cards/application/gift-card-admin.service';
import { GiftCardRedemptionService } from '../../apps/api/src/modules/commerce/gift-cards/application/gift-card-redemption.service';
import { DrizzleOpsLogFacts } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/drizzle-ops-log-facts';
import { i18nOpsLogWords } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import { LedgerLogConsumer } from '../../apps/api/src/modules/commerce/ops-log/application/ledger-log.consumer';
import type { OpsLogLane } from '../../apps/api/src/modules/commerce/ops-log/application/ports';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * R10 D4 — gift cards (wallet top-up codes), at the service level against PostgreSQL.
 *
 * The rules each case pins, and the mutation that breaks it:
 *
 * - a code credits the wallet ONCE, through the ledger, under `giftcard:<codeId>`, with its
 *   events, its audit row and the operations-log line (the conditional UPDATE's
 *   `redeemed_at IS NULL`: racing redeemers);
 * - a replay answers the first result and writes nothing;
 * - the expiry is half-open: redeemable while `now < expires_at` (`>=` -> `>`);
 * - one refusal sentence for disabled, limit, other tenant, currency, used and unknown;
 * - the per-customer limit and the failed-attempt limiter are decided under the customer's
 *   wallet lock, and the limiter runs BEFORE the code is read, in the database (no Redis);
 * - the flag and a stopped scope refuse with nothing written;
 * - no plaintext code is stored anywhere but the sealed export, which expires, is audited on
 *   every download and is purged by the sweep;
 * - denied create / export / disable are audited DENIED; a disable is bound to its preview.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;
const HOUR = 60 * 60 * 1000;

const customerActor = (
  correlationId: string,
  surface: 'TELEGRAM' | 'MINI_APP' = 'TELEGRAM',
): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface,
  correlationId: correlationId as CorrelationId,
});

interface Queued {
  readonly input: Parameters<OpsLogLane['queue']>[1];
}

describe('gift cards', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let ownerB: ActorContext;
  let operator: ActorContext;
  let n = 0;
  const key = (): string => `gift-card-key-${(n += 1)}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-gc', roleKeys: ['owner'] }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-gc-b', roleKeys: ['owner'] }),
    );
    // `operator` holds no gift-card key: every gift-card write is refused to it.
    operator = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'operator-gc',
        roleKeys: ['operator'],
      }),
    );
  });

  const db = () => ctx.container.database.db;
  async function rows<T>(query: SQL): Promise<T[]> {
    return ((await db().execute(query as never)) as unknown as { rows: T[] }).rows;
  }
  async function count(query: SQL): Promise<number> {
    return Number((await rows<{ n: number }>(query))[0]?.n ?? 0);
  }

  async function setFlag(enabled: boolean, scope: TenantContext = tenantA, actor = owner) {
    const before = (await ctx.container.featureFlags.list(scope, actor)).find(
      (flag) => flag.key === 'gift_cards',
    );
    if (before === undefined) throw new Error('no gift_cards flag');
    await ctx.container.featureFlags.set(scope, actor, {
      idempotencyKey: key(),
      key: 'gift_cards',
      enabled,
      expectedVersion: before.version,
      confirmKey: 'gift_cards',
      reason: 'test toggle',
    });
  }

  async function setCurrency(currency: 'IRT' | 'IRR') {
    const before = await ctx.container.settingsService.get(tenantA, owner, 'sales.currency');
    await ctx.container.settingsService.set(tenantA, owner, {
      idempotencyKey: key(),
      key: 'sales.currency',
      value: currency,
      expectedVersion: before.version,
    });
  }

  async function customer(
    telegramId: string,
    scope: TenantContext = tenantA,
    bot: BotInstanceId = BOT_A,
  ): Promise<UserId> {
    const { customer: created } = await ctx.container.customers.resolveFromUpdate(
      scope,
      customerActor(key()),
      {
        idempotencyKey: key(),
        telegramUserId: telegramId,
        from: { id: Number(telegramId), first_name: 'مشتری', username: `u${telegramId}` },
        botInstanceId: bot,
      },
    );
    return created.id;
  }

  /** A batch minted through the service, and its codes read back from the CSV export. */
  async function mint(
    options: {
      readonly count?: number;
      readonly amountMinor?: bigint;
      readonly perCustomerLimit?: number | null;
      readonly expiresInMs?: number;
      readonly scope?: TenantContext;
      readonly actor?: ActorContext;
      readonly label?: string;
    } = {},
  ): Promise<{ batchId: string; codes: string[] }> {
    const scope = options.scope ?? tenantA;
    const actor = options.actor ?? owner;
    const codeCount = options.count ?? 3;
    const amountMinor = options.amountMinor ?? 50_000n;
    const view = await ctx.container.giftCards.create(scope, actor, {
      idempotencyKey: key(),
      label: options.label ?? 'یلدا',
      amountMinor,
      currency: 'IRT',
      count: codeCount,
      expiresAt: new Date(
        ctx.container.clock.now().getTime() + (options.expiresInMs ?? 30 * 24 * HOUR),
      ),
      perCustomerLimit: options.perCustomerLimit ?? null,
      reason: 'کمپین آزمایشی',
      expectedTotalMinor: amountMinor * BigInt(codeCount),
      typedCount: codeCount,
    });
    const file = await ctx.container.giftCards.exportCodes(scope, actor, view.batch.id);
    const codes = file.content
      .slice(1)
      .trimEnd()
      .split('\r\n')
      .slice(1)
      .map((line) => (line.split(',')[0] as string).replace(/"/g, ''));
    expect(codes).toHaveLength(codeCount);
    return { batchId: view.batch.id, codes };
  }

  const redeem = (
    customerId: UserId,
    code: string,
    idempotencyKey = key(),
    scope: TenantContext = tenantA,
    service: GiftCardRedemptionService = ctx.container.giftCardRedemption,
  ) => service.redeem(scope, customerActor(key()), { customerId, code, idempotencyKey });

  const entries = (customerId?: string) =>
    rows<{ id: string; reason: string; direction: string; amount: string; reference: string }>(
      sql`SELECT id, reason, direction, amount::text AS amount, reference FROM wallet_entries
           WHERE reason = 'GIFT_CARD_REDEMPTION'
             ${customerId === undefined ? sql`` : sql`AND customer_id = ${customerId}`}
           ORDER BY created_at, id`,
    );

  const attempts = (customerId: string) =>
    rows<{ outcome: string }>(
      sql`SELECT outcome FROM gift_card_redemption_attempts WHERE customer_id = ${customerId}
           ORDER BY attempted_at, id`,
    );

  const balance = async (customerId: UserId) =>
    (await ctx.container.wallet.balanceForCustomer(tenantA, customerActor(key()), customerId))
      .amountMinor;

  /** A service on another clock, everything else the container's. */
  function redemptionAt(now: Date): GiftCardRedemptionService {
    const { deps } = ctx.container.giftCardRedemption as unknown as {
      deps: ConstructorParameters<typeof GiftCardRedemptionService>[0];
    };
    return new GiftCardRedemptionService({ ...deps, clock: { now: () => now } });
  }
  function adminAt(now: Date): GiftCardAdminService {
    const { deps } = ctx.container.giftCards as unknown as {
      deps: ConstructorParameters<typeof GiftCardAdminService>[0];
    };
    return new GiftCardAdminService({ ...deps, clock: { now: () => now } });
  }

  // -----------------------------------------------------------------------------------

  describe('a redemption', () => {
    it('credits the wallet once through the ledger, with both events, the audit row and the ops log line', async () => {
      await setFlag(true);
      const { batchId, codes } = await mint({ count: 2, amountMinor: 50_000n, label: 'نوروز' });
      const buyer = await customer('950001');
      const code = codes[0] as string;

      const result = await redeem(buyer, code.toLowerCase());
      expect(result).toMatchObject({
        outcome: 'REDEEMED',
        amount: money(50_000n, 'IRT'),
        balance: money(50_000n, 'IRT'),
        batchId,
      });
      if (result.outcome !== 'REDEEMED') throw new Error('not redeemed');

      const ledger = await entries(buyer);
      expect(ledger).toEqual([
        {
          id: result.entryId,
          reason: 'GIFT_CARD_REDEMPTION',
          direction: 'CREDIT',
          amount: '50000',
          reference: giftCardReference(result.codeId),
        },
      ]);
      // The balance is the ledger's sum, and nothing else.
      expect(await balance(buyer)).toBe(50_000n);
      const [stamped] = await rows<{
        redeemed_by_customer_id: string;
        wallet_entry_id: string;
        last4: string;
      }>(
        sql`SELECT redeemed_by_customer_id, wallet_entry_id, last4 FROM gift_card_codes WHERE id = ${result.codeId}`,
      );
      expect(stamped).toMatchObject({
        redeemed_by_customer_id: buyer,
        wallet_entry_id: result.entryId,
      });
      expect(stamped?.last4).toBe(code.slice(-4));

      expect(
        await count(sql`SELECT count(*)::int AS n FROM outbox_messages
                         WHERE event_type = 'WalletEntryRecorded' AND payload->>'entryId' = ${result.entryId}`),
      ).toBe(1);
      expect(
        await count(sql`SELECT count(*)::int AS n FROM outbox_messages
                         WHERE event_type = 'GiftCardRedeemed' AND payload->>'codeId' = ${result.codeId}`),
      ).toBe(1);
      const audit = await rows<{
        entity_id: string;
        after: Record<string, unknown>;
        source_surface: string;
      }>(
        sql`SELECT entity_id, after, source_surface FROM audit_logs WHERE action = 'gift_card.redeem'`,
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ entity_id: result.codeId, source_surface: 'TELEGRAM' });
      expect(audit[0]?.after).toMatchObject({ last4: code.slice(-4), entryId: result.entryId });
      expect(JSON.stringify(audit[0]?.after)).not.toContain(code);

      // The same code again — another key, the same customer — is refused, and nothing moves.
      expect(await redeem(buyer, code)).toEqual({ outcome: 'REJECTED', rejection: 'USED' });
      expect(await entries()).toHaveLength(1);
      expect(await attempts(buyer)).toEqual([{ outcome: 'USED' }]);

      // The operations log: the money from the ledger, the batch, the last four, the source.
      const queued: Queued[] = [];
      const consumer = new LedgerLogConsumer({
        lane: { queue: async (_scope, input) => void queued.push({ input }) },
        facts: new DrizzleOpsLogFacts(db()),
        words: i18nOpsLogWords,
      });
      const event = (
        await rows<{ payload: Record<string, unknown> }>(
          sql`SELECT payload FROM outbox_messages WHERE event_type = 'WalletEntryRecorded'
               AND payload->>'entryId' = ${result.entryId}`,
        )
      )[0];
      await ctx.container.uow.run(tenantA, (tx) =>
        consumer.handle(
          {
            eventId: ctx.container.ids.uuid(),
            eventType: 'WalletEntryRecorded',
            eventVersion: 1,
            tenantId: String(tenantA.tenantId),
            aggregateType: 'Wallet',
            aggregateId: buyer,
            sequence: 1,
            correlationId: 'gift-card-test',
            causationId: null,
            actor: { type: 'SYSTEM_JOB', id: null },
            occurredAt: '2026-10-26T09:30:00.000Z',
            payload: event?.payload,
          } as unknown as DomainEvent,
          tx as never,
        ),
      );
      expect(queued).toHaveLength(1);
      expect(queued[0]?.input).toMatchObject({
        templateKey: 'ops.log.gift_card_redeemed',
        dedupeKey: `oplog:ledger:${result.entryId}`,
      });
      expect(queued[0]?.input.values).toMatchObject({
        amount: money(50_000n, 'IRT'),
        balanceBefore: money(0n, 'IRT'),
        balanceAfter: money(50_000n, 'IRT'),
        batchLabel: 'نوروز',
        codeLast4: code.slice(-4),
        source: i18nOpsLogWords.sourceName('BOT'),
      });
    });

    it('answers a replay with the first result and writes nothing; a key reused for another code is refused', async () => {
      await setFlag(true);
      const { codes } = await mint({ count: 2 });
      const buyer = await customer('950002');
      const sameKey = key();
      const first = await redeem(buyer, codes[0] as string, sameKey);
      const again = await redeem(buyer, codes[0] as string, sameKey);
      expect(again).toEqual(first);
      expect(await entries(buyer)).toHaveLength(1);
      expect(await attempts(buyer)).toEqual([]);
      await expect(redeem(buyer, codes[1] as string, sameKey)).rejects.toMatchObject({
        kind: 'CONFLICT',
      });
      expect(await entries(buyer)).toHaveLength(1);
    });

    it('lets one of several customers racing for one code have it: one credit, every other REJECTED', async () => {
      await setFlag(true);
      const { codes } = await mint({ count: 1, amountMinor: 70_000n });
      const racers = await Promise.all(
        ['950010', '950011', '950012', '950013'].map((id) => customer(id)),
      );
      const results = await Promise.all(racers.map((racer) => redeem(racer, codes[0] as string)));
      expect(results.filter((r) => r.outcome === 'REDEEMED')).toHaveLength(1);
      expect(results.filter((r) => r.outcome === 'REJECTED')).toHaveLength(3);
      expect(await entries()).toHaveLength(1);
    });

    it('stops at the expiry instant: redeemable one millisecond before it, refused AT it', async () => {
      await setFlag(true);
      const { batchId, codes } = await mint({ count: 2 });
      const [row] = await rows<{ expires_at: Date }>(
        sql`SELECT expires_at FROM gift_card_batches WHERE id = ${batchId}`,
      );
      const expiresAt = new Date(row?.expires_at as Date);
      const buyer = await customer('950020');
      expect(
        await redeem(buyer, codes[0] as string, key(), tenantA, redemptionAt(expiresAt)),
      ).toEqual({
        outcome: 'REJECTED',
        rejection: 'EXPIRED',
      });
      const before = new Date(expiresAt.getTime() - 1);
      expect(
        (await redeem(buyer, codes[1] as string, key(), tenantA, redemptionAt(before))).outcome,
      ).toBe('REDEEMED');
      expect(await entries(buyer)).toHaveLength(1);
    });

    it('gives the one refusal for a disabled batch, a reached limit, another tenant and a changed currency', async () => {
      await setFlag(true);
      await setFlag(true, tenantB, ownerB);
      const limited = await mint({ count: 3, perCustomerLimit: 1 });
      const buyer = await customer('950030');
      expect((await redeem(buyer, limited.codes[0] as string)).outcome).toBe('REDEEMED');
      expect(await redeem(buyer, limited.codes[1] as string)).toEqual({
        outcome: 'REJECTED',
        rejection: 'LIMIT_REACHED',
      });
      // Another customer is not held by this one's limit.
      const other = await customer('950031');
      expect((await redeem(other, limited.codes[1] as string)).outcome).toBe('REDEEMED');

      // Disabled: the unredeemed code stops; the redeemed ones keep their money.
      const preview = await ctx.container.giftCards.disablePreview(tenantA, owner, limited.batchId);
      expect(preview.unredeemed).toBe(1);
      await ctx.container.giftCards.disable(tenantA, owner, limited.batchId, {
        idempotencyKey: key(),
        reason: 'پایان کمپین',
        expectedUnredeemed: 1,
      });
      const third = await customer('950032');
      expect(await redeem(third, limited.codes[2] as string)).toEqual({
        outcome: 'REJECTED',
        rejection: 'DISABLED',
      });

      // Another tenant's customer: the code's hash is bound to tenant A, so it is unknown in B.
      const fresh = await mint({ count: 1 });
      const stranger = await customer('950033', tenantB, BOT_B);
      expect(await redeem(stranger, fresh.codes[0] as string, key(), tenantB)).toEqual({
        outcome: 'REJECTED',
        rejection: 'UNKNOWN',
      });

      // The wallet's currency changed since the batch was minted: refused, never converted.
      await setCurrency('IRR');
      expect(await redeem(third, fresh.codes[0] as string)).toEqual({
        outcome: 'REJECTED',
        rejection: 'CURRENCY_MISMATCH',
      });
      expect(await entries()).toHaveLength(2);
      expect(await balance(third)).toBe(0n);
    });

    it('decides the per-customer limit under the customer lock: concurrent redemptions of one customer get one', async () => {
      await setFlag(true);
      const { codes } = await mint({ count: 4, perCustomerLimit: 1 });
      const buyer = await customer('950040');
      const results = await Promise.all(codes.map((code) => redeem(buyer, code)));
      expect(results.filter((r) => r.outcome === 'REDEEMED')).toHaveLength(1);
      expect(await entries(buyer)).toHaveLength(1);
    });

    it('limits refused codes in the database and refuses the next code unread, even a valid one', async () => {
      await setFlag(true);
      const { codes } = await mint({ count: 1 });
      const guesser = await customer('950050');
      for (let i = 0; i < GIFT_CARD_MAX_FAILED_ATTEMPTS; i += 1) {
        const guess = i % 2 === 0 ? 'not a code' : '2222-3333-4444-5555-6666';
        expect((await redeem(guesser, guess)).outcome).toBe('REJECTED');
      }
      expect(await redeem(guesser, codes[0] as string)).toEqual({ outcome: 'RATE_LIMITED' });
      // Not read: the code is untouched and another customer still redeems it.
      expect(await attempts(guesser)).toHaveLength(GIFT_CARD_MAX_FAILED_ATTEMPTS);
      expect(await entries()).toHaveLength(0);
      const honest = await customer('950051');
      expect((await redeem(honest, codes[0] as string)).outcome).toBe('REDEEMED');
    });

    it('counts concurrent guesses under the lock: never more refusals recorded than the limit allows', async () => {
      await setFlag(true);
      const guesser = await customer('950052');
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => redeem(guesser, `guess-${i}`)),
      );
      expect(results.filter((r) => r.outcome === 'REJECTED')).toHaveLength(
        GIFT_CARD_MAX_FAILED_ATTEMPTS,
      );
      expect(results.filter((r) => r.outcome === 'RATE_LIMITED')).toHaveLength(
        12 - GIFT_CARD_MAX_FAILED_ATTEMPTS,
      );
      expect(await attempts(guesser)).toHaveLength(GIFT_CARD_MAX_FAILED_ATTEMPTS);
    });

    it('is refused with nothing written while the feature is off or the tenant has stopped', async () => {
      await setFlag(true);
      const { codes } = await mint({ count: 1 });
      const buyer = await customer('950060');
      await setFlag(false);
      await expect(redeem(buyer, codes[0] as string)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.GIFT_CARDS_DISABLED,
      });
      await setFlag(true);
      await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`);
      await expect(redeem(buyer, codes[0] as string)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
      });
      await db().execute(sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${tenantA.tenantId}`);
      expect(await entries()).toHaveLength(0);
      expect(await attempts(buyer)).toEqual([]);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM gift_card_codes WHERE redeemed_at IS NOT NULL`,
        ),
      ).toBe(0);
    });
  });

  // -----------------------------------------------------------------------------------

  describe('a batch', () => {
    it('stores no plaintext code anywhere: codes hashed, the export sealed, the audit and events counts only', async () => {
      await setFlag(true);
      const { batchId, codes } = await mint({ count: 5 });
      expect(new Set(codes).size).toBe(5);
      for (const code of codes)
        expect(code).toMatch(/^[2-9A-HJKMNP-TV-Z]{4}(-[2-9A-HJKMNP-TV-Z]{4}){4}$/u);
      const bare = codes.map((code) => code.replace(/-/g, ''));
      const dump = (
        await rows<{ text: string }>(sql`
          SELECT (SELECT coalesce(string_agg(t::text, ' '), '') FROM gift_card_codes t)
              || (SELECT coalesce(string_agg(t::text, ' '), '') FROM gift_card_batches t)
              || (SELECT coalesce(string_agg(t::text, ' '), '') FROM audit_logs t)
              || (SELECT coalesce(string_agg(t::text, ' '), '') FROM outbox_messages t)
              || (SELECT coalesce(string_agg(t::text, ' '), '') FROM operational_events t)
              || (SELECT coalesce(string_agg(t::text, ' '), '') FROM request_idempotency t) AS text`)
      )[0]?.text as string;
      for (const code of [...codes, ...bare]) expect(dump).not.toContain(code);
      const [batch] = await rows<{ export_ciphertext: string | null; code_count: number }>(
        sql`SELECT export_ciphertext, code_count FROM gift_card_batches WHERE id = ${batchId}`,
      );
      expect(batch?.export_ciphertext).not.toBeNull();
      expect(batch?.code_count).toBe(5);
      const audit = await rows<{ action: string; after: Record<string, unknown> }>(
        sql`SELECT action, after FROM audit_logs WHERE entity_id = ${batchId} ORDER BY occurred_at, id`,
      );
      expect(audit.map((row) => row.action)).toEqual([
        'gift_card.batch.create',
        'gift_card.batch.export',
      ]);
      expect(audit[0]?.after).toMatchObject({
        count: 5,
        faceTotalMinor: '250000',
        currency: 'IRT',
      });
      expect(audit[1]?.after).toMatchObject({ count: 5 });
      expect(
        await count(sql`SELECT count(*)::int AS n FROM outbox_messages
                         WHERE event_type = 'GiftCardBatchCreated' AND aggregate_id = ${batchId}`),
      ).toBe(1);
    });

    it('refuses a wrong confirmation, another currency, and minting while the feature is off', async () => {
      const base = {
        label: 'آزمون',
        amountMinor: 10_000n,
        currency: 'IRT' as const,
        count: 3,
        expiresAt: new Date(ctx.container.clock.now().getTime() + 48 * HOUR),
        perCustomerLimit: null,
        reason: 'آزمون',
        expectedTotalMinor: 30_000n,
        typedCount: 3,
      };
      await expect(
        ctx.container.giftCards.create(tenantA, owner, { ...base, idempotencyKey: key() }),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.GIFT_CARDS_DISABLED });
      await setFlag(true);
      await expect(
        ctx.container.giftCards.create(tenantA, owner, {
          ...base,
          idempotencyKey: key(),
          typedCount: 4,
        }),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.GIFT_CARD_CONFIRMATION_MISMATCH });
      await expect(
        ctx.container.giftCards.create(tenantA, owner, {
          ...base,
          idempotencyKey: key(),
          expectedTotalMinor: 29_999n,
        }),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.GIFT_CARD_CONFIRMATION_MISMATCH });
      await expect(
        ctx.container.giftCards.create(tenantA, owner, {
          ...base,
          idempotencyKey: key(),
          currency: 'IRR',
        }),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.GIFT_CARD_BATCH_INVALID });
      await expect(
        ctx.container.giftCards.create(tenantA, owner, {
          ...base,
          idempotencyKey: key(),
          expiresAt: new Date(ctx.container.clock.now().getTime() + 10 * 60 * 1000),
        }),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.GIFT_CARD_BATCH_INVALID });
      expect(await count(sql`SELECT count(*)::int AS n FROM gift_card_batches`)).toBe(0);
      expect(await count(sql`SELECT count(*)::int AS n FROM gift_card_codes`)).toBe(0);
      // A replayed create answers the batch it made and mints nothing more.
      const sameKey = key();
      const first = await ctx.container.giftCards.create(tenantA, owner, {
        ...base,
        idempotencyKey: sameKey,
      });
      const again = await ctx.container.giftCards.create(tenantA, owner, {
        ...base,
        idempotencyKey: sameKey,
      });
      expect(again.batch.id).toBe(first.batch.id);
      expect(await count(sql`SELECT count(*)::int AS n FROM gift_card_codes`)).toBe(3);
    });

    it('serves the export for 24 hours only; the sweep then purges it, and the codes cannot be shown again', async () => {
      await setFlag(true);
      const { batchId } = await mint({ count: 2 });
      const [row] = await rows<{ created_at: Date }>(
        sql`SELECT created_at FROM gift_card_batches WHERE id = ${batchId}`,
      );
      const createdAt = new Date(row?.created_at as Date).getTime();
      // One millisecond inside the window, then AT its end.
      const inside = await adminAt(new Date(createdAt + GIFT_CARD_EXPORT_TTL_MS - 1)).exportCodes(
        tenantA,
        owner,
        batchId,
      );
      expect(inside.count).toBe(2);
      await expect(
        adminAt(new Date(createdAt + GIFT_CARD_EXPORT_TTL_MS)).exportCodes(tenantA, owner, batchId),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.GIFT_CARD_EXPORT_GONE });
      // Every successful download is audited.
      expect(
        await count(sql`SELECT count(*)::int AS n FROM audit_logs
                         WHERE action = 'gift_card.batch.export' AND entity_id = ${batchId}`),
      ).toBe(2);

      // The sweep purges an export whose window has passed (moved into the past here).
      await db().execute(sql`UPDATE gift_card_batches
                                SET export_expires_at = created_at + interval '1 millisecond'
                              WHERE id = ${batchId}`);
      ctx.container.setInstallationTenant(tenantA.tenantId);
      expect(await ctx.container.giftCardSweepLoop.tick()).toMatchObject({ exportsPurged: 1 });
      const [purged] = await rows<{
        export_ciphertext: string | null;
        export_key_id: string | null;
      }>(sql`SELECT export_ciphertext, export_key_id FROM gift_card_batches WHERE id = ${batchId}`);
      expect(purged).toEqual({ export_ciphertext: null, export_key_id: null });
      await expect(
        ctx.container.giftCards.exportCodes(tenantA, owner, batchId),
      ).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.GIFT_CARD_EXPORT_GONE,
      });
      const view = await ctx.container.giftCards.get(tenantA, owner, batchId);
      expect(view.exportAvailableUntil).toBeNull();
    });

    it('disables only the unredeemed codes, confirmed against the previewed count, and says so on a repeat', async () => {
      await setFlag(true);
      const { batchId, codes } = await mint({ count: 3 });
      const buyer = await customer('950070');
      expect((await redeem(buyer, codes[0] as string)).outcome).toBe('REDEEMED');
      const preview = await ctx.container.giftCards.disablePreview(tenantA, owner, batchId);
      expect(preview.unredeemed).toBe(2);
      await expect(
        ctx.container.giftCards.disable(tenantA, owner, batchId, {
          idempotencyKey: key(),
          reason: 'پایان',
          expectedUnredeemed: 3,
        }),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.GIFT_CARD_CONFIRMATION_MISMATCH });
      const done = await ctx.container.giftCards.disable(tenantA, owner, batchId, {
        idempotencyKey: key(),
        reason: 'پایان',
        expectedUnredeemed: 2,
      });
      expect(done).toMatchObject({ changed: true, codesDisabled: 2 });
      expect(done.view.counts).toEqual({ redeemed: 1, disabled: 2, unredeemed: 0 });
      expect(done.view.redeemedTotal).toEqual(money(50_000n, 'IRT'));
      // The redeemed code and its money are untouched.
      expect(await balance(buyer)).toBe(50_000n);
      expect(
        await count(sql`SELECT count(*)::int AS n FROM outbox_messages
                         WHERE event_type = 'GiftCardBatchDisabled' AND aggregate_id = ${batchId}`),
      ).toBe(1);
      const repeat = await ctx.container.giftCards.disable(tenantA, owner, batchId, {
        idempotencyKey: key(),
        reason: 'پایان',
        expectedUnredeemed: 0,
      });
      expect(repeat).toMatchObject({ changed: false, codesDisabled: 0 });
    });

    it('audits a denied create, export and disable as DENIED, and writes nothing', async () => {
      await setFlag(true);
      const { batchId } = await mint({ count: 1 });
      await expect(
        ctx.container.giftCards.create(tenantA, operator, {
          idempotencyKey: key(),
          label: 'x',
          amountMinor: 1_000n,
          currency: 'IRT',
          count: 1,
          expiresAt: new Date(ctx.container.clock.now().getTime() + 48 * HOUR),
          perCustomerLimit: null,
          reason: 'x',
          expectedTotalMinor: 1_000n,
          typedCount: 1,
        }),
      ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
      await expect(
        ctx.container.giftCards.exportCodes(tenantA, operator, batchId),
      ).rejects.toMatchObject({
        kind: 'PERMISSION_DENIED',
      });
      await expect(
        ctx.container.giftCards.disable(tenantA, operator, batchId, {
          idempotencyKey: key(),
          reason: 'x',
          expectedUnredeemed: 1,
        }),
      ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
      const denied = await rows<{ action: string }>(
        sql`SELECT action FROM audit_logs WHERE result = 'DENIED' AND action LIKE 'gift_card.%'
             ORDER BY action`,
      );
      expect(denied.map((row) => row.action)).toEqual([
        'gift_card.batch.create',
        'gift_card.batch.disable',
        'gift_card.batch.export',
      ]);
      expect(await count(sql`SELECT count(*)::int AS n FROM gift_card_batches`)).toBe(1);
      await expect(ctx.container.giftCards.list(tenantA, operator, {})).rejects.toMatchObject({
        kind: 'PERMISSION_DENIED',
      });
    });
  });
});
