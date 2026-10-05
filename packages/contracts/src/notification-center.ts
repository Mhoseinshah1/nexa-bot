import { z } from 'zod';
import type { PermissionKey } from './permissions.js';
import { OPERATIONAL_SEVERITIES, type OperationalSeverity } from './ports.js';

/**
 * Phase B3 — the Web Admin Notification Center (`docs/notification-center.md`).
 *
 * An OPERATOR inbox, and a PROJECTION: every notification is an `operational_events` row,
 * read through the rule table below. There is no notification table and no second
 * transport. What the inbox adds is per-administrator READ STATE, which is the
 * administrator's own and never touches the event — the operational log still has no
 * "mark as seen" (`OPERATIONAL_SCOPES`), and nothing here resolves a condition.
 *
 * Deduplication is the recorder's: a recurring condition is one row (same code and dedupe
 * key while open) with an occurrence counter and a last-seen time, so it is one
 * notification with a count. A recurrence AFTER an administrator read it makes it unread
 * again for that administrator, because their read mark is "read through last-seen T".
 */

/**
 * What a notification is about. A CATEGORY is what an administrator may or may not see
 * (`NOTIFICATION_CATEGORY_PERMISSIONS`), and what the inbox filters by.
 *
 * `INCIDENTS` is incident / maintenance updates (program §21): its rules are prefixes, and
 * the incident domain (Phase E3, `incidentOpsCode`) records under `incident.` or
 * `maintenance.`, linking to the incident by `incidentId`.
 */
export const NOTIFICATION_CATEGORIES = [
  'PAYMENTS',
  'GATEWAYS',
  'PANELS',
  'PROVISIONING',
  'BACKUPS',
  'RECOVERY',
  'SECURITY',
  'INCIDENTS',
  // TB10: Telegram Business support — a conversation waiting for a person, a connection that
  // cannot send (`business_chats.view`).
  'SUPPORT',
  // TB10: the support AI's providers — a rejected key, no provider answering
  // (`support_ai.configure`, the only key that can act on either).
  'SUPPORT_AI',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * The permission that admits a category — always an EXISTING view key, the one that opens
 * the page the notification links to. A notification an administrator could not follow is
 * one they are not shown, and its count is not in their badge.
 */
export const NOTIFICATION_CATEGORY_PERMISSIONS: Readonly<
  Record<NotificationCategory, PermissionKey>
> = {
  PAYMENTS: 'payments.view',
  GATEWAYS: 'payments.gateways.view',
  PANELS: 'panels.view',
  PROVISIONING: 'services.view',
  BACKUPS: 'backup.view',
  RECOVERY: 'backup.view',
  SECURITY: 'admins.view',
  INCIDENTS: 'incidents.view',
  SUPPORT: 'business_chats.view',
  SUPPORT_AI: 'support_ai.configure',
};

/**
 * Where a notification's deep link goes. An `…` target with an entity carries the id read
 * from the event's typed subject (`OperationalSubject`: `paymentId`, `panelId`,
 * `serviceId`, `orderId`); when the event names none, the link falls back to the list.
 */
export const NOTIFICATION_LINK_TARGETS = [
  'PAYMENT',
  'PAYMENTS',
  'PAYMENT_GATEWAYS',
  'PANEL',
  'PANELS',
  'SERVICE',
  'SERVICES',
  'ORDER',
  'ORDERS',
  'RECOVERY',
  'ADMINS',
  'ALERTS',
  // Phase E3: an incident's page, and the incident list.
  'INCIDENT',
  'INCIDENTS',
  // The automatic wallet refunds of paid orders that could not be delivered (`payments.view`).
  'COMPENSATIONS',
  // TB10: one business conversation, the business inbox (with its connections), and the
  // support AI's settings page (providers, keys, health).
  'BUSINESS_CHAT',
  'BUSINESS_CHATS',
  'SUPPORT_AI',
] as const;
export type NotificationLinkTarget = (typeof NOTIFICATION_LINK_TARGETS)[number];

/** The entity targets: which context key carries the id, and the list it falls back to. */
export const NOTIFICATION_ENTITY_LINKS: Readonly<
  Partial<
    Record<
      NotificationLinkTarget,
      { readonly contextKey: string; readonly fallback: NotificationLinkTarget }
    >
  >
> = {
  PAYMENT: { contextKey: 'paymentId', fallback: 'PAYMENTS' },
  PANEL: { contextKey: 'panelId', fallback: 'PANELS' },
  SERVICE: { contextKey: 'serviceId', fallback: 'SERVICES' },
  ORDER: { contextKey: 'orderId', fallback: 'ORDERS' },
  INCIDENT: { contextKey: 'incidentId', fallback: 'INCIDENTS' },
  BUSINESS_CHAT: { contextKey: 'conversationId', fallback: 'BUSINESS_CHATS' },
};

/**
 * One rule: which operational codes become notifications, in which category, linking where,
 * from which severity up.
 *
 * `code` matches exactly; `prefix` matches by `starts_with` (never SQL `LIKE`, where `_` is a
 * wildcard). A RECOVERY row (`recovers_code` set) is never a notification whatever the rule
 * says — it is what marks the failure's notification resolved.
 */
export interface NotificationRule {
  readonly code?: string;
  readonly prefix?: string;
  readonly category: NotificationCategory;
  readonly link: NotificationLinkTarget;
  /** The lowest severity admitted. Most rules start at WARN. */
  readonly minSeverity: OperationalSeverity;
}

/**
 * THE EXTENSION POINT. A new source of operator notifications is a row here — an exact code
 * or a prefix, a category, a link — and nothing else: the recorder already dedupes it, the
 * inbox already projects it, the badge already counts it. No special case in any reader.
 *
 * Deliberately NOT everything. Routine operations (every probe, every delivery, every
 * customer send) belong to the Telegram operations group, and `access.permission_denied` —
 * a refusal, usually a misclick — would bury the inbox; it stays on the alerts page.
 * Audit rows are a different store and are never projected here.
 */
export const NOTIFICATION_RULES: readonly NotificationRule[] = [
  // --- payments that need a person ------------------------------------------------------
  // A gateway's review or settlement ended with no trustworthy answer: reconcile it.
  {
    code: 'payments.gateway_review_unresolved',
    category: 'PAYMENTS',
    link: 'PAYMENT',
    minSeverity: 'WARN',
  },
  // UNKNOWN outcomes: a create, a receipt upload or a card change whose answer was lost.
  {
    code: 'payments.gateway_create_unknown',
    category: 'PAYMENTS',
    link: 'PAYMENT',
    minSeverity: 'WARN',
  },
  {
    code: 'payments.gateway_receipt_unknown',
    category: 'PAYMENTS',
    link: 'PAYMENT',
    minSeverity: 'WARN',
  },
  {
    code: 'payments.gateway_card_change_unknown',
    category: 'PAYMENTS',
    link: 'PAYMENT',
    minSeverity: 'WARN',
  },
  // Money that arrived late, for someone else, or for nothing invoiced.
  {
    code: 'payments.gateway_late_completion',
    category: 'PAYMENTS',
    link: 'PAYMENT',
    minSeverity: 'WARN',
  },
  {
    code: 'payments.gateway_identity_mismatch',
    category: 'PAYMENTS',
    link: 'PAYMENT',
    minSeverity: 'WARN',
  },
  {
    code: 'payments.gateway_charge_unmatched',
    category: 'PAYMENTS',
    link: 'PAYMENTS',
    minSeverity: 'WARN',
  },
  // Reviewers were not told about a receipt, or a refund request, waiting for them.
  {
    code: 'payments.receipt_push_failed',
    category: 'PAYMENTS',
    link: 'PAYMENTS',
    minSeverity: 'WARN',
  },
  {
    code: 'payments.refund_request_push_failed',
    category: 'PAYMENTS',
    link: 'SERVICES',
    minSeverity: 'WARN',
  },
  // --- gateways failing repeatedly (one deduped condition per provider) -----------------
  {
    code: 'payments.gateway_misconfigured',
    category: 'GATEWAYS',
    link: 'PAYMENT_GATEWAYS',
    minSeverity: 'WARN',
  },
  {
    code: 'payments.gateway_webhook_unverified',
    category: 'GATEWAYS',
    link: 'PAYMENT_GATEWAYS',
    minSeverity: 'WARN',
  },
  // --- panels down, degraded or full -----------------------------------------------------
  { prefix: 'panel.health.', category: 'PANELS', link: 'PANEL', minSeverity: 'WARN' },
  { prefix: 'panel.capacity.', category: 'PANELS', link: 'PANEL', minSeverity: 'WARN' },
  {
    code: 'panel.monitor.tenant_budget_exceeded',
    category: 'PANELS',
    link: 'PANELS',
    minSeverity: 'WARN',
  },
  // --- provisioning that did not happen --------------------------------------------------
  { code: 'provisioning.stalled', category: 'PROVISIONING', link: 'SERVICE', minSeverity: 'WARN' },
  /*
   * A paid order that could not be delivered was refunded to the wallet. Under PAYMENTS and
   * linked to the compensation list, both `payments.view`: under PROVISIONING
   * (`services.view`) it linked to an order page that charges `orders.view`, which the
   * category never checked (Codex, #162). A link is reachable under its category's key.
   */
  {
    code: 'order.refunded_undeliverable',
    category: 'PAYMENTS',
    link: 'COMPENSATIONS',
    minSeverity: 'INFO',
  },
  // --- backup and recovery ---------------------------------------------------------------
  { code: 'backup.run_failed', category: 'BACKUPS', link: 'RECOVERY', minSeverity: 'WARN' },
  { code: 'recovery.run_failed', category: 'RECOVERY', link: 'RECOVERY', minSeverity: 'WARN' },
  // --- security: lock-outs and changes to who may do what --------------------------------
  { code: 'auth.login_locked_out', category: 'SECURITY', link: 'ADMINS', minSeverity: 'INFO' },
  { code: 'admin.created', category: 'SECURITY', link: 'ADMINS', minSeverity: 'INFO' },
  { code: 'admin.roles_changed', category: 'SECURITY', link: 'ADMINS', minSeverity: 'INFO' },
  { code: 'admin.status_changed', category: 'SECURITY', link: 'ADMINS', minSeverity: 'INFO' },
  { code: 'admin.password_reset', category: 'SECURITY', link: 'ADMINS', minSeverity: 'INFO' },
  { code: 'admin.sessions_revoked', category: 'SECURITY', link: 'ADMINS', minSeverity: 'INFO' },
  // --- incidents and maintenance: the typed hook, matched by prefix ----------------------
  { prefix: 'incident.', category: 'INCIDENTS', link: 'INCIDENT', minSeverity: 'INFO' },
  { prefix: 'maintenance.', category: 'INCIDENTS', link: 'INCIDENT', minSeverity: 'INFO' },
  // --- TB10: the support agent ----------------------------------------------------------
  /*
   * Exact codes, never a `support.` prefix: `support.handoff_resolved`, `….usable`,
   * `….credential_accepted` and `….available` are recoveries, and a prefix would also admit
   * whatever `support.` code a later package records without anyone deciding it should
   * reach an inbox. Each one is a condition the recorder dedupes and a recovery closes.
   */
  // A conversation was handed to a person (TB7): open it. Deduped per conversation.
  {
    code: 'support.handoff_required',
    category: 'SUPPORT',
    link: 'BUSINESS_CHAT',
    minSeverity: 'WARN',
  },
  // A Telegram Business connection is disabled or lost the right to reply (TB1).
  {
    code: 'support.business_connection.unusable',
    category: 'SUPPORT',
    link: 'BUSINESS_CHATS',
    minSeverity: 'WARN',
  },
  // A provider rejected its key, or every configured provider failed (TB4).
  {
    code: 'support.ai_provider.credential_rejected',
    category: 'SUPPORT_AI',
    link: 'SUPPORT_AI',
    minSeverity: 'WARN',
  },
  {
    code: 'support.ai_provider.unavailable',
    category: 'SUPPORT_AI',
    link: 'SUPPORT_AI',
    minSeverity: 'WARN',
  },
];

const SEVERITY_RANK = new Map<string, number>(
  OPERATIONAL_SEVERITIES.map((severity, index) => [severity, index]),
);

/** The rule an event falls under, exact codes before prefixes; null when none does. */
export function notificationRuleFor(code: string): NotificationRule | null {
  const exact = NOTIFICATION_RULES.find((rule) => rule.code === code);
  if (exact !== undefined) return exact;
  return (
    NOTIFICATION_RULES.find((rule) => rule.prefix !== undefined && code.startsWith(rule.prefix)) ??
    null
  );
}

/** Whether an event is a notification at all: a rule, its severity, and not a recovery. */
export function isNotification(event: {
  readonly code: string;
  readonly severity: string;
  readonly recoversCode: string | null;
}): boolean {
  if (event.recoversCode !== null) return false;
  const rule = notificationRuleFor(event.code);
  if (rule === null) return false;
  return (SEVERITY_RANK.get(event.severity) ?? -1) >= (SEVERITY_RANK.get(rule.minSeverity) ?? 99);
}

/** The categories an administrator holding `permissions` may see. */
export function visibleNotificationCategories(
  permissions: ReadonlySet<string> | readonly string[],
): NotificationCategory[] {
  const held = permissions instanceof Set ? permissions : new Set(permissions as readonly string[]);
  return NOTIFICATION_CATEGORIES.filter((category) =>
    held.has(NOTIFICATION_CATEGORY_PERMISSIONS[category]),
  );
}

/**
 * A condition stays in the inbox while it is open. Everything else — a resolved condition, a
 * one-shot record — stays this long after it was last seen, so the inbox and its badge are
 * bounded however long the installation runs.
 */
export const NOTIFICATION_WINDOW_DAYS = 30;
export const INBOX_PAGE_DEFAULT = 30;
export const INBOX_PAGE_MAX = 100;
/** The bell polls this often; a count is a hint, the inbox is the answer. */
export const NOTIFICATION_SUMMARY_REFRESH_MS = 60_000;

// --- HTTP -------------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Whether a context value is safe to put in a link: a UUID, nothing else. */
export function isLinkableId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export const inboxLinkSchema = z.object({
  target: z.enum(NOTIFICATION_LINK_TARGETS),
  id: z.string().regex(UUID_PATTERN).nullable(),
});
export type InboxLink = z.infer<typeof inboxLinkSchema>;

export const inboxNotificationSchema = z.object({
  /** The operational event's id. */
  id: z.string(),
  code: z.string(),
  category: z.enum(NOTIFICATION_CATEGORIES),
  severity: z.enum(OPERATIONAL_SEVERITIES),
  /** The recorder's operator-facing sentence. */
  message: z.string(),
  occurrenceCount: z.number().int().positive(),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  /** When the condition cleared; null while open, and always null for a one-shot record. */
  resolvedAt: z.iso.datetime().nullable(),
  read: z.boolean(),
  link: inboxLinkSchema,
});
export type InboxNotification = z.infer<typeof inboxNotificationSchema>;

export const inboxListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(INBOX_PAGE_MAX).default(INBOX_PAGE_DEFAULT),
    category: z.enum(NOTIFICATION_CATEGORIES).optional(),
    unread: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    /** Keyset on the immutable `(first_seen_at, id)`, newest first. Both halves or neither. */
    beforeAt: z.iso.datetime().optional(),
    beforeId: z.string().regex(UUID_PATTERN).optional(),
  })
  // Half a cursor is no cursor: accepting one would silently answer page 1 to a caller
  // that asked for a later page, so it is refused, as the ticket cursor refuses it.
  .refine((query) => (query.beforeAt === undefined) === (query.beforeId === undefined), {
    message: 'beforeAt and beforeId must be supplied together.',
    path: ['beforeId'],
  });
export type InboxListQuery = z.infer<typeof inboxListQuerySchema>;

export const inboxListResponseSchema = z.object({
  notifications: z.array(inboxNotificationSchema),
  nextCursor: z.object({ at: z.iso.datetime(), id: z.string() }).nullable(),
});
export type InboxListResponse = z.infer<typeof inboxListResponseSchema>;

export const inboxSummaryResponseSchema = z.object({
  /** Unread notifications this administrator may see, capped at `COUNTER_CAP`. */
  unread: z.number().int().nonnegative(),
  /** `unread` reached the cap: "this many or more". */
  atLeast: z.boolean(),
  /** The highest severity among the unread, for the bell's tone; null when none. */
  highestUnread: z.enum(OPERATIONAL_SEVERITIES).nullable(),
});
export type InboxSummaryResponse = z.infer<typeof inboxSummaryResponseSchema>;

export const markInboxRequestSchema = z.object({ read: z.boolean() }).strict();
export type MarkInboxRequest = z.infer<typeof markInboxRequestSchema>;

export const markAllInboxRequestSchema = z
  .object({ category: z.enum(NOTIFICATION_CATEGORIES).optional() })
  .strict();
export type MarkAllInboxRequest = z.infer<typeof markAllInboxRequestSchema>;

export const markInboxResponseSchema = z.object({ notification: inboxNotificationSchema });
export type MarkInboxResponse = z.infer<typeof markInboxResponseSchema>;

export const markAllInboxResponseSchema = z.object({
  /** How many notifications this call turned from unread to read. */
  marked: z.number().int().nonnegative(),
});
export type MarkAllInboxResponse = z.infer<typeof markAllInboxResponseSchema>;

/** Paths under `API_PREFIX`. `/notifications` is the Phase 2 operator-channel page's. */
export const NOTIFICATION_CENTER_ROUTES = {
  list: '/notification-center',
  summary: '/notification-center/summary',
  mark: (id: string) => `/notification-center/${id}/read`,
  markAll: '/notification-center/read-all',
} as const;

export const NOTIFICATION_CENTER_ERROR_CODES = {
  /** No such notification for this administrator — absent, another tenant's, or not visible. */
  NOT_FOUND: 'notification_center.not_found',
} as const;
