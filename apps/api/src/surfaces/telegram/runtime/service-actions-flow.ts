// The paid and operational actions on one service: renew / add traffic / add time / add
// devices, change location, rotate the link, and the quote/confirm hand-off into the order
// lane. The card itself is `service-card-flow.ts`.
// Moved verbatim out of bot-runtime.ts, which still re-exports every name it exported.
import {
  SERVICE_LOCATIONS_PER_PANEL_MAX,
  type TenantContext,
  type ActorContext,
  type Money,
  DEVICE_ADDON_MAX_QUANTITY,
  money,
  type BotInstanceId,
  COMMERCE_ERROR_CODES,
  isNexaError,
} from '@nexa/contracts';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import { type PendingReply, toastReply } from './replies.js';
import { refusal, REFUSAL_REPLIES } from './refusals.js';
import {
  SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX,
  SERVICE_BUY_TIME_CALLBACK_PREFIX,
  encodeIdPair,
  encodeDeviceQuantity,
  SERVICE_LOCATION_TARGET_CALLBACK_PREFIX,
  SERVICE_LOCATION_CONFIRM_CALLBACK_PREFIX,
  SERVICE_ROTATE_CALLBACK_PREFIX,
  SERVICE_RENEW_QUOTE_CALLBACK_PREFIX,
  SERVICE_RENEW_PLAN_CALLBACK_PREFIX,
} from './callbacks.js';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import {
  backToServiceButton,
  cardMessageOf,
  backToCardButton,
  ownedService,
  showWorking,
  cardAfterEnded,
  serviceDetail,
  renewMenuShowsTime,
} from './service-card-flow.js';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import { operationHasEnded } from '../../../modules/commerce/provisioning/application/provisioning.service.js';
import type { CardMessageRef } from '../../../modules/commerce/provisioning/application/operation-card.js';
import type { CommercialActionService } from '../../../modules/commerce/commercial/application/commercial-action.service.js';
import { preinvoice } from './purchase-flow.js';
import { awaitingPaymentReply } from './checkout-flow.js';
import type { BotRuntime } from '../bot-runtime.js';
import { listedPrice, personalDiscountOf } from './listed-price.js';

/**
 * How many targets one choice screen draws: every one a panel may hold. The admin refuses a
 * panel's 21st location (`SERVICE_LOCATIONS_PER_PANEL_MAX`), so no configured target is
 * ever cut off this screen; the slice is the bound restated, not a second quota.
 */
export const LOCATION_TARGETS_SHOWN = SERVICE_LOCATIONS_PER_PANEL_MAX;

/**
 * A customer asking for their configuration again.
 *
 * The remedy `UNCONFIRMED` and `FAILED` were designed around: an announcement whose
 * outcome was never observed leaves a customer with nothing, and until now they had
 * no way to recover it themselves. `DeliveryService.redeliver` is what sends it —
 * through the SAME `markSendStarted` stamp and the same delivery accounting the
 * automatic lane uses, so a customer-requested send and a swept one cannot race each
 * other into two messages.
 *
 * This returns `key: null`, which `handle` reads as "nothing further to send". The
 * delivery service has already sent the subscription; a second message here would be
 * the runtime and the delivery lane both answering the same tap.
 */
/**
 * The packages a customer may buy for one service, as buttons.
 *
 * A read and nothing else — no order, no row, no money. Each button carries the
 * service AND the package, because with no conversation state there is nowhere to
 * keep the first while the customer chooses the second, and neither can be inferred
 * from the other: they OWN the service and CHOOSE the package.
 *
 * The amount and the price are rendered from the row the operator configured, and
 * neither travels in the callback. What comes back is two identifiers.
 */
export async function addonChoice(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string,
  kind: 'ADD_TRAFFIC' | 'ADD_TIME',
): Promise<PendingReply> {
  let offer;
  try {
    offer = await rt.deps.commercial.offer(scope, actor, customer.id, serviceId, kind);
  } catch (error) {
    return refusal(error);
  }

  const prefix =
    kind === 'ADD_TRAFFIC' ? SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX : SERVICE_BUY_TIME_CALLBACK_PREFIX;
  return {
    key: 'bot.service.addon_choice',
    values: {},
    /*
     * Unpriced rows are dropped rather than rendered at zero.
     *
     * `listOfferable` already filters them out in SQL, so this cannot fire — and it
     * is a filter rather than a `?? zero` because `catalog.ts` says an absent price
     * means unsellable and never free. A zero here would offer a customer a package
     * for nothing, which is the one way to be wrong that money cannot be taken back
     * from.
     */
    buttons: [
      ...offer.addons
        .filter((addon): addon is typeof addon & { price: Money } => addon.price !== null)
        .map((addon) => ({
          // The VALUES the key declares. Before the customer UX completion they were
          // put on a label that carried none, so the resolver threw and the screen
          // never sent; the label type carries values now and the messenger renders
          // them. A MONEY value, so the currency is the catalogue's, never typed.
          // R11 A9: the price its quote charges when the personal discount wins it.
          ...inlineLabel('service.addon_option', {
            title: addon.title,
            price: listedPrice(addon),
          }),
          data: `${prefix}${encodeIdPair(serviceId, addon.id)}`,
          ...personalDiscountOf(addon),
        })),
      backToServiceButton(serviceId),
    ],
    orderId: null,
  };
}

/**
 * The extra users / devices offer for one service, as quantity buttons (WP-A5).
 *
 * A read and nothing else — no order, no row, no money. The current limit, the price of
 * one and how many more may be bought all come from `CommercialActionService.offer`,
 * which refuses for every reason the purchase would. Each button carries the service,
 * the rate and a count within what the server said remains; its label shows that
 * count's list price, and the quote screen the next tap produces states the final one.
 */
export async function devicesChoice(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string,
): Promise<PendingReply> {
  let offer;
  try {
    offer = await rt.deps.commercial.offer(scope, actor, customer.id, serviceId, 'ADD_DEVICES');
  } catch (error) {
    return refusal(error);
  }
  const devices = offer.devices;
  if (devices === null) {
    return { key: 'bot.service.action_unavailable', values: {}, buttons: [], orderId: null };
  }
  const shown = Math.min(devices.remaining, DEVICE_ADDON_MAX_QUANTITY);
  const unit = devices.addon.price;
  const buttons: CustomerButton[] = [];
  for (let quantity = 1; quantity <= shown; quantity += 1) {
    buttons.push({
      ...inlineLabel('service.devices_option', {
        quantity,
        price: money(unit.amountMinor * BigInt(quantity), unit.currency),
      }),
      data: encodeDeviceQuantity(serviceId, devices.addon.id, quantity),
      // Two to a row, so a maximum of twenty stays a readable keyboard.
      row: Math.floor((quantity - 1) / 2),
    });
  }
  buttons.push({ ...backToServiceButton(serviceId), row: Math.ceil(shown / 2) });
  return {
    key: 'bot.service.devices_choice',
    values: {
      currentLimit: devices.currentLimit,
      unitPrice: unit,
      remaining: devices.remaining,
    },
    buttons,
    orderId: null,
  };
}

/**
 * Where the service is and where it may be moved (WP-A6), as one button per target.
 *
 * A read and nothing else. The current location, the targets and their list prices all
 * come from `CommercialActionService.offer`, which refuses for every reason a move
 * would; each button carries the service and the configured location, never a price.
 */
export async function locationChoice(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string,
): Promise<PendingReply> {
  let offer;
  try {
    offer = await rt.deps.commercial.offer(scope, actor, customer.id, serviceId, 'CHANGE_LOCATION');
  } catch (error) {
    return refusal(error);
  }
  const locations = offer.locations ?? null;
  if (locations === null) {
    return { key: 'bot.service.action_unavailable', values: {}, buttons: [], orderId: null };
  }
  const shown = locations.targets.slice(0, LOCATION_TARGETS_SHOWN);
  const buttons: CustomerButton[] = shown.map((target, index) => ({
    ...(target.price.amountMinor === 0n
      ? inlineLabel('service.location_option_free', { location: target.label })
      : inlineLabel('service.location_option', { location: target.label, price: target.price })),
    data: `${SERVICE_LOCATION_TARGET_CALLBACK_PREFIX}${encodeIdPair(serviceId, target.id)}`,
    row: index,
  }));
  buttons.push({ ...backToServiceButton(serviceId), row: shown.length });
  // R11 B4: the remaining line comes from the offer's own evaluation, never a second count.
  const screen = await rt.deps.screens.locationChoice(scope, {
    currentLocation: locations.current.label,
    locationChanges: locations.remaining,
  });
  return { key: 'bot.service.location_choice', values: screen.values, buttons, orderId: null };
}

/**
 * A target tapped (WP-A6): its impact and price, and the way to confirm.
 *
 * Decided on the server first — not offered, already there, cooldown, limit and the
 * panel are each refused with their own sentence before anything is shown. A FREE move
 * then asks for an explicit confirmation (`lf:`) and writes nothing yet; a PRICED one
 * becomes the ordinary quote — the pre-invoice with its from / to block and the same
 * confirmation and payment buttons every commercial order uses.
 */
export async function locationTarget(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string,
  locationId: string,
  input: { readonly idempotencyKey: string },
): Promise<PendingReply> {
  let decided;
  try {
    decided = await rt.deps.commercial.locationTarget(
      scope,
      actor,
      customer.id,
      serviceId,
      locationId,
    );
  } catch (error) {
    return refusal(error);
  }
  if (decided.target.price.amountMinor !== 0n) {
    return commercialQuote(
      rt,
      scope,
      actor,
      customer,
      serviceId,
      'CHANGE_LOCATION',
      null,
      input,
      undefined,
      locationId,
    );
  }
  return {
    key: 'bot.service.location_confirm_free',
    values: { fromLocation: decided.current.label, toLocation: decided.target.label },
    buttons: [
      {
        ...inlineLabel('service.location_confirm'),
        data: `${SERVICE_LOCATION_CONFIRM_CALLBACK_PREFIX}${encodeIdPair(serviceId, locationId)}`,
        row: 0,
      },
      { ...backToServiceButton(serviceId), row: 1 },
    ],
    orderId: null,
  };
}

/**
 * A free move, confirmed (WP-A6). `LocationChangeService.requestFree` decides everything
 * again in its own transaction and plans the operation.
 *
 * FIX-08: confirmed on the service card, it is answered ON that card, the way a disable is
 * (`serviceAction`): the card turns «working» on the tap, the move is planned with the card
 * recorded beside it, and `OperationCardEditor` edits the same card to the service as it
 * now is — the new location — or back as it was with the failure line. No «ثبت شد» now and
 * no separate «انجام شد» later. Without a card (a client that sent no message) the customer
 * is told it was recorded, and its outcome later through the notification lane, as before.
 *
 * `idempotencyKey` is the update's, so Telegram redelivering the tap requests it once — and
 * a redelivery is recognised BEFORE the card is touched, so it never turns a card that
 * already shows the outcome back to «working».
 */
export async function locationRequest(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string,
  locationId: string,
  input: {
    readonly idempotencyKey: string;
    readonly update?: unknown;
    readonly botInstanceId?: BotInstanceId;
  },
): Promise<PendingReply> {
  const changes = rt.deps.locationChanges;
  if (changes === undefined) {
    return { key: 'bot.service.action_unavailable', values: {}, buttons: [], orderId: null };
  }
  const request = {
    serviceId,
    locationId,
    idempotencyKey: `${input.idempotencyKey}:change_location`,
  };
  const card =
    input.botInstanceId === undefined || changes.freeRequestRecorded === undefined
      ? null
      : cardMessageOf(input.update, input.botInstanceId);
  if (card !== null) {
    if (await changes.freeRequestRecorded?.(scope, customer.id, request)) {
      return { key: null, values: {}, buttons: [], orderId: null };
    }
    const service = await ownedService(rt, scope, customer, serviceId);
    if (service === null) return toastReply('bot.service.not_found');
    await showWorking(rt, scope, actor, customer, serviceId, card);
  }
  let requested;
  try {
    requested = await changes.requestFree(scope, actor, customer.id, {
      ...request,
      ...(card === null ? {} : { card }),
    });
  } catch (error) {
    return refusal(error);
  }
  /*
   * Codex review of #257, as `serviceAction`: a concurrent redelivery can pass the check
   * above before the first delivery recorded the move, and its «working» edit can land
   * after the move ENDED and was drawn on the card. Its request replays the first one's,
   * so the move's operation is read back by its change and, once ended, the card is drawn
   * as it now is rather than left «working».
   */
  if (card !== null) {
    const operation = await rt.deps.services.findLocationChange(
      scope,
      serviceId,
      requested.changeId,
    );
    if (operation !== null && operationHasEnded(operation)) {
      return cardAfterEnded(rt, scope, actor, customer, serviceId, operation.state);
    }
  }
  // FIX-08: the card reads «working» and is answered when the move ends.
  if (card !== null) return { key: null, values: {}, buttons: [], orderId: null };
  return {
    key: 'bot.service.location_requested',
    values: {},
    buttons: [backToServiceButton(serviceId)],
    orderId: null,
  };
}

/**
 * The quote a customer answers: what this action buys, and what it costs.
 *
 * It writes a DRAFT order and its invoice line — both in one transaction — and
 * commits the customer to nothing. The number shown is the number the order was
 * written with, and it is never re-taken: confirming re-checks that the service and
 * the package are still eligible and leaves the price exactly as the customer saw it.
 *
 * `idempotencyKey` is the update's, so Telegram redelivering the same tap produces
 * the same draft rather than a second one.
 */
export async function commercialQuote(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string,
  kind: 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME' | 'ADD_DEVICES' | 'CHANGE_LOCATION',
  addonId: string | null,
  input: { readonly idempotencyKey: string },
  /** WP-A5: the extra-users count a `dq:` tap chose; absent for every other kind. */
  quantity?: number,
  /** WP-A6: the configured location an `lt:` tap chose; absent for every other kind. */
  locationId?: string,
  /** Owner rule 2026-10-18: the panel plan an `rq:` tap chose; absent for every other kind. */
  planId?: string,
): Promise<PendingReply> {
  try {
    const service = await ownedService(rt, scope, customer, serviceId);
    if (service === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    const { order } = await rt.deps.commercial.draft(scope, actor, customer.id, {
      serviceId,
      kind,
      ...(addonId === null ? {} : { addonId }),
      ...(quantity === undefined ? {} : { quantity }),
      ...(locationId === undefined ? {} : { locationId }),
      ...(planId === undefined ? {} : { productId: planId }),
      idempotencyKey: `${input.idempotencyKey}:${kind.toLowerCase()}`,
    });
    // The same pre-invoice and the same payment buttons as a new purchase (§H5, §H6):
    // one payment UX, and the username shown is the service's own.
    return preinvoice(rt, scope, actor, order, customer, service.providerUsername);
  } catch (error) {
    return refusal(error);
  }
}

/**
 * The customer answering the quote: DRAFT to AWAITING_PAYMENT, then the payment
 * buttons.
 *
 * The same two steps a product purchase takes, and deliberately the same screen after
 * them — `paymentButtons` is shared, so wallet and manual transfer work on a
 * commercial order without knowing it is one.
 */
export async function commercialConfirm(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  orderId: string,
  input: { readonly idempotencyKey: string },
): Promise<PendingReply> {
  try {
    const order = await rt.deps.commercial.confirm(scope, actor, customer.id, {
      orderId,
      idempotencyKey: `${input.idempotencyKey}:action_confirm`,
    });
    return awaitingPaymentReply(rt, scope, customer, order);
  } catch (error) {
    return refusal(error);
  }
}

/**
 * The screen between a customer and a new subscription link (WP6-C).
 *
 * Plans nothing and writes nothing: it only asks. The offer is re-read
 * rather than trusted from the message that was tapped, and the cooldown shown is the
 * setting as it stands now. The sentence says a new link will be issued and has to be
 * put into the customer's apps; it says nothing about the old one (OQ-RP-07).
 */
export async function serviceRotateAsk(
  rt: BotRuntime,
  scope: TenantContext,
  customer: CustomerRecord,
  serviceId: string,
): Promise<PendingReply> {
  const service = await ownedService(rt, scope, customer, serviceId);
  if (service === null) {
    return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
  }
  const offer = await rt.deps.services.customerRotationFor(scope, service);
  if (!offer.offered) {
    return { key: 'bot.service.capability_unsupported', values: {}, buttons: [], orderId: null };
  }
  /*
   * R3 item 9: the question replaces the card in place, with a way back to it; the
   * confirmation then puts the card back (`serviceRotate`), so the change of link is
   * one message throughout rather than a new one per step.
   */
  // R11 A4: on a files-only panel the same question is about new FILES, never a link.
  const filesOnly = await rt.deps.delivery.isFilesOnly(scope, service);
  return {
    key: filesOnly ? 'bot.service.files_new_ask' : 'bot.service.rotate_ask',
    values: { cooldownHours: offer.cooldownHours },
    buttons: [
      {
        ...inlineLabel(filesOnly ? 'service.files_new_confirm' : 'service.rotate_confirm'),
        data: `${SERVICE_ROTATE_CALLBACK_PREFIX}${service.id}`,
        row: 0,
      },
      { ...backToCardButton(service.id), row: 1 },
    ],
    orderId: null,
    edit: true,
  };
}

/**
 * A customer confirms a new subscription link for their own service (WP6-C).
 *
 * `requestRotation` decides everything, inside its transaction; this answers each of
 * its refusals BY NAME from a closed list and re-throws anything else, for the reason
 * `serviceAction` gives. The cooldown is the one refusal with a value in it: the
 * instant another rotation will be accepted, read from the refusal rather than
 * computed here, so the sentence is the server's answer.
 */
export async function serviceRotate(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string,
  idempotencyKey: string,
  /** Round N (F4): the card the confirmation was tapped on — answered on it. */
  card: CardMessageRef | null = null,
): Promise<PendingReply> {
  /*
   * Round N (F4): the card reads «working» from the confirmation until the panel has
   * answered — put there BEFORE the rotation is planned, for the reason `serviceAction`
   * gives. The new link then lands on this same card (`DeliveryService.sendRotated`), a
   * failure puts the card back with its notice (`OperationCardEditor`), and a refusal
   * below is edited over it.
   */
  if (card !== null) {
    const service = await ownedService(rt, scope, customer, serviceId);
    // Codex review of #116: a redelivered confirmation leaves the card to its answer.
    if (
      service !== null &&
      (await rt.deps.services.findCustomerRequest(
        scope,
        serviceId,
        'ROTATE_SUBSCRIPTION',
        idempotencyKey,
      )) !== null
    ) {
      return { key: null, values: {}, buttons: [], orderId: null };
    }
    if (service !== null && (await rt.deps.services.customerRotationFor(scope, service)).offered) {
      await showWorking(rt, scope, actor, customer, serviceId, card);
    }
  }
  let planned;
  try {
    planned = await rt.deps.services.requestRotation(scope, actor, customer.id, serviceId, {
      idempotencyKey,
      ...(card === null ? {} : { card }),
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null, edit: true };
    }
    if (code === COMMERCE_ERROR_CODES.SERVICE_ROTATION_COOLDOWN) {
      const at = (error as { details?: Readonly<Record<string, unknown>> }).details?.[
        'availableAt'
      ];
      if (typeof at === 'string') {
        const owned = await ownedService(rt, scope, customer, serviceId);
        const filesOnly = owned !== null && (await rt.deps.delivery.isFilesOnly(scope, owned));
        return {
          key: filesOnly ? 'bot.service.files_new_cooldown' : 'bot.service.rotate_cooldown',
          values: { availableAt: new Date(at) },
          buttons: [backToCardButton(serviceId)],
          orderId: null,
          edit: true,
        };
      }
      throw error;
    }
    if (code === COMMERCE_ERROR_CODES.CUSTOMER_BLOCKED) {
      return { key: 'bot.blocked', values: {}, buttons: [], orderId: null, edit: true };
    }
    const refusals: readonly unknown[] = [
      COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
      COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
      COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
      COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
      // WP-A6: a location move in flight refuses a rotation; the card is put back.
      COMMERCE_ERROR_CODES.SERVICE_ACTION_IN_PROGRESS,
    ];
    if (!refusals.includes(code)) throw error;
    return {
      key: 'bot.service.capability_unsupported',
      values: {},
      buttons: [backToCardButton(serviceId)],
      orderId: null,
      edit: true,
    };
  }
  /*
   * R3 item 9: no «request registered» message, and never «service created». Round N
   * (F4): with a card, it already reads «working» and nothing more is sent now — the new
   * link lands on it (then the files, as an album), or it comes back with the failure
   * notice. Without one (a client that sent no message), the card is drawn as before.
   * A concurrent redelivery that got the operation back ENDED draws the card as it is
   * (Codex review of #116, as `serviceAction`).
   */
  if (card !== null && operationHasEnded(planned)) {
    return cardAfterEnded(rt, scope, actor, customer, serviceId, planned.state);
  }
  if (card !== null) return { key: null, values: {}, buttons: [], orderId: null };
  return { ...(await serviceDetail(rt, scope, actor, customer, serviceId)), edit: true };
}

/**
 * «💊 تمدید سرویس»: the renewal (the product re-priced at its current terms) and the
 * add-time packages, on one screen. Each option is re-decided by the quote it opens.
 */
export async function renewMenu(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string,
): Promise<PendingReply> {
  const service = await ownedService(rt, scope, customer, serviceId);
  if (service === null) {
    return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
  }
  const offered = await rt.deps.commercial.availableFor(scope, actor, service);
  const buttons: CustomerButton[] = [];
  // Owner rule 2026-10-18: an imported service renews from its panel's current plans.
  let panelPlans: number | null = null;
  if (offered.includes('RENEW')) {
    const renewal = await offerOrNull(rt, scope, actor, customer, service.id, 'RENEW');
    const product = renewal?.product ?? null;
    // R11 A9: each line at the price its quote charges when the personal discount wins it.
    if (product !== null && product.price !== null) {
      buttons.push({
        ...inlineLabel('service.renew_option', {
          title: product.title,
          price: listedPrice({ ...product, price: product.price }),
        }),
        data: `${SERVICE_RENEW_QUOTE_CALLBACK_PREFIX}${service.id}`,
        ...personalDiscountOf(product),
      });
    }
    if (renewal?.plans !== undefined) {
      panelPlans = 0;
      for (const plan of renewal.plans) {
        if (plan.price === null) continue;
        panelPlans += 1;
        buttons.push({
          ...inlineLabel('service.renew_option', {
            title: plan.title,
            price: listedPrice({ ...plan, price: plan.price }),
          }),
          data: `${SERVICE_RENEW_PLAN_CALLBACK_PREFIX}${encodeIdPair(service.id, plan.id)}`,
          ...personalDiscountOf(plan),
        });
      }
    }
  }
  // R5C-1 item 4: the owner may keep the time packages out of this menu (`addon_time_in_renew_menu`).
  if (offered.includes('ADD_TIME') && (await renewMenuShowsTime(rt, scope))) {
    const packages = await offerOrNull(rt, scope, actor, customer, service.id, 'ADD_TIME');
    for (const addon of packages?.addons ?? []) {
      if (addon.price === null) continue;
      buttons.push({
        ...inlineLabel('service.addon_option', {
          title: addon.title,
          price: listedPrice({ ...addon, price: addon.price }),
        }),
        data: `${SERVICE_BUY_TIME_CALLBACK_PREFIX}${encodeIdPair(service.id, addon.id)}`,
        ...personalDiscountOf(addon),
      });
    }
  }
  if (buttons.length === 0) {
    return {
      // An imported service whose panel sells no plan right now is told exactly that, in
      // a sentence — never an error (owner rule 2026-10-18).
      key: panelPlans === 0 ? 'bot.service.renew_no_plan' : 'bot.service.renew_unavailable',
      values: {},
      buttons: [backToServiceButton(service.id)],
      orderId: null,
    };
  }
  buttons.push(backToServiceButton(service.id));
  return {
    key: 'bot.service.renew_choose',
    values: {},
    buttons,
    orderId: null,
  };
}

/** `commercial.offer`, with "nothing offered" as null rather than a throw: the menu decides. */
export async function offerOrNull(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string,
  kind: 'RENEW' | 'ADD_TIME',
): Promise<Awaited<ReturnType<CommercialActionService['offer']>> | null> {
  try {
    return await rt.deps.commercial.offer(scope, actor, customer.id, serviceId, kind);
  } catch (error) {
    if (isNexaError(error) && error.code in REFUSAL_REPLIES) return null;
    throw error;
  }
}
