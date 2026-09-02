import { z } from 'zod';
import { actorRefSchema, type ActorRef } from './actor.js';
import { NOTIFICATION_KINDS } from './notifications.js';

/**
 * Domain events.
 *
 * State changes emit events; work runs as jobs. The distinction is encoded
 * here so it cannot blur.
 *
 * An event is written to `outbox_messages` inside the same transaction as the
 * state change it describes, then relayed. It exists if and only if the change
 * committed. The database is the log; Telegram and any webhook are projections.
 */

export const EVENT_ENVELOPE_VERSION = 1;

export interface DomainEvent<TPayload = unknown> {
  /** UUIDv7. Consumers dedupe on this. */
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  /** Null for platform-level events that belong to no tenant. */
  readonly tenantId: string | null;
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** Monotonic per `(aggregateType, aggregateId)`. Ordering is per-aggregate only. */
  readonly sequence: number;
  /** One business transaction, end to end, across surfaces and queues. */
  readonly correlationId: string;
  /** The event or command that caused this one. */
  readonly causationId: string | null;
  readonly actor: ActorRef;
  readonly occurredAt: string;
  readonly payload: TPayload;
}

export const domainEventSchema = z.object({
  eventId: z.string(),
  eventType: z.string().min(1),
  eventVersion: z.number().int().positive(),
  tenantId: z.string().nullable(),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  correlationId: z.string().min(1),
  causationId: z.string().nullable(),
  actor: actorRefSchema,
  occurredAt: z.iso.datetime(),
  payload: z.unknown(),
});

/**
 * The event name catalog.
 *
 * Names are PascalCase, past tense, prefixed by their aggregate. Names are
 * stable identifiers; payloads are versioned. Adding a payload field is safe,
 * changing one is a new version.
 *
 * Phase 0 registers only the platform events it actually emits. A module that
 * emits an unregistered event name fails the build — adding one is a contract
 * change, reviewed on its own.
 */
export const EVENT_TYPES = [
  // Platform — the only group Phase 0 emits
  'SystemPinged',
  'TenantCreated',
  'TenantStatusChanged',
  'BotInstanceRegistered',
  'BotInstanceStatusChanged',
  'SettingChanged',
  'PermissionDenied',

  // Identity — Phase 1. Lifecycle only: a sign-in is not a domain event, it is
  // an audit row. What other modules must react to is an administrator's
  // existence, status and privileges changing.
  'AdminCreated',
  'AdminStatusChanged',
  'AdminRolesChanged',
  'AdminPasswordChanged',

  // Control plane — Phase 2. Configuration changes are events because other
  // modules must be able to react to them; the audit row beside each one
  // answers a different question and is not a substitute.
  'TemplateOverrideChanged',
  'TemplateOverrideReverted',
  'FeatureFlagChanged',
  // The only event in this set with a consumer today: the relay turns it into a
  // send job, which is how the network call gets outside the transaction that
  // created the intent.
  'NotificationQueued',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);

export function isEventType(value: string): value is EventType {
  return EVENT_TYPE_SET.has(value);
}

export const AGGREGATE_TYPES = [
  'System',
  'Tenant',
  'BotInstance',
  'Setting',
  'Admin',
  'Template',
  'FeatureFlag',
  'Notification',
] as const;
export type AggregateType = (typeof AGGREGATE_TYPES)[number];

/**
 * Payload schemas, keyed by event type. A consumer parses with these rather
 * than trusting the envelope's `unknown`.
 */
export const EVENT_PAYLOAD_SCHEMAS = {
  SystemPinged: z.object({
    source: z.enum(['telegram', 'http', 'test']),
    note: z.string().max(200).optional(),
  }),
  TenantCreated: z.object({ slug: z.string(), kind: z.string() }),
  TenantStatusChanged: z.object({ from: z.string(), to: z.string() }),
  BotInstanceRegistered: z.object({ username: z.string() }),
  BotInstanceStatusChanged: z.object({ from: z.string(), to: z.string() }),
  SettingChanged: z.object({ key: z.string(), from: z.unknown(), to: z.unknown() }),
  PermissionDenied: z.object({ permissionKey: z.string(), reason: z.string() }),
  AdminCreated: z.object({
    username: z.string(),
    roleKeys: z.array(z.string()),
  }),
  AdminStatusChanged: z.object({ from: z.string(), to: z.string() }),
  AdminRolesChanged: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
  }),
  // Carries no password material of any kind, not even a length.
  AdminPasswordChanged: z.object({ bySelf: z.boolean() }),

  // Carries the revision number, not the body. A domain event is relayed and
  // may be projected anywhere; a template body is up to four kilobytes of
  // customer-facing copy and belongs in the revision table it was written to.
  TemplateOverrideChanged: z.object({
    key: z.string(),
    locale: z.string(),
    revision: z.number().int().positive(),
    /** Null when this is the tenant's first override of the key. */
    previousRevision: z.number().int().positive().nullable(),
  }),
  TemplateOverrideReverted: z.object({
    key: z.string(),
    locale: z.string(),
    /** The revision that records the revert itself. History is not rewound. */
    revision: z.number().int().positive(),
  }),
  FeatureFlagChanged: z.object({ key: z.string(), from: z.boolean(), to: z.boolean() }),
  NotificationQueued: z.object({
    kind: z.enum(NOTIFICATION_KINDS),
    /** The intent's identity. A retry reuses it and never mints a second one. */
    dedupeKey: z.string(),
  }),
} as const satisfies Record<EventType, z.ZodType>;

export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[T]>;

/**
 * The publishing port. Application services depend on this; the persistence
 * layer implements it by writing outbox rows in the caller's transaction.
 */
export interface EventPublisher {
  publish<T extends EventType>(event: {
    eventType: T;
    aggregateType: AggregateType;
    aggregateId: string;
    payload: EventPayload<T>;
  }): Promise<void>;
}
