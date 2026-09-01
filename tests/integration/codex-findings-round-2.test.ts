import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  API_PREFIX,
  AUTH_ROUTES,
  OWNER_ROLE_KEY,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME_SECURE,
  type AdminId,
  type CorrelationId,
} from '@nexa/contracts';
import { createApiApp, resolveInstallationTenant, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { ScryptPasswordHasher } from '../../apps/api/src/infrastructure/crypto/password-hasher';
import {
  adminLoginThrottle,
  adminSessions,
  auditLogs,
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

describe('system roles are synchronised for an installation that already exists', () => {
  it('restores a catalogue permission missing from a seeded role at boot', async () => {
    // `ensureSystemRoles` was written to be re-runnable so an upgrade picks up
    // a permission newly added to a seeded role — and its only production
    // caller was inside the first-owner bootstrap, which returns early once any
    // administrator exists. The upgrade path was unreachable for exactly the
    // installations that needed it, and a missing `owner` permission would then
    // stop ANYONE granting it, since the amplification rule requires a holder.
    await ctx.container.roles.ensureSystemRoles(tenantA);
    const [ownerRole] = await ctx.container.database.db
      .select()
      .from(roles)
      .where(eq(roles.key, OWNER_ROLE_KEY));
    expect(ownerRole).toBeDefined();

    const before = await ctx.container.roles.permissionsForAdmin(tenantA, owner.id as AdminId);
    const dropped = 'admins.permissions.edit';
    expect(before).toContain(dropped);

    // Simulate the state a release would leave: the row exists, the permission
    // the new build expects does not.
    await ctx.container.database.db
      .delete(rolePermissions)
      .where(eq(rolePermissions.permissionKey, dropped));
    expect(
      await ctx.container.roles.permissionsForAdmin(tenantA, owner.id as AdminId),
    ).not.toContain(dropped);

    // What boot now does for an installation that has administrators.
    await resolveInstallationTenant(ctx.container);

    expect(await ctx.container.roles.permissionsForAdmin(tenantA, owner.id as AdminId)).toContain(
      dropped,
    );
  });
});

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
