import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type OrderId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import type { ServiceRecord } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  validatePanelConnection,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Package E — a RickPanel service's connection files, end to end
 * (`docs/package-e-rickpanel-files-audit.md`).
 *
 * Through the shipped container: the real `RickpanelAdapter` over the real
 * `SafeHttpClient` against `tests/support/fake-rickpanel.ts`, and the real customer
 * messenger against a Telegram stand-in on a socket that records every upload.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const CUSTOMER_TG = '940400';
const OTHER_TG = '940401';

const systemActor = (label: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: label as CorrelationId,
});

interface Sent {
  readonly url: string;
  readonly raw: string;
}

describe('Package E — RickPanel subscription files', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  let telegramAnswer: { status: number; body: unknown } | null;
  let panel: FakeRickpanel;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let panelId: string;
  let customerId: UserId;
  let otherId: UserId;
  let owner: ActorContext;
  let updateSeq = 5000;

  beforeAll(async () => {
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        sent.push({ url: request.url ?? '', raw: Buffer.concat(chunks).toString('utf8') });
        const answer = telegramAnswer ?? {
          status: 200,
          body: { ok: true, result: { message_id: 7 } },
        };
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    telegram.closeAllConnections();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(ctx.container.database.db);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    sent = [];
    telegramAnswer = null;

    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-files', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Rick',
      providerType: 'rickpanel',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: {},
      idempotencyKey: 'panel-files-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);

    const resolve = async (tg: string) =>
      (
        await ctx.container.customers.resolveFromUpdate(tenantA, systemActor(`r-${tg}`), {
          idempotencyKey: `resolve-files-${tg}`,
          telegramUserId: tg,
          from: { id: Number(tg), first_name: 'سارا' },
          botInstanceId: BOT_A,
        })
      ).customer.id;
    customerId = await resolve(CUSTOMER_TG);
    otherId = await resolve(OTHER_TG);
  });

  async function deliveredService(key: string): Promise<ServiceRecord> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ریک',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(key), {
      idempotencyKey: `${key}-draft`,
      customerId,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId,
      orderId: draft.id,
    });
    await ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), customerId, {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id as OrderId,
    });
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, confirmed.id);
    if (service === null || service.state !== 'ACTIVE') throw new Error('not provisioned');
    sent = [];
    return service;
  }

  const send = (serviceId: string, asCustomer: UserId = customerId, scope = tenantA) =>
    ctx.container.subscriptionFiles.send(scope, systemActor(randomUUID()), {
      customerId: asCustomer,
      serviceId,
      chatId: CUSTOMER_TG,
      botInstanceId: BOT_A,
    });

  const uploads = () => sent.filter((one) => one.url.endsWith('/sendDocument'));

  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

  const tap = (data: string, telegramUserId = CUSTOMER_TG) => {
    updateSeq += 1;
    return ctx.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: `files-update-${String(updateSeq)}-${randomUUID()}`,
      botInstanceId: BOT_A,
      update: {
        update_id: updateSeq,
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'سارا' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: Number(telegramUserId), type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'سارا' },
    });
  };

  it('sends every format as a document with its file name, media type, bytes and caption', async () => {
    const service = await deliveredService('ok');
    const result = await send(service.id);
    expect(result).toEqual({ outcome: 'SENT', sent: 2, failed: 0 });
    const docs = uploads();
    expect(docs).toHaveLength(2);
    const user = panel.users.get(service.providerUsername)!;
    expect(docs[0]!.raw).toContain(`filename="${service.providerUsername}.json"`);
    expect(docs[0]!.raw).toContain('Content-Type: application/json');
    expect(docs[0]!.raw).toContain(JSON.stringify({ outbounds: [{ token: user.subToken }] }));
    expect(docs[0]!.raw).toContain(`${service.providerUsername} — JSON`);
    expect(docs[0]!.raw).toContain(`name="chat_id"\r\n\r\n${CUSTOMER_TG}`);
    // A `charset` parameter is dropped to the vetted type, never passed through.
    expect(docs[1]!.raw).toContain('Content-Type: text/plain\r\n');
    expect(panel.filesCalls()).toBe(1);
  });

  it('sends the usable formats and counts the one the panel failed to build', async () => {
    const service = await deliveredService('partial');
    panel.filesBody = JSON.stringify({
      files: [
        { filename: 'a.json', media_type: 'application/json', content_b64: b64('{"a":1}') },
        { filename: 'b.yaml', media_type: 'application/yaml', error: 'build failed' },
      ],
    });
    expect(await send(service.id)).toEqual({ outcome: 'SENT', sent: 1, failed: 1 });
    expect(uploads()).toHaveLength(1);
  });

  it('refuses malformed Base64 as a failed format, never a partial decode', async () => {
    const service = await deliveredService('b64');
    panel.filesBody = JSON.stringify([
      { filename: 'ok.txt', media_type: 'text/plain', content_b64: b64('fine') },
      { filename: 'bad.txt', media_type: 'text/plain', content_b64: 'not base64!!' },
      { filename: 'pad.txt', media_type: 'text/plain', content_b64: 'Zm9v=' },
    ]);
    expect(await send(service.id)).toEqual({ outcome: 'SENT', sent: 1, failed: 2 });
    expect(uploads().map((one) => /filename="([^"]+)"/.exec(one.raw)?.[1])).toEqual(['ok.txt']);
  });

  it('answers UNAVAILABLE when every format failed, and sends nothing', async () => {
    const service = await deliveredService('none');
    panel.filesBody = JSON.stringify([{ filename: 'x', error: 'nope' }]);
    expect(await send(service.id)).toEqual({ outcome: 'UNAVAILABLE' });
    expect(uploads()).toHaveLength(0);
  });

  it('refuses an answer with more entries than the bound as malformed', async () => {
    const service = await deliveredService('many');
    panel.filesBody = JSON.stringify(
      Array.from({ length: 21 }, (_, i) => ({
        filename: `f${String(i)}.txt`,
        media_type: 'text/plain',
        content_b64: b64('x'),
      })),
    );
    expect(await send(service.id)).toEqual({ outcome: 'UNAVAILABLE' });
    expect(uploads()).toHaveLength(0);
  });

  it('answers UNAVAILABLE for a user the panel does not hold', async () => {
    const service = await deliveredService('gone');
    (panel.users as Map<string, unknown>).delete(service.providerUsername);
    expect(await send(service.id)).toEqual({ outcome: 'UNAVAILABLE' });
    expect(uploads()).toHaveLength(0);
  });

  it("honours the panel's 429 and Retry-After, and never retries", async () => {
    const service = await deliveredService('limit');
    const operationsOf = async () =>
      (
        (await ctx.container.database.db.execute(
          sql`SELECT count(*)::int AS n FROM provisioning_operations WHERE service_id = ${service.id}`,
        )) as unknown as { rows: { n: number }[] }
      ).rows[0]?.n;
    const before = await operationsOf();
    expect((await send(service.id)).outcome).toBe('SENT');
    sent = [];
    const second = await send(service.id);
    expect(second.outcome).toBe('RATE_LIMITED');
    if (second.outcome !== 'RATE_LIMITED') return;
    expect(second.retryAfterSeconds).toBeGreaterThan(50);
    expect(second.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(panel.filesCalls()).toBe(2);
    expect(uploads()).toHaveLength(0);
    // Not an operation, and not a provider mutation failure: nothing is recorded.
    expect(await operationsOf()).toBe(before);
  });

  it("never sends another customer's files, and never asks the panel", async () => {
    const service = await deliveredService('owner');
    expect(await send(service.id, otherId)).toEqual({ outcome: 'NOT_FOUND' });
    expect(panel.filesCalls()).toBe(0);
    expect(uploads()).toHaveLength(0);
  });

  it("never serves another tenant's service", async () => {
    const service = await deliveredService('tenant');
    expect(await send(service.id, customerId, tenantB)).toEqual({ outcome: 'NOT_FOUND' });
    expect(panel.filesCalls()).toBe(0);
  });

  it('keeps the file bytes out of every table', async () => {
    const service = await deliveredService('persist');
    const secret = `FILESECRET-${randomUUID()}`;
    panel.filesBody = JSON.stringify([
      {
        filename: `${secret}.txt`,
        media_type: 'text/plain',
        content_b64: b64(secret),
        caption: secret,
      },
    ]);
    expect((await send(service.id)).outcome).toBe('SENT');
    expect(uploads()[0]!.raw).toContain(secret);

    const db = ctx.container.database.db;
    const tables = (
      (await db.execute(
        sql`SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      )) as unknown as { rows: { table_name: string }[] }
    ).rows.map((row) => row.table_name);
    expect(tables.length).toBeGreaterThan(50);
    for (const table of tables) {
      const found = (
        (await db.execute(
          sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} t
               WHERE t::text LIKE ${`%${secret}%`} OR t::text LIKE ${`%${b64(secret)}%`}`,
        )) as unknown as { rows: { n: number }[] }
      ).rows[0]?.n;
      expect({ table, found }).toEqual({ table, found: 0 });
    }
  });

  it('stops at the first send Telegram declines and retries nothing', async () => {
    const service = await deliveredService('stop');
    telegramAnswer = {
      status: 429,
      body: { ok: false, error_code: 429, parameters: { retry_after: 5 } },
    };
    expect(await send(service.id)).toEqual({ outcome: 'STOPPED', sent: 0 });
    expect(uploads()).toHaveLength(1);
  });

  describe('in the bot', () => {
    it('draws the files button on the detail of a service whose panel can fetch files', async () => {
      const service = await deliveredService('button');
      await tap(`s:${service.id}`);
      // The detail screen, among the tap's calls (the last one only stops the spinner).
      expect(sent.some((one) => one.raw.includes(`"callback_data":"sf:${service.id}"`))).toBe(true);
    });

    it('sends the files to the private chat the tap came from', async () => {
      const service = await deliveredService('tap');
      await tap(`sf:${service.id}`);
      expect(uploads()).toHaveLength(2);
      expect(uploads()[0]!.raw).toContain(`name="chat_id"\r\n\r\n${CUSTOMER_TG}`);
    });

    it("answers another customer's tap as an unknown service", async () => {
      const service = await deliveredService('foreign-tap');
      await tap(`sf:${service.id}`, OTHER_TG);
      expect(uploads()).toHaveLength(0);
      expect(panel.filesCalls()).toBe(0);
    });

    it('tells the customer how long to wait after a 429', async () => {
      const service = await deliveredService('wait');
      await tap(`sf:${service.id}`);
      sent = [];
      await tap(`sf:${service.id}`);
      expect(uploads()).toHaveLength(0);
      const reply = sent.find((one) => one.url.endsWith('/sendMessage'))!.raw;
      expect(reply).toMatch(/ثانیه دیگر دوباره امتحان کنید/);
    });
  });
});
