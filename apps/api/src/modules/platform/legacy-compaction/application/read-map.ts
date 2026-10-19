import {
  LEGACY_COMPACTION_DROP_TYPES,
  LEGACY_HISTORY_RECORD_TYPES,
  type LegacyHistoryRecordType,
} from '@nexa/contracts';

/**
 * THE READ MAP (Round 4 PR-E, E1): which code reads which `legacy_history_records` type.
 *
 * Built by searching the source for every type by name, then reading each hit. A type is
 * READ when a page, a bot flow, a reconciliation, a re-runnable materialize step or the
 * service history selects it BY TYPE. The tenant-wide «سوابق و تنظیمات ربات قبلی» browser
 * and the customer's history card list whatever rows exist; they are a viewer of the
 * archive, not a reader of a type, and the «آرشیو ربات قبلی» backup taken first keeps every
 * row restorable.
 *
 * `tests/unit/legacy-compaction-read-map.test.ts` holds this to the source: a dropped type
 * named in any reader file fails it, and every read type must name at least one real file.
 */
export const LEGACY_COMPACTION_READ_MAP: Readonly<
  Record<LegacyHistoryRecordType, readonly string[]>
> = {
  payment: [
    'legacy-history/infrastructure/drizzle-legacy-money-history.reader.ts',
    'legacy-materialize/application/payment-history.step.ts',
  ],
  wallet_transaction: [
    'legacy-history/infrastructure/drizzle-legacy-money-history.reader.ts',
    'legacy-materialize/application/wallet-history.step.ts',
  ],
  wallet_history_check: [
    'legacy-history/infrastructure/drizzle-legacy-money-history.reader.ts',
    'legacy-history/application/money-reconciliation.ts',
  ],
  wallet_difference: ['legacy-history/infrastructure/drizzle-legacy-money-history.reader.ts'],
  service_operation: [
    'legacy-history/infrastructure/drizzle-legacy-money-history.reader.ts',
    'legacy-history/infrastructure/drizzle-legacy-records.repository.ts',
  ],
  service_cancellation_request: [
    'legacy-history/infrastructure/drizzle-legacy-records.repository.ts',
  ],
  service_ownership: ['legacy-history/infrastructure/drizzle-legacy-records.repository.ts'],
  panel_registry: ['legacy-history/infrastructure/drizzle-legacy-records.repository.ts'],
  category_catalogue: ['legacy-materialize/application/products-step.ts'],
  product_mapping_proposal: ['legacy-materialize/application/products-step.ts'],
  agent_profile: ['legacy-materialize/application/resellers-step.ts'],
  agent_price_level: ['legacy-materialize/application/resellers-step.ts'],
  agent_state: ['legacy-materialize/application/resellers-step.ts'],
  discount: [
    'legacy-materialize/infrastructure/drizzle-discount-usage-history.repository.ts',
    'legacy-materialize/application/discounts-step.ts',
  ],
  discount_usage: [
    'legacy-history/infrastructure/drizzle-legacy-money-history.reader.ts',
    'legacy-materialize/application/discount-usage-history.step.ts',
  ],
  referral: [
    'legacy-history/infrastructure/drizzle-legacy-money-history.reader.ts',
    'legacy-materialize/application/referral-history.step.ts',
  ],
  wheel_result: [
    'legacy-history/infrastructure/drizzle-legacy-money-history.reader.ts',
    'legacy-materialize/application/wallet-history.step.ts',
  ],
  support_message: ['legacy-materialize/application/ticket-history.step.ts'],
  ticket: [
    'legacy-history/infrastructure/drizzle-legacy-history.repository.ts',
    'legacy-materialize/application/ticket-history.step.ts',
  ],
  ticket_message: [
    'legacy-history/infrastructure/drizzle-legacy-history.repository.ts',
    'legacy-materialize/application/ticket-history.step.ts',
  ],
  // Read by no type-selecting code. `archive_row` is KEPT anyway: only its invoice-table
  // rows are duplicated elsewhere (`legacy_invoice_archive`), and only those are deduped.
  archive_row: [],
  // Read by nothing; dropped (`LEGACY_COMPACTION_DROP_TYPES`).
  manual_config_inventory: [],
  panel_target: [],
  panel_mapping_template: [],
  agent_invoice: [],
  agent_log: [],
  agent_usage: [],
  agent_request: [],
  ad_campaign: [],
  program_setting: [],
  support_department: [],
  configuration_row: [],
};

/** The types a compaction deletes. Never one with a reader. */
export function compactionDropTypes(): readonly LegacyHistoryRecordType[] {
  return LEGACY_COMPACTION_DROP_TYPES.filter(
    (type) => (LEGACY_COMPACTION_READ_MAP[type] ?? ['unknown']).length === 0,
  );
}

/** Every type the compaction keeps (and only strips). */
export function compactionKeptTypes(): readonly LegacyHistoryRecordType[] {
  const dropped = new Set<string>(compactionDropTypes());
  return LEGACY_HISTORY_RECORD_TYPES.filter((type) => !dropped.has(type));
}

/**
 * The top-level keys stripped from KEPT payloads: the live-state flags, every one `false`
 * on a stored record (a `true` was refused at ingest) — `record-map.ts`'s list. Nothing
 * else: `schema`, `provenance`, `idempotency_key` (`summaryOf`, the reseller step),
 * `*_raw` and `*_note` (`fields_raw`, `owner_value_raw`, `parse_note` are read by the
 * materialize steps and the redaction allowlists) all stay.
 */
export { ALL_LIVE_FLAGS as COMPACTION_STRIP_KEYS } from '../../legacy-history/application/record-map.js';
