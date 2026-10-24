// The referral program's two customer screens: the invite dashboard and the gift claim.
// Moved verbatim out of bot-runtime.ts, which still re-exports every name it exported.
import type { TenantContext, ActorContext, BotInstanceId } from '@nexa/contracts';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import type { PendingReply } from './replies.js';
import { mainMenuButton } from './keyboards.js';
import { refusal } from './refusals.js';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import { REFERRAL_GIFT_CALLBACK_DATA } from './callbacks.js';
import type { BotRuntime } from '../bot-runtime.js';

export async function referralGift(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  idempotencyKey: string,
): Promise<PendingReply> {
  if (rt.deps.referralGifts === undefined) {
    return { key: 'bot.referral.gift_disabled', values: {}, buttons: [], orderId: null };
  }
  try {
    const claimed = await rt.deps.referralGifts.claim(scope, actor, customer.id, {
      idempotencyKey: `${idempotencyKey}:signup-gift`,
    });
    if (claimed.claimedCount === 0 || claimed.credited.amountMinor === 0n) {
      return {
        key: 'bot.referral.gift_nothing',
        values: {},
        buttons: [mainMenuButton()],
        orderId: null,
      };
    }
    return {
      key: 'bot.referral.gift_claimed',
      values: { amount: claimed.credited },
      buttons: [mainMenuButton()],
      orderId: null,
    };
  } catch (error) {
    return refusal(error);
  }
}

/**
 * The referral program, in EXACTLY two messages (R1).
 *
 * 1. The invite — the one a customer forwards to a friend: the banner, the program's
 *    introduction and the customer's link, as ONE message (the banner's caption when
 *    there is a banner, text otherwise). It carries no figure about the customer.
 * 2. The dashboard — theirs alone: the gift terms, the commission, its scope and
 *    minimum, and their figures, under the share, claim-gift and back buttons.
 *
 * Every figure is `ReferralProgram.terms`' and `ReferralSignupGiftService.stats`' —
 * nothing is calculated here. Asking records the customer's code the first time, which
 * is why it carries the turn's idempotency key; every other answer is the one
 * unconfigured sentence. Reached from the main menu's «👥 زیرمجموعه‌گیری», `/referral`
 * and — from a wallet message drawn before F5 — the wallet's old referral button alike.
 */
export async function referralInvite(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  botInstanceId: BotInstanceId,
  idempotencyKey: string,
): Promise<PendingReply> {
  const unconfigured: PendingReply = {
    key: 'bot.referral.unconfigured',
    values: {},
    buttons: [mainMenuButton()],
    orderId: null,
  };
  if (rt.deps.referrals === undefined || rt.deps.referralGifts === undefined) {
    return unconfigured;
  }
  const terms = await rt.deps.referrals.terms(scope);
  if (!terms.active || terms.percent === null) return unconfigured;
  const invite = await rt.deps.referrals.invite(scope, actor, {
    // Suffixed, as every other write that shares a turn with `resolveFromUpdate` is:
    // the bare key was consumed there.
    idempotencyKey: `${idempotencyKey}:referral`,
    customerId: customer.id,
    botInstanceId,
  });
  if (invite.outcome !== 'READY') return unconfigured;
  const gift = await rt.deps.referralGifts.terms(scope);
  const stats = await rt.deps.referralGifts.stats(scope, customer.id);
  /*
   * The claim button only when there is something to claim — the gift on AND a share
   * owed to this customer now (`claimableFor`, the service's own answer). A button that
   * can only say "nothing to claim" is a promise the keyboard broke.
   */
  const claimable =
    gift.active &&
    (rt.deps.referralGifts.claimableFor === undefined ||
      (await rt.deps.referralGifts.claimableFor(scope, customer.id)).length > 0);
  const card = rt.deps.screens.referralInviteCard({
    commissionPercent: terms.percent,
    referralLink: invite.link,
  });
  const dashboard = await rt.deps.screens.referralDashboard(scope, {
    commissionPercent: terms.percent,
    commissionScope: terms.scope,
    minimumOrder: terms.minimum,
    gift: gift.active
      ? {
          total: gift.total,
          referrerPercent: gift.referrerPercent,
          referredPercent: gift.referredPercent,
        }
      : null,
    referralCount: stats.referralCount,
    referredPurchaseCount: stats.referredPurchaseCount,
    referredPurchaseTotal: stats.referredPurchaseTotal,
    commissionReceivedTotal: stats.commissionReceivedTotal,
  });
  const banner =
    rt.deps.media === undefined ? null : await rt.deps.media.bytesFor(scope, 'REFERRAL_BANNER');
  return {
    key: dashboard.key,
    values: dashboard.values,
    buttons: [
      {
        ...inlineLabel('referral.share'),
        // Telegram's own share sheet, with the customer's link as the payload.
        url: `https://t.me/share/url?url=${encodeURIComponent(invite.link)}`,
      },
      ...(claimable
        ? [
            {
              ...inlineLabel('referral.gift'),
              data: REFERRAL_GIFT_CALLBACK_DATA,
            },
          ]
        : []),
      mainMenuButton(),
    ],
    orderId: null,
    // Message 1, ahead of the dashboard: the banner WITH the invite as its caption, so
    // forwarding it forwards the picture, the words and the link together.
    lead: [
      banner === null
        ? { kind: 'TEXT' as const, key: card.key, values: card.values }
        : {
            kind: 'PHOTO_BYTES' as const,
            bytes: banner.bytes,
            mimeType: banner.mimeType,
            fileName: banner.mimeType === 'image/png' ? 'banner.png' : 'banner.jpg',
            caption: { key: card.key, values: card.values },
          },
    ],
  };
}
