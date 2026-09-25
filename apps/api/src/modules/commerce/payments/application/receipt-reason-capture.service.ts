import {
  ADMIN_AMOUNT_CAPTURE_TTL_MS,
  ADMIN_CAPTURE_REASON_MAX_LENGTH,
  COMMERCE_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  errors,
  paymentIdSchema,
  userIdSchema,
  uuidV7Schema,
  type ActorContext,
  type AdminAmountCaptureCloseReason,
  type AdminReasonCapturePurpose,
  type AuditWriter,
  type BotInstanceId,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PaymentId,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerRecord, CustomerRepository } from '../../customers/application/ports.js';
import type { PaymentRecord, PaymentRepository } from './ports.js';
import type { PaymentReceiptRepository } from './receipt-ports.js';
import type {
  AdminAmountCaptureRecord,
  AdminAmountCaptureRepository,
} from './admin-amount-capture-ports.js';

const CAPTURE_NAMESPACE = 'TELEGRAM' as const;

/**
 * What a capture names: a PAYMENT for the three receipt purposes, a CUSTOMER for the customers
 * section's block (WP10G). The table's target CHECK holds the same rule; this is the type's half.
 */
export type ReasonCaptureTarget = 'PAYMENT' | 'CUSTOMER';

/**
 * What ONE typed-reason action is: which capture purpose reads its reason, which permission
 * gates it, what it is ABOUT and when it may be asked, and what it DOES once the reason is
 * confirmed.
 *
 * Three policies use it — Block User from a receipt (WP10 follow-up §4), the rejection's
 * mandatory reason (File 01 §7) and the customers section's block (WP10G) — and they differ in
 * exactly these fields, so the capture mechanics that make a typed message safe to read
 * (INCIDENT-FIN-001) exist once rather than three times.
 *
 * `TSubject` is what the surface is shown about the target: `{ payment, customer }` for a
 * receipt, `{ customer }` for a customers-section block. It is an object so the results can
 * spread it, which is how the surface reads `asked.customer` without knowing the policy.
 */
export interface ReasonCapturePolicy<TSubject extends object, TOutcome> {
  readonly purpose: AdminReasonCapturePurpose;
  readonly target: ReasonCaptureTarget;
  /** The audit/denial action every refusal of this path is recorded under. */
  readonly action: string;
  /** Charged on every step, and again inside every writing transaction. */
  readonly permission: PermissionKey;
  /** Charged beside it where the target is read to show who or what the reason is about. */
  readonly viewPermission: PermissionKey;
  /**
   * The target, READ, as the surface will be shown it — or null when it does not exist or no
   * longer admits this action, which answers `GONE`: a rejection asked of a payment already
   * decided has nothing to reject, a receipt action asked of a transfer with no receipt has
   * nothing to act from. Read only, never locked: a reason capture waits on no disposition.
   */
  readonly load: (
    scope: TenantContext,
    targetId: string,
    tx?: TransactionScope,
  ) => Promise<TSubject | null>;
  /** The key the confirmed capture acts under — derived from the capture, so it acts once. */
  readonly keyFor: (captureId: string) => string;
  /**
   * The action, OUTSIDE the capture's transaction and through the path that owns it — the
   * customers section's block, or the payment's own conditional reject. It charges its own
   * permission again; nothing here is authorized by having been given the function.
   */
  readonly act: (
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly subject: TSubject;
      readonly reason: string;
      readonly captureId: string;
    },
  ) => Promise<TOutcome>;
}

export interface ReceiptReasonCaptureDeps {
  readonly captures: AdminAmountCaptureRepository;
  /** The payment READ alone, never locked: a reason capture waits on no disposition. */
  readonly payments: Pick<PaymentRepository, 'findById'>;
  /**
   * Whether the payment carries a stored receipt. The receipt purposes are RECEIPT-originated,
   * so a transfer with none admits neither: a forged callback naming it answers `GONE`.
   */
  readonly receipts: Pick<PaymentReceiptRepository, 'countForPayment'>;
  readonly customers: Pick<CustomerRepository, 'findById'>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** What a receipt action is about: the payment, and the customer it belongs to when known. */
export interface ReasonSubject {
  readonly payment: PaymentRecord;
  readonly customer: CustomerRecord | null;
}

/** What a customers-section block is about: the customer, and nothing they bought. */
export interface CustomerReasonSubject {
  readonly customer: CustomerRecord;
}

export type ReasonAskResult<TSubject extends object = ReasonSubject> =
  | ({ readonly outcome: 'ASK' } & TSubject)
  | { readonly outcome: 'GONE' };

export type ReasonOpenResult<TSubject extends object = ReasonSubject> =
  | ({ readonly outcome: 'OPENED'; readonly capture: AdminAmountCaptureRecord } & TSubject)
  | { readonly outcome: 'GONE' };

export type ReasonTextResult<TSubject extends object = ReasonSubject> =
  | { readonly outcome: 'NO_CAPTURE' }
  | { readonly outcome: 'INVALID' }
  | { readonly outcome: 'EXPIRED' }
  | { readonly outcome: 'GONE' }
  | ({
      readonly outcome: 'ENTERED';
      readonly capture: AdminAmountCaptureRecord;
      readonly reason: string;
    } & TSubject);

export type ReasonConfirmResult<TOutcome> =
  | { readonly outcome: 'DONE'; readonly result: TOutcome; readonly reason: string }
  | { readonly outcome: 'CLOSED'; readonly reason: AdminAmountCaptureCloseReason }
  | { readonly outcome: 'GONE' };

/**
 * `CONFIRMED` says the reason was confirmed — NOT that the action took effect: the capture closes
 * before the action runs, and an action refused, lost to another decision or interrupted leaves
 * it CONFIRMED with nothing done. So it carries the target's id, and the caller reports what the
 * customer or the payment IS rather than what the capture implies.
 */
export type ReasonCancelResult =
  | { readonly outcome: 'CANCELLED' }
  | { readonly outcome: 'CONFIRMED'; readonly targetId: string }
  | { readonly outcome: 'GONE' };

/**
 * A MANDATORY typed reason, read safely, for one action taken from a Telegram admin message.
 *
 * Ask → open the capture → the reason, as text → a confirmation restating it → the action. The
 * reason is read through `admin_amount_captures`, whose partial unique index makes "one open
 * prompt per administrator per bot" a database fact across every purpose, with the four
 * INCIDENT-FIN-001 properties: one administrator, one bot, one target; ONE reason read; nothing
 * done by the typed text itself; a short expiry.
 *
 * The reason is mandatory twice over: an empty or over-long message is refused here and the
 * capture stays open, and the table's CHECK refuses a CONFIRMED reason capture without one.
 */
export class ReceiptReasonCaptureService<TSubject extends object, TOutcome> {
  constructor(
    private readonly deps: ReceiptReasonCaptureDeps,
    private readonly policy: ReasonCapturePolicy<TSubject, TOutcome>,
  ) {}

  /** The question before anything is written: whose, or which, it would be. Writes nothing. */
  async ask(
    scope: TenantContext,
    actor: ActorContext,
    targetId: string,
  ): Promise<ReasonAskResult<TSubject>> {
    const id = this.targetId(targetId);
    const denial = { action: this.policy.action, entityType: this.entityType(), entityId: id };
    await this.authorize(scope, actor, this.policy.permission, denial);
    await this.authorize(scope, actor, this.policy.viewPermission, denial);
    const subject = await this.policy.load(scope, id);
    return subject === null ? { outcome: 'GONE' } : { outcome: 'ASK', ...subject };
  }

  /** Opens this administrator's reason capture for this target. Does nothing else. */
  async open(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly targetId: string;
    },
  ): Promise<ReasonOpenResult<TSubject>> {
    const targetId = this.targetId(input.targetId);
    const adminId = this.adminIdOf(actor);
    const denial = {
      action: this.policy.action,
      entityType: this.entityType(),
      entityId: targetId,
    };
    await this.authorize(scope, actor, this.policy.permission, denial);
    await this.authorize(scope, actor, this.policy.viewPermission, denial);

    const requestHash = hashRequest({
      targetId,
      bot: input.botInstanceId,
      open: this.policy.purpose,
    });
    const replayed = await this.deps.idempotency.find<{ captureId: string }>(
      scope,
      CAPTURE_NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replayed !== null) {
      const capture = await this.deps.captures.findById(scope, replayed.result.captureId);
      const subject = capture === null ? null : await this.subjectOf(scope, capture);
      if (capture !== null && subject !== null) return { outcome: 'OPENED', capture, ...subject };
    }

    return this.mutate(scope, actor, denial, async (tx) => {
      await this.deps.captures.lockForAdmin(scope, input.botInstanceId, adminId, tx);
      const subject = await this.policy.load(scope, targetId, tx);
      if (subject === null) return { outcome: 'GONE' } as const;
      const now = this.deps.clock.now();
      // Opening closes any other open prompt of this administrator on this bot — a credit's
      // amount capture included — in this transaction: one prompt, never two.
      const capture = await this.deps.captures.open(
        scope,
        {
          id: this.deps.ids.uuid(),
          botInstanceId: input.botInstanceId,
          adminId,
          ...(this.policy.target === 'PAYMENT'
            ? { paymentId: targetId as PaymentId }
            : { customerId: targetId as UserId }),
          purpose: this.policy.purpose,
          openedAt: now,
          expiresAt: new Date(now.getTime() + ADMIN_AMOUNT_CAPTURE_TTL_MS),
        },
        tx,
      );
      await rememberOnce(
        this.deps.idempotency,
        scope,
        CAPTURE_NAMESPACE,
        input.idempotencyKey,
        requestHash,
        { captureId: capture.id },
        tx,
      );
      return { outcome: 'OPENED', capture, ...subject } as const;
    });
  }

  /**
   * An administrator's plain message, offered to their reason capture of this purpose.
   *
   * `NO_CAPTURE` — the answer for almost every message — when the sender has none waiting;
   * the message then routes exactly as it did before. The reason is RECORDED, not acted on:
   * only the confirm that restates it acts.
   */
  async submitReason(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly text: string;
    },
  ): Promise<ReasonTextResult<TSubject>> {
    const adminId = this.adminIdOrNull(actor);
    if (adminId === null) return { outcome: 'NO_CAPTURE' };

    const requestHash = hashRequest({
      bot: input.botInstanceId,
      text: input.text,
      reason: this.policy.purpose,
    });
    const replayed = await this.deps.idempotency.find<{ captureId: string }>(
      scope,
      CAPTURE_NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replayed !== null) {
      const capture = await this.deps.captures.findById(scope, replayed.result.captureId);
      const subject = capture === null ? null : await this.subjectOf(scope, capture);
      if (capture !== null && capture.reason !== null && subject !== null) {
        return { outcome: 'ENTERED', capture, reason: capture.reason, ...subject };
      }
    }

    const waiting = await this.deps.captures.findAwaitingReason(
      scope,
      input.botInstanceId,
      adminId,
      this.policy.purpose,
    );
    if (waiting === null) return { outcome: 'NO_CAPTURE' };

    const denial = {
      action: this.policy.action,
      entityType: this.entityType(),
      entityId: this.targetIdOf(waiting),
    };
    return this.mutate(scope, actor, denial, async (tx) => {
      await this.deps.captures.lockForAdmin(scope, input.botInstanceId, adminId, tx);
      // Read again under the lock: two messages arriving together are one reason.
      const capture = await this.deps.captures.findAwaitingReason(
        scope,
        input.botInstanceId,
        adminId,
        this.policy.purpose,
        tx,
      );
      if (capture === null) return { outcome: 'NO_CAPTURE' } as const;
      const now = this.deps.clock.now();
      if (now.getTime() >= capture.expiresAt.getTime()) {
        await this.deps.captures.close(scope, capture.id, 'EXPIRED', now, tx);
        return { outcome: 'EXPIRED' } as const;
      }
      const subject = await this.subjectOf(scope, capture, tx);
      if (subject === null) {
        await this.deps.captures.close(scope, capture.id, 'SUPERSEDED', now, tx);
        return { outcome: 'GONE' } as const;
      }

      const reason = normaliseCaptureReason(input.text);
      // Refused and ANSWERED, and the capture stays open: INCIDENT-FIN-001 is a message
      // swallowed without a word, and "the reason is mandatory" is this refusal.
      if (reason === null) return { outcome: 'INVALID' } as const;

      if (!(await this.deps.captures.recordReason(scope, capture.id, reason, tx))) {
        return { outcome: 'NO_CAPTURE' } as const;
      }
      await rememberOnce(
        this.deps.idempotency,
        scope,
        CAPTURE_NAMESPACE,
        input.idempotencyKey,
        requestHash,
        { captureId: capture.id },
        tx,
      );
      return {
        outcome: 'ENTERED',
        capture: { ...capture, reason },
        reason,
        ...subject,
      } as const;
    });
  }

  /**
   * The commit: close the capture CONFIRMED, then act under the capture-derived key.
   *
   * Closed FIRST and acted after. A capture found already CONFIRMED acts again under the same
   * key, which the path behind it answers with its first result — so a double tap, a
   * redelivered update and a tap after a crash between the two are one action, never two.
   */
  async confirm(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly captureId: string },
  ): Promise<ReasonConfirmResult<TOutcome>> {
    const adminId = this.adminIdOf(actor);
    const captureId = this.captureId(input.captureId);
    const denial = {
      action: this.policy.action,
      entityType: 'AdminAmountCapture',
      entityId: captureId,
    };
    await this.authorize(scope, actor, this.policy.permission, denial);

    const decided = await this.mutate(scope, actor, denial, async (tx) => {
      const found = await this.deps.captures.findById(scope, captureId, tx);
      if (found === null || found.adminId !== adminId) return { outcome: 'GONE' } as const;
      await this.deps.captures.lockForAdmin(scope, found.botInstanceId, adminId, tx);
      const capture = await this.deps.captures.findById(scope, captureId, tx);
      if (capture === null || capture.purpose !== this.policy.purpose || capture.reason === null) {
        return { outcome: 'GONE' } as const;
      }
      if (capture.closeReason === 'CONFIRMED') {
        return { outcome: 'ACT', capture, reason: capture.reason } as const;
      }
      if (capture.closeReason !== null) {
        return { outcome: 'CLOSED', reason: capture.closeReason } as const;
      }
      const now = this.deps.clock.now();
      if (now.getTime() >= capture.expiresAt.getTime()) {
        await this.deps.captures.close(scope, capture.id, 'EXPIRED', now, tx);
        return { outcome: 'CLOSED', reason: 'EXPIRED' } as const;
      }
      if (!(await this.deps.captures.close(scope, capture.id, 'CONFIRMED', now, tx))) {
        const standing = await this.deps.captures.findById(scope, captureId, tx);
        if (standing?.closeReason === 'CONFIRMED' && standing.reason !== null) {
          return { outcome: 'ACT', capture: standing, reason: standing.reason } as const;
        }
        return { outcome: 'CLOSED', reason: standing?.closeReason ?? 'CANCELLED' } as const;
      }
      return { outcome: 'ACT', capture, reason: capture.reason } as const;
    });
    if (decided.outcome !== 'ACT') return decided;

    const subject = await this.subjectOf(scope, decided.capture);
    if (subject === null) return { outcome: 'GONE' };
    const result = await this.policy.act(scope, actor, {
      idempotencyKey: this.policy.keyFor(decided.capture.id),
      subject,
      reason: decided.reason,
      captureId: decided.capture.id,
    });
    return { outcome: 'DONE', result, reason: decided.reason };
  }

  /** The cancel button. Nothing about the customer or the payment changes. */
  async cancel(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly captureId: string },
  ): Promise<ReasonCancelResult> {
    const adminId = this.adminIdOf(actor);
    const captureId = this.captureId(input.captureId);
    const denial = {
      action: this.policy.action,
      entityType: 'AdminAmountCapture',
      entityId: captureId,
    };
    await this.authorize(scope, actor, this.policy.permission, denial);

    return this.mutate(scope, actor, denial, async (tx) => {
      const found = await this.deps.captures.findById(scope, captureId, tx);
      if (found === null || found.adminId !== adminId || found.purpose !== this.policy.purpose) {
        return { outcome: 'GONE' } as const;
      }
      // The confirm's own lock, so a cancel and a confirm tapped together are serial.
      await this.deps.captures.lockForAdmin(scope, found.botInstanceId, adminId, tx);
      const capture = await this.deps.captures.findById(scope, captureId, tx);
      if (capture === null) return { outcome: 'GONE' } as const;
      const confirmed = {
        outcome: 'CONFIRMED',
        targetId: this.targetIdOf(capture) ?? captureId,
      } as const;
      if (capture.closeReason === 'CONFIRMED') return confirmed;
      if (
        capture.closeReason === null &&
        !(await this.deps.captures.close(scope, capture.id, 'CANCELLED', this.deps.clock.now(), tx))
      ) {
        const standing = await this.deps.captures.findById(scope, captureId, tx);
        if (standing?.closeReason === 'CONFIRMED') return confirmed;
      }
      await rememberOnce(
        this.deps.idempotency,
        scope,
        CAPTURE_NAMESPACE,
        input.idempotencyKey,
        hashRequest({ captureId, cancel: this.policy.purpose }),
        { captureId },
        tx,
      );
      return { outcome: 'CANCELLED' } as const;
    });
  }

  // -------------------------------------------------------------------------

  /** The policy's permission re-checked inside the transaction, and the scope's activity. */
  private mutate<T>(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
    fn: (tx: TransactionScope) => Promise<T>,
  ): Promise<T> {
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      this.policy.permission,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        return fn(tx);
      },
    );
  }

  /** The capture's target, loaded through the policy — null when the capture names none. */
  private async subjectOf(
    scope: TenantContext,
    capture: AdminAmountCaptureRecord,
    tx?: TransactionScope,
  ): Promise<TSubject | null> {
    const targetId = this.targetIdOf(capture);
    if (targetId === null) return null;
    return this.policy.load(scope, targetId, tx);
  }

  /**
   * The id the capture names for THIS policy's target. A capture of the other kind — a
   * payment-naming row met by a customer policy, say — has none, and is answered as gone
   * rather than read through the wrong table.
   */
  private targetIdOf(capture: AdminAmountCaptureRecord): string | null {
    return this.policy.target === 'PAYMENT' ? capture.paymentId : capture.customerId;
  }

  private entityType(): string {
    return this.policy.target === 'PAYMENT' ? 'Payment' : 'Customer';
  }

  private adminIdOf(actor: ActorContext): string {
    const id = this.adminIdOrNull(actor);
    if (id !== null) return id;
    throw errors.permissionDenied(
      PLATFORM_ERROR_CODES.PERMISSION_DENIED,
      'Only an administrator can give a reason here.',
    );
  }

  private adminIdOrNull(actor: ActorContext): string | null {
    return (actor.type === 'WEB_ADMIN' || actor.type === 'TELEGRAM_ADMIN') && actor.id !== null
      ? actor.id
      : null;
  }

  /**
   * The target id, validated by the schema its table uses — a UUIDv7, lower-cased — so a
   * malformed callback is a refusal and never a cast error at the `uuid` column.
   */
  private targetId(candidate: string): string {
    if (this.policy.target === 'PAYMENT') {
      const parsed = paymentIdSchema.safeParse(candidate);
      if (!parsed.success) {
        throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');
      }
      return parsed.data;
    }
    const parsed = userIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
    return parsed.data;
  }

  private captureId(candidate: string): string {
    const parsed = uuidV7Schema.safeParse(candidate);
    return parsed.success ? parsed.data : '00000000-0000-7000-8000-000000000000';
  }

  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (error) {
      await recordMutationDenial(this.mutationDeps(), scope, actor, permission, denial, error);
      throw error;
    }
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}

/**
 * A typed reason as it is stored: trimmed, and between one and
 * `ADMIN_CAPTURE_REASON_MAX_LENGTH` characters — the bound the capture's CHECK applies. Null
 * for anything else, which is refused rather than truncated: a reason cut short is a different
 * reason. Code points, as PostgreSQL's `length` counts them.
 */
export function normaliseCaptureReason(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (Array.from(trimmed).length > ADMIN_CAPTURE_REASON_MAX_LENGTH) return null;
  return trimmed;
}
