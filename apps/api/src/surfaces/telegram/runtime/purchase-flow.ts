// Buying a service: catalogue, custom service, draft, username, discount code, confirm, cancel.
// Moved verbatim out of bot-runtime.ts; BotRuntime keeps a forwarder for every one a router calls.
import {
  type ActorContext,
  type BotInstanceId,
  formatCustomServiceVolume,
  money,
  orderCodeOf,
  type TenantContext,
} from '@nexa/contracts';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import {
  inlineDataLabel,
  inlineLabel,
} from '../../../modules/commerce/messaging/application/inline-buttons.js';
import type { OrderRecord } from '../../../modules/commerce/orders/application/ports.js';
import { personalDiscountPercentOf } from '../../../modules/commerce/pricing/domain/pricing-engine.js';
import { personalDiscountOf } from './listed-price.js';
import type { CustomerCaptureRecord } from '../../../modules/commerce/customers/application/customer-capture-ports.js';
import {
  CANCEL_ORDER_CALLBACK_PREFIX,
  CATALOG_BROWSE_MAX_PAGE,
  CATALOG_PAGE_CALLBACK_PREFIX,
  CATEGORY_CALLBACK_PREFIX,
  CUSTOM_SERVICE_BACK_CALLBACK_DATA,
  CUSTOM_SERVICE_CALLBACK_DATA,
  CUSTOM_SERVICE_LOCATION_CALLBACK_PREFIX,
  DISCOUNT_CODE_ENTER_CALLBACK_PREFIX,
  DISCOUNT_CODE_REMOVE_CALLBACK_PREFIX,
  INPUT_BACK_CALLBACK_PREFIX,
  INPUT_CANCEL_CALLBACK_DATA,
  ORDER_CALLBACK_PREFIX,
  USERNAME_AUTOMATIC_CALLBACK_PREFIX,
  USERNAME_CUSTOM_CALLBACK_PREFIX,
  WALLET_PAY_CALLBACK_PREFIX,
} from './callbacks.js';
import { mainMenuButton } from './keyboards.js';
import { refusal } from './refusals.js';
import type { PendingReply } from './replies.js';
import { payMethodsButton } from './payment-screens.js';
import { awaitingPaymentReply, orderRouteButtons } from './checkout-flow.js';
import { cancelledOrderReply, orderEndedRefusal } from './order-end-flow.js';
import type { CardMessageRef } from '../../../modules/commerce/provisioning/application/operation-card.js';
import type { BotRuntime } from '../bot-runtime.js';

/**
 * How many products one `/catalog` answer shows.
 *
 * A BOUND, not a page. `listCatalog` reports `hasMore` and this surface drops it on the
 * floor, so a tenant with more than twenty sellable products shows twenty and says
 * nothing about the rest. That is a real limit and it is stated here rather than left to
 * be discovered: how a customer reaches a long catalogue over Telegram — a next button,
 * categories, a search — is a product decision with no evidence behind it in
 * `docs/research/`, and `docs/open-questions.md` carries it rather than this file
 * guessing. Twenty is above any catalogue the research shows.
 */
export const CATALOG_PAGE_SIZE = 20;

/**
 * How many rows one page of the CATEGORISED catalogue shows, at either level.
 *
 * A page, not a bound — unlike `CATALOG_PAGE_SIZE` above, which this browse replaces for
 * customers. Eight because a Telegram inline keyboard is read on a phone: eight rows plus
 * a navigation row fits one screen, and a page the customer has to scroll to find the
 * Next button on is a page they give up on.
 */
export const CATALOG_BROWSE_PAGE_SIZE = 8;

/**
 * The catalogue: a heading and one button per product.
 *
 * The product list cannot be interpolated into `bot.catalog.heading` — it declares no
 * placeholders, and a template is not a list renderer. So the products are BUTTONS,
 * whose labels are the tenant's own data and whose `callback_data` is the id. That is
 * also why the empty case is a different KEY rather than the same message with nothing
 * under it: `bot.catalog.empty` says why there is nothing, and an empty list reads as
 * a failure.
 */
/**
 * One page of the CATEGORY list — the first of the two steps (OQ-4B-01).
 *
 * What reaches this list is decided entirely in SQL, ahead of LIMIT/OFFSET: tenant,
 * category status and visibility, and non-emptiness by EXISTS over products that are
 * themselves listed, priced and on an eligible panel. Nothing here filters what came
 * back — §6.4 forbids fetching a page and then trimming it, which is the shape that
 * emptied this catalogue three times at three different thresholds.
 *
 * Next and Previous are drawn only when TRUE: Previous when this is not the first
 * page, Next when the query read a row beyond this one. `hasMore` is a fact about the
 * data, not an inference from a count.
 *
 * A page past the end — a stale button after categories were withdrawn — recovers to
 * the first page rather than showing an empty list with a Previous button. That is a
 * navigation recovery and selects nothing: the customer taps again from what exists.
 */
export async function catalogue(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  page: number,
  customer: CustomerRecord,
): Promise<PendingReply> {
  const { items, hasMore } = await rt.deps.products.browseCategories(
    scope,
    actor,
    CATALOG_BROWSE_PAGE_SIZE,
    page * CATALOG_BROWSE_PAGE_SIZE,
    // Whose catalogue: a reseller's tier decides what they see (WP9-B R6).
    customer.id,
  );
  /*
   * No trial here (F5). A trial is not something a customer buys or browses to: it is
   * its own main-menu action («🧪 دریافت سرویس تست», `/trial`), drawn while a panel
   * offers one. The purchase flow — categories, products, plans — sells, and only sells.
   *
   * The custom service (Package D), on the first page only: drawn when at least one
   * location could price this customer now. A courtesy — every step after the tap
   * decides again. Unlike the trial it IS a way to buy, so it stays.
   */
  /*
   * B1: the entry is the LAST item of the category list — below every category, never
   * above them — so it sits on the final page, after the categories and before the
   * paging row. Drawn where the list ends (no further page), not on page 0.
   */
  const lastPage = !hasMore || page >= CATALOG_BROWSE_MAX_PAGE;
  const trailing: CustomerButton[] = [];
  if (lastPage && (await customServiceOffered(rt, scope, actor, customer))) {
    trailing.push({
      ...inlineLabel('catalog.custom_service'),
      data: CUSTOM_SERVICE_CALLBACK_DATA,
    });
  }
  if (items.length === 0) {
    if (page > 0) return catalogue(rt, scope, actor, 0, customer);
    return { key: 'bot.catalog.empty', values: {}, buttons: trailing, orderId: null };
  }
  const buttons: CustomerButton[] = [];
  buttons.push(
    ...items.map((category) => ({
      // Operator text, exactly as a product title is. The emoji is optional and its
      // absence renders as an ordinary category — §6.1.
      ...inlineDataLabel('catalog.category', {
        kind: 'TEXT',
        text: category.emoji === null ? category.name : `${category.emoji} ${category.name}`,
      }),
      data: `${CATEGORY_CALLBACK_PREFIX}${category.id}.0`,
      // UX Batch 01, item 2: the category's own colour; the route above is unchanged.
      category: category.id,
    })),
    ...trailing,
  );
  if (page > 0) {
    buttons.push({
      ...inlineLabel('catalog.previous_page'),
      data: `${CATALOG_PAGE_CALLBACK_PREFIX}${page - 1}`,
    });
  }
  if (hasMore && page < CATALOG_BROWSE_MAX_PAGE) {
    buttons.push({
      ...inlineLabel('catalog.next_page'),
      data: `${CATALOG_PAGE_CALLBACK_PREFIX}${page + 1}`,
    });
  }
  return {
    key: 'bot.catalog.categories_heading',
    values: {},
    buttons,
    orderId: null,
    wizard: { kind: 'ORDER', step: 'CATEGORIES' },
  };
}

/** Whether to draw the custom-service button (Package D): some location prices this customer. */
export async function customServiceOffered(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
): Promise<boolean> {
  if (rt.deps.customService === undefined) return false;
  return (await rt.deps.customService.offeredLocations(scope, actor, customer.id)).length > 0;
}

/**
 * R12 F3 item 2: «🔙 بازگشت به مکان‌ها» + «انصراف» under the custom service's volume and days
 * questions. There is no pre-invoice yet at that point (the draft is made after the days), so
 * the way back is the location list; both close the open text window first.
 */
function customServiceExitButtons(): readonly CustomerButton[] {
  return [
    { ...inlineLabel('custom_service.back'), data: CUSTOM_SERVICE_BACK_CALLBACK_DATA, row: 0 },
    { ...inlineLabel('order.input_cancel'), data: INPUT_CANCEL_CALLBACK_DATA, row: 0 },
  ];
}

/** The custom-service button: the locations, each by the label the operator wrote. */
export async function customServiceMenu(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
): Promise<PendingReply> {
  const locations =
    rt.deps.customService === undefined
      ? []
      : await rt.deps.customService.offeredLocations(scope, actor, customer.id);
  if (locations.length === 0) {
    return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
  }
  return {
    key: 'bot.custom_service.locations',
    values: {},
    buttons: locations.map((location) => ({
      ...inlineDataLabel('custom_service.location', { kind: 'TEXT', text: location.label }),
      data: `${CUSTOM_SERVICE_LOCATION_CALLBACK_PREFIX}${location.panelId}`,
    })),
    orderId: null,
  };
}

/** A location was tapped: re-decided, then the volume question and its window. */
export async function customServiceLocation(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  panelId: string,
  input: { readonly idempotencyKey: string; readonly botInstanceId: BotInstanceId },
): Promise<PendingReply> {
  if (rt.deps.customService === undefined) {
    return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
  }
  const begun = await rt.deps.customService.begin(scope, actor, {
    idempotencyKey: `${input.idempotencyKey}:custom-service-volume`,
    botInstanceId: input.botInstanceId,
    customerId: customer.id,
    panelId,
  });
  if (begun.outcome === 'UNAVAILABLE') {
    return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
  }
  return {
    key: 'bot.custom_service.ask_volume',
    values: { location: begun.location.label, ...volumeRangeValues(begun.range) },
    buttons: customServiceExitButtons(),
    orderId: null,
  };
}

/**
 * A figure a custom-service window read (Package D): the volume, then the days, then
 * the draft and the ordinary username step and pre-invoice.
 */
export async function customServiceFigure(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  capture: CustomerCaptureRecord,
  text: string,
  input: { readonly idempotencyKey: string; readonly botInstanceId: BotInstanceId },
): Promise<PendingReply> {
  const flow = rt.deps.customService;
  if (flow === undefined || capture.customerId !== customer.id) {
    return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
  }
  if (capture.purpose === 'CUSTOM_SERVICE_VOLUME') {
    const volume = await flow.recordVolume(scope, actor, {
      capture,
      text,
      botInstanceId: input.botInstanceId,
    });
    if (volume.outcome === 'INVALID') {
      // B1: the wrong input is named and the allowed range repeated. No range means the
      // window is no longer one this customer can price: the one unavailable sentence.
      if (volume.range === null) {
        return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
      }
      return {
        key: 'bot.custom_service.invalid_volume',
        values: volumeRangeValues(volume.range),
        buttons: customServiceExitButtons(),
        orderId: null,
      };
    }
    if (volume.outcome === 'UNPRICED') {
      return {
        key: 'bot.custom_service.volume_unpriced',
        values: {},
        buttons: customServiceExitButtons(),
        orderId: null,
      };
    }
    if (volume.outcome === 'UNAVAILABLE') {
      return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.custom_service.ask_days',
      values: { volumeBytes: volume.volumeBytes, ...daysRangeValues(volume.range) },
      buttons: customServiceExitButtons(),
      orderId: null,
    };
  }
  try {
    const days = await flow.recordDays(scope, actor, { capture, text });
    if (days.outcome === 'INVALID') {
      if (days.range === null) {
        return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
      }
      return {
        key: 'bot.custom_service.invalid_days',
        values: daysRangeValues(days.range),
        buttons: customServiceExitButtons(),
        orderId: null,
      };
    }
    if (days.outcome === 'UNPRICED') {
      return {
        key: 'bot.custom_service.days_unpriced',
        values: {},
        buttons: customServiceExitButtons(),
        orderId: null,
      };
    }
    if (days.outcome === 'UNAVAILABLE') {
      return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
    }
    return afterDraft(
      rt,
      scope,
      actor,
      days.order,
      customer,
      input.botInstanceId,
      input.idempotencyKey,
    );
  } catch (error) {
    return refusal(error);
  }
}

/**
 * One page of the products inside one category — the second step.
 *
 * The category id comes from a button, so it may be stale: withdrawn, hidden, emptied
 * or another tenant's since the list was drawn. None of that is decided HERE. The
 * query carries the category's own status and visibility predicates and the tenant,
 * so every one of those cases reaches this handler as an empty page — and an empty
 * first page is answered with `bot.catalog.category_empty` and a way back, which is
 * the truthful outcome whichever of them it was.
 *
 * A product button carries the PRODUCT'S id. Tapping it goes through `createDraft`,
 * which re-reads the product and its category inside its own transaction and refuses
 * what is no longer orderable — so a button older than a withdrawal is refused with a
 * sentence rather than honoured, and nothing a position in this page could mean is
 * ever looked up.
 */
export async function categoryPage(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  categoryId: string,
  page: number,
  /** Whose catalogue: a reseller's tier decides what they see (WP9-B R6). */
  customerId: string,
): Promise<PendingReply> {
  const { items, hasMore } = await rt.deps.products.browseCategory(
    scope,
    actor,
    categoryId,
    CATALOG_BROWSE_PAGE_SIZE,
    page * CATALOG_BROWSE_PAGE_SIZE,
    customerId,
  );
  const back: CustomerButton = {
    ...inlineLabel('catalog.back_to_categories'),
    data: `${CATALOG_PAGE_CALLBACK_PREFIX}0`,
  };
  if (items.length === 0) {
    if (page > 0) return categoryPage(rt, scope, actor, categoryId, 0, customerId);
    return {
      key: 'bot.catalog.category_empty',
      values: {},
      buttons: [back],
      orderId: null,
      wizard: { kind: 'ORDER', step: 'PRODUCTS' },
    };
  }
  const buttons: CustomerButton[] = [];
  for (const product of items) {
    // The SQL returns only priced products; a null here would mean the read model
    // changed under this surface. Skipped rather than drawn without an amount,
    // because a plan whose price a customer cannot see is one they cannot consent to.
    if (product.price === null) continue;
    // R11 A9: the price the draft will quote when the personal discount wins it.
    const personal = product.personalDiscount;
    buttons.push({
      ...inlineDataLabel('catalog.product', {
        kind: 'TEXT',
        text: product.title,
        amount: personal === null ? product.price : personal.price,
      }),
      data: `${ORDER_CALLBACK_PREFIX}${product.id}`,
      // R4 PR-F (F2): the plan table of a rich message; an ordinary message ignores it.
      planFacts: {
        trafficBytes: product.specification.trafficBytes,
        durationDays: product.specification.durationDays,
      },
      ...personalDiscountOf(product),
    });
  }
  if (page > 0) {
    buttons.push({
      ...inlineLabel('catalog.previous_page'),
      data: `${CATEGORY_CALLBACK_PREFIX}${categoryId}.${page - 1}`,
    });
  }
  if (hasMore && page < CATALOG_BROWSE_MAX_PAGE) {
    buttons.push({
      ...inlineLabel('catalog.next_page'),
      data: `${CATEGORY_CALLBACK_PREFIX}${categoryId}.${page + 1}`,
    });
  }
  buttons.push(back);
  return {
    key: 'bot.catalog.heading',
    values: {},
    buttons,
    orderId: null,
    wizard: { kind: 'ORDER', step: 'PRODUCTS' },
  };
}

/**
 * The summary a customer confirms, with the name their service will carry.
 *
 * One builder for every path that reaches it — the draft, the two mode buttons and
 * the typed name — because the summary is the thing the customer AGREES to, and four
 * copies of it are four chances for one of them to show a figure the order does not
 * have. `username` is omitted rather than blanked when there is none: the placeholder
 * is optional, so a body that renders it simply does not, and a body a tenant
 * overrode before this step existed is unaffected.
 */
export async function preinvoice(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  order: OrderRecord,
  customer: CustomerRecord,
  username: string | null,
): Promise<PendingReply> {
  const discounted = order.totals.discount.amountMinor > 0n;
  const cashback = order.totals.quote.cashback;
  // A purchase shows the plan's allowance; an action on an existing service does not.
  const commercial = order.purpose !== 'NEW_SERVICE' && order.purpose !== 'CUSTOM_SERVICE';
  // Marketing display data for the plan being bought or renewed; a package has none.
  const display =
    order.purpose === 'ADD_TRAFFIC' ||
    order.purpose === 'ADD_TIME' ||
    order.purpose === 'ADD_DEVICES' ||
    order.purpose === 'CHANGE_LOCATION'
      ? null
      : await rt.deps.productDisplay.displayFor(scope, order.line.productId);
  // WP-A6: a paid move states from where and to where, from its frozen change request.
  const locationChange =
    order.purpose === 'CHANGE_LOCATION'
      ? await rt.deps.commercial.locationChangeFor(scope, actor, customer.id, order.id)
      : null;
  /*
   * WP-A5: an extra-users order states what it bought from its own frozen line — the
   * count, the price of one, and the limit before and after, the target being what
   * `line_device_limit` holds.
   */
  const target = order.line.specification.deviceLimit;
  const devices =
    order.purpose === 'ADD_DEVICES' && target !== null
      ? {
          quantity: order.line.quantity,
          unitPrice: order.line.unitPrice,
          currentLimit: target - order.line.quantity,
          targetLimit: target,
        }
      : null;
  const balance = await rt.deps.wallet.balanceForCustomer(scope, actor, customer.id);
  // A custom service shows what it was priced from, from the order's frozen terms.
  const custom =
    order.purpose === 'CUSTOM_SERVICE'
      ? await rt.deps.customService?.termsFor(scope, order.id)
      : undefined;
  const screen = await rt.deps.screens.preinvoice(scope, {
    // PR-C: the order's public code, the one the customer quotes and every log prints.
    orderCode: orderCodeOf(order),
    custom:
      custom === undefined || custom === null
        ? null
        : {
            location: custom.locationLabel,
            volumeBytes: custom.trafficBytes,
            pricePerGb: custom.pricePerGb,
            volumePrice: custom.volumePrice,
            durationDays: custom.durationDays,
            pricePerDay: custom.pricePerDay,
            timePrice: custom.timePrice,
          },
    devices,
    locationChange,
    serviceUsername: username,
    productName: order.line.title,
    durationDays:
      order.purpose === 'ADD_TRAFFIC' ||
      order.purpose === 'ADD_DEVICES' ||
      order.purpose === 'CHANGE_LOCATION'
        ? null
        : order.line.specification.durationDays,
    total: order.totals.total,
    trafficBytes: commercial ? null : order.line.specification.trafficBytes,
    addedTrafficBytes:
      order.purpose === 'ADD_TRAFFIC' ? order.line.specification.trafficBytes : null,
    discount: discounted
      ? {
          subtotal: order.totals.subtotal,
          discount: order.totals.discount,
          // R10 D3: the frozen quote's own decision names the personal discount.
          personalPercent: personalDiscountPercentOf(order.totals.quote),
        }
      : null,
    cashback: cashback === undefined ? null : cashback.amount,
    locations: display?.displayLocations ?? [],
    features: display?.displayFeatures ?? [],
    // B1: the one editable customer-facing description, in place of the two blocks.
    description: display?.description ?? null,
    walletBalance: money(balance.amountMinor, balance.currency),
  });
  const routes = await orderRouteButtons(rt, scope, customer.id, order.id, order.totals.total);
  return {
    key: screen.key,
    values: screen.values,
    buttons: preinvoiceButtons(order, routes.length > 0),
    orderId: order.id,
    wizard: { kind: 'ORDER', step: 'PREINVOICE', subjectId: order.id },
  };
}

/**
 * The summary again, for a draft whose quote just changed under a code.
 *
 * The username is read back rather than carried, because the code turn does not know
 * it: the window that brought the code names only the order.
 */
export async function repricedSummary(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  order: OrderRecord,
  customer: CustomerRecord,
): Promise<PendingReply> {
  const step = await rt.deps.orders.usernameStep(scope, actor, {
    customerId: customer.id,
    orderId: order.id,
  });
  return preinvoice(rt, scope, actor, order, customer, step.reservation?.username ?? null);
}

/**
 * R12 F3 item 2: the back / cancel pair under a typed-input prompt. «🔙 بازگشت به پیش‌فاکتور»
 * names the order whose pre-invoice is drawn again; «انصراف» goes to the main menu. Both close
 * the customer's open text window first (`abandonTextEntry`), so the next plain message is not
 * read as the answer to a question they left.
 */
export function inputExitButtons(orderId: string): readonly CustomerButton[] {
  return [
    { ...inlineLabel('order.input_back'), data: `${INPUT_BACK_CALLBACK_PREFIX}${orderId}`, row: 0 },
    { ...inlineLabel('order.input_cancel'), data: INPUT_CANCEL_CALLBACK_DATA, row: 0 },
  ];
}

/**
 * Closes whichever text window the customer has open (discount code, username, a custom
 * service's volume or days). Null once closed; a refusal reply when the service refuses (a
 * stopped scope, a customer who may not order) — the caller then answers THAT, not the screen.
 */
export async function abandonTextEntry(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  input: { readonly idempotencyKey: string; readonly botInstanceId: BotInstanceId },
): Promise<PendingReply | null> {
  try {
    await rt.deps.orders.abandonTextEntry(scope, actor, {
      idempotencyKey: `${input.idempotencyKey}:abandon-text`,
      botInstanceId: input.botInstanceId,
      customerId: customer.id,
    });
    return null;
  } catch (error) {
    return refusal(error);
  }
}

/** Opens the code window for one draft and asks for the code. */
export async function enterDiscountCode(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  orderId: string,
  customer: CustomerRecord,
  botInstanceId: string,
  idempotencyKey: string,
): Promise<PendingReply> {
  try {
    await rt.deps.orders.beginDiscountCodeEntry(scope, actor, {
      idempotencyKey: `${idempotencyKey}:discount-entry`,
      botInstanceId,
      customerId: customer.id,
      orderId,
    });
    return {
      key: 'bot.discount.ask',
      values: {},
      buttons: inputExitButtons(orderId),
      orderId,
      wizard: { kind: 'ORDER', step: 'DISCOUNT', subjectId: orderId },
    };
  } catch (error) {
    return refusal(error);
  }
}

/** Takes the code off a draft: the draft is re-quoted from its own snapshot. */
export async function removeDiscountCode(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  orderId: string,
  customer: CustomerRecord,
  idempotencyKey: string,
): Promise<PendingReply> {
  try {
    const order = await rt.deps.orders.applyDiscountCode(scope, actor, {
      idempotencyKey: `${idempotencyKey}:discount-remove`,
      customerId: customer.id,
      orderId,
      code: null,
    });
    return repricedSummary(rt, scope, actor, order, customer);
  } catch (error) {
    return refusal(error);
  }
}

/**
 * An ordinary message the username window did not claim. A code only if the code
 * window says so; otherwise the fallback every unrecognised message has always had.
 */
export async function typedDiscountCode(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  text: string,
  customer: CustomerRecord,
  botInstanceId: string,
  idempotencyKey: string,
): Promise<PendingReply> {
  try {
    const result = await rt.deps.orders.submitTypedDiscountCode(scope, actor, {
      idempotencyKey: `${idempotencyKey}:discount-text`,
      botInstanceId,
      customerId: customer.id,
      text,
    });
    if (result.outcome === 'NO_WINDOW') {
      return { key: 'bot.unknown_command', values: {}, buttons: [], orderId: null };
    }
    const summary = await repricedSummary(rt, scope, actor, result.order, customer);
    // R2: the wizard that asked for the code shows the re-priced pre-invoice.
    return {
      ...summary,
      wizard: {
        kind: 'ORDER',
        step: 'PREINVOICE',
        subjectId: result.order.id,
        anchor: { steps: ['DISCOUNT'], subjectId: result.order.id },
      },
    };
  } catch (error) {
    // `DISCOUNT_CODE_REJECTED` through the shared table: one sentence for every reason,
    // and the window left open by the rolled-back transaction — on ITS order's wizard.
    const refused = refusal(error);
    const orderId =
      (await rt.deps.answerWindowOrder?.(scope, botInstanceId, customer.id, 'DISCOUNT')) ?? null;
    return {
      ...refused,
      wizard: {
        kind: 'ORDER',
        step: 'DISCOUNT',
        anchor: { steps: ['DISCOUNT'], subjectId: orderId },
      },
    };
  }
}

/**
 * What to show once a draft exists: the summary, or the username question first.
 *
 * The question is skipped in two cases and both are deliberate. A name already
 * reserved — a redelivered tap, a customer who came back — goes straight to the
 * summary carrying it, because asking again would suggest the first answer did not
 * take. And a panel offering only RANDOM has no question to ask: one button is a tap
 * that teaches nothing, so the name is drawn and the summary shows it.
 *
 * A panel offering only CUSTOM still shows this screen rather than opening the
 * window unasked. The window makes an ordinary message mean something, and opening
 * one the customer did not ask for is the half of INCIDENT-FIN-001 that is about
 * surprise rather than duration.
 */
export async function afterDraft(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  order: OrderRecord,
  customer: CustomerRecord,
  botInstanceId: string,
  idempotencyKey: string,
): Promise<PendingReply> {
  const step = await rt.deps.orders.usernameStep(scope, actor, {
    customerId: customer.id,
    orderId: order.id,
  });
  if (step.reservation !== null) {
    return preinvoice(rt, scope, actor, order, customer, step.reservation.username);
  }
  if (step.modes.length === 0) return preinvoice(rt, scope, actor, order, customer, null);
  /*
   * ONE mode is not a question, whichever mode it is.
   *
   * An earlier version made an exception for CUSTOM: a single AUTOMATIC button was
   * skipped, but a single CUSTOM button was still drawn, on the reasoning that
   * opening a typing window the customer did not ask for is the surprise half of
   * INCIDENT-FIN-001. The owner overruled that, and the overruling is right — what
   * INCIDENT-FIN-001 is about is a window that outlives its question and swallows an
   * unrelated message. This window is opened BY the purchase the customer is in the
   * middle of, it names that one order, and it says in full what it is waiting for.
   *
   * What the exception actually produced was a screen offering one button, which
   * teaches the customer nothing and costs them a tap.
   */
  if (step.modes.length === 1) {
    return step.modes[0] === 'AUTOMATIC'
      ? automaticUsername(rt, scope, actor, order.id, customer, idempotencyKey)
      : customUsername(rt, scope, actor, order.id, customer, botInstanceId, idempotencyKey);
  }

  return usernameChoiceReply(order.id, step.modes);
}

/** The «choose how the name is made» screen: custom and/or automatic, for one draft. */
function usernameChoiceReply(
  orderId: string,
  modes: readonly ('CUSTOM' | 'AUTOMATIC')[],
): PendingReply {
  const buttons: CustomerButton[] = [];
  if (modes.includes('CUSTOM')) {
    buttons.push({
      ...inlineLabel('username.custom'),
      data: `${USERNAME_CUSTOM_CALLBACK_PREFIX}${orderId}`,
    });
  }
  if (modes.includes('AUTOMATIC')) {
    buttons.push({
      ...inlineLabel('username.automatic'),
      data: `${USERNAME_AUTOMATIC_CALLBACK_PREFIX}${orderId}`,
    });
  }
  return {
    key: 'bot.username.choose',
    values: {},
    buttons,
    orderId,
    wizard: { kind: 'ORDER', step: 'USERNAME', subjectId: orderId },
  };
}

/**
 * R12 F3 item 2: «🔙 بازگشت به پیش‌فاکتور» for a DRAFT purchase — the screen the customer was
 * on before the typed prompt, never one they could not pay from. A name already held (the
 * discount prompt's case) or a panel that asks for none: the pre-invoice. A name still to be
 * chosen with two ways to make one: the choice again. A name still to be chosen with ONE way
 * (typing it) has no earlier screen at all — the prompt was the first — so the answer is `'MENU'` and the caller leaves to the main menu, rather than drawing a pre-invoice
 * whose pay buttons the missing name would refuse. Null for anything but a draft purchase (the
 * caller redraws the order's own current screen). Reads only.
 */
export async function inputBack(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  orderId: string,
  customer: CustomerRecord,
): Promise<PendingReply | 'MENU' | null> {
  try {
    const order = await rt.deps.orders.orderForCustomer(scope, actor, {
      customerId: customer.id,
      orderId,
    });
    if (
      order.state !== 'DRAFT' ||
      (order.purpose !== 'NEW_SERVICE' && order.purpose !== 'CUSTOM_SERVICE')
    ) {
      return null;
    }
    const step = await rt.deps.orders.usernameStep(scope, actor, {
      customerId: customer.id,
      orderId: order.id,
    });
    if (step.reservation !== null) {
      return {
        ...(await preinvoice(rt, scope, actor, order, customer, step.reservation.username)),
        edit: true,
      };
    }
    if (step.modes.length === 0) {
      return { ...(await preinvoice(rt, scope, actor, order, customer, null)), edit: true };
    }
    // On the tapped prompt's own message: the screen the customer came from replaces it.
    return step.modes.length >= 2
      ? { ...usernameChoiceReply(order.id, step.modes), edit: true }
      : 'MENU';
  } catch (error) {
    return refusal(error);
  }
}

/** The installation draws a name, and the summary shows the one it drew. */
export async function automaticUsername(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  orderId: string,
  customer: CustomerRecord,
  idempotencyKey: string,
): Promise<PendingReply> {
  try {
    const reservation = await rt.deps.orders.chooseUsername(scope, actor, {
      idempotencyKey: `${idempotencyKey}:username`,
      customerId: customer.id,
      orderId,
      choice: { mode: 'AUTOMATIC' },
    });
    /*
     * The CUSTOMER's read, not the operator's. `get` charges `orders.view`, which a
     * customer turn does not hold — so it threw here AFTER the reservation had
     * committed, and the customer saw nothing at all.
     */
    const order = await rt.deps.orders.orderForCustomer(scope, actor, {
      customerId: customer.id,
      orderId,
    });
    return preinvoice(rt, scope, actor, order, customer, reservation.username);
  } catch (error) {
    return refusal(error);
  }
}

/**
 * Open the typing window and state the whole rule.
 *
 * The rule is sent in FULL, once, before the customer types, which is why
 * `bot.username.invalid` names no clause: a refusal that said which rule was broken
 * would add nothing they were not already told and would turn each attempt into a
 * probe of the validator.
 */
export async function customUsername(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  orderId: string,
  customer: CustomerRecord,
  botInstanceId: string,
  idempotencyKey: string,
): Promise<PendingReply> {
  try {
    await rt.deps.orders.beginUsernameEntry(scope, actor, {
      idempotencyKey: `${idempotencyKey}:username-entry`,
      botInstanceId,
      customerId: customer.id,
      orderId,
    });
    return {
      key: 'bot.username.instructions',
      values: {},
      buttons: inputExitButtons(orderId),
      orderId,
      wizard: { kind: 'ORDER', step: 'USERNAME', subjectId: orderId },
    };
  } catch (error) {
    return refusal(error);
  }
}

/**
 * An ordinary message, which is a username only if a window says so.
 *
 * `NO_WINDOW` is the answer for almost every message this bot receives, and it
 * returns the same fallback the surface has always given. That is the whole safety
 * argument for routing plain text here at all: the decision is the database's, the
 * default is unchanged, and nothing about this path can reach anything but one draft
 * order of one customer.
 */
export async function typedUsername(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  text: string,
  customer: CustomerRecord,
  botInstanceId: string,
  idempotencyKey: string,
): Promise<PendingReply> {
  try {
    const result = await rt.deps.orders.submitTypedUsername(scope, actor, {
      idempotencyKey: `${idempotencyKey}:username-text`,
      botInstanceId,
      customerId: customer.id,
      text,
    });
    if (result.outcome === 'NO_WINDOW') {
      // Not a username. Perhaps a discount code; otherwise the fallback it always got.
      return typedDiscountCode(rt, scope, actor, text, customer, botInstanceId, idempotencyKey);
    }
    // The customer's read. See `automaticUsername` for what `get` did here.
    const order = await rt.deps.orders.orderForCustomer(scope, actor, {
      customerId: customer.id,
      orderId: result.reservation.orderId,
    });
    const summary = await preinvoice(
      rt,
      scope,
      actor,
      order,
      customer,
      result.reservation.username,
    );
    // R2: the wizard that asked for the name shows the pre-invoice.
    return {
      ...summary,
      wizard: {
        kind: 'ORDER',
        step: 'PREINVOICE',
        subjectId: order.id,
        anchor: { steps: ['USERNAME'], subjectId: order.id },
      },
    };
  } catch (error) {
    /*
     * Every refusal through the shared table, and NOTHING about the window.
     *
     * The two the customer can act on — an invalid name and a taken one — leave the
     * window OPEN, because `submitTypedUsername` closes it only for an accepted
     * name, so they type another and are answered again.
     *
     * They used to be mapped by two branches here rather than in `REFUSAL_REPLIES`,
     * which meant the same refusal arriving through the AUTOMATIC path had no entry
     * at all and `refusal` rethrew it. One table for all five is what makes the two
     * paths answer alike.
     */
    /*
     * R2: shown in the wizard that asked; the window stays open, so the step does too. The
     * refusal names no order, so the open window is asked which one: with two purchases
     * open, the chat's most recently touched USERNAME wizard may be the OTHER order's.
     */
    const refused = refusal(error);
    const orderId =
      (await rt.deps.answerWindowOrder?.(scope, botInstanceId, customer.id, 'USERNAME')) ?? null;
    return {
      ...refused,
      wizard: {
        kind: 'ORDER',
        step: 'USERNAME',
        anchor: { steps: ['USERNAME'], subjectId: orderId },
      },
    };
  }
}

/** The summary a customer confirms. Every figure comes from the ORDER, never the tap. */
export async function draft(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  productId: string,
  customer: CustomerRecord,
  botInstanceId: string,
  idempotencyKey: string,
): Promise<PendingReply> {
  try {
    const order = await rt.deps.orders.createDraft(scope, actor, {
      // Suffixed, and the suffix is load-bearing. `resolveFromUpdate` already consumed
      // the bare update key in the `TELEGRAM` namespace, and presenting it again with
      // a different payload is `platform.idempotency_payload_mismatch` — the exact
      // collision `webhook.controller.ts` records for `/ping`. The update's identity is
      // still the base; this names the second command WITHIN that update.
      idempotencyKey: `${idempotencyKey}:draft`,
      customerId: customer.id,
      productId,
    });
    return afterDraft(rt, scope, actor, order, customer, botInstanceId, idempotencyKey);
  } catch (error) {
    return refusal(error);
  }
}

/**
 * DRAFT to AWAITING_PAYMENT, and the message that says what that means.
 *
 * Through the lane of the order's PURPOSE (`CheckoutService.confirmDraft`), as the mini
 * app's confirm: a renewal or a package confirmed by this tap goes through
 * `CommercialActionService.confirm` and its re-check of the service, never through the
 * new-service lane (R10 B1). A new or custom service keeps `OrderService.confirm` under the
 * same `:confirm` key as before.
 */
export async function confirm(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  orderId: string,
  customer: CustomerRecord,
  idempotencyKey: string,
): Promise<PendingReply> {
  try {
    const before = await rt.deps.orders.orderForCustomer(scope, actor, {
      customerId: customer.id,
      orderId,
    });
    const order = await rt.deps.checkout.confirmDraft(
      scope,
      actor,
      customer.id,
      before,
      idempotencyKey,
    );
    return awaitingPaymentReply(rt, scope, customer, order);
  } catch (error) {
    // R11 A11: a draft past its hold is answered ON its pre-invoice, not by a new message.
    return (await orderEndedRefusal(rt, scope, actor, customer, orderId, error)) ?? refusal(error);
  }
}

/**
 * The question between the cancel-order button and the cancellation.
 *
 * `cancelPaymentAsk` one aggregate over is the same shape and states the reasons: it
 * writes nothing, it offers the ONE button carrying the destructive prefix, and it
 * re-reads rather than trusting whichever message was tapped.
 *
 * The re-read goes through `awaitingPaymentForCustomer`, NOT `orders.get`. That one
 * is the operator's read and checks `orders.view`, which this turn does not hold —
 * a job actor holds `maintenance.run` and nothing else (see the job permission list
 * in `packages/contracts/src/permissions.ts`, named there rather than here because
 * `check:boundaries` refuses a surface that so much as mentions it) — so the first
 * version of this method refused every customer who tapped the button. Nothing
 * asserting only that the BUTTON was drawn would have noticed.
 *
 * Ownership and state are both compared against the ROW, so a customer holding
 * somebody else's order id is answered exactly as one holding an id that does not
 * exist. The cancellation re-checks both inside its own transaction; this check is
 * about not drawing a question, not about authorization.
 */
export async function cancelOrderAsk(
  rt: BotRuntime,
  scope: TenantContext,
  orderId: string,
  customer: CustomerRecord,
): Promise<PendingReply> {
  try {
    const order = await rt.deps.orders.awaitingPaymentForCustomer(scope, customer.id, orderId);
    if (order === null) {
      return { key: 'bot.order.not_awaiting_payment', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.order.cancel_confirm',
      values: {},
      buttons: [
        {
          ...inlineLabel('order.cancel_confirm'),
          data: `${CANCEL_ORDER_CALLBACK_PREFIX}${order.id}`,
        },
      ],
      orderId: order.id,
    };
  } catch (error) {
    return refusal(error);
  }
}

/**
 * The customer withdrawing their own unpaid order.
 *
 * `ORDER_MACHINE`'s `CANCEL` edge reaching a surface at last —
 * `docs/phase4h-audit.md` §3 measured that 4G made it writable and left it with no
 * caller, and `bot.order.cancelled` a frozen sentence with nowhere to be sent from.
 *
 * The reply says the ORDER is gone and says nothing about a payment, although the
 * service withdrew any pending transfer in the same transaction. That is not an
 * omission: a customer who reaches this has been told about the order, which is the
 * thing they acted on, and a second sentence about a reference they were about to
 * stop using is noise. The refusal when they HAVE claimed to pay is the case where
 * the payment matters, and it has its own key.
 */
export async function cancelOrder(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  orderId: string,
  customer: CustomerRecord,
  idempotencyKey: string,
  /** R11 A11: the confirmation question the customer tapped, removed once it is answered. */
  tapped: CardMessageRef | null = null,
): Promise<PendingReply> {
  try {
    await rt.deps.orders.cancelByCustomer(scope, actor, {
      idempotencyKey: `${idempotencyKey}:cancel-order`,
      customerId: customer.id,
      orderId,
    });
  } catch (error) {
    return refusal(error);
  }
  /*
   * R11 A11: the order is gone, and the customer is told so ON the order's own payment
   * message — edited into the cancelled screen, with re-order and the main menu — rather than
   * by a «سفارش لغو شد» under a payment screen that still offers to pay. The fallback is
   * unchanged in purpose: a customer who does not learn the order is gone keeps waiting for a
   * service that will never be made, so a rate-limited answer still reaches them by the lane.
   */
  return cancelledOrderReply(rt, scope, actor, customer, orderId, tapped);
}

function preinvoiceButtons(order: OrderRecord, routesOffered: boolean): readonly CustomerButton[] {
  return [
    {
      ...inlineLabel('payment.wallet'),
      data: `${WALLET_PAY_CALLBACK_PREFIX}${order.id}`,
    },
    ...(routesOffered ? [payMethodsButton(order.id)] : []),
    ...(order.state === 'DRAFT' &&
    (order.purpose === 'NEW_SERVICE' || order.purpose === 'CUSTOM_SERVICE')
      ? [
          order.discountCode === null
            ? {
                ...inlineLabel('discount.enter'),
                data: `${DISCOUNT_CODE_ENTER_CALLBACK_PREFIX}${order.id}`,
              }
            : {
                ...inlineLabel('discount.remove'),
                data: `${DISCOUNT_CODE_REMOVE_CALLBACK_PREFIX}${order.id}`,
              },
        ]
      : []),
    mainMenuButton(),
  ];
}

/** The one trial refusal, with the way back to the main menu. */
/** The GB bounds a custom-service volume question and its refusal quote (B1). */
export function volumeRangeValues(range: { readonly min: bigint; readonly max: bigint }): {
  minGb: string;
  maxGb: string;
} {
  return {
    minGb: formatCustomServiceVolume(range.min),
    maxGb: formatCustomServiceVolume(range.max),
  };
}

/** The day bounds a custom-service days question and its refusal quote (B1). */
export function daysRangeValues(range: { readonly min: bigint; readonly max: bigint }): {
  minDays: string;
  maxDays: string;
} {
  return { minDays: range.min.toString(), maxDays: range.max.toString() };
}
