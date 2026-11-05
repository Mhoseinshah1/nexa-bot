import { createHash, randomBytes } from 'node:crypto';
import {
  errors,
  hostingActivateRequestSchema,
  hostingEnrolRequestSchema,
  hostingOpenSessionRequestSchema,
  hostingProofSchema,
  hostingRecoveryCodesRequestSchema,
  HOSTING_CODE_LOCKOUT_SECONDS,
  HOSTING_CODE_MAX_FAILURES,
  HOSTING_ENROLMENT_TTL_SECONDS,
  HOSTING_ERROR_CODES,
  HOSTING_RECOVERY_CODE_COUNT,
  HOSTING_SECTION_SESSION_TTL_SECONDS,
  HOSTING_TOTP_ISSUER,
  NexaError,
  TOTP_PARAMETERS,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type HostingActivateResponse,
  type HostingEnrolResponse,
  type HostingProof,
  type HostingRecoveryCodesResponse,
  type HostingSessionResponse,
  type IdGenerator,
  type ScopeContext,
  type SecondFactorMethod,
  type SecretCipher,
  type SecretContext,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  generateBackupCodes,
  normaliseBackupCode,
} from '../../identity/application/backup-codes.js';
import { generateTotpSecret, matchTotp, otpauthUri } from '../../identity/application/totp.js';
import type { HostingOwnerGuard } from './hosting-owner-guard.js';
import type { HostingFactorRow, HostingRepository, HostingSessionRow } from './ports.js';

/**
 * Phase 6A PR-3 — the creator panel's own second factor and its 12-hour section session.
 *
 * MANDATORY for this section and for this section only: the rest of the Web Admin is
 * unchanged, and the Web Admin sign-in factor (`admin_totp_factors`) is a different secret
 * with different recovery codes, so neither opens the other.
 *
 * - Enrolment: the owner's password (the shared, throttled step-up) → a fresh RFC 6238
 *   secret sealed under `hosting.totp_secret` (the installation's keyring), shown once as a
 *   secret, an `otpauth://` URI and a QR; activation with a first code, from the SAME Web
 *   Admin session, within 15 minutes, returns ten one-time recovery codes and opens the
 *   section.
 * - Section session: 12 hours by the `Clock`, its own httpOnly cookie, bound to the Web
 *   Admin session it was opened from — signing out, or the same cookie in another browser's
 *   session, opens nothing.
 * - Sensitive actions re-ask: `verifyFreshProof` is called by every create, suspend,
 *   activate, delete, purge, expiry and limits change, on top of the open section.
 * - Codes: a TOTP step is accepted once (the replay rule); a recovery code is spent by a
 *   conditional update; regenerating replaces the whole set in one transaction.
 * - Throttle: every code attempt is checked under the factor row's lock, and a wrong one is
 *   counted IN THE SAME TRANSACTION that judged it, which commits — so parallel guesses
 *   queue on the lock and each sees the previous one's count. Five wrong codes lock the
 *   section's codes for 15 minutes; a right one resets the count.
 */

/** `hosting.totp_secret`: the entity is the factor row's id. */
export function hostingTotpSecretContext(tenantId: string, factorId: string): SecretContext {
  return { purpose: 'hosting.totp_secret', tenantId, entityId: factorId };
}

/** Domain-separated from the sign-in factor's backup codes: one cannot verify as the other. */
export function hashRecoveryCode(tenantId: string, adminId: string, normalised: string): string {
  return createHash('sha256')
    .update(`nexa.hosting_recovery_code.v1\n${tenantId}\n${adminId}\n${normalised}`, 'utf8')
    .digest('hex');
}

export function hashSectionToken(token: string): string {
  return createHash('sha256').update(`nexa.hosting_session.v1\n${token}`, 'utf8').digest('hex');
}

export interface OpenedSection {
  readonly token: string;
  readonly expiresAt: Date;
}

type Verdict =
  | { readonly kind: 'OK'; readonly method: SecondFactorMethod }
  | { readonly kind: 'NO_FACTOR' }
  | { readonly kind: 'LOCKED'; readonly until: Date }
  | {
      readonly kind: 'REJECTED';
      readonly method: SecondFactorMethod;
      readonly reason: string;
      readonly lockedUntil: Date | null;
    };

export interface HostingSectionDeps {
  readonly uow: UnitOfWork<TransactionScope>;
  readonly repository: HostingRepository;
  readonly owner: HostingOwnerGuard;
  readonly cipher: SecretCipher;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly qr: { encode(text: string): Uint8Array } | null;
  readonly verifyOwnPassword: (
    scope: ScopeContext,
    actor: ActorContext,
    password: string,
    context: { readonly ip: string | null },
    action: string,
  ) => Promise<void>;
}

export class HostingSectionService {
  constructor(private readonly deps: HostingSectionDeps) {}

  /** The section's state for the status card. Owner only. */
  async status(
    scope: ScopeContext,
    actor: ActorContext,
    sectionToken: string | null,
  ): Promise<{
    factor: 'NONE' | 'PENDING' | 'ACTIVE';
    recoveryCodesRemaining: number;
    session: { expiresAt: string } | null;
    lockedUntil: string | null;
  }> {
    const installation = await this.deps.owner.checkAudited(scope, actor, 'hosting.status');
    const adminId = actor.id as string;
    const now = this.deps.clock.now();
    const factor = await this.deps.repository.findFactor(installation, adminId);
    const session =
      sectionToken === null ? null : await this.liveSession(installation, actor, sectionToken);
    const pendingExpired =
      factor?.state === 'PENDING' && this.pendingDeadline(factor).getTime() <= now.getTime();
    return {
      factor: factor === null || pendingExpired ? 'NONE' : factor.state,
      recoveryCodesRemaining:
        factor?.state === 'ACTIVE'
          ? await this.deps.repository.countUnusedRecoveryCodes(installation, adminId)
          : 0,
      session: session === null ? null : { expiresAt: session.expiresAt.toISOString() },
      lockedUntil:
        factor?.lockedUntil != null && factor.lockedUntil.getTime() > now.getTime()
          ? factor.lockedUntil.toISOString()
          : null,
    };
  }

  /** Starts (or restarts) enrolment. Refused while a factor is ACTIVE. */
  async enrol(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
    context: { readonly ip: string | null },
  ): Promise<HostingEnrolResponse> {
    const installation = await this.deps.owner.checkAudited(scope, actor, 'hosting.totp_enrol');
    const command = hostingEnrolRequestSchema.parse(input);
    await this.deps.verifyOwnPassword(
      installation,
      actor,
      command.password,
      context,
      'hosting.totp_enrol',
    );
    const adminId = actor.id as string;
    const secret = generateTotpSecret();
    const factorId = this.deps.ids.uuid();
    const expiresAt = await this.deps.uow.run(installation, async (tx) => {
      await this.deps.owner.check(installation, actor, tx);
      const now = this.deps.clock.now();
      const existing = await this.deps.repository.lockFactor(installation, adminId, tx);
      if (existing?.state === 'ACTIVE') {
        throw errors.conflict(
          HOSTING_ERROR_CODES.SECOND_FACTOR_ACTIVE,
          'The creator panel’s two-step code is already on.',
        );
      }
      const sealed = this.deps.cipher.encrypt(
        secret,
        hostingTotpSecretContext(installation.tenantId, factorId),
      );
      await this.deps.repository.replaceWithPending(
        installation,
        {
          id: factorId,
          adminId,
          ciphertext: sealed.ciphertext,
          keyId: sealed.keyId,
          enrolledSessionId: actor.sessionId ?? null,
          now,
        },
        tx,
      );
      const deadline = new Date(now.getTime() + HOSTING_ENROLMENT_TTL_SECONDS * 1000);
      await this.deps.audit.record(
        installation,
        actor,
        {
          action: 'hosting.totp_enrol',
          entityType: 'Admin',
          entityId: adminId,
          before: existing === null ? null : { state: existing.state },
          after: { state: 'PENDING', expiresAt: deadline.toISOString() },
          result: 'SUCCESS',
        },
        tx,
      );
      return deadline;
    });
    const uri = otpauthUri({
      issuer: HOSTING_TOTP_ISSUER,
      account: actor.label ?? adminId,
      secret,
    });
    return {
      secret,
      otpauthUri: uri,
      qrPngDataUrl: this.qrDataUrl(uri),
      expiresAt: expiresAt.toISOString(),
      parameters: {
        algorithm: TOTP_PARAMETERS.algorithm,
        digits: TOTP_PARAMETERS.digits,
        periodSeconds: TOTP_PARAMETERS.periodSeconds,
      },
    };
  }

  /**
   * Turns the pending factor on with a first code from the device, from the session that
   * was shown the secret. Answers the first recovery codes (once) and opens the section.
   */
  async activate(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<HostingActivateResponse & { readonly opened: OpenedSection }> {
    const installation = await this.deps.owner.checkAudited(scope, actor, 'hosting.totp_activate');
    const command = hostingActivateRequestSchema.parse(input);
    const adminId = actor.id as string;
    const sessionId = this.requireWebSession(actor);
    const codes = generateBackupCodes(HOSTING_RECOVERY_CODE_COUNT);
    const token = randomBytes(32).toString('base64url');

    const outcome = await this.deps.uow.run(installation, async (tx) => {
      await this.deps.owner.check(installation, actor, tx);
      const now = this.deps.clock.now();
      const factor = await this.deps.repository.lockFactor(installation, adminId, tx);
      if (factor === null || factor.state !== 'PENDING') {
        return { kind: 'GONE' as const };
      }
      if (this.pendingDeadline(factor).getTime() <= now.getTime()) {
        await this.deps.repository.deleteFactor(installation, factor.id, tx);
        return { kind: 'GONE' as const };
      }
      // The secret was shown to ONE Web Admin session; a stolen cookie elsewhere cannot finish.
      if (factor.enrolledSessionId !== null && factor.enrolledSessionId !== sessionId) {
        return { kind: 'GONE' as const };
      }
      if (factor.lockedUntil !== null && factor.lockedUntil.getTime() > now.getTime()) {
        return { kind: 'LOCKED' as const, until: factor.lockedUntil };
      }
      const secret = this.decrypt(installation, factor);
      const step = matchTotp(secret, command.code, now, factor.lastUsedStep);
      if (step === null) {
        const lockedUntil = await this.countFailure(installation, factor, now, tx);
        return { kind: 'REJECTED' as const, lockedUntil };
      }
      if (!(await this.deps.repository.activate(installation, factor.id, step, now, tx))) {
        return { kind: 'GONE' as const };
      }
      await this.deps.repository.replaceRecoveryCodes(
        installation,
        adminId,
        this.hashCodes(installation, adminId, codes),
        now,
        tx,
      );
      const expiresAt = await this.insertSession(installation, adminId, sessionId, token, now, tx);
      await this.deps.audit.record(
        installation,
        actor,
        {
          action: 'hosting.totp_activate',
          entityType: 'Admin',
          entityId: adminId,
          before: { state: 'PENDING' },
          after: { state: 'ACTIVE', recoveryCodes: codes.length, sectionOpened: true },
          result: 'SUCCESS',
        },
        tx,
      );
      return { kind: 'OK' as const, expiresAt };
    });

    if (outcome.kind === 'GONE') {
      throw errors.preconditionFailed(
        HOSTING_ERROR_CODES.ENROLMENT_EXPIRED,
        'There is no enrolment waiting for a code here. Start again.',
      );
    }
    if (outcome.kind === 'LOCKED') throw this.locked(outcome.until);
    if (outcome.kind === 'REJECTED') {
      await this.auditRejection(installation, actor, 'hosting.totp_activate', 'TOTP', 'WRONG_CODE');
      if (outcome.lockedUntil !== null) throw this.locked(outcome.lockedUntil);
      throw this.rejected();
    }
    return {
      recoveryCodes: codes,
      session: { expiresAt: outcome.expiresAt.toISOString() },
      opened: { token, expiresAt: outcome.expiresAt },
    };
  }

  /** Opens a 12-hour section session with a fresh code (or a recovery code). */
  async openSession(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<HostingSessionResponse & { readonly opened: OpenedSection }> {
    const installation = await this.deps.owner.checkAudited(scope, actor, 'hosting.session_open');
    const command = hostingOpenSessionRequestSchema.parse(input);
    const adminId = actor.id as string;
    const sessionId = this.requireWebSession(actor);
    const token = randomBytes(32).toString('base64url');
    const { result: opened } = await this.withFreshProof(
      installation,
      actor,
      command.proof,
      'hosting.session_open',
      async (tx, now, method) => {
        await this.deps.owner.check(installation, actor, tx);
        const expiresAt = await this.insertSession(
          installation,
          adminId,
          sessionId,
          token,
          now,
          tx,
        );
        await this.deps.audit.record(
          installation,
          actor,
          {
            action: 'hosting.session_open',
            entityType: 'Admin',
            entityId: adminId,
            before: null,
            after: { expiresAt: expiresAt.toISOString(), proof: method },
            result: 'SUCCESS',
          },
          tx,
        );
        return expiresAt;
      },
    );
    return { session: { expiresAt: opened.toISOString() }, opened: { token, expiresAt: opened } };
  }

  /** Ends this Web Admin session's section session. */
  async closeSession(scope: ScopeContext, actor: ActorContext): Promise<{ closed: number }> {
    const installation = await this.deps.owner.checkAudited(scope, actor, 'hosting.session_close');
    const closed = await this.deps.repository.revokeSessions(installation, {
      adminId: actor.id as string,
      adminSessionId: this.requireWebSession(actor),
      now: this.deps.clock.now(),
    });
    await this.deps.audit.record(installation, actor, {
      action: 'hosting.session_close',
      entityType: 'Admin',
      entityId: actor.id,
      before: null,
      after: { closed },
      result: 'SUCCESS',
    });
    return { closed };
  }

  /** A new set of recovery codes; the previous set dies in the same transaction. */
  async regenerateRecoveryCodes(
    scope: ScopeContext,
    actor: ActorContext,
    sectionToken: string | null,
    input: unknown,
  ): Promise<HostingRecoveryCodesResponse> {
    const installation = await this.requireSection(
      scope,
      actor,
      sectionToken,
      'hosting.recovery_codes',
    );
    const command = hostingRecoveryCodesRequestSchema.parse(input);
    const adminId = actor.id as string;
    const codes = generateBackupCodes(HOSTING_RECOVERY_CODE_COUNT);
    await this.withFreshProof(
      installation,
      actor,
      command.proof,
      'hosting.recovery_codes',
      async (tx, now, method) => {
        await this.deps.owner.check(installation, actor, tx);
        await this.assertSectionIn(installation, actor, sectionToken, tx);
        await this.deps.repository.replaceRecoveryCodes(
          installation,
          adminId,
          this.hashCodes(installation, adminId, codes),
          now,
          tx,
        );
        await this.deps.audit.record(
          installation,
          actor,
          {
            action: 'hosting.recovery_codes',
            entityType: 'Admin',
            entityId: adminId,
            before: null,
            after: { recoveryCodes: codes.length, proof: method },
            result: 'SUCCESS',
          },
          tx,
        );
      },
    );
    return { recoveryCodes: codes };
  }

  /**
   * The owner check AND an open section session for this Web Admin session — what every
   * read and action of the panel (other than opening it) requires. Answers the scope.
   */
  async requireSection(
    scope: ScopeContext,
    actor: ActorContext,
    sectionToken: string | null,
    action: string,
    entityId: string | null = null,
  ): Promise<TenantContext> {
    const installation = await this.deps.owner.checkAudited(scope, actor, action, entityId);
    if (
      sectionToken === null ||
      (await this.liveSession(installation, actor, sectionToken)) === null
    ) {
      throw errors.unauthenticated(
        HOSTING_ERROR_CODES.SECTION_SESSION_REQUIRED,
        'Open the creator panel with your two-step code first.',
      );
    }
    return installation;
  }

  /** The same check inside a write transaction: a session revoked mid-request is honoured. */
  async assertSectionIn(
    installation: TenantContext,
    actor: ActorContext,
    sectionToken: string | null,
    tx: unknown,
  ): Promise<void> {
    if (
      sectionToken === null ||
      (await this.liveSession(installation, actor, sectionToken, tx)) === null
    ) {
      throw errors.unauthenticated(
        HOSTING_ERROR_CODES.SECTION_SESSION_REQUIRED,
        'The creator panel’s session ended. Open it again.',
      );
    }
  }

  /**
   * The re-ask: one fresh proof, checked and spent under the factor's lock. A wrong one is
   * counted and committed, audited, and refused; `fn` runs only after an accepted proof, in
   * the same transaction that spent it.
   */
  async withFreshProof<T>(
    installation: TenantContext,
    actor: ActorContext,
    proofInput: unknown,
    action: string,
    fn: (tx: TransactionScope, now: Date, method: SecondFactorMethod) => Promise<T>,
  ): Promise<{ readonly method: SecondFactorMethod; readonly result: T }> {
    const proof = hostingProofSchema.parse(proofInput);
    const adminId = actor.id as string;
    const verdict = await this.deps.uow.run(installation, async (tx): Promise<Verdict> => {
      const now = this.deps.clock.now();
      const factor = await this.deps.repository.lockFactor(installation, adminId, tx);
      if (factor === null || factor.state !== 'ACTIVE') return { kind: 'NO_FACTOR' };
      if (factor.lockedUntil !== null && factor.lockedUntil.getTime() > now.getTime()) {
        return { kind: 'LOCKED', until: factor.lockedUntil };
      }
      const judged = await this.judge(installation, adminId, factor, proof, now, tx);
      if (judged.kind === 'REJECTED') {
        return { ...judged, lockedUntil: await this.countFailure(installation, factor, now, tx) };
      }
      if (factor.failedAttempts > 0 || factor.lockedUntil !== null) {
        await this.deps.repository.setFailures(
          installation,
          factor.id,
          { failedAttempts: 0, lockedUntil: null, now },
          tx,
        );
      }
      return judged;
    });
    if (verdict.kind === 'NO_FACTOR') {
      throw errors.preconditionFailed(
        HOSTING_ERROR_CODES.SECOND_FACTOR_REQUIRED,
        'Turn on the creator panel’s two-step code first.',
      );
    }
    if (verdict.kind === 'LOCKED') {
      await this.auditRejection(installation, actor, action, null, 'LOCKED');
      throw this.locked(verdict.until);
    }
    if (verdict.kind === 'REJECTED') {
      await this.auditRejection(installation, actor, action, verdict.method, verdict.reason);
      if (verdict.lockedUntil !== null) throw this.locked(verdict.lockedUntil);
      throw this.rejected();
    }
    // The action's own transaction: the proof is spent, and only now does `fn` run. A
    // failure in `fn` leaves the code spent (the next one is 30 s away), never re-usable.
    const { method } = verdict;
    const result = await this.deps.uow.run(installation, async (tx) =>
      fn(tx, this.deps.clock.now(), method),
    );
    return { method, result };
  }

  // -------------------------------------------------------------------------------------

  private async judge(
    installation: TenantContext,
    adminId: string,
    factor: HostingFactorRow,
    proof: HostingProof,
    now: Date,
    tx: unknown,
  ): Promise<Verdict> {
    if (proof.code !== undefined) {
      const secret = this.decrypt(installation, factor);
      const step = matchTotp(secret, proof.code, now, factor.lastUsedStep);
      if (step === null) {
        const ignoringReplay = matchTotp(secret, proof.code, now, null);
        return {
          kind: 'REJECTED',
          method: 'TOTP',
          reason: ignoringReplay === null ? 'WRONG_CODE' : 'REPLAYED_CODE',
          lockedUntil: null,
        };
      }
      if (!(await this.deps.repository.consumeStep(installation, factor.id, step, now, tx))) {
        return { kind: 'REJECTED', method: 'TOTP', reason: 'REPLAYED_CODE', lockedUntil: null };
      }
      return { kind: 'OK', method: 'TOTP' };
    }
    const normalised =
      proof.backupCode === undefined ? null : normaliseBackupCode(proof.backupCode);
    const spent =
      normalised !== null &&
      (await this.deps.repository.consumeRecoveryCode(
        installation,
        adminId,
        hashRecoveryCode(installation.tenantId, adminId, normalised),
        now,
        tx,
      ));
    return spent
      ? { kind: 'OK', method: 'BACKUP_CODE' }
      : {
          kind: 'REJECTED',
          method: 'BACKUP_CODE',
          reason: 'UNKNOWN_RECOVERY_CODE',
          lockedUntil: null,
        };
  }

  /** One wrong code, under the lock; answers the lock it set, if this one set it. */
  private async countFailure(
    installation: TenantContext,
    factor: HostingFactorRow,
    now: Date,
    tx: unknown,
  ): Promise<Date | null> {
    // A lock that has run out starts a fresh count.
    const lapsed = factor.lockedUntil !== null && factor.lockedUntil.getTime() <= now.getTime();
    const failedAttempts = (lapsed ? 0 : factor.failedAttempts) + 1;
    const lockedUntil =
      failedAttempts >= HOSTING_CODE_MAX_FAILURES
        ? new Date(now.getTime() + HOSTING_CODE_LOCKOUT_SECONDS * 1000)
        : null;
    await this.deps.repository.setFailures(
      installation,
      factor.id,
      { failedAttempts, lockedUntil, now },
      tx,
    );
    return lockedUntil;
  }

  private async liveSession(
    installation: TenantContext,
    actor: ActorContext,
    token: string,
    tx?: unknown,
  ): Promise<HostingSessionRow | null> {
    if (actor.id === null || actor.sessionId === undefined) return null;
    return this.deps.repository.findLiveSession(
      installation,
      {
        adminId: actor.id,
        adminSessionId: actor.sessionId,
        tokenHash: hashSectionToken(token),
        now: this.deps.clock.now(),
      },
      tx,
    );
  }

  private async insertSession(
    installation: TenantContext,
    adminId: string,
    adminSessionId: string,
    token: string,
    now: Date,
    tx: unknown,
  ): Promise<Date> {
    const expiresAt = new Date(now.getTime() + HOSTING_SECTION_SESSION_TTL_SECONDS * 1000);
    // One section per Web Admin session: opening again replaces it.
    await this.deps.repository.revokeSessions(installation, { adminId, adminSessionId, now }, tx);
    await this.deps.repository.createSession(
      installation,
      {
        id: this.deps.ids.uuid(),
        adminId,
        adminSessionId,
        tokenHash: hashSectionToken(token),
        now,
        expiresAt,
      },
      tx,
    );
    return expiresAt;
  }

  private requireWebSession(actor: ActorContext): string {
    if (actor.sessionId === undefined) {
      throw errors.unauthenticated(
        HOSTING_ERROR_CODES.SECTION_SESSION_REQUIRED,
        'The creator panel opens from a signed-in Web Admin session only.',
      );
    }
    return actor.sessionId;
  }

  private pendingDeadline(factor: HostingFactorRow): Date {
    return new Date(factor.createdAt.getTime() + HOSTING_ENROLMENT_TTL_SECONDS * 1000);
  }

  private decrypt(installation: TenantContext, factor: HostingFactorRow): string {
    return this.deps.cipher.decrypt(
      { ciphertext: factor.ciphertext, keyId: factor.keyId },
      hostingTotpSecretContext(installation.tenantId, factor.id),
    );
  }

  private hashCodes(installation: TenantContext, adminId: string, codes: readonly string[]) {
    return codes.map((code) => ({
      id: this.deps.ids.uuid(),
      hash: hashRecoveryCode(installation.tenantId, adminId, normaliseBackupCode(code) as string),
    }));
  }

  private async auditRejection(
    installation: TenantContext,
    actor: ActorContext,
    action: string,
    method: SecondFactorMethod | null,
    reason: string,
  ): Promise<void> {
    await this.deps.audit.record(installation, actor, {
      action,
      entityType: 'Admin',
      entityId: actor.id,
      before: null,
      // The reason is for an investigator; the caller is told one sentence for all of them.
      after: { proof: method, reason },
      result: 'FAILED',
    });
  }

  private rejected(): Error {
    return errors.validation(HOSTING_ERROR_CODES.CODE_REJECTED, 'That code was not accepted.');
  }

  private locked(until: Date): Error {
    return new NexaError({
      kind: 'RATE_LIMITED',
      code: HOSTING_ERROR_CODES.CODE_ATTEMPTS_LOCKED,
      message: 'Too many wrong codes. Try again later.',
      details: { lockedUntil: until.toISOString() },
    });
  }

  private qrDataUrl(uri: string): string | null {
    if (this.deps.qr === null) return null;
    try {
      return `data:image/png;base64,${Buffer.from(this.deps.qr.encode(uri)).toString('base64')}`;
    } catch {
      // The secret and the URI are still shown; a QR that cannot be drawn is not a failure.
      return null;
    }
  }
}
