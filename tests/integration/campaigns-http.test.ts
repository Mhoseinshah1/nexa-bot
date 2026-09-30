import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  CAMPAIGN_ROUTES,
  SESSION_COOKIE_NAME,
  campaignListResponseSchema,
  campaignPreviewResponseSchema,
  campaignResponseSchema,
  campaignResultsResponseSchema,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { IntlCampaignCalendar } from '../../apps/api/src/modules/commerce/campaigns/infrastructure/intl-campaign-calendar';
import { CachedTenantPresentationReader } from '../../apps/api/src/modules/control/templates/infrastructure/cached-tenant-presentation.reader';
import { createAdmin, migrateOnce, resetDatabase, tenantA, tenantB, testConfig } from './harness';

/**
 * Campaigns over HTTP (round N, C1): the controller maps the contract to the service and
 * back, the service charges `campaigns.view`, `campaigns.manage` and each action's own key,
 * and another tenant's campaign is not found. The composition itself is
 * `campaigns.test.ts`.
 */

const ORIGIN = 'https://admin.example.test';

describe('campaigns HTTP surface', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let salesCookie: string;
  let supportCookie: string;
  let foreignCookie: string;
  let n = 0;
  const key = (): string => `campaign-http-${(n += 1)}`;

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

  async function cookieFor(username: string): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password: `the-${username}-password` },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(response.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error(`No session cookie for ${username}: ${response.body}`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    for (const [username, roleKeys, scope] of [
      ['owner', ['owner'], tenantA],
      ['sales', ['sales'], tenantA],
      ['support', ['support'], tenantA],
      ['foreign', ['owner'], tenantB],
    ] as const) {
      await createAdmin(api.container, scope, {
        username,
        password: `the-${username}-password`,
        roleKeys: [...roleKeys],
      });
    }
    ownerCookie = await cookieFor('owner');
    salesCookie = await cookieFor('sales');
    supportCookie = await cookieFor('support');
    api.container.setInstallationTenant(tenantB.tenantId);
    foreignCookie = await cookieFor('foreign');
    api.container.setInstallationTenant(tenantA.tenantId);
  });

  const get = (path: string, cookie = ownerCookie) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: { cookie, origin: ORIGIN } });
  const post = (path: string, payload: unknown, cookie = ownerCookie) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: { cookie, origin: ORIGIN },
      payload,
    });

  /** A window a day long, starting an hour ago, in the tenant's own calendar. */
  async function window() {
    const calendar = new IntlCampaignCalendar(
      new CachedTenantPresentationReader(api.container.tenants, api.container.clock),
    );
    const presentation = await calendar.presentationFor(tenantA);
    const now = Date.now();
    return {
      start: calendar.localOf(new Date(now - 3_600_000), presentation),
      end: calendar.localOf(new Date(now + 86_400_000), presentation),
    };
  }

  const draftBody = async (actions: Record<string, unknown>) => ({
    idempotencyKey: key(),
    name: 'جشنواره',
    description: '',
    ...(await window()),
    audience: { version: 1 },
    actions,
  });

  const discount = {
    kind: 'CODE',
    code: 'autumn20',
    type: 'PERCENTAGE',
    value: '20',
    currency: null,
    appliesTo: ['NEW_SERVICE'],
    productId: null,
    categoryId: null,
    firstPurchaseOnly: false,
    minimumSubtotalAmount: null,
    totalRedemptionsLimit: 100,
    perCustomerLimit: 1,
    priority: 0,
    stackable: false,
  };

  it('drafts, previews, confirms and reports through the contract', async () => {
    const created = await post(CAMPAIGN_ROUTES.create, await draftBody({ discount }));
    expect(created.statusCode, created.body).toBe(201);
    const campaign = campaignResponseSchema.parse(created.json()).campaign;
    expect(campaign.state).toBe('DRAFT');
    expect(campaign.actionKinds).toEqual(['DISCOUNT']);
    // The window round-trips in the tenant's own calendar.
    expect(campaign.startLocal).toEqual((await window()).start);

    const preview = campaignPreviewResponseSchema.parse(
      (await get(CAMPAIGN_ROUTES.preview(campaign.id))).json(),
    );
    const scheduled = await post(CAMPAIGN_ROUTES.schedule(campaign.id), {
      idempotencyKey: key(),
      expectedDefinitionHash: preview.audience.definitionHash,
      expectedRecipients: preview.audience.customers,
      expectedFingerprint: preview.audience.fingerprint,
      confirmed: true,
    });
    expect(scheduled.statusCode, scheduled.body).toBe(201);
    const after = campaignResponseSchema.parse(scheduled.json()).campaign;
    expect(after.state).toBe('SCHEDULED');
    const action = after.actions[0];
    expect(action?.state).toBe('LAUNCHED');
    expect(action?.discountId).not.toBeNull();
    // The rule is the discount engine's own, visible on the discounts surface.
    const rule = await get(`/discounts/${action?.discountId as string}`);
    expect(rule.json()).toMatchObject({
      discount: { code: 'AUTUMN20', status: 'ACTIVE', label: 'جشنواره' },
    });

    // The rule is edited on the discounts page: the campaign shows the rule as it is NOW.
    const edited = await post(`/discounts/${action?.discountId as string}`, {
      idempotencyKey: key(),
      kind: 'CODE',
      code: 'AUTUMN20',
      label: 'جشنواره',
      type: 'PERCENTAGE',
      value: '30',
      currency: null,
      appliesTo: ['NEW_SERVICE'],
      productId: null,
      categoryId: null,
      customerId: null,
      firstPurchaseOnly: false,
      minimumSubtotalAmount: null,
      startsAt: after.startsAt,
      endsAt: after.endsAt,
      totalRedemptionsLimit: 100,
      perCustomerLimit: 1,
      priority: 0,
      stackable: false,
    });
    expect(edited.statusCode, edited.body).toBeLessThan(300);
    await post(`/discounts/${action?.discountId as string}/deactivate`, {
      idempotencyKey: key(),
    });
    const live = campaignResponseSchema.parse((await get(CAMPAIGN_ROUTES.one(campaign.id))).json())
      .campaign.actions[0];
    expect(live?.terms).toMatchObject({ value: '30' });
    expect(live?.ruleStatus).toBe('INACTIVE');

    const list = campaignListResponseSchema.parse((await get(CAMPAIGN_ROUTES.list)).json());
    expect(list.campaigns.map((c) => c.id)).toEqual([campaign.id]);
    const results = campaignResultsResponseSchema.parse(
      (await get(CAMPAIGN_ROUTES.results(campaign.id))).json(),
    );
    expect(results.discountRedemptions).toEqual([]);
  });

  it('charges its own keys and each action’s key, and keeps tenants apart', async () => {
    // Support holds neither campaign key: not even the list.
    expect((await get(CAMPAIGN_ROUTES.list, supportCookie)).statusCode).toBe(403);

    // Sales manages campaigns but may not publish cashback (`catalog.pricing.edit`): a draft
    // holding cashback is refused at once, and one the owner drafted cannot be confirmed.
    const cashback = {
      cashback: { percent: 5, appliesTo: ['NEW_SERVICE'], productId: null, categoryId: null },
    };
    expect(
      (await post(CAMPAIGN_ROUTES.create, await draftBody(cashback), salesCookie)).statusCode,
    ).toBe(403);
    const created = await post(CAMPAIGN_ROUTES.create, await draftBody(cashback));
    expect(created.statusCode, created.body).toBe(201);
    const id = campaignResponseSchema.parse(created.json()).campaign.id;
    const preview = campaignPreviewResponseSchema.parse(
      (await get(CAMPAIGN_ROUTES.preview(id), salesCookie)).json(),
    );
    const refused = await post(
      CAMPAIGN_ROUTES.schedule(id),
      {
        idempotencyKey: key(),
        expectedDefinitionHash: preview.audience.definitionHash,
        expectedRecipients: preview.audience.customers,
        expectedFingerprint: preview.audience.fingerprint,
        confirmed: true,
      },
      salesCookie,
    );
    expect(refused.statusCode).toBe(403);

    // Another tenant's owner cannot see it at all.
    expect((await get(CAMPAIGN_ROUTES.one(id), foreignCookie)).statusCode).toBe(404);
  });
});
