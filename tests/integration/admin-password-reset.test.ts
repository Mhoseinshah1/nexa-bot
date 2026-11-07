import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  IDENTITY_ERROR_CODES,
  isNexaError,
  type ActorContext,
  type CorrelationId,
} from '@nexa/contracts';
import {
  adminLoginThrottle,
  admins,
  auditLogs,
  operationalEvents,
} from '../../apps/api/src/infrastructure/persistence/schema';
import { ServerPasswordRecovery } from '../../apps/api/src/modules/platform/identity/application/server-password-recovery';
import {
  describeFailure,
  parsePasswordResetArgs,
  PasswordResetArgsError,
  readPasswordFromStdin,
  resolveResetScope,
} from '../../apps/api/src/admin-password-reset.cli';
import { Readable } from 'node:stream';
import { createAdmin, createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * `botctl admin reset-password`, against a real database.
 *
 * What matters is in rows and in one verifier: the stored hash must verify with the SAME
 * hasher login uses, the administrator's lockout must be gone and nobody else's touched,
 * and an unknown username must change nothing.
 */

let ctx: TestContext;
const OLD = 'the-old-password-123';
const NEW = 'a-brand-new-password-456';

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await ctx.reset();
  await createAdmin(ctx.container, tenantA, {
    username: 'owner',
    password: OLD,
    roleKeys: ['owner'],
  });
  await createAdmin(ctx.container, tenantA, {
    username: 'other',
    password: OLD,
    roleKeys: ['operator'],
  });
});

/** Built from the container's parts, exactly as the CLI builds it. */
function recovery(): ServerPasswordRecovery {
  return new ServerPasswordRecovery({
    uow: ctx.container.uow,
    admins: ctx.container.admins,
    sessions: ctx.container.sessions,
    throttle: ctx.container.loginThrottle,
    hasher: ctx.container.hasher,
    audit: ctx.container.audit,
    opsLog: ctx.container.opsLog,
    clock: ctx.container.clock,
    ids: ctx.container.ids,
  });
}

async function storedHash(username: string): Promise<string> {
  const [row] = await ctx.container.database.db
    .select({ hash: admins.passwordHash })
    .from(admins)
    .where(and(eq(admins.tenantId, tenantA.tenantId as string), eq(admins.username, username)));
  return row!.hash;
}

async function lockOut(username: string): Promise<void> {
  const anon: ActorContext = {
    type: 'API',
    id: null,
    label: null,
    surface: 'WEB',
    correlationId: 'test-correlation' as CorrelationId,
  };
  for (let i = 0; i < 3; i += 1) {
    await ctx.container.auth
      .login(
        tenantA,
        anon,
        { username, password: 'wrong-wrong-wrong' },
        { ip: null, userAgent: 'vitest' },
      )
      .catch(() => undefined);
  }
}

async function throttleRows(username: string): Promise<number> {
  const rows = await ctx.container.database.db
    .select({ s: adminLoginThrottle.subject })
    .from(adminLoginThrottle)
    .where(
      and(eq(adminLoginThrottle.subjectKind, 'USERNAME'), eq(adminLoginThrottle.subject, username)),
    );
  return rows.length;
}

describe('ServerPasswordRecovery', () => {
  it('stores a hash the login verifier accepts, and the old password stops working', async () => {
    await recovery().resetPasswordFromServer(tenantA, { username: ' Owner ', password: NEW });
    const hash = await storedHash('owner');
    expect(await ctx.container.hasher.verify(NEW, hash)).toBe(true);
    expect(await ctx.container.hasher.verify(OLD, hash)).toBe(false);
    expect(hash).not.toContain(NEW);
    // And through the real login path, not only the hasher.
    const anon: ActorContext = {
      type: 'API',
      id: null,
      label: null,
      surface: 'WEB',
      correlationId: 'test-correlation' as CorrelationId,
    };
    const signedIn = await ctx.container.auth.login(
      tenantA,
      anon,
      { username: 'owner', password: NEW },
      { ip: null, userAgent: 'vitest' },
    );
    expect(signedIn).toBeDefined();
  });

  it('clears that administrator throttle rows and leaves everyone else untouched', async () => {
    await lockOut('owner');
    await lockOut('other');
    expect(await throttleRows('owner')).toBe(1);
    expect(await throttleRows('other')).toBe(1);
    await recovery().resetPasswordFromServer(tenantA, { username: 'owner', password: NEW });
    expect(await throttleRows('owner')).toBe(0);
    expect(await throttleRows('other')).toBe(1);
  });

  it('refuses an unknown username and changes nothing', async () => {
    const before = await storedHash('owner');
    await lockOut('owner');
    const error = await recovery()
      .resetPasswordFromServer(tenantA, { username: 'nobody', password: NEW })
      .catch((e: unknown) => e);
    expect(isNexaError(error) && error.code === IDENTITY_ERROR_CODES.ADMIN_NOT_FOUND).toBe(true);
    expect(await storedHash('owner')).toBe(before);
    expect(await throttleRows('owner')).toBe(1);
    expect(describeFailure(error)).toContain('وجود ندارد');
  });

  it('enforces the application password policy before touching anything', async () => {
    const before = await storedHash('owner');
    await expect(
      recovery().resetPasswordFromServer(tenantA, { username: 'owner', password: 'short' }),
    ).rejects.toThrow();
    expect(await storedHash('owner')).toBe(before);
  });

  it('records an audit row and a WARN that carry no secret', async () => {
    await recovery().resetPasswordFromServer(tenantA, { username: 'owner', password: NEW });
    const audit = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'admin.password_reset'));
    expect(audit).toHaveLength(1);
    const events = await ctx.container.database.db
      .select()
      .from(operationalEvents)
      .where(eq(operationalEvents.code, 'admin.password_reset'));
    expect(events).toHaveLength(1);
    const dump = JSON.stringify([audit, events]);
    expect(dump).not.toContain(NEW);
    expect(dump).not.toContain(await storedHash('owner'));
  });
});

describe('one tenant of many, under row-level security (ADR-0037)', () => {
  /*
   * The suite's container runs as nexa_app. Tenant B (slug `globex`) also has an `owner`;
   * `--tenant globex` must reset B's and nobody else's. MUTATION: make
   * `resolveResetScope` ignore its slug (always the primary) — this case fails.
   */
  const hashIn = async (tenantId: string, username: string): Promise<string> => {
    const [row] = await ctx.container.database.db
      .select({ hash: admins.passwordHash })
      .from(admins)
      .where(and(eq(admins.tenantId, tenantId), eq(admins.username, username)));
    return row!.hash;
  };
  const throttleIn = async (tenantId: string, username: string): Promise<number> =>
    (
      await ctx.container.database.db
        .select({ s: adminLoginThrottle.subject })
        .from(adminLoginThrottle)
        .where(
          and(
            eq(adminLoginThrottle.tenantId, tenantId),
            eq(adminLoginThrottle.subjectKind, 'USERNAME'),
            eq(adminLoginThrottle.subject, username),
          ),
        )
    ).length;

  it('`--tenant <slug>` resets that tenant’s administrator only; no slug means the primary', async () => {
    await createAdmin(ctx.container, tenantB, {
      username: 'owner',
      password: OLD,
      roleKeys: ['owner'],
    });
    await lockOut('owner');
    const a = tenantA.tenantId as string;
    const b = tenantB.tenantId as string;
    const aBefore = await hashIn(a, 'owner');

    // Resolved unbound, as the CLI does: the directory reads take the system path.
    const scopeB = await resolveResetScope(ctx.container.tenants, 'globex');
    expect(scopeB).toEqual({ tenantId: b, botInstanceId: null });
    expect(await resolveResetScope(ctx.container.tenants, null)).toEqual({
      tenantId: a,
      botInstanceId: null,
    });
    await expect(resolveResetScope(ctx.container.tenants, 'no-such')).rejects.toBeInstanceOf(
      PasswordResetArgsError,
    );

    await recovery().resetPasswordFromServer(scopeB, { username: 'owner', password: NEW });
    expect(await ctx.container.hasher.verify(NEW, await hashIn(b, 'owner'))).toBe(true);
    expect(await hashIn(a, 'owner')).toBe(aBefore);
    expect(await throttleIn(a, 'owner')).toBe(1);
  });
});

describe('the CLI parts', () => {
  it('reads one line from a pipe and refuses a terminal or an empty line', async () => {
    expect(await readPasswordFromStdin(Readable.from([Buffer.from(`${NEW}\n`)]))).toBe(NEW);
    expect(await readPasswordFromStdin(Readable.from([Buffer.from(`${NEW}\r\n`)]))).toBe(NEW);
    await expect(readPasswordFromStdin(Readable.from([Buffer.from('\n')]))).rejects.toBeInstanceOf(
      PasswordResetArgsError,
    );
    const tty = Object.assign(Readable.from([]), { isTTY: true });
    await expect(readPasswordFromStdin(tty)).rejects.toBeInstanceOf(PasswordResetArgsError);
  });

  it('parses strictly and never accepts a password argument', () => {
    expect(parsePasswordResetArgs(['--username', 'owner'])).toEqual({
      username: 'owner',
      tenantSlug: null,
    });
    expect(parsePasswordResetArgs(['--username', 'owner', '--tenant', 't1']).tenantSlug).toBe('t1');
    expect(() => parsePasswordResetArgs(['--username', 'owner', '--password', 'x'])).toThrow(
      PasswordResetArgsError,
    );
    expect(() => parsePasswordResetArgs([])).toThrow(PasswordResetArgsError);
  });
});
