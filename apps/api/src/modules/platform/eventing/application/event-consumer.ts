import type { DomainEvent, EventType } from '@nexa/contracts';

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
  handle(event: DomainEvent): Promise<void>;
}

export const EVENT_CONSUMERS = Symbol('EVENT_CONSUMERS');
