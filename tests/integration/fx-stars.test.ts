import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  COMMERCE_ERROR_CODES,
  CONTROL_ERROR_CODES,
  FX_ROUTES,
  fxRefreshResponseSchema,
  fxStatusResponseSchema,
  isNexaError,
  money,
  SESSION_COOKIE_NAME,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PaymentGatewayConfig,
  type SettingKey,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { FX_UNAVAILABLE_REASON } from '../../apps/api/src/modules/commerce/payments/application/payment.service';
import {
  FX_STALE_QUOTE_USED_CODE,
  FX_FALLBACK_IN_USE_CODE,
} from '../../apps/api/src/modules/commerce/fx/application/fx.service';
import { DrizzleFxQuoteRepository } from '../../apps/api/src/modules/commerce/fx/infrastructure/drizzle-fx.repository';
import { DrizzleGatewayInvoiceRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-invoice.repository';
import { panelUrlPolicy } from '../../apps/api/src/infrastructure/net/installation-policy';
import { checkUrl } from '../../apps/api/src/infrastructure/net/url-policy';
import type { AppConfig } from '../../apps/api/src/infrastructure/config/config.schema';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  testConfig,
} from './harness';

/**
 * Package FX / FX-STARS, end to end (`docs/fx-audit.md` §5).
 *
 * The real API app and container over a real database. The two exchange-rate sources
 * are ONE scripted fake HTTP server on loopback (`FX_*_BASE_URL` point at it, the URL
 * policy admits loopback in tests), and Telegram is a recording fake so a Stars invoice
 * can be sent. The refresh lane is driven by hand (`container.fx.refreshIfDue`, the
 * worker's own call); the attempts go through `PaymentService.requestGatewayTopup`, the
 * production path, and the invoice rows are read back with SQL.
 */

const ORIGIN = 'https://admin.example.test';
const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-fx-stars';
const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const MARYAM = 930930;
/** 1 Star = 1,300 Toman, the owner's `toman_per_star` (Package A). */
const RATE = 1_300n;
const OWNER_PASSWORD = 'the-owners-real-password';

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

/** The documented Nobitex book (Rial) and the Wallex depth (Toman), scriptable per case. */
interface SourceScript {
  nobitex: { status: number; body: unknown };
  wallex: { status: number; body: unknown };
}

function nobitexBook(bestBidRial: string) {
  return {
    status: 'ok',
    lastUpdate: 1_700_000_000_000,
    lastTradePrice: bestBidRial,
    asks: [[`${bestBidRial}0`, '1']],
    bids: [
      [bestBidRial, '119.31'],
      ['271240', '1079.75'],
    ],
  };
}

function wallexDepth(bestBidToman: string) {
  return {
    success: true,
    result: {
      ask: [{ price: `${bestBidToman}9`, quantity: 1 }],
      bid: [{ price: bestBidToman, quantity: 40 }],
    },
  };
}

/** The same service, addressed by name rather than by the loopback literal. */
function byName(connectionString: string): string {
  const url = new URL(connectionString);
  if (url.hostname === '127.0.0.1') url.hostname = 'localhost';
  return url.toString();
}

describe('Central FX and the Stars route (packages FX, FX-STARS)', () => {
  let api: ApiApp;
  let config: AppConfig;
  let nobitexServer: Server;
  let wallexServer: Server;
  let telegram: Server;
  let script: SourceScript;
  let hits: string[] = [];
  let owner: ActorContext;
  let maryam: UserId;
  let seq = 90_000;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  const systemActor = (correlationId: string): ActorContext => ({
    type: 'SYSTEM_JOB',
    id: null,
    label: 'telegram-update:test',
    surface: 'TELEGRAM',
    correlationId: correlationId as CorrelationId,
  });

  beforeAll(async () => {
    /*
     * One fake server per source: an adapter's path starts with `/`, which
     * `SafeHttpClient` resolves against the base's ORIGIN (never a base path), so the two
     * sources cannot share a port under different prefixes.
     */
    const fake = (name: 'nobitex' | 'wallex') =>
      createServer((request: IncomingMessage, response: ServerResponse) => {
        hits.push(`${name}${request.url ?? ''}`);
        const answer = script[name];
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
      });
    nobitexServer = fake('nobitex');
    wallexServer = fake('wallex');
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      });
    });
    const port = async (server: Server): Promise<number> => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      return address.port;
    };
    const [nobitexPort, wallexPort, telegramPort] = await Promise.all([
      port(nobitexServer),
      port(wallexServer),
      port(telegram),
    ]);
    /*
     * The installation policy refuses the database's and Redis's host BY NAME
     * (`panelUrlPolicy` → `deniedHosts`), whatever it resolves to. On GitHub's runner both
     * are addressed as `127.0.0.1` — the literal the fakes listen on — so every source
     * read was refused there and every refresh FAILED, while the same file passed against
     * a database addressed as `localhost` (#122). The suite's own services are addressed
     * by name here, so the fakes' literal is not the data host; the first case below
     * asserts that the policy admits them, naming the cause if the collision returns.
     */
    const defaults = testConfig();
    config = testConfig({
      DATABASE_URL: byName(defaults.DATABASE_URL),
      REDIS_URL: byName(defaults.REDIS_URL),
      WEB_ADMIN_ORIGINS: ORIGIN,
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(telegramPort)}`,
      FX_NOBITEX_BASE_URL: `http://127.0.0.1:${String(nobitexPort)}`,
      FX_WALLEX_BASE_URL: `http://127.0.0.1:${String(wallexPort)}`,
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    for (const server of [nobitexServer, wallexServer, telegram]) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    hits = [];
    // 1,035,500 Rial per USDT on Nobitex = 103,550 Toman; Wallex says 103,500 Toman.
    script = {
      nobitex: { status: 200, body: nobitexBook('1035500') },
      wallex: { status: 200, body: wallexDepth('103500') },
    };
    owner = adminActorFor(
      await createAdmin(api.container, tenantA, {
        username: 'owner',
        password: OWNER_PASSWORD,
        roleKeys: ['owner'],
      }),
    );
    maryam = (
      await api.container.customers.resolveFromUpdate(tenantA, systemActor(`r-${String(MARYAM)}`), {
        idempotencyKey: `resolve-${String(MARYAM)}-${BOT_A}`,
        telegramUserId: String(MARYAM),
        from: { id: MARYAM, first_name: 'Customer' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
  });

  // -------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------

  const key = () => `fx-${String((seq += 1))}`;

  async function setSetting(settingKey: SettingKey, value: unknown) {
    const current = await api.container.settingsService.get(tenantA, owner, settingKey);
    return api.container.settingsService.set(tenantA, owner, {
      key: settingKey,
      value,
      expectedVersion: current.version,
      idempotencyKey: key(),
    });
  }

  async function setFlag(enabled: boolean) {
    const current = await api.container.featureFlagResolver.resolve(tenantA, 'central_fx');
    return api.container.featureFlags.set(tenantA, owner, {
      key: 'central_fx',
      enabled,
      expectedVersion: current.version,
      idempotencyKey: key(),
      reason: 'Package FX integration test.',
    });
  }

  async function enableStars(
    config: Partial<PaymentGatewayConfig> & { customerFeeBasisPoints?: number } = {},
  ) {
    await api.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TELEGRAM_STARS',
      config: { ...OPEN_ROUTE, providerUnitRateMinor: RATE, ...config },
    });
    await api.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TELEGRAM_STARS',
      status: 'ACTIVE',
    });
  }

  /** The whole central setup: flag on, ratio 100 Stars per USDT, mode central, one refresh. */
  async function centralStars() {
    await enableStars({ customerFeeBasisPoints: 500 });
    await setFlag(true);
    await setSetting('stars.per_usdt', '100');
    await setSetting('stars.pricing_mode', 'CENTRAL_FX_RATIO');
    expect(await api.container.fx.refreshIfDue(tenantA, 'USDT')).toMatchObject({
      outcome: 'REFRESHED',
    });
  }

  const inBot = { ...tenantA, botInstanceId: BOT_A };

  const topup = (amountMinor: bigint) => {
    const k = key();
    return api.container.payments.requestGatewayTopup(inBot, systemActor(k), maryam, {
      idempotencyKey: k,
      amount: money(amountMinor, 'IRT'),
      provider: 'TELEGRAM_STARS',
    });
  };

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await api.container.database.db.execute(query)).rows as T[];
  }

  interface InvoiceRow {
    sent_amount: string;
    conversion_policy: string;
    conversion_rate_minor: string | null;
    fx_quote_id: string | null;
    fx_source: string | null;
    fx_base_asset: string | null;
    fx_quote_currency: string | null;
    fx_rate_mantissa: string | null;
    fx_rate_scale: number | null;
    fx_source_at: string | null;
    fx_fetched_at: string | null;
    fx_quote_state: string | null;
    fx_policy_version: number | null;
    fx_unit_ratio_mantissa: string | null;
    fx_unit_ratio_scale: number | null;
    fx_effective_rate_numerator: string | null;
    fx_effective_rate_denominator: string | null;
  }

  async function invoiceOf(paymentId: string): Promise<InvoiceRow> {
    const [row] = await rows<InvoiceRow>(
      sql`SELECT sent_amount::text AS sent_amount, conversion_policy, conversion_rate_minor::text AS conversion_rate_minor,
                 fx_quote_id, fx_source, fx_base_asset, fx_quote_currency, fx_rate_mantissa::text AS fx_rate_mantissa,
                 fx_rate_scale, fx_source_at, fx_fetched_at, fx_quote_state, fx_policy_version,
                 fx_unit_ratio_mantissa::text AS fx_unit_ratio_mantissa, fx_unit_ratio_scale,
                 fx_effective_rate_numerator::text AS fx_effective_rate_numerator,
                 fx_effective_rate_denominator::text AS fx_effective_rate_denominator
          FROM gateway_invoices WHERE payment_id = ${paymentId}`,
    );
    if (row === undefined) throw new Error('no invoice');
    return row;
  }

  const opsCodes = async () =>
    (
      await rows<{ code: string; occurrence_count: number }>(
        sql`SELECT code, occurrence_count FROM operational_events WHERE tenant_id = ${tenantA.tenantId} ORDER BY first_seen_at`,
      )
    ).map((row) => `${row.code}×${String(row.occurrence_count)}`);

  /** Ages the stored quote, as time would: the test cannot wait fifteen minutes. */
  const ageQuote = (seconds: number) =>
    api.container.database.db.execute(
      sql`UPDATE fx_quotes SET fetched_at = now() - make_interval(secs => ${seconds}) WHERE tenant_id = ${tenantA.tenantId}`,
    );

  async function login(): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner', password: OWNER_PASSWORD },
    });
    const header = String(response.headers['set-cookie'] ?? '');
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header);
    if (match === null) throw new Error('No session cookie was set.');
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  // =====================================================================================

  describe('the suite against the installation policy', () => {
    it("the fakes are reachable: they do not share the data services' host name, which the policy denies by name (CI on #122)", () => {
      const policy = panelUrlPolicy(config);
      expect(policy.deniedHosts).not.toContain('127.0.0.1');
      for (const base of [config.FX_NOBITEX_BASE_URL, config.FX_WALLEX_BASE_URL]) {
        expect(checkUrl(`${base}/`, policy)).toMatchObject({ allowed: true });
      }
    });
  });

  describe('backward compatibility (FX-STARS)', () => {
    it('an upgraded installation prices Stars by the fixed rate: policy FIXED_RATE, no FX snapshot, nothing dialled', async () => {
      await enableStars({ customerFeeBasisPoints: 500 });
      const attempt = await topup(100_000n);
      const invoice = await invoiceOf(attempt.payment.id);
      // 100,000 + 5 % = 105,000; / 1,300 = 80.77 → 81 Stars, exactly as Package A.
      expect(invoice).toMatchObject({
        sent_amount: '81',
        conversion_policy: 'FIXED_RATE',
        conversion_rate_minor: '1300',
        fx_quote_id: null,
        fx_source: null,
      });
      expect(attempt.invoice.conversionPolicy).toBe('FIXED_RATE');
      expect(attempt.invoice.fx).toBeNull();
      expect(hits).toEqual([]);
      // The worker's lane, with the feature off, dials nothing either.
      expect(await api.container.fx.refreshIfDue(tenantA, 'USDT')).toMatchObject({
        outcome: 'DISABLED',
      });
      expect(hits).toEqual([]);
    });

    it('the previous release keeps writing a Stars invoice in its own shape: a rate and no policy reads back FIXED_RATE (Codex #122, P1)', async () => {
      await enableStars({ customerFeeBasisPoints: 500 });
      const attempt = await topup(100_000n);
      const db = api.container.database.db;
      // The columns the previous release wrote: everything but the policy and the FX snapshot.
      const columns = (
        await rows<{ column_name: string }>(
          sql`SELECT column_name FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'gateway_invoices'
                AND column_name <> 'conversion_policy' AND column_name NOT LIKE 'fx\\_%'
              ORDER BY ordinal_position`,
        )
      ).map((row) => row.column_name);
      expect(columns).toContain('conversion_rate_minor');
      expect(columns).not.toContain('conversion_policy');
      const list = sql.raw(columns.map((column) => `"${column}"`).join(', '));
      // One connection: the copy is a TEMP table, and the re-insert is the old write shape
      // (a rate, the column's default for the policy), exactly what a rolling deploy sees.
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`CREATE TEMP TABLE pre_p_invoice ON COMMIT DROP AS SELECT * FROM gateway_invoices WHERE payment_id = ${attempt.payment.id}`,
        );
        await tx.execute(
          sql`DELETE FROM gateway_invoices WHERE payment_id = ${attempt.payment.id}`,
        );
        await tx.execute(
          sql`INSERT INTO gateway_invoices (${list}) SELECT ${list} FROM pre_p_invoice`,
        );
      });
      expect(await invoiceOf(attempt.payment.id)).toMatchObject({
        sent_amount: '81',
        conversion_policy: 'FIXED_RATE',
        conversion_rate_minor: '1300',
        fx_quote_id: null,
      });
      // And this release still reads it as the fixed-rate attempt it is.
      const record = await new DrizzleGatewayInvoiceRepository(db).findByPayment(
        tenantA,
        attempt.payment.id,
      );
      expect(record?.conversionPolicy).toBe('FIXED_RATE');
    });

    it('the central mode cannot be chosen while the feature is off or the ratio is unset, and the ratio cannot be cleared under it', async () => {
      // A positive ratio is accepted at any time; it is the MODE that needs the feature.
      expect((await setSetting('stars.per_usdt', '100')).changed).toBe(true);
      const off = await setSetting('stars.pricing_mode', 'CENTRAL_FX_RATIO').catch(
        (error: unknown) => error,
      );
      expect(isNexaError(off) && off.code).toBe(CONTROL_ERROR_CODES.INVALID_VALUE);
      expect(isNexaError(off) && off.message).toMatch(/central_fx feature is on/u);
      await setFlag(true);
      // Under the fixed rate the ratio may be cleared; the mode then needs it back.
      expect((await setSetting('stars.per_usdt', '')).changed).toBe(true);
      const noRatio = await setSetting('stars.pricing_mode', 'CENTRAL_FX_RATIO').catch(
        (error: unknown) => error,
      );
      expect(isNexaError(noRatio) && noRatio.code).toBe(CONTROL_ERROR_CODES.INVALID_VALUE);
      expect(isNexaError(noRatio) && noRatio.message).toMatch(/positive ratio/u);
      await setSetting('stars.per_usdt', '100');
      expect((await setSetting('stars.pricing_mode', 'CENTRAL_FX_RATIO')).changed).toBe(true);
      const cleared = await setSetting('stars.per_usdt', '').catch((error: unknown) => error);
      expect(isNexaError(cleared) && cleared.code).toBe(CONTROL_ERROR_CODES.INVALID_VALUE);
      // A positive ratio is always accepted, and switching back to the fixed rate frees the ratio.
      expect((await setSetting('stars.per_usdt', '77.5')).changed).toBe(true);
      await setSetting('stars.pricing_mode', 'FIXED_RATE');
      expect((await setSetting('stars.per_usdt', '')).changed).toBe(true);
    });
  });

  describe('the central rate prices a Stars attempt', () => {
    it('snapshots the USDT quote, its source and times, the ratio and the effective figure; stars = ceil(payable / (rate / ratio))', async () => {
      await centralStars();
      expect(hits).toEqual(['nobitex/v3/orderbook/USDTIRT']);
      const attempt = await topup(100_000n);
      const invoice = await invoiceOf(attempt.payment.id);
      // 105,000 Toman payable; 103,550 Toman per USDT / 100 Stars per USDT = 1,035.5 Toman
      // per Star; 105,000 / 1,035.5 = 101.40… → 102 Stars.
      expect(invoice).toMatchObject({
        sent_amount: '102',
        conversion_policy: 'CENTRAL_FX',
        conversion_rate_minor: null,
        fx_source: 'NOBITEX',
        fx_base_asset: 'USDT',
        fx_quote_currency: 'IRT',
        fx_rate_mantissa: '103550',
        fx_rate_scale: 0,
        fx_quote_state: 'FRESH',
        fx_policy_version: 1,
        fx_unit_ratio_mantissa: '100',
        fx_unit_ratio_scale: 0,
        fx_effective_rate_numerator: '2071',
        fx_effective_rate_denominator: '2',
      });
      expect(invoice.fx_quote_id).toMatch(/^v1:NOBITEX:USDT-IRT:103550e-0:1700000000000:\d+$/u);
      // The book's own time (`lastUpdate`) and the fetch time, both kept.
      expect(new Date(invoice.fx_source_at ?? '').getTime()).toBe(1_700_000_000_000);
      expect(invoice.fx_fetched_at).not.toBeNull();
      expect(attempt.invoice.fx).toMatchObject({ source: 'NOBITEX', quoteState: 'FRESH' });
      // The customer's Toman figures are untouched: principal, fee and payable are what Package A froze.
      expect(attempt.payment.amount.amountMinor).toBe(100_000n);
      expect(attempt.payment.customerFee?.payable.amountMinor).toBe(105_000n);
    });

    it('an existing invoice is unaffected by a market move; a new attempt uses the new quote', async () => {
      await centralStars();
      const first = await topup(100_000n);
      const before = await invoiceOf(first.payment.id);
      // The market moves ten percent: 1,139,050 Rial. An operator's refresh reads it now.
      script.nobitex = { status: 200, body: nobitexBook('1139050') };
      expect((await api.container.fx.refresh(tenantA, owner, 'USDT')).outcome).toBe('REFRESHED');
      expect(await invoiceOf(first.payment.id)).toEqual(before);
      // The same open attempt is handed back unchanged (its snapshot is its own).
      const again = await topup(100_000n);
      expect(again.reissued).toBe(true);
      expect(again.invoice.fx?.rate).toEqual({ mantissa: 103_550n, scale: 0 });
      // A different attempt is priced by the new quote: 113,905 / 100 = 1,139.05 per Star;
      // 210,000 / 1,139.05 = 184.36… → 185.
      const second = await topup(200_000n);
      expect(await invoiceOf(second.payment.id)).toMatchObject({
        sent_amount: '185',
        fx_rate_mantissa: '113905',
        fx_rate_scale: 0,
      });
      expect(await invoiceOf(first.payment.id)).toEqual(before);
      // And the snapshot cannot be rewritten, by anyone: the guard trigger refuses.
      const rewrite = await api.container.database.db
        .execute(
          sql`UPDATE gateway_invoices SET fx_rate_mantissa = 1 WHERE payment_id = ${first.payment.id}`,
        )
        .then(
          () => 'written',
          (error: unknown) => String((error as { cause?: { message?: string } }).cause?.message),
        );
      expect(rewrite).toMatch(/snapshot is immutable/u);
    });

    it('a later ratio change touches only future attempts', async () => {
      await centralStars();
      const first = await topup(100_000n);
      const before = await invoiceOf(first.payment.id);
      await setSetting('stars.per_usdt', '50');
      expect(await invoiceOf(first.payment.id)).toEqual(before);
      // 103,550 / 50 = 2,071 Toman per Star; 210,000 / 2,071 = 101.4 → 102.
      const second = await topup(200_000n);
      expect(await invoiceOf(second.payment.id)).toMatchObject({
        sent_amount: '102',
        fx_unit_ratio_mantissa: '50',
        fx_effective_rate_numerator: '2071',
        fx_effective_rate_denominator: '1',
      });
    });

    it('inside the stale window the last-known-good prices a NEW attempt and the stale use is recorded once', async () => {
      await centralStars();
      await ageQuote(120);
      const first = await topup(100_000n);
      expect(await invoiceOf(first.payment.id)).toMatchObject({
        sent_amount: '102',
        fx_quote_state: 'STALE_ALLOWED',
      });
      const second = await topup(200_000n);
      expect(await invoiceOf(second.payment.id)).toMatchObject({ fx_quote_state: 'STALE_ALLOWED' });
      expect(await opsCodes()).toEqual([`${FX_STALE_QUOTE_USED_CODE}×2`]);
    });

    it('beyond the stale limit a NEW attempt is refused with FX_UNAVAILABLE; the issued invoice keeps its snapshot', async () => {
      await centralStars();
      const first = await topup(100_000n);
      const before = await invoiceOf(first.payment.id);
      await ageQuote(1_000);
      const refused = await topup(200_000n).catch((error: unknown) => error);
      expect(isNexaError(refused) && refused.code).toBe(
        COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE,
      );
      expect(isNexaError(refused) && refused.details).toMatchObject({
        reason: FX_UNAVAILABLE_REASON,
        detail: 'TOO_STALE',
      });
      expect(await invoiceOf(first.payment.id)).toEqual(before);
      // No new payment row was written for the refused attempt.
      const [count] = await rows<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM payments WHERE tenant_id = ${tenantA.tenantId}`,
      );
      expect(count?.n).toBe('1');
    });

    it('with the feature switched off afterwards, a new central-rate attempt is refused and the fixed rate is not silently used', async () => {
      await centralStars();
      const first = await topup(100_000n);
      await setFlag(false);
      const refused = await topup(200_000n).catch((error: unknown) => error);
      expect(isNexaError(refused) && refused.details).toMatchObject({
        reason: FX_UNAVAILABLE_REASON,
        detail: 'DISABLED',
      });
      expect((await invoiceOf(first.payment.id)).conversion_policy).toBe('CENTRAL_FX');
    });

    it('an open central-rate invoice is handed back again while the feed is unavailable: a repeat is never re-priced (Codex #122)', async () => {
      await centralStars();
      const first = await topup(100_000n);
      const before = await invoiceOf(first.payment.id);
      // The feature is off now, and the quote is past its stale limit besides.
      await setFlag(false);
      await ageQuote(1_000);
      const again = await topup(100_000n);
      expect(again.reissued).toBe(true);
      expect(again.payment.id).toBe(first.payment.id);
      expect(await invoiceOf(first.payment.id)).toEqual(before);
      // A different amount is a NEW attempt, and that one the feed's absence refuses.
      const refused = await topup(200_000n).catch((error: unknown) => error);
      expect(isNexaError(refused) && refused.details).toMatchObject({
        reason: FX_UNAVAILABLE_REASON,
        detail: 'DISABLED',
      });
      const [count] = await rows<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM payments WHERE tenant_id = ${tenantA.tenantId}`,
      );
      expect(count?.n).toBe('1');
    });

    it('the worker lane refreshes only when the quote is older than the TTL: one conditional claim, nothing dialled otherwise', async () => {
      await centralStars();
      expect(hits).toHaveLength(1);
      expect(await api.container.fx.refreshIfDue(tenantA, 'USDT')).toMatchObject({
        outcome: 'NOT_DUE',
      });
      expect(hits).toHaveLength(1);
      // Past the TTL (the default is 45 s) the same call claims the row and dials the primary.
      await ageQuote(60);
      expect(await api.container.fx.refreshIfDue(tenantA, 'USDT')).toMatchObject({
        outcome: 'REFRESHED',
      });
      expect(hits).toHaveLength(2);
      // A lease another replica holds is honoured: nothing is dialled until it lapses.
      await ageQuote(60);
      await api.container.database.db.execute(
        sql`UPDATE fx_quotes SET refresh_claimed_until = now() + interval '20 seconds', refresh_claim_token = 'another-replica' WHERE tenant_id = ${tenantA.tenantId}`,
      );
      expect(await api.container.fx.refreshIfDue(tenantA, 'USDT')).toMatchObject({
        outcome: 'NOT_DUE',
      });
      expect((await api.container.fx.refresh(tenantA, owner, 'USDT')).outcome).toBe('BUSY');
      expect(hits).toHaveLength(2);
    });

    it('the stored quote never moves backwards: a replica whose clock is behind cannot replace a newer quote', async () => {
      await centralStars();
      // The stored quote reads as fetched an hour from now — what a replica with a clock
      // behind this one would see. A refresh from here is "older" and must not win.
      await ageQuote(-3_600);
      script.nobitex = { status: 200, body: nobitexBook('1139050') };
      expect((await api.container.fx.refresh(tenantA, owner, 'USDT')).outcome).toBe('REFRESHED');
      const [row] = await rows<{
        rate_mantissa: string;
        source: string;
        refresh_claimed_until: Date | null;
      }>(
        sql`SELECT rate_mantissa::text AS rate_mantissa, source, refresh_claimed_until FROM fx_quotes WHERE tenant_id = ${tenantA.tenantId}`,
      );
      expect(row).toMatchObject({
        rate_mantissa: '103550',
        source: 'NOBITEX',
        refresh_claimed_until: null,
      });
    });

    it('a refresh lease is fenced by its token: a stalled refresher can neither release nor overwrite the claim a newer replica holds (Codex #122)', async () => {
      const repository = new DrizzleFxQuoteRepository(api.container.database.db);
      const pair = { baseAsset: 'USDT', quoteCurrency: 'IRT' } as const;
      const t0 = new Date('2026-09-30T10:00:00.000Z');
      const at = (seconds: number) => new Date(t0.getTime() + seconds * 1_000);
      const lease = (now: Date, claimToken: string) => ({
        now,
        leaseUntil: new Date(now.getTime() + 30_000),
        dueBefore: null,
        claimToken,
      });
      const quote = (fetchedAt: Date, mantissa: bigint) => ({
        rate: { mantissa, scale: 0 },
        source: 'NOBITEX' as const,
        sourceAt: null,
        fetchedAt,
        quoteId: `v1:NOBITEX:USDT/IRT:${String(mantissa)}e-0:-:${String(fetchedAt.getTime())}`,
        policyVersion: 1,
      });
      // Replica A claims, then stalls past its lease; replica B claims the lapsed lease.
      expect(await repository.claimRefresh(tenantA, pair, lease(t0, 'replica-a'), undefined)).toBe(
        true,
      );
      expect(
        await repository.claimRefresh(tenantA, pair, lease(at(60), 'replica-b'), undefined),
      ).toBe(true);
      // A wakes up. Its release changes nothing, and its store is refused.
      await repository.releaseRefresh(
        tenantA,
        pair,
        { now: at(61), errorCode: 'late', claimToken: 'replica-a' },
        undefined,
      );
      expect(await repository.find(tenantA, pair)).toMatchObject({
        refreshClaimedUntil: at(90),
        refreshClaimToken: 'replica-b',
        lastErrorCode: null,
      });
      expect(
        await repository.storeQuote(
          tenantA,
          pair,
          quote(at(62), 999_999n),
          at(62),
          'replica-a',
          undefined,
        ),
      ).toBe(false);
      expect((await repository.find(tenantA, pair))?.quote).toBeNull();
      // B's own store lands and clears the lease it holds.
      expect(
        await repository.storeQuote(
          tenantA,
          pair,
          quote(at(63), 103_550n),
          at(63),
          'replica-b',
          undefined,
        ),
      ).toBe(true);
      expect(await repository.find(tenantA, pair)).toMatchObject({
        quote: { rate: { mantissa: 103_550n, scale: 0 }, source: 'NOBITEX' },
        refreshClaimedUntil: null,
        refreshClaimToken: null,
      });
    });

    it('primary down: the fallback prices the attempt from Toman as read, and the conditions are recorded', async () => {
      await enableStars({ customerFeeBasisPoints: 500 });
      await setFlag(true);
      await setSetting('stars.per_usdt', '100');
      await setSetting('stars.pricing_mode', 'CENTRAL_FX_RATIO');
      script.nobitex = { status: 502, body: 'bad gateway' };
      expect(await api.container.fx.refreshIfDue(tenantA, 'USDT')).toMatchObject({
        outcome: 'REFRESHED_BY_FALLBACK',
      });
      expect(hits).toEqual(['nobitex/v3/orderbook/USDTIRT', 'wallex/v1/depth?symbol=USDTTMN']);
      const attempt = await topup(100_000n);
      // 103,500 / 100 = 1,035 per Star; 105,000 / 1,035 = 101.44… → 102.
      expect(await invoiceOf(attempt.payment.id)).toMatchObject({
        sent_amount: '102',
        fx_source: 'WALLEX',
        fx_rate_mantissa: '103500',
        fx_source_at: null,
      });
      expect(await opsCodes()).toEqual(['fx.source_unavailable×1', `${FX_FALLBACK_IN_USE_CODE}×1`]);
    });
  });

  describe('the Web Admin section', () => {
    it('serves the status and the manual refresh over HTTP, to the frozen schemas, with the Stars figures', async () => {
      await centralStars();
      const cookie = await login();
      const status = await inject({
        method: 'GET',
        url: `${API_PREFIX}${FX_ROUTES.status}`,
        headers: { cookie, origin: ORIGIN },
      });
      expect(status.statusCode).toBe(200);
      const view = fxStatusResponseSchema.parse(status.json());
      expect(view).toMatchObject({
        enabled: true,
        baseAsset: 'USDT',
        quoteCurrency: 'IRT',
        side: 'SELL_USDT_TO_RECEIVE_FIAT',
        primarySource: 'NOBITEX',
        fallbackSource: 'WALLEX',
        state: 'FRESH',
        quote: { source: 'NOBITEX', rate: '103550', rateMantissa: '103550', rateScale: 0 },
        stars: {
          pricingMode: 'CENTRAL_FX_RATIO',
          starsPerUsdt: '100',
          fixedRateMinor: '1300',
          centralRatePerStar: '1035.5',
        },
        policyVersion: 1,
      });
      expect(view.sources.map((source) => [source.source, source.consecutiveFailures])).toEqual([
        ['NOBITEX', 0],
      ]);

      script.nobitex = { status: 429, body: '' };
      const refreshed = await inject({
        method: 'POST',
        url: `${API_PREFIX}${FX_ROUTES.refresh}`,
        headers: { cookie, origin: ORIGIN },
        payload: {},
      });
      expect(refreshed.statusCode).toBe(201);
      const result = fxRefreshResponseSchema.parse(refreshed.json());
      expect(result.outcome).toBe('REFRESHED_BY_FALLBACK');
      // The answer says why the primary did not price the pair.
      expect(result.reason).toBe('nobitex:nobitex.rate_limited');
      expect(result.status.quote?.source).toBe('WALLEX');
      const nobitex = result.status.sources.find((source) => source.source === 'NOBITEX');
      expect(nobitex).toMatchObject({
        lastFailureCode: 'nobitex.rate_limited',
        consecutiveFailures: 1,
      });
      expect(nobitex?.retryAfter).not.toBeNull();
      // Who pressed refresh is audited; nothing about a source's body or URL is.
      const [audit] = await rows<{ action: string; after: Record<string, unknown> }>(
        sql`SELECT action, after FROM audit_logs WHERE action = 'fx.refresh' ORDER BY occurred_at DESC LIMIT 1`,
      );
      expect(audit?.after).toMatchObject({ outcome: 'REFRESHED_BY_FALLBACK', pair: 'USDT-IRT' });
    });

    it('refuses the section to an unauthenticated caller', async () => {
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${FX_ROUTES.status}`,
        headers: { origin: ORIGIN },
      });
      expect(response.statusCode).toBe(401);
    });
  });
});
