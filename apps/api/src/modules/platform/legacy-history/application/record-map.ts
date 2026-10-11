import {
  LEGACY_HISTORY_IDEMPOTENCY_PREFIX,
  type LegacyHistoryRecordType,
  type LegacyNxpkgErrorCode,
} from '@nexa/contracts';

/**
 * Mirza `.nxpkg` importer — which package files are history, and how one history record is
 * read (`docs/legacy-migration/nxpkg-importer.md` §5; the converter's content contract
 * `PACKAGE_CONTRACT.md`, files and `record_type` values as the converter writes them).
 *
 * Pure: no I/O. Everything here fails CLOSED with a `LegacyHistoryIngestRefused` — an
 * unknown file under `records/`, an unknown `record_type`, a record in the wrong file, a key
 * that is not `legacy:…`, a duplicate key or a live-state flag set to true. Nothing is ever
 * skipped silently.
 */

/** Why the history ingest refused a package. A code, never a value from the package. */
export const LEGACY_HISTORY_REFUSAL_REASONS = [
  'UNKNOWN_FILE',
  'UNKNOWN_RECORD_TYPE',
  'RECORD_TYPE_MISMATCH',
  'RECORD_INVALID',
  'IDEMPOTENCY_KEY_INVALID',
  'IDEMPOTENCY_KEY_DUPLICATED',
  'LIVE_FLAG',
  'PACKAGE_IMPORT_MISMATCH',
] as const;
export type LegacyHistoryRefusalReason = (typeof LEGACY_HISTORY_REFUSAL_REASONS)[number];

const ERROR_CODE_OF: Readonly<Record<LegacyHistoryRefusalReason, LegacyNxpkgErrorCode>> = {
  UNKNOWN_FILE: 'NXPKG_UNSUPPORTED_VERSION',
  UNKNOWN_RECORD_TYPE: 'NXPKG_UNSUPPORTED_VERSION',
  RECORD_TYPE_MISMATCH: 'IMPORT_FAILED',
  RECORD_INVALID: 'IMPORT_FAILED',
  IDEMPOTENCY_KEY_INVALID: 'IMPORT_FAILED',
  IDEMPOTENCY_KEY_DUPLICATED: 'IMPORT_FAILED',
  LIVE_FLAG: 'NXPKG_LIVE_FLAG',
  PACKAGE_IMPORT_MISMATCH: 'IMPORT_FAILED',
};

/**
 * A refusal. `code` is the import's stored error code (`LEGACY_NXPKG_ERROR_CODES`); `reason`
 * and `file`/`line`/`detail` say where. `detail` is a field NAME or a `record_type` value the
 * converter controls — never a customer value.
 */
export class LegacyHistoryIngestRefused extends Error {
  override readonly name = 'LegacyHistoryIngestRefused';
  readonly code: LegacyNxpkgErrorCode;

  constructor(
    readonly reason: LegacyHistoryRefusalReason,
    readonly file: string | null,
    readonly line: number | null,
    readonly detail: string | null = null,
  ) {
    super(
      `${reason}${file === null ? '' : ` in ${file}`}${line === null ? '' : `:${line}`}` +
        (detail === null ? '' : ` (${detail})`),
    );
    this.code = ERROR_CODE_OF[reason];
  }
}

/**
 * The live-state flags of the content contract ("Fields every record has"): an importer must
 * refuse any record where one is true.
 */
export const LIVE_STATE_FLAGS = [
  'provision',
  'affects_wallet',
  'creates_payment',
  'creates_order',
  'counts_as_revenue',
  'enters_live_payment_state_machine',
  'triggers_service',
  'applies_to_live_state',
  'applied_to_balance',
  'activates_role',
  'grants_credit',
  'redeemable',
  'auto_create',
] as const;

/**
 * Further flags the converter's modules set to false on history records (support, engagement,
 * agents, panel targets). Not in the contract's list, but each names a live effect, so one set
 * to true is refused the same way rather than archived as if it were harmless.
 */
export const EXTRA_LIVE_STATE_FLAGS = [
  'creates_ticket',
  'sends_message',
  'notifies_customer',
  'pays_commission',
  'applies_price',
  'issues_new_credit',
  'services_reprovisioned',
] as const;

const ALL_LIVE_FLAGS: readonly string[] = [...LIVE_STATE_FLAGS, ...EXTRA_LIVE_STATE_FLAGS];

/** One history file: the converter's `record_type` it holds and the archive type it becomes. */
export interface HistoryFileSpec {
  readonly sourceType: string;
  readonly historyType: LegacyHistoryRecordType;
}

const spec = (sourceType: string, historyType: LegacyHistoryRecordType): HistoryFileSpec => ({
  sourceType,
  historyType,
});

/** The fixed history files (design §5), with the `record_type` the converter writes in each. */
export const HISTORY_FILES: Readonly<Record<string, HistoryFileSpec>> = {
  'records/payments.jsonl': spec('legacy_payment_history', 'payment'),
  'records/wallet_history.jsonl': spec('legacy_wallet_transaction', 'wallet_transaction'),
  'records/wallet_history_checks.jsonl': spec(
    'legacy_wallet_history_check',
    'wallet_history_check',
  ),
  'records/wallet_difference_analysis.jsonl': spec('legacy_wallet_difference', 'wallet_difference'),
  'records/service_operations.jsonl': spec('legacy_service_operation', 'service_operation'),
  'records/service_cancellation_requests.jsonl': spec(
    'legacy_service_cancellation_request',
    'service_cancellation_request',
  ),
  'records/manual_config_inventory.jsonl': spec(
    'legacy_manual_config_inventory',
    'manual_config_inventory',
  ),
  'records/service_ownership.jsonl': spec('legacy_service_ownership', 'service_ownership'),
  'records/panel_registry.jsonl': spec('legacy_panel', 'panel_registry'),
  'records/panel_target_mapping.jsonl': spec('legacy_panel_target', 'panel_target'),
  'records/panel_mapping_template.jsonl': spec(
    'legacy_panel_mapping_template',
    'panel_mapping_template',
  ),
  'records/category_catalogue.jsonl': spec('legacy_category', 'category_catalogue'),
  'records/product_mapping_proposal.jsonl': spec(
    'legacy_product_mapping_proposal',
    'product_mapping_proposal',
  ),
  'records/agents/profiles.jsonl': spec('legacy_agent_profile', 'agent_profile'),
  'records/agents/tier_prices.jsonl': spec('legacy_agent_price_level', 'agent_price_level'),
  'records/agents/agent_invoices.jsonl': spec('legacy_agent_invoice', 'agent_invoice'),
  'records/agents/agent_logs.jsonl': spec('legacy_agent_log', 'agent_log'),
  'records/agents/agent_usage.jsonl': spec('legacy_agent_usage', 'agent_usage'),
  'records/agents/agent_requests.jsonl': spec('legacy_agent_request', 'agent_request'),
  'records/agents/state.jsonl': spec('legacy_agent_state', 'agent_state'),
  'records/engagement/discounts.jsonl': spec('legacy_discount_code', 'discount'),
  'records/engagement/discount_usage.jsonl': spec('legacy_discount_usage', 'discount_usage'),
  'records/engagement/referrals.jsonl': spec('legacy_referral', 'referral'),
  'records/engagement/wheel_results.jsonl': spec('legacy_wheel_spin', 'wheel_result'),
  'records/engagement/ad_campaigns.jsonl': spec('legacy_ad_campaign', 'ad_campaign'),
  'records/engagement/program_settings.jsonl': spec(
    'legacy_referral_program_settings',
    'program_setting',
  ),
  'records/support/departments.jsonl': spec('legacy_support_department', 'support_department'),
  'records/support/support_messages.jsonl': spec('legacy_support_message', 'support_message'),
  'records/support/tickets.jsonl': spec('legacy_ticket', 'ticket'),
  'records/support/ticket_messages.jsonl': spec('legacy_ticket_message', 'ticket_message'),
};

/** The per-table directories: `records/<dir>/<table>.jsonl`, one table per file. */
export const HISTORY_DIRECTORIES: Readonly<Record<string, HistoryFileSpec>> = {
  'records/archive/': spec('legacy_archive_row', 'archive_row'),
  'records/configuration/': spec('legacy_configuration_row', 'configuration_row'),
};

/**
 * The record files the EXISTING legacy importer consumes through the `.nxpkg` source adapter
 * (design §0.2: customers, openings, debts, services, invoices, products, category labels,
 * panel codes). They are not history: the history ingest leaves them to it, and counts them.
 */
export const OPERATIONAL_RECORD_FILES: readonly string[] = [
  'records/customers.jsonl',
  'records/wallet_opening_balances.jsonl',
  'records/legacy_debts.jsonl',
  'records/services.jsonl',
  'records/invoices.jsonl',
  'records/products.jsonl',
  'records/categories.jsonl',
  'records/panels.jsonl',
];

/** Every converter `record_type` this ingest knows, to tell an unknown type from a misfiled one. */
const KNOWN_SOURCE_TYPES: ReadonlySet<string> = new Set(
  [...Object.values(HISTORY_FILES), ...Object.values(HISTORY_DIRECTORIES)].map((s) => s.sourceType),
);

/** A table name the converter uses as a file name under `archive/` or `configuration/`. */
const TABLE_FILE = /^[A-Za-z0-9_]{1,64}\.jsonl$/;

export interface PlannedHistoryFile extends HistoryFileSpec {
  readonly path: string;
}

export interface HistoryFilePlan {
  /** In package path order: a resumed ingest walks the same files the same way. */
  readonly files: readonly PlannedHistoryFile[];
  /** The operational files present, left to the legacy importer. */
  readonly operational: readonly string[];
}

/**
 * Which of the package's files this ingest reads. Only `records/` is considered (manifest,
 * reports and the source snapshot are the reader's and the importer's); within it every file
 * is history, operational, or a refusal.
 */
export function planHistoryFiles(paths: readonly string[]): HistoryFilePlan {
  const files: PlannedHistoryFile[] = [];
  const operational: string[] = [];
  for (const path of [...paths].sort()) {
    if (!path.startsWith('records/')) continue;
    if (OPERATIONAL_RECORD_FILES.includes(path)) {
      operational.push(path);
      continue;
    }
    const fixed = Object.hasOwn(HISTORY_FILES, path) ? HISTORY_FILES[path] : undefined;
    if (fixed !== undefined) {
      files.push({ path, ...fixed });
      continue;
    }
    const dir = Object.keys(HISTORY_DIRECTORIES).find((prefix) => path.startsWith(prefix));
    const rest = dir === undefined ? '' : path.slice(dir.length);
    if (dir !== undefined && TABLE_FILE.test(rest)) {
      files.push({ path, ...(HISTORY_DIRECTORIES[dir] as HistoryFileSpec) });
      continue;
    }
    throw new LegacyHistoryIngestRefused('UNKNOWN_FILE', path, null);
  }
  return { files, operational };
}

// --- one record ---------------------------------------------------------------------------

type Path = readonly string[];

/** Where each type names the legacy user the record is about (a Telegram id), in order. */
const USER_ID_PATHS: Readonly<Partial<Record<LegacyHistoryRecordType, readonly Path[]>>> = {
  payment: [['customer', 'telegram_user_id']],
  wallet_transaction: [['customer', 'telegram_user_id']],
  wallet_history_check: [['customer', 'telegram_user_id']],
  wallet_difference: [['customer', 'telegram_user_id']],
  service_operation: [['owner', 'telegram_user_id']],
  service_cancellation_request: [['owner', 'telegram_user_id']],
  // The proven final owner first; else the invoice's current-owner candidate (history only:
  // the ownership decision itself is the adoption's, never this archive's).
  service_ownership: [
    ['final_owner_telegram_user_id'],
    ['current_owner_candidate', 'telegram_user_id'],
  ],
  agent_profile: [['customer', 'telegram_user_id']],
  agent_state: [['customer', 'telegram_user_id']],
  agent_price_level: [['owner', 'telegram_user_id']],
  agent_invoice: [['owner', 'telegram_user_id']],
  agent_log: [['owner', 'telegram_user_id']],
  agent_usage: [['owner', 'telegram_user_id']],
  agent_request: [['requester', 'telegram_user_id']],
  discount_usage: [['customer', 'telegram_user_id']],
  // The referred customer: the referral is an event of their sign-up.
  referral: [['referee', 'telegram_user_id']],
  wheel_result: [['customer', 'telegram_user_id']],
  support_message: [['customer', 'telegram_user_id']],
  ticket: [['customer', 'telegram_user_id']],
};

/**
 * Where each type states WHEN it happened. Only an unambiguous instant is taken: Unix seconds,
 * or an ISO timestamp with `Z` or an offset. The converter's local wall times ("zone
 * UNPROVEN", `OK_TEHRAN_LOCAL`) carry no offset and are left null.
 */
const TIME_PATHS: Readonly<Partial<Record<LegacyHistoryRecordType, readonly Path[]>>> = {
  payment: [['times', 'created', 'unix']],
  wallet_transaction: [['created_at', 'unix']],
  agent_request: [['requested_at']],
  referral: [['attributed_at']],
  wheel_result: [['spun_at']],
  support_message: [['sent_at']],
  ticket_message: [['sent_at']],
};

/** Codes, states and amounts the card lists. Never an id, a name or a text. */
const SUMMARY_PATHS: Readonly<
  Partial<Record<LegacyHistoryRecordType, Readonly<Record<string, Path>>>>
> = {
  payment: {
    status: ['status', 'outcome'],
    method: ['method', 'normalized'],
    amountMinor: ['amount', 'amount_minor'],
    currency: ['amount', 'currency'],
  },
  wallet_transaction: {
    type: ['type', 'normalized'],
    amountMinor: ['amount', 'value_minor'],
    currency: ['amount', 'currency'],
    balanceAfterMinor: ['balance_after', 'value_minor'],
  },
  wallet_history_check: { verdict: ['verdict'], transactions: ['transactions'] },
  wallet_difference: {
    cause: ['cause'],
    certainty: ['certainty'],
    deltaMinor: ['features', 'delta_snapshot_minus_history_minor'],
  },
  service_operation: {
    operation: ['operation_type', 'normalized'],
    status: ['status', 'normalized'],
    amountMinor: ['amount', 'amount_minor'],
    currency: ['amount', 'currency'],
  },
  service_cancellation_request: { status: ['status', 'normalized'] },
  manual_config_inventory: { status: ['status', 'normalized'], codePanel: ['code_panel'] },
  service_ownership: {
    decision: ['ownership_decision'],
    confidence: ['ownership_confidence'],
    invoiceKey: ['invoice_key'],
  },
  panel_registry: { codePanel: ['code_panel'], panelType: ['panel_type', 'normalized'] },
  panel_target: { codePanel: ['code_panel'], mappingState: ['mapping_state'] },
  panel_mapping_template: { codePanel: ['code_panel'], decision: ['decision'] },
  category_catalogue: { reviewState: ['review_state'] },
  product_mapping_proposal: { codeProduct: ['code_product'] },
  agent_profile: { status: ['status'], tier: ['tier'] },
  agent_request: { status: ['status'], grantedTier: ['granted_tier'] },
  discount: { kind: ['kind'], state: ['state'] },
  discount_usage: { codeMatch: ['code_match'] },
  referral: { relationValid: ['relation_valid'] },
  wheel_result: {
    won: ['won'],
    prizeMinor: ['prize', 'amount_minor'],
    currency: ['prize', 'currency'],
  },
  support_message: { state: ['message_state'] },
  ticket: { status: ['status'] },
  ticket_message: { seq: ['seq'] },
  archive_row: { class: ['class'] },
  configuration_row: { class: ['class'] },
};

export interface ReadHistoryRecord {
  readonly historyType: LegacyHistoryRecordType;
  readonly idempotencyKey: string;
  readonly legacyUserId: string | null;
  readonly occurredAt: Date | null;
  /** The record exactly as packaged. */
  readonly payload: Record<string, unknown>;
}

/** A Telegram user id as the converter writes it: decimal digits, no sign, no padding. */
const TELEGRAM_ID = /^[1-9][0-9]{0,19}$/;
const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** 2000-01-01 .. 2100-01-01 in Unix seconds: anything else is not a Mirza event time. */
const UNIX_MIN = 946_684_800;
const UNIX_MAX = 4_102_444_800;

/**
 * Validates one record of `file` and reads its columns. Throws a `LegacyHistoryIngestRefused`;
 * returns nothing partial.
 */
export function readHistoryRecord(
  file: PlannedHistoryFile,
  line: number,
  record: unknown,
): ReadHistoryRecord {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new LegacyHistoryIngestRefused('RECORD_INVALID', file.path, line, 'not_an_object');
  }
  const payload = record as Record<string, unknown>;
  const type = payload['record_type'];
  if (typeof type !== 'string') {
    throw new LegacyHistoryIngestRefused('RECORD_INVALID', file.path, line, 'record_type');
  }
  if (!KNOWN_SOURCE_TYPES.has(type)) {
    throw new LegacyHistoryIngestRefused('UNKNOWN_RECORD_TYPE', file.path, line, safeCode(type));
  }
  if (type !== file.sourceType) {
    throw new LegacyHistoryIngestRefused('RECORD_TYPE_MISMATCH', file.path, line, safeCode(type));
  }
  const key = payload['idempotency_key'];
  if (
    typeof key !== 'string' ||
    !key.startsWith(LEGACY_HISTORY_IDEMPOTENCY_PREFIX) ||
    key.length < 8 ||
    key.length > 512
  ) {
    throw new LegacyHistoryIngestRefused('IDEMPOTENCY_KEY_INVALID', file.path, line);
  }
  const live = ALL_LIVE_FLAGS.find((flag) => payload[flag] === true);
  if (live !== undefined) {
    throw new LegacyHistoryIngestRefused('LIVE_FLAG', file.path, line, live);
  }
  return {
    historyType: file.historyType,
    idempotencyKey: key,
    legacyUserId: legacyUserIdOf(file.historyType, payload),
    occurredAt: occurredAtOf(file.historyType, payload),
    payload,
  };
}

export function legacyUserIdOf(
  type: LegacyHistoryRecordType,
  payload: Record<string, unknown>,
): string | null {
  for (const path of USER_ID_PATHS[type] ?? []) {
    const value = at(payload, path);
    if (typeof value === 'string' && TELEGRAM_ID.test(value)) return value;
  }
  return null;
}

export function occurredAtOf(
  type: LegacyHistoryRecordType,
  payload: Record<string, unknown>,
): Date | null {
  for (const path of TIME_PATHS[type] ?? []) {
    const instant = unambiguousInstant(at(payload, path));
    if (instant !== null) return instant;
  }
  return null;
}

/** The scalar summary of one record (see `SUMMARY_PATHS`), plus its schema and source table. */
export function summaryOf(
  type: LegacyHistoryRecordType,
  payload: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  const schema = payload['schema'];
  if (typeof schema === 'string') out['schema'] = schema;
  const table = at(payload, ['provenance', 'source_table']);
  if (typeof table === 'string') out['sourceTable'] = table;
  for (const [name, path] of Object.entries(SUMMARY_PATHS[type] ?? {})) {
    const value = at(payload, path);
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      out[name] = value;
    }
  }
  return out;
}

export function unambiguousInstant(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= UNIX_MIN && value <= UNIX_MAX ? new Date(value * 1000) : null;
  }
  if (typeof value === 'string' && ISO_WITH_OFFSET.test(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function at(value: unknown, path: Path): unknown {
  let current: unknown = value;
  for (const step of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, step)) return undefined;
    current = (current as Record<string, unknown>)[step];
  }
  return current;
}

/** A `record_type` value as an error may name it: the converter's vocabulary, bounded. */
function safeCode(value: string): string {
  return /^[a-z0-9_]{1,64}$/.test(value) ? value : 'unrecognised';
}
