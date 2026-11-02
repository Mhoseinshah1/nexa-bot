import {
  paymentTrackingCode,
  publicCodeFromSearch,
  type ActorContext,
  type GlobalSearchHit,
  type ListSearchTerm,
  type TenantContext,
} from '@nexa/contracts';
import type { PaymentPage, PaymentRecord } from '../../payments/application/ports.js';
import type { TicketListItem } from '../../tickets/application/ports.js';
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

export interface PaymentListing {
  list(
    scope: TenantContext,
    actor: ActorContext,
    query: { readonly limit: number; readonly search: { readonly text: ListSearchTerm } },
  ): Promise<PaymentPage>;
}
export interface TicketListing {
  list(
    scope: TenantContext,
    actor: ActorContext,
    query: {
      readonly limit: number;
      readonly publicCode?: string;
      readonly number?: number;
    },
  ): Promise<readonly TicketListItem[]>;
}

/** A payment is its public tracking code; the method and amount-free subtitle tells two apart. */
export function paymentHit(record: PaymentRecord): GlobalSearchHit {
  return {
    id: record.id,
    title: paymentTrackingCode(record),
    subtitle: record.method,
    state: record.state,
  };
}

/** A ticket is «#number»; its subject (or category) tells two apart. */
export function ticketHit(item: TicketListItem): GlobalSearchHit {
  const ticket = item.ticket;
  return {
    id: ticket.id,
    title: `#${String(ticket.number)}`,
    subtitle: ticket.subject ?? ticket.categoryTitle,
    state: ticket.status,
  };
}

/**
 * Payments, by what an operator is QUOTED — the 8-character tracking code (or a reference, a
 * customer's Telegram id, a uuid: the payments list's own search, classified exactly as its `q`
 * is). The list's tenant scope and `payments.view` check are the list's.
 */
export class ListBackedPaymentSource implements GlobalSearchSource {
  constructor(private readonly payments: PaymentListing) {}
  async search(scope: TenantContext, actor: ActorContext, term: ListSearchTerm, limit: number) {
    const page = await this.payments.list(scope, actor, {
      limit: limit + 1,
      search: { text: term },
    });
    return bounded(page.items.map(paymentHit), limit);
  }
}

/**
 * Tickets, by their number («1042» or «#1042») or their 8-character public code. Only those two
 * shapes search: a customer's name is the customers kind's to find, and a ticket inbox query by
 * name would list every ticket of whoever matched.
 */
export class ListBackedTicketSource implements GlobalSearchSource {
  constructor(private readonly tickets: TicketListing) {}
  async search(scope: TenantContext, actor: ActorContext, term: ListSearchTerm, limit: number) {
    const typed = term.value.trim().replace(/^#/u, '');
    const number = /^[1-9][0-9]{0,8}$/u.test(typed) ? Number(typed) : undefined;
    const publicCode = publicCodeFromSearch(term.value) ?? undefined;
    if (number === undefined && publicCode === undefined) return { hits: [], hasMore: false };
    const items = await this.tickets.list(scope, actor, {
      limit: limit + 1,
      ...(number === undefined ? {} : { number }),
      ...(publicCode === undefined ? {} : { publicCode }),
    });
    return bounded(items.map(ticketHit), limit);
  }
}
