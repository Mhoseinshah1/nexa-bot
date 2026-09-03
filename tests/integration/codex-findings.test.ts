import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  API_PREFIX,
  AUTH_ROUTES,
  OWNER_ROLE_KEY,
  TELEGRAM_SECRET_TOKEN_HEADER,
  type AdminId,
  type CorrelationId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { ScryptPasswordHasher } from '../../apps/api/src/infrastructure/crypto/password-hasher';
import {
  adminLoginThrottle,
  adminPermissionOverrides,
  adminSessions,
  botInstances,
} from '../../apps/api/src/infrastructure/persistence/schema';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  migrateOnce,
  resetDatabase,
  tenantA,
  testConfig,
  type SeededAdmin,
  type TestContext,
} from './harness';

/**
 * Regressions for the findings an external review raised on this branch.
 *
 * Each one is a property that was demonstrably absent before the fix, not a
 * restatement of what the code now does.
 */

let ctx: TestContext;
let owner: SeededAdmin;

const anonymous = {
  type: 'API' as const,
  id: null,
  label: null,
  surface: 'WEB' as const,
  correlationId: 'codex' as CorrelationId,
};
const from = { ip: '203.0.113.90', userAgent: 'vitest' };

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

describe('a login cannot outlive the credential that authorised it', () => {
  it('creates no session when a rotation commits during the login', async () => {
    // Verification happens outside any transaction, because scrypt is slow by
    // design. A rotation committing in that gap revokes every session that
    // EXISTS at that moment — and a session inserted afterwards from the old
    // password was not one of them, so it survived. Rotation would then have
    // failed at the one thing it is for.
    const subject = await createAdmin(ctx.container, tenantA, {
      username: 'racer',
      password: 'the-original-password',
      roleKeys: ['support'],
    });

    // Hold the login after it has verified, before it issues a session.
    const hasher = ctx.container.hasher as { verify: unknown };
    const realVerify = hasher.verify.bind(ctx.container.hasher) as (
      plaintext: string,
      encoded: string,
    ) => Promise<boolean>;
    let releaseLogin: () => void = () => undefined;
    const loginHasVerified = new Promise<void>((resolve) => {
      hasher.verify = async (plaintext: string, encoded: string) => {
        hasher.verify = realVerify;
        const result = await realVerify(plaintext, encoded);
        resolve();
        await new Promise<void>((release) => {
          releaseLogin = release;
        });
        return result;
      };
    });

    const login = ctx.container.auth.login(
      tenantA,
      anonymous,
      { username: 'racer', password: 'the-original-password' },
      from,
    );
    const settled = login.catch((error: unknown) => error);

    await loginHasVerified;

    await ctx.container.adminManagement.changeOwnPassword(
      tenantA,
      adminActorFor(subject),
      {
        currentPassword: 'the-original-password',
        newPassword: 'the-rotated-password',
      },
      { ip: null },
    );

    releaseLogin();
    const caught = await settled;

    // Reported as an ordinary credential failure, which is what it is: the
    // password presented is no longer the account's password.
    expect((caught as { code?: string }).code).toBe('auth.invalid_credentials');

    // And decisively: no live session exists for that administrator.
    const live = await ctx.container.database.db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.adminId, subject.id));
    expect(live.filter((row) => row.revokedAt === null)).toHaveLength(0);
  });
});

describe('throttle reservation', () => {
  it('refuses a concurrent burst before it can queue the derivations', async () => {
    // The counter was only read before the KDF and written after it failed, so
    // a burst arriving while the counters were empty all passed the check and
    // every one queued a production-cost, memory-heavy derivation.
    const attempts = 20;
    const outcomes = await Promise.all(
      Array.from({ length: attempts }, (_unused, index) =>
        ctx.container.auth
          .login(
            tenantA,
            anonymous,
            { username: 'owner', password: `wrong-${index}` },
            { ip: null, userAgent: 'vitest' },
          )
          .then(
            () => 'ALLOWED',
            (error: { kind?: string }) => error.kind ?? 'UNKNOWN',
          ),
      ),
    );

    // None succeeded, and the ones past the limit were refused as rate limited
    // rather than each spending a hash first.
    expect(outcomes).not.toContain('ALLOWED');
    expect(outcomes.filter((o) => o === 'RATE_LIMITED').length).toBeGreaterThan(0);

    const [row] = await ctx.container.database.db
      .select()
      .from(adminLoginThrottle)
      .where(eq(adminLoginThrottle.subject, 'owner'));
    // The subject is locked, and the count passed the limit. It need not equal
    // the burst size: once locked, later attempts are refused by the read that
    // precedes the reservation, so they never increment — which is the point.
    expect(row?.lockedUntil).not.toBeNull();
    expect(row?.failedCount).toBeGreaterThanOrEqual(5);
    expect(row?.failedCount).toBeLessThanOrEqual(attempts);
  });

  it('records the lockout as an operational event', async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
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

describe('an unrelated success does not reset the IP limiter', () => {
  it('keeps accumulated IP failures when a different account signs in', async () => {
    // Otherwise anyone holding one valid low-privilege account can spray
    // guesses across administrator names and reset the breadth limiter by
    // periodically signing into their own.
    const mine = await createAdmin(ctx.container, tenantA, {
      username: 'attacker',
      password: 'my-own-account-password',
      roleKeys: ['support'],
    });
    expect(mine.username).toBe('attacker');

    const sharedIp = { ip: '198.51.100.7', userAgent: 'vitest' };

    for (const victim of ['owner', 'finance-lead', 'ops-lead']) {
      await expect(
        ctx.container.auth.login(
          tenantA,
          anonymous,
          { username: victim, password: 'guess' },
          sharedIp,
        ),
      ).rejects.toThrow();
    }

    const before = await ctx.container.auth['throttle'].find(tenantA, 'IP', sharedIp.ip);
    expect(before?.failedCount).toBe(3);

    await ctx.container.auth.login(
      tenantA,
      anonymous,
      { username: 'attacker', password: 'my-own-account-password' },
      sharedIp,
    );

    // The success gives back only its own reservation; the three earlier
    // failures against other usernames remain on the record.
    const after = await ctx.container.auth['throttle'].find(tenantA, 'IP', sharedIp.ip);
    expect(after?.failedCount).toBe(3);

    // The successful account's own username counter is cleared, as it should be.
    expect(await ctx.container.auth['throttle'].find(tenantA, 'USERNAME', 'attacker')).toBeNull();
  });
});

describe('owner status changes need the privilege permission', () => {
  async function managerWithAdminsEdit(): Promise<SeededAdmin> {
    const manager = await createAdmin(ctx.container, tenantA, {
      username: 'manager',
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

  it('refuses to disable an owner with only admins.edit', async () => {
    // Disabling an owner empties their authority exactly as completely as
    // removing the role — the resolver grants a non-ACTIVE admin nothing — so
    // gating one and not the other let plain `admins.edit` neutralise an owner
    // by the back door. A second owner exists, so the last-owner guard is not
    // what refuses this.
    const manager = await managerWithAdminsEdit();
    const secondOwner = await createAdmin(ctx.container, tenantA, {
      username: 'second-owner',
      roleKeys: [OWNER_ROLE_KEY],
    });

    await expect(
      ctx.container.adminManagement.setStatus(
        tenantA,
        adminActorFor(manager),
        secondOwner.id as AdminId,
        { status: 'DISABLED', reason: 'Neutralising an owner.' },
      ),
    ).rejects.toThrow(/permission/i);

    expect((await ctx.container.admins.findById(tenantA, secondOwner.id as AdminId))?.status).toBe(
      'ACTIVE',
    );
  });

  it('refuses to re-enable a disabled owner with only admins.edit', async () => {
    const manager = await managerWithAdminsEdit();
    const disabledOwner = await createAdmin(ctx.container, tenantA, {
      username: 'dormant-owner',
      roleKeys: [OWNER_ROLE_KEY],
      status: 'DISABLED',
    });

    await expect(
      ctx.container.adminManagement.setStatus(
        tenantA,
        adminActorFor(manager),
        disabledOwner.id as AdminId,
        { status: 'ACTIVE', reason: 'Restoring an owner.' },
      ),
    ).rejects.toThrow(/permission/i);
  });

  it('permits both when the actor holds admins.permissions.edit', async () => {
    // Not blanket pessimism: an actor entitled to change privilege still can.
    const secondOwner = await createAdmin(ctx.container, tenantA, {
      username: 'second-owner',
      roleKeys: [OWNER_ROLE_KEY],
    });
    await expect(
      ctx.container.adminManagement.setStatus(
        tenantA,
        adminActorFor(owner),
        secondOwner.id as AdminId,
        { status: 'DISABLED', reason: 'Owner may.' },
      ),
    ).resolves.toBeDefined();
  });

  it('still permits a non-owner status change with plain admins.edit', async () => {
    const manager = await managerWithAdminsEdit();
    const target = await createAdmin(ctx.container, tenantA, {
      username: 'target',
      roleKeys: ['support'],
    });
    await expect(
      ctx.container.adminManagement.setStatus(
        tenantA,
        adminActorFor(manager),
        target.id as AdminId,
        { status: 'DISABLED', reason: 'Ordinary administration.' },
      ),
    ).resolves.toBeDefined();
  });
});

describe('scrypt parameters from the database are validated', () => {
  it('fails one login rather than the endpoint on an impossible parameter', async () => {
    // `N` must be a power of two. `scrypt$3$…` reached OpenSSL, which throws —
    // turning one administrator's login into a 500 that incidentally confirms
    // the account exists.
    const hasher = new ScryptPasswordHasher({ N: 1024, r: 8, p: 1 });
    for (const broken of [
      'scrypt$3$8$1$c2FsdA==$ZGlnZXN0',
      'scrypt$1$8$1$c2FsdA==$ZGlnZXN0',
      `scrypt$${2 ** 30}$8$1$c2FsdA==$ZGlnZXN0`,
      'scrypt$1024$0$1$c2FsdA==$ZGlnZXN0',
      'scrypt$1024$8$0$c2FsdA==$ZGlnZXN0',
      'scrypt$1024$999$1$c2FsdA==$ZGlnZXN0',
    ]) {
      await expect(hasher.verify('anything', broken)).resolves.toBe(false);
      expect(hasher.needsRehash(broken)).toBe(true);
    }
  });

  it('rejects a login against a corrupted stored hash with the generic failure', async () => {
    const subject = await createAdmin(ctx.container, tenantA, {
      username: 'corrupted',
      roleKeys: ['support'],
    });
    await ctx.container.admins.setPasswordHash(
      tenantA,
      subject.id as AdminId,
      'scrypt$3$8$1$c2FsdA==$ZGlnZXN0',
      ctx.container.clock.now(),
    );

    let caught: unknown;
    try {
      await ctx.container.auth.login(
        tenantA,
        anonymous,
        { username: 'corrupted', password: 'anything' },
        from,
      );
    } catch (error) {
      caught = error;
    }
    // The generic credential failure, not an internal error.
    expect((caught as { kind?: string }).kind).toBe('UNAUTHENTICATED');
    expect((caught as { code?: string }).code).toBe('auth.invalid_credentials');
  });
});

describe('the Telegram webhook honours bot status', () => {
  let api: ApiApp;
  const WEBHOOK_SECRET = 'a-sufficiently-long-secret';

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig({
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
  });

  afterAll(async () => {
    await api?.close();
  });

  const ping = (botInstanceId: string, updateId: number) =>
    inject({
      method: 'POST',
      url: `/telegram/webhook/${botInstanceId}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: {
        update_id: updateId,
        message: { message_id: 1, date: 0, chat: { id: 1, type: 'private' }, text: '/ping' },
      },
    });

  it('accepts an update for an ACTIVE bot', async () => {
    expect((await ping(SEED_IDS.botA1, 9001)).statusCode).toBe(201);
  });

  it('refuses an update for a STOPPED bot', async () => {
    // STOPPED and DISABLED are an inbound kill switch, and only mean that if
    // the receiver honours them. `botA2` is seeded STOPPED.
    expect((await ping(SEED_IDS.botA2, 9002)).statusCode).toBe(404);
  });

  it('refuses an update for a DISABLED bot, and records no work for it', async () => {
    await api.container.database.db
      .update(botInstances)
      .set({ status: 'DISABLED' })
      .where(eq(botInstances.id, SEED_IDS.botB1));

    expect((await ping(SEED_IDS.botB1, 9003)).statusCode).toBe(404);

    const keys = await api.container.database.db.execute(
      `SELECT key FROM request_idempotency WHERE key LIKE '%:update:9003'` as never,
    );
    expect(JSON.stringify(keys)).not.toContain('update:9003');
  });
});

describe('the login route checks Origin like every other write', () => {
  let api: ApiApp;
  const ORIGIN = 'https://admin.example.test';

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
  });

  const login = (headers: Record<string, string>) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers,
      payload: { username: 'owner', password: 'the-owners-real-password' },
    });

  it('refuses a login from an unlisted origin', async () => {
    const response = await login({ origin: 'https://evil.example.test' });
    expect(response.statusCode).toBe(403);
    expect(String(response.headers['set-cookie'] ?? '')).not.toContain('nexa_admin_session=');
  });

  it('refuses a login with no Origin at all', async () => {
    const response = await login({});
    expect(response.statusCode).toBe(403);
  });

  it('permits a login from the configured origin', async () => {
    const response = await login({ origin: ORIGIN });
    expect(response.statusCode).toBe(201);
    expect(String(response.headers['set-cookie'])).toContain('nexa_admin_session=');
  });
});
