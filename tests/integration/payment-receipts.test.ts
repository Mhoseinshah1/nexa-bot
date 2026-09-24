import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  isNexaError,
  money,
  PAYMENT_RECEIPT_MAX_PER_PAYMENT,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type PaymentId,
  type PaymentReceiptId,
  type ProductId,
  type UserId,
  type ProductCategoryId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { RECEIPT_CAPTURE_LOCK_CLASS } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-receipt.repository';
import type { ProductDraft } from '../../apps/api/src/modules/commerce/catalog/application/ports';
import type { InboundReceiptFile } from '../../apps/api/src/modules/commerce/payments/application/receipt-ports';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  tenantA,
  tenantB,
  type TestContext,
  SEED_IDS,
} from './harness';

/**
 * The receipt lane: a window a tap opens, and what may reach it.
 *
 * Every case here is about one of two boundaries. The first is CLAIM versus EVIDENCE —
 * a filed receipt is something for a person to look at and settles nothing, so no case
 * below leaves a payment anything other than PENDING. The second is the window itself:
 * `INCIDENT-FIN-001` is a prompt that outlived its question and swallowed an ordinary
 * message, and the refusals here are what stop this one doing that.
 */

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('a customer sending a receipt', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let botA: BotInstanceId;
  let panelA: string;
  let panelB: string;
  let customerA: UserId;
  let ownerA: ActorContext;
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
    botA = (await firstBot(tenantA.tenantId)) as BotInstanceId;
    panelA = ctx.container.ids.uuid();
    panelB = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE'),
             (${panelB}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
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
    await makePanelSellable(ctx.container, tenantB, panelB);
    customerA = await customer(tenantA, botA, '920100');
    ownerA = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'owner-receipts-a',
        roleKeys: ['owner'],
      }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, {
        username: 'owner-receipts-b',
        roleKeys: ['owner'],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // The window, and what reaches it
  // -------------------------------------------------------------------------

  it('files a photo against the payment the window names, and settles nothing', async () => {
    const payment = await pending('r1');
    await signal(payment.id, 'r1-signal');

    const result = await submit(payment.id, photo('u-r1'), 'r1-file');

    expect(result.filed).toBe(true);
    expect(result.held).toBe(1);
    expect(result.paymentId).toBe(payment.id);

    const rows = await receiptRows(payment.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('PHOTO');
    expect(rows[0]?.bot_instance_id).toBe(botA);
    expect(rows[0]?.customer_id).toBe(customerA);

    // The whole point: EVIDENCE arrived and nothing was decided.
    const after = await paymentRow(payment.id);
    expect(after.state).toBe('PENDING');
    expect(after.evidence_kind).toBeNull();
    expect(after.confirmed_at).toBeNull();
  });

  it('files a document too, keeping the declared name, size and type', async () => {
    const payment = await pending('r2');
    await signal(payment.id, 'r2-signal');

    await submit(
      payment.id,
      {
        kind: 'DOCUMENT',
        fileId: 'file-r2',
        fileUniqueId: 'u-r2',
        mimeType: 'application/pdf',
        fileSize: 4_096n,
        fileName: 'rasid.pdf',
        telegramMessageId: 55n,
        caption: null,
      },
      'r2-file',
    );

    const rows = await receiptRows(payment.id);
    expect(rows[0]?.kind).toBe('DOCUMENT');
    expect(rows[0]?.file_name).toBe('rasid.pdf');
    expect(rows[0]?.mime_type).toBe('application/pdf');
    expect(rows[0]?.file_size).toBe('4096');
  });

  it('keeps the customer’s caption with the receipt, and the database bounds it (D3)', async () => {
    const payment = await pending('r2c');
    await signal(payment.id, 'r2c-signal');

    await submit(payment.id, { ...photo('u-r2c'), caption: 'از کارت همسرم' }, 'r2c-file');

    const stored = (await ctx.container.database.db.execute(
      sql`SELECT caption FROM payment_receipts WHERE payment_id = ${payment.id}` as never,
    )) as unknown as { rows: { caption: string | null }[] };
    expect(stored.rows).toEqual([{ caption: 'از کارت همسرم' }]);

    // The Telegram boundary normalises (`normalizeReceiptCaption`: empty to null, cut at
    // 1024). The CHECK is what holds for a writer that skips it.
    for (const [n, caption] of [
      [1, ''],
      [2, 'x'.repeat(1025)],
    ] as const) {
      const error = await submit(
        payment.id,
        { ...photo(`u-r2c-${n}`), caption },
        `r2c-file-${n}`,
      ).then(
        () => null,
        (caught: unknown) => caught,
      );
      let message = '';
      for (let at: unknown = error, depth = 0; at instanceof Error && depth < 5; depth += 1) {
        message += ` ${at.message}`;
        at = (at as { cause?: unknown }).cause;
      }
      expect(message, `a caption of ${caption.length}`).toMatch(/payment_receipts_caption_check/u);
    }
    expect(await receiptRows(payment.id)).toHaveLength(1);
  });

  it('refuses a file nobody asked for, by name', async () => {
    const payment = await pending('r3');
    // No tap, so no window. The payment exists and is pending, which is what makes this
    // the interesting refusal rather than a missing-payment one.
    await expectRefusal(
      submit(payment.id, photo('u-r3'), 'r3-file'),
      'commerce.receipt_not_expected',
    );
    expect(await receiptRows(payment.id)).toHaveLength(0);
  });

  it('refuses a file sent after the window closed', async () => {
    const payment = await pending('r4');
    await signal(payment.id, 'r4-signal');
    // The deadline moved into the past, which is what a customer who came back an hour
    // later produces. The ROW is untouched otherwise, so the window is open-but-expired
    // — the state the service must tell apart from no window at all.
    // Both timestamps, because `receipt_captures_expiry_check` refuses a deadline at or
    // before the opening — the constraint that stops a window being born expired.
    await ctx.container.database.db.execute(sql`
      UPDATE receipt_captures
         SET opened_at = now() - interval '2 hours',
             expires_at = now() - interval '1 minute'
       WHERE payment_id = ${payment.id} AND closed_at IS NULL`);

    await expectRefusal(
      submit(payment.id, photo('u-r4'), 'r4-file'),
      'commerce.receipt_window_expired',
    );
    expect(await receiptRows(payment.id)).toHaveLength(0);
  });

  it('refuses the sixth receipt and closes the window at the cap', async () => {
    const payment = await pending('r5');
    await signal(payment.id, 'r5-signal');

    for (let index = 0; index < PAYMENT_RECEIPT_MAX_PER_PAYMENT; index += 1) {
      const result = await submit(
        payment.id,
        photo(`u-r5-${String(index)}`),
        `r5-file-${String(index)}`,
      );
      expect(result.held).toBe(index + 1);
    }
    // The window closed as RECEIVED, and the reason matters: RECEIVED means it held
    // everything it may, never "a file arrived".
    expect(await captureState(payment.id)).toStrictEqual({
      closed: true,
      reason: 'RECEIVED',
    });

    await expectRefusal(
      submit(payment.id, photo('u-r5-extra'), 'r5-file-extra'),
      'commerce.receipt_not_expected',
    );
    expect(await receiptRows(payment.id)).toHaveLength(PAYMENT_RECEIPT_MAX_PER_PAYMENT);
  });

  it('keeps the window open while the payment can still hold more', async () => {
    const payment = await pending('r6');
    await signal(payment.id, 'r6-signal');
    await submit(payment.id, photo('u-r6-a'), 'r6-file-a');

    /*
     * A blurred screenshot followed by a clear one is ordinary. Closing on the FIRST
     * file would answer the second with `RECEIPT_NOT_EXPECTED` — the refusal meant for
     * a file nobody asked for — so the bound closes the window and nothing else does.
     */
    expect(await captureState(payment.id)).toStrictEqual({ closed: false, reason: null });
    const second = await submit(payment.id, photo('u-r6-b'), 'r6-file-b');
    expect(second.held).toBe(2);
  });

  it('refuses a receipt for a payment an operator already confirmed', async () => {
    const payment = await pending('r7');
    await signal(payment.id, 'r7-signal');
    await ctx.container.payments.confirmManualTransfer(tenantA, ownerA, payment.id, {
      idempotencyKey: 'r7-confirm',
      note: 'seen on the statement',
    });

    // The window is still open — the operator's confirmation does not close it — so the
    // refusal has to come from re-reading the PAYMENT's state, which is the rule.
    await expectRefusal(
      submit(payment.id, photo('u-r7'), 'r7-file'),
      'commerce.payment_state_invalid',
    );
    expect(await receiptRows(payment.id)).toHaveLength(0);
  });

  it('refuses a receipt from a customer blocked after the tap', async () => {
    const payment = await pending('r8');
    await signal(payment.id, 'r8-signal');
    await ctx.container.customers.block(tenantA, ownerA, {
      idempotencyKey: 'r8-block',
      customerId: customerA,
      reason: 'chargeback',
    });

    await expectRefusal(submit(payment.id, photo('u-r8'), 'r8-file'), 'commerce.customer_blocked');
    expect(await receiptRows(payment.id)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Redelivery and idempotency
  // -------------------------------------------------------------------------

  it('answers a redelivered update without writing a second row', async () => {
    const payment = await pending('r9');
    await signal(payment.id, 'r9-signal');
    const first = await submit(payment.id, photo('u-r9'), 'r9-file');
    // The SAME key: Telegram redelivering the same update is the case this covers.
    const replay = await submit(payment.id, photo('u-r9'), 'r9-file');

    expect(first.filed).toBe(true);
    expect(replay.held).toBe(first.held);
    expect(await receiptRows(payment.id)).toHaveLength(1);
    // One audit row, not one per retry. A log that grew a line per redelivery is the
    // legacy activity feed.
    expect(await auditActions(payment.id)).toStrictEqual(
      expect.arrayContaining(['payment.receipt_submit']),
    );
    expect(
      (await auditActions(payment.id)).filter((a) => a === 'payment.receipt_submit'),
    ).toHaveLength(1);
  });

  it('treats the same file under a new key as the same file, not a second receipt', async () => {
    const payment = await pending('r10');
    await signal(payment.id, 'r10-signal');
    await submit(payment.id, photo('u-r10'), 'r10-file-a');
    /*
     * A different idempotency key, so the store does not answer it — but the FILE is the
     * same, and `payment_receipts_unique_file` is what makes the second attempt a no-op
     * rather than a duplicate an operator has to reconcile.
     */
    const again = await submit(payment.id, photo('u-r10'), 'r10-file-b');

    expect(again.filed).toBe(false);
    expect(again.held).toBe(1);
    expect(await receiptRows(payment.id)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Tenancy
  // -------------------------------------------------------------------------

  it('does not let another tenant list or download a receipt', async () => {
    const payment = await pending('r11');
    await signal(payment.id, 'r11-signal');
    await submit(payment.id, photo('u-r11'), 'r11-file');
    const [row] = await receiptRows(payment.id);
    const receiptId = row?.id as PaymentReceiptId;

    // Tenant A's own operator reads it, so the refusals below are about the TENANT and
    // not about a permission or a bad id.
    expect(
      await ctx.container.receipts.listForPayment(tenantA, ownerA, payment.id as PaymentId),
    ).toHaveLength(1);

    await expectRefusal(
      ctx.container.receipts.listForPayment(tenantB, ownerB, payment.id as PaymentId),
      'commerce.payment_not_found',
    );
    await expectRefusal(
      ctx.container.receipts.findForDownload(tenantB, ownerB, receiptId),
      'commerce.receipt_not_found',
    );
  });

  it('refuses a receipt read to an operator without receipts.view', async () => {
    const payment = await pending('r12');
    await signal(payment.id, 'r12-signal');
    await submit(payment.id, photo('u-r12'), 'r12-file');
    const reader = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'sales-receipts',
        roleKeys: ['sales'],
      }),
    );

    /*
     * `sales` holds neither receipt key, which is what makes this case about
     * `receipts.view` and nothing else. `support` would NOT do: it holds `receipts.view`
     * WITHOUT `payments.view`, so this call would pass and the Web Admin page that
     * carries the card would still refuse it — the shape migration 0055 repaired for
     * `receipt_reviewer`, recorded for `support` as OQ-5R-01 rather than resolved by
     * widening a seeded role here.
     */
    await expectRefusal(
      ctx.container.receipts.listForPayment(tenantA, reader, payment.id as PaymentId),
      'platform.permission_denied',
    );
  });

  // -------------------------------------------------------------------------
  // Concurrency, on the Codex round of PR #35
  // -------------------------------------------------------------------------

  /*
   * Three of the four below are driven by a LOCK rather than by `Promise.all` timing: a
   * holder connection takes the same advisory key — or the same payment row — the suite
   * waits until each call is provably blocked on it, and only then releases. The wait is
   * also the falsification detector: with the lock removed nothing blocks, and
   * `awaitWaiters` fails by name rather than leaving the case to a count that might
   * happen to be right. The fourth needs no interleaving at all.
   */

  it('refuses the sixth of two concurrent receipts at the cap', async () => {
    const payment = await pending('c4');
    await signal(payment.id, 'c4-signal');
    for (let index = 0; index < PAYMENT_RECEIPT_MAX_PER_PAYMENT - 1; index += 1) {
      await submit(payment.id, photo(`u-c4-${String(index)}`), `c4-file-${String(index)}`);
    }
    expect(await receiptRows(payment.id)).toHaveLength(PAYMENT_RECEIPT_MAX_PER_PAYMENT - 1);

    const settled = await withHeldLock(async () => {
      const first = outcomeOf(submit(payment.id, photo('u-c4-a'), 'c4-file-a'));
      await awaitWaiters(1, 'the first receipt');
      const second = outcomeOf(submit(payment.id, photo('u-c4-b'), 'c4-file-b'));
      await awaitWaiters(2, 'the second receipt');
      return [first, second] as const;
    });

    const done = await Promise.all(settled);
    // One files, one is refused. Five, never six — the number the constant says.
    expect(done.filter((one) => one.ok)).toHaveLength(1);
    expect(await receiptRows(payment.id)).toHaveLength(PAYMENT_RECEIPT_MAX_PER_PAYMENT);
    const refused = done.find((one) => !one.ok);
    /*
     * `RECEIPT_NOT_EXPECTED`, not `RECEIPT_LIMIT_REACHED`, and the difference is the
     * serialisation working: the transaction that files the fifth closes the window as
     * RECEIVED in the SAME transaction, so the loser — which only now gets the lock —
     * reads no open window at all. It is the same refusal the sequential sixth receipt
     * gets, which is the point: concurrent and sequential must not differ.
     */
    expect(
      refused === undefined || refused.ok || !isNexaError(refused.error)
        ? null
        : refused.error.code,
    ).toBe('commerce.receipt_not_expected');
  });

  it('answers both of two concurrent taps on two invoices', async () => {
    const first = await pending('c2-a');
    const second = await pending('c2-b');

    const settled = await withHeldLock(async () => {
      const one = outcomeOf(signal(first.id, 'c2-signal-a'));
      await awaitWaiters(1, 'the first tap');
      const two = outcomeOf(signal(second.id, 'c2-signal-b'));
      await awaitWaiters(2, 'the second tap');
      return [one, two] as const;
    });

    /*
     * BOTH answered. Without the lock each transaction closes what it can see and
     * inserts, neither sees the other's uncommitted row, and the second insert hits
     * `receipt_captures_open_key` — the webhook swallows that and one customer's tap
     * is answered with nothing at all.
     */
    const done = await Promise.all(settled);
    expect(
      done.every((one) => one.ok),
      'neither tap may fail',
    ).toBe(true);
    // And one open window, because the second superseded the first.
    const open = (await ctx.container.database.db.execute(
      sql`SELECT payment_id FROM receipt_captures
           WHERE tenant_id = ${tenantA.tenantId} AND closed_at IS NULL` as never,
    )) as unknown as { rows: { payment_id: string }[] };
    expect(open.rows).toHaveLength(1);
  });

  it('refuses a receipt for a payment confirmed while the file was arriving', async () => {
    const payment = await pending('c9');
    await signal(payment.id, 'c9-signal');

    const outcome = await ctx.container.database.withClient(async (holder) => {
      await holder.query('BEGIN');
      try {
        // The PAYMENT row, held. `submit` re-reads it FOR UPDATE, so it blocks here —
        // which is the window an operator's confirmation commits in.
        await holder.query('SELECT id FROM payments WHERE id = $1 FOR UPDATE', [payment.id]);
        const filing = outcomeOf(submit(payment.id, photo('u-c9'), 'c9-file'));
        await awaitRowWaiters(1, 'the filing');
        await holder.query(
          `UPDATE payments SET state = 'CONFIRMED', evidence_kind = 'OPERATOR_REVIEW',
             confirmed_at = now() WHERE id = $1`,
          [payment.id],
        );
        await holder.query('COMMIT');
        return filing;
      } catch (error: unknown) {
        await holder.query('ROLLBACK');
        throw error;
      }
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok || !isNexaError(outcome.error) ? null : outcome.error.code).toBe(
      'commerce.payment_state_invalid',
    );
    expect(await receiptRows(payment.id)).toHaveLength(0);
  });

  it('does not promise another window once the payment is full', async () => {
    const payment = await pending('c8');
    await signal(payment.id, 'c8-signal');
    for (let index = 0; index < PAYMENT_RECEIPT_MAX_PER_PAYMENT; index += 1) {
      await submit(payment.id, photo(`u-c8-${String(index)}`), `c8-file-${String(index)}`);
    }
    expect(await captureState(payment.id)).toStrictEqual({ closed: true, reason: 'RECEIVED' });

    /*
     * The payment is still PENDING, so a customer scrolling back and tapping again used
     * to be given a fresh window that `submit` would refuse every time. The claim is
     * still recorded; what is not promised is an upload that cannot work.
     */
    const again = await signal(payment.id, 'c8-again');
    expect(again.receiptWindow).toBeNull();
    expect(await receiptRows(payment.id)).toHaveLength(PAYMENT_RECEIPT_MAX_PER_PAYMENT);
  });

  /** Runs `body` while a holder connection owns this customer's advisory key. */
  async function withHeldLock<T>(body: () => Promise<T>): Promise<T> {
    return ctx.container.database.withClient(async (holder) => {
      await holder.query('BEGIN');
      try {
        await holder.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
          RECEIPT_CAPTURE_LOCK_CLASS,
          `${tenantA.tenantId}:${botA}:${customerA}`,
        ]);
        const result = await body();
        await holder.query('COMMIT');
        return result;
      } catch (error: unknown) {
        await holder.query('ROLLBACK');
        throw error;
      }
    });
  }

  /** Waits until `expected` transactions are blocked on this customer's advisory key. */
  async function awaitWaiters(expected: number, what: string): Promise<void> {
    await awaitBlocked(
      sql`SELECT count(*)::int AS n FROM pg_locks
           WHERE locktype = 'advisory' AND classid = ${RECEIPT_CAPTURE_LOCK_CLASS}
             AND objid = (SELECT hashtext(${`${tenantA.tenantId}:${botA}:${customerA}`})::oid)
             AND NOT granted`,
      expected,
      `${what} never blocked on the receipt advisory lock. Either lockForCustomer is not ` +
        'taken inside the transaction, or it is keyed on something else.',
    );
  }

  /** The same, for a transaction waiting on a ROW rather than an advisory key. */
  async function awaitRowWaiters(expected: number, what: string): Promise<void> {
    await awaitBlocked(
      sql`SELECT count(*)::int AS n FROM pg_locks
           WHERE NOT granted AND locktype IN ('tuple', 'transactionid')`,
      expected,
      `${what} never blocked on the payment row. Either the read is not FOR UPDATE, or ` +
        'it runs outside the transaction that files the receipt.',
    );
  }

  async function awaitBlocked(query: unknown, expected: number, complaint: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const rows = (await ctx.container.database.db.execute(query as never)) as unknown as {
        rows: { n: number }[];
      };
      if ((rows.rows[0]?.n ?? 0) >= expected) return;
      if (Date.now() > deadline) throw new Error(complaint);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function outcomeOf<T>(
    running: Promise<T>,
  ): Promise<
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
  > {
    return running.then(
      (value) => ({ ok: true, value }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
  }

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  const photo = (uniqueId: string): InboundReceiptFile => ({
    kind: 'PHOTO',
    fileId: `file-${uniqueId}`,
    fileUniqueId: uniqueId,
    mimeType: 'image/jpeg',
    fileSize: 102_400n,
    fileName: null,
    telegramMessageId: 42n,
    caption: null,
  });

  const submit = (paymentId: string, file: InboundReceiptFile, key: string) =>
    ctx.container.receipts.submit(tenantA, systemActor(key), customerA, {
      idempotencyKey: key,
      botInstanceId: botA,
      file,
    });

  const signal = (paymentId: string, key: string) =>
    ctx.container.payments.signalTransferSent(tenantA, systemActor(key), customerA, {
      idempotencyKey: key,
      paymentId: paymentId as PaymentId,
      botInstanceId: botA,
    });

  async function pending(key: string): Promise<{ id: string }> {
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
        display: EMPTY_PRODUCT_DISPLAY,
      } satisfies ProductDraft,
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
    const issued = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor(`${key}-p`),
      customerA,
      { idempotencyKey: `${key}-pay`, orderId: confirmed.id },
    );
    return { id: issued.payment.id };
  }

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

  async function firstBot(tenantId: string): Promise<string> {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT id FROM bot_instances WHERE tenant_id = ${tenantId} ORDER BY created_at ASC LIMIT 1` as never,
    )) as unknown as { rows: { id: string }[] };
    const row = rows.rows[0];
    if (row === undefined) throw new Error(`no bot instance seeded for ${tenantId}`);
    return row.id;
  }

  async function receiptRows(paymentId: string): Promise<
    {
      id: string;
      kind: string;
      bot_instance_id: string;
      customer_id: string;
      file_name: string | null;
      mime_type: string | null;
      file_size: string | null;
    }[]
  > {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT id, kind, bot_instance_id, customer_id, file_name, mime_type, file_size::text AS file_size
            FROM payment_receipts WHERE payment_id = ${paymentId}
           ORDER BY created_at ASC, id ASC` as never,
    )) as unknown as {
      rows: {
        id: string;
        kind: string;
        bot_instance_id: string;
        customer_id: string;
        file_name: string | null;
        mime_type: string | null;
        file_size: string | null;
      }[];
    };
    return rows.rows;
  }

  async function paymentRow(id: string): Promise<{
    state: string;
    evidence_kind: string | null;
    confirmed_at: string | null;
  }> {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT state, evidence_kind, confirmed_at FROM payments WHERE id = ${id}` as never,
    )) as unknown as {
      rows: { state: string; evidence_kind: string | null; confirmed_at: string | null }[];
    };
    const row = rows.rows[0];
    if (row === undefined) throw new Error('payment vanished');
    return row;
  }

  async function captureState(
    paymentId: string,
  ): Promise<{ closed: boolean; reason: string | null }> {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT closed_at, close_reason FROM receipt_captures
           WHERE payment_id = ${paymentId} ORDER BY opened_at DESC LIMIT 1` as never,
    )) as unknown as { rows: { closed_at: string | null; close_reason: string | null }[] };
    const row = rows.rows[0];
    if (row === undefined) throw new Error('no capture window was opened');
    return { closed: row.closed_at !== null, reason: row.close_reason };
  }

  async function auditActions(entityId: string): Promise<string[]> {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT action FROM audit_logs WHERE entity_id = ${entityId}
           ORDER BY occurred_at ASC, id ASC` as never,
    )) as unknown as { rows: { action: string }[] };
    return rows.rows.map((r) => r.action);
  }

  /** Asserts the CODE, walking the `cause` chain Drizzle and Nest both wrap. */
  async function expectRefusal(running: Promise<unknown>, code: string): Promise<void> {
    const error = await running.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error, `expected ${code}, got success`).not.toBeNull();
    let walked: unknown = error;
    for (let depth = 0; depth < 5 && walked !== null && walked !== undefined; depth += 1) {
      if (isNexaError(walked)) {
        expect(walked.code).toBe(code);
        return;
      }
      walked = (walked as { cause?: unknown }).cause;
    }
    throw new Error(`not a NexaError: ${String(error)}`);
  }
});
