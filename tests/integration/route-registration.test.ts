import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  API_PREFIX,
  AUTH_ROUTES,
  PAYMENT_ACCOUNT_ROUTES,
  PAYMENT_GATEWAY_ROUTES,
  REFUND_ROUTES,
  SESSION_COOKIE_NAME,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';

/**
 * Every DYNAMIC admin route is reachable at a real URL.
 *
 * ## The defect this file exists for
 *
 * Nine routes were registered as `%3A`-encoded literals. A controller declared its
 * path by calling the CLIENT's URL builder with `':provider'` or `':id'`, and those
 * builders call `encodeURIComponent` — correctly, because a real id has to survive a
 * slash. So Nest registered `/payment-gateways/%3Aprovider`, the real URL matched
 * nothing, and a real staging server answered
 * `Cannot POST /api/admin/v1/payment-gateways/MANUAL_TRANSFER`.
 *
 * ## Why nothing caught it
 *
 * Every existing test either called the service directly or stubbed `fetch`. Neither
 * touches Nest's route table, so nine dead routes passed a green suite and a full
 * deployment smoke. A unit test of `routePattern` would not catch it either — the
 * bug was in REGISTRATION, so the test has to go through the real router.
 *
 * So this boots the real Nest application and injects real concrete URLs through
 * Fastify. The assertion is deliberately about ROUTING rather than about the
 * business outcome: a 404 whose body says `Cannot POST` means the route does not
 * exist, and ANY other status means the request reached a controller. Most cases here
 * are unauthenticated on purpose, because 401 is proof of arrival and needs no
 * fixture; the authenticated case below then proves an authorized call gets all the
 * way through to a real response.
 */

const ORIGIN = 'https://admin.example.test';

/** A real-looking id of each kind, in the shape the product actually issues. */
const ACCOUNT_ID = '019240ab-cdef-7012-8345-6789abcdef01';
const PAYMENT_ID = '019241ab-cdef-7012-8345-6789abcdef02';
const REFUND_ID = '019242ab-cdef-7012-8345-6789abcdef03';

describe('dynamic route registration', () => {
  let api: ApiApp;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  });

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
  });

  /**
   * The assertion, in one place.
   *
   * `Cannot POST /path` is Fastify's own not-found body, and it is the ONLY thing this
   * helper rejects. Checking the body rather than only the status matters: a
   * controller is entitled to answer 404 itself (an unknown account), and a test that
   * treated every 404 as a routing failure would fail on a correct route while a test
   * that treated none as one would pass on a missing route.
   */
  const reaches = async (method: 'GET' | 'POST', url: string) => {
    const response = await inject({ method, url, payload: method === 'POST' ? {} : undefined });
    const body = typeof response.body === 'string' ? response.body : '';
    expect(
      body.includes(`Cannot ${method} ${url}`),
      `${method} ${url} did not reach a controller — Nest has no such route. ` +
        `Status ${String(response.statusCode)}, body ${body.slice(0, 200)}`,
    ).toBe(false);
    return response;
  };

  // -------------------------------------------------------------------------
  // The five routes staging reported, at the URLs staging used
  // -------------------------------------------------------------------------

  it('routes POST /payment-gateways/MANUAL_TRANSFER', async () => {
    // The exact URL from the staging failure, provider name and all.
    await reaches('POST', `${API_PREFIX}${PAYMENT_GATEWAY_ROUTES.update('MANUAL_TRANSFER')}`);
  });

  it('routes POST /payment-gateways/MANUAL_TRANSFER/status', async () => {
    await reaches('POST', `${API_PREFIX}${PAYMENT_GATEWAY_ROUTES.status('MANUAL_TRANSFER')}`);
  });

  it('routes POST /payment-accounts/<id>', async () => {
    await reaches('POST', `${API_PREFIX}${PAYMENT_ACCOUNT_ROUTES.update(ACCOUNT_ID)}`);
  });

  it('routes POST /payment-accounts/<id>/enabled', async () => {
    await reaches('POST', `${API_PREFIX}${PAYMENT_ACCOUNT_ROUTES.enabled(ACCOUNT_ID)}`);
  });

  it('routes POST /payment-accounts/<id>/default', async () => {
    await reaches('POST', `${API_PREFIX}${PAYMENT_ACCOUNT_ROUTES.makeDefault(ACCOUNT_ID)}`);
  });

  // -------------------------------------------------------------------------
  // The four the scan found, which had the same defect and were never reported
  // -------------------------------------------------------------------------

  it('routes the four refund routes', async () => {
    await reaches('GET', `${API_PREFIX}${REFUND_ROUTES.list(PAYMENT_ID)}`);
    await reaches('POST', `${API_PREFIX}${REFUND_ROUTES.request(PAYMENT_ID)}`);
    await reaches('POST', `${API_PREFIX}${REFUND_ROUTES.complete(REFUND_ID)}`);
    await reaches('POST', `${API_PREFIX}${REFUND_ROUTES.fail(REFUND_ID)}`);
  });

  // -------------------------------------------------------------------------
  // The dynamic routes that were ALREADY correct, so a future edit cannot break them
  // -------------------------------------------------------------------------

  it('routes every other dynamic admin route', async () => {
    const id = ACCOUNT_ID;
    for (const [method, path] of [
      ['GET', `users/${id}`],
      ['POST', `users/${id}/block`],
      ['POST', `users/${id}/unblock`],
      ['GET', `users/${id}/wallet`],
      ['GET', `users/${id}/wallet/entries`],
      ['POST', `users/${id}/wallet/adjust`],
      ['GET', `orders/${id}`],
      ['GET', `products/${id}`],
      ['POST', `products/${id}`],
      ['POST', `products/${id}/activate`],
      ['POST', `products/${id}/deactivate`],
      ['GET', `service-addons/${id}`],
      ['POST', `service-addons/${id}`],
      ['POST', `service-addons/${id}/activate`],
      ['POST', `service-addons/${id}/deactivate`],
      ['GET', `discounts/${id}`],
      ['POST', `discounts/${id}`],
      ['POST', `discounts/${id}/activate`],
      ['POST', `discounts/${id}/deactivate`],
      ['GET', `cashback-rules/${id}`],
      ['POST', `cashback-rules/${id}`],
      ['POST', `cashback-rules/${id}/activate`],
      ['POST', `cashback-rules/${id}/deactivate`],
      ['GET', `orders/${id}/pricing`],
      // WP9: the referral reads.
      ['GET', 'referrals'],
      ['GET', 'referral-commissions'],
      ['GET', `customers/${id}/referral`],
      ['GET', `services/${id}`],
      ['GET', `services/${id}/operations`],
      ['POST', `services/${id}/sync-usage`],
      ['POST', `services/${id}/resend`],
      ['POST', `services/${id}/retry-provision`],
      ['POST', `services/${id}/reconcile`],
      ['POST', `services/${id}/suspend`],
      ['POST', `services/${id}/resume`],
      ['POST', `services/${id}/terminate`],
      ['GET', `panels/${id}`],
      ['POST', `panels/${id}`],
      ['POST', `panels/${id}/credentials`],
      ['POST', `panels/${id}/status`],
      ['POST', `panels/${id}/test`],
      ['GET', `payments/${id}`],
      ['POST', `payments/${id}/confirm`],
      ['POST', `payments/${id}/reject`],
      ['GET', `payments/${id}/receipts`],
      ['GET', `payments/${id}/receipts/${REFUND_ID}/content`],
      ['POST', `admins/${id}/status`],
      ['POST', `admins/${id}/roles`],
      ['POST', `admins/${id}/telegram`],
      ['POST', `settings/sales.currency`],
      ['POST', `features/telegram.webhook`],
      ['GET', `templates/bot.start.greeting`],
      ['GET', `templates/bot.start.greeting/revisions`],
      ['POST', `templates/bot.start.greeting`],
      ['POST', `templates/bot.start.greeting/revert`],
      ['POST', `templates/bot.start.greeting/preview`],
      ['GET', `notifications/${id}`],
      ['GET', `backups/${id}`],
      ['GET', `backups/${id}/archive`],
      ['GET', `recoveries/${id}`],
      ['POST', `recoveries/${id}/verify`],
      ['POST', `recoveries/${id}/confirm`],
    ] as const) {
      await reaches(method, `${API_PREFIX}/${path}`);
    }
  });

  // -------------------------------------------------------------------------
  // Arrival is not enough: an AUTHORIZED call must complete
  // -------------------------------------------------------------------------

  /**
   * The positive proof, and the reason the cases above are not the whole test.
   *
   * A 401 shows the router found the handler. It does not show the handler works with
   * the parameter the router extracted — a route registered as `:id` but read with
   * `@Param('accountId')` would answer 401 unauthenticated and then fail on a real
   * call. So this one signs in and switches a route off, end to end, and asserts the
   * response body describes the provider named IN THE URL.
   */
  it('carries the URL parameter through to the handler on an authorized call', async () => {
    await createAdmin(api.container, tenantA, {
      username: 'owner-routes',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    const login = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner-routes', password: 'the-owners-real-password' },
    });
    // 201, not 200: Nest's default success status for a POST handler.
    expect(login.statusCode).toBe(201);
    const cookie = String(login.headers['set-cookie'] ?? '')
      .split(';')[0]
      ?.replace(`${SESSION_COOKIE_NAME}=`, '');
    expect(cookie).toBeTruthy();

    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${PAYMENT_GATEWAY_ROUTES.status('MANUAL_TRANSFER')}`,
      headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE_NAME}=${cookie ?? ''}` },
      payload: { idempotencyKey: 'route-registration-0001', status: 'DISABLED' },
    });

    expect(response.statusCode).toBe(201);
    const payload = JSON.parse(response.body) as { gateway: { provider: string; status: string } };
    // The provider the URL named, not a default the handler invented.
    expect(payload.gateway.provider).toBe('MANUAL_TRANSFER');
    expect(payload.gateway.status).toBe('DISABLED');

    // And it actually persisted, so the parameter reached the write rather than only
    // the response builder.
    const rows = (await api.container.database.db.execute(
      sql`SELECT status FROM payment_gateways
           WHERE tenant_id = ${tenantA.tenantId} AND provider = 'MANUAL_TRANSFER'` as never,
    )) as unknown as { rows: { status: string }[] };
    expect(rows.rows[0]?.status).toBe('DISABLED');
  });
});
