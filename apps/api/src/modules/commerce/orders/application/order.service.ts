import {
  orderPurposeCreatesNewService,
  canonicalizeCustomUsername,
  isValidCustomUsername,
  USERNAME_CAPTURE_TTL_MS,
  DISCOUNT_CODE_CAPTURE_TTL_MS,
  normaliseDiscountCode,
  COMMERCE_ERROR_CODES,
  MAX_ORDER_QUANTITY,
  ORDER_MACHINE,
  errors,
  nextState,
  orderIdSchema,
  userIdSchema,
  type ActorContext,
  type AuditWriter,
  type ServiceUsernameMode,
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
import type {
  OrderUsernameLane,
  UsernameChoice,
} from '../../provisioning/application/username-lane.js';
import type { UsernameReservation } from '../../provisioning/application/username-ports.js';
import type { ProductRecord, ProductRepository } from '../../catalog/application/ports.js';
import { unorderableReason } from '../../catalog/application/catalog-visibility.js';
import type { ResellerService } from '../../resellers/application/reseller.service.js';
import type {
  ProductCategoryRecord,
  ProductCategoryRepository,
} from '../../catalog/application/ports.js';
import { quoteLine, quoteProduct } from './order-pricing.js';
import type { PricingService } from '../../pricing/application/pricing.service.js';
import type { DiscountCodeCaptureRepository } from '../../pricing/application/ports.js';
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
  /**
   * Categories, read inside the transaction that decides whether a sale may happen.
   *
   * A separate port rather than a method on `products` because they are separate
   * aggregates: a category outlives the products in it, and "may this be sold" asks
   * about both independently.
   */
  readonly categories: ProductCategoryRepository;
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
  /**
   * What this order's service will be called, and who decides.
   *
   * A port into provisioning rather than a rule here, for the same reason
   * `panelSales` is one: the panel's policy, the template and the reservation index
   * are facts about the fleet and the provider, not about orders.
   */
  readonly usernames: OrderUsernameLane;
  /**
   * The pricing engine's door (WP8). A draft is priced through it, a code re-quotes a
   * draft through it, and confirmation redeems through it — so checkout cannot price
   * differently from the operator's preview.
   */
  readonly pricing: Pick<PricingService, 'price' | 'redeem'>;
  /** A buyer's reseller standing and entitlements (`docs/wp9-reseller-audit.md` R5, R6). */
  readonly resellers: Pick<ResellerService, 'standing' | 'assertEntitled'>;
  /** The window in which a plain message is a discount code (WP8 P11). */
  readonly discountCodes: DiscountCodeCaptureRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface OrderListQuery {
  readonly limit?: number;
  readonly cursor?: OrderCursor;
  readonly search: OrderSearch;
}

/**
 * How long a username hold lasts for an order that carries no deadline of its own.
 *
 * Every order this repository creates has an `expires_at`, so this is reached only by
 * a row written before that column did — and a hold with no end is a name nobody can
 * ever have again. One hour, because an unfunded hold costs a customer only a retry
 * while a leaked one costs the name for good.
 */
const USERNAME_HOLD_FALLBACK_MS = 60 * 60 * 1000;

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
        /*
         * The category is read INSIDE the transaction, like every other rule here.
         *
         * A surface may have filtered on it a moment ago; that is a courtesy. The
         * authoritative question is asked here, under the same transaction that will
         * write the order.
         */
        const category = await this.deps.categories.findById(scope, product.categoryId, tx);
        /*
         * A reseller's standing, then their tier's grants (`docs/wp9-reseller-audit.md` R5,
         * R6): an ACTIVE reseller may order a reseller-only product and may order nothing
         * their tier does not grant. Refused here, before a draft exists; confirmation
         * decides again.
         */
        const standing = await this.deps.resellers.standing(scope, customerId, tx);
        const { price, panelId } = this.assertOrderable(
          product,
          category,
          standing === null ? 'CUSTOMER' : 'RESELLER',
        );
        if (standing !== null) {
          await this.deps.resellers.assertEntitled(
            scope,
            standing,
            { operation: 'NEW_SERVICE', productId: product.id, panelId },
            tx,
          );
        }

        /*
         * The list price, then every automatic rule that applies (WP8 P6).
         *
         * No code: a customer enters one on the summary, and `applyDiscountCode` re-quotes
         * this draft from its own snapshot when they do.
         */
        const { totals } = await this.deps.pricing.price(
          scope,
          {
            base: quoteProduct(product, price, MAX_ORDER_QUANTITY, now),
            purpose: 'NEW_SERVICE',
            productId: product.id,
            categoryId: product.categoryId,
            customerId,
            now,
          },
          tx,
        );
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
              /*
               * Snapshotted HERE, beside the title and the price, and not at
               * confirmation.
               *
               * The rest of the line is fixed at draft creation because a draft is the
               * quote the customer was shown; the category belongs to that same picture.
               * Taken at confirmation instead, an order would record a category the
               * customer never saw whenever an operator renamed one in the minutes
               * between the two — which is the class of after-the-fact rewriting this
               * whole snapshot exists to prevent.
               *
               * `assertOrderable` has already refused a null category above, so this is
               * never null on a new order. The FIELD is nullable for the orders that
               * predate the column, which carry no record and must not be given one.
               */
              category: {
                categoryId: category!.id,
                name: category!.name,
                emoji: category!.emoji,
              },
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
  /**
   * The name the customer's service will carry, chosen before they agree to pay.
   *
   * Its own command and not part of `confirm`, because the customer has to SEE the
   * result before they agree to it: the summary they answer shows the canonical name,
   * and a name decided inside the confirmation is a name they first meet on an
   * invoice. A CUSTOM one is also refused and retried several times in a normal
   * conversation, and each of those refusals must cost nothing — no slot, no payment,
   * no state change on the order.
   *
   * DRAFT only. After `AWAITING_PAYMENT` the customer has agreed to a summary naming
   * this username, and letting it change afterwards would mean the thing they agreed
   * to and the thing they get are different. It is also the window in which a payment
   * can already be in flight.
   *
   * Idempotent twice over: by the request key, and under it by the
   * `(tenant_id, order_id)` index — so a Telegram callback redelivered after the
   * insert committed returns the held name rather than taking a second.
   */
  async chooseUsername(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly orderId: string;
      readonly choice: UsernameChoice;
    },
  ): Promise<UsernameReservation> {
    const customerId = this.customerId(input.customerId);
    const orderId = this.orderId(input.orderId);
    /*
     * The RAW input is in the hash, not the canonical form.
     *
     * Two requests under one key asking for `Ali_2026` and `ali_2026` are the same
     * ask and must replay; two asking for `ali_2026` and `ali_2027` are different and
     * must not. Hashing the raw text gets the second right and the first wrong — so
     * the value hashed is what `canonicalizeCustomUsername` would produce, which is
     * the identity the reservation is actually about.
     */
    const requestHash = hashRequest({
      customerId,
      orderId,
      mode: input.choice.mode,
      username:
        input.choice.raw === undefined || !isValidCustomUsername(input.choice.raw)
          ? null
          : canonicalizeCustomUsername(input.choice.raw),
    });

    /** Before the replay, for the reason `createDraft` states: a replay returns a row. */
    await this.authorize(scope, actor, {
      action: 'order.username.choose',
      entityType: 'Order',
      entityId: orderId,
    });

    const replayed = await this.replayUsername(scope, input.idempotencyKey, requestHash, orderId);
    if (replayed !== null) return replayed;

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      ORDER_PLACE_PERMISSION,
      { action: 'order.username.choose', entityType: 'Order', entityId: orderId },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.assertCustomerMayOrder(scope, customerId, tx);

        // ORDER first, then the panel the lane reads and the reservation it writes.
        // The canonical order of this domain, and the one a Codex review found broken
        // on this very path — see the comment in `confirm`.
        await this.deps.repository.lock(scope, orderId, tx);
        const order = await this.deps.repository.findById(scope, orderId, tx);
        // Another customer's order is UNKNOWN, not FORBIDDEN. See `confirm`.
        if (order === null || order.customerId !== customerId) {
          throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
        }
        this.assertNameable(order);

        const reservation = await this.reserveFor(scope, order, input.choice, tx);

        await rememberOnce(
          this.deps.idempotency,
          scope,
          ORDER_NAMESPACE,
          input.idempotencyKey,
          requestHash,
          { orderId },
          tx,
        );
        return reservation;
      },
    );
  }

  /**
   * One of THIS customer's own orders, for a surface that has just written to it.
   *
   * `get` above is the OPERATOR's read and charges `orders.view`, which a customer's
   * own turn does not hold and must not: `orders.view` is "may read the orders of this
   * installation". A customer turn holds `orders.place`, and what it may read is the
   * order it is placing — so that is what this charges and how it is scoped.
   *
   * It exists because the Telegram username step used `get`, and the effect was
   * invisible in exactly the way this codebase keeps finding: the name was reserved,
   * the transaction committed, the permission check on the read that followed threw,
   * and the customer was shown NOTHING — no summary, no refusal, not even a spinner
   * stopping. The reservation was real and the screen was blank.
   *
   * Another customer's order is UNKNOWN rather than FORBIDDEN, for the reason `confirm`
   * gives: a distinguishable refusal is an oracle for which order ids exist.
   */
  async orderForCustomer(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly customerId: string; readonly orderId: string },
  ): Promise<OrderRecord> {
    const customerId = this.customerId(input.customerId);
    const orderId = this.orderId(input.orderId);
    await this.deps.guard.check(scope, actor, ORDER_PLACE_PERMISSION);
    const order = await this.deps.repository.findById(scope, orderId);
    if (order === null || order.customerId !== customerId) {
      throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
    }
    return order;
  }

  /**
   * What this order's username step looks like right now.
   *
   * A READ, and the one the Telegram flow asks before drawing anything: which modes the
   * order's panel offers, and whether a name is already held. Both come from the same
   * place the write path uses, so a surface cannot draw a button for a mode the
   * allocator would refuse — and the allocator re-checks anyway, because a button drawn
   * a minute ago is not authorisation.
   */
  async usernameStep(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly customerId: string; readonly orderId: string },
  ): Promise<{
    readonly modes: readonly ServiceUsernameMode[];
    readonly reservation: UsernameReservation | null;
  }> {
    const customerId = this.customerId(input.customerId);
    const orderId = this.orderId(input.orderId);
    await this.deps.guard.check(scope, actor, ORDER_PLACE_PERMISSION);

    const order = await this.deps.repository.findById(scope, orderId);
    // Another customer's order is UNKNOWN, not FORBIDDEN. See `confirm`.
    if (order === null || order.customerId !== customerId) {
      throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
    }
    /*
     * A commercial order has no step at all, and says so with an empty list rather than
     * a refusal. The surface is asking what to draw, and "nothing" is a legitimate
     * answer — `RENEW` acts on a service that already has a name.
     */
    if (!orderPurposeCreatesNewService(order.purpose)) {
      return { modes: [], reservation: null };
    }
    return {
      modes: await this.deps.usernames.modesFor(scope, order.line.panelId),
      reservation: await this.deps.usernames.held(scope, orderId),
    };
  }

  /**
   * Open the window in which this customer's next plain message is a username.
   *
   * The window is a ROW and not conversation state held in a process, which is the
   * distinction `BOT_INTENTS` is written around: the legacy system's prompt capture
   * outlived its question and swallowed an ordinary message into a production gateway
   * setting (INCIDENT-FIN-001). What bounds this one is not its deadline but its
   * REACH — the row names one order, and the only thing an open window can do with
   * whatever arrives is offer it to the allocator for that order.
   *
   * Idempotent under a redelivered tap: the advisory lock serialises the customer's
   * window work, and `openWindow` closes whatever was open before inserting, in ONE
   * transaction, because the partial unique index refuses two open rows and a split
   * would leave the customer with no window at all.
   */
  async beginUsernameEntry(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: string;
      readonly customerId: string;
      readonly orderId: string;
    },
  ): Promise<{ readonly expiresAt: Date }> {
    const customerId = this.customerId(input.customerId);
    const orderId = this.orderId(input.orderId);
    const requestHash = hashRequest({ customerId, orderId, bot: input.botInstanceId });

    await this.authorize(scope, actor, {
      action: 'order.username.entry',
      entityType: 'Order',
      entityId: orderId,
    });

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      ORDER_PLACE_PERMISSION,
      { action: 'order.username.entry', entityType: 'Order', entityId: orderId },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.assertCustomerMayOrder(scope, customerId, tx);
        await this.deps.usernames.lockWindow(scope, input.botInstanceId, customerId, tx);

        const order = await this.deps.repository.findById(scope, orderId, tx);
        // Another customer's order is UNKNOWN, not FORBIDDEN. See `confirm`.
        if (order === null || order.customerId !== customerId) {
          throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
        }
        this.assertNameable(order);
        // One window per customer and bot across BOTH kinds (WP8 P11): a plain message is
        // offered to one question, never to two.
        await this.supersedeDiscountCodeWindow(scope, input.botInstanceId, customerId, tx);
        /*
         * The PANEL's modes, not the ones the button was drawn from.
         *
         * `allocate` already refuses a CUSTOM it does not offer — but it refuses at
         * SUBMISSION, one typed message later, and the refusal aborts the transaction
         * that would have closed the window. So a tap carrying CUSTOM after an
         * operator made the panel automatic-only told the customer to type a name,
         * refused every name they typed, and left the window intercepting their
         * ordinary messages for the rest of its ten minutes. Found by Codex.
         *
         * The same refusal as the allocator's, deliberately: one wrong answer, given
         * before the window exists rather than after. Nothing is opened, because this
         * throws and the transaction carries the window's insert.
         */
        if (
          !(await this.deps.usernames.modesFor(scope, order.line.panelId, tx)).includes('CUSTOM')
        ) {
          throw errors.preconditionFailed(
            COMMERCE_ERROR_CODES.SERVICE_USERNAME_MODE_UNAVAILABLE,
            'That way of choosing a username is not available for this plan.',
          );
        }

        const now = this.deps.clock.now();
        const window = await this.deps.usernames.openWindow(
          scope,
          {
            botInstanceId: input.botInstanceId,
            customerId,
            orderId,
            openedAt: now,
            expiresAt: new Date(now.getTime() + USERNAME_CAPTURE_TTL_MS),
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          ORDER_NAMESPACE,
          input.idempotencyKey,
          requestHash,
          { orderId },
          tx,
        );
        return { expiresAt: window.expiresAt };
      },
    );
  }

  /**
   * Take a plain message as a username, IF a window says it is one.
   *
   * `NO_WINDOW` is a first-class outcome rather than an error, because the caller is a
   * surface deciding what an ordinary message meant: every message that is not a
   * command arrives here, and the answer for almost all of them is "that was not a
   * username". Making the normal case an exception would turn the fallback path into a
   * `catch`, and a `catch` around a command is how a real refusal gets swallowed.
   *
   * The window is closed only for an ACCEPTED name. A refusal leaves it open on
   * purpose — the customer is being asked to type another, and closing it would strand
   * them behind a button they have already used.
   */
  async submitTypedUsername(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: string;
      readonly customerId: string;
      readonly text: string;
    },
  ): Promise<
    | { readonly outcome: 'NO_WINDOW' }
    | { readonly outcome: 'RESERVED'; readonly reservation: UsernameReservation }
  > {
    const customerId = this.customerId(input.customerId);

    await this.authorize(scope, actor, {
      action: 'order.username.submit',
      entityType: 'Order',
      entityId: null,
    });

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      ORDER_PLACE_PERMISSION,
      { action: 'order.username.submit', entityType: 'Order', entityId: null },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.assertCustomerMayOrder(scope, customerId, tx);
        await this.deps.usernames.lockWindow(scope, input.botInstanceId, customerId, tx);

        const window = await this.deps.usernames.openWindowFor(
          scope,
          input.botInstanceId,
          customerId,
          tx,
        );
        if (window === null) return { outcome: 'NO_WINDOW' } as const;

        const now = this.deps.clock.now();
        if (now.getTime() >= window.expiresAt.getTime()) {
          /*
           * Closed as it is found, and reported as NO WINDOW.
           *
           * The customer gets the ordinary unsupported-input answer rather than "your
           * username window expired", because by then they may well have been typing
           * something else entirely — which is the case the deadline exists for.
           */
          await this.deps.usernames.closeWindow(scope, window.id, 'EXPIRED', now, tx);
          return { outcome: 'NO_WINDOW' } as const;
        }

        const orderId = this.orderId(window.orderId);
        await this.deps.repository.lock(scope, orderId, tx);
        const order = await this.deps.repository.findById(scope, orderId, tx);
        if (order === null || order.customerId !== customerId) {
          throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
        }
        this.assertNameable(order);

        // Throws on an invalid or taken name, which rolls this transaction back and so
        // leaves the window open — the customer is asked to type another.
        const reservation = await this.reserveFor(
          scope,
          order,
          { mode: 'CUSTOM', raw: input.text },
          tx,
        );
        await this.deps.usernames.closeWindow(scope, window.id, 'RECEIVED', now, tx);
        await rememberOnce(
          this.deps.idempotency,
          scope,
          ORDER_NAMESPACE,
          input.idempotencyKey,
          hashRequest({ customerId, orderId, username: reservation.username }),
          { orderId },
          tx,
        );
        return { outcome: 'RESERVED', reservation } as const;
      },
    );
  }

  /**
   * Enter or remove a discount code on a DRAFT (WP8 P6).
   *
   * `code: null` removes it. Either way the draft is RE-QUOTED FROM ITS OWN SNAPSHOT —
   * the unit price and quantity the customer was shown — with every automatic rule as it
   * stands now and the code, if any. Never from today's product: a price change between
   * the draft and the code must not reach the customer through the back door.
   *
   * A code that will not apply is refused with `DISCOUNT_CODE_REJECTED` and the draft
   * keeps the quote it had. One code for every reason; the reason is in the details.
   * New purchases only (P7): a commercial order's evidence row is written with its draft
   * and cannot follow a code entered afterwards.
   */
  async applyDiscountCode(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly orderId: string;
      readonly code: string | null;
    },
  ): Promise<OrderRecord> {
    const customerId = this.customerId(input.customerId);
    const orderId = this.orderId(input.orderId);
    const code = input.code === null ? null : normaliseDiscountCode(input.code);
    const requestHash = hashRequest({ customerId, orderId, code });
    const denial = { action: 'order.discount_code', entityType: 'Order', entityId: orderId };

    await this.authorize(scope, actor, denial);
    const replay = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replay !== null) return replay;

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      ORDER_PLACE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.assertCustomerMayOrder(scope, customerId, tx);
        const after = await this.repriceWithCode(scope, actor, customerId, orderId, code, tx);
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
   * Open the window in which this customer's next plain message is a discount code
   * (WP8 P11). `beginUsernameEntry`'s shape, under the SAME window lock, and closing any
   * open username window for this customer and bot: a plain message answers one
   * question, never two.
   */
  async beginDiscountCodeEntry(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: string;
      readonly customerId: string;
      readonly orderId: string;
    },
  ): Promise<{ readonly expiresAt: Date }> {
    const customerId = this.customerId(input.customerId);
    const orderId = this.orderId(input.orderId);
    const requestHash = hashRequest({ customerId, orderId, bot: input.botInstanceId, code: true });
    const denial = { action: 'order.discount_code.entry', entityType: 'Order', entityId: orderId };

    await this.authorize(scope, actor, denial);

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      ORDER_PLACE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.assertCustomerMayOrder(scope, customerId, tx);
        await this.deps.usernames.lockWindow(scope, input.botInstanceId, customerId, tx);

        const order = await this.deps.repository.findById(scope, orderId, tx);
        if (order === null || order.customerId !== customerId) {
          throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
        }
        this.assertCodeable(order);

        const now = this.deps.clock.now();
        const usernameWindow = await this.deps.usernames.openWindowFor(
          scope,
          input.botInstanceId,
          customerId,
          tx,
        );
        if (usernameWindow !== null) {
          await this.deps.usernames.closeWindow(scope, usernameWindow.id, 'SUPERSEDED', now, tx);
        }
        const window = await this.deps.discountCodes.open(
          scope,
          {
            id: this.deps.ids.uuid(),
            botInstanceId: input.botInstanceId,
            customerId,
            orderId,
            openedAt: now,
            expiresAt: new Date(now.getTime() + DISCOUNT_CODE_CAPTURE_TTL_MS),
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          ORDER_NAMESPACE,
          input.idempotencyKey,
          requestHash,
          { orderId },
          tx,
        );
        return { expiresAt: window.expiresAt };
      },
    );
  }

  /**
   * Take a plain message as a discount code, IF a window says it is one (WP8 P11).
   *
   * `submitTypedUsername`'s contract: `NO_WINDOW` is an outcome, not an error, and the
   * window closes only for an ACCEPTED code — a refusal rolls this transaction back and
   * leaves it open, so the customer can type another.
   */
  async submitTypedDiscountCode(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: string;
      readonly customerId: string;
      readonly text: string;
    },
  ): Promise<
    { readonly outcome: 'NO_WINDOW' } | { readonly outcome: 'APPLIED'; readonly order: OrderRecord }
  > {
    const customerId = this.customerId(input.customerId);
    const denial = { action: 'order.discount_code.submit', entityType: 'Order', entityId: null };

    await this.authorize(scope, actor, denial);

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      ORDER_PLACE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.assertCustomerMayOrder(scope, customerId, tx);
        await this.deps.usernames.lockWindow(scope, input.botInstanceId, customerId, tx);

        const window = await this.deps.discountCodes.findOpen(
          scope,
          input.botInstanceId,
          customerId,
          tx,
        );
        if (window === null) return { outcome: 'NO_WINDOW' } as const;

        const now = this.deps.clock.now();
        if (now.getTime() >= window.expiresAt.getTime()) {
          // Closed as it is found and reported as NO WINDOW, for the reason
          // `submitTypedUsername` gives: by now they may be typing something else.
          await this.deps.discountCodes.close(scope, window.id, 'EXPIRED', now, tx);
          return { outcome: 'NO_WINDOW' } as const;
        }

        const orderId = this.orderId(window.orderId);
        // A window outlives its draft when the draft moves on without it — confirmed from
        // the summary still on screen, cancelled, or held too long. Closed here and
        // COMMITTED as NO WINDOW: the refusal `repriceWithCode` would throw rolls back, so
        // the window would stay open and catch every plain message until its own expiry.
        await this.deps.repository.lock(scope, orderId, tx);
        const draft = await this.deps.repository.findById(scope, orderId, tx);
        const heldTooLong =
          draft !== null && draft.expiresAt !== null && now.getTime() >= draft.expiresAt.getTime();
        if (draft === null || draft.state !== 'DRAFT' || heldTooLong) {
          await this.deps.discountCodes.close(
            scope,
            window.id,
            heldTooLong ? 'EXPIRED' : 'SUPERSEDED',
            now,
            tx,
          );
          return { outcome: 'NO_WINDOW' } as const;
        }

        const code = normaliseDiscountCode(input.text);
        const order = await this.repriceWithCode(scope, actor, customerId, orderId, code, tx);
        await this.deps.discountCodes.close(scope, window.id, 'RECEIVED', now, tx);
        await rememberOnce(
          this.deps.idempotency,
          scope,
          ORDER_NAMESPACE,
          input.idempotencyKey,
          hashRequest({ customerId, orderId, code }),
          { orderId },
          tx,
        );
        return { outcome: 'APPLIED', order } as const;
      },
    );
  }

  /** Closes this customer's open discount-code window on this bot, if one is open. */
  private async supersedeDiscountCodeWindow(
    scope: TenantContext,
    botInstanceId: string,
    customerId: UserId,
    tx: TransactionScope,
  ): Promise<void> {
    const open = await this.deps.discountCodes.findOpen(scope, botInstanceId, customerId, tx);
    if (open !== null) {
      await this.deps.discountCodes.close(scope, open.id, 'SUPERSEDED', this.deps.clock.now(), tx);
    }
  }

  /**
   * The re-quote both code commands share, under the order's lock.
   *
   * Refuses a code that will not apply with ONE error whatever the reason, and records
   * the change it did make with before and after totals.
   */
  private async repriceWithCode(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    orderId: OrderId,
    code: string | null,
    tx: TransactionScope,
  ): Promise<OrderRecord> {
    await this.deps.repository.lock(scope, orderId, tx);
    const before = await this.deps.repository.findById(scope, orderId, tx);
    if (before === null || before.customerId !== customerId) {
      throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
    }
    this.assertCodeable(before);
    const now = this.deps.clock.now();
    if (before.expiresAt !== null && now.getTime() >= before.expiresAt.getTime()) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.ORDER_EXPIRED,
        'This order was held for too long and must be started again.',
      );
    }

    const priced = await this.deps.pricing.price(
      scope,
      {
        base: quoteLine(before.line.productId, before.line.unitPrice, before.line.quantity, now),
        purpose: 'NEW_SERVICE',
        productId: before.line.productId,
        categoryId: before.line.category?.categoryId ?? null,
        customerId,
        ...(code === null ? {} : { code }),
        now,
        orderId,
      },
      tx,
    );
    if (priced.code !== null && !priced.code.accepted) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.DISCOUNT_CODE_REJECTED,
        'That discount code cannot be used.',
        { reason: priced.code.reason },
      );
    }

    const changed = await this.deps.repository.reprice(
      scope,
      orderId,
      { totals: priced.totals, discountCode: code },
      now,
      tx,
    );
    if (!changed) {
      // The order moved on while this waited for its lock.
      throw errors.conflict(
        COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
        'This order can no longer be changed.',
      );
    }
    const after = await this.deps.repository.findById(scope, orderId, tx);
    if (after === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
    }
    await this.deps.audit.record(
      scope,
      actor,
      {
        action: 'order.discount_code',
        entityType: 'Order',
        entityId: orderId,
        before: {
          discountCode: before.discountCode,
          discountMinor: before.totals.discount.amountMinor.toString(),
          totalMinor: before.totals.total.amountMinor.toString(),
        },
        after: {
          discountCode: after.discountCode,
          discountMinor: after.totals.discount.amountMinor.toString(),
          totalMinor: after.totals.total.amountMinor.toString(),
        },
        result: 'SUCCESS',
      },
      tx,
    );
    return after;
  }

  /** A code is entered on a DRAFT new purchase and nowhere else (P7). */
  private assertCodeable(order: OrderRecord): void {
    if (order.state !== 'DRAFT') {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
        'The discount on this order can no longer be changed.',
      );
    }
    if (order.purpose !== 'NEW_SERVICE') {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.DISCOUNT_CODE_REJECTED,
        'That discount code cannot be used.',
        { reason: 'PURPOSE' },
      );
    }
  }

  /**
   * The two conditions an order must meet before it may be given a name.
   *
   * Shared by all three entry points so they cannot drift. DRAFT, because after
   * `AWAITING_PAYMENT` the customer has agreed to a summary naming this username and a
   * payment may already be in flight. And a purpose that creates a service, because
   * `RENEW`, `ADD_TRAFFIC` and `ADD_TIME` act on an account that already has a name —
   * reserving a second would hold a name nothing will ever use while telling the
   * customer their service is about to be renamed.
   */
  private assertNameable(order: OrderRecord): void {
    if (order.state !== 'DRAFT') {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
        'The username for this order can no longer be changed.',
      );
    }
    if (!orderPurposeCreatesNewService(order.purpose)) {
      throw errors.preconditionFailed(
        COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
        'This order does not create a new service.',
      );
    }
  }

  /** The reservation itself, with the hold bounded by the order's own deadline. */
  private async reserveFor(
    scope: TenantContext,
    order: OrderRecord,
    choice: UsernameChoice,
    tx: TransactionScope,
  ): Promise<UsernameReservation> {
    return this.deps.usernames.choose(
      scope,
      {
        orderId: order.id,
        customerId: this.customerId(order.customerId),
        panelId: order.line.panelId,
        expiresAt:
          order.expiresAt ?? new Date(this.deps.clock.now().getTime() + USERNAME_HOLD_FALLBACK_MS),
      },
      choice,
      tx,
    );
  }

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
        /*
         * Re-read and re-checked, not carried from the draft.
         *
         * The owner's requirement is explicit that the authoritative confirmation
         * transaction re-checks the category rule, and the window it closes is real: an
         * operator can deactivate a category between the summary a customer is looking
         * at and the tap that answers it. This is the same discipline `PanelSalesGate`
         * already applies to the panel three lines below.
         *
         * Under a SHARE lock, and that is what makes the re-check a guarantee rather than
         * a narrower window. A plain read returned ACTIVE and a deactivation could commit
         * before this transaction moved the order on — confirming a sale the operator had
         * already withdrawn. Deactivation is an UPDATE, which waits for this lock, so the
         * two now serialise: either the deactivation lands first and is read here, or it
         * waits for this confirmation to finish. Found by the Codex review of this branch.
         */
        const category =
          product.categoryId === null
            ? null
            : await this.deps.categories.findForShare(scope, product.categoryId, tx);
        // The audience, as the draft asked it (R5). The grants themselves are decided
        // again, authoritatively, by `pricing.redeem` below — for every order path.
        const standing = await this.deps.resellers.standing(scope, customerId, tx);
        this.assertOrderable(product, category, standing === null ? 'CUSTOMER' : 'RESELLER');

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
        /*
         * The ORDER's lock FIRST, before the panel and the reservation below.
         *
         * `order → panel → reservation` is the canonical order of this domain, and
         * this is one of the two places that used to take it last. Cancellation and
         * the expiry sweep take the order first and the reservation second; a path
         * that took them the other way round closed a cycle, and PostgreSQL answered
         * a customer's confirmation with `40P01` instead of an outcome. Found by the
         * Codex review of this branch and reproduced in
         * `tests/integration/lock-order.test.ts`.
         *
         * It authorizes nothing and decides nothing: the conditional UPDATE naming
         * its `from` state is still what makes the transition exclusive. All this
         * does is take a lock the transaction was going to take anyway, earlier.
         */
        await this.deps.repository.lock(scope, orderId, tx);

        /*
         * A slot is taken ONLY by an order that creates a service.
         *
         * `acquire` used to run for every purpose, and Codex found what that cost:
         * a `RENEW`, `ADD_TRAFFIC` or `ADD_TIME` order took a capacity reservation
         * that nothing ever consumed — commercial settlement creates no service and
         * so never calls `consume` — so the hold sat there until the order's deadline,
         * understating the panel's free capacity. Worse in the other direction: a
         * customer whose panel was AT its cap could not renew the service they
         * already had, because `decideEligibility` counts capacity and answered
         * `AT_CAPACITY` for a purchase that needed no new slot at all.
         *
         * `orderPurposeCreatesNewService` is a positively-named exhaustive predicate
         * for exactly this reason: the rule it replaced was a negation that read the
         * other way round, and this line is one of the three places that misread it.
         *
         * ## What a commercial order is still subject to
         *
         * Everything that genuinely applies, and none of it is capacity.
         * `CommercialActionService` asks `panels.operability` for the action's kind
         * before it writes the order at all, and settlement asks the same question
         * again — with the service's own lifecycle state and any outstanding action —
         * inside the transaction that takes the money. Eligibility was never the
         * right question here: `PanelSalesGate`'s own docblock says `decideEligibility`
         * asks whether we may take money for a NEW account, and a renewal is not one.
         */
        if (orderPurposeCreatesNewService(before.purpose)) {
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
           * And the NAME, in the same transaction and under the same panel lock.
           *
           * After the slot rather than before it, because a name held for an order
           * that cannot have a slot is a name nobody can use until the order lapses,
           * and the slot is the scarcer of the two. Both are released by the same
           * cancellation and the same sweep.
           *
           * `require` normally finds the reservation the customer already made — the
           * username step runs before this, so they saw the name in the summary they
           * are answering. It allocates a RANDOM one only for an order whose step
           * predates this feature; on a CUSTOM-only panel it refuses, because there
           * the operator has said the customer chooses.
           *
           * Only for an order that creates a service, exactly like the slot above: a
           * RENEW names no new account, and reserving one for it would hold a name
           * against a service that already has a different one.
           */
          await this.deps.usernames.require(
            scope,
            {
              orderId,
              customerId,
              panelId: before.line.panelId,
              expiresAt: before.expiresAt ?? new Date(now.getTime() + USERNAME_HOLD_FALLBACK_MS),
            },
            tx,
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
        /*
         * What the quote spent, redeemed under the rules' own locks (WP8 P6).
         *
         * After the slot and the name and before the transition, so a discount that no
         * longer holds refuses the confirmation and this transaction takes neither with
         * it. The quote is never re-priced here: a customer is refused and starts again
         * rather than being charged a number they did not see.
         */
        await this.deps.pricing.redeem(scope, actor, before, now, tx);

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

        /*
         * And the NAME, beside the slot, for all the same reasons.
         *
         * Unconditional and idempotent in the same way — but `releaseUnfunded`, never
         * `release`: a cancellation racing a settlement must not free a name money has
         * been taken for, and the `funded_at IS NULL` predicate is what decides that
         * inside the DELETE rather than in a read before it.
         *
         * Omitting this was a real leak rather than an untidiness. The unique index on
         * `(namespace_key, username)` does not read `expires_at`, so a cancelled
         * order's hold went on refusing its name to every later customer — and on a
         * panel where customers type their own names, the name they wanted.
         */
        await this.deps.usernames.releaseUnfunded(scope, orderId, tx);

        /*
         * The audit row belongs to the transaction that PERFORMED the cancellation,
         * and to no other.
         *
         * `changed` was already computed and was already written into the row as a
         * field; what it was not doing was deciding whether to write the row at all.
         * Two customers cannot race here, but one customer tapping twice can: the
         * Telegram key is per-UPDATE (`telegramUpdateKey(botInstance.id, updateId)`),
         * so two fast taps are two update ids and two DIFFERENT idempotency keys that
         * the replay guard above cannot collapse. Both then reach this far, and the
         * loser wrote a second `order.cancel` SUCCESS row for a transition it did not
         * perform.
         *
         * Falling through is still right for the ANSWER — the customer asked for a
         * cancelled order and has one, which is why the guard above admits
         * `CANCELLED` — so this narrows what the loser CLAIMS rather than what it
         * returns.
         *
         * The asymmetry that made this a defect rather than a policy is now closed:
         * a request arriving after the cancellation commits takes the early return at
         * the top and writes no audit row either. Same customer, same intent, same end
         * state, and now the same number of rows whichever way the interleaving falls
         * — which is the only way the log can answer who cancelled this order and
         * when.
         *
         * Everything below stays unconditional on purpose. `rememberOnce` records
         * THIS key's answer, and both releases are idempotent DELETEs that must run
         * even for a loser, because a winner that cancelled and died before releasing
         * would otherwise leave the hold standing until its deadline.
         */
        if (changed) {
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
   * The name a completed `chooseUsername` already took, or null.
   *
   * The username command had no replay lookup at all, and the shape of that omission
   * is the one this file has now met three times: `rememberOnce` is a conditional
   * INSERT, so the SECOND arrival under a key finds the row already there, gets
   * `false`, and throws `IDEMPOTENCY_IN_FLIGHT`. That answer is right for a
   * double-tap — two requests raced and the loser must roll back — and wrong for the
   * ordinary case it also caught: a customer whose reply timed out, retrying with the
   * same key, was told their request conflicted with itself instead of being handed
   * the name they had already reserved. Found by Codex.
   *
   * The reservation is re-read rather than reconstructed from the stored response, for
   * the reason `replay` gives: the stored value is an order id and the ROW is the
   * truth. So a name released since — cancelled, swept, or cleared as a stale draft —
   * falls through to a fresh attempt rather than replaying a hold that is gone.
   *
   * `find` compares the request hash, so a different ask under the same key is a
   * payload mismatch and not a replay. The hash carries the customer, which is what
   * stops one customer replaying another's key.
   */
  private async replayUsername(
    scope: TenantContext,
    key: string,
    requestHash: string,
    orderId: OrderId,
  ): Promise<UsernameReservation | null> {
    const found = await this.deps.idempotency.find<{ orderId: string }>(
      scope,
      ORDER_NAMESPACE,
      key,
      requestHash,
    );
    if (found === null || found.result.orderId !== orderId) return null;
    return this.deps.usernames.held(scope, orderId);
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
  private assertOrderable(
    product: ProductRecord,
    category: ProductCategoryRecord | null,
    audience: 'CUSTOMER' | 'RESELLER',
  ): {
    price: NonNullable<ProductRecord['price']>;
    panelId: NonNullable<ProductRecord['panelId']>;
  } {
    const reason = unorderableReason(product, category, audience);
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
     * The two category refusals, and note which one is NOT here.
     *
     * A HIDDEN category does not appear: hidden means unlisted, and its products remain
     * orderable through a direct reference, exactly as a HIDDEN product's do. Only the
     * category's STATUS is a refusal — `unorderableReason` consults
     * `isCategoryPurchasable` for that reason and a reader who adds the visibility term
     * turns every operator's "unlist this group" into "withdraw this group".
     */
    if (reason === 'NOT_CATEGORISED') {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PRODUCT_NOT_CATEGORISED,
        'This product is not filed under a category and cannot be ordered.',
      );
    }
    if (reason === 'CATEGORY_NOT_PURCHASABLE') {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.CATEGORY_NOT_PURCHASABLE,
        'This category is not available for purchase.',
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
