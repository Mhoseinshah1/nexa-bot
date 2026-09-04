import {
  systemContext,
  type DomainEvent,
  type EventType,
  type OperationalEventRecorder,
} from '@nexa/contracts';
import type { EventConsumer } from '../../eventing/application/event-consumer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * The one consumer Phase 0 ships.
 *
 * It closes the loop the exit criterion requires — transaction, relay,
 * consumer — by turning a published `SystemPinged` event into an operational
 * event. That is a real projection of the event log, not a stub: the same shape
 * every later consumer takes.
 */
export class PingLogConsumer implements EventConsumer {
  readonly name = 'opslog.ping';
  readonly subscribesTo: readonly EventType[] = ['SystemPinged'];

  constructor(private readonly recorder: OperationalEventRecorder) {}

  async handle(event: DomainEvent, tx: TransactionScope): Promise<void> {
    const payload = event.payload as { source?: string };
    // Through the relay's transaction, never the pool. The projection and the
    // relay's claim on this event then commit together, which is what makes
    // "applied once" a fact rather than a race.
    await this.recorder.record(
      event.tenantId === null
        ? systemContext('outbox-relay')
        : { tenantId: event.tenantId as never, botInstanceId: null },
      {
        code: 'system.ping',
        severity: 'INFO',
        message: `System ping from ${payload.source ?? 'unknown'}.`,
        context: { eventId: event.eventId, sequence: event.sequence },
        correlationId: event.correlationId as never,
      },
      tx,
    );
  }
}
