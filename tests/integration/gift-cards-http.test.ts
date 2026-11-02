import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  COMMERCE_ERROR_CODES,
  GIFT_CARD_CODE_ALPHABET,
  GIFT_CARD_CODE_GROUP_SIZE,
  GIFT_CARD_CODE_LENGTH,
  GIFT_CARD_ROUTES,
  MINIAPP_API_PREFIX,
  MINIAPP_ROUTES,
  SESSION_COOKIE_NAME,
  giftCardBatchListResponseSchema,
  giftCardBatchResponseSchema,
  miniAppGiftCardResponseSchema,
  miniAppPath,
  miniAppWalletResponseSchema,
  type ActorContext,
  type FeatureFlagKey,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  SEED_IDS,
  tenantA,
  testConfig,
} from './harness';

/**
 * R10 D4 — gift cards over HTTP: the Web Admin's batch routes (authentication here, every
 * permission charged by the service) and the mini app's redemption route. Synthetic data only.
 *
 * - the create answers the batch and never a code; the CSV is an attachment, no-store, nosniff;
 * - an operator without the keys gets 403 on every write and on the download;
 * - the mini app draws the field only while the flag is on, redeems through the same service as
 *   the bot, and answers one REJECTED for a used code.
 */

const ORIGIN = 'https://admin.example.test';
const TOKEN_A1 = '000000:seed-token-acme-1';
const HOUR = 60 * 60 * 1000;

/** Telegram's own signer, independently of the verifier. */
function initDataFor(user: { id: number; first_name: string }): string {
  const fields: Record<string, string> = {
    query_id: `q-${String(user.id)}-${String(Math.random()).slice(2, 10)}`,
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const check = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN_A1).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe('gift cards over HTTP', () => {
  let api: ApiApp;
  let owner: ActorContext;
  let ownerCookie: string;
  let technicalCookie: string;
  let n = 0;
  const key = () => `gift-http-${String((n += 1)).padStart(6, '0')}-abcdef`;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig();
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
    owner = adminActorFor(
      await createAdmin(api.container, tenantA, {
        username: 'owner',
        password: 'the-owners-password',
        roleKeys: ['owner'],
      }),
    );
    await createAdmin(api.container, tenantA, {
      username: 'technical',
      password: 'the-technical-password',
      roleKeys: ['technical'],
    });
    ownerCookie = await cookieFor('owner', 'the-owners-password');
    technicalCookie = await cookieFor('technical', 'the-technical-password');
  });

  async function cookieFor(username: string, password: string): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password },
    });
    const header = String(response.headers['set-cookie'] ?? '');
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header);
    if (match === null) throw new Error(`No session cookie for ${username}: ${response.body}`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  async function setFlag(flag: FeatureFlagKey, enabled: boolean) {
    const before = (await api.container.featureFlags.list(tenantA, owner)).find(
      (one) => one.key === flag,
    );
    if (before === undefined) throw new Error(`no ${flag} flag`);
    await api.container.featureFlags.set(tenantA, owner, {
      idempotencyKey: key(),
      key: flag,
      enabled,
      expectedVersion: before.version,
      confirmKey: flag,
      reason: 'gift card HTTP test',
    });
  }

  const get = (url: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${url}`, headers: { cookie } });
  const post = (url: string, cookie: string, payload: unknown) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${url}`,
      headers: { cookie, origin: ORIGIN },
      payload,
    });
  const errorCode = (body: string): string =>
    (JSON.parse(body) as { error: { code: string } }).error.code;

  const CODE_SYMBOLS = `[${GIFT_CARD_CODE_ALPHABET}]`;
  const CODE_SHAPE = new RegExp(
    `^${CODE_SYMBOLS}{4}(?:-${CODE_SYMBOLS}{4}){${GIFT_CARD_CODE_LENGTH / GIFT_CARD_CODE_GROUP_SIZE - 1}}$`,
    'u',
  );
  /** Every string in a parsed JSON value, keys excluded. */
  const stringValues = (node: unknown): string[] =>
    typeof node === 'string'
      ? [node]
      : node !== null && typeof node === 'object'
        ? Object.values(node).flatMap(stringValues)
        : [];

  const createBody = (count = 3) => ({
    idempotencyKey: key(),
    label: 'نوروز',
    amountMinor: '40000',
    currency: 'IRT',
    count,
    expiresAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
    perCustomerLimit: null,
    reason: 'کمپین نوروز',
    expectedTotalMinor: String(40_000 * count),
    typedCount: count,
  });

  it('mints, lists, downloads and disables a batch; the operator without the keys is refused', async () => {
    await setFlag('gift_cards', true);
    const created = await post(GIFT_CARD_ROUTES.batches, ownerCookie, createBody());
    expect(created.statusCode, created.body).toBeLessThan(300);
    const { batch } = giftCardBatchResponseSchema.parse(JSON.parse(created.body));
    expect(batch).toMatchObject({
      count: 3,
      unredeemedCount: 3,
      redeemedCount: 0,
      state: 'ACTIVE',
    });
    expect(batch.exportAvailableUntil).not.toBeNull();
    const listed = await get(GIFT_CARD_ROUTES.batches, ownerCookie);
    expect(listed.statusCode, listed.body).toBe(200);
    const list = giftCardBatchListResponseSchema.parse(JSON.parse(listed.body));
    expect(list).toMatchObject({ walletCurrency: 'IRT', enabled: true });
    expect(list.batches.map((one) => one.id)).toEqual([batch.id]);

    const file = await get(GIFT_CARD_ROUTES.exportCsv(batch.id), ownerCookie);
    expect(file.statusCode, file.body).toBe(200);
    expect(file.headers['content-type']).toContain('text/csv');
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(String(file.headers['content-disposition'])).toMatch(
      /^attachment; filename="gift-cards-[0-9a-f]{8}\.csv"$/u,
    );
    expect(file.body.trimEnd().split('\r\n')).toHaveLength(4);

    // The answer to the create carries no code. The check is exact: the codes this batch
    // minted are read from its own export, and no string in the parsed answer may contain
    // one (hyphenated or compact) or be shaped like one. A regex over the raw body is not
    // used: the lowercase UUID ids are full of digit groups ("9452-7982") that the code
    // alphabet shares, and it failed about one run in a hundred for that reason alone.
    const minted = file.body
      .trimEnd()
      .split('\r\n')
      .slice(1)
      .map((row) => (row.split(',')[0] ?? '').replaceAll('"', ''));
    expect(minted).toHaveLength(3);
    for (const code of minted) expect(code, 'export row').toMatch(CODE_SHAPE);
    const values = stringValues(JSON.parse(created.body));
    expect(values.length).toBeGreaterThan(5);
    for (const value of values) {
      expect(value).not.toMatch(CODE_SHAPE);
      for (const code of minted) {
        expect(value).not.toContain(code);
        expect(value).not.toContain(code.replaceAll('-', ''));
      }
    }

    for (const refused of [
      await post(GIFT_CARD_ROUTES.batches, technicalCookie, createBody()),
      await get(GIFT_CARD_ROUTES.exportCsv(batch.id), technicalCookie),
      await get(GIFT_CARD_ROUTES.batches, technicalCookie),
      await post(GIFT_CARD_ROUTES.disable(batch.id), technicalCookie, {
        idempotencyKey: key(),
        reason: 'x',
        expectedUnredeemed: 3,
        confirmed: true,
      }),
    ]) {
      expect(refused.statusCode, refused.body).toBe(403);
    }

    const preview = await get(GIFT_CARD_ROUTES.disablePreview(batch.id), ownerCookie);
    expect(JSON.parse(preview.body)).toMatchObject({ unredeemedCount: 3, state: 'ACTIVE' });
    const disabled = await post(GIFT_CARD_ROUTES.disable(batch.id), ownerCookie, {
      idempotencyKey: key(),
      reason: 'پایان',
      expectedUnredeemed: 3,
      confirmed: true,
    });
    expect(disabled.statusCode, disabled.body).toBeLessThan(300);
    expect(JSON.parse(disabled.body)).toMatchObject({
      changed: true,
      codesDisabled: 3,
      batch: { state: 'DISABLED', unredeemedCount: 0, disabledCount: 3 },
    });
  });

  it('refuses a batch whose confirmation does not match, with the contract code', async () => {
    await setFlag('gift_cards', true);
    const response = await post(GIFT_CARD_ROUTES.batches, ownerCookie, {
      ...createBody(),
      typedCount: 2,
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response.body)).toBe(COMMERCE_ERROR_CODES.GIFT_CARD_CONFIRMATION_MISMATCH);
  });

  describe('in the mini app', () => {
    const call = (token: string, method: 'GET' | 'POST', route: string, payload?: unknown) =>
      inject({
        method,
        url: `${MINIAPP_API_PREFIX}${miniAppPath(route, {})}`,
        headers: {
          authorization: `Bearer ${token}`,
          ...(method === 'GET' ? {} : { 'idempotency-key': key() }),
        },
        ...(payload === undefined ? {} : { payload }),
      });

    async function sessionFor(telegramUserId: number): Promise<string> {
      const response = await inject({
        method: 'POST',
        url: `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.session, {
          botInstanceId: SEED_IDS.botA1,
        })}`,
        payload: { initData: initDataFor({ id: telegramUserId, first_name: 'مشتری' }) },
      });
      expect(response.statusCode, response.body).toBe(201);
      return (JSON.parse(response.body) as { token: string }).token;
    }

    it('draws the field only while the flag is on and redeems through the same service', async () => {
      await setFlag('mini_app', true);
      const token = await sessionFor(960001);
      const off = miniAppWalletResponseSchema.parse(
        JSON.parse((await call(token, 'GET', MINIAPP_ROUTES.wallet)).body),
      );
      expect(off.giftCards).toBe(false);
      const refused = await call(token, 'POST', MINIAPP_ROUTES.walletGiftCard, {
        code: 'ABCD-EFGH-JKMN-PQRS-TVWX',
      });
      expect(errorCode(refused.body)).toBe(COMMERCE_ERROR_CODES.GIFT_CARDS_DISABLED);

      await setFlag('gift_cards', true);
      const created = await post(GIFT_CARD_ROUTES.batches, ownerCookie, createBody(1));
      const { batch } = giftCardBatchResponseSchema.parse(JSON.parse(created.body));
      const csv = (await get(GIFT_CARD_ROUTES.exportCsv(batch.id), ownerCookie)).body;
      const code = (csv.trimEnd().split('\r\n')[1]?.split(',')[0] ?? '').replace(/"/g, '');

      const on = miniAppWalletResponseSchema.parse(
        JSON.parse((await call(token, 'GET', MINIAPP_ROUTES.wallet)).body),
      );
      expect(on.giftCards).toBe(true);
      const redeemed = await call(token, 'POST', MINIAPP_ROUTES.walletGiftCard, { code });
      expect(redeemed.statusCode, redeemed.body).toBeLessThan(300);
      expect(miniAppGiftCardResponseSchema.parse(JSON.parse(redeemed.body))).toEqual({
        outcome: 'REDEEMED',
        amount: { amountMinor: '40000', currency: 'IRT' },
        balance: { amountMinor: '40000', currency: 'IRT' },
      });
      const again = await call(token, 'POST', MINIAPP_ROUTES.walletGiftCard, { code });
      expect(JSON.parse(again.body)).toEqual({ outcome: 'REJECTED' });
      // The audit row of the redemption names the mini app as its source.
      const rows = (await api.container.database.db.execute(
        sql`SELECT source_surface FROM audit_logs WHERE action = 'gift_card.redeem'`,
      )) as unknown as { rows: { source_surface: string }[] };
      expect(rows.rows.map((row) => row.source_surface)).toEqual(['MINI_APP']);
    });
  });
});
