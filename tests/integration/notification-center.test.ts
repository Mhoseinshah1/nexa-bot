import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  NOTIFICATION_CENTER_ROUTES,
  NOTIFICATION_RULES,
  NOTIFICATION_WINDOW_DAYS,
  SESSION_COOKIE_NAME,
  isNexaError,
  type ActorContext,
  type CorrelationId,
  type OperationalEventInput,
  type TenantContext,
} from '@nexa/contracts';
import { sql } from 'drizzle-orm';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { createContainer } from '../../apps/api/src/container';
import {
  NotificationCenterService,
  type NotificationCenterDeps,
} from '../../apps/api/src/modules/platform/opslog/application/notification-center.service';
import { DrizzleNotificationInboxRepository } from '../../apps/api/src/modules/platform/opslog/infrastructure/drizzle-notification-inbox.repository';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  migrateOnce,
  resetDatabase,
  testConfig,
  tenantA,
  tenantB,
  type SeededAdmin,
  type TestContext,
} from './harness';

/**
 * Phase B3 — the Web Admin Notification Center, against a real PostgreSQL and the REAL
 * operational-event recorder: every notification here is produced by the code path that
 * records it in production (`opsLog.record`), and read back through the service and the
 * HTTP route. Nothing is inserted behind the recorder's back except to age a row.
 */

const panelDown = (panelId: string): OperationalEventInput => ({
  code: 'panel.health.unreachable',
  severity: 'ERROR',
  message: 'Panel is not answering.',
  dedupeKey: `panel.health:${panelId}`,
  context: { panelId },
});
const panelUp = (panelId: string): OperationalEventInput => ({
  code: 'panel.health.recovered',
  severity: 'INFO',
  message: 'Panel is answering again.',
  context: { panelId },
  recoversCode: 'panel.health.unreachable',
  recoversDedupeKey: `panel.health:${panelId}`,
});
const paymentReview = (paymentId: string): OperationalEventInput => ({
  code: 'payments.gateway_review_unresolved',
  severity: 'WARN',
  message: 'Reconcile this payment against the gateway.',
  dedupeKey: `payments.gateway_review_unresolved:${paymentId}`,
  context: { paymentId, provider: 'TONPAYS' },
});

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isNexaError(error)) return { kind: error.kind, code: error.code };
    throw error;
  }
  throw new Error('Expected a refusal.');
}

describe('Phase B3 — notification center', () => {
  let ctx: TestContext;
  let owner: SeededAdmin;
  let finance: SeededAdmin;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await ctx.reset();
    owner = await createAdmin(ctx.container, tenantA, {
      username: 'owner-nc',
      roleKeys: ['owner'],
    });
    // Finance reads payments and nothing about panels, backups or administrators.
    finance = await createAdmin(ctx.container, tenantA, {
      username: 'finance-nc',
      roleKeys: ['finance'],
    });
  });

  const record = (event: OperationalEventInput, scope: TenantContext = tenantA) =>
    ctx.container.opsLog.record(scope, event);
  const list = (admin: SeededAdmin, extra: { unreadOnly?: boolean; category?: 'PANELS' } = {}) =>
    ctx.container.notificationCenter.list(tenantA, adminActorFor(admin), {
      limit: 50,
      unreadOnly: extra.unreadOnly ?? false,
      before: null,
      ...(extra.category === undefined ? {} : { category: extra.category }),
    });
  const summary = (admin: SeededAdmin) =>
    ctx.container.notificationCenter.summary(tenantA, adminActorFor(admin));

  it('fans out from the source event, with its category, severity and deep link', async () => {
    const panelId = randomUUID();
    const paymentId = randomUUID();
    await record(panelDown(panelId));
    await record(paymentReview(paymentId));
    const items = await list(owner);
    expect(items.map((one) => one.code).sort()).toEqual([
      'panel.health.unreachable',
      'payments.gateway_review_unresolved',
    ]);
    const panel = items.find((one) => one.code === 'panel.health.unreachable');
    expect(panel).toMatchObject({
      category: 'PANELS',
      severity: 'ERROR',
      read: false,
      resolvedAt: null,
      link: { target: 'PANEL', id: panelId },
    });
    expect(items.find((one) => one.category === 'PAYMENTS')?.link).toEqual({
      target: 'PAYMENT',
      id: paymentId,
    });
  });

  it('is not every operational event: no rule, a routine severity, or a recovery is no notification', async () => {
    await record({ code: 'system.ping', severity: 'INFO', message: 'ping' });
    await record({
      code: 'access.permission_denied',
      severity: 'WARN',
      message: 'denied',
    });
    // A rule's prefix, below its minimum severity.
    await record({ code: 'panel.health.restored', severity: 'INFO', message: 'restored' });
    const panelId = randomUUID();
    await record(panelDown(panelId));
    // A recovery at a severity the rule admits: still not a notification, because it
    // is a recovery (`recovers_code` set), whatever its code and severity.
    await record({ ...panelUp(panelId), severity: 'WARN' });
    const items = await list(owner);
    expect(items.map((one) => one.code)).toEqual(['panel.health.unreachable']);
    // The recovery closes the failure's notification rather than adding one.
    expect(items[0]?.resolvedAt).not.toBeNull();
  });

  it('dedupes a recurring condition into ONE notification with a count, unread again after a recurrence', async () => {
    const panelId = randomUUID();
    await record(panelDown(panelId));
    await record(panelDown(panelId));
    await record(panelDown(panelId));
    let items = await list(owner);
    expect(items).toHaveLength(1);
    expect(items[0]?.occurrenceCount).toBe(3);
    expect(await summary(owner)).toMatchObject({ unread: 1, highest: 'ERROR' });

    const id = items[0]?.id as string;
    await ctx.container.notificationCenter.mark(tenantA, adminActorFor(owner), { id, read: true });
    expect((await summary(owner)).unread).toBe(0);

    // The same condition again: still one notification, now unread for this admin again.
    await record(panelDown(panelId));
    items = await list(owner);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id, occurrenceCount: 4, read: false });
    expect((await summary(owner)).unread).toBe(1);
  });

  it('keeps read state per administrator: read, unread and mark-all', async () => {
    const other = await createAdmin(ctx.container, tenantA, {
      username: 'owner-nc-2',
      roleKeys: ['owner'],
    });
    await record(panelDown(randomUUID()));
    await record(paymentReview(randomUUID()));
    await record({
      code: 'backup.run_failed',
      severity: 'ERROR',
      message: 'The backup failed.',
      dedupeKey: 'backup.run',
    });
    expect((await summary(owner)).unread).toBe(3);
    expect((await summary(other)).unread).toBe(3);

    const [first] = await list(owner);
    const read = await ctx.container.notificationCenter.mark(tenantA, adminActorFor(owner), {
      id: first?.id as string,
      read: true,
    });
    expect(read.read).toBe(true);
    // Idempotent: the same mark again is the same state.
    await ctx.container.notificationCenter.mark(tenantA, adminActorFor(owner), {
      id: first?.id as string,
      read: true,
    });
    expect((await summary(owner)).unread).toBe(2);
    expect((await summary(other)).unread).toBe(3);

    const unread = await ctx.container.notificationCenter.mark(tenantA, adminActorFor(owner), {
      id: first?.id as string,
      read: false,
    });
    expect(unread.read).toBe(false);
    expect((await summary(owner)).unread).toBe(3);

    // Mark all in one category, then everything.
    expect(
      await ctx.container.notificationCenter.markAll(tenantA, adminActorFor(owner), {
        category: 'PANELS',
      }),
    ).toBe(1);
    expect((await list(owner, { unreadOnly: true })).map((one) => one.category).sort()).toEqual([
      'BACKUPS',
      'PAYMENTS',
    ]);
    expect(await ctx.container.notificationCenter.markAll(tenantA, adminActorFor(owner), {})).toBe(
      2,
    );
    expect((await summary(owner)).unread).toBe(0);
    expect(await ctx.container.notificationCenter.markAll(tenantA, adminActorFor(owner), {})).toBe(
      0,
    );
    expect((await summary(other)).unread).toBe(3);
  });

  it('shows each administrator only the categories their permissions admit', async () => {
    const panelId = randomUUID();
    await record(panelDown(panelId));
    await record(paymentReview(randomUUID()));
    await record({
      code: 'admin.roles_changed',
      severity: 'INFO',
      message: 'Roles changed.',
    });
    expect((await list(owner)).map((one) => one.category).sort()).toEqual([
      'PANELS',
      'PAYMENTS',
      'SECURITY',
    ]);
    expect((await list(finance)).map((one) => one.category)).toEqual(['PAYMENTS']);
    expect((await summary(finance)).unread).toBe(1);

    // A notification outside the admin's categories is not found, and cannot be marked.
    const hidden = (await list(owner)).find((one) => one.category === 'PANELS');
    expect(
      (
        await refusal(
          ctx.container.notificationCenter.mark(tenantA, adminActorFor(finance), {
            id: hidden?.id as string,
            read: true,
          }),
        )
      ).kind,
    ).toBe('NOT_FOUND');
    // Asking for a category one may not see is a refusal through the guard.
    expect(
      (
        await refusal(
          ctx.container.notificationCenter.markAll(tenantA, adminActorFor(finance), {
            category: 'PANELS',
          }),
        )
      ).kind,
    ).toBe('PERMISSION_DENIED');
    // And an administrator with no notifiable permission has an empty inbox, not an error.
    const observer = await createAdmin(ctx.container, tenantA, {
      username: 'observer-nc',
      roleKeys: [],
    });
    expect(await list(observer)).toEqual([]);
    expect(await summary(observer)).toEqual({ unread: 0, atLeast: false, highest: null });
  });

  it('isolates tenants: another tenant’s events are never in the inbox, nor markable', async () => {
    const foreign = await record(panelDown(randomUUID()), tenantB);
    await record(paymentReview(randomUUID()));
    expect((await list(owner)).map((one) => one.code)).toEqual([
      'payments.gateway_review_unresolved',
    ]);
    expect(
      (
        await refusal(
          ctx.container.notificationCenter.mark(tenantA, adminActorFor(owner), {
            id: foreign.id,
            read: true,
          }),
        )
      ).kind,
    ).toBe('NOT_FOUND');
    const ownerB = await createAdmin(ctx.container, tenantB, {
      username: 'owner-nc-b',
      roleKeys: ['owner'],
    });
    const inB = await ctx.container.notificationCenter.list(tenantB, adminActorFor(ownerB), {
      limit: 50,
      unreadOnly: false,
      before: null,
    });
    expect(inB.map((one) => one.id)).toEqual([foreign.id]);
    // Marking in B leaves A's admin untouched, and vice versa.
    await ctx.container.notificationCenter.markAll(tenantB, adminActorFor(ownerB), {});
    expect((await summary(owner)).unread).toBe(1);
  });

  it('links to the list when the event names no entity, and never links an unsafe id', async () => {
    await record({
      code: 'provisioning.stalled',
      severity: 'ERROR',
      message: 'stalled',
      dedupeKey: 'provisioning.stalled:x',
      context: { serviceId: 'javascript:alert(1)' },
    });
    await record({
      code: 'recovery.run_failed',
      severity: 'ERROR',
      message: 'recovery failed',
      dedupeKey: `recovery.${randomUUID()}`,
    });
    const links = (await list(owner)).map((one) => one.link);
    expect(links).toContainEqual({ target: 'SERVICES', id: null });
    expect(links).toContainEqual({ target: 'RECOVERY', id: null });
  });

  it('ages out of the window unless it recurs', async () => {
    const paymentId = randomUUID();
    await record(paymentReview(paymentId));
    // The same inbox, forty days later: the event is past the window. (The operational log
    // refuses rewriting its timestamps, so it is the reader's clock that moves.)
    const later = new NotificationCenterService({
      repository: new DrizzleNotificationInboxRepository(
        ctx.container.database.db,
        NOTIFICATION_RULES,
      ),
      guard: ctx.container.guard,
      opsLog: ctx.container.opsLog,
      scopeActivity: ctx.container.tenants,
      uow: ctx.container.uow,
      clock: { now: () => new Date(Date.now() + (NOTIFICATION_WINDOW_DAYS + 10) * 86_400_000) },
    });
    const listLater = () =>
      later.list(tenantA, adminActorFor(owner), { limit: 50, unreadOnly: false, before: null });
    expect(await listLater()).toEqual([]);
    expect((await later.summary(tenantA, adminActorFor(owner))).unread).toBe(0);
    // Still in today's inbox.
    expect(await list(owner)).toHaveLength(1);
  });

  it('pages by the immutable (first_seen, id) keyset without losing rows', async () => {
    for (let index = 0; index < 5; index += 1) await record(paymentReview(randomUUID()));
    const all = await list(owner);
    const page1 = await ctx.container.notificationCenter.list(tenantA, adminActorFor(owner), {
      limit: 2,
      unreadOnly: false,
      before: null,
    });
    const last = page1.at(-1);
    const page2 = await ctx.container.notificationCenter.list(tenantA, adminActorFor(owner), {
      limit: 10,
      unreadOnly: false,
      before: { at: last?.firstSeenAt as Date, id: last?.id as string },
    });
    expect([...page1, ...page2].map((one) => one.id)).toEqual(all.map((one) => one.id));
  });

  it('survives a restart: read state is in the database, not the process', async () => {
    await record(panelDown(randomUUID()));
    await record(paymentReview(randomUUID()));
    const [first] = await list(owner);
    await ctx.container.notificationCenter.mark(tenantA, adminActorFor(owner), {
      id: first?.id as string,
      read: true,
    });
    // A second, fresh process over the same database.
    const fresh = createContainer(testConfig(), 'api');
    try {
      const after = await fresh.notificationCenter.summary(tenantA, adminActorFor(owner));
      expect(after.unread).toBe(1);
    } finally {
      await fresh.shutdown();
    }
  });

  it('tones the bell by the highest unread severity, even when it lies beyond the count cap', async () => {
    // Five WARNs first, then the only CRITICAL, newest and last in the table's natural
    // order: an unordered LIMIT of 3 reads the WARNs and stops before it.
    for (let index = 0; index < 5; index += 1) await record(paymentReview(randomUUID()));
    await record({
      code: 'payments.gateway_review_unresolved',
      severity: 'CRITICAL',
      message: 'Reconcile this payment against the gateway.',
      dedupeKey: `payments.gateway_review_unresolved:${randomUUID()}`,
      context: { paymentId: randomUUID() },
    });
    const repository = new DrizzleNotificationInboxRepository(
      ctx.container.database.db,
      NOTIFICATION_RULES,
    );
    const answer = await repository.unread(
      tenantA,
      {
        adminId: owner.id,
        rules: NOTIFICATION_RULES,
        windowStart: new Date(Date.now() - NOTIFICATION_WINDOW_DAYS * 86_400_000),
        unreadOnly: true,
      },
      3,
    );
    expect(answer).toEqual({ count: 3, highest: 'CRITICAL' });
  });

  describe('a permission revoked after the early check and before the write', () => {
    const reads = async () =>
      Number(
        (
          (
            await ctx.container.database.db.execute(
              sql`SELECT count(*)::int AS n FROM admin_notification_reads`,
            )
          ).rows[0] as { n: number }
        ).n,
      );
    /** The real unit of work, with the revocation committed just before it opens. */
    const racing = (admin: SeededAdmin) =>
      new NotificationCenterService({
        repository: new DrizzleNotificationInboxRepository(
          ctx.container.database.db,
          NOTIFICATION_RULES,
        ),
        guard: ctx.container.guard,
        opsLog: ctx.container.opsLog,
        scopeActivity: ctx.container.tenants,
        clock: ctx.container.clock,
        uow: {
          run: async (scope, fn) => {
            await ctx.container.roles.setAdminRoles(tenantA, admin.id, [], null);
            return ctx.container.uow.run(scope, fn);
          },
          runSnapshot: (scope, fn) => ctx.container.uow.runSnapshot(scope, fn),
          runNested: (scope, tx, fn) => ctx.container.uow.runNested(scope, tx, fn),
        } satisfies NotificationCenterDeps['uow'],
      });

    // Another owner, so that revoking this one's roles leaves the tenant an active owner.
    const racer = (username: string) =>
      createAdmin(ctx.container, tenantA, { username, roleKeys: ['owner'] });

    it('refuses a mark, writes nothing, and records the denial', async () => {
      await record(panelDown(randomUUID()));
      const [item] = await list(owner);
      const admin = await racer('owner-nc-racer');
      const refused = await refusal(
        racing(admin).mark(tenantA, adminActorFor(admin), { id: item?.id as string, read: true }),
      );
      expect(refused.kind).toBe('PERMISSION_DENIED');
      expect(await reads()).toBe(0);
      const events = await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM operational_events WHERE code = 'access.permission_denied'`,
      );
      expect((events.rows[0] as { n: number }).n).toBe(1);
    });

    it('refuses a category mark-all, and marks nothing in an unfiltered one', async () => {
      await record(panelDown(randomUUID()));
      await record(paymentReview(randomUUID()));
      const first = await racer('owner-nc-racer-1');
      expect(
        (
          await refusal(
            racing(first).markAll(tenantA, adminActorFor(first), { category: 'PANELS' }),
          )
        ).kind,
      ).toBe('PERMISSION_DENIED');
      expect(await reads()).toBe(0);

      // A mark-all over every category: the filter is decided again on the transaction,
      // so an administrator revoked in between marks nothing.
      const second = await racer('owner-nc-racer-2');
      expect(await racing(second).markAll(tenantA, adminActorFor(second), {})).toBe(0);
      expect(await reads()).toBe(0);
    });
  });

  it('refuses a system job: only an administrator has an inbox', async () => {
    const job: ActorContext = {
      type: 'SYSTEM_JOB',
      id: null,
      label: 'job',
      surface: 'WORKER',
      correlationId: 'c' as CorrelationId,
    };
    expect((await refusal(ctx.container.notificationCenter.summary(tenantA, job))).kind).toBe(
      'PERMISSION_DENIED',
    );
  });
});

describe('Phase B3 — notification center over HTTP', () => {
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
      username: 'owner-nc-http',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    const login = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner-nc-http', password: 'the-owners-real-password' },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(login.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error('No session cookie.');
    cookie = `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  });

  it('lists, counts, marks and marks all — and never sends the raw context', async () => {
    const paymentId = randomUUID();
    await api.container.opsLog.record(tenantA, {
      ...paymentReview(paymentId),
      context: { paymentId, provider: 'TONPAYS', secretish: 'do-not-ship' },
    });
    const summary = await inject({
      method: 'GET',
      url: `${API_PREFIX}${NOTIFICATION_CENTER_ROUTES.summary}`,
      headers: { cookie },
    });
    expect(summary.json()).toEqual({ unread: 1, atLeast: false, highestUnread: 'WARN' });

    const listed = await inject({
      method: 'GET',
      url: `${API_PREFIX}${NOTIFICATION_CENTER_ROUTES.list}?unread=true`,
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain('do-not-ship');
    const [item] = (listed.json() as { notifications: { id: string; link: unknown }[] })
      .notifications;
    expect(item?.link).toEqual({ target: 'PAYMENT', id: paymentId });

    const marked = await inject({
      method: 'POST',
      url: `${API_PREFIX}${NOTIFICATION_CENTER_ROUTES.mark(item?.id as string)}`,
      headers: { origin: ORIGIN, cookie },
      payload: { read: true },
    });
    expect(marked.statusCode, marked.body).toBe(201);
    expect((marked.json() as { notification: { read: boolean } }).notification.read).toBe(true);

    const all = await inject({
      method: 'POST',
      url: `${API_PREFIX}${NOTIFICATION_CENTER_ROUTES.markAll}`,
      headers: { origin: ORIGIN, cookie },
      payload: {},
    });
    expect(all.json()).toEqual({ marked: 0 });

    const foreign = await inject({
      method: 'POST',
      url: `${API_PREFIX}${NOTIFICATION_CENTER_ROUTES.markAll}`,
      headers: { origin: 'https://evil.example.test', cookie },
      payload: {},
    });
    expect(foreign.statusCode).toBe(403);
  });

  it('refuses half a page cursor rather than answering page 1', async () => {
    for (const query of ['beforeAt=2026-01-01T00:00:00.000Z', `beforeId=${randomUUID()}`]) {
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${NOTIFICATION_CENTER_ROUTES.list}?${query}`,
        headers: { cookie },
      });
      expect(response.statusCode, query).toBe(400);
    }
    const whole = await inject({
      method: 'GET',
      url: `${API_PREFIX}${NOTIFICATION_CENTER_ROUTES.list}?beforeAt=2026-01-01T00:00:00.000Z&beforeId=${randomUUID()}`,
      headers: { cookie },
    });
    expect(whole.statusCode).toBe(200);
  });
});
