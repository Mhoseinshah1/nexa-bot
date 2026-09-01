import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX, AUTH_ROUTES } from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { adminLoginThrottle } from '../../apps/api/src/infrastructure/persistence/schema';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';

/**
 * Client IP behind a reverse proxy, over real HTTP.
 *
 * Production sits behind Caddy, so the socket address is the proxy's and the
 * real client is in `X-Forwarded-For`. That header is attacker-controlled
 * unless something decides whose copy to believe, and the client IP feeds
 * brute-force throttling and audit rows.
 */

const ORIGIN = 'https://admin.example.test';
const PROXY = '127.0.0.1';
const CLIENT = '203.0.113.55';
const SPOOFED = '198.51.100.99';

/** The throttle subjects recorded so far, so we can see whose IP was believed. */
async function ipSubjects(api: ApiApp): Promise<string[]> {
  const rows = await api.container.database.db.select().from(adminLoginThrottle);
  return rows
    .filter((row) => row.subjectKind === 'IP')
    .map((row) => row.subject)
    .sort();
}

async function failedLogin(
  api: ApiApp,
  headers: Record<string, string>,
  remoteAddress: string,
): Promise<void> {
  await api.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN, ...headers },
      remoteAddress,
      payload: { username: 'owner', password: 'definitely-wrong' },
    } as never);
}

describe('with a trusted upstream configured', () => {
  let api: ApiApp;

  beforeAll(async () => {
    const config = testConfig({
      WEB_ADMIN_ORIGINS: ORIGIN,
      DEPLOYMENT_TOPOLOGY: 'reverse-proxy',
      TRUSTED_PROXY_IPS: PROXY,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  });

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    const config = api.container.config;
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, config.SECRETS_KEK, config.SECRETS_KEK_ID);
    api.container.setInstallationTenant(tenantA.tenantId);
    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
  });

  it('believes X-Forwarded-For from the configured proxy', async () => {
    await failedLogin(api, { 'x-forwarded-for': CLIENT }, PROXY);
    // The client is throttled, not the proxy — otherwise one attacker behind
    // Caddy would lock out every administrator.
    expect(await ipSubjects(api)).toEqual([CLIENT]);
  });

  it('ignores a client-supplied prefix that our proxy appended to', async () => {
    // A client can send its own X-Forwarded-For; Caddy appends the address it
    // actually saw, so the header arrives as `<whatever the client claimed>,
    // <real client>`. Fastify walks from the RIGHT, skipping trusted upstreams,
    // and stops at the first address it was not told to trust — the real one.
    //
    // So the security property is not "take the leftmost". It is that a
    // caller's own entries can never displace what the proxy observed: they sit
    // to the left of it and are never reached.
    await failedLogin(api, { 'x-forwarded-for': `${SPOOFED}, ${CLIENT}` }, PROXY);

    const subjects = await ipSubjects(api);
    expect(subjects).toEqual([CLIENT]);
    expect(subjects).not.toContain(SPOOFED);
  });

  it('does not let a forged chain reach past the proxy', async () => {
    // Even a chain forged to look like several hops cannot promote an
    // attacker-chosen address, because only the configured upstream is skipped.
    await failedLogin(api, { 'x-forwarded-for': `${SPOOFED}, ${SPOOFED}, ${CLIENT}` }, PROXY);
    expect(await ipSubjects(api)).toEqual([CLIENT]);
  });

  it('does not throttle the proxy itself when the header is missing', async () => {
    // This is the misconfiguration signature: every request looks like it came
    // from Caddy. Counting failures against that address would lock the whole
    // installation out on somebody else's attempts, so per-IP throttling is
    // skipped and the per-username throttle carries the load alone.
    await failedLogin(api, {}, PROXY);
    expect(await ipSubjects(api)).toEqual([]);

    const usernameSubjects = await api.container.database.db.select().from(adminLoginThrottle);
    expect(usernameSubjects.some((row) => row.subjectKind === 'USERNAME')).toBe(true);
  });
});

describe('with no trusted upstream configured', () => {
  let api: ApiApp;

  beforeAll(async () => {
    const config = testConfig({
      WEB_ADMIN_ORIGINS: ORIGIN,
      DEPLOYMENT_TOPOLOGY: 'direct',
      TRUSTED_PROXY_IPS: '',
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  });

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    const config = api.container.config;
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, config.SECRETS_KEK, config.SECRETS_KEK_ID);
    api.container.setInstallationTenant(tenantA.tenantId);
    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
  });

  it('ignores a spoofed X-Forwarded-For from a direct client', async () => {
    // The attack `trustProxy: true` would allow: rotate a header instead of an
    // address, and both the throttle and the audit trail follow you.
    await failedLogin(api, { 'x-forwarded-for': SPOOFED }, CLIENT);

    const subjects = await ipSubjects(api);
    expect(subjects).toEqual([CLIENT]);
    expect(subjects).not.toContain(SPOOFED);
  });

  it('cannot be evaded by rotating the forged header', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await failedLogin(api, { 'x-forwarded-for': `198.51.100.${attempt}` }, CLIENT);
    }
    // One subject, five failures: the socket address, which nobody can forge.
    expect(await ipSubjects(api)).toEqual([CLIENT]);
  });
});
