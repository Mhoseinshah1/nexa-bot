import {
  LEGACY_COMPACTION_ARCHIVE_TWINS,
  LEGACY_COMPACTION_DROP_ARCHIVE_TABLES,
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
  support_message: ['legacy-materialize/application/ticket-history.step.ts'],
  ticket: [
    'legacy-history/infrastructure/drizzle-legacy-history.repository.ts',
    'legacy-materialize/application/ticket-history.step.ts',
  ],
  ticket_message: [
    'legacy-history/infrastructure/drizzle-legacy-history.repository.ts',
    'legacy-materialize/application/ticket-history.step.ts',
  ],
  // Read by no type-selecting code. `archive_row` is KEPT anyway; only a row with a TWIN for
  // the same source key is deduped: an invoice in `legacy_invoice_archive`, or (PR-L) a typed
  // record of `LEGACY_COMPACTION_ARCHIVE_TWINS` (`compactionArchiveTwins`). The raw copies of
  // a dropped type's table (`wheel_list`) are dropped with it.
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
  // PR-L, owner decision: Nexa has no lucky wheel. The money-history reader, the money
  // reconciliation and the wallet-history materialize step no longer read it; dropped.
  wheel_result: [],
};

/** The types a compaction deletes. Never one with a reader. */
export function compactionDropTypes(): readonly LegacyHistoryRecordType[] {
  return LEGACY_COMPACTION_DROP_TYPES.filter(
    (type) => (LEGACY_COMPACTION_READ_MAP[type] ?? ['unknown']).length === 0,
  );
}

/**
 * PR-L: the archive-row twins DEDUPING deletes by — each a raw Mirza table and the typed
 * record type whose record of the same source key makes its archive copy redundant.
 */
export function compactionArchiveTwins(): readonly {
  readonly sourceTable: string;
  readonly recordType: LegacyHistoryRecordType;
}[] {
  return LEGACY_COMPACTION_ARCHIVE_TWINS;
}

/** PR-L: Mirza tables whose raw archive rows DROPPING deletes: their typed type is dropped. */
export function compactionDropArchiveTables(): readonly string[] {
  const dropped = new Set<string>(compactionDropTypes());
  return LEGACY_COMPACTION_DROP_ARCHIVE_TABLES.filter((table) =>
    LEGACY_COMPACTION_ARCHIVE_TWINS.some(
      (pair) => pair.sourceTable === table && dropped.has(pair.recordType),
    ),
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
