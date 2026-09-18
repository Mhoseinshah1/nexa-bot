import {
  COMMERCE_ERROR_CODES,
  MAX_ORDER_QUANTITY,
  ORDER_MACHINE,
  errors,
  nextState,
  orderIdSchema,
  userIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type OrderId,
  type PermissionKey,
  type ProductId,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import { productIdSchema } from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { PanelSalesGate } from '../../../platform/panels/application/panel-sales-gate.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import type { ProductRecord, ProductRepository } from '../../catalog/application/ports.js';
import { unorderableReason } from '../../catalog/application/catalog-visibility.js';
import { quoteProduct } from './order-pricing.js';
import type { OrderCursor, OrderPage, OrderRecord, OrderRepository, OrderSearch } from './ports.js';

/** What an operator needs to read the order list and an order's detail. */
export const ORDER_VIEW_PERMISSION: PermissionKey = 'orders.view';

/**
 * What a customer-initiated order command acts under.
 *
 * `maintenance.run`, exactly as `CATALOG_BROWSE_PERMISSION` and
 * `RESOLVE_CUSTOMER_PERMISSION` do: this is system work triggered by a customer,
 * `SYSTEM_JOB` holds that one key and nothing else, and the check is MADE rather than
 * skipped because `nexa-conventions` forbids deciding authorization by looking at an
 * actor's type.
 *
 * Note what this is NOT: `orders.manual.create`. That permission exists for an
 * OPERATOR placing an order on a customer's behalf, which is a surface Phase 4B does
 * not build. Charging it here would make a customer's own purchase indistinguishable
 * from an operator-placed one in the audit log.
 */
export const ORDER_PLACE_PERMISSION: PermissionKey = 'maintenance.run';

/**
 * The idempotency namespace for customer order commands.
 *
 * `'TELEGRAM'`, because that is the surface these commands arrive through and the
 * namespace exists to stop a key minted by one surface colliding with a key minted by
 * another. It is a constant rather than a parameter for the same reason the initial
 * state is: a caller that can choose its own namespace can choose one that does not
 * collide with the replay it is supposed to find.
 */
const ORDER_NAMESPACE = 'TELEGRAM' as const;

/**
 * What an order cancellation needs to know and do about the payments against it.
 *
 * A NARROW port rather than `PaymentRepository`, for the reason `CustomerBotReader`
 * gives one module over: handing the order service the payment repository would also
 * hand it `confirm`, and therefore the ability to mark money as received from inside an
 * order command.
 *
 * Both methods are scoped to ONE order and take the caller's transaction, because the
 * order's cancellation and the payment's withdrawal are the same fact: an order
 * cancelled while a transfer instruction is still live is an instruction to send money
 * for something that no longer exists, which is the half-state
 * `PaymentExpiryService`'s docblock names as the dangerous one.
 */
export interface OrderPaymentLane {
  /**
   * Whether any PENDING payment against this order has been claimed as sent.
   *
   * The one combination 4H must not perform. A customer who has said they transferred
   * the money may have money in flight, and cancelling would close the payment it was
   * against while the transfer is on its way to a reference nobody is holding open.
   */
  claimedPendingFor(scope: TenantContext, orderId: OrderId, tx: TransactionScope): Promise<boolean>;

  /**
   * Withdraws every PENDING payment against this order. Returns the ids it moved.
   *
   * A set rather than one row, because `requestManualTransfer` allows at most one
   * PENDING transfer per order but nothing in the schema says the set is a singleton,
   * and a cancellation that closed "the" payment would leave the second one live.
   */
  withdrawPendingFor(
    scope: TenantContext,
    orderId: OrderId,
    now: Date,
    tx: TransactionScope,
  ): Promise<readonly string[]>;
}

export interface OrderServiceDeps {
  readonly repository: OrderRepository;
  /** How a cancellation reaches the payments against the order. See `OrderPaymentLane`. */
  readonly payments: OrderPaymentLane;
  readonly products: ProductRepository;
  readonly customers: CustomerRepository;
  readonly settings: SettingsResolver;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly outbox: OutboxWriter;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  /**
   * Whether the panel behind the product may be sold onto, and the holder of the
   * slot this order takes.
   *
   * A port into the panels module rather than a rule here. `catalog-visibility`
   * already answers "is this product sellable in principle"; this answers "is the
   * machine behind it able to take one more today", which is a fact about the
   * fleet and not about the catalogue.
   */
  readonly panelSales: PanelSalesGate;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface OrderListQuery {
  readonly limit?: number;
  readonly cursor?: OrderCursor;
  readonly search: OrderSearch;
}

export const ORDER_PAGE_DEFAULT = 25;
export const ORDER_PAGE_MAX = 100;

/**
 * Orders, from the customer's intent to the boundary where money begins.
 *
 * Phase 4B owns exactly two writes: creating a `DRAFT`, and moving it to
 * `AWAITING_PAYMENT`. `SETTLE` is not here, and its absence is the phase boundary
 * rather than an omission — `ORDER_MACHINE` guards that edge with
 * `settlementIsFunded`, and the funding it names is a payment or a wallet debit,
 * neither of which exists. An implementation of `SETTLE` in this phase could only
 * satisfy that guard by pretending.
 *
 * ## The snapshot, and when it is taken
 *
 * Every `line_*` field is copied onto the order when the DRAFT is created, not when it
 * is confirmed. That is forced — the columns are NOT NULL and a DRAFT is a row — and it
 * is also right: the number in `bot.order.summary` is the number the customer agreed
 * to, so re-pricing at confirmation would charge them something they never saw.
 *
 * What confirmation DOES re-check is whether the product can still be ordered at all,
 * and whether the draft's own deadline has passed. Those two together are what stops a
 * stale price being held open indefinitely: the price is honoured, but only inside a
 * window the operator configures.
 */
export class OrderService {
  constructor(private readonly deps: OrderServiceDeps) {}

  async list(scope: TenantContext, actor: ActorContext, query: OrderListQuery): Promise<OrderPage> {
    await this.deps.guard.check(scope, actor, ORDER_VIEW_PERMISSION);
    const limit = Math.min(Math.max(query.limit ?? ORDER_PAGE_DEFAULT, 1), ORDER_PAGE_MAX);
    return this.deps.repository.list(scope, query.search, limit, query.cursor ?? null);
  }

  async get(scope: TenantContext, actor: ActorContext, id: string): Promise<OrderRecord> {
    await this.deps.guard.check(scope, actor, ORDER_VIEW_PERMISSION);
    const order = await this.deps.repository.findById(scope, this.orderId(id));
    if (order === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
    }
    return order;
  }

  /**
   * Creates a DRAFT for one product, priced and snapshotted.
   *
   * Nothing is owed at the end of this. The customer is looking at a summary, and the
   * row exists so that what they are looking at is a stored fact rather than a number
   * rendered into a message — which is how the legacy system ends up unable to say what
   * anybody was quoted.
   */
  async createDraft(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly productId: string;
    },
  ): Promise<OrderRecord> {
    const customerId = this.customerId(input.customerId);
    const productId = this.productId(input.productId);
    const requestHash = hashRequest({ customerId, productId });

    /*
     * Authorized BEFORE the replay lookup, not only inside the transaction.
     *
     * `runAuthorizedMutation` re-checks inside the committing transaction, which is the
     * rule — but a replay never reaches it, and a replay returns an ORDER. Without this
     * an unauthorized caller replaying somebody else's key would be answered with one.
     * The check is made twice on a first call and exactly once on a replay, which is the
     * shape `CustomerService.resolveFromUpdate` records for the same reason.
     *
     * Through `authorize` rather than the guard directly: an early check that merely
     * throws leaves NO audit row, so closing the read hole would open a silent-refusal
     * one. See `authorize`.
     */
    await this.authorize(scope, actor, {
      // `order.draft_create`, the SAME action the success row and the transaction-time
      // denial below use. An early refusal recorded under a second name splits one
      // command across two audit actions, so a query for the established one silently
      // omits exactly the denials this early check exists to record. Found by the Codex
      // review of the stabilization round — introduced by the fix for C2.
      action: 'order.draft_create',
      entityType: 'Order',
      entityId: null,
    });

    const replay = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replay !== null) return replay;

    const now = this.deps.clock.now();
    const id = this.deps.ids.uuid() as OrderId;

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      ORDER_PLACE_PERMISSION,
      { action: 'order.draft_create', entityType: 'Order', entityId: null },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.assertCustomerMayOrder(scope, customerId, tx);

        const product = await this.deps.products.findById(scope, productId, tx);
        if (product === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND, 'Unknown product.');
        }
        const { price, panelId } = this.assertOrderable(product);

        const totals = quoteProduct(product, price, MAX_ORDER_QUANTITY, now);
        const expiresAt = new Date(now.getTime() + (await this.expiryMinutes(scope, tx)) * 60_000);

        const created = await this.deps.repository.create(
          scope,
          {
            id,
            customerId,
            line: {
              productId: product.id,
              panelId,
              title: product.title,
              specification: product.specification,
              unitPrice: price,
              quantity: MAX_ORDER_QUANTITY,
            },
            totals,
            expiresAt,
            now,
          },
          tx,
        );

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'order.draft_create',
            entityType: 'Order',
            entityId: created.id,
            before: null,
            after: auditView(created),
            result: 'SUCCESS',
          },
          tx,
        );

        /*
         * No domain event, deliberately.
         *
         * The catalogue declares `OrderConfirmed`, `OrderSettled`, `OrderCancelled` and
         * `OrderRefunded` — and nothing for a draft. A draft commits the customer to
         * nothing and there is no consumer that should act on one; an `OrderDrafted`
         * invented here would be a name in a frozen spec with no reader, which is what
         * `0002_drop_callback_refs` exists to record the cost of.
         */

        await rememberOnce(
          this.deps.idempotency,
          scope,
          ORDER_NAMESPACE,
          input.idempotencyKey,
          requestHash,
          { orderId: created.id },
          tx,
        );
        return created;
      },
    );
  }

  /**
   * DRAFT → AWAITING_PAYMENT. The last edge Phase 4B owns.
   *
   * After this the order is waiting for money, and nothing in this codebase can give
   * it any. That is the boundary: a surface renders `bot.order.awaiting_payment`, and
   * the phase that owns payment picks the order up from there.
   */
  async confirm(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly orderId: string;
    },
  ): Promise<OrderRecord> {
    const customerId = this.customerId(input.customerId);
    const orderId = this.orderId(input.orderId);
    const requestHash = hashRequest({ customerId, orderId });

    /** Before the replay, for the reason `createDraft` states: a replay returns a row. */
    await this.authorize(scope, actor, {
      action: 'order.confirm',
      entityType: 'Order',
      entityId: orderId,
    });

    const replay = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replay !== null) return replay;

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      ORDER_PLACE_PERMISSION,
      { action: 'order.confirm', entityType: 'Order', entityId: orderId },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.assertCustomerMayOrder(scope, customerId, tx);

        const before = await this.deps.repository.findById(scope, orderId, tx);
        /*
         * Another customer's order is UNKNOWN, not FORBIDDEN.
         *
         * A distinct refusal would answer "does order X exist" for anybody willing to
         * guess ids, and an order id is the sort of thing that travels in a screenshot.
         * The two cases are the same sentence to the caller and different rows in the
         * audit log, which is where the distinction is actually useful.
         */
        if (before === null || before.customerId !== customerId) {
          throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
        }

        /*
         * Already confirmed is a SUCCESS, and it is not this call's success.
         *
         * A customer who taps Confirm twice, or a Telegram callback Telegram redelivers,
         * must not be told their order is broken. The end state they asked for holds.
         * The audit row below records `changed: false` so the log still distinguishes
         * "this call confirmed it" from "it was already confirmed" — the distinction
         * `nexa-conventions` requires and a bare success would erase.
         */
        if (before.state !== 'DRAFT') {
          if (before.state !== 'AWAITING_PAYMENT') {
            throw errors.conflict(
              COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
              'This order can no longer be confirmed.',
            );
          }
          await this.recordConfirmation(scope, actor, tx, before, before, false);
          await rememberOnce(
            this.deps.idempotency,
            scope,
            ORDER_NAMESPACE,
            input.idempotencyKey,
            requestHash,
            { orderId: before.id },
            tx,
          );
          return before;
        }

        /*
         * The draft's own deadline, checked BEFORE the product.
         *
         * A DRAFT carries `expires_at` so that a price quoted an hour ago cannot be
         * confirmed a week later. The order is not moved to `EXPIRED` here: that is a
         * sweeper's work and the sweeper is a later phase's, and a read path that
         * quietly writes a state change is a read path an operator cannot reason about.
         * The refusal is what matters now.
         */
        if (before.expiresAt !== null && now.getTime() >= before.expiresAt.getTime()) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.ORDER_EXPIRED,
            'This order was held for too long and must be started again.',
          );
        }

        /*
         * Orderability is re-checked; the PRICE is not re-quoted.
         *
         * Those two go together. Re-quoting would charge a number the customer never
         * saw — the summary they are answering is the offer. Not re-checking would sell
         * a product an operator withdrew, or one whose panel was unbound, between the
         * summary and the tap.
         */
        const product = await this.deps.products.findById(scope, before.line.productId, tx);
        if (product === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND, 'Unknown product.');
        }
        this.assertOrderable(product);

        /*
         * The panel is re-decided here, and the SLOT is taken here.
         *
         * This is the moment money starts: the next state is `AWAITING_PAYMENT`,
         * and from here on a customer may pay at any time. Whatever the catalogue
         * showed a minute ago is a snapshot — `PanelSalesGate` says why it is
         * never trusted — so the panel is evaluated again inside this
         * transaction, under its own row lock, and the hold is taken in the same
         * lock.
         *
         * Taking the slot BEFORE the transition rather than after is what makes
         * the last slot exclusive. Between confirmation and settlement there is no
         * service row, so two customers reaching for the last slot would both
         * count the same n-1 and both be sold it — and the second would discover
         * it after paying.
         *
         * The hold expires with the ORDER, so an abandoned checkout frees the slot
         * without anything having to run.
         */
        const eligible = await this.deps.panelSales.acquire(
          scope,
          before.line.panelId,
          orderId,
          tx,
          before.expiresAt,
        );
        if (!eligible.eligible) {
          throw errors.preconditionFailed(
            COMMERCE_ERROR_CODES.PANEL_NOT_ELIGIBLE,
            'This plan cannot be bought right now.',
            // The REASON, for the operator reading the audit trail and the
            // operations log. The customer's message says none of it — which of
            // somebody's machines is full is not a fact a buyer is owed.
            { reason: eligible.reason },
          );
        }

        /*
         * The target comes from the FROZEN machine, not from a literal.
         *
         * `nextState(ORDER_MACHINE, 'DRAFT', 'CONFIRM')` is `AWAITING_PAYMENT` because
         * the contract says so. Writing the literal here would let the machine and this
         * service disagree silently, and the machine is the thing the state-machine
         * validation test walks.
         */
        const to = nextState(ORDER_MACHINE, 'DRAFT', 'CONFIRM');
        if (to === null) throw new Error('ORDER_MACHINE no longer allows CONFIRM from DRAFT.');

        const changed = await this.deps.repository.transition(
          scope,
          orderId,
          'DRAFT',
          to,
          { confirmedAt: now },
          now,
          tx,
        );

        const after = await this.deps.repository.findById(scope, orderId, tx);
        if (after === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
        }

        await this.recordConfirmation(scope, actor, tx, before, after, changed);

        /*
         * The event follows the ROW CHANGING, not the command succeeding.
         *
         * `changed` is false when another confirmation of the same draft committed
         * first — the conditional UPDATE matched nothing. Emitting anyway would put two
         * `OrderConfirmed` events on one order, and a consumer that charges once per
         * event would charge twice.
         */
        if (changed) {
          await this.deps.outbox.write(tx, actor, {
            eventType: 'OrderConfirmed',
            aggregateType: 'Order',
            aggregateId: after.id,
            payload: {
              customerId: after.customerId,
              productId: after.line.productId,
              totalMinor: after.totals.total.amountMinor.toString(),
              currency: after.totals.currency,
            },
          });
        }

        await rememberOnce(
          this.deps.idempotency,
          scope,
          ORDER_NAMESPACE,
          input.idempotencyKey,
          requestHash,
          { orderId: after.id },
          tx,
        );
        return after;
      },
    );
  }

  /**
   * The customer's OWN order, read for a surface that is about to offer a question.
   *
   * `OrderService.get` is the operator's read and checks `orders.view`, which a
   * customer-initiated turn does not hold — `SYSTEM_JOB_PERMISSIONS` is
   * `['maintenance.run']` and nothing else. Calling it from the bot would refuse every
   * customer with a permission error, which is a defect a surface test that only
   * asserted the BUTTON existed would not have caught.
   *
   * `PaymentService.pendingTransferForCustomer` is the same method one aggregate over
   * and states the rest of the reasoning: it returns only a row in the state the
   * question is about, so a surface cannot ask "are you sure?" about something whose
   * answer would be refused. Ownership is compared to the customer the surface
   * authenticated, so a guessed id answers exactly as one that does not exist.
   *
   * It writes nothing and takes no permission. The cancellation itself re-reads both
   * facts inside its own transaction; this is about not DRAWING a question.
   */
  async awaitingPaymentForCustomer(
    scope: TenantContext,
    customerId: UserId,
    id: string,
  ): Promise<OrderRecord | null> {
    const parsed = orderIdSchema.safeParse(id);
    if (!parsed.success) return null;
    const order = await this.deps.repository.findById(scope, parsed.data);
    if (order === null || order.customerId !== customerId) return null;
    return order.state === 'AWAITING_PAYMENT' ? order : null;
  }

  /**
   * A customer withdrawing an order they have not paid for.
   *
   * `ORDER_MACHINE`'s `CANCEL` edge, which 4G made WRITABLE — by adding `cancelledAt`
   * to the transition stamps — and left with no caller at all. `docs/phase4h-audit.md`
   * §3 is the measurement: two comments about the constraint, no producer, and
   * `bot.order.cancelled` a frozen sentence with nowhere to be sent from.
   *
   * ## AWAITING_PAYMENT only
   *
   * `ORDER_MACHINE` also allows CANCEL from `DRAFT`, and this does not take it. A draft
   * is a quote the customer has not answered; nothing is owed for it, no payment names
   * it, and no surface shows one after the summary. Adding the edge here would be a
   * second path with no caller, which is the defect this method exists to close.
   *
   * ## The payment goes with it
   *
   * Both in ONE transaction, and the ordering is the opposite of the expiry sweep's for
   * a reason: the sweep takes payments first because it is bounded and may stop between
   * the halves, and this touches exactly one order and cannot. What matters here is
   * that neither commits without the other.
   *
   * A cancellation that left a PENDING transfer alive would leave the customer holding
   * a reference for an order that no longer exists — the state `PaymentExpiryService`
   * names as the one a customer could act on, with their own money.
   *
   * ## Unless they said they already paid
   *
   * `ORDER_TRANSFER_UNDER_REVIEW`. The claim says money may be in flight, and there is
   * no version of cancelling that is safe once it is: the transfer arrives against a
   * reference belonging to a closed payment on a cancelled order, and the remedy
   * becomes a manual wallet credit. So the order stays live until an operator has
   * looked. The customer is told why, which is what stops them tapping again.
   *
   * Read INSIDE the transaction, so a claim that commits between the read and the
   * write cannot slip past it.
   *
   * ## What it does not do
   *
   * No refund and no service. An `AWAITING_PAYMENT` order has taken no money and
   * provisioned nothing — `ORDER_MACHINE` reaches `REFUNDED` only from `PAID` — so
   * there is nothing to reverse and nothing to tear down.
   */
  async cancelByCustomer(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly orderId: string;
    },
  ): Promise<OrderRecord> {
    const customerId = this.customerId(input.customerId);
    const orderId = this.orderId(input.orderId);
    const requestHash = hashRequest({ customerId, orderId, action: 'cancel' });

    /** Before the replay, for the reason `createDraft` states: a replay returns a row. */
    await this.authorize(scope, actor, {
      action: 'order.cancel',
      entityType: 'Order',
      entityId: orderId,
    });

    const replay = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replay !== null) return replay;

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      ORDER_PLACE_PERMISSION,
      { action: 'order.cancel', entityType: 'Order', entityId: orderId },
      async (tx) => {
        await this.assertScopeActive(scope, tx);

        const before = await this.deps.repository.findById(scope, orderId, tx);
        /* Another customer's order is UNKNOWN, not FORBIDDEN — `confirm` states why. */
        if (before === null || before.customerId !== customerId) {
          throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
        }

        /*
         * Already cancelled is the end state the caller asked for, and a second tap is
         * not an error. `confirm` answers a repeated confirmation the same way, and the
         * message carrying this button stays in the chat for ever.
         */
        if (before.state === 'CANCELLED') {
          await rememberOnce(
            this.deps.idempotency,
            scope,
            ORDER_NAMESPACE,
            input.idempotencyKey,
            requestHash,
            { orderId: before.id },
            tx,
          );
          return before;
        }
        if (before.state !== 'AWAITING_PAYMENT') {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
            'This order can no longer be cancelled.',
          );
        }

        if (await this.deps.payments.claimedPendingFor(scope, orderId, tx)) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.ORDER_TRANSFER_UNDER_REVIEW,
            'A transfer for this order is waiting to be reviewed.',
          );
        }

        /*
         * The target comes from the FROZEN machine, exactly as `confirm` takes its own.
         * A literal here would let the machine and this service disagree silently.
         */
        const to = nextState(ORDER_MACHINE, 'AWAITING_PAYMENT', 'CANCEL');
        if (to === null) {
          throw new Error('ORDER_MACHINE no longer allows CANCEL from AWAITING_PAYMENT.');
        }

        const withdrawn = await this.deps.payments.withdrawPendingFor(scope, orderId, now, tx);

        /*
         * The claim guard, asked AGAIN after the withdrawal — and this one is the check.
         *
         * The read above happens before any write, and READ COMMITTED lets a
         * `signalTransferSent` commit between the two: the guard says no claim, the
         * customer's claim lands, and `withdrawPendingFor` then cancels the payment they
         * were just told is recorded for review. The repository's UPDATE now refuses a
         * signalled row, so this re-ask is what turns "we left one behind" into a
         * refusal rather than a silent partial cancellation. Found by the Codex review
         * of PR #30.
         *
         * Throwing rolls the withdrawal back with it, which is the whole point: the
         * order stays open, the claim stands, and the customer is told a transfer is
         * waiting to be reviewed — the same answer the pre-write guard gives.
         */
        if (await this.deps.payments.claimedPendingFor(scope, orderId, tx)) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.ORDER_TRANSFER_UNDER_REVIEW,
            'A transfer for this order is waiting to be reviewed.',
          );
        }

        const changed = await this.deps.repository.transition(
          scope,
          orderId,
          'AWAITING_PAYMENT',
          to,
          /*
           * `cancelledAt` is written by the SAME statement as the state, because
           * `orders_cancelled_at_check` is `(state = 'CANCELLED') = (cancelled_at IS NOT
           * NULL)` — a transition that moved one without the other could not commit.
           */
          { cancelledAt: now },
          now,
          tx,
        );

        const after = await this.deps.repository.findById(scope, orderId, tx);
        /* istanbul ignore next -- read in the same transaction as the read above. */
        if (after === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
        }

        /*
         * A transition that moved NOTHING is not a cancellation, and must not be
         * reported as one.
         *
         * `changed` was computed and then used only as an audit field. If confirmation
         * or the expiry sweep moved the order between the `before` read and this
         * statement, the UPDATE matches no row — and the method went on to audit
         * SUCCESS, store the idempotency result, and return the now-`PAID` row, which
         * `BotRuntime.cancelOrder` renders as "your order was cancelled". A customer
         * whose payment had just settled would be told it was withdrawn. Found by the
         * Codex review of PR #30.
         *
         * `CANCELLED` is the one losing outcome that is still success: two taps, or a
         * replay racing itself, and the end state is the one the customer asked for.
         * Everything else is a conflict, and throwing rolls back the withdrawal above
         * so a settled order does not lose its payment rows on the way out.
         */
        if (!changed && after.state !== 'CANCELLED') {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
            'This order can no longer be cancelled.',
          );
        }

        /*
         * The slot goes back, in the transaction that ends the order.
         *
         * Unconditional, including on the second tap that found the order already
         * `CANCELLED`: the release is idempotent, and a first attempt that
         * cancelled the order but died before this line would otherwise leave the
         * hold standing until its deadline. A slot given back late is a panel that
         * refuses a sale it could have taken.
         *
         * Here and not in a handler on `OrderCancelled`, for the reason settlement
         * writes its service here: one transaction, one outcome. A handler would
         * make "a cancelled order holds no slot" depend on the handler having run.
         */
        await this.deps.panelSales.release(scope, orderId, tx);

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'order.cancel',
            entityType: 'Order',
            entityId: orderId,
            before: { state: before.state },
            after: {
              state: after.state,
              changed,
              /*
               * How many transfer instructions this closed, so the log distinguishes a
               * customer abandoning a quote from one abandoning a payment in progress.
               */
              paymentsWithdrawn: withdrawn.length,
            },
            result: 'SUCCESS',
          },
          tx,
        );

        await rememberOnce(
          this.deps.idempotency,
          scope,
          ORDER_NAMESPACE,
          input.idempotencyKey,
          requestHash,
          { orderId: after.id },
          tx,
        );
        return after;
      },
    );
  }

  private async recordConfirmation(
    scope: TenantContext,
    actor: ActorContext,
    tx: TransactionScope,
    before: OrderRecord,
    after: OrderRecord,
    changed: boolean,
  ): Promise<void> {
    await this.deps.audit.record(
      scope,
      actor,
      {
        action: 'order.confirm',
        entityType: 'Order',
        entityId: after.id,
        before: { state: before.state },
        after: { state: after.state, changed },
        result: 'SUCCESS',
      },
      tx,
    );
  }

  /**
   * The replayed result, or null.
   *
   * The order is re-read rather than reconstructed from the stored response: the stored
   * value is an id, and the row is the truth about its state. An idempotency row that
   * outlives its order — which a restore can produce — falls through to a fresh attempt
   * rather than reporting success for a row that is gone.
   */
  private async replay(
    scope: TenantContext,
    key: string,
    requestHash: string,
  ): Promise<OrderRecord | null> {
    const found = await this.deps.idempotency.find<{ orderId: string }>(
      scope,
      ORDER_NAMESPACE,
      key,
      requestHash,
    );
    if (found === null) return null;
    return this.deps.repository.findById(scope, found.result.orderId as OrderId);
  }

  /**
   * The three reasons a product cannot be ordered, each named.
   *
   * `unorderableReason` is the single TypeScript statement of the rule and this is its
   * only translation into refusals. They are three codes and not one because a customer
   * asking support "why can't I buy this" and an operator reading the log need to know
   * WHICH of withdrawn, unpriced or unbound it was — and only one of the three is
   * something the customer could have caused.
   */
  private assertOrderable(product: ProductRecord): {
    price: NonNullable<ProductRecord['price']>;
    panelId: NonNullable<ProductRecord['panelId']>;
  } {
    const reason = unorderableReason(product);
    if (reason === 'NOT_PURCHASABLE') {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PRODUCT_NOT_PURCHASABLE,
        'This product is not available for purchase.',
      );
    }
    if (reason === 'NOT_FOR_AUDIENCE') {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PRODUCT_NOT_FOR_AUDIENCE,
        'This product is not available for purchase.',
      );
    }
    if (reason === 'NOT_PRICED') {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PRODUCT_NOT_PRICED,
        'This product has no price and cannot be ordered.',
      );
    }
    if (reason === 'NOT_FULFILLABLE') {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PRODUCT_NOT_FULFILLABLE,
        'This product is not bound to a panel and cannot be ordered.',
      );
    }
    /*
     * Narrowed by the checks above, and re-asserted rather than assumed.
     *
     * `unorderableReason` returning null MEANS both are present, but TypeScript cannot
     * see that through a function boundary, and a cast here would be a place where a
     * change to that function stops being checked.
     */
    const { price, panelId } = product;
    if (price === null || panelId === null) {
      throw new Error('unorderableReason passed a product with no price or no panel.');
    }
    return { price, panelId };
  }

  /** A blocked customer places no orders. The block is an operator decision about them. */
  private async assertCustomerMayOrder(
    scope: TenantContext,
    customerId: UserId,
    tx: TransactionScope,
  ): Promise<void> {
    const customer = await this.deps.customers.findById(scope, customerId, tx);
    if (customer === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
    if (customer.status === 'BLOCKED') {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.CUSTOMER_BLOCKED,
        'This account cannot place orders.',
      );
    }
  }

  /**
   * Charges the place permission BEFORE the replay lookup, and audits a refusal.
   *
   * The check itself is what stops a replay answering an unauthorized caller with an
   * order. `recordMutationDenial` is what stops that fix from making a denial silent:
   * `runAuthorizedMutation` records one for a refusal inside the transaction, and an
   * early refusal never reaches it. One call per attempt, so one audit row either way —
   * the same division of labour `PanelService.authorize` uses.
   */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, ORDER_PLACE_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        ORDER_PLACE_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }

  /** The configured hold, read inside the transaction like every other scoped read. */
  private async expiryMinutes(scope: TenantContext, tx: TransactionScope): Promise<number> {
    return this.deps.settings.valueOf<number>(scope, 'sales.order_expiry_minutes', tx);
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

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
  }

  private orderId(candidate: string): OrderId {
    const parsed = orderIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid order identifier.',
      );
    }
    return parsed.data;
  }

  private productId(candidate: string): ProductId {
    const parsed = productIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid product identifier.',
      );
    }
    return parsed.data;
  }

  private customerId(candidate: string): UserId {
    const parsed = userIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid customer identifier.',
      );
    }
    return parsed.data;
  }
}

/**
 * What an audit row records about an order.
 *
 * The snapshot and the totals, as text for the `bigint` fields — an audit row is
 * `jsonb`. This is the evidence that answers "what was this customer quoted", which is
 * the question the legacy system cannot answer for any order it ever took.
 */
function auditView(order: OrderRecord): Record<string, unknown> {
  return {
    state: order.state,
    customerId: order.customerId,
    productId: order.line.productId,
    panelId: order.line.panelId,
    title: order.line.title,
    durationDays: order.line.specification.durationDays,
    trafficBytes: order.line.specification.trafficBytes.toString(),
    deviceLimit: order.line.specification.deviceLimit,
    unitPriceMinor: order.line.unitPrice.amountMinor.toString(),
    quantity: order.line.quantity,
    subtotalMinor: order.totals.subtotal.amountMinor.toString(),
    discountMinor: order.totals.discount.amountMinor.toString(),
    totalMinor: order.totals.total.amountMinor.toString(),
    currency: order.totals.currency,
    expiresAt: order.expiresAt === null ? null : order.expiresAt.toISOString(),
  };
}
