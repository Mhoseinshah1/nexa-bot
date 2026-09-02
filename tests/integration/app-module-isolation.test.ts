import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { migrateOnce, testConfig } from './harness';

/**
 * Two applications in one process must not share configuration.
 *
 * `AppModule.isProduction` was a mutable static: `forContainer` assigned it and
 * `configure` read it back. Nothing keyed it to an application, so a second
 * construction overwrote the first's value.
 *
 * What this test does and does not prove, stated plainly rather than implied:
 * it PASSES against the old mutable static too. `securityHeaders(isProduction)`
 * is called during `configure()` and captures the boolean in a closure, so by
 * the time a later construction rewrites the static the middleware has already
 * been built. The static was latent, not live — unnecessary process-global
 * state rather than a reachable bug, and it was removed on that basis.
 *
 * The test earns its place as the invariant going forward: it fails the moment
 * anyone makes that value read at request time, or shares it between graphs in
 * any other way. The final assertion is the pointed one — an application's
 * header mode must not change because a DIFFERENT application was constructed
 * afterwards.
 */
describe('two applications in one process', () => {
  let production: ApiApp;
  let development: ApiApp;

  const headers = async (api: ApiApp): Promise<Record<string, unknown>> => {
    const response = await api.app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/health/live' } as never);
    return (response as { headers: Record<string, unknown> }).headers;
  };

  beforeAll(async () => {
    const productionConfig = testConfig({
      NODE_ENV: 'production',
      PASSWORD_HASH_PROFILE: 'production',
      WEB_ADMIN_ORIGINS: 'https://admin.example.com',
      DEPLOYMENT_TOPOLOGY: 'reverse-proxy',
      TRUSTED_PROXY_IPS: '127.0.0.1,::1',
    });
    await migrateOnce(productionConfig.DATABASE_URL);

    production = await createApiApp(productionConfig);
    development = await createApiApp(testConfig());
  }, 120_000);

  afterAll(async () => {
    await production?.close();
    await development?.close();
  });

  it('does not leak the security-header mode between them', async () => {
    const productionHeaders = await headers(production);
    const developmentHeaders = await headers(development);

    // Production sends HSTS.
    expect(productionHeaders['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );

    // Development does not — and this is the assertion that fails when the
    // setting is process-global, because development was constructed last.
    expect(developmentHeaders['strict-transport-security']).toBeUndefined();

    // The headers that do not depend on the environment are present on both,
    // so the test is reading a live middleware rather than an empty response.
    for (const set of [productionHeaders, developmentHeaders]) {
      expect(set['x-content-type-options']).toBe('nosniff');
      expect(set['x-frame-options']).toBe('DENY');
    }
  }, 60_000);

  it('does not change an application because a later one was constructed', async () => {
    // The pointed version of the same rule. The development application above
    // was constructed AFTER the production one; production must still answer
    // exactly as it did before that happened.
    const productionHeaders = await headers(production);
    expect(productionHeaders['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );

    // And a third construction, made right now, must not disturb either.
    const late = await createApiApp(testConfig());
    try {
      expect((await headers(production))['strict-transport-security']).toBe(
        'max-age=31536000; includeSubDomains',
      );
      expect((await headers(development))['strict-transport-security']).toBeUndefined();
      expect((await headers(late))['strict-transport-security']).toBeUndefined();
    } finally {
      await late.close();
    }
  }, 60_000);
});
