import {
  DATA_COMPACTION_CLASS_TABLES,
  type CustomerNotificationKind,
  type CustomerNotificationState,
  type DataCompactionClass,
  type DataCompactionTable,
} from '@nexa/contracts';

/**
 * What the data compaction may delete, and what it may never touch (Round 9 C3).
 *
 * THE RULE: a row is removed only when its table is on `COMPACTION_ALLOW_LIST` below, under the
 * predicate written there, and its table is NOT on `COMPACTION_PROTECTED_TABLES`. The
 * repository deletes through `assertCompactable`, so a table outside the allow-list cannot be
 * deleted from by accident, and `tests/unit/data-compaction-allow-list.test.ts` reads the
 * repository's source and fails the moment a protected table is targeted or named here.
 *
 * Every allow-listed table was checked for its READERS (who reads a row once its life is over)
 * and its DEDUPE role (what stops a producer making the same thing again once the row is gone).
 * A table where either answer was "something money, history or dedupe relies on" is protected.
 */

export interface AllowListEntry {
  readonly class: DataCompactionClass;
  /** The predicate, in words; the SQL that implements it is the repository's, once. */
  readonly removes: string;
  /** Why removing it changes nothing anyone relies on. */
  readonly reason: string;
}

export const COMPACTION_ALLOW_LIST: Readonly<Record<DataCompactionTable, AllowListEntry>> = {
  notifications: {
    class: 'OPS_NOTIFICATIONS',
    removes:
      'an operations-lane intent whose status is SENT or FAILED and whose completed_at is older ' +
      'than retention.ops_notifications_days; never a PENDING one.',
    reason:
      'A finished intent is never claimed again (the dispatcher claims PENDING rows only). Its ' +
      'dedupe key cannot recur after 30 days: every producer derives it from a monotonic ' +
      'occurrence (`opslog:<event>:<n>`), an outbox event id (published events are never ' +
      'offered again and the outbox keeps them 7 days), a once-only row (`oplog:op:<operation>` ' +
      'behind announced_at), a time bucket (`storm:`, `report:` — the nightly report looks back ' +
      'two days) or a fresh id. Nothing about money reads this lane.',
  },
  notification_delivery_attempts: {
    class: 'OPS_NOTIFICATIONS',
    removes: 'every attempt of a notification removed in the same batch transaction.',
    reason:
      'The wire record of a finished intent. Removed WITH its intent, never alone, so the ' +
      "dispatcher's invariant (a terminal intent has at least one attempt row) holds for every " +
      'intent that remains. Migration 0279 lets a DELETE through only inside an APPLY pass and ' +
      'only for a notification that is not PENDING.',
  },
  notification_released_claims: {
    class: 'OPS_NOTIFICATIONS',
    removes: 'every released claim of a notification removed in the same batch transaction.',
    reason:
      'Spend accounting (`attempt_count` minus releases) matters only while an intent can still ' +
      'be claimed; a finished intent cannot. Removed with its intent, under the same 0279 guard.',
  },
  customer_notifications: {
    class: 'CUSTOMER_NOTIFICATIONS',
    removes:
      'a row in DELIVERED, FAILED or SUPERSEDED whose resolved_at is older than ' +
      'retention.customer_notifications_days AND whose kind is RESOLVED in ' +
      '`CUSTOMER_NOTIFICATION_COMPACTION` — or ANNOUNCED there with its operation already ' +
      'stamped announced_at. Never PENDING, never UNCONFIRMED (the customer MAY hold it, and a ' +
      'person may still need the row to decide).',
    reason:
      "`customer_notifications_subject_key` is the lane's told-once guarantee, so a row may go " +
      'only where the guarantee no longer depends on it: the kinds whose producer writes a NEW ' +
      'subject row (a fresh id) for every occurrence and notifies only when that write inserted, ' +
      'and the announcer kinds whose operation carries announced_at (the stamp, committed with ' +
      'the enqueue, is what stops a second announcement). Every kind a payment timeline, a ' +
      'ticket, a direct message, a bulk operation or a money fact reads is protected.',
  },
  receipt_captures: {
    class: 'RECEIPT_WINDOWS',
    removes:
      'a manual-transfer receipt window whose closed_at is older than ' +
      'retention.receipt_windows_days; never an open window.',
    reason:
      'Only an OPEN window is ever read (`findOpen`, the open-window index, the expiry ' +
      'exemption). A closed one is scratch: the receipt it admitted is a `payment_receipts` ' +
      'row, which is protected and does not reference the window.',
  },
  gateway_receipt_captures: {
    class: 'RECEIPT_WINDOWS',
    removes:
      'a provider receipt window whose closed_at is older than retention.receipt_windows_days ' +
      'AND that no `gateway_receipt_submissions` row names; never an open window.',
    reason:
      'Only an open window is read. A window that admitted a receipt is kept, because the ' +
      'submission (protected: the receipt sent to the provider) references it.',
  },
};

/**
 * Tables the compaction NEVER targets, with the reason. Not exhaustive of the schema — every
 * table not on the allow-list is out of reach — but every table someone might reasonably think
 * of compacting is named here, so the decision is written down and a test holds it.
 */
export const COMPACTION_PROTECTED_TABLES: Readonly<Record<string, string>> = {
  wallet_entries: 'The ledger. Balance is derived from it; append-only by trigger.',
  payments: 'Money. Reconciliation, the payment timeline and the ledger all read it.',
  orders: 'Money and the two terminal outcomes; read by reports and reconciliation.',
  services: 'What a customer owns.',
  refunds: 'Money returned; the one credit path reads what is already committed.',
  payment_receipts: 'Receipts are evidence of money that moved.',
  receipt_credits: 'A reviewer credit to the wallet; money.',
  gateway_invoices:
    'Holds `last_webhook_delivery_id` and the inquiry/webhook dedupe of a settlement inside ' +
    'its window; the only record of what a provider was asked and answered.',
  gateway_receipt_submissions: 'A receipt sent to a provider; UNKNOWN uploads are never resent.',
  gateway_provider_requests: 'A cancel or refund asked of a provider; UNKNOWN is never resent.',
  gateway_invoice_provider_facts: 'The latest provider facts a customer is shown; latest state.',
  gateway_card_changes: 'A card change asked of a provider; UNKNOWN is never resent.',
  provisioning_operations: 'announced_at and the UNKNOWN outcomes live here; refunds read it.',
  audit_logs: 'Audit is never deleted by any job; append-only by trigger.',
  processed_messages:
    "The consumers' dedupe ledger: what stops a redelivered outbox message duplicating its " +
    'effect (docs/project-status.md, Backup).',
  outbox_messages: 'Owned by the E3 retention job (published history only); not this job.',
  request_idempotency:
    'Owned by the E3 retention job (interactive keys only); WORKER/SCHEDULER/API keys are the ' +
    're-run safety of the importer and the money jobs and are kept for ever.',
  operational_events: 'Dedupes and recovers by code; append-only identity.',
  broadcast_recipients:
    'A broadcast report and its recipients page are counted from these rows, and a pinned ' +
    "message's id is kept here for the pin.",
  bulk_operation_items:
    'A bulk operation report is counted from these rows; mass credits move money.',
  service_reminders: 'The subject of reminder notices; a period key stops a second reminder.',
  wallet_threshold_alerts: 'One row per crossing: what stops a second low-balance alert.',
  reseller_minimum_notices: 'One row per month: what stops a second minimum notice.',
  backup_runs: 'A backup run; an in-flight run holds the installation lock.',
  backup_run_parts: 'The delivered parts of a backup; a restore reads them.',
  recovery_requests: 'A recovery; a CUTOVER row is the only record of the displaced database.',
  legacy_history_records: 'The legacy money history; compacted only by the legacy compaction.',
  legacy_invoice_archive: 'Every legacy invoice reader reads it.',
  legacy_import_map: "The importer's identity map; a re-run reads it.",
};

/** How a customer notification kind may be compacted once resolved. */
export type CustomerNotificationCompaction =
  | {
      /** Removable once resolved: its producer writes a fresh subject row per occurrence. */
      readonly compact: 'RESOLVED';
      readonly reason: string;
    }
  | {
      /** Removable once resolved AND its operation (the subject) is stamped announced_at. */
      readonly compact: 'ANNOUNCED';
      readonly reason: string;
    }
  | { readonly compact: 'NEVER'; readonly reason: string };

const REMINDER: CustomerNotificationCompaction = {
  compact: 'RESOLVED',
  reason:
    'Subject is a `service_reminders` row, inserted with a fresh id per (service, kind, period); ' +
    'the reminder sweep notifies only when that insert wrote a row, so a removed notice is never ' +
    'raised again. Superseding touches PENDING rows only.',
};
const ANNOUNCED: CustomerNotificationCompaction = {
  compact: 'ANNOUNCED',
  reason:
    "Subject is the provisioning operation; the announcer stamps announced_at in the enqueue's " +
    'own transaction and never announces a stamped operation, so once stamped the row is not ' +
    'what stops a second message.',
};
const PAYMENT_TIMELINE: CustomerNotificationCompaction = {
  compact: 'NEVER',
  reason: 'A money fact the payment timeline shows (what the customer was told about it).',
};
const MONEY: CustomerNotificationCompaction = {
  compact: 'NEVER',
  reason: 'A money fact (an order, a refund or a wallet entry); kept with the money history.',
};

/**
 * TOTAL over the kinds: a kind added to the lane without a decision here is a compile error, so
 * no new kind becomes compactable by default.
 */
export const CUSTOMER_NOTIFICATION_COMPACTION: Readonly<
  Record<CustomerNotificationKind, CustomerNotificationCompaction>
> = {
  PAYMENT_REJECTED: PAYMENT_TIMELINE,
  PAYMENT_EXPIRED: PAYMENT_TIMELINE,
  PAYMENT_TRANSFER_RECORDED: PAYMENT_TIMELINE,
  WALLET_TOPUP_CREDITED: PAYMENT_TIMELINE,
  RECEIPT_CREDITED_TO_WALLET: PAYMENT_TIMELINE,
  WALLET_TOPUP_GIFT_CREDITED: PAYMENT_TIMELINE,
  GATEWAY_PAYMENT_FAILED: PAYMENT_TIMELINE,
  GATEWAY_LATE_PAYMENT_CREDITED: PAYMENT_TIMELINE,
  ORDER_EXPIRED: MONEY,
  ORDER_CANCELLED: MONEY,
  ORDER_REFUNDED_TO_WALLET: MONEY,
  TRIAL_NOT_DELIVERED: MONEY,
  REFUND_COMPLETED: MONEY,
  WALLET_ADMIN_CREDITED: MONEY,
  WALLET_ADMIN_DEBITED: MONEY,
  WALLET_MASS_CREDITED: {
    compact: 'NEVER',
    reason: 'A mass credit (money); the bulk operation report joins these rows.',
  },
  SERVICE_GIFT_APPLIED: {
    compact: 'NEVER',
    reason: 'The bulk operation report joins these rows to count who was told.',
  },
  PAYMENT_PENDING_REMINDER: {
    compact: 'NEVER',
    reason:
      'Its sweep dedupes by NOT EXISTS over this table, not by a subject row of its own; a ' +
      'payment kept pending by a receipt under review could be reminded again.',
  },
  ORDER_PENDING_REMINDER: {
    compact: 'NEVER',
    reason: 'Its sweep dedupes by NOT EXISTS over this table (see PAYMENT_PENDING_REMINDER).',
  },
  SERVICE_PROVISION_DELAYED: {
    compact: 'NEVER',
    reason:
      'Subject is the SERVICE, told once per service for ever; removing it would let a later ' +
      'abandoned operation of the same service send a second delay notice.',
  },
  SERVICE_REFUND_REQUEST_REGISTERED: MONEY,
  SERVICE_REFUND_REQUEST_APPROVED: MONEY,
  SERVICE_REFUND_REQUEST_REJECTED: MONEY,
  SERVICE_TRANSFER_RECEIVED: {
    compact: 'NEVER',
    reason: 'Service ownership history.',
  },
  TICKET_REPLY: {
    compact: 'NEVER',
    reason: "A ticket's history shows each reply's delivery state from this row.",
  },
  TICKET_REPLY_ATTACHMENT: {
    compact: 'NEVER',
    reason: "A ticket's history shows each file's delivery state from this row.",
  },
  DIRECT_MESSAGE: {
    compact: 'NEVER',
    reason: 'Customer 360 shows each direct message with its delivery state from this row.',
  },
  DIRECT_MESSAGE_MEDIA: {
    compact: 'NEVER',
    reason: 'Customer 360 shows each direct message with its delivery state from this row.',
  },
  INCIDENT_NOTICE: {
    compact: 'NEVER',
    reason: 'An incident communication is an operator decision with a counted audience; kept.',
  },
  ACCOUNT_UNBLOCKED: {
    compact: 'NEVER',
    reason: 'Rare and tied to a block decision; kept rather than reasoned about for no gain.',
  },
  SERVICE_EXPIRY_FIRST: REMINDER,
  SERVICE_EXPIRY_SECOND: REMINDER,
  SERVICE_EXPIRED: REMINDER,
  SERVICE_USAGE_FIRST: REMINDER,
  SERVICE_USAGE_SECOND: REMINDER,
  SERVICE_USAGE_FINAL: REMINDER,
  SERVICE_EXPIRY_EARLY: REMINDER,
  SERVICE_EXPIRY_DAY: REMINDER,
  WALLET_LOW_BALANCE: {
    compact: 'RESOLVED',
    reason:
      'Subject is a `wallet_threshold_alerts` row, one per crossing with a fresh id; the sweep ' +
      'notifies only when that insert wrote a row.',
  },
  RESELLER_MINIMUM_REMINDER: {
    compact: 'RESOLVED',
    reason:
      'Subject is a `reseller_minimum_notices` row, one per (reseller, kind, month) with a fresh ' +
      'id; the sweep notifies only when that insert wrote a row.',
  },
  RESELLER_MINIMUM_ACHIEVED: {
    compact: 'RESOLVED',
    reason: 'As RESELLER_MINIMUM_REMINDER.',
  },
  SERVICE_ACTION_SUCCEEDED: ANNOUNCED,
  SERVICE_ACTION_FAILED: ANNOUNCED,
  SERVICE_RENEWED: ANNOUNCED,
  SERVICE_TRAFFIC_ADDED: ANNOUNCED,
  SERVICE_TIME_ADDED: ANNOUNCED,
};

/** The resolved states a row may be removed in. PENDING and UNCONFIRMED never. */
export const CUSTOMER_NOTIFICATION_COMPACTABLE_STATES: readonly CustomerNotificationState[] = [
  'DELIVERED',
  'FAILED',
  'SUPERSEDED',
];

export function customerKindsCompacted(mode: 'RESOLVED' | 'ANNOUNCED'): CustomerNotificationKind[] {
  return (Object.keys(CUSTOMER_NOTIFICATION_COMPACTION) as CustomerNotificationKind[])
    .filter((kind) => CUSTOMER_NOTIFICATION_COMPACTION[kind].compact === mode)
    .sort();
}

/** Every table a class names, from the contract; each must be allow-listed. */
export function classTables(cls: DataCompactionClass): readonly DataCompactionTable[] {
  return DATA_COMPACTION_CLASS_TABLES[cls];
}

/**
 * The gate every DELETE passes: the table is on the allow-list and NOT protected. Thrown, not
 * returned: a caller that ignores a boolean would still delete.
 */
export function assertCompactable(table: string): asserts table is DataCompactionTable {
  if (Object.prototype.hasOwnProperty.call(COMPACTION_PROTECTED_TABLES, table)) {
    throw new Error(`data compaction refused: ${table} is a protected table`);
  }
  if (!Object.prototype.hasOwnProperty.call(COMPACTION_ALLOW_LIST, table)) {
    throw new Error(`data compaction refused: ${table} is not on the allow-list`);
  }
}
