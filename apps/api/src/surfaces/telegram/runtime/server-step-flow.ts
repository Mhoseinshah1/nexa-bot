// V099 «انتخاب سرور در خرید»: the server step before the categories (`sales.server_selection`).
//
// A server is a panel. With the setting on and more than one server able to sell, buying is
// server → category → plan → the existing pre-invoice. With it off, or with one server, the
// entry is `catalogue` exactly as before. The plan button is the ordinary `p:<product id>`,
// so the draft, the price, the pre-invoice, payment and provisioning are untouched; this
// file only narrows what is LISTED, through `ProductService`'s own browse.
import type { ActorContext, TenantContext } from '@nexa/contracts';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import {
  inlineDataLabel,
  inlineLabel,
} from '../../../modules/commerce/messaging/application/inline-buttons.js';
import {
  CATALOG_BROWSE_MAX_PAGE,
  CUSTOM_SERVICE_CALLBACK_DATA,
  encodeServerCategory,
  SERVER_CATEGORIES_CALLBACK_PREFIX,
  SERVER_LIST_CALLBACK_PREFIX,
} from './callbacks.js';
import type { PendingReply } from './replies.js';
import {
  CATALOG_BROWSE_PAGE_SIZE,
  catalogue,
  categoryPage,
  customServiceOffered,
} from './purchase-flow.js';
import type { BotRuntime } from '../bot-runtime.js';

/**
 * The buy entry (`CATALOG`: the main-menu button, `/catalog`, «خرید سرویس» under a message).
 *
 * The setting is read first and nothing else is when it is off, so the flow without the step
 * is the one it always was, call for call.
 */
export async function buyEntry(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
): Promise<PendingReply> {
  return serverList(rt, scope, actor, 0, customer);
}

/**
 * One page of the server list.
 *
 * Skipped — the ordinary category list instead — when the setting is off (a stale `cs:` button
 * after it was turned off) or when at most one server qualifies: a choice of one is not a
 * choice. A page past the end recovers to the first, as the category list does. The custom
 * service, which chooses its own location, keeps its place as the last item of the first
 * screen, after the servers.
 */
export async function serverList(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  page: number,
  customer: CustomerRecord,
): Promise<PendingReply> {
  if (!(await rt.deps.products.serverSelectionEnabled(scope))) {
    return catalogue(rt, scope, actor, 0, customer);
  }
  const { items, hasMore } = await rt.deps.products.browseServers(
    scope,
    actor,
    CATALOG_BROWSE_PAGE_SIZE,
    page * CATALOG_BROWSE_PAGE_SIZE,
    customer.id,
  );
  if (items.length === 0 && page > 0) return serverList(rt, scope, actor, 0, customer);
  if (page === 0 && !hasMore && items.length <= 1) {
    return catalogue(rt, scope, actor, 0, customer);
  }
  const buttons: CustomerButton[] = items.map((server) => ({
    // The panel's name, as the operator wrote it — tenant data, like a category's.
    ...inlineDataLabel('catalog.server', { kind: 'TEXT', text: server.name }),
    data: `${SERVER_CATEGORIES_CALLBACK_PREFIX}${server.id}.0`,
  }));
  const lastPage = !hasMore || page >= CATALOG_BROWSE_MAX_PAGE;
  if (lastPage && (await customServiceOffered(rt, scope, actor, customer))) {
    buttons.push({
      ...inlineLabel('catalog.custom_service'),
      data: CUSTOM_SERVICE_CALLBACK_DATA,
    });
  }
  if (page > 0) {
    buttons.push({
      ...inlineLabel('catalog.previous_page'),
      data: `${SERVER_LIST_CALLBACK_PREFIX}${page - 1}`,
    });
  }
  if (hasMore && page < CATALOG_BROWSE_MAX_PAGE) {
    buttons.push({
      ...inlineLabel('catalog.next_page'),
      data: `${SERVER_LIST_CALLBACK_PREFIX}${page + 1}`,
    });
  }
  return {
    key: 'bot.catalog.servers_heading',
    values: {},
    buttons,
    orderId: null,
    wizard: { kind: 'ORDER', step: 'CATEGORIES' },
  };
}

/**
 * One page of the categories with a plan on one server. Back is the server list; a category
 * button carries the server with it, so choosing another server starts from its own
 * categories and no category of the previous one is carried over.
 *
 * A server that no longer sells (drained, archived, emptied between the taps, or a crafted
 * id) narrows to nothing in `ProductService` and is answered with the empty catalogue and the
 * way back — never with another server's categories.
 */
export async function serverCategories(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  serverId: string,
  page: number,
  customer: CustomerRecord,
): Promise<PendingReply> {
  const { items, hasMore } = await rt.deps.products.browseCategories(
    scope,
    actor,
    CATALOG_BROWSE_PAGE_SIZE,
    page * CATALOG_BROWSE_PAGE_SIZE,
    customer.id,
    serverId,
  );
  const back: CustomerButton = {
    ...inlineLabel('catalog.back_to_servers'),
    data: `${SERVER_LIST_CALLBACK_PREFIX}0`,
  };
  if (items.length === 0) {
    if (page > 0) return serverCategories(rt, scope, actor, serverId, 0, customer);
    return {
      key: 'bot.catalog.empty',
      values: {},
      buttons: [back],
      orderId: null,
      wizard: { kind: 'ORDER', step: 'CATEGORIES' },
    };
  }
  const buttons: CustomerButton[] = items.map((category) => ({
    ...inlineDataLabel('catalog.category', {
      kind: 'TEXT',
      text: category.emoji === null ? category.name : `${category.emoji} ${category.name}`,
    }),
    data: encodeServerCategory(serverId, category.id, 0),
    category: category.id,
  }));
  if (page > 0) {
    buttons.push({
      ...inlineLabel('catalog.previous_page'),
      data: `${SERVER_CATEGORIES_CALLBACK_PREFIX}${serverId}.${page - 1}`,
    });
  }
  if (hasMore && page < CATALOG_BROWSE_MAX_PAGE) {
    buttons.push({
      ...inlineLabel('catalog.next_page'),
      data: `${SERVER_CATEGORIES_CALLBACK_PREFIX}${serverId}.${page + 1}`,
    });
  }
  buttons.push(back);
  return {
    key: 'bot.catalog.categories_heading',
    values: {},
    buttons,
    orderId: null,
    wizard: { kind: 'ORDER', step: 'CATEGORIES' },
  };
}

/** One page of a category's plans on one server: `categoryPage` with the server. */
export async function serverCategory(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  serverId: string,
  categoryId: string,
  page: number,
  customer: CustomerRecord,
): Promise<PendingReply> {
  return categoryPage(rt, scope, actor, categoryId, page, customer.id, serverId);
}
