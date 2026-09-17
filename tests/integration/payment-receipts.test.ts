import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
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
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { ProductDraft } from '../../apps/api/src/modules/commerce/catalog/application/ports';
import type { InboundReceiptFile } from '../../apps/api/src/modules/commerce/payments/application/receipt-ports';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type TestContext,
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
      },
      'r2-file',
    );

    const rows = await receiptRows(payment.id);
    expect(rows[0]?.kind).toBe('DOCUMENT');
    expect(rows[0]?.file_name).toBe('rasid.pdf');
    expect(rows[0]?.mime_type).toBe('application/pdf');
    expect(rows[0]?.file_size).toBe('4096');
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

    // `sales` holds neither receipt key. `support` would NOT do here: it holds
    // `receipts.view` without `payments.view`, which is the seeded split the Web Admin
    // card draws its own permission from and the reason the card is not gated on the
    // payment read.
    await expectRefusal(
      ctx.container.receipts.listForPayment(tenantA, reader, payment.id as PaymentId),
      'platform.permission_denied',
    );
  });

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
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(250_000n, 'IRT'),
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
