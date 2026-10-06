import {
  COMMERCE_ERROR_CODES,
  DELIVERY_MAX_ATTEMPTS,
  errors,
  type ActorContext,
  type BotInstanceId,
  type Clock,
  type PermissionKey,
  type ServiceDeliveryState,
  type TenantContext,
  type UnitOfWork,
  type UserId,
  type TemplateValues,
  deliveryModeOf,
} from '@nexa/contracts';
import type { PanelPolicyGate } from '../../../platform/panels/application/panel-policy.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CustomerButton,
  CustomerMessenger,
  CustomerSendResult,
} from '../../messaging/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import { serviceIdOrNotFound } from './service-id.js';
import { inlineLabel } from '../../messaging/application/inline-buttons.js';
import {
  cardRetryDelayMs,
  type CardMessageRef,
  type OperationCardRepository,
} from './operation-card.js';
import type {
  CustomerContactReader,
  DeliveryQrRenderer,
  ServiceRecord,
  ServiceRepository,
} from './ports.js';

/** What an operator-initiated resend charges. The same key every other service edit does. */
const SERVICE_EDIT_PERMISSION: PermissionKey = 'services.edit';

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
  /**
   * Codex review of #116: the chat and bot the link actually went to, when that is not the
   * caller's — a link change answered ON the card it was asked from, through the bot that
   * drew that card. The files that follow go there too, so they arrive beside the link.
   */
  readonly sentTo?: { readonly chatId: string; readonly botInstanceId: BotInstanceId };
}

/**
 * What the delivery card says about the service besides its link (customer UX
 * completion §B): the product's public name (frozen on the order), the service's
 * location label (display data, read live — a label is not a snapshot-worthy fact; the
 * precedence is `displayedServiceLocation`'s, pre-support A6), and the plan's duration and
 * allowance. Null when the order or
 * product cannot be read, and then the plain link message is sent rather than a card
 * with holes in it.
 */
export interface DeliveryCardFacts {
  readonly productName: string;
  readonly serviceLocation: string | null;
  readonly durationDays: number;
  readonly trafficBytes: bigint;
}

export interface DeliveryCardFactsReader {
  factsFor(scope: TenantContext, service: ServiceRecord): Promise<DeliveryCardFacts | null>;
}

export interface DeliveryServiceDeps {
  readonly services: ServiceRepository;
  readonly contacts: CustomerContactReader;
  readonly messenger: CustomerMessenger;
  /**
   * The QR renderer, asked for the code of the EXACT `subscriptionUrl` the row holds at send
   * time — the same string `markSendStarted` compares-and-sets — and of nothing else. Never a
   * draft URL, never the panel's base URL, never the username. Phase 2 item 4: it draws the
   * code on the tenant's QR background when one is configured, at all three sites below;
   * what the code encodes is the same either way.
   */
  readonly qr: DeliveryQrRenderer;
  readonly card: DeliveryCardFactsReader;
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
  /**
   * For the ONE operator-initiated path here, `resendForOperator`.
   *
   * The sweep does not use it and cannot: a background lane has no caller to authorize
   * and runs as `SYSTEM_JOB`. It is on the deps rather than reached through another
   * service so that the permission charged for a resend is visible in this file, beside
   * the send it authorises.
   */
  readonly guard: PermissionGuard;
  /**
   * The panel's delivery mode (WP-A8): whether the card carries the QR image of the
   * link. Either way the SAME approved card text and buttons are sent; the policy
   * changes only whether a photo goes with them, and an unreadable policy sends the
   * default card.
   */
  readonly panelPolicy: PanelPolicyGate;
  /**
   * R3 item 6: the connection files, sent right after an AUTOMATIC delivery was recorded
   * DELIVERED — for every purchase kind, since this lane never knows what bought the
   * service. Optional: without it the lane sends the link and nothing more.
   */
  readonly files?: AutomaticFileSender;
  /**
   * R3 item 9: whether the service's link has been changed since it was created. The
   * automatic lane then announces the NEW link as a link change — never as «service
   * created». Optional: without it every automatic delivery is the purchase card.
   */
  readonly rotations?: RotationHistoryReader;
  /**
   * Round N (F4): the service card a customer's link change was asked from. The new link is
   * delivered ON that card (`claimRotationCard`) instead of in a message beside it.
   * Optional: without it the link change is announced as its own message, as in R3.
   */
  readonly cards?: Pick<OperationCardRepository, 'claimRotationCard' | 'release'>;
  /**
   * Pre-support A9: the durable claim behind the QR photo sent under the link view. Absent,
   * the link view sends no QR at all — never one that a replay could send again.
   */
  readonly linkQr?: LinkQrClaims;
  /**
   * Phase 2 item 5: the panel's optional tutorial, after the connection files of the FIRST
   * automatic delivery of a purchase or a trial — never a rotation's, never a resend's.
   * Optional: without it nothing follows the files.
   */
  readonly tutorial?: AutomaticTutorialSender;
}

/**
 * Phase 2 item 5: what sends a panel's tutorial after a service on it was delivered.
 *
 * Holds its own at-most-once claim per service and never throws for a send; whatever it
 * returns is for a log line. The delivery is recorded already and is never touched by it.
 */
export interface AutomaticTutorialSender {
  afterDelivery(
    scope: TenantContext,
    service: ServiceRecord,
    contact: { readonly chatId: string; readonly botInstanceId: BotInstanceId },
  ): Promise<unknown>;
}

/**
 * Pre-support A9: one QR photo per «🔗 لینک اشتراک» tap, and never a second for the same tap.
 *
 * `claim` records the tap's key inside the caller's transaction and answers whether THIS
 * caller recorded it: `false` is a replay (Telegram redelivering the update), or a concurrent
 * twin, and the photo is not sent. The claim is committed BEFORE the photo is sent, so a
 * sender that died mid-send leaves the claim standing and the photo is never sent twice.
 */
export interface LinkQrClaims {
  claim(scope: TenantContext, key: string, tx: TransactionScope): Promise<boolean>;
}

/**
 * R3 item 6: what sends a service's connection files after its link was delivered.
 *
 * Never throws for the files: a file that did not arrive is not a failed delivery and
 * certainly not a failed provisioning, and the customer can still ask for them from the
 * service card. Whatever it returns is for a log line.
 */
export interface AutomaticFileSender {
  afterDelivery(
    scope: TenantContext,
    service: ServiceRecord,
    contact: { readonly chatId: string; readonly botInstanceId: BotInstanceId },
  ): Promise<unknown>;
}

/**
 * R3 item 9: has a `ROTATE_SUBSCRIPTION` on this service SUCCEEDED?
 *
 * The one fact that tells the two automatic deliveries apart. Delivery is re-armed to
 * `PENDING` by exactly two writers: the provisioning that created the service, and a
 * rotation (`recordRotation`). A rotation needs an ACTIVE service, which exists only
 * after the first delivery was armed; so once any rotation has succeeded, a pending
 * automatic delivery is the rotation's new link. Derived from the operation rows — the
 * record of what happened — rather than from a flag somebody must remember to set.
 */
export interface RotationHistoryReader {
  hasRotated(scope: TenantContext, serviceId: string): Promise<boolean>;
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
    /**
     * R3 item 9: announce the link as a CHANGED link of this same service. Set only by
     * the automatic lane, from `RotationHistoryReader`; a customer's or operator's resend
     * keeps the card it always sent.
     */
    options: {
      readonly rotated?: boolean;
      /**
       * Round N (F4): the service card «🔗 لینک اشتراک» was tapped on. The link is shown ON
       * it (`showLinkOnCard`) rather than sent as a new message; set only by a customer's
       * own request.
       */
      readonly card?: CardMessageRef;
      /**
       * Pre-support A9: the tap's own key (the Telegram update's), which the QR photo under
       * the link view is claimed by. Only with `card`; without it no QR is sent.
       */
      readonly linkQrKey?: string;
    } = {},
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
     * customer's own re-request, is already sending — or a rotation replaced the link
     * this caller read. Refused rather than sent, because two senders is the duplicate
     * this whole file is arranged around, and an old link is not the customer's link.
     *
     * The stamp is conditional on the LINK too, the same compare-and-set the two
     * records below make. Without it a rotation that committed between the sweep's
     * read and this stamp would let the old link go out, and the stamp would land on
     * the rotated row after the rotation had cleared it — stranding the new link behind
     * a send nobody will record, until the reaper gives up on it.
     */
    const sentUrl = service.subscriptionUrl;
    const started = await this.deps.uow.run(scope, async (tx) =>
      this.deps.services.markSendStarted(
        scope,
        service.id,
        from,
        sentUrl,
        this.deps.clock.now(),
        tx,
      ),
    );
    if (!started) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_NOT_DELIVERABLE,
        'That service is already being sent.',
        { reason: 'SEND_IN_PROGRESS' },
      );
    }

    /*
     * `sentUrl` is the link THIS attempt sends, and the one both records below are
     * conditional on. A rotation that commits while the message is in flight replaces
     * it, and the record of the old link's send must not land on the row that now holds
     * the new one: that would mark a link DELIVERED the customer never received.
     */
    const rotated =
      options.rotated === true
        ? await this.sendRotated(scope, service, chatId, botInstanceId, sentUrl)
        : null;
    const sentTo = rotated?.sentTo;
    const result =
      rotated !== null
        ? rotated.result
        : options.card !== undefined
          ? await this.showLinkOnCard(scope, service, options.card, sentUrl)
          : await this.sendCard(scope, service, chatId, botInstanceId, sentUrl);

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
     * The retry waits the LATER of Telegram's own `retry_after` and
     * `DELIVERY_BACKOFF_MS` (WP20, brief §3.1): never sooner than Telegram asked, and
     * never sooner than our own floor either, so a short `retry_after` cannot turn a
     * rate limit into a tight loop.
     */
    if (result.outcome === 'RATE_LIMITED') {
      const retryAt = new Date(
        now.getTime() + Math.max(result.retryAfterMs ?? 0, DELIVERY_BACKOFF_MS),
      );
      const held = await this.deps.uow.run(scope, async (tx) =>
        this.deps.services.recordRateLimited(scope, service.id, from, retryAt, sentUrl, now, tx),
      );
      return { state: from, recorded: held, ...(sentTo === undefined ? {} : { sentTo }) };
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
          sentUrl,
        },
        now,
        tx,
      ),
    );

    /*
     * Pre-support A9: the link view shown, then ONE QR photo of the same `sentUrl` beneath it
     * — only when the view is known to be on the customer's screen, never on an ambiguous
     * edit, and never a second time for the same tap.
     */
    if (
      options.card !== undefined &&
      options.linkQrKey !== undefined &&
      result.outcome === 'DELIVERED'
    ) {
      await this.sendLinkQr(scope, service, options.card, sentUrl, options.linkQrKey);
    }

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
    return { state: to, recorded, ...(sentTo === undefined ? {} : { sentTo }) };
  }

  /**
   * Pre-support A9: the QR of the EXACT link the view shows, as one photo under it, captioned
   * `bot.service.link_qr_caption` — the QR of the link above it.
   *
   * The panel's delivery mode is honoured exactly as the delivery card honours it: a
   * `CARD_TEXT` panel gets no QR. The tap's key is claimed first, in its own transaction and
   * with the tenant's activity read inside it, so a replayed tap — Telegram redelivering the
   * update — finds the claim and sends nothing.
   *
   * Never throws and never touches the delivery record: the link was shown and recorded, and
   * a photo Telegram declined (or answered ambiguously) is not a failed delivery. It is not
   * retried either — the claim stands — because a QR that may already be on the screen must
   * not be sent again; the customer can tap the link again.
   */
  private async sendLinkQr(
    scope: TenantContext,
    service: ServiceRecord,
    card: CardMessageRef,
    sentUrl: string,
    key: string,
  ): Promise<void> {
    const claims = this.deps.linkQr;
    if (claims === undefined) return;
    try {
      const mode = deliveryModeOf(await this.deps.panelPolicy.forPanel(scope, service.panelId));
      if (mode === 'CARD_TEXT') return;
      const claimed = await this.deps.uow.run(scope, async (tx) =>
        (await this.deps.scopeActivity.scopeIsActive(scope, tx))
          ? claims.claim(scope, key, tx)
          : false,
      );
      if (!claimed) return;
      await this.deps.messenger.sendFile(scope, {
        chatId: card.chatId,
        botInstanceId: card.botInstanceId,
        kind: 'PHOTO',
        source: {
          kind: 'BYTES',
          bytes: (await this.deps.qr.render(scope, { kind: 'PAYLOAD', text: sentUrl })).bytes,
          fileName: 'subscription.png',
          mimeType: 'image/png',
        },
        // Its own caption: the delivery card's says the details follow in the NEXT message,
        // and here the link is in the message ABOVE.
        caption: { templateKey: 'bot.service.link_qr_caption', values: {} },
      });
    } catch {
      // Deliberately swallowed: the link view is shown and recorded already.
      return;
    }
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
        const rotated = (await this.deps.rotations?.hasRotated(scope, service.id)) === true;
        const record = await this.deliver(
          scope,
          service,
          lookup.contact.chatId,
          lookup.contact.botInstanceId,
          { rotated },
        );
        /*
         * R3 item 6: the connection files, immediately after the link — only when this
         * sweep's send was DELIVERED and recorded, so a message that may not have arrived
         * is not followed by files, and a send somebody else recorded is not answered
         * twice. Its failure is swallowed by `sendFilesAfter` and changes nothing here.
         */
        if (record.recorded && record.state === 'DELIVERED') {
          // Codex review of #116: beside the link — the card's own chat and bot, if it went there.
          await this.sendFilesAfter(scope, service, record.sentTo ?? lookup.contact);
          // Phase 2 item 5: the panel's tutorial, after the files — a first delivery only.
          if (!rotated)
            await this.sendTutorialAfter(scope, service, record.sentTo ?? lookup.contact);
        }
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
   * R3 item 6: the files after a delivered link. Never throws and never writes: the
   * delivery is recorded already, the service is ACTIVE, and neither may be touched by
   * a file Telegram or the panel declined. The files service keeps every secret in
   * memory; nothing about them is logged here.
   */
  private async sendFilesAfter(
    scope: TenantContext,
    service: ServiceRecord,
    contact: { readonly chatId: string; readonly botInstanceId: BotInstanceId },
  ): Promise<void> {
    if (this.deps.files === undefined) return;
    try {
      await this.deps.files.afterDelivery(scope, service, contact);
    } catch {
      // Deliberately swallowed: the link is delivered and recorded, and the customer
      // can still ask for the files from the card («📁 دریافت فایل‌های اتصال»).
      return;
    }
  }

  /**
   * Phase 2 item 5: the panel's tutorial after a FIRST delivery. Never throws and never
   * writes the delivery: the sender claims the service once and sends at most once.
   */
  private async sendTutorialAfter(
    scope: TenantContext,
    service: ServiceRecord,
    contact: { readonly chatId: string; readonly botInstanceId: BotInstanceId },
  ): Promise<void> {
    if (this.deps.tutorial === undefined) return;
    try {
      await this.deps.tutorial.afterDelivery(scope, service, contact);
    } catch {
      // Deliberately swallowed: the link is delivered and recorded; a tutorial is a courtesy.
      return;
    }
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
        { deliveredAt: null, nextAttemptAt: null, sentUrl: service.subscriptionUrl },
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
  /**
   * The delivery card (customer UX completion §B): the QR of `sentUrl` as a photo, the
   * approved text as its caption, and the three buttons.
   *
   * ONE media message whenever the rendered caption fits Telegram's caption bound; the
   * messenger refuses an over-bound HTML caption WITHOUT a request, and then the
   * arrangement is deterministic: the photo with its short caption, then the whole card
   * as a text message carrying the buttons. The URL is in exactly one message either
   * way — inside the caption, or inside the card — and is never split. The recorded
   * outcome is the WORST of the sends, so an ambiguous second send is UNCONFIRMED and
   * never DELIVERED, and no request is made after a send that did not deliver.
   *
   * Facts that cannot be read fall back to the plain link message this service sent
   * before the card existed: a link without a card is still a delivery; a card with
   * holes in it is a claim.
   */
  private async sendCard(
    scope: TenantContext,
    service: ServiceRecord,
    chatId: string,
    botInstanceId: BotInstanceId,
    sentUrl: string,
  ): Promise<CustomerSendResult> {
    const facts = await this.deps.card.factsFor(scope, service);
    if (facts === null) {
      return this.deps.messenger.send(scope, {
        chatId,
        botInstanceId,
        templateKey: 'bot.service.subscription',
        values: { subscriptionUrl: sentUrl },
      });
    }
    const values: TemplateValues = {
      serviceUsername: service.providerUsername,
      productName: facts.productName,
      ...(facts.serviceLocation === null ? {} : { serviceLocation: facts.serviceLocation }),
      durationDays: facts.durationDays,
      trafficBytes: facts.trafficBytes,
      subscriptionUrl: sentUrl,
    };
    const buttons = deliveryCardButtons(service.id);
    const mode = deliveryModeOf(await this.deps.panelPolicy.forPanel(scope, service.panelId));
    if (mode === 'CARD_TEXT') {
      // The card as text, exactly the second half of the split below: no QR is encoded
      // and no photo is sent, and the link is in this one message.
      return this.deps.messenger.send(scope, {
        chatId,
        botInstanceId,
        templateKey: 'bot.service.delivered',
        values,
        buttons,
      });
    }
    const png = (await this.deps.qr.render(scope, { kind: 'PAYLOAD', text: sentUrl })).bytes;
    const photo = {
      chatId,
      botInstanceId,
      kind: 'PHOTO' as const,
      source: {
        kind: 'BYTES' as const,
        bytes: png,
        fileName: 'subscription.png',
        mimeType: 'image/png' as const,
      },
    };
    const single = await this.deps.messenger.sendFile(scope, {
      ...photo,
      caption: { templateKey: 'bot.service.delivered', values },
      buttons,
    });
    if (single.outcome !== 'REFUSED' || single.reason !== 'CAPTION_OVER_BOUND') return single;

    const first = await this.deps.messenger.sendFile(scope, {
      ...photo,
      caption: { templateKey: 'bot.service.delivered_qr_caption', values: {} },
    });
    if (first.outcome !== 'DELIVERED') return first;
    const second = await this.deps.messenger.send(scope, {
      chatId,
      botInstanceId,
      templateKey: 'bot.service.delivered',
      values,
      buttons,
    });
    return second;
  }

  /**
   * R3 item 9: the new link after a link change on the SAME service — «the link of
   * service X changed; the previous link is no longer usable; replace it in your apps»,
   * then the link. Never the purchase card: nothing was created.
   *
   * The panel's delivery mode is honoured exactly as the card's is: the QR of `sentUrl`
   * with this text as its caption, or the text alone; and an over-bound caption falls
   * back to the photo with its short caption followed by the text. The card's buttons
   * (guide, connected, problem) go with it.
   */
  private async sendRotated(
    scope: TenantContext,
    service: ServiceRecord,
    chatId: string,
    botInstanceId: BotInstanceId,
    sentUrl: string,
  ): Promise<{
    readonly result: CustomerSendResult;
    readonly sentTo?: { readonly chatId: string; readonly botInstanceId: BotInstanceId };
  }> {
    const values: TemplateValues = {
      serviceUsername: service.providerUsername,
      subscriptionUrl: sentUrl,
    };
    const buttons = deliveryCardButtons(service.id);
    /*
     * Round N (F4): a link change asked from the service card is answered ON that card —
     * the card that has read «working» since the tap becomes «the link changed; the previous
     * link no longer works» with the new link, and a way back to the card. Never the
     * purchase card, never a second message. The claim (`answered_at`) is taken first, in
     * its own transaction, so a replica cannot edit the same card; a 429 gives it back with
     * Telegram's wait, and this delivery is re-queued by the caller.
     *
     * Text only: a text message cannot be edited into a photo, so the QR the panel's
     * delivery mode may ask for is not drawn on the card. A card Telegram cannot edit
     * (deleted, too old) falls back, once, to the message R3 sends — the smallest fallback.
     */
    const edit = this.deps.messenger.edit;
    const cards = this.deps.cards;
    if (edit !== undefined && cards !== undefined) {
      const card = await this.deps.uow.run(scope, async (tx) =>
        cards.claimRotationCard(scope, service.id, this.deps.clock.now(), tx),
      );
      if (card !== null) {
        const edited = await edit.call(this.deps.messenger, scope, {
          chatId: card.chatId,
          messageId: card.messageId,
          botInstanceId: card.botInstanceId,
          templateKey: 'bot.service.link_rotated',
          values,
          buttons: [...buttons, { ...backToCardButton(service.id), row: 2 }],
        });
        if (edited.outcome === 'RATE_LIMITED') {
          const retryAt = new Date(
            this.deps.clock.now().getTime() + cardRetryDelayMs(edited.retryAfterMs),
          );
          await this.deps.uow.run(scope, async (tx) =>
            cards.release(scope, card.operationId, retryAt, tx),
          );
          return { result: edited };
        }
        if (edited.outcome !== 'REFUSED') {
          return {
            result: edited,
            sentTo: { chatId: card.chatId, botInstanceId: card.botInstanceId },
          };
        }
      }
    }
    const text = {
      chatId,
      botInstanceId,
      templateKey: 'bot.service.link_rotated' as const,
      values,
      buttons,
    };
    const mode = deliveryModeOf(await this.deps.panelPolicy.forPanel(scope, service.panelId));
    if (mode === 'CARD_TEXT') return { result: await this.deps.messenger.send(scope, text) };
    const photo = {
      chatId,
      botInstanceId,
      kind: 'PHOTO' as const,
      source: {
        kind: 'BYTES' as const,
        bytes: (await this.deps.qr.render(scope, { kind: 'PAYLOAD', text: sentUrl })).bytes,
        fileName: 'subscription.png',
        mimeType: 'image/png' as const,
      },
    };
    const single = await this.deps.messenger.sendFile(scope, {
      ...photo,
      caption: { templateKey: 'bot.service.link_rotated', values },
      buttons,
    });
    if (single.outcome !== 'REFUSED' || single.reason !== 'CAPTION_OVER_BOUND') {
      return { result: single };
    }
    const first = await this.deps.messenger.sendFile(scope, {
      ...photo,
      caption: { templateKey: 'bot.service.delivered_qr_caption', values: {} },
    });
    if (first.outcome !== 'DELIVERED') return { result: first };
    return { result: await this.deps.messenger.send(scope, text) };
  }

  async redeliver(
    scope: TenantContext,
    service: ServiceRecord,
    customerId: UserId,
    chatId: string,
    botInstanceId: BotInstanceId,
    /**
     * Round N (F4): the card the tap came from, which the link is shown on. Pre-support A9:
     * the tap's key, which the QR photo under the link view is claimed by.
     */
    options: { readonly card?: CardMessageRef; readonly linkQrKey?: string } = {},
  ): Promise<DeliveryRecord> {
    if (service.customerId !== customerId) {
      throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
    }
    return this.deliver(
      scope,
      service,
      chatId,
      botInstanceId,
      options.card === undefined
        ? {}
        : {
            card: options.card,
            ...(options.linkQrKey === undefined ? {} : { linkQrKey: options.linkQrKey }),
          },
    );
  }

  /**
   * Round N (F4): «🔗 لینک اشتراک» on the service card. The card itself becomes the link
   * (`bot.service.subscription`, the link in `<code>` so it copies on tap) with a way back
   * to the card — no separate link message. Recorded exactly as any delivery is: the same
   * `markSendStarted` stamp and outcome record, so a customer whose automatic announcement
   * was UNCONFIRMED is now recorded as told.
   *
   * A card Telegram cannot edit (deleted, too old, a photo) gets the same link view ONCE as a
   * new message — the smallest fallback. A text card cannot become the QR photo, so the QR
   * goes beneath it as one photo of its own (pre-support A9, `sendLinkQr`).
   */
  private async showLinkOnCard(
    scope: TenantContext,
    service: ServiceRecord,
    card: CardMessageRef,
    sentUrl: string,
  ): Promise<CustomerSendResult> {
    const view = {
      chatId: card.chatId,
      botInstanceId: card.botInstanceId,
      templateKey: 'bot.service.subscription' as const,
      values: { subscriptionUrl: sentUrl },
      buttons: [backToCardButton(service.id)],
    };
    const edit = this.deps.messenger.edit;
    if (edit !== undefined) {
      const edited = await edit.call(this.deps.messenger, scope, {
        ...view,
        messageId: card.messageId,
      });
      if (edited.outcome !== 'REFUSED') return edited;
    }
    return this.deps.messenger.send(scope, view);
  }

  /**
   * Sends a customer their configuration again, because an OPERATOR asked.
   *
   * Phase 6A. `redeliver` above is the customer asking for their own — ownership is the
   * authorisation and the chat comes from the update. This is the other caller: an
   * operator answering "this customer says they never got their link", who holds a
   * permission rather than the service, and for whom the chat has to be LOOKED UP.
   *
   * ## The lookup is the refusal, and both of its answers are real
   *
   * `contactFor` is the same reader the sweep uses. `NONE` is a customer with no durable
   * bot link — they have never opened the bot, so there is nowhere to send and guessing
   * a chat id is the failure mode that port's docblock exists to forbid. `BLOCKED` is an
   * operator's own instruction not to message them, and a resend that overrode it would
   * be this surface undoing a decision somebody made on another screen. Both answer
   * `SERVICE_NOT_DELIVERABLE` with the reason named, because the service is real and the
   * send is what cannot happen.
   *
   * ## It plans no operation and touches no panel
   *
   * A resend is a message and a delivery row. The service does not move — that is the
   * rule this whole file exists to hold, and it is why an operator resending to a
   * customer whose send has already FAILED three times is allowed: `deliver` is legal
   * from every delivery state, and the attempt ceiling bounds the AUTOMATIC lane only.
   */
  async resendForOperator(
    scope: TenantContext,
    actor: ActorContext,
    serviceId: string,
  ): Promise<DeliveryRecord> {
    await this.deps.guard.check(scope, actor, SERVICE_EDIT_PERMISSION);
    const service = await this.deps.services.findById(scope, serviceIdOrNotFound(serviceId));
    if (service === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
    }
    const lookup = await this.deps.contacts.contactFor(scope, service.customerId);
    if (lookup.kind !== 'CONTACT') {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_NOT_DELIVERABLE,
        'There is nowhere to send this configuration.',
        { reason: lookup.kind === 'BLOCKED' ? 'CUSTOMER_BLOCKED' : 'NO_CONTACT' },
      );
    }
    return this.deliver(scope, service, lookup.contact.chatId, lookup.contact.botInstanceId);
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

/**
 * The card's buttons, and their order, as approved: the connection guide on its own
 * row, then «وصل شدم» beside «مشکل دارم». The callbacks carry the service id and
 * nothing else; the guide and the FAQ need no id at all.
 */
export function deliveryCardButtons(serviceId: string): readonly CustomerButton[] {
  return [
    {
      ...inlineLabel('service.tutorial'),
      data: `${TUTORIAL_CALLBACK_DATA}`,
      row: 0,
    },
    {
      ...inlineLabel('service.connected'),
      data: `${CONNECTED_CALLBACK_PREFIX}${serviceId}`,
      row: 1,
    },
    {
      ...inlineLabel('service.problem'),
      data: `${SUPPORT_CALLBACK_DATA}`,
      row: 1,
    },
  ];
}

/**
 * Round N (F4): «🔙 بازگشت به مشخصات سرویس» — the service card, drawn back into the message
 * that shows the link or the changed link.
 */
export function backToCardButton(serviceId: string): CustomerButton {
  return {
    ...inlineLabel('service.back_to_card'),
    data: `${SERVICE_CARD_CALLBACK_PREFIX}${serviceId}`,
  };
}

/**
 * The callbacks the card's buttons carry. Declared HERE, beside the one composer that
 * draws them, and read by the Telegram surface's router, so the two cannot drift: the
 * surface imports these rather than spelling them a second time.
 */
export const TUTORIAL_CALLBACK_DATA = 'tu:';
export const CONNECTED_CALLBACK_PREFIX = 'ok:';
export const SUPPORT_CALLBACK_DATA = 'sp:';
/** `sv:<service id>` — R3: the service card, edited into the message the tap came from. */
export const SERVICE_CARD_CALLBACK_PREFIX = 'sv:';
