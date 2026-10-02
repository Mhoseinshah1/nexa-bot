import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TONPAYS_TELEGRAM_REVIEW_WINDOW_MS,
  type BotInstanceId,
  type CorrelationId,
  type PaymentId,
  type UserId,
} from '@nexa/contracts';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { createTestContext, SEED_IDS, tenantA, type TestContext } from './harness';

/**
 * The provider review window, at the repository and the schema
 * (`docs/tonpays-telegram-gateway-audit.md` §7.0, §9.6.3; the owner's decision of 2026-10-01).
 *
 * Every rule here is enforced TWICE: by the conditional statement the application uses and
 * by the database for any writer that forgets it — the CHECK binds the window to its route,
 * its length and a moment strictly before the payment's own deadline, and the confirmation
 * guard writes it once, only while PENDING. The minute-70 race is run with two real
 * connections and a lock barrier, never a sleep.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const HOUR = 3_600_000;

describe('the provider review window (repository and schema)', () => {
  let ctx: TestContext;
  let repo: DrizzlePaymentRepository;
  let customer: UserId;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    repo = new DrizzlePaymentRepository(ctx.container.database.db);
    customer = (
      await ctx.container.customers.resolveFromUpdate(
        tenantA,
        {
          type: 'SYSTEM_JOB',
          id: null,
          label: 'test',
          surface: 'TELEGRAM',
          correlationId: 'c' as CorrelationId,
        },
        {
          idempotencyKey: 'resolve-review',
          telegramUserId: '424242',
          from: { id: 424242, first_name: 'سارا' },
          botInstanceId: BOT_A,
        },
      )
    ).customer.id;
  });

  const exec = async <T>(query: ReturnType<typeof sql>): Promise<T[]> =>
    (await ctx.container.database.db.execute(query)).rows as T[];

  /** A PENDING gateway payment created at `createdAt`, with the 70-minute deadline. */
  async function gatewayPayment(
    provider: 'TONPAYS_TELEGRAM' | 'TONPAYS' | 'TELEGRAM_STARS',
    createdAt: Date,
  ): Promise<{ id: PaymentId; expiresAt: Date }> {
    seq += 1;
    const id = ctx.container.ids.uuid() as PaymentId;
    const expiresAt = new Date(createdAt.getTime() + 70 * 60_000);
    await exec(sql`INSERT INTO payments
      (id, tenant_id, customer_id, method, amount, currency, reference, expires_at,
       gateway_provider, created_at, updated_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customer}, 'GATEWAY', 250000, 'IRT',
              ${`ref-review-${String(seq)}`}, ${expiresAt}, ${provider}, ${createdAt}, ${createdAt})`);
    return { id, expiresAt };
  }

  async function row(id: string) {
    const [found] = await exec<{
      state: string;
      provider_review_started_at: Date | null;
      provider_review_until: Date | null;
      resolved_at: Date | null;
    }>(sql`SELECT state, provider_review_started_at, provider_review_until, resolved_at
             FROM payments WHERE id = ${id}`);
    if (found === undefined) throw new Error('no payment');
    const date = (value: Date | string | null) => (value === null ? null : new Date(value));
    return {
      ...found,
      provider_review_started_at: date(found.provider_review_started_at),
      provider_review_until: date(found.provider_review_until),
      resolved_at: date(found.resolved_at),
    };
  }

  const ack = (id: PaymentId, at: Date) =>
    ctx.container.uow.run(tenantA, async (tx) => {
      await repo.findByIdForUpdate(tenantA, id, tx);
      return repo.recordProviderReview(
        tenantA,
        id,
        {
          acknowledgedAt: at,
          reviewUntil: new Date(at.getTime() + TONPAYS_TELEGRAM_REVIEW_WINDOW_MS),
        },
        at,
        tx,
      );
    });

  const expireAt = (now: Date) =>
    ctx.container.uow.run(tenantA, (tx) => repo.expireDue(tenantA, now, 100, tx));

  const loseTrackAt = (now: Date) =>
    ctx.container.uow.run(tenantA, (tx) => repo.loseTrackOfReviewed(tenantA, now, 100, tx));

  /** A refused statement, as the error PostgreSQL raised (a CHECK or the guard trigger). */
  const refused = async (query: ReturnType<typeof sql>): Promise<string> => {
    try {
      await exec(query);
    } catch (error: unknown) {
      const cause = (error as { cause?: { message?: string } }).cause;
      return String(cause?.message ?? (error as Error).message);
    }
    throw new Error('the statement was accepted');
  };

  it('TPTG-24: an acknowledgement opens a review only strictly before the 70-minute deadline (half-open), and the CHECK refuses one at it', async () => {
    const created = new Date('2026-10-02T10:00:00Z');
    const early = await gatewayPayment('TONPAYS_TELEGRAM', created);
    const atDeadline = await gatewayPayment('TONPAYS_TELEGRAM', created);

    const justBefore = new Date(early.expiresAt.getTime() - 1);
    expect(await ack(early.id, justBefore)).toBe(true);
    const opened = await row(early.id);
    expect(opened.provider_review_started_at?.getTime()).toBe(justBefore.getTime());
    expect(opened.provider_review_until?.getTime()).toBe(
      justBefore.getTime() + TONPAYS_TELEGRAM_REVIEW_WINDOW_MS,
    );

    // 70:00.000 exactly opens nothing, and writes nothing.
    expect(await ack(atDeadline.id, atDeadline.expiresAt)).toBe(false);
    expect((await row(atDeadline.id)).provider_review_until).toBeNull();

    // A writer that forgets the predicate is refused by the database itself.
    const at = atDeadline.expiresAt;
    expect(
      await refused(sql`UPDATE payments SET provider_review_started_at = ${at},
          provider_review_until = ${new Date(at.getTime() + TONPAYS_TELEGRAM_REVIEW_WINDOW_MS)}
        WHERE id = ${atDeadline.id}`),
    ).toMatch(/payments_provider_review_check/u);
  });

  it('TPTG-24/34: the CHECK pins exactly 24 hours, both columns together, and the Telegram route only', async () => {
    const created = new Date('2026-10-02T10:00:00Z');
    const telegram = await gatewayPayment('TONPAYS_TELEGRAM', created);
    const website = await gatewayPayment('TONPAYS', created);
    const stars = await gatewayPayment('TELEGRAM_STARS', created);
    const at = new Date(created.getTime() + 30 * 60_000);
    for (const [label, until] of [
      ['23 hours', new Date(at.getTime() + 23 * HOUR)],
      ['25 hours', new Date(at.getTime() + 25 * HOUR)],
    ] as const) {
      expect(
        await refused(sql`UPDATE payments SET provider_review_started_at = ${at},
            provider_review_until = ${until} WHERE id = ${telegram.id}`),
        label,
      ).toMatch(/payments_provider_review_check/u);
    }
    expect(
      await refused(
        sql`UPDATE payments SET provider_review_started_at = ${at} WHERE id = ${telegram.id}`,
      ),
    ).toMatch(/payments_provider_review_check/u);
    for (const other of [website, stars]) {
      expect(
        await refused(sql`UPDATE payments SET provider_review_started_at = ${at},
            provider_review_until = ${new Date(at.getTime() + TONPAYS_TELEGRAM_REVIEW_WINDOW_MS)}
          WHERE id = ${other.id}`),
      ).toMatch(/payments_provider_review_check/u);
      expect(await ack(other.id, at)).toBe(false);
    }
  });

  it('TPTG-30: a repeated or later acknowledgement never moves the deadline, and the guard refuses any direct change', async () => {
    const created = new Date('2026-10-02T10:00:00Z');
    const payment = await gatewayPayment('TONPAYS_TELEGRAM', created);
    const first = new Date(created.getTime() + 20 * 60_000);
    expect(await ack(payment.id, first)).toBe(true);
    // A second acknowledgement, later but still inside the customer window: a clean false.
    expect(await ack(payment.id, new Date(created.getTime() + 40 * 60_000))).toBe(false);
    const after = await row(payment.id);
    expect(after.provider_review_started_at?.getTime()).toBe(first.getTime());
    expect(after.provider_review_until?.getTime()).toBe(
      first.getTime() + TONPAYS_TELEGRAM_REVIEW_WINDOW_MS,
    );
    const later = new Date(created.getTime() + 41 * 60_000);
    expect(
      await refused(sql`UPDATE payments SET provider_review_started_at = ${later},
          provider_review_until = ${new Date(later.getTime() + TONPAYS_TELEGRAM_REVIEW_WINDOW_MS)}
        WHERE id = ${payment.id}`),
    ).toMatch(/written once/u);
    expect(
      await refused(sql`UPDATE payments SET provider_review_started_at = NULL,
          provider_review_until = NULL WHERE id = ${payment.id}`),
    ).toMatch(/written once/u);
  });

  it('TPTG-30: the window cannot be written on a payment that is not PENDING', async () => {
    const created = new Date('2026-10-02T10:00:00Z');
    const payment = await gatewayPayment('TONPAYS_TELEGRAM', created);
    expect(await expireAt(new Date(payment.expiresAt.getTime() + 1))).toHaveLength(1);
    const at = new Date(created.getTime() + 10 * 60_000);
    expect(await ack(payment.id, at)).toBe(false);
    expect(
      await refused(sql`UPDATE payments SET provider_review_started_at = ${at},
          provider_review_until = ${new Date(at.getTime() + TONPAYS_TELEGRAM_REVIEW_WINDOW_MS)}
        WHERE id = ${payment.id}`),
    ).toMatch(/written once|cannot be reopened/u);
  });

  it('TPTG-25/26: the expiry sweep skips a payment in review and nothing else — website, Stars and an unacknowledged Telegram attempt still expire', async () => {
    const created = new Date('2026-10-02T10:00:00Z');
    const reviewed = await gatewayPayment('TONPAYS_TELEGRAM', created);
    const unacknowledged = await gatewayPayment('TONPAYS_TELEGRAM', created);
    const website = await gatewayPayment('TONPAYS', created);
    const stars = await gatewayPayment('TELEGRAM_STARS', created);
    expect(await ack(reviewed.id, new Date(created.getTime() + 69 * 60_000))).toBe(true);

    const expired = await expireAt(new Date(created.getTime() + 71 * 60_000));
    expect(expired.map((payment) => payment.id).sort()).toEqual(
      [unacknowledged.id, website.id, stars.id].sort(),
    );
    expect((await row(reviewed.id)).state).toBe('PENDING');
    // Even a day later, until its review ends, the expiry sweep never takes it.
    expect(await expireAt(new Date(created.getTime() + 20 * HOUR))).toHaveLength(0);
    expect((await row(reviewed.id)).state).toBe('PENDING');
  });

  it('TPTG-31 (a): the acknowledgement holds the payment’s lock while the minute-70 sweep runs — skipped, and not expired after the commit', async () => {
    const created = new Date('2026-10-02T10:00:00Z');
    const payment = await gatewayPayment('TONPAYS_TELEGRAM', created);
    const ackAt = new Date(payment.expiresAt.getTime() - 1);
    const sweepAt = payment.expiresAt;

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const acknowledging = ctx.container.uow.run(tenantA, async (tx) => {
      await repo.findByIdForUpdate(tenantA, payment.id, tx);
      const moved = await repo.recordProviderReview(
        tenantA,
        payment.id,
        {
          acknowledgedAt: ackAt,
          reviewUntil: new Date(ackAt.getTime() + TONPAYS_TELEGRAM_REVIEW_WINDOW_MS),
        },
        ackAt,
        tx,
      );
      locked();
      await held;
      return moved;
    });
    try {
      await holding;
      // The sweep on a second connection while the acknowledgement is uncommitted.
      expect(await expireAt(sweepAt)).toHaveLength(0);
    } finally {
      release();
    }
    expect(await acknowledging).toBe(true);
    expect(await expireAt(new Date(sweepAt.getTime() + 60_000))).toHaveLength(0);
    const after = await row(payment.id);
    expect(after.state).toBe('PENDING');
    expect(after.provider_review_until).not.toBeNull();
  });

  it('TPTG-31 (b): the sweep expires first — the acknowledgement then finds EXPIRED, writes nothing and opens no review', async () => {
    const created = new Date('2026-10-02T10:00:00Z');
    const payment = await gatewayPayment('TONPAYS_TELEGRAM', created);
    expect(await expireAt(payment.expiresAt)).toHaveLength(1);
    expect(await ack(payment.id, new Date(payment.expiresAt.getTime() - 1))).toBe(false);
    const after = await row(payment.id);
    expect(after.state).toBe('EXPIRED');
    expect(after.provider_review_started_at).toBeNull();
    expect(after.provider_review_until).toBeNull();
  });

  it('TPTG-34: a fresh repository reads the persisted deadline, and the review sweep moves the payment to UNKNOWN exactly at it (half-open), once', async () => {
    const created = new Date('2026-10-02T10:00:00Z');
    const payment = await gatewayPayment('TONPAYS_TELEGRAM', created);
    const ackAt = new Date(created.getTime() + 30 * 60_000);
    expect(await ack(payment.id, ackAt)).toBe(true);
    const until = new Date(ackAt.getTime() + TONPAYS_TELEGRAM_REVIEW_WINDOW_MS);

    // A "restart": a new repository over a new view of the same database.
    const restarted = new DrizzlePaymentRepository(ctx.container.database.db);
    const read = await restarted.findById(tenantA, payment.id);
    expect(read?.providerReviewUntil?.getTime()).toBe(until.getTime());

    expect(await loseTrackAt(new Date(until.getTime() - 1))).toHaveLength(0);
    const moved = await loseTrackAt(until);
    expect(moved.map((one) => one.id)).toEqual([payment.id]);
    const after = await row(payment.id);
    expect(after.state).toBe('UNKNOWN');
    // UNKNOWN is not a resolved state: no resolution time.
    expect(after.resolved_at).toBeNull();
    // A replayed pass moves nothing.
    expect(await loseTrackAt(new Date(until.getTime() + HOUR))).toHaveLength(0);
  });

  it('reconciles only from UNKNOWN, each edge conditional so a double click moves once', async () => {
    const created = new Date('2026-10-02T10:00:00Z');
    const confirmable = await gatewayPayment('TONPAYS_TELEGRAM', created);
    const failable = await gatewayPayment('TONPAYS_TELEGRAM', created);
    const pending = await gatewayPayment('TONPAYS_TELEGRAM', created);
    const ackAt = new Date(created.getTime() + 10 * 60_000);
    for (const one of [confirmable, failable]) expect(await ack(one.id, ackAt)).toBe(true);
    await loseTrackAt(new Date(ackAt.getTime() + TONPAYS_TELEGRAM_REVIEW_WINDOW_MS));
    const now = new Date(ackAt.getTime() + TONPAYS_TELEGRAM_REVIEW_WINDOW_MS + HOUR);
    const confirm = (id: PaymentId) =>
      ctx.container.uow.run(tenantA, (tx) =>
        repo.reconcileConfirm(
          tenantA,
          id,
          {
            evidenceKind: 'RECONCILIATION',
            evidenceNote: 'test',
            confirmedByAdminId: null,
            confirmedAt: now,
          },
          now,
          tx,
        ),
      );
    const fail = (id: PaymentId) =>
      ctx.container.uow.run(tenantA, (tx) =>
        repo.reconcileFail(
          tenantA,
          id,
          { resolvedByAdminId: null, resolutionNote: 'tonpays_telegram:rejected', resolvedAt: now },
          now,
          tx,
        ),
      );
    expect(await confirm(pending.id)).toBe(false);
    expect(await fail(pending.id)).toBe(false);
    expect(await confirm(confirmable.id)).toBe(true);
    expect(await confirm(confirmable.id)).toBe(false);
    expect(await fail(confirmable.id)).toBe(false);
    expect(await fail(failable.id)).toBe(true);
    expect(await fail(failable.id)).toBe(false);
    expect((await row(confirmable.id)).state).toBe('CONFIRMED');
    expect((await row(failable.id)).state).toBe('FAILED');
    expect((await row(pending.id)).state).toBe('PENDING');
  });

  it('the card history is append-only', async () => {
    const created = new Date('2026-10-02T10:00:00Z');
    const payment = await gatewayPayment('TONPAYS_TELEGRAM', created);
    await exec(sql`INSERT INTO gateway_invoice_cards
      (tenant_id, payment_id, seq, card_number, card_name, source, received_at)
      VALUES (${tenantA.tenantId}, ${payment.id}, 1, '6037-0000-0000-0001', NULL, 'CREATE', ${created})`);
    expect(
      await refused(sql`UPDATE gateway_invoice_cards SET card_number = '6037-9999-9999-9999'
        WHERE payment_id = ${payment.id}`),
    ).toMatch(/append-only/u);
    expect(
      await refused(sql`DELETE FROM gateway_invoice_cards WHERE payment_id = ${payment.id}`),
    ).toMatch(/append-only/u);
  });
});
