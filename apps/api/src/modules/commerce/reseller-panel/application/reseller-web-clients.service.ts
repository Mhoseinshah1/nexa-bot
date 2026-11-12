import {
  COMMERCE_ERROR_CODES,
  RESELLER_SELLING_AUDIT_ACTIONS,
  RESELLER_WEB_ERROR_CODES,
  errors,
  isNexaError,
  money,
  toWire,
  type AuditWriter,
  type NexaError,
  type Clock,
  type IdGenerator,
  type Money,
  type ResellerAutoRenew,
  type ResellerClient,
  type ResellerClientServicesResponse,
  type ResellerClientWrite,
  type ResellerRenewAllQuote,
  type ResellerRenewAllResult,
  type ResellerSellingServicesResponse,
  type ResellerServicesResponse,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { CheckoutService } from '../../checkout/application/checkout.service.js';
import {
  renewsFromPanelPlans,
  type CommercialActionService,
} from '../../commercial/application/commercial-action.service.js';
import type { OrderService } from '../../orders/application/order.service.js';
import type { OrderRecord } from '../../orders/application/ports.js';
import type { ServiceRecord } from '../../provisioning/application/ports.js';
import type { ServiceAutoRenewService } from '../../provisioning/application/service-auto-renew.service.js';
import type { ResellerWebContext } from './reseller-web-access.service.js';
import {
  assertWalletCovers,
  payableTotal,
  type ResellerWebPurchaseDeps,
  type ResellerWebPurchaseService,
} from './reseller-web-purchase.service.js';
import {
  isExpiring,
  type ClientLabel,
  type ResellerWebServicesService,
} from './reseller-web-services.service.js';
import type { ResellerClientRecord, ResellerSellingRepository } from './selling-ports.js';

export interface ResellerWebClientsDeps {
  readonly repository: ResellerSellingRepository;
  readonly services: Pick<ResellerWebServicesService, 'own' | 'ownList' | 'rowsOf'>;
  readonly purchases: Pick<ResellerWebPurchaseService, 'applyPending'>;
  readonly autoRenew: Pick<
    ServiceAutoRenewService,
    'stateFor' | 'set' | 'featureOn' | 'importedOffered'
  >;
  readonly commercial: Pick<CommercialActionService, 'renewalQuote' | 'draft' | 'offer'>;
  readonly orders: Pick<OrderService, 'cancelByCustomer' | 'orderForCustomer'>;
  readonly checkout: Pick<CheckoutService, 'payFromWallet'>;
  readonly wallet: ResellerWebPurchaseDeps['wallet'];
  readonly audit: AuditWriter;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: Pick<IdGenerator, 'uuid'>;
}

const notFound = (): NexaError => errors.notFound(RESELLER_WEB_ERROR_CODES.NOT_FOUND, 'Not found.');
const stopped = (): NexaError =>
  errors.conflict(
    RESELLER_WEB_ERROR_CODES.UNAVAILABLE,
    'This installation has stopped accepting work.',
  );
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** «تمدید همه»: the confirmed quote no longer holds; nothing was paid. */
const termsChanged = (reason: string, details: Record<string, unknown> = {}): NexaError =>
  errors.conflict(
    COMMERCE_ERROR_CODES.RESELLER_TERMS_CHANGED,
    'The renewal no longer matches the confirmed quote.',
    { reason, ...details },
  );

/** A decided refusal: a 4xx the server chose, never a transport failure or a 5xx. */
function isRefusal(error: unknown): error is NexaError {
  return isNexaError(error) && error.httpStatus >= 400 && error.httpStatus < 500;
}

/**
 * PR-5 §5.6 — «مشتری‌ها», the reseller's clients book, and the per-service auto-renew switch.
 *
 * The book is a LABEL: it never prices, entitles or charges anything. Every read and write
 * names the owning reseller (another reseller's client is "not found"), a service is filed
 * under at most one client and only under a client of the service's OWN reseller (the
 * application checks both; the composite foreign key binds the assignment to its client's
 * owner). Clients are archived, never deleted.
 *
 * «تمدید همهٔ سرویس‌های او» renews each ACTIVE service once through the ordinary renewal (the
 * RENEW draft, `payFromWallet` → `settleFromWallet`), the total pre-checked under the wallet's
 * lock first. Auto-renew is Round 10 D1's own consent (`ServiceAutoRenewService.set`), with the
 * owner's rule for imported services: a reseller chooses the plan at opt-in.
 */
export class ResellerWebClientsService {
  constructor(private readonly deps: ResellerWebClientsDeps) {}

  /** The labels the services list draws (and the batch labels put on new services first). */
  async labelsOf(context: ResellerWebContext): Promise<ReadonlyMap<string, ClientLabel>> {
    await this.deps.purchases.applyPending(context);
    const assignments = await this.deps.repository.assignmentsOf(
      context.scope,
      context.customer.id,
    );
    if (assignments.size === 0) return new Map();
    const clients = new Map<string, ResellerClientRecord>();
    for (const archived of [false, true]) {
      for (const client of await this.deps.repository.listClients(
        context.scope,
        context.customer.id,
        { archived },
      )) {
        clients.set(client.id, client);
      }
    }
    const out = new Map<string, ClientLabel>();
    for (const [serviceId, clientId] of assignments) {
      const client = clients.get(clientId);
      if (client !== undefined) out.set(serviceId, { id: client.id, name: client.name });
    }
    return out;
  }

  async list(
    context: ResellerWebContext,
    query: { readonly archived: boolean; readonly q?: string },
  ): Promise<{ readonly items: ResellerClient[] }> {
    await this.deps.purchases.applyPending(context);
    const clients = await this.deps.repository.listClients(
      context.scope,
      context.customer.id,
      query,
    );
    const assignments = await this.deps.repository.assignmentsOf(
      context.scope,
      context.customer.id,
    );
    const services = await this.deps.services.ownList(context);
    const now = this.deps.clock.now();
    const counts = new Map<string, { services: number; expiring: number }>();
    for (const service of services) {
      const clientId = assignments.get(service.id);
      if (clientId === undefined) continue;
      const entry = counts.get(clientId) ?? { services: 0, expiring: 0 };
      entry.services += 1;
      if (isExpiring(service, now)) entry.expiring += 1;
      counts.set(clientId, entry);
    }
    return {
      items: clients.map((client) => ({
        ...clientWire(client),
        serviceCount: counts.get(client.id)?.services ?? 0,
        expiringCount: counts.get(client.id)?.expiring ?? 0,
      })),
    };
  }

  async create(context: ResellerWebContext, write: ResellerClientWrite): Promise<ResellerClient> {
    const id = this.deps.ids.uuid();
    const row = {
      id,
      customerId: context.customer.id,
      ...clean(write),
      now: this.deps.clock.now(),
    };
    await this.write(context, async (tx) => {
      await this.deps.repository.insertClient(context.scope, row, tx);
      await this.audit(
        context,
        RESELLER_SELLING_AUDIT_ACTIONS.CLIENT_CREATED,
        null,
        { clientId: id },
        tx,
      );
    });
    return this.one(context, id);
  }

  async update(
    context: ResellerWebContext,
    clientId: string,
    write: ResellerClientWrite,
  ): Promise<ResellerClient> {
    const before = await this.ownClient(context, clientId);
    await this.write(context, async (tx) => {
      const updated = await this.deps.repository.updateClient(
        context.scope,
        {
          id: before.id,
          customerId: context.customer.id,
          ...clean(write),
          now: this.deps.clock.now(),
        },
        tx,
      );
      if (!updated) throw notFound();
      await this.audit(
        context,
        RESELLER_SELLING_AUDIT_ACTIONS.CLIENT_UPDATED,
        { clientId: before.id },
        { clientId: before.id },
        tx,
      );
    });
    return this.one(context, before.id);
  }

  /** Archive, never delete: the client and its labels stay; it is no longer offered. */
  async archive(context: ResellerWebContext, clientId: string): Promise<ResellerClient> {
    const before = await this.ownClient(context, clientId);
    await this.write(context, async (tx) => {
      await this.deps.repository.archiveClient(
        context.scope,
        { id: before.id, customerId: context.customer.id, now: this.deps.clock.now() },
        tx,
      );
      await this.audit(
        context,
        RESELLER_SELLING_AUDIT_ACTIONS.CLIENT_ARCHIVED,
        { clientId: before.id },
        { archived: true },
        tx,
      );
    });
    return this.one(context, before.id);
  }

  async services(
    context: ResellerWebContext,
    clientId: string,
  ): Promise<ResellerClientServicesResponse> {
    const client = await this.ownClient(context, clientId);
    const services = await this.servicesOf(context, client.id);
    const rows = await this.deps.services.rowsOf(context, services);
    const items: ResellerClientServicesResponse['items'] = [];
    for (const [index, row] of rows.entries()) {
      items.push({
        ...row,
        autoRenew: await this.autoRenewOf(context, services[index] as ServiceRecord),
      });
    }
    return { items };
  }

  /** File a service under a client of the SAME reseller, or take it out (`clientId` null). */
  async assign(
    context: ResellerWebContext,
    serviceId: string,
    clientId: string | null,
  ): Promise<{ readonly clientId: string | null }> {
    const service = await this.deps.services.own(context, serviceId);
    const client = clientId === null ? null : await this.ownClient(context, clientId);
    if (client !== null && client.archivedAt !== null) throw notFound();
    await this.write(context, async (tx) => {
      const before = await this.deps.repository.assignedTo(context.scope, service.id, tx);
      if (client === null) {
        await this.deps.repository.unassign(
          context.scope,
          { serviceId: service.id, customerId: context.customer.id },
          tx,
        );
      } else {
        await this.deps.repository.assign(
          context.scope,
          {
            serviceId: service.id,
            clientId: client.id,
            customerId: context.customer.id,
            now: this.deps.clock.now(),
          },
          tx,
        );
      }
      await this.audit(
        context,
        client === null
          ? RESELLER_SELLING_AUDIT_ACTIONS.CLIENT_SERVICE_UNASSIGNED
          : RESELLER_SELLING_AUDIT_ACTIONS.CLIENT_SERVICE_ASSIGNED,
        { serviceId: service.id, clientId: before },
        { serviceId: service.id, clientId: client?.id ?? null },
        tx,
      );
    });
    return { clientId: client?.id ?? null };
  }

  // --- «تمدید همهٔ سرویس‌های او» -------------------------------------------------------------

  async renewAllQuote(
    context: ResellerWebContext,
    clientId: string,
  ): Promise<ResellerRenewAllQuote> {
    const client = await this.ownClient(context, clientId);
    const customerId = context.customer.id as UserId;
    const active = (await this.servicesOf(context, client.id)).filter((s) => s.state === 'ACTIVE');
    const items: ResellerRenewAllQuote['items'] = [];
    let total: Money | null = null;
    for (const service of active) {
      if (renewsFromPanelPlans(service)) {
        items.push({
          serviceId: service.id,
          username: service.providerUsername,
          price: null,
          skipped: 'PLAN_REQUIRED',
        });
        continue;
      }
      try {
        const quote = (
          await this.deps.commercial.renewalQuote(
            context.scope,
            context.actor,
            customerId,
            service.id,
          )
        ).total;
        total =
          total === null ? quote : money(total.amountMinor + quote.amountMinor, quote.currency);
        items.push({
          serviceId: service.id,
          username: service.providerUsername,
          price: toWire(quote),
          skipped: null,
        });
      } catch (error) {
        if (!isRefusal(error)) throw error;
        items.push({
          serviceId: service.id,
          username: service.providerUsername,
          price: null,
          skipped: 'NOT_AVAILABLE',
        });
      }
    }
    const balance = await this.deps.wallet.balanceOf(
      context.scope,
      customerId,
      total?.currency ?? 'IRT',
    );
    const due = total ?? money(0n, balance.currency);
    const sufficient = balance.amountMinor >= 0n && balance.amountMinor >= due.amountMinor;
    return {
      count: items.filter((item) => item.skipped === null).length,
      total: toWire(due),
      balance: toWire(money(balance.amountMinor, balance.currency)),
      sufficient,
      shortfall: sufficient
        ? null
        : toWire(money(due.amountMinor - balance.amountMinor, due.currency)),
      items,
    };
  }

  /**
   * Each ACTIVE service of the client renewed ONCE, at the price the reseller CONFIRMED: the
   * quote is honoured, never re-priced. The services renewed must be exactly the confirmed
   * ones, and each renewal drafted under `(key, service)` must cost exactly the confirmed
   * price; anything else — a service added, gone or no longer renewable, a price up or down —
   * refuses the whole renewal with `RESELLER_TERMS_CHANGED` before anything is paid. Then the
   * total is pre-checked under the wallet's lock and each order paid by the bot's wallet
   * checkout. A replay re-reads the same drafts (at the price they were drafted at); a paid one
   * is not paid again.
   */
  async renewAll(
    context: ResellerWebContext,
    clientId: string,
    confirmed: readonly { readonly serviceId: string; readonly price: Money }[],
    key: string,
  ): Promise<ResellerRenewAllResult> {
    const client = await this.ownClient(context, clientId);
    const customerId = context.customer.id as UserId;
    const agreed = new Map(confirmed.map((item) => [item.serviceId, item.price]));
    if (agreed.size !== confirmed.length) throw termsChanged('DUPLICATE_SERVICE');
    const active = (await this.servicesOf(context, client.id)).filter((s) => s.state === 'ACTIVE');
    const results = new Map<string, ResellerRenewAllResult['items'][number]>();
    const renewing: ServiceRecord[] = [];
    for (const service of active) {
      if (renewsFromPanelPlans(service)) {
        results.set(service.id, {
          serviceId: service.id,
          status: 'SKIPPED',
          reason: 'PLAN_REQUIRED',
          orderId: null,
        });
      } else {
        renewing.push(service);
      }
    }
    // The set first: nothing is drafted for a renewal the reseller did not agree to.
    if (renewing.length !== agreed.size || renewing.some((service) => !agreed.has(service.id))) {
      throw termsChanged('SERVICES_CHANGED');
    }
    const drafted: { readonly service: ServiceRecord; readonly order: OrderRecord }[] = [];
    for (const service of renewing) {
      let order: OrderRecord;
      try {
        ({ order } = await this.deps.commercial.draft(context.scope, context.actor, customerId, {
          serviceId: service.id,
          kind: 'RENEW',
          idempotencyKey: `${key}:${service.id}:draft`,
        }));
      } catch (error) {
        if (!isRefusal(error)) throw error;
        // Quoted with a price, refused now: what was agreed to can no longer be bought.
        throw termsChanged('NOT_AVAILABLE', { serviceId: service.id, refusal: error.code });
      }
      const price = agreed.get(service.id) as Money;
      const line = order.totals.total;
      if (line.currency !== price.currency || line.amountMinor !== price.amountMinor) {
        throw termsChanged('PRICE_CHANGED', { serviceId: service.id });
      }
      drafted.push({ service, order });
    }
    const total = payableTotal(drafted.map((item) => item.order));
    await this.write(context, async (tx) => {
      if (!(await this.deps.wallet.lockCustomer(context.scope, customerId, tx))) throw notFound();
      if (total !== null) {
        await assertWalletCovers(this.deps.wallet, context.scope, customerId, total, tx);
      }
      await this.audit(
        context,
        RESELLER_SELLING_AUDIT_ACTIONS.CLIENT_RENEW_ALL,
        null,
        {
          clientId: client.id,
          services: drafted.length,
          totalMinor: total?.amountMinor.toString() ?? '0',
          currency: total?.currency ?? null,
        },
        tx,
      );
    });
    for (const { service, order } of drafted) {
      results.set(service.id, await this.payRenewal(context, service, order, key));
    }
    return {
      items: active.map((service) => results.get(service.id)).filter((item) => item !== undefined),
    };
  }

  // --- auto-renew (Round 10 D1) --------------------------------------------------------------

  /**
   * «سرویس‌های من»'s page with each row's auto-renew switch, so the panel reads no switch per
   * row. The rows are the services list's own; the records are read once for the page.
   */
  async withAutoRenew(
    context: ResellerWebContext,
    listed: ResellerServicesResponse,
  ): Promise<ResellerSellingServicesResponse> {
    if (listed.items.length === 0) return { ...listed, items: [] };
    const records = new Map(
      (await this.deps.services.ownList(context)).map((service) => [service.id, service]),
    );
    const items: ResellerSellingServicesResponse['items'] = [];
    for (const row of listed.items) {
      const service = records.get(row.id) ?? (await this.deps.services.own(context, row.id));
      items.push({ ...row, autoRenew: await this.autoRenewOf(context, service) });
    }
    return { ...listed, items };
  }

  async autoRenew(context: ResellerWebContext, serviceId: string): Promise<ResellerAutoRenew> {
    return this.autoRenewOf(context, await this.deps.services.own(context, serviceId));
  }

  async setAutoRenew(
    context: ResellerWebContext,
    serviceId: string,
    input: {
      readonly enabled: boolean;
      readonly expected: Money | null;
      readonly planId: string | null;
    },
    idempotencyKey: string,
  ): Promise<ResellerAutoRenew> {
    const service = await this.deps.services.own(context, serviceId);
    try {
      await this.deps.autoRenew.set(context.scope, context.actor, context.customer.id as UserId, {
        serviceId: service.id,
        enabled: input.enabled,
        expected: input.expected,
        planId: input.planId,
        idempotencyKey,
      });
    } catch (error) {
      if (
        isNexaError(error) &&
        error.code === COMMERCE_ERROR_CODES.AUTO_RENEW_NOT_AVAILABLE &&
        (error.details as { reason?: unknown } | undefined)?.reason === 'PLAN_REQUIRED'
      ) {
        throw errors.conflict(
          RESELLER_WEB_ERROR_CODES.AUTO_RENEW_PLAN_REQUIRED,
          'Choose the plan to renew this imported service into.',
        );
      }
      throw error;
    }
    return this.autoRenewOf(context, service);
  }

  // --- helpers ------------------------------------------------------------------------------

  private async autoRenewOf(
    context: ResellerWebContext,
    service: ServiceRecord,
  ): Promise<ResellerAutoRenew> {
    const customerId = context.customer.id as UserId;
    const imported = renewsFromPanelPlans(service);
    const state = await this.deps.autoRenew.stateFor(
      context.scope,
      context.actor,
      customerId,
      service,
    );
    const base = {
      enabled: state.enabled,
      price: state.price === null ? null : toWire(state.price),
      leadHours: state.leadHours,
      imported,
      planId: state.planId,
    };
    if (state.enabled) return { ...base, offered: false, plans: [], unavailable: null };
    if (!(await this.deps.autoRenew.featureOn(context.scope))) {
      return { ...base, offered: false, plans: [], unavailable: 'FEATURE_OFF' };
    }
    if (!imported) {
      return {
        ...base,
        offered: state.offered,
        plans: [],
        unavailable: state.offered ? null : 'NOT_AVAILABLE',
      };
    }
    if (!(await this.deps.autoRenew.importedOffered(context.scope, customerId, service))) {
      return { ...base, offered: false, plans: [], unavailable: 'NOT_AVAILABLE' };
    }
    // The plans their entitlement allows on this service's panel: the renewal offer's own.
    let plans: ResellerAutoRenew['plans'] = [];
    try {
      const offer = await this.deps.commercial.offer(
        context.scope,
        context.actor,
        customerId,
        service.id,
        'RENEW',
      );
      plans = (offer.plans ?? []).flatMap((plan) =>
        plan.price === null
          ? []
          : [{ planId: plan.id, title: plan.title, price: toWire(plan.price) }],
      );
    } catch (error) {
      if (!isRefusal(error)) throw error;
    }
    return {
      ...base,
      offered: false,
      plans,
      unavailable: plans.length === 0 ? 'NOT_AVAILABLE' : 'PLAN_REQUIRED',
    };
  }

  private async payRenewal(
    context: ResellerWebContext,
    service: ServiceRecord,
    order: OrderRecord,
    key: string,
  ): Promise<ResellerRenewAllResult['items'][number]> {
    const customerId = context.customer.id as UserId;
    if (order.state === 'PAID') {
      return { serviceId: service.id, status: 'RENEWED', reason: null, orderId: order.id };
    }
    if (order.state !== 'DRAFT' && order.state !== 'AWAITING_PAYMENT') {
      return { serviceId: service.id, status: 'FAILED', reason: order.state, orderId: order.id };
    }
    try {
      const paid = await this.deps.checkout.payFromWallet(
        context.scope,
        context.actor,
        customerId,
        order,
        `${key}:${service.id}:pay`,
      );
      if (paid.outcome === 'SHORT') {
        return {
          serviceId: service.id,
          status: 'FAILED',
          reason: COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS,
          orderId: order.id,
        };
      }
      return { serviceId: service.id, status: 'RENEWED', reason: null, orderId: order.id };
    } catch (error) {
      if (!isRefusal(error)) throw error;
      const now = await this.deps.orders.orderForCustomer(context.scope, context.actor, {
        customerId,
        orderId: order.id,
      });
      if (now.state === 'AWAITING_PAYMENT') {
        try {
          await this.deps.orders.cancelByCustomer(context.scope, context.actor, {
            idempotencyKey: `${key}:${service.id}:withdraw`,
            customerId,
            orderId: order.id,
          });
        } catch (withdrawal) {
          if (!isRefusal(withdrawal)) throw withdrawal;
        }
      }
      return { serviceId: service.id, status: 'FAILED', reason: error.code, orderId: order.id };
    }
  }

  /** The reseller's own services filed under this client (a service transferred away drops out). */
  private async servicesOf(
    context: ResellerWebContext,
    clientId: string,
  ): Promise<ServiceRecord[]> {
    const assignments = await this.deps.repository.assignmentsOf(
      context.scope,
      context.customer.id,
    );
    return (await this.deps.services.ownList(context)).filter(
      (service) => assignments.get(service.id) === clientId,
    );
  }

  /** The ownership rule: this reseller's client, or not found. */
  private async ownClient(
    context: ResellerWebContext,
    clientId: string,
  ): Promise<ResellerClientRecord> {
    if (!UUID.test(clientId)) throw notFound();
    const client = await this.deps.repository.findClient(
      context.scope,
      context.customer.id,
      clientId,
    );
    if (client === null) throw notFound();
    return client;
  }

  private async one(context: ResellerWebContext, clientId: string): Promise<ResellerClient> {
    const listed = await this.list(context, { archived: false });
    const live = listed.items.find((client) => client.id === clientId);
    if (live !== undefined) return live;
    const client = await this.ownClient(context, clientId);
    return { ...clientWire(client), serviceCount: 0, expiringCount: 0 };
  }

  private async write(
    context: ResellerWebContext,
    body: (tx: TransactionScope) => Promise<void>,
  ): Promise<void> {
    await this.deps.uow.run(context.scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(context.scope, tx))) throw stopped();
      await body(tx);
    });
  }

  private async audit(
    context: ResellerWebContext,
    action: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.audit.record(
      context.scope,
      context.actor,
      {
        action,
        entityType: 'Customer',
        entityId: context.customer.id,
        before,
        after,
        result: 'SUCCESS',
      },
      tx,
    );
  }
}

function clean(write: ResellerClientWrite): {
  readonly name: string;
  readonly contact: string | null;
  readonly note: string | null;
} {
  return {
    name: write.name,
    contact: write.contact === null || write.contact.length === 0 ? null : write.contact,
    note: write.note === null || write.note.length === 0 ? null : write.note,
  };
}

function clientWire(
  client: ResellerClientRecord,
): Omit<ResellerClient, 'serviceCount' | 'expiringCount'> {
  return {
    id: client.id,
    name: client.name,
    contact: client.contact,
    note: client.note,
    archived: client.archivedAt !== null,
    createdAt: client.createdAt.toISOString(),
  };
}
