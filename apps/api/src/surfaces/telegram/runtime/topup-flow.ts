// The wallet screen and topping it up.
// Moved verbatim out of bot-runtime.ts; BotRuntime keeps a forwarder for every one a router calls.
import {
  type ActorContext,
  type BotInstanceId,
  money,
  type PaymentGatewayProvider,
  type TenantContext,
} from '@nexa/contracts';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import {
  inlineDataLabel,
  inlineLabel,
} from '../../../modules/commerce/messaging/application/inline-buttons.js';
import type {
  TopupRoute,
  WalletTopupFlowService,
} from '../../../modules/commerce/payments/application/wallet-topup-flow.service.js';
import type { WizardDirective } from '../wizard-state.js';
import {
  GIFT_CARD_CALLBACK_DATA,
  TOPUP_CLOSE_CALLBACK_PREFIX,
  TOPUP_MENU_CALLBACK_PREFIX,
  TOPUP_PICK_CALLBACK_PREFIX,
  TOPUP_ROUTE_CALLBACK_PREFIX,
  WALLET_HISTORY_CALLBACK_PREFIX,
  WALLET_OPEN_CALLBACK_DATA,
} from './callbacks.js';
import { mainMenuButton } from './keyboards.js';
import { refusal } from './refusals.js';
import type { PendingReply } from './replies.js';
import { gatewayAttemptReply } from './checkout-flow.js';
import { transferInstruction } from './card-receipt-flow.js';
import type { BotRuntime } from '../bot-runtime.js';
import { encodeKeysetToken, type KeysetToken } from '../keyset-token.js';

/** The answer to a recorded (or refused) top-up amount: the route chooser, or why not. */
export async function topupAmountReply(
  rt: BotRuntime,
  scope: TenantContext,
  result: Awaited<ReturnType<WalletTopupFlowService['recordAmountText']>>,
  captureId: string,
): Promise<PendingReply> {
  const reply = await topupAmountScreen(rt, scope, result, captureId);
  /*
   * R2: a TYPED amount continues the wizard that asked for it — anchored on the amount
   * screen of this capture. A tapped preset has its claim and ignores the anchor.
   */
  return {
    ...reply,
    wizard: {
      ...(reply.wizard ?? { kind: 'TOPUP', step: 'NOTICE' }),
      anchor: { steps: ['AMOUNT'], subjectId: captureId },
    },
  };
}

export async function topupAmountScreen(
  rt: BotRuntime,
  scope: TenantContext,
  result: Awaited<ReturnType<WalletTopupFlowService['recordAmountText']>>,
  captureId: string,
): Promise<PendingReply> {
  const amountStep: WizardDirective = { kind: 'TOPUP', step: 'AMOUNT', subjectId: captureId };
  const close = {
    ...inlineLabel('list.close'),
    data: `${TOPUP_CLOSE_CALLBACK_PREFIX}${captureId}`,
  };
  if (result.outcome === 'GONE') {
    return { key: 'bot.wallet.topup_expired', values: {}, buttons: [], orderId: null };
  }
  if (result.outcome === 'INVALID') {
    return {
      key: 'bot.wallet.topup_amount_invalid',
      values: {},
      buttons: [close],
      orderId: null,
      wizard: amountStep,
    };
  }
  if (result.outcome === 'BELOW_MINIMUM') {
    return {
      key: 'bot.wallet.topup_below_minimum',
      values: { minimum: result.minimum },
      buttons: [close],
      orderId: null,
      wizard: amountStep,
    };
  }
  if (result.outcome === 'ABOVE_MAXIMUM') {
    return {
      key: 'bot.wallet.topup_above_maximum',
      values: { maximum: result.maximum },
      buttons: [close],
      orderId: null,
      wizard: amountStep,
    };
  }
  return topupChooser(rt, scope, captureId, result.routes);
}

/**
 * «💳 روش پرداخت خود را انتخاب نمایید»: one button per route the amount may be paid
 * through, in the operator's order, with the route's gift when it has one. The buttons
 * carry the capture id and the provider — identifiers, never the amount.
 */
export async function topupChooser(
  rt: BotRuntime,
  scope: TenantContext,
  captureId: string,
  routes: readonly TopupRoute[],
): Promise<PendingReply> {
  const close = {
    ...inlineLabel('list.close'),
    data: `${TOPUP_CLOSE_CALLBACK_PREFIX}${captureId}`,
  };
  const methods: WizardDirective = { kind: 'TOPUP', step: 'METHODS', subjectId: captureId };
  if (routes.length === 0) {
    return {
      key: 'bot.wallet.topup_none_available',
      values: {},
      buttons: [close],
      orderId: null,
      wizard: methods,
    };
  }
  // The routes as `CheckoutService.topupRoutes` names them — the mini app's list too.
  const buttons: CustomerButton[] = [];
  for (const route of await rt.deps.checkout.topupRoutes(scope, routes)) {
    buttons.push({
      ...(route.giftPercent > 0
        ? inlineLabel('payment.route_gift', { name: route.name, percent: route.giftPercent })
        : inlineLabel('payment.route', { name: route.name })),
      data: `${TOPUP_ROUTE_CALLBACK_PREFIX}${captureId}.${route.provider}`,
    });
  }
  buttons.push(close);
  return {
    key: 'bot.wallet.topup_method_prompt',
    values: {},
    buttons,
    orderId: null,
    wizard: methods,
  };
}

export async function topupRoute(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  captureId: string,
  provider: PaymentGatewayProvider,
): Promise<PendingReply> {
  try {
    const chosen = await rt.deps.topup.choose(scope, actor, {
      customerId: customer.id,
      captureId,
      provider,
    });
    if (chosen.outcome === 'GONE') {
      return { key: 'bot.wallet.topup_expired', values: {}, buttons: [], orderId: null };
    }
    if (chosen.outcome === 'NOT_OFFERED') {
      return topupChooser(rt, scope, captureId, chosen.routes);
    }
    if (chosen.outcome === 'GATEWAY_REQUESTED') {
      return await gatewayAttemptReply(rt, chosen.attempt, null, scope);
    }
    return transferInstruction(rt, scope, chosen.instruction, null);
  } catch (error) {
    return refusal(error);
  }
}

export async function topupClose(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  captureId: string,
): Promise<PendingReply> {
  await rt.deps.topup.close(scope, actor, { customerId: customer.id, captureId });
  return {
    key: 'bot.wallet.topup_closed',
    values: {},
    buttons: [mainMenuButton()],
    orderId: null,
    wizard: { kind: 'TOPUP', step: 'CLOSED' },
  };
}

/**
 * The customer's own balance, derived from the ledger every time it is asked for.
 *
 * There is no balance column to read and no cache to go stale — `balanceOf` sums the
 * entries. `bot.wallet.balance` declares exactly one placeholder and this supplies
 * exactly that.
 */
export async function walletBalance(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
): Promise<PendingReply> {
  const balance = await rt.deps.wallet.balanceForCustomer(scope, actor, customer.id);
  const counters = await rt.deps.counters.counters(scope, customer.id);
  /*
   * The referral COUNT stays on the account summary: it is a fact about this customer
   * that Mirza's /wallet shows too (the one referral surface its research VERIFIED). The
   * referral BUTTON does not (F5): the wallet carries wallet operations only, and the
   * program is reached from its own main-menu button and `/referral`.
   */
  const referralCount =
    rt.deps.referralGifts === undefined
      ? 0
      : (await rt.deps.referralGifts.stats(scope, customer.id)).referralCount;
  const reseller =
    rt.deps.resellers === undefined
      ? null
      : await rt.deps.resellers.standing(scope, customer.id, undefined);
  const fundable =
    (await rt.deps.routes.routesFor(scope, customer.id, 'WALLET_TOPUP', null)).length > 0;
  // R10 D4: the gift-card button only while the feature is on, read when the screen is drawn.
  const giftCards = rt.deps.giftCards !== undefined && (await rt.deps.giftCards.isEnabled(scope));
  const summary = await rt.deps.screens.walletSummary(scope, {
    telegramId: customer.telegramUserId,
    displayName: displayNameOf(customer),
    registeredAt: customer.createdAt,
    balance: money(balance.amountMinor, balance.currency),
    serviceCount: counters.services,
    paidInvoiceCount: counters.paidInvoices,
    referralCount,
    group: reseller === null ? 'CUSTOMER' : 'RESELLER',
    // Owner spec §3: when the screen was drawn, not when anything happened.
    now: rt.deps.clock.now(),
  });
  return {
    key: summary.key,
    values: summary.values,
    buttons: [
      /*
       * R8-C2: no separate «کپی شناسه» button. The numeric id is in <code> in the summary
       * (`bot.wallet.summary` is TELEGRAM_HTML), so a tap on the text copies it.
       */
      ...(fundable
        ? [
            {
              ...inlineLabel('wallet.topup'),
              data: TOPUP_MENU_CALLBACK_PREFIX,
            },
          ]
        : []),
      ...(giftCards ? [{ ...inlineLabel('wallet.gift_card'), data: GIFT_CARD_CALLBACK_DATA }] : []),
      // R12 F3 item 7: the wallet's last movements, ten a page, edited in place.
      { ...inlineLabel('wallet.history'), data: WALLET_HISTORY_CALLBACK_PREFIX },
      mainMenuButton(),
    ],
    orderId: null,
  };
}

/** R12 F3 item 7: how many movements one page of the wallet history shows. */
export const WALLET_HISTORY_PAGE_SIZE = 10;

/**
 * R12 F3 item 7: the customer's last wallet movements, newest first, ten a page, drawn IN
 * PLACE of the tapped message (the wallet screen, or the previous page). The page is the
 * customer's own ledger in the selling currency (`WalletService.historyForCustomer`, the
 * customer-own permission; the id is the one the update authenticated), read when the tap
 * arrives. `wh:<token>` pages on by keyset, so a movement written meanwhile cannot shift a page
 * under the reader. «◀️» goes back to the newest page; there is no back-by-page, because a
 * keyset names a position and not a number. Nothing here writes.
 */
export async function walletHistory(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  cursor: KeysetToken | null,
): Promise<PendingReply> {
  const page = await rt.deps.wallet.historyForCustomer(scope, actor, customer.id, {
    limit: WALLET_HISTORY_PAGE_SIZE,
    ...(cursor === null ? {} : { cursor }),
  });
  const screen = await rt.deps.screens.walletHistory(
    scope,
    page.items.map((entry) => ({
      direction: entry.direction,
      reason: entry.reason,
      amount: entry.amount,
      createdAt: entry.createdAt,
    })),
  );
  const next = page.nextCursor === null ? null : encodeKeysetToken(page.nextCursor);
  return {
    key: screen.key,
    values: screen.values,
    buttons: [
      ...(cursor === null
        ? []
        : [
            {
              ...inlineLabel('services.previous_page'),
              data: WALLET_HISTORY_CALLBACK_PREFIX,
              row: 0,
            },
          ]),
      ...(next === null
        ? []
        : [
            {
              ...inlineLabel('services.next_page'),
              data: `${WALLET_HISTORY_CALLBACK_PREFIX}${next}`,
              row: 0,
            },
          ]),
      { ...inlineLabel('wallet.open'), data: WALLET_OPEN_CALLBACK_DATA, row: 1 },
      { ...mainMenuButton(), row: 1 },
    ],
    orderId: null,
    edit: true,
  };
}

/**
 * The offered amounts, one button each, read when the tap arrives.
 *
 * No amount is baked into the message that drew this: a customer scrolling back to an
 * old balance and tapping gets today's presets, not the ones that were configured when
 * it was sent. The refusal when nothing is offered is the same one the service gives,
 * so a customer who taps a button that has since become unfundable is told the same
 * thing either way.
 */
export async function topupBegin(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  botInstanceId: BotInstanceId,
  idempotencyKey: string,
): Promise<PendingReply> {
  const offered = await rt.deps.routes.routesFor(scope, customer.id, 'WALLET_TOPUP', null);
  if (offered.length === 0) {
    return {
      key: 'bot.wallet.topup_unavailable',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    };
  }
  const begun = await rt.deps.topup.begin(scope, actor, {
    customerId: customer.id,
    botInstanceId,
    idempotencyKey: `${idempotencyKey}:topup-begin`,
  });
  // The presets, when configured, are shortcuts that record the figure on the same
  // capture the typed path uses; they are not a second flow.
  const presets = await rt.deps.payments.topupPresets(scope);
  return {
    key: 'bot.wallet.topup_amount_prompt',
    values: {
      ...(begun.minimum === null ? {} : { minimum: begun.minimum }),
      ...(begun.maximum === null ? {} : { maximum: begun.maximum }),
    },
    buttons: [
      ...presets.map((preset) => ({
        ...inlineDataLabel('wallet.topup_amount', { kind: 'AMOUNT', amount: preset }),
        data: `${TOPUP_PICK_CALLBACK_PREFIX}${preset.amountMinor.toString()}`,
      })),
      {
        ...inlineLabel('list.close'),
        data: `${TOPUP_CLOSE_CALLBACK_PREFIX}${begun.capture.id}`,
      },
    ],
    orderId: null,
    wizard: { kind: 'TOPUP', step: 'AMOUNT', subjectId: begun.capture.id },
  };
}

/**
 * A chosen amount becomes an invoice — the SAME invoice an order's transfer produces.
 *
 * `renderTransferInstruction` is shared, so the customer gets the structured
 * card-to-card destination, the two copy buttons and the combined
 * «پرداخت را انجام دادم | ارسال رسید» button that 5A and 5R built. A top-up has no
 * order, so nothing here names one.
 */
export async function topupPick(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  amountMinor: string,
  customer: CustomerRecord,
  idempotencyKey: string,
  botInstanceId: BotInstanceId,
): Promise<PendingReply> {
  const presets = await rt.deps.payments.topupPresets(scope);
  const preset = presets.find((candidate) => candidate.amountMinor.toString() === amountMinor);
  if (preset === undefined) {
    return {
      key: 'bot.wallet.topup_refused',
      values: {},
      buttons: [],
      orderId: null,
      wizard: { kind: 'TOPUP', step: 'NOTICE' },
    };
  }
  const begun = await rt.deps.topup.begin(scope, actor, {
    customerId: customer.id,
    botInstanceId,
    idempotencyKey: `${idempotencyKey}:topup-pick`,
  });
  const result = await rt.deps.topup.recordAmount(scope, {
    customerId: customer.id,
    captureId: begun.capture.id,
    amount: preset,
  });
  return topupAmountReply(rt, scope, result, begun.capture.id);
}

/**
 * R10 D4: «🎁 کارت هدیه» — opens the customer's text window for ONE code. Whether gift cards are
 * on is read when the tap arrives: a button from an old wallet screen after the feature was
 * switched off answers «unavailable» and opens nothing.
 */
export async function giftCardBegin(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  botInstanceId: BotInstanceId,
  idempotencyKey: string,
): Promise<PendingReply> {
  if (rt.deps.giftCards === undefined || !(await rt.deps.giftCards.isEnabled(scope))) {
    return {
      key: 'bot.wallet.gift_card_unavailable',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    };
  }
  await rt.deps.captures.open(scope, actor, {
    idempotencyKey: `${idempotencyKey}:gift-card-open`,
    botInstanceId,
    customerId: customer.id,
    purpose: 'GIFT_CARD_CODE',
    subjectId: null,
  });
  return {
    key: 'bot.wallet.gift_card_ask',
    values: {},
    buttons: [mainMenuButton()],
    orderId: null,
  };
}

/**
 * R10 D4: the code the window read. The redemption service decides everything; the reply is
 * one of three sentences — the credit and the balance after it, ONE refusal for every reason
 * (so the bot is no oracle for which codes exist), or «too many tries». A refused code offers
 * the button again; no customer message is sent beyond this reply.
 */
export async function giftCardText(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  text: string,
  input: { readonly idempotencyKey: string },
): Promise<PendingReply> {
  if (rt.deps.giftCards === undefined) {
    return {
      key: 'bot.wallet.gift_card_unavailable',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    };
  }
  let result;
  try {
    result = await rt.deps.giftCards.redeem(scope, actor, {
      customerId: customer.id,
      code: text,
      idempotencyKey: `${input.idempotencyKey}:gift-card-redeem`,
    });
  } catch (error) {
    // Switched off since the button (`bot.wallet.gift_card_unavailable`), or anything else the
    // refusal table names; an unexpected error is rethrown to the turn's own handler.
    return refusal(error);
  }
  if (result.outcome === 'REDEEMED') {
    return {
      key: 'bot.wallet.gift_card_redeemed',
      values: { amount: result.amount, balance: result.balance },
      buttons: [mainMenuButton()],
      orderId: null,
    };
  }
  if (result.outcome === 'RATE_LIMITED') {
    return {
      key: 'bot.wallet.gift_card_rate_limited',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    };
  }
  return {
    key: 'bot.wallet.gift_card_rejected',
    values: {},
    buttons: [
      { ...inlineLabel('wallet.gift_card'), data: GIFT_CARD_CALLBACK_DATA },
      mainMenuButton(),
    ],
    orderId: null,
  };
}

/** First and last name, else the username, else the numeric id — never blank. */
function displayNameOf(customer: CustomerRecord): string {
  const name = [customer.firstName, customer.lastName]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ')
    .trim();
  if (name.length > 0) return name;
  if (customer.username !== null && customer.username.trim().length > 0) return customer.username;
  return customer.telegramUserId;
}
