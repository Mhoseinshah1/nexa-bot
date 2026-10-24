// The free trial: the offer screen and the claim. Eligibility is decided by `deps.trials`.
// Moved verbatim out of bot-runtime.ts, which still re-exports every name it exported.
import type { PendingReply } from './replies.js';
import { mainMenuButton } from './keyboards.js';
import type { TenantContext, ActorContext } from '@nexa/contracts';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import { TRIAL_PANEL_CALLBACK_PREFIX } from './callbacks.js';
import type { BotRuntime } from '../bot-runtime.js';

export function trialUnavailable(): PendingReply {
  return { key: 'bot.trial.unavailable', values: {}, buttons: [mainMenuButton()], orderId: null };
}

/**
 * A customer asked for a trial — the main menu's «🧪 دریافت سرویس تست», `/trial`, or a
 * pre-F5 catalogue message's trial button (R1).
 *
 * Which panels offer one is `TrialService.claim`'s answer, decided with no panel named —
 * enabled, eligible by the one evaluator, able to name the account — and never this
 * surface's. Exactly
 * one: the trial is taken on it at once. Several: the customer chooses, from buttons
 * carrying only the panel's id. None, or a customer who may not take one: the one
 * unavailable sentence. Every refusal says the same thing; the reason is the service's.
 *
 * A NEW message rather than an edit: the main-menu tap is a text message of the
 * customer's, which there is nothing of ours to edit, and the choice is the one step
 * between the tap and the result.
 */
export async function beginTrial(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  idempotencyKey: string,
): Promise<PendingReply> {
  if (rt.deps.trials === undefined) return trialUnavailable();
  /*
   * The claim decides — not an availability read ahead of it. It answers a redelivered
   * update from the record the first delivery left, BEFORE it looks at what is offered
   * now: a trial already issued for this update is issued again (not "unavailable"
   * because the allowance is now spent), and a refusal stays a refusal even if a panel
   * came on in between. Codex, PR #111.
   */
  const result = await rt.deps.trials.claim(scope, actor, customer.id, {
    idempotencyKey: `${idempotencyKey}:trial`,
  });
  if (result.outcome === 'ISSUED') {
    return { key: 'bot.trial.issued', values: {}, buttons: [], orderId: null };
  }
  if (result.outcome === 'REFUSED') return trialUnavailable();
  return {
    key: 'bot.trial.choose_panel',
    values: {},
    buttons: [
      ...result.offers.map((offer) => ({
        ...inlineLabel('trial.panel', {
          label: offer.label,
          traffic: offer.trafficBytes,
          hours: offer.durationHours,
        }),
        data: `${TRIAL_PANEL_CALLBACK_PREFIX}${offer.panelId}`,
      })),
      mainMenuButton(),
    ],
    orderId: null,
  };
}

/**
 * The customer takes the trial on one panel: the only one offered, or the one they
 * chose.
 *
 * One sentence either way. `bot.trial.issued` says the service is being created — the
 * link then arrives through the ordinary delivery lane, as a purchase's does, once the
 * panel has answered. Every refusal says `bot.trial.unavailable`: the reason (limit
 * reached, blocked, panel no longer offering one) is in the audit row for an operator.
 *
 * Idempotent by the UPDATE: a redelivered tap is answered from the claim's record with
 * the same trial, and a second tap — a new update — is decided afresh under the
 * customer's lock, finds the allowance spent and is refused, so a double tap never
 * issues two trials a limit of one does not allow.
 */
export async function claimTrial(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  panelId: string,
  idempotencyKey: string,
): Promise<PendingReply> {
  if (rt.deps.trials === undefined) return trialUnavailable();
  // Suffixed, as every other write this update makes: `resolveFromUpdate` has already
  // spent the bare key in the same namespace.
  const result = await rt.deps.trials.claim(scope, actor, customer.id, {
    idempotencyKey: `${idempotencyKey}:trial`,
    panelId,
  });
  return result.outcome === 'ISSUED'
    ? { key: 'bot.trial.issued', values: {}, buttons: [], orderId: null }
    : trialUnavailable();
}
