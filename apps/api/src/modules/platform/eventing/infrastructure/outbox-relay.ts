import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  systemContext,
  type Clock,
  type DomainEvent,
  type EventType,
  type Logger,
  type ActorRef,
  type ScopeContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  outboxMessages,
  processedMessages,
  tenants,
} from '../../../../infrastructure/persistence/schema.js';
import type { EventConsumer } from '../application/event-consumer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

export interface OutboxRelayOptions {
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly maxLagMs: number;
}

export interface RelayBatchResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

/**
 * The outbox relay.
 *
 * Claims unpublished rows with FOR UPDATE SKIP LOCKED so several relay
 * instances are safe to run at once, dispatches each to the consumers that
 * subscribe to it, then marks the row published.
 *
 * Delivery is at-least-once by construction: a crash between dispatch and the
 * `published_at` update replays the message. That is why every consumer records
 * its own applied event ids in `processed_messages` — the redelivery is
 * received, and its effect happens once.
 *
 * "Once" is only true because the claim and the effect are ONE transaction.
 * Each consumer receives the relay's transaction and writes through it, so the
 * `processed_messages` row and whatever the consumer wrote commit together or
 * roll back together. The earlier shape — the claim inside the relay's
 * transaction, the effect on the consumer's own pooled connection — was two
 * commits: the effect could land and the claim then roll back, and the
 * redelivery applied the effect again. Worse, a consumer that THREW left its
 * claim committed beside the failure bookkeeping, so the retry found the pair
 * already claimed, skipped the consumer, and marked the message published with
 * no effect ever having happened.
 *
 * Each message is dispatched under its own SAVEPOINT. A consumer failure rolls
 * back that message's claim and partial effect while the batch transaction
 * stays usable, so the attempt count and error can still be recorded and the
 * other messages in the batch still publish.
 *
 * The relay never gives up on a message and has no dead-letter queue: an event
 * that cannot be delivered is a bug to fix, not a message to discard. It backs
 * off, and lag beyond `maxLagMs` makes the process unhealthy so it is visible
 * rather than silent.
 */
export class OutboxRelay {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database,
    private readonly consumers: readonly EventConsumer[],
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly options: OutboxRelayOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    let result: RelayBatchResult = { claimed: 0, published: 0, failed: 0 };
    try {
      result = await this.processBatch();
    } catch (error) {
      this.logger.error({ err: String(error) }, 'Outbox relay batch failed');
    }
    // Drain quickly while there is work; idle politely when there is not.
    this.scheduleNext(result.claimed > 0 ? 0 : this.options.pollIntervalMs);
  }

  /**
   * Processes one batch. Exposed so tests can drive the relay deterministically
   * instead of waiting on a timer.
   */
  async processBatch(): Promise<RelayBatchResult> {
    return this.db.transaction(async (tx) => {
      // Work belonging to a tenant that is not ACTIVE is left UNCLAIMED, not
      // discarded and not marked published. `eligibleForDispatch` below is the
      // one statement of that rule; readiness uses it too, so the two cannot
      // disagree about what is pending.
      //
      // Stopping a tenant now ends its Web Admin logins and its Telegram
      // intake; a relay that went on dispatching would leave the one half of
      // the installation that talks to the outside world still talking —
      // notifications sent, provisioning performed — for an installation
      // somebody switched off. Skipping rather than dropping is the other half
      // of that: the messages are still there, in order, when the tenant is
      // started again. A message with no tenant is platform work and always
      // eligible.
      const eligible = eligibleForDispatch(await this.activeTenantIds(tx));

      const claimed = await tx
        .select()
        .from(outboxMessages)
        .where(and(isNull(outboxMessages.publishedAt), eligible))
        .orderBy(asc(outboxMessages.occurredAt), asc(outboxMessages.sequence))
        .limit(this.options.batchSize)
        .for('update', { skipLocked: true });

      let published = 0;
      let failed = 0;

      for (const row of claimed) {
        // The eligibility above was evaluated when the row was SELECTed, and
        // `FOR UPDATE` locked the message, not its tenant — so a stop could
        // commit between the claim and the dispatch and the delivery would go
        // out anyway, which is the one thing the pause exists to prevent.
        //
        // Locking the tenant row here holds the answer still for the rest of
        // this transaction: a status change either committed before this and is
        // seen, or waits until the dispatch is done. `FOR SHARE` rather than
        // `FOR UPDATE` because several relay workers may hold this at once —
        // they are readers of the status, not writers of it.
        if (row.tenantId !== null && !(await this.tenantIsActive(tx, row.tenantId))) {
          continue;
        }

        const event = toDomainEvent(row);
        try {
          // A SAVEPOINT per message. Drizzle turns a nested `transaction()` on
          // a transaction into SAVEPOINT / ROLLBACK TO, so a consumer that
          // throws takes its claim and its half-written effect back with it —
          // and the batch transaction is still live for the bookkeeping below.
          // Without the savepoint the failed statement would have aborted the
          // whole transaction, and "record the attempt" would itself fail
          // with `current transaction is aborted`.
          await tx.transaction(async (attempt) => {
            await this.dispatch(attempt, event);
            await attempt
              .update(outboxMessages)
              .set({ publishedAt: this.clock.now(), lastError: null })
              .where(sql`${outboxMessages.id} = ${row.id}`);
          });
          published += 1;
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          await tx
            .update(outboxMessages)
            .set({
              attempts: sql`${outboxMessages.attempts} + 1`,
              lastError: message.slice(0, 2000),
            })
            .where(sql`${outboxMessages.id} = ${row.id}`);
          this.logger.error(
            { eventId: event.eventId, eventType: event.eventType, err: message },
            'Outbox consumer failed; message will be retried',
          );
        }
      }

      return { claimed: claimed.length, published, failed };
    });
  }

  private async dispatch(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    event: DomainEvent,
  ): Promise<void> {
    for (const consumer of this.consumers) {
      if (!consumer.subscribesTo.includes(event.eventType as EventType)) continue;

      // Effectively-once: claim the (consumer, event) pair first. If the insert
      // reports no row, another delivery already applied it and we skip.
      const claim = await tx
        .insert(processedMessages)
        .values({ consumer: consumer.name, messageId: event.eventId })
        .onConflictDoNothing()
        .returning({ messageId: processedMessages.messageId });

      if (claim.length === 0) continue;

      // The consumer's effect goes through THIS transaction — the one that
      // holds the claim — so the two are one commit. Handing it the scope the
      // event belongs to lets a consumer that records by scope do so without
      // reconstructing it.
      await consumer.handle(event, { tx, scope: scopeOf(event) });
    }
  }

  /**
   * Whether this tenant is open for business, held still for the transaction.
   *
   * Read on the relay's own connection inside the claim transaction, so a
   * concurrent status change cannot slip between the decision and the delivery.
   */
  private async tenantIsActive(tx: Executor, tenantId: string): Promise<boolean> {
    const [row] = await tx
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)
      .for('share');
    return row?.status === 'ACTIVE';
  }

  /**
   * Oldest DISPATCHABLE unpublished message age, for readiness reporting.
   *
   * The same eligibility the claim uses, deliberately. Work paused because its
   * tenant is stopped is never going to publish while that lasts, so counting
   * it would make readiness fall behind for as long as the pause — and an
   * installation somebody switched off on purpose would report itself unready,
   * indefinitely, and be pulled out of service. The relay is healthy; it is
   * waiting, which is what it was told to do.
   */
  async lagMs(executor: Executor = this.db): Promise<number> {
    // The executor is a parameter so the readiness probe can run this on a
    // connection whose statement timeout it has bounded; on the pool it would
    // run under the pool's much longer default and outlive the probe.
    const [row] = await executor
      .select({ occurredAt: outboxMessages.occurredAt })
      .from(outboxMessages)
      .where(
        and(
          isNull(outboxMessages.publishedAt),
          eligibleForDispatch(await this.activeTenantIds(executor)),
        ),
      )
      .orderBy(asc(outboxMessages.occurredAt))
      .limit(1);
    if (!row) return 0;
    return this.clock.now().getTime() - row.occurredAt.getTime();
  }

  /**
   * The tenants currently open for business.
   *
   * One installation serves one customer (ADR-0001), so this is a handful of
   * rows at most — cheap enough to read per batch, and far cheaper than making
   * the planner ask the same question once per unpublished message.
   */
  private async activeTenantIds(tx?: Executor): Promise<string[]> {
    const rows = await (tx ?? this.db)
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.status, 'ACTIVE'));
    return rows.map((row) => row.id);
  }

  async isHealthy(): Promise<boolean> {
    return (await this.lagMs()) <= this.options.maxLagMs;
  }
}

/**
 * Which unpublished rows this relay may act on.
 *
 * A message with no tenant is platform work and always eligible. A
 * tenant-scoped one is eligible only while its tenant is ACTIVE: stopping a
 * tenant ends its Web Admin logins and its Telegram intake, and a relay that
 * kept dispatching would leave the half of the installation that talks to the
 * outside world still talking. Skipped, never dropped — the rows stay
 * unpublished, in order, for when the tenant comes back.
 */
function eligibleForDispatch(activeTenantIds: readonly string[]) {
  // An ID LIST, not a correlated EXISTS.
  //
  // As a subquery this had to be evaluated per row, and the only index over
  // unpublished messages orders them by occurrence time — so proving that a
  // stopped tenant's large backlog contains nothing dispatchable meant
  // inspecting every paused row, on every relay poll AND every readiness check.
  // Harmless until connections carried a statement timeout; after it, an
  // installation deliberately paused would start reporting errors instead of
  // sitting healthily idle, which is the opposite of what pausing is for.
  //
  // The list is a snapshot, and that is safe because it is not the authority:
  // every row is re-checked against its tenant under `FOR SHARE` at dispatch,
  // which is what actually stops delivery. This filter only decides what is
  // worth looking at.
  if (activeTenantIds.length === 0) return isNull(outboxMessages.tenantId);
  return or(isNull(outboxMessages.tenantId), inArray(outboxMessages.tenantId, activeTenantIds));
}

/** The scope a consumer acts in for this event: the tenant's, or the platform's. */
function scopeOf(event: DomainEvent): ScopeContext {
  return event.tenantId === null
    ? systemContext('outbox-relay')
    : { tenantId: event.tenantId as never, botInstanceId: null };
}

function toDomainEvent(row: typeof outboxMessages.$inferSelect): DomainEvent {
  return {
    eventId: row.id,
    eventType: row.eventType,
    eventVersion: row.eventVersion,
    tenantId: row.tenantId,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    sequence: row.sequence,
    correlationId: row.correlationId,
    causationId: row.causationId,
    actor: row.actor as ActorRef,
    occurredAt: row.occurredAt.toISOString(),
    payload: row.payload,
  };
}
