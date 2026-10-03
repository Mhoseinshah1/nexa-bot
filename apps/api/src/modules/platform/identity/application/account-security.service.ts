import {
  accountSecurityResponseSchema,
  BACKUP_CODE_COUNT,
  errors,
  IDENTITY_ERROR_CODES,
  isNexaError,
  isSystemContext,
  PLATFORM_ERROR_CODES,
  reauthenticateWithSecondFactorSchema,
  SECOND_FACTOR_METHODS,
  SECURITY_EVENT_ACTIONS,
  TOTP_ACTIVATION_MAX_ATTEMPTS,
  TOTP_ENROLMENT_TTL_SECONDS,
  TOTP_ISSUER,
  TOTP_PARAMETERS,
  totpActivateRequestSchema,
  totpEnrolRequestSchema,
  type AccountSecurityResponse,
  type ActorContext,
  type Admin,
  type AdminId,
  type AdminSessionId,
  type AdminSessionSummary,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type ManagementAdminEventCode,
  type OperationalEventRecorder,
  type ScopeContext,
  type SecondFactorMethod,
  type SecretCipher,
  type SecurityEvent,
  type SecurityEventAction,
  type TenantContext,
  type TotpEnrolResponse,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  AdminRepository,
  SecondFactorRepository,
  SecurityEventReader,
  SessionRepository,
  StoredTotpFactor,
} from './ports.js';
import type { CredentialThrottle, Reservation } from './credential-throttle.js';
import type { PasswordChangeContext } from './admin-management.service.js';
import { generateTotpSecret, matchTotp, otpauthUri } from './totp.js';
import { generateBackupCodes, hashBackupCode, normaliseBackupCode } from './backup-codes.js';
import {
  totpSecretContext,
  verifySecondFactorProof,
  type ProofVerdict,
} from './second-factor-proof.js';

/**
 * An administrator's OWN account security (Phase D2, program §17): the second factor,
 * backup codes, their sessions and their sign-in history — plus the server-side
 * owner-recovery path.
 *
 * ## Authorization
 *
 * Self-service needs no catalog permission, on the precedent `changeOwnPassword` set: it
 * acts only on the caller's own account, grants nothing, and refusing it to some role
 * would mean that role could never protect its own account. What it needs instead is
 * PROOF, proportional to the act:
 *
 *   - reading, and ending one's own sessions: a live session;
 *   - enrolling: the password as well — otherwise a stolen session could enrol the
 *     thief's phone and lock the real holder out at their next sign-in;
 *   - disabling the factor, and replacing backup codes: the password AND a current
 *     code or unused backup code. Either alone is what somebody holding half the
 *     account would have.
 *
 * Every write re-checks, inside its transaction, that the tenant is still active and the
 * session it arrived on is still live, and takes the administrator's row lock — the
 * lock a login and a password rotation take — so a factor change and a sign-in
 * serialise rather than interleave.
 *
 * ## What is never written down
 *
 * No secret, code, backup code or hash reaches a response other than the one that
 * creates it, an audit row, an operational event or a log line. Audit keys are chosen to
 * survive the redactor (`liveSignIns`, never `sessions…`) because a key that LOOKS like
 * a credential is redacted, and that is the redactor working, not an obstacle to it.
 */
export interface AccountSecurityDependencies {
  readonly uow: UnitOfWork<TransactionScope>;
  readonly admins: AdminRepository;
  readonly sessions: SessionRepository;
  readonly factors: SecondFactorRepository;
  readonly events: SecurityEventReader;
  readonly cipher: SecretCipher;
  /** The installation's QR encoder (`infrastructure/qr`), as a PNG. */
  readonly qr: { encode(text: string): Uint8Array } | null;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly throttle: CredentialThrottle;
  /** The one password step-up: throttled, audited, shared with the Recovery Kit. */
  readonly verifyOwnPassword: (
    scope: ScopeContext,
    actor: ActorContext,
    password: string,
    context: PasswordChangeContext,
    action: string,
  ) => Promise<void>;
}

/** How many sessions and history rows one read returns. */
const OWN_SESSION_LIMIT = 50;
const SECURITY_EVENT_LIMIT = 50;

type ProofOutcome =
  | { readonly kind: 'OK'; readonly method: SecondFactorMethod; readonly codes?: string[] }
  | { readonly kind: 'NOT_ACTIVE' }
  | { readonly kind: 'REJECTED'; readonly verdict: ProofVerdict };

export class AccountSecurityService {
  constructor(private readonly deps: AccountSecurityDependencies) {}

  async overview(scope: ScopeContext, actor: ActorContext): Promise<AccountSecurityResponse> {
    const { tenantScope, adminId } = this.self(scope, actor);
    const stored = await this.deps.factors.findFactor(tenantScope, adminId);
    // An expired PENDING enrolment is no enrolment: it cannot be activated, and showing
    // it as waiting would invite a code that is then refused (D2 review).
    const factor =
      stored !== null && isExpiredPending(stored, this.deps.clock.now()) ? null : stored;
    const codes =
      factor?.state === 'ACTIVE'
        ? await this.deps.factors.backupCodeSummary(tenantScope, adminId)
        : { remaining: 0, generatedAt: null };
    return accountSecurityResponseSchema.parse({
      totp: {
        state: factor === null ? 'DISABLED' : factor.state,
        activatedAt: factor?.activatedAt?.toISOString() ?? null,
      },
      backupCodes: {
        remaining: codes.remaining,
        generatedAt: codes.generatedAt?.toISOString() ?? null,
      },
    });
  }

  /**
   * Starts (or restarts) an enrolment. The secret is returned here and NOWHERE else,
   * ever; a pending enrolment that is not activated in time is simply replaced by the
   * next one.
   */
  async enrolTotp(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
    context: PasswordChangeContext,
  ): Promise<TotpEnrolResponse> {
    const { tenantScope, adminId } = this.self(scope, actor);
    const command = totpEnrolRequestSchema.parse(input);
    await this.deps.verifyOwnPassword(scope, actor, command.password, context, 'admin.totp_enrol');

    const secret = generateTotpSecret();
    const factorId = this.deps.ids.uuid();
    const result = await this.deps.uow.run(tenantScope, async (tx) => {
      const admin = await this.lockSelf(tenantScope, actor, adminId, tx);
      const now = this.deps.clock.now();
      const existing = await this.deps.factors.lockFactor(tenantScope, adminId, tx);
      if (existing?.state === 'ACTIVE') {
        throw errors.conflict(
          IDENTITY_ERROR_CODES.ADMIN_SECOND_FACTOR_ACTIVE,
          'Two-step sign-in is already on. Turn it off first to enrol a new device.',
        );
      }
      const sealed = this.deps.cipher.encrypt(
        secret,
        totpSecretContext(tenantScope.tenantId, factorId),
      );
      await this.deps.factors.replaceWithPending(
        tenantScope,
        {
          id: factorId,
          adminId,
          ciphertext: sealed.ciphertext,
          keyId: sealed.keyId,
          // Activation must come from THIS session (D2 review): the secret was shown to it.
          enrolledSessionId: actor.sessionId ?? null,
          now,
        },
        tx,
      );
      const expiresAt = new Date(now.getTime() + TOTP_ENROLMENT_TTL_SECONDS * 1000);
      await this.deps.audit.record(
        tenantScope,
        actor,
        {
          action: 'admin.totp_enrol',
          entityType: 'Admin',
          entityId: adminId,
          before: existing === null ? null : { state: existing.state },
          after: { state: 'PENDING', expiresAt: expiresAt.toISOString() },
          result: 'SUCCESS',
        },
        tx,
      );
      return { admin, expiresAt };
    });

    const uri = otpauthUri({ issuer: TOTP_ISSUER, account: result.admin.username, secret });
    return {
      secret,
      otpauthUri: uri,
      qrPngDataUrl: this.qrDataUrl(uri),
      expiresAt: result.expiresAt.toISOString(),
      parameters: {
        algorithm: TOTP_PARAMETERS.algorithm,
        digits: TOTP_PARAMETERS.digits,
        periodSeconds: TOTP_PARAMETERS.periodSeconds,
      },
    };
  }

  /**
   * Turns a pending enrolment on, with a code from the device — so a factor is never
   * active that its holder has not shown they can produce. Returns the first set of
   * backup codes, once. Every OTHER session of the account ends: they were opened
   * without the second factor, and the point of turning it on is that that is no longer
   * enough.
   *
   * ## Guessing (D2 security review)
   *
   * This answers with the only display of ten backup codes and ends every other
   * session, so it must not be a place to guess six digits. Three bounds, all needed:
   *
   *   - each guess is RESERVED on the credential throttle, like every other code and
   *     password the account accepts; a wrong one keeps its reservation;
   *   - one pending enrolment allows `TOTP_ACTIVATION_MAX_ATTEMPTS` wrong codes, counted
   *     in a commit of its own; past that the pending row is DELETED and enrolment starts
   *     again from the password;
   *   - only the session that enrolled may activate: a different session presenting a
   *     code never saw the secret, so it is guessing.
   *
   * An expired enrolment is deleted before the refusal is reported, so its secret does
   * not linger as a stored ciphertext nobody can use.
   */
  async activateTotp(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
    context: PasswordChangeContext = { ip: null },
  ): Promise<{ backupCodes: string[]; endedSignIns: number }> {
    const { tenantScope, adminId } = this.self(scope, actor);
    const command = totpActivateRequestSchema.parse(input);
    const admin = await this.requireAdmin(tenantScope, adminId);

    // Pre-checks that decide nothing and spend nothing: an expired enrolment is removed
    // (in its own commit) and refused; another session's enrolment is refused.
    const pending = await this.deps.factors.findFactor(tenantScope, adminId);
    if (pending !== null && pending.state === 'PENDING') {
      if (isExpiredPending(pending, this.deps.clock.now())) {
        await this.deps.factors.discardPending(tenantScope, adminId);
        throw notPending();
      }
    }

    const reserved = await this.reserveGuess(
      tenantScope,
      actor,
      admin,
      context,
      'admin.totp_enable',
      'TOTP',
    );
    let judged = false;
    try {
      const attempts = await this.deps.factors.countActivationAttempt(tenantScope, adminId);
      if (attempts === null) {
        await this.deps.throttle.release(tenantScope, admin.username, context.ip, reserved);
        judged = true;
        throw notPending();
      }
      if (attempts > TOTP_ACTIVATION_MAX_ATTEMPTS) {
        // Out of guesses: the displayed secret is spent. Not a judged guess, so the
        // reservation goes back; the pending row goes away in its own commit.
        await this.deps.factors.discardPending(tenantScope, adminId);
        await this.deps.throttle.release(tenantScope, admin.username, context.ip, reserved);
        judged = true;
        await this.deps.audit.record(tenantScope, actor, {
          action: 'admin.totp_enable',
          entityType: 'Admin',
          entityId: adminId,
          before: { state: 'PENDING' },
          after: { reason: 'ACTIVATION_ATTEMPTS_EXHAUSTED', state: 'DISABLED' },
          result: 'DENIED',
        });
        throw notPending();
      }

      const codes = generateBackupCodes();
      const outcome = await this.deps.uow.run(tenantScope, async (tx) => {
        await this.lockSelf(tenantScope, actor, adminId, tx);
        // After the waits, not before them (D2 review).
        const now = this.deps.clock.now();
        const factor = await this.deps.factors.lockFactor(tenantScope, adminId, tx);
        if (factor?.state === 'ACTIVE') return { kind: 'ALREADY_ACTIVE' as const };
        if (factor === null || isExpiredPending(factor, now))
          return { kind: 'NOT_PENDING' as const };
        if (
          factor.enrolledSessionId !== null &&
          factor.enrolledSessionId !== (actor.sessionId ?? null)
        ) {
          return { kind: 'OTHER_SESSION' as const };
        }
        const secret = this.deps.cipher.decrypt(
          { ciphertext: factor.ciphertext, keyId: factor.keyId },
          totpSecretContext(tenantScope.tenantId, factor.id),
        );
        const step = matchTotp(secret, command.code, now, null);
        if (step === null) return { kind: 'WRONG' as const };

        if (!(await this.deps.factors.activate(tenantScope, factor.id, step, now, tx))) {
          return { kind: 'NOT_PENDING' as const };
        }
        await this.writeBackupCodes(tenantScope, adminId, codes, now, tx);
        const endedSignIns = await this.endOtherSessions(
          tenantScope,
          actor,
          adminId,
          now,
          tx,
          'second_factor_enabled',
        );
        // The reservation goes back WITH the activation, never after it.
        await this.deps.throttle.releaseIn(tenantScope, admin.username, context.ip, reserved, tx);
        await this.deps.audit.record(
          tenantScope,
          actor,
          {
            action: 'admin.totp_enable',
            entityType: 'Admin',
            entityId: adminId,
            before: { state: 'PENDING' },
            after: { state: 'ACTIVE', backupCodesIssued: BACKUP_CODE_COUNT, endedSignIns },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.recordChange(
          tenantScope,
          tx,
          'admin.second_factor_enabled',
          'INFO',
          'an administrator turned on two-step sign-in',
          { adminId, endedSignIns },
        );
        return { kind: 'OK' as const, endedSignIns };
      });

      if (outcome.kind === 'OK') {
        judged = true;
        return { backupCodes: codes, endedSignIns: outcome.endedSignIns };
      }
      if (outcome.kind === 'WRONG' || outcome.kind === 'OTHER_SESSION') {
        // A judged guess: the reservation stays.
        judged = true;
        await this.deps.audit.record(tenantScope, actor, {
          action: 'admin.totp_enable',
          entityType: 'Admin',
          entityId: adminId,
          before: null,
          after: {
            reason: outcome.kind === 'WRONG' ? 'BAD_SECOND_FACTOR' : 'OTHER_SESSION',
            method: 'TOTP',
          },
          result: 'DENIED',
        });
        if (outcome.kind === 'OTHER_SESSION') throw notPending();
        // The guess that USES UP the allowance also voids the enrolment, so a sixth guess
        // has nothing to guess at — whatever the throttle's own limit is.
        if (attempts >= TOTP_ACTIVATION_MAX_ATTEMPTS) {
          await this.deps.factors.discardPending(tenantScope, adminId);
        }
        throw errors.unauthenticated(
          IDENTITY_ERROR_CODES.AUTH_SECOND_FACTOR_INVALID,
          'The code is not valid.',
        );
      }
      await this.deps.throttle.release(tenantScope, admin.username, context.ip, reserved);
      judged = true;
      if (outcome.kind === 'ALREADY_ACTIVE') {
        throw errors.conflict(
          IDENTITY_ERROR_CODES.ADMIN_SECOND_FACTOR_ACTIVE,
          'Two-step sign-in is already on.',
        );
      }
      await this.deps.factors.discardPending(tenantScope, adminId);
      throw notPending();
    } catch (error) {
      if (!judged) {
        await this.deps.throttle.release(tenantScope, admin.username, context.ip, reserved);
      }
      throw error;
    }
  }

  /** One code guess, reserved on the shared credential throttle; a refusal is audited. */
  private async reserveGuess(
    scope: TenantContext,
    actor: ActorContext,
    admin: Admin,
    context: PasswordChangeContext,
    action: string,
    method: SecondFactorMethod,
  ): Promise<Reservation> {
    try {
      return await this.deps.throttle.reserve(scope, actor, admin.username, context.ip);
    } catch (error) {
      if (isNexaError(error) && error.code === IDENTITY_ERROR_CODES.AUTH_RATE_LIMITED) {
        await this.deps.audit.record(scope, actor, {
          action,
          entityType: 'Admin',
          entityId: admin.id,
          before: null,
          after: { reason: 'THROTTLED', method },
          result: 'DENIED',
        });
      }
      throw error;
    }
  }

  /** Turns the factor off: password AND a current code or unused backup code. */
  async disableTotp(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
    context: PasswordChangeContext,
  ): Promise<void> {
    await this.withProof(
      scope,
      actor,
      input,
      context,
      'admin.totp_disable',
      async (tenantScope, adminId, method, now, tx) => {
        await this.deps.factors.deleteFactor(tenantScope, adminId, tx);
        await this.deps.audit.record(
          tenantScope,
          actor,
          {
            action: 'admin.totp_disable',
            entityType: 'Admin',
            entityId: adminId,
            before: { state: 'ACTIVE' },
            after: { state: 'DISABLED', method, at: now.toISOString() },
            result: 'SUCCESS',
          },
          tx,
        );
        // WARN: an account just lost a protection. Usually the holder's own choice, and
        // exactly what a takeover would also do — so it is worth the alerts page.
        await this.recordChange(
          tenantScope,
          tx,
          'admin.second_factor_disabled',
          'WARN',
          'an administrator turned off two-step sign-in',
          { adminId, method },
        );
        return undefined;
      },
    );
  }

  /** Replaces every backup code. The old set stops working in the same commit. */
  async regenerateBackupCodes(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
    context: PasswordChangeContext,
  ): Promise<{ backupCodes: string[] }> {
    const codes = generateBackupCodes();
    await this.withProof(
      scope,
      actor,
      input,
      context,
      'admin.backup_codes_regenerate',
      async (tenantScope, adminId, method, now, tx) => {
        await this.writeBackupCodes(tenantScope, adminId, codes, now, tx);
        await this.deps.audit.record(
          tenantScope,
          actor,
          {
            action: 'admin.backup_codes_regenerate',
            entityType: 'Admin',
            entityId: adminId,
            before: null,
            after: { backupCodesIssued: BACKUP_CODE_COUNT, method },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.recordChange(
          tenantScope,
          tx,
          'admin.backup_codes_regenerated',
          'INFO',
          'an administrator replaced their backup codes',
          { adminId, method },
        );
        return undefined;
      },
    );
    return { backupCodes: codes };
  }

  async listOwnSessions(
    scope: ScopeContext,
    actor: ActorContext,
  ): Promise<readonly AdminSessionSummary[]> {
    const { tenantScope, adminId } = this.self(scope, actor);
    const rows = await this.deps.sessions.listForAdmin(
      tenantScope,
      adminId,
      this.deps.clock.now(),
      OWN_SESSION_LIMIT,
    );
    const mine = actor.sessionId ?? null;
    return rows.map((row) => ({
      id: row.id,
      issuedAt: row.issuedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      ip: row.ip,
      userAgent: row.userAgent,
      current: mine !== null && row.id === mine,
    }));
  }

  /**
   * Ends ONE of the caller's own sessions. Revoking the current one is allowed — it is a
   * sign-out — and reported as `current: true` so the surface clears the cookie. An id
   * that is not theirs is NOT FOUND, whoever it belongs to.
   */
  async revokeOwnSession(
    scope: ScopeContext,
    actor: ActorContext,
    sessionId: string,
  ): Promise<{ revoked: boolean; current: boolean }> {
    const { tenantScope, adminId } = this.self(scope, actor);
    if (!UUID.test(sessionId)) throw sessionNotFound();
    const current = actor.sessionId === sessionId;
    const outcome = await this.deps.uow.run(tenantScope, async (tx) => {
      await this.assertSelfLive(tenantScope, actor, tx);
      const now = this.deps.clock.now();
      const result = await this.deps.sessions.revokeOwn(
        tenantScope,
        adminId,
        sessionId as AdminSessionId,
        now,
        'revoked_by_holder',
        tx,
      );
      if (result === 'NOT_FOUND') return result;
      await this.deps.audit.record(
        tenantScope,
        actor,
        {
          action: 'auth.session_revoke',
          entityType: 'Admin',
          entityId: adminId,
          before: null,
          after: { signIn: sessionId, ended: result === 'REVOKED', thisDevice: current },
          result: 'SUCCESS',
        },
        tx,
      );
      return result;
    });
    if (outcome === 'NOT_FOUND') throw sessionNotFound();
    return { revoked: outcome === 'REVOKED', current };
  }

  /** "Sign out everywhere else": every live session but the one making the request. */
  async revokeOtherSessions(scope: ScopeContext, actor: ActorContext): Promise<number> {
    const { tenantScope, adminId } = this.self(scope, actor);
    if (actor.sessionId === undefined) {
      throw errors.unauthenticated(IDENTITY_ERROR_CODES.AUTH_REQUIRED, 'Sign in first.');
    }
    return this.deps.uow.run(tenantScope, async (tx) => {
      await this.assertSelfLive(tenantScope, actor, tx);
      const now = this.deps.clock.now();
      const ended = await this.endOtherSessions(
        tenantScope,
        actor,
        adminId,
        now,
        tx,
        'revoked_by_holder',
      );
      await this.deps.audit.record(
        tenantScope,
        actor,
        {
          action: 'auth.sessions_revoke_others',
          entityType: 'Admin',
          entityId: adminId,
          before: { liveSignIns: ended + 1 },
          after: { endedSignIns: ended },
          result: 'SUCCESS',
        },
        tx,
      );
      return ended;
    });
  }

  /** The caller's own sign-in and security history, newest first. */
  async securityEvents(
    scope: ScopeContext,
    actor: ActorContext,
  ): Promise<readonly SecurityEvent[]> {
    const { tenantScope, adminId } = this.self(scope, actor);
    const rows = await this.deps.events.forAdmin(
      tenantScope,
      adminId,
      SECURITY_EVENT_ACTIONS,
      SECURITY_EVENT_LIMIT,
    );
    return rows.flatMap((row) => {
      if (!(SECURITY_EVENT_ACTIONS as readonly string[]).includes(row.action)) return [];
      const reason = row.after?.['reason'];
      const method = row.after?.['method'];
      return [
        {
          id: row.id,
          action: row.action as SecurityEventAction,
          result: row.result as SecurityEvent['result'],
          occurredAt: row.occurredAt.toISOString(),
          // Named only when somebody ELSE acted on this account: an operator, or the
          // server recovery path. The holder's own acts need no name.
          actorLabel: row.actorId === adminId ? null : row.actorLabel,
          // The address and agent only when the account holder acted (D2 review): on a row
          // an OPERATOR wrote, they are the operator's, not this holder's to see.
          ip: row.actorId === adminId ? row.ip : null,
          userAgent: row.actorId === adminId ? row.userAgent : null,
          reason: typeof reason === 'string' ? reason : null,
          method:
            typeof method === 'string' &&
            (SECOND_FACTOR_METHODS as readonly string[]).includes(method)
              ? (method as SecondFactorMethod)
              : null,
        },
      ];
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * Password, then a second-factor proof, then `fn` — in that order, each throttled.
   *
   * The password goes through `verifyOwnPassword` (the shared counter, its own audit
   * row). The code is RESERVED on the same counter before it is checked: a wrong code
   * keeps its reservation, so holding the password does not make this an unthrottled
   * guessing oracle for six digits.
   */
  private async withProof(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
    context: PasswordChangeContext,
    action: string,
    fn: (
      tenantScope: TenantContext,
      adminId: AdminId,
      method: SecondFactorMethod,
      now: Date,
      tx: TransactionScope,
    ) => Promise<undefined>,
  ): Promise<void> {
    const { tenantScope, adminId } = this.self(scope, actor);
    const command = reauthenticateWithSecondFactorSchema.parse(input);
    await this.deps.verifyOwnPassword(scope, actor, command.password, context, action);

    const admin = await this.requireAdmin(tenantScope, adminId);
    const method: SecondFactorMethod = command.code !== undefined ? 'TOTP' : 'BACKUP_CODE';
    const reserved = await this.reserveGuess(tenantScope, actor, admin, context, action, method);

    let outcome: ProofOutcome;
    try {
      outcome = await this.deps.uow.run(tenantScope, async (tx): Promise<ProofOutcome> => {
        await this.lockSelf(tenantScope, actor, adminId, tx);
        const now = this.deps.clock.now();
        const factor: StoredTotpFactor | null = await this.deps.factors.lockFactor(
          tenantScope,
          adminId,
          tx,
        );
        if (factor === null || factor.state !== 'ACTIVE') return { kind: 'NOT_ACTIVE' };
        const verdict = await verifySecondFactorProof(
          this.deps,
          tenantScope,
          adminId,
          factor,
          command,
          now,
          tx,
        );
        if (!verdict.accepted) return { kind: 'REJECTED', verdict };
        await fn(tenantScope, adminId, verdict.method, now, tx);
        // In the SAME transaction as the change (Codex review): released afterwards, a
        // transient failure reported an error for a change already made — a regeneration
        // whose old codes were gone and whose new ones were never delivered.
        await this.deps.throttle.releaseIn(tenantScope, admin.username, context.ip, reserved, tx);
        return { kind: 'OK', method: verdict.method };
      });
    } catch (error) {
      // Never judged: not counted.
      await this.deps.throttle.release(tenantScope, admin.username, context.ip, reserved);
      throw error;
    }

    if (outcome.kind === 'REJECTED') {
      // Judged and wrong: the reservation stays.
      await this.deps.audit.record(tenantScope, actor, {
        action,
        entityType: 'Admin',
        entityId: adminId,
        before: null,
        after: {
          reason: 'BAD_SECOND_FACTOR',
          method,
          ...(outcome.verdict.accepted ? {} : { detail: outcome.verdict.reason }),
        },
        result: 'DENIED',
      });
      throw errors.unauthenticated(
        IDENTITY_ERROR_CODES.AUTH_SECOND_FACTOR_INVALID,
        'The code is not valid.',
      );
    }
    if (outcome.kind === 'NOT_ACTIVE') {
      // Never judged: the reservation goes back.
      await this.deps.throttle.release(tenantScope, admin.username, context.ip, reserved);
      throw errors.conflict(
        IDENTITY_ERROR_CODES.ADMIN_SECOND_FACTOR_NOT_ACTIVE,
        'Two-step sign-in is not on for this account.',
      );
    }
  }

  private async writeBackupCodes(
    scope: TenantContext,
    adminId: AdminId,
    codes: readonly string[],
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.factors.replaceBackupCodes(
      scope,
      adminId,
      codes.map((code) => ({
        id: this.deps.ids.uuid(),
        codeHash: hashBackupCode(scope.tenantId, adminId, normaliseBackupCode(code) as string),
      })),
      now,
      tx,
    );
  }

  private async endOtherSessions(
    scope: TenantContext,
    actor: ActorContext,
    adminId: AdminId,
    now: Date,
    tx: TransactionScope,
    reason: string,
  ): Promise<number> {
    // A caller with no session (a service-level test, a job) keeps none.
    if (actor.sessionId === undefined) {
      return this.deps.sessions.revokeAllForAdmin(scope, adminId, now, reason, tx);
    }
    return this.deps.sessions.revokeOthersForAdmin(
      scope,
      adminId,
      actor.sessionId as AdminSessionId,
      now,
      reason,
      tx,
    );
  }

  private async recordChange(
    scope: ScopeContext,
    tx: TransactionScope,
    code: ManagementAdminEventCode,
    severity: 'INFO' | 'WARN',
    message: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.opsLog.record(scope, { code, severity, message, context }, tx);
  }

  /** The tenant and administrator a self-service call acts on. */
  private self(
    scope: ScopeContext,
    actor: ActorContext,
  ): { tenantScope: TenantContext; adminId: AdminId } {
    if (actor.type !== 'WEB_ADMIN' || actor.id === null) {
      throw errors.unauthenticated(IDENTITY_ERROR_CODES.AUTH_REQUIRED, 'Sign in first.');
    }
    if (isSystemContext(scope)) {
      throw errors.validation(
        PLATFORM_ERROR_CODES.TENANT_CONTEXT_MISSING,
        'Account security needs a tenant scope.',
      );
    }
    return { tenantScope: scope, adminId: actor.id as AdminId };
  }

  /** Tenant active and session live, on the locked connection. */
  private async assertSelfLive(
    scope: TenantContext,
    actor: ActorContext,
    tx: TransactionScope,
  ): Promise<void> {
    if ((await this.deps.admins.lockTenantForRead(scope, tx)) !== 'ACTIVE') {
      throw errors.unauthenticated(
        IDENTITY_ERROR_CODES.AUTH_SESSION_INVALID,
        'The session is not valid. Sign in again.',
      );
    }
    if (actor.sessionId !== undefined) {
      const live = await this.deps.sessions.isLive(
        scope,
        actor.sessionId as AdminSessionId,
        this.deps.clock.now(),
        tx,
      );
      if (!live) {
        throw errors.unauthenticated(
          IDENTITY_ERROR_CODES.AUTH_SESSION_INVALID,
          'The session is not valid. Sign in again.',
        );
      }
    }
  }

  /** `assertSelfLive`, then the administrator's row lock — the one login takes. */
  private async lockSelf(
    scope: TenantContext,
    actor: ActorContext,
    adminId: AdminId,
    tx: TransactionScope,
  ): Promise<Admin> {
    await this.assertSelfLive(scope, actor, tx);
    if ((await this.deps.admins.lockActiveCredential(scope, adminId, tx)) === null) {
      throw errors.unauthenticated(
        IDENTITY_ERROR_CODES.AUTH_SESSION_INVALID,
        'The session is not valid. Sign in again.',
      );
    }
    return this.requireAdmin(scope, adminId, tx);
  }

  private async requireAdmin(scope: TenantContext, adminId: AdminId, tx?: unknown): Promise<Admin> {
    const admin = await this.deps.admins.findById(scope, adminId, tx);
    if (admin === null) {
      throw errors.notFound(IDENTITY_ERROR_CODES.ADMIN_NOT_FOUND, 'No such administrator.');
    }
    return admin;
  }

  private qrDataUrl(uri: string): string | null {
    if (this.deps.qr === null) return null;
    try {
      return `data:image/png;base64,${Buffer.from(this.deps.qr.encode(uri)).toString('base64')}`;
    } catch (error) {
      // The manual secret always works; an encoder refusal is not the enrolment failing.
      if (isNexaError(error)) return null;
      throw error;
    }
  }
}

function isExpiredPending(factor: StoredTotpFactor, now: Date): boolean {
  return (
    factor.state === 'PENDING' &&
    factor.createdAt.getTime() + TOTP_ENROLMENT_TTL_SECONDS * 1000 <= now.getTime()
  );
}

function notPending() {
  return errors.conflict(
    IDENTITY_ERROR_CODES.ADMIN_SECOND_FACTOR_NOT_PENDING,
    'There is no enrolment waiting, or it has expired. Start again.',
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionNotFound() {
  return errors.notFound(IDENTITY_ERROR_CODES.ADMIN_SESSION_NOT_FOUND, 'No such session.');
}
