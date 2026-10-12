import type { OperationalSeverity } from './ports.js';

/**
 * FIX-04 / FIX-05 (2026-10-09) — the ONE taxonomy of reportable operational events.
 *
 * The owner's instruction: every error the bot has, wherever it happens, recorded in the
 * operations log group with enough information to act on. This file is the map that says,
 * for every operational-event code this installation records, WHAT it is (its class and
 * area), HOW it is deduplicated, and HOW it is presented in the group. It adds no second
 * pipeline: every event still goes through the one recorder (`operational_events`), the
 * one projector (`NotifyingOperationalEventRecorder`) and the one dispatcher, which already
 * own dedupe, routing to the group's topics, retries, the per-minute ceiling and the
 * preserved (dead-letter) state.
 *
 * A code is part of the schema (CLAUDE.md): the entries below never rename or split one.
 * `docs/ops-error-events.md` is the coverage matrix this table is the source of truth for,
 * and `tests/unit/ops-error-events.test.ts` scans the source for every code recorded and
 * fails when one is not classified here.
 */

// ---------------------------------------------------------------------------
// Classes — the severity policy
// ---------------------------------------------------------------------------

/**
 * The five classes an operator reads, each with one policy (`OPS_ERROR_CLASS_POLICY`).
 *
 * `SECURITY` is a CLASS, not a stored severity. `operational_events.severity` is pinned by
 * a CHECK constraint to `OPERATIONAL_SEVERITIES`, and every reader of the column (the alerts
 * page, the notification centre's rank, the gateway-health roll-up) ranks by that list — a
 * sixth stored value would be a widened vocabulary an older replica cannot read after a
 * rollback. So a security event is STORED at the severity its policy names and PRESENTED
 * as `SECURITY`: the group message prints the class, and its code routes it to the
 * SECURITY topic (`OPS_LOG_TOPIC_ROUTES`) — by its family prefix, or, for
 * `payments.gateway_webhook_unverified`, by a route of its own ahead of `payments.`. The
 * unit test pins every code here to its topic, and every SECURITY-class code to SECURITY.
 */
export const OPS_ERROR_CLASSES = ['SECURITY', 'CRITICAL', 'ERROR', 'WARN', 'INFO'] as const;
export type OpsErrorClass = (typeof OPS_ERROR_CLASSES)[number];

export interface OpsErrorClassPolicy {
  /** The severity a NEW code of this class is recorded at. */
  readonly storedSeverity: OperationalSeverity;
  /** What earns the class. */
  readonly when: string;
}

export const OPS_ERROR_CLASS_POLICY: Readonly<Record<OpsErrorClass, OpsErrorClassPolicy>> = {
  SECURITY: {
    storedSeverity: 'WARN',
    when:
      'Somebody was refused, locked out or blocked, or a privileged identity changed: an ' +
      'actionable abuse or access fact. Never a customer typing something invalid.',
  },
  CRITICAL: {
    storedSeverity: 'CRITICAL',
    when:
      'Money or data is at risk, or the installation as a whole has stopped doing its job ' +
      '(a recovery failed, a lane every customer depends on stopped).',
  },
  ERROR: {
    storedSeverity: 'ERROR',
    when:
      'An operation failed and will not succeed on its own: an operator has to look ' +
      '(a payment link could not be made, a configuration was refused, a job stalled).',
  },
  WARN: {
    storedSeverity: 'WARN',
    when:
      'Degraded or ambiguous: the outcome is UNKNOWN, a fallback is in use, or the condition ' +
      'is retried automatically. Worth reading; not yet a failure.',
  },
  INFO: {
    storedSeverity: 'INFO',
    when: 'A recovery, or a fact an operator asked to be told. Never a failure.',
  },
};

/** The class a stored severity reads as when a code names no class of its own. */
export function opsErrorClassOfSeverity(severity: OperationalSeverity): OpsErrorClass {
  return severity === 'DEBUG' ? 'INFO' : severity;
}

// ---------------------------------------------------------------------------
// Areas — the owner's list
// ---------------------------------------------------------------------------

/** The owner's FIX-05 groups, one per row family of the coverage matrix. */
export const OPS_ERROR_AREAS = [
  'PAYMENTS',
  'WALLET',
  'DELIVERY',
  'TELEGRAM',
  'USERS',
  'BOT_SETUP',
  'ORDERS',
  'NOTIFICATIONS',
  'SECURITY',
  'JOBS',
  'PANELS',
  'BACKUPS',
  'SYSTEM',
] as const;
export type OpsErrorArea = (typeof OPS_ERROR_AREAS)[number];

/**
 * How a code's occurrences collapse.
 *
 * - `CONDITION` — one row per subject, open until a recovery code closes it; announced when
 *   it opens and again when it reopens.
 * - `PER_SUBJECT` — one row per subject (a payment, a message), never recovered: each
 *   subject is its own fact.
 * - `WINDOW` — one row per subject per aggregation window (`opsAggregationKey`): a storm
 *   of the same failure is one message per window with an occurrence counter, and the
 *   next window announces again if it is still happening.
 * - `PER_OCCURRENCE` — no dedupe key: every occurrence is a row (rare, bounded facts).
 */
export const OPS_ERROR_DEDUPE_POLICIES = [
  'CONDITION',
  'PER_SUBJECT',
  'WINDOW',
  'PER_OCCURRENCE',
] as const;
export type OpsErrorDedupePolicy = (typeof OPS_ERROR_DEDUPE_POLICIES)[number];

/** Whether a code reports something going wrong, something going right again, or a fact. */
export const OPS_ERROR_KINDS = ['FAILURE', 'RECOVERY', 'FACT'] as const;
export type OpsErrorKind = (typeof OPS_ERROR_KINDS)[number];

/**
 * How the group message is laid out. `GENERIC` is `ops.notification.operational_event`;
 * `PAYMENT_LINK` is `ops.notification.payment_link_failed` (FIX-04).
 */
export const OPS_ERROR_PRESENTATIONS = ['GENERIC', 'PAYMENT_LINK'] as const;
export type OpsErrorPresentation = (typeof OPS_ERROR_PRESENTATIONS)[number];

/** The template each presentation renders, from the frozen catalogue. */
export const OPS_ERROR_PRESENTATION_TEMPLATES = {
  GENERIC: 'ops.notification.operational_event',
  PAYMENT_LINK: 'ops.notification.payment_link_failed',
} as const satisfies Record<OpsErrorPresentation, string>;

// ---------------------------------------------------------------------------
// FIX-04 — payment link creation
// ---------------------------------------------------------------------------

/**
 * A gateway's create-invoice / payment-link request ended with no link a customer can
 * use, for any reason OTHER than an unknown outcome (which keeps its own, older code,
 * `payments.gateway_create_unknown`, so an operator's existing filter still finds it).
 * One row per gateway and failure kind per aggregation window.
 */
export const PAYMENT_LINK_CREATE_FAILED_CODE = 'payments.gateway_link_create_failed';

/** The phase the FIX-04 events name. A closed list, so a group filter can rely on it. */
export const OPS_ERROR_PHASES = ['PAYMENT_LINK_CREATE'] as const;
export type OpsErrorPhase = (typeof OPS_ERROR_PHASES)[number];

/**
 * Why a payment link was not made — every FIX-04 case, as a closed vocabulary the template
 * gives one Persian line each.
 *
 * `retryable` answers "may a LATER attempt succeed with nobody changing anything?": a
 * timeout or a 5xx may, a refused API key will not. It never means "Nexa re-sends this
 * request": a create whose answer was lost is never re-sent (CLAUDE.md, TonPays rules),
 * which is why `UNKNOWN` is not retryable.
 */
export const PAYMENT_LINK_FAILURE_KINDS = {
  NO_LINK: { retryable: false },
  MALFORMED_LINK: { retryable: false },
  NO_CARD: { retryable: false },
  BAD_REQUEST: { retryable: false },
  UNAUTHORIZED: { retryable: false },
  FORBIDDEN: { retryable: false },
  CONFIGURATION: { retryable: false },
  RATE_LIMITED: { retryable: true },
  PROVIDER_ERROR: { retryable: true },
  BAD_RESPONSE: { retryable: true },
  TIMEOUT: { retryable: true },
  UNREACHABLE: { retryable: true },
  UNKNOWN: { retryable: false },
} as const satisfies Record<string, { readonly retryable: boolean }>;
export type PaymentLinkFailureKind = keyof typeof PAYMENT_LINK_FAILURE_KINDS;

/**
 * FINAL: this attempt will not produce a usable link and nothing about it is in doubt.
 * UNKNOWN: the provider may have made an invoice; nothing is re-sent and an operator may
 * have to reconcile it.
 */
export const OPS_FAILURE_CLASSIFICATIONS = ['FINAL', 'UNKNOWN'] as const;
export type OpsFailureClassification = (typeof OPS_FAILURE_CLASSIFICATIONS)[number];

/** The template placeholder that selects each kind's line (`ops.notification.payment_link_failed`). */
export const PAYMENT_LINK_CAUSE_TOKENS = {
  NO_LINK: 'causeNoLink',
  MALFORMED_LINK: 'causeMalformedLink',
  NO_CARD: 'causeNoCard',
  BAD_REQUEST: 'causeBadRequest',
  UNAUTHORIZED: 'causeUnauthorized',
  FORBIDDEN: 'causeForbidden',
  CONFIGURATION: 'causeConfiguration',
  RATE_LIMITED: 'causeRateLimited',
  PROVIDER_ERROR: 'causeProviderError',
  BAD_RESPONSE: 'causeBadResponse',
  TIMEOUT: 'causeTimeout',
  UNREACHABLE: 'causeUnreachable',
  UNKNOWN: 'causeUnknown',
} as const satisfies Record<PaymentLinkFailureKind, string>;

// ---------------------------------------------------------------------------
// FIX-05 — the codes this fix adds
// ---------------------------------------------------------------------------

/** Anti-spam blocked a customer (WP20 §3.5). SECURITY; one row per customer per window. */
export const ANTI_SPAM_CUSTOMER_BLOCKED_CODE = 'antispam.customer_blocked';

/**
 * A worker loop stopped making progress (the heartbeat's `stalledLoops`). One condition per
 * loop, closed by `JOB_LOOP_RECOVERED_CODE` when the loop is fresh again.
 */
export const JOB_LOOP_STALLED_CODE = 'job.loop_stalled';
export const JOB_LOOP_RECOVERED_CODE = 'job.loop_recovered';

/**
 * An API request failed with an unhandled 5xx. The body code of the same name has always
 * been answered to the client; this records it as an operational event too. One row per
 * failure name per window.
 */
export const INTERNAL_UNHANDLED_CODE = 'internal.unhandled';

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * The aggregation window of a `WINDOW` code: an hour. A storm of one failure is one group
 * message an hour with its counter, never one per occurrence — and the row, its counter
 * and the audit evidence beside it are all kept, so nothing is lost by not posting it.
 */
export const OPS_AGGREGATION_WINDOW_MS = 60 * 60_000;

/**
 * The dedupe key of a `WINDOW` code: the subject's key plus the window it falls in. Pure,
 * so two replicas reporting the same failure in the same window collapse onto one row.
 */
export function opsAggregationKey(
  subjectKey: string,
  at: Date,
  windowMs: number = OPS_AGGREGATION_WINDOW_MS,
): string {
  return `${subjectKey}@${String(Math.floor(at.getTime() / windowMs))}`;
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export interface OpsErrorEventDefinition {
  /** The exact code, or — with `prefix: true` — a family of codes built at run time. */
  readonly code: string;
  readonly prefix?: true;
  readonly area: OpsErrorArea;
  readonly kind: OpsErrorKind;
  readonly dedupe: OpsErrorDedupePolicy;
  /**
   * The class to PRESENT, when it differs from the stored severity's own reading
   * (`opsErrorClassOfSeverity`). Every security code names `SECURITY`; the rest are read
   * from the severity their producer records.
   */
  readonly eventClass?: OpsErrorClass;
  readonly presentation?: OpsErrorPresentation;
  /** The failure code a recovery closes. */
  readonly recovers?: string;
}

const failure = (
  code: string,
  area: OpsErrorArea,
  dedupe: OpsErrorDedupePolicy,
  extra: Partial<OpsErrorEventDefinition> = {},
): OpsErrorEventDefinition => ({ code, area, kind: 'FAILURE', dedupe, ...extra });
const recovery = (code: string, area: OpsErrorArea, recovers: string): OpsErrorEventDefinition => ({
  code,
  area,
  kind: 'RECOVERY',
  dedupe: 'PER_OCCURRENCE',
  recovers,
});
const fact = (
  code: string,
  area: OpsErrorArea,
  dedupe: OpsErrorDedupePolicy,
  extra: Partial<OpsErrorEventDefinition> = {},
): OpsErrorEventDefinition => ({ code, area, kind: 'FACT', dedupe, ...extra });

/**
 * Every operational-event code this installation records, classified. The unit test that
 * scans the source for recorded codes is what keeps this complete.
 */
export const OPS_ERROR_EVENTS: readonly OpsErrorEventDefinition[] = [
  // --- Payments: gateways, receipts, FX ---------------------------------------------------
  failure(PAYMENT_LINK_CREATE_FAILED_CODE, 'PAYMENTS', 'WINDOW', {
    presentation: 'PAYMENT_LINK',
  }),
  failure('payments.gateway_create_unknown', 'PAYMENTS', 'PER_SUBJECT', {
    presentation: 'PAYMENT_LINK',
  }),
  failure('payments.gateway_misconfigured', 'PAYMENTS', 'CONDITION'),
  recovery('payments.gateway_configured', 'PAYMENTS', 'payments.gateway_misconfigured'),
  failure('payments.gateway_late_completion', 'PAYMENTS', 'PER_SUBJECT'),
  failure('payments.gateway_identity_mismatch', 'PAYMENTS', 'PER_SUBJECT'),
  failure('payments.gateway_charge_unmatched', 'PAYMENTS', 'PER_SUBJECT'),
  failure('payments.gateway_receipt_unknown', 'PAYMENTS', 'PER_SUBJECT'),
  failure('payments.gateway_card_change_unknown', 'PAYMENTS', 'PER_SUBJECT'),
  failure('payments.gateway_review_unresolved', 'PAYMENTS', 'CONDITION'),
  recovery('payments.gateway_review_reconciled', 'PAYMENTS', 'payments.gateway_review_unresolved'),
  failure('payments.gateway_webhook_unverified', 'PAYMENTS', 'CONDITION', {
    eventClass: 'SECURITY',
  }),
  recovery('payments.gateway_webhook_verified', 'PAYMENTS', 'payments.gateway_webhook_unverified'),
  // FIX-03 (batch 2026-10-10): the provider approved and the settlement transaction refused
  // (nothing moved; asked again inside the deadline). One condition per payment, closed by
  // `payments.gateway_settlement_decided` once the lane decides that payment (settled,
  // already settled, held, failed, or recorded late) — audit P2-b on #260.
  failure('payments.gateway_settlement_failed', 'PAYMENTS', 'CONDITION'),
  recovery('payments.gateway_settlement_decided', 'PAYMENTS', 'payments.gateway_settlement_failed'),
  // FIX-03 (batch 2026-10-10): a gateway's inquiries keep failing (timeouts, 5xx, 429), so
  // approvals cannot be read. One condition per gateway, closed by its next answered inquiry.
  failure('payments.gateway_inquiry_failing', 'PAYMENTS', 'CONDITION'),
  recovery('payments.gateway_inquiry_ok', 'PAYMENTS', 'payments.gateway_inquiry_failing'),
  failure('payments.receipt_push_failed', 'PAYMENTS', 'CONDITION'),
  recovery('payments.receipt_push_ok', 'PAYMENTS', 'payments.receipt_push_failed'),
  failure('payments.refund_request_push_failed', 'PAYMENTS', 'CONDITION'),
  recovery('payments.refund_request_push_ok', 'PAYMENTS', 'payments.refund_request_push_failed'),
  failure('fx.quote_unavailable', 'PAYMENTS', 'CONDITION'),
  failure('fx.quote_rejected', 'PAYMENTS', 'CONDITION'),
  failure('fx.source_unavailable', 'PAYMENTS', 'CONDITION'),
  failure('fx.fallback_in_use', 'PAYMENTS', 'CONDITION'),
  failure('fx.stale_quote_used', 'PAYMENTS', 'CONDITION'),

  // --- Wallet and refunds -----------------------------------------------------------------
  fact('order.refunded_undeliverable', 'WALLET', 'PER_SUBJECT'),

  // --- Delivery: provisioning, panels -----------------------------------------------------
  failure('provisioning.stalled', 'DELIVERY', 'CONDITION'),
  recovery('provisioning.delivered', 'DELIVERY', 'provisioning.stalled'),
  failure('panel.health.', 'PANELS', 'CONDITION', { prefix: true }),
  failure('panel.capacity.full', 'PANELS', 'CONDITION'),
  failure('panel.capacity.warning', 'PANELS', 'CONDITION'),
  recovery('panel.capacity.recovered', 'PANELS', 'panel.capacity.full'),
  failure('panel.monitor.tenant_budget_exceeded', 'PANELS', 'CONDITION'),
  recovery('panel.monitor.tenant_budget_ok', 'PANELS', 'panel.monitor.tenant_budget_exceeded'),
  failure('panel.monitor.scheduler_capacity_exceeded', 'PANELS', 'CONDITION'),
  recovery(
    'panel.monitor.scheduler_capacity_ok',
    'PANELS',
    'panel.monitor.scheduler_capacity_exceeded',
  ),
  failure('panel.probe.limited', 'PANELS', 'CONDITION'),
  recovery('panel.probe.ok', 'PANELS', 'panel.probe.limited'),

  // --- Telegram: sends, edits, webhook, rate limits ---------------------------------------
  failure('telegram.customer_send_failed', 'TELEGRAM', 'CONDITION'),
  recovery('telegram.customer_send_ok', 'TELEGRAM', 'telegram.customer_send_failed'),
  failure('telegram.appearance_decoration_failed', 'TELEGRAM', 'CONDITION'),
  recovery(
    'telegram.appearance_decoration_ok',
    'TELEGRAM',
    'telegram.appearance_decoration_failed',
  ),
  failure('telegram.turn_failed', 'TELEGRAM', 'WINDOW'),
  failure('telegram.ops_group_update_failed', 'TELEGRAM', 'WINDOW'),
  failure('telegram.message_retention_failing', 'TELEGRAM', 'CONDITION'),
  recovery(
    'telegram.message_retention_recovered',
    'TELEGRAM',
    'telegram.message_retention_failing',
  ),
  failure('channels.membership_unavailable', 'TELEGRAM', 'CONDITION'),
  recovery('channels.membership_recovered', 'TELEGRAM', 'channels.membership_unavailable'),
  failure('support.business_update_failed', 'TELEGRAM', 'WINDOW'),
  failure('support.business_connection.unusable', 'TELEGRAM', 'CONDITION'),
  recovery(
    'support.business_connection.usable',
    'TELEGRAM',
    'support.business_connection.unusable',
  ),
  failure('support.handoff_required', 'TELEGRAM', 'CONDITION'),
  recovery('support.handoff_resolved', 'TELEGRAM', 'support.handoff_required'),

  // --- Users: abuse and blocks ------------------------------------------------------------
  failure(ANTI_SPAM_CUSTOMER_BLOCKED_CODE, 'USERS', 'WINDOW', { eventClass: 'SECURITY' }),
  failure('antispam.unavailable', 'USERS', 'CONDITION', { eventClass: 'SECURITY' }),
  recovery('antispam.recovered', 'USERS', 'antispam.unavailable'),

  // --- Bot setup: token, registration, menus ----------------------------------------------
  failure('bot.token_replacement_incomplete', 'BOT_SETUP', 'CONDITION'),
  recovery('bot.token_replacement_completed', 'BOT_SETUP', 'bot.token_replacement_incomplete'),
  failure('bot.command_sync_failing', 'BOT_SETUP', 'CONDITION'),
  recovery('bot.command_sync_recovered', 'BOT_SETUP', 'bot.command_sync_failing'),
  failure('bot_menu.published_unreadable', 'BOT_SETUP', 'CONDITION'),
  recovery('bot_menu.published_readable', 'BOT_SETUP', 'bot_menu.published_unreadable'),
  failure('settings.stored_value_invalid', 'SYSTEM', 'CONDITION'),
  recovery('settings.stored_value_valid', 'SYSTEM', 'settings.stored_value_invalid'),

  // --- Security: denials, lock-outs, administrator changes --------------------------------
  failure('access.permission_denied', 'SECURITY', 'PER_OCCURRENCE', { eventClass: 'SECURITY' }),
  failure('auth.login_locked_out', 'SECURITY', 'PER_SUBJECT', { eventClass: 'SECURITY' }),
  fact('admin.', 'SECURITY', 'PER_OCCURRENCE', { prefix: true, eventClass: 'SECURITY' }),

  // --- Notifications and the outbox -------------------------------------------------------
  failure('outbox.message_exhausted', 'NOTIFICATIONS', 'PER_SUBJECT'),
  fact('notification.sweep_withdrawn', 'NOTIFICATIONS', 'PER_SUBJECT'),
  fact('ops_group.topic_recreated', 'NOTIFICATIONS', 'PER_OCCURRENCE'),

  // --- Jobs and the worker ----------------------------------------------------------------
  failure(JOB_LOOP_STALLED_CODE, 'JOBS', 'CONDITION'),
  recovery(JOB_LOOP_RECOVERED_CODE, 'JOBS', JOB_LOOP_STALLED_CODE),
  failure(INTERNAL_UNHANDLED_CODE, 'SYSTEM', 'WINDOW'),

  // --- Backups and recovery ---------------------------------------------------------------
  failure('backup.run_failed', 'BACKUPS', 'CONDITION'),
  recovery('backup.run_ok', 'BACKUPS', 'backup.run_failed'),
  failure('backup.delivery_failed', 'BACKUPS', 'CONDITION'),
  recovery('backup.delivery_ok', 'BACKUPS', 'backup.delivery_failed'),
  failure('backup.cleanup_failed', 'BACKUPS', 'CONDITION'),
  recovery('backup.cleanup_ok', 'BACKUPS', 'backup.cleanup_failed'),
  failure('backup.disk_threshold_exceeded', 'BACKUPS', 'CONDITION'),
  recovery('backup.disk_threshold_ok', 'BACKUPS', 'backup.disk_threshold_exceeded'),
  failure('backup.interval_exceeded', 'BACKUPS', 'CONDITION'),
  recovery('backup.interval_ok', 'BACKUPS', 'backup.interval_exceeded'),
  failure('recovery.run_failed', 'BACKUPS', 'CONDITION'),
  recovery('recovery.run_ok', 'BACKUPS', 'recovery.run_failed'),

  // --- Incidents and the platform -------------------------------------------------
  fact('incident.', 'SYSTEM', 'CONDITION', { prefix: true }),
  fact('maintenance.', 'SYSTEM', 'CONDITION', { prefix: true }),
  fact('system.ping', 'SYSTEM', 'PER_OCCURRENCE'),
];

/** The entry for a code: its exact entry first, then the longest family prefix. */
export function opsErrorEventFor(code: string): OpsErrorEventDefinition | null {
  let best: OpsErrorEventDefinition | null = null;
  for (const entry of OPS_ERROR_EVENTS) {
    if (entry.prefix === undefined) {
      if (entry.code === code) return entry;
    } else if (
      code.startsWith(entry.code) &&
      (best === null || entry.code.length > best.code.length)
    ) {
      best = entry;
    }
  }
  return best;
}

/** The class an event is PRESENTED as: its code's own class, else its severity's. */
export function opsErrorClassOf(code: string, severity: OperationalSeverity): OpsErrorClass {
  return opsErrorEventFor(code)?.eventClass ?? opsErrorClassOfSeverity(severity);
}

/** How an event is presented in the group. Unknown codes are `GENERIC`, never refused. */
export function opsErrorPresentationOf(code: string): OpsErrorPresentation {
  return opsErrorEventFor(code)?.presentation ?? 'GENERIC';
}
