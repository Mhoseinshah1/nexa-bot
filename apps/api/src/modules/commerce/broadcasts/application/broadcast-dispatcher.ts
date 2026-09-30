import {
  BROADCAST_DRAFT_MEDIA_RETENTION_DAYS,
  BROADCAST_LEASE_MS,
  BROADCAST_MAX_ATTEMPTS,
  BROADCAST_MEDIA_RETENTION_DAYS,
  BROADCAST_RETRY_FLOOR_MS,
  BROADCAST_SENDS_PER_SECOND,
  isSourcedBroadcastKind,
  placeholderTokensIn,
  systemJobActor,
  type ActorContext,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type {
  BroadcastContent,
  BroadcastRepository,
  BroadcastTransport,
  ClaimedRecipient,
  PinOutcome,
  RecipientFactsReader,
  RecipientOutcome,
} from './ports.js';

const DAY_MS = 86_400_000;
/** How many of one bot's recipients one pass claims at most: its per-second budget. */
const PER_BOT_PASS = BROADCAST_SENDS_PER_SECOND;
/** Sends in flight at once within a pass; the bot's budget still bounds the total. */
const CONCURRENCY = 4;

export interface BroadcastPassReport {
  readonly started: number;
  readonly reaped: number;
  readonly claimed: number;
  readonly sent: number;
  readonly unconfirmed: number;
  readonly unreachable: number;
  readonly failed: number;
  readonly retried: number;
  readonly rateLimited: number;
  readonly skipped: number;
  readonly lost: number;
  readonly errored: number;
  readonly completed: number;
  readonly purged: number;
  /** Round N close (§C): pins attempted this pass, by outcome, and stranded pins reaped. */
  readonly pinned: number;
  readonly pinFailed: number;
  readonly pinsReaped: number;
}

type Tally = { -readonly [K in keyof BroadcastPassReport]: number };

export interface BroadcastDispatcherDeps {
  readonly repository: BroadcastRepository;
  readonly transport: BroadcastTransport;
  readonly facts: RecipientFactsReader;
  readonly outbox: OutboxWriter;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly scopeIsActive: (scope: TenantContext) => Promise<boolean>;
  readonly logger: {
    info: (context: Record<string, unknown>, message: string) => void;
    error: (context: Record<string, unknown>, message: string) => void;
  };
}

/**
 * The broadcast lane's dispatcher (round N, B1) — one pass claims, sends and records.
 *
 * The notification lane's shape, and its rules, for operator-authored content:
 *
 * - NOTHING holds a transaction while it sends. The stamp, the outcome and the pacing hold are
 *   each their own `uow.run`, and the Telegram request sits between them.
 * - AT MOST ONCE. The stamp (`PENDING → SENDING`) commits before the request; a process that
 *   dies before recording leaves a stamped row the reaper resolves `UNCONFIRMED`. It is never
 *   sent again — `docs/round-n-broadcast-audit.md` §4 says why.
 * - A 429 is NOT unknown: the recipient goes back to `PENDING` at the later of Telegram's
 *   `retry_after` and a floor, with no attempt spent, and the whole BOT is held until then for
 *   every replica through its pacing row. The recipient is never dropped.
 * - A recipient's failure is that recipient's outcome. Blocked-the-bot is `UNREACHABLE`, a
 *   refusal is `FAILED`, and neither stops the batch. Only a bot with no usable token pauses
 *   the broadcast, because then every recipient of that bot would fail the same way.
 * - Multi-worker safe: the claim is `FOR UPDATE SKIP LOCKED` under the bot's pacing lock, the
 *   stamp names the lease this pass took, and every broadcast transition is conditional.
 */
export class BroadcastDispatcher {
  constructor(private readonly deps: BroadcastDispatcherDeps) {}

  private actor(): ActorContext {
    return systemJobActor('broadcast-dispatcher', this.deps.ids.uuid() as CorrelationId);
  }

  async pass(scope: TenantContext): Promise<BroadcastPassReport> {
    const tally: Tally = {
      started: 0,
      reaped: 0,
      claimed: 0,
      sent: 0,
      unconfirmed: 0,
      unreachable: 0,
      failed: 0,
      retried: 0,
      rateLimited: 0,
      skipped: 0,
      lost: 0,
      errored: 0,
      completed: 0,
      purged: 0,
      pinned: 0,
      pinFailed: 0,
      pinsReaped: 0,
    };
    // A stopped tenant is a healthy pass that did nothing, as for the notification lane.
    if (!(await this.deps.scopeIsActive(scope))) return tally;
    const actor = this.actor();
    const now = this.deps.clock.now();

    // Scheduled broadcasts whose time has come.
    const started = await this.deps.uow.run(scope, async (tx) => {
      const ids = await this.deps.repository.startDue(scope, now, tx);
      for (const id of ids) {
        await this.deps.outbox.write(tx, actor, {
          eventType: 'BroadcastStateChanged',
          aggregateType: 'Broadcast',
          aggregateId: id,
          payload: { broadcastId: id, from: 'SCHEDULED', to: 'SENDING', recipients: null },
        });
      }
      return ids.length;
    });
    tally.started = started;

    // Stranded sends first, in their own transaction: resolved UNCONFIRMED, never re-sent.
    tally.reaped = await this.deps.uow.run(scope, (tx) =>
      this.deps.repository.reapStranded(scope, now, tx),
    );
    // And stranded pins, the same way: a pin stamped and never answered may have pinned.
    tally.pinsReaped = await this.deps.uow.run(scope, (tx) =>
      this.deps.repository.reapStrandedPins(scope, now, tx),
    );

    const contents = new Map<string, BroadcastContent | null>();
    const contentOf = async (id: string) => {
      if (!contents.has(id)) contents.set(id, await this.deps.repository.content(scope, id));
      return contents.get(id) ?? null;
    };

    for (const bot of await this.deps.repository.botsWithWork(scope, now)) {
      // Through the unit of work, so a recovery's quiesce refuses the claim like every write.
      const claimed = await this.deps.uow.run(scope, (tx) =>
        this.deps.repository.claimForBot(
          scope,
          bot,
          {
            now,
            leaseUntil: new Date(now.getTime() + BROADCAST_LEASE_MS),
            max: PER_BOT_PASS,
            perSecond: BROADCAST_SENDS_PER_SECOND,
          },
          tx,
        ),
      );
      tally.claimed += claimed.length;
      let index = 0;
      const worker = async () => {
        while (index < claimed.length) {
          const recipient = claimed[index] as ClaimedRecipient;
          index += 1;
          const outcome = await this.deliverOne(scope, recipient, contentOf, actor, tally);
          tally[outcome] += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, claimed.length) }, worker));
    }

    const completed = await this.deps.uow.run(scope, async (tx) => {
      const finished = await this.deps.repository.completeFinished(
        scope,
        this.deps.clock.now(),
        tx,
      );
      for (const { id, count } of finished) {
        await this.deps.outbox.write(tx, actor, {
          eventType: 'BroadcastStateChanged',
          aggregateType: 'Broadcast',
          aggregateId: id,
          payload: { broadcastId: id, from: 'SENDING', to: 'COMPLETED', recipients: count },
        });
      }
      return finished.length;
    });
    tally.completed = completed;

    // The staging bound's other half: bytes past retention are cleared, never kept.
    tally.purged = await this.deps.uow.run(scope, (tx) =>
      this.deps.repository.purgeMedia(
        scope,
        {
          terminalBefore: new Date(now.getTime() - BROADCAST_MEDIA_RETENTION_DAYS * DAY_MS),
          draftBefore: new Date(now.getTime() - BROADCAST_DRAFT_MEDIA_RETENTION_DAYS * DAY_MS),
          now,
        },
        tx,
      ),
    );
    return tally;
  }

  private async deliverOne(
    scope: TenantContext,
    recipient: ClaimedRecipient,
    contentOf: (id: string) => Promise<BroadcastContent | null>,
    actor: ActorContext,
    tally: Tally,
  ): Promise<keyof BroadcastPassReport> {
    try {
      const content = await contentOf(recipient.broadcastId);
      // A broadcast that stopped SENDING since the claim: the stamp below would refuse
      // anyway; answering here saves the reads.
      if (content === null || content.state !== 'SENDING') return 'lost';

      /*
       * The one LIVE eligibility fact a broadcast re-checks: a customer an operator blocked
       * after launch, when the audience asked for active customers only. Skipped, not
       * failed — nothing was attempted — and before the stamp, so nothing looks sent.
       */
      if (content.requiresActiveCustomer) {
        const status = await this.deps.repository.customerStatus(scope, recipient.customerId);
        if (status !== 'ACTIVE') {
          const moved = await this.deps.uow.run(scope, (tx) =>
            this.deps.repository.skip(
              scope,
              recipient,
              'broadcast.customer_blocked',
              this.deps.clock.now(),
              tx,
            ),
          );
          return moved ? 'skipped' : 'lost';
        }
      }

      // Everything that can refuse or throw happens BEFORE the stamp.
      const facts = await this.deps.facts.factsFor(scope, recipient.customerId, {
        withBalance: placeholderTokensIn(content.body).includes('walletBalance'),
      });
      const rendered = await this.deps.transport.render(scope, {
        contentKind: content.contentKind,
        body: content.body,
        facts,
        buttons: content.buttons,
        source: content.source,
      });
      const isMedia =
        content.contentKind !== 'TEXT' && !isSourcedBroadcastKind(content.contentKind);
      const media = !isMedia
        ? null
        : await this.deps.repository.mediaSource(
            scope,
            recipient.broadcastId,
            recipient.botInstanceId,
          );

      /*
       * Round N close (§D): the second live fact a MARKETING send re-reads — a customer who
       * opted out of promotions since the recipients were materialised — is decided by the
       * stamp itself, in its transaction and under the customer's lock (`stamp`): SKIPPED
       * before anything looks sent. A service announcement asks nothing of it.
       */
      const stampedAt = this.deps.clock.now();
      const stamped = await this.deps.uow.run(scope, (tx) =>
        this.deps.repository.stamp(
          scope,
          recipient,
          {
            now: stampedAt,
            leaseUntil: new Date(stampedAt.getTime() + BROADCAST_LEASE_MS),
            marketing: content.purpose === 'MARKETING',
          },
          tx,
        ),
      );
      if (stamped === 'SKIPPED') return 'skipped';
      if (stamped === 'MOVED') return 'lost';

      if (!rendered.ok || (isMedia && media === null)) {
        const errorCode = rendered.ok ? 'broadcast.media_unavailable' : rendered.errorCode;
        return this.finish(scope, recipient, stampedAt, { to: 'FAILED', errorCode }, 'failed');
      }

      const result = await this.deps.transport.deliver(scope, {
        chatId: recipient.chatId,
        botInstanceId: recipient.botInstanceId,
        rendered: rendered.rendered,
        media,
      });
      const at = this.deps.clock.now();

      switch (result.outcome) {
        case 'SENT': {
          const messageId = result.messageId ?? null;
          const pinRequested = content.pin && messageId !== null;
          const counted = await this.finish(
            scope,
            recipient,
            stampedAt,
            { to: 'SENT', messageId, pinRequested },
            'sent',
            async (tx) => {
              // The first upload through this bot hands every later recipient Telegram's handle.
              if (media?.kind === 'BYTES' && result.fileId !== undefined) {
                await this.deps.repository.rememberHandle(
                  scope,
                  recipient.broadcastId,
                  recipient.botInstanceId,
                  result.fileId,
                  tx,
                );
              }
            },
            // The pin's stamp IS this record's instant: `recordPin` names it exactly.
            at,
          );
          /*
           * Round N close (§C): the pin, AFTER the send is recorded and its stamp committed.
           * Its outcome is its own column; the send stays SENT whatever happens here. One
           * attempt: `recordPin` names the stamp, so a row the reaper resolved meanwhile, or
           * a send that was never recorded (`counted === 'lost'`), takes no write.
           */
          if (counted === 'sent' && pinRequested && messageId !== null) {
            await this.pinOne(scope, recipient, at, messageId, tally);
          }
          return counted;
        }
        case 'RATE_LIMITED': {
          const until = new Date(
            at.getTime() + Math.max(result.retryAfterMs ?? 0, BROADCAST_RETRY_FLOOR_MS),
          );
          return this.finish(
            scope,
            recipient,
            stampedAt,
            { to: 'DEFER', errorCode: 'telegram.rate_limited', nextAttemptAt: until },
            'rateLimited',
            (tx) => this.deps.repository.holdBot(scope, recipient.botInstanceId, until, at, tx),
          );
        }
        case 'UNKNOWN':
          return this.finish(
            scope,
            recipient,
            stampedAt,
            { to: 'UNCONFIRMED', errorCode: result.errorCode },
            'unconfirmed',
          );
        case 'UNREACHABLE':
          return this.finish(
            scope,
            recipient,
            stampedAt,
            { to: 'UNREACHABLE', errorCode: result.errorCode },
            'unreachable',
          );
        case 'REFUSED':
          return this.finish(
            scope,
            recipient,
            stampedAt,
            { to: 'FAILED', errorCode: result.errorCode },
            'failed',
          );
        case 'BOT_UNAVAILABLE': {
          /*
           * Nothing was sent. The recipient spends an attempt and waits; the broadcast is
           * PAUSED with its reason, because every recipient of this bot would fail the same
           * way until an operator fixes the bot and resumes.
           */
          const exhausted = recipient.attempts + 1 >= BROADCAST_MAX_ATTEMPTS;
          const outcome: RecipientOutcome = exhausted
            ? { to: 'FAILED', errorCode: result.errorCode }
            : {
                to: 'RETRY',
                errorCode: result.errorCode,
                nextAttemptAt: new Date(at.getTime() + BROADCAST_RETRY_FLOOR_MS),
              };
          return this.finish(
            scope,
            recipient,
            stampedAt,
            outcome,
            exhausted ? 'failed' : 'retried',
            async (tx) => {
              const paused = await this.deps.repository.transition(
                scope,
                recipient.broadcastId,
                ['SENDING'],
                'PAUSED',
                { now: at, pauseReason: 'BOT_UNAVAILABLE' },
                tx,
              );
              if (paused) {
                await this.deps.outbox.write(tx, actor, {
                  eventType: 'BroadcastStateChanged',
                  aggregateType: 'Broadcast',
                  aggregateId: recipient.broadcastId,
                  payload: {
                    broadcastId: recipient.broadcastId,
                    from: 'SENDING',
                    to: 'PAUSED',
                    recipients: null,
                  },
                });
              }
            },
          );
        }
      }
    } catch (error: unknown) {
      /*
       * The lease stands and the row comes back later — or, if it was stamped, the reaper
       * resolves it UNCONFIRMED. Never recorded as an attempt: nothing was observed.
       */
      this.deps.logger.error(
        {
          err: error instanceof Error ? error.name : 'unknown',
          broadcastId: recipient.broadcastId,
        },
        'broadcast send failed',
      );
      return 'errored';
    }
  }

  private async finish(
    scope: TenantContext,
    recipient: ClaimedRecipient,
    stampedAt: Date,
    outcome: RecipientOutcome,
    counted: keyof BroadcastPassReport,
    alongside?: (tx: TransactionScope) => Promise<void>,
    /** The instant the outcome is recorded at; the SENT branch passes the pin's stamp. */
    recordedAt: Date = this.deps.clock.now(),
  ): Promise<keyof BroadcastPassReport> {
    const recorded = await this.deps.uow.run(scope, async (tx) => {
      const moved = await this.deps.repository.record(
        scope,
        recipient,
        stampedAt,
        outcome,
        recordedAt,
        tx,
      );
      if (moved && alongside !== undefined) await alongside(tx);
      return moved;
    });
    return recorded ? counted : 'lost';
  }

  /**
   * One pin request for a delivered message, between the commit that stamped it PENDING
   * (`record` of the SENT outcome, at `pinStampedAt`) and the commit that records its
   * answer. Never a retry: bounded at one by construction, and a failure is the pin's own.
   */
  private async pinOne(
    scope: TenantContext,
    recipient: ClaimedRecipient,
    pinStampedAt: Date,
    messageId: number,
    tally: Tally,
  ): Promise<void> {
    try {
      const result = await this.deps.transport.pin(scope, {
        chatId: recipient.chatId,
        botInstanceId: recipient.botInstanceId,
        messageId,
      });
      const outcome: PinOutcome =
        result.outcome === 'PINNED'
          ? { to: 'PINNED' }
          : result.outcome === 'UNKNOWN'
            ? { to: 'UNCONFIRMED', errorCode: result.errorCode }
            : { to: 'FAILED', errorCode: result.errorCode };
      const recorded = await this.deps.uow.run(scope, (tx) =>
        this.deps.repository.recordPin(
          scope,
          recipient,
          pinStampedAt,
          outcome,
          this.deps.clock.now(),
          tx,
        ),
      );
      if (recorded) {
        if (outcome.to === 'PINNED') tally.pinned += 1;
        else tally.pinFailed += 1;
      }
    } catch (error: unknown) {
      // The stamp stands; the pin reaper resolves it UNCONFIRMED. Never attempted again.
      this.deps.logger.error(
        {
          err: error instanceof Error ? error.name : 'unknown',
          broadcastId: recipient.broadcastId,
        },
        'broadcast pin failed',
      );
    }
  }
}
