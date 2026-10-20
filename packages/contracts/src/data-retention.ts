/**
 * Data retention jobs (Round 4 PR-E, E3).
 *
 * Two tables grew without a policy on the first real import (198k customers): the
 * transactional outbox (270k PUBLISHED import events, 190 MB) and the idempotency store
 * (211k keys, 108 MB). Each now has a bounded, configurable retention, read on the
 * installation tenant by the worker. What is NEVER removed is part of the rule, stated
 * here so the settings cannot be read as more than they are:
 *
 * - the OUTBOX keeps every message that is not yet published — pending, failing or
 *   exhausted — whatever its age: an unpublished message is work, not history.
 *   `processed_messages` is not touched: it is the consumers' dedupe ledger, and a
 *   published message is never offered again, so its row there is inert, not stale.
 * - the IDEMPOTENCY store removes only keys in the two INTERACTIVE namespaces — `WEB`
 *   (one key per form submission) and `TELEGRAM` (one per update, which Telegram
 *   redelivers for a day at most). Keys in `WORKER`, `SCHEDULER` and `API` are derived
 *   deterministically (`legacy-import:…`, `service-refund:<id>`…) and ARE the re-run
 *   safety of the importer and the money jobs, so they are kept for ever.
 * - audit logs are never deleted by any job.
 */
export const DATA_RETENTION_SETTING_KEYS = {
  outboxPublishedDays: 'retention.outbox_published_days',
  idempotencyInteractiveDays: 'retention.idempotency_interactive_days',
} as const;

export const OUTBOX_PUBLISHED_RETENTION_DAYS_DEFAULT = 7;
export const OUTBOX_PUBLISHED_RETENTION_DAYS_MIN = 1;
export const OUTBOX_PUBLISHED_RETENTION_DAYS_MAX = 3650;

export const IDEMPOTENCY_INTERACTIVE_RETENTION_DAYS_DEFAULT = 30;
/** A week: far beyond any retry a browser or Telegram makes of one submission. */
export const IDEMPOTENCY_INTERACTIVE_RETENTION_DAYS_MIN = 7;
export const IDEMPOTENCY_INTERACTIVE_RETENTION_DAYS_MAX = 3650;

/** The namespaces whose keys expire. Every other namespace's keys are kept for ever. */
export const IDEMPOTENCY_EXPIRING_NAMESPACES = ['WEB', 'TELEGRAM'] as const;
