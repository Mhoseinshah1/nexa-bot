import {
  COMMERCE_ERROR_CODES,
  isNexaError,
  type ActorContext,
  type TenantContext,
} from '@nexa/contracts';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import type { PendingReply } from './replies.js';
import { SERVICE_AUTO_RENEW_CONFIRM_CALLBACK_PREFIX } from './callbacks.js';
import { backToCardButton, cardWithToast, ownedService } from './service-card-flow.js';
import type { BotRuntime } from '../bot-runtime.js';

/**
 * Round 10, D1 — «تمدید خودکار» on a customer's service screen.
 *
 * The ON switch ASKS: it names the renewal total quoted now (the most automatic renewal will
 * ever charge for this service) and how long before the deadline it runs, and records nothing.
 * Its confirm button is the only tap that records the consent; the OFF switch acts at once.
 * Every answer is decided again by `ServiceAutoRenewService.set` inside its transaction: a
 * button drawn is never the authorization.
 */

/** The one sentence for every refusal, with the way back to the card. */
function unavailable(serviceId: string): PendingReply {
  return {
    key: 'bot.service.auto_renew_unavailable',
    values: {},
    buttons: [{ ...backToCardButton(serviceId), row: 0 }],
    orderId: null,
    edit: true,
  };
}

export async function autoRenewAsk(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: Pick<CustomerRecord, 'id'>,
  serviceId: string,
): Promise<PendingReply> {
  const service = await ownedService(rt, scope, customer, serviceId);
  if (service === null) {
    return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
  }
  if (rt.deps.autoRenew === undefined) return unavailable(service.id);
  const state = await rt.deps.autoRenew.stateFor(scope, actor, customer.id, service);
  // Already on (a second tap of an old card): the card as it is now.
  if (state.enabled) {
    return cardWithToast(rt, scope, actor, customer, service.id, 'bot.service.auto_renew_enabled');
  }
  if (!state.offered || state.price === null) return unavailable(service.id);
  return {
    key: 'bot.service.auto_renew_ask',
    values: {
      service: service.providerUsername,
      price: state.price,
      leadHours: state.leadHours,
    },
    buttons: [
      {
        ...inlineLabel('service.auto_renew_confirm'),
        data: `${SERVICE_AUTO_RENEW_CONFIRM_CALLBACK_PREFIX}${service.id}`,
        row: 0,
      },
      { ...backToCardButton(service.id), row: 1 },
    ],
    orderId: null,
    edit: true,
  };
}

/**
 * The confirm (`enabled`) or the OFF switch. The card comes back with a short notice; a
 * refusal is the one Persian sentence, and nothing was recorded.
 */
export async function autoRenewSet(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: Pick<CustomerRecord, 'id'>,
  serviceId: string,
  enabled: boolean,
  idempotencyKey: string,
): Promise<PendingReply> {
  if (rt.deps.autoRenew === undefined) return unavailable(serviceId);
  try {
    await rt.deps.autoRenew.set(scope, actor, customer.id, {
      serviceId,
      enabled,
      // The update's key is the turn's, shared with the customer's resolution in the same
      // namespace: this command takes its own suffix of it, as every other bot command does.
      idempotencyKey: `${idempotencyKey}:auto-renew-${enabled ? 'on' : 'off'}`,
    });
  } catch (error) {
    if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    if (
      isNexaError(error) &&
      (error.code === COMMERCE_ERROR_CODES.AUTO_RENEW_DISABLED ||
        error.code === COMMERCE_ERROR_CODES.AUTO_RENEW_NOT_AVAILABLE)
    ) {
      return unavailable(serviceId);
    }
    throw error;
  }
  return cardWithToast(
    rt,
    scope,
    actor,
    customer,
    serviceId,
    enabled ? 'bot.service.auto_renew_enabled' : 'bot.service.auto_renew_disabled',
  );
}
