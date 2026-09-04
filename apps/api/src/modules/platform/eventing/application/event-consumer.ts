import type { DomainEvent, EventType } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * A consumer of domain events.
 *
 * Delivery is at-least-once. Effects are effectively-once, because the relay
 * records which event ids each consumer has already applied — one half without
 * the other is not a guarantee, it is a hope.
 *
 * Each consumer has its own cursor: a failing consumer does not block the
 * others, and a consumer added later can be replayed independently.
 */
export interface EventConsumer {
  /** Stable name. It is the key in `processed_messages`, so it never changes. */
  readonly name: string;
  /** The event types this consumer wants. */
  readonly subscribesTo: readonly EventType[];
  /**
   * Apply the event's effect, INSIDE the relay's transaction.
   *
   * `tx` is the transaction the relay claimed this (consumer, event) pair in,
   * and every database write the effect makes must go through it. That is the
   * whole of the effectively-once guarantee: the claim and the effect commit
   * together or roll back together. A consumer that wrote through the pool
   * instead would commit its effect on its own connection, and the claim it
   * was paired with could then roll back — leaving an effect with no record of
   * it, and a redelivery that applies it again.
   *
   * A consumer that must talk to something outside the database (Telegram, a
   * panel) does not belong here at all; that is what the notification poller
   * is for (ADR-0018), because a transaction must not be held open across a
   * network call.
   */
  handle(event: DomainEvent, tx: TransactionScope): Promise<void>;
}

export const EVENT_CONSUMERS = Symbol('EVENT_CONSUMERS');
