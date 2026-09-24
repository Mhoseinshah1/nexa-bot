import {
  COMMERCE_ERROR_CODES,
  PAYMENT_RECEIPT_MAX_PER_PAYMENT,
  errors,
  type ActorContext,
  type AuditWriter,
  type BotInstanceId,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PaymentId,
  type PaymentReceiptId,
  type PermissionKey,
  type ReceiptDisposition,
  type TemplateValues,
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
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { CustomerRecord, CustomerRepository } from '../../customers/application/ports.js';
import type { PaymentRecord, PaymentRepository } from './ports.js';
import type { ReceiptCreditRecord, ReceiptCreditRepository } from './receipt-credit-ports.js';
import type { ReceiptReviewCaption } from './receipt-review-caption.js';
import type {
  InboundReceiptFile,
  PaymentReceiptRecord,
  PaymentReceiptRepository,
  ReceiptCaptureRepository,
} from './receipt-ports.js';

/**
 * What a CUSTOMER sending a receipt acts under.
 *
 * `maintenance.run`, the same key `PAYMENT_PLACE_PERMISSION` uses and for the reason
 * recorded there: this is system work triggered by a customer, `SYSTEM_JOB` holds that
 * one key and nothing else, and the check is MADE rather than skipped because
 * authorization is never decided by looking at an actor's type.
 */
export const RECEIPT_SUBMIT_PERMISSION: PermissionKey = 'maintenance.run';

/** What an operator needs to read one payment's receipts, and their bytes. */
export const RECEIPT_VIEW_PERMISSION: PermissionKey = 'receipts.view';

/** Customer-initiated work shares one idempotency namespace. See `PaymentService`. */
const CUSTOMER_NAMESPACE = 'TELEGRAM';

export interface ReceiptSubmission {
  readonly idempotencyKey: string;
  /**
   * The bot the file arrived on. The window is keyed on it, so it is carried rather
   * than read from `TenantContext.botInstanceId` — see `PaymentSentSignal`.
   */
  readonly botInstanceId: BotInstanceId;
  readonly file: InboundReceiptFile;
}

/**
 * What was done with the file.
 *
 * `filed` is false for the ONE non-refusal that is not a new row: Telegram redelivering
 * an update whose file is already on the payment. The customer's situation is identical
 * either way, so the surface says the same thing — which is why this is a field and
 * not a refusal.
 */
export interface ReceiptSubmissionResult {
  readonly paymentId: PaymentId;
  readonly filed: boolean;
  /** How many the payment holds after this call. What decides whether the window closed. */
  readonly held: number;
}

/**
 * One row of the reviewer's queue.
 *
 * The payment is the authority on the money; `held` is how many receipts are attached,
 * which is what tells a reviewer whether there is more than one thing to look at. The
 * customer may be null only if the row disappeared between two reads — the FK makes it
 * unreachable in practice and it is typed honestly rather than asserted away.
 */
export interface ReceiptQueueItem {
  readonly payment: PaymentRecord;
  readonly customer: CustomerRecord | null;
  readonly held: number;
}

export interface ReceiptServiceDeps {
  readonly captures: ReceiptCaptureRepository;
  readonly receipts: PaymentReceiptRepository;
  /**
   * The payment read ALONE.
   *
   * A receipt is evidence an operator looks at; nothing here may confirm, reject or
   * settle anything, and a module holding the whole payment repository could. The
   * addendum's own words — *"settlement still requires the existing authorized
   * operator confirmation"* — are enforced by this type as much as by the permission.
   */
  readonly payments: Pick<
    PaymentRepository,
    'findById' | 'findByIdForUpdate' | 'receiptDispositions'
  >;
  /** The credit-to-wallet disposition's row, READ, for the already-resolved answer (§5). */
  readonly credits: Pick<ReceiptCreditRepository, 'findByPayment'>;
  /**
   * Where a filed receipt announces itself (WP10 follow-up §3, ADR-0031): one
   * `PaymentReceiptSubmitted`, in the SAME transaction as the row, so the administrators'
   * push is exactly as durable as the receipt and never part of what filing it can fail on.
   */
  readonly outbox: Pick<OutboxWriter, 'write'>;
  /** The reviewer's caption values — the one builder the pull item and the push share. */
  readonly caption: ReceiptReviewCaption;
  /** Read to refuse a BLOCKED customer inside the transaction that would write the row. */
  readonly customers: CustomerRepository;
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

/**
 * The receipt a customer sends, and the window that makes it a receipt.
 *
 * ## Why a window at all
 *
 * Without one, "a photo from a customer" has to be attached to something, and the only
 * available something is whichever payment they most recently had. That is
 * `INCIDENT-FIN-001` rebuilt: the legacy system's prompt capture consumed an ordinary
 * message and overwrote a production gateway setting, because a prompt outlived the
 * question it was asked for. So this window has four properties that one did not, and
 * all four are in the schema rather than here:
 *
 *   - it names the ONE payment it was opened for, and a file cannot reach another;
 *   - it is keyed on (tenant, bot, customer) by a partial unique index, so a customer
 *     has at most one and there is no ambiguity to resolve in code;
 *   - it expires, and the deadline is the sooner of `RECEIPT_CAPTURE_MINUTES` and the
 *     payment's own;
 *   - it is opened only by the tap that asked for a receipt, in that tap's transaction.
 *
 * ## What it is not
 *
 * It is not conversation state and it is not an FSM. Nothing about the NEXT message is
 * decided by it: an update with no file routes exactly as it did before this existed,
 * and a `/start` sent while a window is open is a `/start`. What it holds is an
 * authorization to attach a file to one payment, which is the smallest fact that makes
 * the addendum's flow possible.
 *
 * ## What filing a receipt does NOT do
 *
 * Settle, confirm, credit or move anything. `PAYMENT_EVIDENCE_KINDS` is still
 * `OPERATOR_REVIEW` and the confirmation is still `receipts.review`. A row here is
 * something for a person to look at.
 */
export class ReceiptService {
  constructor(private readonly deps: ReceiptServiceDeps) {}

  /**
   * Files one inbound file against the payment its window names.
   *
   * Refuses by NAME in four cases the customer can tell apart, because the remedy
   * differs in each: no window is open (`RECEIPT_NOT_EXPECTED`), the window's deadline
   * has passed (`RECEIPT_WINDOW_EXPIRED`), the payment holds all it may
   * (`RECEIPT_LIMIT_REACHED`), and the payment is no longer pending
   * (`PAYMENT_STATE_INVALID`).
   *
   * None of the four writes anything, and that is deliberate rather than an oversight:
   * a refusal throws, a throw rolls its transaction back, and a design where the
   * refusal's bookkeeping had to survive would need a second transaction around a
   * refusal. An expired window is closed as `EXPIRED` by the next `open` — which is
   * where a reader of `receipt_captures` sees what happened to it — and until then
   * every reader compares `expires_at` to the clock, exactly as this one does.
   */
  async submit(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    submission: ReceiptSubmission,
  ): Promise<ReceiptSubmissionResult> {
    const denial = { action: 'payment.receipt_submit', entityType: 'Payment', entityId: null };
    await this.authorize(scope, actor, RECEIPT_SUBMIT_PERMISSION, denial);

    /*
     * The HASH carries the file, not just the key.
     *
     * `fileUniqueId` is stable across re-sends of the same file, so a redelivered
     * update hashes identically and replays; a DIFFERENT file under a reused key is a
     * mismatch rather than a silent replay that would answer "received" for a file
     * nobody stored.
     */
    const requestHash = hashRequest({
      customerId,
      fileUniqueId: submission.file.fileUniqueId,
      kind: submission.file.kind,
    });
    const replayed = await this.deps.idempotency.find<ReceiptReplay>(
      scope,
      CUSTOMER_NAMESPACE,
      submission.idempotencyKey,
      requestHash,
    );
    if (replayed !== null) {
      return {
        paymentId: replayed.result.paymentId as PaymentId,
        filed: replayed.result.filed,
        held: replayed.result.held,
      };
    }

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      RECEIPT_SUBMIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);

        /*
         * BEFORE the read, and this is the whole of the concurrency fix.
         *
         * Two files arriving together each read the same count and each insert a
         * different `file_unique_id`, so nothing conflicts and the payment ends up
         * holding six receipts where the constant says five. Counting does not lock the
         * gap; this does, keyed on exactly what the partial unique index is keyed on.
         */
        await this.deps.captures.lockForCustomer(scope, submission.botInstanceId, customerId, tx);

        const open = await this.deps.captures.findOpen(
          scope,
          submission.botInstanceId,
          customerId,
          tx,
        );
        if (open === null) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.RECEIPT_NOT_EXPECTED,
            'No receipt was expected from this customer.',
          );
        }
        if (open.expiresAt.getTime() <= now.getTime()) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.RECEIPT_WINDOW_EXPIRED,
            'The window to send this receipt has closed.',
          );
        }

        const customer = await this.deps.customers.findById(scope, customerId, tx);
        /*
         * The surface refuses a blocked customer on arrival and an operator can block
         * between that check and this write — the same sentence `PaymentService`'s
         * `customers` dependency carries, applied to the one path that writes a row on
         * a customer's behalf without moving money.
         */
        if (customer === null || customer.status === 'BLOCKED') {
          /*
           * A CONFLICT, the same kind `PaymentService` gives it. Not a permission
           * failure: the customer is authorized and the installation has stopped
           * accepting work FROM them, which is a state and not a grant.
           */
          throw errors.conflict(
            COMMERCE_ERROR_CODES.CUSTOMER_BLOCKED,
            'This account cannot send a receipt.',
          );
        }

        const payment = await this.deps.payments.findByIdForUpdate(scope, open.paymentId, tx);
        /*
         * Re-read FOR UPDATE, and the ownership checked again against the row. The
         * window names a payment and the window is ours to trust; the payment's STATE is
         * not, because an operator can confirm or reject it while the customer is
         * choosing a photo — and an unlocked read leaves room for that confirmation to
         * commit between this line and the insert, which would attach evidence to a
         * payment somebody had already decided.
         */
        if (payment === null || payment.customerId !== customerId) {
          throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');
        }
        if (payment.state !== 'PENDING') {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,
            'This payment is no longer pending.',
          );
        }

        const already = await this.deps.receipts.countForPayment(scope, open.paymentId, tx);
        if (already >= PAYMENT_RECEIPT_MAX_PER_PAYMENT) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.RECEIPT_LIMIT_REACHED,
            'This payment already holds every receipt it can.',
          );
        }

        const filed = await this.deps.receipts.attach(
          scope,
          {
            id: this.deps.ids.uuid() as PaymentReceiptId,
            botInstanceId: submission.botInstanceId,
            customerId,
            paymentId: open.paymentId,
            file: submission.file,
            now,
          },
          tx,
        );
        const held = filed === null ? already : already + 1;

        /*
         * The window closes when the payment is FULL, and not when the first file
         * arrives.
         *
         * A customer who sends a blurred screenshot and then a clear one is doing
         * something ordinary; closing on the first would answer the second with
         * `RECEIPT_NOT_EXPECTED`, which is the refusal for a file nobody asked for. So
         * the BOUND closes it, and `RECEIVED` means the window did its job.
         *
         * Conditional, and its false result is ignored on purpose: false means somebody
         * else closed it first, which is not a second decision and not an error.
         */
        if (held >= PAYMENT_RECEIPT_MAX_PER_PAYMENT) {
          await this.deps.captures.close(scope, open.id, 'RECEIVED', now, tx);
        }

        /*
         * Audited only when a row was written. A redelivered update is not an event, and
         * a log that grew a line per Telegram retry would be the legacy activity feed.
         *
         * The payload carries the two identifiers and the declared size and type. It
         * does NOT carry `fileId`: that is what `getFile` takes, it is bot-scoped, and
         * an audit payload is read in more places than a receipt row is.
         */
        if (filed !== null) {
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'payment.receipt_submit',
              entityType: 'Payment',
              entityId: open.paymentId,
              before: { receipts: already },
              after: {
                receipts: held,
                receiptId: filed.id,
                kind: filed.kind,
                fileUniqueId: filed.fileUniqueId,
                fileSize: filed.fileSize === null ? null : filed.fileSize.toString(),
                mimeType: filed.mimeType,
              },
              result: 'SUCCESS',
            },
            tx,
          );
        }

        /*
         * The push to the administrators, as an EVENT and nothing more (WP10 follow-up §3).
         *
         * Only for a row this call wrote — a redelivered update filed nothing and announces
         * nothing. Who is told, and the send, are the consumer's and the push lane's: both
         * run after this commits, so neither can cost the customer their receipt.
         */
        if (filed !== null) {
          await this.deps.outbox.write(tx, actor, {
            eventType: 'PaymentReceiptSubmitted',
            aggregateType: 'Payment',
            aggregateId: open.paymentId,
            payload: { paymentId: open.paymentId, receiptId: filed.id },
          });
        }

        const answer: ReceiptReplay = {
          paymentId: open.paymentId,
          filed: filed !== null,
          held,
        };
        await rememberOnce(
          this.deps.idempotency,
          scope,
          CUSTOMER_NAMESPACE,
          submission.idempotencyKey,
          requestHash,
          answer,
          tx,
        );
        return { paymentId: open.paymentId, filed: filed !== null, held };
      },
    );
  }

  /**
   * Everything filed against one payment, for the reviewer looking at it.
   *
   * `receipts.view` and not `payments.view`: reading the evidence is its own LOW read,
   * which is what lets the seeded `receipt_reviewer` role hold it without holding
   * anything that decides. The records carry `fileId`, which is why the controller
   * projects them to `PaymentReceiptView` before anything reaches a browser.
   */
  /**
   * The queue an administrator works: manual transfers that hold a receipt and are
   * still PENDING (Phase 5T).
   *
   * Bounded, and the bound is applied in SQL against the same predicate — so ten rows
   * are ten decisions still to make rather than ten rows of which some are already
   * decided. There is no history here and that is a property rather than an omission:
   * this answers "what is waiting", the payment's own resolution answers what happened
   * to everything else, and the Mirza section it is modelled on showed pending items
   * and nothing else either.
   *
   * The payment and the customer are read per row, which is an N+1 bounded by `limit`
   * and deliberate: the alternative is a three-table join whose projection would have
   * to be maintained beside two aggregates, to save nine round trips on a screen a
   * person reads.
   */
  async reviewQueue(
    scope: TenantContext,
    actor: ActorContext,
    limit: number,
  ): Promise<readonly ReceiptQueueItem[]> {
    await this.deps.guard.check(scope, actor, RECEIPT_VIEW_PERMISSION);
    const rows = await this.deps.receipts.pendingForReview(scope, limit);
    const items: ReceiptQueueItem[] = [];
    for (const row of rows) {
      const payment = await this.deps.payments.findById(scope, row.paymentId);
      // A payment resolved between the queue query and this read is simply not in the
      // list. Skipped rather than rendered as "gone": the row was never shown, so there
      // is nothing for the reader to reconcile.
      if (payment === null || payment.state !== 'PENDING') continue;
      const customer = await this.deps.customers.findById(scope, payment.customerId);
      items.push({ payment, customer, held: row.held });
    }
    return items;
  }

  /**
   * One queue item, with its receipts, for the screen that decides it.
   *
   * `null` when the payment is no longer PENDING, which is what makes a stale inline
   * button say so instead of doing something: the message that drew it stays in the
   * chat for ever, and the state it described is not the state now.
   */
  async reviewItem(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: PaymentId,
  ): Promise<{
    readonly payment: PaymentRecord;
    readonly customer: CustomerRecord | null;
    readonly receipts: readonly PaymentReceiptRecord[];
    /** `bot.admin.receipt`'s values for THIS reviewer (File 01 §4). */
    readonly caption: TemplateValues;
  } | null> {
    await this.deps.guard.check(scope, actor, RECEIPT_VIEW_PERMISSION);
    const payment = await this.deps.payments.findById(scope, paymentId);
    if (payment === null || payment.state !== 'PENDING' || payment.method !== 'MANUAL_TRANSFER') {
      return null;
    }
    const receipts = await this.deps.receipts.listForPayment(scope, paymentId);
    const customer = await this.deps.customers.findById(scope, payment.customerId);
    const caption = await this.deps.caption.valuesFor(scope, actor, payment, customer, receipts);
    return { payment, customer, receipts, caption };
  }

  /**
   * How a receipt left review, for a reviewer whose button is stale (WP10 follow-up §5).
   *
   * `null` when the payment is unknown, still pending, or was not decided as a receipt. The
   * credit's own row rides along for `CREDITED_TO_WALLET`, so the answer can name the amount
   * rather than leave a FAILED payment to be read as a rejection.
   */
  async dispositionOf(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: PaymentId,
  ): Promise<{
    readonly disposition: ReceiptDisposition;
    readonly credit: ReceiptCreditRecord | null;
  } | null> {
    await this.deps.guard.check(scope, actor, RECEIPT_VIEW_PERMISSION);
    const found = await this.deps.payments.receiptDispositions(scope, [paymentId]);
    const disposition = found.get(paymentId) ?? null;
    if (disposition === null) return null;
    const credit =
      disposition === 'CREDITED_TO_WALLET'
        ? await this.deps.credits.findByPayment(scope, paymentId)
        : null;
    return { disposition, credit };
  }

  async listForPayment(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: PaymentId,
  ): Promise<readonly PaymentReceiptRecord[]> {
    await this.deps.guard.check(scope, actor, RECEIPT_VIEW_PERMISSION);
    const payment = await this.deps.payments.findById(scope, paymentId);
    if (payment === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');
    }
    return this.deps.receipts.listForPayment(scope, paymentId);
  }

  /**
   * One receipt, by id, with the `fileId` the bytes are fetched with.
   *
   * The payment is read too, and only to prove the receipt belongs to a payment this
   * tenant has — the repository is already tenant-scoped, and this is the second lock
   * on the one route that turns an id into a file.
   */
  async findForDownload(
    scope: TenantContext,
    actor: ActorContext,
    receiptId: PaymentReceiptId,
  ): Promise<{ readonly receipt: PaymentReceiptRecord; readonly payment: PaymentRecord }> {
    await this.deps.guard.check(scope, actor, RECEIPT_VIEW_PERMISSION);
    const receipt = await this.deps.receipts.findById(scope, receiptId);
    if (receipt === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.RECEIPT_NOT_FOUND, 'Unknown receipt.');
    }
    const payment = await this.deps.payments.findById(scope, receipt.paymentId);
    if (payment === null) {
      /* istanbul ignore next -- a composite FK makes this unreachable; refused anyway. */
      throw errors.notFound(COMMERCE_ERROR_CODES.RECEIPT_NOT_FOUND, 'Unknown receipt.');
    }
    return { receipt, payment };
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

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
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

/** What the idempotency store remembers, so a replay answers without re-deciding. */
interface ReceiptReplay {
  readonly paymentId: string;
  readonly filed: boolean;
  readonly held: number;
}
