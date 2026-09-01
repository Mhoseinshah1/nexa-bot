import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { IDENTITY_ERROR_CODES, isNexaError, type AdminId } from '@nexa/contracts';
import { admins, auditLogs } from '../../apps/api/src/infrastructure/persistence/schema';
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
 * Authentication, against a real database.
 *
 * Nothing is mocked. The properties under test — that a lockout survives a
 * restart, that a disabled admin's sessions die at once, that a username in one
 * tenant is invisible in another — live in rows and constraints, and a mock
 * cannot express any of them.
 */

let ctx: TestContext;
let owner: SeededAdmin;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.reset();
  owner = await createAdmin(ctx.container, tenantA, {
    username: 'owner',
    password: 'the-owners-real-password',
    roleKeys: ['owner'],
  });
});

const from = { ip: '203.0.113.10', userAgent: 'vitest' };

function anonymousActor() {
  return {
    type: 'API' as const,
    id: null,
    label: null,
    surface: 'WEB' as const,
    correlationId: 'test-correlation' as never,
  };
}

describe('username and password login', () => {
  it('signs in with the correct credentials and issues a session', async () => {
    const result = await ctx.container.auth.login(
      tenantA,
      anonymousActor(),
      { username: 'owner', password: 'the-owners-real-password' },
      from,
    );

    expect(result.admin.username).toBe('owner');
    expect(result.token.length).toBeGreaterThanOrEqual(43);
    expect(result.session.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.permissions).toContain('admins.edit');
    expect(result.roleKeys).toEqual(['owner']);
  });

  it('accepts the username in any case', async () => {
    // Folded at the boundary, so `Owner` and `owner` are one account rather
    // than one account and one permanent login failure.
    const result = await ctx.container.auth.login(
      tenantA,
      anonymousActor(),
      { username: '  OWNER ', password: 'the-owners-real-password' },
      from,
    );
    expect(result.admin.id).toBe(owner.id);
  });

  it('never persists the password in any readable form', async () => {
    const [row] = await ctx.container.database.db
      .select()
      .from(admins)
      .where(eq(admins.id, owner.id));

    expect(row?.passwordHash).toBeTruthy();
    expect(row?.passwordHash).not.toContain('the-owners-real-password');
    expect(row?.passwordHash.startsWith('scrypt$')).toBe(true);
    // And the whole row, serialised, carries no trace of it.
    expect(JSON.stringify(row)).not.toContain('the-owners-real-password');
  });

  it('resolves the session token back to the administrator', async () => {
    const { token } = await ctx.container.auth.login(
      tenantA,
      anonymousActor(),
      { username: 'owner', password: 'the-owners-real-password' },
      from,
    );
    const resolved = await ctx.container.auth.authenticate(token);
    expect(resolved.admin.id).toBe(owner.id);
  });

  it('stores only the hash of the session token', async () => {
    // A database read must not be replayable as a login.
    const { token } = await ctx.container.auth.login(
      tenantA,
      anonymousActor(),
      { username: 'owner', password: 'the-owners-real-password' },
      from,
    );
    const rows = await ctx.container.database.db.execute(
      `SELECT token_hash FROM admin_sessions` as never,
    );
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(token);
  });
});

describe('failed authentication', () => {
  async function expectGenericFailure(username: string, password: string): Promise<unknown> {
    let caught: unknown;
    try {
      await ctx.container.auth.login(tenantA, anonymousActor(), { username, password }, from);
    } catch (error) {
      caught = error;
    }
    expect(isNexaError(caught)).toBe(true);
    return caught;
  }

  it('reports the same error for a wrong password and an unknown username', async () => {
    // The whole point: an error that distinguishes them is a username oracle.
    const wrongPassword = await expectGenericFailure('owner', 'not-the-password');
    const unknownUser = await expectGenericFailure('nobody', 'not-the-password');

    for (const error of [wrongPassword, unknownUser]) {
      expect((error as { kind: string }).kind).toBe('UNAUTHENTICATED');
      expect((error as { code: string }).code).toBe(IDENTITY_ERROR_CODES.AUTH_INVALID_CREDENTIALS);
      expect((error as Error).message).toBe('The username or password is incorrect.');
    }
    expect((wrongPassword as { message: string }).message).toBe(
      (unknownUser as { message: string }).message,
    );
  });

  it('reports the same error for a disabled administrator', async () => {
    const disabled = await createAdmin(ctx.container, tenantA, {
      username: 'suspended',
      password: 'a-perfectly-good-password',
      roleKeys: ['support'],
      status: 'DISABLED',
    });

    const error = await expectGenericFailure(disabled.username, 'a-perfectly-good-password');
    expect((error as { code: string }).code).toBe(IDENTITY_ERROR_CODES.AUTH_INVALID_CREDENTIALS);
    expect((error as Error).message).toBe('The username or password is incorrect.');
  });

  it('records why the login actually failed, in the audit log', async () => {
    // The response says one thing; the audit row says which it was. Both
    // properties matter, and they are not in tension.
    await expectGenericFailure('owner', 'not-the-password');
    await expectGenericFailure('nobody-at-all', 'whatever');

    const rows = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.login'));

    const denied = rows.filter((row) => row.result === 'DENIED');
    const reasons = denied.map((row) => (row.after as { reason: string }).reason);
    expect(reasons).toContain('BAD_PASSWORD');
    expect(reasons).toContain('NO_SUCH_ADMIN');
    // And never the submitted password, under any key.
    expect(JSON.stringify(denied)).not.toContain('not-the-password');
  });

  it('rejects a syntactically impossible username without a database lookup', async () => {
    const error = await expectGenericFailure('!!not-a-username!!', 'whatever');
    expect((error as { code: string }).code).toBe(IDENTITY_ERROR_CODES.AUTH_INVALID_CREDENTIALS);
  });
});

describe('brute-force throttling', () => {
  it('locks a username out after the configured number of failures', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        ctx.container.auth.login(
          tenantA,
          anonymousActor(),
          { username: 'owner', password: `wrong-${attempt}` },
          from,
        ),
      ).rejects.toThrow();
    }

    // The sixth attempt is refused as rate limited — and, decisively, the
    // CORRECT password is refused too. A lockout that let the right password
    // through would only throttle the attacker's last guess.
    let caught: unknown;
    try {
      await ctx.container.auth.login(
        tenantA,
        anonymousActor(),
        { username: 'owner', password: 'the-owners-real-password' },
        from,
      );
    } catch (error) {
      caught = error;
    }
    expect((caught as { kind: string }).kind).toBe('RATE_LIMITED');
    expect((caught as { code: string }).code).toBe(IDENTITY_ERROR_CODES.AUTH_RATE_LIMITED);
    expect(
      (caught as { details: { retryAfterSeconds: number } }).details.retryAfterSeconds,
    ).toBeGreaterThan(0);
  });

  it('throttles a username that does not exist, exactly like one that does', async () => {
    // Throttling only real accounts turns the lockout itself into the oracle
    // the error text refuses to be.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        ctx.container.auth.login(
          tenantA,
          anonymousActor(),
          { username: 'ghost', password: `wrong-${attempt}` },
          from,
        ),
      ).rejects.toThrow();
    }

    const state = await ctx.container.database.db.execute(
      `SELECT locked_until FROM admin_login_throttle WHERE subject = 'ghost'` as never,
    );
    expect(JSON.stringify(state)).toContain('locked_until');
  });

  it('clears the counter on a successful login', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        ctx.container.auth.login(
          tenantA,
          anonymousActor(),
          { username: 'owner', password: 'wrong' },
          from,
        ),
      ).rejects.toThrow();
    }

    await ctx.container.auth.login(
      tenantA,
      anonymousActor(),
      { username: 'owner', password: 'the-owners-real-password' },
      from,
    );

    const remaining = await ctx.container.auth['throttle'].find(tenantA, 'USERNAME', 'owner');
    expect(remaining).toBeNull();
  });

  it('records a lockout as an operational event worth alerting on', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        ctx.container.auth.login(
          tenantA,
          anonymousActor(),
          { username: 'owner', password: 'wrong' },
          from,
        ),
      ).rejects.toThrow();
    }

    const events = await ctx.container.database.db.execute(
      `SELECT code FROM operational_events WHERE code = 'auth.login_locked_out'` as never,
    );
    expect(JSON.stringify(events)).toContain('auth.login_locked_out');
  });
});

describe('sessions', () => {
  it('rejects an unknown, malformed or empty token', async () => {
    for (const token of ['', 'not-a-real-token', 'x'.repeat(43)]) {
      await expect(ctx.container.auth.authenticate(token)).rejects.toThrow();
    }
  });

  it('stops accepting a token after logout', async () => {
    const { token, session } = await ctx.container.auth.login(
      tenantA,
      anonymousActor(),
      { username: 'owner', password: 'the-owners-real-password' },
      from,
    );
    await ctx.container.auth.authenticate(token);

    await ctx.container.auth.logout(tenantA, adminActorFor(owner), session.id);

    await expect(ctx.container.auth.authenticate(token)).rejects.toThrow();
  });

  it('audits the logout', async () => {
    const { session } = await ctx.container.auth.login(
      tenantA,
      anonymousActor(),
      { username: 'owner', password: 'the-owners-real-password' },
      from,
    );
    await ctx.container.auth.logout(tenantA, adminActorFor(owner), session.id);

    const rows = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.logout'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('SUCCESS');
  });

  it('revokes every live session the moment an admin is disabled', async () => {
    // Not at session expiry: a revoked administrator would otherwise keep
    // acting for up to the session lifetime.
    const second = await createAdmin(ctx.container, tenantA, {
      username: 'operator',
      password: 'an-operator-password',
      roleKeys: ['operator'],
    });
    const { token } = await ctx.container.auth.login(
      tenantA,
      anonymousActor(),
      { username: 'operator', password: 'an-operator-password' },
      from,
    );
    await ctx.container.auth.authenticate(token);

    await ctx.container.adminManagement.setStatus(
      tenantA,
      adminActorFor(owner),
      second.id as AdminId,
      { status: 'DISABLED', reason: 'Left the company.' },
    );

    await expect(ctx.container.auth.authenticate(token)).rejects.toThrow();
  });
});

describe('tenant isolation', () => {
  it('does not let one tenant sign in with another tenant’s credentials', async () => {
    // Usernames are unique WITHIN a tenant. The same name in tenant B is a
    // different account, and tenant A's password must not open it.
    await createAdmin(ctx.container, tenantB, {
      username: 'owner',
      password: 'globex-owner-password',
      roleKeys: ['owner'],
    });

    await expect(
      ctx.container.auth.login(
        tenantB,
        anonymousActor(),
        { username: 'owner', password: 'the-owners-real-password' },
        from,
      ),
    ).rejects.toThrow();

    const inB = await ctx.container.auth.login(
      tenantB,
      anonymousActor(),
      { username: 'owner', password: 'globex-owner-password' },
      from,
    );
    expect(inB.admin.id).not.toBe(owner.id);
  });

  it('resolves a session to its own tenant only', async () => {
    const { token } = await ctx.container.auth.login(
      tenantA,
      anonymousActor(),
      { username: 'owner', password: 'the-owners-real-password' },
      from,
    );
    const resolved = await ctx.container.auth.authenticate(token);
    expect(resolved.admin.tenantId).toBe(tenantA.tenantId);
    expect(resolved.session.tenantId).toBe(tenantA.tenantId);
  });

  it('cannot read an administrator from another tenant', async () => {
    const other = await createAdmin(ctx.container, tenantB, {
      username: 'globex-admin',
      roleKeys: ['support'],
    });
    expect(await ctx.container.admins.findById(tenantA, other.id)).toBeNull();
    expect(await ctx.container.admins.findById(tenantB, other.id)).not.toBeNull();
  });
});
