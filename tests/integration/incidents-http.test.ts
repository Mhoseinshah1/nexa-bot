import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  INCIDENT_ROUTES,
  NOTIFICATION_CENTER_ROUTES,
  SESSION_COOKIE_NAME,
  incidentDetailResponseSchema,
  incidentListResponseSchema,
  inboxListResponseSchema,
} from '@nexa/contracts';
import type { ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  createAdmin,
  createApiApp,
  migrateOnce,
  resetDatabase,
  tenantA,
  testConfig,
} from './harness';

/**
 * PR-8, the «رخدادها» report ("view says there is no incident although incidents exist"):
 * the Web Admin opens an incident by the id the list (or the inbox's «مشاهده» link) gave it,
 * through `GET /incidents/:id`. The service suite calls the service directly; this one goes
 * over HTTP, as the admin does, and parses each answer with the schema the web client
 * parses it with — so a listed incident that the detail read could not open, or answered in
 * a shape the client refuses, fails here.
 */
describe('incidents over HTTP: every listed incident opens by its id', () => {
  const ORIGIN = 'https://admin.example.test';
  let api: ApiApp;
  let cookie: string;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const get = (path: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: { cookie } });
  const post = (path: string, payload: Record<string, unknown>) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: { origin: ORIGIN, cookie },
      payload: { idempotencyKey: randomUUID(), ...payload },
    });

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
      username: 'owner-inc-http',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    const login = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner-inc-http', password: 'the-owners-real-password' },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(login.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error('No session cookie.');
    cookie = `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  });

  it('active, scheduled, resolved and stop-sales incidents: list → detail, and the inbox links', async () => {
    const created = await post(INCIDENT_ROUTES.create, {
      kind: 'INCIDENT',
      severity: 'MINOR',
      title: 'resolved one',
    });
    expect(created.statusCode).toBe(201);
    const first = (JSON.parse(created.body) as { incident: { id: string; version: number } })
      .incident;
    expect(
      (await post(INCIDENT_ROUTES.resolve(first.id), { expectedVersion: first.version }))
        .statusCode,
    ).toBe(201);
    expect(
      (
        await post(INCIDENT_ROUTES.create, {
          kind: 'MAINTENANCE',
          severity: 'MAJOR',
          title: 'gateway stop',
          stopSales: true,
          customerMessage: 'paused',
          targets: [{ kind: 'GATEWAY', ref: 'TONPAYS' }],
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await post(INCIDENT_ROUTES.create, {
          kind: 'MAINTENANCE',
          severity: 'CRITICAL',
          title: 'scheduled window',
          scheduledStartAt: new Date(Date.now() + 86_400_000).toISOString(),
          scheduledEndAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        })
      ).statusCode,
    ).toBe(201);

    const listed = await get(INCIDENT_ROUTES.list);
    expect(listed.statusCode).toBe(200);
    const rows = incidentListResponseSchema.parse(JSON.parse(listed.body)).incidents;
    expect(rows.map((row) => row.title).sort()).toEqual(
      ['gateway stop', 'resolved one', 'scheduled window'].sort(),
    );
    for (const row of rows) {
      const one = await get(INCIDENT_ROUTES.one(encodeURIComponent(row.id)));
      expect(one.statusCode, row.title).toBe(200);
      const parsed = incidentDetailResponseSchema.parse(JSON.parse(one.body));
      expect(parsed.incident.id).toBe(row.id);
      expect(parsed.timeline.length).toBeGreaterThan(0);
    }

    // The inbox's «مشاهده» opens `/incidents/<link.id>`: each such id is a listed incident.
    const inbox = await get(NOTIFICATION_CENTER_ROUTES.list);
    expect(inbox.statusCode).toBe(200);
    const links = inboxListResponseSchema
      .parse(JSON.parse(inbox.body))
      .notifications.filter((item) => item.link.target === 'INCIDENT');
    expect(links.length).toBeGreaterThan(0);
    for (const item of links) {
      expect(rows.map((row) => row.id)).toContain(item.link.id);
    }
  });
});
