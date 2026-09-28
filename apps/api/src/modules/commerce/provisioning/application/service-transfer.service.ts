import {
  COMMERCE_ERROR_CODES,
  SERVICE_TRANSFERABLE_STATES,
  errors,
  telegramUserIdSchema,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type BotInstanceId,
  type Clock,
  type IdGenerator,
  type OperationalEventRecorder,
  type PermissionKey,
  type ServiceTransferIneligibilityReason,
  type ServiceTransferRecipientRefusal,
  type TemplateValues,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerCaptureService } from '../../customers/application/customer-capture.service.js';
import type { CustomerRecord, CustomerRepository } from '../../customers/application/ports.js';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';
import type { CustomerScreenComposer } from '../../messaging/application/customer-screens.js';
import type { OrderRepository } from '../../orders/application/ports.js';
import type { ServiceRecord, ServiceRepository } from './ports.js';
import type { ServiceTransferRecord, ServiceTransferRepository } from './service-transfer-ports.js';

/**
 * What a customer's own transfer is charged through the guard: `maintenance.run`, the key
 * every customer write through the webhook's `SYSTEM_JOB` takes (`SUBSCRIPTION_FILES_PERMISSION`,
 * `CUSTOMER_ROTATION_PERMISSION`). `services.transfer` is the OPERATOR's key, and no operator
 * route exists.
 */
export const SERVICE_TRANSFER_PERMISSION: PermissionKey = 'maintenance.run';

/**
 * A typed recipient id, or null.
 *
 * Trimmed, with Persian `۰-۹` and Arabic-Indic `٠-٩` digits read as ASCII — a customer
 * copying the id their recipient's `/wallet` shows may type it on a Persian keyboard — and
 * then held to `telegramUserIdSchema`, the one rule for a Telegram numeric id.
 */
export function parseRecipientTelegramId(text: string): string | null {
  const ascii = text
    .trim()
    .replace(/[۰-۹]/gu, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660));
  const parsed = telegramUserIdSchema.safeParse(ascii);
  return parsed.success ? parsed.data : null;
}

/**
 * How the confirmation names the recipient: their name, then their @username, as Telegram
 * last gave them. Null when Telegram gave neither — the numeric id is always shown beside.
 */
export function recipientNameOf(customer: CustomerRecord): string | null {
  const name = [customer.firstName, customer.lastName]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim())
    .join(' ');
  const username =
    customer.username !== null && customer.username.trim().length > 0
      ? `@${customer.username.trim()}`
      : '';
  const both = [name, username].filter((part) => part.length > 0).join(' ');
  return both.length === 0 ? null : both;
}

export interface ServiceTransferDeps {
  readonly repository: ServiceTransferRepository;
  readonly services: Pick<
    ServiceRepository,
    'findById' | 'findForCustomer' | 'lockForUpdate' | 'lockLifecycle' | 'hasActiveRefundRequest'
  >;
  readonly orders: Pick<OrderRepository, 'findById'>;
  readonly customers: Pick<CustomerRepository, 'findById' | 'list'>;
  readonly captures: Pick<CustomerCaptureService, 'open'>;
  readonly screens: Pick<CustomerScreenComposer, 'serviceSummary'>;
  /** The location the service card shows for this service, or null. */
  readonly locationOf: (scope: TenantContext, service: ServiceRecord) => Promise<string | null>;
  readonly notifier: CustomerNotifier;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly guard: PermissionGuard;
  readonly sessions: SessionRepository;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** The answer to the transfer button: the prompt is open, or why not. */
export type ServiceTransferBeginResult =
  | { readonly outcome: 'OPENED' }
  | { readonly outcome: 'NOT_FOUND' }
  | { readonly outcome: 'NOT_TRANSFERABLE'; readonly reason: ServiceTransferIneligibilityReason };

/** The answer to a typed recipient id: the confirmation screen, or why not. */
export type ServiceTransferPreviewResult =
  | {
      readonly outcome: 'READY';
      readonly serviceId: string;
      readonly recipientTelegramUserId: string;
      /**
       * The service's ownership version when this screen was drawn. The confirmation
       * carries it back, and a transfer made since refuses it (`CONFIRMATION_STALE`).
       */
      readonly ownershipVersion: number;
      /** The values `bot.service.transfer_confirm` renders. */
      readonly values: TemplateValues;
    }
  | { readonly outcome: 'REFUSED'; readonly refusal: ServiceTransferRecipientRefusal }
  | { readonly outcome: 'NOT_TRANSFERABLE'; readonly reason: ServiceTransferIneligibilityReason }
  | { readonly outcome: 'NOT_FOUND' };

/**
 * A committed transfer. `replayed` is true when this call wrote nothing because the SAME
 * transfer had already been made — a redelivered update, or a second tap on a stale
 * confirmation — and the answer is that transfer, not an error.
 */
export interface ServiceTransferResult {
  readonly outcome: 'TRANSFERRED';
  readonly transfer: ServiceTransferRecord;
  readonly replayed: boolean;
}

/**
 * Package F — a customer hands one of their own services to another customer of the same
 * tenant (`docs/package-f-service-transfer-audit.md`).
 *
 * Only ownership moves. The order stays the payer's; the payment, the wallet, cashback,
 * referral commission and every earlier renewal stay where they were written; the provider
 * account is not called at all. The sender's note is cleared, because it was theirs.
 *
 * One evaluator decides whether a service may change hands, with three callers: the button
 * (a courtesy), the preview, and the transfer itself — which decides again under the
 * service's row lock and its lifecycle lock, the locks a terminate, a refund request and a
 * commercial settlement serialise on.
 */
export class ServiceTransferService {
  constructor(private readonly deps: ServiceTransferDeps) {}

  // --- eligibility ------------------------------------------------------------------------

  /**
   * Why this service cannot change hands now, or null when it can (audit §4). Read without
   * locks by the button and the preview; the transfer calls it again under both locks.
   */
  async ineligibilityOf(
    scope: TenantContext,
    service: ServiceRecord,
    tx?: unknown,
  ): Promise<ServiceTransferIneligibilityReason | null> {
    if (!(SERVICE_TRANSFERABLE_STATES as readonly string[]).includes(service.state)) {
      return 'SERVICE_STATE';
    }
    // A link still on its way would reach whoever owns the service when the send is retried.
    if (service.deliveryState !== 'DELIVERED') return 'NOT_DELIVERED';
    const order = await this.deps.orders.findById(scope, service.orderId, tx);
    // `services_order_fk` requires the row: its absence is a broken database.
    if (order === null) throw new Error(`service ${service.id} names no order`);
    // A trial is free and counts against its claimant's allowance: it does not move.
    if (order.purpose === 'TRIAL') return 'TRIAL';
    if (await this.deps.repository.operationUndecided(scope, service.id, tx)) {
      return 'OPERATION_PENDING';
    }
    if (await this.deps.services.hasActiveRefundRequest(scope, service.id, tx)) {
      return 'REFUND_REQUESTED';
    }
    if (await this.deps.repository.commercialPaymentPending(scope, service.id, tx)) {
      return 'PAYMENT_PENDING';
    }
    return null;
  }

  /** Whether the service detail draws «🔄 انتقال سرویس». A courtesy; never trusted. */
  async offered(scope: TenantContext, service: ServiceRecord): Promise<boolean> {
    return (await this.ineligibilityOf(scope, service)) === null;
  }

  // --- the customer's flow -----------------------------------------------------------------

  /**
   * The transfer button: opens the window that reads the recipient's id. Moves nothing.
   * The window names the service and reads only messages newer than the tap.
   */
  async begin(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      readonly serviceId: string;
      readonly botInstanceId: BotInstanceId;
      readonly idempotencyKey: string;
      readonly openedUpdateId?: bigint;
    },
  ): Promise<ServiceTransferBeginResult> {
    await this.deps.guard.check(scope, actor, SERVICE_TRANSFER_PERMISSION);
    const service = await this.ownedService(scope, input.customerId, input.serviceId);
    if (service === null) return { outcome: 'NOT_FOUND' };
    const reason = await this.ineligibilityOf(scope, service);
    if (reason !== null) return { outcome: 'NOT_TRANSFERABLE', reason };
    await this.deps.captures.open(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      botInstanceId: input.botInstanceId,
      customerId: input.customerId,
      purpose: 'SERVICE_TRANSFER_RECIPIENT',
      subjectId: service.id,
      ...(input.openedUpdateId === undefined ? {} : { openedUpdateId: input.openedUpdateId }),
    });
    return { outcome: 'OPENED' };
  }

  /**
   * The typed recipient id: the confirmation screen, or the refusal. Reads only — the
   * transfer resolves the recipient again, and trusts nothing its button carries.
   */
  async preview(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly customerId: UserId; readonly serviceId: string; readonly text: string },
  ): Promise<ServiceTransferPreviewResult> {
    await this.deps.guard.check(scope, actor, SERVICE_TRANSFER_PERMISSION);
    const service = await this.ownedService(scope, input.customerId, input.serviceId);
    if (service === null) return { outcome: 'NOT_FOUND' };
    const telegramUserId = parseRecipientTelegramId(input.text);
    if (telegramUserId === null) return { outcome: 'REFUSED', refusal: 'RECIPIENT_INVALID' };
    const recipient = await this.findRecipient(scope, telegramUserId);
    const refusal = recipientRefusal(recipient, input.customerId);
    if (refusal !== null || recipient === null) {
      return { outcome: 'REFUSED', refusal: refusal ?? 'RECIPIENT_UNKNOWN' };
    }
    const reason = await this.ineligibilityOf(scope, service);
    if (reason !== null) return { outcome: 'NOT_TRANSFERABLE', reason };
    const name = recipientNameOf(recipient);
    return {
      outcome: 'READY',
      serviceId: service.id,
      recipientTelegramUserId: recipient.telegramUserId,
      ownershipVersion: await this.deps.repository.countForService(scope, service.id),
      values: {
        ...(await this.summaryOf(scope, service)),
        recipientId: recipient.telegramUserId,
        ...(name === null ? {} : { recipientName: name }),
      },
    };
  }

  /**
   * «✅ تأیید انتقال سرویس»: the transfer, in ONE transaction (audit §5).
   *
   * 1. The key. A redelivered update answers with the row it already wrote.
   * 2. The service row (`FOR NO KEY UPDATE`), then the lifecycle lock — the order a
   *    terminate and a refund request take, and the lock a commercial settlement takes.
   * 3. Everything decided again: the owner, the recipient, the service's eligibility. A
   *    sender who no longer owns the service because THIS transfer already happened — the
   *    newest transfer row is sender → this recipient — is answered with that transfer: a
   *    double tap is two updates with two keys, and the second must not say the first
   *    failed. A sender who DOES own it is held to the ownership version the confirmation
   *    was drawn at: a screen from before the service changed hands and came back is
   *    refused (`CONFIRMATION_STALE`), because Telegram leaves it tappable.
   * 4. The transfer row FIRST, because the database admits the change of owner only when
   *    the newest row names it; then the service (owner, note cleared), the audit row, the
   *    event and the recipient's notification.
   *
   * The provider is not called. The recipient's customer row is read, not locked: a block
   * committed a moment later is the same as one a moment after the transfer.
   */
  async transfer(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      readonly serviceId: string;
      readonly recipientTelegramUserId: string;
      /** The version `preview` returned for the screen being confirmed. */
      readonly ownershipVersion: number;
      readonly botInstanceId: BotInstanceId;
      readonly idempotencyKey: string;
    },
  ): Promise<ServiceTransferResult> {
    const denial = {
      action: 'service.transfer',
      entityType: 'Service',
      entityId: input.serviceId,
    };
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      SERVICE_TRANSFER_PERMISSION,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'That tenant has stopped accepting work.',
          );
        }
        const sender = await this.deps.customers.findById(scope, input.customerId, tx);
        if (sender === null) throw notFound();
        if (sender.status !== 'ACTIVE') {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.CUSTOMER_BLOCKED,
            'This customer cannot act on their services.',
          );
        }

        // A replay of this very confirmation, whatever became of the service since.
        const replayed = await this.deps.repository.findByKey(scope, input.idempotencyKey, tx);
        if (replayed !== null) {
          if (replayed.serviceId !== input.serviceId || replayed.fromCustomerId !== sender.id) {
            throw errors.conflict(
              COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
              'That idempotency key already transferred a different service.',
            );
          }
          return { outcome: 'TRANSFERRED', transfer: replayed, replayed: true };
        }

        const serviceId = uuidV7Schema.safeParse(input.serviceId);
        if (!serviceId.success) throw notFound();
        const telegramUserId = parseRecipientTelegramId(input.recipientTelegramUserId);
        if (telegramUserId === null) throw recipientRefused('RECIPIENT_INVALID');

        const locked = await this.deps.services.lockForUpdate(scope, serviceId.data, tx);
        if (locked === null) throw notFound();
        await this.deps.services.lockLifecycle(scope, locked.id, tx);

        const recipient = await this.findRecipient(scope, telegramUserId, tx);
        if (locked.customerId !== sender.id) {
          const newest = await this.deps.repository.newestForService(scope, locked.id, tx);
          if (
            newest !== null &&
            recipient !== null &&
            newest.fromCustomerId === sender.id &&
            newest.toCustomerId === recipient.id
          ) {
            return { outcome: 'TRANSFERRED', transfer: newest, replayed: true };
          }
          throw notFound();
        }
        // Owned, and not paid back and deleted at the owner's own request (WP19): the
        // customer-facing predicate, read under the lock.
        const service = await this.deps.services.findForCustomer(scope, sender.id, locked.id, tx);
        if (service === null) throw notFound();
        // Read under the row lock every transfer of this service takes, so no change of
        // owner can land between this count and the write below.
        const version = await this.deps.repository.countForService(scope, service.id, tx);
        if (version !== input.ownershipVersion) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.SERVICE_NOT_TRANSFERABLE,
            'This confirmation was made before the service last changed hands.',
            { reason: 'CONFIRMATION_STALE' satisfies ServiceTransferIneligibilityReason },
          );
        }

        const refusal = recipientRefusal(recipient, sender.id);
        if (refusal !== null || recipient === null) {
          throw recipientRefused(refusal ?? 'RECIPIENT_UNKNOWN');
        }
        const reason = await this.ineligibilityOf(scope, service, tx);
        if (reason !== null) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.SERVICE_NOT_TRANSFERABLE,
            'This service cannot be transferred now.',
            { reason },
          );
        }

        const now = this.deps.clock.now();
        const written = await this.deps.repository.create(
          scope,
          {
            id: this.deps.ids.uuid(),
            serviceId: service.id,
            fromCustomerId: sender.id,
            toCustomerId: recipient.id,
            botInstanceId: input.botInstanceId,
            idempotencyKey: input.idempotencyKey,
            actorType: actor.type,
            actorLabel: actor.label,
            correlationId: actor.correlationId,
            now,
          },
          tx,
        );
        if (written === null) {
          // Unreachable under the row lock, which serialises every transfer of this service:
          // a key cannot be written by two of them. A broken database, not a condition.
          throw new Error(`transfer key ${input.idempotencyKey} was written concurrently`);
        }
        const moved = await this.deps.repository.reassign(
          scope,
          {
            serviceId: service.id,
            fromCustomerId: sender.id,
            toCustomerId: recipient.id,
            now,
          },
          tx,
        );
        if (!moved) throw new Error(`service ${service.id} changed owner under its row lock`);

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'service.transfer',
            entityType: 'Service',
            entityId: service.id,
            before: { customerId: sender.id },
            // Ids only: never the subscription link, its token or a file.
            after: { customerId: recipient.id, transferId: written.id },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'ServiceOwnershipTransferred',
          aggregateType: 'Service',
          aggregateId: service.id,
          payload: {
            serviceId: service.id,
            fromCustomerId: sender.id,
            toCustomerId: recipient.id,
          },
        });
        // In this transaction, so a Telegram failure never undoes the transfer: the lane's
        // own retries carry the message (brief F6).
        await this.deps.notifier.notify(
          scope,
          recipient.id,
          'SERVICE_TRANSFER_RECEIVED',
          written.id,
          now,
          tx,
        );
        return { outcome: 'TRANSFERRED', transfer: written, replayed: false };
      },
    );
  }

  // --- the recipient's notification --------------------------------------------------------

  /**
   * What `SERVICE_TRANSFER_RECEIVED` renders, read at send time from the transfer row and
   * the service it names — a reader, not a payload (ADR 0030 §1) — and the service its one
   * button opens. Null when the row or the service cannot be read.
   */
  async notificationFacts(
    scope: TenantContext,
    transferId: string,
  ): Promise<{ readonly values: TemplateValues; readonly serviceId: string } | null> {
    const id = uuidV7Schema.safeParse(transferId);
    if (!id.success) return null;
    const transfer = await this.deps.repository.findById(scope, id.data);
    if (transfer === null) return null;
    const service = await this.deps.services.findById(scope, transfer.serviceId);
    if (service === null) return null;
    return { values: await this.summaryOf(scope, service), serviceId: service.id };
  }

  // --- internals ---------------------------------------------------------------------------

  /** The customer's own service, not refunded away — or null, for any other id. */
  private async ownedService(
    scope: TenantContext,
    customerId: UserId,
    serviceId: string,
  ): Promise<ServiceRecord | null> {
    const parsed = uuidV7Schema.safeParse(serviceId);
    if (!parsed.success) return null;
    return this.deps.services.findForCustomer(scope, customerId, parsed.data);
  }

  /**
   * The customer of THIS tenant with that exact numeric id — the exact lookup the admin
   * search uses. A customer of another tenant is not found, so a transfer cannot cross one.
   */
  private async findRecipient(
    scope: TenantContext,
    telegramUserId: string,
    tx?: unknown,
  ): Promise<CustomerRecord | null> {
    const page = await this.deps.customers.list(scope, { telegramUserId }, 1, null, tx);
    return page.items[0] ?? null;
  }

  private async summaryOf(scope: TenantContext, service: ServiceRecord): Promise<TemplateValues> {
    return this.deps.screens.serviceSummary(scope, {
      serviceUsername: service.providerUsername,
      serviceLocation: await this.deps.locationOf(scope, service),
      trafficLimitBytes: service.trafficLimitBytes,
      trafficUsedBytes: service.trafficUsedBytes,
      usageSyncedAt: service.usageSyncedAt,
      expiresAt: service.expiresAt,
      now: this.deps.clock.now(),
    });
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}

/** The recipient's refusal, or null when they may be given the service (audit §3). */
function recipientRefusal(
  recipient: CustomerRecord | null,
  senderId: UserId,
): ServiceTransferRecipientRefusal | null {
  if (recipient === null) return 'RECIPIENT_UNKNOWN';
  if (recipient.id === senderId) return 'RECIPIENT_SELF';
  if (recipient.status !== 'ACTIVE') return 'RECIPIENT_BLOCKED';
  return null;
}

function notFound() {
  return errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
}

function recipientRefused(refusal: ServiceTransferRecipientRefusal) {
  return errors.conflict(
    COMMERCE_ERROR_CODES.SERVICE_TRANSFER_RECIPIENT_REFUSED,
    'That customer cannot be given this service.',
    { refusal },
  );
}
