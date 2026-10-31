import type { ActorContext, GlobalSearchHit, ListSearchTerm, TenantContext } from '@nexa/contracts';
import type { CustomerPage, CustomerRecord } from '../../customers/application/ports.js';
import type { OrderPage, OrderRecord } from '../../orders/application/ports.js';
import type { ServicePage, ServiceRecord } from '../../provisioning/application/ports.js';
import type { GlobalSearchSource, GlobalSearchSourceResult } from './global-search.service.js';

/**
 * The three sources, each over the kind's EXISTING list service (see `GlobalSearchService`). The
 * list is asked for `limit + 1` rows: the extra one only proves there is more.
 */

export interface CustomerListing {
  list(
    scope: TenantContext,
    actor: ActorContext,
    query: { readonly limit: number; readonly search: { readonly text: ListSearchTerm } },
  ): Promise<CustomerPage>;
}
export interface OrderListing {
  list(
    scope: TenantContext,
    actor: ActorContext,
    query: { readonly limit: number; readonly search: { readonly text: ListSearchTerm } },
  ): Promise<OrderPage>;
}
export interface ServiceListing {
  list(
    scope: TenantContext,
    actor: ActorContext,
    query: { readonly limit: number; readonly search: { readonly text: ListSearchTerm } },
  ): Promise<ServicePage>;
}

function bounded(items: readonly GlobalSearchHit[], limit: number): GlobalSearchSourceResult {
  return { hits: items.slice(0, limit), hasMore: items.length > limit };
}

/** A customer is called by name, else @username, else Telegram id; the rest tells two apart. */
export function customerHit(record: CustomerRecord): GlobalSearchHit {
  const name = [record.firstName, record.lastName]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(' ');
  const handle = record.username === null || record.username === '' ? null : `@${record.username}`;
  const title = name !== '' ? name : (handle ?? record.telegramUserId);
  const extra = [handle, record.telegramUserId].filter(
    (part): part is string => part !== null && part !== title,
  );
  return {
    id: record.id,
    title,
    subtitle: extra.length === 0 ? null : extra.join(' · '),
    state: record.status,
  };
}

/** An order is its public code (the product line when the code is not assigned yet). */
export function orderHit(record: OrderRecord): GlobalSearchHit {
  const code = record.code;
  return {
    id: record.id,
    title: code ?? record.line.title,
    subtitle: code === null ? null : record.line.title,
    state: record.state,
  };
}

/** A service is its public code (the panel username when the code is not assigned yet). */
export function serviceHit(record: ServiceRecord): GlobalSearchHit {
  const code = record.code;
  return {
    id: record.id,
    title: code ?? record.providerUsername,
    subtitle: code === null ? null : record.providerUsername,
    state: record.state,
  };
}

export class ListBackedCustomerSource implements GlobalSearchSource {
  constructor(private readonly customers: CustomerListing) {}
  async search(scope: TenantContext, actor: ActorContext, term: ListSearchTerm, limit: number) {
    const page = await this.customers.list(scope, actor, {
      limit: limit + 1,
      search: { text: term },
    });
    return bounded(page.items.map(customerHit), limit);
  }
}

export class ListBackedOrderSource implements GlobalSearchSource {
  constructor(private readonly orders: OrderListing) {}
  async search(scope: TenantContext, actor: ActorContext, term: ListSearchTerm, limit: number) {
    const page = await this.orders.list(scope, actor, { limit: limit + 1, search: { text: term } });
    return bounded(page.items.map(orderHit), limit);
  }
}

export class ListBackedServiceSource implements GlobalSearchSource {
  constructor(private readonly services: ServiceListing) {}
  async search(scope: TenantContext, actor: ActorContext, term: ListSearchTerm, limit: number) {
    const page = await this.services.list(scope, actor, {
      limit: limit + 1,
      search: { text: term },
    });
    return bounded(page.items.map(serviceHit), limit);
  }
}
