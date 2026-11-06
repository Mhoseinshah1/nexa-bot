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
} from '../../apps/api/src/admin-password-reset.cli';
import { Readable } from 'node:stream';
import { createAdmin, createTestContext, tenantA, type TestContext } from './harness';

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
