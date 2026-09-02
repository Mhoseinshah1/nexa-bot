import {
  NexaError,
  isNexaError,
  IDENTITY_ERROR_CODES,
  type ActorContext,
  type Clock,
} from '@nexa/contracts';
import type { OperationalEventRecorder, TenantContext } from '@nexa/contracts';
import type { LoginThrottleRepository, ThrottleState } from './ports.js';

/**
 * Counting attempts at a password, and refusing past the limit.
 *
 * Extracted because there is now more than one way to submit a password. Login
 * is the obvious one; `changeOwnPassword` is the other, and it went unthrottled
 * — an attacker holding a stolen session could guess the current password
 * without limit, each guess costing a production-cost scrypt derivation. That is
 * both a brute force and a way to burn CPU and memory, and finding the password
 * turns a session that expires into a credential that does not.
 *
 * Both paths share ONE counter per subject, deliberately. Separate counters
 * would mean an attacker locked out of login could keep guessing on the
 * rotation endpoint, which is the same credential by another door.
 *
 * The audit row stays with the caller: a refused login and a refused rotation
 * are different actions and must not be recorded as the same one. Only the
 * operational event, which describes the lockout rather than the request, is
 * written here.
 */
export interface ThrottlePolicy {
  readonly windowSeconds: number;
  readonly maxAttemptsPerUsername: number;
  readonly maxAttemptsPerIp: number;
  readonly lockoutSeconds: number;
}

export interface Reservation {
  readonly username: ThrottleState;
  readonly ip: ThrottleState | null;
}

export class CredentialThrottle {
  constructor(
    private readonly throttle: LoginThrottleRepository,
    private readonly opsLog: OperationalEventRecorder,
    private readonly clock: Clock,
    private readonly policy: ThrottlePolicy,
  ) {}

  /** The IP limit, for the one release that happens inside a transaction. */
  get maxAttemptsPerIp(): number {
    return this.policy.maxAttemptsPerIp;
  }

  /**
   * Counts this attempt against both subjects and refuses if it crosses a limit.
   *
   * Called BEFORE the verification, so the reservation is what stops a burst
   * rather than the count that follows it.
   */
  async reserve(
    scope: TenantContext,
    actor: ActorContext,
    username: string,
    ip: string | null,
  ): Promise<Reservation> {
    const now = this.clock.now();

    // An ACTIVE lock is refused before anything is written.
    //
    // Reserving over an existing lock re-runs the over-limit branch, which sets
    // `locked_until = now + lockoutSeconds` — so every further attempt extends
    // the deadline instead of serving it. Login happened to avoid this by
    // checking first; the rotation path did not, and an attacker holding a
    // stolen session could send cheap, already-refused requests indefinitely to
    // keep the real administrator locked out for good. The check belongs here,
    // where every caller gets it, rather than in one of them.
    await this.assertNotLocked(scope, username, ip, now);

    const usernameState = await this.throttle.reserveAttempt(scope, 'USERNAME', username, now, {
      windowSeconds: this.policy.windowSeconds,
      maxAttempts: this.policy.maxAttemptsPerUsername,
      lockoutSeconds: this.policy.lockoutSeconds,
    });

    // If the SECOND reservation fails, the first has already committed and
    // nothing would ever give it back — a transient database error would count
    // as a failed attempt by somebody who never made one, and at a limit of 1
    // would lock them out once the database recovered.
    let ipState: ThrottleState | null;
    try {
      ipState =
        ip === null
          ? null
          : await this.throttle.reserveAttempt(scope, 'IP', ip, now, {
              windowSeconds: this.policy.windowSeconds,
              maxAttempts: this.policy.maxAttemptsPerIp,
              lockoutSeconds: this.policy.lockoutSeconds,
            });
    } catch (error) {
      await this.throttle.releaseAttempt(
        scope,
        'USERNAME',
        username,
        this.policy.maxAttemptsPerUsername,
        usernameState.windowStartedAt,
      );
      throw error;
    }

    const subjects = [
      ['USERNAME', usernameState, this.policy.maxAttemptsPerUsername, username],
      ['IP', ipState, this.policy.maxAttemptsPerIp, ip ?? ''],
    ] as const;
    const reserved: Reservation = { username: usernameState, ip: ipState };

    // Everything from here runs with BOTH reservations already committed, and
    // the caller's own cleanup does not begin until this method returns. So a
    // failure in here — writing the lockout event, say — would stand the counts
    // up permanently without any credential ever being judged.
    try {
      // The attempt that REACHES the limit establishes the lockout. It is still
      // verified — see below — but the lockout is worth alerting on from the
      // moment it exists, and this is the only place that observes it: the
      // failure path is not reached for a refused attempt, and the refusal path
      // is not reached by the attempt that merely reaches the limit.
      for (const [kind, state, limit, subject] of subjects) {
        if (state !== null && state.failedCount >= limit) {
          await this.opsLog.record(scope, {
            code: 'auth.login_locked_out',
            severity: 'WARN',
            message: `Password attempts were locked out for a ${kind.toLowerCase()} subject.`,
            context: { username, subjectKind: kind, failedCount: state.failedCount },
            dedupeKey: `auth.login_locked_out:${kind}:${subject}`,
            correlationId: actor.correlationId,
          });
        }
      }

      // Refused only once the attempt is PAST the configured number, not on the
      // one that reaches it. `maxAttempts` is how many attempts are allowed, so
      // rejecting the Nth would give N-1 credential checks — and with a limit of
      // 1 the very first login, correct password and all, would be refused and
      // the installation would have no way in.
      for (const [, state, limit] of subjects) {
        if (state !== null && state.failedCount > limit) {
          // Give BOTH reservations back before refusing. This request never
          // reaches the KDF and never checks a credential, so counting it
          // overstates what happened — and the overstatement sticks, holding the
          // subject at the limit and keeping the lock alive.
          await this.release(scope, username, ip, reserved);
          throw new NexaError({
            kind: 'RATE_LIMITED',
            code: IDENTITY_ERROR_CODES.AUTH_RATE_LIMITED,
            message: 'Too many attempts. Try again later.',
            details: {
              retryAfterSeconds: Math.max(
                1,
                Math.ceil(((state.lockedUntil?.getTime() ?? now.getTime()) - now.getTime()) / 1000),
              ),
            },
          });
        }
      }

      return reserved;
    } catch (error) {
      // A refusal releases on its own terms below and rethrows; anything else
      // is a failure that judged nothing, so both subjects go back.
      if (isNexaError(error) && error.code === IDENTITY_ERROR_CODES.AUTH_RATE_LIMITED) throw error;
      await this.release(scope, username, ip, reserved);
      throw error;
    }
  }

  /**
   * Refuses while a lock is being served, without touching the row.
   *
   * Reads only. Writing here is what would renew the deadline it is checking.
   */
  private async assertNotLocked(
    scope: TenantContext,
    username: string,
    ip: string | null,
    now: Date,
  ): Promise<void> {
    const subjects: ['USERNAME' | 'IP', string][] = [['USERNAME', username]];
    if (ip !== null) subjects.push(['IP', ip]);

    for (const [kind, subject] of subjects) {
      const state = await this.throttle.find(scope, kind, subject);
      if (state?.lockedUntil && state.lockedUntil.getTime() > now.getTime()) {
        throw new NexaError({
          kind: 'RATE_LIMITED',
          code: IDENTITY_ERROR_CODES.AUTH_RATE_LIMITED,
          message: 'Too many attempts. Try again later.',
          details: {
            subjectKind: kind,
            retryAfterSeconds: Math.ceil((state.lockedUntil.getTime() - now.getTime()) / 1000),
          },
        });
      }
    }
  }

  /**
   * Returns both reservations a call made.
   *
   * Used only where the attempt is abandoned without being verified. A failure
   * that WAS verified keeps its reservation — that is the failure being counted.
   */
  async release(
    scope: TenantContext,
    username: string,
    ip: string | null,
    reserved: Reservation,
  ): Promise<void> {
    await this.throttle.releaseAttempt(
      scope,
      'USERNAME',
      username,
      this.policy.maxAttemptsPerUsername,
      reserved.username.windowStartedAt,
    );
    if (ip !== null && reserved.ip !== null) {
      await this.throttle.releaseAttempt(
        scope,
        'IP',
        ip,
        this.policy.maxAttemptsPerIp,
        reserved.ip.windowStartedAt,
      );
    }
  }
}
