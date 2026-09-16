import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAIN_MENU_BUTTONS, TELEGRAM_SECRET_TOKEN_HEADER } from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import {
  CUSTOMER_SEND_FAILED_CODE,
  CUSTOMER_SEND_OK_CODE,
} from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { migrateOnce, resetDatabase, tenantA, testConfig } from './harness';

/**
 * The customer-facing Telegram turn, end to end.
 *
 * Against a REAL socket standing in for Telegram, not a stubbed `fetch`. Two of
 * the rules under test are about WHEN the send happens relative to the commit,
 * and a stub cannot witness that ordering honestly: it would assert the test's
 * own idea of it. The fake records every request with the moment it arrived, so
 * "the fact committed before the reply went out" is a measurement.
 *
 * What the turn must do, and each way it could be wrong:
 *
 *   - create the customer on first `/start`, and NOT a second time on the next
 *     one — the legacy bot has no idempotency anywhere, so a redelivered update
 *     there is indistinguishable from a second visit;
 *   - never let a profile refresh touch `status`, because a block any customer
 *     could lift by typing `/start` is not a block;
 *   - commit the fact and only then send, because a send inside the transaction
 *     can be rolled back after Telegram has delivered;
 *   - keep a failed reply from rolling back the fact, because the customer
 *     exists whether or not they were greeted.
 */

const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-the-turn';
const BOT_A = SEED_IDS.botA1;
/** The tenant's SECOND bot, so a per-bot rule can be told from a per-tenant one. */
const BOT_A2 = SEED_IDS.botA2;
const BOT_B = SEED_IDS.botB1;

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly at: number;
}

describe('the customer Telegram turn', () => {
  let api: ApiApp;
  let telegram: Server;
  let sent: Sent[];
  /** What the fake answers. Replaced per test for the failure cases. */
  let reply: (request: IncomingMessage, response: ServerResponse) => void;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    sent = [];
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        // An unparseable body is RECORDED rather than dropped: a case asserting that
        // no send happened must be able to tell "nothing was sent" from "something was
        // sent and the fake could not read it".
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = { unparseable: raw };
        }
        sent.push({ url: request.url ?? '', body, at: Date.now() });
        reply(request, response);
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');

    const config = testConfig({
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      // `http://` loopback, which the config schema allows outside production
      // and refuses in it — the bot token is in the request path.
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  });

  afterAll(async () => {
    await api?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    sent = [];
    reply = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
    };
  });

  let updateId = 1000;
  const start = (
    options: {
      bot?: string;
      from?: Record<string, unknown>;
      text?: string;
      chatType?: string;
      update?: number;
      /** Sends an update with NO `from` at all — the one case a default hides. */
      omitFrom?: boolean;
    } = {},
  ) => {
    const id = options.update ?? (updateId += 1);
    return inject({
      method: 'POST',
      url: `/telegram/webhook/${options.bot ?? BOT_A}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: {
        update_id: id,
        message: {
          message_id: id,
          date: 0,
          chat: { id: 4242, type: options.chatType ?? 'private' },
          ...(options.omitFrom === true
            ? {}
            : { from: options.from ?? { id: 5551234567, is_bot: false, first_name: 'Ali' } }),
          text: options.text ?? '/start',
        },
      },
    });
  };

  const customers = async (where = sql`TRUE`) =>
    (
      await api.container.database.db.execute(sql`
        SELECT id, tenant_id, telegram_user_id, username, first_name, status, blocked_reason,
               first_seen_at, last_seen_at
          FROM customers WHERE ${where} ORDER BY created_at ASC`)
    ).rows as Record<string, unknown>[];

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  it('creates the customer on a first /start, and greets them as new', async () => {
    const response = await start({ from: { id: 5551234567, is_bot: false, username: 'ali' } });
    expect(response.statusCode).toBe(201);

    const rows = await customers();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['telegram_user_id']).toBe('5551234567');
    expect(rows[0]?.['username']).toBe('ali');
    expect(rows[0]?.['tenant_id']).toBe(SEED_IDS.tenantA);
    expect(rows[0]?.['status']).toBe('ACTIVE');

    // The reply went out, to the chat the update named, and the chat id is a
    // NUMBER in the Telegram body rather than the customer's internal uuid.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain('/sendMessage');
    // A STRING chat id, which is what Telegram accepts and what the notification
    // transport has always sent: `textMessageBody` takes `chatId: string`, so
    // there is one spelling rather than one per caller.
    expect(sent[0]?.body['chat_id']).toBe('4242');
    /*
     * The EXACT rendered text, from the shared catalogue.
     *
     * Asserting merely that something was sent cannot tell one template from
     * another, which is how the blocked-reply rule came to have no integration
     * test: a mutation that made every arrival answer with the welcome survived
     * sixteen green cases. The text is read from `CATALOGUE_FA` rather than
     * copied, so a wording change moves both sides at once while a WRONG KEY
     * still fails.
     */
    expect(sent[0]?.body['text']).toBe(CATALOGUE_FA['bot.start.welcome']);

    // And a domain event exists for the registration, written inside the
    // business transaction.
    const events = await api.container.database.db.execute(
      sql`SELECT event_type FROM outbox_messages WHERE event_type = 'CustomerRegistered'`,
    );
    expect(events.rows).toHaveLength(1);
  });

  it('attaches the persistent main menu to the welcome, and nothing else to it', async () => {
    /*
     * Real v0.2.0 staging acceptance found the gap this closes: five commands were
     * registered with Telegram and an ordinary customer still had to know to type a
     * slash. The keyboard is what a customer meets instead.
     *
     * Asserted on the WIRE, because everything between the runtime and Telegram is a
     * place the markup can be dropped: this is the payload the real `textMessageBody`
     * built and the real messenger sent.
     */
    await start();

    const markup = sent[0]?.body['reply_markup'] as
      | {
          keyboard?: { text: string }[][];
          resize_keyboard?: boolean;
          is_persistent?: boolean;
          one_time_keyboard?: boolean;
          inline_keyboard?: unknown;
        }
      | undefined;
    expect(markup, 'the welcome carried no keyboard at all').toBeDefined();
    expect(markup?.keyboard?.map((row) => row.map((button) => button.text))).toEqual([
      [CATALOGUE_FA['bot.menu.catalog'], CATALOGUE_FA['bot.menu.services']],
      [CATALOGUE_FA['bot.menu.wallet'], CATALOGUE_FA['bot.menu.help']],
    ]);
    // A REPLY keyboard, not an inline one: it carries no `callback_data`, which is why
    // it grants no authority and why a tap arrives as ordinary text.
    expect(markup?.inline_keyboard, 'the menu was drawn as an inline keyboard').toBeUndefined();
    expect(markup?.resize_keyboard).toBe(true);
    expect(markup?.is_persistent).toBe(true);
    // Never one-shot. Hiding the menu after a single tap is what made the bot feel
    // command-driven, which is the thing staging acceptance objected to.
    expect(markup?.one_time_keyboard).toBe(false);

    // Exactly the four this release can perform. A Phase 7 button here would be a
    // promise the product cannot keep.
    expect(MAIN_MENU_BUTTONS).toHaveLength(4);
  });

  it('draws no menu for a BLOCKED customer', async () => {
    // `bot.blocked` returns before the menu is attached. Drawing a customer a menu they
    // may not use is the untruthful surface this codebase keeps refusing.
    await start();
    await api.container.database.db.execute(
      sql`UPDATE customers SET status = 'BLOCKED', blocked_at = now()
          WHERE telegram_user_id = '5551234567'`,
    );
    sent = [];

    await start();

    expect(sent[0]?.body['text']).toBe(CATALOGUE_FA['bot.blocked']);
    expect(sent[0]?.body['reply_markup']).toBeUndefined();
  });

  it('greets a RETURNING customer differently, and creates no second row', async () => {
    await start();
    const first = (await customers())[0] as Record<string, unknown>;
    sent = [];

    await start();
    const rows = await customers();
    // One row, same id. Two rows here would be the whole customer model broken.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['id']).toBe(first['id']);

    expect(sent).toHaveLength(1);
    // A DIFFERENT greeting, named. This is the only externally visible difference
    // between `FIRST_SEEN` and `RETURNING`, and the reason `created` has to be a
    // fact about the statement rather than a guess.
    expect(sent[0]?.body['text']).toBe(CATALOGUE_FA['bot.start.welcome_back']);
    expect(sent[0]?.body['text']).not.toBe(CATALOGUE_FA['bot.start.welcome']);
    const registrations = await api.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'CustomerRegistered'`,
    );
    expect((registrations.rows[0] as { n: number }).n).toBe(1);
  });

  it('treats a REDELIVERED update as a replay: one row, one reply', async () => {
    // Telegram retries any update it did not get a 200 for, and it is the same
    // `update_id` each time.
    const id = (updateId += 1);
    await start({ update: id });
    await start({ update: id });

    expect(await customers()).toHaveLength(1);

    /*
     * ONE of every DURABLE effect, and TWO replies. Both halves asserted, because
     * the second is a decision and an undocumented decision gets "fixed".
     *
     * `resolveFromUpdate` is idempotent, so the row, the audit row, the
     * registration event and `last_seen_at` happen once however many times
     * Telegram delivers. The reply cannot join them: `sendMessage` has no
     * idempotency key, so the choice is a duplicate greeting or a missing one —
     * and Telegram redelivers precisely when it did not see a 200, which includes
     * the turn that committed and never sent. `bot-runtime.ts` states the
     * reasoning and names what would change it.
     */
    const registrations = await api.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'CustomerRegistered'`,
    );
    expect((registrations.rows[0] as { n: number }).n).toBe(1);
    const audits = await api.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'customer.registered'`,
    );
    expect((audits.rows[0] as { n: number }).n).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it('lets two CONCURRENT first contacts produce one customer and no failure', async () => {
    /*
     * Two different updates from the same person at the same moment — a double
     * tap on Start. Both want to create; the upsert's `ON CONFLICT (tenant_id,
     * telegram_user_id) DO UPDATE` means one inserts and the other takes the
     * update branch and reports `created: false`.
     *
     * A read-then-write would have both read nothing, both insert, and the loser
     * surface a unique violation on a path that must answer 200 — which makes
     * Telegram retry it for ever.
     */
    const [a, b] = await Promise.all([
      start({ update: (updateId += 1) }),
      start({ update: (updateId += 1) }),
    ]);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(await customers()).toHaveLength(1);
    // Both turns replied, because both are real updates from a real person.
    expect(sent).toHaveLength(2);
  });

  it('lets two CONCURRENT deliveries of ONE update produce one effect', async () => {
    const id = (updateId += 1);
    const [a, b] = await Promise.all([start({ update: id }), start({ update: id })]);
    // Neither is an error: a replay is a success.
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(await customers()).toHaveLength(1);
    const registrations = await api.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'CustomerRegistered'`,
    );
    // ONE registration event. `rememberOnce` makes the losing insert a conflict,
    // so the loser's whole transaction rolls back rather than writing a second
    // event beside the first.
    expect((registrations.rows[0] as { n: number }).n).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The profile refresh
  // -------------------------------------------------------------------------

  it('refreshes the profile and last_seen_at on a later contact', async () => {
    await start({ from: { id: 5551234567, is_bot: false, username: 'old', first_name: 'Ali' } });
    const before = (await customers())[0] as Record<string, unknown>;

    await start({ from: { id: 5551234567, is_bot: false, username: 'new', first_name: 'Ali R' } });
    const after = (await customers())[0] as Record<string, unknown>;

    expect(after['username']).toBe('new');
    expect(after['first_name']).toBe('Ali R');
    // `first_seen_at` is set once. It is the one fact a refresh must not move —
    // an operator reading it is answering "how long have they been a customer".
    expect(String(after['first_seen_at'])).toBe(String(before['first_seen_at']));
  });

  it('replies with the blocked text when the REPLAYED update predates the block', async () => {
    /*
     * The arrival is recomputed from the row, never read back from the stored reply.
     *
     * A replay answers from the idempotency record, which holds the arrival as it
     * was when the update was first handled — `FIRST_SEEN` or `RETURNING`. If the
     * operator blocks the customer in between and Telegram then redelivers that
     * same update, answering from the stored arrival greets a blocked customer with
     * the welcome text. The replay must re-read status and let BLOCKED outrank the
     * arrival it remembered.
     */
    const id = (updateId += 1);
    await start({ update: id });
    const row = (await customers())[0] as Record<string, unknown>;
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body['text']).toBe(CATALOGUE_FA['bot.start.welcome']);

    await api.container.database.db.execute(sql`
      UPDATE customers
         SET status = 'BLOCKED', blocked_at = now(), blocked_reason = 'blocked after the turn'
       WHERE id = ${row['id'] as string}`);
    sent = [];

    // The SAME update_id, so this is the replay path and not a fresh contact.
    const response = await start({ update: id });
    expect(response.statusCode).toBe(201);
    // One row still, and still blocked: the replay writes nothing.
    const after = await customers();
    expect(after).toHaveLength(1);
    expect(after[0]?.['status']).toBe('BLOCKED');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.body['text']).toBe(CATALOGUE_FA['bot.blocked']);
    expect(sent[0]?.body['text']).not.toBe(CATALOGUE_FA['bot.start.welcome']);
    expect(sent[0]?.body['text']).not.toBe(CATALOGUE_FA['bot.start.welcome_back']);
  });

  it('does NOT unblock a blocked customer on /start, and replies with the blocked text', async () => {
    await start();
    const row = (await customers())[0] as Record<string, unknown>;
    await api.container.database.db.execute(sql`
      UPDATE customers
         SET status = 'BLOCKED', blocked_at = now(), blocked_reason = 'operator note'
       WHERE id = ${row['id'] as string}`);
    sent = [];
    const blockedReply = (await customers())[0] as Record<string, unknown>;
    expect(blockedReply['status']).toBe('BLOCKED');

    await start({ from: { id: 5551234567, is_bot: false, username: 'renamed' } });
    const after = (await customers())[0] as Record<string, unknown>;

    // STILL BLOCKED. `status` is absent from the upsert's DO UPDATE list, so
    // there is no path here that could lift it — and a block any customer could
    // lift by typing `/start` is not a block.
    expect(after['status']).toBe('BLOCKED');
    expect(after['blocked_reason']).toBe('operator note');
    // The metadata was still refreshed, deliberately: an operator looking at a
    // blocked account wants the name it is using now.
    expect(after['username']).toBe('renamed');

    /*
     * One reply, and it is `bot.blocked` — asserted by its TEXT.
     *
     * This case previously asserted only that one message went out and that it
     * did not contain the operator note. Both stayed true when `replyFor`'s
     * BLOCKED branch was removed, so the rule "BLOCKED outranks every intent"
     * had no integration test at all: the blocked customer was greeted with
     * `bot.start.welcome_back` and sixteen cases stayed green. Found by mutation,
     * which is the only thing that finds it.
     */
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body['text']).toBe(CATALOGUE_FA['bot.blocked']);
    expect(sent[0]?.body['text']).not.toBe(CATALOGUE_FA['bot.start.welcome_back']);
    // And it carries no operator note: `blockedReason` is an operator field and
    // `bot.blocked` declares no placeholder for it.
    expect(String(sent[0]?.body['text'] ?? '')).not.toContain('operator note');
  });

  // -------------------------------------------------------------------------
  // Ordering: commit, then send
  // -------------------------------------------------------------------------

  it('commits the customer BEFORE the reply leaves, and sends outside the transaction', async () => {
    /*
     * Measured rather than asserted by construction.
     *
     * The fake records the instant each request arrives, and the handler reads
     * the database AT THAT MOMENT. If the send were inside the transaction the
     * row would not be visible to this separate connection yet — so finding it
     * is the proof that the commit came first.
     *
     * This is also what `assertOutsideTransaction` enforces from the other side:
     * a send inside the transaction can be rolled back after Telegram has
     * delivered, and the customer then has a message about something that does
     * not exist.
     */
    let visibleWhenSent: number | null = null;
    reply = (_request, response) => {
      void api.container.database.db
        .execute(sql`SELECT count(*)::int AS n FROM customers`)
        .then((result) => {
          visibleWhenSent = (result.rows[0] as { n: number }).n;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, result: { message_id: 12 } }));
        });
    };

    await start();
    expect(sent).toHaveLength(1);
    expect(visibleWhenSent, 'the customer was not committed before the reply was sent').toBe(1);
  });

  it('keeps the customer when the reply FAILS, and still answers Telegram 200', async () => {
    // Telegram is down, or the token is wrong. The customer exists either way:
    // rolling the row back would mean the next `/start` created them again and
    // greeted them as new, for ever, while Telegram stayed broken.
    reply = (_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, description: 'Internal Server Error' }));
    };

    const response = await start();
    // 200-class, because a non-2xx makes Telegram retry this update for ever and
    // the update was handled.
    expect(response.statusCode).toBe(201);
    expect(await customers()).toHaveLength(1);

    // The refusal was RECORDED rather than swallowed: an operator has to be able
    // to see that replies are failing.
    const events = await api.container.database.db.execute(
      sql`SELECT code FROM operational_events WHERE code LIKE 'telegram.customer_send%'`,
    );
    expect(events.rows.length).toBeGreaterThan(0);
  });

  it('still answers 200 when the reply CANNOT be classified', async () => {
    // A 2xx whose body stops mid-JSON: Telegram very likely delivered it, and it
    // is recorded as unobserved rather than as failed.
    reply = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":tr');
    };
    const response = await start();
    expect(response.statusCode).toBe(201);
    expect(await customers()).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // The send-failure condition: opens, closes, and can open AGAIN
  // -------------------------------------------------------------------------

  /** Every send condition this tenant has, newest state and all. */
  const sendEvents = async () =>
    (
      await api.container.database.db.execute(sql`
        SELECT code, severity, dedupe_key, occurrence_count, resolved_at, context
          FROM operational_events
         WHERE code IN (${CUSTOMER_SEND_FAILED_CODE}, ${CUSTOMER_SEND_OK_CODE})
         ORDER BY first_seen_at ASC, code ASC`)
    ).rows as Record<string, unknown>[];

  const failWith = (status: number, description: string) => {
    reply = (_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, description }));
    };
  };

  it('collapses every kind of send failure for one bot onto ONE condition row', async () => {
    // A 500 (retryable, so the outcome is UNKNOWN) and then a 400 (permanent, so
    // REFUSED). These used to be two codes, `_unknown` and `_refused`, each keyed
    // by its Telegram error code — which is how one bot accumulated a row per
    // distinct error and a recovery could name none of them.
    failWith(500, 'Internal Server Error');
    await start();
    failWith(400, 'Bad Request: chat not found');
    await start({ from: { id: 777000111, is_bot: false, first_name: 'Sara' } });

    const rows = await sendEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['code']).toBe(CUSTOMER_SEND_FAILED_CODE);
    expect(rows[0]?.['dedupe_key']).toBe(`${CUSTOMER_SEND_FAILED_CODE}:${BOT_A}`);
    expect(Number(rows[0]?.['occurrence_count'])).toBe(2);
    expect(rows[0]?.['resolved_at']).toBeNull();
    // The kind is in the CONTEXT, which the recorder rewrites per occurrence, so
    // the open row says why it failed MOST RECENTLY rather than first.
    const context = rows[0]?.['context'] as Record<string, unknown>;
    expect(context['reason']).toBe('REFUSED');
    expect(context['botInstanceId']).toBe(BOT_A);
  });

  it('resolves the condition on the next successful reply, and REOPENS it on the next failure', async () => {
    /*
     * The property Codex found missing, and the reason it matters.
     *
     * `operational-event-projector.ts` returns early for an occurrence that is
     * neither new nor reopened. So a condition nothing ever resolves is announced
     * exactly once, for ever: the first transient Telegram hiccup opened the row,
     * and a genuine outage three weeks later was folded onto it silently. The
     * three-way assertion below — open, resolved, open again with a higher count —
     * is what a recovery has to produce for the NEXT failure to be seen at all.
     */
    failWith(502, 'Bad Gateway');
    await start();
    const opened = await sendEvents();
    expect(opened).toHaveLength(1);
    expect(opened[0]?.['resolved_at']).toBeNull();

    // Telegram comes back. The default `reply` is a success.
    reply = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: 12 } }));
    };
    await start({ from: { id: 777000222, is_bot: false, first_name: 'Nima' } });

    const recovered = await sendEvents();
    expect(recovered).toHaveLength(2);
    const failure = recovered.find((row) => row['code'] === CUSTOMER_SEND_FAILED_CODE);
    const recovery = recovered.find((row) => row['code'] === CUSTOMER_SEND_OK_CODE);
    expect(failure?.['resolved_at']).not.toBeNull();
    // The recovery is one-shot: no dedupe key, so it never needs closing itself.
    expect(recovery?.['dedupe_key']).toBeNull();
    expect(recovery?.['severity']).toBe('INFO');

    // And now the failure can be SEEN again. Same row, reopened, counter advanced —
    // which is what makes the projector announce it a second time.
    failWith(502, 'Bad Gateway');
    await start({ from: { id: 777000333, is_bot: false, first_name: 'Reza' } });
    const again = await sendEvents();
    const reopened = again.find((row) => row['code'] === CUSTOMER_SEND_FAILED_CODE);
    expect(reopened?.['resolved_at']).toBeNull();
    expect(Number(reopened?.['occurrence_count'])).toBe(2);
  });

  it('writes NO recovery when no condition is open, so the log is not a send log', async () => {
    // Three ordinary, successful replies. A recovery on every success would make
    // `operational_events` grow by a row per customer message — or, deduplicated,
    // funnel every reply for a bot through one `FOR UPDATE`-locked row.
    await start();
    await start({ from: { id: 777000444, is_bot: false, first_name: 'Mina' } });
    await start({ from: { id: 777000555, is_bot: false, first_name: 'Omid' } });
    expect(sent).toHaveLength(3);
    expect(await sendEvents()).toHaveLength(0);
  });

  it('resolves only the BOT whose reply succeeded, not every bot in the tenant', async () => {
    // Two bots in ONE tenant, so the narrowing under test is the dedupe key and
    // not the tenant. `recoversCode` alone resolves every open row of that code in
    // the scope, and one bot coming back would then mark the other's condition
    // resolved — an operator's unresolved list emptying itself of a bot nobody
    // had fixed.
    await api.container.database.db.execute(
      sql`UPDATE bot_instances SET status = 'ACTIVE' WHERE id = ${BOT_A2}`,
    );

    // BOTH bots are failing, which is what makes the narrowing observable: with
    // only one open row there is nothing a too-broad recovery could also resolve.
    failWith(502, 'Bad Gateway');
    await start({ bot: BOT_A });
    await start({ bot: BOT_A2, from: { id: 777000666, is_bot: false, first_name: 'Hana' } });
    expect(await sendEvents()).toHaveLength(2);

    // Only BOT_A comes back.
    reply = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: 13 } }));
    };
    await start({ bot: BOT_A, from: { id: 777000777, is_bot: false, first_name: 'Kian' } });

    const rows = await sendEvents();
    const open = rows.filter(
      (row) => row['code'] === CUSTOMER_SEND_FAILED_CODE && row['resolved_at'] === null,
    );
    expect(open).toHaveLength(1);
    expect(open[0]?.['dedupe_key'], "the recovery resolved the other bot's condition as well").toBe(
      `${CUSTOMER_SEND_FAILED_CODE}:${BOT_A2}`,
    );
    // Exactly one recovery, and it is BOT_A's.
    const recoveries = rows.filter((row) => row['code'] === CUSTOMER_SEND_OK_CODE);
    expect(recoveries).toHaveLength(1);
    expect((recoveries[0]?.['context'] as Record<string, unknown>)['botInstanceId']).toBe(BOT_A);
  });

  // -------------------------------------------------------------------------
  // Tenancy and scope activity
  // -------------------------------------------------------------------------

  it('keeps the same Telegram id in two tenants as two customers', async () => {
    await start({ bot: BOT_A });
    await start({ bot: BOT_B });

    const rows = await customers(sql`telegram_user_id = '5551234567'`);
    expect(rows).toHaveLength(2);
    // One per tenant, and the ids differ. A globally unique Telegram id would
    // have made the second update a conflict and handed tenant B tenant A's
    // customer — a cross-tenant read through an ordinary `/start`.
    expect(new Set(rows.map((row) => row['tenant_id'])).size).toBe(2);
    expect(new Set(rows.map((row) => row['id'])).size).toBe(2);
  });

  it('writes nothing and sends nothing for an INACTIVE bot instance', async () => {
    await api.container.database.db.execute(
      sql`UPDATE bot_instances SET status = 'DISABLED' WHERE id = ${BOT_A}`,
    );
    const response = await start();
    // Refused at the edge, before the bot id is trusted for anything.
    expect(response.statusCode).toBe(404);
    expect(await customers()).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('writes nothing and sends nothing for an INACTIVE tenant', async () => {
    await api.container.database.db.execute(
      // `STOPPED`, from `TENANT_STATUSES`. The CHECK constraint is built from the
      // contract enum, so a status this product does not declare is refused by the
      // database — which is how the first version of this line was caught.
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${SEED_IDS.tenantA}`,
    );
    const response = await start();
    expect(response.statusCode).toBe(404);
    expect(await customers()).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Sender identity
  // -------------------------------------------------------------------------

  it('creates no customer for an update with no usable sender', async () => {
    /*
     * `null` is the MISSING-`from` case, not `undefined`.
     *
     * `start` spreads its options over a default `from`, so `from: undefined`
     * quietly fell back to the valid sender and the case asserted the opposite of
     * what it claimed — a customer WAS created and the test caught itself only
     * because the count was then 1. The sentinel is explicit now.
     */
    for (const from of [
      null,
      { id: '5551234567', is_bot: false },
      { id: 1.5, is_bot: false },
      { id: -1, is_bot: false },
      { id: 0, is_bot: false },
      // A BOT. A bot is not a customer, and the legacy system has no concept of
      // the distinction at all.
      { id: 777000111, is_bot: true },
    ]) {
      sent = [];
      const label = JSON.stringify(from);
      const response = await start({
        update: (updateId += 1),
        ...(from === null ? { omitFrom: true } : { from: from as Record<string, unknown> }),
      });
      // 200-class: an update with no customer behind it is not an error, and a
      // non-2xx would have Telegram retry it for ever.
      expect(response.statusCode, label).toBe(201);
      expect(await customers(), label).toHaveLength(0);
      expect(sent, label).toHaveLength(0);
    }
  });

  it('does not reply outside a private chat, but still records the customer', async () => {
    const response = await start({ chatType: 'group' });
    expect(response.statusCode).toBe(201);
    // The customer is a fact — they wrote to this bot — and the reply is not
    // sent, because a bot answering every `/start` in a group is the legacy
    // bot's behaviour and an operator cannot switch it off.
    expect(await customers()).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it('answers an UNSUPPORTED message without pretending to understand it', async () => {
    const response = await start({ text: 'سلام، قیمت چنده؟' });
    expect(response.statusCode).toBe(201);
    expect(await customers()).toHaveLength(1);
    // One reply, and it is the FALLBACK rather than the welcome — named, for the
    // same reason the blocked case is.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body['text']).toBe(CATALOGUE_FA['bot.unknown_command']);
  });
});
