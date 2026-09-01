import { sql } from 'drizzle-orm';
import {
  errors,
  isEventType,
  isSystemContext,
  PLATFORM_ERROR_CODES,
  type ActorContext,
  type AggregateType,
  type Clock,
  type EventPayload,
  type EventType,
  type IdGenerator,
  type ScopeContext,
} from '@nexa/contracts';
import { actorRef, EVENT_ENVELOPE_VERSION } from '@nexa/contracts';
import {
  aggregateSequences,
  outboxMessages,
} from '../../../../infrastructure/persistence/schema.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { scopeTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';

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

/** Convenience for code paths that legitimately have no tenant. */
export function describeScope(scope: ScopeContext): string {
  return isSystemContext(scope) ? `system:${scope.reason}` : `tenant:${scope.tenantId}`;
}
