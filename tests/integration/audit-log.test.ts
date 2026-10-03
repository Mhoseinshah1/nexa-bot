import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUDIT_LOG_EXPORT_ROW_MAX,
  AUDIT_LOG_ROUTES,
  AUTH_ROUTES,
  SESSION_COOKIE_NAME,
  auditLogListResponseSchema,
  type AuditLogEntry,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, tenantB, testConfig } from './harness';

/**
 * Phase D1 — the audit log browser and its export, over real HTTP and real SQL
 * (`docs/audit-log.md`).
 *
 * Rows are written straight into `audit_logs` (an INSERT is what the append-only guard
 * allows), at fixed instants in the past, so every filter below is asserted against a set
 * worked out by hand. Logging in writes `auth.login` rows of its own; those are at the
 * wall clock, after every fixture instant, and every assertion either filters them out by
 * range or names them.
 */

const ORIGIN = 'https://admin.example.test';
const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);
const at = (minutes: number, ms = 0): string => new Date(T0 + minutes * 60_000 + ms).toISOString();
/** The fixture's own window: every hand-written row, no login row. */
const WINDOW = `from=${encodeURIComponent(at(-10_000))}&to=${encodeURIComponent(at(10_000))}`;

describe('Phase D1: the audit log', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let financeCookie: string;
  let supportCookie: string;
  let foreignCookie: string;
  let ownerId: string;
  let financeId: string;
  const uuid = (): string => api.container.ids.uuid();
  const run = (query: ReturnType<typeof sql>) => api.container.database.db.execute(query);

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  const get = (path: string, cookie: string | null = ownerCookie) =>
    inject({
      method: 'GET',
      url: `${API_PREFIX}${path}`,
      headers: cookie === null ? { origin: ORIGIN } : { cookie, origin: ORIGIN },
    });

  const list = async (query: string, cookie: string = ownerCookie) => {
    const response = await get(`${AUDIT_LOG_ROUTES.list}?${query}`, cookie);
    expect(response.statusCode, response.body).toBe(200);
    return auditLogListResponseSchema.parse(response.json());
  };

  /** Every page of a filter, at a given page size, in order. */
  const walk = async (query: string, limit: number): Promise<AuditLogEntry[]> => {
    const all: AuditLogEntry[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 1_000; pages += 1) {
      const page = await list(
        `${query}&limit=${String(limit)}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      all.push(...page.entries);
      cursor = page.nextCursor;
      if (cursor === null) return all;
    }
    throw new Error('the walk did not end');
  };

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

  interface Row {
    tenantId?: string | null;
    at: string;
    action: string;
    entityType?: string;
    entityId?: string | null;
    actorType?: string;
    actorId?: string | null;
    actorLabel?: string | null;
    result?: 'SUCCESS' | 'DENIED' | 'FAILED';
    before?: unknown;
    after?: unknown;
    reason?: string | null;
    id?: string;
  }

  async function row(r: Row): Promise<string> {
    const id = r.id ?? uuid();
    await run(sql`INSERT INTO audit_logs
        (id, tenant_id, occurred_at, actor_type, actor_id, actor_label, action, entity_type,
         entity_id, before, after, reason, correlation_id, source_surface, ip, user_agent, result)
      VALUES (${id}, ${r.tenantId === undefined ? tenantA.tenantId : r.tenantId},
        ${r.at}::timestamptz, ${r.actorType ?? 'WEB_ADMIN'}, ${r.actorId === undefined ? ownerId : r.actorId},
        ${r.actorLabel === undefined ? 'owner' : r.actorLabel}, ${r.action}, ${r.entityType ?? 'Panel'},
        ${r.entityId === undefined ? uuid() : r.entityId},
        ${r.before === undefined ? null : JSON.stringify(r.before)}::jsonb,
        ${r.after === undefined ? null : JSON.stringify(r.after)}::jsonb,
        ${r.reason ?? null}, ${`corr-${id}`}, 'WEB', '203.0.113.9', 'secret-agent/1.0',
        ${r.result ?? 'SUCCESS'})`);
    return id;
  }

  async function customer(tenantId: string): Promise<string> {
    const id = uuid();
    await run(sql`INSERT INTO customers (id, tenant_id, telegram_user_id, status)
      VALUES (${id}, ${tenantId}, ${String(Math.floor(Math.random() * 1e9) + 1e9)}, 'ACTIVE')`);
    return id;
  }

  /** A minimal real order (every NOT NULL and CHECK satisfied), owned by `customerId`. */
  async function order(tenantId: string, customerId: string): Promise<string> {
    const panelId = uuid();
    const productId = uuid();
    const id = uuid();
    await run(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelId}::uuid, ${tenantId}::uuid, ${`P ${panelId}`}, 'marzban', 'https://p.example.test', 'ACTIVE')`);
    await run(sql`INSERT INTO products (id, tenant_id, title, status, audience, sort_order, panel_id,
        duration_days, traffic_bytes, price_amount, price_currency)
      VALUES (${productId}::uuid, ${tenantId}::uuid, 'plan', 'ACTIVE', 'EVERYONE', 0, ${panelId}::uuid, 30,
        53687091200, 250000, 'IRT')`);
    await run(sql`INSERT INTO orders (id, tenant_id, customer_id, state, product_id, panel_id, line_title,
        line_duration_days, line_traffic_bytes, line_unit_price_amount, line_quantity,
        subtotal_amount, discount_amount, total_amount, currency, quote, settled_at)
      VALUES (${id}::uuid, ${tenantId}::uuid, ${customerId}::uuid, 'PAID', ${productId}::uuid, ${panelId}::uuid,
        'plan', 30, 53687091200, 250000, 1, 250000, 0, 250000, 'IRT', '{}'::jsonb, now())`);
    return id;
  }

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
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
    const made: Record<string, string> = {};
    for (const [username, roleKeys, scope] of [
      ['owner', ['owner'], tenantA],
      ['finance', ['finance'], tenantA],
      ['support', ['support'], tenantA],
      ['foreign', ['owner'], tenantB],
    ] as const) {
      const admin = await createAdmin(api.container, scope, {
        username,
        password: `the-${username}-password`,
        roleKeys: [...roleKeys],
      });
      made[username] = admin.id;
    }
    ownerId = made['owner'] as string;
    financeId = made['finance'] as string;
    ownerCookie = await cookieFor('owner');
    financeCookie = await cookieFor('finance');
    supportCookie = await cookieFor('support');
    api.container.setInstallationTenant(tenantB.tenantId);
    foreignCookie = await cookieFor('foreign');
    api.container.setInstallationTenant(tenantA.tenantId);
  });

  // --- Permission -------------------------------------------------------------------

  it('charges audit.view on the list and audit.export on the file, on the server', async () => {
    expect((await get(AUDIT_LOG_ROUTES.list, null)).statusCode).toBe(401);
    expect((await get(AUDIT_LOG_ROUTES.list, supportCookie)).statusCode).toBe(403);
    expect((await get(AUDIT_LOG_ROUTES.export, supportCookie)).statusCode).toBe(403);
    // Finance reads the log and may not take it away as a file.
    expect((await get(AUDIT_LOG_ROUTES.list, financeCookie)).statusCode).toBe(200);
    const refused = await get(`${AUDIT_LOG_ROUTES.export}?${WINDOW}`, financeCookie);
    expect(refused.statusCode).toBe(403);
    // The refusal is itself on the record, as a DENIED `audit.export` by finance.
    const denials = await list(`action=audit.export&result=DENIED`);
    expect(denials.entries.map((e) => [e.actorId, e.security])).toEqual([[financeId, ['DENIED']]]);
    expect((await get(`${AUDIT_LOG_ROUTES.export}?${WINDOW}`)).statusCode).toBe(200);
  });

  // --- Filters ----------------------------------------------------------------------

  it('filters by actor (id, username, @username), actor type, action, entity and result', async () => {
    const a = await row({ at: at(1), action: 'panel.update' });
    const b = await row({
      at: at(2),
      action: 'reseller_tier.update',
      actorId: financeId,
      actorLabel: 'finance',
    });
    const c = await row({
      at: at(3),
      action: 'resellerXtier.update',
      entityType: 'Order',
      entityId: 'e-1',
    });
    const d = await row({
      at: at(4),
      action: 'panel.status',
      result: 'DENIED',
      actorType: 'SYSTEM_JOB',
      actorId: 'job:monitor',
      actorLabel: 'job:monitor',
    });
    const ids = async (query: string) =>
      (await list(`${WINDOW}&${query}`)).entries.map((e) => e.id);

    expect(await ids(`actor=${financeId}`)).toEqual([b]);
    expect(await ids('actor=finance')).toEqual([b]);
    expect(await ids(`actor=${encodeURIComponent('@FINANCE')}`)).toEqual([b]);
    // A job's id, typed back from its row, finds that job's rows.
    expect(await ids('actor=job%3Amonitor')).toEqual([d]);
    expect(await ids('actor=nobody-at-all')).toEqual([]);
    expect(await ids('actorType=SYSTEM_JOB')).toEqual([d]);
    expect(await ids('action=panel.update')).toEqual([a]);
    expect(await ids('action=panel.')).toEqual([d, a]);
    // `_` is a LIKE wildcard: the family `reseller_tier.` must not match `resellerXtier.`.
    expect(await ids('action=reseller_tier.')).toEqual([b]);
    expect(await ids('entityType=Order&entityId=e-1')).toEqual([c]);
    expect(await ids('result=DENIED')).toEqual([d]);
    expect((await get(`${AUDIT_LOG_ROUTES.list}?entityId=e-1`)).statusCode).toBe(400);
  });

  it('bounds the date range half-open: from is in, to is out', async () => {
    const before = await row({ at: at(0, -1), action: 'x.edge' });
    const onFrom = await row({ at: at(0), action: 'x.edge' });
    const inside = await row({ at: at(5), action: 'x.edge' });
    const onTo = await row({ at: at(10), action: 'x.edge' });
    const page = await list(
      `action=x.edge&from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(10))}`,
    );
    expect(page.entries.map((e) => e.id)).toEqual([inside, onFrom]);
    expect([before, onTo].some((id) => page.entries.some((e) => e.id === id))).toBe(false);
    const reversed = await get(
      `${AUDIT_LOG_ROUTES.list}?from=${encodeURIComponent(at(10))}&to=${encodeURIComponent(at(0))}`,
    );
    expect(reversed.statusCode).toBe(400);
  });

  it('filters the security slices by the same rule the badge shows', async () => {
    const denied = await row({ at: at(1), action: 'product.update', result: 'DENIED' });
    const login = await row({ at: at(2), action: 'auth.login', entityType: 'Admin' });
    const password = await row({ at: at(3), action: 'admin.password_change', entityType: 'Admin' });
    const debit = await row({ at: at(4), action: 'wallet.debit', entityType: 'Wallet' });
    await row({ at: at(5), action: 'wallet.credit', entityType: 'Wallet' });
    await row({ at: at(6), action: 'payment.confirm', entityType: 'Payment' });
    const slice = async (security: string) =>
      (await list(`${WINDOW}&security=${security}`)).entries.map((e) => [e.id, e.security]);
    expect(await slice('DENIED')).toEqual([[denied, ['DENIED']]]);
    expect(await slice('AUTH')).toEqual([
      [password, ['AUTH']],
      [login, ['AUTH']],
    ]);
    expect(await slice('CRITICAL')).toEqual([[debit, ['CRITICAL']]]);
  });

  it('finds a customer’s rows: about them, their wallet, and their orders — not another’s', async () => {
    const mine = await customer(tenantA.tenantId);
    const theirs = await customer(tenantA.tenantId);
    const myOrder = await order(tenantA.tenantId, mine);
    const theirOrder = await order(tenantA.tenantId, theirs);
    const blocked = await row({
      at: at(1),
      action: 'customer.block',
      entityType: 'Customer',
      entityId: mine,
    });
    const credited = await row({
      at: at(2),
      action: 'wallet.credit',
      entityType: 'Wallet',
      entityId: mine,
    });
    const confirmed = await row({
      at: at(3),
      action: 'order.confirm',
      entityType: 'Order',
      entityId: myOrder,
    });
    await row({ at: at(4), action: 'order.confirm', entityType: 'Order', entityId: theirOrder });
    await row({ at: at(5), action: 'customer.block', entityType: 'Customer', entityId: theirs });
    const page = await list(`${WINDOW}&customerId=${mine}`);
    expect(page.entries.map((e) => e.id)).toEqual([confirmed, credited, blocked]);
    // Deep links, decided by the server from the row's own entity and its current owner.
    const links = Object.fromEntries(page.entries.map((e) => [e.id, e.links]));
    expect(links[confirmed]).toEqual({
      customerId: mine,
      orderId: myOrder,
      paymentId: null,
      serviceId: null,
    });
    expect(links[credited]).toEqual({
      customerId: mine,
      orderId: null,
      paymentId: null,
      serviceId: null,
    });
  });

  it('links nowhere when the entity is another tenant’s or not an id this installation issues', async () => {
    const foreignCustomer = await customer(tenantB.tenantId);
    const foreignOrder = await order(tenantB.tenantId, foreignCustomer);
    const smuggled = await row({
      at: at(1),
      action: 'order.confirm',
      entityType: 'Order',
      entityId: foreignOrder,
    });
    const odd = await row({
      at: at(2),
      action: 'order.confirm',
      entityType: 'Order',
      entityId: 'not-a-uuid',
    });
    const page = await list(WINDOW);
    const none = { customerId: null, orderId: null, paymentId: null, serviceId: null };
    for (const id of [smuggled, odd]) {
      expect(page.entries.find((e) => e.id === id)?.links).toEqual(none);
    }
  });

  // --- Pagination -------------------------------------------------------------------

  it('pages deterministically: every row exactly once, at every page size, through ties', async () => {
    // Forty rows share ONE instant — a transaction's `Clock.now()` — and twenty more follow.
    const expected: string[] = [];
    for (let i = 0; i < 40; i += 1) expected.push(await row({ at: at(1), action: 'tie.same' }));
    for (let i = 0; i < 20; i += 1)
      expected.push(await row({ at: at(2 + i), action: 'tie.later' }));
    const full = await walk(`${WINDOW}&action=tie.`, 100);
    expect(full).toHaveLength(60);
    expect(new Set(full.map((e) => e.id))).toEqual(new Set(expected));
    for (const size of [1, 7, 13, 40]) {
      const paged = await walk(`${WINDOW}&action=tie.`, size);
      expect(
        paged.map((e) => e.id),
        `page size ${String(size)}`,
      ).toEqual(full.map((e) => e.id));
    }
    // Newest first by (occurredAt, id), DESC on both.
    for (let i = 1; i < full.length; i += 1) {
      const [p, q] = [full[i - 1] as AuditLogEntry, full[i] as AuditLogEntry];
      expect(p.occurredAt > q.occurredAt || (p.occurredAt === q.occurredAt && p.id > q.id)).toBe(
        true,
      );
    }
  });

  it('keeps a walk stable while new rows arrive, and refuses a cursor it did not mint', async () => {
    for (let i = 0; i < 10; i += 1) await row({ at: at(i), action: 'walk.step' });
    const first = await list(`${WINDOW}&action=walk.step&limit=4`);
    // A new row lands at the head of the log mid-walk; the next page is unaffected.
    await row({ at: at(100), action: 'walk.step' });
    const second = await list(
      `${WINDOW}&action=walk.step&limit=4&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    );
    const seen = [...first.entries, ...second.entries].map((e) => e.id);
    expect(new Set(seen).size).toBe(8);
    expect(
      second.entries.every((e) => e.occurredAt < (first.entries[3] as AuditLogEntry).occurredAt),
    ).toBe(true);
    expect((await get(`${AUDIT_LOG_ROUTES.list}?cursor=not-a-cursor`)).statusCode).toBe(400);
  });

  // --- Tenant isolation -------------------------------------------------------------

  it('never shows another tenant’s rows or installation-wide rows, even through a cursor', async () => {
    for (let i = 0; i < 6; i += 1) await row({ at: at(i), action: 'iso.mine' });
    for (let i = 0; i < 6; i += 1) {
      await row({ tenantId: tenantB.tenantId, at: at(i), action: 'iso.mine', actorId: null });
    }
    await row({ tenantId: null, at: at(3), action: 'iso.mine', actorId: null });
    const mine = await walk(`${WINDOW}&action=iso.`, 4);
    expect(mine).toHaveLength(6);
    // Tenant A's cursor, replayed by tenant B's administrator, selects inside B only.
    const first = await list(`${WINDOW}&action=iso.mine&limit=2`);
    const replay = await list(
      `${WINDOW}&action=iso.mine&limit=10&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      foreignCookie,
    );
    const aIds = new Set(mine.map((e) => e.id));
    expect(replay.entries.length).toBeGreaterThan(0);
    expect(replay.entries.some((e) => aIds.has(e.id))).toBe(false);
  });

  // --- Redaction --------------------------------------------------------------------

  it('redacts secrets again on the way out, and never returns ip or user agent', async () => {
    // An OLD row, written before the redactor knew some of these keys.
    const id = await row({
      at: at(1),
      action: 'panel.credentials.replace',
      before: { password: 'hunter2-plain', nested: { apiToken: 'tok_live_123' }, status: 'ACTIVE' },
      after: { subscriptionUrl: 'https://sub.example/xyz', status: 'DISABLED' },
      reason: 'rotated; old token=abcdef0123456789abcdef was leaked',
    });
    const response = await get(`${AUDIT_LOG_ROUTES.list}?${WINDOW}`);
    const body = response.body;
    for (const secret of [
      'hunter2-plain',
      'tok_live_123',
      'sub.example/xyz',
      'abcdef0123456789abcdef',
      '203.0.113.9',
      'secret-agent',
    ]) {
      expect(body, secret).not.toContain(secret);
    }
    const entry = auditLogListResponseSchema
      .parse(response.json())
      .entries.find((e) => e.id === id);
    expect(entry?.before?.['status']).toBe('ACTIVE');
    expect(entry?.after?.['status']).toBe('DISABLED');
    expect(entry?.before?.['password']).toBe('[redacted]');

    const file = await get(`${AUDIT_LOG_ROUTES.export}?${WINDOW}`);
    for (const secret of ['hunter2-plain', 'tok_live_123', 'sub.example/xyz', '203.0.113.9']) {
      expect(file.body, secret).not.toContain(secret);
    }
  });

  it('shows a row with no before/after as none, never a reconstruction', async () => {
    const id = await row({
      at: at(1),
      action: 'payment.confirm',
      before: [1, 2],
      after: undefined,
    });
    const entry = (await list(WINDOW)).entries.find((e) => e.id === id);
    expect(entry?.before).toBeNull();
    expect(entry?.after).toBeNull();
  });

  // --- Export -----------------------------------------------------------------------

  it('exports exactly the displayed set, and records the export', async () => {
    const mine = await customer(tenantA.tenantId);
    for (let i = 0; i < 37; i += 1) {
      await row({
        at: at(i % 5),
        action: i % 3 === 0 ? 'wallet.debit' : 'customer.block',
        entityType: 'Customer',
        entityId: mine,
        reason: i === 0 ? '=HYPERLINK("x")' : null,
      });
    }
    await row({ at: at(1), action: 'customer.block', entityType: 'Customer', entityId: uuid() });
    const query = `${WINDOW}&customerId=${mine}`;
    const shown = await walk(query, 10);
    expect(shown).toHaveLength(37);

    const file = await get(`${AUDIT_LOG_ROUTES.export}?${query}`);
    expect(file.statusCode, file.body).toBe(200);
    expect(file.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(String(file.headers['content-disposition'])).toMatch(
      /^attachment; filename="nexa-audit-log-[0-9T-]+Z\.csv"$/,
    );
    expect(file.headers['cache-control']).toBe('no-store');
    const lines = file.body
      .replace(/^\uFEFF/u, '')
      .trimEnd()
      .split('\r\n');
    const data = lines.slice(1);
    expect(data).toHaveLength(shown.length);
    // Same rows, same order: the id is the last column.
    expect(data.map((line) => line.split(',').at(-1))).toEqual(shown.map((e) => e.id));
    // An operator-entered reason that a spreadsheet would run is neutralised.
    expect(file.body).toContain(`"'=HYPERLINK(""x"")"`);

    const recorded = await list(`action=audit.export&actor=${ownerId}`);
    expect(recorded.entries).toHaveLength(1);
    expect(recorded.entries[0]?.after).toMatchObject({
      format: 'csv',
      rows: 37,
      filter: { customerId: mine },
    });
  });

  it('refuses an export larger than the bound rather than cutting it short', async () => {
    await run(sql`INSERT INTO audit_logs (id, tenant_id, occurred_at, actor_type, action, entity_type,
        correlation_id, source_surface, result)
      SELECT gen_random_uuid(), ${tenantA.tenantId}::uuid, ${at(1)}::timestamptz - (g || ' ms')::interval,
             'SYSTEM_JOB', 'bulk.item', 'BulkOperation', 'bulk-' || g, 'WORKER', 'SUCCESS'
        FROM generate_series(1, ${AUDIT_LOG_EXPORT_ROW_MAX + 1}) AS g`);
    const refused = await get(`${AUDIT_LOG_ROUTES.export}?action=bulk.item`);
    expect(refused.statusCode).toBe(400);
    expect((await list('action=audit.export')).entries).toHaveLength(0);
    // One row fewer is a file: `from` drops the oldest, exactly at the bound.
    const narrowed = await get(
      `${AUDIT_LOG_ROUTES.export}?action=bulk.item&from=${encodeURIComponent(at(1, -AUDIT_LOG_EXPORT_ROW_MAX))}`,
    );
    expect(narrowed.statusCode).toBe(200);
    expect(narrowed.body.trimEnd().split('\r\n')).toHaveLength(AUDIT_LOG_EXPORT_ROW_MAX + 1);
  }, 60_000);
});
