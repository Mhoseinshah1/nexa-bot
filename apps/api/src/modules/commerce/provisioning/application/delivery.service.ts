import {
  COMMERCE_ERROR_CODES,
  DELIVERY_MAX_ATTEMPTS,
  errors,
  type BotInstanceId,
  type Clock,
  type ServiceDeliveryState,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerMessenger } from '../../messaging/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { CustomerContactReader, ServiceRecord, ServiceRepository } from './ports.js';

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
 *
 * ## Why `from` is an argument
 *
 * **Only `PENDING` — the automatic lane — may be moved by a failure.** A failed send
 * from any other state leaves the state exactly as it was, and that rule has two
 * distinct jobs.
 *
 * It stops a customer's own re-request from ERASING what already happened: without it
 * a customer whose service was `DELIVERED` asking again, and being refused because
 * they have since blocked the bot, moved the row back to `PENDING` and NULLed
 * `delivered_at` — destroying the record that they were told, and re-arming the sweep
 * on a service the paragraph above says must never be automatically re-announced.
 *
 * And it stops a re-request from putting `UNCONFIRMED` or `FAILED` back into the
 * sweep, which would reach round the front of the one decision this file exists to
 * make.
 */
export function deliveryStateAfter(
  from: ServiceDeliveryState,
  outcome: 'DELIVERED' | 'REFUSED' | 'UNKNOWN',
  attemptsAfter: number,
): ServiceDeliveryState {
  if (outcome === 'DELIVERED') return 'DELIVERED';
  if (from !== 'PENDING') return from;
  if (outcome === 'UNKNOWN') return 'UNCONFIRMED';
  return attemptsAfter >= DELIVERY_MAX_ATTEMPTS ? 'FAILED' : 'PENDING';
}

/**
 * How long a claimed service is held before another sweep may take it.
 *
 * The LONGEST backoff, not the shortest. A leased row that never came back was held by
 * a process that died somewhere between the claim and the send, and the message may
 * well have reached Telegram — so the next attempt waits at least as long as a refused
 * one would have, rather than announcing again a few seconds later.
 */
export const DELIVERY_LEASE_MS = DELIVERY_BACKOFF_MS * DELIVERY_MAX_ATTEMPTS;

/**
 * What one sweep did, for the loop's log and for a test.
 *
 * Counted rather than returned as records, because nothing downstream acts on the
 * services and a sweep that handed them back would invite a caller to send again.
 */
export interface DeliverySweepReport {
  readonly claimed: number;
  readonly delivered: number;
  /** Refused by Telegram, and still `PENDING` — the attempts are not spent. */
  readonly pending: number;
  /** Refused by Telegram for the last time. Needs a person. */
  readonly failed: number;
  /** Telegram may have delivered it. Never retried automatically. */
  readonly unconfirmed: number;
  /** Nothing to send, or nobody to send to. Recorded as `FAILED`. */
  readonly undeliverable: number;
  /** Claimed, then found to belong to a customer an operator blocked in the meantime. */
  readonly blocked: number;
  /** The send threw. The lease stands and the row comes back later. */
  readonly errored: number;
  /**
   * Sent, and the outcome could not be recorded because the row had moved.
   *
   * Its own count rather than part of `delivered`, because the two are different facts
   * and only this one can produce a second message to the same customer.
   */
  readonly lost: number;
}

/**
 * What one send did, and whether the row took it.
 *
 * Two fields rather than one, because "the customer was told" and "the database says
 * so" can differ, and a caller that saw only the state could not tell.
 */
export interface DeliveryRecord {
  readonly state: ServiceDeliveryState;
  readonly recorded: boolean;
}

export interface DeliveryServiceDeps {
  readonly services: ServiceRepository;
  readonly contacts: CustomerContactReader;
  readonly messenger: CustomerMessenger;
  /**
   * The tenant kill switch, read before anything leaves the process.
   *
   * Required of every write path by `nexa-conventions`, and this one sends a message as
   * well as writing a row. An operator who stopped a tenant expects its customers to
   * stop hearing from it — a background sweep that kept announcing services would be the
   * panels module's omission repeated, where a stopped tenant went on being given new
   * panels and a background monitor.
   */
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
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
  ): Promise<DeliveryRecord> {
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

    if (!(await this.scopeIsActive(scope))) {
      /*
       * The tenant has stopped accepting work.
       *
       * Refused BEFORE the send, not after: the record is the cheap half and the message
       * is the half that cannot be taken back.
       *
       * `SERVICE_NOT_DELIVERABLE` with a `reason`, which is NOT what the other
       * stopped-tenant refusals look like — `order.service.ts`, `payment.service.ts`,
       * wallet and catalog all throw `COMMERCE_REQUEST_INVALID` with no detail. The
       * shape here is deliberate and the difference is worth stating: this refusal is
       * about one SERVICE and a surface showing it has the service in front of the
       * customer, so the reason distinguishes "the tenant has stopped" from "there is
       * nothing to send yet", which are different sentences to show. Whichever surface
       * wires `redeliver` maps both to a template key; neither reaches a customer as a
       * code.
       */
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_NOT_DELIVERABLE,
        'That tenant has stopped accepting work.',
        { reason: 'SCOPE_INACTIVE' },
      );
    }

    const from = service.deliveryState;
    /*
     * The stamp that makes a dead sender recoverable, committed BEFORE the send.
     *
     * `markCallStarted` for the announcement half, and it exists for the same reason:
     * without it a process killed between handing the message to Telegram and recording
     * the outcome left the row `PENDING` behind nothing but a lease, so the automatic
     * lane announced again when that lease expired. `deliveryStateAfter` says in as many
     * words that an unknown send is never retried automatically; an ordinary container
     * restart broke that rule, which is exactly the shape of defect this codebase treats
     * as worse than one nobody claimed to have handled.
     *
     * Its own transaction, because a crash must NOT roll it back — the crash is the case
     * it records.
     *
     * A `false` means the row moved between reading it and here: another sweep, or the
     * customer's own re-request, is already sending. Refused rather than sent, because
     * two senders is the duplicate this whole file is arranged around.
     */
    const started = await this.deps.uow.run(scope, async (tx) =>
      this.deps.services.markSendStarted(scope, service.id, from, this.deps.clock.now(), tx),
    );
    if (!started) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_NOT_DELIVERABLE,
        'That service is already being sent.',
        { reason: 'SEND_IN_PROGRESS' },
      );
    }

    const result = await this.deps.messenger.send(scope, {
      chatId,
      botInstanceId,
      templateKey: 'bot.service.subscription',
      values: { subscriptionUrl: service.subscriptionUrl },
    });

    const now = this.deps.clock.now();

    /*
     * A RATE LIMIT goes back on the queue, and NO attempt is spent.
     *
     * The defect this closes is measured in `docs/phase4h-audit.md` §6b. A 429 used to
     * arrive here as `UNKNOWN`, `deliveryStateAfter` turned that into `UNCONFIRMED`, and
     * `claimDeliveryDue` never re-claims `UNCONFIRMED` — so ONE rate limit withheld a
     * paid customer's subscription link until an operator noticed. Telegram sends a 429
     * exactly when the most customers are waiting for exactly this message.
     *
     * The attempt counter must not move either. It bounds DEFINITE refusals of this
     * message, and three bursts would otherwise fail a link Telegram never rejected on
     * its merits. `recordRateLimited` is a separate repository method precisely so that
     * no boolean can blur the two.
     *
     * Telegram's own `retry_after` is preferred over any number we would invent, with
     * `DELIVERY_BACKOFF_MS` as the floor for the case where it sends none.
     */
    if (result.outcome === 'RATE_LIMITED') {
      const retryAt = new Date(now.getTime() + (result.retryAfterMs ?? DELIVERY_BACKOFF_MS));
      const held = await this.deps.uow.run(scope, async (tx) =>
        this.deps.services.recordRateLimited(scope, service.id, from, retryAt, now, tx),
      );
      return { state: from, recorded: held };
    }

    const outcome = result.outcome;
    const attemptsAfter = service.deliveryAttempts + 1;
    const to = deliveryStateAfter(from, outcome, attemptsAfter);

    const recorded = await this.deps.uow.run(scope, async (tx) =>
      this.deps.services.recordDelivery(
        scope,
        service.id,
        from,
        to,
        {
          /*
           * `services_delivered_at_check` binds the two: a DELIVERED with no time, or a
           * time on anything else, is refused by the database.
           *
           * A row that was ALREADY `DELIVERED` and stayed that way keeps its original
           * stamp rather than being re-dated by a re-request that failed — the customer
           * was told when they were told, and a failed second send is not a delivery.
           */
          deliveredAt:
            to !== 'DELIVERED' ? null : outcome === 'DELIVERED' ? now : service.deliveredAt,
          nextAttemptAt:
            to === 'PENDING' ? new Date(now.getTime() + deliveryBackoffMs(attemptsAfter)) : null,
        },
        now,
        tx,
      ),
    );

    /*
     * The conditional UPDATE's answer, RETURNED rather than discarded.
     *
     * `false` means the delivery state moved between reading this service and recording
     * the outcome — a customer's own re-request landing while the sweep held the lease.
     * The message has already gone out, so there is nothing to undo; what must not
     * happen is the sweep counting a delivery it did not persist. The caller reports it
     * separately, and a `false` here is the one case where the next sweep may send the
     * customer a second message.
     */
    return { state: to, recorded };
  }

  /**
   * One sweep: claim what is due, announce each, record what happened.
   *
   * This is the automatic half of delivery, and the ONLY caller of `deliver` that is not
   * a customer asking. It claims first — see `claimDeliveryDue` — so a second replica
   * sweeping at the same moment does not send the same customer a second message.
   *
   * Each service is handled inside its own `try`. A sweep that let one bad row throw
   * would abandon every service behind it in the batch, for ever, because the batch is
   * ordered oldest-first and the same row would lead the next one. The lease the claim
   * took is what makes the abandoned row safe to leave: it comes back when the lease
   * expires, with no attempt spent on an outcome nobody observed.
   */
  async deliverDue(scope: TenantContext, limit: number): Promise<DeliverySweepReport> {
    if (!(await this.scopeIsActive(scope))) {
      // Asked once here as well as inside `deliver`, so a stopped tenant's rows are not
      // claimed and leased only to have every one of them refused a moment later.
      return EMPTY_SWEEP;
    }
    const now = this.deps.clock.now();
    /*
     * Sends whose sender died, resolved BEFORE anything is claimed.
     *
     * A stamped row past its lease may already have reached the customer, so it leaves
     * the automatic lane as `UNCONFIRMED` rather than being announced a second time.
     * First in the tick, so the claim below cannot race it — and the claim refuses a
     * stamped row anyway, which is the same rule enforced twice on purpose.
     */
    await this.deps.uow.run(scope, async (tx) =>
      this.deps.services.reapStrandedSends(scope, now, limit, tx),
    );
    /*
     * The claim is a durable WRITE, so it goes through `uow.run`.
     *
     * It sets `delivery_next_attempt_at` to the lease, and it ran on the pool — outside
     * `DrizzleUnitOfWork.run`, and therefore outside ADR-0028's quiesce gate. A restore
     * that committed its quiesce just after the `scopeIsActive` transaction above found
     * the delivery sweep still leasing rows in the database it was replacing, and the
     * send-time check could not undo a write that had already committed. The
     * provisioning claim was moved inside the gate for exactly this reason; this was the
     * one claim left outside it.
     */
    const claimed = await this.deps.uow.run(scope, async (tx) =>
      this.deps.services.claimDeliveryDue(
        scope,
        now,
        new Date(now.getTime() + DELIVERY_LEASE_MS),
        limit,
        tx,
      ),
    );

    let delivered = 0;
    let pending = 0;
    let failed = 0;
    let unconfirmed = 0;
    let undeliverable = 0;
    let blocked = 0;
    let errored = 0;
    let lost = 0;

    for (const service of claimed) {
      try {
        /*
         * Two ways a claimed service has no announcement to make, both recorded as
         * `FAILED` rather than left `PENDING`.
         *
         * `subscriptionUrl === null` is a provider whose `ServiceDelivery` was not a
         * subscription link — `RAW_CONFIGS` and `CONFIG_FILE` exist in the contract and
         * no adapter in this release produces them, so there is no column holding one.
         * `contact === null` is a customer with no durable bot link.
         *
         * Neither improves by being retried, and `FAILED` is not the end of the road:
         * `redeliver` is allowed from every delivery state, so the customer asking for
         * their configuration still gets it and an operator can see the row.
         */
        const lookup =
          service.subscriptionUrl === null
            ? ({ kind: 'NONE' } as const)
            : await this.deps.contacts.contactFor(scope, service.customerId);
        if (lookup.kind === 'BLOCKED') {
          /*
           * Blocked between the claim and this read. LEFT ALONE, deliberately.
           *
           * Nothing is recorded, so the row keeps its `PENDING` state and its attempt
           * count, and the lease it already holds is what stops this sweep spinning on
           * it. When the lease expires the claim decides again — still blocked and the
           * query skips it; unblocked and the customer gets the announcement they paid
           * for. Recording `FAILED` here would take the automatic announcement away
           * permanently on the strength of a block that may last an hour.
           */
          blocked += 1;
          continue;
        }
        if (lookup.kind === 'NONE') {
          await this.abandon(scope, service);
          undeliverable += 1;
          continue;
        }
        const record = await this.deliver(
          scope,
          service,
          lookup.contact.chatId,
          lookup.contact.botInstanceId,
        );
        if (!record.recorded) {
          // Sent, and the outcome could not be written because somebody else had
          // already moved the row. Counted as its own thing rather than folded into
          // `delivered`, which would report a delivery this sweep did not persist.
          lost += 1;
        } else if (record.state === 'DELIVERED') delivered += 1;
        else if (record.state === 'PENDING') pending += 1;
        else if (record.state === 'FAILED') failed += 1;
        else unconfirmed += 1;
      } catch {
        /*
         * Swallowed, and deliberately not re-thrown.
         *
         * `CustomerMessenger.send` promises not to throw for a send failure, so reaching
         * here means something else broke — and the one thing that must not happen is
         * this exception reaching the service row. Delivery is a separate axis from
         * `ServiceState`; a thrown send that rolled anything back would be the start of
         * "the message failed, so provision it again".
         */
        errored += 1;
      }
    }

    return {
      claimed: claimed.length,
      delivered,
      pending,
      failed,
      unconfirmed,
      undeliverable,
      blocked,
      errored,
      lost,
    };
  }

  /**
   * Whether this tenant is still accepting work, read INSIDE a transaction.
   *
   * In a transaction rather than on the pool because that is what
   * `ScopeActivityReader` is for: a stop can commit between a surface's check and this
   * one, and a read outside a transaction can observe a snapshot either side of it.
   */
  private async scopeIsActive(scope: TenantContext): Promise<boolean> {
    return this.deps.uow.run(scope, async (tx) => this.deps.scopeActivity.scopeIsActive(scope, tx));
  }

  /**
   * Records a claimed service that cannot be announced at all. Never a send.
   *
   * ## Why there is no `scopeIsActive` read in this transaction
   *
   * Every other write path in `commerce` reads `ScopeActivityReader` inside the
   * transaction it writes in, and this one deliberately does not. Written down because
   * the next reader will notice the absence and the obvious "fix" causes a defect.
   *
   * The tenant gate is asked twice on the way here — once by `deliverDue` before it
   * claims, once by `deliver` before it sends — and both are BEFORE the irreversible
   * act. What happens after it cannot be gated: the message has either gone or been
   * refused, and this transaction only writes down which. Refusing the record because an
   * operator stopped the tenant in the meantime would leave the row `PENDING` behind an
   * expiring lease, and the fact would be re-derived by sending the customer a SECOND
   * message once the tenant started again. A gate that produces a duplicate announcement
   * is not a gate.
   *
   * So the rule here is the narrower one the surrounding code already follows: the tenant
   * kill switch stops new outbound work, and it never discards the record of work
   * already done.
   */
  private async abandon(scope: TenantContext, service: ServiceRecord): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.uow.run(scope, async (tx) => {
      await this.deps.services.recordDelivery(
        scope,
        service.id,
        service.deliveryState,
        'FAILED',
        { deliveredAt: null, nextAttemptAt: null },
        now,
        tx,
      );
    });
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
  ): Promise<DeliveryRecord> {
    if (service.customerId !== customerId) {
      throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
    }
    return this.deliver(scope, service, chatId, botInstanceId);
  }
}

/** Nothing claimed, nothing sent. The answer for a tenant that has stopped. */
const EMPTY_SWEEP: DeliverySweepReport = {
  claimed: 0,
  delivered: 0,
  pending: 0,
  failed: 0,
  unconfirmed: 0,
  undeliverable: 0,
  blocked: 0,
  errored: 0,
  lost: 0,
};
