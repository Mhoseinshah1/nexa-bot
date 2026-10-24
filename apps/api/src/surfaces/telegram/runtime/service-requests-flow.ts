// A customer's two requests about one of their services: a refund request (ask, confirm,
// the typed reason) and a transfer to another customer (ask, the typed recipient, confirm).
// Moved verbatim out of bot-runtime.ts, which still re-exports every name it exported.
import type { PendingReply } from './replies.js';
import { backToServiceButton, ownedService, serviceDetail } from './service-card-flow.js';
import {
  type ServiceTransferRecipientRefusal,
  type TemplateKey,
  type TenantContext,
  type ActorContext,
  type BotInstanceId,
  SERVICE_REFUND_REASON_MIN_LENGTH,
  SERVICE_REFUND_REASON_MAX_LENGTH,
  isNexaError,
  COMMERCE_ERROR_CODES,
  serviceTransferRecipientRefusalSchema,
} from '@nexa/contracts';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import {
  SERVICE_REFUND_CONFIRM_CALLBACK_PREFIX,
  transferConfirmData,
  SERVICES_LIST_PAGE_CALLBACK_PREFIX,
} from './callbacks.js';
import { updateIdOf } from './intent-of.js';
import { normaliseRefundReason } from '../../../modules/commerce/payments/application/service-refund-request.service.js';
import { hasRefusalReply, refusal } from './refusals.js';
import type { ServiceRecord } from '../../../modules/commerce/provisioning/application/ports.js';
import type { BotRuntime } from '../bot-runtime.js';

/** The answer to a refund request the service cannot take right now (WP19). */
export function refundOfferReply(
  offer: 'PENDING' | 'UNAVAILABLE',
  serviceId: string,
): PendingReply {
  return {
    key:
      offer === 'PENDING'
        ? 'bot.service.refund_request_pending'
        : 'bot.service.refund_request_unavailable',
    values: {},
    buttons: [backToServiceButton(serviceId)],
    orderId: null,
  };
}

/**
 * The sentence for each recipient refusal (Package F). Unknown and blocked are ONE
 * sentence: telling them apart would tell a stranger which accounts an operator blocked.
 */
export const TRANSFER_RECIPIENT_REPLIES: Readonly<
  Record<ServiceTransferRecipientRefusal, TemplateKey>
> = {
  RECIPIENT_INVALID: 'bot.service.transfer_recipient_invalid',
  RECIPIENT_UNKNOWN: 'bot.service.transfer_recipient_unavailable',
  RECIPIENT_BLOCKED: 'bot.service.transfer_recipient_unavailable',
  RECIPIENT_SELF: 'bot.service.transfer_recipient_self',
};

/** One sentence for every reason a service cannot be transferred now, and the way back. */
export function transferUnavailableReply(serviceId: string): PendingReply {
  return {
    key: 'bot.service.transfer_unavailable',
    values: {},
    buttons: [backToServiceButton(serviceId)],
    orderId: null,
  };
}

/**
 * «درخواست بازگشت وجه» (WP19, brief §2.2): what would happen, and one confirm button.
 * Writes nothing. The offer is re-read here rather than trusted from the drawn button, so
 * a stale or forged tap on a service that is no longer eligible is told so.
 */
export async function serviceRefundAsk(
  rt: BotRuntime,
  scope: TenantContext,
  customer: CustomerRecord,
  serviceId: string,
): Promise<PendingReply> {
  const service = await ownedService(rt, scope, customer, serviceId);
  if (service === null) {
    return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
  }
  const offer = await refundOffer(rt, scope, service);
  if (offer !== 'OFFERED') return refundOfferReply(offer, service.id);
  const title = await rt.deps.purchaseTitle(scope, service.orderId);
  return {
    key: 'bot.service.refund_request_ask',
    values: { service: service.providerUsername, product: title ?? '—' },
    buttons: [
      {
        ...inlineLabel('service.refund_request_confirm'),
        data: `${SERVICE_REFUND_CONFIRM_CALLBACK_PREFIX}${service.id}`,
        row: 0,
      },
      { ...backToServiceButton(service.id), row: 1 },
    ],
    orderId: null,
  };
}

/**
 * «✅ تأیید درخواست بازگشت وجه»: opens the reason window. Still files nothing — the reason
 * files the request, so a confirmation never followed by a reason leaves no row.
 */
export async function serviceRefundConfirm(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string,
  botInstanceId: BotInstanceId,
  idempotencyKey: string,
  updateId: bigint | undefined,
): Promise<PendingReply> {
  const service = await ownedService(rt, scope, customer, serviceId);
  if (service === null) {
    return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
  }
  const offer = await refundOffer(rt, scope, service);
  if (offer !== 'OFFERED') return refundOfferReply(offer, service.id);
  await rt.deps.captures.open(scope, actor, {
    idempotencyKey: `${idempotencyKey}:refund-reason-open`,
    botInstanceId,
    customerId: customer.id,
    purpose: 'SERVICE_REFUND_REASON',
    subjectId: service.id,
    // The reason must be typed after this tap (Codex review of #83, round 8).
    ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
  });
  return {
    key: 'bot.service.refund_request_reason_prompt',
    values: {},
    buttons: [backToServiceButton(service.id)],
    orderId: null,
  };
}

/**
 * The customer's reason, which files the request exactly once (brief §2.2). An invalid
 * reason is told so and the window is opened again; everything else is decided by
 * `ServiceRefundRequestService.file`, inside its transaction.
 */
export async function serviceRefundReason(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string | null,
  text: string,
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: BotInstanceId;
    readonly update?: unknown;
  },
): Promise<PendingReply | null> {
  const refunds = rt.deps.serviceRefunds;
  if (serviceId === null) return null;
  if (refunds === undefined) return refundOfferReply('UNAVAILABLE', serviceId);
  const updateId = updateIdOf(input.update);
  // A window this message reopens reads only messages sent after it (round 8).
  const reopen = (suffix: string) =>
    rt.deps.captures.open(scope, actor, {
      idempotencyKey: `${input.idempotencyKey}:${suffix}`,
      botInstanceId: input.botInstanceId,
      customerId: customer.id,
      purpose: 'SERVICE_REFUND_REASON',
      subjectId: serviceId,
      ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
    });
  if (normaliseRefundReason(text) === null) {
    await reopen('refund-reason-reopen');
    return {
      key: 'bot.service.refund_request_reason_invalid',
      values: { min: SERVICE_REFUND_REASON_MIN_LENGTH, max: SERVICE_REFUND_REASON_MAX_LENGTH },
      buttons: [backToServiceButton(serviceId)],
      orderId: null,
    };
  }
  try {
    const result = await refunds.file(scope, actor, {
      customerId: customer.id,
      serviceId,
      botInstanceId: input.botInstanceId,
      reason: text,
      // The update that carried the reason: a redelivery files nothing new, whatever
      // became of the request in between.
      idempotencyKey: `${input.idempotencyKey}:refund-file`,
    });
    if (result.outcome === 'ALREADY_OPEN') {
      // The slot held by an operator's delete-and-refund (item 11) is not a request the
      // customer filed: no "being reviewed" sentence for it.
      return refundOfferReply(
        result.request.origin === 'CUSTOMER' ? 'PENDING' : 'UNAVAILABLE',
        serviceId,
      );
    }
    /*
     * A redelivered reason is answered with its own request, whatever became of it
     * (round 3) — so "registered, awaiting review" is said only while that is still true
     * (Codex review of #83, round 6). An approved request still deleting is pending; a
     * decided one was told through the lane, and the customer is shown the service as it
     * now stands (or `not_found`, once a completed request has hidden it).
     */
    if (result.request.state === 'EXECUTING') return refundOfferReply('PENDING', serviceId);
    if (result.request.state !== 'OPEN') {
      return serviceDetail(rt, scope, actor, customer, serviceId);
    }
    return {
      key: 'bot.service.refund_request_registered',
      values: {},
      buttons: [backToServiceButton(serviceId)],
      orderId: null,
      // A registration the customer never saw is repeated through the lane, once.
      fallback: { kind: 'SERVICE_REFUND_REQUEST_REGISTERED', subjectId: result.request.id },
    };
  } catch (error) {
    if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.SERVICE_REFUND_NOT_ELIGIBLE) {
      return refundOfferReply('UNAVAILABLE', serviceId);
    }
    if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    /*
     * A failure nobody answers — the database, a timeout, or a typed error with no reply
     * sentence such as the outbox's own — filed nothing, but reading the reason already
     * closed its window, and the webhook answers 2xx, so Telegram will not redeliver
     * (Codex review of #83, rounds 8 and 9). The window is reopened, so the customer's next
     * message files the request. A refusal that HAS a sentence is an answer, and keeps
     * the window shut: a window reopened under "not available" would swallow whatever the
     * customer typed next. Best effort: if the reopen fails too, the original failure is
     * the one reported.
     */
    if (!hasRefusalReply(error)) {
      await reopen('refund-reason-retry').catch(() => undefined);
    }
    return refusal(error);
  }
}

/**
 * «🔄 انتقال سرویس» (Package F): opens the window that reads the recipient's numeric id and
 * asks for it. Moves nothing; the service's eligibility is read again here rather than
 * trusted from the drawn button.
 */
export async function serviceTransferAsk(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string,
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: BotInstanceId;
    readonly update?: unknown;
  },
): Promise<PendingReply> {
  const transfers = rt.deps.serviceTransfers;
  if (transfers === undefined) return transferUnavailableReply(serviceId);
  const updateId = updateIdOf(input.update);
  const begun = await transfers.begin(scope, actor, {
    customerId: customer.id,
    serviceId,
    botInstanceId: input.botInstanceId,
    idempotencyKey: `${input.idempotencyKey}:transfer-open`,
    // The id must be typed after this tap, as a refund reason must (WP19 round 8).
    ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
  });
  if (begun.outcome === 'NOT_FOUND') {
    return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
  }
  if (begun.outcome === 'NOT_TRANSFERABLE') return transferUnavailableReply(serviceId);
  return {
    key: 'bot.service.transfer_prompt',
    values: {},
    buttons: [backToServiceButton(serviceId)],
    orderId: null,
  };
}

/**
 * The recipient's id, typed into the transfer window: the confirmation screen, or the
 * refusal. A refusal about the recipient opens the window again, because its sentence asks
 * for the id once more; a service that cannot be transferred, or is not theirs, does not.
 */
export async function serviceTransferRecipient(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string | null,
  text: string,
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: BotInstanceId;
    readonly update?: unknown;
  },
): Promise<PendingReply | null> {
  if (serviceId === null) return null;
  const transfers = rt.deps.serviceTransfers;
  if (transfers === undefined) return transferUnavailableReply(serviceId);
  const preview = await transfers.preview(scope, actor, {
    customerId: customer.id,
    serviceId,
    text,
  });
  if (preview.outcome === 'NOT_FOUND') {
    return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
  }
  if (preview.outcome === 'NOT_TRANSFERABLE') return transferUnavailableReply(serviceId);
  if (preview.outcome === 'REFUSED') {
    const updateId = updateIdOf(input.update);
    await rt.deps.captures.open(scope, actor, {
      idempotencyKey: `${input.idempotencyKey}:transfer-reopen`,
      botInstanceId: input.botInstanceId,
      customerId: customer.id,
      purpose: 'SERVICE_TRANSFER_RECIPIENT',
      subjectId: serviceId,
      ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
    });
    return {
      key: TRANSFER_RECIPIENT_REPLIES[preview.refusal],
      values: {},
      buttons: [backToServiceButton(serviceId)],
      orderId: null,
    };
  }
  const confirm = transferConfirmData(
    preview.serviceId,
    preview.recipientTelegramUserId,
    preview.ownershipVersion,
  );
  // Past the version a callback can carry, no confirmation is drawn rather than one
  // Telegram would refuse (`TRANSFER_CONFIRM_VERSION_MAX`).
  if (confirm === null) return transferUnavailableReply(serviceId);
  return {
    key: 'bot.service.transfer_confirm',
    values: preview.values,
    buttons: [
      {
        ...inlineLabel('service.transfer_confirm'),
        data: confirm,
        row: 0,
      },
      { ...backToServiceButton(serviceId), row: 1 },
    ],
    orderId: null,
  };
}

/**
 * «✅ تأیید انتقال سرویس»: the transfer. Keyed by THIS update, so a redelivery answers with
 * the transfer it made; a second tap is a new update, and is answered with the transfer
 * already made rather than told it failed.
 */
export async function serviceTransferConfirm(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  serviceId: string,
  confirmed: { readonly recipientTelegramUserId: string; readonly ownershipVersion: number },
  input: { readonly idempotencyKey: string; readonly botInstanceId: BotInstanceId },
): Promise<PendingReply> {
  const transfers = rt.deps.serviceTransfers;
  if (transfers === undefined) return transferUnavailableReply(serviceId);
  try {
    await transfers.transfer(scope, actor, {
      customerId: customer.id,
      serviceId,
      recipientTelegramUserId: confirmed.recipientTelegramUserId,
      ownershipVersion: confirmed.ownershipVersion,
      botInstanceId: input.botInstanceId,
      // Suffixed: the bare update key is already spent by `resolveFromUpdate` this turn.
      idempotencyKey: `${input.idempotencyKey}:transfer`,
    });
    return {
      key: 'bot.service.transfer_done',
      values: {},
      // The service is not theirs any more: back to the list, not to it.
      buttons: [
        {
          ...inlineLabel('service.back_to_list'),
          data: `${SERVICES_LIST_PAGE_CALLBACK_PREFIX}1`,
        },
      ],
      orderId: null,
    };
  } catch (error) {
    if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.SERVICE_NOT_TRANSFERABLE) {
      return transferUnavailableReply(serviceId);
    }
    if (
      isNexaError(error) &&
      error.code === COMMERCE_ERROR_CODES.SERVICE_TRANSFER_RECIPIENT_REFUSED
    ) {
      const refusal = serviceTransferRecipientRefusalSchema.safeParse(error.details['refusal']);
      return {
        key: TRANSFER_RECIPIENT_REPLIES[refusal.success ? refusal.data : 'RECIPIENT_UNKNOWN'],
        values: {},
        buttons: [backToServiceButton(serviceId)],
        orderId: null,
      };
    }
    return refusal(error);
  }
}

export async function refundOffer(
  rt: BotRuntime,
  scope: TenantContext,
  service: ServiceRecord,
): Promise<'OFFERED' | 'PENDING' | 'UNAVAILABLE'> {
  const refunds = rt.deps.serviceRefunds;
  return refunds === undefined ? 'UNAVAILABLE' : refunds.customerOffer(scope, service);
}
