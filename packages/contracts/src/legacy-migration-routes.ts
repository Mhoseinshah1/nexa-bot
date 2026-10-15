import { z } from 'zod';
import {
  legacyNxpkgErrorCodeSchema,
  legacyNxpkgImportStatusSchema,
  legacyNxpkgKeyKindSchema,
  type LegacyNxpkgImportStatus,
} from './legacy-nxpkg.js';
import { legacyInventoryPanelDiagnosticsSchema } from './legacy-inventory-diagnostics.js';

/**
 * Mirza `.nxpkg` importer — the Web Admin surface «مهاجرت از میرزا»
 * (`docs/legacy-migration/nxpkg-importer.md` §4, §8).
 *
 * The web surface uploads a package, takes its key once, records the panel bindings and the
 * optional ownership decisions file, requests a dry run and records the owner's approval of
 * ONE dry run's digest. The `migration` process role does every step that opens the package;
 * no HTTP request decrypts, verifies or imports anything.
 *
 * What crosses this surface: ids, statuses, codes, counts, digests and NEXA panel ids. Never
 * the key or passphrase (write-only), never a file path on the installation's disk, never a
 * legacy row or any personal data from the package.
 */

/**
 * The routes. Builders, so the server declares each parameterised route with `routePattern`
 * from the same function the client calls.
 */
export const LEGACY_MIGRATION_ROUTES = {
  /** What the server can do: the feature flag, the upload ceilings, the approval phrase. */
  capabilities: '/legacy-migration/capabilities',
  list: '/legacy-migration/imports',
  /**
   * The package upload: a raw `application/octet-stream` body streamed to disk and counted,
   * exactly as the recovery upload is (the ceiling is the server's counter, not
   * `content-length`). The browser's file name travels in `x-nexa-filename`.
   */
  upload: '/legacy-migration/imports/upload',
  detail: (id: string) => `/legacy-migration/imports/${encodeURIComponent(id)}`,
  /** The package key or passphrase, once, as JSON. Write-only: never returned. */
  key: (id: string) => `/legacy-migration/imports/${encodeURIComponent(id)}/key`,
  panelBindings: (id: string) =>
    `/legacy-migration/imports/${encodeURIComponent(id)}/panel-bindings`,
  /** The converter's `ownership-decisions.json`, raw `application/octet-stream`, small. */
  decisions: (id: string) => `/legacy-migration/imports/${encodeURIComponent(id)}/decisions`,
  dryRun: (id: string) => `/legacy-migration/imports/${encodeURIComponent(id)}/dry-run`,
  approve: (id: string) => `/legacy-migration/imports/${encodeURIComponent(id)}/approve`,
  cancel: (id: string) => `/legacy-migration/imports/${encodeURIComponent(id)}/cancel`,
} as const;

/**
 * The states each operator command accepts (every one also requires that no `migration`
 * worker holds the row, except `cancel`, which does not wait for it). One table for the
 * server's checks and the page's offers, so the two cannot disagree.
 *
 * - A panel binding or decisions file after the dry run returns the import to VERIFIED and
 *   clears that dry run: no approval can bind a report computed from other inputs.
 * - APPLYING is never cancellable: writes may have committed, and the importer's resume is
 *   what finishes them.
 */
export const LEGACY_MIGRATION_COMMAND_STATES = {
  /**
   * The key is given once after the upload, and AGAIN after the `migration` role erased an
   * idle one (`LEGACY_MIGRATION_KEY_IDLE_MS`) from a VERIFIED or DRY_RUN_DONE import — the
   * server accepts it there only while the import holds no key.
   */
  setKey: ['UPLOADED', 'VERIFIED', 'DRY_RUN_DONE'],
  setPanelBindings: ['UPLOADED', 'VERIFIED', 'DRY_RUN_DONE'],
  uploadDecisions: ['UPLOADED', 'VERIFIED', 'DRY_RUN_DONE'],
  requestDryRun: ['VERIFIED', 'DRY_RUN_DONE'],
  approve: ['DRY_RUN_DONE'],
  cancel: [
    'UPLOADED',
    'VERIFYING',
    'VERIFIED',
    'DRY_RUN_REQUESTED',
    'DRY_RUN_RUNNING',
    'DRY_RUN_DONE',
    'APPROVED',
  ],
} as const satisfies Readonly<Record<string, readonly LegacyNxpkgImportStatus[]>>;

/** HTTP refusal codes of this surface (never a row's `error_code`; those are LEGACY_NXPKG_*). */
export const LEGACY_MIGRATION_HTTP_ERROR_CODES = {
  /** `LEGACY_MIGRATION_ENABLED` is off: every route refuses. */
  DISABLED: 'legacy_migration.disabled',
  NOT_FOUND: 'legacy_migration.not_found',
  REQUEST_INVALID: 'legacy_migration.request_invalid',
  /** The import is not in a state that accepts this command. Nothing changed. */
  INVALID_STATE: 'legacy_migration.invalid_state',
  /** Another import of this tenant is not finished (one at a time). */
  ALREADY_ACTIVE: 'legacy_migration.already_active',
  UPLOAD_TOO_LARGE: 'legacy_migration.upload_too_large',
  UPLOAD_EMPTY: 'legacy_migration.upload_empty',
  /** The approval names a dry run digest that is not the import's current one. */
  DIGEST_MISMATCH: 'legacy_migration.digest_mismatch',
  /** The typed approval phrase does not match. */
  CONFIRMATION_INVALID: 'legacy_migration.confirmation_invalid',
  SCOPE_STOPPED: 'legacy_migration.scope_stopped',
  /**
   * Production-like target: the approval's `targetAcknowledgement` is not this installation's
   * own (`capabilities.targetAcknowledgement`) — the owner confirmed another database or
   * tenant, or none. Nothing was approved.
   */
  TARGET_ACK_MISMATCH: 'legacy_migration.target_ack_mismatch',
  /**
   * A disaster recovery holds the installation (confirmed and not finished). A migration is a
   * restore from the operator's view: one at a time, whichever came first. Nothing was approved.
   */
  RECOVERY_ACTIVE: 'legacy_migration.recovery_active',
} as const;
export type LegacyMigrationHttpErrorCode =
  (typeof LEGACY_MIGRATION_HTTP_ERROR_CODES)[keyof typeof LEGACY_MIGRATION_HTTP_ERROR_CODES];

/**
 * The phrase the owner types to approve. Required ON TOP of `legacy.migration.apply` and of
 * the digest binding — a defence against a misclick, never against an actor who should not
 * be here (the recovery confirmation's rule).
 */
export const LEGACY_MIGRATION_APPROVAL_PHRASE = 'IMPORT MIRZA';

/**
 * How long an approval may wait in APPROVED before the executor starts it. Past it the import
 * is FAILED `APPROVAL_EXPIRED` with nothing written (an approval read days ago is not the
 * owner's decision about today's installation). 24 hours.
 */
export const LEGACY_MIGRATION_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** The ownership decisions file ceiling (a JSON document, never a package). */
export const LEGACY_MIGRATION_DECISIONS_MAX_BYTES = 16 * 1024 * 1024;

/** Bounds of the key material: a converter key file is short; a passphrase is a sentence. */
export const LEGACY_MIGRATION_KEY_FILE_MAX_LENGTH = 4096;
export const LEGACY_MIGRATION_PASSPHRASE_MAX_LENGTH = 1024;
export const LEGACY_MIGRATION_PAGE_MAX = 100;
/** At most this many package panel targets can be bound. */
export const LEGACY_MIGRATION_BINDINGS_MAX = 200;

const idempotencyKey = z.string().min(8).max(255);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/u);
/** A non-negative integer as a decimal string (bigint over the wire). */
const decimal = z.string().regex(/^-?(0|[1-9][0-9]*)$/u);
const count = z.number().int().nonnegative();

// --- requests ------------------------------------------------------------------------------

/**
 * The key, once. Exactly one of the two. `idempotencyKey` replays the stored answer; the
 * request hash covers the import and the KIND only — never the secret, so no digest of a
 * passphrase is ever written to the idempotency store.
 */
export const legacyMigrationKeyRequestSchema = z.union([
  z
    .object({
      idempotencyKey,
      keyFileText: z.string().min(1).max(LEGACY_MIGRATION_KEY_FILE_MAX_LENGTH),
    })
    .strict(),
  z
    .object({
      idempotencyKey,
      passphrase: z.string().min(1).max(LEGACY_MIGRATION_PASSPHRASE_MAX_LENGTH),
    })
    .strict(),
]);
export type LegacyMigrationKeyRequest = z.infer<typeof legacyMigrationKeyRequestSchema>;

/** A package `code_panel` as the converter writes it. Bounded, printable, no control chars. */
export const legacyMigrationCodePanelSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !/\p{Cc}/u.test(value), { message: 'no control characters' });

export const legacyMigrationPanelBindingSchema = z
  .object({ codePanel: legacyMigrationCodePanelSchema, panelId: z.uuid() })
  .strict();
export type LegacyMigrationPanelBinding = z.infer<typeof legacyMigrationPanelBindingSchema>;

/**
 * Package panel target → NEXA panel. Each `codePanel` once. Recorded as given; whether each
 * panel is an ACTIVE, non-archived `rickpanel` of this tenant is decided again by the
 * `migration` role at the dry run and at the apply (`PANEL_TARGET_MISMATCH`).
 */
export const legacyMigrationPanelBindingsRequestSchema = z
  .object({
    idempotencyKey,
    bindings: z
      .array(legacyMigrationPanelBindingSchema)
      .min(1)
      .max(LEGACY_MIGRATION_BINDINGS_MAX)
      .refine((rows) => new Set(rows.map((row) => row.codePanel)).size === rows.length, {
        message: 'each codePanel once',
      }),
  })
  .strict();
export type LegacyMigrationPanelBindingsRequest = z.infer<
  typeof legacyMigrationPanelBindingsRequestSchema
>;

export const legacyMigrationCommandRequestSchema = z.object({ idempotencyKey }).strict();
export type LegacyMigrationCommandRequest = z.infer<typeof legacyMigrationCommandRequestSchema>;

/** The importer's target acknowledgement: 16 lowercase hex (a digest, not a secret). */
export const legacyMigrationTargetAcknowledgementSchema = z.string().regex(/^[0-9a-f]{16}$/u);

/**
 * The owner's approval: bound to the dry run digest the owner READ, plus the typed phrase.
 *
 * `targetAcknowledgement` (Phase 7, the restore page): on a production-like target the server
 * REQUIRES it to equal its own `targetAcknowledgement(target, tenant)` — the value
 * `capabilities.targetAcknowledgement` shows — and stores it on the import, where the
 * `migration` executor accepts it in place of the process environment's
 * `NEXA_LEGACY_IMPORT_TARGET_ACK`. Elsewhere it is ignored. Omitted means null.
 */
export const legacyMigrationApproveRequestSchema = z
  .object({
    idempotencyKey,
    dryRunSha256: hex64,
    confirmation: z.string().max(64),
    targetAcknowledgement: legacyMigrationTargetAcknowledgementSchema.nullable().default(null),
  })
  .strict();
export type LegacyMigrationApproveRequest = z.infer<typeof legacyMigrationApproveRequestSchema>;

export const legacyMigrationListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(LEGACY_MIGRATION_PAGE_MAX).optional(),
  /** The last `id` of the page before (uuid v7, so id order is upload order). */
  after: z.uuid().optional(),
});
export type LegacyMigrationListQuery = z.infer<typeof legacyMigrationListQuerySchema>;

// --- the reports the `migration` role stores (counts, codes, digests; never a row) ---------

/** Per-section counts (design §5): nothing is dropped silently. */
export const legacyMigrationSectionCountsSchema = z.object({
  section: z.string(),
  source: count,
  imported: count,
  archived: count,
  skipped: count,
  quarantined: count,
});
export type LegacyMigrationSectionCounts = z.infer<typeof legacyMigrationSectionCountsSchema>;

export const legacyMigrationCodeCountSchema = z.object({ code: z.string(), count });
export type LegacyMigrationCodeCount = z.infer<typeof legacyMigrationCodeCountSchema>;

/** One package panel target (`records/panel_target_mapping.jsonl`), as verification read it. */
export const legacyMigrationPanelTargetSchema = z.object({
  codePanel: z.string(),
  providerType: z.string(),
  /** Live legacy services the package places on this target. */
  services: count,
});
export type LegacyMigrationPanelTarget = z.infer<typeof legacyMigrationPanelTargetSchema>;

/** What verification proved about the package (stored as `verify_report`). */
export const legacyMigrationVerifyReportSchema = z.object({
  packageImportId: z.string(),
  sourceFingerprint: z.string(),
  packageSchemaVersion: z.string(),
  converterVersion: z.string(),
  /** The package was converted from a SYNTHETIC source: never a real migration. */
  synthetic: z.boolean(),
  panelTargets: z.array(legacyMigrationPanelTargetSchema),
  recordCounts: z.array(legacyMigrationCodeCountSchema),
  /**
   * The converter's signed ownership decisions, when given and verified (design §7): the
   * sealed entries digest an audit row may cite, and the counts per class. Never an entry.
   */
  decisions: z
    .object({
      entriesDigest: z.string(),
      auditHead: z.string().nullable(),
      items: count,
      proven: count,
      adminApprovedUnverified: count,
      pending: count,
      rejected: count,
      quarantined: count,
      stale: count,
    })
    .nullable(),
});
export type LegacyMigrationVerifyReport = z.infer<typeof legacyMigrationVerifyReportSchema>;

/** Wallet totals in the destination's currency, minor units as decimal strings. */
export const legacyMigrationWalletTotalsSchema = z.object({
  currency: z.string(),
  customers: count,
  beforeTotalMinor: decimal,
  afterTotalMinor: decimal,
});

export const legacyMigrationOwnershipSummarySchema = z.object({
  decisionsProvided: z.boolean(),
  proven: count,
  adminApprovedUnverified: count,
  quarantined: count,
  rejected: count,
  pending: count,
  stale: count,
});
export type LegacyMigrationOwnershipSummary = z.infer<typeof legacyMigrationOwnershipSummarySchema>;

/**
 * The seven values a legacy cutover approval binds (`legacy_cutover_approvals`), as THIS
 * package's dry run recorded them. On a production-like target the import is gated exactly as
 * the CLI gates it: the owner records an approval of these values at `/legacy-cutover`, and the
 * `migration` role passes them to the importer as the CLI's `--expected-*` flags.
 *
 * - `sourceFingerprint`: the v1 source fingerprint of the package's snapshot;
 * - `panelMapFingerprint`: the panel map built from the package targets and the bindings;
 * - `inventoryFingerprint`, `productsFingerprint`, `invoiceArchiveFingerprint`: the three read
 *   sets the dry run recorded for that source;
 * - `freezeProofSha256`: the SHA-256 of the package's authenticated, decrypted payload — the
 *   frozen content itself, independent of the encryption;
 * - `finalDumpSha256`: the SHA-256 of the uploaded `.nxpkg` file — the artifact imported.
 */
export const legacyMigrationCutoverValuesSchema = z.object({
  sourceFingerprint: hex64,
  panelMapFingerprint: hex64,
  inventoryFingerprint: hex64,
  productsFingerprint: hex64,
  invoiceArchiveFingerprint: hex64,
  freezeProofSha256: hex64,
  finalDumpSha256: hex64,
});
export type LegacyMigrationCutoverValues = z.infer<typeof legacyMigrationCutoverValuesSchema>;

/**
 * The dry run's report (stored as `dry_run_report`). Its SHA-256 over the canonical JSON is
 * `dry_run_sha256`, which the owner's approval binds.
 */
export const legacyMigrationDryRunReportSchema = z.object({
  importerVerdict: z.string(),
  sections: z.array(legacyMigrationSectionCountsSchema),
  warnings: z.array(legacyMigrationCodeCountSchema),
  quarantine: z.array(legacyMigrationCodeCountSchema),
  wallets: legacyMigrationWalletTotalsSchema,
  debts: z.object({ currency: z.string(), count, totalMinor: decimal }),
  ownership: legacyMigrationOwnershipSummarySchema,
  /** What a cutover approval of this package binds (required on a production-like target). */
  cutover: legacyMigrationCutoverValuesSchema,
  /**
   * The importer's digest of the plan tallies this dry run computed (`planTalliesDigest`). The
   * apply gives the APPROVED value to the importer, which refuses to start on a plan whose
   * tallies differ (`DRY_RUN_MISMATCH`). Null only when the importer reported none.
   */
  planTalliesDigest: hex64.nullable(),
  /**
   * Per production panel decided one needed name at a time: WHY each walk was or was not
   * gap-free and why each unresolved name stayed so (`legacy-inventory-diagnostics.ts`).
   * Diagnostics only — nothing reads it to decide. Absent on a report written before it.
   */
  providerDiagnostics: z.array(legacyInventoryPanelDiagnosticsSchema).optional(),
  /**
   * The inventory hold this dry run recorded (`LEGACY_MIGRATION_INVENTORY_HOLD_VERSION`): the
   * live invoices whose needed username a SUCCESSFUL per-name RickPanel read could not prove
   * present or absent. They are quarantined — kept as history and an OPEN review candidate,
   * never adopted — instead of blocking the whole import. `invoices` is how many, `digest` the
   * SHA-256 of their sorted keys (never a key). The importer binds the same hold into the plan
   * digest and the apply is given exactly this hold back: it only demotes (a held invoice
   * stays `INVENTORY_INCOMPLETE` even if the apply's read now resolves it), and an invoice
   * unresolved at the apply that is NOT in it refuses `DRY_RUN_MISMATCH`.
   *
   * ABSENT on a report written before the hold existed: `legacyMigrationDryRunInventoryIncomplete`
   * then counts every `INVENTORY_INCOMPLETE` service exactly as before — fail closed.
   */
  inventoryHold: z
    .object({
      version: z.literal(1),
      invoices: count,
      digest: hex64,
    })
    .strict()
    .optional(),
});
export type LegacyMigrationDryRunReport = z.infer<typeof legacyMigrationDryRunReportSchema>;
export type LegacyMigrationInventoryHold = NonNullable<
  LegacyMigrationDryRunReport['inventoryHold']
>;

/** The one version of `inventoryHold` this release writes and reads. */
export const LEGACY_MIGRATION_INVENTORY_HOLD_VERSION = 1;

/**
 * Whether a STORED report's `inventoryHold` is exactly the version-1 shape. The stored JSON is
 * not re-parsed by the server, so the rule never trusts a field it did not check.
 */
export function validInventoryHold(hold: unknown): hold is LegacyMigrationInventoryHold {
  if (typeof hold !== 'object' || hold === null) return false;
  const h = hold as { version?: unknown; invoices?: unknown; digest?: unknown };
  return (
    h.version === LEGACY_MIGRATION_INVENTORY_HOLD_VERSION &&
    typeof h.invoices === 'number' &&
    Number.isSafeInteger(h.invoices) &&
    h.invoices >= 0 &&
    typeof h.digest === 'string' &&
    /^[0-9a-f]{64}$/u.test(h.digest)
  );
}

/**
 * The dry run report's warning for the invoices the inventory hold quarantines
 * (`inventoryHold.invoices`): services kept as history and an OPEN review candidate because a
 * needed username was left UNRESOLVED by a per-name read that itself succeeded. Informational:
 * it does not block an approval (wallets, debts and every decided service still import).
 */
export const LEGACY_MIGRATION_PROVIDER_INVENTORY_QUARANTINED = 'PROVIDER_INVENTORY_QUARANTINED';

/**
 * The dry run report's warning for the production panels whose LIVE RickPanel inventory was
 * not complete when the dry run planned. Beside it, one `PROVIDER_INVENTORY_INCOMPLETE:<reason>`
 * per reason (`TOTAL_CHANGED`, `COUNT_MISMATCH`, `WALKS_DIFFER`, a failure kind such as
 * `TIMEOUT`).
 */
export const LEGACY_MIGRATION_PROVIDER_INVENTORY_INCOMPLETE = 'PROVIDER_INVENTORY_INCOMPLETE';

/**
 * The dry run report's warning for the production panels that CHANGED while they were read
 * (the double walk was not one snapshot because the panel moved: `TOTAL_CHANGED`,
 * `WALKS_DIFFER` — never a `COUNT_MISMATCH` of withheld rows, which stays an incomplete panel)
 * and whose needed usernames were therefore decided one by one, from the walks alone — a
 * gap-free decision walk, each presence confirmed by a later walk (no exact lookup). Beside it, one `PROVIDER_INVENTORY_CHURN:<reason>` per reason.
 * Informational and NOT blocking: a panel that keeps
 * selling while it is read is the normal case, and what such a read could not decide is
 * reported separately (`PROVIDER_INVENTORY_UNRESOLVED`).
 */
export const LEGACY_MIGRATION_PROVIDER_INVENTORY_CHURN = 'PROVIDER_INVENTORY_CHURN';

/**
 * The dry run report's warning for the needed usernames the walks could not decide (no exact
 * lookup is ever made: no gap-free decision walk, a row no later walk confirmed, or a name
 * seen under two creation times). Its count is the number of such names; the
 * invoices behind them are services category `INVENTORY_INCOMPLETE`. A report with the
 * inventory hold quarantines them (`PROVIDER_INVENTORY_QUARANTINED`) instead of blocking; one
 * without it blocks approval through `legacyMigrationDryRunInventoryIncomplete` — this code
 * itself is a count for the operator and is not read by that rule.
 */
export const LEGACY_MIGRATION_PROVIDER_INVENTORY_UNRESOLVED = 'PROVIDER_INVENTORY_UNRESOLVED';

/**
 * The `reason` a production-like approval refusal (`legacy_migration.invalid_state`) carries
 * when the dry run reported no plan digest: without it the import could be bound to no approved
 * plan (`DRY_RUN_MISMATCH` would compare nothing). The server's refusal and the Web Admin's
 * courtesy name it from here. A detail value, not an error code.
 */
export const LEGACY_MIGRATION_PLAN_DIGEST_MISSING = 'PLAN_DIGEST_MISSING';

/**
 * How many production panels a dry run planned on without a complete live RickPanel inventory.
 * On a production-like target such a dry run is NOT approvable and its apply does not start:
 * the import reads the panel again, and a plan made on a read that did not hold cannot be
 * compared with it (`DRY_RUN_MISMATCH`). ONE rule, for the server's refusal and the Web Admin's
 * courtesy alike.
 *
 * Fails closed for a report written before the warning existed: there the services category
 * `INVENTORY_INCOMPLETE` is the only trace (a production-like dry run with an incomplete TABLE
 * inventory never reaches DRY_RUN_DONE, so on such a target that code is the services one).
 *
 * A panel that moved while read (`TOTAL_CHANGED`, `WALKS_DIFFER`; a `COUNT_MISMATCH` of withheld
 * rows is never resolved per name and stays incomplete) but whose needed usernames were ALL
 * decided one by one, from a gap-free last walk, is reported as complete, with `PROVIDER_INVENTORY_CHURN`, and is
 * not counted here: the plan binds only those decisions. A needed name it could not decide
 * leaves its invoice `INVENTORY_INCOMPLETE`, which this rule still counts — UNLESS the report
 * carries the inventory hold (`inventoryHold`, version 1) and that invoice is one it holds: a
 * held invoice is quarantined, not a blocker. Only the `INVENTORY_INCOMPLETE` services beyond
 * the hold's count are counted; a whole-panel read failure (`PROVIDER_INVENTORY_INCOMPLETE`)
 * blocks whatever the hold says. A report without the hold fails closed exactly as before.
 */
export function legacyMigrationDryRunInventoryIncomplete(
  warnings: readonly LegacyMigrationCodeCount[] | null | undefined,
  inventoryHold?: LegacyMigrationInventoryHold | null,
): number {
  let provider = 0;
  let services = 0;
  for (const w of warnings ?? []) {
    if (w.code === LEGACY_MIGRATION_PROVIDER_INVENTORY_INCOMPLETE) provider += w.count;
    if (w.code === 'INVENTORY_INCOMPLETE') services += w.count;
  }
  // The inventory hold covers only what it says it covers, and only in the version this release
  // reads. A stored report is not re-parsed, so anything that is not exactly the v1 shape (a
  // safe non-negative count, a digest) is no hold at all. A hold claiming MORE invoices than
  // the report counts is inconsistent: blocked.
  const held = validInventoryHold(inventoryHold) ? inventoryHold.invoices : 0;
  const uncovered = held > services ? 1 : services - held;
  return Math.max(provider, uncovered > 0 ? 1 : 0);
}

/** The apply's outcome (stored as `apply_report`). */
export const legacyMigrationApplyReportSchema = z.object({
  importerVerdict: z.string(),
  reconcileVerdict: z.enum(['RECONCILED', 'DISCREPANCY']),
  /** The final report v2 `verdict.holds`. */
  reportHolds: z.boolean(),
  failedInvariants: z.array(z.string()),
  /** The final report v2 `verdict.failedSections`: every section whose own checks failed. */
  failedSections: z.array(z.string()),
  sections: z.array(legacyMigrationSectionCountsSchema),
  history: z.array(legacyMigrationCodeCountSchema),
});
export type LegacyMigrationApplyReport = z.infer<typeof legacyMigrationApplyReportSchema>;

/** Where the `migration` role is inside a step, and what the post-import backup did. */
export const LEGACY_MIGRATION_PHASES = [
  'VERIFY',
  'DRY_RUN',
  'APPLY_PRECHECK',
  'APPLY_IMPORT',
  'HISTORY',
  'RECONCILE',
  'REPORT',
  'BACKUP',
] as const;
export type LegacyMigrationPhase = (typeof LEGACY_MIGRATION_PHASES)[number];

/**
 * Why the `migration` role is WAITING on an operator (production-like target only). Not a
 * failure: the import stays where it is (still cancellable before the apply starts) and
 * continues once the operator acts.
 *
 * - `TARGET_ACK_MISSING`: neither the owner's approval (`targetAcknowledgement`, stored on the
 *   import) nor the `migration` process's environment (`NEXA_LEGACY_IMPORT_TARGET_ACK`, the CLI
 *   and rehearsal path) carries this target's acknowledgement;
 * - `CUTOVER_APPROVAL_MISSING`: no unrevoked owner approval matches the dry run's seven
 *   `cutover` values (the restore page's approval records one; `/legacy-cutover` too);
 * - `STOP_SALES_NOT_ACTIVE`: sales are not stopped (runbook step 1). An APPLYING import's own
 *   installation-wide write freeze counts as stopped sales.
 *
 * Phase 7: a blocker met once the import is APPLYING fails it (`IMPORT_FAILED`, the blocker
 * kept on the progress) instead of waiting: the write freeze would refuse the very operator
 * write that could clear it.
 */
export const LEGACY_MIGRATION_BLOCKERS = [
  'TARGET_ACK_MISSING',
  'CUTOVER_APPROVAL_MISSING',
  'STOP_SALES_NOT_ACTIVE',
  /** A NEXA restore is confirmed and unfinished: the import waits, APPROVED, until it ends. */
  'RECOVERY_ACTIVE',
  /** Another import (any tenant) is APPLYING: one installation-wide freeze at a time. */
  'ANOTHER_IMPORT_APPLYING',
] as const;
export type LegacyMigrationBlocker = (typeof LEGACY_MIGRATION_BLOCKERS)[number];

export const LEGACY_MIGRATION_BACKUP_OUTCOMES = [
  'TAKEN',
  'BUSY',
  'SKIPPED_QUIESCED',
  'FAILED',
] as const;
export type LegacyMigrationBackupOutcome = (typeof LEGACY_MIGRATION_BACKUP_OUTCOMES)[number];

/**
 * The `migration` role's bookmark on the row. Each finished apply phase records its result
 * here BEFORE the next starts, so a resumed apply continues from the phase it reached rather
 * than repeating one (every phase is idempotent anyway; this makes it cheap and visible).
 */
export const legacyMigrationProgressSchema = z.object({
  phase: z.enum(LEGACY_MIGRATION_PHASES).nullable(),
  /** How many times the apply was started or resumed (a crash resumes, never fails). */
  applyAttempts: count,
  /**
   * How many times VERIFY and the DRY RUN were started (a crash runs them again, read-only);
   * bounded like the apply, so an error nobody classified cannot loop for ever.
   */
  verifyAttempts: count,
  dryRunAttempts: count,
  importerVerdict: z.string().nullable(),
  reconcileVerdict: z.enum(['RECONCILED', 'DISCREPANCY']).nullable(),
  /** Archived history records per record type (design §5). */
  history: z.array(legacyMigrationCodeCountSchema),
  /** Why a fresh-target check refused (design §6): the non-empty tables and their counts. */
  refusalCounts: z.array(legacyMigrationCodeCountSchema),
  backup: z.enum(LEGACY_MIGRATION_BACKUP_OUTCOMES).nullable(),
  /** What the role is waiting for, or null. */
  blocker: z.enum(LEGACY_MIGRATION_BLOCKERS).nullable(),
});
export type LegacyMigrationProgress = z.infer<typeof legacyMigrationProgressSchema>;

// --- responses ------------------------------------------------------------------------------

/** One import as the Web Admin sees it. No key, no path, no package content. */
export const legacyMigrationImportViewSchema = z.object({
  id: z.string(),
  status: legacyNxpkgImportStatusSchema,
  errorCode: legacyNxpkgErrorCodeSchema.nullable(),
  fileName: z.string(),
  fileSha256: hex64,
  fileBytes: decimal,
  packageImportId: z.string().nullable(),
  packageSourceFingerprint: z.string().nullable(),
  packageSchemaVersion: z.string().nullable(),
  converterVersion: z.string().nullable(),
  /** Whether a key is held (sealed). The key itself never leaves the server. */
  keyPresent: z.boolean(),
  keyKind: legacyNxpkgKeyKindSchema.nullable(),
  decisionsPresent: z.boolean(),
  panelBindings: z.array(legacyMigrationPanelBindingSchema).nullable(),
  verifyReport: legacyMigrationVerifyReportSchema.nullable(),
  dryRunReport: legacyMigrationDryRunReportSchema.nullable(),
  dryRunSha256: hex64.nullable(),
  approvedDryRunSha256: hex64.nullable(),
  applyReport: legacyMigrationApplyReportSchema.nullable(),
  dryRunLegacyRunId: z.string().nullable(),
  applyLegacyRunId: z.string().nullable(),
  backupRunId: z.string().nullable(),
  /**
   * The mandatory protective backup the executor took BEFORE the import wrote anything
   * (`backup_runs.id`, trigger `PRE_RESTORE`, verified). Restoring it on the recovery page is
   * how this import is undone. Null until taken.
   */
  preImportBackupRunId: z.string().nullable(),
  progress: legacyMigrationProgressSchema,
  /** The `migration` role holds the import right now. */
  working: z.boolean(),
  requestedByAdminId: z.string(),
  approvedByAdminId: z.string().nullable(),
  approvedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type LegacyMigrationImportView = z.infer<typeof legacyMigrationImportViewSchema>;

export const legacyMigrationImportResponseSchema = z.object({
  import: legacyMigrationImportViewSchema,
});
export type LegacyMigrationImportResponse = z.infer<typeof legacyMigrationImportResponseSchema>;

export const legacyMigrationImportListResponseSchema = z.object({
  imports: z.array(legacyMigrationImportViewSchema),
  nextCursor: z.string().nullable(),
});
export type LegacyMigrationImportListResponse = z.infer<
  typeof legacyMigrationImportListResponseSchema
>;

export const legacyMigrationCapabilitiesResponseSchema = z.object({
  enabled: z.boolean(),
  maxUploadBytes: z.number().int().positive(),
  maxDecisionsBytes: z.number().int().positive(),
  approvalPhrase: z.string(),
  /**
   * The destination looks like production (the importer's production guard): the existing
   * cutover approval (`/legacy-cutover`) must also be recorded before the import may run.
   */
  productionLikeTarget: z.boolean(),
  /**
   * Production-like only: the importer's target acknowledgement for this database and tenant
   * (a digest, not a secret). The owner's approval echoes it (`targetAcknowledgement`), which
   * is how the restore page confirms the target; the `migration` process's environment
   * (`NEXA_LEGACY_IMPORT_TARGET_ACK`) is still accepted for the CLI and the rehearsal kit.
   */
  targetAcknowledgement: z.string().nullable(),
});
export type LegacyMigrationCapabilitiesResponse = z.infer<
  typeof legacyMigrationCapabilitiesResponseSchema
>;
