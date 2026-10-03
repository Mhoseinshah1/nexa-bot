import { z } from 'zod';

/**
 * Phase E3 — incidents and maintenance (`docs/incidents.md`).
 *
 * An incident is an operator's RECORD of something happening — an outage, a degradation, a
 * planned maintenance window — with a title, a scope, a status, a start and an end, a
 * description and an optional customer-facing message. It is not a switch that turns parts
 * of the installation off by itself: every operational EFFECT (stop new sales on a panel or
 * location, withdraw a product, disable a gateway) is executed through the owning module's
 * EXISTING enablement mechanism — panel drain, product deactivation, gateway status — by
 * an operator, under that module's own permission and audit, and recorded on the incident's
 * timeline. Nothing unrelated is ever touched: an effect names exactly one target.
 *
 * Money rules hold by construction: every effect refuses NEW sales before money moves
 * (the catalogue and confirmation already ask drain, product status and gateway status),
 * and nothing here pauses an order that is already paid — that would be the "paid,
 * undelivered, somebody will decide later" state the installation forbids.
 */

export const INCIDENT_KINDS = ['INCIDENT', 'MAINTENANCE'] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const INCIDENT_SEVERITIES = ['MINOR', 'MAJOR', 'CRITICAL'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

/**
 * - `SCHEDULED` — a future window; the worker starts it at `scheduledStartAt`.
 * - `ACTIVE` — happening now.
 * - `RESOLVED` — over. Terminal.
 * - `CANCELLED` — a scheduled window that never happened. Terminal.
 */
export const INCIDENT_STATUSES = ['SCHEDULED', 'ACTIVE', 'RESOLVED', 'CANCELLED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const INCIDENT_TERMINAL_STATUSES: readonly IncidentStatus[] = ['RESOLVED', 'CANCELLED'];

/** What an incident can be about. `LOCATION` is a configured service location (a panel's). */
export const INCIDENT_TARGET_KINDS = ['PANEL', 'LOCATION', 'PRODUCT', 'GATEWAY'] as const;
export type IncidentTargetKind = (typeof INCIDENT_TARGET_KINDS)[number];

/**
 * The effect a target takes when sales stop, each through its module's own mechanism:
 *
 * - `PANEL_DRAIN` — panel drain (Phase C2): no new allocations, existing services untouched.
 * - `LOCATION_DISABLE` — the configured location is switched off (`enabled`), so it is no
 *   longer offered; nothing else on its panel changes.
 * - `PRODUCT_DEACTIVATE` — the product leaves the catalogue; orders already placed keep
 *   their snapshot.
 * - `GATEWAY_DISABLE` — the gateway route is switched off; a payment already started keeps
 *   its own lifecycle.
 */
export const INCIDENT_EFFECT_KINDS = [
  'PANEL_DRAIN',
  'LOCATION_DISABLE',
  'PRODUCT_DEACTIVATE',
  'GATEWAY_DISABLE',
] as const;
export type IncidentEffectKind = (typeof INCIDENT_EFFECT_KINDS)[number];

/**
 * - `PENDING` / `REVERTING` — CLAIMED by one reconcile, which is applying or restoring it
 *   now. The claim is a row insert (or a conditional update) before the owning module is
 *   called, so two operators, a double click or a retry run each effect once. A claim
 *   older than `INCIDENT_EFFECT_CLAIM_STALE_MS` belongs to a process that died, and is
 *   taken over — safely, because each module call is idempotent by a key derived from the
 *   incident and the subject.
 * - `APPLIED` — this incident changed the target. Reverted at resolution, and only if the
 *   target is still in the state this incident put it in.
 * - `ALREADY` — the target was already in that state; this incident changed nothing and
 *   will restore nothing.
 * - `FAILED` — the owning module refused (a permission, a conflict); nothing changed.
 * - `REVERTED` — restored at resolution.
 * - `KEPT` — at resolution the target was no longer in the state this incident set
 *   (somebody changed it since), so it was left as it is.
 */
export const INCIDENT_EFFECT_STATES = [
  'PENDING',
  'APPLIED',
  'ALREADY',
  'FAILED',
  'REVERTING',
  'REVERTED',
  'KEPT',
] as const;
export type IncidentEffectState = (typeof INCIDENT_EFFECT_STATES)[number];
export const INCIDENT_EFFECT_CLAIM_STALE_MS = 5 * 60_000;

/** The timeline: every state change, scope change, effect and communication, in order. */
export const INCIDENT_EVENT_KINDS = [
  'CREATED',
  'SCHEDULED',
  'STARTED',
  'UPDATED',
  'SCOPE_CHANGED',
  'EFFECT',
  'EFFECTS_PENDING',
  'COMMUNICATED',
  'RESOLVED',
  'CANCELLED',
] as const;
export type IncidentEventKind = (typeof INCIDENT_EVENT_KINDS)[number];

/**
 * The operational codes an incident records, through the ordinary recorder. All are under
 * `incident.` / `maintenance.`, which `NOTIFICATION_RULES` already routes to the
 * Notification Center's INCIDENTS category; the `.resolved` codes are RECOVERIES, which
 * close the started condition rather than adding a notification.
 */
export function incidentOpsCode(
  kind: IncidentKind,
  what: 'scheduled' | 'started' | 'resolved' | 'cancelled' | 'effects_pending',
): string {
  return `${kind === 'INCIDENT' ? 'incident' : 'maintenance'}.${what}`;
}
/** One open condition per incident: the dedupe key its start opens and its end closes. */
export function incidentConditionKey(incidentId: string): string {
  return `incident:${incidentId}`;
}

export const INCIDENT_TITLE_MAX_LENGTH = 160;
export const INCIDENT_DESCRIPTION_MAX_LENGTH = 4000;
/** What customers read; Telegram's bound leaves room for the template's heading. */
export const INCIDENT_CUSTOMER_MESSAGE_MAX_LENGTH = 1500;
export const INCIDENT_TARGETS_MAX = 50;
/**
 * A customer notice is not sent once it is this old: a maintenance notice that leaves the
 * queue a day late describes a window that may be over.
 */
export const INCIDENT_NOTICE_STALE_AFTER_MS = 12 * 3_600_000;
/** How often the worker looks for scheduled windows whose start has come. */
export const INCIDENT_SCHEDULER_INTERVAL_MS = 60_000;

// --- HTTP -------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const idempotencyKey = z.string().min(8).max(255);

export const incidentTargetSchema = z
  .object({
    kind: z.enum(INCIDENT_TARGET_KINDS),
    /** A panel, location or product id (UUID), or a gateway's provider code. */
    ref: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/u),
  })
  .strict();
export type IncidentTarget = z.infer<typeof incidentTargetSchema>;

export function isValidIncidentTarget(target: IncidentTarget): boolean {
  return target.kind === 'GATEWAY'
    ? /^[A-Z][A-Z0-9_]{1,31}$/u.test(target.ref)
    : UUID.test(target.ref);
}

const incidentFields = {
  kind: z.enum(INCIDENT_KINDS),
  severity: z.enum(INCIDENT_SEVERITIES),
  title: z.string().trim().min(1).max(INCIDENT_TITLE_MAX_LENGTH),
  description: z.string().trim().max(INCIDENT_DESCRIPTION_MAX_LENGTH).default(''),
  customerMessage: z
    .string()
    .trim()
    .max(INCIDENT_CUSTOMER_MESSAGE_MAX_LENGTH)
    .nullable()
    .default(null),
  targets: z.array(incidentTargetSchema).max(INCIDENT_TARGETS_MAX).default([]),
  /** Stop new sales on the targets, through their modules' own mechanisms. */
  stopSales: z.boolean().default(false),
  /** Show a banner to every administrator while the incident is ACTIVE. */
  adminBanner: z.boolean().default(true),
};

export const createIncidentRequestSchema = z
  .object({
    idempotencyKey,
    ...incidentFields,
    /** Null starts it now; a future instant schedules it. */
    scheduledStartAt: z.iso.datetime().nullable().default(null),
    scheduledEndAt: z.iso.datetime().nullable().default(null),
  })
  .strict();
export type CreateIncidentRequest = z.input<typeof createIncidentRequestSchema>;

/** Edits are versioned: the version the editor read, or the edit is refused. */
export const updateIncidentRequestSchema = z
  .object({
    idempotencyKey,
    expectedVersion: z.number().int().positive(),
    ...incidentFields,
    scheduledStartAt: z.iso.datetime().nullable().default(null),
    scheduledEndAt: z.iso.datetime().nullable().default(null),
  })
  .strict();
export type UpdateIncidentRequest = z.input<typeof updateIncidentRequestSchema>;

export const incidentActionRequestSchema = z
  .object({ idempotencyKey, expectedVersion: z.number().int().positive() })
  .strict();
export type IncidentActionRequest = z.infer<typeof incidentActionRequestSchema>;

/** The customer notice: the preview's count must be sent back to confirm. */
export const incidentNoticeRequestSchema = z
  .object({
    idempotencyKey,
    expectedVersion: z.number().int().positive(),
    expectedRecipients: z.number().int().nonnegative(),
  })
  .strict();
export type IncidentNoticeRequest = z.infer<typeof incidentNoticeRequestSchema>;

export const incidentEffectSchema = z.object({
  kind: z.enum(INCIDENT_EFFECT_KINDS),
  targetKind: z.enum(INCIDENT_TARGET_KINDS),
  targetRef: z.string(),
  /** The thing actually changed: the panel for a location, else the target itself. */
  subjectRef: z.string(),
  state: z.enum(INCIDENT_EFFECT_STATES),
  errorCode: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type IncidentEffectItem = z.infer<typeof incidentEffectSchema>;

export const incidentEventSchema = z.object({
  id: z.string(),
  kind: z.enum(INCIDENT_EVENT_KINDS),
  actorLabel: z.string().nullable(),
  /** A structured, non-sensitive detail: what changed, how many were told. */
  detail: z.record(z.string(), z.unknown()).nullable(),
  occurredAt: z.iso.datetime(),
});
export type IncidentEventItem = z.infer<typeof incidentEventSchema>;

export const incidentSchema = z.object({
  id: z.string(),
  kind: z.enum(INCIDENT_KINDS),
  severity: z.enum(INCIDENT_SEVERITIES),
  status: z.enum(INCIDENT_STATUSES),
  title: z.string(),
  description: z.string(),
  customerMessage: z.string().nullable(),
  targets: z.array(incidentTargetSchema),
  stopSales: z.boolean(),
  adminBanner: z.boolean(),
  scheduledStartAt: z.iso.datetime().nullable(),
  scheduledEndAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  effects: z.array(incidentEffectSchema),
});
export type IncidentItem = z.infer<typeof incidentSchema>;

export const incidentResponseSchema = z.object({ incident: incidentSchema });
export type IncidentResponse = z.infer<typeof incidentResponseSchema>;

export const incidentDetailResponseSchema = z.object({
  incident: incidentSchema,
  timeline: z.array(incidentEventSchema),
});
export type IncidentDetailResponse = z.infer<typeof incidentDetailResponseSchema>;

export const incidentListResponseSchema = z.object({ incidents: z.array(incidentSchema) });
export type IncidentListResponse = z.infer<typeof incidentListResponseSchema>;

/** What a notice would reach now: customers with a live service on the scope. */
export const incidentNoticePreviewResponseSchema = z.object({
  recipients: z.number().int().nonnegative(),
  version: z.number().int().positive(),
});
export type IncidentNoticePreviewResponse = z.infer<typeof incidentNoticePreviewResponseSchema>;

export const incidentNoticeResponseSchema = z.object({
  incident: incidentSchema,
  queued: z.number().int().nonnegative(),
});
export type IncidentNoticeResponse = z.infer<typeof incidentNoticeResponseSchema>;

/** The admin banner: ACTIVE incidents that asked for one. Any administrator may read it. */
export const incidentBannerResponseSchema = z.object({
  incidents: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(INCIDENT_KINDS),
      severity: z.enum(INCIDENT_SEVERITIES),
      title: z.string(),
      startedAt: z.iso.datetime().nullable(),
      scheduledEndAt: z.iso.datetime().nullable(),
    }),
  ),
});
export type IncidentBannerResponse = z.infer<typeof incidentBannerResponseSchema>;

export const INCIDENT_ROUTES = {
  list: '/incidents',
  create: '/incidents',
  banner: '/incidents/banner',
  one: (id: string) => `/incidents/${id}`,
  update: (id: string) => `/incidents/${id}/edit`,
  start: (id: string) => `/incidents/${id}/start`,
  applyEffects: (id: string) => `/incidents/${id}/effects/apply`,
  resolve: (id: string) => `/incidents/${id}/resolve`,
  cancel: (id: string) => `/incidents/${id}/cancel`,
  noticePreview: (id: string) => `/incidents/${id}/notice/preview`,
  notice: (id: string) => `/incidents/${id}/notice`,
} as const;

export const INCIDENT_ERROR_CODES = {
  NOT_FOUND: 'incident.not_found',
  /** Not possible in the incident's current status. */
  STATE_CONFLICT: 'incident.state_conflict',
  /** The incident changed since it was read. */
  VERSION_CONFLICT: 'incident.version_conflict',
  /** A target that does not exist in this tenant, or is malformed. */
  TARGET_INVALID: 'incident.target_invalid',
  /** A schedule whose start is past, or whose end is not after its start. */
  SCHEDULE_INVALID: 'incident.schedule_invalid',
  /** A notice with no customer message, or a count that differs from the preview's. */
  NOTICE_REFUSED: 'incident.notice_refused',
} as const;
