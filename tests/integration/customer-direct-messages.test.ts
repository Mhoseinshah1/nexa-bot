import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  DIRECT_MESSAGE_MAX_PER_ADMIN,
  DIRECT_MESSAGE_MAX_PER_CUSTOMER,
  DIRECT_MESSAGE_ROUTES,
  ROLE_SEEDS,
  SESSION_COOKIE_NAME,
  isNexaError,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type DirectMessageFile,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { toItem } from '../../apps/api/src/surfaces/web/customer-direct-messages.controller';
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
 * Phase A2 — «ارسال پیام» from Customer 360, end to end against a real PostgreSQL: the real
 * service and repository, the real customer notification lane (its dispatcher, messenger
 * and `telegramSend`) against a socket standing in for Telegram, and the HTTP route.
 *
 * Each rule the program names is a case: text, photo and document; permission denial;
 * a blocked, bot-less, unknown or foreign target; Telegram's refusal, rate limit and
 * unknown outcome (never re-sent); a double click, a retried request and a concurrent
 * duplicate (one message); the rate limit, under concurrency; tenant isolation; the audit
 * record without the text; and the staleness rule.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_A2 = SEED_IDS.botA2 as BotInstanceId; // seeded STOPPED
const BOT_B = SEED_IDS.botB1 as BotInstanceId;
const CUSTOMER_TG = '961001';

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
  readonly raw: Buffer;
}
type Mode = 'OK' | 'REFUSE' | 'RATE_LIMIT' | 'SERVER_ERROR';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
const PDF = Buffer.from('%PDF-1.7\nthe invoice\n');
const png = (): DirectMessageFile => ({
  fileName: 'screenshot.png',
  mimeType: 'image/png',
  contentBase64: PNG.toString('base64'),
});
const pdf = (): DirectMessageFile => ({
  fileName: 'invoice.pdf',
  mimeType: 'application/pdf',
  contentBase64: PDF.toString('base64'),
});

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isNexaError(error)) return { kind: error.kind, code: error.code, details: error.details };
    throw error;
  }
  throw new Error('Expected a refusal.');
}

describe('Phase A2 — direct message from Customer 360', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  let mode: Mode = 'OK';
  let owner: SeededAdmin;
  let customer: UserId;
  let keySeq = 0;

  beforeAll(async () => {
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const url = request.url ?? '';
        const raw = Buffer.concat(chunks);
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          body = { unparseable: true };
        }
        sent.push({ url, body, raw });
        if (mode === 'REFUSE') {
          response.writeHead(403, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              ok: false,
              error_code: 403,
              description: 'Forbidden: bot was blocked by the user',
            }),
          );
          return;
        }
        if (mode === 'RATE_LIMIT') {
          response.writeHead(429, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 1 } }),
          );
          return;
        }
        if (mode === 'SERVER_ERROR') {
          response.writeHead(502, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: false, error_code: 502 }));
          return;
        }
        const file = { file_id: 'tg-file-1', file_unique_id: 'tg-unique-1' };
        const result = url.endsWith('/sendPhoto')
          ? { message_id: 21, photo: [{ file_id: 'thumb', file_unique_id: 'u-thumb' }, file] }
          : url.endsWith('/sendDocument')
            ? { message_id: 22, document: file }
            : { message_id: 20 };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result }));
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
      username: 'owner-dm',
      roleKeys: ['owner'],
    });
    customer = await resolve(CUSTOMER_TG);
  });

  async function resolve(
    telegramUserId: string,
    scope: TenantContext = tenantA,
    bot: BotInstanceId = BOT_A,
  ): Promise<UserId> {
    const resolved = await ctx.container.customers.resolveFromUpdate(
      scope,
      systemActor(`r-${telegramUserId}`),
      {
        idempotencyKey: `resolve-dm-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'مریم' },
        botInstanceId: bot,
      },
    );
    return resolved.customer.id;
  }

  const send = (
    input: {
      text?: string;
      file?: DirectMessageFile | null;
      key?: string;
      customerId?: string;
      actor?: ActorContext;
      scope?: TenantContext;
    } = {},
  ) => {
    keySeq += 1;
    return ctx.container.customerDirectMessages.send(
      input.scope ?? tenantA,
      input.actor ?? adminActorFor(owner),
      {
        customerId: input.customerId ?? customer,
        idempotencyKey: input.key ?? `dm-key-${String(keySeq)}`,
        text: input.text ?? 'سلام، پرداخت شما بررسی شد.',
        file: input.file ?? null,
      },
    );
  };
  const history = async (customerId: string = customer) =>
    (
      await ctx.container.customerDirectMessages.history(tenantA, adminActorFor(owner), {
        customerId,
        limit: 50,
        before: null,
      })
    ).map(toItem);
  const tick = () => ctx.container.customerNotificationLoop.tick();
  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return ((await ctx.container.database.db.execute(query as never)) as unknown as { rows: T[] })
      .rows;
  }
  const count = async (query: ReturnType<typeof sql>) =>
    Number((await rows<{ n: number }>(query))[0]?.n ?? 0);
  const sends = () => sent.filter((one) => /\/send(Message|Photo|Document)$/u.test(one.url));

  // --- content -----------------------------------------------------------------------------

  it('queues a text, sends it through the customer’s own bot on the next lane pass, and reports SENT — never "delivered"', async () => {
    const result = await send({ text: 'پرداخت شما تأیید شد.' });
    expect(result.replayed).toBe(false);
    expect(toItem(result.row)).toMatchObject({
      contentKind: 'TEXT',
      text: 'پرداخت شما تأیید شد.',
      file: null,
      delivery: 'QUEUED',
      attempts: 0,
      sentBy: { id: owner.id, username: 'owner-dm' },
    });
    expect(sends()).toHaveLength(0);

    await tick();
    expect(sends()).toHaveLength(1);
    const [message] = sends();
    expect(message?.url).toContain('/sendMessage');
    expect(String(message?.body.chat_id)).toBe(CUSTOMER_TG);
    expect(String(message?.body.text)).toContain('پرداخت شما تأیید شد.');
    expect(String(message?.body.text)).toContain('پیام پشتیبانی');

    const [item] = await history();
    expect(item?.delivery).toBe('SENT');
    expect(item?.resolvedAt).not.toBeNull();
    // The outbox event names ids and the kind, never the words.
    const events = await rows<{ payload: Record<string, unknown> }>(
      sql`SELECT payload FROM outbox_messages WHERE event_type = 'CustomerDirectMessageQueued'`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      messageId: item?.id,
      customerId: customer,
      contentKind: 'TEXT',
    });
    expect(JSON.stringify(events)).not.toContain('پرداخت');
  });

  it('sends a photo with its caption as one upload, then stamps Telegram’s handle and clears the bytes', async () => {
    const result = await send({ text: 'این تصویر تنظیمات است.', file: png() });
    expect(toItem(result.row)).toMatchObject({
      contentKind: 'PHOTO',
      text: 'این تصویر تنظیمات است.',
      file: { fileName: 'screenshot.png', mimeType: 'image/png', byteLength: PNG.byteLength },
    });
    await tick();
    expect(sends()).toHaveLength(1);
    const upload = sends()[0];
    expect(upload?.url).toContain('/sendPhoto');
    expect(upload?.raw.includes(PNG)).toBe(true);
    expect(upload?.raw.toString('utf8')).toContain('این تصویر تنظیمات است.');
    const [stored] = await rows<{ staged: boolean; file_id: string | null }>(
      sql`SELECT file_content IS NOT NULL AS staged, telegram_file_id AS file_id
            FROM customer_direct_messages`,
    );
    expect(stored).toEqual({ staged: false, file_id: 'tg-file-1' });
    expect((await history())[0]?.delivery).toBe('SENT');
  });

  it('sends a document without a caption, the caption line dropped', async () => {
    const result = await send({ text: '', file: pdf() });
    expect(toItem(result.row)).toMatchObject({ contentKind: 'DOCUMENT', text: null });
    await tick();
    const upload = sends()[0];
    expect(upload?.url).toContain('/sendDocument');
    expect(upload?.raw.includes(PDF)).toBe(true);
    expect((await history())[0]?.delivery).toBe('SENT');
  });

  it('refuses an empty text, an over-long caption and a file that is not what it says — writing nothing', async () => {
    expect((await refusalOf(send({ text: '   ' }))).code).toBe('direct_message.body_invalid');
    expect((await refusalOf(send({ text: 'x'.repeat(901), file: png() }))).code).toBe(
      'direct_message.body_invalid',
    );
    const disguised: DirectMessageFile = {
      fileName: 'tool.pdf',
      mimeType: 'application/pdf',
      contentBase64: Buffer.from('MZ\x90\x00binary').toString('base64'),
    };
    expect((await refusalOf(send({ file: disguised }))).code).toBe('direct_message.file_refused');
    expect(await count(sql`SELECT count(*)::int AS n FROM customer_direct_messages`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM customer_notifications`)).toBe(0);
  });

  // --- permission ----------------------------------------------------------------------------

  it('is its own permission: a role without users.message.send is refused, audited as DENIED, and nothing is queued', async () => {
    // `finance` reads customers and moves money, but holds neither message key.
    const finance = await createAdmin(ctx.container, tenantA, {
      username: 'finance-dm',
      roleKeys: ['finance'],
    });
    const refused = await refusalOf(send({ actor: adminActorFor(finance) }));
    expect(refused.kind).toBe('PERMISSION_DENIED');
    expect(await count(sql`SELECT count(*)::int AS n FROM customer_direct_messages`)).toBe(0);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM audit_logs
             WHERE action = 'customer.direct_message' AND result = 'DENIED'`,
      ),
    ).toBe(1);
    await expect(
      ctx.container.customerDirectMessages.history(tenantA, adminActorFor(finance), {
        customerId: customer,
        limit: 10,
        before: null,
      }),
    ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
    // Seeded where the customer conversation is held, and nowhere it is not.
    const seeded = (key: string) => ROLE_SEEDS.find((role) => role.key === key)?.permissions;
    expect(seeded('support')).toContain('users.message.send');
    expect(seeded('operator')).toContain('users.message.send');
    expect(seeded('finance')).not.toContain('users.message.send');
    expect(seeded('observer')).not.toContain('users.message.view');
  });

  it('a system job holds no message permission at all', async () => {
    expect((await refusalOf(send({ actor: systemActor('job') }))).kind).toBe('PERMISSION_DENIED');
  });

  // --- the target, revalidated at send time --------------------------------------------------

  it('refuses a blocked customer, and a customer whose only bot is not active', async () => {
    await ctx.container.customers.block(tenantA, adminActorFor(owner), {
      idempotencyKey: 'block-dm',
      customerId: customer,
      reason: 'spam',
    });
    const blocked = await refusalOf(send());
    expect(blocked).toMatchObject({
      kind: 'PRECONDITION_FAILED',
      code: 'direct_message.target_unavailable',
      details: { reason: 'BLOCKED' },
    });

    const stranded = await resolve('961050', tenantA, BOT_A2);
    const noBot = await refusalOf(send({ customerId: stranded }));
    expect(noBot).toMatchObject({
      code: 'direct_message.target_unavailable',
      details: { reason: 'NO_BOT' },
    });
    expect(await count(sql`SELECT count(*)::int AS n FROM customer_direct_messages`)).toBe(0);
  });

  it('a customer blocked after the message was queued is not sent to; once stale it EXPIRES unsent', async () => {
    await send();
    await ctx.container.customers.block(tenantA, adminActorFor(owner), {
      idempotencyKey: 'block-after',
      customerId: customer,
      reason: 'spam',
    });
    await tick();
    expect(sends()).toHaveLength(0);
    expect((await history())[0]?.delivery).toBe('QUEUED');

    // A day later the block is lifted: the message is no longer one anybody would send.
    await ctx.container.database.db.execute(
      sql`UPDATE customer_direct_messages SET created_at = created_at - interval '25 hours'`,
    );
    await ctx.container.customers.unblock(tenantA, adminActorFor(owner), {
      idempotencyKey: 'unblock-after',
      customerId: customer,
      reason: null,
    });
    await tick();
    expect(sends()).toHaveLength(0);
    expect((await history())[0]?.delivery).toBe('EXPIRED');
  });

  // --- tenant isolation ----------------------------------------------------------------------

  it('cannot reach another tenant’s customer: not found for the send and for the history', async () => {
    const foreign = await resolve('961099', tenantB, BOT_B);
    expect((await refusalOf(send({ customerId: foreign }))).kind).toBe('NOT_FOUND');
    expect((await refusalOf(history(foreign))).kind).toBe('NOT_FOUND');
    expect((await refusalOf(send({ customerId: 'not-a-uuid' }))).kind).toBe('NOT_FOUND');
    expect(await count(sql`SELECT count(*)::int AS n FROM customer_direct_messages`)).toBe(0);

    // And a message in tenant A is invisible to tenant B's owner.
    await send();
    const ownerB = await createAdmin(ctx.container, tenantB, {
      username: 'owner-dm-b',
      roleKeys: ['owner'],
    });
    expect(
      (
        await refusalOf(
          ctx.container.customerDirectMessages.history(tenantB, adminActorFor(ownerB), {
            customerId: customer,
            limit: 10,
            before: null,
          }),
        )
      ).kind,
    ).toBe('NOT_FOUND');
  });

  // --- Telegram's answers ----------------------------------------------------------------------

  it('a refusal is retried by the lane and stays QUEUED with an attempt spent; a rate limit spends none', async () => {
    await send();
    mode = 'RATE_LIMIT';
    await tick();
    let [item] = await history();
    expect(item).toMatchObject({ delivery: 'QUEUED', attempts: 0 });

    await ctx.container.database.db.execute(
      sql`UPDATE customer_notifications SET next_attempt_at = NULL`,
    );
    mode = 'REFUSE';
    await tick();
    [item] = await history();
    expect(item).toMatchObject({ delivery: 'QUEUED', attempts: 1 });
  });

  it('an UNKNOWN outcome is final: reported UNKNOWN and never sent again, by the lane or by a retried request', async () => {
    await send({ key: 'dm-unknown' });
    mode = 'SERVER_ERROR';
    await tick();
    expect(sends()).toHaveLength(1);
    expect((await history())[0]?.delivery).toBe('UNKNOWN');

    mode = 'OK';
    await ctx.container.database.db.execute(
      sql`UPDATE customer_notifications SET next_attempt_at = NULL`,
    );
    await tick();
    // The operator's retry of the same request answers with the same message.
    const retried = await send({ key: 'dm-unknown' });
    expect(retried.replayed).toBe(true);
    await tick();
    expect(sends()).toHaveLength(1);
    expect((await history())[0]?.delivery).toBe('UNKNOWN');
  });

  it('a stranded send (process died after the stamp) is resolved UNKNOWN, never re-sent', async () => {
    await send();
    // The stamp committed and nothing was recorded: what a crash mid-send leaves.
    await ctx.container.database.db.execute(
      sql`UPDATE customer_notifications
             SET send_started_at = now() - interval '1 hour',
                 next_attempt_at = now() - interval '1 hour'`,
    );
    expect((await history())[0]?.delivery).toBe('SENDING');
    await tick();
    expect(sends()).toHaveLength(0);
    expect((await history())[0]?.delivery).toBe('UNKNOWN');
  });

  // --- duplicates ------------------------------------------------------------------------------

  it('a double click or a retried request sends ONE message; the same key with other words is refused', async () => {
    const first = await send({ key: 'dm-same', text: 'یک بار' });
    const second = await send({ key: 'dm-same', text: 'یک بار' });
    expect(second.replayed).toBe(true);
    expect(second.row.message.id).toBe(first.row.message.id);

    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () => send({ key: 'dm-race', text: 'همزمان' })),
    );
    expect(new Set(concurrent.map((one) => one.row.message.id)).size).toBe(1);
    expect(concurrent.filter((one) => !one.replayed)).toHaveLength(1);

    const mismatch = await refusalOf(send({ key: 'dm-same', text: 'متن دیگر' }));
    expect(mismatch.code).toBe('platform.idempotency_payload_mismatch');

    expect(await count(sql`SELECT count(*)::int AS n FROM customer_direct_messages`)).toBe(2);
    expect(await count(sql`SELECT count(*)::int AS n FROM customer_notifications`)).toBe(2);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM audit_logs
             WHERE action = 'customer.direct_message' AND result = 'SUCCESS'`,
      ),
    ).toBe(2);
    await tick();
    expect(sends()).toHaveLength(2);
  });

  // --- the rate limit --------------------------------------------------------------------------

  it('limits one customer to DIRECT_MESSAGE_MAX_PER_CUSTOMER in the window, exactly, under concurrency', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: DIRECT_MESSAGE_MAX_PER_CUSTOMER + 3 }, (_, index) =>
        send({ text: `پیام ${String(index)}` }),
      ),
    );
    const accepted = results.filter((one) => one.status === 'fulfilled');
    expect(accepted).toHaveLength(DIRECT_MESSAGE_MAX_PER_CUSTOMER);
    const refused = results.filter((one) => one.status === 'rejected');
    for (const one of refused) {
      expect((one as PromiseRejectedResult).reason).toMatchObject({
        kind: 'RATE_LIMITED',
        code: 'direct_message.rate_limited',
        details: { scope: 'CUSTOMER' },
      });
    }
    // The window slides: rows older than it no longer count.
    await ctx.container.database.db.execute(
      sql`UPDATE customer_direct_messages SET created_at = created_at - interval '11 minutes'`,
    );
    expect((await send()).replayed).toBe(false);
  });

  it('limits one operator to DIRECT_MESSAGE_MAX_PER_ADMIN across customers', async () => {
    const perCustomer = DIRECT_MESSAGE_MAX_PER_CUSTOMER;
    const customers = Math.ceil(DIRECT_MESSAGE_MAX_PER_ADMIN / perCustomer) + 1;
    const ids: UserId[] = [];
    for (let index = 0; index < customers; index += 1) {
      ids.push(await resolve(String(962000 + index)));
    }
    let sentCount = 0;
    for (const id of ids) {
      for (
        let index = 0;
        index < perCustomer && sentCount < DIRECT_MESSAGE_MAX_PER_ADMIN;
        index += 1
      ) {
        await send({ customerId: id });
        sentCount += 1;
      }
    }
    const last = ids.at(-1) as UserId;
    const refused = await refusalOf(send({ customerId: last }));
    expect(refused).toMatchObject({
      code: 'direct_message.rate_limited',
      details: { scope: 'ADMIN' },
    });

    // Another operator is not limited by the first one's count.
    const other = await createAdmin(ctx.container, tenantA, {
      username: 'operator-dm',
      roleKeys: ['operator'],
    });
    expect((await send({ customerId: last, actor: adminActorFor(other) })).replayed).toBe(false);
  });

  // --- audit -----------------------------------------------------------------------------------

  it('audits the operator, the target and the kind — never the text', async () => {
    const secret = 'رمز عبور جدید شما: AbC-123';
    const result = await send({ text: secret, file: png() });
    const audits = await rows<{
      actor_id: string;
      entity_type: string;
      entity_id: string;
      after: Record<string, unknown>;
      reason: string | null;
    }>(
      sql`SELECT actor_id, entity_type, entity_id, after, reason FROM audit_logs
           WHERE action = 'customer.direct_message'`,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_id: owner.id,
      entity_type: 'Customer',
      entity_id: customer,
      after: {
        messageId: result.row.message.id,
        contentKind: 'PHOTO',
        textLength: Array.from(secret).length,
        file: { mimeType: 'image/png', byteLength: PNG.byteLength },
      },
    });
    expect(JSON.stringify(audits)).not.toContain('AbC-123');
    expect(JSON.stringify(audits)).not.toContain(PNG.toString('base64'));
  });

  it('the history is newest first and pages by its cursor', async () => {
    const first = await send({ text: 'اول' });
    const second = await send({ text: 'دوم' });
    const items = await history();
    expect(items.map((one) => one.id)).toEqual([second.row.message.id, first.row.message.id]);
    const page = await ctx.container.customerDirectMessages.history(tenantA, adminActorFor(owner), {
      customerId: customer,
      limit: 10,
      before: { at: second.row.message.createdAt, id: second.row.message.id },
    });
    expect(page.map((one) => one.message.id)).toEqual([first.row.message.id]);
  });
});

/** The route, through Fastify: the origin check, the body limit and the wire shape. */
describe('Phase A2 — direct message over HTTP', () => {
  const ORIGIN = 'https://admin.example.test';
  let api: ApiApp;
  let cookie: string;
  let customerId: string;

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
    await createAdmin(api.container, tenantA, {
      username: 'owner-dm-http',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    const login = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner-dm-http', password: 'the-owners-real-password' },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(login.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error('No session cookie.');
    cookie = `${SESSION_COOKIE_NAME}=${match[1] as string}`;
    const resolved = await api.container.customers.resolveFromUpdate(tenantA, systemActor('h'), {
      idempotencyKey: 'resolve-dm-http',
      telegramUserId: CUSTOMER_TG,
      from: { id: Number(CUSTOMER_TG), first_name: 'مریم' },
      botInstanceId: BOT_A,
    });
    customerId = resolved.customer.id;
  });

  it('sends with a file over HTTP, answers the wire shape without Telegram identifiers, and lists it', async () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024, 0x41);
    Buffer.from('%PDF-1.7\n').copy(bytes);
    const posted = await inject({
      method: 'POST',
      url: `${API_PREFIX}${DIRECT_MESSAGE_ROUTES.send(customerId)}`,
      headers: { origin: ORIGIN, cookie },
      payload: {
        idempotencyKey: 'http-dm-1',
        text: 'فاکتور شما',
        file: {
          fileName: 'invoice.pdf',
          mimeType: 'application/pdf',
          contentBase64: bytes.toString('base64'),
        },
      },
    });
    expect(posted.statusCode, posted.body.slice(0, 300)).toBe(201);
    const body = posted.json() as { message: Record<string, unknown>; replayed: boolean };
    expect(body.replayed).toBe(false);
    expect(body.message).toMatchObject({ contentKind: 'DOCUMENT', delivery: 'QUEUED' });
    expect(posted.body).not.toContain(CUSTOMER_TG);
    expect(posted.body).not.toContain(BOT_A);

    const listed = await inject({
      method: 'GET',
      url: `${API_PREFIX}${DIRECT_MESSAGE_ROUTES.list(customerId)}`,
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { messages: unknown[] }).messages).toHaveLength(1);

    const foreignOrigin = await inject({
      method: 'POST',
      url: `${API_PREFIX}${DIRECT_MESSAGE_ROUTES.send(customerId)}`,
      headers: { origin: 'https://evil.example.test', cookie },
      payload: { idempotencyKey: 'http-dm-2', text: 'x' },
    });
    expect(foreignOrigin.statusCode).toBe(403);
  });
});
