import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
  type AdminId,
  type BotInstanceId,
  type CorrelationId,
  type OrderId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
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
 * Shared rig for the Round 9 characterization tests (`r9-char-*.test.ts`).
 *
 * These tests exist so that `bot-runtime.ts` can be split without changing what a
 * customer or an operator sees. They drive `BotRuntime.handle` the way the webhook does,
 * against a real PostgreSQL and a socket standing in for Telegram, and pin what the code
 * answers TODAY: the template key, the rendered text and the buttons in order. They are
 * deliberately not a statement that the current behaviour is right.
 */

export const BOT_A = SEED_IDS.botA1 as BotInstanceId;

export interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** One button as Telegram received it: its label and what a tap sends back. */
export interface PinnedButton {
  readonly text: string;
  readonly data: string | undefined;
  readonly url?: string;
}

export const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Ids differ run to run; their position and role must not. */
export const maskIds = (value: string): string => value.replace(UUID, '<id>');

/** `encodeIdPair` packs two uuids into 43 base64url characters; their value is per run. */
export const maskPairs = (value: string): string =>
  value.replace(/^([a-z]{1,2}:)[A-Za-z0-9_-]{43}$/, '$1<pair>');

export interface CharRig {
  readonly sent: Sent[];
  ctx(): TestContext;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Truncate, re-seed, point the container at tenant A and forget what was sent. */
  reset(): Promise<void>;
  text(value: string, telegramUserId: string, messageId?: number): Update;
  tap(data: string, telegramUserId: string, messageId?: number): Update;
  /** Deliver a `/start` carrying a deep-link payload. */
  handle(update: Update): ReturnType<TestContext['container']['botRuntime']['handle']>;
  /** sendMessage + editMessageText + sendPhoto etc, in arrival order. */
  drawn(): Sent[];
  lastDrawn(): Sent | undefined;
  lastText(): string;
  /** `[label, callback_data][]` per row, of the last drawn message. */
  lastKeyboard(): PinnedButton[][];
  /** Every request path in arrival order, e.g. `sendMessage`, `answerCallbackQuery`. */
  methods(): string[];
  resolveCustomer(telegramUserId: string, firstName?: string): Promise<UserId>;
  /** An owner administrator (every permission), created on first use. */
  owner(): Promise<ActorContext>;
  /** An administrator bound to a Telegram account, with the given seeded roles. */
  boundAdmin(
    username: string,
    telegramUserId: string,
    roleKeys: readonly string[],
  ): Promise<AdminId>;
  /** An active, sellable product on a sellable panel; returns its id. */
  product(spec?: { title?: string; price?: bigint }): Promise<ProductId>;
  panelId(): Promise<string>;
  /** A DRAFT order for the product (not confirmed). */
  draftOrder(customerId: UserId, productId: ProductId, key: string): Promise<OrderId>;
  /** A confirmed order, AWAITING_PAYMENT. */
  awaitingOrder(customerId: UserId, productId: ProductId, key: string): Promise<OrderId>;
}

export interface Update {
  readonly idempotencyKey: string;
  readonly botInstanceId: BotInstanceId;
  readonly update: Record<string, unknown>;
  readonly telegramUserId: string;
  readonly from: Record<string, unknown>;
}

export function makeRig(): CharRig {
  let ctx: TestContext | undefined;
  let telegram: Server | undefined;
  const sent: Sent[] = [];
  let updateSeq = 0;
  let panel: string | undefined;
  let ownerActor: ActorContext | undefined;

  const requireCtx = (): TestContext => {
    if (ctx === undefined) throw new Error('rig not started');
    return ctx;
  };

  const base = (payload: Record<string, unknown>, telegramUserId: string): Update => {
    updateSeq += 1;
    return {
      idempotencyKey: `r9-update-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      update: { update_id: updateSeq, ...payload },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'x' },
    };
  };

  const drawn = (): Sent[] =>
    sent.filter(
      (one) =>
        one.url.includes('/sendMessage') ||
        one.url.includes('/editMessageText') ||
        one.url.includes('/sendPhoto') ||
        one.url.includes('/sendVideo') ||
        one.url.includes('/sendDocument') ||
        one.url.includes('/editMessageCaption'),
    );

  const rig: CharRig = {
    sent,
    ctx: requireCtx,
    async start() {
      telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          } catch {
            body = { unparseable: true };
          }
          sent.push({ url: request.url ?? '', body });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
        });
      });
      const server = telegram;
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      ctx = await createTestContext({
        PANEL_HTTP_ALLOW_LOOPBACK: 'true',
        TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
      });
    },
    async stop() {
      await ctx?.close();
      const server = telegram;
      if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    async reset() {
      const c = requireCtx();
      await c.reset();
      c.container.setInstallationTenant(tenantA.tenantId);
      sent.length = 0;
      panel = undefined;
      ownerActor = undefined;
    },
    text(value, telegramUserId, messageId) {
      return base(
        {
          message: {
            message_id: messageId ?? updateSeq + 1,
            date: 0,
            chat: { id: Number(telegramUserId), type: 'private' },
            from: { id: Number(telegramUserId), is_bot: false, first_name: 'x' },
            text: value,
          },
        },
        telegramUserId,
      );
    },
    tap(data, telegramUserId, messageId) {
      return base(
        {
          callback_query: {
            id: `cbq-${String(updateSeq + 1)}`,
            from: { id: Number(telegramUserId), is_bot: false, first_name: 'x' },
            data,
            message: {
              message_id: messageId ?? updateSeq + 1,
              date: 0,
              chat: { id: Number(telegramUserId), type: 'private' },
              from: { id: 999_999, is_bot: true, first_name: 'Nexa' },
            },
          },
        },
        telegramUserId,
      );
    },
    handle(update) {
      return requireCtx().container.botRuntime.handle(tenantA, systemActor('r9-bot'), update);
    },
    drawn,
    lastDrawn: () => drawn()[drawn().length - 1],
    lastText: () => String(drawn()[drawn().length - 1]?.body['text'] ?? ''),
    lastKeyboard() {
      const markup = drawn()[drawn().length - 1]?.body['reply_markup'] as
        | {
            inline_keyboard?: { text: string; callback_data?: string; url?: string }[][];
          }
        | undefined;
      return (markup?.inline_keyboard ?? []).map((row) =>
        row.map((button) => ({
          text: button.text,
          data: button.callback_data === undefined ? undefined : maskIds(button.callback_data),
          ...(button.url === undefined ? {} : { url: button.url }),
        })),
      );
    },
    methods: () => sent.map((one) => one.url.replace(/^.*\/bot[^/]*\//, '')),
    async resolveCustomer(telegramUserId, firstName = 'مریم') {
      const resolved = await requireCtx().container.customers.resolveFromUpdate(
        tenantA,
        systemActor(`resolve-${telegramUserId}`),
        {
          idempotencyKey: `resolve-${telegramUserId}`,
          telegramUserId,
          from: { id: Number(telegramUserId), first_name: firstName },
          botInstanceId: BOT_A,
        },
      );
      return resolved.customer.id;
    },
    async owner() {
      if (ownerActor === undefined) {
        ownerActor = adminActorFor(
          await createAdmin(requireCtx().container, tenantA, {
            username: 'r9-owner',
            roleKeys: ['owner'],
          }),
        );
      }
      return ownerActor;
    },
    async boundAdmin(username, telegramUserId, roleKeys) {
      const c = requireCtx();
      const seeded = await createAdmin(c.container, tenantA, { username, roleKeys });
      await c.container.adminManagement.setTelegramBinding(
        tenantA,
        await rig.owner(),
        seeded.id as AdminId,
        { telegramUserId, reason: 'r9 characterization binding' },
      );
      return seeded.id as AdminId;
    },
    async panelId() {
      if (panel !== undefined) return panel;
      const c = requireCtx();
      const id = c.container.ids.uuid();
      await c.container.database.db.execute(sql`
        INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
        VALUES (${id}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
      await makePanelSellable(c.container, tenantA, id);
      panel = id;
      return id;
    },
    async product(spec = {}) {
      const c = requireCtx();
      const repository = new DrizzleProductRepository(c.container.database.db);
      const created = await repository.create(tenantA, {
        id: c.container.ids.uuid() as ProductId,
        draft: {
          title: spec.title ?? 'پلن پایه',
          description: null,
          audience: 'EVERYONE',
          sortOrder: 10,
          panelId: (await rig.panelId()) as never,
          categoryId: SEED_IDS.categoryA as ProductCategoryId,
          specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
          price: money(spec.price ?? 250_000n, 'IRT'),
          display: EMPTY_PRODUCT_DISPLAY,
        },
        now: c.container.clock.now(),
      });
      await repository.setStatus(
        tenantA,
        created.id,
        'INACTIVE',
        'ACTIVE',
        c.container.clock.now(),
      );
      return created.id;
    },
    async draftOrder(customerId, productId, key) {
      const draft = await requireCtx().container.orders.createDraft(tenantA, systemActor(key), {
        idempotencyKey: `${key}-draft`,
        customerId,
        productId,
      });
      return draft.id;
    },
    async awaitingOrder(customerId, productId, key) {
      const c = requireCtx();
      const draftId = await rig.draftOrder(customerId, productId, key);
      const confirmed = await c.container.orders.confirm(tenantA, systemActor(key), {
        idempotencyKey: `${key}-confirm`,
        customerId,
        orderId: draftId,
      });
      return confirmed.id;
    },
  };
  return rig;
}

/**
 * What a customer or an operator is shown for one turn: the intent the update was
 * classified as, the template key the turn answered with, the rendered text and the
 * inline keyboard row by row as `[label, callback_data]`. Ids are masked.
 */
export interface View {
  readonly intent: string;
  readonly key: string | null;
  readonly text: string;
  readonly buttons: readonly (readonly (readonly [string, string])[])[];
  /** The persistent reply keyboard when the message attached one: label rows. */
  readonly replyKeyboard?: readonly (readonly string[])[];
}

interface Keyboarded {
  readonly reply_markup?: {
    readonly keyboard?: readonly (string | { readonly text: string })[][];
    readonly inline_keyboard?: readonly {
      readonly text: string;
      readonly callback_data?: string;
      readonly url?: string;
    }[][];
  };
}

/** A turn's result and the last message body Telegram received, as a `View`. */
export function viewOf(
  result: { readonly intent: string; readonly replyKey: string | null },
  body: Record<string, unknown> | undefined,
): View {
  const markup = (body as Keyboarded | undefined)?.reply_markup;
  const replyKeyboard = markup?.keyboard?.map((row) =>
    row.map((button) => (typeof button === 'string' ? button : button.text)),
  );
  return {
    intent: result.intent,
    key: result.replyKey,
    text: maskIds(String(body?.['text'] ?? body?.['caption'] ?? '')),
    ...(replyKeyboard === undefined ? {} : { replyKeyboard }),
    buttons: (markup?.inline_keyboard ?? []).map((row) =>
      row.map(
        (button) =>
          [
            button.text,
            maskPairs(
              maskIds(
                button.callback_data ?? (button.url === undefined ? '' : `url:${button.url}`),
              ),
            ),
          ] as const,
      ),
    ),
  };
}

/**
 * Pins a table of expected views: each case calls `pin('label', view)` and the label must be
 * in the table. The tables were recorded from the code as it stood before the split, and are
 * the characterization: a table entry changes only when a reply is changed on purpose.
 */
export function makePin(
  table: Readonly<Record<string, View>>,
  assertEqual: (actual: unknown, expected: unknown, label: string) => void,
): (label: string, view: View) => void {
  return (label, view) => {
    const expected = table[label];
    if (expected === undefined) throw new Error(`no pinned view for '${label}'`);
    assertEqual(view, expected, label);
  };
}
