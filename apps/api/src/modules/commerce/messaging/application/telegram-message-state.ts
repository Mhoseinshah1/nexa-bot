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
import { TELEGRAM_MESSAGE_STATE_RETENTION_DAYS } from '@nexa/contracts';
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

  /**
   * The chat's most recently touched wizard at one of `steps`, not held by a turn. `kind`
   * null is either kind; `paymentId`, when given, is the payment the wizard must show (owner
   * spec §2.4: a receipt continues the invoice of ITS payment, whichever flow drew it).
   */
  latestWizard(
    scope: TenantContext,
    where: {
      readonly botInstanceId: BotInstanceId;
      readonly chatId: string;
      readonly kind: TelegramWizardKind | null;
      readonly steps: readonly TelegramWizardStep[];
      readonly subjectId: string | null;
      readonly paymentId?: string | null;
    },
    now: Date,
    tx?: TransactionScope,
  ): Promise<TelegramWizardRecord | null>;

  /**
   * FIX-08: the most recently touched `ORDER` wizard naming `subjectId` (an order), whatever
   * its step or lease — the message an order's outcome may be answered on. A read; nothing
   * moves. Null when the order never had a tracked screen.
   */
  latestForSubject(
    scope: TenantContext,
    subjectId: string,
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
  unfinaliseReviewMessage(
    scope: TenantContext,
    id: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<void>;

  // --- Retention (docs/telegram-retention.md) ---------------------------------------------

  /**
   * Whether `ref` is at or below its chat's PURGE HORIZON: the greatest message id whose row
   * the retention sweep has removed in that chat. A tap on an untracked message there is a
   * tap on a message whose row may have been deleted, and is stale.
   */
  isWithinPurgedHorizon(
    scope: TenantContext,
    ref: TelegramMessageRef,
    tx?: TransactionScope,
  ): Promise<boolean>;

  /**
   * Deletes at most `limit` wizard rows nothing live names any more — untouched since
   * `cutoff`, not held by a turn's lease at `now`, showing no payment that is still open
   * (`PENDING`, `UNKNOWN`) and, for an `ORDER` wizard, no order that is not yet done — and
   * returns the messages they tracked. Candidates are taken `FOR UPDATE SKIP LOCKED`, so a
   * row a turn is writing is skipped, never waited on, and the DELETE re-checks the age and
   * the lease against the row it actually removes.
   */
  purgeWizards(
    scope: TenantContext,
    where: { readonly cutoff: Date; readonly now: Date; readonly limit: number },
    tx: TransactionScope,
  ): Promise<readonly TelegramMessageRef[]>;

  /**
   * Deletes at most `limit` review-message rows whose payment has reached a terminal state,
   * whose payment last changed before `cutoff`, and whose own last write (`updated_at`: the
   * recording, the finalisation or a cleared stamp) is before `cutoff`, and returns the
   * messages they tracked. Same locking as wizards.
   */
  purgeReviewMessages(
    scope: TenantContext,
    where: { readonly cutoff: Date; readonly limit: number },
    tx: TransactionScope,
  ): Promise<readonly TelegramMessageRef[]>;

  /**
   * Raises each chat's purge horizon to the greatest message id among `refs` (never lowers
   * it). Called in the transaction that deleted those rows.
   */
  raisePurgedHorizons(
    scope: TenantContext,
    refs: readonly TelegramMessageRef[],
    now: Date,
    tx: TransactionScope,
  ): Promise<void>;
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
          /*
           * Retention (docs/telegram-retention.md): an untracked message at or below its
           * chat's purge horizon may be one whose row the sweep DELETED — a closed wizard, a
           * message a refused edit left behind with its keyboard still on it. Adopting it
           * would honour that old keyboard as if it were a fresh screen: a pay or confirm
           * button of a flow that ended long ago. So it is stale, and nothing is written.
           * Read in this transaction, after `findWizard`: the sweep deletes a row and raises
           * the horizon in ONE commit, so a read that no longer sees the row sees the horizon.
           */
          if (await this.deps.repository.isWithinPurgedHorizon(scope, input.ref, tx)) {
            return { outcome: 'STALE' };
          }
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
      readonly kind: TelegramWizardKind | null;
      readonly steps: readonly TelegramWizardStep[];
      readonly subjectId: string | null;
      readonly paymentId?: string | null;
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

  /** FIX-08: the order's most recently touched screen, for its outcome to be answered on. */
  latestForSubject(scope: TenantContext, subjectId: string): Promise<TelegramWizardRecord | null> {
    return this.deps.repository.latestForSubject(scope, subjectId);
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

  /**
   * Retention: whether a receipt-review tap on a message with NO row is a tap on one whose
   * row the sweep removed — at or below the chat's purge horizon. Such a tap is answered and
   * nothing else, exactly like a tap on a finalised message: the decision it would ask for
   * was taken (the sweep removes a review row only once its payment is terminal), and asking
   * again would only produce a second answer to a settled question.
   */
  reviewTapIsRetired(scope: TenantContext, ref: TelegramMessageRef): Promise<boolean> {
    return this.deps.repository.isWithinPurgedHorizon(scope, ref);
  }

  /**
   * One bounded retention pass (docs/telegram-retention.md): at most `limit` wizard rows and
   * at most `limit` review rows that nothing live names any more, deleted with their chats'
   * purge horizons raised in the SAME transaction. Charged and scope-checked like every
   * other write here: a stopped scope removes nothing.
   */
  purgeExpired(
    scope: TenantContext,
    actor: ActorContext,
    limit: number,
  ): Promise<{ readonly wizards: number; readonly reviews: number }> {
    return this.write(scope, actor, null, { wizards: 0, reviews: 0 }, async (tx, now) => {
      const cutoff = new Date(now.getTime() - TELEGRAM_MESSAGE_STATE_RETENTION_DAYS * 86_400_000);
      const bounded = Math.max(1, Math.floor(limit));
      const wizards = await this.deps.repository.purgeWizards(
        scope,
        { cutoff, now, limit: bounded },
        tx,
      );
      const reviews = await this.deps.repository.purgeReviewMessages(
        scope,
        { cutoff, limit: bounded },
        tx,
      );
      await this.deps.repository.raisePurgedHorizons(scope, [...wizards, ...reviews], now, tx);
      return { wizards: wizards.length, reviews: reviews.length };
    });
  }

  unfinaliseReview(scope: TenantContext, actor: ActorContext, id: string): Promise<void> {
    return this.write(scope, actor, id, undefined, (tx, now) =>
      this.deps.repository.unfinaliseReviewMessage(scope, id, now, tx),
    );
  }
}
