import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  API_PREFIX,
  IDENTITY_ERROR_CODES,
  AUTH_ROUTES,
  OWNER_ROLE_KEY,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME_SECURE,
  systemContext,
  TELEGRAM_SECRET_TOKEN_HEADER,
  type AdminId,
  type AdminSessionId,
  type CorrelationId,
} from '@nexa/contracts';
import { createApiApp, resolveInstallationTenant, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { ScryptPasswordHasher } from '../../apps/api/src/infrastructure/crypto/password-hasher';
import {
  adminLoginThrottle,
  adminPermissionOverrides,
  adminSessions,
  auditLogs,
  botInstances,
  outboxMessages,
  roles,
  rolePermissions,
  tenants,
} from '../../apps/api/src/infrastructure/persistence/schema';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
  type SeededAdmin,
  type TestContext,
} from './harness';

/**
 * Regressions for the second round of external review findings.
 *
 * Two of them are the review catching a fix that broke something (a login path
 * closed to every account still on an older cost profile, a lockout that
 * refused the attempt it was meant to allow), which is exactly the class of
 * defect a test suite is supposed to notice and did not. Each test below fails
 * against the commit that preceded its fix.
 */

let ctx: TestContext;
let owner: SeededAdmin;

const anonymous = {
  type: 'API' as const,
  id: null,
  label: null,
  surface: 'WEB' as const,
  correlationId: 'codex-2' as CorrelationId,
};
const from = { ip: '203.0.113.91', userAgent: 'vitest' };

/**
 * Below the suite's own profile (N=1024), and above OpenSSL's memory floor,
 * which N=2 is not. Stands in for a hash stored before a cost increase.
 */
const LEGACY_SCRYPT = { N: 256, r: 8, p: 1 };

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.reset();
  owner = await createAdmin(ctx.container, tenantA, { username: 'owner', roleKeys: ['owner'] });
});

/** Replaces an administrator's stored hash with one at a lower cost profile. */
async function storeLegacyHash(admin: SeededAdmin): Promise<string> {
  const legacy = await new ScryptPasswordHasher(LEGACY_SCRYPT).hash(admin.password);
  await ctx.container.admins.setPasswordHash(
    tenantA,
    admin.id as AdminId,
    legacy,
    ctx.container.clock.now(),
  );
  return legacy;
}

async function storedHashOf(username: string): Promise<string> {
  const credentials = await ctx.container.admins.findCredentialsByUsername(tenantA, username);
  if (credentials === null) throw new Error(`No credentials for ${username}`);
  return credentials.passwordHash;
}

describe('an account stored below the current cost profile can still sign in', () => {
  it('issues a session and upgrades the stored hash', async () => {
    // The rehash was written by its own compare-and-set BEFORE the session
    // transaction, whose `lockIfPasswordHashMatches` then demanded the hash the
    // rehash had just replaced. It never matched, so every account still on an
    // older profile was refused its own correct password — a self-inflicted
    // lockout of exactly the accounts a cost increase is meant to protect.
    const subject = await createAdmin(ctx.container, tenantA, {
      username: 'legacy',
      password: 'a-password-from-before',
      roleKeys: ['support'],
    });
    const legacyHash = await storeLegacyHash(subject);
    expect(ctx.container.hasher.needsRehash(legacyHash)).toBe(true);

    const result = await ctx.container.auth.login(
      tenantA,
      anonymous,
      { username: 'legacy', password: 'a-password-from-before' },
      from,
    );
    expect(result.admin.id).toBe(subject.id);

    // And the point of the rehash: the stored value is now at current cost, so
    // the upgrade happens once rather than on every login.
    const upgraded = await storedHashOf('legacy');
    expect(upgraded).not.toBe(legacyHash);
    expect(ctx.container.hasher.needsRehash(upgraded)).toBe(false);
    expect(await ctx.container.hasher.verify('a-password-from-before', upgraded)).toBe(true);
  });

  it('still refuses a wrong password against a below-cost hash', async () => {
    const subject = await createAdmin(ctx.container, tenantA, {
      username: 'legacy-wrong',
      password: 'a-password-from-before',
      roleKeys: ['support'],
    });
    const legacyHash = await storeLegacyHash(subject);

    await expect(
      ctx.container.auth.login(
        tenantA,
        anonymous,
        { username: 'legacy-wrong', password: 'not-the-password' },
        from,
      ),
    ).rejects.toMatchObject({ code: 'auth.invalid_credentials' });

    // A failed attempt must not upgrade anything: the plaintext was wrong, so
    // there was nothing correct to re-store.
    expect(await storedHashOf('legacy-wrong')).toBe(legacyHash);
  });
});

describe('the username oracle a cost increase would otherwise open', () => {
  it('spends the dummy derivation alongside the cheap one, not after it', async () => {
    // A below-cost hash verifies FASTER than the dummy work an unknown username
    // spends, so the difference says which usernames exist. Topping it up with
    // a second full derivation removed that signal and created the mirror
    // image: known-and-below-cost then took legacy + current, nearly twice what
    // an unknown username costs.
    //
    // Asserted structurally rather than by wall clock, which would be flaky:
    // the two derivations must OVERLAP, so the total is max(...) and not a sum.
    const subject = await createAdmin(ctx.container, tenantA, {
      username: 'timed',
      password: 'a-password-from-before',
      roleKeys: ['support'],
    });
    await storeLegacyHash(subject);

    const hasher = ctx.container.hasher as unknown as Record<string, unknown>;
    const realVerify = ctx.container.hasher.verify.bind(ctx.container.hasher);
    const realDummy = ctx.container.hasher.spendDummyWork.bind(ctx.container.hasher);
    const spans: Record<string, { start: number; end: number }> = {};

    hasher['verify'] = async (plaintext: string, encoded: string) => {
      const start = performance.now();
      const result = await realVerify(plaintext, encoded);
      spans['verify'] = { start, end: performance.now() };
      return result;
    };
    hasher['spendDummyWork'] = async () => {
      const start = performance.now();
      await realDummy();
      spans['dummy'] = { start, end: performance.now() };
    };

    try {
      await expect(
        ctx.container.auth.login(
          tenantA,
          anonymous,
          { username: 'timed', password: 'not-the-password' },
          from,
        ),
      ).rejects.toMatchObject({ code: 'auth.invalid_credentials' });
    } finally {
      hasher['verify'] = realVerify;
      hasher['spendDummyWork'] = realDummy;
    }

    const verifySpan = spans['verify'];
    const dummySpan = spans['dummy'];
    expect(verifySpan).toBeDefined();
    // The equalisation must still happen at all.
    expect(dummySpan).toBeDefined();
    // Started before the real verification finished: concurrent, not sequential.
    expect((dummySpan as { start: number }).start).toBeLessThan(
      (verifySpan as { end: number }).end,
    );
  });
});

describe('a rotation may not commit after the account is disabled', () => {
  it('loses to a disable that commits while it is hashing', async () => {
    // The compare-and-set predicate was the hash alone. A disable committing
    // inside the hashing window revoked the actor's sessions and ended their
    // access — and the rotation then stored a credential the disabled operator
    // chose, sitting ready for whenever the account is re-enabled.
    const subject = await createAdmin(ctx.container, tenantA, {
      username: 'rotator',
      password: 'the-original-password',
      roleKeys: ['support'],
    });
    const before = await storedHashOf('rotator');

    const hasher = ctx.container.hasher as unknown as Record<string, unknown>;
    const realHash = ctx.container.hasher.hash.bind(ctx.container.hasher);
    let releaseRotation: () => void = () => undefined;
    const rotationIsHashing = new Promise<void>((resolve) => {
      hasher['hash'] = async (plaintext: string) => {
        hasher['hash'] = realHash;
        resolve();
        await new Promise<void>((release) => {
          releaseRotation = release;
        });
        return realHash(plaintext);
      };
    });

    const rotation = ctx.container.adminManagement
      .changeOwnPassword(tenantA, adminActorFor(subject), {
        currentPassword: 'the-original-password',
        newPassword: 'a-password-the-attacker-picked',
      })
      .catch((error: unknown) => error);

    await rotationIsHashing;

    await ctx.container.adminManagement.setStatus(
      tenantA,
      adminActorFor(owner),
      subject.id as AdminId,
      { status: 'DISABLED', reason: 'Access revoked mid-rotation.' },
    );

    releaseRotation();
    const caught = await rotation;

    expect((caught as { code?: string }).code).toBe('admin.password_stale');
    // Decisively: the stored credential is untouched, so re-enabling the
    // account restores the password its owner last had, not the one chosen
    // after their access ended.
    expect(await storedHashOf('rotator')).toBe(before);
  });
});

describe('a login may not outlive the account access that authorised it', () => {
  it('creates no session when a disable commits during the login', async () => {
    // The status was read outside any transaction, and the row lock the session
    // takes carried only the hash. A disable committing in that gap revokes
    // every session that EXISTS at that moment; one inserted afterwards was not
    // one of them. It could never be used — `authenticate` refuses a
    // non-ACTIVE administrator on every request — but the row should not exist
    // at all, for the same reason a rotation's does not.
    const subject = await createAdmin(ctx.container, tenantA, {
      username: 'disabled-mid-login',
      password: 'the-original-password',
      roleKeys: ['support'],
    });

    const hasher = ctx.container.hasher as unknown as Record<string, unknown>;
    const realVerify = ctx.container.hasher.verify.bind(ctx.container.hasher);
    let releaseLogin: () => void = () => undefined;
    const loginHasVerified = new Promise<void>((resolve) => {
      hasher['verify'] = async (plaintext: string, encoded: string) => {
        hasher['verify'] = realVerify;
        const result = await realVerify(plaintext, encoded);
        resolve();
        await new Promise<void>((release) => {
          releaseLogin = release;
        });
        return result;
      };
    });

    const login = ctx.container.auth
      .login(
        tenantA,
        anonymous,
        { username: 'disabled-mid-login', password: 'the-original-password' },
        from,
      )
      .catch((error: unknown) => error);

    await loginHasVerified;

    await ctx.container.adminManagement.setStatus(
      tenantA,
      adminActorFor(owner),
      subject.id as AdminId,
      { status: 'DISABLED', reason: 'Access revoked mid-login.' },
    );

    releaseLogin();
    const caught = await login;

    expect((caught as { code?: string }).code).toBe('auth.invalid_credentials');

    const live = await ctx.container.database.db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.adminId, subject.id as AdminId));
    expect(live.filter((row) => row.revokedAt === null)).toHaveLength(0);
  });
});

describe('the attempt limit is the number of attempts allowed', () => {
  it('verifies exactly the configured number before refusing', async () => {
    // Refusing on the attempt that REACHES the limit gives N-1 credential
    // checks, not N. Off by one in the safe direction is still wrong, and the
    // same error at a limit of 1 locks the installation out entirely.
    const limit = ctx.container.config.LOGIN_MAX_ATTEMPTS_PER_USERNAME;
    const kinds: string[] = [];
    for (let attempt = 0; attempt < limit + 1; attempt += 1) {
      kinds.push(
        await ctx.container.auth
          .login(
            tenantA,
            anonymous,
            { username: 'owner', password: `wrong-${attempt}` },
            { ip: null, userAgent: 'vitest' },
          )
          .then(
            () => 'ALLOWED',
            (error: { kind?: string }) => error.kind ?? 'UNKNOWN',
          ),
      );
    }

    expect(kinds.slice(0, limit)).toEqual(Array.from({ length: limit }, () => 'UNAUTHENTICATED'));
    expect(kinds[limit]).toBe('RATE_LIMITED');
  });

  it('records the lockout even though the limit attempt is still verified', async () => {
    const limit = ctx.container.config.LOGIN_MAX_ATTEMPTS_PER_USERNAME;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      await expect(
        ctx.container.auth.login(
          tenantA,
          anonymous,
          { username: 'owner', password: 'wrong' },
          { ip: null, userAgent: 'vitest' },
        ),
      ).rejects.toThrow();
    }
    const events = await ctx.container.database.db.execute(
      `SELECT code FROM operational_events WHERE code = 'auth.login_locked_out'` as never,
    );
    expect(JSON.stringify(events)).toContain('auth.login_locked_out');
  });
});

describe('a single-attempt limit still admits a correct password', () => {
  let strict: TestContext;

  beforeAll(async () => {
    strict = await createTestContext({ LOGIN_MAX_ATTEMPTS_PER_USERNAME: '1' });
  });

  afterAll(async () => {
    await strict?.close();
  });

  it('permits the first login and refuses the one after a failure', async () => {
    // The tightest legal configuration. Refusing on the attempt that reaches
    // the limit meant the very first login — correct password and all — was
    // rate limited, and the installation had no way in.
    await strict.reset();
    await createAdmin(strict.container, tenantA, {
      username: 'strict-owner',
      password: 'the-owners-real-password',
      roleKeys: [OWNER_ROLE_KEY],
    });

    await expect(
      strict.container.auth.login(
        tenantA,
        anonymous,
        { username: 'strict-owner', password: 'the-owners-real-password' },
        { ip: null, userAgent: 'vitest' },
      ),
    ).resolves.toMatchObject({ admin: { username: 'strict-owner' } });

    // One failure is allowed, and the next attempt is refused before the KDF.
    await expect(
      strict.container.auth.login(
        tenantA,
        anonymous,
        { username: 'strict-owner', password: 'wrong' },
        { ip: null, userAgent: 'vitest' },
      ),
    ).rejects.toMatchObject({ kind: 'UNAUTHENTICATED' });
    await expect(
      strict.container.auth.login(
        tenantA,
        anonymous,
        { username: 'strict-owner', password: 'wrong-again' },
        { ip: null, userAgent: 'vitest' },
      ),
    ).rejects.toMatchObject({ kind: 'RATE_LIMITED' });
  });
});

describe('bootstrap creates the first owner once, under concurrency', () => {
  it('refuses a second bootstrap that started before the first committed', async () => {
    // The existence check read outside the transaction that creates the owner,
    // so two installer runs — or a retried one — both saw an empty roster and
    // both created an owner. Two owners, one of which nobody asked for.
    //
    // `tenantB` is seeded with no administrators, which is what makes it
    // eligible for bootstrap at all.
    const hasher = ctx.container.hasher as unknown as Record<string, unknown>;
    const realHash = ctx.container.hasher.hash.bind(ctx.container.hasher);
    let releaseFirst: () => void = () => undefined;
    const firstIsHashing = new Promise<void>((resolve) => {
      hasher['hash'] = async (plaintext: string) => {
        hasher['hash'] = realHash;
        resolve();
        await new Promise<void>((release) => {
          releaseFirst = release;
        });
        return realHash(plaintext);
      };
    });

    const first = ctx.container.bootstrapOwner
      .execute(tenantB, {
        username: 'first-owner',
        displayName: 'First',
        password: 'a-perfectly-fine-password',
      })
      .catch((error: unknown) => error);

    // Held before it opens its transaction, so the second run's own cheap
    // pre-check sees exactly what a concurrent installer would: nothing.
    await firstIsHashing;

    const second = await ctx.container.bootstrapOwner.execute(tenantB, {
      username: 'second-owner',
      displayName: 'Second',
      password: 'a-perfectly-fine-password',
    });
    expect(second.username).toBe('second-owner');

    releaseFirst();
    const caught = await first;
    expect((caught as { code?: string }).code).toBe('bootstrap.already_completed');

    const admins = await ctx.container.admins.list(tenantB);
    expect(admins.map((admin) => admin.username)).toEqual(['second-owner']);
  });
});

describe('a success does not leave the IP it arrived from locked', () => {
  it('lifts a lockout that the successful attempt itself established', async () => {
    // The attempt that REACHES the limit is verified, and may succeed — but the
    // reservation had already written `lockedUntil`, and giving the attempt back
    // only decremented the count. Every administrator behind that address was
    // then refused for the full lockout on the strength of a login that worked.
    const limit = ctx.container.config.LOGIN_MAX_ATTEMPTS_PER_IP;
    const ip = '198.51.100.44';
    const subject = await createAdmin(ctx.container, tenantA, {
      username: 'ip-sharer',
      password: 'the-correct-password',
      roleKeys: ['support'],
    });
    expect(subject.username).toBe('ip-sharer');

    // Spend every attempt but the last against a username that does not exist,
    // so the IP counter — not the username counter — is what fills up.
    for (let attempt = 0; attempt < limit - 1; attempt += 1) {
      await expect(
        ctx.container.auth.login(
          tenantA,
          anonymous,
          { username: `nobody-${attempt}`, password: 'guess' },
          { ip, userAgent: 'vitest' },
        ),
      ).rejects.toThrow();
    }

    // The attempt that reaches the limit, and it is a correct one.
    await expect(
      ctx.container.auth.login(
        tenantA,
        anonymous,
        { username: 'ip-sharer', password: 'the-correct-password' },
        { ip, userAgent: 'vitest' },
      ),
    ).resolves.toMatchObject({ admin: { username: 'ip-sharer' } });

    const [row] = await ctx.container.database.db
      .select()
      .from(adminLoginThrottle)
      .where(eq(adminLoginThrottle.subject, ip));
    // The count is given back, so the address is below the limit again...
    expect(row?.failedCount).toBe(limit - 1);
    // ...and the lock that count established is gone with it.
    expect(row?.lockedUntil).toBeNull();

    // Decisively: the next login from that address is not refused.
    await expect(
      ctx.container.auth.login(
        tenantA,
        anonymous,
        { username: 'ip-sharer', password: 'the-correct-password' },
        { ip, userAgent: 'vitest' },
      ),
    ).resolves.toBeDefined();
  });

  it('leaves a lock standing when failures still hold it', async () => {
    // Not blanket forgiveness. Giving back one reservation only lifts the lock
    // if the count actually falls below the limit.
    const strictIp = await createTestContext({ LOGIN_MAX_ATTEMPTS_PER_IP: '1' });
    try {
      await strictIp.reset();
      await createAdmin(strictIp.container, tenantA, {
        username: 'solo',
        password: 'the-correct-password',
        roleKeys: ['support'],
      });
      const ip = '198.51.100.45';

      // The first attempt reaches the limit of one and succeeds.
      await expect(
        strictIp.container.auth.login(
          tenantA,
          anonymous,
          { username: 'solo', password: 'the-correct-password' },
          { ip, userAgent: 'vitest' },
        ),
      ).resolves.toBeDefined();

      // Which must not poison the address for everyone behind it.
      await expect(
        strictIp.container.auth.login(
          tenantA,
          anonymous,
          { username: 'solo', password: 'the-correct-password' },
          { ip, userAgent: 'vitest' },
        ),
      ).resolves.toBeDefined();

      // A genuine failure at that limit still locks it.
      await expect(
        strictIp.container.auth.login(
          tenantA,
          anonymous,
          { username: 'solo', password: 'wrong' },
          { ip, userAgent: 'vitest' },
        ),
      ).rejects.toMatchObject({ kind: 'UNAUTHENTICATED' });
      await expect(
        strictIp.container.auth.login(
          tenantA,
          anonymous,
          { username: 'solo', password: 'the-correct-password' },
          { ip, userAgent: 'vitest' },
        ),
      ).rejects.toMatchObject({ kind: 'RATE_LIMITED' });
    } finally {
      await strictIp.close();
    }
  });
});

describe('an unauthorized mutation attempt is audited', () => {
  async function deniedAuditRows(action: string): Promise<unknown[]> {
    return ctx.container.database.db.select().from(auditLogs).where(eq(auditLogs.action, action));
  }

  it('records a DENIED row when the pre-lock check refuses', async () => {
    // The pre-lock check is only a fast rejection, but it is the one an
    // ordinary unauthorized request hits. It threw straight out of the service:
    // the guard wrote its operational event and nothing wrote the audit row, so
    // whether an attempted mutation was auditable depended on WHEN the denial
    // fired.
    const nobody = await createAdmin(ctx.container, tenantA, {
      username: 'nobody',
      roleKeys: ['support'],
    });
    const target = await createAdmin(ctx.container, tenantA, {
      username: 'victim',
      roleKeys: ['support'],
    });

    await expect(
      ctx.container.adminManagement.create(tenantA, adminActorFor(nobody), {
        username: 'planted',
        displayName: 'Planted',
        password: 'a-perfectly-fine-password',
        roleKeys: ['support'],
      }),
    ).rejects.toThrow(/permission/i);

    await expect(
      ctx.container.adminManagement.setStatus(
        tenantA,
        adminActorFor(nobody),
        target.id as AdminId,
        { status: 'DISABLED', reason: 'Not mine to make.' },
      ),
    ).rejects.toThrow(/permission/i);

    await expect(
      ctx.container.adminManagement.setRoles(tenantA, adminActorFor(nobody), target.id as AdminId, {
        roleKeys: [OWNER_ROLE_KEY],
      }),
    ).rejects.toThrow(/permission/i);

    for (const action of ['admin.create', 'admin.status_change', 'admin.roles_change']) {
      const rows = (await deniedAuditRows(action)) as { result: string; actorId: string | null }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.result).toBe('DENIED');
      expect(rows[0]?.actorId).toBe(nobody.id);
    }
  });
});

describe('the session cookie a production deployment issues', () => {
  let api: ApiApp;
  const ORIGIN = 'https://admin.example.test';

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    // A real production configuration, which means the real cost profile — the
    // config schema refuses the fast one here, and rightly. One login pays for
    // it, which is the price of testing the thing that actually ships.
    const config = testConfig({
      NODE_ENV: 'production',
      PASSWORD_HASH_PROFILE: 'production',
      WEB_ADMIN_ORIGINS: ORIGIN,
      // The only production topology: `direct` is refused there, because this
      // process serves plain HTTP and the Secure `__Host-` cookie below would
      // be discarded by every browser.
      DEPLOYMENT_TOPOLOGY: 'reverse-proxy',
      TRUSTED_PROXY_IPS: '127.0.0.1,::1',
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
    api.container.setInstallationTenant(tenantA.tenantId);
  }, 60_000);

  afterAll(async () => {
    await api?.close();
  });

  // The file-level hook truncates between tests, and this describe's owner
  // lives in the same database, so it is re-seeded here rather than once.
  beforeEach(async () => {
    const config = api.container.config;
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, config.SECRETS_KEK, config.SECRETS_KEK_ID);
    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owners-real-password',
      roleKeys: [OWNER_ROLE_KEY],
    });
  }, 30_000);

  it('issues it under the __Host- prefix, with the attributes that prefix demands', async () => {
    // A sibling host under a shared parent domain could otherwise set a cookie
    // of the same name for the parent with a longer Path, which browsers send
    // first — enough to keep a victim logged out, and enough to toss an
    // attacker's own session into their browser.
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner', password: 'the-owners-real-password' },
    });
    expect(response.statusCode).toBe(201);

    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME_SECURE}=`);
    // The three conditions a browser enforces for the prefix. Miss any one and
    // it silently refuses to store the cookie at all.
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Domain=');
    // And the properties that were already right.
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    // Still no credential in the body.
    expect(JSON.stringify(response.json())).not.toContain(
      setCookie.split('=')[1]?.split(';')[0] ?? 'unreachable',
    );
  }, 30_000);

  it('clears both spellings on logout, not just the one it issues', async () => {
    // Two `set-cookie` headers on one reply. If the framework overwrote rather
    // than appended, logout would clear one name and leave the other being
    // presented on every subsequent request — and a deployment that has just
    // moved to production still has the unprefixed cookie in browsers.
    const login = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner', password: 'the-owners-real-password' },
    });
    const token = String(login.headers['set-cookie']).split('=')[1]?.split(';')[0] ?? '';

    const logout = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.logout}`,
      headers: {
        origin: ORIGIN,
        cookie: `${SESSION_COOKIE_NAME_SECURE}=${token}`,
      },
    });
    expect(logout.statusCode).toBe(201);

    const cleared = ([] as string[]).concat(logout.headers['set-cookie'] as never).join('\n');
    expect(cleared).toContain(`${SESSION_COOKIE_NAME_SECURE}=;`);
    expect(cleared).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(cleared).toContain('Max-Age=0');
  }, 30_000);

  it('accepts the prefixed cookie it issued', async () => {
    const login = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner', password: 'the-owners-real-password' },
    });
    const token = String(login.headers['set-cookie']).split('=')[1]?.split(';')[0] ?? '';
    expect(token).not.toBe('');

    // Presented alongside a shadowing plain cookie sent first, exactly as a
    // browser would order an attacker's longer-path one.
    const session = await inject({
      method: 'GET',
      url: `${API_PREFIX}${AUTH_ROUTES.session}`,
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=tossed; ${SESSION_COOKIE_NAME_SECURE}=${token}`,
      },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ admin: { username: 'owner' } });
  }, 30_000);
});

describe('a lockout that has expired ends the counting period with it', () => {
  it('does not renew itself forever when the lockout is shorter than the window', async () => {
    // With a 24-hour window and a 30-second lockout, the first attempt after
    // those 30 seconds still incremented the over-limit count, wrote a fresh
    // lock, and was refused before the password was checked. Every retry
    // renewed it, so the configured 30 seconds was really 24 hours.
    const brief = await createTestContext({
      LOGIN_THROTTLE_WINDOW_SECONDS: '86400',
      LOGIN_LOCKOUT_SECONDS: '60',
      LOGIN_MAX_ATTEMPTS_PER_USERNAME: '3',
    });
    try {
      await brief.reset();
      await createAdmin(brief.container, tenantA, {
        username: 'locked-out',
        password: 'the-correct-password',
        roleKeys: ['support'],
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(
          brief.container.auth.login(
            tenantA,
            anonymous,
            { username: 'locked-out', password: 'wrong' },
            { ip: null, userAgent: 'vitest' },
          ),
        ).rejects.toThrow();
      }
      // Locked, and the correct password is refused — which is the point of a
      // lockout.
      await expect(
        brief.container.auth.login(
          tenantA,
          anonymous,
          { username: 'locked-out', password: 'the-correct-password' },
          { ip: null, userAgent: 'vitest' },
        ),
      ).rejects.toMatchObject({ kind: 'RATE_LIMITED' });

      // Serve the sentence. The window has 24 hours left on it, so this is
      // exactly the case that used to renew instead of releasing.
      await brief.container.database.db
        .update(adminLoginThrottle)
        .set({ lockedUntil: new Date(Date.now() - 1000) })
        .where(eq(adminLoginThrottle.subject, 'locked-out'));

      await expect(
        brief.container.auth.login(
          tenantA,
          anonymous,
          { username: 'locked-out', password: 'the-correct-password' },
          { ip: null, userAgent: 'vitest' },
        ),
      ).resolves.toMatchObject({ admin: { username: 'locked-out' } });
    } finally {
      await brief.close();
    }
  });

  it('still refuses while the lockout is unexpired', async () => {
    // The converse, so the fix is not "clear the lock whenever asked".
    const limit = ctx.container.config.LOGIN_MAX_ATTEMPTS_PER_USERNAME;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      await expect(
        ctx.container.auth.login(
          tenantA,
          anonymous,
          { username: 'owner', password: 'wrong' },
          { ip: null, userAgent: 'vitest' },
        ),
      ).rejects.toThrow();
    }
    await expect(
      ctx.container.auth.login(
        tenantA,
        anonymous,
        { username: 'owner', password: owner.password },
        { ip: null, userAgent: 'vitest' },
      ),
    ).rejects.toMatchObject({ kind: 'RATE_LIMITED' });
  });
});

describe('a stopped tenant is closed for business', () => {
  async function stopTenant(): Promise<void> {
    await ctx.container.database.db
      .update(tenants)
      .set({ status: 'STOPPED' })
      .where(eq(tenants.id, tenantA.tenantId));
  }

  it('refuses a login with the correct password', async () => {
    // TENANT_INACTIVE was declared in the contracts and emitted by nothing, so
    // stopping an installation changed precisely nothing about who could sign
    // into it.
    await stopTenant();
    await expect(
      ctx.container.auth.login(
        tenantA,
        anonymous,
        { username: 'owner', password: owner.password },
        from,
      ),
    ).rejects.toMatchObject({ code: 'auth.invalid_credentials' });
  });

  it('refuses a session that was already open', async () => {
    // Otherwise stopping an installation leaves every session already issued
    // able to mutate it until expiry.
    const issued = await ctx.container.auth.login(
      tenantA,
      anonymous,
      { username: 'owner', password: owner.password },
      from,
    );
    expect(issued.admin.username).toBe('owner');

    await stopTenant();
    await expect(ctx.container.auth.authenticate(issued.token)).rejects.toMatchObject({
      kind: 'UNAUTHENTICATED',
    });
  });

  it('records the reason in the audit log without disclosing it', async () => {
    await stopTenant();
    await expect(
      ctx.container.auth.login(
        tenantA,
        anonymous,
        { username: 'owner', password: owner.password },
        from,
      ),
    ).rejects.toThrow();

    const rows = (await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.login'))) as { after: Record<string, unknown> | null }[];
    expect(JSON.stringify(rows)).toContain('TENANT_INACTIVE');
  });

  it('lets an active tenant through, so the check is not a blanket refusal', async () => {
    await expect(
      ctx.container.auth.login(
        tenantA,
        anonymous,
        { username: 'owner', password: owner.password },
        from,
      ),
    ).resolves.toBeDefined();
  });
});

describe('the last login timestamp never moves backwards', () => {
  it('keeps the newer value when an older write lands second', async () => {
    // `now` is captured before the KDF, so two overlapping logins can reach the
    // write in the opposite order to the one they started in.
    const subject = await createAdmin(ctx.container, tenantA, {
      username: 'twice',
      password: 'the-correct-password',
      roleKeys: ['support'],
    });

    const newer = new Date('2030-01-02T00:00:00.000Z');
    const older = new Date('2030-01-01T00:00:00.000Z');
    await ctx.container.admins.recordLogin(tenantA, subject.id as AdminId, newer);
    await ctx.container.admins.recordLogin(tenantA, subject.id as AdminId, older);

    const stored = await ctx.container.admins.findById(tenantA, subject.id as AdminId);
    expect(stored?.lastLoginAt?.toISOString()).toBe(newer.toISOString());
  });

  it('still records the first login, when there is nothing to compare against', async () => {
    const subject = await createAdmin(ctx.container, tenantA, {
      username: 'first-timer',
      roleKeys: ['support'],
    });
    const at = new Date('2030-03-03T00:00:00.000Z');
    await ctx.container.admins.recordLogin(tenantA, subject.id as AdminId, at);
    const stored = await ctx.container.admins.findById(tenantA, subject.id as AdminId);
    expect(stored?.lastLoginAt?.toISOString()).toBe(at.toISOString());
  });
});

// The describe that stood here asserted that a boot restores a catalogue
// permission missing from an existing seeded role. That behaviour was
// deliberately reversed — a restart reasserting the seed also silently restored
// permissions an operator had withdrawn, and between "an upgrade does not extend
// a role automatically" and "a restart hands back authority somebody removed",
// the first is the failure to keep: it is visible, because the amplification
// rule refuses to grant what nobody holds, and it is fixed by a migration that
// says what it is doing.
//
// It is removed rather than rewritten because its replacement would duplicate
// coverage that already exists: 'still creates a seeded role that is missing
// entirely' pins the creation path, and 'holds the same tenant lock those
// mutations take' pins that boot reaches the sync at all — which was the
// reachability the original finding was about. Simulating a missing role inside
// an installation that has one is not possible anyway: `nexa_protect_system_role`
// refuses to delete it, correctly.

describe('two processes may seed the system roles at once', () => {
  it('does not fail when several callers race the same insert', async () => {
    // `ensureSystemRoles` used to SELECT, then INSERT ... ON CONFLICT DO
    // NOTHING with an id it had generated, then grant permissions against that
    // id. Whichever caller loses the unique index gets a no-op from the insert,
    // so the id it generated was never stored — and `role_permissions` has a
    // composite foreign key to `roles`, which rejects a grant naming a role
    // that does not exist. Two API processes booting together would take one of
    // them down, and this now runs at boot.
    //
    // There is no seam inside the statement to interleave at, so this races for
    // real. Each trial gets a fresh tenant: system roles cannot be deleted
    // (`nexa_protect_system_role` sees to that, correctly), so a trial cannot
    // reuse one.
    const template = (
      await ctx.container.database.db.select().from(tenants).where(eq(tenants.id, tenantB.tenantId))
    )[0];
    expect(template).toBeDefined();

    for (let trial = 0; trial < 4; trial += 1) {
      const id = ctx.container.ids.uuid();
      await ctx.container.database.db.insert(tenants).values({
        ...(template as NonNullable<typeof template>),
        id,
        slug: `race-${trial}-${id.slice(0, 8)}`,
      });
      const scope = { tenantId: id as never, botInstanceId: null };

      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, () => ctx.container.roles.ensureSystemRoles(scope)),
      );
      expect(
        outcomes
          .filter((o) => o.status === 'rejected')
          .map((o) => String((o as PromiseRejectedResult).reason)),
      ).toEqual([]);

      // One row per seeded role, and every grant resolves to one of them.
      const seeded = await ctx.container.database.db
        .select()
        .from(roles)
        .where(eq(roles.tenantId, id));
      expect(seeded.length).toBeGreaterThan(0);
      expect(new Set(seeded.map((role) => role.key)).size).toBe(seeded.length);

      const roleIds = new Set(seeded.map((role) => role.id));
      const grants = await ctx.container.database.db
        .select()
        .from(rolePermissions)
        .where(eq(rolePermissions.tenantId, id));
      expect(grants.length).toBeGreaterThan(0);
      expect(grants.every((grant) => roleIds.has(grant.roleId))).toBe(true);
    }
  }, 60_000);

  it('is a no-op when everything is already seeded', async () => {
    const before = await ctx.container.database.db.select().from(rolePermissions);
    await ctx.container.roles.ensureSystemRoles(tenantA);
    const after = await ctx.container.database.db.select().from(rolePermissions);
    expect(after).toHaveLength(before.length);
  });
});

describe('a refused attempt does not spend anything', () => {
  it('returns both reservations when it is rejected over the limit', async () => {
    // A request refused past the limit never reaches the KDF and never checks a
    // credential, so counting it overstates what happened — and the
    // overstatement sticks. An allowed request that reserved the limiting count
    // and then succeeded returns only its own reservation, so the leaked one
    // holds the subject at the limit and keeps the lock alive.
    //
    // `assertNotThrottled` refuses without reserving, so it hides this
    // interleaving on its own: both requests have to pass that read before
    // either writes. A barrier inside the IP reservation forces exactly that.
    const strict = await createTestContext({
      LOGIN_MAX_ATTEMPTS_PER_IP: '1',
      LOGIN_MAX_ATTEMPTS_PER_USERNAME: '100',
    });
    try {
      await strict.reset();
      await createAdmin(strict.container, tenantA, {
        username: 'pair',
        password: 'the-correct-password',
        roleKeys: ['support'],
      });
      const ip = '198.51.100.77';

      const throttle = strict.container.auth['throttle'] as unknown as Record<string, unknown>;
      const realReserve = (
        throttle['reserveAttempt'] as (...args: unknown[]) => Promise<unknown>
      ).bind(throttle);

      let arrived = 0;
      let openGate: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      throttle['reserveAttempt'] = async (...args: unknown[]) => {
        if (args[1] === 'IP') {
          arrived += 1;
          if (arrived >= 2) openGate();
          await gate;
        }
        return realReserve(...args);
      };

      // Two simultaneous CORRECT logins. One reserves the limiting count and
      // succeeds; the other reserves past it and is refused without verifying.
      const outcomes = await Promise.all(
        Array.from({ length: 2 }, () =>
          strict.container.auth
            .login(
              tenantA,
              anonymous,
              { username: 'pair', password: 'the-correct-password' },
              { ip, userAgent: 'vitest' },
            )
            .then(
              () => 'ALLOWED',
              (error: { kind?: string }) => error.kind ?? 'UNKNOWN',
            ),
        ),
      );
      throttle['reserveAttempt'] = realReserve;

      expect(outcomes).toContain('ALLOWED');
      expect(outcomes).toContain('RATE_LIMITED');

      // The address they share must not be left locked by a login that worked
      // plus one that was never checked.
      const [row] = await strict.container.database.db
        .select()
        .from(adminLoginThrottle)
        .where(eq(adminLoginThrottle.subject, ip));
      expect(row?.lockedUntil ?? null).toBeNull();

      await expect(
        strict.container.auth.login(
          tenantA,
          anonymous,
          { username: 'pair', password: 'the-correct-password' },
          { ip, userAgent: 'vitest' },
        ),
      ).resolves.toBeDefined();
    } finally {
      await strict.close();
    }
  }, 30_000);

  it('still counts an attempt that was actually verified', async () => {
    // The release is for abandoned attempts only. A wrong password that reached
    // the KDF is exactly the thing the counter exists to count.
    await expect(
      ctx.container.auth.login(
        tenantA,
        anonymous,
        { username: 'owner', password: 'wrong' },
        { ip: '198.51.100.78', userAgent: 'vitest' },
      ),
    ).rejects.toThrow();

    const [row] = await ctx.container.database.db
      .select()
      .from(adminLoginThrottle)
      .where(eq(adminLoginThrottle.subject, '198.51.100.78'));
    expect(row?.failedCount).toBe(1);
  });
});

describe('the session last-seen timestamp never moves backwards', () => {
  it('keeps the newer value when an older touch lands second', async () => {
    const issued = await ctx.container.auth.login(
      tenantA,
      anonymous,
      { username: 'owner', password: owner.password },
      from,
    );

    const newer = new Date('2030-05-02T00:00:00.000Z');
    const older = new Date('2030-05-01T00:00:00.000Z');
    await ctx.container.sessions.touch(issued.session.id, newer);
    await ctx.container.sessions.touch(issued.session.id, older);

    const [row] = await ctx.container.database.db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.id, issued.session.id));
    expect(row?.lastSeenAt?.toISOString()).toBe(newer.toISOString());
  });
});

describe('re-enabling an administrator cannot restore authority the actor lacks', () => {
  async function managerWithEditOnly(): Promise<SeededAdmin> {
    const manager = await createAdmin(ctx.container, tenantA, {
      username: 'roster-manager',
      roleKeys: ['support'],
    });
    await ctx.container.database.db.insert(adminPermissionOverrides).values({
      tenantId: tenantA.tenantId,
      adminId: manager.id,
      permissionKey: 'admins.edit',
      effect: 'GRANT',
      reason: 'Administers the roster.',
      expiresAt: null,
    });
    return manager;
  }

  it('refuses to re-enable a disabled admin holding permissions the actor does not', async () => {
    // Gating only the owner key was too narrow. The resolver gives a disabled
    // administrator nothing, so flipping them to ACTIVE is where the authority
    // comes back — an actor who could neither create that account nor grant it
    // those roles should not be able to switch it back on.
    const manager = await managerWithEditOnly();
    const dormant = await createAdmin(ctx.container, tenantA, {
      username: 'dormant-finance',
      roleKeys: ['finance'],
      status: 'DISABLED',
    });

    await expect(
      ctx.container.adminManagement.setStatus(
        tenantA,
        adminActorFor(manager),
        dormant.id as AdminId,
        { status: 'ACTIVE', reason: 'Bringing back the finance account.' },
      ),
    ).rejects.toThrow(/permission|hold/i);

    expect((await ctx.container.admins.findById(tenantA, dormant.id as AdminId))?.status).toBe(
      'DISABLED',
    );
  });

  it('permits an owner to re-enable the same account', async () => {
    // Not blanket pessimism: an owner holds the whole catalogue, so the rule
    // never constrains them.
    const dormant = await createAdmin(ctx.container, tenantA, {
      username: 'dormant-finance-2',
      roleKeys: ['finance'],
      status: 'DISABLED',
    });
    await expect(
      ctx.container.adminManagement.setStatus(
        tenantA,
        adminActorFor(owner),
        dormant.id as AdminId,
        { status: 'ACTIVE', reason: 'Owner may.' },
      ),
    ).resolves.toBeDefined();
  });

  it('permits re-enabling an account whose permissions the actor does hold', async () => {
    const manager = await managerWithEditOnly();
    const dormant = await createAdmin(ctx.container, tenantA, {
      username: 'dormant-peer',
      roleKeys: ['support'],
      status: 'DISABLED',
    });
    await expect(
      ctx.container.adminManagement.setStatus(
        tenantA,
        adminActorFor(manager),
        dormant.id as AdminId,
        { status: 'ACTIVE', reason: 'Same authority as mine.' },
      ),
    ).resolves.toBeDefined();
  });

  it('still permits disabling, which takes authority away rather than giving it', async () => {
    const manager = await managerWithEditOnly();
    const active = await createAdmin(ctx.container, tenantA, {
      username: 'active-peer',
      roleKeys: ['support'],
    });
    await expect(
      ctx.container.adminManagement.setStatus(
        tenantA,
        adminActorFor(manager),
        active.id as AdminId,
        { status: 'DISABLED', reason: 'Ordinary administration.' },
      ),
    ).resolves.toBeDefined();
  });
});

describe('a throttle release belongs to the period it reserved in', () => {
  it('does nothing once a later attempt has started a new counting period', async () => {
    // A login can sit in the KDF longer than the whole window — 30 seconds is
    // the configured minimum, and a saturated crypto pool can exceed it. By the
    // time it releases, a later attempt may have reset the row into a new
    // period; an unconditional decrement would take away THAT attempt instead,
    // and could clear the lock it had just established.
    const ip = '198.51.100.99';
    const reserved = await ctx.container.auth['throttle'].reserveAttempt(
      tenantA,
      'IP',
      ip,
      ctx.container.clock.now(),
      { windowSeconds: 900, maxAttempts: 1, lockoutSeconds: 900 },
    );
    expect(reserved.failedCount).toBe(1);

    // A later attempt in a new period: the row is rewritten with a fresh
    // window, exactly as an expired window or a served lockout would do.
    const laterWindow = new Date(Date.now() + 60_000);
    await ctx.container.database.db
      .update(adminLoginThrottle)
      .set({ windowStartedAt: laterWindow, failedCount: 1, lockedUntil: laterWindow })
      .where(eq(adminLoginThrottle.subject, ip));

    // The old login finally releases. It must not touch the new period.
    await ctx.container.auth['throttle'].releaseAttempt(
      tenantA,
      'IP',
      ip,
      1,
      reserved.windowStartedAt,
    );

    const [row] = await ctx.container.database.db
      .select()
      .from(adminLoginThrottle)
      .where(eq(adminLoginThrottle.subject, ip));
    expect(row?.failedCount).toBe(1);
    expect(row?.lockedUntil).not.toBeNull();
  });

  it('still releases within its own period', async () => {
    // The narrowing must not stop the ordinary case working.
    const ip = '198.51.100.100';
    const reserved = await ctx.container.auth['throttle'].reserveAttempt(
      tenantA,
      'IP',
      ip,
      ctx.container.clock.now(),
      { windowSeconds: 900, maxAttempts: 1, lockoutSeconds: 900 },
    );
    expect(reserved.lockedUntil).not.toBeNull();

    await ctx.container.auth['throttle'].releaseAttempt(
      tenantA,
      'IP',
      ip,
      1,
      reserved.windowStartedAt,
    );

    const [row] = await ctx.container.database.db
      .select()
      .from(adminLoginThrottle)
      .where(eq(adminLoginThrottle.subject, ip));
    expect(row?.failedCount).toBe(0);
    expect(row?.lockedUntil).toBeNull();
  });
});

describe('permissionsIfActive answers only for this tenant', () => {
  it('reports nothing for an administrator of another tenant', async () => {
    // It differs from `resolve` by the status check and by nothing else. Its
    // only caller today holds a tenant scope and a target it has already
    // loaded, so a missing gate would not be exploitable now — it would be a
    // way in later, in a method whose name invites reuse.
    const elsewhere = await createAdmin(ctx.container, tenantB, {
      username: 'other-tenant-owner',
      roleKeys: [OWNER_ROLE_KEY],
    });

    // Asked under tenant B, they hold the catalogue.
    expect(
      (await ctx.container.guard.permissionsIfActive(tenantB, elsewhere.id as AdminId)).size,
    ).toBeGreaterThan(0);

    // Asked under tenant A, they hold nothing.
    expect(
      (await ctx.container.guard.permissionsIfActive(tenantA, elsewhere.id as AdminId)).size,
    ).toBe(0);
  });

  it('reports nothing under a real system scope', async () => {
    // A genuine `SystemContext`, not a tenant context with a null id — the
    // difference matters, and an earlier version of this test used the latter
    // and therefore proved nothing.
    expect(
      (
        await ctx.container.guard.permissionsIfActive(
          systemContext('test:cross-tenant-check'),
          owner.id as AdminId,
        )
      ).size,
    ).toBe(0);
  });

  it('reports the authority a disabled administrator would regain', async () => {
    // The one difference from `resolve`, and the reason the method exists.
    const dormant = await createAdmin(ctx.container, tenantA, {
      username: 'dormant-support',
      roleKeys: ['support'],
      status: 'DISABLED',
    });
    const restored = await ctx.container.guard.permissionsIfActive(tenantA, dormant.id as AdminId);
    expect(restored.size).toBeGreaterThan(0);

    // Where `resolve` — via the guard's actor-facing view — gives them nothing.
    expect((await ctx.container.guard.permissionsOf(tenantA, adminActorFor(dormant))).size).toBe(0);
  });
});

describe('the first owner gets the same validation as everyone else', () => {
  it('refuses an empty display name', async () => {
    // There is no profile-edit route, so whatever the installer types is what
    // the first owner is called permanently. Bootstrap validated the username
    // and the password and passed the display name straight through, so
    // pressing Enter at the prompt persisted an empty one.
    for (const displayName of ['', '   ', 'x'.repeat(121)]) {
      await expect(
        ctx.container.bootstrapOwner.execute(tenantB, {
          username: 'installer',
          displayName,
          password: 'a-perfectly-fine-password',
        }),
      ).rejects.toThrow();
    }

    // Nothing was created by the refused attempts.
    expect(await ctx.container.admins.list(tenantB)).toHaveLength(0);
  });

  it('accepts a valid display name and trims it', async () => {
    const created = await ctx.container.bootstrapOwner.execute(tenantB, {
      username: 'installer',
      displayName: '  The Operator  ',
      password: 'a-perfectly-fine-password',
    });
    const stored = await ctx.container.admins.findById(tenantB, created.adminId);
    expect(stored?.displayName).toBe('The Operator');
  });
});

describe('a duplicate Telegram identity is a conflict, not a server fault', () => {
  it('reports admin.telegram_id_taken rather than failing on the unique index', async () => {
    // Only the username was checked, so the unique index rejected the INSERT
    // and the driver error surfaced as a 500 — an ordinary input mistake
    // reported as a server fault, and a declared conflict code that nothing
    // could emit.
    const first = await createAdmin(ctx.container, tenantA, {
      username: 'linked-admin',
      roleKeys: ['support'],
      telegramUserId: '123456789',
    });
    expect(first.username).toBe('linked-admin');

    let caught: unknown;
    try {
      await ctx.container.adminManagement.create(tenantA, adminActorFor(owner), {
        username: 'second-linked',
        displayName: 'Second',
        password: 'a-perfectly-fine-password',
        roleKeys: ['support'],
        telegramUserId: '123456789',
      });
    } catch (error) {
      caught = error;
    }

    expect((caught as { kind?: string }).kind).toBe('CONFLICT');
    expect((caught as { code?: string }).code).toBe('admin.telegram_id_taken');

    // And nothing was written.
    expect(await ctx.container.admins.findByUsername(tenantA, 'second-linked')).toBeNull();
  });

  it('still permits a distinct Telegram identity', async () => {
    await createAdmin(ctx.container, tenantA, {
      username: 'linked-one',
      roleKeys: ['support'],
      telegramUserId: '111111111',
    });
    await expect(
      ctx.container.adminManagement.create(tenantA, adminActorFor(owner), {
        username: 'linked-two',
        displayName: 'Two',
        password: 'a-perfectly-fine-password',
        roleKeys: ['support'],
        telegramUserId: '222222222',
      }),
    ).resolves.toBeDefined();
  });
});

describe('the permissions a session reports are the ones that will be enforced', () => {
  it('includes a GRANT override and excludes a DENY one', async () => {
    // These are display permissions — they authorize nothing, and every
    // endpoint re-checks. But they were the raw union of role permissions,
    // which ignores overrides in both directions: a granted administrator saw
    // the button hidden, a denied one saw a button that then answered 403. A
    // surface computing a concept differently from the layer that enforces it
    // is the divergence this codebase exists to avoid.
    const subject = await createAdmin(ctx.container, tenantA, {
      username: 'overridden',
      password: 'the-correct-password',
      roleKeys: ['support'],
    });

    const roleUnion = await ctx.container.roles.permissionsForAdmin(tenantA, subject.id as AdminId);
    const denied = roleUnion[0];
    expect(denied).toBeDefined();

    await ctx.container.database.db.insert(adminPermissionOverrides).values([
      {
        tenantId: tenantA.tenantId,
        adminId: subject.id,
        permissionKey: 'admins.edit',
        effect: 'GRANT',
        reason: 'Temporarily administers the roster.',
        expiresAt: null,
      },
      {
        tenantId: tenantA.tenantId,
        adminId: subject.id,
        permissionKey: denied as string,
        effect: 'DENY',
        reason: 'Withdrawn.',
        expiresAt: null,
      },
    ]);

    const login = await ctx.container.auth.login(
      tenantA,
      anonymous,
      { username: 'overridden', password: 'the-correct-password' },
      from,
    );
    expect(login.permissions).toContain('admins.edit');
    expect(login.permissions).not.toContain(denied);

    // And the session view agrees with the login view.
    const described = await ctx.container.auth.describeSession(login.token);
    expect(described.permissions).toContain('admins.edit');
    expect(described.permissions).not.toContain(denied);

    // Decisively: what is reported is what the guard enforces.
    const enforced = await ctx.container.guard.permissionsOf(tenantA, adminActorFor(subject));
    expect([...described.permissions].sort()).toEqual([...enforced].sort());
  });
});

describe('a status change is stamped with when it happened', () => {
  it('never revokes a session before the session was issued', async () => {
    // `now` used to be captured before `runLockedMutation`, so a request could
    // queue on the tenant lock for as long as the holder took. In that window
    // the target can log in and be issued a session — and the revocation then
    // stamped `revoked_at` earlier than that session's `issued_at`, a record
    // saying the session was revoked before it existed.
    //
    // Stalled at the lock acquisition itself rather than by holding a real
    // lock from another transaction: doing that occupies a pool connection
    // while the login needs one, which is the pool-exhaustion deadlock this
    // branch fixed elsewhere. The seam is enough — what matters is that time
    // passes between the request starting and the lock being taken.
    const subject = await createAdmin(ctx.container, tenantA, {
      username: 'stamped',
      password: 'the-correct-password',
      roleKeys: ['support'],
    });

    const admins = ctx.container.admins as unknown as Record<string, unknown>;
    const realLock = ctx.container.admins.lockTenantForAdminChange.bind(ctx.container.admins);
    let releaseLock: () => void = () => undefined;
    const disableReachedLock = new Promise<void>((resolve) => {
      admins['lockTenantForAdminChange'] = async (scope: never, tx: never) => {
        admins['lockTenantForAdminChange'] = realLock;
        resolve();
        await new Promise<void>((release) => {
          releaseLock = release;
        });
        return realLock(scope, tx);
      };
    });

    const disabling = ctx.container.adminManagement
      .setStatus(tenantA, adminActorFor(owner), subject.id as AdminId, {
        status: 'DISABLED',
        reason: 'Queued behind the lock.',
      })
      .catch((error: unknown) => error);

    await disableReachedLock;

    // While the disable waits, the target signs in.
    const issued = await ctx.container.auth.login(
      tenantA,
      anonymous,
      { username: 'stamped', password: 'the-correct-password' },
      from,
    );

    releaseLock();
    await disabling;

    const [row] = await ctx.container.database.db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.id, issued.session.id));
    expect(row?.revokedAt).not.toBeNull();
    // The record must describe the order these things actually happened in.
    expect((row?.revokedAt as Date).getTime()).toBeGreaterThanOrEqual(
      (row?.issuedAt as Date).getTime(),
    );
  }, 30_000);
});

describe('a stopped tenant closes its Telegram surface too', () => {
  let api: ApiApp;
  const WEBHOOK_SECRET = 'a-sufficiently-long-secret';

  const ping = (botInstanceId: string, updateId: number) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `/telegram/webhook/${botInstanceId}`,
        headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
        payload: {
          update_id: updateId,
          message: { message_id: 1, date: 0, chat: { id: 1, type: 'private' }, text: '/ping' },
        },
      } as never);

  beforeAll(async () => {
    const config = testConfig({
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
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
  });

  it('accepts an update while the tenant is active', async () => {
    expect((await ping(SEED_IDS.botA1, 9101)).statusCode).toBe(201);
  });

  it('refuses an update for an ACTIVE bot whose tenant is stopped', async () => {
    // The bot's own status was the whole check. But the update acts as
    // SYSTEM_JOB, which never consults the permission resolver, so a stopped
    // installation kept accepting Telegram work while its Web Admin was shut.
    await api.container.database.db
      .update(tenants)
      .set({ status: 'STOPPED' })
      .where(eq(tenants.id, SEED_IDS.tenantA));

    expect((await ping(SEED_IDS.botA1, 9102)).statusCode).toBe(404);

    // And no work was recorded under the stopped tenant.
    const keys = await api.container.database.db.execute(
      `SELECT key FROM request_idempotency WHERE key LIKE '%:update:9102'` as never,
    );
    expect(JSON.stringify(keys)).not.toContain('update:9102');
  });

  it('refuses an update for a DISABLED tenant', async () => {
    await api.container.database.db
      .update(tenants)
      .set({ status: 'DISABLED' })
      .where(eq(tenants.id, SEED_IDS.tenantA));
    expect((await ping(SEED_IDS.botA1, 9103)).statusCode).toBe(404);
  });
});

describe('the boot-time role sync is serialised with administrator mutations', () => {
  it('holds the same tenant lock those mutations take', async () => {
    // Without it, a rolling upgrade has a window with teeth: a concurrent
    // `setRoles` reads a role's permissions, passes the no-amplification check
    // against an actor who does not hold the permission this boot is about to
    // add, and assigns the role — and when the seeder commits, the target
    // silently holds authority nobody ever checked.
    //
    // Asserted by observing the lock: a mutation holding it must block the
    // sync, which it cannot do unless the sync takes it too.
    let releaseHolder: () => void = () => undefined;
    let syncFinished = false;

    const holderHasLock = new Promise<void>((resolve) => {
      void ctx.container.uow.run(tenantA, async (tx) => {
        await ctx.container.admins.lockTenantForAdminChange(tenantA, tx);
        resolve();
        await new Promise<void>((release) => {
          releaseHolder = release;
        });
      });
    });
    await holderHasLock;

    const sync = resolveInstallationTenant(ctx.container).then(() => {
      syncFinished = true;
    });

    try {
      // Give it every chance to finish if it were not waiting on the lock.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(syncFinished).toBe(false);
    } finally {
      // Released even when the assertion above fails: leaving the holding
      // transaction open would hang the whole run rather than failing this one
      // test, and a slow failure is a failure nobody reads.
      releaseHolder();
    }

    await sync;
    expect(syncFinished).toBe(true);
  }, 30_000);
});

describe('the outbox pauses for a tenant that is not active', () => {
  it('leaves the work unclaimed, and delivers it when the tenant returns', async () => {
    // Stopping a tenant ends its Web Admin logins and its Telegram intake. A
    // relay that went on dispatching would leave the half of the installation
    // that talks to the outside world still talking. Skipping rather than
    // dropping is the other half of that promise: the messages must still be
    // there, in order, when the tenant is started again.
    const relay = ctx.container.relay;

    // Drain anything the fixtures left behind, so the counts below are this
    // test's own.
    await relay.processBatch();

    await ctx.container.uow.run(tenantA, async (tx) => {
      await ctx.container.outbox.write(tx, adminActorFor(owner), {
        eventType: 'SystemPinged',
        aggregateType: 'System',
        aggregateId: ctx.container.ids.uuid(),
        payload: { note: 'while active' },
      });
    });

    await ctx.container.database.db
      .update(tenants)
      .set({ status: 'STOPPED' })
      .where(eq(tenants.id, tenantA.tenantId));

    const whileStopped = await relay.processBatch();
    expect(whileStopped.published).toBe(0);

    // Still pending, not published and not failed.
    const pending = await ctx.container.database.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.tenantId, tenantA.tenantId));
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((row) => row.publishedAt === null)).toBe(true);
    expect(pending.every((row) => row.attempts === 0)).toBe(true);

    await ctx.container.database.db
      .update(tenants)
      .set({ status: 'ACTIVE' })
      .where(eq(tenants.id, tenantA.tenantId));

    const afterRestart = await relay.processBatch();
    expect(afterRestart.published).toBeGreaterThan(0);
  }, 30_000);
});

describe("a boot sync does not undo an operator's decision", () => {
  it('leaves a permission that was deliberately withdrawn withdrawn', async () => {
    // The seed used to be written on every boot, so a permission an operator
    // had removed came back at the next restart, silently and with no audit
    // row. That is authority being restored by accident, which is worse than
    // the failure it replaces: a permission newly added to a seeded role no
    // longer reaches installations that already have the role, and THAT fails
    // loudly — the amplification rule refuses to grant what nobody holds.
    const [financeRole] = await ctx.container.database.db
      .select()
      .from(roles)
      .where(and(eq(roles.tenantId, tenantA.tenantId), eq(roles.key, 'finance')));
    expect(financeRole).toBeDefined();

    const before = await ctx.container.database.db
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, financeRole?.id as string));
    const withdrawn = before[0]?.permissionKey;
    expect(withdrawn).toBeDefined();

    await ctx.container.database.db
      .delete(rolePermissions)
      .where(
        and(
          eq(rolePermissions.roleId, financeRole?.id as string),
          eq(rolePermissions.permissionKey, withdrawn as string),
        ),
      );

    // What a restart does.
    await resolveInstallationTenant(ctx.container);

    const after = await ctx.container.database.db
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, financeRole?.id as string));
    expect(after.map((row) => row.permissionKey)).not.toContain(withdrawn);
    expect(after).toHaveLength(before.length - 1);
  });

  it('still creates a seeded role that is missing entirely', async () => {
    // The reachability the previous round asked for is kept: a role absent from
    // an installation — a new one in the catalogue, or a fresh install — is
    // created with its seed permissions.
    const scope = { tenantId: tenantB.tenantId as never, botInstanceId: null };
    expect(
      await ctx.container.database.db
        .select()
        .from(roles)
        .where(eq(roles.tenantId, tenantB.tenantId)),
    ).toHaveLength(0);

    await ctx.container.roles.ensureSystemRoles(scope);

    const created = await ctx.container.database.db
      .select()
      .from(roles)
      .where(eq(roles.tenantId, tenantB.tenantId));
    expect(created.length).toBeGreaterThan(0);

    const granted = await ctx.container.database.db
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.tenantId, tenantB.tenantId));
    expect(granted.length).toBeGreaterThan(0);
  });
});

describe('a revoked session performs no writes', () => {
  it('refuses a mutation whose session was revoked while it waited', async () => {
    // Session validity is established once, when the request arrives, and then
    // the request does work. A logout or a password rotation committing in that
    // window revokes the session — and without re-reading it under the lock,
    // the request still commits. That would make "a rotation revokes every
    // session" true of the rows and false of the requests already in flight,
    // which is the one thing rotation exists to guarantee.
    const target = await createAdmin(ctx.container, tenantA, {
      username: 'mutation-target',
      roleKeys: ['support'],
    });

    // The owner acts on a real session, as a surface would.
    const issued = await ctx.container.auth.login(
      tenantA,
      anonymous,
      { username: 'owner', password: owner.password },
      from,
    );
    const actorOnSession = {
      ...adminActorFor(owner),
      sessionId: issued.session.id as string,
    };

    // Stall the mutation at the lock, then revoke its session underneath it.
    const admins = ctx.container.admins as unknown as Record<string, unknown>;
    const realLock = ctx.container.admins.lockTenantForAdminChange.bind(ctx.container.admins);
    let release: () => void = () => undefined;
    const reachedLock = new Promise<void>((resolve) => {
      admins['lockTenantForAdminChange'] = async (scope: never, tx: never) => {
        admins['lockTenantForAdminChange'] = realLock;
        resolve();
        await new Promise<void>((r) => {
          release = r;
        });
        return realLock(scope, tx);
      };
    });

    const mutating = ctx.container.adminManagement
      .setStatus(tenantA, actorOnSession, target.id as AdminId, {
        status: 'DISABLED',
        reason: 'Started before the logout.',
      })
      .catch((error: unknown) => error);

    await reachedLock;
    await ctx.container.auth.logout(tenantA, actorOnSession, issued.session.id);
    release();

    const caught = await mutating;
    expect((caught as { code?: string }).code).toBe('auth.session_invalid');

    // And decisively: the mutation did not happen.
    expect((await ctx.container.admins.findById(tenantA, target.id as AdminId))?.status).toBe(
      'ACTIVE',
    );
  }, 30_000);

  it('still permits a mutation on a live session', async () => {
    const target = await createAdmin(ctx.container, tenantA, {
      username: 'mutation-target-2',
      roleKeys: ['support'],
    });
    const issued = await ctx.container.auth.login(
      tenantA,
      anonymous,
      { username: 'owner', password: owner.password },
      from,
    );
    await expect(
      ctx.container.adminManagement.setStatus(
        tenantA,
        { ...adminActorFor(owner), sessionId: issued.session.id as string },
        target.id as AdminId,
        { status: 'DISABLED', reason: 'Ordinary administration.' },
      ),
    ).resolves.toBeDefined();
  });

  it('still permits system work, which carries no session', async () => {
    // A SYSTEM_JOB actor is not a signed-in administrator wearing a different
    // hat, and this gate must not become a way to refuse provisioning.
    await expect(
      ctx.container.bootstrapOwner.execute(tenantB, {
        username: 'installer',
        displayName: 'The Operator',
        password: 'a-perfectly-fine-password',
      }),
    ).resolves.toBeDefined();
  });
});

describe('a paused installation does not lock its operator out', () => {
  it('gives back the reservations when a correct password meets a stopped tenant', async () => {
    // The refusal is about the installation being paused, not about them. At a
    // limit of one, a single correct attempt during a maintenance window would
    // otherwise leave the operator rate limited the moment it ended.
    const strict = await createTestContext({
      LOGIN_MAX_ATTEMPTS_PER_USERNAME: '1',
      LOGIN_MAX_ATTEMPTS_PER_IP: '1',
    });
    try {
      await strict.reset();
      await createAdmin(strict.container, tenantA, {
        username: 'operator',
        password: 'the-correct-password',
        roleKeys: [OWNER_ROLE_KEY],
      });
      const ip = '198.51.100.201';

      await strict.container.database.db
        .update(tenants)
        .set({ status: 'STOPPED' })
        .where(eq(tenants.id, tenantA.tenantId));

      await expect(
        strict.container.auth.login(
          tenantA,
          anonymous,
          { username: 'operator', password: 'the-correct-password' },
          { ip, userAgent: 'vitest' },
        ),
      ).rejects.toMatchObject({ code: 'auth.invalid_credentials' });

      await strict.container.database.db
        .update(tenants)
        .set({ status: 'ACTIVE' })
        .where(eq(tenants.id, tenantA.tenantId));

      // The maintenance window is over; the operator must be able to sign in.
      await expect(
        strict.container.auth.login(
          tenantA,
          anonymous,
          { username: 'operator', password: 'the-correct-password' },
          { ip, userAgent: 'vitest' },
        ),
      ).resolves.toBeDefined();
    } finally {
      await strict.close();
    }
  }, 30_000);

  it('still counts a WRONG password against a stopped tenant', async () => {
    // The release is for a correct credential meeting a paused installation,
    // not an amnesty for guessing during one.
    await ctx.container.database.db
      .update(tenants)
      .set({ status: 'STOPPED' })
      .where(eq(tenants.id, tenantA.tenantId));

    await expect(
      ctx.container.auth.login(
        tenantA,
        anonymous,
        { username: 'owner', password: 'wrong' },
        { ip: '198.51.100.202', userAgent: 'vitest' },
      ),
    ).rejects.toThrow();

    const [row] = await ctx.container.database.db
      .select()
      .from(adminLoginThrottle)
      .where(eq(adminLoginThrottle.subject, '198.51.100.202'));
    expect(row?.failedCount).toBe(1);
  });
});

describe('readiness does not count deliberately paused work', () => {
  it('reports no lag for messages held back by a stopped tenant', async () => {
    // Otherwise an installation somebody switched off on purpose reports itself
    // unready, indefinitely, and gets pulled out of service.
    const relay = ctx.container.relay;
    await relay.processBatch();

    await ctx.container.uow.run(tenantA, async (tx) => {
      await ctx.container.outbox.write(tx, adminActorFor(owner), {
        eventType: 'SystemPinged',
        aggregateType: 'System',
        aggregateId: ctx.container.ids.uuid(),
        payload: { note: 'paused' },
      });
    });

    // Move the clock forward rather than backdating the row: `nexa_outbox_guard`
    // refuses to alter an outbox message's content, correctly.
    const clock = ctx.container.clock as unknown as Record<string, unknown>;
    const realNow = ctx.container.clock.now.bind(ctx.container.clock);
    clock['now'] = () => new Date(realNow().getTime() + 3_600_000);

    try {
      expect(await relay.lagMs()).toBeGreaterThan(60_000);

      await ctx.container.database.db
        .update(tenants)
        .set({ status: 'STOPPED' })
        .where(eq(tenants.id, tenantA.tenantId));

      // Paused, therefore not lagging.
      expect(await relay.lagMs()).toBe(0);
      expect(await relay.isHealthy()).toBe(true);
    } finally {
      clock['now'] = realNow;
    }
  }, 30_000);
});

describe('serialization holds for the whole write, not just up to the check', () => {
  it('refuses a mutation whose session is revoked AFTER the liveness check', async () => {
    // The previous round closed the window before the check and left the one
    // after it: a logout starting once `isLive` had returned could commit on
    // its own connection while the mutation was still working. `FOR UPDATE`
    // makes the logout wait for this transaction instead.
    const target = await createAdmin(ctx.container, tenantA, {
      username: 'post-check-target',
      roleKeys: ['support'],
    });
    const issued = await ctx.container.auth.login(
      tenantA,
      anonymous,
      { username: 'owner', password: owner.password },
      from,
    );
    const actorOnSession = { ...adminActorFor(owner), sessionId: issued.session.id as string };

    // Stall the mutation AFTER the session check, before it writes.
    const admins = ctx.container.admins as unknown as Record<string, unknown>;
    const realRequire = ctx.container.admins.findById.bind(ctx.container.admins);
    let release: () => void = () => undefined;
    let stalled = false;
    const pastTheCheck = new Promise<void>((resolve) => {
      admins['findById'] = async (...args: unknown[]) => {
        if (!stalled) {
          stalled = true;
          resolve();
          await new Promise<void>((r) => {
            release = r;
          });
        }
        return (realRequire as (...a: unknown[]) => unknown)(...args);
      };
    });

    const mutating = ctx.container.adminManagement
      .setStatus(tenantA, actorOnSession, target.id as AdminId, {
        status: 'DISABLED',
        reason: 'Started before the logout.',
      })
      .catch((error: unknown) => error);

    await pastTheCheck;

    // The logout must not be able to commit while that transaction holds the
    // session row; it blocks until the mutation finishes.
    const loggingOut = ctx.container.auth
      .logout(tenantA, actorOnSession, issued.session.id)
      .catch((error: unknown) => error);

    release();
    admins['findById'] = realRequire;
    await mutating;
    await loggingOut;

    // Whichever order the database chose, the two must not BOTH have taken
    // effect out of order: a mutation that committed did so while its session
    // was live, and the revocation that follows is simply later.
    const [session] = await ctx.container.database.db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.id, issued.session.id));
    expect(session?.revokedAt).not.toBeNull();
  }, 30_000);
});

describe('a tenant stopped mid-request stops the write', () => {
  it('refuses a mutation when the stop commits before the lock', async () => {
    // Authentication checked tenant status when the request arrived, which is a
    // snapshot. The lock observes the transition; the work it protects has to
    // observe it too, or a stop that has already returned to the operator still
    // lets writes land.
    const target = await createAdmin(ctx.container, tenantA, {
      username: 'stopped-mid-request',
      roleKeys: ['support'],
    });

    const admins = ctx.container.admins as unknown as Record<string, unknown>;
    const realLock = ctx.container.admins.lockTenantForAdminChange.bind(ctx.container.admins);
    let release: () => void = () => undefined;
    const reachedLock = new Promise<void>((resolve) => {
      admins['lockTenantForAdminChange'] = async (scope: never, tx: never) => {
        admins['lockTenantForAdminChange'] = realLock;
        resolve();
        await new Promise<void>((r) => {
          release = r;
        });
        return realLock(scope, tx);
      };
    });

    const mutating = ctx.container.adminManagement
      .setStatus(tenantA, adminActorFor(owner), target.id as AdminId, {
        status: 'DISABLED',
        reason: 'Authenticated before the stop.',
      })
      .catch((error: unknown) => error);

    await reachedLock;
    await ctx.container.database.db
      .update(tenants)
      .set({ status: 'STOPPED' })
      .where(eq(tenants.id, tenantA.tenantId));
    release();

    const caught = await mutating;
    expect((caught as { code?: string }).code).toBe('auth.session_invalid');
    expect((await ctx.container.admins.findById(tenantA, target.id as AdminId))?.status).toBe(
      'ACTIVE',
    );
  }, 30_000);
});

describe('the outbox re-checks the tenant at dispatch, not only at claim', () => {
  it('takes the tenant row lock before delivering, so a stop cannot slip in', async () => {
    // Eligibility was evaluated when the row was SELECTed, and `FOR UPDATE`
    // locked the message rather than its tenant — so a stop committing between
    // the claim and the dispatch still let the delivery go out, which is the
    // one thing the pause exists to prevent.
    //
    // There is no seam between the claim and the dispatch to interleave at, so
    // this observes the lock instead: holding the tenant row from another
    // transaction must make the batch WAIT. It cannot wait unless it asks for
    // that row, which is the property. An earlier version of this test stopped
    // the tenant before the batch ran and therefore only re-tested the claim
    // filter another test already covers.
    const relay = ctx.container.relay;
    await relay.processBatch();

    await ctx.container.uow.run(tenantA, async (tx) => {
      await ctx.container.outbox.write(tx, adminActorFor(owner), {
        eventType: 'SystemPinged',
        aggregateType: 'System',
        aggregateId: ctx.container.ids.uuid(),
        payload: { note: 'claimed then stopped' },
      });
    });

    let releaseHolder: () => void = () => undefined;
    let batchFinished = false;

    const holderHasTenantRow = new Promise<void>((resolve) => {
      void ctx.container.uow.run(tenantA, async (tx) => {
        await ctx.container.admins.lockTenantForAdminChange(tenantA, tx);
        resolve();
        await new Promise<void>((release) => {
          releaseHolder = release;
        });
      });
    });
    await holderHasTenantRow;

    const batch = relay.processBatch().then((result) => {
      batchFinished = true;
      return result;
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(batchFinished).toBe(false);
    } finally {
      // Released even on failure: a held transaction would hang the run rather
      // than failing this one test.
      releaseHolder();
    }

    const result = await batch;
    expect(result.published).toBeGreaterThan(0);
  }, 30_000);
});

describe('a login refuses a tenant stopped while it was hashing', () => {
  it('mints no session, and gives the reservations back', async () => {
    // I argued the opposite one commit ago: that a session minted after a stop
    // is inert because `authenticate` refuses it. That was wrong against my own
    // decision — sessions are REFUSED, not revoked, precisely so they survive a
    // restart, which means one minted after the stop works the moment the
    // tenant comes back.
    //
    // The window is narrow and specific: AFTER the tenant check that follows
    // verification, and BEFORE the session transaction. The rehash is what
    // occupies it, so this account is stored below the current cost profile to
    // make that rehash run. An earlier version of this test stalled inside
    // `verify` instead and passed against the broken code, because the existing
    // tenant check comes after that and caught it — it proved nothing.
    const subject = await createAdmin(ctx.container, tenantA, {
      username: 'hashing-when-stopped',
      password: 'the-correct-password',
      roleKeys: ['support'],
    });
    await ctx.container.admins.setPasswordHash(
      tenantA,
      subject.id as AdminId,
      await new ScryptPasswordHasher(LEGACY_SCRYPT).hash('the-correct-password'),
      ctx.container.clock.now(),
    );

    const hasher = ctx.container.hasher as unknown as Record<string, unknown>;
    const realHash = ctx.container.hasher.hash.bind(ctx.container.hasher);
    let release: () => void = () => undefined;
    const rehashing = new Promise<void>((resolve) => {
      hasher['hash'] = async (plaintext: string) => {
        hasher['hash'] = realHash;
        resolve();
        await new Promise<void>((r) => {
          release = r;
        });
        return realHash(plaintext);
      };
    });

    const login = ctx.container.auth
      .login(
        tenantA,
        anonymous,
        { username: 'hashing-when-stopped', password: 'the-correct-password' },
        { ip: '198.51.100.210', userAgent: 'vitest' },
      )
      .catch((error: unknown) => error);

    await rehashing;
    await ctx.container.database.db
      .update(tenants)
      .set({ status: 'STOPPED' })
      .where(eq(tenants.id, tenantA.tenantId));
    release();

    const caught = await login;
    expect((caught as { code?: string }).code).toBe('auth.invalid_credentials');

    // No session exists for them at all.
    const sessions = await ctx.container.database.db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.adminId, subject.id));
    expect(sessions).toHaveLength(0);

    // And the maintenance window did not cost them their attempt budget.
    const [row] = await ctx.container.database.db
      .select()
      .from(adminLoginThrottle)
      .where(eq(adminLoginThrottle.subject, '198.51.100.210'));
    expect(row?.failedCount ?? 0).toBe(0);
  }, 30_000);
});

describe('the webhook write is refused if the bot stops while it runs', () => {
  it('writes no audit, idempotency or outbox row for a stopped bot', async () => {
    // The surface checks the bot and the tenant when the update arrives, which
    // is a snapshot. A stop committing before the write lands would otherwise
    // still create rows for an installation somebody had already switched off —
    // and the relay filters on tenant status only, so a bot-only stop would let
    // the event go straight out.
    const scope = {
      tenantId: SEED_IDS.tenantA as never,
      botInstanceId: SEED_IDS.botA1 as never,
    };
    const actor = {
      type: 'SYSTEM_JOB' as const,
      id: null,
      label: 'telegram-update:test',
      surface: 'TELEGRAM' as const,
      correlationId: 'webhook-scope' as CorrelationId,
    };

    await ctx.container.database.db
      .update(botInstances)
      .set({ status: 'STOPPED' })
      .where(eq(botInstances.id, SEED_IDS.botA1));

    await expect(
      ctx.container.recordPing.execute(scope, actor, {
        source: 'telegram',
        idempotencyKey: 'stopped-bot-write',
      }),
    ).rejects.toThrow();

    const keys = await ctx.container.database.db.execute(
      `SELECT key FROM request_idempotency WHERE key = 'stopped-bot-write'` as never,
    );
    expect(JSON.stringify(keys)).not.toContain('stopped-bot-write');
  }, 30_000);

  it('still writes while both the bot and the tenant are active', async () => {
    const scope = {
      tenantId: SEED_IDS.tenantA as never,
      botInstanceId: SEED_IDS.botA1 as never,
    };
    const actor = {
      type: 'SYSTEM_JOB' as const,
      id: null,
      label: 'telegram-update:test',
      surface: 'TELEGRAM' as const,
      correlationId: 'webhook-scope-ok' as CorrelationId,
    };
    await expect(
      ctx.container.recordPing.execute(scope, actor, {
        source: 'telegram',
        idempotencyKey: 'active-bot-write',
      }),
    ).resolves.toBeDefined();
  }, 30_000);
});

describe('a login refused by a tenant stop is classified by the transaction', () => {
  it('gives the reservations back even if the tenant restarts immediately', async () => {
    // The refusal reason used to come from a second, UNLOCKED read after the
    // transaction returned. A restart in that gap made a refusal caused by the
    // stop look like a wrong password, so the operator kept the throttle
    // reservations for a credential that was correct — inferring a locked
    // decision from an unlocked read, which is the exact mistake the lock was
    // added to stop.
    const strict = await createTestContext({
      LOGIN_MAX_ATTEMPTS_PER_USERNAME: '1',
      LOGIN_MAX_ATTEMPTS_PER_IP: '1',
    });
    try {
      await strict.reset();
      const subject = await createAdmin(strict.container, tenantA, {
        username: 'restarted-under-me',
        password: 'the-correct-password',
        roleKeys: [OWNER_ROLE_KEY],
      });
      // Below current cost, so the rehash runs and gives a window to stall in.
      await strict.container.admins.setPasswordHash(
        tenantA,
        subject.id as AdminId,
        await new ScryptPasswordHasher(LEGACY_SCRYPT).hash('the-correct-password'),
        strict.container.clock.now(),
      );
      const ip = '198.51.100.220';

      const hasher = strict.container.hasher as unknown as Record<string, unknown>;
      const realHash = strict.container.hasher.hash.bind(strict.container.hasher);
      let release: () => void = () => undefined;
      const rehashing = new Promise<void>((resolve) => {
        hasher['hash'] = async (plaintext: string) => {
          hasher['hash'] = realHash;
          resolve();
          await new Promise<void>((r) => {
            release = r;
          });
          return realHash(plaintext);
        };
      });

      const login = strict.container.auth
        .login(
          tenantA,
          anonymous,
          { username: 'restarted-under-me', password: 'the-correct-password' },
          { ip, userAgent: 'vitest' },
        )
        .catch((error: unknown) => error);

      await rehashing;
      await strict.container.database.db
        .update(tenants)
        .set({ status: 'STOPPED' })
        .where(eq(tenants.id, tenantA.tenantId));

      // The restart lands in the GAP — after the transaction has refused and
      // before anything could re-read the status. That gap is the whole finding:
      // stopping and restarting either side of the login proves nothing, because
      // an unlocked re-read afterwards would still see STOPPED. The service's
      // own tenant read is the seam, so the restart is triggered from it.
      const auth = strict.container.auth as unknown as Record<string, unknown>;
      const realTenantCheck = (auth['tenantIsActive'] as (scope: unknown) => Promise<boolean>).bind(
        strict.container.auth,
      );
      auth['tenantIsActive'] = async (scope: unknown) => {
        auth['tenantIsActive'] = realTenantCheck;
        await strict.container.database.db
          .update(tenants)
          .set({ status: 'ACTIVE' })
          .where(eq(tenants.id, tenantA.tenantId));
        return realTenantCheck(scope);
      };

      release();
      await login;
      auth['tenantIsActive'] = realTenantCheck;

      await strict.container.database.db
        .update(tenants)
        .set({ status: 'ACTIVE' })
        .where(eq(tenants.id, tenantA.tenantId));

      const [row] = await strict.container.database.db
        .select()
        .from(adminLoginThrottle)
        .where(eq(adminLoginThrottle.subject, ip));
      expect(row?.failedCount ?? 0).toBe(0);

      // And decisively: the operator can sign in.
      await expect(
        strict.container.auth.login(
          tenantA,
          anonymous,
          { username: 'restarted-under-me', password: 'the-correct-password' },
          { ip, userAgent: 'vitest' },
        ),
      ).resolves.toBeDefined();
    } finally {
      await strict.close();
    }
  }, 30_000);
});

describe('an attempted privilege escalation is recorded in full', () => {
  it('names the permissions the actor tried to confer, not "unknown"', async () => {
    // A guard denial names one permission under `permission`; an amplification
    // refusal names the whole offending set under `permissions`. Reading only
    // the singular recorded the more serious of the two — somebody caught
    // trying to confer authority they do not hold — as `unknown` in the
    // operational log and `null` in the audit row.
    const manager = await createAdmin(ctx.container, tenantA, {
      username: 'delegated-manager',
      roleKeys: ['support'],
    });
    await ctx.container.database.db.insert(adminPermissionOverrides).values({
      tenantId: tenantA.tenantId,
      adminId: manager.id,
      permissionKey: 'admins.edit',
      effect: 'GRANT',
      reason: 'Administers the roster.',
      expiresAt: null,
    });

    await expect(
      ctx.container.adminManagement.create(tenantA, adminActorFor(manager), {
        username: 'a-puppet',
        displayName: 'Puppet',
        password: 'a-perfectly-fine-password',
        roleKeys: ['finance'],
      }),
    ).rejects.toMatchObject({ code: 'admin.privilege_escalation_denied' });

    const [row] = (await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'admin.create'))) as {
      result: string;
      after: Record<string, unknown> | null;
    }[];

    expect(row?.result).toBe('DENIED');
    expect(row?.after?.['reason']).toBe('admin.privilege_escalation_denied');
    // The set, not a single name and not null.
    const attempted = row?.after?.['deniedPermissions'] as string[] | undefined;
    expect(Array.isArray(attempted)).toBe(true);
    expect((attempted ?? []).length).toBeGreaterThan(0);
    expect(row?.after?.['deniedPermission']).not.toBeNull();
  });
});

describe('a blank reason is not a reason', () => {
  it('refuses a whitespace-only reason on a status change', async () => {
    // These operations disable accounts and alter authority. A mandatory reason
    // that accepts " " is not mandatory; it just leaves the audit row for the
    // most consequential event on this surface holding a blank.
    const target = await createAdmin(ctx.container, tenantA, {
      username: 'blank-reason-target',
      roleKeys: ['support'],
    });

    for (const reason of ['', '   ', '\t\n ']) {
      await expect(
        ctx.container.adminManagement.setStatus(
          tenantA,
          adminActorFor(owner),
          target.id as AdminId,
          { status: 'DISABLED', reason },
        ),
      ).rejects.toThrow();
    }

    expect((await ctx.container.admins.findById(tenantA, target.id as AdminId))?.status).toBe(
      'ACTIVE',
    );

    // A real reason still works, and reaches the audit row trimmed.
    await expect(
      ctx.container.adminManagement.setStatus(tenantA, adminActorFor(owner), target.id as AdminId, {
        status: 'DISABLED',
        reason: '  Left the company.  ',
      }),
    ).resolves.toBeDefined();

    const rows = (await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'admin.status_change'))) as { reason: string | null }[];
    expect(rows.some((row) => row.reason === 'Left the company.')).toBe(true);
  });
});

describe('the login throttle does not grow without bound', () => {
  it('removes rows whose window and lockout are both over', async () => {
    // Every previously unseen username or IP inserts a durable row, and an
    // expired one is only reset when that exact subject is used again — so an
    // endless stream of distinct usernames, or a rotating IPv6 range, would
    // grow this table for good.
    for (const username of ['ghost-a', 'ghost-b', 'ghost-c']) {
      await expect(
        ctx.container.auth.login(
          tenantA,
          anonymous,
          { username, password: 'guess' },
          { ip: null, userAgent: 'vitest' },
        ),
      ).rejects.toThrow();
    }

    const before = await ctx.container.database.db.select().from(adminLoginThrottle);
    expect(before.length).toBeGreaterThanOrEqual(3);

    // Nothing is removed while the rows still count for something.
    expect(await ctx.container.throttleSweeper.sweep()).toBe(0);
    expect(await ctx.container.database.db.select().from(adminLoginThrottle)).toHaveLength(
      before.length,
    );

    // Once the window and any lockout are past, they are housekeeping.
    const clock = ctx.container.clock as unknown as Record<string, unknown>;
    const realNow = ctx.container.clock.now.bind(ctx.container.clock);
    clock['now'] = () => new Date(realNow().getTime() + 30 * 24 * 3_600_000);
    try {
      expect(await ctx.container.throttleSweeper.sweep()).toBeGreaterThanOrEqual(3);
      expect(await ctx.container.database.db.select().from(adminLoginThrottle)).toHaveLength(0);
    } finally {
      clock['now'] = realNow;
    }
  }, 30_000);

  it('never removes a lockout somebody is still serving', async () => {
    // The sweep must not be a way to shorten a lockout.
    const limit = ctx.container.config.LOGIN_MAX_ATTEMPTS_PER_USERNAME;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      await expect(
        ctx.container.auth.login(
          tenantA,
          anonymous,
          { username: 'owner', password: 'wrong' },
          { ip: null, userAgent: 'vitest' },
        ),
      ).rejects.toThrow();
    }

    // Far enough forward that the WINDOW has elapsed, but the row carries an
    // unexpired lockout — the sweep must leave it alone.
    const [locked] = await ctx.container.database.db
      .select()
      .from(adminLoginThrottle)
      .where(eq(adminLoginThrottle.subject, 'owner'));
    expect(locked?.lockedUntil).not.toBeNull();

    expect(await ctx.container.throttleSweeper.sweep()).toBe(0);
    const [survivor] = await ctx.container.database.db
      .select()
      .from(adminLoginThrottle)
      .where(eq(adminLoginThrottle.subject, 'owner'));
    expect(survivor).toBeDefined();
  }, 30_000);
});

describe('review round 15', () => {
  it('does not commit a session whose login audit fails', async () => {
    // The previous round moved the throttle cleanup and `recordLogin` into the
    // session transaction and stopped there. The SUCCESS audit stayed outside
    // it, so a failing audit insert left a live session committed, returned an
    // error to the caller, and recorded nothing about a sign-in that had
    // actually happened.
    const audit = ctx.container.audit as unknown as Record<string, unknown>;
    const realRecord = ctx.container.audit.record.bind(ctx.container.audit);
    let refused = 0;
    audit['record'] = async (
      scope: unknown,
      actor: unknown,
      entry: { action: string; result: string },
      tx?: unknown,
    ) => {
      if (entry.action === 'auth.login' && entry.result === 'SUCCESS') {
        refused += 1;
        throw new Error('audit is unavailable');
      }
      return realRecord(scope as never, actor as never, entry as never, tx as never);
    };

    try {
      await expect(
        ctx.container.auth.login(
          tenantA,
          anonymous,
          { username: owner.username, password: owner.password },
          from,
        ),
      ).rejects.toThrow('audit is unavailable');
    } finally {
      audit['record'] = realRecord;
    }
    expect(refused).toBe(1);

    // The session must have gone back with the audit row. A committed session
    // whose token the caller never received is one nobody can account for.
    const sessions = await ctx.container.database.db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.adminId, owner.id));
    expect(sessions).toHaveLength(0);
  }, 30_000);

  it('removes expired sessions, and only past the retention cutoff', async () => {
    // `purgeExpiredBefore` existed with no caller anywhere: sessions were only
    // ever marked revoked, never removed, so one valid credential signed in
    // repeatedly grew the table for the life of the installation.
    const issued = await ctx.container.auth.login(
      tenantA,
      anonymous,
      { username: owner.username, password: owner.password },
      from,
    );

    const rowsForSession = () =>
      ctx.container.database.db
        .select()
        .from(adminSessions)
        .where(eq(adminSessions.id, issued.session.id));

    // Still live: housekeeping must not touch it.
    expect(await ctx.container.sessionSweeper.sweep()).toBe(0);
    expect(await rowsForSession()).toHaveLength(1);

    const clock = ctx.container.clock as unknown as Record<string, unknown>;
    const realNow = ctx.container.clock.now.bind(ctx.container.clock);
    const ttl = ctx.container.config.SESSION_TTL_SECONDS;
    const retention = ctx.container.config.SESSION_RETENTION_SECONDS;
    try {
      // Expired, but inside the retention window — still readable for
      // forensics, which is the whole reason the cutoff is not "expired".
      clock['now'] = () => new Date(realNow().getTime() + (ttl + 60) * 1000);
      expect(await ctx.container.sessionSweeper.sweep()).toBe(0);
      expect(await rowsForSession()).toHaveLength(1);

      // Past retention: collected.
      clock['now'] = () => new Date(realNow().getTime() + (ttl + retention + 60) * 1000);
      expect(await ctx.container.sessionSweeper.sweep()).toBeGreaterThanOrEqual(1);
      expect(await rowsForSession()).toHaveLength(0);
    } finally {
      clock['now'] = realNow;
    }
  }, 30_000);

  it('collects a revoked session too, on the same schedule', async () => {
    // Revoking sets `revoked_at` and leaves the original expiry, so the one
    // condition the sweep uses covers both without a second branch.
    const issued = await ctx.container.auth.login(
      tenantA,
      anonymous,
      { username: owner.username, password: owner.password },
      from,
    );
    await ctx.container.auth.logout(
      tenantA,
      adminActorFor(owner),
      issued.session.id as AdminSessionId,
    );

    const clock = ctx.container.clock as unknown as Record<string, unknown>;
    const realNow = ctx.container.clock.now.bind(ctx.container.clock);
    const ttl = ctx.container.config.SESSION_TTL_SECONDS;
    const retention = ctx.container.config.SESSION_RETENTION_SECONDS;
    clock['now'] = () => new Date(realNow().getTime() + (ttl + retention + 60) * 1000);
    try {
      expect(await ctx.container.sessionSweeper.sweep()).toBeGreaterThanOrEqual(1);
      expect(
        await ctx.container.database.db
          .select()
          .from(adminSessions)
          .where(eq(adminSessions.id, issued.session.id)),
      ).toHaveLength(0);
    } finally {
      clock['now'] = realNow;
    }
  }, 30_000);
});

describe('review round 16', () => {
  it('drains the throttle backlog by index, not by scanning the table', async () => {
    // The sweeper's predicate had no index: its table's only one leads with
    // `tenant_id` for the per-subject lookups. Harmless while the table is
    // small, and not harmless at all now that connections carry a statement
    // timeout — a backlog big enough to scan past it makes every sweep fail,
    // which leaves growth an unauthenticated caller can drive permanent.
    const now = ctx.container.clock.now();
    const fresh = new Date(now.getTime() - 3_600_000);
    const stale = new Date(now.getTime() - 40 * 24 * 3_600_000);
    const rows = [
      ...Array.from({ length: 400 }, (_, i) => ({ subject: `fresh-${i}`, at: fresh })),
      ...Array.from({ length: 20 }, (_, i) => ({ subject: `stale-${i}`, at: stale })),
    ];
    await ctx.container.database.db.insert(adminLoginThrottle).values(
      rows.map((row) => ({
        tenantId: SEED_IDS.tenantA,
        subjectKind: 'USERNAME' as const,
        subject: row.subject,
        failedCount: 1,
        lockedUntil: null,
        windowStartedAt: row.at,
        updatedAt: row.at,
      })) as never,
    );
    await ctx.container.database.db.execute('ANALYZE admin_login_throttle' as never);

    const plan = (await ctx.container.database.db.execute(
      `EXPLAIN SELECT ctid FROM admin_login_throttle
         WHERE window_started_at <= now() - interval '30 days'
           AND (locked_until IS NULL OR locked_until <= now())
         LIMIT 5000` as never,
    )) as unknown as { rows: Record<string, string>[] };
    const text = (plan.rows ?? (plan as unknown as Record<string, string>[]))
      .map((row) => Object.values(row).join(' '))
      .join('\n');
    expect(text).toContain('admin_login_throttle_retention_idx');
  }, 30_000);

  it('has a NON-PARTIAL expiry index the session sweeper can use', async () => {
    // `admin_sessions_expiry_idx` is partial on `revoked_at IS NULL`, which is
    // right for finding live sessions and unusable for retention: the sweep
    // collects revoked rows too, so its query cannot imply that predicate and
    // fell back to a sequential scan. With a statement timeout now on every
    // connection, a backlog big enough to scan past it makes every sweep fail.
    //
    // Asserted structurally rather than through EXPLAIN: on a small table the
    // planner correctly prefers a scan whatever indexes exist, so a plan
    // assertion here passes for the wrong reason. What must be true is that an
    // index this predicate CAN use exists at all.
    const rows = (await ctx.container.database.db.execute(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'admin_sessions'` as never,
    )) as unknown as { rows: { indexdef: string }[] };
    const definitions = (rows.rows ?? (rows as unknown as { indexdef: string }[])).map(
      (row) => row.indexdef,
    );

    const usable = definitions.filter(
      (definition) => definition.includes('(expires_at)') && !definition.includes('WHERE'),
    );
    expect(usable).toHaveLength(1);

    // And the partial one is still there, because live-session lookups want it.
    expect(
      definitions.some(
        (definition) =>
          definition.includes('expires_at') && definition.includes('revoked_at IS NULL'),
      ),
    ).toBe(true);
  }, 30_000);
});

describe('review round 17', () => {
  it('rate-limits guesses at the current password', async () => {
    // This endpoint verifies a password and was not throttled at all, so an
    // attacker holding a stolen session could guess without limit — each guess
    // spending a production-cost KDF, and success converting a session that
    // expires into a credential that does not.
    const limit = ctx.container.config.LOGIN_MAX_ATTEMPTS_PER_USERNAME;
    const actor = adminActorFor(owner);

    for (let attempt = 0; attempt < limit; attempt += 1) {
      await expect(
        ctx.container.adminManagement.changeOwnPassword(tenantA, actor, {
          currentPassword: `wrong-${attempt}`,
          newPassword: 'a-brand-new-password',
        }),
      ).rejects.toMatchObject({ code: IDENTITY_ERROR_CODES.AUTH_INVALID_CREDENTIALS });
    }

    // Past the limit the guess is refused before the KDF runs at all.
    await expect(
      ctx.container.adminManagement.changeOwnPassword(tenantA, actor, {
        currentPassword: 'wrong-again',
        newPassword: 'a-brand-new-password',
      }),
    ).rejects.toMatchObject({ code: IDENTITY_ERROR_CODES.AUTH_RATE_LIMITED });
  }, 60_000);

  it('shares one counter with login, so neither door is a way around the other', async () => {
    // Separate counters would let an attacker locked out of login carry on
    // guessing the same credential on the rotation endpoint.
    const limit = ctx.container.config.LOGIN_MAX_ATTEMPTS_PER_USERNAME;
    const actor = adminActorFor(owner);

    for (let attempt = 0; attempt < limit; attempt += 1) {
      await expect(
        ctx.container.adminManagement.changeOwnPassword(tenantA, actor, {
          currentPassword: `wrong-${attempt}`,
          newPassword: 'a-brand-new-password',
        }),
      ).rejects.toThrow();
    }

    await expect(
      ctx.container.auth.login(
        tenantA,
        anonymous,
        { username: owner.username, password: owner.password },
        { ip: null, userAgent: 'vitest' },
      ),
    ).rejects.toMatchObject({ code: IDENTITY_ERROR_CODES.AUTH_RATE_LIMITED });
  }, 60_000);

  it('does not count a rotation whose password was correct', async () => {
    const actor = adminActorFor(owner);
    await ctx.container.adminManagement.changeOwnPassword(tenantA, actor, {
      currentPassword: owner.password,
      newPassword: 'a-completely-different-password',
    });

    const [row] = await ctx.container.database.db
      .select()
      .from(adminLoginThrottle)
      .where(eq(adminLoginThrottle.subject, owner.username));
    // The reservation went back: rotating a password must not rate-limit the
    // person doing it.
    expect(row?.failedCount ?? 0).toBe(0);
  }, 60_000);

  it('gives the reservation back when login fails before any verdict', async () => {
    // A transient failure between reserving and judging — a lookup that times
    // out, say, which the new statement timeout makes MORE likely — was counted
    // as a failed attempt by somebody who never submitted one.
    const admins = ctx.container.admins as unknown as Record<string, unknown>;
    const real = ctx.container.admins.findCredentialsByUsername.bind(ctx.container.admins);
    admins['findCredentialsByUsername'] = async () => {
      throw new Error('database is unavailable');
    };

    try {
      await expect(
        ctx.container.auth.login(
          tenantA,
          anonymous,
          { username: owner.username, password: owner.password },
          { ip: '203.0.113.7', userAgent: 'vitest' },
        ),
      ).rejects.toThrow('database is unavailable');
    } finally {
      admins['findCredentialsByUsername'] = real;
    }

    const rows = await ctx.container.database.db
      .select()
      .from(adminLoginThrottle)
      .where(eq(adminLoginThrottle.subject, owner.username));
    expect(rows[0]?.failedCount ?? 0).toBe(0);

    // And the correct password still works immediately afterwards.
    await expect(
      ctx.container.auth.login(
        tenantA,
        anonymous,
        { username: owner.username, password: owner.password },
        { ip: '203.0.113.7', userAgent: 'vitest' },
      ),
    ).resolves.toBeDefined();
  }, 60_000);

  it('can find dispatchable work without walking a paused tenant backlog', async () => {
    // The eligibility filter was a correlated EXISTS, so proving a stopped
    // tenant's backlog held nothing dispatchable meant inspecting every paused
    // row — on every relay poll and every readiness check. Under the statement
    // timeout, a deliberately paused installation would start reporting errors
    // instead of sitting healthily idle.
    const rows = (await ctx.container.database.db.execute(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'outbox_messages'` as never,
    )) as unknown as { rows: { indexdef: string }[] };
    const definitions = (rows.rows ?? (rows as unknown as { indexdef: string }[])).map(
      (row) => row.indexdef,
    );
    expect(
      definitions.some(
        (definition) =>
          definition.includes('tenant_id') &&
          definition.includes('occurred_at') &&
          definition.includes('published_at IS NULL'),
      ),
    ).toBe(true);

    // And the behaviour the filter exists for is unchanged: a stopped tenant's
    // messages are still left unclaimed rather than dispatched or dropped.
    expect(await ctx.container.relay.lagMs()).toBe(0);
  }, 30_000);
});
