import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_ROUTES,
  API_PREFIX,
  AUTH_ROUTES,
  CONTROL_ROUTES,
  monitorProfileResponseSchema,
  operationalEventListResponseSchema,
  SESSION_COOKIE_NAME,
  systemContext,
  settingListResponseSchema,
  settingWriteResponseSchema,
  notificationListResponseSchema,
} from '@nexa/contracts';
import {
  schedulerFreshPanelUpperBound,
  tenantBudgetFreshPanelUpperBound,
  tenantTurnFreshTenantUpperBound,
} from '../../apps/api/src/modules/platform/panels/domain/monitor-cadence';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';

/**
 * Phase 3D, over real HTTP and a real database.
 *
 * Three things the browser tests cannot prove: that the management scope is
 * applied in SQL so a PAGE of results is a page of matching rows, that the four
 * new settings round-trip through the registry and the audit, and that the
 * monitor profile reports the deployment's own configuration.
 */

const ORIGIN = 'https://admin.example.test';

describe('the Web Admin V2 surface', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let supportCookie: string;

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

    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    // `receipt_reviewer` holds neither `opslog.view` nor `panels.view`.
    await createAdmin(api.container, tenantA, {
      username: 'reviewer',
      password: 'the-reviewers-password',
      roleKeys: ['receipt_reviewer'],
    });

    ownerCookie = await cookieFor('owner', 'the-owners-real-password');
    supportCookie = await cookieFor('reviewer', 'the-reviewers-password');
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
    if (match === null) throw new Error(`No session cookie for ${username}.`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  const asAdmin = (cookie: string) => ({ cookie, origin: ORIGIN });
  const get = (path: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: asAdmin(cookie) });
  const post = (path: string, cookie: string, payload: unknown) =>
    inject({ method: 'POST', url: `${API_PREFIX}${path}`, headers: asAdmin(cookie), payload });

  let keyCounter = 0;
  const idempotencyKey = () => `phase3d-${(keyCounter += 1)}-${Date.now()}`;

  // -------------------------------------------------------------------------
  // Owner revision 21 — the management scope
  // -------------------------------------------------------------------------

  describe('the management scope', () => {
    async function recordEvents(): Promise<void> {
      // Nine routine events and one management event, recorded in that order so
      // the management row is the OLDEST. A browser-side filter over a page of
      // five would show nothing at all and page past it.
      for (let index = 0; index < 9; index += 1) {
        await api.container.opsLog.record(tenantA, {
          code: 'panel.health.unreachable',
          severity: 'ERROR',
          message: `panel ${index} is unreachable`,
          dedupeKey: `panel:${index}`,
        });
      }
      // A code a production path actually writes. Every assertion in this
      // block used to invent one — `admin.roles_change`, which is an AUDIT
      // action, not an event code — so the suite proved the SQL could find a
      // row nothing ever inserts.
      await api.container.opsLog.record(tenantA, {
        code: 'admin.roles_changed',
        severity: 'INFO',
        message: 'roles changed',
      });
    }

    it('returns only management codes, and returns them on the first page', async () => {
      await recordEvents();

      const body = operationalEventListResponseSchema.parse(
        (await get(`${CONTROL_ROUTES.opsLog}?scope=MANAGEMENT&limit=5`, ownerCookie)).json(),
      );

      expect(body.events.map((event) => event.code)).toEqual(['admin.roles_changed']);
      // The point of applying it in SQL: `limit` bounds the MATCHING rows, so
      // the one management event is on the first page even though nine routine
      // events were recorded after it.
      expect(body.events).toHaveLength(1);
    });

    it('still returns the whole stream without the scope', async () => {
      await recordEvents();

      const body = operationalEventListResponseSchema.parse(
        (await get(`${CONTROL_ROUTES.opsLog}?limit=50`, ownerCookie)).json(),
      );
      expect(body.events).toHaveLength(10);
      expect(body.events.some((event) => event.code === 'panel.health.unreachable')).toBe(true);
    });

    /**
     * The narrower scope, and the defect it exists to prevent.
     *
     * `access.permission_denied` is written fresh on every denial — no dedupe
     * key, no recovery — and nothing in this product ever resolves it, because
     * there is deliberately no "mark as seen". On a card headed "needs
     * attention" those rows accumulate for the life of the installation. So
     * the dashboard asks for `MANAGEMENT_CONDITIONS`, which admits only codes
     * something closes, and the denial stays readable on the alerts page as
     * history.
     */
    it('separates the conditions an operator can close from the records they cannot', async () => {
      await api.container.opsLog.record(tenantA, {
        code: 'access.permission_denied',
        severity: 'WARN',
        message: 'somebody was denied panels.edit',
      });
      await api.container.opsLog.record(tenantA, {
        code: 'settings.stored_value_invalid',
        severity: 'ERROR',
        message: 'a stored setting stopped parsing',
        dedupeKey: 'settings.stored_value_invalid:ops.notifications.min_severity',
      });

      const wide = operationalEventListResponseSchema.parse(
        (await get(`${CONTROL_ROUTES.opsLog}?scope=MANAGEMENT`, ownerCookie)).json(),
      );
      const codes = wide.events.map((event) => event.code);
      expect(codes).toContain('access.permission_denied');
      expect(codes).toContain('settings.stored_value_invalid');

      const conditions = operationalEventListResponseSchema.parse(
        (
          await get(`${CONTROL_ROUTES.opsLog}?scope=MANAGEMENT_CONDITIONS&open=true`, ownerCookie)
        ).json(),
      );
      const conditionCodes = conditions.events.map((event) => event.code);
      expect(conditionCodes).toContain('settings.stored_value_invalid');
      // The one that matters: a denial is never an outstanding task.
      expect(conditionCodes).not.toContain('access.permission_denied');
    });

    /**
     * T15 — a RECOVERY is not an open condition.
     *
     * This is the same defect as the denial above, arriving from the other
     * direction, and it was introduced by the fix for it. A recovery row is
     * INSERTED by the recorder with its own `resolvedAt` left null: it resolves
     * the preceding failure, never itself, and nothing in this product ever
     * resolves a recovery. So a conditions scope built from the whole lifecycle
     * returned `settings.stored_value_valid` from `open=true` — and the card
     * headed "needs attention" filled with the rows that say attention is no
     * longer needed. Driven through the real recorder and the real HTTP
     * endpoint, because the bug lives in the seam between them.
     */
    it('never returns a recovery as an open condition', async () => {
      await api.container.opsLog.record(tenantA, {
        code: 'settings.stored_value_invalid',
        severity: 'ERROR',
        message: 'a stored setting stopped parsing',
        dedupeKey: 'settings.stored_value_invalid:ops.notifications.min_severity',
      });
      // The production recovery path: a row of its own that CLOSES the failure.
      await api.container.opsLog.record(tenantA, {
        code: 'settings.stored_value_valid',
        severity: 'INFO',
        message: 'the stored setting parses again',
        recoversCode: 'settings.stored_value_invalid',
      });

      const open = operationalEventListResponseSchema.parse(
        (
          await get(`${CONTROL_ROUTES.opsLog}?scope=MANAGEMENT_CONDITIONS&open=true`, ownerCookie)
        ).json(),
      );
      // The failure was closed by the recovery, so nothing is open...
      expect(open.events).toEqual([]);

      // ...and specifically NOT the recovery, whose own `resolvedAt` is null.
      const all = operationalEventListResponseSchema.parse(
        (await get(`${CONTROL_ROUTES.opsLog}?scope=MANAGEMENT`, ownerCookie)).json(),
      );
      const recovery = all.events.find((event) => event.code === 'settings.stored_value_valid');
      expect(recovery, 'the recovery is still readable as history').toBeDefined();
      expect(recovery?.resolvedAt, 'nothing resolves a recovery').toBeNull();

      const conditions = operationalEventListResponseSchema.parse(
        (await get(`${CONTROL_ROUTES.opsLog}?scope=MANAGEMENT_CONDITIONS`, ownerCookie)).json(),
      );
      expect(conditions.events.map((event) => event.code)).not.toContain(
        'settings.stored_value_valid',
      );
    });

    /**
     * T14 — a malformed `open` is a 400, not the opposite answer.
     *
     * `query.open === 'true'` turned every other spelling into `false`, so
     * `open=tru` answered 200 with the whole history where the caller asked for
     * outstanding conditions only.
     */
    it('refuses an open filter that is neither true nor false', async () => {
      for (const value of ['tru', 'TRUE', '1', 'yes', '']) {
        const response = await get(
          `${CONTROL_ROUTES.opsLog}?scope=MANAGEMENT_CONDITIONS&open=${value}`,
          ownerCookie,
        );
        expect(response.statusCode, `open=${value}`).toBe(400);
      }
      // Both accepted spellings still work.
      for (const value of ['true', 'false']) {
        expect((await get(`${CONTROL_ROUTES.opsLog}?open=${value}`, ownerCookie)).statusCode).toBe(
          200,
        );
      }
    });

    /**
     * T18 — a malformed cursor id is a 400, not a 500.
     *
     * `beforeId` is compared against a `uuid` column, so a short string reached
     * the driver as 22P02 and came back as an internal error on a request the
     * caller got wrong.
     */
    it('refuses a cursor id that is not an identifier', async () => {
      const response = await get(
        `${CONTROL_ROUTES.opsLog}?before=2026-09-06T08:00:00.000Z&beforeId=not-a-uuid`,
        ownerCookie,
      );
      expect(response.statusCode).toBe(400);
    });

    it('refuses a page size outside the bounds instead of coercing it', async () => {
      for (const limit of ['0', '-1', '5000', 'many']) {
        expect(
          (await get(`${CONTROL_ROUTES.opsLog}?limit=${limit}`, ownerCookie)).statusCode,
          `limit=${limit}`,
        ).toBe(400);
      }
    });

    /**
     * T06 — `nextCursor` answers "is there another page", and a FULL last page
     * is the case a length comparison gets wrong.
     *
     * With exactly `limit` matching rows the page is full and there is nothing
     * behind it. The reader over-fetches one row so the server can tell the two
     * apart, and the alerts pager reads that answer instead of guessing.
     */
    it('reports no next cursor on a page that is exactly full', async () => {
      for (let index = 0; index < 3; index += 1) {
        await api.container.opsLog.record(tenantA, {
          code: 'access.permission_denied',
          severity: 'WARN',
          message: `denial ${index}`,
        });
      }

      const exact = operationalEventListResponseSchema.parse(
        (await get(`${CONTROL_ROUTES.opsLog}?scope=MANAGEMENT&limit=3`, ownerCookie)).json(),
      );
      expect(exact.events).toHaveLength(3);
      // Full, and final. A `length === limit` test would have offered a page
      // that does not exist.
      expect(exact.nextCursor).toBeNull();

      const first = operationalEventListResponseSchema.parse(
        (await get(`${CONTROL_ROUTES.opsLog}?scope=MANAGEMENT&limit=2`, ownerCookie)).json(),
      );
      expect(first.events).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      // And the cursor points at the LAST row returned, so the next page
      // continues rather than skipping one.
      expect(first.nextCursor?.id).toBe(first.events[1]?.id);

      const second = operationalEventListResponseSchema.parse(
        (
          await get(
            `${CONTROL_ROUTES.opsLog}?scope=MANAGEMENT&limit=2` +
              `&before=${encodeURIComponent(first.nextCursor?.at ?? '')}` +
              `&beforeId=${first.nextCursor?.id ?? ''}`,
            ownerCookie,
          )
        ).json(),
      );
      expect(second.events).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      // Every row seen exactly once across the two pages.
      const ids = [...first.events, ...second.events].map((event) => event.id);
      expect(new Set(ids).size).toBe(3);
    });

    /**
     * The `admin.` PREFIX that used to be in the contract matched nothing:
     * `admin.create` and friends are audit `action` values, not event codes.
     * The four codes below are what the identity service now records beside
     * those audit rows, which is what makes owner revision 24 true rather than
     * claimed.
     */
    it('carries the administrator changes owner revision 24 asks for', async () => {
      for (const code of [
        'admin.created',
        'admin.status_changed',
        'admin.roles_changed',
        'admin.password_changed',
      ] as const) {
        await api.container.opsLog.record(tenantA, {
          code,
          severity: 'INFO',
          message: `${code} happened`,
        });
      }

      const body = operationalEventListResponseSchema.parse(
        (await get(`${CONTROL_ROUTES.opsLog}?scope=MANAGEMENT`, ownerCookie)).json(),
      );
      const codes = body.events.map((event) => event.code);
      for (const code of [
        'admin.created',
        'admin.status_changed',
        'admin.roles_changed',
        'admin.password_changed',
      ]) {
        expect(codes, code).toContain(code);
      }

      // And a code with the old prefix shape is NOT management-facing, because
      // the prefix is gone and the enumeration is the whole rule.
      await api.container.opsLog.record(tenantA, {
        code: 'admin.some_future_change',
        severity: 'WARN',
        message: 'something new happened to an administrator',
      });
      const after = operationalEventListResponseSchema.parse(
        (await get(`${CONTROL_ROUTES.opsLog}?scope=MANAGEMENT`, ownerCookie)).json(),
      );
      expect(after.events.map((event) => event.code)).not.toContain('admin.some_future_change');
    });

    /**
     * T26 — the codes come from the REAL administrator operations.
     *
     * Every assertion above records its rows through `container.opsLog`
     * directly, which proves the SQL can find them and nothing about whether
     * anything writes them. Replacing `recordAdminChange`'s body with a no-op
     * left the whole management scope green while creating an administrator,
     * suspending one, changing their roles or their password produced nothing
     * on the alerts page at all. So this block drives the four operations over
     * real HTTP and reads back what the endpoint returns.
     */
    it('records an operational event for each real administrator change', async () => {
      const created = await post(ADMIN_ROUTES.create, ownerCookie, {
        username: 'newcomer',
        displayName: 'Newcomer',
        password: 'a-perfectly-fine-password',
        roleKeys: ['support'],
      });
      expect([200, 201], created.body).toContain(created.statusCode);
      const newcomerId = (created.json() as { id: string }).id;

      const disabled = await post(ADMIN_ROUTES.status(newcomerId), ownerCookie, {
        status: 'DISABLED',
        reason: 'They have left.',
      });
      expect([200, 201], disabled.body).toContain(disabled.statusCode);

      const reroled = await post(ADMIN_ROUTES.roles(newcomerId), ownerCookie, {
        roleKeys: ['receipt_reviewer'],
        reason: 'A different job now.',
      });
      expect([200, 201], reroled.body).toContain(reroled.statusCode);

      // The owner's own password, through the auth surface — the fourth code.
      const changed = await post(AUTH_ROUTES.password, ownerCookie, {
        currentPassword: 'the-owners-real-password',
        newPassword: 'an-entirely-different-password',
      });
      expect([200, 201], changed.body).toContain(changed.statusCode);

      // A password change kills every session that administrator holds, which
      // is itself the behaviour under test elsewhere — so sign in again.
      const freshCookie = await cookieFor('owner', 'an-entirely-different-password');
      const body = operationalEventListResponseSchema.parse(
        (await get(`${CONTROL_ROUTES.opsLog}?scope=MANAGEMENT&limit=50`, freshCookie)).json(),
      );
      const codes = new Set(body.events.map((event) => event.code));
      for (const code of [
        'admin.created',
        'admin.status_changed',
        'admin.roles_changed',
        'admin.password_changed',
      ]) {
        expect(codes.has(code), `${code} was not recorded by the real operation`).toBe(true);
      }
    });
  });

  describe('the settings the owner revisions add', () => {
    it('reports whether anything reads each key', async () => {
      const body = settingListResponseSchema.parse(
        (await get(CONTROL_ROUTES.settings, ownerCookie)).json(),
      );
      const byKey = new Map(body.settings.map((setting) => [setting.key, setting]));

      for (const key of [
        'sales.currency',
        'support.accounts',
        'telegram.channels',
        'wallet.topup.minimum',
      ]) {
        expect(byKey.get(key)?.consumer, key).toBe('PLANNED');
      }
      expect(byKey.get('ops.notifications.max_attempts')?.consumer).toBe('ACTIVE');
    });

    it('round-trips an ordered list of support accounts', async () => {
      const response = await post(CONTROL_ROUTES.setting('support.accounts'), ownerCookie, {
        value: ['@Support1', '@Support2', '@Support3'],
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });
      // 201: this creates the row. A replacement answers 200.
      expect(response.statusCode).toBe(201);

      const written = settingWriteResponseSchema.parse(response.json());
      expect(written.changed).toBe(true);
      // Order survives the round trip. It is data, not a rendering choice.
      expect(written.setting.value).toEqual(['@Support1', '@Support2', '@Support3']);

      const list = settingListResponseSchema.parse(
        (await get(CONTROL_ROUTES.settings, ownerCookie)).json(),
      );
      expect(list.settings.find((s) => s.key === 'support.accounts')?.value).toEqual([
        '@Support1',
        '@Support2',
        '@Support3',
      ]);
    });

    it('rejects a malformed handle and a repeat, at the server', async () => {
      for (const value of [['not-a-handle'], ['@Support1', '@support1'], ['@ab']]) {
        const response = await post(CONTROL_ROUTES.setting('support.accounts'), ownerCookie, {
          value,
          expectedVersion: null,
          idempotencyKey: idempotencyKey(),
        });
        expect(response.statusCode, JSON.stringify(value)).toBe(400);
      }
    });

    it('round-trips channels with their required-membership flag', async () => {
      const response = await post(CONTROL_ROUTES.setting('telegram.channels'), ownerCookie, {
        value: [
          { handle: '@Channel1', mandatory: true },
          { handle: '@NewsChannel', mandatory: false },
        ],
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });
      expect(response.statusCode).toBe(201);
      expect(settingWriteResponseSchema.parse(response.json()).setting.value).toEqual([
        { handle: '@Channel1', mandatory: true },
        { handle: '@NewsChannel', mandatory: false },
      ]);
    });

    it('refuses a channel with no answer to the membership question', async () => {
      const response = await post(CONTROL_ROUTES.setting('telegram.channels'), ownerCookie, {
        value: [{ handle: '@Channel1' }],
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });
      expect(response.statusCode).toBe(400);
    });

    it('stores the top-up minimum as an amount and a currency, and refuses a bare number', async () => {
      const ok = await post(CONTROL_ROUTES.setting('wallet.topup.minimum'), ownerCookie, {
        value: { amountMinor: '20000', currency: 'IRT' },
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });
      expect(ok.statusCode).toBe(201);

      const bare = await post(CONTROL_ROUTES.setting('wallet.topup.minimum'), ownerCookie, {
        value: 20000,
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });
      expect(bare.statusCode).toBe(400);
    });

    it('accepts Toman and Rial as the store currency and nothing else', async () => {
      // Every control-plane POST answers 201, replacement included — Nest's
      // default for @Post, and what the rest of this suite asserts. Worth
      // knowing rather than worth changing: the status is part of a shipped
      // API, and a create/replace distinction nobody currently reads is not
      // reason enough to move it.
      const first = await post(CONTROL_ROUTES.setting('sales.currency'), ownerCookie, {
        value: 'IRR',
        expectedVersion: null,
        idempotencyKey: idempotencyKey(),
      });
      expect(first.statusCode).toBe(201);
      const created = settingWriteResponseSchema.parse(first.json());
      expect(created.setting.value).toBe('IRR');

      const second = await post(CONTROL_ROUTES.setting('sales.currency'), ownerCookie, {
        value: 'IRT',
        expectedVersion: created.setting.version,
        idempotencyKey: idempotencyKey(),
      });
      expect(second.statusCode).toBe(201);
      expect(settingWriteResponseSchema.parse(second.json()).setting.value).toBe('IRT');

      // The catalogue in money.ts carries USD, EUR and USDT for a converted
      // payment quote. A STORE currency is a different question, and widening
      // it is a contract change to make when a gateway settles in one of them.
      const rejected = await post(CONTROL_ROUTES.setting('sales.currency'), ownerCookie, {
        value: 'USD',
        expectedVersion: settingWriteResponseSchema.parse(second.json()).setting.version,
        idempotencyKey: idempotencyKey(),
      });
      expect(rejected.statusCode).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Owner revision 18 — the monitor profile
  // -------------------------------------------------------------------------

  /**
   * Owner-facing history has to be REACHABLE.
   *
   * The repository accepted a `before` from the day it was written and the
   * controller never parsed it, so the newest page was the only page: past
   * the default fifty, an intent was unreachable from the Web Admin unless
   * its UUID was already known.
   */
  describe('the notification pager', () => {
    /**
     * `count` intents that ALL share one `created_at`.
     *
     * Written through the repository with an explicit `now` rather than
     * through `NotificationService.queue`, and the shared timestamp is the
     * whole point: `Clock.now()` is read per call, so intents queued normally
     * get distinct timestamps and a timestamp-ONLY cursor walks them
     * perfectly. Two earlier versions of this block did exactly that, and both
     * stayed green with the tie-break reverted — a test that could not fail
     * for the defect it was written for.
     *
     * With a shared timestamp, a page boundary falls inside the group, and
     * `lt(created_at, cursor)` skips every remaining member of it.
     */
    async function recordIntents(count: number): Promise<void> {
      const at = new Date('2026-09-06T08:00:00.000Z');
      for (let index = 0; index < count; index += 1) {
        await api.container.notificationRepository.create(tenantA, {
          id: api.container.ids.uuid(),
          kind: 'OPERATIONAL_EVENT',
          dedupeKey: `phase3d-pager-${(keyCounter += 1)}`,
          destination: { transport: 'TELEGRAM', chatId: '-1001234567890', topicId: null },
          payload: { code: 'panel.health.unreachable', message: `panel ${index}` },
          templateKey: 'ops.notification.operational_event',
          maxAttempts: 5,
          correlationId: null,
          now: at,
        });
      }
    }

    it('walks the whole history with a cursor, seeing every intent exactly once', async () => {
      await recordIntents(7);

      const seen: string[] = [];
      let cursor: { at: string; id: string } | null = null;
      for (let page = 0; page < 10; page += 1) {
        const params = new URLSearchParams({ limit: '3' });
        if (cursor) {
          params.set('before', cursor.at);
          params.set('beforeId', cursor.id);
        }
        const body = notificationListResponseSchema.parse(
          (await get(`${CONTROL_ROUTES.notifications}?${params.toString()}`, ownerCookie)).json(),
        );
        seen.push(...body.notifications.map((one) => one.id));
        cursor = body.nextCursor;
        if (cursor === null) break;
      }

      expect(seen).toHaveLength(7);
      // Exactly once: a timestamp-only cursor would DROP the tail of any group
      // sharing a `created_at`, and those rows would appear on no page at all.
      expect(new Set(seen).size).toBe(7);
    });

    it('reports no next cursor on a short page', async () => {
      await recordIntents(2);
      const body = notificationListResponseSchema.parse(
        (await get(`${CONTROL_ROUTES.notifications}?limit=50`, ownerCookie)).json(),
      );
      expect(body.notifications).toHaveLength(2);
      expect(body.nextCursor).toBeNull();
    });

    /**
     * T17 — the case a short page cannot detect.
     *
     * `found.length === size` is true both for the last page and for a page
     * with more behind it, so the surface was offered an "older" page that did
     * not exist and one press past the end rendered an empty history over
     * intents that were one page back. The reader asks for one row more than it
     * returns.
     */
    it('reports no next cursor on a page that is exactly full', async () => {
      await recordIntents(3);
      const body = notificationListResponseSchema.parse(
        (await get(`${CONTROL_ROUTES.notifications}?limit=3`, ownerCookie)).json(),
      );
      expect(body.notifications).toHaveLength(3);
      expect(body.nextCursor).toBeNull();
    });

    /**
     * The MAXIMUM page size, which the over-fetch nearly made unreachable.
     *
     * The controller asks the service for `size + 1`, and the service clamped
     * at 200 — the wire maximum — so at `limit=200` the extra row was eaten,
     * `found.length > size` was `200 > 200`, and `nextCursor` came back null
     * with rows still behind it. That is a worse failure than the false cursor
     * the over-fetch removed: an empty page can be navigated away from, an
     * unreachable one cannot. The ops-log path was raised to 201 for this and
     * the notification path was missed.
     */
    it('still reports a next cursor at the maximum page size', async () => {
      // One more than the ceiling, so the ceiling page has something behind it.
      await recordIntents(201);
      const body = notificationListResponseSchema.parse(
        (await get(`${CONTROL_ROUTES.notifications}?limit=200`, ownerCookie)).json(),
      );
      expect(body.notifications).toHaveLength(200);
      expect(body.nextCursor, 'the 201st intent is unreachable').not.toBeNull();
    });

    it('reports no next cursor at the maximum page size when the page is the last', async () => {
      // Exactly the ceiling: full, and final. The other direction, so the fix
      // is not "always return a cursor at the ceiling".
      await recordIntents(200);
      const body = notificationListResponseSchema.parse(
        (await get(`${CONTROL_ROUTES.notifications}?limit=200`, ownerCookie)).json(),
      );
      expect(body.notifications).toHaveLength(200);
      expect(body.nextCursor).toBeNull();
    });

    /**
     * Half a cursor is a bad request, not the first page.
     *
     * A lone `before` walked the keyset with no tie-break — the defect the pair
     * exists to prevent — and a lone `beforeId` was dropped entirely and
     * answered 200 with the NEWEST page, so a client whose cursor was truncated
     * looped on page one with no way to tell.
     */
    it('refuses half a notification cursor', async () => {
      const id = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
      expect(
        (await get(`${CONTROL_ROUTES.notifications}?before=2026-09-06T08:00:00.000Z`, ownerCookie))
          .statusCode,
        'a timestamp with no tie-break',
      ).toBe(400);
      expect(
        (await get(`${CONTROL_ROUTES.notifications}?beforeId=${id}`, ownerCookie)).statusCode,
        'a tie-break with no timestamp',
      ).toBe(400);
      // Neither half is still fine — that is the newest page, asked for plainly.
      expect((await get(CONTROL_ROUTES.notifications, ownerCookie)).statusCode).toBe(200);
    });

    it('refuses half an ops-log cursor', async () => {
      const id = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
      expect(
        (await get(`${CONTROL_ROUTES.opsLog}?before=2026-09-06T08:00:00.000Z`, ownerCookie))
          .statusCode,
      ).toBe(400);
      expect((await get(`${CONTROL_ROUTES.opsLog}?beforeId=${id}`, ownerCookie)).statusCode).toBe(
        400,
      );
      expect((await get(CONTROL_ROUTES.opsLog, ownerCookie)).statusCode).toBe(200);
    });

    it('refuses a page size past the wire maximum rather than clamping it', async () => {
      expect((await get(`${CONTROL_ROUTES.notifications}?limit=201`, ownerCookie)).statusCode).toBe(
        400,
      );
    });

    it('refuses a notification cursor id that is not an identifier', async () => {
      const response = await get(
        `${CONTROL_ROUTES.notifications}?before=2026-09-06T08:00:00.000Z&beforeId=not-a-uuid`,
        ownerCookie,
      );
      expect(response.statusCode).toBe(400);
    });
  });

  describe('the monitor profile', () => {
    it('reports the cadence and the capacity this deployment actually has', async () => {
      const response = await get(CONTROL_ROUTES.systemMonitor, ownerCookie);
      expect(response.statusCode).toBe(200);

      const { monitor } = monitorProfileResponseSchema.parse(response.json());
      expect(monitor.healthyIntervalMs).toBe(
        api.container.config.PANEL_MONITOR_HEALTHY_INTERVAL_MS,
      );
      expect(monitor.probeTenantLimit).toBe(api.container.config.PANEL_PROBE_TENANT_LIMIT);
      // Computed on the server, by the same functions the capacity conditions
      // use, so the screen and the alarm cannot disagree about a fleet fitting.
      //
      // Asserted against those functions, not against `> 0`. The previous pair
      // of assertions passed for any positive integer: swapping the two
      // ceilings, or returning a constant 1, left them green while the comment
      // above went on claiming the guarantee.
      const config = api.container.config;
      expect(monitor.tenantFreshPanelCeiling).toBe(
        tenantBudgetFreshPanelUpperBound(
          config.PANEL_PROBE_TENANT_LIMIT,
          config.PANEL_PROBE_TENANT_WINDOW_MS,
          config.PANEL_MONITOR_HEALTHY_INTERVAL_MS,
        ),
      );
      expect(monitor.installationFreshPanelCeiling).toBe(
        schedulerFreshPanelUpperBound(
          config.PANEL_MONITOR_BATCH_SIZE,
          config.PANEL_MONITOR_TICK_MS,
          config.PANEL_MONITOR_HEALTHY_INTERVAL_MS,
        ),
      );
      // T21 — the THIRD bound, which nothing reported. The scheduler reaches
      // `tenantsPerTick x (interval / tick)` tenants inside a freshness window;
      // a tenant beyond that waits longer than the interval for its first probe
      // and goes stale while both panel ceilings say the fleet fits.
      expect(monitor.tenantTurnCeiling).toBe(
        tenantTurnFreshTenantUpperBound(
          config.PANEL_MONITOR_TENANTS_PER_TICK,
          config.PANEL_MONITOR_TICK_MS,
          config.PANEL_MONITOR_HEALTHY_INTERVAL_MS,
        ),
      );
      // The two are NOT interchangeable, which is what a swap would break.
      expect(monitor.tenantFreshPanelCeiling).not.toBe(monitor.installationFreshPanelCeiling);
      // Nothing is over capacity on a fresh installation with no panels.
      expect(monitor.schedulerCapacityExceeded).toBe(false);
    });

    /**
     * T31 — the alarm, with a REAL condition open.
     *
     * `schedulerCapacityExceeded` was only ever asserted false, on an empty
     * database, beside a unit test whose fake reader returned whatever the case
     * wanted. So hard-coding `DrizzleOperationalEventReader.systemConditionIsOpen`
     * to false, or breaking its null-tenant predicate, left every test green
     * while the only Web Admin route for the installation-capacity alarm could
     * never report it.
     *
     * The row is written the way the monitor writes it: under `SYSTEM_SCOPE`,
     * with a null tenant — which is also why the tenant-scoped log reader can
     * never see it and this endpoint has to answer.
     */
    it('reports an installation capacity condition that is really open', async () => {
      const before = monitorProfileResponseSchema.parse(
        (await get(CONTROL_ROUTES.systemMonitor, ownerCookie)).json(),
      );
      expect(before.monitor.schedulerCapacityExceeded).toBe(false);

      await api.container.opsLog.record(systemContext('a capacity assessment, in a test'), {
        code: 'panel.monitor.scheduler_capacity_exceeded',
        severity: 'ERROR',
        message: 'the installation asks for more starts than the scheduler can make',
        dedupeKey: 'panel.monitor.scheduler_capacity_exceeded',
      });

      const during = monitorProfileResponseSchema.parse(
        (await get(CONTROL_ROUTES.systemMonitor, ownerCookie)).json(),
      );
      expect(during.monitor.schedulerCapacityExceeded).toBe(true);

      // And it CLOSES: the recovery resolves the failure row, and the alarm
      // stops — so this is not merely "any row makes it true for ever".
      await api.container.opsLog.record(systemContext('a capacity assessment, in a test'), {
        code: 'panel.monitor.scheduler_capacity_ok',
        severity: 'INFO',
        message: 'the installation is back under its ceiling',
        recoversCode: 'panel.monitor.scheduler_capacity_exceeded',
      });

      const after = monitorProfileResponseSchema.parse(
        (await get(CONTROL_ROUTES.systemMonitor, ownerCookie)).json(),
      );
      expect(after.monitor.schedulerCapacityExceeded).toBe(false);
    });

    /**
     * The null-tenant predicate itself: a row with the same code under a TENANT
     * is not an installation condition, and must not raise the alarm.
     */
    it('does not mistake a tenant-scoped row for an installation condition', async () => {
      await api.container.opsLog.record(tenantA, {
        code: 'panel.monitor.scheduler_capacity_exceeded',
        severity: 'ERROR',
        message: 'recorded against a tenant, which the monitor never does',
        dedupeKey: 'tenant-scoped-capacity',
      });

      const body = monitorProfileResponseSchema.parse(
        (await get(CONTROL_ROUTES.systemMonitor, ownerCookie)).json(),
      );
      expect(body.monitor.schedulerCapacityExceeded).toBe(false);
    });

    /**
     * T04 — the EFFECTIVE probe cooldown, over real HTTP, from a deployment
     * whose two settings disagree.
     *
     * The probe core floors the cooldown at what one probe can actually spend
     * on the wire — `max(PANEL_PROBE_COOLDOWN_MS, PANEL_HTTP_TIMEOUT_MS x (1 +
     * retries))` — because a shorter window would let a second request start
     * while the first is still open. The profile published the RAW setting, so
     * a deployment configured at one second reported a one-second cooldown
     * while every panel was held for the full HTTP budget. The endpoint's whole
     * contract is that it describes what this installation is running.
     *
     * A second app, with its own configuration, because the defect is in what
     * `createContainer` hands to two different objects and no test of either
     * one alone can see it.
     */
    it('reports the cooldown the probes actually obey, not the raw setting', async () => {
      const config = testConfig({
        WEB_ADMIN_ORIGINS: ORIGIN,
        PANEL_PROBE_COOLDOWN_MS: '1000',
        PANEL_HTTP_TIMEOUT_MS: '20000',
      });
      const other = await createApiApp(config);
      try {
        const login = await other.app
          .getHttpAdapter()
          .getInstance()
          .inject({
            method: 'POST',
            url: `${API_PREFIX}${AUTH_ROUTES.login}`,
            headers: { origin: ORIGIN },
            payload: { username: 'owner', password: 'the-owners-real-password' },
          } as never);
        const header = String(login.headers['set-cookie'] ?? '');
        const cookie = `${SESSION_COOKIE_NAME}=${
          new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header)?.[1] ?? ''
        }`;

        const response = await other.app
          .getHttpAdapter()
          .getInstance()
          .inject({
            method: 'GET',
            url: `${API_PREFIX}${CONTROL_ROUTES.systemMonitor}`,
            headers: { cookie, origin: ORIGIN },
          } as never);
        const { monitor } = monitorProfileResponseSchema.parse(response.json());

        // NOT the configured 1000.
        expect(monitor.probeCooldownMs).not.toBe(config.PANEL_PROBE_COOLDOWN_MS);
        expect(monitor.probeCooldownMs).toBe(20_000);
      } finally {
        await other.close();
      }
    });

    it('reports the configured cooldown when it is above the HTTP floor', async () => {
      // The other direction, so this is not "always report the floor": a
      // constant would pass the case above and fail here.
      const config = testConfig({
        WEB_ADMIN_ORIGINS: ORIGIN,
        PANEL_PROBE_COOLDOWN_MS: '600000',
        PANEL_HTTP_TIMEOUT_MS: '10000',
      });
      const other = await createApiApp(config);
      try {
        const login = await other.app
          .getHttpAdapter()
          .getInstance()
          .inject({
            method: 'POST',
            url: `${API_PREFIX}${AUTH_ROUTES.login}`,
            headers: { origin: ORIGIN },
            payload: { username: 'owner', password: 'the-owners-real-password' },
          } as never);
        const header = String(login.headers['set-cookie'] ?? '');
        const cookie = `${SESSION_COOKIE_NAME}=${
          new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header)?.[1] ?? ''
        }`;

        const response = await other.app
          .getHttpAdapter()
          .getInstance()
          .inject({
            method: 'GET',
            url: `${API_PREFIX}${CONTROL_ROUTES.systemMonitor}`,
            headers: { cookie, origin: ORIGIN },
          } as never);
        const { monitor } = monitorProfileResponseSchema.parse(response.json());
        expect(monitor.probeCooldownMs).toBe(600_000);
      } finally {
        await other.close();
      }
    });

    it('refuses a caller without panels.view', async () => {
      expect((await get(CONTROL_ROUTES.systemMonitor, supportCookie)).statusCode).toBe(403);
    });

    it('refuses an anonymous caller', async () => {
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${CONTROL_ROUTES.systemMonitor}`,
        headers: { origin: ORIGIN },
      });
      expect(response.statusCode).toBe(401);
    });
  });
});
