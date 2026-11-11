import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MINIAPP_API_PREFIX,
  MINIAPP_ROUTES,
  TELEGRAM_SECRET_TOKEN_HEADER,
  miniAppPath,
  type ActorContext,
  type BotInstanceId,
} from '@nexa/contracts';
import type { ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  createApiApp,
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  testConfig,
} from './harness';

/**
 * `captcha.kind`: the picture, emoji and number-in-words questions, and RANDOM, end to end.
 *
 * The real app over a real database; Telegram is a fake that records every call. Updates
 * arrive on the bot's authenticated webhook, so the gate is the production `guardedAct` path
 * and every answer is the production conditional write. Time is moved by moving the row's own
 * instants into the past, never by waiting.
 *
 * The rules under test: a kind is asked as set and a PENDING question keeps it; the picture is
 * sent as a photo with the answer nowhere but the row; a typed answer is normalised; a wrong one
 * spends an attempt, a new picture does not (three per question); emoji and number-in-words are
 * answered on buttons; RANDOM reaches every kind; the mini app serves the picture only to a
 * session and judges the same typed answer.
 */

const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-the-captcha';

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_TOKEN = '000000:seed-token-acme-1';

/** One multipart field of a photo upload: its text value, and its file name when it is a file. */
interface Photo {
  readonly caption: string;
  readonly replyMarkup: string;
  readonly fileName: string | null;
  readonly bytes: Buffer;
}

/** A `sendPhoto` request taken apart: the PNG, its fixed file name, the caption, the buttons. */
function photoOf(call: Call): Photo {
  const field = (name: string): { value: string; fileName: string | null } => {
    const match = new RegExp(
      `name="${name}"(?:; filename="([^"]*)")?\\r\\n(?:[A-Za-z-]+: [^\\r]*\\r\\n)*\\r\\n([\\s\\S]*?)\\r\\n--`,
      'u',
    ).exec(call.raw);
    return { value: match?.[2] ?? '', fileName: match?.[1] ?? null };
  };
  const utf8 = (latin1: string) => Buffer.from(latin1, 'latin1').toString('utf8');
  const file = field('photo');
  return {
    caption: utf8(field('caption').value),
    replyMarkup: utf8(field('reply_markup').value),
    fileName: file.fileName,
    bytes: Buffer.from(file.value, 'latin1'),
  };
}

/** The buttons' callback data of a photo's inline keyboard. */
const photoButtons = (photo: Photo): string[] =>
  (
    JSON.parse(photo.replyMarkup || '{"inline_keyboard":[]}') as {
      inline_keyboard: { callback_data?: string }[][];
    }
  ).inline_keyboard
    .flat()
    .map((button) => button.callback_data ?? '');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PERSIAN = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
const ARABIC = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
const asDigits = (text: string, table: string[]) =>
  [...text].map((digit) => table[Number(digit)]).join('');

function initDataFor(user: { id: number; first_name: string }): string {
  const fields: Record<string, string> = {
    query_id: `q-${String(user.id)}-${String(Math.random()).slice(2, 10)}`,
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const check = Object.keys(fields)
    .sort()
    .map((name) => `${name}=${fields[name]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

interface Call {
  readonly method: string;
  readonly body: Record<string, unknown>;
  readonly messageId?: number;
  /** The request exactly as it arrived (a photo is multipart, not JSON), as latin1 text. */
  readonly raw: string;
}

interface CaptchaRow {
  readonly customer_id: string;
  readonly state: string;
  readonly challenge_id: string;
  readonly kind: string;
  readonly operand_a: number;
  readonly operand_b: number;
  readonly options: (number | string)[];
  readonly answer_index: number;
  readonly answer_text: string | null;
  readonly refreshes: number;
  readonly attempts: number;
  readonly locked_until: string | null;
}

describe('the /start captcha kinds (captcha.kind)', () => {
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
        calls.push({
          method,
          body,
          messageId: id,
          raw: Buffer.concat(chunks).toString('latin1'),
        });
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
      photos: calls.filter((call) => call.method === 'sendPhoto').map(photoOf),
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
      sql`SELECT c.customer_id, c.state, c.challenge_id, c.kind, c.operand_a, c.operand_b, c.options,
                 c.answer_index, c.answer_text, c.refreshes, c.attempts, c.locked_until
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
  // Helpers of this file
  // -------------------------------------------------------------------------------------

  const setKind = (kind: string) => setSetting('captcha.kind', kind);
  const refreshData = (row: CaptchaRow) => `hc:${row.challenge_id}:r`;
  const expire = async (telegramUserId: number) =>
    db().execute(
      sql`UPDATE customer_captchas
             SET issued_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
           WHERE customer_id = ${await customerIdOf(telegramUserId)}`,
    );

  /** A new customer asked a question of `kind`, with the first turn's reply. */
  async function asked(kind: string) {
    await setFlag('start_captcha', true);
    await setKind(kind);
    const customer = user();
    const turn = await say(customer, '/start');
    return { customer, turn, row: await captcha(customer) };
  }

  // -------------------------------------------------------------------------------------
  // MATH stays the default
  // -------------------------------------------------------------------------------------

  it('asks the sum when nothing is set: MATH is the default and exactly the old question', async () => {
    await setFlag('start_captcha', true);
    const customer = user();
    const { sends, photos } = await say(customer, '/start');
    const row = await captcha(customer);
    expect(row).toMatchObject({ kind: 'MATH', answer_text: null, refreshes: 0 });
    expect(photos).toEqual([]);
    expect(String(sends[0]?.text)).toContain(sum(row));
    expect(optionsOf(sends[0])).toEqual([0, 1, 2, 3].map((p) => answerData(row, p)));
  });

  // -------------------------------------------------------------------------------------
  // IMAGE_NUMBER
  // -------------------------------------------------------------------------------------

  it('sends the picture as a PNG photo, keeps the answer in the row only, and never writes a file', async () => {
    const { turn, row } = await asked('IMAGE_NUMBER');
    expect(row).toMatchObject({
      kind: 'IMAGE_NUMBER',
      state: 'PENDING',
      options: [],
      refreshes: 0,
    });
    expect(row.answer_text).toMatch(/^[1-9][0-9]{3}$/u);

    // A photo and nothing else: no text message, no answer buttons.
    expect(turn.sends).toEqual([]);
    expect(turn.photos).toHaveLength(1);
    const photo = turn.photos[0] as Photo;
    expect(photo.bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(photo.bytes.readUInt32BE(16)).toBe(320);
    expect(photo.bytes.readUInt32BE(20)).toBe(120);
    expect(photo.caption).toContain('عدد 4 رقمی');
    // The only button is «🔄 تصویر جدید», carrying the question id and `r`.
    expect(photoButtons(photo)).toEqual([refreshData(row)]);

    // The answer is nowhere a customer or Telegram could read it but the stored row: not in
    // the callback data, the caption, the keyboard, nor in the file's name.
    const answer = row.answer_text as string;
    expect(photo.replyMarkup).not.toContain(answer);
    expect(photo.caption).not.toContain(answer);
    expect(photo.fileName).toBe('captcha.png');
    expect(photo.fileName).not.toContain(answer);
    expect(replyKeyboardOf(undefined)).toBeUndefined();
  });

  it('passes on the typed answer in Latin, Persian or Arabic-Indic digits, spaces and all', async () => {
    for (const spell of [
      (digits: string) => digits,
      (digits: string) => asDigits(digits, PERSIAN),
      (digits: string) => asDigits(digits, ARABIC),
      (digits: string) => ` ${[...asDigits(digits, PERSIAN)].join(' ')} `,
    ]) {
      const { customer, row } = await asked('IMAGE_NUMBER');
      const { sends } = await say(customer, spell(row.answer_text as string));
      expect((await captcha(customer)).state).toBe('PASSED');
      // The greeting, with the main-menu keyboard it alone attaches.
      expect(replyKeyboardOf(sends[0])).toBeDefined();
    }
    expect(await audits('customer.captcha_passed')).toHaveLength(4);
  });

  it('spends an attempt on a wrong typed number, asks a NEW picture, and cools down at the limit', async () => {
    const { customer, row } = await asked('IMAGE_NUMBER');
    const wrongNumber = (r: CaptchaRow) => String(((Number(r.answer_text) + 1) % 9000) + 1000);

    const one = await say(customer, wrongNumber(row));
    const second = await captcha(customer);
    expect(second.attempts).toBe(1);
    expect(second.challenge_id).not.toBe(row.challenge_id);
    expect(one.photos).toHaveLength(1);
    expect((one.photos[0] as Photo).caption).toContain('2 فرصت');
    expect(photoButtons(one.photos[0] as Photo)).toEqual([refreshData(second)]);

    await say(customer, wrongNumber(second));
    const third = await captcha(customer);
    expect(third.attempts).toBe(2);

    const locked = await say(customer, wrongNumber(third));
    const cooling = await captcha(customer);
    expect(cooling.state).toBe('PENDING');
    expect(cooling.locked_until).not.toBeNull();
    expect(String(locked.sends[0]?.text)).toContain('10 دقیقه');
    expect(locked.photos).toEqual([]);
    expect(await statusOf(customer)).toBe('ACTIVE');

    // During the cooldown even the right answer changes nothing.
    await say(customer, cooling.answer_text as string);
    expect((await captcha(customer)).state).toBe('PENDING');

    // After it: a new question, the count from zero, and it can be passed.
    await db().execute(
      sql`UPDATE customer_captchas SET locked_until = now() - interval '1 second'
            WHERE customer_id = ${await customerIdOf(customer)}`,
    );
    const after = await say(customer, 'سلام');
    const fresh = await captcha(customer);
    expect(fresh).toMatchObject({ attempts: 0, locked_until: null, kind: 'IMAGE_NUMBER' });
    expect(fresh.challenge_id).not.toBe(cooling.challenge_id);
    expect(after.photos).toHaveLength(1);
    await say(customer, fresh.answer_text as string);
    expect((await captcha(customer)).state).toBe('PASSED');
  });

  it('does not spend an attempt on text that is not four digits, and shows the same picture again', async () => {
    const { customer, row } = await asked('IMAGE_NUMBER');
    for (const text of ['سلام', '12', '12345', 'abcd', '/wallet']) {
      const turn = await say(customer, text);
      expect(await captcha(customer), text).toMatchObject({
        attempts: 0,
        challenge_id: row.challenge_id,
        state: 'PENDING',
      });
      expect(turn.photos, text).toHaveLength(1);
    }
    // The picture is drawn again from the row: the same one every time.
    const again = (await say(customer, 'hello')).photos[0] as Photo;
    const first = (await say(customer, 'hello')).photos[0] as Photo;
    expect(again.bytes.equals(first.bytes)).toBe(true);
  });

  it('asks anew on a typed answer to an EXPIRED question, without counting it', async () => {
    const { customer, row } = await asked('IMAGE_NUMBER');
    await expire(customer);
    // Even the right digits to an expired question do not pass, and a wrong one is free.
    const turn = await say(customer, row.answer_text as string);
    const renewed = await captcha(customer);
    expect(renewed).toMatchObject({ state: 'PENDING', attempts: 0, kind: 'IMAGE_NUMBER' });
    expect(renewed.challenge_id).not.toBe(row.challenge_id);
    expect((turn.photos[0] as Photo).caption).toContain('تمام شده');
    await say(customer, renewed.answer_text as string);
    expect((await captcha(customer)).state).toBe('PASSED');
  });

  it('swaps the picture on «🔄 تصویر جدید» without spending an attempt, three times per question', async () => {
    const { customer, row } = await asked('IMAGE_NUMBER');
    // One wrong answer first, so "no attempt spent" is visible against a count above zero.
    await say(customer, String(((Number(row.answer_text) + 1) % 9000) + 1000));
    let current = await captcha(customer);
    expect(current.attempts).toBe(1);

    const seen = new Set([current.challenge_id]);
    for (let swap = 1; swap <= 3; swap += 1) {
      const turn = await tap(customer, refreshData(current));
      const next = await captcha(customer);
      expect(next.challenge_id).not.toBe(current.challenge_id);
      expect(next.attempts).toBe(1);
      expect(next.refreshes).toBe(swap);
      expect(turn.photos).toHaveLength(1);
      // The button goes with the last swap.
      expect(photoButtons(turn.photos[0] as Photo)).toEqual(swap < 3 ? [refreshData(next)] : []);
      seen.add(next.challenge_id);
      current = next;
    }
    expect(seen.size).toBe(4);

    // The fourth is refused: nothing changes and the same question is shown.
    const fourth = await tap(customer, refreshData(current));
    expect(await captcha(customer)).toMatchObject({
      challenge_id: current.challenge_id,
      refreshes: 3,
      attempts: 1,
    });
    expect(photoButtons(fourth.photos[0] as Photo)).toEqual([]);

    // A wrong answer starts a NEW question, with its own three swaps.
    await say(customer, String(((Number(current.answer_text) + 1) % 9000) + 1000));
    expect(await captcha(customer)).toMatchObject({ refreshes: 0, attempts: 2 });
  });

  it('refuses a refresh of an OLD picture, of a MATH question, and a foreign id, changing nothing', async () => {
    const { customer, row } = await asked('IMAGE_NUMBER');
    await tap(customer, refreshData(row));
    const current = await captcha(customer);
    await tap(customer, refreshData(row));
    expect(await captcha(customer)).toMatchObject({
      challenge_id: current.challenge_id,
      refreshes: 1,
    });
    await tap(customer, 'hc:01900000-0000-7000-8000-00000000dead:r');
    expect((await captcha(customer)).challenge_id).toBe(current.challenge_id);

    await setKind('MATH');
    const other = user();
    await say(other, '/start');
    const mathRow = await captcha(other);
    await tap(other, refreshData(mathRow));
    expect(await captcha(other)).toMatchObject({
      challenge_id: mathRow.challenge_id,
      kind: 'MATH',
      refreshes: 0,
    });
  });

  // -------------------------------------------------------------------------------------
  // EMOJI and WORD_NUMBER
  // -------------------------------------------------------------------------------------

  it('EMOJI: names the item in the text, offers four different emoji, and judges the tapped one', async () => {
    const { customer, turn, row } = await asked('EMOJI');
    expect(row).toMatchObject({ kind: 'EMOJI', answer_text: null });
    expect(new Set(row.options).size).toBe(4);
    const rightEmoji = String(row.options[row.answer_index]);
    const text = String(turn.sends[0]?.text);
    expect(text).toContain('روی');
    expect(text).not.toContain(rightEmoji);
    const labels = (
      turn.sends[0]?.reply_markup as { inline_keyboard: { text: string }[][] }
    ).inline_keyboard
      .flat()
      .map((button) => button.text);
    expect(labels).toEqual(row.options.map(String));
    expect(optionsOf(turn.sends[0])).toEqual([0, 1, 2, 3].map((p) => answerData(row, p)));

    const miss = await tap(customer, wrong(row));
    const second = await captcha(customer);
    expect(second).toMatchObject({ attempts: 1, kind: 'EMOJI' });
    expect(String(miss.edits[0]?.text)).toContain('2 فرصت');
    await tap(customer, right(second));
    expect((await captcha(customer)).state).toBe('PASSED');
  });

  it('WORD_NUMBER: writes the number in words and offers Latin-digit buttons, one wrong sharing a digit', async () => {
    const { customer, turn, row } = await asked('WORD_NUMBER');
    expect(row).toMatchObject({ kind: 'WORD_NUMBER', answer_text: null });
    const options = row.options as number[];
    const answer = options[row.answer_index] as number;
    expect(String(turn.sends[0]?.text)).toMatch(/[؀-ۿ]/u);
    const labels = (
      turn.sends[0]?.reply_markup as { inline_keyboard: { text: string }[][] }
    ).inline_keyboard
      .flat()
      .map((button) => button.text);
    expect(labels).toEqual(options.map(String));
    const digits = (n: number) => [Math.floor(n / 10), n % 10];
    expect(
      options.some(
        (option) => option !== answer && digits(option).some((d) => digits(answer).includes(d)),
      ),
    ).toBe(true);

    await tap(customer, wrong(row));
    expect(await captcha(customer)).toMatchObject({ attempts: 1, kind: 'WORD_NUMBER' });
    await tap(customer, right(await captcha(customer)));
    expect((await captcha(customer)).state).toBe('PASSED');
  });

  // -------------------------------------------------------------------------------------
  // RANDOM, and a kind change
  // -------------------------------------------------------------------------------------

  it('RANDOM: new questions reach every one of the four kinds', async () => {
    await setFlag('start_captcha', true);
    await setKind('RANDOM');
    for (let i = 0; i < 60; i += 1) await say(user(), '/start');
    const kinds = await rows<{ kind: string }>(
      sql`SELECT DISTINCT kind FROM customer_captchas WHERE tenant_id = ${tenantA.tenantId}`,
    );
    expect(kinds.map((row) => row.kind).sort()).toEqual([
      'EMOJI',
      'IMAGE_NUMBER',
      'MATH',
      'WORD_NUMBER',
    ]);
  });

  it('keeps the kind a PENDING question was asked with when the setting changes', async () => {
    const { customer, row } = await asked('IMAGE_NUMBER');
    await setKind('EMOJI');
    // The pending picture is still a picture, still shown as one and still answerable.
    const turn = await say(customer, 'سلام');
    expect(await captcha(customer)).toMatchObject({
      kind: 'IMAGE_NUMBER',
      challenge_id: row.challenge_id,
    });
    expect(turn.photos).toHaveLength(1);
    await say(customer, row.answer_text as string);
    expect((await captcha(customer)).state).toBe('PASSED');

    // And the other way round: a pending sum is still a sum after a switch to pictures.
    await setKind('MATH');
    const other = user();
    await say(other, '/start');
    const sumRow = await captcha(other);
    await setKind('IMAGE_NUMBER');
    await tap(other, right(sumRow));
    expect((await captcha(other)).state).toBe('PASSED');

    // A NEW question after a wrong answer follows the setting as it is now.
    await setKind('EMOJI');
    const third = user();
    await setKind('MATH');
    await say(third, '/start');
    const pending = await captcha(third);
    await setKind('EMOJI');
    await tap(third, wrong(pending));
    expect(await captcha(third)).toMatchObject({ kind: 'EMOJI', attempts: 1 });
  });

  // -------------------------------------------------------------------------------------
  // The mini app
  // -------------------------------------------------------------------------------------

  describe('the mini app', () => {
    const route = (name: keyof typeof MINIAPP_ROUTES) =>
      `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES[name])}`;

    async function sessionFor(telegramUserId: number): Promise<string> {
      const response = await inject({
        method: 'POST',
        url: `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.session, { botInstanceId: BOT_A })}`,
        payload: { initData: initDataFor({ id: telegramUserId, first_name: 'مشتری' }) },
      });
      expect(response.statusCode, response.body).toBe(201);
      return (JSON.parse(response.body) as { token: string }).token;
    }
    const authed = (token: string) => ({ authorization: `Bearer ${token}` });
    const post = (token: string, name: keyof typeof MINIAPP_ROUTES, payload: unknown = {}) =>
      inject({
        method: 'POST',
        url: route(name),
        headers: { ...authed(token), 'idempotency-key': key() },
        payload,
      });

    beforeEach(async () => {
      await setFlag('mini_app', true);
    });

    it('refuses the picture without a session, and serves it to the session of the held customer, never cached', async () => {
      const { customer, row } = await asked('IMAGE_NUMBER');
      const bare = await inject({ method: 'GET', url: route('captchaImage') });
      expect(bare.statusCode).toBe(401);
      expect(bare.rawPayload.subarray(0, 4).toString('latin1')).not.toBe('\u0089PNG');
      const forged = await inject({
        method: 'GET',
        url: route('captchaImage'),
        headers: authed('not-a-session'),
      });
      expect(forged.statusCode).toBe(401);

      const token = await sessionFor(customer);
      const image = await inject({
        method: 'GET',
        url: route('captchaImage'),
        headers: authed(token),
      });
      expect(image.statusCode).toBe(200);
      expect(image.headers['content-type']).toBe('image/png');
      expect(String(image.headers['cache-control'])).toContain('no-store');
      expect(image.rawPayload.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      // The same picture the bot sent, drawn again from the row, and one customer's only.
      const sent = await asked('IMAGE_NUMBER');
      expect(sent.row.challenge_id).not.toBe(row.challenge_id);

      const me = await inject({ method: 'GET', url: route('me'), headers: authed(token) });
      expect(JSON.parse(me.body).gate).toEqual({
        kind: 'CAPTCHA',
        question: { kind: 'IMAGE_NUMBER', state: 'CURRENT', refreshesLeft: 3 },
      });
    });

    it('has no picture for a customer who is not held at one: a sum, a passed customer, nobody', async () => {
      await setFlag('start_captcha', true);
      const customer = user();
      await say(customer, '/start');
      const token = await sessionFor(customer);
      const math = await inject({
        method: 'GET',
        url: route('captchaImage'),
        headers: authed(token),
      });
      expect(math.statusCode).toBe(404);

      await tap(customer, right(await captcha(customer)));
      const passed = await inject({
        method: 'GET',
        url: route('captchaImage'),
        headers: authed(token),
      });
      expect(passed.statusCode).toBe(404);
    });

    it('judges the typed digits as the chat does: wrong spends an attempt, a swap does not, right opens the gate', async () => {
      const { customer, row } = await asked('IMAGE_NUMBER');
      const token = await sessionFor(customer);
      const bad = String(((Number(row.answer_text) + 1) % 9000) + 1000);

      const wrongAnswer = JSON.parse((await post(token, 'captchaAnswer', { text: bad })).body);
      expect(wrongAnswer).toMatchObject({ result: 'WRONG', remaining: 2 });
      const second = await captcha(customer);
      expect(second.attempts).toBe(1);
      expect(second.challenge_id).not.toBe(row.challenge_id);

      const swapped = JSON.parse((await post(token, 'captchaRefresh')).body);
      expect(swapped).toMatchObject({ result: 'REFRESHED' });
      expect(await captcha(customer)).toMatchObject({ attempts: 1, refreshes: 1 });

      const current = await captcha(customer);
      const passed = JSON.parse(
        (
          await post(token, 'captchaAnswer', {
            text: asDigits(current.answer_text as string, PERSIAN),
          })
        ).body,
      );
      expect(passed.result).toBe('PASSED');
      expect(passed.me.gate).toBeNull();
      expect((await captcha(customer)).state).toBe('PASSED');
    });

    it('renews an expired picture on a refresh, and refuses a malformed body', async () => {
      const { customer, row } = await asked('IMAGE_NUMBER');
      const token = await sessionFor(customer);
      await expire(customer);
      const me = JSON.parse(
        (await inject({ method: 'GET', url: route('me'), headers: authed(token) })).body,
      );
      expect(me.gate.question.state).toBe('EXPIRED');
      const renewed = JSON.parse((await post(token, 'captchaRefresh')).body);
      expect(renewed.result).toBe('RENEWED');
      expect((await captcha(customer)).challenge_id).not.toBe(row.challenge_id);
      expect(renewed.me.gate.question.state).toBe('CURRENT');

      const bad = await post(token, 'captchaAnswer', { text: '' });
      expect(bad.statusCode).toBe(400);
    });
  });
});
