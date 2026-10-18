import { sql } from 'drizzle-orm';
import {
  errors,
  isEventType,
  PLATFORM_ERROR_CODES,
  type ActorContext,
  type AggregateType,
  type Clock,
  type EventPayload,
  type EventType,
  type IdGenerator,
} from '@nexa/contracts';
import { actorRef, EVENT_ENVELOPE_VERSION } from '@nexa/contracts';
import {
  aggregateSequences,
  outboxMessages,
} from '../../../../infrastructure/persistence/schema.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { scopeTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';

/** Aggregates per sequence upsert (3 parameters a row, far under PostgreSQL's 65 535). */
const SEQUENCE_CHUNK = 5000;
/** Outbox rows per INSERT (12 parameters a row: 5 000 rows stay under 65 535). */
const OUTBOX_INSERT_CHUNK = 5000;

/**
 * Writes domain events to the outbox INSIDE the caller's transaction.
 *
 * This is the whole point of an outbox: the event exists if and only if the
 * state change committed. Publishing from a request handler instead is the
 * classic dual-write bug — the transaction rolls back and the message is
 * already gone.
 *
 * The correlation id is a column, not just an ambient value, so the chain
 * survives the queue boundary and a business transaction can be followed from
 * a Telegram update through to a consumer's side effects.
 */
export class OutboxWriter {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async write<T extends EventType>(
    { tx, scope }: TransactionScope,
    actor: ActorContext,
    event: {
      eventType: T;
      aggregateType: AggregateType;
      aggregateId: string;
      payload: EventPayload<T>;
      causationId?: string;
    },
  ): Promise<{ eventId: string; sequence: number }> {
    if (!isEventType(event.eventType)) {
      // An unregistered event name is a contract violation, not a runtime hiccup.
      throw errors.validation(
        PLATFORM_ERROR_CODES.UNKNOWN_EVENT_TYPE,
        `"${String(event.eventType)}" is not in the event catalog. Adding an event is a contract change.`,
      );
    }

    const sequence = await this.nextSequence(tx, event.aggregateType, event.aggregateId);
    const eventId = this.ids.uuid();

    await tx.insert(outboxMessages).values({
      id: eventId,
      tenantId: scopeTenantId(scope),
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      sequence,
      eventType: event.eventType,
      eventVersion: EVENT_ENVELOPE_VERSION,
      payload: event.payload as Record<string, unknown>,
      actor: actorRef(actor),
      correlationId: actor.correlationId,
      causationId: event.causationId ?? null,
      occurredAt: this.clock.now(),
    });

    return { eventId, sequence };
  }

  /**
   * `write` for many events in ONE round trip per table: the same rows `write` would insert
   * one by one, in the same order — the same ids drawn in the same order, the same
   * per-aggregate sequences (an aggregate named twice gets consecutive numbers, in the order
   * given), one `occurredAt` per event from the clock. For a bulk writer (the one-time
   * import) inside its own transaction; an empty list writes nothing.
   *
   * The sequence upsert adds each aggregate's COUNT in one statement (an aggregate may
   * appear only once per `INSERT … ON CONFLICT`, so they are grouped first) and the numbers
   * are handed out downwards from the returned last value — exactly what `count` calls of
   * `nextSequence` would have produced.
   */
  async writeMany<T extends EventType>(
    { tx, scope }: TransactionScope,
    actor: ActorContext,
    events: readonly {
      eventType: T;
      aggregateType: AggregateType;
      aggregateId: string;
      payload: EventPayload<T>;
      causationId?: string;
    }[],
  ): Promise<{ eventId: string; sequence: number }[]> {
    if (events.length === 0) return [];
    for (const event of events) {
      if (!isEventType(event.eventType)) {
        throw errors.validation(
          PLATFORM_ERROR_CODES.UNKNOWN_EVENT_TYPE,
          `"${String(event.eventType)}" is not in the event catalog. Adding an event is a contract change.`,
        );
      }
    }
    const aggregateKey = (type: string, id: string) => `${type}\u0000${id}`;
    const counts = new Map<string, { type: string; id: string; count: number }>();
    for (const event of events) {
      const key = aggregateKey(event.aggregateType, event.aggregateId);
      const entry = counts.get(key);
      if (entry === undefined) {
        counts.set(key, { type: event.aggregateType, id: event.aggregateId, count: 1 });
      } else entry.count += 1;
    }
    // Next sequence per aggregate: last − count + 1, handed out in the order given.
    const next = new Map<string, number>();
    const groups = [...counts.values()];
    for (let i = 0; i < groups.length; i += SEQUENCE_CHUNK) {
      const chunk = groups.slice(i, i + SEQUENCE_CHUNK);
      const rows = await tx
        .insert(aggregateSequences)
        .values(
          chunk.map((g) => ({
            aggregateType: g.type,
            aggregateId: g.id,
            lastSequence: BigInt(g.count),
          })),
        )
        .onConflictDoUpdate({
          target: [aggregateSequences.aggregateType, aggregateSequences.aggregateId],
          set: {
            lastSequence: sql`${aggregateSequences.lastSequence} + excluded.last_sequence`,
          },
        })
        .returning({
          aggregateType: aggregateSequences.aggregateType,
          aggregateId: aggregateSequences.aggregateId,
          lastSequence: aggregateSequences.lastSequence,
        });
      if (rows.length !== chunk.length) {
        throw errors.internal(
          'platform.outbox_sequence_failed',
          'Failed to allocate an outbox sequence.',
        );
      }
      for (const row of rows) {
        const key = aggregateKey(row.aggregateType, row.aggregateId);
        const group = counts.get(key);
        if (group === undefined) {
          throw errors.internal(
            'platform.outbox_sequence_failed',
            'Failed to allocate an outbox sequence.',
          );
        }
        next.set(key, Number(row.lastSequence) - group.count + 1);
      }
    }
    const tenantId = scopeTenantId(scope);
    const written: { eventId: string; sequence: number }[] = [];
    const values = events.map((event) => {
      const key = aggregateKey(event.aggregateType, event.aggregateId);
      const sequence = next.get(key);
      if (sequence === undefined) {
        throw errors.internal(
          'platform.outbox_sequence_failed',
          'Failed to allocate an outbox sequence.',
        );
      }
      next.set(key, sequence + 1);
      const eventId = this.ids.uuid();
      written.push({ eventId, sequence });
      return {
        id: eventId,
        tenantId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        sequence,
        eventType: event.eventType,
        eventVersion: EVENT_ENVELOPE_VERSION,
        payload: event.payload as Record<string, unknown>,
        actor: actorRef(actor),
        correlationId: actor.correlationId,
        causationId: event.causationId ?? null,
        occurredAt: this.clock.now(),
      };
    });
    for (let i = 0; i < values.length; i += OUTBOX_INSERT_CHUNK) {
      await tx.insert(outboxMessages).values(values.slice(i, i + OUTBOX_INSERT_CHUNK));
    }
    return written;
  }

  /**
   * Allocates the next per-aggregate sequence. Ordering is guaranteed per
   * aggregate and nowhere else; nothing in the design needs global ordering.
   */
  private async nextSequence(
    tx: TransactionScope['tx'],
    aggregateType: string,
    aggregateId: string,
  ): Promise<number> {
    const rows = await tx
      .insert(aggregateSequences)
      .values({ aggregateType, aggregateId, lastSequence: 1n })
      .onConflictDoUpdate({
        target: [aggregateSequences.aggregateType, aggregateSequences.aggregateId],
        set: { lastSequence: sql`${aggregateSequences.lastSequence} + 1` },
      })
      .returning({ lastSequence: aggregateSequences.lastSequence });

    const row = rows[0];
    if (!row) {
      throw errors.internal(
        'platform.outbox_sequence_failed',
        'Failed to allocate an outbox sequence.',
      );
    }
    return Number(row.lastSequence);
  }
}
