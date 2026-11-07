import {
  RESELLER_REQUEST_CALLBACKS,
  RESELLER_REQUEST_ERROR_CODES,
  isNexaError,
  type ActorContext,
  type BotInstanceId,
  type PermissionKey,
  type TemplateKey,
  type TemplateValues,
  type TenantContext,
} from '@nexa/contracts';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import type { CustomerCaptureRecord } from '../../../modules/commerce/customers/application/customer-capture-ports.js';
import type { BotRuntime } from '../bot-runtime.js';
import { decodeIdPair, encodeIdPair } from './callbacks.js';
import { privateChatIdOf, updateIdOf } from './intent-of.js';
import type { BotCommand } from './intents.js';
import type { PendingReply } from './replies.js';
import { refusal } from './refusals.js';

/**
 * «درخواست نمایندگی», the operator's side (PR-2): the three buttons under a request in the
 * operations log group, and what they open.
 *
 * A tap in the GROUP never gets an answer there ("nothing is ever sent into the group"): the
 * tier list, the confirmation and the prompts go to the administrator's PRIVATE chat, which
 * the bot may open only after /start. A tap in the private chat (a tier, the confirmation, a
 * cancel) is answered in place, like every other button of the panel.
 *
 * Acting needs `resellers.edit`; `adminTurn` admits only an administrator who holds it, and
 * the service charges it again on every write. The decision is the service's, never this
 * file's: a double tap or a race is the service's idempotency, not a check here.
 */

export const RESELLER_REQUEST_ADMIN_PERMISSION: PermissionKey = 'resellers.edit';

type Input = {
  readonly idempotencyKey: string;
  readonly botInstanceId: BotInstanceId;
  readonly update: unknown;
  readonly telegramUserId: string;
};

const silent = (): PendingReply => ({ key: null, values: {}, buttons: [], orderId: null });

const notice = (key: TemplateKey, values: TemplateValues = {}): PendingReply => ({
  key,
  values,
  buttons: [],
  orderId: null,
});

/**
 * Where an answer goes: edited in place when the tap came from the private chat, sent to the
 * private chat when it came from the group (and the tap itself is only acknowledged).
 */
async function deliver(
  rt: BotRuntime,
  scope: TenantContext,
  input: Input,
  pending: PendingReply,
): Promise<PendingReply> {
  if (privateChatIdOf(input.update) !== null) return pending;
  if (pending.key !== null) {
    await rt.deps.messenger.send(scope, {
      chatId: input.telegramUserId,
      templateKey: pending.key,
      values: pending.values,
      botInstanceId: input.botInstanceId,
      ...(pending.buttons.length === 0 ? {} : { buttons: pending.buttons }),
    });
  }
  return silent();
}

const button = (key: TemplateKey, data: string, row = 0): CustomerButton => ({
  label: { kind: 'TEMPLATE', key },
  // An administrator's button: its label is one of the bot.admin.* texts.
  data,
  row,
});

export async function adminResellerRequestTurn(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  adminActor: ActorContext,
  command: BotCommand,
  input: Input,
): Promise<PendingReply | null> {
  const service = rt.deps.resellerRequests;
  if (service === undefined || command.targetId === null) return null;
  const id = command.targetId;
  try {
    switch (command.intent) {
      case 'ADMIN_RESELLER_REQUEST_APPROVE': {
        const detail = await service.get(scope, adminActor, id);
        if (detail.request.status !== 'PENDING') {
          return deliver(rt, scope, input, notice('bot.admin.reseller_request.closed'));
        }
        const tiers = await service.tiersFor(scope, adminActor);
        if (tiers.length === 0) {
          return deliver(rt, scope, input, notice('bot.admin.reseller_request.closed'));
        }
        return deliver(rt, scope, input, {
          key: 'bot.admin.reseller_request.tiers',
          values: { number: Number(detail.request.number) },
          buttons: [
            ...tiers.map((tier, row): CustomerButton => ({
              label: { kind: 'TEXT', text: tier.name },
              // The bot.admin.reseller_request.tiers list: labelled by the tier's own name.
              data: `${RESELLER_REQUEST_CALLBACKS.tier}${encodeIdPair(id, tier.id)}`,
              row,
            })),
          ],
          orderId: null,
        });
      }
      case 'ADMIN_RESELLER_REQUEST_TIER': {
        if (command.secondaryId == null) return null;
        const detail = await service.get(scope, adminActor, id);
        const tier = (await service.tiersFor(scope, adminActor)).find(
          (one) => one.id === command.secondaryId,
        );
        if (detail.request.status !== 'PENDING' || tier === undefined) {
          return deliver(rt, scope, input, notice('bot.admin.reseller_request.closed'));
        }
        return deliver(rt, scope, input, {
          key: 'bot.admin.reseller_request.confirm',
          values: { number: Number(detail.request.number), tier: tier.name },
          buttons: [
            button(
              'bot.admin.reseller_request.button_confirm',
              `${RESELLER_REQUEST_CALLBACKS.confirm}${encodeIdPair(id, tier.id)}`,
            ),
          ],
          orderId: null,
        });
      }
      case 'ADMIN_RESELLER_REQUEST_CONFIRM': {
        if (command.secondaryId == null) return null;
        const detail = await service.get(scope, adminActor, id);
        const approved = await service.approve(scope, adminActor, {
          requestId: id,
          tierId: command.secondaryId,
          // The tap's own update key: a redelivery replays, a second tap is a second key
          // that finds the request decided (the service's idempotency, not a check here).
          idempotencyKey: `${input.idempotencyKey}:approve`,
        });
        // The tier the request WAS approved on: a second tap that lost the race to another
        // operator's approval is told the decision that stands, not the tier it tapped.
        const decidedTier = approved.request.tierId ?? command.secondaryId;
        const tierName = (await service.tiersFor(scope, adminActor)).find(
          (one) => one.id === decidedTier,
        )?.name;
        return deliver(rt, scope, input, {
          key: 'bot.admin.reseller_request.done_approved',
          values: { number: Number(detail.request.number), tier: tierName ?? '' },
          buttons: [],
          orderId: null,
        });
      }
      case 'ADMIN_RESELLER_REQUEST_REJECT':
      case 'ADMIN_RESELLER_REQUEST_MESSAGE': {
        const reject = command.intent === 'ADMIN_RESELLER_REQUEST_REJECT';
        const detail = await service.get(scope, adminActor, id);
        if (detail.request.status !== 'PENDING') {
          return deliver(rt, scope, input, notice('bot.admin.reseller_request.closed'));
        }
        // The prompt is read by the administrator's OWN text window, so they need a customer
        // row: one exists once they have opened the bot in a private chat.
        const customerId = await service.customerIdOfTelegramUser(scope, input.telegramUserId);
        if (customerId === null) {
          return deliver(rt, scope, input, notice('bot.admin.reseller_request.start_bot'));
        }
        const updateId = updateIdOf(input.update);
        const window = await rt.deps.captures.open(scope, actor, {
          idempotencyKey: `${input.idempotencyKey}:rr-admin-window`,
          botInstanceId: input.botInstanceId,
          customerId: customerId as CustomerRecord['id'],
          purpose: reject ? 'RESELLER_REQUEST_ADMIN_REASON' : 'RESELLER_REQUEST_ADMIN_MESSAGE',
          subjectId: id,
          ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
        });
        return deliver(rt, scope, input, {
          key: reject
            ? 'bot.admin.reseller_request.reject_prompt'
            : 'bot.admin.reseller_request.message_prompt',
          values: { number: Number(detail.request.number) },
          buttons: [
            ...(reject
              ? [
                  button(
                    'bot.admin.reseller_request.button_reject_plain',
                    `${RESELLER_REQUEST_CALLBACKS.rejectPlain}${id}`,
                  ),
                ]
              : []),
            button(
              'bot.admin.reseller_request.button_cancel',
              `${RESELLER_REQUEST_CALLBACKS.cancel}${window.id}`,
              reject ? 1 : 0,
            ),
          ],
          orderId: null,
        });
      }
      case 'ADMIN_RESELLER_REQUEST_REJECT_PLAIN': {
        const result = await service.reject(scope, adminActor, {
          requestId: id,
          idempotencyKey: `${input.idempotencyKey}:reject`,
        });
        return deliver(rt, scope, input, {
          key: 'bot.admin.reseller_request.done_rejected',
          values: { number: Number(result.request.number) },
          buttons: [],
          orderId: null,
        });
      }
      case 'ADMIN_RESELLER_REQUEST_CANCEL': {
        const customerId = await service.customerIdOfTelegramUser(scope, input.telegramUserId);
        if (customerId !== null) {
          await rt.deps.captures.close(scope, actor, {
            customerId: customerId as CustomerRecord['id'],
            captureId: id,
            reason: 'CANCELLED',
          });
        }
        return deliver(rt, scope, input, notice('bot.admin.reseller_request.cancelled'));
      }
      default:
        return null;
    }
  } catch (error) {
    if (isNexaError(error)) {
      if (error.code === RESELLER_REQUEST_ERROR_CODES.ALREADY_RESELLER) {
        return deliver(rt, scope, input, notice('bot.admin.reseller_request.already_reseller'));
      }
      if (
        error.code === RESELLER_REQUEST_ERROR_CODES.CLOSED ||
        error.code === RESELLER_REQUEST_ERROR_CODES.NOT_FOUND ||
        error.code === RESELLER_REQUEST_ERROR_CODES.TIER_INVALID
      ) {
        return deliver(rt, scope, input, notice('bot.admin.reseller_request.closed'));
      }
    }
    return refusal(error);
  }
}

/** The text window of an operator's prompt read what they typed: a reason, or a message. */
export async function adminText(
  rt: BotRuntime,
  scope: TenantContext,
  _actor: ActorContext,
  customer: CustomerRecord,
  capture: CustomerCaptureRecord,
  text: string,
  input: { readonly idempotencyKey: string; readonly botInstanceId: BotInstanceId },
): Promise<PendingReply | null> {
  const service = rt.deps.resellerRequests;
  const admins = rt.deps.telegramAdmins;
  if (service === undefined || admins === undefined || capture.subjectId === null) return null;
  const identity = await admins.resolve(scope, customer.telegramUserId, _actor.correlationId);
  // The window is an operator's: a customer's row never holds one, but the binding is checked.
  if (identity === null || !identity.permissions.has(RESELLER_REQUEST_ADMIN_PERMISSION))
    return null;
  const requestId = capture.subjectId;
  try {
    if (capture.purpose === 'RESELLER_REQUEST_ADMIN_MESSAGE') {
      const posted = await service.postMessage(scope, identity.actor, {
        requestId,
        text,
        idempotencyKey: `${input.idempotencyKey}:message`,
      });
      const detail = await service.get(scope, identity.actor, posted.message.requestId);
      return notice('bot.admin.reseller_request.done_message', {
        number: Number(detail.request.number),
      });
    }
    const result = await service.reject(scope, identity.actor, {
      requestId,
      reason: text,
      idempotencyKey: `${input.idempotencyKey}:reject`,
    });
    return notice('bot.admin.reseller_request.done_rejected', {
      number: Number(result.request.number),
    });
  } catch (error) {
    if (
      isNexaError(error) &&
      (error.code === RESELLER_REQUEST_ERROR_CODES.CLOSED ||
        error.code === RESELLER_REQUEST_ERROR_CODES.NOT_FOUND)
    ) {
      return notice('bot.admin.reseller_request.closed');
    }
    return refusal(error);
  }
}

/** Parses the id pair of a tier or confirm callback, or null. */
export function tierPairOf(encoded: string): { requestId: string; tierId: string } | null {
  const pair = decodeIdPair(encoded);
  return pair === null ? null : { requestId: pair.first, tierId: pair.second };
}
