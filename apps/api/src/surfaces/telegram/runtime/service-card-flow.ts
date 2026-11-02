// The service-card kernel: the customer's service list, one service's card and the actions
// drawn on it that answer in place (refresh, files, link resend, suspend/resume/terminate,
// note), and the helpers every card screen shares (`ownedService`, `showWorking`,
// `cardAfterEnded`, `cardWithToast`). `BotRuntime.serviceCardFor` is the public way in.
// Moved verbatim out of bot-runtime.ts, which still re-exports every name it exported.
import { type PendingReply, toastReply, plainReply } from './replies.js';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import {
  SUPPORT_CALLBACK_DATA,
  SERVICE_CARD_CALLBACK_PREFIX,
} from '../../../modules/commerce/provisioning/application/delivery.service.js';
import {
  SERVICES_LIST_PAGE_CALLBACK_PREFIX,
  SERVICES_SEARCH_CALLBACK_DATA,
  MAIN_MENU_CALLBACK_DATA,
  SERVICE_REFRESH_CALLBACK_PREFIX,
  SERVICE_FILES_CALLBACK_PREFIX,
  SERVICE_RESEND_CALLBACK_PREFIX,
  SERVICE_ROTATE_ASK_CALLBACK_PREFIX,
  SERVICE_NOTE_CALLBACK_PREFIX,
  SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX,
  SERVICE_ADD_TIME_CALLBACK_PREFIX,
  SERVICE_RENEW_CALLBACK_PREFIX,
  SERVICE_ADD_DEVICES_CALLBACK_PREFIX,
  SERVICE_CHANGE_LOCATION_CALLBACK_PREFIX,
  SERVICE_SUSPEND_CALLBACK_PREFIX,
  SERVICE_AUTO_RENEW_ASK_CALLBACK_PREFIX,
  SERVICE_AUTO_RENEW_OFF_CALLBACK_PREFIX,
  SERVICE_RESUME_CALLBACK_PREFIX,
  SERVICE_REFUND_ASK_CALLBACK_PREFIX,
  SERVICE_TRANSFER_ASK_CALLBACK_PREFIX,
  SERVICE_SUSPEND_CONFIRM_CALLBACK_PREFIX,
  SERVICE_RESUME_CONFIRM_CALLBACK_PREFIX,
} from './callbacks.js';
import type { ServiceRecord } from '../../../modules/commerce/provisioning/application/ports.js';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import {
  SERVICE_STATUS_PRESENTATION,
  serviceDisplayStatus,
} from '../../../modules/commerce/provisioning/domain/service-display-status.js';
import {
  appearanceMarker,
  type BotInstanceId,
  type ProviderLastSeen,
  type TenantContext,
  type ActorContext,
  type UserId,
  type TemplateKey,
  type TemplateValues,
  COMMERCE_ERROR_CODES,
  type OperationState,
  SERVICE_NOTE_MAX_LENGTH,
} from '@nexa/contracts';
import type { CardMessageRef } from '../../../modules/commerce/provisioning/application/operation-card.js';
import { privateChatIdOf } from './intent-of.js';
import { callbackOriginOf } from '../wizard-state.js';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import { mainMenuButton } from './keyboards.js';
import {
  ProvisioningService,
  type CustomerServiceOperation,
  operationHasEnded,
} from '../../../modules/commerce/provisioning/application/provisioning.service.js';
import { applyServiceCardLayout } from '../service-card-layout.js';
import { displayedServiceLocation } from '../../../modules/commerce/locations/application/location-change-policy.js';
import type { ServiceLiveCheckResult } from '../../../modules/commerce/provisioning/application/service-refresh.service.js';
import { isExpectedRefreshRefusal, refusal } from './refusals.js';
import type { BotRuntime } from '../bot-runtime.js';

/**
 * Track 3 §1: the answer to opening a card whose account the panel said, twice, it does not
 * have — support, and the way back to the list. Deliberately no link, files, renew or any
 * other service action: there is nothing on the panel for them to act on, and what happens
 * to the service is an operator's decision.
 */
export function panelMissingReply(): PendingReply {
  return {
    key: 'bot.service.panel_missing',
    values: {},
    buttons: [
      { ...inlineLabel('service.support'), data: SUPPORT_CALLBACK_DATA, row: 0 },
      {
        ...inlineLabel('service.back_to_list'),
        data: `${SERVICES_LIST_PAGE_CALLBACK_PREFIX}1`,
        row: 1,
      },
    ],
    orderId: null,
  };
}

/**
 * One service's button in «سرویس‌های من» and in its search results (Batch 01 item 3).
 *
 * The label is the REAL username on the panel, as the approved list shows it (never the
 * title), after the marker of the service's DERIVED status; the colour is that status's
 * button style. Both come from the one table, `SERVICE_STATUS_PRESENTATION`, over
 * `serviceDisplayStatus` — the state, the deadline and the read usage at `now` — so the
 * list is redrawn in the right colour on every open, page turn and search, and after a
 * refresh has read new usage, with nothing stored. Owner spec §2.3: the card opens IN
 * PLACE of the list (`sv:`); its back (`sl:`) is the list again.
 */
export function serviceListButton(
  service: Pick<
    ServiceRecord,
    | 'id'
    | 'providerUsername'
    | 'state'
    | 'expiresAt'
    | 'trafficLimitBytes'
    | 'trafficUsedBytes'
    | 'usageSyncedAt'
  >,
  now: Date,
): CustomerButton {
  const shown = SERVICE_STATUS_PRESENTATION[serviceDisplayStatus({ ...service, now })];
  return {
    ...inlineLabel('services.item', {
      username: service.providerUsername,
      marker: appearanceMarker(shown.slot),
    }),
    data: `${SERVICE_CARD_CALLBACK_PREFIX}${service.id}`,
    ...(shown.buttonStyle === null ? {} : { derivedStyle: shown.buttonStyle }),
  };
}

export function backToListButton(): CustomerButton {
  return {
    ...inlineLabel('service.back_to_list'),
    data: `${SERVICES_LIST_PAGE_CALLBACK_PREFIX}1`,
  };
}

/** R3: back to the service card, drawn IN PLACE (`sv:`). */
export function backToCardButton(serviceId: string): CustomerButton {
  return {
    ...inlineLabel('service.back_to_card'),
    data: `${SERVICE_CARD_CALLBACK_PREFIX}${serviceId}`,
  };
}

/**
 * R3: the service card a tap came from — the private chat, the message's own id, and the
 * bot that drew it — or null when the update carries no such message.
 */
export function cardMessageOf(
  update: unknown,
  botInstanceId: BotInstanceId,
): CardMessageRef | null {
  const chatId = privateChatIdOf(update);
  const messageId = (update as { callback_query?: { message?: { message_id?: unknown } } } | null)
    ?.callback_query?.message?.message_id;
  if (chatId === null || typeof messageId !== 'number' || !Number.isSafeInteger(messageId)) {
    return null;
  }
  if (messageId <= 0) return null;
  /*
   * A4: a FILE message — a client app's tutorial video with the guide as its caption — has no
   * text for `editMessageText` to replace; Telegram answers 400 "there is no text in the
   * message to edit". No card there: the screen goes out as a new message, without spending
   * a request on an edit that cannot succeed.
   */
  if (callbackOriginOf(update)?.media === true) return null;
  return { botInstanceId, chatId, messageId };
}

/**
 * The way back from a screen about one service. Round N (F4): the service card drawn IN
 * PLACE (`sv:`) — every screen a card's button opens is the card's own message, so «back»
 * restores that same card rather than sending a second one. On a screen that is a message
 * of its own (the answer to a typed step), it turns that message into the card.
 */
export function backToServiceButton(serviceId: string): CustomerButton {
  return backToCardButton(serviceId);
}

/**
 * Round N (F4): a screen a service card's button opened, edited INTO the card's message
 * (`PendingReply.edit`) — the renew menu, the add-traffic and extra-users offers, the
 * location move, the note, refund and transfer prompts and their answers. A screen that
 * would be left without a single button gets the way back to the card, so the card is
 * never lost in its own message.
 *
 * A WIZARD screen is left as its own message: a quote opens the payment wizard, whose
 * message identity and step gate are R2's (`telegram_wizards`), and a card message already
 * tracked there could not be given a fresh quote in place without rewinding that state.
 */
export function inCard(serviceId: string, reply: PendingReply): PendingReply {
  if (reply.key === null || reply.wizard !== undefined) return reply;
  const lost = reply.buttons.length === 0 && reply.key !== 'bot.service.not_found';
  return { ...reply, ...(lost ? { buttons: [backToCardButton(serviceId)] } : {}), edit: true };
}

/**
 * The list's bottom controls (§G): the search pair, the pager, back to the menu. The
 * page indicator is a real button — a tap re-renders the page — and the arrows appear
 * only where there is a page to go to.
 */
export function servicesListControls(page: number, pages: number): readonly CustomerButton[] {
  const controls: CustomerButton[] = [
    {
      ...inlineLabel('services.search_label'),
      data: SERVICES_SEARCH_CALLBACK_DATA,
      row: 100,
    },
    {
      ...inlineLabel('services.search'),
      data: SERVICES_SEARCH_CALLBACK_DATA,
      row: 100,
    },
  ];
  if (page > 1) {
    controls.push({
      ...inlineLabel('services.previous_page'),
      data: `${SERVICES_LIST_PAGE_CALLBACK_PREFIX}${page - 1}`,
      row: 101,
    });
  }
  controls.push({
    ...inlineLabel('services.page', { page, pages }),
    data: `${SERVICES_LIST_PAGE_CALLBACK_PREFIX}${page}`,
    row: 101,
  });
  if (page < pages) {
    controls.push({
      ...inlineLabel('services.next_page'),
      data: `${SERVICES_LIST_PAGE_CALLBACK_PREFIX}${page + 1}`,
      row: 101,
    });
  }
  controls.push({
    ...inlineLabel('services.back_to_menu'),
    data: MAIN_MENU_CALLBACK_DATA,
    row: 102,
  });
  return controls;
}

/** The stored last-seen columns as the tri-state the composer renders. NULL is UNSUPPORTED. */
export function lastSeenOf(service: ServiceRecord): ProviderLastSeen {
  if (service.lastSeenState === 'AT' && service.lastSeenAt !== null) {
    return { kind: 'AT', at: service.lastSeenAt };
  }
  if (service.lastSeenState === 'NEVER') return { kind: 'NEVER' };
  return { kind: 'UNSUPPORTED' };
}

/**
 * The customer's own services: a heading and one button each.
 *
 * The same shape as the catalogue and for the same reason — `bot.service.list_heading`
 * declares no placeholders and a template is not a list renderer — so the services are
 * BUTTONS whose `callback_data` is the id. The empty case is a different KEY rather
 * than the heading with nothing under it, because an empty list reads as a failure
 * and `bot.service.list_empty` says what it actually is.
 *
 * `listForCustomer` takes the customer id from the RESOLVED customer row, never from
 * anything the update carried, so there is no id here for a modified client to change.
 */
export async function services(
  rt: BotRuntime,
  scope: TenantContext,
  customer: CustomerRecord,
  pageNumber: number,
): Promise<PendingReply> {
  const page = await rt.deps.services.pageForCustomer(scope, customer.id, pageNumber);
  if (page.count === 0) {
    return {
      key: 'bot.service.list_empty',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    };
  }
  const now = rt.deps.clock.now();
  const buttons: CustomerButton[] = page.items.map((service) => serviceListButton(service, now));
  buttons.push(...servicesListControls(page.page, page.pages));
  return {
    key: 'bot.service.list',
    values: { page: page.page, pages: page.pages, total: page.count },
    buttons,
    orderId: null,
  };
}

/**
 * R3 item 10: the customer's own service card, exactly as `serviceDetail` draws it, for
 * the provisioner to edit into the card a disable or enable was asked from. Null when
 * the service is not theirs to see any more (the same answer the tap would get), so
 * nothing is drawn for somebody else's service.
 */
export async function serviceCardFor(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customerId: UserId,
  serviceId: string,
  /** Round N (F4): the one-line notice the card carries, e.g. a change that did not happen. */
  notice?: TemplateKey,
): Promise<{
  readonly key: TemplateKey;
  readonly values: TemplateValues;
  readonly buttons: readonly CustomerButton[];
} | null> {
  const reply = await serviceDetail(
    rt,
    scope,
    actor,
    { id: customerId },
    serviceId,
    notice === undefined ? {} : { notice },
  );
  if (reply.key === null || reply.key === 'bot.service.not_found') return null;
  return { key: reply.key, values: reply.values, buttons: reply.buttons };
}

/**
 * One service, as its owner sees it.
 *
 * `getForCustomer` asks for the service by id AND owner in one query, so an id that is
 * not theirs, an id that does not exist, and a service a completed refund request took
 * out of their view (WP19) all arrive here as `SERVICE_NOT_FOUND` — and all answer
 * `bot.service.not_found`. Keeping them the same
 * answer is what stops this being an oracle for guessing service ids.
 *
 * The usage figure is reported WITH the moment it was read. A figure with no `asOf` is
 * a figure a customer reads as live, and `usage_synced_at` is null until the first
 * `SYNC_USAGE` succeeds — so the template gets an absent `syncedAt` rather than a
 * fabricated one, which is the whole reason that placeholder is not required.
 */
export async function serviceDetail(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: Pick<CustomerRecord, 'id'>,
  serviceId: string,
  /**
   * Round N (F4): `working` draws the card as «working» before the change it is about is
   * even planned — the tap's own answer, put on the card first so no later edit can
   * overwrite a final one — and `notice` adds one line under the status.
   */
  options: {
    readonly working?: boolean;
    readonly notice?: TemplateKey;
    /** Track 3 §1: drawn from stored figures; the status names when they were read. */
    readonly lastUpdatedAt?: Date;
  } = {},
): Promise<PendingReply> {
  const service = await ownedService(rt, scope, customer, serviceId);
  const cardExtra = {
    ...(options.notice === undefined ? {} : { notice: options.notice }),
    ...(options.lastUpdatedAt === undefined ? {} : { lastUpdatedAt: options.lastUpdatedAt }),
  };
  if (service === null) {
    return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
  }
  const title = await rt.deps.purchaseTitle(scope, service.orderId);
  if (title === null) {
    return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
  }
  /*
   * Round N (F4): a change still being applied — a disable, an enable, a new link or a
   * location move, planned, in flight or being reconciled — makes the card «working»,
   * from the operation rows, whichever message draws it. Its state is not final, so it
   * offers no action until the change has its answer; only the refresh (which redraws
   * it) and the way back to the list.
   */
  const working =
    options.working === true || (await rt.deps.services.changeInProgress(scope, service));
  if (working) {
    const buttons: CustomerButton[] = [];
    if (await rt.deps.services.customerSyncOffered(scope, service)) {
      buttons.push({
        ...inlineLabel('service.refresh'),
        data: `${SERVICE_REFRESH_CALLBACK_PREFIX}${service.id}`,
        row: 0,
      });
    }
    buttons.push({
      ...inlineLabel('service.back_to_list'),
      data: `${SERVICES_LIST_PAGE_CALLBACK_PREFIX}1`,
      row: 5,
    });
    const card = await serviceCardScreen(rt, scope, service, title, false, {
      working: true,
      ...cardExtra,
    });
    return { key: card.key, values: card.values, buttons, orderId: null };
  }

  /*
   * Every button below is a server-side decision re-decided on the tap; drawing one is
   * never the authorization. Rows: refresh alone; link beside rotate; note beside
   * add-traffic; renew beside the on/off switch; the terminate ask; back to the list.
   */
  const buttons: CustomerButton[] = [];
  if (await rt.deps.services.customerSyncOffered(scope, service)) {
    buttons.push({
      ...inlineLabel('service.refresh'),
      data: `${SERVICE_REFRESH_CALLBACK_PREFIX}${service.id}`,
      row: 0,
    });
  }
  // Package E: only where the panel's adapter can fetch its files.
  if (
    rt.deps.subscriptionFiles !== undefined &&
    (await rt.deps.subscriptionFiles.offered(scope, service))
  ) {
    buttons.push({
      ...inlineLabel('service.files'),
      data: `${SERVICE_FILES_CALLBACK_PREFIX}${service.id}`,
      row: 0,
    });
  }
  /*
   * R11 A4: on a «فقط فایل، بدون لینک ساب» panel there is no «🔗 لینک اشتراک» (no QR, no
   * copy: the link view is the only place the card showed one) and «⚙️ تغییر لینک» is
   * «⚙️ دریافت فایل‌های جدید» — the same tap, the same slot, the same rotation behind it.
   */
  const filesOnly = await rt.deps.delivery.isFilesOnly(scope, service);
  if (ProvisioningService.isDeliverable(service) && !filesOnly) {
    buttons.push({
      ...inlineLabel('service.link'),
      data: `${SERVICE_RESEND_CALLBACK_PREFIX}${service.id}`,
      row: 1,
    });
  }
  const rotation = await rt.deps.services.customerRotationFor(scope, service);
  if (rotation.offered) {
    buttons.push({
      ...inlineLabel(filesOnly ? 'service.files_new' : 'service.rotate'),
      data: `${SERVICE_ROTATE_ASK_CALLBACK_PREFIX}${service.id}`,
      row: 1,
    });
  }
  buttons.push({
    ...inlineLabel('service.note'),
    data: `${SERVICE_NOTE_CALLBACK_PREFIX}${service.id}`,
    row: 2,
  });
  const commercial = await rt.deps.commercial.availableFor(scope, actor, service);
  if (commercial.includes('ADD_TRAFFIC')) {
    buttons.push({
      ...inlineLabel('service.add_traffic'),
      data: `${SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX}${service.id}`,
      row: 2,
    });
  }
  /*
   * R5C-1 item 4: «⏳ خرید زمان اضافه», beside «➕ خرید حجم اضافه». `availableFor` includes
   * ADD_TIME only when the service, the panel and its policy allow one AND at least one
   * priced time package is on offer (`offerableAddons`), so the tap always has a list.
   */
  if (commercial.includes('ADD_TIME')) {
    buttons.push({
      ...inlineLabel('service.add_time'),
      data: `${SERVICE_ADD_TIME_CALLBACK_PREFIX}${service.id}`,
      row: 2,
    });
  }
  /*
   * The renewal menu is for renewing. With the time packages no longer a reason to open it
   * on their own (they have their button), a service whose only commercial action is time
   * is renewed from nowhere: «💊 تمدید سرویس» is drawn when a renewal is available, or when
   * the owner keeps time packages in that menu (`addon_time_in_renew_menu`, default ON).
   */
  if (
    commercial.includes('RENEW') ||
    (commercial.includes('ADD_TIME') && (await renewMenuShowsTime(rt, scope)))
  ) {
    buttons.push({
      ...inlineLabel('service.renew'),
      data: `${SERVICE_RENEW_CALLBACK_PREFIX}${service.id}`,
      row: 3,
    });
  }
  /*
   * WP-A5: extra users, on a row of their own, only where `availableFor` found every
   * condition true — a recorded limit, a panel whose adapter declares and implements
   * DEVICE_LIMIT_ADJUSTMENT, a rate that applies, and room left under its maximum. No
   * provider-name test anywhere: the capability decides.
   */
  if (commercial.includes('ADD_DEVICES')) {
    buttons.push({
      ...inlineLabel('service.add_devices'),
      data: `${SERVICE_ADD_DEVICES_CALLBACK_PREFIX}${service.id}`,
      // Its own row, drawn just below renew: an unused number is a new row where it
      // first appears, and 3 already holds renew and the on/off switch.
      row: 7,
    });
  }
  /*
   * WP-A6: «🌍 تغییر لوکیشن», on a row of its own, only where `availableFor` found every
   * condition true — an ACTIVE service, a panel whose adapter declares and implements
   * LOCATION_CHANGE, a known current location, and a configured target other than it.
   * The capability decides; no provider is named.
   */
  if (commercial.includes('CHANGE_LOCATION')) {
    buttons.push({
      ...inlineLabel('service.change_location'),
      data: `${SERVICE_CHANGE_LOCATION_CALLBACK_PREFIX}${service.id}`,
      row: 8,
    });
  }
  const actions = await rt.deps.services.customerActionsFor(scope, service);
  if (actions.includes('SUSPEND')) {
    buttons.push({
      ...inlineLabel('service.suspend'),
      data: `${SERVICE_SUSPEND_CALLBACK_PREFIX}${service.id}`,
      row: 3,
    });
  }
  if (actions.includes('RESUME')) {
    buttons.push({
      ...inlineLabel('service.resume'),
      data: `${SERVICE_RESUME_CALLBACK_PREFIX}${service.id}`,
      row: 3,
    });
  }
  // WP19: the refund request, alone on its row — it deletes the service, so it sits
  // apart from the everyday actions above it.
  if ((await rt.deps.serviceRefunds?.offeredFor(scope, service)) === true) {
    buttons.push({
      ...inlineLabel('service.refund_request'),
      data: `${SERVICE_REFUND_ASK_CALLBACK_PREFIX}${service.id}`,
      row: 4,
    });
  }
  // Package F: beside the refund request — both hand the service away for good.
  if ((await rt.deps.serviceTransfers?.offered(scope, service)) === true) {
    buttons.push({
      ...inlineLabel('service.transfer'),
      data: `${SERVICE_TRANSFER_ASK_CALLBACK_PREFIX}${service.id}`,
      row: 4,
    });
  }
  /*
   * Round 10, D1: «تمدید خودکار», on a row of its own below the hand-away pair: OFF while the
   * customer's consent is on, ON (which asks first) while the feature is on and the service
   * can be renewed automatically — a native service with a deadline whose renewal is on offer.
   */
  const autoRenew = await rt.deps.autoRenew?.switchFor(
    scope,
    customer.id,
    service,
    commercial.includes('RENEW'),
  );
  if (autoRenew === 'ENABLE' || autoRenew === 'DISABLE') {
    buttons.push({
      ...inlineLabel(
        autoRenew === 'ENABLE' ? 'service.auto_renew_enable' : 'service.auto_renew_disable',
      ),
      data: `${
        autoRenew === 'ENABLE'
          ? SERVICE_AUTO_RENEW_ASK_CALLBACK_PREFIX
          : SERVICE_AUTO_RENEW_OFF_CALLBACK_PREFIX
      }${service.id}`,
      row: 9,
    });
  }
  buttons.push({
    ...inlineLabel('service.back_to_list'),
    data: `${SERVICES_LIST_PAGE_CALLBACK_PREFIX}1`,
    row: 5,
  });

  /*
   * R11 B4: «تغییر لوکیشن باقی‌مانده: ۲ از ۳», only where location change is enabled for this
   * service and a limit is set. Read through the commercial service, which applies the same
   * state / panel / policy gates as the button and the policy's own count; it is asked even at
   * zero, where the button is already gone.
   */
  const locationChanges = await rt.deps.commercial.locationChangesLeft(scope, actor, service);
  // The card's hint names «تغییر لینک»; on a files-only panel there is no such button.
  const card = await serviceCardScreen(rt, scope, service, title, rotation.offered && !filesOnly, {
    ...cardExtra,
    locationChanges,
  });
  // R8-C3: the owner's order, rows and switches, over the buttons decided above.
  const layout = (await rt.deps.serviceCardLayout?.(scope)) ?? null;
  return {
    key: card.key,
    values: card.values,
    buttons: [...applyServiceCardLayout(buttons, layout)],
    orderId: null,
  };
}

/** The card's text: one composition for the ordinary card and the «working» one. */
export async function serviceCardScreen(
  rt: BotRuntime,
  scope: TenantContext,
  service: ServiceRecord,
  title: string,
  rotateOffered: boolean,
  extra: {
    readonly working?: boolean;
    readonly notice?: TemplateKey;
    readonly lastUpdatedAt?: Date;
    /** R11 B4: the location changes left; drawn only on the ordinary card. */
    readonly locationChanges?: { readonly remaining: number; readonly max: number } | null;
  },
): Promise<{ readonly key: TemplateKey; readonly values: TemplateValues }> {
  const display = await rt.deps.productDisplay.displayFor(scope, service.productId);
  return rt.deps.screens.serviceCard(scope, {
    state: service.state,
    serviceUsername: service.providerUsername,
    // Pre-support A6: moved label, then the CURRENT panel's initial location, then the
    // product's label — one precedence, shared with the delivery card.
    serviceLocation: displayedServiceLocation(
      service.locationLabel,
      service.locationLabel !== null
        ? null
        : ((await rt.deps.panelLocations?.initialLabelFor(scope, service.panelId)) ?? null),
      display?.serviceLocationLabel ?? null,
    ),
    productName: title,
    trafficLimitBytes: service.trafficLimitBytes,
    trafficUsedBytes: service.trafficUsedBytes,
    usageSyncedAt: service.usageSyncedAt,
    expiresAt: service.expiresAt,
    now: rt.deps.clock.now(),
    lastSeen: lastSeenOf(service),
    note: service.customerNote,
    rotateOffered,
    ...extra,
  });
}

/** The flag read once per screen; absent (a fixture without it) is on, as the menu always was. */
export async function renewMenuShowsTime(rt: BotRuntime, scope: TenantContext): Promise<boolean> {
  return (await rt.deps.renewMenuShowsTime?.(scope)) ?? true;
}

export async function serviceResend(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string,
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: BotInstanceId;
    readonly update: unknown;
  },
): Promise<PendingReply> {
  const service = await ownedService(rt, scope, customer, serviceId);
  if (service === null) {
    return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
  }
  /*
   * R11 A4: a stale «🔗 لینک اشتراک» (a message from before the panel was set to files only)
   * is answered with the FILES, never the link. `DeliveryService.deliver` refuses the link
   * view on such a panel as well, so this is the courtesy and that is the rule.
   */
  if (await rt.deps.delivery.isFilesOnly(scope, service)) {
    return serviceFiles(rt, scope, actor, customer, serviceId, input);
  }
  const chatId = privateChatIdOf(input.update);
  if (chatId === null) {
    /*
     * A tap from somewhere that is not a private chat.
     *
     * Refused with the same answer as an unknown service rather than sent to the
     * chat the service was FIRST delivered to: a subscription link is a bearer
     * capability, and delivering it anywhere other than where it was asked for is
     * how one lands in a group.
     */
    return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
  }
  /*
   * Round N (F4): «🔗 لینک اشتراک» turns the card the tap came from into the link, with a
   * way back to the card — no separate link message (`DeliveryService.showLinkOnCard`).
   * Without a card (a client that sent no message) the delivery card is sent, as before.
   */
  const card = cardMessageOf(input.update, input.botInstanceId);
  try {
    await rt.deps.delivery.redeliver(
      scope,
      service,
      customer.id,
      chatId,
      input.botInstanceId,
      // Pre-support A9: the update's key claims the QR photo under the link view, so a
      // redelivered tap shows the link again and never sends a second QR.
      card === null ? {} : { card, linkQrKey: input.idempotencyKey },
    );
    return { key: null, values: {}, buttons: [], orderId: null };
  } catch {
    // Round N (F4): with a card, the card stays as it is and the tap gets the notice.
    if (card !== null) return toastReply('bot.service.not_found');
    /*
     * Every refusal `deliver` can produce, as one customer-facing answer.
     *
     * `SERVICE_NOT_DELIVERABLE` carries a `reason` — NO_SUBSCRIPTION, SCOPE_INACTIVE,
     * SEND_IN_PROGRESS — and its own docblock says a surface maps them to a template
     * key. They are mapped to ONE here because a customer can act on none of them
     * and because the third is a race whose honest description is "try again in a
     * moment", which is what a service that answers nothing already tells them.
     * `bot.service.provisioning` is the closest true sentence for a service that has
     * no link yet and it is NOT used, because it would be wrong for the other two.
     */
    return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
  }
}

/**
 * A customer asking for their service's connection files (Package E).
 *
 * Sent only to the private chat the tap came from, for the reason `serviceResend`
 * gives: these are credentials. Ownership, state and the panel are decided again by
 * `SubscriptionFileService.send`, which sends the files itself — this handler sees a
 * count, never a file — and the one answer after them is a template key.
 */
export async function serviceFiles(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string,
  input: { readonly botInstanceId: BotInstanceId; readonly update: unknown },
): Promise<PendingReply> {
  const files = rt.deps.subscriptionFiles;
  const chatId = privateChatIdOf(input.update);
  if (files === undefined || chatId === null) {
    return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
  }
  const result = await files.send(scope, actor, {
    customerId: customer.id,
    serviceId,
    chatId,
    botInstanceId: input.botInstanceId,
  });
  switch (result.outcome) {
    case 'NOT_FOUND':
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    case 'RATE_LIMITED':
      return {
        key: 'bot.service.files_rate_limited',
        values: { seconds: result.retryAfterSeconds },
        buttons: [backToCardButton(serviceId)],
        orderId: null,
      };
    case 'UNAVAILABLE':
      return {
        key: 'bot.service.files_unavailable',
        values: {},
        buttons: [backToCardButton(serviceId)],
        orderId: null,
      };
    case 'SENT':
      return result.failed === 0
        ? { key: null, values: {}, buttons: [], orderId: null }
        : {
            key: 'bot.service.files_partial',
            values: { failed: result.failed },
            buttons: [backToCardButton(serviceId)],
            orderId: null,
          };
    case 'STOPPED':
      // Telegram declined a send part-way; a further message would meet the same answer.
      return { key: null, values: {}, buttons: [], orderId: null };
  }
}

/**
 * A customer asking for one of the two management actions on their own service.
 *
 * The TYPE is a literal chosen by which callback prefix matched, never parsed out of
 * the payload. That is the property worth stating: nothing a client sends can turn a
 * tap on "pause" into a terminate, because the only thing that crosses the boundary
 * is a service id.
 *
 * What this does is PLAN an operation. The provisioner claims it on its next tick and
 * calls the panel; this surface never touches a provider, which is why the reply says
 * the request was recorded rather than that it is done. Saying "your service is
 * paused" here would be a claim about somebody else's machine, made before anything
 * was asked of it.
 *
 * Every refusal `requestFromCustomer` can produce is answered BY NAME, and the
 * mapping is a closed list rather than a catch-all. `SERVICE_NOT_FOUND` is the same
 * answer an id that is not theirs gets. The other three — a state the action is not
 * legal from, a panel that cannot perform it, a tenant that has stopped — are one
 * sentence, because that sentence is true for all of them, none is the customer's to
 * fix, and telling them apart would describe an operator's panel to a customer.
 *
 * Anything ELSE is re-thrown, and that is the part worth stating. A catch-all here
 * would answer a database failure with "this action is not available for your
 * service" — a false statement about the customer's panel, made to hide an outage,
 * and indistinguishable from the three real refusals in every log this installation
 * keeps. The runtime's own error path exists for the unknown case.
 */
export async function serviceAction(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string,
  type: CustomerServiceOperation,
  idempotencyKey: string,
  card: CardMessageRef | null,
): Promise<PendingReply> {
  /*
   * Round N (F4): the card turns «working» on the tap — BEFORE the operation exists, so the
   * provisioner's answer (`OperationCardEditor`), which can only follow the operation, can
   * never be overwritten by this turn's loading edit. The switch is re-offered first, so a
   * tap from a keyboard that is already out of date (a second tap after the change landed)
   * redraws the card as it is, with a notice, and never flashes «working».
   */
  if (card !== null) {
    const service = await ownedService(rt, scope, customer, serviceId);
    if (service === null) return toastReply('bot.service.not_found');
    /*
     * Codex review of #116: a REDELIVERY of this very tap is decided before the card is
     * touched. Its operation already exists: open, the card already reads «working» and is
     * answered when it ends; ended, the card was answered (or the sweep answers it) — and a
     * «working» edit now would overwrite that answer with a state nothing ever clears.
     */
    if (
      (await rt.deps.services.findCustomerRequest(scope, serviceId, type, idempotencyKey)) !== null
    ) {
      return { key: null, values: {}, buttons: [], orderId: null };
    }
    if (!(await rt.deps.services.customerActionsFor(scope, service)).includes(type)) {
      return cardWithToast(
        rt,
        scope,
        actor,
        customer,
        serviceId,
        'bot.service.capability_unsupported',
      );
    }
    await showWorking(rt, scope, actor, customer, serviceId, card);
  }
  let planned;
  try {
    planned = await rt.deps.services.requestFromCustomer(
      scope,
      actor,
      customer.id,
      serviceId,
      type,
      {
        idempotencyKey,
        ...(card === null ? {} : { card }),
      },
    );
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND) {
      return card === null
        ? plainReply('bot.service.not_found')
        : cardWithToast(rt, scope, actor, customer, serviceId, 'bot.service.not_found');
    }
    const refusals: readonly unknown[] = [
      COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
      COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
      COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
    ];
    if (!refusals.includes(code)) throw error;
    // The card was turned «working» above: it is put back as it is, with the notice.
    return card === null
      ? plainReply('bot.service.capability_unsupported')
      : cardWithToast(rt, scope, actor, customer, serviceId, 'bot.service.capability_unsupported');
  }
  /*
   * R3 item 10: nothing more is sent now. The provisioner performs the disable or enable
   * and then edits THIS card — «working» since the tap — to the state it left
   * (`OperationCardEditor`); round N: a failure is answered on the card too, as the service
   * still is with the failure line. A tap with no card to edit (a client that sent no
   * message) is answered as before.
   *
   * Codex review of #116: a concurrent redelivery can pass the check above before the
   * first turn planned, then get the first turn's operation back ENDED — answered on the
   * card before this turn's «working» edit landed. The card is drawn as it now is.
   */
  if (card !== null && operationHasEnded(planned)) {
    return cardAfterEnded(rt, scope, actor, customer, serviceId, planned.state);
  }
  if (card !== null) return { key: null, values: {}, buttons: [], orderId: null };
  return { key: 'bot.service.action_requested', values: {}, buttons: [], orderId: null };
}

/**
 * B8: the question between a customer and their service's switch, in both directions.
 *
 * Plans nothing and writes nothing: it only asks, IN the card (`edit`), with the confirm
 * (`uq:` / `eq:`, the only taps that plan the operation) and a cancel that redraws the card
 * (`sv:`, which changes nothing and is safe to repeat). The switch is re-offered first, as
 * `serviceAction` re-offers it: a tap from an out-of-date keyboard gets the card as it is
 * now, with the notice, rather than a question it could not act on.
 */
export async function serviceToggleAsk(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string,
  type: 'SUSPEND' | 'RESUME',
): Promise<PendingReply> {
  const service = await ownedService(rt, scope, customer, serviceId);
  // The same notice on the button an unknown id gets from the switch itself: another
  // customer's service is indistinguishable from none.
  if (service === null) return toastReply('bot.service.not_found');
  if (!(await rt.deps.services.customerActionsFor(scope, service)).includes(type)) {
    return cardWithToast(
      rt,
      scope,
      actor,
      customer,
      serviceId,
      'bot.service.capability_unsupported',
    );
  }
  const suspend = type === 'SUSPEND';
  return {
    key: suspend ? 'bot.service.suspend_confirm' : 'bot.service.resume_confirm',
    values: { serviceUsername: service.providerUsername },
    buttons: [
      {
        ...inlineLabel(suspend ? 'service.suspend_confirm' : 'service.resume_confirm'),
        data: `${
          suspend ? SERVICE_SUSPEND_CONFIRM_CALLBACK_PREFIX : SERVICE_RESUME_CONFIRM_CALLBACK_PREFIX
        }${service.id}`,
        row: 0,
      },
      {
        ...inlineLabel('service.toggle_cancel'),
        data: `${SERVICE_CARD_CALLBACK_PREFIX}${service.id}`,
        row: 0,
      },
    ],
    orderId: null,
    edit: true,
  };
}

/**
 * Round N (F4): the service card, as «working», edited into the message a change was asked
 * from. Best effort: a card Telegram cannot edit is answered by the provisioner's own
 * fallback (the final card, sent once), so nothing here needs one.
 */
export async function showWorking(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: Pick<CustomerRecord, 'id'>,
  serviceId: string,
  card: CardMessageRef,
): Promise<void> {
  const edit = rt.deps.messenger.edit;
  if (edit === undefined) return;
  const working = await serviceDetail(rt, scope, actor, customer, serviceId, { working: true });
  if (working.key === null || working.key === 'bot.service.not_found') return;
  await edit.call(rt.deps.messenger, scope, {
    ...card,
    templateKey: working.key,
    values: working.values,
    buttons: working.buttons,
  });
}

/**
 * Codex review of #116: the card as it now is, edited in place, after a request whose
 * operation had already ENDED — with the failure line when it ended without happening.
 */
export async function cardAfterEnded(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: Pick<CustomerRecord, 'id'>,
  serviceId: string,
  state: OperationState,
): Promise<PendingReply> {
  return {
    ...(await serviceDetail(
      rt,
      scope,
      actor,
      customer,
      serviceId,
      state === 'SUCCEEDED' ? {} : { notice: 'bot.service.notice_action_failed' },
    )),
    edit: true,
  };
}

/** Round N (F4): the card as it now is, edited in place, with a short notice on the tap. */
export async function cardWithToast(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: Pick<CustomerRecord, 'id'>,
  serviceId: string,
  toast: TemplateKey,
): Promise<PendingReply> {
  const card = await serviceDetail(rt, scope, actor, customer, serviceId);
  if (card.key === 'bot.service.not_found') return toastReply(toast);
  return { ...card, edit: true, toast: { key: toast, values: {} } };
}

export async function servicesSearchBegin(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  botInstanceId: BotInstanceId,
  idempotencyKey: string,
): Promise<PendingReply> {
  await rt.deps.captures.open(scope, actor, {
    idempotencyKey: `${idempotencyKey}:search-open`,
    botInstanceId,
    customerId: customer.id,
    purpose: 'SERVICE_SEARCH',
    subjectId: null,
  });
  return {
    key: 'bot.service.search_prompt',
    values: {},
    buttons: [backToListButton()],
    orderId: null,
  };
}

/**
 * Opening a card (`s:` and `sv:`) checks the panel live before the card is drawn
 * (Track 3 §1; before it, Pre-support A2's opportunistic usage read), through
 * `ServiceRefreshService.liveCheck` — hard-bounded, cached for a short window, inside the
 * tenant's one outbound budget above the background floor. Three answers, kept apart:
 *
 * - **FRESH** (read now, or within the window): the card, as the database now holds it;
 * - **MISSING_ON_PANEL** (the panel said twice the account does not exist): NOT the card —
 *   `bot.service.panel_missing`, with support and the way back to the list, and no link,
 *   files or renewal. The tap changed nothing about the service; an operator was told;
 * - **STALE** (timeout, the panel's 429, panel down, budget spent, no proven read): the
 *   stored card with `bot.service.last_updated` naming when it was last read. Never an
 *   error, and never a toast: the failure notice belongs to the «♻️» button.
 *
 * `NOT_FOUND` is the card's own not-found answer; `NOT_READ` (a suspended service, reads
 * not offered) draws the stored card as it stands. Anything the check throws draws the
 * stored card too: an expected refusal (`isExpectedRefreshRefusal`) silently, anything
 * else reported through `logger`.
 *
 * Not for the «working» card: a service with a change still being applied is drawn
 * «working» from its operation rows, and the check is skipped.
 */
export async function openServiceCard(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string,
): Promise<PendingReply> {
  const refresh = rt.deps.serviceRefresh;
  const service = await ownedService(rt, scope, customer, serviceId);
  if (
    refresh === undefined ||
    service === null ||
    (await rt.deps.services.changeInProgress(scope, service))
  ) {
    return serviceDetail(rt, scope, actor, customer, serviceId);
  }
  let checked: ServiceLiveCheckResult | null;
  try {
    checked = await refresh.liveCheck(scope, actor, { customerId: customer.id, serviceId });
  } catch (error) {
    /*
     * A live check never costs the customer the card: whatever it threw, the stored card
     * is drawn below. An expected refusal is silent; anything else is a defect somebody
     * must see (an unreadable credential, say), so it is reported.
     */
    if (!isExpectedRefreshRefusal(error)) {
      rt.deps.logger?.error(
        { err: error, serviceId, tenantId: scope.tenantId },
        'the live read on opening a service card failed; the stored card was drawn',
      );
    }
    checked = null;
  }
  if (checked?.outcome === 'NOT_FOUND') {
    return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
  }
  if (checked?.outcome === 'MISSING_ON_PANEL') return panelMissingReply();
  if (checked?.outcome === 'STALE' || checked === null) {
    // Re-read: the row as it stands now is what the card draws, and what it was read at.
    const stored = await ownedService(rt, scope, customer, serviceId);
    const at = stored?.usageSyncedAt ?? null;
    return serviceDetail(
      rt,
      scope,
      actor,
      customer,
      serviceId,
      at === null ? {} : { lastUpdatedAt: at },
    );
  }
  return serviceDetail(rt, scope, actor, customer, serviceId);
}

export async function serviceRefresh(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string,
  idempotencyKey: string,
): Promise<PendingReply> {
  /*
   * R3 item 7: read the panel now and redraw the SAME card, or leave it untouched with a
   * short notice on the button. No «request registered», no «result later».
   */
  const refresh = rt.deps.serviceRefresh;
  if (refresh !== undefined) {
    const result = await refresh.refresh(scope, actor, { customerId: customer.id, serviceId });
    if (result.outcome === 'NOT_FOUND') return toastReply('bot.service.not_found');
    if (result.outcome === 'FAILED') return toastReply('bot.service.refresh_failed');
    return { ...(await serviceDetail(rt, scope, actor, customer, serviceId)), edit: true };
  }
  try {
    await rt.deps.services.requestSyncFromCustomer(scope, actor, customer.id, serviceId, {
      idempotencyKey: `${idempotencyKey}:refresh`,
    });
    return {
      key: 'bot.service.refresh_requested',
      values: {},
      buttons: [backToServiceButton(serviceId)],
      orderId: null,
    };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    if (
      code === COMMERCE_ERROR_CODES.ORDER_STATE_INVALID ||
      code === COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE
    ) {
      return {
        key: 'bot.service.capability_unsupported',
        values: {},
        buttons: [backToServiceButton(serviceId)],
        orderId: null,
      };
    }
    return refusal(error);
  }
}

export async function serviceNoteBegin(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string,
  botInstanceId: BotInstanceId,
  idempotencyKey: string,
): Promise<PendingReply> {
  const service = await ownedService(rt, scope, customer, serviceId);
  if (service === null) {
    return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
  }
  await rt.deps.captures.open(scope, actor, {
    idempotencyKey: `${idempotencyKey}:note-open`,
    botInstanceId,
    customerId: customer.id,
    purpose: 'SERVICE_NOTE',
    subjectId: service.id,
  });
  return {
    key: 'bot.service.note_prompt',
    values: { max: SERVICE_NOTE_MAX_LENGTH },
    buttons: [backToServiceButton(service.id)],
    orderId: null,
  };
}

/** One of the customer's own services, or null. Never anybody else's, never a throw. */
export async function ownedService(
  rt: BotRuntime,
  scope: TenantContext,
  customer: Pick<CustomerRecord, 'id'>,
  serviceId: string,
): Promise<ServiceRecord | null> {
  try {
    return await rt.deps.services.getForCustomer(scope, customer.id, serviceId);
  } catch {
    // `SERVICE_NOT_FOUND` for an id that is not theirs and one that does not exist
    // alike. Caught rather than propagated because a surface answers a customer.
    return null;
  }
}
