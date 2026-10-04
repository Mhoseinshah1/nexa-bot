import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  CUSTOMER_360_ROUTES,
  EMPTY_PRODUCT_DISPLAY,
  SESSION_COOKIE_NAME,
  TELEGRAM_SECRET_TOKEN_HEADER,
  TERMS_ERROR_CODES,
  TERMS_BODY_MAX_LENGTH,
  TERMS_ROUTES,
  TERMS_TEMPLATE_MAX_LENGTH,
  TERMS_TITLE_MAX_LENGTH,
  customerOverviewResponseSchema,
  isNexaError,
  money,
  termsOverviewSchema,
  termsVersionWriteResponseSchema,
  type ActorContext,
  type BotInstanceId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type CorrelationId,
  type TenantContext,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { TermsVersionRecord } from '../../apps/api/src/modules/control/terms/application/ports';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
  validatePanelConnection,
} from './harness';

/**
 * Program §6 — the terms and rules, end to end (`docs/terms-audit.md`).
 *
 * The real app over a real database; Telegram is a fake that records every call. Updates
 * arrive on the bot's authenticated webhook, so the gate is the production `guardedAct` →
 * `termsGatedAct` path, and the acceptance is the production write.
 */

const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-the-terms';
const ORIGIN = 'https://admin.example.test';
const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (isNexaError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('terms and rules (program §6)', () => {
  let api: ApiApp;
  let telegram: Server;
  let calls: { method: string; body: Record<string, unknown>; messageId?: number }[] = [];
  /**
   * Batch 01 item 1: what each message in the fake chat says now, so an edit into the same
   * text and keyboard is answered as Telegram answers it — `400 message is not modified` —
   * and `refuseEdits` stands for a message Telegram cannot edit any more.
   */
  let shown = new Map<number, string>();
  let refuseEdits = false;
  let owner: ActorContext;
  let ownerB: ActorContext;
  let operator: ActorContext;
  let observer: ActorContext;
  let panel: FakeMarzban | null = null;
  let config: ReturnType<typeof testConfig>;
  let updateId = 120_000;
  let messageId = 1200;
  let nextUser = 820_000;
  let keys = 0;

  const key = () => `terms-${String((keys += 1)).padStart(8, '0')}`;
  const user = () => (nextUser += 1);

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const [, , method = ''] = (request.url ?? '').split('/');
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = {};
        }
        const content = JSON.stringify([body.text, body.reply_markup ?? null]);
        if (method === 'editMessageText') {
          const target = Number(body.message_id);
          calls.push({ method, body, messageId: target });
          const refusal = refuseEdits
            ? 'Bad Request: message to edit not found'
            : shown.get(target) === content
              ? 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message'
              : null;
          if (refusal !== null) {
            response.writeHead(400, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ok: false, error_code: 400, description: refusal }));
            return;
          }
          shown.set(target, content);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, result: true }));
          return;
        }
        const id = (messageId += 1);
        calls.push({ method, body, messageId: id });
        if (method === 'sendMessage') shown.set(id, content);
        const result = method === 'answerCallbackQuery' ? true : { message_id: id };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    config = testConfig({
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      WEB_ADMIN_ORIGINS: ORIGIN,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await panel?.close();
    await api?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  beforeEach(async () => {
    await panel?.close();
    panel = null;
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    calls = [];
    shown = new Map();
    refuseEdits = false;
    owner = adminActorFor(
      await createAdmin(api.container, tenantA, {
        username: 'owner-terms',
        password: 'the-owners-real-password',
        roleKeys: ['owner'],
      }),
    );
    operator = adminActorFor(
      await createAdmin(api.container, tenantA, {
        username: 'operator-terms',
        roleKeys: ['operator'],
      }),
    );
    observer = adminActorFor(
      await createAdmin(api.container, tenantA, {
        username: 'observer-terms',
        roleKeys: ['observer'],
      }),
    );
    ownerB = adminActorFor(
      await createAdmin(api.container, tenantB, { username: 'owner-terms-b', roleKeys: ['owner'] }),
    );
  });

  // -------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------

  async function publish(
    title: string,
    body: string,
    scope: TenantContext = tenantA,
    actor: ActorContext = scope === tenantA ? owner : ownerB,
  ): Promise<TermsVersionRecord> {
    const existing = (await api.container.terms.overview(scope, actor)).draft;
    const draft =
      existing === null
        ? await api.container.terms.createDraft(scope, actor, {
            idempotencyKey: key(),
            title,
            body,
          })
        : await api.container.terms.updateDraft(scope, actor, {
            idempotencyKey: key(),
            id: existing.id,
            title,
            body,
            expectedRevision: existing.revision,
          });
    return api.container.terms.publish(scope, actor, {
      idempotencyKey: key(),
      id: draft.id,
      expectedRevision: draft.revision,
    });
  }

  async function enforce(enabled: boolean, scope: TenantContext = tenantA) {
    const actor = scope === tenantA ? owner : ownerB;
    const current = (await api.container.terms.overview(scope, actor)).enforcement;
    await api.container.featureFlags.set(scope, actor, {
      key: 'terms_enforcement',
      enabled,
      expectedVersion: current.version,
      idempotencyKey: key(),
    });
  }

  const webhook = (bot: BotInstanceId, update: Record<string, unknown>) =>
    inject({
      method: 'POST',
      url: `/telegram/webhook/${bot}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: { update_id: (updateId += 1), ...update },
    });

  async function say(from: number, text: string, bot: BotInstanceId = BOT_A) {
    calls = [];
    await webhook(bot, {
      message: {
        message_id: (messageId += 1),
        date: 0,
        chat: { id: from, type: 'private' },
        from: { id: from, is_bot: false, first_name: 'Customer' },
        text,
      },
    });
    return calls.filter((call) => call.method === 'sendMessage').map((call) => call.body);
  }

  const tapUpdate = (from: number, data: string, onMessage?: number) => ({
    callback_query: {
      id: `cbq-${String((updateId += 1))}`,
      from: { id: from, is_bot: false, first_name: 'Customer' },
      chat_instance: 'ci',
      message: {
        message_id: onMessage ?? (messageId += 1),
        date: 0,
        chat: { id: from, type: 'private' },
        from: { id: 999999, is_bot: true, first_name: 'Nexa' },
        text: 'x',
      },
      data,
    },
  });

  async function tap(from: number, data: string, bot: BotInstanceId = BOT_A) {
    calls = [];
    await webhook(bot, tapUpdate(from, data));
    return calls.filter((call) => call.method === 'sendMessage').map((call) => call.body);
  }

  /** The Telegram id of the message the last turn sent, for a tap ON that message. */
  const lastSentId = () => {
    const id = calls.filter((call) => call.method === 'sendMessage').at(-1)?.messageId;
    if (id === undefined) throw new Error('nothing was sent');
    return id;
  };

  /**
   * Batch 01 item 1: a tap on the message `onMessage`, and every send and edit it caused —
   * so a test can say "edited that message, sent nothing" rather than only "said this".
   */
  async function tapOn(from: number, data: string, onMessage: number) {
    calls = [];
    await webhook(BOT_A, tapUpdate(from, data, onMessage));
    return {
      sends: calls.filter((call) => call.method === 'sendMessage').map((call) => call.body),
      edits: calls.filter((call) => call.method === 'editMessageText'),
    };
  }

  /** Accept on the terms message just sent; asserts it was edited and nothing was sent. */
  async function acceptOnScreen(from: number, versionId: string) {
    const { sends, edits } = await tapOn(from, `ac:${versionId}`, lastSentId());
    expect(sends).toEqual([]);
    return textOf(edits.map((edit) => edit.body));
  }

  const textOf = (bodies: readonly Record<string, unknown>[]) =>
    bodies.map((body) => String(body.text));

  const dataOf = (bodies: readonly Record<string, unknown>[]) =>
    bodies.flatMap((body) => {
      const markup = body.reply_markup as
        { inline_keyboard?: { callback_data?: string }[][] } | undefined;
      return (markup?.inline_keyboard ?? []).flat().map((button) => button.callback_data);
    });

  const WELCOME_BACK = CATALOGUE_FA['bot.start.welcome_back'];
  const ACCEPTED = CATALOGUE_FA['bot.terms.accepted'].replace('{icon:success}', '✅');

  /** Whether these replies are exactly the terms screen for `version`. */
  function isTermsScreen(bodies: readonly Record<string, unknown>[], version: TermsVersionRecord) {
    return (
      bodies.length === 1 &&
      textOf(bodies)[0]?.includes(version.title) === true &&
      textOf(bodies)[0]?.includes(version.body) === true &&
      dataOf(bodies).includes(`ac:${version.id}`)
    );
  }

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await api.container.database.db.execute(query)).rows as T[];
  }

  const customerIdOf = async (telegramUserId: number, tenant: string = tenantA.tenantId) =>
    (
      await rows<{ id: string }>(
        sql`SELECT id FROM customers WHERE tenant_id = ${tenant}
            AND telegram_user_id = ${String(telegramUserId)}`,
      )
    )[0]?.id;

  const acceptances = (tenant: string = tenantA.tenantId) =>
    rows<{ customer_id: string; terms_version_id: string; source: string }>(
      sql`SELECT customer_id, terms_version_id, source FROM terms_acceptances
          WHERE tenant_id = ${tenant} ORDER BY accepted_at, id`,
    );

  const auditOf = (action: string) =>
    rows<{ result: string; entity_id: string | null; actor_id: string | null }>(
      sql`SELECT result, entity_id, actor_id FROM audit_logs
          WHERE tenant_id = ${tenantA.tenantId} AND action = ${action} ORDER BY occurred_at, id`,
    );

  const orderCount = async () =>
    Number(
      (
        await rows<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM orders WHERE tenant_id = ${tenantA.tenantId}`,
        )
      )[0]?.n,
    );

  async function product(): Promise<string> {
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    const created = await api.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-terms-create',
    });
    await validatePanelConnection(api.container, tenantA, created.view.panel.id);
    const products = new DrizzleProductRepository(api.container.database.db);
    const row = await products.create(tenantA, {
      id: api.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن قوانین',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: created.view.panel.id as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(200_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: api.container.clock.now(),
    });
    await products.setStatus(tenantA, row.id, 'INACTIVE', 'ACTIVE', api.container.clock.now());
    return row.id;
  }

  // =====================================================================================
  // The gate
  // =====================================================================================

  it('stops nobody while nothing is published, even with enforcement on', async () => {
    await enforce(true);
    const customer = user();
    await say(customer, '/start');
    expect(textOf(await say(customer, '/start'))).toEqual([WELCOME_BACK]);
    expect(await acceptances()).toEqual([]);
  });

  it('stops nobody while enforcement is off, even with a published version', async () => {
    await publish('قوانین', 'متن قوانین نسخهٔ یک');
    const customer = user();
    await say(customer, '/start');
    expect(textOf(await say(customer, '/start'))).toEqual([WELCOME_BACK]);
  });

  it('shows the current version with its accept button, then lets the customer through once accepted', async () => {
    const v1 = await publish('قوانین ربات', 'بند یک: استفادهٔ منصفانه.');
    await enforce(true);
    const customer = user();

    const first = await say(customer, '/start');
    expect(isTermsScreen(first, v1)).toBe(true);
    // The label comes from the inline-button registry, never from the callback.
    const markup = first[0]?.reply_markup as { inline_keyboard: { text: string }[][] };
    expect(markup.inline_keyboard.flat()[0]?.text).toBe(CATALOGUE_FA['bot.terms.accept_button']);

    // Batch 01 item 1: the tap EDITS the terms message it sits on — exactly one edit, of
    // THAT message, into the accepted text with the way to the main menu — and sends nothing.
    const screen = lastSentId();
    const accepted = await tapOn(customer, `ac:${v1.id}`, screen);
    expect(accepted.sends).toEqual([]);
    expect(accepted.edits).toHaveLength(1);
    expect(accepted.edits[0]?.messageId).toBe(screen);
    expect(textOf(accepted.edits.map((edit) => edit.body))).toEqual([ACCEPTED]);
    expect(ACCEPTED).toBe(
      '✅ قوانین و مقررات با موفقیت پذیرفته شد.\nاکنون می‌توانید از ربات استفاده کنید.',
    );
    // The accept button is gone from the message; the main menu is what is left on it.
    expect(dataOf(accepted.edits.map((edit) => edit.body))).toEqual(['mm:']);
    expect(await acceptances()).toEqual([
      { customer_id: await customerIdOf(customer), terms_version_id: v1.id, source: 'TELEGRAM' },
    ]);
    expect(textOf(await say(customer, '/start'))).toEqual([WELCOME_BACK]);

    // Audited once, as the customer's own fact, and announced in the same transaction.
    const audit = await auditOf('customer.terms_accept');
    expect(audit).toEqual([
      expect.objectContaining({ result: 'SUCCESS', entity_id: await customerIdOf(customer) }),
    ]);
    const events = await rows<{ payload: { termsVersionId: string; versionNumber: number } }>(
      sql`SELECT payload FROM outbox_messages WHERE tenant_id = ${tenantA.tenantId}
          AND event_type = 'CustomerTermsAccepted'`,
    );
    expect(events.map((event) => event.payload)).toEqual([
      { termsVersionId: v1.id, versionNumber: 1 },
    ]);
  });

  it('never asks again for the accepted version: not on later requests, not after a restart', async () => {
    // Batch 01 item 1, acceptance: "the next request does not repeat the terms", and
    // "restart / coming back must not bring the prompt back".
    const v1 = await publish('قوانین', 'نسخهٔ یک');
    await enforce(true);
    const customer = user();
    expect(isTermsScreen(await say(customer, '/start'), v1)).toBe(true);
    expect(await acceptOnScreen(customer, v1.id)).toEqual([ACCEPTED]);

    for (const turn of [
      () => say(customer, '/start'),
      () => say(customer, '/wallet'),
      () => tap(customer, 'mm:'),
      () => say(customer, '/start'),
    ]) {
      const replies = await turn();
      expect(replies.length).toBeGreaterThan(0);
      expect(dataOf(replies).some((data) => data?.startsWith('ac:') === true)).toBe(false);
      expect(textOf(replies).some((text) => text.includes('نسخهٔ یک'))).toBe(false);
    }
    // The main-menu button the accepted message carries brings the persistent menu.
    const menu = await tap(customer, 'mm:');
    expect(textOf(menu)).toEqual([WELCOME_BACK]);
    expect((menu[0]?.reply_markup as { keyboard?: unknown } | undefined)?.keyboard).toBeDefined();

    // A restart is a new process over the same database: the acceptance is a row, not memory.
    await api.close();
    api = await createApiApp(config);
    api.container.setInstallationTenant(tenantA.tenantId);
    expect(textOf(await say(customer, '/start'))).toEqual([WELCOME_BACK]);
    expect(await acceptances()).toHaveLength(1);
  });

  it('falls back to ONE new message when Telegram cannot edit the terms message, and never loops', async () => {
    const v1 = await publish('قوانین', 'نسخهٔ یک');
    await enforce(true);
    const customer = user();
    await say(customer, '/start');
    const screen = lastSentId();
    refuseEdits = true;

    const { sends, edits } = await tapOn(customer, `ac:${v1.id}`, screen);
    // The edit was tried on THAT message and refused; the same reply went out once.
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.every((edit) => edit.messageId === screen)).toBe(true);
    expect(textOf(sends)).toEqual([ACCEPTED]);
    expect(dataOf(sends)).toEqual(['mm:']);
    expect(await acceptances()).toHaveLength(1);

    // A message that IS editable but already says this is success, never a fallback.
    refuseEdits = false;
    const again = await tapOn(customer, `ac:${v1.id}`, lastSentId());
    expect(again.sends).toEqual([]);
    expect(textOf(again.edits.map((edit) => edit.body))).toEqual([ACCEPTED]);
    expect(await acceptances()).toHaveLength(1);
  });

  it('cannot be bypassed: every customer action meets the gate, and nothing runs behind it', async () => {
    const productId = await product();
    const v1 = await publish('قوانین', 'بدون پذیرش، هیچ خریدی ممکن نیست.');
    await enforce(true);
    const customer = user();

    for (const turn of [
      () => say(customer, '/start'),
      () => say(customer, '/catalog'),
      () => say(customer, '/wallet'),
      () => say(customer, 'any plain text'),
      () => tap(customer, `p:${productId}`),
      () => tap(customer, 'mm:'),
      () => tap(customer, 'mc:'),
      () => tap(customer, 'wo:'),
      () => tap(customer, 'co:'),
      // A crafted confirm for an order id, and one for a service action.
      () => tap(customer, `c:${api.container.ids.uuid()}`),
      () => tap(customer, `q:${api.container.ids.uuid()}`),
    ]) {
      expect(isTermsScreen(await turn(), v1)).toBe(true);
    }
    expect(await orderCount()).toBe(0);
    expect(await acceptances()).toEqual([]);

    // Support and help stay reachable, as at the membership gate.
    expect(isTermsScreen(await say(customer, '/paysupport'), v1)).toBe(false);
    expect(isTermsScreen(await say(customer, '/help'), v1)).toBe(false);

    // Accepting answers the main menu and never replays what was stopped; THEN it works.
    expect(isTermsScreen(await say(customer, '/start'), v1)).toBe(true);
    expect(await acceptOnScreen(customer, v1.id)).toEqual([ACCEPTED]);
    expect(await orderCount()).toBe(0);
    await tap(customer, `p:${productId}`);
    expect(await orderCount()).toBe(1);
  });

  it('asks again after a new publication, and never counts an older acceptance for it', async () => {
    const v1 = await publish('قوانین', 'نسخهٔ یک');
    await enforce(true);
    const customer = user();
    await say(customer, '/start');
    await tap(customer, `ac:${v1.id}`);
    expect(textOf(await say(customer, '/start'))).toEqual([WELCOME_BACK]);

    const v2 = await publish('قوانین جدید', 'نسخهٔ دو');
    expect(v2.versionNumber).toBe(2);
    // Publishing marked nobody: the customer who accepted v1 is stopped by v2.
    expect((await acceptances()).map((row) => row.terms_version_id)).toEqual([v1.id]);
    expect(isTermsScreen(await say(customer, '/start'), v2)).toBe(true);

    const overview = await api.container.terms.overview(tenantA, owner);
    expect(overview.acceptanceCounts.get(v2.id) ?? 0).toBe(0);
    expect(overview.acceptanceCounts.get(v1.id)).toBe(1);

    await tap(customer, `ac:${v2.id}`);
    expect(textOf(await say(customer, '/start'))).toEqual([WELCOME_BACK]);
  });

  it('answers a stale accept button with the version that replaced it, and records nothing', async () => {
    const v1 = await publish('قوانین', 'نسخهٔ یک');
    await enforce(true);
    const customer = user();
    expect(isTermsScreen(await say(customer, '/start'), v1)).toBe(true);
    const v2 = await publish('قوانین', 'نسخهٔ دو');

    // The button under the v1 message, tapped after v2 was published.
    // Batch 01 item 1: the SAME message is edited into v2 with v2's own button — the
    // customer is never left with two terms prompts, one of them dead.
    const screen = lastSentId();
    const { sends, edits } = await tapOn(customer, `ac:${v1.id}`, screen);
    expect(sends).toEqual([]);
    const stale = edits.map((edit) => edit.body);
    expect(edits.map((edit) => edit.messageId)).toEqual([screen]);
    expect(isTermsScreen(stale, v2)).toBe(true);
    expect(textOf(stale)[0]).toContain('به‌روزرسانی');
    expect(await acceptances()).toEqual([]);

    // An id that was never a version, and a malformed one: nothing recorded either.
    const crafted = await tapOn(customer, `ac:${api.container.ids.uuid()}`, screen);
    expect(
      isTermsScreen(
        crafted.edits.map((edit) => edit.body),
        v2,
      ),
    ).toBe(true);
    await tap(customer, 'ac:not-a-uuid');
    expect(await acceptances()).toEqual([]);
    expect(await auditOf('customer.terms_accept')).toEqual([]);
  });

  it('fits the longest version into one message under any accepted override, and answers a stored over-long one in parts', async () => {
    // Codex 4172817732: `{title}` and `{body}` add up to 3,620 characters, so an override
    // under the generic 4,096 ceiling could render to ~7,700 — past Telegram's bound.
    const title = 'ع'.repeat(TERMS_TITLE_MAX_LENGTH);
    const body = Array.from({ length: 2 }, () => 'ب'.repeat(1749)).join('\n\n');
    expect(body.length).toBe(TERMS_BODY_MAX_LENGTH);
    const v1 = await publish(title, body);
    await enforce(true);

    // The frame is bounded so that frame + the longest title + the longest body fit.
    const frame = (length: number) => {
      const head = '{icon:info} {title}\n\n{body}\n\n';
      return head + 'ق'.repeat(length - head.length);
    };
    const setFrame = (text: string) =>
      api.container.templatesService.set(tenantA, owner, {
        key: 'bot.terms.required',
        body: text,
        expectedVersion: null,
        expectedRevision: null,
        idempotencyKey: key(),
      });
    expect(await codeOf(setFrame(frame(TERMS_TEMPLATE_MAX_LENGTH + 1)))).toBe(
      'control.template_invalid',
    );
    await setFrame(frame(TERMS_TEMPLATE_MAX_LENGTH));
    const customer = user();
    const fits = await say(customer, '/start');
    expect(fits).toHaveLength(1);
    expect(textOf(fits)[0]?.length).toBeLessThanOrEqual(4096);
    expect(isTermsScreen(fits, v1)).toBe(true);

    // An override stored before the ceiling existed (or by a hand-written row) is still
    // ANSWERED: the messenger cuts it into parts within the bound, and the accept button
    // rides on the last one, so the customer is never left with nothing.
    await rows(
      sql`UPDATE template_overrides SET body = ${frame(4096)}
          WHERE tenant_id = ${tenantA.tenantId} AND template_key = 'bot.terms.required'`,
    );
    const parts = await say(customer, '/start');
    expect(parts.length).toBeGreaterThan(1);
    for (const text of textOf(parts)) expect(text.length).toBeLessThanOrEqual(4096);
    expect(dataOf(parts.slice(-1))).toEqual([`ac:${v1.id}`]);
    expect(dataOf(parts.slice(0, -1))).toEqual([]);
    const whole = textOf(parts).join('');
    expect(whole).toContain(title);
    for (const paragraph of body.split('\n\n')) expect(whole).toContain(paragraph);
    // And the button works from there: the last part, which carries it, is edited.
    expect(await acceptOnScreen(customer, v1.id)).toEqual([ACCEPTED]);
  });

  it('records a duplicate accept once, sequentially and concurrently', async () => {
    const v1 = await publish('قوانین', 'نسخهٔ یک');
    await enforce(true);
    const customer = user();
    await say(customer, '/start');
    const screen = lastSentId();

    // Two taps at once on the terms message, each its own update.
    calls = [];
    await Promise.all([
      webhook(BOT_A, tapUpdate(customer, `ac:${v1.id}`, screen)),
      webhook(BOT_A, tapUpdate(customer, `ac:${v1.id}`, screen)),
    ]);
    // And a third later, and Telegram redelivering one update twice.
    await webhook(BOT_A, tapUpdate(customer, `ac:${v1.id}`, screen));
    const third = calls.filter((call) => call.method === 'editMessageText').at(-1);
    const repeated = tapUpdate(customer, `ac:${v1.id}`, screen);
    const fixedId = (updateId += 1);
    for (let i = 0; i < 2; i += 1) {
      await inject({
        method: 'POST',
        url: `/telegram/webhook/${BOT_A}`,
        headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
        payload: { update_id: fixedId, ...repeated },
      });
    }

    /*
     * Batch 01 item 1: every one of the five turns answered by editing THE terms message
     * into the same accepted text — the first changed it, the rest were "not modified",
     * which is success — and not one of them sent a message. Each tap is still answered
     * (its spinner stopped), so the second tap is not left hanging.
     */
    expect(calls.filter((call) => call.method === 'sendMessage')).toEqual([]);
    expect(textOf(third === undefined ? [] : [third.body])).toEqual([ACCEPTED]);
    expect(
      new Set(calls.filter((call) => call.method === 'editMessageText').map((c) => c.messageId)),
    ).toEqual(new Set([screen]));
    expect((JSON.parse(shown.get(screen) ?? '[]') as unknown[])[0]).toBe(ACCEPTED);
    expect(calls.filter((call) => call.method === 'answerCallbackQuery')).toHaveLength(5);

    expect(await acceptances()).toHaveLength(1);
    expect(await auditOf('customer.terms_accept')).toHaveLength(1);
    const events = await rows<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM outbox_messages WHERE tenant_id = ${tenantA.tenantId}
          AND event_type = 'CustomerTermsAccepted'`,
    );
    expect(events[0]?.n).toBe('1');
  });

  it('keeps tenants apart: another tenant’s version, enforcement and acceptance count for nothing', async () => {
    const a1 = await publish('قوانین A', 'متن A');
    const b1 = await publish('قوانین B', 'متن B', tenantB);
    await enforce(true);
    await enforce(true, tenantB);
    const customer = user();

    // Tenant A's bot shows A's rules; B's version id tapped on A's bot is stale there.
    expect(isTermsScreen(await say(customer, '/start'), a1)).toBe(true);
    const crossed = await tapOn(customer, `ac:${b1.id}`, lastSentId());
    expect(
      isTermsScreen(
        crossed.edits.map((edit) => edit.body),
        a1,
      ),
    ).toBe(true);
    expect(await acceptances()).toEqual([]);
    expect(await acceptances(tenantB.tenantId)).toEqual([]);

    // Accepting on A's bot does not satisfy B's: the same Telegram user is two customers.
    await tap(customer, `ac:${a1.id}`);
    expect(isTermsScreen(await say(customer, '/start', BOT_B), b1)).toBe(true);
    expect(await acceptances(tenantB.tenantId)).toEqual([]);

    // The operator side: B cannot edit or publish A's rows, and does not see them.
    expect(
      await codeOf(
        api.container.terms.publish(tenantB, ownerB, {
          idempotencyKey: key(),
          id: a1.id,
          expectedRevision: a1.revision,
        }),
      ),
    ).toBe(TERMS_ERROR_CODES.TERMS_VERSION_NOT_FOUND);
    const overviewB = await api.container.terms.overview(tenantB, ownerB);
    expect(overviewB.history.map((row) => row.id)).toEqual([b1.id]);

    // And the database refuses an acceptance that names another tenant's version.
    const customerA = await customerIdOf(customer);
    await expect(
      rows(
        sql`INSERT INTO terms_acceptances
              (id, tenant_id, customer_id, terms_version_id, accepted_at, source, correlation_id)
            VALUES (${api.container.ids.uuid()}, ${tenantA.tenantId}, ${customerA}, ${b1.id},
                    now(), 'TELEGRAM', 'x')`,
      ),
    ).rejects.toThrow();
  });

  // =====================================================================================
  // The operator's side
  // =====================================================================================

  it('drafts, edits by revision, publishes with the next number, and keeps one draft', async () => {
    const draft = await api.container.terms.createDraft(tenantA, operator, {
      idempotencyKey: key(),
      title: 'پیش‌نویس',
      body: 'متن اول',
    });
    expect(draft).toMatchObject({ status: 'DRAFT', versionNumber: null, revision: 1 });
    expect(
      await codeOf(
        api.container.terms.createDraft(tenantA, operator, {
          idempotencyKey: key(),
          title: 'دومی',
          body: 'متن',
        }),
      ),
    ).toBe(TERMS_ERROR_CODES.TERMS_DRAFT_EXISTS);

    const edited = await api.container.terms.updateDraft(tenantA, operator, {
      idempotencyKey: key(),
      id: draft.id,
      title: 'پیش‌نویس',
      body: 'متن دوم',
      expectedRevision: 1,
    });
    expect(edited.revision).toBe(2);
    // The stale editor, and a publish of a revision nobody previewed.
    for (const work of [
      api.container.terms.updateDraft(tenantA, operator, {
        idempotencyKey: key(),
        id: draft.id,
        title: 'کهنه',
        body: 'کهنه',
        expectedRevision: 1,
      }),
      api.container.terms.publish(tenantA, owner, {
        idempotencyKey: key(),
        id: draft.id,
        expectedRevision: 1,
      }),
    ]) {
      expect(await codeOf(work)).toBe(TERMS_ERROR_CODES.TERMS_DRAFT_CONFLICT);
    }

    const publishKey = key();
    const published = await api.container.terms.publish(tenantA, owner, {
      idempotencyKey: publishKey,
      id: draft.id,
      expectedRevision: 2,
    });
    expect(published).toMatchObject({
      status: 'PUBLISHED',
      versionNumber: 1,
      body: 'متن دوم',
      publishedByUsername: 'owner-terms',
      createdByUsername: 'operator-terms',
    });
    // A replay answers the first result; a second publish of the same row is refused.
    expect(
      (
        await api.container.terms.publish(tenantA, owner, {
          idempotencyKey: publishKey,
          id: draft.id,
          expectedRevision: 2,
        })
      ).versionNumber,
    ).toBe(1);
    expect(
      await codeOf(
        api.container.terms.publish(tenantA, owner, {
          idempotencyKey: key(),
          id: draft.id,
          expectedRevision: 2,
        }),
      ),
    ).toBe(TERMS_ERROR_CODES.TERMS_VERSION_PUBLISHED);
    expect(
      await codeOf(
        api.container.terms.updateDraft(tenantA, owner, {
          idempotencyKey: key(),
          id: draft.id,
          title: 'x',
          body: 'y',
          expectedRevision: 2,
        }),
      ),
    ).toBe(TERMS_ERROR_CODES.TERMS_VERSION_PUBLISHED);

    // Audited, with the actor, and the publication announced.
    expect((await auditOf('terms.draft_create'))[0]).toMatchObject({
      result: 'SUCCESS',
      actor_id: operator.id,
    });
    expect(await auditOf('terms.draft_update')).toHaveLength(1);
    expect(await auditOf('terms.publish')).toEqual([
      expect.objectContaining({ result: 'SUCCESS', actor_id: owner.id, entity_id: draft.id }),
    ]);
    const events = await rows<{ aggregate_id: string }>(
      sql`SELECT aggregate_id FROM outbox_messages WHERE tenant_id = ${tenantA.tenantId}
          AND event_type = 'TermsVersionPublished'`,
    );
    expect(events.map((event) => event.aggregate_id)).toEqual([draft.id]);
  });

  it('publishes one of two racing publications of the same draft', async () => {
    const draft = await api.container.terms.createDraft(tenantA, owner, {
      idempotencyKey: key(),
      title: 'قوانین',
      body: 'متن',
    });
    const results = await Promise.allSettled([
      api.container.terms.publish(tenantA, owner, {
        idempotencyKey: key(),
        id: draft.id,
        expectedRevision: 1,
      }),
      api.container.terms.publish(tenantA, owner, {
        idempotencyKey: key(),
        id: draft.id,
        expectedRevision: 1,
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await auditOf('terms.publish')).toHaveLength(1);
  });

  it('answers a replayed acceptance of a since-superseded version as STALE with the current terms', async () => {
    // Codex 4172817728: the replay branch fell through into a new write that stored a
    // second result under the occupied key, and `rememberOnce` refused it as in-flight.
    const v1 = await publish('قوانین یک', 'متن یک');
    await enforce(true);
    const telegramUser = user();
    await say(telegramUser, '/start');
    const customerId = await customerIdOf(telegramUser);
    if (customerId === undefined) throw new Error('no customer');
    // The actor the Telegram surface accepts as (`BotRuntime.acceptTerms`).
    const system: ActorContext = {
      type: 'SYSTEM_JOB',
      id: null,
      label: 'telegram-update:test',
      surface: 'TELEGRAM',
      correlationId: 'terms-replay' as CorrelationId,
    };
    const input = {
      idempotencyKey: 'terms-replay-accept',
      customerId,
      termsVersionId: v1.id,
      botInstanceId: BOT_A,
    };
    const first = await api.container.termsAcceptance.accept(tenantA, system, input);
    expect(first).toMatchObject({ outcome: 'ACCEPTED', changed: true });

    const v2 = await publish('قوانین دو', 'متن دو');
    const replayed = await api.container.termsAcceptance.accept(tenantA, system, input);
    expect(replayed).toEqual({
      outcome: 'STALE',
      current: expect.objectContaining({ id: v2.id }) as unknown,
    });
    // Nothing new was written: the one acceptance is still of v1.
    expect(await acceptances()).toEqual([
      expect.objectContaining({ customer_id: customerId, terms_version_id: v1.id }),
    ]);
  });

  it('makes a published version and every acceptance immutable in the database', async () => {
    const v1 = await publish('قوانین', 'متن');
    await enforce(true);
    const customer = user();
    await say(customer, '/start');
    await tap(customer, `ac:${v1.id}`);
    for (const statement of [
      sql`UPDATE terms_versions SET body = 'rewritten' WHERE id = ${v1.id}`,
      sql`DELETE FROM terms_versions WHERE id = ${v1.id}`,
      sql`UPDATE terms_acceptances SET source = 'TELEGRAM'`,
      sql`DELETE FROM terms_acceptances`,
    ]) {
      await expect(rows(statement)).rejects.toThrow();
    }
    expect((await api.container.terms.overview(tenantA, owner)).history[0]?.body).toBe('متن');
  });

  it('charges terms.view, terms.edit and terms.publish, and audits a refused write', async () => {
    // Observer reads, writes nothing.
    await api.container.terms.overview(tenantA, observer);
    expect(
      await codeOf(
        api.container.terms.createDraft(tenantA, observer, {
          idempotencyKey: key(),
          title: 't',
          body: 'b',
        }),
      ),
    ).toMatch(/permission/u);
    // Operator drafts and edits, but publishing is the owner's.
    const draft = await api.container.terms.createDraft(tenantA, operator, {
      idempotencyKey: key(),
      title: 't',
      body: 'b',
    });
    expect(
      await codeOf(
        api.container.terms.publish(tenantA, operator, {
          idempotencyKey: key(),
          id: draft.id,
          expectedRevision: draft.revision,
        }),
      ),
    ).toMatch(/permission/u);
    expect(await auditOf('terms.publish')).toEqual([
      expect.objectContaining({ result: 'DENIED', actor_id: operator.id }),
    ]);
    expect(await auditOf('terms.draft_create')).toEqual([
      expect.objectContaining({ result: 'DENIED', actor_id: observer.id }),
      expect.objectContaining({ result: 'SUCCESS', actor_id: operator.id }),
    ]);
    // Nothing was published by the refusal.
    expect((await api.container.terms.overview(tenantA, owner)).history).toEqual([]);
  });

  // =====================================================================================
  // HTTP: the page and Customer 360
  // =====================================================================================

  it('serves the overview, the draft writes and Customer 360’s standing over HTTP', async () => {
    const login = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner-terms', password: 'the-owners-real-password' },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(login.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error('No session cookie.');
    const cookie = `${SESSION_COOKIE_NAME}=${match[1] as string}`;

    const created = await inject({
      method: 'POST',
      url: `${API_PREFIX}${TERMS_ROUTES.createDraft}`,
      headers: { cookie, origin: ORIGIN },
      payload: { idempotencyKey: key(), title: 'قوانین', body: 'متن قوانین' },
    });
    expect(created.statusCode).toBe(201);
    const draft = termsVersionWriteResponseSchema.parse(created.json()).version;
    const published = await inject({
      method: 'POST',
      url: `${API_PREFIX}${TERMS_ROUTES.publish(draft.id)}`,
      headers: { cookie, origin: ORIGIN },
      payload: { idempotencyKey: key(), expectedRevision: draft.revision },
    });
    expect(published.statusCode).toBe(201);
    await enforce(true);

    const customer = user();
    await say(customer, '/start');
    const customerId = await customerIdOf(customer);
    if (customerId === undefined) throw new Error('no customer');

    const overviewOf = async () =>
      customerOverviewResponseSchema.parse(
        (
          await inject({
            method: 'GET',
            url: `${API_PREFIX}${CUSTOMER_360_ROUTES.overview(customerId)}`,
            headers: { cookie },
          })
        ).json(),
      ).overview.terms;
    expect(await overviewOf()).toMatchObject({
      available: true,
      enforced: true,
      current: { versionId: draft.id, versionNumber: 1 },
      lastAccepted: null,
      acceptedCurrent: false,
      reacceptanceRequired: true,
    });

    await tap(customer, `ac:${draft.id}`);
    expect(await overviewOf()).toMatchObject({
      lastAccepted: { versionId: draft.id, versionNumber: 1 },
      acceptedCurrent: true,
      reacceptanceRequired: false,
    });

    const listed = await inject({
      method: 'GET',
      url: `${API_PREFIX}${TERMS_ROUTES.overview}`,
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    const overview = termsOverviewSchema.parse(listed.json());
    expect(overview).toMatchObject({
      enforcement: { enabled: true },
      current: { id: draft.id, current: true, acceptanceCount: 1, publishedBy: 'owner-terms' },
      draft: null,
      statistics: { customers: 1, acceptedCurrent: 1, pendingCurrent: 0 },
    });

    // A write from an origin the installation does not list is refused.
    const foreign = await inject({
      method: 'POST',
      url: `${API_PREFIX}${TERMS_ROUTES.createDraft}`,
      headers: { cookie, origin: 'https://evil.example' },
      payload: { idempotencyKey: key(), title: 't', body: 'b' },
    });
    expect(foreign.statusCode).toBe(403);
  });
});
