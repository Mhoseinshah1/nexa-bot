/**
 * Database schema — legacy history: the invoice archive, wallet debts, service candidates, cutover approvals, .nxpkg imports, history records, compaction.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  LEGACY_COMPACTION_FAILURE_CODES,
  LEGACY_COMPACTION_STATES,
  LEGACY_INVOICE_ARCHIVE_CLASSES,
  LEGACY_WALLET_DEBT_CURRENCY,
  LEGACY_WALLET_DEBT_STATES,
  LEGACY_SERVICE_OUTCOMES,
  LEGACY_CUTOVER_APPROVAL_KINDS,
  LEGACY_CUTOVER_REASON_MAX_LENGTH,
  LEGACY_HISTORY_RECORD_TYPES,
  LEGACY_NXPKG_ERROR_CODES,
  LEGACY_NXPKG_IMPORT_STATUSES,
  LEGACY_NXPKG_KEY_KINDS,
  LEGACY_NXPKG_TERMINAL_STATUSES,
  LEGACY_SERVICE_REVIEW_STATES,
  LEGACY_INVOICE_PARSE_NOTES,
  LEGACY_INVOICE_PRODUCT_REFS,
  LEGACY_INVOICE_REVISION_REASONS,
} from '@nexa/contracts';
import { enumCheck, nullableEnumCheck, timestamptz } from './_shared.js';
import { tenants } from './tenancy.js';
import { admins } from './identity.js';
import { panels } from './panels.js';
import { customers } from './customers.js';
import { services } from './services.js';
import { legacyImportRuns, legacyInvoiceArchiveRuns } from './legacy-import.js';

/**
 * Mirza migration PR3 — the legacy invoice ARCHIVE: one row per REVISION of one legacy
 * `invoice` row, kept as read-only history. APPEND-ONLY (0224): no UPDATE and no DELETE,
 * whoever asks.
 *
 * - Keyed by (tenant, `id_invoice` exactly as read, revision). Any key shape is kept: an id
 *   outside the importer's evidenced shape (`INVOICE_KEY_INVALID`, which the import map
 *   cannot hold) is archived with `key_shape_evidenced = false`. Nothing is dropped.
 * - A newer snapshot appends revision n+1 only when `archive_checksum` (the cells AND their
 *   source-derived context) differs from revision n; an identical row writes nothing.
 * - `raw_row` is the cells VERBATIM; beside it the validated normalised fields, each from
 *   one named column by one deterministic rule, NULL with a closed note when the rule does
 *   not read it. The historical price is METADATA in IRT minor units (owner decision 7);
 *   `sold_at` is parsed only as unix seconds (the public sources' `time()`).
 * - `classification` is source-derived only; the CHECK restates its decision order, so a
 *   row whose class disagrees with its own facts cannot be written.
 *
 * NOT an order, a payment, a wallet entry, a service or revenue. Nothing here has a foreign
 * key to any of those, and nothing reads this table but the archive's own service.
 */
export const legacyInvoiceArchive = pgTable(
  'legacy_invoice_archive',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    runId: uuid('run_id').notNull(),
    /** The legacy `id_invoice` exactly as read. */
    invoiceKey: text('invoice_key').notNull(),
    revision: integer('revision').notNull(),
    revisionReason: text('revision_reason').notNull(),
    /** Whether the key has the importer's evidenced shape (`LEGACY_ID_PATTERNS.invoice`). */
    keyShapeEvidenced: boolean('key_shape_evidenced').notNull(),
    /** Column name to cell as read: lossless. */
    rawRow: jsonb('raw_row').notNull(),
    /** SHA-256 over the canonical cells. */
    rowChecksum: text('row_checksum').notNull(),
    /** SHA-256 over the cells AND the source-derived context: what a revision compares. */
    archiveChecksum: text('archive_checksum').notNull(),
    classification: text('classification').notNull(),
    live: boolean('live').notNull(),
    /** `Status` verbatim. */
    status: text('status'),
    /** `is_test` read as 1 → true, 0 → false; anything else NULL (TEST_FLAG_INVALID). */
    isTest: boolean('is_test'),
    /** `id_user` verbatim (PII: a Telegram id). */
    legacyUserId: text('legacy_user_id'),
    /** `id_user` names a row of the legacy `user` table of the same snapshot. */
    ownerPresent: boolean('owner_present').notNull(),
    /** `username` verbatim (PII: the legacy account name). */
    username: text('username'),
    /** `code_panel` trimmed; NULL when NULL or blank (owner decision 8: NO_PANEL). */
    panelCode: text('panel_code'),
    /** `code_product` trimmed; NULL when NULL or blank. */
    productCode: text('product_code'),
    productRef: text('product_ref').notNull(),
    productName: text('product_name'),
    priceRaw: text('price_raw'),
    /** Metadata only: whole Toman as IRT minor units. Never a price, a total or revenue. */
    priceMinor: bigint('price_minor', { mode: 'bigint' }),
    priceCurrency: text('price_currency'),
    priceNote: text('price_note'),
    soldAtRaw: text('sold_at_raw'),
    soldAt: timestamptz('sold_at'),
    soldAtNote: text('sold_at_note'),
    readSetFingerprint: text('read_set_fingerprint').notNull(),
    sourceFingerprint: text('source_fingerprint').notNull(),
    normalizationVersion: text('normalization_version').notNull(),
    archivedAt: timestamptz('archived_at').notNull(),
  },
  (table) => [
    unique('legacy_invoice_archive_tenant_id_key').on(table.tenantId, table.id),
    unique('legacy_invoice_archive_revision_key').on(
      table.tenantId,
      table.invoiceKey,
      table.revision,
    ),
    foreignKey({
      name: 'legacy_invoice_archive_run_fk',
      columns: [table.tenantId, table.runId],
      foreignColumns: [legacyInvoiceArchiveRuns.tenantId, legacyInvoiceArchiveRuns.id],
    }),
    index('legacy_invoice_archive_run_idx').on(table.tenantId, table.runId),
    index('legacy_invoice_archive_key_prefix_idx').on(
      table.tenantId,
      sql`invoice_key text_pattern_ops`,
    ),
    index('legacy_invoice_archive_user_idx').on(
      table.tenantId,
      table.legacyUserId,
      table.invoiceKey,
    ),
    index('legacy_invoice_archive_username_idx').on(
      table.tenantId,
      sql`lower(username) text_pattern_ops`,
    ),
    index('legacy_invoice_archive_status_idx').on(table.tenantId, table.status, table.invoiceKey),
    index('legacy_invoice_archive_panel_idx').on(table.tenantId, table.panelCode, table.invoiceKey),
    index('legacy_invoice_archive_product_idx').on(
      table.tenantId,
      table.productCode,
      table.invoiceKey,
    ),
    index('legacy_invoice_archive_class_idx').on(
      table.tenantId,
      table.classification,
      table.invoiceKey,
    ),
    index('legacy_invoice_archive_test_idx').on(table.tenantId, table.isTest, table.invoiceKey),
    check(
      'legacy_invoice_archive_class_check',
      sql`(${enumCheck('classification', LEGACY_INVOICE_ARCHIVE_CLASSES)}) AND classification = CASE WHEN NOT key_shape_evidenced THEN 'KEY_SHAPE_UNRECOGNISED' WHEN is_test IS TRUE THEN 'TEST' WHEN is_test IS NULL THEN 'TEST_FLAG_INVALID' WHEN NOT owner_present THEN 'ORPHAN_OWNER' WHEN NOT live THEN 'NOT_LIVE' WHEN panel_code IS NULL THEN 'NO_PANEL' ELSE 'LIVE_CANDIDATE' END`,
    ),
    check(
      'legacy_invoice_archive_revision_check',
      sql`revision >= 1 AND (${enumCheck('revision_reason', LEGACY_INVOICE_REVISION_REASONS)}) AND ((revision = 1) = (revision_reason = 'FIRST_SEEN'))`,
    ),
    check(
      'legacy_invoice_archive_product_check',
      sql`(${enumCheck('product_ref', LEGACY_INVOICE_PRODUCT_REFS)}) AND ((product_code IS NULL) = (product_ref = 'NONE'))`,
    ),
    check(
      'legacy_invoice_archive_price_check',
      sql`((price_minor IS NULL) = (price_currency IS NULL)) AND ((price_minor IS NULL) = (price_note IS NOT NULL)) AND (price_currency IS NULL OR price_currency = 'IRT') AND (price_minor IS NULL OR price_minor >= 0) AND (${nullableEnumCheck('price_note', LEGACY_INVOICE_PARSE_NOTES)})`,
    ),
    check(
      'legacy_invoice_archive_sold_at_check',
      sql`((sold_at IS NULL) = (sold_at_note IS NOT NULL)) AND (${nullableEnumCheck('sold_at_note', LEGACY_INVOICE_PARSE_NOTES)})`,
    ),
    check(
      'legacy_invoice_archive_shape_check',
      sql`jsonb_typeof(raw_row) = 'object' AND char_length(invoice_key) <= 1000 AND (panel_code IS NULL OR (panel_code <> '' AND panel_code = btrim(panel_code))) AND (product_code IS NULL OR (product_code <> '' AND product_code = btrim(product_code)))`,
    ),
    check(
      'legacy_invoice_archive_hashes_check',
      sql`row_checksum ~ '^[0-9a-f]{64}$' AND archive_checksum ~ '^[0-9a-f]{64}$' AND read_set_fingerprint ~ '^[0-9a-f]{64}$' AND source_fingerprint ~ '^[0-9a-f]{64}$' AND normalization_version ~ '^legacy-invoice-archive:v[1-9][0-9]{0,3}$'`,
    ),
  ],
);

/**
 * Mirza migration PR4 — a legacy wallet DEBT (owner decision 6, 2026-10-07;
 * `docs/migration-opening-balance.md` §Negative balances).
 *
 * A negative legacy `user.Balance` is held for review instead of becoming a ledger DEBIT:
 * this row records it — the exact magnitude owed, its currency, the legacy user id and the
 * snapshot it was read from — and the customer's NEXA balance starts at 0. It is NOT a
 * wallet entry and there is deliberately no foreign key to `wallet_entries`, orders or
 * payments: no balance, purchase, top-up, refund or clawback reads it, so nothing nets it
 * off. The owner's per-customer decision is a label (`state`) and moves no money.
 *
 * One debt per customer and per legacy user id (the importer's derived idempotency key,
 * like the opening reference). The recorded facts are immutable and the row is never
 * deleted (`0227`); only the decision columns move, by a conditional UPDATE naming its
 * `from` state at the version the operator saw.
 */
export const legacyWalletDebts = pgTable(
  'legacy_wallet_debts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /** The legacy `user.id`: the customer's own Telegram id (checked by the writer). */
    legacyUserId: text('legacy_user_id').notNull(),
    /** The MAGNITUDE owed, in minor units of `currency`. Always > 0. */
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** The v1 source fingerprint of the snapshot the debt was read from. */
    sourceFingerprint: text('source_fingerprint').notNull(),
    /** The legacy user row's `user:v1` checksum in that snapshot. */
    rowChecksum: text('row_checksum').notNull(),
    /** The APPLY run that recorded it. */
    runId: uuid('run_id').notNull(),
    /** The source carried the synthetic-fixture marker: test data, never a real debt. */
    synthetic: boolean('synthetic').notNull(),
    state: text('state').notNull(),
    decisionReason: text('decision_reason'),
    decidedByAdminId: uuid('decided_by_admin_id'),
    decidedAt: timestamptz('decided_at'),
    version: integer('version').notNull().default(1),
    recordedAt: timestamptz('recorded_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    unique('legacy_wallet_debts_tenant_id_key').on(table.tenantId, table.id),
    unique('legacy_wallet_debts_tenant_customer_key').on(table.tenantId, table.customerId),
    unique('legacy_wallet_debts_tenant_legacy_user_key').on(table.tenantId, table.legacyUserId),
    index('legacy_wallet_debts_tenant_state_idx').on(table.tenantId, table.state, table.id),
    foreignKey({
      name: 'legacy_wallet_debts_tenant_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'legacy_wallet_debts_tenant_run_fk',
      columns: [table.tenantId, table.runId],
      foreignColumns: [legacyImportRuns.tenantId, legacyImportRuns.id],
    }),
    foreignKey({
      name: 'legacy_wallet_debts_tenant_admin_fk',
      columns: [table.tenantId, table.decidedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    check('legacy_wallet_debts_state_check', enumCheck('state', LEGACY_WALLET_DEBT_STATES)),
    check(
      'legacy_wallet_debts_amount_check',
      sql`amount_minor > 0 AND currency = ${sql.raw(`'${LEGACY_WALLET_DEBT_CURRENCY}'`)}`,
    ),
    check(
      'legacy_wallet_debts_identity_check',
      sql`legacy_user_id ~ '^[1-9][0-9]{0,19}$' AND source_fingerprint ~ '^[0-9a-f]{64}$' AND row_checksum ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'legacy_wallet_debts_decision_check',
      sql`(state = 'PENDING_REVIEW' OR (decided_at IS NOT NULL AND decided_by_admin_id IS NOT NULL)) AND (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 1 AND 500) AND version >= 1`,
    ),
  ],
);

/**
 * Mirza migration PR5 — one live legacy invoice considered as a service, with the ONE
 * outcome the latest import run that decided it gave it, the evidence behind that outcome,
 * and the operator's review (`docs/legacy-migration/service-review.md`).
 *
 * The importer writes the outcome and evidence on every APPLY run (insert, or a conditional
 * update of this invoice's row — never a second row: `(tenant_id, invoice_key)` is unique).
 * The operator writes only the review columns, bound to `version`. An invoice that was not
 * adopted is history: `archive_id` names the invoice archive revision (PR3) it is kept in.
 * Codes, NEXA ids, counts and hashes only — never a legacy username, a Telegram id or a
 * subscription link (those stay in the archive, behind its own permission).
 */
export const legacyServiceCandidates = pgTable(
  'legacy_service_candidates',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** `invoice.id_invoice` as read (the archive's bound; any shape — a bad key is an outcome). */
    invoiceKey: text('invoice_key').notNull(),
    /** The APPLY run that last decided it. */
    runId: uuid('run_id').notNull(),
    sourceFingerprint: text('source_fingerprint').notNull(),
    /** The source carried the synthetic-fixture marker. Never acted on in production. */
    synthetic: boolean('synthetic').notNull(),
    /** The importer's `invoice:v1` checksum of the source row that run decided from. */
    invoiceChecksum: text('invoice_checksum').notNull(),
    outcome: text('outcome').notNull(),
    /** The raw map or adoption reason behind the outcome, when there is one. */
    blocker: text('blocker'),
    /** `LegacyServiceEvidence` (codes, NEXA ids, counts). */
    evidence: jsonb('evidence').notNull(),
    /** sha256 of the canonical evidence: a change of evidence is a new version. */
    evidenceHash: text('evidence_hash').notNull(),
    /** The legacy `code_panel` / `code_product`, trimmed as the importer reads them. */
    panelCode: text('panel_code'),
    productCode: text('product_code'),
    /** The invoice archive revision this candidate is history in (null: not archived yet). */
    archiveId: uuid('archive_id'),
    /** The adopted NEXA service: exactly when the outcome is ADOPTED or ALREADY_ADOPTED. */
    serviceId: uuid('service_id'),
    reviewState: text('review_state').notNull(),
    /** An ADOPT approval: the panel named (null: the map's), and what it was bound to. */
    approvedPanelId: uuid('approved_panel_id'),
    approvedChecksum: text('approved_checksum'),
    approvedOutcome: text('approved_outcome'),
    /** Why the last approval was not executed (an outcome or an approval refusal code). */
    lastApprovalRefusal: text('last_approval_refusal'),
    decisionReason: text('decision_reason'),
    decidedByAdminId: uuid('decided_by_admin_id'),
    decidedAt: timestamptz('decided_at'),
    /** When the inventory walk that decided it finished; null when no inventory was read. */
    observedAt: timestamptz('observed_at'),
    version: integer('version').notNull().default(1),
    firstDecidedAt: timestamptz('first_decided_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    unique('legacy_service_candidates_tenant_id_key').on(table.tenantId, table.id),
    unique('legacy_service_candidates_tenant_invoice_key').on(table.tenantId, table.invoiceKey),
    index('legacy_service_candidates_outcome_idx').on(table.tenantId, table.outcome, table.id),
    index('legacy_service_candidates_review_idx').on(table.tenantId, table.reviewState, table.id),
    index('legacy_service_candidates_panel_idx').on(table.tenantId, table.panelCode, table.id),
    index('legacy_service_candidates_product_idx').on(table.tenantId, table.productCode, table.id),
    foreignKey({
      name: 'legacy_service_candidates_tenant_run_fk',
      columns: [table.tenantId, table.runId],
      foreignColumns: [legacyImportRuns.tenantId, legacyImportRuns.id],
    }),
    foreignKey({
      name: 'legacy_service_candidates_tenant_archive_fk',
      columns: [table.tenantId, table.archiveId],
      foreignColumns: [legacyInvoiceArchive.tenantId, legacyInvoiceArchive.id],
    }),
    foreignKey({
      name: 'legacy_service_candidates_tenant_service_fk',
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
    }),
    foreignKey({
      name: 'legacy_service_candidates_tenant_panel_fk',
      columns: [table.tenantId, table.approvedPanelId],
      foreignColumns: [panels.tenantId, panels.id],
    }),
    foreignKey({
      name: 'legacy_service_candidates_tenant_admin_fk',
      columns: [table.tenantId, table.decidedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    check('legacy_service_candidates_outcome_check', enumCheck('outcome', LEGACY_SERVICE_OUTCOMES)),
    check(
      'legacy_service_candidates_review_state_check',
      enumCheck('review_state', LEGACY_SERVICE_REVIEW_STATES),
    ),
    check(
      'legacy_service_candidates_adopted_check',
      sql`((service_id IS NOT NULL) = (outcome IN ('ADOPTED', 'ALREADY_ADOPTED'))) AND ((review_state = 'ADOPTED') = (outcome IN ('ADOPTED', 'ALREADY_ADOPTED')))`,
    ),
    check(
      'legacy_service_candidates_approval_check',
      sql`((approved_checksum IS NOT NULL) = (review_state IN ('ADOPT_APPROVED', 'ADOPTING'))) AND ((approved_outcome IS NOT NULL) = (approved_checksum IS NOT NULL)) AND (approved_panel_id IS NULL OR approved_checksum IS NOT NULL) AND (approved_outcome IS NULL OR approved_outcome IN (${sql.raw(LEGACY_SERVICE_OUTCOMES.map((o) => `'${o}'`).join(', '))}))`,
    ),
    check(
      'legacy_service_candidates_decision_check',
      sql`(review_state NOT IN ('ACKNOWLEDGED', 'KEPT_AS_HISTORY', 'ADOPT_APPROVED', 'ADOPTING') OR (decided_at IS NOT NULL AND decided_by_admin_id IS NOT NULL AND decision_reason IS NOT NULL)) AND (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 1 AND 500) AND version >= 1`,
    ),
    check(
      'legacy_service_candidates_shape_check',
      sql`char_length(invoice_key) BETWEEN 1 AND 1000 AND (panel_code IS NULL OR (panel_code <> '' AND panel_code = btrim(panel_code) AND char_length(panel_code) <= 1000)) AND (product_code IS NULL OR (product_code <> '' AND product_code = btrim(product_code) AND char_length(product_code) <= 1000)) AND jsonb_typeof(evidence) = 'object' AND (blocker IS NULL OR blocker ~ '^[A-Z_]{1,64}$') AND (last_approval_refusal IS NULL OR last_approval_refusal ~ '^[A-Z_]{1,64}$')`,
    ),
    check(
      'legacy_service_candidates_hashes_check',
      sql`source_fingerprint ~ '^[0-9a-f]{64}$' AND invoice_checksum ~ '^[0-9a-f]{64}$' AND evidence_hash ~ '^[0-9a-f]{64}$' AND (approved_checksum IS NULL OR approved_checksum ~ '^[0-9a-f]{64}$')`,
    ),
  ],
);

/**
 * Mirza migration PR6 — the owner's approval of ONE legacy snapshot for import (owner
 * constraint 3; `docs/legacy-migration/cutover-runbook.md` §Owner approval).
 *
 * Bound to seven exact values: the v1 source fingerprint, the panel-map fingerprint, the
 * three read-set fingerprints (each recorded in `legacy_read_set_runs` for that source when
 * the approval was made), the freeze proof file's SHA-256 and the final dump's SHA-256. A
 * production-like import refuses without an UNREVOKED row matching every value it is given
 * — so a changed value is no approval at all. `RERUN_OVER_PRIOR_IMPORT` additionally names
 * the earlier source a re-run goes over (SOURCE_SUPERSEDED otherwise).
 *
 * Who and when are the authenticated owner and the Clock — never a typed name. Append-only
 * (`0234`): a row is never edited or deleted; it is withdrawn by a row in
 * `legacy_cutover_approval_revocations`. Fingerprints and digests only — no legacy row.
 */
export const legacyCutoverApprovals = pgTable(
  'legacy_cutover_approvals',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    sourceFingerprint: text('source_fingerprint').notNull(),
    panelMapFingerprint: text('panel_map_fingerprint').notNull(),
    inventoryFingerprint: text('inventory_fingerprint').notNull(),
    productsFingerprint: text('products_fingerprint').notNull(),
    invoiceArchiveFingerprint: text('invoice_archive_fingerprint').notNull(),
    freezeProofSha256: text('freeze_proof_sha256').notNull(),
    finalDumpSha256: text('final_dump_sha256').notNull(),
    /** RERUN_OVER_PRIOR_IMPORT only: the earlier source this re-run goes over. */
    priorSourceFingerprint: text('prior_source_fingerprint'),
    /** The read sets it binds were read from a SYNTHETIC-marked source. */
    synthetic: boolean('synthetic').notNull(),
    reason: text('reason').notNull(),
    approvedByAdminId: uuid('approved_by_admin_id').notNull(),
    approvedAt: timestamptz('approved_at').notNull(),
  },
  (table) => [
    unique('legacy_cutover_approvals_tenant_id_key').on(table.tenantId, table.id),
    index('legacy_cutover_approvals_tenant_source_idx').on(
      table.tenantId,
      table.sourceFingerprint,
      table.id,
    ),
    foreignKey({
      name: 'legacy_cutover_approvals_tenant_admin_fk',
      columns: [table.tenantId, table.approvedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    check('legacy_cutover_approvals_kind_check', enumCheck('kind', LEGACY_CUTOVER_APPROVAL_KINDS)),
    check(
      'legacy_cutover_approvals_hashes_check',
      sql`source_fingerprint ~ '^[0-9a-f]{64}$' AND panel_map_fingerprint ~ '^[0-9a-f]{64}$' AND inventory_fingerprint ~ '^[0-9a-f]{64}$' AND products_fingerprint ~ '^[0-9a-f]{64}$' AND invoice_archive_fingerprint ~ '^[0-9a-f]{64}$' AND freeze_proof_sha256 ~ '^[0-9a-f]{64}$' AND final_dump_sha256 ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'legacy_cutover_approvals_prior_check',
      sql`CASE kind WHEN 'CUTOVER' THEN prior_source_fingerprint IS NULL ELSE prior_source_fingerprint ~ '^[0-9a-f]{64}$' AND prior_source_fingerprint <> source_fingerprint END`,
    ),
    check(
      'legacy_cutover_approvals_reason_check',
      sql`char_length(reason) BETWEEN 1 AND ${sql.raw(String(LEGACY_CUTOVER_REASON_MAX_LENGTH))}`,
    ),
  ],
);

/**
 * Mirza migration PR6 — the withdrawal of one cutover approval: at most one per approval,
 * by the authenticated owner. Append-only (`0234`), so a withdrawn approval stays on the
 * record as withdrawn and can never be un-withdrawn; a new approval is a new row.
 */
export const legacyCutoverApprovalRevocations = pgTable(
  'legacy_cutover_approval_revocations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    approvalId: uuid('approval_id').notNull(),
    reason: text('reason').notNull(),
    revokedByAdminId: uuid('revoked_by_admin_id').notNull(),
    revokedAt: timestamptz('revoked_at').notNull(),
  },
  (table) => [
    unique('legacy_cutover_approval_revocations_approval_key').on(table.tenantId, table.approvalId),
    foreignKey({
      name: 'legacy_cutover_approval_revocations_approval_fk',
      columns: [table.tenantId, table.approvalId],
      foreignColumns: [legacyCutoverApprovals.tenantId, legacyCutoverApprovals.id],
    }),
    foreignKey({
      name: 'legacy_cutover_approval_revocations_tenant_admin_fk',
      columns: [table.tenantId, table.revokedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    check(
      'legacy_cutover_approval_revocations_reason_check',
      sql`char_length(reason) BETWEEN 1 AND ${sql.raw(String(LEGACY_CUTOVER_REASON_MAX_LENGTH))}`,
    ),
  ],
);

/**
 * Mirza `.nxpkg` importer — one uploaded package and its Fresh Migration
 * (`docs/legacy-migration/nxpkg-importer.md` §4).
 *
 * The web surface uploads, records the key, the panel bindings and the decisions file, and
 * shows progress; the `migration` process role does the work by polling this table with a
 * lease (`claimed_by`, `lease_until`), the recovery pattern (ADR-0028). Every state change
 * is a conditional UPDATE naming its `from` states.
 *
 * The package key is sealed with the installation keyring (`legacy_migration.package_key`, AAD
 * bound to this row) and erased when the import reaches a terminal state; it is never
 * logged, returned or audited. The reports are counts, codes and digests — `manifest_summary`
 * carries no personal data. An APPLY is bound to `approved_dry_run_sha256`, which the owner
 * approved under the CRITICAL `legacy.migration.apply`.
 *
 * At most one non-terminal import per tenant (a partial unique index). Never deleted (`0242`):
 * it is the provenance every history record names.
 */
export const legacyNxpkgImports = pgTable(
  'legacy_nxpkg_imports',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    status: text('status').notNull(),
    /** What the browser called the file. Recorded, bounded, and acted on nowhere. */
    fileName: text('file_name').notNull(),
    /** Where the encrypted package lives on the installation's own disk. */
    filePath: text('file_path').notNull(),
    /** SHA-256 of the ENCRYPTED package as received: what verify, approve and apply bind to. */
    fileSha256: text('file_sha256').notNull(),
    fileBytes: bigint('file_bytes', { mode: 'bigint' }).notNull(),
    /** From the authenticated manifest, once verified. */
    packageImportId: text('package_import_id'),
    packageSourceFingerprint: text('package_source_fingerprint'),
    packageSchemaVersion: text('package_schema_version'),
    converterVersion: text('converter_version'),
    /** Counts and versions from the manifest. Never personal data. */
    manifestSummary: jsonb('manifest_summary'),
    /** The package key, sealed (`legacy_migration.package_key`). NULL once terminal. */
    keyCiphertext: text('key_ciphertext'),
    keyKeyId: text('key_key_id'),
    keyKind: text('key_kind'),
    /** The converter's `ownership-decisions.json`, when one was given (§7). */
    decisionsFilePath: text('decisions_file_path'),
    decisionsSummary: jsonb('decisions_summary'),
    /** `code_panel` → NEXA panel id, as the operator chose them. */
    panelBindings: jsonb('panel_bindings'),
    verifyReport: jsonb('verify_report'),
    dryRunReport: jsonb('dry_run_report'),
    /** SHA-256 of the canonical dry-run report. */
    dryRunSha256: text('dry_run_sha256'),
    /** The dry-run digest the owner approved; APPLY refuses any other (`DRY_RUN_MISMATCH`). */
    approvedDryRunSha256: text('approved_dry_run_sha256'),
    applyReport: jsonb('apply_report'),
    /**
     * The "adopt approved" lane's counts (`legacyMigrationAdoptReportSchema`,
     * `docs/legacy-migration/service-review.md` §4b), set with ADOPT_DONE. Codes and counts.
     */
    adoptReport: jsonb('adopt_report'),
    dryRunLegacyRunId: uuid('dry_run_legacy_run_id'),
    applyLegacyRunId: uuid('apply_legacy_run_id'),
    /** The lane's own `ADOPT_APPROVED` run (none when no approval was waiting). */
    adoptLegacyRunId: uuid('adopt_legacy_run_id'),
    /** The standard backup requested after COMPLETED (`backup_runs.id`; no FK — rows are purged). */
    backupRunId: uuid('backup_run_id'),
    /**
     * Phase 7: the mandatory protective backup (`backup_runs.id`, trigger `PRE_RESTORE`,
     * verified) taken BEFORE the import writes anything. Set in the same UPDATE that moves the
     * import APPROVED → APPLYING, so an APPLYING row always names one and a resume never takes
     * a second. No FK, as `backup_run_id`: backup rows are purged by retention.
     */
    preImportBackupRunId: uuid('pre_import_backup_run_id'),
    /**
     * Phase 7: the importer's target acknowledgement the OWNER's approval carried (16 hex,
     * production-like targets only). The executor accepts it, when it is still this
     * installation's own, in place of the process's `NEXA_LEGACY_IMPORT_TARGET_ACK`.
     */
    targetAck: text('target_ack'),
    progress: jsonb('progress')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** A value from `LEGACY_NXPKG_ERROR_CODES`. Never a message. */
    errorCode: text('error_code'),
    requestedByAdminId: uuid('requested_by_admin_id').notNull(),
    approvedByAdminId: uuid('approved_by_admin_id'),
    approvedAt: timestamptz('approved_at'),
    /** The worker lease: two `migration` replicas are the normal case on a rolling update. */
    claimedBy: text('claimed_by'),
    leaseUntil: timestamptz('lease_until'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
    finishedAt: timestamptz('finished_at'),
  },
  (table) => [
    unique('legacy_nxpkg_imports_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('legacy_nxpkg_imports_one_active_idx')
      .on(table.tenantId)
      .where(sql`NOT (${enumCheck('status', LEGACY_NXPKG_TERMINAL_STATUSES)})`),
    /*
     * Phase 7 (review M4): at most ONE import APPLYING in the whole installation, whatever
     * the tenant — each one freezes every write, and the write gate's exemption names one
     * import. The executor checks first (blocker `ANOTHER_IMPORT_APPLYING`); this is the
     * database's rule for a writer that does not.
     */
    uniqueIndex('legacy_nxpkg_imports_one_applying_idx')
      .on(table.status)
      .where(sql`status = 'APPLYING'`),
    index('legacy_nxpkg_imports_poll_idx').on(table.status, table.leaseUntil),
    index('legacy_nxpkg_imports_tenant_created_idx').on(table.tenantId, table.createdAt),
    foreignKey({
      name: 'legacy_nxpkg_imports_tenant_requested_by_fk',
      columns: [table.tenantId, table.requestedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    foreignKey({
      name: 'legacy_nxpkg_imports_tenant_approved_by_fk',
      columns: [table.tenantId, table.approvedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    foreignKey({
      name: 'legacy_nxpkg_imports_tenant_dry_run_fk',
      columns: [table.tenantId, table.dryRunLegacyRunId],
      foreignColumns: [legacyImportRuns.tenantId, legacyImportRuns.id],
    }),
    foreignKey({
      name: 'legacy_nxpkg_imports_tenant_apply_run_fk',
      columns: [table.tenantId, table.applyLegacyRunId],
      foreignColumns: [legacyImportRuns.tenantId, legacyImportRuns.id],
    }),
    foreignKey({
      name: 'legacy_nxpkg_imports_tenant_adopt_run_fk',
      columns: [table.tenantId, table.adoptLegacyRunId],
      foreignColumns: [legacyImportRuns.tenantId, legacyImportRuns.id],
    }),
    /**
     * The lane's result exists exactly on a finished lane, and a lane is never an import: an
     * ADOPT_* row carries no approval, no apply run and no protective backup.
     */
    check(
      'legacy_nxpkg_imports_adopt_check',
      sql`((status = 'ADOPT_DONE') = (adopt_report IS NOT NULL)) AND (adopt_legacy_run_id IS NULL OR adopt_report IS NOT NULL) AND (status NOT IN ('ADOPT_REQUESTED', 'ADOPT_RUNNING', 'ADOPT_DONE') OR (approved_at IS NULL AND apply_legacy_run_id IS NULL AND pre_import_backup_run_id IS NULL))`,
    ),
    check('legacy_nxpkg_imports_status_check', enumCheck('status', LEGACY_NXPKG_IMPORT_STATUSES)),
    check(
      'legacy_nxpkg_imports_error_code_check',
      sql`(${nullableEnumCheck('error_code', LEGACY_NXPKG_ERROR_CODES)}) AND ((status IN ('VERIFY_FAILED', 'DRY_RUN_FAILED', 'FAILED', 'CANCELLED')) = (error_code IS NOT NULL))`,
    ),
    check(
      'legacy_nxpkg_imports_key_check',
      sql`(${nullableEnumCheck('key_kind', LEGACY_NXPKG_KEY_KINDS)}) AND ((key_ciphertext IS NULL) = (key_key_id IS NULL)) AND (key_ciphertext IS NULL OR key_kind IS NOT NULL)`,
    ),
    check(
      'legacy_nxpkg_imports_hashes_check',
      sql`file_sha256 ~ '^[0-9a-f]{64}$' AND (dry_run_sha256 IS NULL OR dry_run_sha256 ~ '^[0-9a-f]{64}$') AND (approved_dry_run_sha256 IS NULL OR approved_dry_run_sha256 ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      'legacy_nxpkg_imports_approval_check',
      sql`((approved_dry_run_sha256 IS NULL) = (approved_at IS NULL)) AND ((approved_at IS NULL) = (approved_by_admin_id IS NULL)) AND (status NOT IN ('APPROVED', 'APPLYING', 'COMPLETED', 'COMPLETED_WITH_DISCREPANCY') OR approved_at IS NOT NULL)`,
    ),
    check(
      'legacy_nxpkg_imports_lifecycle_check',
      sql`(finished_at IS NOT NULL) = (${enumCheck('status', LEGACY_NXPKG_TERMINAL_STATUSES)})`,
    ),
    check(
      'legacy_nxpkg_imports_pre_import_backup_check',
      sql`(target_ack IS NULL OR target_ack ~ '^[0-9a-f]{16}$') AND (status <> 'APPLYING' OR pre_import_backup_run_id IS NOT NULL)`,
    ),
    check(
      'legacy_nxpkg_imports_lease_check',
      sql`(claimed_by IS NULL) = (lease_until IS NULL) AND (claimed_by IS NULL OR char_length(claimed_by) BETWEEN 1 AND 200)`,
    ),
    check(
      'legacy_nxpkg_imports_shape_check',
      sql`char_length(file_name) BETWEEN 1 AND 255 AND char_length(file_path) BETWEEN 1 AND 4096 AND file_bytes > 0 AND (decisions_file_path IS NULL OR char_length(decisions_file_path) BETWEEN 1 AND 4096) AND (package_import_id IS NULL OR char_length(package_import_id) BETWEEN 1 AND 200) AND (package_source_fingerprint IS NULL OR char_length(package_source_fingerprint) BETWEEN 1 AND 200) AND (package_schema_version IS NULL OR char_length(package_schema_version) BETWEEN 1 AND 64) AND (converter_version IS NULL OR char_length(converter_version) BETWEEN 1 AND 64) AND jsonb_typeof(progress) = 'object'`,
    ),
  ],
);

/**
 * Mirza `.nxpkg` importer — one archived Mirza record (design §5): visible history, never
 * operational and never money. Nothing reads it to change a balance, an order, a service or
 * a role. `payload` is the record exactly as packaged.
 *
 * Written once per `(tenant, package import, idempotency key)` — a resumed ingest continues
 * by that key and writes nothing twice. `customer_id` is resolved through
 * `legacy_import_map` when the record is written (after the customers phase). Append-only
 * (`0242`): never updated, never deleted.
 */
export const legacyHistoryRecords = pgTable(
  'legacy_history_records',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    nxpkgImportId: uuid('nxpkg_import_id').notNull(),
    /** The package's own `import_id` (manifest). */
    packageImportId: text('package_import_id').notNull(),
    recordType: text('record_type').notNull(),
    /** `legacy:<…>`, derived from the record's provenance. */
    idempotencyKey: text('idempotency_key').notNull(),
    /** The legacy `user.id` the record belongs to, as packaged (PII: a Telegram id). */
    legacyUserId: text('legacy_user_id'),
    customerId: uuid('customer_id'),
    occurredAt: timestamptz('occurred_at'),
    payload: jsonb('payload').notNull(),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    unique('legacy_history_records_idempotency_key').on(
      table.tenantId,
      table.packageImportId,
      table.idempotencyKey,
    ),
    index('legacy_history_records_customer_idx').on(table.tenantId, table.customerId),
    index('legacy_history_records_legacy_user_idx').on(table.tenantId, table.legacyUserId),
    index('legacy_history_records_type_idx').on(table.tenantId, table.recordType),
    index('legacy_history_records_import_idx').on(table.tenantId, table.nxpkgImportId),
    foreignKey({
      name: 'legacy_history_records_tenant_import_fk',
      columns: [table.tenantId, table.nxpkgImportId],
      foreignColumns: [legacyNxpkgImports.tenantId, legacyNxpkgImports.id],
    }),
    foreignKey({
      name: 'legacy_history_records_tenant_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    check(
      'legacy_history_records_type_check',
      enumCheck('record_type', LEGACY_HISTORY_RECORD_TYPES),
    ),
    check(
      'legacy_history_records_shape_check',
      sql`idempotency_key LIKE 'legacy:%' AND char_length(idempotency_key) BETWEEN 8 AND 512 AND char_length(package_import_id) BETWEEN 1 AND 200 AND (legacy_user_id IS NULL OR char_length(legacy_user_id) BETWEEN 1 AND 64) AND jsonb_typeof(payload) = 'object'`,
    ),
  ],
);

/**
 * The compaction of the imported legacy data (Round 4 PR-E, E1): one row per run, the
 * worker's durable, resumable state. `cursor` is the last id the current stage committed,
 * so a restarted worker resumes the batch after it; `archive_backup_id` is the
 * «آرشیو ربات قبلی» backup that MUST be delivered in full before anything is deleted;
 * `before`/`after` are the report (sizes per table, rows per record type). Every state
 * change is a conditional UPDATE naming its `from` state. One active run per tenant.
 */
export const legacyCompactionRuns = pgTable(
  'legacy_compaction_runs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    state: text('state').notNull(),
    requestedAt: timestamptz('requested_at').notNull(),
    requestedByAdminId: uuid('requested_by_admin_id').references(() => admins.id),
    requestedByLabel: text('requested_by_label'),
    updatedAt: timestamptz('updated_at').notNull(),
    leaseOwner: text('lease_owner'),
    leaseHeartbeatAt: timestamptz('lease_heartbeat_at'),
    archiveBackupId: uuid('archive_backup_id'),
    cursor: uuid('cursor'),
    deleted: bigint('deleted', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    deduplicated: bigint('deduplicated', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    stripped: bigint('stripped', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    before: jsonb('before'),
    after: jsonb('after'),
    failureCode: text('failure_code'),
    finishedAt: timestamptz('finished_at'),
  },
  (table) => [
    check('legacy_compaction_runs_state_check', enumCheck('state', LEGACY_COMPACTION_STATES)),
    check(
      'legacy_compaction_runs_failure_code_check',
      enumCheck('failure_code', LEGACY_COMPACTION_FAILURE_CODES),
    ),
    check(
      'legacy_compaction_runs_finished_check',
      sql`(state IN ('COMPLETED', 'FAILED')) = (finished_at IS NOT NULL)`,
    ),
    uniqueIndex('legacy_compaction_runs_one_active_idx')
      .on(table.tenantId)
      .where(sql`state NOT IN ('COMPLETED', 'FAILED')`),
    index('legacy_compaction_runs_tenant_requested_idx').on(table.tenantId, table.requestedAt),
  ],
);
