import { asc, isNull, sql } from 'drizzle-orm';
import {
  type Clock,
  type DomainEvent,
  type EventType,
  type Logger,
  type ActorRef,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import {
  outboxMessages,
  processedMessages,
} from '../../../../infrastructure/persistence/schema.js';
import type { EventConsumer } from '../application/event-consumer.js';

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
      const claimed = await tx
        .select()
        .from(outboxMessages)
        .where(isNull(outboxMessages.publishedAt))
        .orderBy(asc(outboxMessages.occurredAt), asc(outboxMessages.sequence))
        .limit(this.options.batchSize)
        .for('update', { skipLocked: true });

      let published = 0;
      let failed = 0;

      for (const row of claimed) {
        const event = toDomainEvent(row);
        try {
          await this.dispatch(tx, event);
          await tx
            .update(outboxMessages)
            .set({ publishedAt: this.clock.now(), lastError: null })
            .where(sql`${outboxMessages.id} = ${row.id}`);
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

      await consumer.handle(event);
    }
  }

  /** Oldest unpublished message age, for readiness reporting. */
  async lagMs(): Promise<number> {
    const [row] = await this.db
      .select({ occurredAt: outboxMessages.occurredAt })
      .from(outboxMessages)
      .where(isNull(outboxMessages.publishedAt))
      .orderBy(asc(outboxMessages.occurredAt))
      .limit(1);
    if (!row) return 0;
    return this.clock.now().getTime() - row.occurredAt.getTime();
  }

  async isHealthy(): Promise<boolean> {
    return (await this.lagMs()) <= this.options.maxLagMs;
  }
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
