import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX } from '@nexa/contracts';
import {
  buildWorld,
  leaks,
  ORIGIN,
  PAIRS,
  sizedPng,
  victimRows,
  type TenantWorld,
  type World,
} from './fixtures';

/**
 * Phase 6A PR-5 (D3) — the Web Admin API, tenant against tenant.
 *
 * Every case runs over `PAIRS`: a hosted tenant against the installation's PRIMARY and back,
 * and the two hosted tenants against each other. The attacker holds a REAL owner session of
 * its own tenant (every permission there) and aims it at the victim's records:
 *
 *   - READS by the victim's real ids (stronger than guessing them): 404/403, and the same
 *     path with the victim's own session answers 200 — so the refusal is isolation, not a
 *     broken fixture;
 *   - LISTS, searches, reports and exports, plain and with the victim's ids, its tenant id
 *     and its markers pushed in as query parameters and headers: 200 (or a 400 for a
 *     parameter the route does not take) and none of the victim's fingerprints in the body,
 *     while the victim's own call of the same path does show them;
 *   - WRITES on the victim's ids: 404/403, and every victim row read back as the OWNER is
 *     byte-for-byte what it was. Where the payload has no side effect beyond the row, the
 *     victim's own session then sends the same payload and succeeds, which proves the
 *     attacker's payload was valid and was refused for the tenant alone.
 *
 * The app runs as nexa_app (the harness's `createApiApp`), so row-level security is under
 * every statement here; the fixtures and the read-backs are the owner's.
 */

type Path = (victim: TenantWorld) => string;

interface ReadCase {
  readonly surface: string;
  readonly path: Path;
  /** What the victim's own call answers; 200 unless the route is a file Telegram must serve. */
  readonly ownStatus?: (status: number) => boolean;
}

interface ListCase {
  readonly surface: string;
  readonly path: Path;
  /** False for a list whose victim-side call shows no fingerprint (a count-only report). */
  readonly ownShowsData?: boolean;
}

interface WriteCase {
  readonly surface: string;
  readonly path: Path;
  readonly body: (key: string, victim: TenantWorld) => unknown;
  /**
   * The victim's own session repeats it afterwards and must succeed (and change its row),
   * then puts the record back with this path, so the next pair finds the fixture as built.
   */
  readonly control?: { readonly restore: Path };
}

const READS: readonly ReadCase[] = [
  { surface: 'customers', path: (v) => `/users/${v.customerId}` },
  { surface: 'customers', path: (v) => `/users/${v.customerId}/overview` },
  { surface: 'wallet', path: (v) => `/users/${v.customerId}/wallet` },
  { surface: 'wallet', path: (v) => `/users/${v.customerId}/wallet/entries` },
  { surface: 'orders', path: (v) => `/orders/${v.orderId}` },
  { surface: 'products', path: (v) => `/products/${v.productId}` },
  { surface: 'products', path: (v) => `/product-categories/${v.categoryId}` },
  { surface: 'panels', path: (v) => `/panels/${v.panelId}` },
  { surface: 'panels', path: (v) => `/panels/${v.panelId}/advanced` },
  { surface: 'services', path: (v) => `/services/${v.serviceId}` },
  { surface: 'services', path: (v) => `/services/${v.serviceId}/operations` },
  { surface: 'payments', path: (v) => `/payments/${v.paymentId}` },
  { surface: 'payments', path: (v) => `/payments/${v.paymentId}/timeline` },
  { surface: 'payments', path: (v) => `/payments/${v.paymentId}/receipts` },
  { surface: 'tickets', path: (v) => `/tickets/${v.ticketId}` },
  { surface: 'broadcasts', path: (v) => `/broadcasts/${v.broadcastId}` },
  { surface: 'broadcasts', path: (v) => `/broadcasts/${v.broadcastId}/recipients` },
  { surface: 'broadcasts', path: (v) => `/broadcasts/${v.broadcastId}/history` },
  { surface: 'admins', path: (v) => `/admins/${v.staffId}/effective-permissions` },
  { surface: 'admins', path: (v) => `/admins/${v.staffId}/sessions` },
  // File and media access: a file is served by the id of the record that holds it.
  {
    surface: 'files',
    path: (v) => `/payments/${v.paymentId}/receipts/${v.receiptId}/content`,
    // Telegram (the fake) does not hold the file: the victim's own call gets past the
    // lookup and fails on the fetch — anything but "not found" proves the record resolved.
    ownStatus: (status) => status !== 404,
  },
  {
    surface: 'files',
    path: (v) => `/ticket-messages/${v.ticketMessageId}/attachment`,
    ownStatus: (status) => status !== 404,
  },
  // A client app's stored image: bytes the API serves itself, by the entry's id.
  { surface: 'files', path: (v) => `/client-apps/${v.clientAppId}/image` },
  { surface: 'client-apps', path: (v) => `/client-apps/${v.clientAppId}/videos` },
  { surface: 'gift-cards', path: (v) => `/gift-card-batches/${v.giftCardBatchId}` },
  {
    surface: 'gift-cards',
    path: (v) => `/gift-card-batches/${v.giftCardBatchId}/disable-preview`,
  },
  // A gift-card batch's codes: a CSV of bearer instruments, the most valuable export there is.
  { surface: 'exports', path: (v) => `/gift-card-batches/${v.giftCardBatchId}/export` },
];

const LISTS: readonly ListCase[] = [
  { surface: 'customers', path: () => '/users' },
  { surface: 'customers', path: (v) => `/users?q=@cust_${v.marker}` },
  { surface: 'customers', path: (v) => `/users?username=cust_${v.marker}` },
  { surface: 'customers', path: () => '/users?telegramUserId=111111111' },
  { surface: 'customers', path: (v) => `/users?tenantId=${v.tenantId}` },
  { surface: 'orders', path: () => '/orders' },
  { surface: 'orders', path: (v) => `/orders?customerId=${v.customerId}` },
  { surface: 'orders', path: (v) => `/orders?productId=${v.productId}` },
  { surface: 'orders', path: (v) => `/orders?q=${v.marker}` },
  { surface: 'products', path: () => '/products' },
  { surface: 'products', path: (v) => `/products?tenantId=${v.tenantId}` },
  { surface: 'products', path: () => '/product-categories' },
  { surface: 'panels', path: () => '/panels' },
  { surface: 'panels', path: () => '/panel-health' },
  { surface: 'services', path: () => '/services' },
  { surface: 'services', path: (v) => `/services?customerId=${v.customerId}` },
  { surface: 'services', path: (v) => `/services?orderId=${v.orderId}` },
  { surface: 'payments', path: () => '/payments' },
  { surface: 'payments', path: (v) => `/payments?customerId=${v.customerId}` },
  { surface: 'payments', path: (v) => `/payments?orderId=${v.orderId}` },
  { surface: 'payments', path: (v) => `/payments?reference=NX-${v.marker}` },
  { surface: 'tickets', path: () => '/tickets' },
  { surface: 'broadcasts', path: () => '/broadcasts' },
  { surface: 'admins', path: () => '/admins' },
  { surface: 'gift-cards', path: () => '/gift-card-batches' },
  { surface: 'client-apps', path: () => '/client-apps' },
  // Gateways and settings are keyed by provider / key, never by an id: one tenant's list
  // is its own rows, and the fingerprint is the victim's distinct setting value.
  { surface: 'gateways', path: () => '/payment-gateways', ownShowsData: false },
  { surface: 'settings', path: () => '/settings', ownShowsData: false },
  { surface: 'media', path: (v) => `/media/${v.mediaPurpose}`, ownShowsData: false },
  // Search.
  { surface: 'search', path: (v) => `/search?q=${v.marker}` },
  { surface: 'search', path: () => '/search?q=111111111' },
  { surface: 'search', path: (v) => `/search?q=${v.paymentCode}` },
  { surface: 'search', path: (v) => `/search?q=svc${v.marker}` },
  // Audit log (an operator's view of who did what) and its filters.
  { surface: 'audit', path: () => '/audit-log' },
  { surface: 'audit', path: (v) => `/audit-log?customerId=${v.customerId}` },
  { surface: 'audit', path: (v) => `/audit-log?actor=owner-${v.marker}` },
  // Exports: the bytes of a downloaded file.
  { surface: 'exports', path: () => '/audit-log/export' },
  { surface: 'exports', path: (v) => `/audit-log/export?customerId=${v.customerId}` },
  {
    surface: 'exports',
    path: () => '/reports/export?report=SALES&format=csv&range=LAST_7_DAYS',
    ownShowsData: false,
  },
  {
    surface: 'exports',
    path: () => '/reports/export?report=PAYMENTS&format=csv&range=LAST_7_DAYS',
    ownShowsData: false,
  },
  // Reports carry figures, not records: the fingerprint is the victim's distinct amount.
  { surface: 'reports', path: () => '/reports/summary?range=LAST_7_DAYS', ownShowsData: false },
  { surface: 'reports', path: () => '/reports/orders?range=LAST_7_DAYS', ownShowsData: false },
  { surface: 'reports', path: () => '/reports/products?range=LAST_7_DAYS', ownShowsData: false },
  { surface: 'reports', path: () => '/reports/wallet?range=LAST_7_DAYS', ownShowsData: false },
  { surface: 'reports', path: () => '/reports/payments?range=LAST_7_DAYS', ownShowsData: false },
];

const WRITES: readonly WriteCase[] = [
  {
    surface: 'customers',
    path: (v) => `/users/${v.customerId}/block`,
    body: (key) => ({ idempotencyKey: key, reason: 'cross-tenant attempt' }),
  },
  {
    surface: 'wallet',
    path: (v) => `/users/${v.customerId}/wallet/adjust`,
    body: (key) => ({
      idempotencyKey: key,
      direction: 'DEBIT',
      amount: '1000',
      currency: 'IRT',
      note: 'cross-tenant attempt',
    }),
  },
  {
    surface: 'products',
    path: (v) => `/products/${v.productId}/deactivate`,
    body: (key) => ({ idempotencyKey: key }),
    control: { restore: (v) => `/products/${v.productId}/activate` },
  },
  {
    surface: 'products',
    path: (v) => `/product-categories/${v.categoryId}/hide`,
    body: (key) => ({ idempotencyKey: key }),
    control: { restore: (v) => `/product-categories/${v.categoryId}/show` },
  },
  {
    surface: 'panels',
    path: (v) => `/panels/${v.panelId}/status`,
    body: (key) => ({ idempotencyKey: key, status: 'DISABLED' }),
  },
  {
    surface: 'services',
    path: (v) => `/services/${v.serviceId}/suspend`,
    body: (key) => ({ idempotencyKey: key }),
  },
  {
    surface: 'tickets',
    path: (v) => `/tickets/${v.ticketId}/status`,
    body: () => ({ status: 'CLOSED' }),
  },
  {
    surface: 'broadcasts',
    path: (v) => `/broadcasts/${v.broadcastId}/cancel`,
    body: () => ({}),
  },
  {
    surface: 'admins',
    path: (v) => `/admins/${v.staffId}/status`,
    body: () => ({ status: 'DISABLED', reason: 'cross-tenant attempt' }),
  },
  {
    surface: 'gift-cards',
    path: (v) => `/gift-card-batches/${v.giftCardBatchId}/disable`,
    body: (key) => ({
      idempotencyKey: key,
      reason: 'cross-tenant attempt',
      expectedUnredeemed: 2,
      confirmed: true,
    }),
  },
  {
    surface: 'client-apps',
    path: (v) => `/client-apps/${v.clientAppId}/status`,
    body: (key) => ({ idempotencyKey: key, status: 'DISABLED', expectedVersion: 2 }),
  },
  {
    surface: 'files',
    path: (v) => `/client-apps/${v.clientAppId}/image`,
    body: (key) => ({
      idempotencyKey: key,
      expectedVersion: 2,
      mimeType: 'image/png',
      contentBase64: sizedPng(128, 128, 200).toString('base64'),
    }),
  },
  {
    surface: 'files',
    path: (v) => `/client-apps/${v.clientAppId}/image/clear`,
    body: (key) => ({ idempotencyKey: key, expectedVersion: 2 }),
  },
  {
    surface: 'admins',
    path: (v) => `/admins/${v.staffId}/sessions/revoke`,
    body: () => ({ reason: 'cross-tenant attempt' }),
  },
];

describe('isolation proof (PR-5) — the Web Admin API', () => {
  let world: World;

  beforeAll(async () => {
    world = await buildWorld();
  }, 180_000);

  afterAll(async () => {
    await world?.close();
  });

  const get = (who: TenantWorld, path: string, headers: Record<string, string> = {}) =>
    world.inject({
      method: 'GET',
      url: `${API_PREFIX}${path}`,
      headers: { cookie: who.cookie, ...headers },
    });
  const post = (who: TenantWorld, path: string, payload: unknown) =>
    world.inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: { cookie: who.cookie, origin: ORIGIN },
      payload: payload as never,
    });
  /** The victim's figures: none may show up in another tenant's report. */
  const amounts = (v: TenantWorld) => [v.orderAmountMinor, v.walletAmountMinor];
  /** Each tenant's own value of the one setting the fixtures write (4 / 5 / 6). */
  const SETTING = 'ops.notifications.max_attempts';
  const settingOf = (v: TenantWorld) =>
    v.label === 'PRIMARY' ? 4 : v.label === 'HOSTED_1' ? 5 : 6;
  const listedSetting = (body: string) =>
    (JSON.parse(body) as { settings: { key: string; value: unknown; version: number | null }[] })
      .settings.find((row) => row.key === SETTING);

  it('runs as the application role, which row-level security binds', async () => {
    expect(await world.api.container.database.scopeEnforcement()).toBe('owner');
    const app = await world.api.container.uow.run(world.tenants.HOSTED_1.scope, (tx) =>
      (tx as { tx: { execute: (q: unknown) => Promise<{ rows: { who: string }[] }> } }).tx.execute(
        sql`SELECT current_user AS who`,
      ),
    );
    expect(app.rows[0]?.who).toBe('nexa_app');
  });

  describe.each(PAIRS)('%s → %s', (attackerLabel, victimLabel) => {
    const attacker = () => world.tenants[attackerLabel];
    const victim = () => world.tenants[victimLabel];

    it.each(READS.map((c) => [c.surface, c] as const))(
      'read %s by the victim’s id is refused: %#',
      async (_surface, c) => {
        const path = c.path(victim());
        const refused = await get(attacker(), path);
        expect([403, 404], `${path}: ${refused.body}`).toContain(refused.statusCode);
        expect(leaks(refused.body, victim()), path).toEqual([]);
        // Not vacuous: the victim's own session reaches the record.
        const own = await get(victim(), path);
        const ownOk = c.ownStatus ?? ((status: number) => status === 200);
        expect(ownOk(own.statusCode), `${path} as its owner: ${own.statusCode} ${own.body}`).toBe(
          true,
        );
      },
    );

    it.each(LISTS.map((c) => [c.surface, c] as const))(
      'list %s shows none of the victim’s rows: %#',
      async (_surface, c) => {
        const path = c.path(victim());
        // The victim's tenant id in every header a proxy or a client could try.
        const listed = await get(attacker(), path, {
          'x-tenant-id': victim().tenantId,
          'x-nexa-tenant': victim().tenantId,
        });
        expect([200, 400], `${path}: ${listed.body}`).toContain(listed.statusCode);
        expect(leaks(listed.body, victim()), path).toEqual([]);
        for (const figure of amounts(victim())) {
          expect(listed.body.includes(figure), `${path} carries ${figure}`).toBe(false);
        }
        if (c.surface === 'settings') {
          expect(listedSetting(listed.body)?.value).toBe(settingOf(attacker()));
        }
        // Not vacuous: the same path, as the victim, shows the victim's data.
        const own = await get(victim(), path);
        expect(own.statusCode, `${path} as its owner: ${own.body}`).toBe(listed.statusCode);
        if (c.ownShowsData !== false && listed.statusCode === 200) {
          expect(leaks(own.body, victim()).length, `${path} as its owner`).toBeGreaterThan(0);
        }
        if (c.surface === 'settings') {
          expect(listedSetting(own.body)?.value).toBe(settingOf(victim()));
        }
      },
    );

    it.each(WRITES.map((c) => [c.surface, c] as const))(
      'write %s on the victim’s record is refused and changes no row: %#',
      async (_surface, c) => {
        const path = c.path(victim());
        const before = await victimRows(world, victim());
        const refused = await post(attacker(), path, c.body(world.key(), victim()));
        expect([403, 404], `${path}: ${refused.body}`).toContain(refused.statusCode);
        expect(leaks(refused.body, victim()), path).toEqual([]);
        expect(await victimRows(world, victim())).toBe(before);
        if (c.control !== undefined) {
          const own = await post(victim(), path, c.body(world.key(), victim()));
          expect(own.statusCode, `${path} as its owner: ${own.body}`).toBeLessThan(300);
          expect(await victimRows(world, victim())).not.toBe(before);
          const back = await post(victim(), c.control.restore(victim()), {
            idempotencyKey: world.key(),
          });
          expect(back.statusCode, back.body).toBeLessThan(300);
        }
      },
    );

    it('a gateway or setting written by the attacker lands in the attacker’s tenant only', async () => {
      const before = await victimRows(world, victim());
      const gateways = await get(attacker(), '/payment-gateways');
      expect(gateways.statusCode).toBe(200);
      const provider = (gateways.json() as { gateways: { provider: string; status: string }[] })
        .gateways.find((row) => row.status === 'ACTIVE')?.provider;
      expect(provider).toBeDefined();
      const toggled = await post(attacker(), `/payment-gateways/${String(provider)}/status`, {
        idempotencyKey: world.key(),
        status: 'DISABLED',
      });
      expect(toggled.statusCode, toggled.body).toBeLessThan(300);
      const restored = await post(attacker(), `/payment-gateways/${String(provider)}/status`, {
        idempotencyKey: world.key(),
        status: 'ACTIVE',
      });
      expect(restored.statusCode, restored.body).toBeLessThan(300);

      // Written and written back, so every later case still sees the fixtures' values.
      for (const value of [8, settingOf(attacker())]) {
        const current = listedSetting((await get(attacker(), '/settings')).body);
        const written = await post(attacker(), `/settings/${SETTING}`, {
          value,
          expectedVersion: current?.version ?? null,
          idempotencyKey: world.key(),
        });
        expect(written.statusCode, written.body).toBeLessThan(300);
      }
      expect(await victimRows(world, victim())).toBe(before);
      // And the victim's own value is what it was.
      expect(listedSetting((await get(victim(), '/settings')).body)?.value).toBe(
        settingOf(victim()),
      );
    });
  });
});
