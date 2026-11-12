import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX, AUTH_ROUTES, SESSION_COOKIE_NAME } from '@nexa/contracts';
import type { ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  createApiApp,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  testConfig,
} from './harness';

/**
 * `captcha.kind`: the Web Admin's sample picture. It is read under the permission that lists
 * the setting (`settings.view`): refused without a session, refused to an administrator whose
 * role lacks it, and a fresh PNG that is never cached for one that has it.
 */

const ORIGIN = 'https://admin.example.test';
const ROUTE = `${API_PREFIX}/settings/captcha-preview/image`;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('the captcha sample picture endpoint', () => {
  let api: ApiApp;

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
  });

  async function cookieFor(username: string, roleKeys: string[]): Promise<string> {
    const password = `${username}-a-long-enough-password`;
    await createAdmin(api.container, tenantA, { username, password, roleKeys });
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(response.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error(`No session cookie for ${username}.`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  const get = (cookie?: string) =>
    inject({
      method: 'GET',
      url: ROUTE,
      headers: cookie === undefined ? { origin: ORIGIN } : { cookie, origin: ORIGIN },
    });

  it('refuses a request with no admin session, and draws nothing', async () => {
    const response = await get();
    expect(response.statusCode).toBe(401);
    expect(response.rawPayload.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(false);
  });

  it('refuses an administrator whose role lacks settings.view', async () => {
    const reviewer = await cookieFor('reviewer', ['receipt_reviewer']);
    const response = await get(reviewer);
    expect(response.statusCode).toBe(403);
    expect(response.rawPayload.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(false);
  });

  it('gives one that holds it a fresh PNG, never cached, different every time', async () => {
    const owner = await cookieFor('owner', ['owner']);
    const first = await get(owner);
    const second = await get(owner);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('image/png');
    expect(String(first.headers['cache-control'])).toContain('no-store');
    expect(first.rawPayload.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(first.rawPayload.readUInt32BE(16)).toBe(320);
    expect(first.rawPayload.readUInt32BE(20)).toBe(120);
    expect(first.rawPayload.equals(second.rawPayload)).toBe(false);
  });

  it('lets an observer, who may view settings, see the sample too', async () => {
    const observer = await cookieFor('observer', ['observer']);
    expect((await get(observer)).statusCode).toBe(200);
  });
});
