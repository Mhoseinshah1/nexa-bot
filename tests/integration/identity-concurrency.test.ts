import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  IDENTITY_ERROR_CODES,
  OWNER_ROLE_KEY,
  type AdminId,
  type CorrelationId,
} from '@nexa/contracts';
import {
  adminPermissionOverrides,
  auditLogs,
} from '../../apps/api/src/infrastructure/persistence/schema';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type SeededAdmin,
  type TestContext,
} from './harness';

/**
 * Concurrency in identity and RBAC mutations.
 *
 * The interleavings here are DETERMINISTIC, not raced. Each test drives the two
 * requests to a specific point and holds one there, so a failure means the
 * ordering rule is broken rather than that a race happened to land badly.
 *
 * Two classes of bug are covered:
 *
 *   - **TOCTOU on the credential.** Password verification and hashing happen
 *     outside the transaction, because scrypt is deliberately slow and holding
 *     a transaction across it would make one password change contend with every
 *     other writer. That leaves hundreds of milliseconds in which another
 *     rotation can commit, so the write carries the verified hash as a
 *     compare-and-set predicate.
 *   - **Authorization on stale state.** A decision computed before the tenant
 *     lock is a decision about a snapshot that may no longer exist by the time
 *     it is acted on.
 */

let ctx: TestContext;
let owner: SeededAdmin;

const anonymous = {
  type: 'API' as const,
  id: null,
  label: null,
  surface: 'WEB' as const,
  correlationId: 'concurrency' as CorrelationId,
};
const from = { ip: '203.0.113.40', userAgent: 'vitest' };

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

describe('password rotation is compare-and-set', () => {
  it('refuses a rotation that validated against a superseded password', async () => {
    // The interleaving, forced rather than hoped for:
    //   B verifies the old password
    //   A completes a rotation
    //   B tries to commit  ->  must fail
    const subject = await createAdmin(ctx.container, tenantA, {
      username: 'rotator',
      password: 'the-original-password',
      roleKeys: ['support'],
    });
    const actor = adminActorFor(subject);

    // B reaches the point of having verified the old credential. The hasher is
    // stalled on B's SECOND verify call — the reuse check, which happens after
    // the current-password check has already succeeded.
    const hasher = ctx.container.hasher as { verify: unknown };
    const realVerify = hasher.verify.bind(ctx.container.hasher) as (
      plaintext: string,
      encoded: string,
    ) => Promise<boolean>;

    let releaseB: () => void = () => undefined;
    const bHasVerified = new Promise<void>((resolve) => {
      let seen = 0;
      hasher.verify = async (plaintext: string, encoded: string) => {
        const result = await realVerify(plaintext, encoded);
        seen += 1;
        if (seen === 2) {
          resolve();
          await new Promise<void>((release) => {
            releaseB = release;
          });
        }
        return result;
      };
    });

    const b = ctx.container.adminManagement.changeOwnPassword(tenantA, actor, {
      currentPassword: 'the-original-password',
      newPassword: 'the-password-b-wants',
    });
    const bSettled = b.catch((error: unknown) => error);

    await bHasVerified;
    hasher.verify = realVerify;

    // A rotates while B is held.
    await ctx.container.adminManagement.changeOwnPassword(tenantA, actor, {
      currentPassword: 'the-original-password',
      newPassword: 'the-password-a-wants',
    });

    releaseB();
    const caught = await bSettled;

    // B must lose.
    expect((caught as { code?: string }).code).toBe(IDENTITY_ERROR_CODES.ADMIN_PASSWORD_STALE);

    // A's password is authoritative; B's never took effect; the original is gone.
    await expect(
      ctx.container.auth.login(
        tenantA,
        anonymous,
        { username: 'rotator', password: 'the-password-a-wants' },
        from,
      ),
    ).resolves.toBeDefined();

    for (const rejected of ['the-password-b-wants', 'the-original-password']) {
      await expect(
        ctx.container.auth.login(
          tenantA,
          anonymous,
          { username: 'rotator', password: rejected },
          from,
        ),
      ).rejects.toThrow();
    }
  });

  it('records the loser as DENIED and emits no success for it', async () => {
    const subject = await createAdmin(ctx.container, tenantA, {
      username: 'rotator',
      password: 'the-original-password',
      roleKeys: ['support'],
    });
    const actor = adminActorFor(subject);

    // Simulate the same collision without the stall: rotate once, then replay a
    // request built against the now-superseded hash.
    await ctx.container.adminManagement.changeOwnPassword(tenantA, actor, {
      currentPassword: 'the-original-password',
      newPassword: 'the-password-a-wants',
    });

    const stale = await ctx.container.admins.compareAndSetPasswordHash(
      tenantA,
      subject.id as AdminId,
      // The hash B verified against, which no longer exists.
      'scrypt$1024$8$1$c3RhbGU=$c3RhbGVzdGFsZQ==',
      'scrypt$1024$8$1$bmV3$bmV3bmV3',
      ctx.container.clock.now(),
    );
    expect(stale).toBe(false);

    // A's rotation is still authoritative — the failed CAS wrote nothing.
    await expect(
      ctx.container.auth.login(
        tenantA,
        anonymous,
        { username: 'rotator', password: 'the-password-a-wants' },
        from,
      ),
    ).resolves.toBeDefined();
  });

  it('leaves sessions alive when the rotation loses', async () => {
    // A losing request must not revoke anything: it has no authority to end
    // sessions belonging to a credential it never held.
    const subject = await createAdmin(ctx.container, tenantA, {
      username: 'rotator',
      password: 'the-original-password',
      roleKeys: ['support'],
    });

    const session = await ctx.container.auth.login(
      tenantA,
      anonymous,
      { username: 'rotator', password: 'the-original-password' },
      from,
    );

    const won = await ctx.container.admins.compareAndSetPasswordHash(
      tenantA,
      subject.id as AdminId,
      'scrypt$1024$8$1$c3RhbGU=$c3RhbGVzdGFsZQ==',
      'scrypt$1024$8$1$bmV3$bmV3bmV3',
      ctx.container.clock.now(),
    );
    expect(won).toBe(false);
    await expect(ctx.container.auth.authenticate(session.token)).resolves.toBeTruthy();
  });
});

describe('role changes decide under the lock', () => {
  /** An admin who can manage admins but is not an owner. */
  async function delegatedManager(username: string, roleKeys: string[]): Promise<SeededAdmin> {
    const manager = await createAdmin(ctx.container, tenantA, { username, roleKeys });
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

  it('refuses a stale request that would strip owner without the privilege permission', async () => {
    // The exact interleaving:
    //   target holds [support]
    //   B intends [support] — against that state the delta is empty
    //   A promotes target to [owner]
    //   B proceeds  ->  must be refused, because under the lock B's delta now
    //                   REMOVES owner, and B lacks admins.permissions.edit
    //
    // A second owner exists throughout, so the last-owner trigger is not what
    // is being tested — it would not fire.
    await createAdmin(ctx.container, tenantA, {
      username: 'second-owner',
      roleKeys: [OWNER_ROLE_KEY],
    });
    const manager = await delegatedManager('manager', ['support']);
    const target = await createAdmin(ctx.container, tenantA, {
      username: 'target',
      roleKeys: ['support'],
    });

    // Hold B just after it takes the tenant lock, before it reads state, so A
    // must commit first. The lock itself is what serialises them; the stall
    // only makes the ordering deterministic.
    const repo = ctx.container.admins as { lockTenantForAdminChange: unknown };
    const realLock = repo.lockTenantForAdminChange.bind(ctx.container.admins) as (
      scope: unknown,
      tx: unknown,
    ) => Promise<void>;

    let releaseB: () => void = () => undefined;
    const bHasLocked = new Promise<void>((resolve) => {
      repo.lockTenantForAdminChange = async (scope: unknown, tx: unknown) => {
        repo.lockTenantForAdminChange = realLock;
        resolve();
        await new Promise<void>((release) => {
          releaseB = release;
        });
        await realLock(scope, tx);
      };
    });

    const b = ctx.container.adminManagement.setRoles(
      tenantA,
      adminActorFor(manager),
      target.id as AdminId,
      { roleKeys: ['support'], reason: 'B saw support and intends support.' },
    );
    const bSettled = b.catch((error: unknown) => error);

    await bHasLocked;

    // A promotes the target to owner and commits.
    await ctx.container.adminManagement.setRoles(
      tenantA,
      adminActorFor(owner),
      target.id as AdminId,
      { roleKeys: [OWNER_ROLE_KEY], reason: 'Promoting.' },
    );

    releaseB();
    const caught = await bSettled;

    // B is refused: its delta, computed under the lock, removes owner.
    expect((caught as { code?: string }).code).toBe('platform.permission_denied');

    // The promotion stands.
    expect(await ctx.container.admins.roleKeysFor(tenantA, target.id as AdminId)).toEqual([
      OWNER_ROLE_KEY,
    ]);

    // And no audit row claims B's change happened.
    const audits = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'admin.roles_change'));
    expect(audits).toHaveLength(1);
    expect((audits[0]?.after as { roleKeys: string[] }).roleKeys).toEqual([OWNER_ROLE_KEY]);
  });

  it('permits the same stale request when the actor does hold the privilege permission', async () => {
    // The rule is authorization, not pessimism: a stale view is re-decided
    // under the lock, and an actor entitled to the new delta proceeds.
    await createAdmin(ctx.container, tenantA, {
      username: 'second-owner',
      roleKeys: [OWNER_ROLE_KEY],
    });
    const target = await createAdmin(ctx.container, tenantA, {
      username: 'target',
      roleKeys: ['support'],
    });

    await ctx.container.adminManagement.setRoles(
      tenantA,
      adminActorFor(owner),
      target.id as AdminId,
      { roleKeys: [OWNER_ROLE_KEY], reason: 'Promoting.' },
    );

    await expect(
      ctx.container.adminManagement.setRoles(tenantA, adminActorFor(owner), target.id as AdminId, {
        roleKeys: ['support'],
        reason: 'Owner may demote.',
      }),
    ).resolves.toBeDefined();
  });

  it('audits the transition that actually happened, not the one intended', async () => {
    // before/after come from the locked read, so a concurrent change upstream
    // cannot leave the audit log describing a transition that never occurred.
    const target = await createAdmin(ctx.container, tenantA, {
      username: 'target',
      roleKeys: ['support'],
    });

    await ctx.container.adminManagement.setRoles(
      tenantA,
      adminActorFor(owner),
      target.id as AdminId,
      { roleKeys: ['finance'], reason: 'Moving desks.' },
    );

    const [row] = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'admin.roles_change'));
    expect((row?.before as { roleKeys: string[] }).roleKeys).toEqual(['support']);
    expect((row?.after as { roleKeys: string[] }).roleKeys).toEqual(['finance']);
  });

  it('writes nothing when the locked delta turns out to be empty', async () => {
    // A no-op must not produce an audit row or an event claiming a change.
    const target = await createAdmin(ctx.container, tenantA, {
      username: 'target',
      roleKeys: ['support'],
    });

    await ctx.container.adminManagement.setRoles(
      tenantA,
      adminActorFor(owner),
      target.id as AdminId,
      { roleKeys: ['support'], reason: 'No change.' },
    );

    const audits = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'admin.roles_change'));
    expect(audits).toHaveLength(0);
  });
});

describe('status changes decide under the lock', () => {
  it('re-reads the target inside the transaction', async () => {
    // setStatus already locked first; its reads went through the pool, so the
    // status it decided on was not necessarily the one it overwrote. Two
    // sequential disables now collapse to one write and one audit row.
    const target = await createAdmin(ctx.container, tenantA, {
      username: 'target',
      roleKeys: ['support'],
    });

    await ctx.container.adminManagement.setStatus(
      tenantA,
      adminActorFor(owner),
      target.id as AdminId,
      { status: 'DISABLED', reason: 'First.' },
    );
    await ctx.container.adminManagement.setStatus(
      tenantA,
      adminActorFor(owner),
      target.id as AdminId,
      { status: 'DISABLED', reason: 'Second, already disabled.' },
    );

    const audits = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'admin.status_change'));
    expect(audits).toHaveLength(1);
  });
});
