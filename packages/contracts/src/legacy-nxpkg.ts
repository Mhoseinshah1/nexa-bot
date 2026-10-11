import { z } from 'zod';

/**
 * Mirza `.nxpkg` importer — Fresh Migration (`docs/legacy-migration/nxpkg-importer.md`).
 *
 * The Mirza2Nexa converter turns a Mirza backup into an encrypted, versioned package. One
 * `legacy_nxpkg_imports` row tracks one uploaded package through verification, a dry run,
 * the owner's approval of THAT dry run's digest, and the apply, which the `migration`
 * process role performs under a lease. Everything operational goes through the existing
 * legacy importer; every other record type is archived in `legacy_history_records`, which
 * is visible and never operational, never money.
 *
 * Codes and closed sets only. No package content, no key, no legacy row lives here.
 */

/** The source engine name the importer's `descriptor.engine` reports for a package. */
export const LEGACY_NXPKG_SOURCE_ENGINE = 'NXPKG' as const;

/**
 * The lifecycle of one package import (design §4):
 *
 * ```
 * UPLOADED → VERIFYING → VERIFIED | VERIFY_FAILED
 * VERIFIED → DRY_RUN_REQUESTED → DRY_RUN_RUNNING → DRY_RUN_DONE | DRY_RUN_FAILED
 * DRY_RUN_DONE → APPROVED → APPLYING → COMPLETED | COMPLETED_WITH_DISCREPANCY | FAILED
 * any non-terminal → CANCELLED
 * ```
 *
 * Every transition is a conditional UPDATE naming its `from` states.
 */
export const LEGACY_NXPKG_IMPORT_STATUSES = [
  'UPLOADED',
  'VERIFYING',
  'VERIFIED',
  'VERIFY_FAILED',
  'DRY_RUN_REQUESTED',
  'DRY_RUN_RUNNING',
  'DRY_RUN_DONE',
  'DRY_RUN_FAILED',
  'APPROVED',
  'APPLYING',
  'COMPLETED',
  'COMPLETED_WITH_DISCREPANCY',
  'FAILED',
  'CANCELLED',
] as const;
export type LegacyNxpkgImportStatus = (typeof LEGACY_NXPKG_IMPORT_STATUSES)[number];
export const legacyNxpkgImportStatusSchema = z.enum(LEGACY_NXPKG_IMPORT_STATUSES);

/**
 * The states nothing moves out of. A failed verification or dry run is terminal too: the
 * package is uploaded again (a new row) rather than retried in place, so the one
 * non-terminal import per tenant (a partial unique index over the complement of this list)
 * is released.
 */
export const LEGACY_NXPKG_TERMINAL_STATUSES = [
  'VERIFY_FAILED',
  'DRY_RUN_FAILED',
  'COMPLETED',
  'COMPLETED_WITH_DISCREPANCY',
  'FAILED',
  'CANCELLED',
] as const satisfies readonly LegacyNxpkgImportStatus[];
export type LegacyNxpkgTerminalStatus = (typeof LEGACY_NXPKG_TERMINAL_STATUSES)[number];

/** The non-terminal states: at most one import of a tenant is in one of these. */
export const LEGACY_NXPKG_ACTIVE_STATUSES: readonly LegacyNxpkgImportStatus[] =
  LEGACY_NXPKG_IMPORT_STATUSES.filter(
    (status) => !(LEGACY_NXPKG_TERMINAL_STATUSES as readonly string[]).includes(status),
  );

export function isLegacyNxpkgTerminalStatus(
  status: LegacyNxpkgImportStatus,
): status is LegacyNxpkgTerminalStatus {
  return (LEGACY_NXPKG_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** How the package key was given: the converter's key file, or a passphrase. */
export const LEGACY_NXPKG_KEY_KINDS = ['KEY_FILE', 'PASSPHRASE'] as const;
export type LegacyNxpkgKeyKind = (typeof LEGACY_NXPKG_KEY_KINDS)[number];
export const legacyNxpkgKeyKindSchema = z.enum(LEGACY_NXPKG_KEY_KINDS);

/**
 * Why an import stopped (design §1, §4, §6). Stored in `legacy_nxpkg_imports.error_code`
 * and shown to the operator; never a message, never a value from the package.
 */
export const LEGACY_NXPKG_ERROR_CODES = [
  /** Container: magic, header, AES-256-GCM STREAM, final chunk or trailing bytes. */
  'NXPKG_CONTAINER_INVALID',
  /** The key check failed: the key or passphrase does not open this package. */
  'NXPKG_WRONG_KEY',
  /** An authentication tag, the payload ZIP or `checksums.json` disagrees. */
  'NXPKG_TAMPERED',
  /** `package_schema`, its major or `package_schema_version` is not supported. */
  'NXPKG_UNSUPPORTED_VERSION',
  /** `manifest.readiness` is not `ready`, or blockers remain. */
  'NXPKG_NOT_READY',
  /** `source/catalog.json` or a required `source/tables/*.jsonl` is missing. */
  'NXPKG_SOURCE_SNAPSHOT_MISSING',
  /** Money is not declared as unrescaled Toman (`IRT`). */
  'NXPKG_MONEY_UNIT',
  /** A record carries a live-state flag set to true (`provision`, `affects_wallet`, …). */
  'NXPKG_LIVE_FLAG',
  /** A package target is not `rickpanel`, or the bound NEXA panel is not an ACTIVE one. */
  'PANEL_TARGET_MISMATCH',
  /** The tenant already holds operational data (§6). Nothing is deleted to make room. */
  'FRESH_TARGET_NOT_EMPTY',
  /** The stored package's SHA-256 is not the one verified and approved. */
  'PACKAGE_CHANGED',
  /** The apply's dry-run digest is not the approved one. */
  'DRY_RUN_MISMATCH',
  /** The ownership decisions file failed verification (§7). */
  'DECISIONS_INVALID',
  /** The import itself failed; the legacy run's report says where. */
  'IMPORT_FAILED',
  /** The operator cancelled the import. */
  'CANCELLED',
] as const;
export type LegacyNxpkgErrorCode = (typeof LEGACY_NXPKG_ERROR_CODES)[number];
export const legacyNxpkgErrorCodeSchema = z.enum(LEGACY_NXPKG_ERROR_CODES);

/**
 * The closed set of archive record types (design §5). None of them changes a balance, an
 * order, a service or a role: `legacy_history_records` is visible history only.
 */
export const LEGACY_HISTORY_RECORD_TYPES = [
  'payment',
  'wallet_transaction',
  'wallet_history_check',
  'wallet_difference',
  'service_operation',
  'service_cancellation_request',
  'manual_config_inventory',
  'service_ownership',
  'panel_registry',
  'panel_target',
  'panel_mapping_template',
  'category_catalogue',
  'product_mapping_proposal',
  'agent_profile',
  'agent_price_level',
  'agent_invoice',
  'agent_log',
  'agent_usage',
  'agent_request',
  'agent_state',
  'discount',
  'discount_usage',
  'referral',
  'wheel_result',
  'ad_campaign',
  'program_setting',
  'support_department',
  'support_message',
  'ticket',
  'ticket_message',
  'archive_row',
  'configuration_row',
] as const;
export type LegacyHistoryRecordType = (typeof LEGACY_HISTORY_RECORD_TYPES)[number];
export const legacyHistoryRecordTypeSchema = z.enum(LEGACY_HISTORY_RECORD_TYPES);

/** Every history record's idempotency key starts with this (pinned by a CHECK). */
export const LEGACY_HISTORY_IDEMPOTENCY_PREFIX = 'legacy:' as const;

/**
 * The audit actions of the web surface. The key, the package bytes and any package value
 * never appear in an audit row — only the import id, file SHA-256, status and digests.
 * `approve` is charged on the CRITICAL `legacy.migration.apply` and listed in
 * `AUDIT_CRITICAL_ACTIONS`; the others on `legacy.migration.manage`.
 */
export const LEGACY_NXPKG_AUDIT_ACTIONS = {
  /** A package was uploaded (a new import row). */
  upload: 'legacy.migration.upload',
  /** The package key, panel bindings or ownership decisions were given. */
  configure: 'legacy.migration.configure',
  /** A dry run was requested. */
  requestDryRun: 'legacy.migration.dry_run_request',
  /** The owner approved a dry run's digest and started the import. */
  approve: 'legacy.migration.approve',
  /** The import was cancelled. */
  cancel: 'legacy.migration.cancel',
} as const;
export type LegacyNxpkgAuditAction =
  (typeof LEGACY_NXPKG_AUDIT_ACTIONS)[keyof typeof LEGACY_NXPKG_AUDIT_ACTIONS];
