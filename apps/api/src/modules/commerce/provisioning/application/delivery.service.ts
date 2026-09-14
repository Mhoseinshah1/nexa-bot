import {
  COMMERCE_ERROR_CODES,
  DELIVERY_MAX_ATTEMPTS,
  errors,
  type ActorContext,
  type BotInstanceId,
  type Clock,
  type IdGenerator,
  type ServiceDeliveryState,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerMessenger } from '../../messaging/application/ports.js';
import type { ServiceRecord, ServiceRepository } from './ports.js';

/**
 * How long before a refused delivery is tried again.
 *
 * Minutes rather than seconds, and far longer than the provisioning backoff. A provider
 * create is worth retrying quickly because a customer is waiting for something nothing
 * else can produce; a Telegram send that was REFUSED was refused for a reason — the
 * customer blocked the bot, the chat is gone — and hammering it neither helps them nor
 * respects somebody else's API.
 */
export const DELIVERY_BACKOFF_MS = 5 * 60_000;

export function deliveryBackoffMs(attempts: number): number {
  return DELIVERY_BACKOFF_MS * Math.max(1, Math.min(attempts, DELIVERY_MAX_ATTEMPTS));
}

/**
 * The delivery state one send outcome produces.
 *
 * Pure and total, so the mapping is one table rather than a branch in a loop, and so
 * the rule that matters can be stated once: an `UNKNOWN` send is NEVER retried
 * automatically. The customer messenger's own port already gives the reason — a
 * retried "your service is ready" is a customer wondering which one is true — and the
 * whole point of `UNCONFIRMED` is to hold that fact where an operator can see it
 * instead of guessing.
 *
 * A definite `REFUSED` stays `PENDING` until the attempts run out, because a refusal
 * changed nothing and the situation is identical to never having tried.
 */
export function deliveryStateFor(
  outcome: 'DELIVERED' | 'REFUSED' | 'UNKNOWN',
  attemptsAfter: number,
): ServiceDeliveryState {
  if (outcome === 'DELIVERED') return 'DELIVERED';
  if (outcome === 'UNKNOWN') return 'UNCONFIRMED';
  return attemptsAfter >= DELIVERY_MAX_ATTEMPTS ? 'FAILED' : 'PENDING';
}

export interface DeliveryServiceDeps {
  readonly services: ServiceRepository;
  readonly messenger: CustomerMessenger;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * Telling a customer their service is ready, and never doing anything else.
 *
 * ## The one rule this file exists to hold
 *
 * A failed send must leave the service ACTIVE. Delivery is a separate axis from
 * `ServiceState` — `provisioning.ts` says so and the schema enforces it — because
 * folding them together would make a failed Telegram message look like an
 * unprovisioned service, and the obvious fix for that is to provision it again. So
 * nothing here transitions a service, nothing here plans an operation, and nothing here
 * touches a panel.
 *
 * ## Why the send is outside the transaction
 *
 * Same reason a provider call is. The transaction that records the outcome is opened
 * AFTER the send returns, and it is a conditional UPDATE on the delivery state the send
 * was attempted from — so two workers that both sent lose one write rather than
 * double-counting the attempts.
 */
export class DeliveryService {
  constructor(private readonly deps: DeliveryServiceDeps) {}

  /**
   * Sends one service's subscription to its owner, and records what happened.
   *
   * Takes the bot instance explicitly rather than resolving "the tenant's active bot".
   * A customer wrote to a specific bot, and a message from a different one arrives from
   * an account they have never heard of — which, for a tenant running a public bot and
   * a reseller bot, leaks the relationship between them. The messaging port makes the
   * same argument about its own `botInstanceId`, and this is the caller that has to
   * honour it.
   */
  async deliver(
    scope: TenantContext,
    service: ServiceRecord,
    chatId: string,
    botInstanceId: BotInstanceId,
  ): Promise<ServiceDeliveryState> {
    if (service.subscriptionUrl === null) {
      /*
       * Nothing to send.
       *
       * Refused rather than sent as an empty message, because a message with no link in
       * it reads to a customer exactly like a delivery. `SERVICE_NOT_DELIVERABLE` names
       * the real situation: the service is theirs and it has no configuration yet.
       */
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_NOT_DELIVERABLE,
        'That service has nothing to send yet.',
        { reason: 'NO_SUBSCRIPTION' },
      );
    }

    const from = service.deliveryState;
    const outcome = await this.deps.messenger.send(scope, {
      chatId,
      botInstanceId,
      templateKey: 'bot.service.subscription',
      values: { subscriptionUrl: service.subscriptionUrl },
    });

    const now = this.deps.clock.now();
    const attemptsAfter = service.deliveryAttempts + 1;
    const to = deliveryStateFor(outcome, attemptsAfter);

    await this.deps.uow.run(scope, async (tx) => {
      await this.deps.services.recordDelivery(
        scope,
        service.id,
        from,
        to,
        {
          // `services_delivered_at_check` binds the two: a DELIVERED with no time, or a
          // time on anything else, is refused by the database.
          deliveredAt: to === 'DELIVERED' ? now : null,
          nextAttemptAt:
            to === 'PENDING' ? new Date(now.getTime() + deliveryBackoffMs(attemptsAfter)) : null,
        },
        now,
        tx,
      );
    });

    return to;
  }

  /**
   * The services whose announcement is due, for the sweep.
   *
   * `PENDING` only. `UNCONFIRMED` and `FAILED` are deliberately never swept — both need
   * a person, for reasons `SERVICE_DELIVERY_STATES` gives — and `DELIVERED` is done.
   */
  async due(scope: TenantContext, limit: number): Promise<readonly ServiceRecord[]> {
    return this.deps.services.claimDeliveryDue(scope, this.deps.clock.now(), limit);
  }

  /**
   * A customer asking for their configuration again.
   *
   * Allowed from ANY delivery state including `DELIVERED`, `UNCONFIRMED` and `FAILED`,
   * because a deliberate request is the remedy for all three: the customer is in front
   * of the bot, so the message is wanted and its arrival is observable to them. That is
   * exactly what an automatic retry is not, and why the sweep refuses the last two.
   */
  async redeliver(
    scope: TenantContext,
    service: ServiceRecord,
    customerId: UserId,
    chatId: string,
    botInstanceId: BotInstanceId,
  ): Promise<ServiceDeliveryState> {
    if (service.customerId !== customerId) {
      throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
    }
    return this.deliver(scope, service, chatId, botInstanceId);
  }
}

/** Kept so a reader can see the actor shape a sweep uses without opening the loop. */
export type DeliveryActor = ActorContext;
