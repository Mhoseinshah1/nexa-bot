import {
  RESELLER_WEB_CALLBACK,
  type ActorContext,
  type BotInstanceId,
  type TenantContext,
} from '@nexa/contracts';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import type { BotRuntime } from '../bot-runtime.js';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import { mainMenuButton } from './keyboards.js';
import type { PendingReply } from './replies.js';

/**
 * PR-4 «ورود به پنل وب»: the reseller panel's way in from the bot.
 *
 * `openButton` is drawn under the reseller section's answer (an ACTIVE reseller's «درخواست
 * نمایندگی» screen) and the wallet summary, only while the `reseller_web_panel` flag is on
 * and the customer is an ACTIVE reseller — read when the screen is drawn. The tap is decided
 * again on the server (`ResellerWebAccessService.issueLink`): a link is issued only if every
 * rule still holds, and the message carries it as a URL button, never as text in a log.
 */
export async function openButton(
  rt: BotRuntime,
  scope: TenantContext,
  customer: CustomerRecord,
): Promise<CustomerButton[]> {
  const access = rt.deps.resellerWeb;
  if (access === undefined) return [];
  if (!(await access.offered(scope, customer.id))) return [];
  return [{ ...inlineLabel('reseller_web.open'), data: RESELLER_WEB_CALLBACK }];
}

/** The tap: a fresh one-time link, or the reason there is none. */
export async function issueLink(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  botInstanceId: BotInstanceId,
): Promise<PendingReply> {
  const access = rt.deps.resellerWeb;
  const outcome =
    access === undefined
      ? ({ kind: 'UNAVAILABLE' } as const)
      : await access.issueLink(scope, actor, { customerId: customer.id, botInstanceId });
  if (outcome.kind === 'ISSUED') {
    return {
      key: 'bot.reseller_web.link',
      values: { minutes: outcome.minutes },
      buttons: [{ ...inlineLabel('reseller_web.link'), url: outcome.url }, mainMenuButton()],
      orderId: null,
    };
  }
  return {
    key:
      outcome.kind === 'RATE_LIMITED'
        ? 'bot.reseller_web.link_rate_limited'
        : 'bot.reseller_web.unavailable',
    values: {},
    buttons: [mainMenuButton()],
    orderId: null,
  };
}
