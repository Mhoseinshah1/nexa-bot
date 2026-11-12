import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  money,
  type ResellerAutoRenew,
  type ResellerClient,
  type ResellerPurchaseQuote,
  type ResellerRenewAllResult,
  type UserId,
} from '@nexa/contracts';
import { tenantA } from './harness';
import { codeOf, useSellingHarness } from './reseller-selling-harness';

/**
 * PR-5 §5.6 — the clients book («مشتری‌ها») and auto-renew on the reseller panel.
 *
 * Proves: create / list / edit / archive (never deleted); one reseller never sees, edits,
 * archives or files under another's client; a service is filed only under a client of its OWN
 * reseller; the services list carries the client and filters by it; the client chosen at
 * purchase labels the services once they exist; «تمدید همه» renews each ACTIVE service once
 * with the total pre-checked (a short wallet charges nothing); auto-renew is Round 10 D1's
 * consent, and an imported service needs the plan chosen at opt-in (OQ-R10-D1-01), which the
 * sweep then renews into.
 */
describe('the reseller web panel — clients book and auto-renew (PR-5)', () => {
  const h = useSellingHarness('rwc');

  async function newClient(cookie: string, name = 'علی رضایی', contact: string | null = '@ali') {
    const response = await h().call(cookie, 'POST', '/clients', { name, contact, note: 'VIP' });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as ResellerClient;
  }

  const clientRows = async (customerId: UserId) =>
    (
      await h()
        .db()
        .execute(
          sql`SELECT id, archived_at FROM reseller_clients WHERE customer_id = ${customerId}::uuid`,
        )
    ).rows as { id: string; archived_at: string | null }[];

  it('creates, lists, edits and archives a client — never deletes it', async () => {
    const cookie = await h().signedIn();
    const made = await newClient(cookie);
    expect(made).toMatchObject({
      name: 'علی رضایی',
      contact: '@ali',
      note: 'VIP',
      archived: false,
    });
    const edited = await h().call(cookie, 'PUT', `/clients/${made.id}`, {
      name: 'علی',
      contact: null,
      note: '',
    });
    expect(edited.json()).toMatchObject({ name: 'علی', contact: null, note: null });
    const tooLong = await h().call(cookie, 'POST', '/clients', { name: 'x'.repeat(81) });
    expect(tooLong.statusCode).toBe(400);

    const archived = await h().call(cookie, 'POST', `/clients/${made.id}/archive`);
    expect(archived.json()).toMatchObject({ archived: true });
    const live = (await h().call(cookie, 'GET', '/clients')).json() as { items: unknown[] };
    expect(live.items).toHaveLength(0);
    const old = (await h().call(cookie, 'GET', '/clients?archived=true')).json() as {
      items: { id: string }[];
    };
    expect(old.items.map((item) => item.id)).toEqual([made.id]);
    // Still there: archived, not deleted.
    expect(await clientRows(h().reseller)).toHaveLength(1);
  });

  it('isolates the clients books of two resellers', async () => {
    const mine = await h().signedIn();
    const theirs = await h().signedIn(h().other);
    const client = await newClient(mine);
    const service = await h().delivered(h().other);

    expect(
      ((await h().call(theirs, 'GET', '/clients')).json() as { items: unknown[] }).items,
    ).toHaveLength(0);
    for (const [method, path, body] of [
      ['GET', `/clients/${client.id}/services`, undefined],
      ['PUT', `/clients/${client.id}`, { name: 'x' }],
      ['POST', `/clients/${client.id}/archive`, undefined],
      ['GET', `/clients/${client.id}/renew-all`, undefined],
      ['POST', `/clients/${client.id}/renew-all`, undefined],
      // Their own service under MY client: my client is not theirs to use.
      ['PUT', `/services/${service.id}/client`, { clientId: client.id }],
    ] as const) {
      const response = await h().call(theirs, method, path, body);
      expect(response.statusCode, `${method} ${path}`).toBe(404);
      expect(codeOf(response)).toBe('reseller_web.not_found');
    }
    // Their service under my client, from my side: not my service.
    const foreign = await h().call(mine, 'PUT', `/services/${service.id}/client`, {
      clientId: client.id,
    });
    expect(foreign.statusCode).toBe(404);
    const filed = await h()
      .db()
      .execute(sql`SELECT 1 FROM reseller_client_services`);
    expect(filed.rows).toHaveLength(0);
    expect((await clientRows(h().reseller))[0]?.archived_at).toBeNull();
  });

  it('files a service under a client, and the services list carries and filters by it', async () => {
    const cookie = await h().signedIn();
    const client = await newClient(cookie);
    const filed = await h().delivered(h().reseller);
    const loose = await h().delivered(h().reseller);
    const put = await h().call(cookie, 'PUT', `/services/${filed.id}/client`, {
      clientId: client.id,
    });
    expect(put.json()).toEqual({ clientId: client.id });

    const all = (await h().call(cookie, 'GET', '/services')).json() as {
      items: { id: string; client: string | null; clientId: string | null }[];
    };
    expect(all.items.find((row) => row.id === filed.id)).toMatchObject({
      client: 'علی رضایی',
      clientId: client.id,
    });
    expect(all.items.find((row) => row.id === loose.id)?.client).toBeNull();
    const only = (await h().call(cookie, 'GET', `/services?clientId=${client.id}`)).json() as {
      items: { id: string }[];
    };
    expect(only.items.map((row) => row.id)).toEqual([filed.id]);

    const book = (await h().call(cookie, 'GET', '/clients')).json() as {
      items: { serviceCount: number }[];
    };
    expect(book.items[0]?.serviceCount).toBe(1);
    const listed = (await h().call(cookie, 'GET', `/clients/${client.id}/services`)).json() as {
      items: { id: string; autoRenew: ResellerAutoRenew }[];
    };
    expect(listed.items.map((row) => row.id)).toEqual([filed.id]);
    // The flag is off by default: the switch says why it cannot be turned on.
    expect(listed.items[0]?.autoRenew).toMatchObject({
      enabled: false,
      unavailable: 'FEATURE_OFF',
    });

    // Taken out again.
    await h().call(cookie, 'PUT', `/services/${filed.id}/client`, { clientId: null });
    const after = (await h().call(cookie, 'GET', '/clients')).json() as {
      items: { serviceCount: number }[];
    };
    expect(after.items[0]?.serviceCount).toBe(0);
  });

  it('labels the services of a purchase with the client chosen when buying', async () => {
    const cookie = await h().signedIn();
    const client = await newClient(cookie);
    const plan = await h().product();
    await h().credit(h().reseller, 400_000n);
    const quoted = (
      await h().call(cookie, 'POST', '/purchases/quote', {
        plan: { kind: 'PLAN', productId: plan },
        quantity: 2,
        username: { mode: 'AUTOMATIC' },
        clientId: client.id,
        note: 'برای علی',
      })
    ).json() as ResellerPurchaseQuote;
    await h().call(cookie, 'POST', `/purchases/${quoted.batchId}/confirm`);
    await h().api.container.provisionerLoop.tick();
    const services = (await h().call(cookie, 'GET', `/services?clientId=${client.id}`)).json() as {
      items: { note: string | null }[];
    };
    expect(services.items).toHaveLength(2);
    expect(services.items.every((row) => row.note === 'برای علی')).toBe(true);
  });

  it('renews every ACTIVE service of a client once, the total pre-checked — a short wallet charges nothing', async () => {
    const cookie = await h().signedIn();
    const client = await newClient(cookie);
    const first = await h().delivered(h().reseller);
    const second = await h().delivered(h().reseller);
    for (const service of [first, second]) {
      await h().call(cookie, 'PUT', `/services/${service.id}/client`, { clientId: client.id });
    }
    const quote = (await h().call(cookie, 'GET', `/clients/${client.id}/renew-all`)).json() as {
      count: number;
      total: { amountMinor: string };
      sufficient: boolean;
    };
    expect(quote).toMatchObject({ count: 2, total: { amountMinor: '400000' }, sufficient: false });

    await h().credit(h().reseller, 300_000n);
    const short = await h().call(cookie, 'POST', `/clients/${client.id}/renew-all`);
    expect(short.statusCode).toBe(409);
    expect(codeOf(short)).toBe('commerce.wallet_insufficient_funds');
    expect(await h().balance(h().reseller)).toBe(300_000n);

    await h().credit(h().reseller, 100_000n);
    const key = randomUUID();
    const renewed = await h().call(
      cookie,
      'POST',
      `/clients/${client.id}/renew-all`,
      undefined,
      key,
    );
    expect(renewed.statusCode, renewed.body).toBe(200);
    expect((renewed.json() as ResellerRenewAllResult).items.map((item) => item.status)).toEqual([
      'RENEWED',
      'RENEWED',
    ]);
    expect(await h().balance(h().reseller)).toBe(0n);
    // A replay renews nothing twice.
    const again = await h().call(cookie, 'POST', `/clients/${client.id}/renew-all`, undefined, key);
    expect(again.statusCode, again.body).toBe(200);
    expect(await h().balance(h().reseller)).toBe(0n);
  });

  it('auto-renew: the D1 consent per service; an imported one needs the plan chosen at opt-in', async () => {
    await h().setFlag('service_auto_renew', true);
    const cookie = await h().signedIn();
    const native = await h().delivered(h().reseller);
    const state = (
      await h().call(cookie, 'GET', `/services/${native.id}/auto-renew`)
    ).json() as ResellerAutoRenew;
    expect(state).toMatchObject({
      enabled: false,
      offered: true,
      imported: false,
      unavailable: null,
    });
    const on = await h().call(cookie, 'PUT', `/services/${native.id}/auto-renew`, {
      enabled: true,
      expected: state.price,
    });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ enabled: true, price: { amountMinor: '200000' } });
    const source = await h()
      .db()
      .execute(
        sql`SELECT source FROM service_auto_renew_preferences WHERE service_id = ${native.id}::uuid`,
      );
    expect(source.rows[0]).toEqual({ source: 'RESELLER_WEB' });

    // An imported (Mirza) service: unavailable until a plan is chosen.
    const imported = await h().delivered(h().reseller);
    await h()
      .db()
      .execute(
        sql`UPDATE services SET source = 'MIRZA', source_ref = ${`service:${imported.id}`} WHERE id = ${imported.id}::uuid`,
      );
    const offer = (
      await h().call(cookie, 'GET', `/services/${imported.id}/auto-renew`)
    ).json() as ResellerAutoRenew;
    expect(offer).toMatchObject({ imported: true, offered: false, unavailable: 'PLAN_REQUIRED' });
    expect(offer.plans.length).toBeGreaterThan(0);
    const bare = await h().call(cookie, 'PUT', `/services/${imported.id}/auto-renew`, {
      enabled: true,
      expected: offer.plans[0]?.price,
    });
    expect(bare.statusCode).toBe(409);
    expect(codeOf(bare)).toBe('reseller_web.auto_renew_plan_required');
    const chosen = offer.plans[0] as ResellerAutoRenew['plans'][number];
    const withPlan = await h().call(cookie, 'PUT', `/services/${imported.id}/auto-renew`, {
      enabled: true,
      expected: chosen.price,
      planId: chosen.planId,
    });
    expect(withPlan.statusCode, withPlan.body).toBe(200);
    expect(withPlan.json()).toMatchObject({
      enabled: true,
      planId: chosen.planId,
      price: chosen.price,
    });

    // The sweep renews it into the chosen plan once it is due (lead time ahead of the deadline).
    await h().credit(h().reseller, BigInt(chosen.price.amountMinor));
    await h()
      .db()
      .execute(
        sql`UPDATE services SET expires_at = now() + interval '2 hours' WHERE id = ${imported.id}::uuid`,
      );
    const report = await h().api.container.serviceAutoRenew.runOnce(tenantA);
    expect(report.renewed).toBe(1);
    const renewal = await h()
      .db()
      .execute(
        sql`SELECT o.product_id FROM orders o JOIN service_commercial_actions c ON c.order_id = o.id
             WHERE c.service_id = ${imported.id}::uuid AND o.state = 'PAID'`,
      );
    expect(renewal.rows).toEqual([{ product_id: chosen.planId }]);
  });

  it('an imported service is never auto-renewed for an ordinary customer, plan or not', async () => {
    await h().setFlag('service_auto_renew', true);
    const ordinary = await h().customer('943099', 'مشتری');
    const service = await h().delivered(ordinary);
    await h()
      .db()
      .execute(
        sql`UPDATE services SET source = 'MIRZA', source_ref = ${`service:${service.id}`} WHERE id = ${service.id}::uuid`,
      );
    const plan = await h().product();
    await expect(
      h().api.container.serviceAutoRenew.set(
        tenantA,
        {
          type: 'SYSTEM_JOB',
          id: null,
          label: 'telegram-update:test',
          surface: 'TELEGRAM',
          correlationId: 'c' as never,
        },
        ordinary,
        {
          serviceId: service.id,
          enabled: true,
          expected: money(10_000_000n, 'IRT'),
          planId: plan,
          idempotencyKey: randomUUID(),
        },
      ),
    ).rejects.toMatchObject({ code: 'commerce.auto_renew_not_available' });
  });
});
