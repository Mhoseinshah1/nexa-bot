import { randomInt } from 'node:crypto';
import {
  COMMERCE_ERROR_CODES,
  START_CAPTCHA_IMAGE_REFRESH_MAX,
  errors,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type StartCaptchaKind,
  type StartCaptchaQuestionKind,
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
import {
  captchaEmojiName,
  newChallengeOfKind,
  newMathChallenge,
  normaliseCaptchaDigits,
  persianWords,
  resolveQuestionKind,
} from './start-captcha-questions.js';
import type {
  CaptchaImageRenderer,
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

/**
 * What the customer is shown, whatever the kind. Never the answer, nor its index: `options`
 * are the buttons (all four, the right one among them), `name` the emoji to tap (`EMOJI`),
 * `words` the number in words (`WORD_NUMBER`), `first`/`second` the sum (`MATH`, else 0).
 * `IMAGE_NUMBER` has no buttons: the picture is drawn from the row by `renderImage`, and
 * `refreshesLeft` says whether «🔄 تصویر جدید» still shows.
 */
export interface CaptchaQuestion {
  readonly challengeId: string;
  readonly kind: StartCaptchaQuestionKind;
  readonly first: number;
  readonly second: number;
  readonly options: readonly (number | string)[];
  readonly name: string | null;
  readonly words: string | null;
  readonly refreshesLeft: number;
}

/**
 * Where a customer stands at the captcha, as one turn decided it.
 *
 * - `FREE`: not held — no row (never asked), already PASSED, or `start_captcha` is off.
 * - `ASK`: held; answer `question`. `reason` says why this question is shown: `CURRENT` (the
 *   one already asked, nothing written), `WRONG` (a wrong answer counted, a new question),
 *   `EXPIRED` (an answer to a question whose time ran out — not counted, a new question),
 *   `RENEWED` (the old question had expired or a cooldown ended — a new question),
 *   `REFRESHED` (a new picture on request: a new question that spent no attempt).
 * - `LOCKED`: the answers ran out; a new question comes after `minutes`.
 * - `PASSED`: THIS answer was right.
 */
export type StartCaptchaOutcome =
  | { readonly kind: 'FREE' }
  | {
      readonly kind: 'ASK';
      readonly reason: 'CURRENT' | 'WRONG' | 'EXPIRED' | 'RENEWED' | 'REFRESHED';
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
  /** Draws the `IMAGE_NUMBER` picture. Absent, that kind is never asked (MATH is). */
  readonly images?: CaptchaImageRenderer;
}

/** The original sum question; kept under its first name for its callers. */
export const newCaptchaChallenge = newMathChallenge;

/** Whole minutes until `until`, rounded up, never below one. */
export function captchaMinutesLeft(until: Date, now: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
}

function questionOf(challenge: StartCaptchaChallenge, refreshes: number): CaptchaQuestion {
  const right = challenge.options[challenge.answerIndex];
  return {
    challengeId: challenge.challengeId,
    kind: challenge.kind,
    first: challenge.operandA,
    second: challenge.operandB,
    options: challenge.options,
    name: challenge.kind === 'EMOJI' && typeof right === 'string' ? captchaEmojiName(right) : null,
    words:
      challenge.kind === 'WORD_NUMBER' && typeof right === 'number' ? persianWords(right) : null,
    refreshesLeft:
      challenge.kind === 'IMAGE_NUMBER'
        ? Math.max(0, START_CAPTCHA_IMAGE_REFRESH_MAX - refreshes)
        : 0,
  };
}

/** What one turn did to the question: a tap on a button, a typed answer, or «🔄 تصویر جدید». */
type CaptchaTap =
  | { readonly kind: 'CHOICE'; readonly challengeId: string; readonly choice: number }
  | { readonly kind: 'TEXT'; readonly text: string }
  | { readonly kind: 'REFRESH'; readonly challengeId: string };

interface CaptchaTerms {
  readonly expirySeconds: number;
  readonly maxAttempts: number;
  readonly cooldownSeconds: number;
  readonly kind: StartCaptchaKind;
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
        challenge: this.newChallenge(terms.kind),
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
        question: questionOf(row, row.refreshes),
        remaining: Math.max(1, terms.maxAttempts - row.attempts),
      };
    }
    return this.decide(scope, actor, customerId, {
      idempotencyKey: input.idempotencyKey,
      tap: null,
    });
  }

  /**
   * What a read-only look at the customer's question shows, for the mini app's gate: null when
   * the gate does not hold them (no row, PASSED, or `start_captcha` off), else the question
   * as it stands and whether it is `CURRENT`, has `EXPIRED` (the next `refresh` or `present`
   * renews it) or is `LOCKED` by a cooldown. Writes nothing.
   */
  async peek(
    scope: TenantContext,
    customerId: string,
  ): Promise<{
    readonly question: CaptchaQuestion;
    readonly state: 'CURRENT' | 'EXPIRED' | 'LOCKED';
  } | null> {
    const row = await this.deps.captchas.find(scope, customerId);
    if (row === null || row.state !== 'PENDING') return null;
    if (!(await this.deps.features.isEnabled(scope, START_CAPTCHA_FEATURE))) return null;
    const now = this.deps.clock.now();
    const state =
      row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime()
        ? 'LOCKED'
        : row.lockedUntil === null && row.expiresAt.getTime() > now.getTime()
          ? 'CURRENT'
          : 'EXPIRED';
    return { question: questionOf(row, row.refreshes), state };
  }

  /**
   * The picture of the customer's pending `IMAGE_NUMBER` question, drawn again from the stored
   * answer and the question's id (the same bytes every time; nothing is stored or written to
   * disk). Null when there is none to show: not held, another kind, locked or expired, no
   * renderer, or `challengeId` is not the question the row shows now.
   */
  async renderImage(
    scope: TenantContext,
    customerId: string,
    challengeId?: string,
  ): Promise<{ readonly challengeId: string; readonly png: Uint8Array } | null> {
    const images = this.deps.images;
    if (images === undefined) return null;
    const row = await this.deps.captchas.find(scope, customerId);
    if (row === null || row.state !== 'PENDING') return null;
    if (row.kind !== 'IMAGE_NUMBER' || row.answerText === null) return null;
    if (challengeId !== undefined && challengeId !== row.challengeId) return null;
    const now = this.deps.clock.now();
    if (row.lockedUntil !== null || row.expiresAt.getTime() <= now.getTime()) return null;
    if (!(await this.deps.features.isEnabled(scope, START_CAPTCHA_FEATURE))) return null;
    return { challengeId: row.challengeId, png: images.render(row.answerText, row.challengeId) };
  }

  /**
   * A SAMPLE picture for the Web Admin's preview: a random 4-digit number drawn with a random
   * seed. Belongs to no customer or question and stores nothing. Null with no renderer wired.
   */
  sampleImage(): Uint8Array | null {
    const images = this.deps.images;
    if (images === undefined) return null;
    const { answerText } = newChallengeOfKind('IMAGE_NUMBER', this.random, this.deps.ids.uuid());
    return images.render(answerText ?? '0000', this.deps.ids.uuid());
  }

  /**
   * A TYPED answer, from a customer the gate may hold. Under a picture question it is judged;
   * under any other kind (or for a customer not held) it is an ordinary turn, shown the
   * question by `present`.
   */
  async answerText(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
    input: { readonly idempotencyKey: string; readonly text: string },
  ): Promise<StartCaptchaOutcome> {
    const row = await this.deps.captchas.find(scope, customerId);
    if (row === null || row.state !== 'PENDING') return { kind: 'FREE' };
    if (row.kind !== 'IMAGE_NUMBER') {
      return this.present(scope, actor, customerId, { idempotencyKey: input.idempotencyKey });
    }
    if (!(await this.deps.features.isEnabled(scope, START_CAPTCHA_FEATURE))) {
      return { kind: 'FREE' };
    }
    return this.decide(scope, actor, customerId, {
      idempotencyKey: input.idempotencyKey,
      tap: { kind: 'TEXT', text: input.text },
    });
  }

  /**
   * «🔄 تصویر جدید» on question `challengeId`: a new picture. A NEW question, not a spent
   * attempt, and at most `START_CAPTCHA_IMAGE_REFRESH_MAX` times per question; past that, or
   * on another kind or a stale question, nothing changes and the current question is shown.
   */
  async refresh(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
    input: { readonly idempotencyKey: string; readonly challengeId: string },
  ): Promise<StartCaptchaOutcome> {
    return this.decide(scope, actor, customerId, {
      idempotencyKey: input.idempotencyKey,
      tap: { kind: 'REFRESH', challengeId: input.challengeId },
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
      tap: { kind: 'CHOICE', challengeId: input.challengeId, choice: input.choice },
    });
  }

  private async decide(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
    input: {
      readonly idempotencyKey: string;
      readonly tap: CaptchaTap | null;
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
    tap: CaptchaTap | null,
    terms: CaptchaTerms,
    now: Date,
    tx: TransactionScope,
  ): Promise<{ readonly result: StartCaptchaOutcome; readonly wrote: boolean }> {
    const current: StartCaptchaOutcome = {
      kind: 'ASK',
      reason: 'CURRENT',
      question: questionOf(row, row.refreshes),
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
        { from: row.challengeId, attempts: row.attempts, lockedUntil: null, refreshes: 0 },
        terms,
        now,
        tx,
      );
      if (next === null) return { result: current, wrote: false };
      return {
        result: {
          kind: 'ASK',
          reason: tap !== null && !cooldownOver ? 'EXPIRED' : 'RENEWED',
          question: questionOf(next, 0),
          remaining: Math.max(1, terms.maxAttempts - row.attempts),
        },
        wrote: true,
      };
    }

    if (tap === null) return { result: current, wrote: false };

    if (tap.kind === 'REFRESH') {
      // Only a picture question, only the one shown now, only while swaps remain. A new
      // picture is a new question: the attempts stand as they were, spent or not.
      if (
        row.kind !== 'IMAGE_NUMBER' ||
        tap.challengeId !== row.challengeId ||
        row.refreshes >= START_CAPTCHA_IMAGE_REFRESH_MAX
      ) {
        return { result: current, wrote: false };
      }
      const next = await this.reissue(
        scope,
        row,
        {
          from: row.challengeId,
          attempts: row.attempts,
          lockedUntil: null,
          refreshes: row.refreshes + 1,
          kind: 'IMAGE_NUMBER',
        },
        terms,
        now,
        tx,
      );
      if (next === null) return { result: current, wrote: false };
      return {
        result: {
          kind: 'ASK',
          reason: 'REFRESHED',
          question: questionOf(next, row.refreshes + 1),
          remaining: current.kind === 'ASK' ? current.remaining : 1,
        },
        wrote: true,
      };
    }

    /*
     * Judge the answer. A button answers a button question and a typed text a picture
     * question; the other pairing is no answer at all and costs nothing. Typed text that is
     * not four digits once normalised is not an answer either (a "hello", a sticker's name):
     * the question is shown again, no attempt spent. Four digits that are the wrong four are.
     */
    let judged: string;
    let right: boolean;
    if (tap.kind === 'CHOICE') {
      if (row.kind === 'IMAGE_NUMBER') return { result: current, wrote: false };
      judged = tap.challengeId;
      right = tap.choice === row.answerIndex;
    } else {
      if (row.kind !== 'IMAGE_NUMBER' || row.answerText === null) {
        return { result: current, wrote: false };
      }
      const typed = normaliseCaptchaDigits(tap.text);
      if (!/^[0-9]{4}$/u.test(typed)) return { result: current, wrote: false };
      judged = row.challengeId;
      right = typed === row.answerText;
    }

    if (right) {
      // Conditional on the JUDGED question: a stale tap whose index happens to match the
      // current question's answer passes nothing.
      if (!(await this.deps.captchas.pass(scope, row.customerId, judged, now, tx))) {
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
      const next = await this.reissue(
        scope,
        row,
        { from: judged, attempts: 0, lockedUntil, refreshes: 0 },
        terms,
        now,
        tx,
      );
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
    const next = await this.reissue(
      scope,
      row,
      { from: judged, attempts, lockedUntil: null, refreshes: 0 },
      terms,
      now,
      tx,
    );
    if (next === null) return { result: current, wrote: false };
    return {
      result: {
        kind: 'ASK',
        reason: 'WRONG',
        question: questionOf(next, 0),
        remaining: terms.maxAttempts - attempts,
      },
      wrote: true,
    };
  }

  /**
   * A new question of the kind the setting says (or `kind`, when a swap forces the picture),
   * with its own id. `IMAGE_NUMBER` with no renderer wired is asked as `MATH`.
   */
  private newChallenge(
    setting: StartCaptchaKind,
    forced?: StartCaptchaQuestionKind,
  ): StartCaptchaChallenge {
    let kind = forced ?? resolveQuestionKind(setting, this.random);
    if (kind === 'IMAGE_NUMBER' && this.deps.images === undefined) kind = 'MATH';
    return newChallengeOfKind(kind, this.random, this.deps.ids.uuid());
  }

  /** A new question in place of `from`, or null when the row no longer shows `from`. */
  private async reissue(
    scope: TenantContext,
    row: StartCaptchaRecord,
    change: {
      readonly from: string;
      readonly attempts: number;
      readonly lockedUntil: Date | null;
      readonly refreshes: number;
      readonly kind?: StartCaptchaQuestionKind;
    },
    terms: CaptchaTerms,
    now: Date,
    tx: TransactionScope,
  ): Promise<StartCaptchaChallenge | null> {
    const challenge = this.newChallenge(terms.kind, change.kind);
    const moved = await this.deps.captchas.reissue(
      scope,
      row.customerId,
      change.from,
      {
        challenge,
        attempts: change.attempts,
        refreshes: change.refreshes,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + terms.expirySeconds * 1000),
        lockedUntil: change.lockedUntil,
        now,
      },
      tx,
    );
    return moved ? challenge : null;
  }

  private async terms(scope: TenantContext, tx?: unknown): Promise<CaptchaTerms> {
    const [expirySeconds, maxAttempts, cooldownSeconds, kind] = await Promise.all([
      this.deps.settings.valueOf<number>(scope, 'captcha.expiry_seconds', tx),
      this.deps.settings.valueOf<number>(scope, 'captcha.max_attempts', tx),
      this.deps.settings.valueOf<number>(scope, 'captcha.cooldown_seconds', tx),
      this.deps.settings.valueOf<StartCaptchaKind>(scope, 'captcha.kind', tx),
    ]);
    return { expirySeconds, maxAttempts, cooldownSeconds, kind };
  }
}
