import { randomInt } from 'node:crypto';
import {
  COMMERCE_ERROR_CODES,
  START_CAPTCHA_OPERAND_MAX,
  START_CAPTCHA_OPERAND_MIN,
  START_CAPTCHA_OPTION_COUNT,
  errors,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CaptchaRandom,
  StartCaptchaChallenge,
  StartCaptchaRecord,
  StartCaptchaRepository,
} from './start-captcha-ports.js';

/** The flag the whole captcha sits behind (default OFF). */
export const START_CAPTCHA_FEATURE = 'start_captcha';

/**
 * The bot turn acts as `SYSTEM_JOB`, which holds `maintenance.run` and nothing wider — the
 * same permission the turn's other self-service writes (the referral claim, the customer
 * resolution) are charged to.
 */
export const START_CAPTCHA_PERMISSION: PermissionKey = 'maintenance.run';

const NAMESPACE = 'TELEGRAM';

/** The platform CSPRNG; `randomInt` rejects rather than biases. */
export const CRYPTO_CAPTCHA_RANDOM: CaptchaRandom = { randomInt: (max) => randomInt(max) };

/** What the customer is shown: the two numbers and the four answers. Never the index. */
export interface CaptchaQuestion {
  readonly challengeId: string;
  readonly first: number;
  readonly second: number;
  readonly options: readonly number[];
}

/**
 * Where a customer stands at the captcha, as one turn decided it.
 *
 * - `FREE`: not held — no row (never asked), already PASSED, or `start_captcha` is off.
 * - `ASK`: held; answer `question`. `reason` says why this question is shown: `CURRENT` (the
 *   one already asked, nothing written), `WRONG` (a wrong answer counted, a new question),
 *   `EXPIRED` (an answer to a question whose time ran out — not counted, a new question),
 *   `RENEWED` (the old question had expired or a cooldown ended — a new question).
 * - `LOCKED`: the answers ran out; a new question comes after `minutes`.
 * - `PASSED`: THIS answer was right.
 */
export type StartCaptchaOutcome =
  | { readonly kind: 'FREE' }
  | {
      readonly kind: 'ASK';
      readonly reason: 'CURRENT' | 'WRONG' | 'EXPIRED' | 'RENEWED';
      readonly question: CaptchaQuestion;
      /** Wrong answers still allowed before the cooldown. */
      readonly remaining: number;
    }
  | { readonly kind: 'LOCKED'; readonly minutes: number }
  | { readonly kind: 'PASSED' };

export interface StartCaptchaServiceDeps {
  readonly captchas: StartCaptchaRepository;
  readonly features: {
    isEnabled(
      scope: TenantContext,
      key: typeof START_CAPTCHA_FEATURE,
      tx?: unknown,
    ): Promise<boolean>;
  };
  readonly settings: { valueOf<T>(scope: TenantContext, key: string, tx?: unknown): Promise<T> };
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly idempotency: IdempotencyStore;
  readonly clock: Clock;
  readonly ids: Pick<IdGenerator, 'uuid'>;
  readonly random?: CaptchaRandom;
}

/**
 * A new question: `a + b` with `a`, `b` in 1..9, the right sum and three different wrong
 * ones (all in 2..18, the range of every possible sum, so no option gives itself away by
 * being impossible), in a random order. Pure over `random`.
 */
export function newCaptchaChallenge(
  random: CaptchaRandom,
  challengeId: string,
): StartCaptchaChallenge {
  const span = START_CAPTCHA_OPERAND_MAX - START_CAPTCHA_OPERAND_MIN + 1;
  const operandA = START_CAPTCHA_OPERAND_MIN + random.randomInt(span);
  const operandB = START_CAPTCHA_OPERAND_MIN + random.randomInt(span);
  const answer = operandA + operandB;
  const lowest = START_CAPTCHA_OPERAND_MIN * 2;
  const highest = START_CAPTCHA_OPERAND_MAX * 2;
  const wrong: number[] = [];
  for (let value = lowest; value <= highest; value += 1) if (value !== answer) wrong.push(value);
  // A partial Fisher–Yates: the first three of a uniform shuffle of the wrong sums.
  for (let i = 0; i < START_CAPTCHA_OPTION_COUNT - 1; i += 1) {
    const j = i + random.randomInt(wrong.length - i);
    [wrong[i], wrong[j]] = [wrong[j] as number, wrong[i] as number];
  }
  const answerIndex = random.randomInt(START_CAPTCHA_OPTION_COUNT);
  const options = wrong.slice(0, START_CAPTCHA_OPTION_COUNT - 1);
  options.splice(answerIndex, 0, answer);
  return { challengeId, operandA, operandB, options, answerIndex };
}

/** Whole minutes until `until`, rounded up, never below one. */
export function captchaMinutesLeft(until: Date, now: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
}

function questionOf(challenge: StartCaptchaChallenge): CaptchaQuestion {
  return {
    challengeId: challenge.challengeId,
    first: challenge.operandA,
    second: challenge.operandB,
    options: challenge.options,
  };
}

interface CaptchaTerms {
  readonly expirySeconds: number;
  readonly maxAttempts: number;
  readonly cooldownSeconds: number;
}

/**
 * R10 D5 (a): the optional `/start` captcha for NEW customers.
 *
 * ## Who is asked
 *
 * Only a customer CREATED while `start_captcha` is on. `requireOnArrival` runs inside the
 * transaction that creates the customer row and writes the captcha row there or nowhere, so
 * a customer who existed before the switch, an imported one, one created while it was off,
 * and a turn whose registration rolled back are never asked. The gate holds a customer only
 * while their row is PENDING AND the flag is on: turning the flag off frees every waiting
 * customer at once, touching no row, and turning it back on holds again only those who never
 * answered.
 *
 * ## What a failure costs
 *
 * Never a block. A wrong answer counts one attempt and asks a new question; at
 * `captcha.max_attempts` the customer waits `captcha.cooldown_seconds` and is then asked a
 * new question with the count reset. The customer row is not read for writing, its status is
 * never changed, and no operator is told: a person who cannot add two digits is not an abuser
 * to report. The anti-spam limit still counts every tap, as it counts every update.
 *
 * ## Every write is conditional
 *
 * On `state = 'PENDING' AND challenge_id = <the question tapped>`: the tap's id, not the row's,
 * so a tap on an old question — a stale keyboard, a replayed or crafted callback — changes
 * nothing and costs nothing, and the UPDATE's row count is the decision. The row is also
 * locked first, so two taps of one customer are decided one after the other.
 */
export class StartCaptchaService {
  private readonly random: CaptchaRandom;

  constructor(private readonly deps: StartCaptchaServiceDeps) {
    this.random = deps.random ?? CRYPTO_CAPTCHA_RANDOM;
  }

  /**
   * The registration hook, beside `attributeOnArrival`: inside the transaction that resolved
   * the customer, with that transaction's own `created`. Writes the first question only when
   * this call created the customer and the flag is on — read in the same transaction.
   */
  async requireOnArrival(
    scope: TenantContext,
    input: { readonly customerId: string; readonly created: boolean; readonly now: Date },
    tx: TransactionScope,
  ): Promise<void> {
    if (!input.created) return;
    if (!(await this.deps.features.isEnabled(scope, START_CAPTCHA_FEATURE, tx))) return;
    const terms = await this.terms(scope, tx);
    await this.deps.captchas.insert(
      scope,
      {
        customerId: input.customerId,
        challenge: newCaptchaChallenge(this.random, this.deps.ids.uuid()),
        issuedAt: input.now,
        expiresAt: new Date(input.now.getTime() + terms.expirySeconds * 1000),
      },
      tx,
    );
  }

  /**
   * Whether the gate holds this customer now: a PENDING row while the flag is on. The row is
   * read first, because almost every customer has none and pays for no flag read.
   */
  async holds(scope: TenantContext, customerId: string): Promise<boolean> {
    const row = await this.deps.captchas.find(scope, customerId);
    if (row === null || row.state !== 'PENDING') return false;
    return this.deps.features.isEnabled(scope, START_CAPTCHA_FEATURE);
  }

  /**
   * A turn that is not an answer, from a customer the gate may hold: the question to show.
   *
   * Writes only when the shown question must be a new one — the current one has expired, or
   * a cooldown has ended — and then under the turn's key, so a redelivered update replays.
   */
  async present(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
    input: { readonly idempotencyKey: string },
  ): Promise<StartCaptchaOutcome> {
    const row = await this.deps.captchas.find(scope, customerId);
    if (row === null || row.state !== 'PENDING') return { kind: 'FREE' };
    if (!(await this.deps.features.isEnabled(scope, START_CAPTCHA_FEATURE))) {
      return { kind: 'FREE' };
    }
    const now = this.deps.clock.now();
    if (row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime()) {
      return { kind: 'LOCKED', minutes: captchaMinutesLeft(row.lockedUntil, now) };
    }
    if (row.lockedUntil === null && row.expiresAt.getTime() > now.getTime()) {
      const terms = await this.terms(scope);
      return {
        kind: 'ASK',
        reason: 'CURRENT',
        question: questionOf(row),
        remaining: Math.max(1, terms.maxAttempts - row.attempts),
      };
    }
    return this.decide(scope, actor, customerId, {
      idempotencyKey: input.idempotencyKey,
      tap: null,
    });
  }

  /** A tap on one of the four answers of question `challengeId`. */
  async answer(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
    input: {
      readonly idempotencyKey: string;
      readonly challengeId: string;
      readonly choice: number;
    },
  ): Promise<StartCaptchaOutcome> {
    return this.decide(scope, actor, customerId, {
      idempotencyKey: input.idempotencyKey,
      tap: { challengeId: input.challengeId, choice: input.choice },
    });
  }

  private async decide(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
    input: {
      readonly idempotencyKey: string;
      readonly tap: { readonly challengeId: string; readonly choice: number } | null;
    },
  ): Promise<StartCaptchaOutcome> {
    const requestHash = hashRequest({
      customerId,
      purpose: 'START_CAPTCHA',
      tap: input.tap,
    });
    await this.deps.guard.check(scope, actor, START_CAPTCHA_PERMISSION);
    const replay = await this.deps.idempotency.find<StartCaptchaOutcome>(
      scope,
      NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return replay.result;

    return runAuthorizedMutation(
      {
        uow: this.deps.uow,
        guard: this.deps.guard,
        audit: this.deps.audit,
        opsLog: this.deps.opsLog,
        sessions: this.deps.sessions,
        clock: this.deps.clock,
      },
      scope,
      actor,
      START_CAPTCHA_PERMISSION,
      { action: 'customer.captcha_answer', entityType: 'Customer', entityId: customerId },
      async (tx): Promise<StartCaptchaOutcome> => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        const row = await this.deps.captchas.lock(scope, customerId, tx);
        if (row === null || row.state !== 'PENDING') return { kind: 'FREE' };
        if (!(await this.deps.features.isEnabled(scope, START_CAPTCHA_FEATURE, tx))) {
          return { kind: 'FREE' };
        }
        const terms = await this.terms(scope, tx);
        const now = this.deps.clock.now();
        const outcome = await this.step(scope, actor, row, input.tap, terms, now, tx);
        if (outcome.wrote) {
          await rememberOnce(
            this.deps.idempotency,
            scope,
            NAMESPACE,
            input.idempotencyKey,
            requestHash,
            outcome.result,
            tx,
          );
        }
        return outcome.result;
      },
    );
  }

  /** One decision under the row lock. `wrote` is whether a conditional UPDATE changed the row. */
  private async step(
    scope: TenantContext,
    actor: ActorContext,
    row: StartCaptchaRecord,
    tap: { readonly challengeId: string; readonly choice: number } | null,
    terms: CaptchaTerms,
    now: Date,
    tx: TransactionScope,
  ): Promise<{ readonly result: StartCaptchaOutcome; readonly wrote: boolean }> {
    const current: StartCaptchaOutcome = {
      kind: 'ASK',
      reason: 'CURRENT',
      question: questionOf(row),
      remaining: Math.max(1, terms.maxAttempts - row.attempts),
    };

    if (row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime()) {
      return {
        result: { kind: 'LOCKED', minutes: captchaMinutesLeft(row.lockedUntil, now) },
        wrote: false,
      };
    }

    /*
     * The question shown has run out — its time, or the cooldown that replaced it. A new
     * one, the count as it stands (a cooldown already reset it), and whatever was tapped is
     * not judged: an answer to a question nobody can still be asked costs nothing.
     */
    const cooldownOver = row.lockedUntil !== null;
    if (cooldownOver || row.expiresAt.getTime() <= now.getTime()) {
      const next = await this.reissue(
        scope,
        row,
        row.challengeId,
        row.attempts,
        null,
        terms,
        now,
        tx,
      );
      if (next === null) return { result: current, wrote: false };
      return {
        result: {
          kind: 'ASK',
          reason: tap !== null && !cooldownOver ? 'EXPIRED' : 'RENEWED',
          question: questionOf(next),
          remaining: Math.max(1, terms.maxAttempts - row.attempts),
        },
        wrote: true,
      };
    }

    if (tap === null) return { result: current, wrote: false };

    if (tap.choice === row.answerIndex) {
      // Conditional on the TAPPED question: a stale tap whose index happens to match the
      // current question's answer passes nothing.
      if (!(await this.deps.captchas.pass(scope, row.customerId, tap.challengeId, now, tx))) {
        return { result: current, wrote: false };
      }
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'customer.captcha_passed',
          entityType: 'Customer',
          entityId: row.customerId,
          before: { state: 'PENDING', attempts: row.attempts },
          after: { state: 'PASSED' },
          result: 'SUCCESS',
        },
        tx,
      );
      return { result: { kind: 'PASSED' }, wrote: true };
    }

    const attempts = row.attempts + 1;
    if (attempts >= terms.maxAttempts) {
      const lockedUntil = new Date(now.getTime() + terms.cooldownSeconds * 1000);
      const next = await this.reissue(scope, row, tap.challengeId, 0, lockedUntil, terms, now, tx);
      if (next === null) return { result: current, wrote: false };
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'customer.captcha_locked',
          entityType: 'Customer',
          entityId: row.customerId,
          before: { attempts: row.attempts },
          after: { lockedUntil: lockedUntil.toISOString() },
          result: 'SUCCESS',
        },
        tx,
      );
      return {
        result: { kind: 'LOCKED', minutes: captchaMinutesLeft(lockedUntil, now) },
        wrote: true,
      };
    }
    const next = await this.reissue(scope, row, tap.challengeId, attempts, null, terms, now, tx);
    if (next === null) return { result: current, wrote: false };
    return {
      result: {
        kind: 'ASK',
        reason: 'WRONG',
        question: questionOf(next),
        remaining: terms.maxAttempts - attempts,
      },
      wrote: true,
    };
  }

  /** A new question in place of `from`, or null when the row no longer shows `from`. */
  private async reissue(
    scope: TenantContext,
    row: StartCaptchaRecord,
    from: string,
    attempts: number,
    lockedUntil: Date | null,
    terms: CaptchaTerms,
    now: Date,
    tx: TransactionScope,
  ): Promise<StartCaptchaChallenge | null> {
    const challenge = newCaptchaChallenge(this.random, this.deps.ids.uuid());
    const moved = await this.deps.captchas.reissue(
      scope,
      row.customerId,
      from,
      {
        challenge,
        attempts,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + terms.expirySeconds * 1000),
        lockedUntil,
        now,
      },
      tx,
    );
    return moved ? challenge : null;
  }

  private async terms(scope: TenantContext, tx?: unknown): Promise<CaptchaTerms> {
    const [expirySeconds, maxAttempts, cooldownSeconds] = await Promise.all([
      this.deps.settings.valueOf<number>(scope, 'captcha.expiry_seconds', tx),
      this.deps.settings.valueOf<number>(scope, 'captcha.max_attempts', tx),
      this.deps.settings.valueOf<number>(scope, 'captcha.cooldown_seconds', tx),
    ]);
    return { expirySeconds, maxAttempts, cooldownSeconds };
  }
}
