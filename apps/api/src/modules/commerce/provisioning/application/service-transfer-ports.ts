import type { ActorType, BotInstanceId, TenantContext, UserId } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * One change of a service's owner (Package F), as `service_ownership_transfers` holds it.
 * Append-only: the row is written once, in the transaction that moves the service.
 */
export interface ServiceTransferRecord {
  readonly id: string;
  readonly serviceId: string;
  readonly fromCustomerId: UserId;
  readonly toCustomerId: UserId;
  /** Null for an operator's account transfer (Customer 360), which no bot carried. */
  readonly botInstanceId: BotInstanceId | null;
  readonly idempotencyKey: string;
  readonly actorType: ActorType;
  readonly actorLabel: string | null;
  readonly correlationId: string;
  readonly createdAt: Date;
}

export interface ServiceTransferDraft {
  readonly id: string;
  readonly serviceId: string;
  readonly fromCustomerId: UserId;
  readonly toCustomerId: UserId;
  /** Null only for an operator's account transfer; a customer's always names a bot. */
  readonly botInstanceId: BotInstanceId | null;
  readonly idempotencyKey: string;
  readonly actorType: ActorType;
  readonly actorLabel: string | null;
  readonly correlationId: string;
  readonly now: Date;
}

export interface ServiceTransferRepository {
  /** The transfer this idempotency key wrote, whatever became of the service since. */
  findByKey(
    scope: TenantContext,
    idempotencyKey: string,
    tx?: unknown,
  ): Promise<ServiceTransferRecord | null>;

  findById(scope: TenantContext, id: string, tx?: unknown): Promise<ServiceTransferRecord | null>;

  /**
   * The NEWEST transfer of a service, by the row's sequence — the same row
   * `nexa_services_ownership_guard` reads to admit a change of `services.customer_id`.
   */
  newestForService(
    scope: TenantContext,
    serviceId: string,
    tx?: unknown,
  ): Promise<ServiceTransferRecord | null>;

  /**
   * How many times this service has changed hands: its ownership VERSION. The rows are
   * append-only, so the count only grows, and every change of owner adds exactly one. A
   * confirmation carries the version it was made at; one made before a later change of
   * owner no longer matches (`CONFIRMATION_STALE`).
   */
  countForService(scope: TenantContext, serviceId: string, tx?: unknown): Promise<number>;

  /**
   * Writes the row. `null` when the key already wrote one: the caller answers with THAT
   * row rather than transferring twice.
   */
  create(
    scope: TenantContext,
    draft: ServiceTransferDraft,
    tx: TransactionScope,
  ): Promise<ServiceTransferRecord | null>;

  /**
   * Hands the service to the recipient and clears the sender's note, in one UPDATE whose
   * WHERE names the sender — so a service that is not the sender's any more is not written.
   * The database admits it only because the transfer row was written first, in this
   * transaction.
   */
  reassign(
    scope: TenantContext,
    input: {
      readonly serviceId: string;
      readonly fromCustomerId: UserId;
      readonly toCustomerId: UserId;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Whether an operation on this service is undecided (`PLANNED`, `IN_FLIGHT`, `UNKNOWN`),
   * other than a SCHEDULED usage read — one no customer asked for, whose outcome nobody is
   * told. A usage read a customer asked for is announced to whoever owns the service when
   * it ends, so it holds the transfer back like any other operation.
   */
  operationUndecided(scope: TenantContext, serviceId: string, tx?: unknown): Promise<boolean>;

  /**
   * Whether a commercial order for this service (a renewal, an add-on) is
   * `AWAITING_PAYMENT`: its payer may be paying for it right now.
   */
  commercialPaymentPending(scope: TenantContext, serviceId: string, tx?: unknown): Promise<boolean>;
}
