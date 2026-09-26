import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  COMMERCE_ERROR_CODES,
  CONTROL_ERROR_CODES,
  CUSTOMER_BLOCK_REASON_MAX_LENGTH,
  CUSTOMER_ROUTES,
  customerListResponseSchema,
  customerResponseSchema,
  PLATFORM_ERROR_CODES,
  SESSION_COOKIE_NAME,
} from '@nexa/contracts';
import type { BotInstanceId, UserId } from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { hashRequest } from '../../apps/api/src/modules/platform/idempotency/infrastructure/drizzle-idempotency-store';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
} from './harness';

/**
 * Customers over real HTTP.
 *
 * Four things only exist at this layer, and each is a way the rules could be
 * right and the product still wrong:
 *
 *   - the response projection, which is the one place a field the contract does
 *     not declare could become JSON;
 *   - authorization for an authenticated but UNPRIVILEGED caller, because the
 *     Web Admin not drawing a button is not authorization — and `users.view`,
 *     `users.search` and `users.block` are three separate answers;
 *   - tenant scope taken from the SESSION rather than from anything the caller
 *     can type, which is what makes another tenant's customer id and another
 *     tenant's cursor useless;
 *   - the cursor, which is shared with `/panels` and refuses what it did not
 *     mint rather than silently restarting the traversal.
 */

const ORIGIN = 'https://admin.example.test';

describe('customer HTTP surface', () => {
  let api: ApiApp;
  /** operator: users.view + users.search + users.block. */
  let operatorCookie: string;
  let operatorAdmin: Awaited<ReturnType<typeof createAdmin>>;
  /** support: users.view + users.search, and NOT users.block. */
  let supportCookie: string;
  /** A custom role holding users.view ALONE — no system role has that shape. */
  let viewerCookie: string;
  /** No users permission at all. */
  let technicalCookie: string;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig();
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

    operatorAdmin = await createAdmin(api.container, tenantA, {
      username: 'operator',
      password: 'the-operators-real-password',
      roleKeys: ['operator'],
    });
    await createAdmin(api.container, tenantA, {
      username: 'support',
      password: 'the-support-password',
      roleKeys: ['support'],
    });
    await createAdmin(api.container, tenantA, {
      username: 'technical',
      password: 'the-technical-password',
      roleKeys: ['technical'],
    });

    /*
     * `users.view` WITHOUT `users.search`, which no system role has.
     *
     * The separation is a real product decision — a list of a tenant's own
     * customers is a different question from a lookup of one specific person by
     * their Telegram id — so it has to be provable, and the only way to
     * construct the actor is a custom role. Built through the same tables the
     * role repository writes, not through a stubbed guard: a stub would prove
     * the test's own arithmetic.
     */
    const viewerRoleId = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO roles (id, tenant_id, key, name, is_system)
      VALUES (${viewerRoleId}, ${tenantA.tenantId}, 'viewer_only', 'Viewer only', false)`);
    await api.container.database.db.execute(sql`
      INSERT INTO role_permissions (tenant_id, role_id, permission_key)
      VALUES (${tenantA.tenantId}, ${viewerRoleId}, 'users.view')`);
    const viewer = await createAdmin(api.container, tenantA, {
      username: 'viewer',
      password: 'the-viewers-password',
    });
    await api.container.database.db.execute(sql`
      INSERT INTO admin_roles (tenant_id, admin_id, role_id)
      VALUES (${tenantA.tenantId}, ${viewer.id}, ${viewerRoleId})`);

    operatorCookie = await cookieFor('operator', 'the-operators-real-password');
    supportCookie = await cookieFor('support', 'the-support-password');
    viewerCookie = await cookieFor('viewer', 'the-viewers-password');
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

  const asAdmin = (cookie: string) => ({ cookie, origin: ORIGIN });
  const get = (path: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: asAdmin(cookie) });
  const post = (path: string, cookie: string, payload: unknown) =>
    inject({ method: 'POST', url: `${API_PREFIX}${path}`, headers: asAdmin(cookie), payload });

  let keyCounter = 0;
  const idempotencyKey = () => `customer-http-${(keyCounter += 1)}-${Date.now()}`;

  /**
   * A customer, written through the real repository rather than by raw INSERT.
   *
   * The repository is what the Telegram path uses, so a fixture built with it
   * carries whatever the production write actually produces — including the
   * defaults and the `created_at` the cursor pages on.
   */
  async function customerIn(
    scope: typeof tenantA,
    telegramUserId: string,
    profile: Partial<{
      username: string | null;
      firstName: string | null;
      lastName: string | null;
      languageCode: string | null;
    }> = {},
  ): Promise<UserId> {
    // The REAL repository, constructed over the real database — not a private
    // field reached through the service, and not a raw INSERT. A fixture written
    // by hand would not carry the defaults or the `created_at` the cursor pages
    // on, which is exactly what the paging assertions depend on.
    const repository = new DrizzleCustomerRepository(api.container.database.db);
    const resolution = await repository.resolve(scope, {
      id: api.container.ids.uuid() as UserId,
      telegramUserId,
      profile: {
        username: profile.username ?? null,
        firstName: profile.firstName ?? null,
        lastName: profile.lastName ?? null,
        languageCode: profile.languageCode ?? null,
      },
      botInstanceId: (scope === tenantA
        ? SEED_IDS.botA1
        : SEED_IDS.botB1) as unknown as BotInstanceId,
      now: api.container.clock.now(),
    });
    return resolution.customer.id;
  }

  // -------------------------------------------------------------------------
  // The projection
  // -------------------------------------------------------------------------

  it('returns exactly the declared fields, and nothing commercial', async () => {
    await customerIn(tenantA, '5551234567', { username: 'ali', firstName: 'Ali' });
    const response = await get(CUSTOMER_ROUTES.list, operatorCookie);
    expect(response.statusCode).toBe(200);

    const body = customerListResponseSchema.parse(response.json());
    expect(body.customers).toHaveLength(1);
    const row = response.json().customers[0] as Record<string, unknown>;
    /*
     * The KEY SET, asserted exactly.
     *
     * `customerListResponseSchema.parse` would pass an extra field straight
     * through — zod strips unknown keys by default and says nothing — so the
     * schema alone cannot catch a response that grew a `walletBalance`. These
     * are the eleven fields the contract declares, listed, so adding a twelfth
     * fails here.
     */
    expect(Object.keys(row).sort()).toEqual(
      [
        'blockedAt',
        'blockedReason',
        'blockedReasonShown',
        'firstName',
        'firstSeenAt',
        'id',
        'languageCode',
        'lastName',
        'lastSeenAt',
        'status',
        'telegramUserId',
        'username',
      ].sort(),
    );
    // The Telegram id stays a STRING on the wire. A JSON number above 2^53 is a
    // different id than the one stored, and this is identity.
    expect(typeof row['telegramUserId']).toBe('string');
  });

  it('never moves last_seen_at BACKWARDS when two contacts commit out of order', async () => {
    /*
     * `last_seen_at` is `greatest(stored, proposed)`, not an assignment.
     *
     * Every turn reads `Clock.now()` before it opens its transaction, so two
     * contacts from one customer can reach the upsert in the opposite order to
     * their timestamps — the second request commits first, then the first
     * request arrives holding the older instant. Assigning unconditionally made
     * the operator-facing "last heard from" column jump into the past, which is
     * the one thing a column read as activity must not do.
     *
     * Driven through the REAL repository with the two instants chosen explicitly,
     * because the ordering under test is exactly what a wall clock will not
     * reproduce on demand.
     */
    const repository = new DrizzleCustomerRepository(api.container.database.db);
    const later = new Date('2026-03-02T10:00:00.000Z');
    const earlier = new Date('2026-03-01T10:00:00.000Z');
    const resolveAt = (now: Date) =>
      repository.resolve(tenantA, {
        id: api.container.ids.uuid() as UserId,
        telegramUserId: '5559990001',
        profile: { username: 'ali', firstName: null, lastName: null, languageCode: null },
        botInstanceId: SEED_IDS.botA1 as unknown as BotInstanceId,
        now,
      });

    await resolveAt(later);
    const second = await resolveAt(earlier);

    // The later instant stands, in the returned record and in the row.
    expect(second.customer.lastSeenAt.toISOString()).toBe(later.toISOString());
    const stored = (
      await api.container.database.db.execute(sql`
        SELECT to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
               to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS written
          FROM customers WHERE telegram_user_id = '5559990001'`)
    ).rows[0] as { at: string; written: string };
    expect(stored.at).toBe('2026-03-02T10:00:00Z');
    // `updated_at` is deliberately NOT guarded: it records when the row was last
    // written, which is this statement, whichever instant it carried.
    expect(stored.written).toBe('2026-03-01T10:00:00Z');
  });

  // -------------------------------------------------------------------------
  // RBAC — three separate answers
  // -------------------------------------------------------------------------

  it('refuses the list to an actor without users.view', async () => {
    await customerIn(tenantA, '5551234567');
    const response = await get(CUSTOMER_ROUTES.list, technicalCookie);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { kind: 'PERMISSION_DENIED', code: PLATFORM_ERROR_CODES.PERMISSION_DENIED },
    });
    // And no data leaked alongside the refusal.
    expect(response.json().customers).toBeUndefined();
  });

  it('serves the list but refuses a SEARCH to users.view without users.search', async () => {
    await customerIn(tenantA, '5551234567', { username: 'ali' });

    // The plain list: allowed.
    const list = await get(CUSTOMER_ROUTES.list, viewerCookie);
    expect(list.statusCode).toBe(200);
    expect(customerListResponseSchema.parse(list.json()).customers).toHaveLength(1);

    // The same endpoint with a Telegram id: refused. Not an empty page — a
    // refusal, because an empty page would teach the caller that the customer
    // does not exist.
    const byId = await get(`${CUSTOMER_ROUTES.list}?telegramUserId=5551234567`, viewerCookie);
    expect(byId.statusCode).toBe(403);
    expect(byId.json().customers).toBeUndefined();

    // And with a username prefix: also refused. Both searches are the same
    // permission, so a surface cannot reach one through the other.
    const byName = await get(`${CUSTOMER_ROUTES.list}?username=al`, viewerCookie);
    expect(byName.statusCode).toBe(403);
  });

  it('allows a STATUS filter to users.view without users.search', async () => {
    /*
     * Narrowing a tenant's own list to the blocked half is the question the
     * unfiltered list already answers, so it is not a search. Asserted because
     * the opposite is the easy mistake — charging `users.search` for every query
     * parameter — and it would hide a capability the server permits.
     */
    await customerIn(tenantA, '5551234567');
    const response = await get(`${CUSTOMER_ROUTES.list}?status=ACTIVE`, viewerCookie);
    expect(response.statusCode).toBe(200);
    expect(customerListResponseSchema.parse(response.json()).customers).toHaveLength(1);
  });

  it('refuses a BLOCK to users.view plus users.search without users.block', async () => {
    const id = await customerIn(tenantA, '5551234567');
    // A well-formed request, so the refusal is the GUARD's: a body the schema refuses is a
    // 400 before any permission is asked (WP10G).
    const response = await post(CUSTOMER_ROUTES.block(id), supportCookie, {
      idempotencyKey: idempotencyKey(),
      reason: 'spam',
    });
    expect(response.statusCode).toBe(403);

    // And the row did not move. A refusal that wrote anything would be the
    // defect the guard exists for.
    const after = await get(CUSTOMER_ROUTES.detail(id), supportCookie);
    expect(customerResponseSchema.parse(after.json()).customer.status).toBe('ACTIVE');
  });

  it('refuses an UNBLOCK to the same actor', async () => {
    const id = await customerIn(tenantA, '5551234567');
    await post(CUSTOMER_ROUTES.block(id), operatorCookie, {
      idempotencyKey: idempotencyKey(),
      reason: 'spam',
    });
    const response = await post(CUSTOMER_ROUTES.unblock(id), supportCookie, {
      idempotencyKey: idempotencyKey(),
    });
    expect(response.statusCode).toBe(403);
    const after = await get(CUSTOMER_ROUTES.detail(id), operatorCookie);
    expect(customerResponseSchema.parse(after.json()).customer.status).toBe('BLOCKED');
  });

  it('refuses every customer route to a caller with no session', async () => {
    const id = await customerIn(tenantA, '5551234567');
    for (const [method, path] of [
      ['GET', CUSTOMER_ROUTES.list],
      ['GET', CUSTOMER_ROUTES.detail(id)],
      ['POST', CUSTOMER_ROUTES.block(id)],
      ['POST', CUSTOMER_ROUTES.unblock(id)],
    ] as const) {
      const response = await inject({
        method,
        url: `${API_PREFIX}${path}`,
        headers: { origin: ORIGIN },
        ...(method === 'POST' ? { payload: { idempotencyKey: idempotencyKey() } } : {}),
      });
      expect(response.statusCode, `${method} ${path}`).toBe(401);
    }
  });

  // -------------------------------------------------------------------------
  // Tenancy
  // -------------------------------------------------------------------------

  it('lets the SAME Telegram id and username exist in two tenants, independently', async () => {
    const inA = await customerIn(tenantA, '900100200', { username: 'shared_name' });
    const inB = await customerIn(tenantB, '900100200', { username: 'shared_name' });
    // Two rows, two ids. The unique index is `(tenant_id, telegram_user_id)`, so
    // a global one would have made the second a conflict and handed tenant B
    // tenant A's customer — a cross-tenant read through an ordinary `/start`.
    expect(inA).not.toBe(inB);

    const list = await get(`${CUSTOMER_ROUTES.list}?telegramUserId=900100200`, operatorCookie);
    const body = customerListResponseSchema.parse(list.json());
    // Tenant A's session sees exactly ONE of them, and it is A's.
    expect(body.customers.map((customer) => customer.id)).toEqual([inA]);
  });

  it("does not serve another tenant's customer by id", async () => {
    const inB = await customerIn(tenantB, '900100201', { username: 'only_in_b' });
    // Tenant A's real, fully privileged operator naming tenant B's real id. The
    // scope comes from the SESSION, so there is nothing to type that changes it.
    const response = await get(CUSTOMER_ROUTES.detail(inB), operatorCookie);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND },
    });
  });

  it("does not block another tenant's customer", async () => {
    const inB = await customerIn(tenantB, '900100202');
    const response = await post(CUSTOMER_ROUTES.block(inB), operatorCookie, {
      idempotencyKey: idempotencyKey(),
      reason: 'spam',
    });
    expect(response.statusCode).toBe(404);
    // And B's row is untouched, read from the database rather than from an API
    // no session can reach.
    const rows = await api.container.database.db.execute(
      sql`SELECT status FROM customers WHERE id = ${inB}`,
    );
    expect((rows.rows[0] as { status: string }).status).toBe('ACTIVE');
  });

  it("does not find another tenant's customer by username prefix", async () => {
    await customerIn(tenantB, '900100203', { username: 'only_in_b' });
    const response = await get(`${CUSTOMER_ROUTES.list}?username=only_in_b`, operatorCookie);
    expect(response.statusCode).toBe(200);
    expect(customerListResponseSchema.parse(response.json()).customers).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // The cursor
  // -------------------------------------------------------------------------

  it('pages with the cursor it minted, and a cursor past the end is an empty page', async () => {
    await customerIn(tenantA, '900200001');
    await customerIn(tenantA, '900200002');
    await customerIn(tenantA, '900200003');

    const first = customerListResponseSchema.parse(
      (await get(`${CUSTOMER_ROUTES.list}?limit=2`, operatorCookie)).json(),
    );
    expect(first.customers).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = customerListResponseSchema.parse(
      (
        await get(
          `${CUSTOMER_ROUTES.list}?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
          operatorCookie,
        )
      ).json(),
    );
    expect(second.customers).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    // No row appears twice across the traversal, which is the thing a cursor
    // built from a millisecond `Date` gets wrong at a microsecond boundary.
    const seen = [...first.customers, ...second.customers].map((customer) => customer.id);
    expect(new Set(seen).size).toBe(3);
  });

  it('refuses a cursor it did not mint rather than restarting the traversal', async () => {
    await customerIn(tenantA, '900200004');
    await customerIn(tenantA, '900200005');
    const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
    const real = customerListResponseSchema.parse(
      (await get(`${CUSTOMER_ROUTES.list}?limit=1`, operatorCookie)).json(),
    );

    for (const cursor of [
      '!!!not base64!!!',
      b64('nothing-to-split-on'),
      b64('not-a-uuid:2026-01-01T00:00:00.000000Z'),
      b64('019210ab-cdef-7012-8345-6789abcdef01:0000-01-01T00:00:00.000000Z'),
      '',
      `${real.nextCursor as string}=`,
    ]) {
      const response = await get(
        `${CUSTOMER_ROUTES.list}?limit=1&cursor=${encodeURIComponent(cursor)}`,
        operatorCookie,
      );
      const label = `cursor ${JSON.stringify(cursor.slice(0, 40))}`;
      // 400 EXACTLY, never a 500 from the `uuid` cast and never a 200 with page
      // one — the silent loop the shared cursor exists to refuse.
      expect(response.statusCode, label).toBe(400);
      expect(response.json(), label).toMatchObject({
        error: { kind: 'VALIDATION', code: CONTROL_ERROR_CODES.INVALID_VALUE },
      });
      expect(response.json().customers, label).toBeUndefined();
    }
  });

  it("answers a cursor minted in another tenant with this tenant's rows only", async () => {
    /*
     * A cursor is an opaque POSITION, not a capability, and it is deliberately
     * not bound to a tenant — the repository's WHERE clause already is. So a
     * cursor from tenant B is decodable and produces A's page: it names a
     * `(created_at, id)` pair, and nothing at that pair belongs to B inside A's
     * query. The assertion is that NONE of B's customers come back, which is the
     * guarantee; a 400 here would be a different and weaker claim, because it
     * would depend on recognising the cursor rather than on scoping the query.
     */
    const inB = await customerIn(tenantB, '900300001', { username: 'b_one' });
    await customerIn(tenantB, '900300002', { username: 'b_two' });
    const inA = await customerIn(tenantA, '900300003', { username: 'a_one' });

    // B's cursor, built exactly as the server mints one, from B's real row.
    const bRow = await api.container.database.db.execute(sql`
      SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
        FROM customers WHERE id = ${inB}`);
    const b = bRow.rows[0] as { id: string; at: string };
    const crossed = Buffer.from(`${b.id}:${b.at}`, 'utf8').toString('base64url');

    const response = await get(
      `${CUSTOMER_ROUTES.list}?limit=50&cursor=${encodeURIComponent(crossed)}`,
      operatorCookie,
    );
    expect(response.statusCode).toBe(200);
    const body = customerListResponseSchema.parse(response.json());
    const ids = body.customers.map((customer) => customer.id);
    // Not one of B's, and A's own row is reachable — so this is not vacuously
    // true by the page being empty.
    expect(ids).not.toContain(inB);
    expect(ids).toContain(inA);
  });

  // -------------------------------------------------------------------------
  // Block and unblock
  // -------------------------------------------------------------------------

  it('blocks, audits the block, and stays blocked when pressed again', async () => {
    const id = await customerIn(tenantA, '900400001');
    const first = await post(CUSTOMER_ROUTES.block(id), operatorCookie, {
      idempotencyKey: idempotencyKey(),
      reason: 'abusive messages',
    });
    expect(first.statusCode).toBe(201);
    const blocked = customerResponseSchema.parse(first.json()).customer;
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.blockedAt).not.toBeNull();
    expect(blocked.blockedReason).toBe('abusive messages');

    // A SECOND block with a different key. Idempotent in the sense that matters:
    // the end state the operator asked for holds, and it is not an error —
    // a double-clicked Block that failed the second time teaches an operator
    // that the button is unreliable.
    const second = await post(CUSTOMER_ROUTES.block(id), operatorCookie, {
      idempotencyKey: idempotencyKey(),
      reason: 'abusive messages',
    });
    expect(second.statusCode).toBe(201);
    expect(customerResponseSchema.parse(second.json()).customer.status).toBe('BLOCKED');

    const audits = await api.container.database.db.execute(sql`
      SELECT after FROM audit_logs
       WHERE entity_id = ${id} AND action = 'customer.block'
       ORDER BY occurred_at ASC`);
    // TWO rows, and they differ: the second records `changed: false`, so the log
    // distinguishes "blocked them" from "they were already blocked". A no-op that
    // wrote no audit row would make the second press invisible.
    expect(audits.rows).toHaveLength(2);
    expect((audits.rows[0] as { after: { changed: boolean } }).after.changed).toBe(true);
    expect((audits.rows[1] as { after: { changed: boolean } }).after.changed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // The mandatory reason (WP10G, closing OQ-WP10F-03)
  // -------------------------------------------------------------------------

  it('refuses a block with no reason, before any record is written', async () => {
    const id = await customerIn(tenantA, '900400021');
    const key = idempotencyKey();
    const response = await post(CUSTOMER_ROUTES.block(id), operatorCookie, {
      idempotencyKey: key,
    });
    expect(response.statusCode).toBe(400);

    // Nothing moved, nothing was remembered, nothing was audited: the refusal is BEFORE the
    // idempotency lookup, so the same key can carry the corrected request.
    const after = await get(CUSTOMER_ROUTES.detail(id), operatorCookie);
    expect(customerResponseSchema.parse(after.json()).customer.status).toBe('ACTIVE');
    const remembered = await api.container.database.db.execute(
      sql`SELECT key FROM request_idempotency WHERE key = ${key}`,
    );
    expect(remembered.rows).toEqual([]);
    const audits = await api.container.database.db.execute(sql`
      SELECT count(*)::int AS n FROM audit_logs
       WHERE entity_id = ${id} AND action = 'customer.block'`);
    expect((audits.rows[0] as { n: number }).n).toBe(0);

    const corrected = await post(CUSTOMER_ROUTES.block(id), operatorCookie, {
      idempotencyKey: key,
      reason: 'repeated abuse',
    });
    expect(corrected.statusCode).toBe(201);
    expect(customerResponseSchema.parse(corrected.json()).customer.blockedReason).toBe(
      'repeated abuse',
    );
  });

  it('refuses a whitespace-only reason as no reason, and trims a real one', async () => {
    const id = await customerIn(tenantA, '900400022');
    const blank = await post(CUSTOMER_ROUTES.block(id), operatorCookie, {
      idempotencyKey: idempotencyKey(),
      reason: '   \t\n ',
    });
    expect(blank.statusCode).toBe(400);
    expect(
      customerResponseSchema.parse((await get(CUSTOMER_ROUTES.detail(id), operatorCookie)).json())
        .customer.status,
    ).toBe('ACTIVE');

    const padded = await post(CUSTOMER_ROUTES.block(id), operatorCookie, {
      idempotencyKey: idempotencyKey(),
      reason: '  spam links  ',
    });
    expect(padded.statusCode).toBe(201);
    const blocked = customerResponseSchema.parse(padded.json()).customer;
    expect(blocked.blockedReason).toBe('spam links');
    // Written under the promise that the customer sees it.
    expect(blocked.blockedReasonShown).toBe(true);
  });

  it('refuses an over-long reason rather than cutting it', async () => {
    const id = await customerIn(tenantA, '900400023');
    const response = await post(CUSTOMER_ROUTES.block(id), operatorCookie, {
      idempotencyKey: idempotencyKey(),
      reason: 'x'.repeat(CUSTOMER_BLOCK_REASON_MAX_LENGTH + 1),
    });
    expect(response.statusCode).toBe(400);
    expect(
      customerResponseSchema.parse((await get(CUSTOMER_ROUTES.detail(id), operatorCookie)).json())
        .customer.status,
    ).toBe('ACTIVE');
  });

  it('the service refuses a reason-less block from any caller, not only the schema', async () => {
    // Straight at the service, as a surface that skipped the schema would call it: the rule
    // lives in `CustomerService`, and the HTTP schema is the courtesy in front of it.
    const id = await customerIn(tenantA, '900400024');
    const operator = adminActorFor(operatorAdmin);
    await expect(
      api.container.customers.block(tenantA, operator, {
        idempotencyKey: `service-no-reason-${id}`,
        customerId: id,
        reason: null,
      }),
    ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.CUSTOMER_BLOCK_REASON_REQUIRED });
    await expect(
      api.container.customers.block(tenantA, operator, {
        idempotencyKey: `service-blank-reason-${id}`,
        customerId: id,
        reason: '   ',
      }),
    ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.CUSTOMER_BLOCK_REASON_REQUIRED });
    expect((await api.container.customers.get(tenantA, operator, id)).status).toBe('ACTIVE');
  });

  it('replays a reasonless block an earlier release accepted, instead of refusing its retry', async () => {
    // The previous release blocked without a reason and remembered the key; the answer was
    // lost. The retry after the upgrade must replay that command, not refuse it for a rule the
    // command predates. The replay lookup only reads, so the rule still runs before any write.
    const id = await customerIn(tenantA, '900400029');
    const operator = adminActorFor(operatorAdmin);
    const key = `legacy-reasonless-${id}`;
    await api.container.database.db.execute(
      sql`UPDATE customers SET status = 'BLOCKED', blocked_at = now() WHERE id = ${id}`,
    );
    await api.container.idempotency.remember(
      tenantA,
      operator.surface,
      key,
      hashRequest({ customerId: id, to: 'BLOCKED', reason: null }),
      { customerId: id, changed: true },
    );

    const replayed = await api.container.customers.block(tenantA, operator, {
      idempotencyKey: key,
      customerId: id,
      reason: null,
    });
    expect(replayed.status).toBe('BLOCKED');
    const audits = await api.container.database.db.execute(sql`
      SELECT count(*)::int AS n FROM audit_logs
       WHERE entity_id = ${id} AND action = 'customer.block'`);
    expect((audits.rows[0] as { n: number }).n).toBe(0);
  });

  it('an unblock needs no reason, and clears the stored one', async () => {
    const id = await customerIn(tenantA, '900400025');
    await post(CUSTOMER_ROUTES.block(id), operatorCookie, {
      idempotencyKey: idempotencyKey(),
      reason: 'spam',
    });
    const response = await post(CUSTOMER_ROUTES.unblock(id), operatorCookie, {
      idempotencyKey: idempotencyKey(),
    });
    expect(response.statusCode).toBe(201);
    const active = customerResponseSchema.parse(response.json()).customer;
    expect(active.status).toBe('ACTIVE');
    expect(active.blockedReason).toBeNull();
    expect(active.blockedReasonShown).toBe(false);
  });

  it('an unblock WITH a note clears the stored reason and never stores the note as one', async () => {
    const id = await customerIn(tenantA, '900400027');
    await post(CUSTOMER_ROUTES.block(id), operatorCookie, {
      idempotencyKey: idempotencyKey(),
      reason: 'spam',
    });
    // The note is the audit's justification. Stored as `blocked_reason` on an ACTIVE
    // customer it would read as a current block reason.
    const response = await post(CUSTOMER_ROUTES.unblock(id), operatorCookie, {
      idempotencyKey: idempotencyKey(),
      reason: 'appealed and cleared',
    });
    expect(response.statusCode).toBe(201);
    const active = customerResponseSchema.parse(response.json()).customer;
    expect(active.status).toBe('ACTIVE');
    expect(active.blockedReason).toBeNull();
    expect(active.blockedReasonShown).toBe(false);
  });

  it('a second block of a blocked customer leaves the stored reason untouched', async () => {
    const id = await customerIn(tenantA, '900400026');
    await post(CUSTOMER_ROUTES.block(id), operatorCookie, {
      idempotencyKey: idempotencyKey(),
      reason: 'the first reason',
    });
    const again = await post(CUSTOMER_ROUTES.block(id), operatorCookie, {
      idempotencyKey: idempotencyKey(),
      reason: 'a different reason',
    });
    // Not an error — the end state asked for holds — and not an overwrite: the conditional
    // UPDATE did not match, so changing a reason is unblock-then-block, never a replay.
    expect(again.statusCode).toBe(201);
    expect(customerResponseSchema.parse(again.json()).customer.blockedReason).toBe(
      'the first reason',
    );
    const audits = await api.container.database.db.execute(sql`
      SELECT after FROM audit_logs
       WHERE entity_id = ${id} AND action = 'customer.block'
       ORDER BY occurred_at ASC`);
    expect((audits.rows[1] as { after: { changed: boolean } }).after.changed).toBe(false);
  });

  it('remembers a Web block under WEB and audits it as WEB (OQ-WP10F-04)', async () => {
    const id = await customerIn(tenantA, '900400009');
    const key = idempotencyKey();
    const response = await post(CUSTOMER_ROUTES.block(id), operatorCookie, {
      idempotencyKey: key,
      reason: 'from the web',
    });
    expect(response.statusCode).toBe(201);

    const recorded = await api.container.database.db.execute(sql`
      SELECT scope_ref FROM request_idempotency WHERE key = ${key}`);
    expect(recorded.rows).toEqual([{ scope_ref: `${tenantA.tenantId}|WEB` }]);
    const audit = await api.container.database.db.execute(sql`
      SELECT source_surface FROM audit_logs
       WHERE entity_id = ${id} AND action = 'customer.block'`);
    expect(audit.rows).toEqual([{ source_surface: 'WEB' }]);
  });

  it('treats the SAME key as a replay rather than a second command', async () => {
    const id = await customerIn(tenantA, '900400002');
    const key = idempotencyKey();
    const first = await post(CUSTOMER_ROUTES.block(id), operatorCookie, {
      idempotencyKey: key,
      reason: 'once',
    });
    expect(first.statusCode).toBe(201);
    const replay = await post(CUSTOMER_ROUTES.block(id), operatorCookie, {
      idempotencyKey: key,
      reason: 'once',
    });
    expect(replay.statusCode).toBe(201);
    expect(customerResponseSchema.parse(replay.json()).customer.status).toBe('BLOCKED');

    // ONE audit row, not two: the replay did no work. This is what separates a
    // retry after a lost response from a second operator decision.
    const audits = await api.container.database.db.execute(sql`
      SELECT count(*)::int AS n FROM audit_logs
       WHERE entity_id = ${id} AND action = 'customer.block'`);
    expect((audits.rows[0] as { n: number }).n).toBe(1);
  });

  it('refuses the same key with a DIFFERENT payload', async () => {
    const id = await customerIn(tenantA, '900400003');
    const key = idempotencyKey();
    expect(
      (
        await post(CUSTOMER_ROUTES.block(id), operatorCookie, {
          idempotencyKey: key,
          reason: 'one question',
        })
      ).statusCode,
    ).toBe(201);
    const mismatched = await post(CUSTOMER_ROUTES.block(id), operatorCookie, {
      idempotencyKey: key,
      reason: 'a different question',
    });
    // A key reused with a different payload is always a caller bug, and serving
    // the old result would hide it.
    expect(mismatched.statusCode).toBe(409);
    expect(mismatched.json()).toMatchObject({
      error: { code: PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH },
    });
  });

  it('clears the stored reason on unblock, and emits both events', async () => {
    const id = await customerIn(tenantA, '900400004');
    await post(CUSTOMER_ROUTES.block(id), operatorCookie, {
      idempotencyKey: idempotencyKey(),
      reason: 'temporary',
    });
    const unblocked = customerResponseSchema.parse(
      (
        await post(CUSTOMER_ROUTES.unblock(id), operatorCookie, {
          idempotencyKey: idempotencyKey(),
        })
      ).json(),
    ).customer;
    expect(unblocked.status).toBe('ACTIVE');
    // Both cleared together, because a reason on an active customer reads as
    // current and the CHECK constraint requires them to agree.
    expect(unblocked.blockedAt).toBeNull();
    expect(unblocked.blockedReason).toBeNull();

    const events = await api.container.database.db.execute(sql`
      SELECT event_type FROM outbox_messages
       WHERE aggregate_id = ${id} ORDER BY created_at ASC, event_type ASC`);
    const types = events.rows.map((row) => (row as { event_type: string }).event_type);
    expect(types).toContain('CustomerBlocked');
    expect(types).toContain('CustomerUnblocked');
  });

  it('refuses a malformed customer id with a 400 rather than a 500', async () => {
    // `customers.id` is a `uuid` column, so before this was validated
    // `not-a-uuid` reached PostgreSQL as 22P02 and came back as an internal
    // error — a caller could turn any path segment into a 500.
    for (const bad of ['not-a-uuid', '../../etc/passwd', '00000000-0000-4000-8000-000000000000']) {
      const response = await get(CUSTOMER_ROUTES.detail(bad), operatorCookie);
      expect(response.statusCode, bad).toBe(400);
      expect(response.json(), bad).toMatchObject({
        error: { code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID },
      });
    }
    // A well-formed v7 uuid naming nothing is a 404, not a 400: "I cannot read
    // that" and "there is no such customer" are different answers.
    const unknown = await get(
      CUSTOMER_ROUTES.detail('019210ab-cdef-7012-8345-6789abcdef09'),
      operatorCookie,
    );
    expect(unknown.statusCode).toBe(404);
  });

  it('resolves a RE-CASED id to the same customer rather than a second one', async () => {
    /*
     * Postgres compares `uuid` values case-insensitively, so `…89AB` and
     * `…89ab` are ONE row, while JavaScript `===` says they are two strings.
     * `userIdSchema` lower-cases at the boundary, which is how the admin
     * self-modification guard was fixed after an administrator defeated it by
     * upper-casing their own id in the path.
     */
    const id = await customerIn(tenantA, '900400005');
    const upper = id.toUpperCase();
    const response = await get(CUSTOMER_ROUTES.detail(upper), operatorCookie);
    expect(response.statusCode).toBe(200);
    expect(customerResponseSchema.parse(response.json()).customer.id).toBe(id);
  });

  it('bounds the page size at the contract maximum', async () => {
    const over = await get(`${CUSTOMER_ROUTES.list}?limit=101`, operatorCookie);
    // Refused by the SCHEMA rather than silently clamped, so a caller asking for
    // more than the contract allows is told rather than quietly served less.
    expect(over.statusCode).toBe(400);
    const atMax = await get(`${CUSTOMER_ROUTES.list}?limit=100`, operatorCookie);
    expect(atMax.statusCode).toBe(200);
  });

  it('refuses a repeated query parameter rather than guessing which one meant it', async () => {
    const response = await get(`${CUSTOMER_ROUTES.list}?limit=5&limit=50`, operatorCookie);
    expect(response.statusCode).toBe(400);
  });
});
