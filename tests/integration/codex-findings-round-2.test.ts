import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_ROLE_KEY, type AdminId, type CorrelationId } from '@nexa/contracts';
import { ScryptPasswordHasher } from '../../apps/api/src/infrastructure/crypto/password-hasher';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
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
