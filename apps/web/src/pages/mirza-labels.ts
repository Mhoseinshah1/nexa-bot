import {
  LEGACY_SERVICE_OUTCOMES,
  type LegacyImportMapStatus,
  type LegacyImportRunStatus,
  type LegacyReviewState,
  type LedgerReason,
  type LegacyHistoryRecordType,
  type LegacyServiceOutcome,
} from '@nexa/contracts';
import { t, type WebKey } from '../i18n/web.fa';

/**
 * Persian names for what a Mirza `.nxpkg` import leaves behind: Mirza's verbatim invoice
 * `Status`, the migration report's section names and its warning, quarantine and history
 * codes, and the ledger's reasons. Labels only — nothing here decides anything.
 *
 * A value this file does not know is never guessed: the caller shows it raw (and, for an
 * invoice status, as unknown: `web.mrz_status_unknown`).
 */

/**
 * Mirza's invoice `Status` values whose WRITER is documented, compared exactly and
 * case-sensitively (as the importer compares them). The evidence for each is in the
 * converter's `docs/PANELS_AND_ADOPTION.md` §2 ("Service status classes") and
 * `docs/SOURCE_TABLES.md` (table `invoice`, field `Status`); NEXA's live set is
 * `docs/legacy-migration/nxpkg-coverage.md`. Any other value — NULL, `removed`, `expired`,
 * a case variant such as `Active` — has no writer in either public source and is UNKNOWN.
 *
 * These describe the invoice AS OF THE SNAPSHOT, in Mirza. None of them is the state of a
 * NEXA service, and none of them says the panel account still exists.
 */
export const MIRZA_INVOICE_STATUS_LABELS: Readonly<Record<string, WebKey>> = {
  active: 'web.mrz_status_active',
  send_on_hold: 'web.mrz_status_send_on_hold',
  end_of_time: 'web.mrz_status_end_of_time',
  end_of_volume: 'web.mrz_status_end_of_volume',
  sendedwarn: 'web.mrz_status_sendedwarn',
  disabled: 'web.mrz_status_disabled',
  disabledn: 'web.mrz_status_disabledn',
  disablebyadmin: 'web.mrz_status_disablebyadmin',
  removebyuser: 'web.mrz_status_removebyuser',
  removebyadmin: 'web.mrz_status_removebyadmin',
  removedbyadmin: 'web.mrz_status_removedbyadmin',
  removeTime: 'web.mrz_status_remove_time',
  removevolume: 'web.mrz_status_remove_volume',
  unpaid: 'web.mrz_status_unpaid',
  Unsuccessful: 'web.mrz_status_unsuccessful',
};

/** The label of a verbatim Mirza status, or null when its meaning is not documented. */
export function mirzaStatusLabel(status: string | null): string | null {
  if (status === null || !Object.hasOwn(MIRZA_INVOICE_STATUS_LABELS, status)) return null;
  const key = MIRZA_INVOICE_STATUS_LABELS[status];
  return key === undefined ? null : t(key);
}

/** Every ledger reason, named — exhaustive, so a reason added to the contract is a type error here. */
export const LEDGER_REASON_LABELS: Readonly<Record<LedgerReason, WebKey>> = {
  TOPUP_GATEWAY: 'web.ledger_reason_topup_gateway',
  TOPUP_RECEIPT: 'web.ledger_reason_topup_receipt',
  TOPUP_STARS: 'web.ledger_reason_topup_stars',
  TOPUP_CRYPTO: 'web.ledger_reason_topup_crypto',
  RECEIPT_CREDIT: 'web.ledger_reason_receipt_credit',
  PURCHASE: 'web.ledger_reason_purchase',
  PURCHASE_REVERSAL: 'web.ledger_reason_purchase_reversal',
  REFUND: 'web.ledger_reason_refund',
  CASHBACK_GATEWAY: 'web.ledger_reason_cashback_gateway',
  CASHBACK_TOPUP: 'web.ledger_reason_cashback_topup',
  CASHBACK_RENEWAL: 'web.ledger_reason_cashback_renewal',
  CASHBACK_PURCHASE: 'web.ledger_reason_cashback_purchase',
  CASHBACK_REVERSAL: 'web.ledger_reason_cashback_reversal',
  REFERRAL_COMMISSION: 'web.ledger_reason_referral_commission',
  REFERRAL_COMMISSION_REVERSAL: 'web.ledger_reason_referral_commission_reversal',
  REFERRAL_SIGNUP_GIFT: 'web.ledger_reason_referral_signup_gift',
  START_GIFT: 'web.ledger_reason_start_gift',
  LOTTERY_WIN: 'web.ledger_reason_lottery_win',
  LUCK_WHEEL_WIN: 'web.ledger_reason_luck_wheel_win',
  ADMIN_CREDIT: 'web.ledger_reason_admin_credit',
  ADMIN_DEBIT: 'web.ledger_reason_admin_debit',
  MASS_CREDIT: 'web.ledger_reason_mass_credit',
  MASS_DEBIT: 'web.ledger_reason_mass_debit',
  ACCOUNT_TRANSFER_OUT: 'web.ledger_reason_account_transfer_out',
  ACCOUNT_TRANSFER_IN: 'web.ledger_reason_account_transfer_in',
  RESELLER_SETTLEMENT: 'web.ledger_reason_reseller_settlement',
  RESELLER_MEMBERSHIP_FEE: 'web.ledger_reason_reseller_membership_fee',
  MIGRATION_OPENING_BALANCE: 'web.ledger_reason_migration_opening_balance',
  CHARGEBACK: 'web.ledger_reason_chargeback',
  CORRECTION: 'web.ledger_reason_correction',
  OTHER: 'web.ledger_reason_other',
};

/** The archived history's record types (also the migration report's `history:<type>` codes). */
export const LEGACY_HISTORY_TYPE_LABELS: Readonly<Record<LegacyHistoryRecordType, WebKey>> = {
  payment: 'web.c360_legacy_type_payment',
  wallet_transaction: 'web.c360_legacy_type_wallet_transaction',
  wallet_history_check: 'web.c360_legacy_type_wallet_history_check',
  wallet_difference: 'web.c360_legacy_type_wallet_difference',
  service_operation: 'web.c360_legacy_type_service_operation',
  service_cancellation_request: 'web.c360_legacy_type_service_cancellation_request',
  manual_config_inventory: 'web.c360_legacy_type_manual_config_inventory',
  service_ownership: 'web.c360_legacy_type_service_ownership',
  panel_registry: 'web.c360_legacy_type_panel_registry',
  panel_target: 'web.c360_legacy_type_panel_target',
  panel_mapping_template: 'web.c360_legacy_type_panel_mapping_template',
  category_catalogue: 'web.c360_legacy_type_category_catalogue',
  product_mapping_proposal: 'web.c360_legacy_type_product_mapping_proposal',
  agent_profile: 'web.c360_legacy_type_agent_profile',
  agent_price_level: 'web.c360_legacy_type_agent_price_level',
  agent_invoice: 'web.c360_legacy_type_agent_invoice',
  agent_log: 'web.c360_legacy_type_agent_log',
  agent_usage: 'web.c360_legacy_type_agent_usage',
  agent_request: 'web.c360_legacy_type_agent_request',
  agent_state: 'web.c360_legacy_type_agent_state',
  discount: 'web.c360_legacy_type_discount',
  discount_usage: 'web.c360_legacy_type_discount_usage',
  referral: 'web.c360_legacy_type_referral',
  wheel_result: 'web.c360_legacy_type_wheel_result',
  ad_campaign: 'web.c360_legacy_type_ad_campaign',
  program_setting: 'web.c360_legacy_type_program_setting',
  support_department: 'web.c360_legacy_type_support_department',
  support_message: 'web.c360_legacy_type_support_message',
  ticket: 'web.c360_legacy_type_ticket',
  ticket_message: 'web.c360_legacy_type_ticket_message',
  archive_row: 'web.c360_legacy_type_archive_row',
  configuration_row: 'web.c360_legacy_type_configuration_row',
};

function historyTypeLabel(code: string): string | null {
  if (!Object.hasOwn(LEGACY_HISTORY_TYPE_LABELS, code)) return null;
  const key = LEGACY_HISTORY_TYPE_LABELS[code as LegacyHistoryRecordType];
  return key === undefined ? null : t(key);
}

/** The service outcomes' labels, injected by the caller (they live with `/legacy-services`). */
export type OutcomeLabels = Readonly<Record<LegacyServiceOutcome, WebKey>>;

function isOutcome(code: string): code is LegacyServiceOutcome {
  return (LEGACY_SERVICE_OUTCOMES as readonly string[]).includes(code);
}

/** How a report row names itself: a Persian label when one is known, and where to look. */
export interface MigrationCodeView {
  /** Null when the code is not known here: the caller shows it raw, never guessed. */
  readonly label: string | null;
  /** The filtered global page this row's records are on, when there is one. */
  readonly href: string | null;
}

const SECTION_LABELS: Readonly<Record<string, WebKey>> = {
  customers: 'web.mrz_section_customers',
  'customers:existing': 'web.mrz_section_customers_existing',
  'customers:invalid_identity': 'web.mrz_section_customers_invalid_identity',
  wallet_openings: 'web.mrz_section_wallet_openings',
  legacy_debts: 'web.mrz_section_legacy_debts',
  trials: 'web.mrz_section_trials',
  products: 'web.mrz_section_products',
  invoice_archive: 'web.mrz_section_invoice_archive',
  services: 'web.mrz_section_services',
  history: 'web.mrz_section_history',
};

const SECTION_LINKS: Readonly<Record<string, string>> = {
  legacy_debts: '/legacy-debts?state=ALL',
  products: '/legacy-products',
  invoice_archive: '/legacy-invoices',
  services: '/legacy-services?reviewState=ALL',
};

/** A per-section row of the dry-run or apply report (`customers`, `history:payment`, `table:…`). */
export function migrationSectionView(section: string): MigrationCodeView {
  const own = Object.hasOwn(SECTION_LABELS, section) ? SECTION_LABELS[section] : undefined;
  if (own !== undefined) {
    return {
      label: t(own),
      href: Object.hasOwn(SECTION_LINKS, section) ? (SECTION_LINKS[section] ?? null) : null,
    };
  }
  if (section.startsWith('history:')) {
    const type = historyTypeLabel(section.slice('history:'.length));
    return {
      label: type === null ? null : `${t('web.mrz_section_history_of')} ${type}`,
      href: null,
    };
  }
  if (section.startsWith('table:')) {
    // `table:<class>:<name>`: the source table's own name stays Latin (the caller shows it raw).
    return { label: t('web.mrz_section_table'), href: null };
  }
  return { label: null, href: null };
}

const CODE_LABELS: Readonly<Record<string, WebKey>> = {
  OWNERSHIP_HOLD_CHANGED_NOT_REPORTED: 'web.mrz_code_ownership_hold_not_reported',
  CONVERTER_TOTALS_ABSENT: 'web.mrz_code_converter_totals_absent',
  PROVIDER_INVENTORY_INCOMPLETE: 'web.mrz_code_provider_inventory_incomplete',
  PROVIDER_INVENTORY_CHURN: 'web.mrz_code_provider_inventory_churn',
  PROVIDER_INVENTORY_UNRESOLVED: 'web.mrz_code_provider_inventory_unresolved',
  TABLE_INVENTORY_INCOMPLETE: 'web.mrz_code_table_inventory_incomplete',
  BALANCE_UNREADABLE: 'web.mrz_code_balance_unreadable',
  BALANCE_OUT_OF_RANGE: 'web.mrz_code_balance_out_of_range',
  DUPLICATE_SOURCE_ID: 'web.mrz_code_duplicate_source_id',
  STATUS_UNKNOWN: 'web.mrz_code_status_unknown',
  DECISION_QUARANTINED: 'web.mrz_code_decision_quarantined',
  DECISION_REJECTED: 'web.mrz_code_decision_rejected',
  DECISION_PENDING: 'web.mrz_code_decision_pending',
  DECISION_STALE: 'web.mrz_code_decision_stale',
  OWNERSHIP_NOT_PROVEN: 'web.mrz_code_ownership_not_proven',
  PROVEN_OWNER_IS_NOT_INVOICE_OWNER: 'web.mrz_code_proven_owner_mismatch',
  NO_OWNERSHIP_RECORD: 'web.mrz_code_no_ownership_record',
};

/**
 * A warning, quarantine or history code of the report. A service outcome links to the
 * candidates with that outcome; `PRODUCT_*` to the product review; `X:<reason>` keeps its
 * reason raw beside the label of `X`.
 */
export function migrationCodeView(code: string, outcomes: OutcomeLabels): MigrationCodeView {
  if (isOutcome(code)) {
    return {
      label: t(outcomes[code]),
      href: `/legacy-services?outcome=${encodeURIComponent(code)}&reviewState=ALL`,
    };
  }
  const history = historyTypeLabel(code);
  if (history !== null) return { label: history, href: null };
  if (code.startsWith('PRODUCT_')) {
    return { label: t('web.mrz_code_product'), href: '/legacy-products' };
  }
  const base = code.includes(':') ? code.slice(0, code.indexOf(':')) : code;
  const key = Object.hasOwn(CODE_LABELS, base) ? CODE_LABELS[base] : undefined;
  return { label: key === undefined ? null : t(key), href: null };
}

/*
 * W5: the importer's own words for an invoice key, by name — the map row's status and its
 * review state, and an apply run's status. Open on the wire (strings), so a value no map
 * knows is drawn raw; the test pins every value the contracts name.
 */
export const LEGACY_IMPORT_MAP_STATUS_LABELS: Readonly<Record<LegacyImportMapStatus, WebKey>> = {
  IMPORTED: 'web.mrz_map_status_imported',
  SKIPPED: 'web.mrz_map_status_skipped',
  MANUAL_REVIEW: 'web.mrz_map_status_manual_review',
  FAILED: 'web.mrz_map_status_failed',
};

export const LEGACY_REVIEW_STATE_LABELS: Readonly<Record<LegacyReviewState, WebKey>> = {
  OPEN: 'web.mrz_review_state_open',
  RESOLVED: 'web.mrz_review_state_resolved',
  DISMISSED: 'web.mrz_review_state_dismissed',
};

export const LEGACY_IMPORT_RUN_STATUS_LABELS: Readonly<Record<LegacyImportRunStatus, WebKey>> = {
  RUNNING: 'web.mrz_run_status_running',
  COMPLETED: 'web.mrz_run_status_completed',
  FAILED: 'web.mrz_run_status_failed',
  ABORTED: 'web.mrz_run_status_aborted',
};
