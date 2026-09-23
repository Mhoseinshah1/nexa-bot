import {
  COMMERCE_ERROR_CODES,
  MAX_ORDER_QUANTITY,
  ORDER_MACHINE,
  errors,
  COMMERCIAL_ORDER_PURPOSES,
  isAddonPurchasable,
  isNexaError,
  isPurchasable,
  nextState,
  serviceAddonIdSchema,
  serviceIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type Money,
  type OperationType,
  type OrderId,
  type OrderPurpose,
  type PermissionKey,
  type SalesCurrencyCode,
  type ServiceAddonId,
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
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { OperationalEventRecorder } from '@nexa/contracts';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ProductRecord, ProductRepository } from '../../catalog/application/ports.js';
import type {
  ServiceAddonRecord,
  ServiceAddonRepository,
} from '../../catalog/application/addon-ports.js';
import type {
  OrderRecord,
  OrderRepository,
  OrderTotalsRecord,
} from '../../orders/application/ports.js';
import { quoteAddon, quoteProduct } from '../../orders/application/order-pricing.js';
import type { PricingService } from '../../pricing/application/pricing.service.js';
import type { ServiceRecord, ServiceRepository } from '../../provisioning/application/ports.js';
import { OPERATION_LEGAL_FROM } from '../../provisioning/application/provision-executor.js';
import type { CommercialActionRecord, CommercialActionRepository } from './ports.js';

/**
 * What a customer-triggered commercial command acts under.
 *
 * `maintenance.run`, exactly as ordering does. A customer is not an admin and holds no
 * permissions of their own; this is system work triggered by a customer, `SYSTEM_JOB`
 * holds that one key, and the check is still MADE, because `docs/conventions.md`
 * forbids exempting an actor type from the guard.
 */
export const COMMERCIAL_ACTION_PERMISSION: PermissionKey = 'maintenance.run';

/** The customer namespace, shared with ordering so one key means one command. */
const COMMERCIAL_NAMESPACE = 'TELEGRAM' as const;

/** How many add-ons of one kind a customer is offered at once. */
export const ADDON_OFFER_LIMIT = 10;

/**
 * The refusals that mean "not offerable", as opposed to "this installation is broken".
 *
 * Exactly the codes `renewableProduct` and `assertSalesCurrency` raise. Anything else
 * — a dead repository, an unreadable settings row, a bug — is an OUTAGE, and an outage
 * that renders as a missing button is an outage nobody is told about. `availableFor`
 * used to catch everything, which made those two indistinguishable on a 200.
 */
const OFFER_REFUSALS: readonly string[] = [
  COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
  COMMERCE_ERROR_CODES.PRODUCT_CURRENCY_UNSUPPORTED,
];

function isOfferRefusal(error: unknown): boolean {
  return isNexaError(error) && OFFER_REFUSALS.includes(error.code);
}

export type CommercialKind = Exclude<OrderPurpose, 'NEW_SERVICE' | 'TRIAL'>;

/**
 * What a customer may buy for one service, right now, server-derived.
 *
 * Never a price a client sent, and never a price computed from a callback: the service
 * is read by id from the row the customer owns, the product or add-on is read from the
 * catalogue, and the amount comes out of `quoteProduct` with its mandatory trace.
 */
export interface CommercialOffer {
  readonly kind: CommercialKind;
  /** The renewal's product, when this is a renewal. */
  readonly product: ProductRecord | null;
  /** The quantities on offer, when this is a quantity purchase. */
  readonly addons: readonly ServiceAddonRecord[];
}

export interface CommercialActionServiceDeps {
  readonly services: ServiceRepository;
  readonly products: ProductRepository;
  readonly addons: ServiceAddonRepository;
  readonly orders: OrderRepository;
  readonly actions: CommercialActionRepository;
  /** Asks whether THIS service's panel can perform the operation. Never a projection. */
  readonly panels: {
    operability(
      scope: TenantContext,
      panelId: string,
      type: OperationType,
      tx?: unknown,
    ): Promise<{ readonly ok: boolean; readonly reason?: string }>;
  };
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly outbox: OutboxWriter;
  readonly settings: SettingsResolver;
  /**
   * The pricing engine's door (WP8 P7): automatic rules and the cashback promise apply
   * to renewals and add-ons at draft time, and confirmation redeems them. Codes do not
   * reach this service — the commercial evidence row is written with the draft.
   */
  readonly pricing: Pick<PricingService, 'price' | 'redeem'>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * Buying something for a service that already exists.
 *
 * ## What this owns, and what it deliberately does not
 *
 * It owns eligibility, the server-derived quote, and the ORDER that carries it — and
 * nothing after that. Payment is `PaymentService`, unchanged: a commercial order is an
 * ordinary `AWAITING_PAYMENT` order, so wallet settlement and manual transfer work on
 * it without knowing it is one. Creating a second payment path for renewals is the
 * thing this phase most had to avoid.
 *
 * It is a separate service from `OrderService` rather than a branch inside it, and the
 * reason is `confirm`. An order's confirmation re-checks that what it is selling is
 * still sellable, and for a quantity purchase the thing being sold is the ADD-ON, not
 * the product the order names for navigation. Branching inside `OrderService` would
 * have given it two more dependencies for one conditional, and the two commands
 * genuinely confirm different things.
 *
 * ## Nothing a client sends names a price, a quantity or a duration
 *
 * The kind comes from which button was pressed. The service comes from an id the
 * customer owns, checked against the ROW rather than filtered in the query, so somebody
 * else's id is the same NOT_FOUND an id that does not exist gets. The amount and the
 * quantity come from the catalogue. `commerce.ts` says a callback carries an intent and
 * an identifier; this is the service that would otherwise be the exception.
 */
export class CommercialActionService {
  constructor(private readonly deps: CommercialActionServiceDeps) {}

  /**
   * What this customer may buy for this service, without committing to anything.
   *
   * A READ. It refuses for every reason the purchase would, so a surface never renders
   * a button whose tap is a refusal — and it refuses with the same codes, so the two
   * cannot drift into disagreeing about what is available.
   */
  async offer(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    serviceId: string,
    kind: CommercialKind,
  ): Promise<CommercialOffer> {
    await this.deps.guard.check(scope, actor, COMMERCIAL_ACTION_PERMISSION);
    const service = await this.ownedService(scope, customerId, serviceId);
    this.assertLifecycleAllows(kind, service);
    await this.assertPanelCanPerform(scope, service, kind);

    if (kind === 'RENEW') {
      const product = await this.renewableProduct(scope, service);
      return { kind, product, addons: [] };
    }

    const addons = await this.deps.addons.listOfferable(
      scope,
      kind === 'ADD_TRAFFIC' ? 'ADD_TRAFFIC' : 'ADD_TIME',
      await this.salesCurrency(scope),
      ADDON_OFFER_LIMIT,
    );
    if (addons.items.length === 0) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
        'Nothing of that kind is offered.',
      );
    }
    return { kind, product: null, addons: addons.items };
  }

  /**
   * Which of the three a customer could actually buy for this service, right now.
   *
   * The read a surface uses to decide which buttons to draw, and it applies EVERY
   * condition the purchase would: the service's state, the panel's declared capability,
   * and whether there is anything configured to sell. A button drawn without the third
   * is a button whose tap is a refusal, which is the legacy defect this codebase keeps
   * naming — a product that offers what it cannot honour.
   *
   * Not drawing a button is still never the control. `draft` re-checks all three when
   * the tap arrives, and `planCommercialAction` checks the state again when the money
   * moves, so a customer scrolling back to an older message is refused rather than sold
   * something.
   */
  async availableFor(
    scope: TenantContext,
    actor: ActorContext,
    service: ServiceRecord,
  ): Promise<readonly CommercialKind[]> {
    await this.deps.guard.check(scope, actor, COMMERCIAL_ACTION_PERMISSION);
    const available: CommercialKind[] = [];
    for (const kind of COMMERCIAL_ORDER_PURPOSES as readonly CommercialKind[]) {
      if (!OPERATION_LEGAL_FROM[kind].includes(service.state)) continue;
      const operable = await this.deps.panels.operability(scope, service.panelId, kind);
      if (!operable.ok) continue;
      if (kind === 'RENEW') {
        /*
         * The product must still be sellable, in the tenant's own currency.
         *
         * Caught rather than re-implemented: `renewableProduct` is the one place those
         * three conditions live, and a second copy here is a second thing to keep in
         * step. A refusal means "not offerable", which is exactly what this asks.
         *
         * Only a BUSINESS refusal, by code. A bare `catch` here treated a dead product
         * repository or an unreadable settings row exactly like a withdrawn plan: the
         * button quietly vanished, the request answered 200, and an outage was
         * indistinguishable from a configuration choice. Everything else rethrows and
         * reaches the runtime's error path, which is what the panel and add-on branches
         * beside it already do by not catching at all.
         */
        try {
          await this.renewableProduct(scope, service);
        } catch (error: unknown) {
          if (!isOfferRefusal(error)) throw error;
          continue;
        }
        available.push(kind);
        continue;
      }
      const offered = await this.deps.addons.listOfferable(
        scope,
        kind,
        await this.salesCurrency(scope),
        1,
      );
      if (offered.items.length > 0) available.push(kind);
    }
    return available;
  }

  /**
   * Quotes the action and writes the DRAFT order and its invoice line.
   *
   * Both rows in ONE transaction, and that is the exactly-once rule for a commercial
   * purchase: `service_commercial_actions_order_key` is unique on the order, so a
   * replayed command or a second replica loses on it rather than buying the customer a
   * second renewal.
   *
   * The quote is taken HERE, at draft time, and frozen onto the order. The customer
   * answers the summary they were shown; re-quoting at confirmation would charge a
   * number they never saw, which is exactly what `OrderService.confirm` refuses to do
   * for a product.
   */
  async draft(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    input: {
      readonly serviceId: string;
      readonly kind: CommercialKind;
      /** Required for a quantity purchase, refused for a renewal. */
      readonly addonId?: string;
      readonly idempotencyKey: string;
    },
  ): Promise<{ readonly order: OrderRecord; readonly action: CommercialActionRecord }> {
    const serviceId = this.serviceId(input.serviceId);
    const addonId = input.addonId === undefined ? null : this.addonId(input.addonId);
    const requestHash = hashRequest({
      customerId,
      serviceId,
      kind: input.kind,
      addonId,
    });
    const denial = {
      action: `service.${input.kind.toLowerCase()}_draft`,
      entityType: 'Service',
      entityId: serviceId,
    };

    /*
     * Authorized BEFORE the replay lookup.
     *
     * `runAuthorizedMutation` re-checks inside the committing transaction, which is the
     * rule — but a replay returns an ORDER and never reaches it. The shape every service
     * here uses since the Codex review of 4B found the one that did not.
     */
    await this.authorize(scope, actor, denial);

    const replay = await this.deps.idempotency.find<{ orderId: string }>(
      scope,
      COMMERCIAL_NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.orders.findById(scope, replay.result.orderId as OrderId);
      const action = await this.deps.actions.findByOrderId(scope, replay.result.orderId as OrderId);
      if (existing !== null && action !== null) return { order: existing, action };
      // The idempotency row outlived its order, which a restore can produce. Falling
      // through quotes again rather than reporting a stale success for rows that are gone.
    }

    const now = this.deps.clock.now();
    const orderId = this.deps.ids.uuid() as OrderId;

    return runAuthorizedMutation(
      this.deps2(),
      scope,
      actor,
      COMMERCIAL_ACTION_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);

        /*
         * Everything authoritative is read INSIDE the transaction.
         *
         * A service terminated, a product withdrawn or an add-on deactivated between
         * the customer opening the screen and tapping the button must refuse here
         * rather than be sold. The surface's own check is a courtesy; this is the one
         * that counts.
         */
        const service = await this.ownedService(scope, customerId, serviceId, tx);
        this.assertLifecycleAllows(input.kind, service);
        await this.assertPanelCanPerform(scope, service, input.kind, tx);

        const priced =
          input.kind === 'RENEW'
            ? await this.quoteRenewal(scope, service, now, tx)
            : await this.quoteAddon(scope, service, input.kind, addonId, now, tx);

        const expiresAt = new Date(now.getTime() + (await this.expiryMinutes(scope, tx)) * 60_000);

        const order = await this.deps.orders.create(
          scope,
          {
            id: orderId,
            customerId,
            purpose: input.kind,
            line: priced.line,
            totals: priced.totals,
            expiresAt,
            now,
          },
          tx,
        );

        const created = await this.deps.actions.create(
          scope,
          {
            id: this.deps.ids.uuid(),
            customerId,
            serviceId,
            orderId: order.id,
            kind: input.kind,
            productId: priced.productId,
            addonId: priced.addonId,
            purchasedTrafficBytes: priced.purchasedTrafficBytes,
            purchasedDurationDays: priced.purchasedDurationDays,
            amount: priced.totals.total,
            now,
          },
          tx,
        );
        const action = created ?? (await this.deps.actions.findByOrderId(scope, order.id, tx));
        if (action === null) {
          throw new Error(
            `order ${order.id} was created with no commercial action; the unique index is missing`,
          );
        }

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: denial.action,
            entityType: 'Service',
            entityId: serviceId,
            before: {
              state: service.state,
              expiresAt: service.expiresAt?.toISOString() ?? null,
              trafficLimitBytes: service.trafficLimitBytes.toString(),
            },
            after: {
              requestedBy: customerId,
              orderId: order.id,
              kind: input.kind,
              productId: priced.productId,
              addonId: priced.addonId,
              purchasedTrafficBytes: priced.purchasedTrafficBytes.toString(),
              purchasedDurationDays: priced.purchasedDurationDays,
              amountMinor: priced.totals.total.amountMinor.toString(),
              currency: priced.totals.currency,
            },
            result: 'SUCCESS',
          },
          tx,
        );

        await rememberOnce(
          this.deps.idempotency,
          scope,
          COMMERCIAL_NAMESPACE,
          input.idempotencyKey,
          requestHash,
          { orderId: order.id },
          tx,
        );
        return { order, action };
      },
    );
  }

  /**
   * DRAFT → AWAITING_PAYMENT for a commercial order.
   *
   * The same edge `OrderService.confirm` takes and the same re-check discipline, over a
   * different subject: what is re-validated is the SERVICE's eligibility and the
   * availability of what was quoted, not the product's orderability. The PRICE is not
   * re-quoted, for the reason ordering states: the summary the customer is answering is
   * the offer.
   */
  async confirm(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    input: { readonly orderId: string; readonly idempotencyKey: string },
  ): Promise<OrderRecord> {
    const orderId = this.orderId(input.orderId);
    const requestHash = hashRequest({ customerId, orderId });
    const denial = {
      action: 'service.action_confirm',
      entityType: 'Order',
      entityId: orderId,
    };
    await this.authorize(scope, actor, denial);

    const replay = await this.deps.idempotency.find<{ orderId: string }>(
      scope,
      COMMERCIAL_NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.orders.findById(scope, orderId);
      if (existing !== null) return existing;
    }

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.deps2(),
      scope,
      actor,
      COMMERCIAL_ACTION_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);

        const before = await this.deps.orders.findById(scope, orderId, tx);
        /*
         * Another customer's order is UNKNOWN rather than FORBIDDEN, the rule ordering
         * states: a distinct refusal answers "does order X exist" for anybody guessing.
         */
        if (before === null || before.customerId !== customerId) {
          throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
        }
        if (before.purpose === 'NEW_SERVICE') {
          /*
           * A product purchase reaching this command.
           *
           * Refused rather than handled: `OrderService.confirm` re-checks the PRODUCT
           * and this one does not, so confirming one here would skip the check that
           * stops a withdrawn product being sold.
           */
          throw errors.conflict(
            COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
            'That order is not a service action.',
          );
        }

        const action = await this.deps.actions.findByOrderId(scope, orderId, tx);
        if (action === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
        }

        /*
         * Already confirmed is a SUCCESS, and it is not this call's success.
         *
         * A customer who taps twice, or a callback Telegram redelivers, must not be told
         * their order is broken — the end state they asked for holds. The audit row
         * below records `changed` so the log still tells the two apart.
         */
        if (before.state !== 'DRAFT') {
          if (before.state !== 'AWAITING_PAYMENT') {
            throw errors.conflict(
              COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
              'That order can no longer be confirmed.',
              { state: before.state },
            );
          }
          return before;
        }

        if (before.expiresAt !== null && now.getTime() >= before.expiresAt.getTime()) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.ORDER_EXPIRED,
            'This order was held for too long and must be started again.',
          );
        }

        /*
         * The SERVICE is re-checked, and so is what was quoted.
         *
         * A service terminated since the draft cannot be renewed; an add-on withdrawn
         * since cannot be sold. Neither re-quotes: the amount on the order is what the
         * customer was shown.
         */
        const service = await this.ownedService(scope, customerId, action.serviceId, tx);
        this.assertLifecycleAllows(action.kind, service);
        await this.assertPanelCanPerform(scope, service, action.kind, tx);
        await this.assertStillOffered(scope, action, tx);

        // What the quote spent, redeemed under the rules' locks, before the transition
        // (WP8 P6) — the same call `OrderService.confirm` makes, for the same reasons.
        await this.deps.pricing.redeem(scope, actor, before, now, tx);

        const to = nextState(ORDER_MACHINE, 'DRAFT', 'CONFIRM');
        if (to === null) throw new Error('ORDER_MACHINE no longer allows CONFIRM from DRAFT.');

        const changed = await this.deps.orders.transition(
          scope,
          orderId,
          'DRAFT',
          to,
          { confirmedAt: now },
          now,
          tx,
        );
        const after = await this.deps.orders.findById(scope, orderId, tx);
        if (after === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.ORDER_NOT_FOUND, 'Unknown order.');
        }

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: denial.action,
            entityType: 'Order',
            entityId: orderId,
            before: { state: before.state },
            after: { state: after.state, changed, kind: action.kind, serviceId: action.serviceId },
            result: 'SUCCESS',
          },
          tx,
        );

        /*
         * The event follows the ROW CHANGING, exactly as ordering has it: `changed` is
         * false when another confirmation committed first, and emitting anyway would put
         * two `OrderConfirmed` events on one order.
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
          COMMERCIAL_NAMESPACE,
          input.idempotencyKey,
          requestHash,
          { orderId: after.id },
          tx,
        );
        return after;
      },
    );
  }

  /** This service's commercial history, newest first. A read the owner may take. */
  async historyFor(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    serviceId: string,
    limit: number,
  ): Promise<readonly CommercialActionRecord[]> {
    await this.deps.guard.check(scope, actor, COMMERCIAL_ACTION_PERMISSION);
    const service = await this.ownedService(scope, customerId, serviceId);
    return this.deps.actions.listForService(scope, service.id, Math.min(Math.max(limit, 1), 50));
  }

  /* ---------------------------------------------------------------- pricing */

  /**
   * A renewal is quoted from the SERVICE's own product, at its current list price.
   *
   * Which is what the legacy system does — `TBR-008`: the renewal entry point offers
   * the current plan at the identical price. It is a NEW quote and not a copy of the
   * original order's, because a renewal buys today's plan at today's price; the
   * original order's snapshot stays untouched and still says what was bought then.
   *
   * A product that is gone, withdrawn, unpriced, or priced in a currency the tenant does
   * not sell in makes the action UNAVAILABLE. `OQ-4F-03` records that this diverges
   * from `SBR-011`, which says withdrawal must not stop renewals — deliberately, because
   * continuing to sell against a withdrawn row means charging a price no operator can
   * see, and a renewal price that survives withdrawal needs a place to live that this
   * schema does not have.
   */
  private async quoteRenewal(
    scope: TenantContext,
    service: ServiceRecord,
    now: Date,
    tx: TransactionScope,
  ): Promise<PricedAction> {
    const product = await this.renewableProduct(scope, service, tx);
    const price = product.price;
    if (price === null) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
        'This service cannot be renewed right now.',
      );
    }

    /*
     * A renewal must be shape-compatible with the service it renews.
     *
     * A time-limited service renewed from a product with no duration, or the reverse,
     * is a change of what the customer holds rather than a renewal — and `OperationTarget`
     * has no encoding for "make the window unlimited", deliberately. Refused with the
     * reason rather than silently buying nothing.
     */
    const serviceHasWindow = service.expiresAt !== null;
    const productHasWindow = product.specification.durationDays > 0;
    if (serviceHasWindow !== productHasWindow) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
        'This plan no longer matches the service it would renew.',
      );
    }

    const { totals } = await this.deps.pricing.price(
      scope,
      {
        base: quoteProduct(product, price, MAX_ORDER_QUANTITY, now),
        purpose: 'RENEW',
        productId: product.id,
        categoryId: product.categoryId,
        customerId: service.customerId,
        now,
      },
      tx,
    );
    return {
      productId: product.id,
      addonId: null,
      purchasedTrafficBytes: product.specification.trafficBytes,
      purchasedDurationDays: product.specification.durationDays,
      totals,
      line: {
        productId: product.id,
        panelId: service.panelId,
        title: product.title,
        /*
         * NO category, and that is a statement rather than an omission.
         *
         * A renewal, an added allowance and an added month are not bought FROM a
         * category — the customer named a service they already own, and no category
         * browse happened. Snapshotting the product's category as it reads today would
         * record a fact about the catalogue now as though it were a fact about this
         * purchase, which is the same fabrication the owner's instruction forbids for
         * pre-WP5 orders.
         *
         * So the column stays null, and a surface renders it exactly as it renders an
         * old order's: no category recorded. The two causes are deliberately
         * indistinguishable, because the honest answer to both is the same one, and a
         * code that told them apart would be a distinction nobody can act on.
         */
        category: null,
        specification: product.specification,
        unitPrice: price,
        quantity: MAX_ORDER_QUANTITY,
      },
    };
  }

  /**
   * A quantity purchase is quoted from the ADD-ON the customer chose, by id.
   *
   * The id names a row; the amount and the price come off that row. Nothing a client
   * sends is a quantity, which is the whole reason add-ons are rows rather than a
   * per-unit rate (`OQ-4F-05`).
   */
  private async quoteAddon(
    scope: TenantContext,
    service: ServiceRecord,
    kind: 'ADD_TRAFFIC' | 'ADD_TIME',
    addonId: ServiceAddonId | null,
    now: Date,
    tx: TransactionScope,
  ): Promise<PricedAction> {
    if (addonId === null) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That action needs a package to buy.',
      );
    }
    const addon = await this.deps.addons.findById(scope, addonId, tx);
    if (addon === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.ADDON_NOT_FOUND, 'Unknown add-on.');
    }
    if (addon.kind !== kind) {
      /*
       * The add-on's kind must be the one the button asked for.
       *
       * A callback naming an `ADD_TIME` row on the `ADD_TRAFFIC` path is the one thing a
       * client CAN influence here — the id — and unchecked it would buy a quantity in
       * the wrong unit at the wrong price. Refused where the id arrives.
       */
      throw errors.conflict(
        COMMERCE_ERROR_CODES.ADDON_NOT_PURCHASABLE,
        'That package is not of the kind that was asked for.',
      );
    }
    if (!isAddonPurchasable(addon.status) || addon.price === null) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.ADDON_NOT_PURCHASABLE,
        'That package is no longer offered.',
      );
    }
    await this.assertSalesCurrency(scope, addon.price, tx);

    /*
     * An add-on is not a product and has no category, so only a rule scoped to neither
     * can reach it — a product- or category-scoped rule is refused on scope by the engine.
     */
    const { totals } = await this.deps.pricing.price(
      scope,
      {
        base: quoteAddon(addon.price, now),
        purpose: kind,
        productId: null,
        categoryId: null,
        customerId: service.customerId,
        now,
      },
      tx,
    );
    /*
     * The line snapshot carries the amount in the field this kind reads and ZERO in the
     * other, which `orders_quantity_line_check` pins. The zero means "no time was
     * bought" and NOT "unlimited" — the overload that constraint exists to settle.
     */
    const trafficBytes = addon.specification.trafficBytes ?? 0n;
    const durationDays = addon.specification.durationDays ?? 0;
    return {
      productId: null,
      addonId: addon.id,
      purchasedTrafficBytes: trafficBytes,
      purchasedDurationDays: durationDays,
      totals,
      line: {
        /*
         * `orders.product_id` and `orders.panel_id` are NOT NULL, and an add-on has
         * neither — so the SERVICE's are named, which is what an operator opening this
         * order would want anyway. Navigation, exactly as the column's docblock says:
         * the snapshot beside it is the truth about what was bought, and its title is
         * the PACKAGE's.
         */
        productId: service.productId,
        panelId: service.panelId,
        title: addon.title,
        /** No category, for the reason the renewal line above states. */
        category: null,
        specification: { durationDays, trafficBytes, deviceLimit: null },
        unitPrice: addon.price,
        quantity: MAX_ORDER_QUANTITY,
      },
    };
  }

  /* -------------------------------------------------------------- guards */

  /**
   * The service, by id, owned by this customer.
   *
   * Compared against the ROW rather than filtered in the query, and somebody else's id
   * answers the same NOT_FOUND an id that does not exist gets — telling them apart is
   * how a service id becomes enumerable.
   */
  private async ownedService(
    scope: TenantContext,
    customerId: UserId,
    serviceId: string,
    tx?: unknown,
  ): Promise<ServiceRecord> {
    const id = this.serviceId(serviceId);
    const service = await this.deps.services.findById(scope, id, tx);
    if (service === null || service.customerId !== customerId) {
      throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
    }
    return service;
  }

  /**
   * The service must be in a state this action means something from.
   *
   * `OPERATION_LEGAL_FROM` — the SAME table the executor checks — so a customer is told
   * now rather than by an operation that is planned, paid for and then abandoned.
   */
  private assertLifecycleAllows(kind: CommercialKind, service: ServiceRecord): void {
    if (!OPERATION_LEGAL_FROM[kind].includes(service.state)) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
        'That service is not in a state this action can be taken from.',
        { state: service.state },
      );
    }
  }

  /**
   * The panel must declare the capability, checked BEFORE any money moves.
   *
   * This is what keeps the owner's 3X-UI decision real: a Sanaei-backed service is
   * refused with `PANEL_NOT_OPERABLE` here, before an order exists, so no customer is
   * ever charged for an operation their panel will not perform.
   */
  private async assertPanelCanPerform(
    scope: TenantContext,
    service: ServiceRecord,
    kind: CommercialKind,
    tx?: unknown,
  ): Promise<void> {
    const operable = await this.deps.panels.operability(scope, service.panelId, kind, tx);
    if (!operable.ok) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
        'The panel this service lives on cannot perform that action.',
        { reason: operable.reason ?? 'UNKNOWN' },
      );
    }
  }

  /** What was quoted must still be on sale at confirmation. Never re-priced. */
  private async assertStillOffered(
    scope: TenantContext,
    action: CommercialActionRecord,
    tx: TransactionScope,
  ): Promise<void> {
    if (action.addonId !== null) {
      const addon = await this.deps.addons.findById(scope, action.addonId, tx);
      if (addon === null || !isAddonPurchasable(addon.status) || addon.price === null) {
        throw errors.conflict(
          COMMERCE_ERROR_CODES.ADDON_NOT_PURCHASABLE,
          'That package is no longer offered.',
        );
      }
      return;
    }
    if (action.productId !== null) {
      const product = await this.deps.products.findById(scope, action.productId, tx);
      if (product === null || !isPurchasable(product.status) || product.price === null) {
        throw errors.conflict(
          COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
          'This service cannot be renewed right now.',
        );
      }
    }
  }

  private async renewableProduct(
    scope: TenantContext,
    service: ServiceRecord,
    tx?: unknown,
  ): Promise<ProductRecord> {
    const product = await this.deps.products.findById(scope, service.productId, tx);
    if (product === null || !isPurchasable(product.status) || product.price === null) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
        'This service cannot be renewed right now.',
      );
    }
    await this.assertSalesCurrency(scope, product.price, tx);
    return product;
  }

  /** The unit this installation sells in, read where it is needed rather than cached. */
  private async salesCurrency(scope: TenantContext, tx?: unknown): Promise<SalesCurrencyCode> {
    return this.deps.settings.valueOf<SalesCurrencyCode>(scope, 'sales.currency', tx);
  }

  /** Priced in the currency the tenant sells in, or refused. `ProductService`'s rule. */
  private async assertSalesCurrency(
    scope: TenantContext,
    price: Money,
    tx?: unknown,
  ): Promise<void> {
    const selling = await this.deps.settings.valueOf<SalesCurrencyCode>(
      scope,
      'sales.currency',
      tx,
    );
    if (price.currency !== selling) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PRODUCT_CURRENCY_UNSUPPORTED,
        `This installation sells in ${selling}.`,
      );
    }
  }

  private async expiryMinutes(scope: TenantContext, tx: TransactionScope): Promise<number> {
    return this.deps.settings.valueOf<number>(scope, 'sales.order_expiry_minutes', tx);
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
  }

  private deps2() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }

  /** `recordMutationDenial`, not a bare check — see `ProductService.authorize`. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, COMMERCIAL_ACTION_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.deps2(),
        scope,
        actor,
        COMMERCIAL_ACTION_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }

  private serviceId(candidate: string): string {
    const parsed = serviceIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid service identifier.',
      );
    }
    return parsed.data;
  }

  private addonId(candidate: string): ServiceAddonId {
    const parsed = serviceAddonIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid package identifier.',
      );
    }
    return parsed.data;
  }

  private orderId(candidate: string): OrderId {
    const parsed = serviceIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid order identifier.',
      );
    }
    return parsed.data as unknown as OrderId;
  }
}

interface PricedAction {
  readonly productId: ProductRecord['id'] | null;
  readonly addonId: ServiceAddonId | null;
  readonly purchasedTrafficBytes: bigint;
  readonly purchasedDurationDays: number;
  readonly totals: OrderTotalsRecord;
  readonly line: OrderRecord['line'];
}
