import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MINIAPP_API_PREFIX, MINIAPP_ROUTES, miniAppPath } from '@nexa/contracts';
import { resetAntiSpamWindows } from '../harness';
import {
  buildWorld,
  leaks,
  PAIRS,
  png,
  TWIN_TELEGRAM_USER_ID,
  victimRows,
  type TenantWorld,
  type World,
} from './fixtures';

/**
 * Phase 6A PR-5 (D3) — the customer Mini App, tenant against tenant.
 *
 * The customer is the TWIN: the same Telegram user is a customer of every tenant. A launch
 * from tenant X's bot must mint a session for X's customer and for nobody else, and that
 * session must not reach the same person's orders, services, payments, tickets or wallet in
 * the other tenant — by id or in a list. A launch signed with one bot's token is not a launch
 * of another bot, in either direction.
 */

function initDataFor(token: string, telegramUserId: number, seq: number): string {
  const fields: Record<string, string> = {
    query_id: `iso-${String(telegramUserId)}-${String(seq)}`,
    user: JSON.stringify({ id: telegramUserId, first_name: 'Twin' }),
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const check = Object.keys(fields)
    .sort()
    .map((name) => `${name}=${fields[name]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe('isolation proof (PR-5) — the Mini App', () => {
  let world: World;
  let seq = 0;

  beforeAll(async () => {
    world = await buildWorld();
    for (const tenant of Object.values(world.tenants)) {
      const current = await world.api.container.featureFlagResolver.resolve(
        tenant.scope,
        'mini_app' as never,
      );
      await world.api.container.featureFlags.set(tenant.scope, tenant.ownerActor, {
        key: 'mini_app' as never,
        enabled: true,
        expectedVersion: current.version,
        idempotencyKey: world.key(),
        reason: 'isolation proof',
      });
    }
  }, 180_000);

  afterAll(async () => {
    await world?.close();
  });

  // The launch and request budgets are per address and per customer, and every case here
  // is the same address and the same twin: each case starts with a fresh budget.
  beforeEach(async () => {
    await resetAntiSpamWindows();
  });

  const mint = (botId: string, token: string) =>
    world.inject({
      method: 'POST',
      url: `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.session, { botInstanceId: botId })}`,
      payload: { initData: initDataFor(token, Number(TWIN_TELEGRAM_USER_ID), (seq += 1)) },
    });
  const sessionOf = async (tenant: TenantWorld): Promise<string> => {
    const response = await mint(tenant.botId, tenant.botToken);
    expect(response.statusCode, response.body).toBe(201);
    return (response.json() as { token: string }).token;
  };
  const call = (token: string, method: 'GET' | 'POST', path: string, payload?: unknown) =>
    world.inject({
      method,
      url: `${MINIAPP_API_PREFIX}${path}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': world.key() }),
      },
      ...(payload === undefined ? {} : { payload }),
    });

  /** The victim's records, each by its own id, through the mini app's own routes. */
  const BY_ID: readonly ((v: TenantWorld) => string)[] = [
    (v) => miniAppPath(MINIAPP_ROUTES.order, { orderId: v.orderId }),
    (v) => miniAppPath(MINIAPP_ROUTES.payment, { paymentId: v.paymentId }),
    (v) => miniAppPath(MINIAPP_ROUTES.service, { serviceId: v.serviceId }),
    (v) => miniAppPath(MINIAPP_ROUTES.ticket, { ticketId: v.ticketId }),
    // Files drawn from a record: the service's subscription QR (an image) and its locations.
    (v) => miniAppPath(MINIAPP_ROUTES.serviceQr, { serviceId: v.serviceId }),
    (v) => miniAppPath(MINIAPP_ROUTES.serviceLocations, { serviceId: v.serviceId }),
  ];
  // There is no order list in the mini app (orders are reached through payments and
  // services), and the notifications screen is behind its own flag.
  const LISTS: readonly string[] = [
    MINIAPP_ROUTES.me,
    MINIAPP_ROUTES.payments,
    MINIAPP_ROUTES.services,
    MINIAPP_ROUTES.tickets,
    MINIAPP_ROUTES.ticketCategories,
    MINIAPP_ROUTES.categories,
    MINIAPP_ROUTES.wallet,
    MINIAPP_ROUTES.walletEntries,
    MINIAPP_ROUTES.servers,
  ];
  const WRITES: readonly ((v: TenantWorld) => string)[] = [
    (v) => miniAppPath(MINIAPP_ROUTES.orderCancel, { orderId: v.orderId }),
    (v) => miniAppPath(MINIAPP_ROUTES.paymentTransferSent, { paymentId: v.paymentId }),
    (v) => miniAppPath(MINIAPP_ROUTES.serviceAutoRenew, { serviceId: v.serviceId }),
  ];

  describe.each(PAIRS)('%s → %s', (attackerLabel, victimLabel) => {
    const attacker = () => world.tenants[attackerLabel];
    const victim = () => world.tenants[victimLabel];

    it('a launch from the attacker’s bot is the attacker’s own customer, never the twin', async () => {
      const token = await sessionOf(attacker());
      const me = await call(token, 'GET', MINIAPP_ROUTES.me);
      expect(me.statusCode, me.body).toBe(200);
      expect(leaks(me.body, victim())).toEqual([]);
      const session = await world.api.container.database.db.execute<{ tenant_id: string }>(
        sql`SELECT c.tenant_id FROM customers c
          WHERE c.telegram_user_id = ${TWIN_TELEGRAM_USER_ID} AND c.tenant_id = ${victim().tenantId}`,
      );
      // The victim still has exactly its one twin; nothing was minted there.
      expect(session.rows).toHaveLength(1);
    });

    it.each(BY_ID.map((path, index) => [index, path] as const))(
      'reads the victim’s record by id as not found: %i',
      async (_index, path) => {
        const token = await sessionOf(attacker());
        const refused = await call(token, 'GET', path(victim()));
        expect([403, 404], `${path(victim())}: ${refused.body}`).toContain(refused.statusCode);
        expect(leaks(refused.body, victim())).toEqual([]);
        // Not vacuous: the victim's own launch reaches it (or at least past "not found").
        const own = await call(await sessionOf(victim()), 'GET', path(victim()));
        expect(own.statusCode, `${path(victim())} as its owner: ${own.body}`).not.toBe(404);
      },
    );

    it.each(LISTS.map((path) => [path] as const))(
      'lists %s without one of the victim’s rows',
      async (path) => {
        const token = await sessionOf(attacker());
        const listed = await call(token, 'GET', path);
        expect(listed.statusCode, `${path}: ${listed.body}`).toBe(200);
        expect(leaks(listed.body, victim()), path).toEqual([]);
        expect(listed.body.includes(victim().walletAmountMinor), path).toBe(false);
      },
    );

    it('a category of the victim’s, opened by id, lists none of its products', async () => {
      const path = miniAppPath(MINIAPP_ROUTES.category, { categoryId: victim().categoryId });
      const listed = await call(await sessionOf(attacker()), 'GET', path);
      expect([200, 403, 404], listed.body).toContain(listed.statusCode);
      expect(leaks(listed.body, victim())).toEqual([]);
      // The route itself answers the victim (its product is not sellable without a validated
      // panel, so the page is empty there too; the leak check above is what matters).
      const own = await call(await sessionOf(victim()), 'GET', path);
      expect(own.statusCode, own.body).toBe(200);
    });

    it('shows the attacker its OWN balance, not the twin’s', async () => {
      const wallet = await call(await sessionOf(attacker()), 'GET', MINIAPP_ROUTES.wallet);
      expect(wallet.statusCode, wallet.body).toBe(200);
      expect(wallet.body).toContain(attacker().walletAmountMinor);
      expect(wallet.body).not.toContain(victim().walletAmountMinor);
    });

    it.each(WRITES.map((path, index) => [index, path] as const))(
      'a write on the victim’s record is refused and changes no row: %i',
      async (_index, path) => {
        const token = await sessionOf(attacker());
        const before = await victimRows(world, victim());
        const refused = await call(token, 'POST', path(victim()), { enabled: false });
        expect([400, 403, 404], `${path(victim())}: ${refused.body}`).toContain(refused.statusCode);
        if (refused.statusCode === 400) {
          // A 400 must be the body, not a lookup that passed: the same call on the
          // attacker's own record answers the same 400 or succeeds.
          const own = await call(token, 'POST', path(attacker()), { enabled: false });
          expect(own.statusCode).not.toBe(404);
        }
        expect(await victimRows(world, victim())).toBe(before);
      },
    );

    it('a receipt image uploaded onto the victim’s payment is refused and files nothing', async () => {
      const receipts = async () =>
        (
          (
            await world.api.container.database.db.execute(
              sql`SELECT count(*)::int AS n FROM payment_receipts WHERE tenant_id = ${victim().tenantId}`,
            )
          ).rows[0] as { n: number }
        ).n;
      const path = miniAppPath(MINIAPP_ROUTES.paymentReceipt, { paymentId: victim().paymentId });
      const body = { mimeType: 'image/png', imageBase64: png(96).toString('base64') };
      const before = await victimRows(world, victim());
      const count = await receipts();
      const refused = await call(await sessionOf(attacker()), 'POST', path, body);
      expect([403, 404], `${path}: ${refused.body}`).toContain(refused.statusCode);
      expect(leaks(refused.body, victim())).toEqual([]);
      expect(await victimRows(world, victim())).toBe(before);
      expect(await receipts()).toBe(count);
      // Not vacuous: the victim's own launch gets past the lookup with the same body.
      const own = await call(await sessionOf(victim()), 'POST', path, body);
      expect(own.statusCode, `${path} as its owner: ${own.body}`).not.toBe(404);
    });

    it('a launch signed with one bot’s token is refused by the other bot, both ways', async () => {
      const forged = await mint(victim().botId, attacker().botToken);
      expect([401, 403], forged.body).toContain(forged.statusCode);
      const reversed = await mint(attacker().botId, victim().botToken);
      expect([401, 403], reversed.body).toContain(reversed.statusCode);
      expect(leaks(forged.body + reversed.body, victim())).toEqual([]);
    });
  });
});
