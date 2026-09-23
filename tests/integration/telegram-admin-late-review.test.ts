import { createServer, type Server } from 'node:http';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorContext, AdminId, BotInstanceId, CorrelationId, UserId } from '@nexa/contracts';
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
 * The late-review lane in the Telegram management panel — WP10 P1.
 *
 * Against real everything, the way the other admin sections are tested: a real
 * PostgreSQL, the real `LateTransferService` and `PaymentService` with their real guard,
 * a real socket standing in for Telegram, and the real runtime parsing real callback
 * data. `docs/wp10-payments-audit.md` P1 is the design; `late-transfers.test.ts` holds the
 * service's own rules. What this file defends is the SURFACE:
 *
 *   1. **Who is offered what.** The lane's door for `payments.view`, the two decisions for
 *      `receipts.review` — and every case asserting a control is absent is paired with
 *      one that sends the callback anyway, because the button is never the authority.
 *   2. **The lane is the server's.** The list is `lateReview` on the ordinary payment
 *      list, so a pending transfer and an expired one nobody vouched for are not in it.
 *   3. **A decision goes through the service, once.** A credit moves the payment's exact
 *      amount; a dismissal carries the tapped reason and moves nothing; a second tap is
 *      told the payment was already decided.
 *   4. **Refusals are sentences.** Not eligible, already decided, unknown or another
 *      tenant's, and a permission denial each map to a template key.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

/** Every callback prefix the lane owns, spelled out rather than imported. */
const PREFIX = {
  lane: 'la:',
  view: 'lb:v:',
  credit: 'lb:c:',
  ask: 'lb:d:',
  /** `lc:<reason code>:<uuid>`. */
  dismiss: 'lc:',
} as const;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

describe('the late-review lane in the Telegram management panel', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  let owner: ActorContext;
  let customerA: UserId;
  let updateSeq = 0;
  let sequence = 0;
  const key = (): string => `tg-late-${String((sequence += 1)).padStart(4, '0')}`;

  const TG = {
    /** `receipt_reviewer`: payments.view, receipts.view and receipts.review. */
    reviewer: '730001',
    /** A custom role, built per case. */
    limited: '730002',
    /** An ordinary customer. No administrator row anywhere. */
    customer: '930930',
  } as const;

  beforeAll(async () => {
    sent = [];
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = { unparseable: raw };
        }
        sent.push({ url: request.url ?? '', body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');

    ctx = await createTestContext({
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    sent = [];
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-tg-late', roleKeys: ['owner'] }),
    );
    customerA = await makeCustomer('940940');
    await bindNewAdmin('reviewer-tg-late', TG.reviewer, { roleKeys: ['receipt_reviewer'] });
  });

  // =========================================================================
  // Who is offered what
  // =========================================================================

  it('draws the lane’s door in the receipts section for payments.view, empty queue or not', async () => {
    const result = await open('B:', TG.reviewer);
    expect(result.replyKey).toBe('bot.admin.receipts_none');
    expect(lastMessage(), 'the lane’s door was not drawn').toContain(`"${PREFIX.lane}"`);
  });

  it('draws no door for a receipts reader without payments.view, and the lane refuses them', async () => {
    await bindNewAdmin('receipts-only-late', TG.limited, { permissions: ['receipts.view'] });

    const section = await open('B:', TG.limited);
    expect(section.replyKey).toBe('bot.admin.receipts_none');
    expect(lastMessage(), 'a lane they cannot list was offered').not.toContain(`"${PREFIX.lane}"`);

    /* And sent anyway: `PaymentService.list` charges payments.view, not this surface. */
    const crafted = await open(PREFIX.lane, TG.limited);
    expect(crafted.replyKey).toBe('bot.admin.refused');
  });

  it('answers an ordinary customer who sends any lane callback as unknown input', async () => {
    const { payment } = await expiredTransfer({ signal: true });
    for (const data of [
      PREFIX.lane,
      `${PREFIX.view}${payment}`,
      `${PREFIX.credit}${payment}`,
      `${PREFIX.ask}${payment}`,
      `${PREFIX.dismiss}n:${payment}`,
    ]) {
      const result = await open(data, TG.customer);
      expect(result.replyKey, `${data} answered an administrator's reply`).toBe(
        'bot.unknown_command',
      );
    }
    expect(await lateEntries(payment)).toHaveLength(0);
    expect(await decisionCount(payment)).toBe(0);
  });

  // =========================================================================
  // The lane is the server's
  // =========================================================================

  it('lists the vouched-for expired transfers and nothing else', async () => {
    const signalled = await expiredTransfer({ signal: true });
    const receiptOnly = await expiredTransfer({ receipt: true });
    const lapsed = await expiredTransfer({});
    const pending = await pendingTransfer({ signal: true });

    const result = await open(PREFIX.lane, TG.reviewer);

    expect(result.replyKey).toBe('bot.admin.late_review_list');
    const message = lastMessage();
    expect(message).toContain(`${PREFIX.view}${signalled.payment}`);
    expect(message, 'a receipt alone is vouching').toContain(
      `${PREFIX.view}${receiptOnly.payment}`,
    );
    expect(message, 'an unvouched expiry was listed').not.toContain(lapsed.payment);
    expect(message, 'a pending transfer was listed').not.toContain(pending.payment);
  });

  it('says the lane is empty when nobody vouched for anything', async () => {
    await expiredTransfer({});
    const result = await open(PREFIX.lane, TG.reviewer);
    expect(result.replyKey).toBe('bot.admin.late_review_none');
  });

  // =========================================================================
  // One item
  // =========================================================================

  it('shows an item with its amount and receipts, and both decisions for a reviewer', async () => {
    const { payment, reference } = await expiredTransfer({ receipt: true });

    const result = await open(`${PREFIX.view}${payment}`, TG.reviewer);

    expect(result.replyKey).toBe('bot.admin.late_review_item');
    const message = lastMessage();
    expect(message).toContain(reference);
    expect(message).toContain(`${PREFIX.credit}${payment}`);
    expect(message).toContain(`${PREFIX.ask}${payment}`);
    // The receipt went as media, by the file id the row carries.
    const media = sent.filter((one) => one.url.includes('/sendPhoto'));
    expect(media, 'the receipt was not sent').toHaveLength(1);
    expect(media[0]?.body['photo']).toBe('fixture-file-id');
  });

  it('draws no decision for a reader without receipts.review, and refuses one sent anyway', async () => {
    await bindNewAdmin('late-reader', TG.limited, {
      permissions: ['payments.view', 'receipts.view'],
    });
    const { payment } = await expiredTransfer({ signal: true });

    const item = await open(`${PREFIX.view}${payment}`, TG.limited);
    expect(item.replyKey).toBe('bot.admin.late_review_item');
    expect(lastMessage()).not.toContain(`${PREFIX.credit}${payment}`);
    expect(lastMessage()).not.toContain(`${PREFIX.ask}${payment}`);

    /* The reasons screen is the decision's, and is refused without the key. */
    expect((await open(`${PREFIX.ask}${payment}`, TG.limited)).replyKey).toBe('bot.admin.refused');

    /* Both writes sent anyway: the SERVICE refuses, records the denial, and moves nothing. */
    expect((await open(`${PREFIX.credit}${payment}`, TG.limited)).replyKey).toBe(
      'bot.admin.refused',
    );
    expect((await open(`${PREFIX.dismiss}n:${payment}`, TG.limited)).replyKey).toBe(
      'bot.admin.refused',
    );
    expect(await lateEntries(payment)).toHaveLength(0);
    expect(await decisionCount(payment)).toBe(0);
    expect(await deniedAudits('payment.late_credit')).toBe(1);
    expect(await deniedAudits('payment.late_dismiss')).toBe(1);
  });

  it('answers an item that is not in the lane, and one another tenant owns, as gone', async () => {
    const lapsed = await expiredTransfer({});
    expect((await open(`${PREFIX.view}${lapsed.payment}`, TG.reviewer)).replyKey).toBe(
      'bot.admin.late_review_gone',
    );

    const theirs = await foreignPayment();
    expect((await open(`${PREFIX.view}${theirs}`, TG.reviewer)).replyKey).toBe(
      'bot.admin.late_review_gone',
    );
    expect((await open(`${PREFIX.credit}${theirs}`, TG.reviewer)).replyKey).toBe(
      'bot.admin.late_review_gone',
    );
    expect(await lateEntries(theirs)).toHaveLength(0);
  });

  // =========================================================================
  // The decisions
  // =========================================================================

  it('credits the payment’s exact amount once, and leaves the payment expired', async () => {
    const { payment } = await expiredTransfer({ signal: true });

    const result = await open(`${PREFIX.credit}${payment}`, TG.reviewer);

    expect(result.replyKey).toBe('bot.admin.late_credited');
    const entries = await lateEntries(payment);
    expect(entries).toEqual([
      { direction: 'CREDIT', amount: '75000', reference: `${payment}:late` },
    ]);
    expect(await paymentState(payment)).toBe('EXPIRED');
    expect(await decisionOf(payment)).toEqual({ decision: 'CREDITED', reason: null });
  });

  it('answers a second tap with already-decided and credits nothing more', async () => {
    const { payment } = await expiredTransfer({ signal: true });
    await open(`${PREFIX.credit}${payment}`, TG.reviewer);

    /* A different update — a second tap, not a redelivery. */
    expect((await open(`${PREFIX.credit}${payment}`, TG.reviewer)).replyKey).toBe(
      'bot.admin.late_already_decided',
    );
    expect((await open(`${PREFIX.dismiss}n:${payment}`, TG.reviewer)).replyKey).toBe(
      'bot.admin.late_already_decided',
    );
    /* And the item, reopened from an old message, says so instead of offering buttons. */
    expect((await open(`${PREFIX.view}${payment}`, TG.reviewer)).replyKey).toBe(
      'bot.admin.late_already_decided',
    );
    expect(await lateEntries(payment)).toHaveLength(1);
  });

  it('replays a redelivered credit tap from the store instead of refusing it', async () => {
    const { payment } = await expiredTransfer({ signal: true });
    const update = tapUpdate(`${PREFIX.credit}${payment}`, TG.reviewer);

    const first = await runtime().handle(tenantA, systemActor('bot'), update);
    const again = await runtime().handle(tenantA, systemActor('bot'), update);

    expect(first.replyKey).toBe('bot.admin.late_credited');
    expect(again.replyKey).not.toBe('bot.admin.late_already_decided');
    expect(await lateEntries(payment)).toHaveLength(1);
  });

  it('offers the six reasons a tap can carry, and not OTHER', async () => {
    const { payment } = await expiredTransfer({ signal: true });

    const result = await open(`${PREFIX.ask}${payment}`, TG.reviewer);

    expect(result.replyKey).toBe('bot.admin.late_dismiss_reasons');
    const message = lastMessage();
    for (const code of ['n', 'u', 'o', 'w', 'r', 'e']) {
      expect(message, `reason ${code} is missing`).toContain(`${PREFIX.dismiss}${code}:${payment}`);
    }
    expect(message).not.toContain(`${PREFIX.dismiss}x:`);
    /* Asking moved nothing. */
    expect(await decisionCount(payment)).toBe(0);
  });

  it('dismisses with the tapped reason and no note, and moves nothing', async () => {
    const { payment } = await expiredTransfer({ receipt: true });

    const result = await open(`${PREFIX.dismiss}u:${payment}`, TG.reviewer);

    expect(result.replyKey).toBe('bot.admin.late_dismissed');
    expect(await decisionOf(payment)).toEqual({
      decision: 'DISMISSED',
      reason: 'AMOUNT_UNDERPAID',
    });
    expect(
      await rows(sql`SELECT note FROM late_transfer_decisions WHERE payment_id = ${payment}`),
    ).toEqual([{ note: null }]);
    expect(await lateEntries(payment)).toHaveLength(0);
    expect(await paymentState(payment)).toBe('EXPIRED');
  });

  it('answers a decision on a payment nobody vouched for as not eligible', async () => {
    const lapsed = await expiredTransfer({});
    expect((await open(`${PREFIX.credit}${lapsed.payment}`, TG.reviewer)).replyKey).toBe(
      'bot.admin.late_not_eligible',
    );
    const pending = await pendingTransfer({ signal: true });
    expect((await open(`${PREFIX.dismiss}n:${pending.payment}`, TG.reviewer)).replyKey).toBe(
      'bot.admin.late_not_eligible',
    );
    expect(await decisionCount(lapsed.payment)).toBe(0);
    expect(await decisionCount(pending.payment)).toBe(0);
  });

  it('writes an audit row naming the administrator who credited, from Telegram', async () => {
    const { payment } = await expiredTransfer({ signal: true });
    await open(`${PREFIX.credit}${payment}`, TG.reviewer);

    const [row] = await rows<Record<string, unknown>>(sql`
      SELECT actor_type, source_surface, result FROM audit_logs
       WHERE tenant_id = ${tenantA.tenantId} AND entity_id = ${payment}
         AND action = 'payment.late_credit'`);
    expect(row).toEqual({
      actor_type: 'TELEGRAM_ADMIN',
      source_surface: 'TELEGRAM',
      result: 'SUCCESS',
    });
  });

  // =========================================================================
  // Helpers
  // =========================================================================

  const runtime = () => ctx.container.botRuntime;
  const messages = () => sent.filter((one) => one.url.includes('/sendMessage'));
  const lastMessage = () => JSON.stringify(messages()[messages().length - 1] ?? {});

  /** One tap, with the outbound record cleared first so `lastMessage` is this turn's. */
  const open = async (data: string, telegramUserId: string) => {
    sent = [];
    return runtime().handle(tenantA, systemActor('bot'), tapUpdate(data, telegramUserId));
  };

  async function rows<T>(query: SQL): Promise<T[]> {
    const result = (await ctx.container.database.db.execute(query)) as unknown as { rows: T[] };
    return result.rows;
  }

  const lateEntries = (paymentId: string) =>
    rows<Record<string, unknown>>(sql`
      SELECT direction, amount::text AS amount, reference FROM wallet_entries
       WHERE reason = 'LATE_TRANSFER' AND payment_id = ${paymentId}`);

  const decisionCount = async (paymentId: string) =>
    (
      await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM late_transfer_decisions WHERE payment_id = ${paymentId}`,
      )
    )[0]?.n ?? 0;

  const decisionOf = async (paymentId: string) =>
    (
      await rows<Record<string, unknown>>(
        sql`SELECT decision, reason FROM late_transfer_decisions WHERE payment_id = ${paymentId}`,
      )
    )[0];

  const paymentState = async (paymentId: string) =>
    (await rows<{ state: string }>(sql`SELECT state FROM payments WHERE id = ${paymentId}`))[0]
      ?.state;

  const deniedAudits = async (action: string) =>
    (
      await rows<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM audit_logs
         WHERE tenant_id = ${tenantA.tenantId} AND action = ${action} AND result = 'DENIED'`)
    )[0]?.n ?? 0;

  /**
   * A manual TOP-UP transfer of 75,000 IRT, written as the rows one leaves — the shape
   * `late-transfers.test.ts` uses, because the lane asks only that it be a manual
   * transfer somebody vouched for, and a top-up needs no product, panel or order.
   * Its deadline is already past; `expiredTransfer` runs the real sweep over it.
   */
  async function pendingTransfer(vouch: { signal?: boolean; receipt?: boolean }) {
    const id = ctx.container.ids.uuid();
    const reference = `LATE-${id.slice(-12)}`;
    await ctx.container.database.db.execute(sql`
      INSERT INTO payments (id, tenant_id, customer_id, order_id, method, amount, currency,
                            reference, expires_at, created_at, updated_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customerA}, NULL, 'MANUAL_TRANSFER', 75000, 'IRT',
              ${reference}, now() - interval '1 hour', now(), now())`);
    if (vouch.signal === true) {
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET customer_signalled_at = now() WHERE id = ${id}`,
      );
    }
    if (vouch.receipt === true) {
      await ctx.container.database.db.execute(sql`
        INSERT INTO payment_receipts (id, tenant_id, bot_instance_id, customer_id, payment_id,
                                      kind, file_id, file_unique_id)
        VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${BOT_A}, ${customerA},
                ${id}, 'PHOTO', 'fixture-file-id', ${`fixture-${id.slice(-12)}`})`);
    }
    return { payment: id, reference };
  }

  /** The same, swept to EXPIRED by the REAL expiry sweep, as production expires it. */
  async function expiredTransfer(vouch: { signal?: boolean; receipt?: boolean }) {
    const made = await pendingTransfer(vouch);
    await ctx.container.paymentExpirySweep.runOnce(tenantA);
    expect(await paymentState(made.payment)).toBe('EXPIRED');
    return made;
  }

  /** An expired, signalled transfer in tenant B, for the isolation cases. */
  async function foreignPayment(): Promise<string> {
    const { customer } = await ctx.container.customers.resolveFromUpdate(
      tenantB,
      systemActor('resolve-b'),
      {
        idempotencyKey: 'resolve-late-b',
        telegramUserId: '950950',
        from: { id: 950950, first_name: 'کاربر' },
        botInstanceId: SEED_IDS.botB1 as BotInstanceId,
      },
    );
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO payments (id, tenant_id, customer_id, order_id, method, amount, currency,
                            reference, expires_at, created_at, updated_at, customer_signalled_at)
      VALUES (${id}, ${tenantB.tenantId}, ${customer.id}, NULL, 'MANUAL_TRANSFER', 75000, 'IRT',
              ${`LATE-B-${id.slice(-8)}`}, now() - interval '1 hour', now(), now(), now())`);
    await ctx.container.paymentExpirySweep.runOnce(tenantB);
    return id;
  }

  async function makeCustomer(telegramUserId: string): Promise<UserId> {
    const { customer } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'کاربر' },
        botInstanceId: BOT_A,
      },
    );
    return customer.id;
  }

  const bind = (adminId: AdminId, telegramUserId: string) =>
    ctx.container.adminManagement.setTelegramBinding(tenantA, owner, adminId, {
      telegramUserId,
      reason: 'test binding',
    });

  /** An administrator with a seeded role or a hand-made one, bound to a chat. */
  async function bindNewAdmin(
    username: string,
    telegramUserId: string,
    grant: { roleKeys?: string[]; permissions?: string[] },
  ): Promise<AdminId> {
    const admin = await createAdmin(ctx.container, tenantA, {
      username,
      ...(grant.roleKeys === undefined ? {} : { roleKeys: grant.roleKeys }),
    });
    if (grant.permissions !== undefined) {
      const roleId = ctx.container.ids.uuid();
      await ctx.container.database.db.execute(sql`
        INSERT INTO roles (id, tenant_id, key, name, is_system)
        VALUES (${roleId}, ${tenantA.tenantId}, ${`custom_${username.replaceAll('-', '_')}`}, ${username}, false)`);
      for (const permission of grant.permissions) {
        await ctx.container.database.db.execute(sql`
          INSERT INTO role_permissions (tenant_id, role_id, permission_key)
          VALUES (${tenantA.tenantId}, ${roleId}, ${permission})`);
      }
      await ctx.container.database.db.execute(sql`
        INSERT INTO admin_roles (tenant_id, admin_id, role_id)
        VALUES (${tenantA.tenantId}, ${admin.id}, ${roleId})`);
    }
    await bind(admin.id as AdminId, telegramUserId);
    return admin.id as AdminId;
  }

  const tapUpdate = (data: string, telegramUserId: string) => {
    updateSeq += 1;
    return {
      idempotencyKey: `bot-update-late-${String(updateSeq)}-${key()}`,
      botInstanceId: BOT_A,
      update: {
        update_id: updateSeq,
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'کاربر' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: Number(telegramUserId), type: 'private' },
            from: { id: 999_999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'کاربر' },
    };
  };
});
