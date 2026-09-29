import type {
  ActorContext,
  AuditWriter,
  BotInstanceId,
  Clock,
  IdGenerator,
  OperationalEventRecorder,
  PermissionKey,
  TelegramReviewMessageRole,
  TelegramWizardKind,
  TelegramWizardStep,
  TenantContext,
  UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * R2 (v0.3.5 real-test items 3–5): which Telegram message shows a flow, and whether a tap on
 * it still belongs to the screen it shows.
 *
 * `telegram_wizards` and `telegram_review_messages` hold it. Presentation state and nothing
 * else: an order, a payment, a capture and a decision re-decide every write under their own
 * locks, and these rows only say which message to edit and whether a tapped button is stale.
 */

/** One Telegram message this bot sent, by its identity. */
export interface TelegramMessageRef {
  readonly botInstanceId: BotInstanceId;
  readonly chatId: string;
  readonly messageId: number;
}

export interface TelegramWizardRecord extends TelegramMessageRef {
  readonly id: string;
  readonly kind: TelegramWizardKind;
  readonly step: TelegramWizardStep;
  readonly version: number;
  readonly subjectId: string | null;
  readonly paymentId: string | null;
  readonly busyUntil: Date | null;
  readonly lastUpdateKey: string | null;
  readonly updatedAt: Date;
}

export interface TelegramReviewMessageRecord extends TelegramMessageRef {
  readonly id: string;
  readonly paymentId: string;
  readonly role: TelegramReviewMessageRole;
  readonly hasMedia: boolean;
  readonly finalisedAt: Date | null;
}

/** Where a claimed wizard lands once its reply is decided. */
export interface TelegramWizardLanding {
  /** A message adopted as one kind can turn out to show the other (a top-up's invoice). */
  readonly kind: TelegramWizardKind;
  readonly step: TelegramWizardStep;
  readonly subjectId: string | null;
  readonly paymentId: string | null;
  /** The update whose turn lands it — what lets that update's redelivery replay. */
  readonly updateKey?: string | null;
  /**
   * Keep the lease: the landing turn still has work to do on this message before another
   * turn may take it — the loading screen it has landed (`INVOICE_LOADING`) and will mark
   * once its edit has been asked for. A turn that dies in between frees it when the lease
   * runs out, so a tap on the loading screen's check button can finish the job.
   */
  readonly hold?: boolean;
}

/** Which wizards a move names: every one showing a payment or an order, or one by id. */
export interface WizardSelector {
  readonly paymentId?: string;
  readonly subjectId?: string;
  readonly id?: string;
}

/**
 * The storage. Every write is a CONDITIONAL statement naming what it moves from — the
 * `version` a claim took, the step a message must still show, `finalised_at IS NULL` —
 * because that one mechanism is what makes a double tap, a redelivered update and a worker
 * racing a turn all land exactly once. There is no `setStep`.
 */
export interface TelegramMessageStateRepository {
  /** Inserts a wizard row for a message nothing tracked yet; a conflict keeps the one there. */
  adoptWizard(
    scope: TenantContext,
    row: {
      readonly id: string;
      readonly ref: TelegramMessageRef;
      readonly kind: TelegramWizardKind;
      readonly step: TelegramWizardStep;
      readonly subjectId: string | null;
      readonly paymentId: string | null;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<void>;

  findWizard(
    scope: TenantContext,
    ref: TelegramMessageRef,
    tx?: TransactionScope,
  ): Promise<TelegramWizardRecord | null>;

  /**
   * Takes a message's wizard for one turn: bumps `version` and sets the lease, ONLY while it
   * still shows one of `from` (and is of `kind`, when one is named) and no other turn holds
   * it. Null means the tap is stale.
   */
  claimWizard(
    scope: TenantContext,
    where: {
      readonly ref?: TelegramMessageRef;
      readonly id?: string;
      readonly kind: TelegramWizardKind | null;
      readonly from: readonly TelegramWizardStep[];
      /** The claiming update: a redelivery of the one that landed the screen passes too. */
      readonly updateKey?: string;
    },
    now: Date,
    leaseUntil: Date,
    tx: TransactionScope,
  ): Promise<TelegramWizardRecord | null>;

  /**
   * Lands a claim: the new screen, and the lease set to `busyUntil` (null clears it). False
   * when the claim was overtaken — `version` is no longer the one the claim took.
   */
  landWizard(
    scope: TenantContext,
    id: string,
    version: number,
    landing: TelegramWizardLanding,
    now: Date,
    busyUntil: Date | null,
    tx: TransactionScope,
  ): Promise<boolean>;

  /** Gives a claim back unchanged. */
  releaseWizard(
    scope: TenantContext,
    id: string,
    version: number,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * The wizard now lives on another message (an edit Telegram refused, sent anew). The
   * message it LEFT keeps a row of its own, `CLOSED`, under `leftBehindId`: its keyboard is
   * still in the chat, and an untracked message would be adopted by the next tap on it and
   * move the wizard backward.
   */
  moveWizard(
    scope: TenantContext,
    id: string,
    messageId: number,
    leftBehindId: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /** The chat's most recently touched wizard at one of `steps`, not held by a turn. */
  latestWizard(
    scope: TenantContext,
    where: {
      readonly botInstanceId: BotInstanceId;
      readonly chatId: string;
      readonly kind: TelegramWizardKind;
      readonly steps: readonly TelegramWizardStep[];
      readonly subjectId: string | null;
    },
    now: Date,
    tx?: TransactionScope,
  ): Promise<TelegramWizardRecord | null>;

  /**
   * Moves every wizard showing `paymentId` (or naming `subjectId`, or the one `id`) at one of
   * `from` to `to`, bumping each version and clearing its lease, and returns the rows it
   * moved — the ones THIS caller now edits.
   */
  moveWizards(
    scope: TenantContext,
    where: WizardSelector,
    from: readonly TelegramWizardStep[],
    to: TelegramWizardStep,
    now: Date,
    tx: TransactionScope,
  ): Promise<readonly TelegramWizardRecord[]>;

  recordReviewMessage(
    scope: TenantContext,
    row: {
      readonly id: string;
      readonly ref: TelegramMessageRef;
      readonly paymentId: string;
      readonly role: TelegramReviewMessageRole;
      readonly hasMedia: boolean;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<void>;

  findReviewMessage(
    scope: TenantContext,
    ref: TelegramMessageRef,
  ): Promise<TelegramReviewMessageRecord | null>;

  /**
   * Stamps `finalised_at` on the payment's unfinalised messages — or on the one named — and
   * returns the rows it stamped: the ones this caller now edits.
   */
  finaliseReviewMessages(
    scope: TenantContext,
    where: {
      readonly paymentId?: string;
      /** With `paymentId`: only this chat's messages (a block decides nothing for others). */
      readonly chatId?: string;
      readonly ref?: TelegramMessageRef;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<readonly TelegramReviewMessageRecord[]>;

  /** Clears a stamp whose edit Telegram definitely did not apply, so a later tap can retry. */
  unfinaliseReviewMessage(scope: TenantContext, id: string, tx: TransactionScope): Promise<void>;
}

/**
 * How long one turn holds a wizard. Long enough for a turn's database work and its edit;
 * short enough that a turn that died mid-way does not freeze the message for its customer.
 */
export const WIZARD_CLAIM_LEASE_MS = 30_000;

/**
 * The permission these writes charge: `maintenance.run`, the key every customer-initiated
 * write on the Telegram turn charges (`CustomerCaptureService`), held by `SYSTEM_JOB`.
 *
 * The rows are the surface's record of which message it sent, written by the turn that sent
 * it and by the gateway worker that edits it. They move no money and decide no business
 * state — the decision itself (an approval, a payment) is taken by its own service with its
 * own actor and permission — so they are not audited; a denial still is, by the guard.
 */
const MESSAGE_STATE_PERMISSION: PermissionKey = 'maintenance.run';

export interface TelegramMessageStateDeps {
  readonly repository: TelegramMessageStateRepository;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export type WizardClaim =
  | { readonly outcome: 'CLAIMED'; readonly wizard: TelegramWizardRecord }
  | { readonly outcome: 'STALE' }
  /** The scope stopped accepting work: the turn goes on without a wizard. */
  | { readonly outcome: 'UNAVAILABLE' };

/**
 * The one writer of both tables. Every method runs its write inside an authorized
 * transaction that also reads `ScopeActivityReader` — a stopped scope moves nothing — and
 * every write is the repository's conditional statement.
 */
export class TelegramMessageStateService {
  constructor(private readonly deps: TelegramMessageStateDeps) {}

  private write<T>(
    scope: TenantContext,
    actor: ActorContext,
    entityId: string | null,
    inactive: T,
    work: (tx: TransactionScope, now: Date) => Promise<T>,
  ): Promise<T> {
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
      MESSAGE_STATE_PERMISSION,
      { action: 'telegram.message_state', entityType: 'TelegramMessage', entityId },
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return inactive;
        return work(tx, this.deps.clock.now());
      },
    );
  }

  // --- Wizards ---------------------------------------------------------------------------

  /**
   * The gate a wizard button passes before its work runs.
   *
   * A message nothing tracks yet (one sent before this release, or whose send answer was
   * lost) is ADOPTED as showing the first of `from` — it does show a screen carrying this
   * button — and then claimed like any other. A tracked message is claimed only while it
   * still shows one of `from`: a tap on a keyboard the message no longer shows, a second tap
   * while the first is still being handled, or a tap on a closed wizard is STALE.
   */
  async claim(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly ref: TelegramMessageRef;
      readonly kind: TelegramWizardKind | null;
      readonly adoptAs: TelegramWizardKind;
      readonly from: readonly TelegramWizardStep[];
      /**
       * The update's idempotency key. A REDELIVERY of the update that put the current
       * screen on the message is let through: every write behind it replays by that key,
       * so the turn reproduces its answer — and an edit a crash lost is made after all.
       */
      readonly updateKey: string;
    },
  ): Promise<WizardClaim> {
    const first = input.from[0];
    if (first === undefined) return { outcome: 'STALE' };
    return this.write<WizardClaim>(
      scope,
      actor,
      null,
      { outcome: 'UNAVAILABLE' },
      async (tx, now) => {
        const existing = await this.deps.repository.findWizard(scope, input.ref, tx);
        if (existing === null) {
          await this.deps.repository.adoptWizard(
            scope,
            {
              id: this.deps.ids.uuid(),
              ref: input.ref,
              kind: input.adoptAs,
              step: first,
              subjectId: null,
              paymentId: null,
            },
            now,
            tx,
          );
        }
        const claimed = await this.deps.repository.claimWizard(
          scope,
          { ref: input.ref, kind: input.kind, from: input.from, updateKey: input.updateKey },
          now,
          new Date(now.getTime() + WIZARD_CLAIM_LEASE_MS),
          tx,
        );
        return claimed === null ? { outcome: 'STALE' } : { outcome: 'CLAIMED', wizard: claimed };
      },
    );
  }

  /**
   * The wizard a TYPED answer continues: the chat's latest one waiting at one of `steps`
   * (for `subjectId`, when named), claimed exactly as a tap claims. Null when there is none —
   * the answer then goes out as a new message, as it always did.
   */
  async claimLatest(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly botInstanceId: BotInstanceId;
      readonly chatId: string;
      readonly kind: TelegramWizardKind;
      readonly steps: readonly TelegramWizardStep[];
      readonly subjectId: string | null;
      readonly updateKey: string;
    },
  ): Promise<TelegramWizardRecord | null> {
    return this.write(scope, actor, null, null, async (tx, now) => {
      const latest = await this.deps.repository.latestWizard(scope, input, now, tx);
      if (latest === null) return null;
      return this.deps.repository.claimWizard(
        scope,
        { id: latest.id, kind: input.kind, from: input.steps, updateKey: input.updateKey },
        now,
        new Date(now.getTime() + WIZARD_CLAIM_LEASE_MS),
        tx,
      );
    });
  }

  /** Lands a claim on the screen its reply shows. False when the claim was overtaken. */
  land(
    scope: TenantContext,
    actor: ActorContext,
    claim: TelegramWizardRecord,
    landing: TelegramWizardLanding,
  ): Promise<boolean> {
    return this.write(scope, actor, claim.id, false, (tx, now) =>
      this.deps.repository.landWizard(
        scope,
        claim.id,
        claim.version,
        landing,
        now,
        landing.hold === true ? new Date(now.getTime() + WIZARD_CLAIM_LEASE_MS) : null,
        tx,
      ),
    );
  }

  /**
   * Undoes a `moveAll` whose edit Telegram definitely did not apply (a 429): the wizard goes
   * back to `to`, the step it was moved from, so the screen it still shows keeps its buttons
   * honoured and a later refresh or tap can finish the edit. The same conditional write as a
   * landing — on the version the move left — so a wizard anybody touched since stays where
   * that write put it. False when it did.
   */
  moveBack(
    scope: TenantContext,
    actor: ActorContext,
    moved: TelegramWizardRecord,
    to: TelegramWizardStep,
  ): Promise<boolean> {
    return this.write(scope, actor, moved.id, false, (tx, now) =>
      this.deps.repository.landWizard(
        scope,
        moved.id,
        moved.version,
        { kind: moved.kind, step: to, subjectId: moved.subjectId, paymentId: moved.paymentId },
        now,
        null,
        tx,
      ),
    );
  }

  /** Gives a claim back: the reply went out as its own message, or not at all. */
  release(
    scope: TenantContext,
    actor: ActorContext,
    claim: TelegramWizardRecord,
  ): Promise<boolean> {
    return this.write(scope, actor, claim.id, false, (tx, now) =>
      this.deps.repository.releaseWizard(scope, claim.id, claim.version, now, tx),
    );
  }

  /**
   * The wizard's screen was sent as a new message (Telegram refused the edit). The message
   * it left stays tracked, CLOSED, so a tap on its old keyboard is stale.
   */
  move(
    scope: TenantContext,
    actor: ActorContext,
    wizardId: string,
    messageId: number,
  ): Promise<boolean> {
    return this.write(scope, actor, wizardId, false, (tx, now) =>
      this.deps.repository.moveWizard(scope, wizardId, messageId, this.deps.ids.uuid(), now, tx),
    );
  }

  /**
   * A wizard screen that went out as a NEW message — the catalogue from the main menu, a
   * prompt no tracked message was waiting for — becomes that message's wizard.
   */
  register(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly ref: TelegramMessageRef;
      readonly landing: TelegramWizardLanding;
    },
  ): Promise<void> {
    return this.write(scope, actor, null, undefined, (tx, now) =>
      this.deps.repository.adoptWizard(
        scope,
        {
          id: this.deps.ids.uuid(),
          ref: input.ref,
          kind: input.landing.kind,
          step: input.landing.step,
          subjectId: input.landing.subjectId,
          paymentId: input.landing.paymentId,
        },
        now,
        tx,
      ),
    );
  }

  /**
   * Moves the wizards showing this payment — or naming this order — from `from` to `to`, and
   * returns the ones moved: exactly one caller wins each, and only the winner edits.
   */
  moveAll(
    scope: TenantContext,
    actor: ActorContext,
    where: WizardSelector,
    from: readonly TelegramWizardStep[],
    to: TelegramWizardStep,
  ): Promise<readonly TelegramWizardRecord[]> {
    const entity = where.id ?? where.paymentId ?? where.subjectId ?? null;
    return this.write(scope, actor, entity, [], (tx, now) =>
      this.deps.repository.moveWizards(scope, where, from, to, now, tx),
    );
  }

  findWizard(scope: TenantContext, ref: TelegramMessageRef): Promise<TelegramWizardRecord | null> {
    return this.deps.repository.findWizard(scope, ref);
  }

  // --- Receipt review messages -----------------------------------------------------------

  recordReview(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly ref: TelegramMessageRef;
      readonly paymentId: string;
      readonly role: TelegramReviewMessageRole;
      readonly hasMedia: boolean;
    },
  ): Promise<void> {
    return this.write(scope, actor, input.paymentId, undefined, (tx, now) =>
      this.deps.repository.recordReviewMessage(
        scope,
        { id: this.deps.ids.uuid(), ...input },
        now,
        tx,
      ),
    );
  }

  findReview(
    scope: TenantContext,
    ref: TelegramMessageRef,
  ): Promise<TelegramReviewMessageRecord | null> {
    return this.deps.repository.findReviewMessage(scope, ref);
  }

  /** Stamps and returns the payment's unfinalised messages, or the one message named. */
  finaliseReviews(
    scope: TenantContext,
    actor: ActorContext,
    where: {
      readonly paymentId?: string;
      /** With `paymentId`: only this chat's messages (a block decides nothing for others). */
      readonly chatId?: string;
      readonly ref?: TelegramMessageRef;
    },
  ): Promise<readonly TelegramReviewMessageRecord[]> {
    return this.write(scope, actor, where.paymentId ?? null, [], (tx, now) =>
      this.deps.repository.finaliseReviewMessages(scope, where, now, tx),
    );
  }

  unfinaliseReview(scope: TenantContext, actor: ActorContext, id: string): Promise<void> {
    return this.write(scope, actor, id, undefined, (tx) =>
      this.deps.repository.unfinaliseReviewMessage(scope, id, tx),
    );
  }
}
