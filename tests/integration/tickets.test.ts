import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE_NAME,
  TICKET_ATTACHMENT_MAX_BYTES,
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
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
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
}

/** How the stand-in answers the next customer sends: normally, refused, rate-limited or 5xx. */
type Mode = 'OK' | 'REFUSE' | 'RATE_LIMIT' | 'SERVER_ERROR';

describe('WP-A7 — support tickets', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  let mode: Mode = 'OK';
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
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = { unparseable: raw };
        }
        sent.push({ url, body });
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
        if (url.endsWith('/sendMessage') && mode !== 'OK') {
          if (mode === 'REFUSE') {
            response.writeHead(400, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request' }),
            );
          } else if (mode === 'RATE_LIMIT') {
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
});
