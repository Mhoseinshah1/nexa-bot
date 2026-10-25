import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_NOTIFICATION_KINDS,
  DATA_COMPACTION_CLASS_TABLES,
  DATA_COMPACTION_CLASSES,
} from '@nexa/contracts';
import {
  assertCompactable,
  COMPACTION_ALLOW_LIST,
  COMPACTION_PROTECTED_TABLES,
  CUSTOMER_NOTIFICATION_COMPACTABLE_STATES,
  CUSTOMER_NOTIFICATION_COMPACTION,
} from '../../apps/api/src/modules/platform/data-compaction/application/allow-list';

/**
 * Round 9 C3: the data compaction may delete from an explicit allow-list and from nothing
 * else. This file holds that rule against BOTH the lists and the SQL.
 *
 * The protected set below is this TEST's own, not imported from the module: a change that
 * weakens the module's `COMPACTION_PROTECTED_TABLES` must still fail here. Adding any of these
 * to a class, or a `DELETE FROM` of any table outside `deleteRows`, turns this file red.
 */

/** Never a compaction target: money, reconciliation, history, dedupe, backup, legacy money. */
const NEVER: readonly string[] = [
  'wallet_entries',
  'payments',
  'orders',
  'services',
  'refunds',
  'payment_receipts',
  'receipt_credits',
  'audit_logs',
  'processed_messages',
  'outbox_messages',
  'request_idempotency',
  'gateway_invoices',
  'gateway_receipt_submissions',
  'gateway_provider_requests',
  'gateway_invoice_provider_facts',
  'gateway_card_changes',
  'provisioning_operations',
  'operational_events',
  'backup_runs',
  'backup_run_parts',
  'recovery_requests',
  'broadcast_recipients',
  'bulk_operation_items',
  'service_reminders',
  'wallet_threshold_alerts',
  'reseller_minimum_notices',
];
/** Whole families that are money or the legacy money history. */
const NEVER_PREFIXES = [
  'legacy_',
  'wallet_',
  'order_',
  'payment',
  'refund',
  'cashback',
  'referral',
  'reseller',
];

const repositorySource = readFileSync(
  join(
    __dirname,
    '../../apps/api/src/modules/platform/data-compaction/infrastructure/drizzle-data-compaction.repository.ts',
  ),
  'utf8',
);

const classTables = DATA_COMPACTION_CLASSES.flatMap((cls) => [
  ...DATA_COMPACTION_CLASS_TABLES[cls],
]);

describe('data compaction allow-list (Round 9 C3)', () => {
  it('every table a class names is allow-listed, with its reason, and nothing else is', () => {
    expect(new Set(Object.keys(COMPACTION_ALLOW_LIST))).toEqual(new Set(classTables));
    for (const table of classTables) {
      const entry = COMPACTION_ALLOW_LIST[table];
      expect(entry.reason.length, table).toBeGreaterThan(40);
      expect(entry.removes.length, table).toBeGreaterThan(20);
      expect(DATA_COMPACTION_CLASS_TABLES[entry.class]).toContain(table);
    }
  });

  it('no class targets a protected table, by name or by family', () => {
    for (const table of classTables) {
      expect(NEVER, `${table} is protected`).not.toContain(table);
      for (const prefix of NEVER_PREFIXES) {
        expect(table.startsWith(prefix), `${table} is in the protected ${prefix}* family`).toBe(
          false,
        );
      }
      expect(Object.keys(COMPACTION_PROTECTED_TABLES)).not.toContain(table);
    }
  });

  it('every protected table is written down with its reason in the module', () => {
    for (const table of NEVER) {
      expect(COMPACTION_PROTECTED_TABLES[table], table).toBeTypeOf('string');
    }
  });

  it('the delete gate refuses every protected table and anything unlisted', () => {
    for (const table of [...NEVER, 'legacy_history_records', 'customers', 'tenants']) {
      expect(() => assertCompactable(table), table).toThrow(/data compaction refused/);
    }
    for (const table of classTables) expect(() => assertCompactable(table)).not.toThrow();
  });

  it('the repository has ONE DELETE, behind the gate, and updates only its own run rows', () => {
    const deletes = [...repositorySource.matchAll(/DELETE\s+FROM\s+(\S+)/g)].map((m) => m[1]);
    expect(deletes).toEqual(['${sql.identifier(table)}']);
    const helper = /private async deleteRows\([^)]*\)[^{]*\{([\s\S]*?)\n {2}\}/.exec(
      repositorySource,
    );
    expect(helper?.[1]).toContain('assertCompactable(table);');
    const updates = [...repositorySource.matchAll(/UPDATE\s+([a-z_]+)/g)].map((m) => m[1]);
    expect(new Set(updates)).toEqual(new Set(['data_compaction_runs']));
    expect(repositorySource).not.toMatch(/TRUNCATE|DROP\s+TABLE/i);
  });

  it('decides every customer notification kind, and never compacts a money, ticket or message kind', () => {
    expect(new Set(Object.keys(CUSTOMER_NOTIFICATION_COMPACTION))).toEqual(
      new Set(CUSTOMER_NOTIFICATION_KINDS),
    );
    const neverKinds =
      /^(PAYMENT_|ORDER_|REFUND_|RECEIPT_|GATEWAY_|TRIAL_|WALLET_(TOPUP|ADMIN|MASS)|SERVICE_REFUND_|TICKET_|DIRECT_MESSAGE|SERVICE_PROVISION_DELAYED|SERVICE_TRANSFER_|SERVICE_GIFT_|INCIDENT_)/;
    for (const kind of CUSTOMER_NOTIFICATION_KINDS) {
      const decision = CUSTOMER_NOTIFICATION_COMPACTION[kind];
      expect(decision.reason.length, kind).toBeGreaterThan(10);
      if (neverKinds.test(kind)) expect(decision.compact, kind).toBe('NEVER');
    }
    // The operation-subject kinds are compacted only behind announced_at.
    for (const kind of [
      'SERVICE_ACTION_SUCCEEDED',
      'SERVICE_ACTION_FAILED',
      'SERVICE_RENEWED',
      'SERVICE_TRAFFIC_ADDED',
      'SERVICE_TIME_ADDED',
    ] as const) {
      expect(CUSTOMER_NOTIFICATION_COMPACTION[kind].compact, kind).toBe('ANNOUNCED');
    }
  });

  it('never compacts a PENDING or UNCONFIRMED customer notification', () => {
    expect(CUSTOMER_NOTIFICATION_COMPACTABLE_STATES).not.toContain('PENDING');
    expect(CUSTOMER_NOTIFICATION_COMPACTABLE_STATES).not.toContain('UNCONFIRMED');
  });
});
