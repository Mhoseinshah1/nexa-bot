import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  money,
  type ActorContext,
  type AdminId,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type PaymentId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { InboundReceiptFile } from '../../apps/api/src/modules/commerce/payments/application/receipt-ports';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * The Telegram receipt review as Payment File 02 §10–§12 asks for it.
 *
 * Against real everything, the way the other panel sections are tested: a real
 * PostgreSQL, the real services and guard, the real bot runtime parsing real updates, and
 * a real socket standing in for Telegram so the assertions are about the BYTES a reviewer
 * would receive.
 *
 *   1. **One message.** The first receipt is sent as a photo whose caption carries the
 *      facts and whose inline keyboard carries the decisions; later receipts follow bare.
 *   2. **Credit to wallet.** A button opens a capture for one administrator and one
 *      payment; that administrator's next plain message is the amount; a confirmation
 *      states it; the confirm credits it once, whatever is tapped twice.
 *   3. **Nobody else's message.** Another administrator's text, a customer's text and a
 *      command never reach the capture, and another administrator's tap does not
 *      confirm it.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

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

interface Button {
  readonly text: string;
  readonly callback_data?: string;
}

describe('the Telegram receipt review, as one message with three decisions', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  let owner: ActorContext;
  let panelA: string;
  let customer: UserId;
  let updateSeq = 0;

  const TG = {
    owner: '740001',
    other: '740002',
    reviewer: '740003',
    customer: '740900',
  } as const;

  beforeAll(async () => {
    sent = [];
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        sent.push({ url: request.url ?? '', body });
        // A file Telegram no longer has: the one case the review falls back to text for.
        if (body['photo'] === 'file-gone') {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: wrong file' }),
          );
          return;
        }
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

    const seededOwner = await createAdmin(ctx.container, tenantA, {
      username: 'owner-tg-receipts',
      roleKeys: ['owner'],
    });
    owner = adminActorFor(seededOwner);
    await bind(seededOwner.id as AdminId, TG.owner);

    panelA = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, panelA);
    customer = await customerNamed(TG.customer, 'zahra_pay');
  });

  // =========================================================================
  // One message
  // =========================================================================

  it('sends the first receipt as ONE photo: the facts as its caption, three decisions on it', async () => {
    const payment = await pendingWithReceipts('one', [
      { fileId: 'file-first', caption: 'از کارت همسرم واریز شد' },
    ]);

    const result = await tap(`C:${payment}`, TG.owner);

    expect(result.replyKey).toBe('bot.admin.receipt');
    expect(result.sent).toBe('DELIVERED');
    expect(sent.map((one) => method(one.url))).toEqual(['sendPhoto', 'answerCallbackQuery']);
    const photo = sent[0]?.body ?? {};
    expect(photo['photo']).toBe('file-first');
    const caption = String(photo['caption']);
    expect(caption).toContain(await referenceOf(payment));
    expect(caption).toContain('250,000');
    expect(caption).toContain(TG.customer);
    expect(caption).toContain('@zahra_pay');
    expect(caption).toContain('پلن پایه');
    expect(caption).toContain('از کارت همسرم واریز شد');
    expect(photo).not.toHaveProperty('parse_mode');
    expect(keyboardOf(photo).map((button) => button.callback_data)).toEqual([
      `D:${payment}`,
      `E:${payment}`,
      `wa:${payment}`,
      // WP10 follow-up §4: the fourth, Block User, for an owner holding `users.block`.
      `xa:${payment}`,
    ]);
  });

  it('sends further receipts as bare files, after the one that carries the decisions', async () => {
    const payment = await pendingWithReceipts('many', [
      { fileId: 'file-a', caption: null },
      { fileId: 'file-b', caption: 'دومی', kind: 'DOCUMENT' },
    ]);

    await tap(`C:${payment}`, TG.owner);

    const files = sent.filter((one) => ['sendPhoto', 'sendDocument'].includes(method(one.url)));
    expect(files).toHaveLength(2);
    expect(files[0]?.body['photo']).toBe('file-a');
    expect(keyboardOf(files[0]?.body ?? {})).toHaveLength(4);
    // The first receipt carried no note; the reviewer's caption carries the one that exists.
    expect(String(files[0]?.body['caption'])).toContain('دومی');
    expect(files[1]?.body).toEqual({ chat_id: TG.owner, document: 'file-b' });
    expect(sent.some((one) => method(one.url) === 'sendMessage')).toBe(false);
  });

  it('renders the customer’s note as text, never as markup or a template token', async () => {
    const payment = await pendingWithReceipts('markup', [
      { fileId: 'file-markup', caption: '<b>تأیید</b> {total} &amp;' },
    ]);

    await tap(`C:${payment}`, TG.owner);

    const photo = sent[0]?.body ?? {};
    expect(String(photo['caption'])).toContain('<b>تأیید</b> {total} &amp;');
    expect(photo).not.toHaveProperty('parse_mode');
  });

  it('falls back to the same caption and buttons as text when Telegram refuses the file', async () => {
    const payment = await pendingWithReceipts('gone', [{ fileId: 'file-gone', caption: null }]);

    const result = await tap(`C:${payment}`, TG.owner);

    expect(result.sent).toBe('DELIVERED');
    expect(sent.map((one) => method(one.url)).slice(0, 2)).toEqual(['sendPhoto', 'sendMessage']);
    const text = sent[1]?.body ?? {};
    expect(String(text['text'])).toContain(await referenceOf(payment));
    expect(keyboardOf(text).map((button) => button.callback_data)).toEqual([
      `D:${payment}`,
      `E:${payment}`,
      `wa:${payment}`,
      // WP10 follow-up §4: the fourth, Block User, for an owner holding `users.block`.
      `xa:${payment}`,
    ]);
  });

  it('draws no credit button for a reviewer without users.wallet.credit, and refuses the crafted tap', async () => {
    await bindNewAdmin('reviewer-only', TG.reviewer, [
      'payments.view',
      'receipts.view',
      'receipts.review',
    ]);
    const payment = await pendingWithReceipts('gated', [{ fileId: 'file-gated', caption: null }]);

    await tap(`C:${payment}`, TG.reviewer);
    expect(keyboardOf(sent[0]?.body ?? {}).map((button) => button.callback_data)).toEqual([
      `D:${payment}`,
      `E:${payment}`,
    ]);

    // The button is advertising, never authority: the crafted callback is refused by the
    // service's guard and opens nothing.
    const crafted = await tap(`wa:${payment}`, TG.reviewer);
    expect(crafted.replyKey).toBe('bot.admin.refused');
    expect(await captureCount()).toBe(0);
  });

  // =========================================================================
  // Credit to wallet
  // =========================================================================

  it('captures an amount typed in Persian, states it, and credits it once on confirm', async () => {
    const payment = await pendingWithReceipts('credit', [{ fileId: 'file-c', caption: null }]);

    const asked = await tap(`wa:${payment}`, TG.owner);
    expect(asked.replyKey).toBe('bot.admin.credit_amount_prompt');
    expect(lastText()).toContain(await referenceOf(payment));

    const stated = await say('۲۰۰٬۰۰۰', TG.owner);
    expect(stated.replyKey).toBe('bot.admin.credit_confirm');
    expect(lastText()).toContain('200,000');
    const [confirm, cancel] = lastKeyboard().map((button) => button.callback_data ?? '');
    expect(confirm).toMatch(/^wb:/);
    expect(cancel).toMatch(/^wc:/);
    expect(Buffer.byteLength(confirm ?? '', 'utf8')).toBeLessThanOrEqual(64);
    // Nothing has moved yet: the amount is stated, not credited.
    expect(await receiptCredits(customer)).toEqual([]);

    const done = await tap(confirm ?? '', TG.owner);
    expect(done.replyKey).toBe('bot.admin.credited');
    expect(lastText()).toContain('200,000');
    expect(await receiptCredits(customer)).toEqual([200_000n]);
    expect(await paymentState(payment)).toBe('FAILED');
    expect(await dispositionOf(payment)).toMatchObject({
      amount: '200000',
      decided_by_admin_id: owner.id,
    });
  });

  it('credits ONCE when the confirm is tapped twice, and says so both times', async () => {
    const payment = await pendingWithReceipts('twice', [{ fileId: 'file-t', caption: null }]);
    await tap(`wa:${payment}`, TG.owner);
    await say('150000', TG.owner);
    const confirm = lastKeyboard()[0]?.callback_data ?? '';

    const first = await tap(confirm, TG.owner);
    const second = await tap(confirm, TG.owner);

    expect(first.replyKey).toBe('bot.admin.credited');
    expect(second.replyKey).toBe('bot.admin.credited');
    expect(await receiptCredits(customer)).toEqual([150_000n]);
  });

  it('credits ONCE when two confirms race', async () => {
    const payment = await pendingWithReceipts('race', [{ fileId: 'file-r', caption: null }]);
    await tap(`wa:${payment}`, TG.owner);
    await say('90000', TG.owner);
    const confirm = lastKeyboard()[0]?.callback_data ?? '';

    const results = await Promise.all([tap(confirm, TG.owner), tap(confirm, TG.owner)]);

    expect(await receiptCredits(customer)).toEqual([90_000n]);
    // One says credited; the other either replays that or is told it is already decided.
    for (const one of results) {
      expect(['bot.admin.credited', 'bot.admin.receipt_gone']).toContain(one.replyKey);
    }
    expect(results.map((one) => one.replyKey)).toContain('bot.admin.credited');
  });

  it('answers an unreadable amount and keeps the capture open for the next one', async () => {
    const payment = await pendingWithReceipts('invalid', [{ fileId: 'file-i', caption: null }]);
    await tap(`wa:${payment}`, TG.owner);

    for (const text of ['دویست هزار', '0', '250000.5', '1,00', '-5']) {
      const answer = await say(text, TG.owner);
      expect(answer.replyKey, text).toBe('bot.admin.credit_amount_invalid');
    }
    expect(await openCaptures()).toBe(1);

    const stated = await say('1,200', TG.owner);
    expect(stated.replyKey).toBe('bot.admin.credit_confirm');
  });

  it('reads ONE amount: a second number after the confirmation is not the capture’s', async () => {
    const payment = await pendingWithReceipts('one-amount', [{ fileId: 'file-o', caption: null }]);
    await tap(`wa:${payment}`, TG.owner);
    await say('100000', TG.owner);
    const confirm = lastKeyboard()[0]?.callback_data ?? '';

    const again = await say('900000', TG.owner);
    expect(again.replyKey).toBe('bot.unknown_command');

    await tap(confirm, TG.owner);
    expect(await receiptCredits(customer)).toEqual([100_000n]);
  });

  it('expires: a late amount and a late confirm are both answered, and nothing moves', async () => {
    const payment = await pendingWithReceipts('expiry', [{ fileId: 'file-e', caption: null }]);
    await tap(`wa:${payment}`, TG.owner);
    await ageCaptures();

    const late = await say('100000', TG.owner);
    expect(late.replyKey).toBe('bot.admin.credit_expired');
    expect(await closeReasons()).toEqual(['EXPIRED']);

    // And a capture that expires AFTER its amount, before the confirm.
    await tap(`wa:${payment}`, TG.owner);
    await say('100000', TG.owner);
    const confirm = lastKeyboard()[0]?.callback_data ?? '';
    await ageCaptures();
    const lateConfirm = await tap(confirm, TG.owner);
    expect(lateConfirm.replyKey).toBe('bot.admin.credit_expired');
    expect(await receiptCredits(customer)).toEqual([]);
    expect(await paymentState(payment)).toBe('PENDING');
  });

  it('is fed by nobody else: another administrator’s message, a customer’s, or a command', async () => {
    await bindNewAdmin('other-owner', TG.other, [
      'payments.view',
      'receipts.view',
      'receipts.review',
      'users.wallet.credit',
    ]);
    const payment = await pendingWithReceipts('others', [{ fileId: 'file-x', caption: null }]);
    await tap(`wa:${payment}`, TG.owner);

    expect((await say('777000', TG.other)).replyKey).toBe('bot.unknown_command');
    expect((await say('777000', TG.customer)).replyKey).toBe('bot.unknown_command');
    // A command while the capture is open is still the command.
    expect((await say('/admin', TG.owner)).replyKey).toBe('bot.admin.panel');

    expect(await openCaptures()).toBe(1);
    const stated = await say('50000', TG.owner);
    expect(stated.replyKey).toBe('bot.admin.credit_confirm');
    expect(lastText()).toContain('50,000');
  });

  it('is not confirmed by another administrator’s tap on its button', async () => {
    await bindNewAdmin('other-confirmer', TG.other, [
      'payments.view',
      'receipts.view',
      'receipts.review',
      'users.wallet.credit',
    ]);
    const payment = await pendingWithReceipts('foreign', [{ fileId: 'file-f', caption: null }]);
    await tap(`wa:${payment}`, TG.owner);
    await say('60000', TG.owner);
    const confirm = lastKeyboard()[0]?.callback_data ?? '';

    const foreign = await tap(confirm, TG.other);

    expect(foreign.replyKey).toBe('bot.admin.receipt_gone');
    expect(await receiptCredits(customer)).toEqual([]);
    expect(await openCaptures()).toBe(1);
  });

  it('cancels: nothing moves, and the old confirm button then credits nothing', async () => {
    const payment = await pendingWithReceipts('cancel', [{ fileId: 'file-k', caption: null }]);
    await tap(`wa:${payment}`, TG.owner);
    await say('70000', TG.owner);
    const [confirm, cancel] = lastKeyboard().map((button) => button.callback_data ?? '');

    expect((await tap(cancel ?? '', TG.owner)).replyKey).toBe('bot.admin.credit_cancelled');
    expect((await tap(confirm ?? '', TG.owner)).replyKey).toBe('bot.admin.credit_cancelled');
    expect(await receiptCredits(customer)).toEqual([]);
    expect(await paymentState(payment)).toBe('PENDING');
  });

  /**
   * Holds the capture repository's `close` for one reason, inside its transaction, until
   * released — so a race is an interleaving the test chooses, not a scheduler's accident.
   */
  function holdClose(reason: 'CANCELLED' | 'CONFIRMED') {
    const repository = (
      ctx.container.receiptCreditCaptures as unknown as {
        deps: { captures: { close: (...args: unknown[]) => Promise<boolean> } };
      }
    ).deps.captures;
    const original = repository.close.bind(repository);
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let held = false;
    vi.spyOn(repository, 'close').mockImplementation(async (...args: unknown[]) => {
      const result = await original(...args);
      if (!held && args[2] === reason) {
        held = true;
        entered();
        await gate;
      }
      return result;
    });
    return { inside, release: open };
  }

  /** Waits until some other session is seen blocked on a lock. */
  async function awaitAnyLockWait(): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const waiting = await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND datname = current_database()`,
      );
      if (((waiting.rows[0] as { n: number } | undefined)?.n ?? 0) > 0) return;
      if (Date.now() > deadline) throw new Error('nothing was seen waiting on a lock');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function captureWithAmount(key: string, amount: string): Promise<string> {
    const payment = await pendingWithReceipts(key, [{ fileId: `file-${key}`, caption: null }]);
    await tap(`wa:${payment}`, TG.owner);
    await say(amount, TG.owner);
    const confirm = lastKeyboard()[0]?.callback_data ?? '';
    return confirm.slice('wb:'.length);
  }

  it('a cancel that closes first wins a racing confirm: nothing is credited (Codex, PR #70)', async () => {
    const captureId = await captureWithAmount('race-cc', '60000');
    const held = holdClose('CANCELLED');

    const cancelling = ctx.container.receiptCreditCaptures.cancel(tenantA, owner, {
      idempotencyKey: 'race-cc-cancel',
      captureId,
    });
    cancelling.catch(() => undefined);
    await held.inside;
    const confirming = ctx.container.receiptCreditCaptures.confirm(tenantA, owner, { captureId });
    confirming.catch(() => undefined);
    // The confirm waits for the cancel's admin lock rather than reading past it.
    await awaitAnyLockWait();
    held.release();

    await expect(cancelling).resolves.toEqual({ outcome: 'CANCELLED' });
    await expect(confirming).resolves.toMatchObject({ outcome: 'CLOSED', reason: 'CANCELLED' });
    expect(await receiptCredits(customer)).toEqual([]);
    vi.restoreAllMocks();
  }, 30_000);

  it('a confirm that closes first wins a racing cancel, and the cancel says so (Codex, PR #70)', async () => {
    const captureId = await captureWithAmount('race-cf', '65000');
    const held = holdClose('CONFIRMED');

    const confirming = ctx.container.receiptCreditCaptures.confirm(tenantA, owner, { captureId });
    confirming.catch(() => undefined);
    await held.inside;
    const cancelling = ctx.container.receiptCreditCaptures.cancel(tenantA, owner, {
      idempotencyKey: 'race-cf-cancel',
      captureId,
    });
    cancelling.catch(() => undefined);
    await awaitAnyLockWait();
    held.release();

    await expect(confirming).resolves.toMatchObject({ outcome: 'CREDITED' });
    // Not "cancelled": money moved, and the reviewer must not be told it did not.
    await expect(cancelling).resolves.toEqual({ outcome: 'CONFIRMED' });
    expect(await receiptCredits(customer)).toEqual([65_000n]);
    vi.restoreAllMocks();
  }, 30_000);

  it('tells the reviewer the payment was decided when an approval won first', async () => {
    const payment = await pendingWithReceipts('lost', [{ fileId: 'file-l', caption: null }]);
    await tap(`wa:${payment}`, TG.owner);
    await say('80000', TG.owner);
    const confirm = lastKeyboard()[0]?.callback_data ?? '';

    await ctx.container.payments.confirmManualTransfer(tenantA, owner, payment, {
      idempotencyKey: 'web-approve-first',
      note: 'approved elsewhere',
    });

    const late = await tap(confirm, TG.owner);
    expect(late.replyKey).toBe('bot.admin.receipt_gone');
    expect(await receiptCredits(customer)).toEqual([]);
    expect(await paymentState(payment)).toBe('CONFIRMED');
  });

  it('answers a withdrawal of the receipted transfer with the sentence about the payment', async () => {
    const payment = await pendingWithReceipts('withdraw', [{ fileId: 'file-w', caption: null }]);

    const refused = await tap(`z:${payment}`, TG.customer);

    expect(refused.replyKey).toBe('bot.payment.withdraw_under_review');
    expect(await paymentState(payment)).toBe('PENDING');
  });

  // =========================================================================
  // Helpers
  // =========================================================================

  const runtime = () => ctx.container.botRuntime;
  const method = (url: string) => url.split('/').pop() ?? '';
  const replies = () =>
    sent.filter((one) => ['sendMessage', 'sendPhoto', 'sendDocument'].includes(method(one.url)));
  const lastReply = () => replies()[replies().length - 1]?.body ?? {};
  const lastText = () => String(lastReply()['text'] ?? lastReply()['caption'] ?? '');
  const lastKeyboard = () => keyboardOf(lastReply());

  function keyboardOf(body: Record<string, unknown>): Button[] {
    const markup = body['reply_markup'] as { inline_keyboard?: Button[][] } | undefined;
    return (markup?.inline_keyboard ?? []).flat();
  }

  const tap = async (data: string, telegramUserId: string) => {
    sent = [];
    return runtime().handle(tenantA, systemActor('bot'), tapUpdate(data, telegramUserId));
  };
  const say = async (message: string, telegramUserId: string) => {
    sent = [];
    return runtime().handle(tenantA, systemActor('bot'), textUpdate(message, telegramUserId));
  };

  async function receiptCredits(customerId: UserId): Promise<bigint[]> {
    const rows = await ctx.container.database.db.execute<{ amount: string }>(sql`
      SELECT amount::text AS amount FROM wallet_entries
       WHERE customer_id = ${customerId} AND reason = 'RECEIPT_CREDIT' ORDER BY created_at`);
    return rows.rows.map((row) => BigInt(row.amount));
  }

  async function dispositionOf(paymentId: string): Promise<Record<string, unknown> | undefined> {
    const rows = await ctx.container.database.db.execute(sql`
      SELECT amount::text AS amount, decided_by_admin_id FROM receipt_credits
       WHERE payment_id = ${paymentId}`);
    return rows.rows[0] as Record<string, unknown> | undefined;
  }

  async function paymentState(paymentId: string): Promise<string> {
    const rows = await ctx.container.database.db.execute<{ state: string }>(
      sql`SELECT state FROM payments WHERE id = ${paymentId}`,
    );
    return rows.rows[0]?.state ?? 'MISSING';
  }

  async function referenceOf(paymentId: string): Promise<string> {
    const rows = await ctx.container.database.db.execute<{ reference: string }>(
      sql`SELECT reference FROM payments WHERE id = ${paymentId}`,
    );
    return rows.rows[0]?.reference ?? 'MISSING';
  }

  async function captureCount(): Promise<number> {
    const rows = await ctx.container.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM admin_amount_captures`,
    );
    return Number(rows.rows[0]?.n ?? 0);
  }

  async function openCaptures(): Promise<number> {
    const rows = await ctx.container.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM admin_amount_captures WHERE closed_at IS NULL`,
    );
    return Number(rows.rows[0]?.n ?? 0);
  }

  async function closeReasons(): Promise<string[]> {
    const rows = await ctx.container.database.db.execute<{ close_reason: string }>(
      sql`SELECT close_reason FROM admin_amount_captures
           WHERE closed_at IS NOT NULL ORDER BY opened_at`,
    );
    return rows.rows.map((row) => row.close_reason);
  }

  /** Moves every open capture's window into the past, keeping `expires_at > opened_at`. */
  async function ageCaptures(): Promise<void> {
    await ctx.container.database.db.execute(sql`
      UPDATE admin_amount_captures
         SET opened_at = opened_at - interval '1 hour',
             expires_at = expires_at - interval '1 hour'
       WHERE closed_at IS NULL`);
  }

  const bind = (adminId: AdminId, telegramUserId: string) =>
    ctx.container.adminManagement.setTelegramBinding(tenantA, owner, adminId, {
      telegramUserId,
      reason: 'test binding',
    });

  async function bindNewAdmin(
    username: string,
    telegramUserId: string,
    permissions: readonly string[],
  ): Promise<AdminId> {
    const admin = await createAdmin(ctx.container, tenantA, { username });
    const roleId = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO roles (id, tenant_id, key, name, is_system)
      VALUES (${roleId}, ${tenantA.tenantId}, ${`custom_${username.replaceAll('-', '_')}`}, ${username}, false)`);
    for (const permission of permissions) {
      await ctx.container.database.db.execute(sql`
        INSERT INTO role_permissions (tenant_id, role_id, permission_key)
        VALUES (${tenantA.tenantId}, ${roleId}, ${permission})`);
    }
    await ctx.container.database.db.execute(sql`
      INSERT INTO admin_roles (tenant_id, admin_id, role_id)
      VALUES (${tenantA.tenantId}, ${admin.id}, ${roleId})`);
    await bind(admin.id as AdminId, telegramUserId);
    return admin.id as AdminId;
  }

  async function customerNamed(telegramUserId: string, username: string): Promise<UserId> {
    const { customer: resolved } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'زهرا', username },
        botInstanceId: BOT_A,
      },
    );
    return resolved.id;
  }

  /** A pending manual transfer for the customer, with these receipts filed against it. */
  async function pendingWithReceipts(
    key: string,
    receipts: readonly {
      fileId: string;
      caption: string | null;
      kind?: 'PHOTO' | 'DOCUMENT';
    }[],
  ): Promise<PaymentId> {
    const products = new DrizzleProductRepository(ctx.container.database.db);
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelA as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 1n, deviceLimit: null },
        price: money(250_000n, 'IRT'),
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const order = await ctx.container.orders.createDraft(tenantA, systemActor(`${key}-d`), {
      idempotencyKey: `${key}-draft`,
      customerId: customer,
      productId: created.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(`${key}-c`), {
      idempotencyKey: `${key}-confirm`,
      customerId: customer,
      orderId: order.id,
    });
    const issued = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor(`${key}-p`),
      customer,
      { idempotencyKey: `${key}-pay`, orderId: confirmed.id },
    );
    const paymentId = issued.payment.id as PaymentId;
    await ctx.container.payments.signalTransferSent(tenantA, systemActor(`${key}-s`), customer, {
      idempotencyKey: `${key}-signal`,
      paymentId,
      botInstanceId: BOT_A,
    });
    let index = 0;
    for (const receipt of receipts) {
      index += 1;
      const file: InboundReceiptFile = {
        kind: receipt.kind ?? 'PHOTO',
        fileId: receipt.fileId,
        fileUniqueId: `unique-${receipt.fileId}`,
        mimeType: receipt.kind === 'DOCUMENT' ? 'application/pdf' : 'image/jpeg',
        fileSize: 102_400n,
        fileName: null,
        telegramMessageId: BigInt(40 + index),
        caption: receipt.caption,
      };
      await ctx.container.receipts.submit(tenantA, systemActor(`${key}-f${index}`), customer, {
        idempotencyKey: `${key}-file-${String(index)}`,
        botInstanceId: BOT_A,
        file,
      });
    }
    return paymentId;
  }

  const baseUpdate = (payload: Record<string, unknown>, telegramUserId: string) => {
    updateSeq += 1;
    return {
      idempotencyKey: `bot-update-receipts-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      update: { update_id: updateSeq, ...payload },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'کاربر' },
    };
  };

  const textUpdate = (message: string, telegramUserId: string) =>
    baseUpdate(
      {
        message: {
          message_id: updateSeq,
          date: 0,
          chat: { id: Number(telegramUserId), type: 'private' },
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'کاربر' },
          text: message,
        },
      },
      telegramUserId,
    );

  const tapUpdate = (data: string, telegramUserId: string) =>
    baseUpdate(
      {
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'کاربر' },
          data,
          message: {
            message_id: 1,
            date: 0,
            chat: { id: Number(telegramUserId), type: 'private' },
          },
        },
      },
      telegramUserId,
    );
});
