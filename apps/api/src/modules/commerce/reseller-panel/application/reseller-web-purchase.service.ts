import {
  COMMERCE_ERROR_CODES,
  NexaError,
  PLATFORM_ERROR_CODES,
  RESELLER_SELLING_AUDIT_ACTIONS,
  RESELLER_WEB_ERROR_CODES,
  errors,
  isNexaError,
  money,
  parseCustomServiceDays,
  parseCustomServiceVolume,
  toWire,
  type AuditWriter,
  type BotInstanceId,
  type Clock,
  type CurrencyCode,
  type IdGenerator,
  type Money,
  type ResellerPurchaseBatch,
  type ResellerPurchaseItemStatus,
  type ResellerPurchaseQuote,
  type ResellerPurchaseQuoteRequest,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { CheckoutService } from '../../checkout/application/checkout.service.js';
import type { CustomServiceFlowService } from '../../custom-service/application/custom-service-flow.service.js';
import type { OrderService } from '../../orders/application/order.service.js';
import type { OrderRecord } from '../../orders/application/ports.js';
import type { ServiceRecord } from '../../provisioning/application/ports.js';
import type { DeliveryService } from '../../provisioning/application/delivery.service.js';
import { ProvisioningService } from '../../provisioning/application/provisioning.service.js';
import type { SubscriptionFileService } from '../../provisioning/application/subscription-file.service.js';
import type { ResellerWebContext } from './reseller-web-access.service.js';
import type { PurchaseBatchRecord, ResellerSellingRepository } from './selling-ports.js';

export interface ResellerWebPurchaseDeps {
  readonly orders: Pick<
    OrderService,
    'createDraft' | 'usernameStep' | 'chooseUsername' | 'cancelByCustomer' | 'orderForCustomer'
  >;
  readonly custom: Pick<CustomServiceFlowService, 'draftFromFigures'>;
  readonly checkout: Pick<CheckoutService, 'payFromWallet'>;
  /** The wallet's own lock and its ledger-derived balance (`WalletRepository`). */
  readonly wallet: {
    lockCustomer(scope: TenantContext, customerId: UserId, tx: unknown): Promise<boolean>;
    balanceOf(
      scope: TenantContext,
      customerId: UserId,
      currency: CurrencyCode,
      tx?: unknown,
    ): Promise<{ readonly amountMinor: bigint; readonly currency: CurrencyCode }>;
  };
  /** A plan's list price, for «سود شما» (display only). */
  readonly listPriceOf: (scope: TenantContext, productId: string) => Promise<Money | null>;
  readonly services: {
    findByOrderId(scope: TenantContext, orderId: string): Promise<ServiceRecord | null>;
  };
  readonly provisioning: Pick<ProvisioningService, 'setCustomerNote'>;
  readonly delivery: Pick<DeliveryService, 'isFilesOnly' | 'redeliver'>;
  readonly files: Pick<SubscriptionFileService, 'sendAfterDelivery'>;
  readonly repository: ResellerSellingRepository;
  readonly audit: AuditWriter;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: Pick<IdGenerator, 'uuid'>;
}

const notFound = (): NexaError => errors.notFound(RESELLER_WEB_ERROR_CODES.NOT_FOUND, 'Not found.');

function invalid(reason: string, details: Record<string, unknown> = {}): NexaError {
  return errors.validation(RESELLER_WEB_ERROR_CODES.REQUEST_INVALID, 'The request is invalid.', {
    reason,
    ...details,
  });
}

function stopped(): NexaError {
  return errors.conflict(
    RESELLER_WEB_ERROR_CODES.UNAVAILABLE,
    'This installation has stopped accepting work.',
  );
}

/** One per-order key, derived from the batch's key: `(batchKey, index)`. */
export function batchOrderKey(batchKey: string, index: number, step: string): string {
  return `${batchKey}:${String(index)}:${step}`;
}

/** The sum of the payable orders' totals, in their one currency (the tenant's selling one). */
export function payableTotal(orders: readonly OrderRecord[]): Money | null {
  let total: Money | null = null;
  for (const order of orders) {
    if (order.state !== 'DRAFT' && order.state !== 'AWAITING_PAYMENT') continue;
    const line = order.totals.total;
    if (total === null) total = line;
    else if (total.currency !== line.currency) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PRODUCT_CURRENCY_UNSUPPORTED,
        'The orders of one purchase are in different currencies.',
      );
    } else total = money(total.amountMinor + line.amountMinor, total.currency);
  }
  return total;
}

/**
 * The wallet pre-check of a group of orders, INSIDE the caller's transaction and under the
 * wallet's own lock (the caller took `lockCustomer`): the ledger balance must be non-negative
 * and cover the whole total, or nothing is charged — there is no credit.
 */
export async function assertWalletCovers(
  wallet: ResellerWebPurchaseDeps['wallet'],
  scope: TenantContext,
  customerId: UserId,
  total: Money,
  tx: unknown,
): Promise<void> {
  const balance = await wallet.balanceOf(scope, customerId, total.currency, tx);
  if (balance.amountMinor < 0n || balance.amountMinor < total.amountMinor) {
    throw errors.conflict(
      COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS,
      'The wallet does not cover this purchase.',
      {
        shortfallMinor: (total.amountMinor - balance.amountMinor).toString(),
        currency: total.currency,
      },
    );
  }
}

type ItemOutcome = { readonly status: ResellerPurchaseItemStatus; readonly reason: string | null };

/**
 * PR-5 §5.5 — «خرید»: one purchase is N ORDINARY orders.
 *
 * The quote drafts each order through the bot's own `createDraft` (or the custom service's
 * draft), each priced once by `PricingService` and honoured when paid, under its own key
 * `(batchKey, index)`; the username is the bot's `chooseUsername` (AUTOMATIC, or the custom
 * name for a quantity of one). Confirming pre-checks the WHOLE total against the wallet under
 * the wallet's own lock (`lockCustomer`) BEFORE the first order is paid — a negative or short
 * wallet refuses everything and nothing is charged — then pays each order through
 * `CheckoutService.payFromWallet` (confirm → `settleFromWallet`, `recordPurchase` inside the
 * pricing redemption as the bot does). An order refused on the way is reported FAILED and is
 * not charged; a paid order the panel cannot deliver is refunded by the existing
 * refund-on-undeliverable rule. The batch row only groups the results.
 */
export class ResellerWebPurchaseService {
  constructor(private readonly deps: ResellerWebPurchaseDeps) {}

  async quote(
    context: ResellerWebContext,
    input: ResellerPurchaseQuoteRequest,
    batchKey: string,
  ): Promise<ResellerPurchaseQuote> {
    const customerId = context.customer.id as UserId;
    if (input.username.mode === 'CUSTOM' && input.quantity !== 1) {
      throw errors.validation(
        RESELLER_WEB_ERROR_CODES.CUSTOM_USERNAME_SINGLE,
        'A custom username is for a purchase of one service.',
      );
    }
    if (input.clientId !== null) {
      const client = await this.deps.repository.findClient(
        context.scope,
        customerId,
        input.clientId,
      );
      if (client === null || client.archivedAt !== null) throw notFound();
    }

    let batch = await this.deps.repository.findBatchByKey(context.scope, customerId, batchKey);
    if (batch !== null && !sameRequest(batch, input)) {
      throw errors.conflict(
        PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
        'This key was used for a different purchase.',
      );
    }
    // Order 0 first: it validates the plan (or the custom terms) and names the batch.
    const first = await this.draft(context, input, batchKey, 0);
    if (batch === null) {
      batch = await this.createBatch(context, input, batchKey, first);
    }
    const orders: OrderRecord[] = [first];
    await this.deps.repository.insertBatchOrder(context.scope, {
      batchId: batch.id,
      position: 0,
      orderId: first.id,
      customerId,
    });
    for (let index = 1; index < input.quantity; index += 1) {
      const order = await this.draft(context, input, batchKey, index);
      await this.deps.repository.insertBatchOrder(context.scope, {
        batchId: batch.id,
        position: index,
        orderId: order.id,
        customerId,
      });
      orders.push(order);
    }
    for (const [index, order] of orders.entries()) {
      await this.reserveUsername(context, batch, order, index, 'username');
    }

    const unit = first.totals.total;
    const total = payableTotal(orders) ?? money(0n, unit.currency);
    const list =
      input.plan.kind === 'PLAN'
        ? await this.deps.listPriceOf(context.scope, input.plan.productId)
        : null;
    const listTotal =
      list !== null && list.currency === unit.currency
        ? money(list.amountMinor * BigInt(input.quantity), list.currency)
        : null;
    const saving =
      listTotal !== null && listTotal.amountMinor > total.amountMinor
        ? money(listTotal.amountMinor - total.amountMinor, total.currency)
        : money(0n, total.currency);
    const balance = await this.deps.wallet.balanceOf(context.scope, customerId, total.currency);
    const after = balance.amountMinor - total.amountMinor;
    const sufficient =
      balance.currency === total.currency && balance.amountMinor >= 0n && after >= 0n;
    return {
      batchId: batch.id,
      title: batch.title,
      quantity: input.quantity,
      unitPrice: toWire(unit),
      listUnitPrice: list === null ? null : toWire(list),
      total: toWire(total),
      saving: toWire(saving),
      balance: toWire(money(balance.amountMinor, balance.currency)),
      balanceAfter: toWire(money(after, total.currency)),
      sufficient,
      // Short by what the total exceeds the balance — a negative balance included.
      shortfall: sufficient
        ? null
        : toWire(money(total.amountMinor - balance.amountMinor, total.currency)),
      usernameMode: input.username.mode,
      username: input.username.mode === 'CUSTOM' ? input.username.value : null,
      clientId: batch.clientId,
      note: batch.note,
    };
  }

  /**
   * «خرید»: the wallet pre-check under the wallet lock, then each order paid in turn. A replay
   * of a batch whose pre-check already passed goes straight to the orders, each of which
   * replays under its own key: nothing is charged twice.
   */
  async confirm(context: ResellerWebContext, batchId: string): Promise<ResellerPurchaseBatch> {
    const customerId = context.customer.id as UserId;
    const batch = await this.ownBatch(context, batchId);
    const rows = await this.deps.repository.batchOrders(context.scope, batch.id);
    // A quote that stopped half way is quoted again (same key) before it can be bought.
    if (rows.length !== batch.quantity) throw invalid('QUOTE_INCOMPLETE');
    const orders = await Promise.all(rows.map((row) => this.ownOrder(context, row.orderId)));
    if (batch.confirmedAt === null) {
      await this.precheck(context, batch, orders);
    }

    const outcomes = new Map<number, ItemOutcome>();
    for (const [index, order] of orders.entries()) {
      outcomes.set(index, await this.pay(context, batch, order, index, customerId));
    }
    return this.view(context, batch, outcomes);
  }

  async get(context: ResellerWebContext, batchId: string): Promise<ResellerPurchaseBatch> {
    return this.view(context, await this.ownBatch(context, batchId), new Map());
  }

  /**
   * «ارسال همهٔ لینک‌ها در تلگرام»: each created service through the existing delivery to the
   * reseller's OWN chat — the link card (none on a files-only panel), then the connection files
   * by `sendAfterDelivery`, in the bot's order.
   */
  async sendLinks(
    context: ResellerWebContext,
    batchId: string,
  ): Promise<{ readonly sent: number; readonly failed: number }> {
    const batch = await this.ownBatch(context, batchId);
    const rows = await this.deps.repository.batchOrders(context.scope, batch.id);
    let sent = 0;
    let failed = 0;
    for (const row of rows) {
      const service = await this.deps.services.findByOrderId(context.scope, row.orderId);
      if (
        service === null ||
        service.customerId !== context.customer.id ||
        !ProvisioningService.isDeliverable(service)
      ) {
        continue;
      }
      try {
        if (!(await this.deps.delivery.isFilesOnly(context.scope, service))) {
          await this.deps.delivery.redeliver(
            context.scope,
            service,
            context.customer.id as UserId,
            context.customer.telegramUserId,
            context.botInstanceId,
          );
        }
        await this.deps.files.sendAfterDelivery(context.scope, context.actor, service, {
          chatId: context.customer.telegramUserId,
          botInstanceId: context.botInstanceId as BotInstanceId,
        });
        sent += 1;
      } catch (error) {
        if (!(error instanceof NexaError)) throw error;
        failed += 1;
      }
    }
    await this.deps.audit.record(context.scope, context.actor, {
      action: RESELLER_SELLING_AUDIT_ACTIONS.LINKS_SENT,
      entityType: 'Customer',
      entityId: context.customer.id,
      before: null,
      after: { batchId: batch.id, sent, failed },
      result: failed === 0 ? 'SUCCESS' : 'FAILED',
    });
    return { sent, failed };
  }

  /**
   * Puts a batch's client and note on each of its services once the service exists (it is made
   * after the payment, by the provisioning lane). Idempotent per order (`applied_at`), in one
   * transaction with the scope check; a stopped scope writes nothing.
   */
  async applyPending(context: ResellerWebContext): Promise<void> {
    const customerId = context.customer.id as UserId;
    const pending = await this.deps.repository.pendingApplications(context.scope, customerId);
    for (const item of pending) {
      await this.deps.uow.run(context.scope, async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(context.scope, tx))) return;
        const now = this.deps.clock.now();
        if (!(await this.deps.repository.markApplied(context.scope, { ...item, now }, tx))) {
          return;
        }
        if (item.clientId !== null) {
          const client = await this.deps.repository.findClient(
            context.scope,
            customerId,
            item.clientId,
            tx,
          );
          const current = await this.deps.repository.assignedTo(context.scope, item.serviceId, tx);
          if (client !== null && client.archivedAt === null && current === null) {
            await this.deps.repository.assign(
              context.scope,
              { serviceId: item.serviceId, clientId: client.id, customerId, now },
              tx,
            );
          }
        }
      });
      if (item.note !== null) {
        await this.deps.provisioning.setCustomerNote(
          context.scope,
          context.actor,
          customerId,
          item.serviceId,
          item.note,
        );
      }
    }
  }

  // --- helpers ------------------------------------------------------------------------------

  private async draft(
    context: ResellerWebContext,
    input: ResellerPurchaseQuoteRequest,
    batchKey: string,
    index: number,
  ): Promise<OrderRecord> {
    const customerId = context.customer.id as UserId;
    const idempotencyKey = batchOrderKey(batchKey, index, 'draft');
    if (input.plan.kind === 'PLAN') {
      return this.deps.orders.createDraft(context.scope, context.actor, {
        idempotencyKey,
        customerId,
        productId: input.plan.productId,
      });
    }
    const drafted = await this.deps.custom.draftFromFigures(context.scope, context.actor, {
      idempotencyKey,
      customerId,
      panelId: input.plan.panelId,
      volume: input.plan.volume,
      days: input.plan.days,
    });
    if (drafted.outcome === 'DRAFTED') return drafted.order;
    if (drafted.outcome === 'INVALID_VOLUME') {
      throw invalid('VOLUME_OUT_OF_RANGE', rangeWire(drafted.range));
    }
    if (drafted.outcome === 'INVALID') throw invalid('DAYS_OUT_OF_RANGE', rangeWire(drafted.range));
    if (drafted.outcome === 'VOLUME_UNPRICED') throw invalid('VOLUME_UNPRICED');
    if (drafted.outcome === 'UNPRICED') throw invalid('DAYS_UNPRICED');
    throw errors.conflict(
      COMMERCE_ERROR_CODES.CUSTOM_SERVICE_UNAVAILABLE,
      'The custom service is not available here.',
    );
  }

  private async createBatch(
    context: ResellerWebContext,
    input: ResellerPurchaseQuoteRequest,
    batchKey: string,
    first: OrderRecord,
  ): Promise<PurchaseBatchRecord> {
    const customerId = context.customer.id as UserId;
    const now = this.deps.clock.now();
    const row: Omit<PurchaseBatchRecord, 'confirmedAt'> = {
      id: this.deps.ids.uuid(),
      customerId,
      idempotencyKey: batchKey,
      productId: input.plan.kind === 'PLAN' ? input.plan.productId : null,
      customPanelId: input.plan.kind === 'CUSTOM' ? input.plan.panelId : null,
      customVolumeUnits:
        input.plan.kind === 'CUSTOM' ? parseCustomServiceVolume(input.plan.volume) : null,
      customDays: input.plan.kind === 'CUSTOM' ? parseCustomServiceDays(input.plan.days) : null,
      title: first.line.title.slice(0, 200),
      quantity: input.quantity,
      usernameMode: input.username.mode,
      customUsername: input.username.mode === 'CUSTOM' ? input.username.value : null,
      clientId: input.clientId,
      note: input.note === null || input.note.length === 0 ? null : input.note,
      createdAt: now,
    };
    await this.deps.uow.run(context.scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(context.scope, tx))) throw stopped();
      if (!(await this.deps.repository.insertBatch(context.scope, row, tx))) return;
      await this.deps.audit.record(
        context.scope,
        context.actor,
        {
          action: RESELLER_SELLING_AUDIT_ACTIONS.PURCHASE_QUOTED,
          entityType: 'Customer',
          entityId: customerId,
          before: null,
          after: {
            batchId: row.id,
            productId: row.productId,
            customPanelId: row.customPanelId,
            quantity: row.quantity,
            usernameMode: row.usernameMode,
            clientId: row.clientId,
          },
          result: 'SUCCESS',
        },
        tx,
      );
    });
    const stored = await this.deps.repository.findBatchByKey(context.scope, customerId, batchKey);
    if (stored === null) throw new Error('reseller purchase batch vanished after its insert');
    return stored;
  }

  /** The bot's username step for one draft: kept when reserved, else AUTOMATIC or the custom name. */
  private async reserveUsername(
    context: ResellerWebContext,
    batch: PurchaseBatchRecord,
    order: OrderRecord,
    index: number,
    step: string,
  ): Promise<void> {
    if (order.state !== 'DRAFT') return;
    const customerId = context.customer.id as UserId;
    const current = await this.deps.orders.usernameStep(context.scope, context.actor, {
      customerId,
      orderId: order.id,
    });
    if (current.reservation !== null) return;
    await this.deps.orders.chooseUsername(context.scope, context.actor, {
      idempotencyKey: batchOrderKey(batch.idempotencyKey, index, step),
      customerId,
      orderId: order.id,
      choice:
        batch.usernameMode === 'CUSTOM' && batch.customUsername !== null
          ? { mode: 'CUSTOM', raw: batch.customUsername }
          : { mode: 'AUTOMATIC' },
    });
  }

  /**
   * The batch pre-check: the WHOLE payable total against the balance read under the wallet's
   * own lock (the customer row, which every debit takes), BEFORE the first order is paid. A
   * negative or short wallet refuses the batch and nothing is charged. Passing it is stamped
   * on the batch in the same transaction, so a replay does not pre-check against a balance its
   * own first run already spent.
   */
  private async precheck(
    context: ResellerWebContext,
    batch: PurchaseBatchRecord,
    orders: readonly OrderRecord[],
  ): Promise<void> {
    const customerId = context.customer.id as UserId;
    const total = payableTotal(orders);
    await this.deps.uow.run(context.scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(context.scope, tx))) throw stopped();
      if (!(await this.deps.wallet.lockCustomer(context.scope, customerId, tx))) throw notFound();
      if (total !== null) {
        await assertWalletCovers(this.deps.wallet, context.scope, customerId, total, tx);
      }
      const now = this.deps.clock.now();
      if (
        !(await this.deps.repository.markBatchConfirmed(
          context.scope,
          { batchId: batch.id, customerId, now },
          tx,
        ))
      ) {
        return;
      }
      await this.deps.audit.record(
        context.scope,
        context.actor,
        {
          action: RESELLER_SELLING_AUDIT_ACTIONS.PURCHASE_CONFIRMED,
          entityType: 'Customer',
          entityId: customerId,
          before: null,
          after: {
            batchId: batch.id,
            orders: orders.length,
            totalMinor: total?.amountMinor.toString() ?? '0',
            currency: total?.currency ?? null,
          },
          result: 'SUCCESS',
        },
        tx,
      );
    });
  }

  /** One order of the batch: paid through the bot's wallet checkout, or FAILED with its reason. */
  private async pay(
    context: ResellerWebContext,
    batch: PurchaseBatchRecord,
    order: OrderRecord,
    index: number,
    customerId: UserId,
  ): Promise<ItemOutcome> {
    if (order.state !== 'DRAFT' && order.state !== 'AWAITING_PAYMENT') {
      return order.state === 'PAID'
        ? { status: 'PAID', reason: null }
        : { status: 'FAILED', reason: order.state };
    }
    try {
      await this.reserveUsername(context, batch, order, index, 'username-pay');
      const paid = await this.deps.checkout.payFromWallet(
        context.scope,
        context.actor,
        customerId,
        order,
        batchOrderKey(batch.idempotencyKey, index, 'pay'),
      );
      if (paid.outcome === 'SHORT') {
        return { status: 'FAILED', reason: COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS };
      }
      return { status: 'PAID', reason: null };
    } catch (error) {
      if (!isNexaError(error) || error.httpStatus >= 500) throw error;
      await this.withdraw(context, order, index, customerId);
      return { status: 'FAILED', reason: error.code };
    }
  }

  /** A confirmed order whose payment was refused is withdrawn: nothing is left reserved. */
  private async withdraw(
    context: ResellerWebContext,
    order: OrderRecord,
    index: number,
    customerId: UserId,
  ): Promise<void> {
    const now = await this.ownOrder(context, order.id);
    if (now.state !== 'AWAITING_PAYMENT') return;
    try {
      await this.deps.orders.cancelByCustomer(context.scope, context.actor, {
        idempotencyKey: `${order.id}:${String(index)}:withdraw`,
        customerId,
        orderId: order.id,
      });
    } catch (error) {
      if (!isNexaError(error) || error.httpStatus >= 500) throw error;
    }
  }

  private async view(
    context: ResellerWebContext,
    batch: PurchaseBatchRecord,
    outcomes: ReadonlyMap<number, ItemOutcome>,
  ): Promise<ResellerPurchaseBatch> {
    await this.applyPending(context);
    const rows = await this.deps.repository.batchOrders(context.scope, batch.id);
    const confirmed =
      batch.confirmedAt !== null ||
      (await this.deps.repository.findBatch(context.scope, batch.customerId, batch.id))
        ?.confirmedAt != null;
    const client =
      batch.clientId === null
        ? null
        : await this.deps.repository.findClient(context.scope, batch.customerId, batch.clientId);
    const items: ResellerPurchaseBatch['items'] = [];
    for (const row of rows) {
      const order = await this.ownOrder(context, row.orderId);
      const service = await this.deps.services.findByOrderId(context.scope, order.id);
      const owned = service !== null && service.customerId === context.customer.id ? service : null;
      const outcome = outcomes.get(row.position) ?? null;
      const status = statusOf(order, owned, confirmed, outcome);
      const filesOnly =
        owned === null ? true : await this.deps.delivery.isFilesOnly(context.scope, owned);
      items.push({
        index: row.position,
        orderId: order.id,
        orderCode: order.code,
        status: status.status,
        reason: status.reason,
        total: toWire(order.totals.total),
        serviceId: owned?.id ?? null,
        username: owned?.providerUsername ?? null,
        subscriptionUrl:
          owned !== null && ProvisioningService.isDeliverable(owned) && !filesOnly
            ? owned.subscriptionUrl
            : null,
      });
    }
    return {
      batchId: batch.id,
      title: batch.title,
      quantity: batch.quantity,
      confirmed,
      clientId: batch.clientId,
      clientName: client?.name ?? null,
      note: batch.note,
      createdAt: batch.createdAt.toISOString(),
      items,
    };
  }

  private async ownBatch(
    context: ResellerWebContext,
    batchId: string,
  ): Promise<PurchaseBatchRecord> {
    if (!/^[0-9a-f-]{36}$/iu.test(batchId)) throw notFound();
    const batch = await this.deps.repository.findBatch(context.scope, context.customer.id, batchId);
    if (batch === null) throw notFound();
    return batch;
  }

  private async ownOrder(context: ResellerWebContext, orderId: string): Promise<OrderRecord> {
    try {
      return await this.deps.orders.orderForCustomer(context.scope, context.actor, {
        customerId: context.customer.id,
        orderId,
      });
    } catch (error) {
      if (isNexaError(error) && (error.kind === 'NOT_FOUND' || error.kind === 'VALIDATION')) {
        throw notFound();
      }
      throw error;
    }
  }
}

function rangeWire(
  range: { readonly min: bigint; readonly max: bigint } | null,
): Record<string, unknown> {
  return range === null ? {} : { min: range.min.toString(), max: range.max.toString() };
}

/** Whether a replayed key asks for the same purchase it first did. */
function sameRequest(batch: PurchaseBatchRecord, input: ResellerPurchaseQuoteRequest): boolean {
  const plan =
    input.plan.kind === 'PLAN'
      ? batch.productId === input.plan.productId
      : batch.customPanelId === input.plan.panelId;
  return (
    plan &&
    batch.quantity === input.quantity &&
    batch.usernameMode === input.username.mode &&
    (batch.customUsername ?? null) ===
      (input.username.mode === 'CUSTOM' ? input.username.value : null) &&
    batch.clientId === input.clientId &&
    (batch.note ?? null) === (input.note === null || input.note.length === 0 ? null : input.note)
  );
}

/** What one order of a batch is, for the result screen. */
export function statusOf(
  order: OrderRecord,
  service: ServiceRecord | null,
  confirmed: boolean,
  outcome: ItemOutcome | null,
): ItemOutcome {
  if (outcome !== null && outcome.status === 'FAILED') return outcome;
  if (order.state === 'PAID') {
    return service === null
      ? { status: 'PAID', reason: null }
      : { status: 'CREATED', reason: null };
  }
  if (order.state === 'DRAFT' || order.state === 'AWAITING_PAYMENT') {
    return confirmed
      ? { status: 'FAILED', reason: 'NOT_PAID' }
      : { status: 'QUOTED', reason: null };
  }
  return { status: 'FAILED', reason: order.state };
}
