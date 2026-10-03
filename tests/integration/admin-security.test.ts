import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  IDENTITY_ERROR_CODES,
  isNexaError,
  LOGIN_CHALLENGE_MAX_ATTEMPTS,
  type ActorContext,
  type CorrelationId,
} from '@nexa/contracts';
import {
  adminBackupCodes,
  adminLoginChallenges,
  adminPermissionOverrides,
  adminLoginThrottle,
  adminSessions,
  adminTotpFactors,
  auditLogs,
  operationalEvents,
} from '../../apps/api/src/infrastructure/persistence/schema';
import {
  totpForStep,
  totpStepAt,
} from '../../apps/api/src/modules/platform/identity/application/totp';
import {
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  testConfig,
  type SeededAdmin,
  type TestContext,
} from './harness';

/**
 * Phase D2 — admin security, against a real database.
 *
 * Every property here lives in a row or a predicate: a step consumed once, a backup code
 * spent once, a challenge that is not a session, a revoked cookie refused, a throttle
 * that a correct password does not reset. A mock could not express any of them.
 */

let ctx: TestContext;
let owner: SeededAdmin;
let manager: SeededAdmin;
let support: SeededAdmin;

const OWNER_PASSWORD = 'the-owners-real-password';
const from = { ip: '203.0.113.10', userAgent: 'vitest' };

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
    password: OWNER_PASSWORD,
    roleKeys: ['owner'],
  });
  manager = await createAdmin(ctx.container, tenantA, {
    username: 'manager',
    password: 'the-managers-password',
    roleKeys: ['operator'],
  });
  // A DELEGATED administrator manager: may edit administrators, is not an owner.
  for (const permissionKey of ['admins.view', 'admins.edit']) {
    await ctx.container.database.db.insert(adminPermissionOverrides).values({
      tenantId: tenantA.tenantId as string,
      adminId: manager.id,
      permissionKey,
      effect: 'GRANT',
      reason: 'test: delegated admin manager',
    });
  }
  support = await createAdmin(ctx.container, tenantA, {
    username: 'support',
    password: 'the-support-password',
    roleKeys: ['support'],
  });
});

function anonymous(): ActorContext {
  return {
    type: 'API',
    id: null,
    label: null,
    surface: 'WEB',
    correlationId: 'test-correlation' as CorrelationId,
  };
}

/** An actor carrying the session it signed in with, as the HTTP surface builds it. */
function actorWithSession(admin: SeededAdmin, sessionId: string): ActorContext {
  return {
    type: 'WEB_ADMIN',
    id: admin.id,
    label: admin.username,
    surface: 'WEB',
    correlationId: 'test-correlation' as CorrelationId,
    sessionId,
    ip: from.ip,
    userAgent: from.userAgent,
  };
}

async function passwordLogin(admin: SeededAdmin, scope = tenantA) {
  const result = await ctx.container.auth.login(
    scope,
    anonymous(),
    { username: admin.username, password: admin.password },
    from,
  );
  return { token: result.token, actor: actorWithSession(admin, result.session.id), result };
}

async function codeOf(error: Promise<unknown>): Promise<string> {
  try {
    await error;
  } catch (caught) {
    if (isNexaError(caught)) return caught.code;
    throw caught;
  }
  throw new Error('expected a failure');
}

/** The code for the current step, offset by `steps` (within the ±1 skew). */
function code(secret: string, steps = 0): string {
  return totpForStep(secret, totpStepAt(ctx.container.clock.now()) + steps);
}

/** Enrols and activates the owner's factor. Returns the secret and the backup codes. */
async function enableFor(admin: SeededAdmin) {
  const { actor, token } = await passwordLogin(admin);
  const enrolment = await ctx.container.accountSecurity.enrolTotp(
    tenantA,
    actor,
    { password: admin.password },
    { ip: from.ip },
  );
  // The step BEFORE now, so later tests can use the current and next step freely.
  const { backupCodes } = await ctx.container.accountSecurity.activateTotp(tenantA, actor, {
    code: code(enrolment.secret, -1),
  });
  return { secret: enrolment.secret, backupCodes, actor, token, enrolment };
}

async function challengeFor(admin: SeededAdmin): Promise<string> {
  const outcome = await ctx.container.auth.signIn(
    tenantA,
    anonymous(),
    { username: admin.username, password: admin.password },
    from,
  );
  expect(outcome.kind).toBe('SECOND_FACTOR_REQUIRED');
  if (outcome.kind !== 'SECOND_FACTOR_REQUIRED') throw new Error('unreachable');
  return outcome.challengeToken;
}

async function liveSessions(adminId: string): Promise<number> {
  const rows = await ctx.container.database.db
    .select({ id: adminSessions.id })
    .from(adminSessions)
    .where(
      and(
        eq(adminSessions.adminId, adminId),
        sql`${adminSessions.revokedAt} IS NULL AND ${adminSessions.expiresAt} > now()`,
      ),
    );
  return rows.length;
}

describe('enrolment', () => {
  it('needs the password before anything is created', async () => {
    const { actor } = await passwordLogin(owner);
    expect(
      await codeOf(
        ctx.container.accountSecurity.enrolTotp(tenantA, actor, { password: 'wrong' }, from),
      ),
    ).toBe(IDENTITY_ERROR_CODES.AUTH_INVALID_CREDENTIALS);
    const rows = await ctx.container.database.db.select().from(adminTotpFactors);
    expect(rows).toHaveLength(0);
  });

  it('shows the secret once, stores it encrypted, and stays PENDING until a code', async () => {
    const { actor } = await passwordLogin(owner);
    const enrolment = await ctx.container.accountSecurity.enrolTotp(
      tenantA,
      actor,
      { password: OWNER_PASSWORD },
      from,
    );
    expect(enrolment.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(enrolment.otpauthUri).toContain(`secret=${enrolment.secret}`);
    expect(enrolment.otpauthUri).toContain('otpauth://totp/Nexa:owner');
    // The repository's own QR encoder, as a PNG data URL.
    expect(enrolment.qrPngDataUrl?.startsWith('data:image/png;base64,')).toBe(true);

    const [row] = await ctx.container.database.db.select().from(adminTotpFactors);
    expect(row?.state).toBe('PENDING');
    expect(row?.totpSecretCiphertext.startsWith('v2.')).toBe(true);
    expect(JSON.stringify(row)).not.toContain(enrolment.secret);
    expect((await ctx.container.accountSecurity.overview(tenantA, actor)).totp.state).toBe(
      'PENDING',
    );

    // A pending factor does not change sign-in.
    await expect(passwordLogin(owner)).resolves.toBeDefined();
  });

  it('refuses a wrong code and activates on a right one, with ten hashed backup codes', async () => {
    const { actor } = await passwordLogin(owner);
    const enrolment = await ctx.container.accountSecurity.enrolTotp(
      tenantA,
      actor,
      { password: OWNER_PASSWORD },
      from,
    );
    const wrong = code(enrolment.secret) === '000000' ? '111111' : '000000';
    expect(
      await codeOf(ctx.container.accountSecurity.activateTotp(tenantA, actor, { code: wrong })),
    ).toBe(IDENTITY_ERROR_CODES.AUTH_SECOND_FACTOR_INVALID);
    expect((await ctx.container.accountSecurity.overview(tenantA, actor)).totp.state).toBe(
      'PENDING',
    );

    const { backupCodes } = await ctx.container.accountSecurity.activateTotp(tenantA, actor, {
      code: code(enrolment.secret),
    });
    expect(backupCodes).toHaveLength(10);
    const overview = await ctx.container.accountSecurity.overview(tenantA, actor);
    expect(overview.totp.state).toBe('ACTIVE');
    expect(overview.backupCodes.remaining).toBe(10);

    const stored = JSON.stringify(await ctx.container.database.db.select().from(adminBackupCodes));
    for (const backup of backupCodes) {
      expect(stored).not.toContain(backup);
      expect(stored).not.toContain(backup.replace(/-/g, ''));
    }
  });

  it('refuses an enrolment that has waited too long', async () => {
    const { actor } = await passwordLogin(owner);
    const enrolment = await ctx.container.accountSecurity.enrolTotp(
      tenantA,
      actor,
      { password: OWNER_PASSWORD },
      from,
    );
    await ctx.container.database.db
      .update(adminTotpFactors)
      .set({ createdAt: new Date(Date.now() - 16 * 60_000) });
    expect(
      await codeOf(
        ctx.container.accountSecurity.activateTotp(tenantA, actor, {
          code: code(enrolment.secret),
        }),
      ),
    ).toBe(IDENTITY_ERROR_CODES.ADMIN_SECOND_FACTOR_NOT_PENDING);
  });

  it('refuses to enrol over an active factor', async () => {
    const { actor } = await enableFor(owner);
    expect(
      await codeOf(
        ctx.container.accountSecurity.enrolTotp(tenantA, actor, { password: OWNER_PASSWORD }, from),
      ),
    ).toBe(IDENTITY_ERROR_CODES.ADMIN_SECOND_FACTOR_ACTIVE);
  });

  it('ends every OTHER session on activation and keeps the current one', async () => {
    const other = await passwordLogin(owner);
    const { token } = await enableFor(owner);
    await expect(ctx.container.auth.authenticate(token)).resolves.toBeDefined();
    expect(await codeOf(ctx.container.auth.authenticate(other.token))).toBe(
      IDENTITY_ERROR_CODES.AUTH_SESSION_INVALID,
    );
  });
});

describe('sign-in with a second factor', () => {
  it('issues a challenge, not a session, for the right password', async () => {
    await enableFor(owner);
    const before = await liveSessions(owner.id);
    // The password-only convenience refuses rather than skipping the factor.
    expect(await codeOf(passwordLogin(owner))).toBe(
      IDENTITY_ERROR_CODES.AUTH_SECOND_FACTOR_REQUIRED,
    );
    const challenge = await challengeFor(owner);
    expect(challenge.length).toBeGreaterThanOrEqual(43);
    expect(await liveSessions(owner.id)).toBe(before);
    // The challenge is not a session token.
    expect(await codeOf(ctx.container.auth.authenticate(challenge))).toBe(
      IDENTITY_ERROR_CODES.AUTH_SESSION_INVALID,
    );
    // And only its hash is stored.
    const stored = JSON.stringify(
      await ctx.container.database.db.select().from(adminLoginChallenges),
    );
    expect(stored).not.toContain(challenge);
  });

  it('still refuses a wrong password generically', async () => {
    await enableFor(owner);
    expect(
      await codeOf(
        ctx.container.auth.signIn(
          tenantA,
          anonymous(),
          { username: 'owner', password: 'not-it' },
          from,
        ),
      ),
    ).toBe(IDENTITY_ERROR_CODES.AUTH_INVALID_CREDENTIALS);
  });

  it('mints a session for a valid code, and the challenge is single-use', async () => {
    const { secret } = await enableFor(owner);
    const challenge = await challengeFor(owner);
    const result = await ctx.container.auth.completeSecondFactor(
      challenge,
      anonymous(),
      { code: code(secret) },
      from,
    );
    expect(result.admin.id).toBe(owner.id);
    await expect(ctx.container.auth.authenticate(result.token)).resolves.toBeDefined();
    expect(
      await codeOf(
        ctx.container.auth.completeSecondFactor(
          challenge,
          anonymous(),
          { code: code(secret, 1) },
          from,
        ),
      ),
    ).toBe(IDENTITY_ERROR_CODES.AUTH_CHALLENGE_INVALID);
  });

  it('refuses a REPLAYED code: one accepted in its step is refused again', async () => {
    const { secret } = await enableFor(owner);
    const current = code(secret);
    await ctx.container.auth.completeSecondFactor(
      await challengeFor(owner),
      anonymous(),
      { code: current },
      from,
    );
    // Same code, fresh challenge: refused, with the generic answer.
    expect(
      await codeOf(
        ctx.container.auth.completeSecondFactor(
          await challengeFor(owner),
          anonymous(),
          { code: current },
          from,
        ),
      ),
    ).toBe(IDENTITY_ERROR_CODES.AUTH_SECOND_FACTOR_INVALID);
    // The activation's own code (one step back) is refused too: steps only move forward.
    expect(
      await codeOf(
        ctx.container.auth.completeSecondFactor(
          await challengeFor(owner),
          anonymous(),
          { code: code(secret, -1) },
          from,
        ),
      ),
    ).toBe(IDENTITY_ERROR_CODES.AUTH_SECOND_FACTOR_INVALID);
    // The audit row names the replay; the response never did.
    const denials = await ctx.container.database.db
      .select({ after: auditLogs.after })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'auth.second_factor'), eq(auditLogs.result, 'DENIED')));
    expect(denials.map((row) => (row.after as { detail?: string }).detail)).toContain(
      'REPLAYED_CODE',
    );
  });

  it('accepts a code exactly once when two requests race with it', async () => {
    const { secret } = await enableFor(owner);
    const [first, second] = [await challengeFor(owner), await challengeFor(owner)];
    const current = code(secret);
    const results = await Promise.allSettled([
      ctx.container.auth.completeSecondFactor(first, anonymous(), { code: current }, from),
      ctx.container.auth.completeSecondFactor(second, anonymous(), { code: current }, from),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('accepts a backup code once, and never again', async () => {
    const { backupCodes } = await enableFor(owner);
    const backup = backupCodes[3]!;
    const result = await ctx.container.auth.completeSecondFactor(
      await challengeFor(owner),
      anonymous(),
      // Typed carelessly: lower case, spaces for dashes.
      { backupCode: backup.toLowerCase().replace(/-/g, ' ') },
      from,
    );
    expect(result.admin.id).toBe(owner.id);
    expect(
      await codeOf(
        ctx.container.auth.completeSecondFactor(
          await challengeFor(owner),
          anonymous(),
          { backupCode: backup },
          from,
        ),
      ),
    ).toBe(IDENTITY_ERROR_CODES.AUTH_SECOND_FACTOR_INVALID);
    const { actor } = { actor: actorWithSession(owner, result.session.id) };
    expect(
      (await ctx.container.accountSecurity.overview(tenantA, actor)).backupCodes.remaining,
    ).toBe(9);
  });

  it('spends a backup code once when two requests race with it', async () => {
    const { backupCodes } = await enableFor(owner);
    const [first, second] = [await challengeFor(owner), await challengeFor(owner)];
    const results = await Promise.allSettled([
      ctx.container.auth.completeSecondFactor(
        first,
        anonymous(),
        { backupCode: backupCodes[0]! },
        from,
      ),
      ctx.container.auth.completeSecondFactor(
        second,
        anonymous(),
        { backupCode: backupCodes[0]! },
        from,
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('spends a challenge after its guesses, even for a right code next', async () => {
    const { secret } = await enableFor(owner);
    const challenge = await challengeFor(owner);
    const wrong = code(secret) === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < LOGIN_CHALLENGE_MAX_ATTEMPTS; attempt += 1) {
      expect(
        await codeOf(
          ctx.container.auth.completeSecondFactor(challenge, anonymous(), { code: wrong }, from),
        ),
      ).toBe(IDENTITY_ERROR_CODES.AUTH_SECOND_FACTOR_INVALID);
    }
    expect(
      await codeOf(
        ctx.container.auth.completeSecondFactor(
          challenge,
          anonymous(),
          { code: code(secret) },
          from,
        ),
      ),
    ).toBe(IDENTITY_ERROR_CODES.AUTH_CHALLENGE_INVALID);
  });

  it('counts wrong codes on the login throttle, and a correct password does not reset them', async () => {
    // Default policy: 5 attempts per username. Wrong codes are counted guesses, and the
    // correct-password step in between GIVES BACK its own reservation without erasing
    // them — so holding the password does not buy a fresh allowance at the six digits.
    const { secret } = await enableFor(owner);
    const wrong = code(secret) === '000000' ? '111111' : '000000';
    const noAddress = { ip: null, userAgent: null };
    const guess = async (challenge: string, times: number) => {
      for (let attempt = 0; attempt < times; attempt += 1) {
        await codeOf(
          ctx.container.auth.completeSecondFactor(
            challenge,
            anonymous(),
            { code: wrong },
            noAddress,
          ),
        );
      }
    };
    const counted = async () => {
      const [row] = await ctx.container.database.db
        .select({ failedCount: adminLoginThrottle.failedCount })
        .from(adminLoginThrottle)
        .where(
          and(
            eq(adminLoginThrottle.subjectKind, 'USERNAME'),
            eq(adminLoginThrottle.subject, 'owner'),
          ),
        );
      return row?.failedCount ?? 0;
    };
    const signIn = () =>
      ctx.container.auth.signIn(
        tenantA,
        anonymous(),
        { username: 'owner', password: OWNER_PASSWORD },
        noAddress,
      );

    const first = await signIn();
    if (first.kind !== 'SECOND_FACTOR_REQUIRED') throw new Error('expected a challenge');
    await guess(first.challengeToken, 3);
    expect(await counted()).toBe(3);

    // The password again: a new challenge, and the three guesses are STILL counted.
    const second = await signIn();
    if (second.kind !== 'SECOND_FACTOR_REQUIRED') throw new Error('expected a challenge');
    expect(await counted()).toBe(3);

    await guess(second.challengeToken, 2);
    expect(await counted()).toBe(5);
    // The sixth attempt — even with the right password — is refused.
    expect(await codeOf(signIn())).toBe(IDENTITY_ERROR_CODES.AUTH_RATE_LIMITED);
  });

  it('clears the username counter when the second factor succeeds', async () => {
    const { secret } = await enableFor(owner);
    const wrong = code(secret) === '000000' ? '111111' : '000000';
    const challenge = await challengeFor(owner);
    await codeOf(
      ctx.container.auth.completeSecondFactor(challenge, anonymous(), { code: wrong }, from),
    );
    await ctx.container.auth.completeSecondFactor(
      challenge,
      anonymous(),
      { code: code(secret) },
      from,
    );
    const rows = await ctx.container.database.db
      .select()
      .from(adminLoginThrottle)
      .where(
        and(
          eq(adminLoginThrottle.subjectKind, 'USERNAME'),
          eq(adminLoginThrottle.subject, 'owner'),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it('voids the challenge when the password changes between the two steps', async () => {
    const { secret } = await enableFor(owner);
    const challenge = await challengeFor(owner);
    await ctx.container.admins.setPasswordHash(
      tenantA,
      owner.id,
      await ctx.container.hasher.hash('a-brand-new-password'),
      ctx.container.clock.now(),
    );
    expect(
      await codeOf(
        ctx.container.auth.completeSecondFactor(
          challenge,
          anonymous(),
          { code: code(secret) },
          from,
        ),
      ),
    ).toBe(IDENTITY_ERROR_CODES.AUTH_CHALLENGE_INVALID);
  });

  it('refuses an expired challenge', async () => {
    const { secret } = await enableFor(owner);
    const challenge = await challengeFor(owner);
    await ctx.container.database.db
      .update(adminLoginChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) });
    expect(
      await codeOf(
        ctx.container.auth.completeSecondFactor(
          challenge,
          anonymous(),
          { code: code(secret) },
          from,
        ),
      ),
    ).toBe(IDENTITY_ERROR_CODES.AUTH_CHALLENGE_INVALID);
  });
});

describe('the replay rule in the database', () => {
  it('records a step once, and never a step at or before the last one', async () => {
    // The statement-level half of replay protection, isolated from `matchTotp`: whatever
    // a process believed, the conditional UPDATE admits only a strictly later step.
    await enableFor(owner);
    const factor = (await ctx.container.secondFactors.findFactor(tenantA, owner.id))!;
    const last = factor.lastUsedStep!;
    const consume = (step: number) =>
      ctx.container.database.db.transaction((tx) =>
        ctx.container.secondFactors.consumeStep(tenantA, factor.id, step, new Date(), { tx }),
      );
    expect(await consume(last)).toBe(false);
    expect(await consume(last - 1)).toBe(false);
    expect(await consume(last + 1)).toBe(true);
    expect(await consume(last + 1)).toBe(false);
  });

  it('spends a backup code once at the statement level', async () => {
    const { backupCodes } = await enableFor(owner);
    const { hashBackupCode, normaliseBackupCode } =
      await import('../../apps/api/src/modules/platform/identity/application/backup-codes');
    const hash = hashBackupCode(
      tenantA.tenantId as string,
      owner.id,
      normaliseBackupCode(backupCodes[0]!)!,
    );
    const spend = () =>
      ctx.container.database.db.transaction((tx) =>
        ctx.container.secondFactors.consumeBackupCode(tenantA, owner.id, hash, new Date(), { tx }),
      );
    expect(await spend()).toBe(true);
    expect(await spend()).toBe(false);
  });
});

describe('backup codes and disabling', () => {
  it('regenerating needs the password AND a factor, and invalidates the old set', async () => {
    const { secret, backupCodes: old, actor } = await enableFor(owner);
    expect(
      await codeOf(
        ctx.container.accountSecurity.regenerateBackupCodes(
          tenantA,
          actor,
          { password: 'wrong', code: code(secret) },
          from,
        ),
      ),
    ).toBe(IDENTITY_ERROR_CODES.AUTH_INVALID_CREDENTIALS);
    const wrong = code(secret) === '000000' ? '111111' : '000000';
    expect(
      await codeOf(
        ctx.container.accountSecurity.regenerateBackupCodes(
          tenantA,
          actor,
          { password: OWNER_PASSWORD, code: wrong },
          from,
        ),
      ),
    ).toBe(IDENTITY_ERROR_CODES.AUTH_SECOND_FACTOR_INVALID);

    const { backupCodes: fresh } = await ctx.container.accountSecurity.regenerateBackupCodes(
      tenantA,
      actor,
      { password: OWNER_PASSWORD, code: code(secret) },
      from,
    );
    expect(fresh).toHaveLength(10);
    expect(fresh.some((value) => old.includes(value))).toBe(false);

    expect(
      await codeOf(
        ctx.container.auth.completeSecondFactor(
          await challengeFor(owner),
          anonymous(),
          { backupCode: old[0]! },
          from,
        ),
      ),
    ).toBe(IDENTITY_ERROR_CODES.AUTH_SECOND_FACTOR_INVALID);
    await expect(
      ctx.container.auth.completeSecondFactor(
        await challengeFor(owner),
        anonymous(),
        { backupCode: fresh[0]! },
        from,
      ),
    ).resolves.toBeDefined();
  });

  it('disabling needs re-authentication: password alone, or a code alone, is refused', async () => {
    const { secret, actor } = await enableFor(owner);
    await expect(
      ctx.container.accountSecurity.disableTotp(tenantA, actor, { password: OWNER_PASSWORD }, from),
    ).rejects.toThrow();
    expect(
      await codeOf(
        ctx.container.accountSecurity.disableTotp(
          tenantA,
          actor,
          { password: 'x', code: code(secret) },
          from,
        ),
      ),
    ).toBe(IDENTITY_ERROR_CODES.AUTH_INVALID_CREDENTIALS);
    expect((await ctx.container.accountSecurity.overview(tenantA, actor)).totp.state).toBe(
      'ACTIVE',
    );

    await ctx.container.accountSecurity.disableTotp(
      tenantA,
      actor,
      { password: OWNER_PASSWORD, code: code(secret) },
      from,
    );
    expect((await ctx.container.accountSecurity.overview(tenantA, actor)).totp.state).toBe(
      'DISABLED',
    );
    expect(await ctx.container.database.db.select().from(adminTotpFactors)).toHaveLength(0);
    expect(await ctx.container.database.db.select().from(adminBackupCodes)).toHaveLength(0);
    // And sign-in is password-only again.
    await expect(passwordLogin(owner)).resolves.toBeDefined();
  });

  it('can be disabled with a backup code in place of the device', async () => {
    const { backupCodes, actor } = await enableFor(owner);
    await ctx.container.accountSecurity.disableTotp(
      tenantA,
      actor,
      { password: OWNER_PASSWORD, backupCode: backupCodes[9]! },
      from,
    );
    expect((await ctx.container.accountSecurity.overview(tenantA, actor)).totp.state).toBe(
      'DISABLED',
    );
  });
});

describe('own sessions', () => {
  it('lists them with the current one marked', async () => {
    const first = await passwordLogin(owner);
    const second = await passwordLogin(owner);
    const sessions = await ctx.container.accountSecurity.listOwnSessions(tenantA, second.actor);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((row) => row.current)?.id).toBe(second.actor.sessionId);
    expect(sessions.find((row) => !row.current)?.id).toBe(first.actor.sessionId);
    expect(JSON.stringify(sessions)).not.toContain(first.token);
  });

  it('revokes one, and its cookie is refused from then on', async () => {
    const first = await passwordLogin(owner);
    const second = await passwordLogin(owner);
    const result = await ctx.container.accountSecurity.revokeOwnSession(
      tenantA,
      second.actor,
      first.actor.sessionId!,
    );
    expect(result).toEqual({ revoked: true, current: false });
    expect(await codeOf(ctx.container.auth.authenticate(first.token))).toBe(
      IDENTITY_ERROR_CODES.AUTH_SESSION_INVALID,
    );
    await expect(ctx.container.auth.authenticate(second.token)).resolves.toBeDefined();
    // Again: already ended, not an error.
    expect(
      await ctx.container.accountSecurity.revokeOwnSession(
        tenantA,
        second.actor,
        first.actor.sessionId!,
      ),
    ).toEqual({ revoked: false, current: false });
  });

  it('revoke-others keeps the current session', async () => {
    const a = await passwordLogin(owner);
    const b = await passwordLogin(owner);
    const current = await passwordLogin(owner);
    expect(await ctx.container.accountSecurity.revokeOtherSessions(tenantA, current.actor)).toBe(2);
    await expect(ctx.container.auth.authenticate(current.token)).resolves.toBeDefined();
    for (const gone of [a, b]) {
      expect(await codeOf(ctx.container.auth.authenticate(gone.token))).toBe(
        IDENTITY_ERROR_CODES.AUTH_SESSION_INVALID,
      );
    }
  });

  it("refuses another administrator's session as NOT FOUND, in the same tenant and across tenants", async () => {
    const theirs = await passwordLogin(support);
    const mine = await passwordLogin(owner);
    expect(
      await codeOf(
        ctx.container.accountSecurity.revokeOwnSession(
          tenantA,
          mine.actor,
          theirs.actor.sessionId!,
        ),
      ),
    ).toBe(IDENTITY_ERROR_CODES.ADMIN_SESSION_NOT_FOUND);
    await expect(ctx.container.auth.authenticate(theirs.token)).resolves.toBeDefined();

    const elsewhere = await createAdmin(ctx.container, tenantB, {
      username: 'owner',
      password: 'tenant-b-password',
      roleKeys: ['owner'],
    });
    const b = await passwordLogin(elsewhere, tenantB);
    expect(
      await codeOf(
        ctx.container.accountSecurity.revokeOwnSession(tenantB, b.actor, mine.actor.sessionId!),
      ),
    ).toBe(IDENTITY_ERROR_CODES.ADMIN_SESSION_NOT_FOUND);
    await expect(ctx.container.auth.authenticate(mine.token)).resolves.toBeDefined();
    expect(
      (await ctx.container.accountSecurity.listOwnSessions(tenantB, b.actor)).map((row) => row.id),
    ).toEqual([b.actor.sessionId]);
  });
});

describe('operator reset and server recovery', () => {
  it('an operator without admins.edit is refused, and the refusal is audited', async () => {
    await enableFor(manager);
    const { actor } = await passwordLogin(support);
    expect(
      await codeOf(
        ctx.container.adminManagement.resetSecondFactor(tenantA, actor, manager.id, {
          reason: 'lost phone',
        }),
      ),
    ).toBe('platform.permission_denied');
    const denied = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'admin.totp_reset'), eq(auditLogs.result, 'DENIED')));
    expect(denied).toHaveLength(1);
  });

  it('the owner resets a manager: factor gone, every session ended, password untouched', async () => {
    const { token } = await enableFor(manager);
    const { actor } = await passwordLogin(owner);
    const result = await ctx.container.adminManagement.resetSecondFactor(
      tenantA,
      actor,
      manager.id,
      {
        reason: 'lost phone',
      },
    );
    expect(result.hadSecondFactor).toBe(true);
    expect(result.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect(await codeOf(ctx.container.auth.authenticate(token))).toBe(
      IDENTITY_ERROR_CODES.AUTH_SESSION_INVALID,
    );
    await expect(passwordLogin(manager)).resolves.toBeDefined();
  });

  it('refuses self, a target in another tenant, and a manager resetting the owner', async () => {
    await enableFor(owner);
    const managerSession = await passwordLogin(manager);
    expect(
      await codeOf(
        ctx.container.adminManagement.resetSecondFactor(
          tenantA,
          managerSession.actor,
          managerSession.actor.id as never,
          {
            reason: 'x',
          },
        ),
      ),
    ).toBe(IDENTITY_ERROR_CODES.ADMIN_SELF_MODIFICATION);
    const ownerReset = await codeOf(
      ctx.container.adminManagement.resetSecondFactor(tenantA, managerSession.actor, owner.id, {
        reason: 'x',
      }),
    );
    // An owner target needs `admins.permissions.edit`, which a delegated manager lacks.
    expect(ownerReset).toBe('platform.permission_denied');
    const elsewhere = await createAdmin(ctx.container, tenantB, {
      username: 'owner',
      password: 'tenant-b-password',
      roleKeys: ['owner'],
    });
    const b = await passwordLogin(elsewhere, tenantB);
    expect(
      await codeOf(
        ctx.container.adminManagement.resetSecondFactor(tenantB, b.actor, owner.id, {
          reason: 'x',
        }),
      ),
    ).toBe(IDENTITY_ERROR_CODES.ADMIN_NOT_FOUND);
    // The owner's factor survived all three.
    expect(await ctx.container.secondFactors.findFactor(tenantA, owner.id)).not.toBeNull();
  });

  it('server recovery removes the factor, ends sessions, audits as SYSTEM_JOB with the reason', async () => {
    const { token } = await enableFor(owner);
    const result = await ctx.container.accountSecurity.resetFromServer(tenantA, {
      username: 'OWNER',
      reason: 'owner lost phone and backup codes',
    });
    expect(result).toMatchObject({ adminId: owner.id, hadSecondFactor: true });
    expect(await codeOf(ctx.container.auth.authenticate(token))).toBe(
      IDENTITY_ERROR_CODES.AUTH_SESSION_INVALID,
    );
    // Recovery does not sign anybody in: the password is still required, and works.
    await expect(passwordLogin(owner)).resolves.toBeDefined();
    const [row] = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'admin.totp_reset'));
    expect(row?.actorType).toBe('SYSTEM_JOB');
    expect(row?.reason).toBe('owner lost phone and backup codes');
    const [event] = await ctx.container.database.db
      .select()
      .from(operationalEvents)
      .where(eq(operationalEvents.code, 'admin.second_factor_reset'));
    expect(event?.severity).toBe('WARN');
  });
});

describe('history and redaction', () => {
  it('shows the account holder their own sign-ins and failures, with the address', async () => {
    const { secret } = await enableFor(owner);
    const wrong = code(secret) === '000000' ? '111111' : '000000';
    const challenge = await challengeFor(owner);
    await codeOf(
      ctx.container.auth.completeSecondFactor(challenge, anonymous(), { code: wrong }, from),
    );
    const done = await ctx.container.auth.completeSecondFactor(
      challenge,
      anonymous(),
      { code: code(secret) },
      from,
    );
    await codeOf(
      ctx.container.auth.signIn(
        tenantA,
        anonymous(),
        { username: 'owner', password: 'nope' },
        from,
      ),
    );
    const events = await ctx.container.accountSecurity.securityEvents(
      tenantA,
      actorWithSession(owner, done.session.id),
    );
    const actions = events.map((event) => `${event.action}:${event.result}`);
    expect(actions).toContain('auth.login:SUCCESS');
    expect(actions).toContain('auth.login:DENIED');
    expect(actions).toContain('auth.login_challenge:SUCCESS');
    expect(actions).toContain('auth.second_factor:DENIED');
    expect(actions).toContain('admin.totp_enable:SUCCESS');
    expect(
      events.find((event) => event.action === 'auth.login' && event.result === 'SUCCESS')?.method,
    ).toBe('TOTP');
    expect(
      events.find((event) => event.result === 'DENIED' && event.action === 'auth.login')?.reason,
    ).toBe('BAD_PASSWORD');
    // Another administrator's history is not in it.
    expect(events.every((event) => event.id.length > 0)).toBe(true);
    const supportEvents = await ctx.container.accountSecurity.securityEvents(
      tenantA,
      (await passwordLogin(support)).actor,
    );
    expect(supportEvents.some((event) => event.action === 'admin.totp_enable')).toBe(false);
  });

  it('never writes a secret, a code or a backup code to the audit log or the operational log', async () => {
    const { secret, backupCodes, actor, enrolment } = await enableFor(owner);
    const challenge = await challengeFor(owner);
    await ctx.container.auth.completeSecondFactor(
      challenge,
      anonymous(),
      { backupCode: backupCodes[1]! },
      from,
    );
    const fresh = await ctx.container.accountSecurity.regenerateBackupCodes(
      tenantA,
      actor,
      { password: OWNER_PASSWORD, backupCode: backupCodes[2]! },
      from,
    );
    await ctx.container.accountSecurity.disableTotp(
      tenantA,
      actor,
      { password: OWNER_PASSWORD, backupCode: fresh.backupCodes[0]! },
      from,
    );
    const audit = JSON.stringify(await ctx.container.database.db.select().from(auditLogs));
    const events = JSON.stringify(await ctx.container.database.db.select().from(operationalEvents));
    const needles = [
      secret,
      enrolment.otpauthUri,
      challenge,
      OWNER_PASSWORD,
      ...backupCodes,
      ...backupCodes.map((value) => value.replace(/-/g, '')),
      ...fresh.backupCodes,
    ];
    for (const needle of needles) {
      expect(audit, 'audit_logs carries a secret').not.toContain(needle);
      expect(events, 'operational_events carries a secret').not.toContain(needle);
    }
  });
});

describe('the recovery CLI', () => {
  const cli = join(__dirname, '../../apps/api/dist/admin-2fa-reset.cli.js');
  const config = testConfig();

  const run = (args: readonly string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn('node', [cli, ...args], {
        env: {
          ...process.env,
          NODE_ENV: 'development',
          LOG_LEVEL: 'error',
          DATABASE_URL: config.DATABASE_URL,
          REDIS_URL: config.REDIS_URL,
          SECRETS_KEK: config.SECRETS_KEK,
          SECRETS_KEK_ID: config.SECRETS_KEK_ID,
          AUTH_MODE: 'password',
          DEPLOYMENT_TOPOLOGY: 'direct',
          TRUSTED_PROXY_IPS: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('close', (exit) => resolve({ code: exit, stdout, stderr }));
    });

  it('checks, resets, and audits, from the compiled entrypoint', async () => {
    const { token } = await enableFor(owner);
    const tenantSlug = (await ctx.container.tenants.findById(tenantA.tenantId))!.slug;

    const check = await run(['--check', '--username', 'owner', '--tenant', tenantSlug]);
    expect(check.code).toBe(0);
    expect(check.stdout.trim()).toBe('on');

    const refused = await run(['--username', 'owner', '--tenant', tenantSlug]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('--reason');

    const reset = await run([
      '--username',
      'owner',
      '--reason',
      'lost phone, verified in person',
      '--tenant',
      tenantSlug,
    ]);
    expect(reset.code).toBe(0);
    expect(reset.stderr).toContain('removed');
    expect(await ctx.container.secondFactors.findFactor(tenantA, owner.id)).toBeNull();
    expect(await codeOf(ctx.container.auth.authenticate(token))).toBe(
      IDENTITY_ERROR_CODES.AUTH_SESSION_INVALID,
    );
    const [row] = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'admin.totp_reset'));
    expect(row?.reason).toBe('lost phone, verified in person');

    const after = await run(['--check', '--username', 'owner', '--tenant', tenantSlug]);
    expect(after.stdout.trim()).toBe('off');
  }, 120_000);
});
