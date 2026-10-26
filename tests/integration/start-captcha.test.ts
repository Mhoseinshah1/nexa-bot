import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TELEGRAM_SECRET_TOKEN_HEADER,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  testConfig,
} from './harness';

/**
 * R10 D5 (a): the optional `/start` captcha for NEW customers, end to end.
 *
 * The real app over a real database; Telegram is a fake that records every call. Updates
 * arrive on the bot's authenticated webhook, so the gate is the production `guardedAct` path
 * and every answer is the production conditional write. Time is moved by moving the row's own
 * instants into the past, never by waiting.
 *
 * The rules under test, each a way to stop the wrong person or let the wrong one through:
 *
 * - only a customer CREATED while the flag is on is asked; nobody who existed before is;
 * - the right answer passes once, is audited, and greets with the main-menu keyboard;
 * - a wrong answer counts down, the last one starts a cooldown, and nothing ever blocks;
 * - an expired question and a stale or foreign tap cost nothing;
 * - administrators are never asked, and turning the flag off frees everybody at once;
 * - the mini app holds the same customer, and the referral is attributed as always.
 */

const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-the-captcha';

const customerActor = (): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: 'captcha-referral' as CorrelationId,
});
const BOT_A = SEED_IDS.botA1 as BotInstanceId;

interface Call {
  readonly method: string;
  readonly body: Record<string, unknown>;
  readonly messageId?: number;
}

interface CaptchaRow {
  readonly customer_id: string;
  readonly state: string;
  readonly challenge_id: string;
  readonly operand_a: number;
  readonly operand_b: number;
  readonly options: number[];
  readonly answer_index: number;
  readonly attempts: number;
  readonly locked_until: string | null;
}

describe('the /start captcha (R10 D5 a)', () => {
  let api: ApiApp;
  let telegram: Server;
  let calls: Call[] = [];
  let owner: ActorContext;
  let updateId = 610_000;
  let messageId = 6100;
  let nextUser = 861_000;
  let keys = 0;

  const key = () => `captcha-${String((keys += 1)).padStart(8, '0')}`;
  const user = () => (nextUser += 1);

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
        const id = (messageId += 1);
        calls.push({ method, body, messageId: id });
        // `getMe` names the bot, which the referral invite builds its link from.
        const result =
          method === 'getMe'
            ? { id: 7001, is_bot: true, username: 'captcha_store_bot' }
            : method === 'answerCallbackQuery' || method === 'editMessageText'
              ? true
              : { message_id: id };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const config = testConfig({
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    calls = [];
    owner = adminActorFor(
      await createAdmin(api.container, tenantA, { username: 'owner-captcha', roleKeys: ['owner'] }),
    );
  });

  // -------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------

  const db = () => api.container.database.db;

  async function rows<T>(query: SQL): Promise<T[]> {
    return ((await db().execute(query as never)) as unknown as { rows: T[] }).rows;
  }

  async function setFlag(flagKey: string, enabled: boolean) {
    const flags = await api.container.featureFlags.list(tenantA, owner);
    const current = flags.find((flag) => flag.key === flagKey);
    await api.container.featureFlags.set(tenantA, owner, {
      key: flagKey as never,
      enabled,
      expectedVersion: current?.version ?? null,
      idempotencyKey: key(),
    });
  }

  async function setSetting(settingKey: string, value: unknown) {
    const before = await api.container.settingsService.get(tenantA, owner, settingKey);
    await api.container.settingsService.set(tenantA, owner, {
      idempotencyKey: key(),
      key: settingKey,
      value,
      expectedVersion: before.version,
    });
  }

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  /** One update on the webhook, under `id` when given (a redelivery repeats it). */
  async function deliver(update: Record<string, unknown>, id = (updateId += 1)) {
    calls = [];
    await inject({
      method: 'POST',
      url: `/telegram/webhook/${BOT_A}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: { update_id: id, ...update },
    });
    return {
      sends: calls.filter((call) => call.method === 'sendMessage').map((call) => call.body),
      edits: calls.filter((call) => call.method === 'editMessageText').map((call) => call.body),
    };
  }

  const message = (from: number, text: string) => ({
    message: {
      message_id: (messageId += 1),
      date: 0,
      chat: { id: from, type: 'private' },
      from: { id: from, is_bot: false, first_name: 'Customer' },
      text,
    },
  });

  const tapUpdate = (from: number, data: string) => ({
    callback_query: {
      id: `cbq-${String((updateId += 1))}`,
      from: { id: from, is_bot: false, first_name: 'Customer' },
      chat_instance: 'ci',
      message: {
        message_id: (messageId += 1),
        date: 0,
        chat: { id: from, type: 'private' },
        from: { id: 999999, is_bot: true, first_name: 'Nexa' },
        text: 'x',
      },
      data,
    },
  });

  const say = (from: number, text: string) => deliver(message(from, text));
  const tap = (from: number, data: string) => deliver(tapUpdate(from, data));

  async function customerIdOf(telegramUserId: number): Promise<string> {
    const [row] = await rows<{ id: string }>(
      sql`SELECT id FROM customers WHERE tenant_id = ${tenantA.tenantId}
            AND telegram_user_id = ${String(telegramUserId)}`,
    );
    if (row === undefined) throw new Error('no customer');
    return row.id;
  }

  async function captchaOf(telegramUserId: number): Promise<CaptchaRow | null> {
    const [row] = await rows<CaptchaRow>(
      sql`SELECT c.customer_id, c.state, c.challenge_id, c.operand_a, c.operand_b, c.options,
                 c.answer_index, c.attempts, c.locked_until
            FROM customer_captchas c
            JOIN customers u ON u.tenant_id = c.tenant_id AND u.id = c.customer_id
           WHERE c.tenant_id = ${tenantA.tenantId}
             AND u.telegram_user_id = ${String(telegramUserId)}`,
    );
    return row ?? null;
  }

  async function captcha(telegramUserId: number): Promise<CaptchaRow> {
    const row = await captchaOf(telegramUserId);
    if (row === null) throw new Error('no captcha row');
    return row;
  }

  const answerData = (row: CaptchaRow, position: number) =>
    `hc:${row.challenge_id}:${String(position)}`;
  const right = (row: CaptchaRow) => answerData(row, row.answer_index);
  const wrong = (row: CaptchaRow) => answerData(row, (row.answer_index + 1) % 4);

  /** The question line exactly as the customer reads it. */
  const sum = (row: CaptchaRow) => `${String(row.operand_a)} + ${String(row.operand_b)} = ؟`;

  const audits = (action: string) =>
    rows<{ entity_id: string }>(
      sql`SELECT entity_id FROM audit_logs WHERE action = ${action} ORDER BY occurred_at, id`,
    );

  const statusOf = async (telegramUserId: number) =>
    (
      await rows<{ status: string }>(
        sql`SELECT status FROM customers WHERE tenant_id = ${tenantA.tenantId}
              AND telegram_user_id = ${String(telegramUserId)}`,
      )
    )[0]?.status;

  const replyKeyboardOf = (body: Record<string, unknown> | undefined) =>
    (body?.reply_markup as { keyboard?: unknown } | undefined)?.keyboard;

  const optionsOf = (body: Record<string, unknown> | undefined) =>
    (
      (body?.reply_markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined)
        ?.inline_keyboard ?? []
    )
      .flat()
      .map((button) => button.callback_data);

  // -------------------------------------------------------------------------------------
  // Who is asked
  // -------------------------------------------------------------------------------------

  it('asks a NEW customer the question at /start, with four answers and no main-menu keyboard', async () => {
    await setFlag('start_captcha', true);
    const customer = user();
    const { sends } = await say(customer, '/start');

    const row = await captcha(customer);
    expect(row.state).toBe('PENDING');
    expect(sends).toHaveLength(1);
    expect(String(sends[0]?.text)).toContain(sum(row));
    expect(optionsOf(sends[0])).toEqual([0, 1, 2, 3].map((p) => answerData(row, p)));
    expect(replyKeyboardOf(sends[0])).toBeUndefined();

    // Anything else they ask is answered with the same question, written nothing new.
    const again = await say(customer, '/wallet');
    expect(String(again.sends[0]?.text)).toContain(sum(row));
    expect((await captcha(customer)).challenge_id).toBe(row.challenge_id);
  });

  it('never asks a customer who existed before the switch, and asks nobody while it is off', async () => {
    const before = user();
    await say(before, '/start');
    expect(await captchaOf(before)).toBeNull();

    await setFlag('start_captcha', true);
    const { sends } = await say(before, '/start');
    // The greeting, with the keyboard: not held.
    expect(replyKeyboardOf(sends[0])).toBeDefined();
    expect(optionsOf(sends[0]).some((data) => data?.startsWith('hc:') === true)).toBe(false);
    expect(await captchaOf(before)).toBeNull();

    // A customer created while it is off is never asked either, even once it is back on.
    await setFlag('start_captcha', false);
    const whileOff = user();
    await say(whileOff, '/start');
    await setFlag('start_captcha', true);
    const later = await say(whileOff, '/start');
    expect(replyKeyboardOf(later.sends[0])).toBeDefined();
    expect(await captchaOf(whileOff)).toBeNull();
  });

  it('holds a PASSED customer never again, even when a row exists for them', async () => {
    // The gate holds a PENDING row, not "any row that is not PASSED": a stand-in for the
    // mutation that reads the gate from the absence of a pass.
    await setFlag('start_captcha', true);
    const customer = user();
    await say(customer, '/start');
    await tap(customer, right(await captcha(customer)));
    expect((await captcha(customer)).state).toBe('PASSED');
    const { sends } = await say(customer, '/start');
    expect(replyKeyboardOf(sends[0])).toBeDefined();
  });

  // -------------------------------------------------------------------------------------
  // The right answer
  // -------------------------------------------------------------------------------------

  it('passes on the right answer once, audits it, and greets with the main-menu keyboard; a redelivery writes nothing', async () => {
    await setFlag('start_captcha', true);
    const customer = user();
    await say(customer, '/start');
    const row = await captcha(customer);

    const update = tapUpdate(customer, right(row));
    const id = (updateId += 1);
    const { sends } = await deliver(update, id);

    expect((await captcha(customer)).state).toBe('PASSED');
    expect(await audits('customer.captcha_passed')).toEqual([
      { entity_id: await customerIdOf(customer) },
    ]);
    // The first-contact greeting, with the reply keyboard it alone attaches.
    expect(sends).toHaveLength(1);
    expect(replyKeyboardOf(sends[0])).toBeDefined();

    // The same update again: answered, and nothing new written.
    await deliver(update, id);
    expect(await audits('customer.captcha_passed')).toHaveLength(1);
    expect((await captcha(customer)).state).toBe('PASSED');
  });

  // -------------------------------------------------------------------------------------
  // Wrong answers, the cooldown, and never a block
  // -------------------------------------------------------------------------------------

  it('counts wrong answers down, cools down at the limit, never blocks, and asks anew afterwards', async () => {
    await setFlag('start_captcha', true);
    const customer = user();
    await say(customer, '/start');

    const first = await captcha(customer);
    const one = await tap(customer, wrong(first));
    const second = await captcha(customer);
    expect(second.attempts).toBe(1);
    expect(second.challenge_id).not.toBe(first.challenge_id);
    // The question message is edited into the count and the NEW question.
    expect(one.sends).toEqual([]);
    expect(String(one.edits[0]?.text)).toContain(sum(second));
    expect(String(one.edits[0]?.text)).toContain('2 فرصت');

    await tap(customer, wrong(second));
    const third = await captcha(customer);
    expect(third.attempts).toBe(2);

    const locked = await tap(customer, wrong(third));
    const cooling = await captcha(customer);
    expect(cooling.state).toBe('PENDING');
    expect(cooling.attempts).toBe(0);
    expect(cooling.locked_until).not.toBeNull();
    expect(String(locked.edits[0]?.text)).toContain('10 دقیقه');
    expect(optionsOf(locked.edits[0])).toEqual([]);
    expect(await audits('customer.captcha_locked')).toHaveLength(1);

    // NEVER a block: the customer row is untouched and nobody is told.
    expect(await statusOf(customer)).toBe('ACTIVE');

    // Every turn during the cooldown gets the cooldown, and an answer changes nothing.
    const during = await say(customer, '/start');
    expect(String(during.sends[0]?.text)).toContain('دقیقه');
    await tap(customer, right(cooling));
    expect((await captcha(customer)).state).toBe('PENDING');
    expect(await statusOf(customer)).toBe('ACTIVE');

    // After it, a new question, the count from zero, and it can be passed.
    await db().execute(
      sql`UPDATE customer_captchas SET locked_until = now() - interval '1 second'
            WHERE customer_id = ${await customerIdOf(customer)}`,
    );
    const after = await say(customer, '/start');
    const fresh = await captcha(customer);
    expect(fresh.locked_until).toBeNull();
    expect(fresh.attempts).toBe(0);
    expect(fresh.challenge_id).not.toBe(cooling.challenge_id);
    expect(String(after.sends[0]?.text)).toContain(sum(fresh));
    await tap(customer, right(fresh));
    expect((await captcha(customer)).state).toBe('PASSED');
    expect(await statusOf(customer)).toBe('ACTIVE');
  });

  it('honours the configured number of attempts', async () => {
    await setSetting('captcha.max_attempts', 1);
    await setFlag('start_captcha', true);
    const customer = user();
    await say(customer, '/start');
    await tap(customer, wrong(await captcha(customer)));
    expect((await captcha(customer)).locked_until).not.toBeNull();
  });

  // -------------------------------------------------------------------------------------
  // Answers that cost nothing
  // -------------------------------------------------------------------------------------

  it('asks anew on an answer to an EXPIRED question, without counting it', async () => {
    await setFlag('start_captcha', true);
    const customer = user();
    await say(customer, '/start');
    const old = await captcha(customer);
    await db().execute(
      sql`UPDATE customer_captchas
             SET issued_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
           WHERE customer_id = ${await customerIdOf(customer)}`,
    );

    // Even the right answer to an expired question does not pass, and a wrong one is free.
    const expired = await tap(customer, wrong(old));
    const renewed = await captcha(customer);
    expect(renewed.state).toBe('PENDING');
    expect(renewed.attempts).toBe(0);
    expect(renewed.challenge_id).not.toBe(old.challenge_id);
    expect(String(expired.edits[0]?.text)).toContain(sum(renewed));

    await tap(customer, right(renewed));
    expect((await captcha(customer)).state).toBe('PASSED');
  });

  it('changes nothing for a tap on an OLD question, even at the current right position', async () => {
    await setFlag('start_captcha', true);
    const customer = user();
    await say(customer, '/start');
    const first = await captcha(customer);
    await tap(customer, wrong(first));
    const current = await captcha(customer);

    // The old question's id with the position the CURRENT question's answer sits at.
    const stale = await tap(customer, answerData(first, current.answer_index));
    const after = await captcha(customer);
    expect(after.state).toBe('PENDING');
    expect(after.attempts).toBe(current.attempts);
    expect(after.challenge_id).toBe(current.challenge_id);
    // Answered with the current question, unchanged.
    expect(String(stale.edits[0]?.text)).toContain(sum(current));
    expect(await audits('customer.captcha_passed')).toEqual([]);

    // And a well-formed id that was never anybody's question, the same.
    await tap(customer, `hc:01900000-0000-7000-8000-00000000dead:${String(current.answer_index)}`);
    expect(await captcha(customer)).toMatchObject({
      state: 'PENDING',
      attempts: current.attempts,
      challenge_id: current.challenge_id,
    });
  });

  // -------------------------------------------------------------------------------------
  // Who is never held
  // -------------------------------------------------------------------------------------

  it('never holds a bound administrator', async () => {
    await setFlag('start_captcha', true);
    const adminUser = user();
    await createAdmin(api.container, tenantA, {
      username: 'bound-captcha-admin',
      roleKeys: ['owner'],
      telegramUserId: String(adminUser),
    });
    const { sends } = await say(adminUser, '/start');
    // Created while the flag is on, so the row exists — and the binding lets them through.
    expect((await captcha(adminUser)).state).toBe('PENDING');
    expect(replyKeyboardOf(sends[0])).toBeDefined();
    expect(optionsOf(sends[0]).some((data) => data?.startsWith('hc:') === true)).toBe(false);
  });

  it('frees every waiting customer at once when the flag goes off, and holds them again when it is back', async () => {
    await setFlag('start_captcha', true);
    const customer = user();
    await say(customer, '/start');
    expect((await captcha(customer)).state).toBe('PENDING');

    await setFlag('start_captcha', false);
    const off = await say(customer, '/start');
    expect(replyKeyboardOf(off.sends[0])).toBeDefined();
    // Freed without a write: the row is as it was.
    expect((await captcha(customer)).state).toBe('PENDING');

    await setFlag('start_captcha', true);
    const on = await say(customer, '/start');
    expect(String(on.sends[0]?.text)).toContain(sum(await captcha(customer)));
  });

  // -------------------------------------------------------------------------------------
  // The mini app, and the referral
  // -------------------------------------------------------------------------------------

  it('holds the same customer in the mini app, which refuses to sell to them', async () => {
    await setFlag('start_captcha', true);
    const customer = user();
    await say(customer, '/start');
    const customerId = (await customerIdOf(customer)) as UserId;
    const record = await api.container.customers.get(tenantA, owner, customerId);
    const context = {
      scope: { tenantId: tenantA.tenantId, botInstanceId: BOT_A },
      botInstanceId: BOT_A,
      sessionId: 'session',
      customer: record,
      telegramUserId: String(customer),
    };
    const correlationId = 'captcha-miniapp' as CorrelationId;
    const sessions = api.container.miniApp.sessions;
    expect(await sessions.gateFor(context, correlationId)).toEqual({ kind: 'CAPTCHA' });
    await expect(sessions.assertUngated(context, correlationId)).rejects.toMatchObject({
      code: 'miniapp.gate_required',
    });

    await tap(customer, right(await captcha(customer)));
    expect(await sessions.gateFor(context, correlationId)).toBeNull();
  });

  it('still attributes the referral a held customer arrived through', async () => {
    await setSetting('referral.commission_percent', 10);
    await setFlag('referrals', true);
    const referrer = user();
    await say(referrer, '/start');
    const referrerId = await customerIdOf(referrer);
    const invited = await api.container.referrals.invite(tenantA, customerActor(), {
      idempotencyKey: key(),
      customerId: referrerId,
      botInstanceId: BOT_A,
    });
    if (invited.outcome !== 'READY') throw new Error(`no code: ${invited.outcome}`);

    await setFlag('start_captcha', true);
    const referee = user();
    await say(referee, `/start ref-${invited.code}`);
    expect((await captcha(referee)).state).toBe('PENDING');
    expect(
      await rows<{ referrer_id: string }>(
        sql`SELECT referrer_id FROM referrals WHERE tenant_id = ${tenantA.tenantId}
              AND referee_id = ${await customerIdOf(referee)}`,
      ),
    ).toEqual([{ referrer_id: referrerId }]);
  });
});
