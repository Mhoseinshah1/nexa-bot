import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { migrateOnce, resetDatabase, testConfig } from './harness';

/**
 * FIX-04 (S2): the unauthenticated development system endpoint is ABSENT unless a process
 * opted in explicitly AND runs under a development or test NODE_ENV.
 *
 * It used to be registered on `NODE_ENV === 'development'` alone, and a hand-built host left
 * on development served `POST /api/admin/v1/system/ping` — an anonymous write into
 * append-only tables — on its public domain, because Caddy proxies `/api/*`.
 *
 * Absence is asserted as a 404 from the real router, not by reading the controller list:
 * the claim is about what a caller on the network can reach.
 */

const PING = '/api/admin/v1/system/ping';

async function ping(api: ApiApp, key: string): Promise<number> {
  const response = await api.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: PING,
      payload: { idempotencyKey: key, source: 'http' },
    } as never);
  return (response as { statusCode: number }).statusCode;
}

const PRODUCTION = {
  NODE_ENV: 'production',
  PASSWORD_HASH_PROFILE: 'production',
  WEB_ADMIN_ORIGINS: 'https://admin.example.com',
  DEPLOYMENT_TOPOLOGY: 'reverse-proxy',
  TRUSTED_PROXY_IPS: '127.0.0.1,::1',
};

describe('the development system endpoint', () => {
  const apps: ApiApp[] = [];
  let developmentWithoutFlag: ApiApp;
  let developmentWithFlag: ApiApp;
  let testWithFlag: ApiApp;
  let production: ApiApp;

  beforeAll(async () => {
    const base = testConfig();
    await migrateOnce(base.DATABASE_URL);
    developmentWithoutFlag = await createApiApp(testConfig());
    developmentWithFlag = await createApiApp(testConfig({ DEV_SYSTEM_ENDPOINT_ENABLED: 'true' }));
    testWithFlag = await createApiApp(
      testConfig({ NODE_ENV: 'test', DEV_SYSTEM_ENDPOINT_ENABLED: 'true' }),
    );
    production = await createApiApp(testConfig(PRODUCTION));
    apps.push(developmentWithoutFlag, developmentWithFlag, testWithFlag, production);
    await resetDatabase(developmentWithFlag.container.database.db);
  }, 120_000);

  afterAll(async () => {
    for (const api of apps) await api.close();
  });

  it('is absent (404) in development without the opt-in', async () => {
    expect(await ping(developmentWithoutFlag, 'dev-no-flag')).toBe(404);
  });

  it('is absent (404) in production', async () => {
    expect(await ping(production, 'prod')).toBe(404);
  });

  it('is present with the opt-in in development and in test', async () => {
    expect(await ping(developmentWithFlag, 'dev-flag')).toBe(201);
    expect(await ping(testWithFlag, 'test-flag')).toBe(201);
  });

  it('refuses the opt-in in production, beside a public admin origin and behind a proxy', () => {
    expect(() => testConfig({ ...PRODUCTION, DEV_SYSTEM_ENDPOINT_ENABLED: 'true' })).toThrow(
      /DEV_SYSTEM_ENDPOINT_ENABLED/,
    );
    expect(() =>
      testConfig({
        DEV_SYSTEM_ENDPOINT_ENABLED: 'true',
        WEB_ADMIN_ORIGINS: 'https://bot.example-shop.com',
      }),
    ).toThrow(/looks public/);
    expect(() =>
      testConfig({
        DEV_SYSTEM_ENDPOINT_ENABLED: 'true',
        DEPLOYMENT_TOPOLOGY: 'reverse-proxy',
        TRUSTED_PROXY_IPS: '127.0.0.1',
      }),
    ).toThrow(/reverse-proxy/);
    // A local origin is not public: the opt-in is accepted there.
    expect(() =>
      testConfig({
        DEV_SYSTEM_ENDPOINT_ENABLED: 'true',
        WEB_ADMIN_ORIGINS: 'http://localhost:5173',
      }),
    ).not.toThrow();
  });
});
