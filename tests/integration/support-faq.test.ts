import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  COMMERCE_ERROR_CODES,
  SESSION_COOKIE_NAME,
  SUPPORT_FAQ_MAX_ENTRIES,
  SUPPORT_FAQ_ROUTES,
  isNexaError,
  supportFaqListSchema,
  supportFaqSchema,
  type ActorContext,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
  type TestContext,
} from './harness';

/**
 * The support FAQ (customer UX completion §J).
 *
 * Every case is one of the ways the screen could tell a customer something the
 * operator did not decide:
 *
 *   - the nine defaults are copied in ONCE, and a tenant that switched all nine off is
 *     not given them back;
 *   - the customer sees ACTIVE rows in the operator's order, and only those;
 *   - one tenant's rows never appear for another, and another tenant's id is "no such
 *     entry" rather than a row;
 *   - a write takes `settings.edit`, a refusal is audited, and a stale editor is refused
 *     with the version it needs;
 *   - a replay answers with the first result;
 *   - the support URL is THIS tenant's `support.accounts`.
 */

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (isNexaError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
};

let keyCounter = 0;
const key = () => `faq-${String((keyCounter += 1)).padStart(8, '0')}`;

describe('support FAQ', () => {
  let ctx: TestContext;
  let ownerA: ActorContext;
  let ownerB: ActorContext;
  let viewerA: ActorContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ownerA = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-faq', roleKeys: ['owner'] }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-faqb', roleKeys: ['owner'] }),
    );
    // `operator` holds `settings.view` and not `settings.edit` — the pair the seed
    // contract defines, used rather than a hand-built role so the case fails if it moves.
    viewerA = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'viewer-faq', roleKeys: ['operator'] }),
    );
  });

  const rowsOf = async (tenantId: unknown) => {
    const { rows } = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS total FROM support_faqs WHERE tenant_id = ${tenantId}`,
    )) as unknown as { rows: { total: number }[] };
    return rows[0]?.total ?? -1;
  };

  const seedsOf = async (tenantId: unknown) => {
    const { rows } = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS total FROM support_faq_seeds WHERE tenant_id = ${tenantId}`,
    )) as unknown as { rows: { total: number }[] };
    return rows[0]?.total ?? -1;
  };

  // -------------------------------------------------------------------------
  // Seeding
  // -------------------------------------------------------------------------

  it('seeds exactly nine defaults on the first read, from the templates, and never again', async () => {
    expect(await rowsOf(tenantA.tenantId)).toBe(0);

    const first = await ctx.container.supportScreen.screenFor(tenantA);
    expect(first.faqs).toHaveLength(9);
    expect(await rowsOf(tenantA.tenantId)).toBe(9);
    expect(await seedsOf(tenantA.tenantId)).toBe(1);

    // The text is the catalogue's, through the resolver.
    const question1 = await ctx.container.templateResolver.render(
      tenantA,
      'bot.faq.default_1_question',
      {},
    );
    const answer9 = await ctx.container.templateResolver.render(
      tenantA,
      'bot.faq.default_9_answer',
      {},
    );
    expect(first.faqs[0]?.question).toBe(question1);
    expect(first.faqs[8]?.answer).toBe(answer9);

    // A second read seeds nothing: nine rows, one marker.
    const second = await ctx.container.supportScreen.screenFor(tenantA);
    expect(second.faqs).toHaveLength(9);
    expect(await rowsOf(tenantA.tenantId)).toBe(9);
    expect(await seedsOf(tenantA.tenantId)).toBe(1);

    // And the operator's list seeds a fresh tenant the same way, once.
    const listed = await ctx.container.supportFaqs.listForOperator(tenantB, ownerB);
    expect(listed).toHaveLength(9);
    expect(listed.map((row) => row.sortOrder)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(listed.every((row) => row.status === 'ACTIVE' && row.version === 1)).toBe(true);
    await ctx.container.supportFaqs.listForOperator(tenantB, ownerB);
    expect(await rowsOf(tenantB.tenantId)).toBe(9);
  });

  it('does not re-seed a tenant that deactivated every entry', async () => {
    const listed = await ctx.container.supportFaqs.listForOperator(tenantA, ownerA);
    for (const row of listed) {
      await ctx.container.supportFaqs.setStatus(tenantA, ownerA, {
        idempotencyKey: key(),
        id: row.id,
        status: 'INACTIVE',
        expectedVersion: row.version,
      });
    }

    const screen = await ctx.container.supportScreen.screenFor(tenantA);
    expect(screen.faqs).toEqual([]);
    expect(await rowsOf(tenantA.tenantId)).toBe(9);
    // The operator still sees the nine, switched off.
    const again = await ctx.container.supportFaqs.listForOperator(tenantA, ownerA);
    expect(again).toHaveLength(9);
    expect(again.every((row) => row.status === 'INACTIVE')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The customer's screen
  // -------------------------------------------------------------------------

  it('returns ACTIVE rows only, in (sort_order, created_at, id) order', async () => {
    const defaults = await ctx.container.supportFaqs.listForOperator(tenantA, ownerA);
    const third = defaults[2] as (typeof defaults)[number];

    const early = await ctx.container.supportFaqs.create(tenantA, ownerA, {
      idempotencyKey: key(),
      question: 'How do I start?',
      answer: 'Tap the catalogue.',
      sortOrder: 5,
    });
    // The same sort order as the third default: created later, so listed after it.
    const tied = await ctx.container.supportFaqs.create(tenantA, ownerA, {
      idempotencyKey: key(),
      question: 'Tied with the third',
      answer: 'Comes after it.',
      sortOrder: third.sortOrder,
    });
    await ctx.container.supportFaqs.setStatus(tenantA, ownerA, {
      idempotencyKey: key(),
      id: third.id,
      status: 'INACTIVE',
      expectedVersion: third.version,
    });

    const screen = await ctx.container.supportScreen.screenFor(tenantA);
    expect(screen.faqs).toHaveLength(10);
    expect(screen.faqs[0]?.question).toBe(early.question);
    expect(screen.faqs.map((faq) => faq.question)).not.toContain(third.question);
    // Position: the two defaults before the third, then the tied entry in the third's slot.
    expect(screen.faqs[3]?.question).toBe(tied.question);

    const operator = await ctx.container.supportFaqs.listForOperator(tenantA, ownerA);
    expect(operator).toHaveLength(11);
    expect(operator.map((row) => row.id)).toContain(third.id);
    expect(operator.findIndex((row) => row.id === third.id)).toBeLessThan(
      operator.findIndex((row) => row.id === tied.id),
    );
  });

  it('takes the support URL from THIS tenant’s support.accounts', async () => {
    await ctx.container.settingsService.set(tenantB, ownerB, {
      idempotencyKey: key(),
      key: 'support.accounts',
      value: ['@HelpDeskB', '@SecondB'],
      expectedVersion: null,
    });

    expect((await ctx.container.supportScreen.screenFor(tenantB)).supportUrl).toBe(
      'https://t.me/HelpDeskB',
    );
    // Tenant A has configured none, and does not inherit B's.
    expect((await ctx.container.supportScreen.screenFor(tenantA)).supportUrl).toBeNull();

    await ctx.container.settingsService.set(tenantA, ownerA, {
      idempotencyKey: key(),
      key: 'support.accounts',
      value: ['@HelpA'],
      expectedVersion: null,
    });
    expect((await ctx.container.supportScreen.screenFor(tenantA)).supportUrl).toBe(
      'https://t.me/HelpA',
    );
    expect((await ctx.container.supportScreen.screenFor(tenantB)).supportUrl).toBe(
      'https://t.me/HelpDeskB',
    );
  });

  // -------------------------------------------------------------------------
  // Tenancy
  // -------------------------------------------------------------------------

  it('keeps one tenant’s FAQ invisible and unreachable from the other', async () => {
    const foreign = await ctx.container.supportFaqs.create(tenantB, ownerB, {
      idempotencyKey: key(),
      question: 'Only for tenant B',
      answer: 'B answer',
      sortOrder: 0,
    });

    const screenA = await ctx.container.supportScreen.screenFor(tenantA);
    expect(screenA.faqs.map((faq) => faq.question)).not.toContain(foreign.question);
    const listA = await ctx.container.supportFaqs.listForOperator(tenantA, ownerA);
    expect(listA.map((row) => row.id)).not.toContain(foreign.id);

    // Tenant A cannot edit, hide or even confirm the existence of B's row by id.
    expect(
      await codeOf(
        ctx.container.supportFaqs.update(tenantA, ownerA, {
          idempotencyKey: key(),
          id: foreign.id,
          question: 'Hijacked',
          answer: 'Hijacked',
          sortOrder: 0,
          expectedVersion: foreign.version,
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.SUPPORT_FAQ_NOT_FOUND);
    expect(
      await codeOf(
        ctx.container.supportFaqs.setStatus(tenantA, ownerA, {
          idempotencyKey: key(),
          id: foreign.id,
          status: 'INACTIVE',
          expectedVersion: foreign.version,
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.SUPPORT_FAQ_NOT_FOUND);

    const untouched = await ctx.container.supportScreen.screenFor(tenantB);
    expect(untouched.faqs.map((faq) => faq.question)).toContain(foreign.question);
  });

  // -------------------------------------------------------------------------
  // Authorization, versions, replay, limit
  // -------------------------------------------------------------------------

  it('requires settings.edit to write, audits the refusal, and lets settings.view read', async () => {
    const listed = await ctx.container.supportFaqs.listForOperator(tenantA, viewerA);
    expect(listed).toHaveLength(9);

    const refused = await codeOf(
      ctx.container.supportFaqs.create(tenantA, viewerA, {
        idempotencyKey: key(),
        question: 'Not allowed',
        answer: 'Not allowed',
        sortOrder: 0,
      }),
    );
    expect(refused).toBe('platform.permission_denied');

    const { rows } = (await ctx.container.database.db.execute(
      sql`SELECT result, after FROM audit_logs
           WHERE tenant_id = ${tenantA.tenantId} AND action = 'support_faq.create'`,
    )) as unknown as { rows: { result: string; after: Record<string, unknown> }[] };
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('DENIED');
    expect(rows[0]?.after).toMatchObject({ deniedPermission: 'settings.edit' });
    expect(await rowsOf(tenantA.tenantId)).toBe(9);
  });

  it('refuses a stale version with the current one in the detail, and audits before/after', async () => {
    const created = await ctx.container.supportFaqs.create(tenantA, ownerA, {
      idempotencyKey: key(),
      question: 'Original',
      answer: 'Original answer',
      sortOrder: 100,
    });
    expect(created.version).toBe(1);

    const updated = await ctx.container.supportFaqs.update(tenantA, ownerA, {
      idempotencyKey: key(),
      id: created.id,
      question: 'Edited',
      answer: 'Edited answer',
      sortOrder: 110,
      expectedVersion: 1,
    });
    expect(updated.version).toBe(2);

    // The stale editor, from the row it read before the edit above.
    try {
      await ctx.container.supportFaqs.update(tenantA, ownerA, {
        idempotencyKey: key(),
        id: created.id,
        question: 'Stale',
        answer: 'Stale answer',
        sortOrder: 100,
        expectedVersion: 1,
      });
      throw new Error('expected a conflict');
    } catch (error) {
      if (!isNexaError(error)) throw error;
      expect(error.code).toBe(COMMERCE_ERROR_CODES.SUPPORT_FAQ_VERSION_CONFLICT);
      expect(error.details).toMatchObject({ currentVersion: 2 });
    }
    expect(
      await codeOf(
        ctx.container.supportFaqs.setStatus(tenantA, ownerA, {
          idempotencyKey: key(),
          id: created.id,
          status: 'INACTIVE',
          expectedVersion: 1,
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.SUPPORT_FAQ_VERSION_CONFLICT);

    // Nothing the stale writes asked for landed.
    const now = await ctx.container.supportFaqs.listForOperator(tenantA, ownerA);
    const row = now.find((candidate) => candidate.id === created.id);
    expect(row).toMatchObject({ question: 'Edited', status: 'ACTIVE', version: 2 });

    const { rows } = (await ctx.container.database.db.execute(
      sql`SELECT action, before, after FROM audit_logs
           WHERE tenant_id = ${tenantA.tenantId}
             AND entity_type = 'SupportFaq' AND entity_id = ${created.id}
           ORDER BY id`,
    )) as unknown as {
      rows: {
        action: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown>;
      }[];
    };
    expect(rows.map((entry) => entry.action)).toEqual(['support_faq.create', 'support_faq.update']);
    expect(rows[0]?.before).toBeNull();
    expect(rows[0]?.after).toMatchObject({ question: 'Original', version: 1 });
    expect(rows[1]?.before).toMatchObject({ question: 'Original', version: 1 });
    expect(rows[1]?.after).toMatchObject({ question: 'Edited', sortOrder: 110, version: 2 });
  });

  it('answers a replay with the first result, and a no-op status change without an audit row', async () => {
    const idempotencyKey = key();
    const input = { idempotencyKey, question: 'Replayed', answer: 'Once', sortOrder: 0 };
    const first = await ctx.container.supportFaqs.create(tenantA, ownerA, input);
    const second = await ctx.container.supportFaqs.create(tenantA, ownerA, input);
    expect(second.id).toBe(first.id);
    // ONE row: a replay inserts nothing, and a create on its own does not seed — the
    // defaults arrive with the first read or list, not with the first write.
    expect(await rowsOf(tenantA.tenantId)).toBe(1);

    const statusKey = key();
    const hidden = await ctx.container.supportFaqs.setStatus(tenantA, ownerA, {
      idempotencyKey: statusKey,
      id: first.id,
      status: 'INACTIVE',
      expectedVersion: 1,
    });
    expect(hidden.version).toBe(2);
    const replayed = await ctx.container.supportFaqs.setStatus(tenantA, ownerA, {
      idempotencyKey: statusKey,
      id: first.id,
      status: 'INACTIVE',
      expectedVersion: 1,
    });
    expect(replayed.version).toBe(2);

    // A DIFFERENT key asking for the state it is already in: no change, no audit row,
    // no version bump.
    const again = await ctx.container.supportFaqs.setStatus(tenantA, ownerA, {
      idempotencyKey: key(),
      id: first.id,
      status: 'INACTIVE',
      expectedVersion: 2,
    });
    expect(again.version).toBe(2);

    const { rows } = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS total FROM audit_logs
           WHERE tenant_id = ${tenantA.tenantId} AND action = 'support_faq.status'`,
    )) as unknown as { rows: { total: number }[] };
    expect(rows[0]?.total).toBe(1);
  });

  it('refuses the entry past SUPPORT_FAQ_MAX_ENTRIES', async () => {
    await ctx.container.supportScreen.screenFor(tenantA);
    // Filled directly: the bound is on the COUNT, and a hundred audited commands would
    // prove nothing more than the insert does.
    const now = ctx.container.clock.now();
    for (let index = 9; index < SUPPORT_FAQ_MAX_ENTRIES; index += 1) {
      await ctx.container.database.db.execute(
        sql`INSERT INTO support_faqs (id, tenant_id, question, answer, status, sort_order, version, created_at, updated_at)
             VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${`Q${String(index)}`}, ${'A'}, 'ACTIVE', ${index}, 1, ${now}, ${now})`,
      );
    }
    expect(await rowsOf(tenantA.tenantId)).toBe(SUPPORT_FAQ_MAX_ENTRIES);

    expect(
      await codeOf(
        ctx.container.supportFaqs.create(tenantA, ownerA, {
          idempotencyKey: key(),
          question: 'One too many',
          answer: 'Refused',
          sortOrder: 0,
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.SUPPORT_FAQ_LIMIT);
    expect(await rowsOf(tenantA.tenantId)).toBe(SUPPORT_FAQ_MAX_ENTRIES);
    // Another tenant is not bounded by this one's count.
    await ctx.container.supportFaqs.create(tenantB, ownerB, {
      idempotencyKey: key(),
      question: 'B is fine',
      answer: 'B',
      sortOrder: 0,
    });
  });

  it('refuses every write once the scope has stopped accepting work', async () => {
    const [row] = await ctx.container.supportFaqs.listForOperator(tenantA, ownerA);
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
    );
    expect(
      await codeOf(
        ctx.container.supportFaqs.create(tenantA, ownerA, {
          idempotencyKey: key(),
          question: 'After the stop',
          answer: 'No',
          sortOrder: 0,
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID);
    expect(
      await codeOf(
        ctx.container.supportFaqs.setStatus(tenantA, ownerA, {
          idempotencyKey: key(),
          id: (row as NonNullable<typeof row>).id,
          status: 'INACTIVE',
          expectedVersion: 1,
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID);
    // And a stopped tenant that was never seeded is not seeded now.
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantB.tenantId}`,
    );
    expect((await ctx.container.supportScreen.screenFor(tenantB)).faqs).toEqual([]);
    expect(await seedsOf(tenantB.tenantId)).toBe(0);
  });
});

/**
 * The same service, reached the way the Web Admin reaches it: a session cookie, the
 * Origin check on every write, the contract schemas on both sides.
 */
describe('support FAQ over HTTP', () => {
  const ORIGIN = 'https://admin.example.test';
  let api: ApiApp;
  let cookie: string;

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

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    await createAdmin(api.container, tenantA, {
      username: 'owner-http',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    const login = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner-http', password: 'the-owners-real-password' },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(login.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error('No session cookie.');
    cookie = `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  });

  it('lists, creates, edits with expectedVersion and switches status through the controller', async () => {
    const listed = await inject({
      method: 'GET',
      url: `${API_PREFIX}${SUPPORT_FAQ_ROUTES.list}`,
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    const items = supportFaqListSchema.parse(listed.json()).items;
    expect(items).toHaveLength(9);

    const created = await inject({
      method: 'POST',
      url: `${API_PREFIX}${SUPPORT_FAQ_ROUTES.create}`,
      headers: { cookie, origin: ORIGIN },
      payload: { idempotencyKey: key(), question: 'Over HTTP', answer: 'Yes', sortOrder: 1 },
    });
    expect(created.statusCode).toBe(201);
    const row = supportFaqSchema.parse(created.json());
    expect(row).toMatchObject({ question: 'Over HTTP', status: 'ACTIVE', version: 1 });

    const edited = await inject({
      method: 'POST',
      url: `${API_PREFIX}${SUPPORT_FAQ_ROUTES.update(row.id)}`,
      headers: { cookie, origin: ORIGIN },
      payload: {
        idempotencyKey: key(),
        question: 'Over HTTP, edited',
        answer: 'Yes',
        sortOrder: 2,
        expectedVersion: 1,
      },
    });
    expect(edited.statusCode).toBe(201);
    expect(supportFaqSchema.parse(edited.json())).toMatchObject({
      id: row.id,
      question: 'Over HTTP, edited',
      version: 2,
    });

    // The stale version is a 409 that names the current one.
    const stale = await inject({
      method: 'POST',
      url: `${API_PREFIX}${SUPPORT_FAQ_ROUTES.status(row.id)}`,
      headers: { cookie, origin: ORIGIN },
      payload: { idempotencyKey: key(), status: 'INACTIVE', expectedVersion: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: {
        code: COMMERCE_ERROR_CODES.SUPPORT_FAQ_VERSION_CONFLICT,
        details: { currentVersion: 2 },
      },
    });

    const hidden = await inject({
      method: 'POST',
      url: `${API_PREFIX}${SUPPORT_FAQ_ROUTES.status(row.id)}`,
      headers: { cookie, origin: ORIGIN },
      payload: { idempotencyKey: key(), status: 'INACTIVE', expectedVersion: 2 },
    });
    expect(hidden.statusCode).toBe(201);
    expect(supportFaqSchema.parse(hidden.json())).toMatchObject({ status: 'INACTIVE', version: 3 });

    // A body the contract refuses never reaches the service.
    const invalid = await inject({
      method: 'POST',
      url: `${API_PREFIX}${SUPPORT_FAQ_ROUTES.create}`,
      headers: { cookie, origin: ORIGIN },
      payload: { idempotencyKey: key(), question: '', answer: 'x', sortOrder: 0 },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('refuses a write without an allowed Origin, and any request without a session', async () => {
    const noOrigin = await inject({
      method: 'POST',
      url: `${API_PREFIX}${SUPPORT_FAQ_ROUTES.create}`,
      headers: { cookie },
      payload: { idempotencyKey: key(), question: 'CSRF', answer: 'No', sortOrder: 0 },
    });
    expect(noOrigin.statusCode).toBe(403);

    const anonymous = await inject({
      method: 'GET',
      url: `${API_PREFIX}${SUPPORT_FAQ_ROUTES.list}`,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
