/**
 * Database schema — legacy import: product shapes, trial eligibility, import runs and map, read sets, product reviews, invoice archive runs.
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
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  ACTOR_TYPES,
  LEGACY_SHAPE_RESOLUTIONS,
  LEGACY_SHAPE_TARIFF_STATUSES,
  LEGACY_SHAPE_UNRESOLVED_REASONS,
  LEGACY_TRIAL_DECISIONS,
  LEGACY_IMPORT_ENTITY_TYPES,
  LEGACY_IMPORT_MAP_STATUSES,
  LEGACY_IMPORT_REASON_CODES,
  LEGACY_IMPORT_RUN_FAILURE_CODES,
  LEGACY_IMPORT_RUN_MODES,
  LEGACY_READ_SET_NAMES,
  LEGACY_PRODUCT_REVIEW_STATES,
  LEGACY_PRODUCT_REVIEW_DECIDED_STATES,
  LEGACY_PRODUCT_SOURCE_CONFLICTS,
  LEGACY_INVOICE_ARCHIVE_RUN_FAILURES,
  LEGACY_INVOICE_ARCHIVE_RUN_STATES,
  LEGACY_IMPORT_RUN_STATUSES,
  LEGACY_IMPORT_SOURCE_TABLES,
  LEGACY_REVIEW_REASON_CODES,
  LEGACY_REVIEW_RESOLUTION_CODES,
  LEGACY_REVIEW_RESOLUTION_STATE,
  LEGACY_REVIEW_STATES,
} from '@nexa/contracts';
import { enumCheck, nullableEnumCheck, timestamptz } from './_shared.js';
import { tenants } from './tenancy.js';
import { admins } from './identity.js';
import { customers } from './customers.js';
import { products } from './catalogue.js';

/**
 * A hidden legacy product shape (program Item 14,
 * `docs/legacy-migration/hidden-legacy-products.md`).
 *
 * One row per tenant per canonical legacy tariff shape — `(code_panel, volume,
 * service_time, time_unit, is_custom)` reduced by `legacyShapeKey` — and the ONE hidden
 * product that stands for it. A legacy service whose invoice named no product will, in
 * P6, reference that product, so it renews through the ordinary renewal path and the one
 * pricing boundary. There is no second productless pricing system.
 *
 * `price_product` is deliberately absent. It is a historical purchase snapshot and the
 * owner decided renewals are at the CURRENT NEXA tariff, so two invoices of one shape at
 * two historical prices are one shape and one product, and no column here could become a
 * permanent price lock.
 *
 * The product is created INACTIVE, HIDDEN, unpriced and uncategorised. `tariff_status`
 * `UNRESOLVED` is the explicit manual-review state: nothing of this shape is adoptable
 * until a current tariff is resolved. Uncategorised is structural, not cosmetic: an
 * order for a NEW service refuses a product with no category (`NOT_CATEGORISED`), while a
 * renewal reads the service's own product, so the row renews and is never sold new — and
 * `nexa_legacy_shape_product_hidden` refuses an edit that would categorise or list it.
 */
export const legacyProductShapes = pgTable(
  'legacy_product_shapes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** `legacyShapeKey`'s output: versioned, deterministic, price-free. */
    shapeKey: text('shape_key').notNull(),
    /** The legacy panel CODE (e.g. `bac6`), trimmed; NULL when the invoice named none. */
    legacyCodePanel: text('legacy_code_panel'),
    trafficBytes: bigint('traffic_bytes', { mode: 'bigint' }).notNull(),
    durationDays: integer('duration_days').notNull(),
    isCustom: boolean('is_custom').notNull(),
    /** The hidden product standing for this shape. One shape, one product, both ways. */
    productId: uuid('product_id').notNull(),
    tariffStatus: text('tariff_status').notNull().default('UNRESOLVED'),
    unresolvedReason: text('unresolved_reason').default('NOT_YET_RESOLVED'),
    resolution: text('resolution'),
    /** For `MATCHED_PUBLIC_PRODUCT`: the public product whose current price was taken. */
    tariffSourceProductId: uuid('tariff_source_product_id'),
    resolvedAt: timestamptz('resolved_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** The idempotent ensure: one shape per tenant, whatever the rerun. */
    uniqueIndex('legacy_product_shapes_tenant_key').on(table.tenantId, table.shapeKey),
    uniqueIndex('legacy_product_shapes_tenant_product_key').on(table.tenantId, table.productId),
    index('legacy_product_shapes_tenant_status_idx').on(
      table.tenantId,
      table.tariffStatus,
      table.id,
    ),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'legacy_product_shapes_product_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.tariffSourceProductId],
      foreignColumns: [products.tenantId, products.id],
      name: 'legacy_product_shapes_source_fk',
    }),
    check(
      'legacy_product_shapes_tariff_status_check',
      enumCheck('tariff_status', LEGACY_SHAPE_TARIFF_STATUSES),
    ),
    check(
      'legacy_product_shapes_unresolved_reason_check',
      nullableEnumCheck('unresolved_reason', LEGACY_SHAPE_UNRESOLVED_REASONS),
    ),
    check(
      'legacy_product_shapes_resolution_check',
      nullableEnumCheck('resolution', LEGACY_SHAPE_RESOLUTIONS),
    ),
    /** UNRESOLVED carries a reason and nothing else; RESOLVED carries how and when. */
    check(
      'legacy_product_shapes_state_check',
      sql`(tariff_status = 'UNRESOLVED'
            AND unresolved_reason IS NOT NULL AND resolution IS NULL
            AND resolved_at IS NULL AND tariff_source_product_id IS NULL)
       OR (tariff_status = 'RESOLVED'
            AND unresolved_reason IS NULL AND resolution IS NOT NULL AND resolved_at IS NOT NULL
            AND (resolution = 'MATCHED_PUBLIC_PRODUCT') = (tariff_source_product_id IS NOT NULL))`,
    ),
    check(
      'legacy_product_shapes_amounts_check',
      sql`traffic_bytes > 0 AND duration_days > 0 AND duration_days <= 3650`,
    ),
    check(
      'legacy_product_shapes_key_check',
      sql`length(shape_key) BETWEEN 1 AND 512 AND (legacy_code_panel IS NULL OR length(btrim(legacy_code_panel)) > 0)`,
    ),
  ],
);

/**
 * What the migration decided about one legacy customer's trial entitlement (program
 * Item 15, `docs/legacy-migration/trial-eligibility.md`).
 *
 * The provenance of a `trial_limit_overrides` row the migration wrote, or of its decision
 * NOT to write one. There is no second trial subsystem: a claim still decides with
 * `trialAllowanceFor` over the override and the grants; this table explains why the
 * override is what it is, and makes the decision once.
 *
 * Written once per customer and never updated: a rerun with the same legacy facts is a
 * replay, and a rerun with different ones is reported as a conflict and changes nothing —
 * in particular an override an operator removed after the import is not re-imposed. The
 * legacy facts are stored as values (`limit_usertest`, whether a test invoice existed),
 * never the legacy row or the Telegram id.
 */
export const legacyTrialEligibility = pgTable(
  'legacy_trial_eligibility',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /** The legacy `user.limit_usertest`, or NULL when it was not a whole number. */
    legacyLimitUsertest: integer('legacy_limit_usertest'),
    /** Whether the legacy archive held a test invoice for this user, in any status. */
    legacyHadTrial: boolean('legacy_had_trial').notNull(),
    decision: text('decision').notNull(),
    /** The customer's NEXA override before the decision, and after it. */
    overrideBefore: integer('override_before'),
    overrideAfter: integer('override_after'),
    /** SHA-256 of the normalised legacy facts: a rerun with other facts is a conflict. */
    inputHash: text('input_hash').notNull(),
    recordedAt: timestamptz('recorded_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'legacy_trial_eligibility_pkey',
      columns: [table.tenantId, table.customerId],
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'legacy_trial_eligibility_customer_fk',
    }),
    index('legacy_trial_eligibility_tenant_decision_idx').on(
      table.tenantId,
      table.decision,
      table.customerId,
    ),
    check('legacy_trial_eligibility_decision_check', enumCheck('decision', LEGACY_TRIAL_DECISIONS)),
    /** The decision and the override it left agree, so the row cannot misexplain it. */
    check(
      'legacy_trial_eligibility_effect_check',
      sql`(decision IN ('LEGACY_NO_TRIALS', 'LEGACY_TRIAL_CONSUMED', 'LEGACY_LIMIT_UNREADABLE')
            AND override_before IS NULL AND override_after = 0)
       OR (decision = 'INHERIT_NEXA_POLICY' AND override_before IS NULL AND override_after IS NULL)
       OR (decision = 'KEPT_EXISTING_OVERRIDE'
            AND override_before IS NOT NULL AND override_after = override_before)`,
    ),
    /** An unreadable limit is NULL, and every decision drawn from the limit had one. */
    check(
      'legacy_trial_eligibility_limit_check',
      sql`decision = 'KEPT_EXISTING_OVERRIDE'
       OR (decision = 'LEGACY_LIMIT_UNREADABLE') = (legacy_limit_usertest IS NULL)`,
    ),
    check('legacy_trial_eligibility_hash_check', sql`input_hash ~ '^[0-9a-f]{64}$'`),
  ],
);

// --- Migration P4: legacy import metadata ----------------------------------------------

/**
 * One legacy import run (`docs/legacy-import-metadata.md`). Metadata about the run, never a
 * copy of what it read: the source is named by a SHA-256 fingerprint, a failure by a closed
 * code, and the counters are numbers.
 *
 * Lifecycle: inserted `RUNNING`; leaves it only by a conditional UPDATE naming `RUNNING`.
 * At most one `RUNNING` run per tenant, by a partial unique index rather than by a process —
 * two importer replicas are as normal here as two monitor replicas are elsewhere.
 */
export const legacyImportRuns = pgTable(
  'legacy_import_runs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    mode: text('mode').notNull(),
    status: text('status').notNull(),
    /** SHA-256 hex of the source snapshot's identity (dump checksum, export manifest). */
    sourceFingerprint: text('source_fingerprint').notNull(),
    /** The importer's commit or release, for provenance; never a path or a host. */
    codeVersion: text('code_version'),
    failureCode: text('failure_code'),
    /** Rows the importer has read so far; advanced monotonically by checkpoints. */
    rowsSeen: integer('rows_seen').notNull().default(0),
    /** Snapshotted at the terminal transition from the map rows this run wrote. */
    rowsImported: integer('rows_imported').notNull().default(0),
    rowsSkipped: integer('rows_skipped').notNull().default(0),
    rowsManualReview: integer('rows_manual_review').notNull().default(0),
    rowsFailed: integer('rows_failed').notNull().default(0),
    startedAt: timestamptz('started_at').notNull(),
    lastProgressAt: timestamptz('last_progress_at').notNull(),
    finishedAt: timestamptz('finished_at'),
  },
  (table) => [
    unique('legacy_import_runs_tenant_id_key').on(table.tenantId, table.id),
    index('legacy_import_runs_tenant_started_idx').on(table.tenantId, table.startedAt),
    uniqueIndex('legacy_import_runs_one_running_idx')
      .on(table.tenantId)
      .where(sql`status = 'RUNNING'`),
    check('legacy_import_runs_mode_check', enumCheck('mode', LEGACY_IMPORT_RUN_MODES)),
    check('legacy_import_runs_status_check', enumCheck('status', LEGACY_IMPORT_RUN_STATUSES)),
    check(
      'legacy_import_runs_failure_code_check',
      sql`failure_code IS NULL OR ${enumCheck('failure_code', LEGACY_IMPORT_RUN_FAILURE_CODES)}`,
    ),
    check('legacy_import_runs_fingerprint_check', sql`source_fingerprint ~ '^[0-9a-f]{64}$'`),
    check(
      'legacy_import_runs_code_version_check',
      sql`code_version IS NULL OR code_version ~ '^[A-Za-z0-9._+-]{1,64}$'`,
    ),
    check(
      'legacy_import_runs_counters_check',
      sql`rows_seen >= 0 AND rows_imported >= 0 AND rows_skipped >= 0 AND rows_manual_review >= 0 AND rows_failed >= 0`,
    ),
    /** Each status carries exactly the stamps it implies; only FAILED names a failure. */
    check(
      'legacy_import_runs_status_stamps_check',
      sql`CASE status
            WHEN 'RUNNING' THEN finished_at IS NULL AND failure_code IS NULL
            WHEN 'FAILED' THEN finished_at IS NOT NULL AND failure_code IS NOT NULL
            ELSE finished_at IS NOT NULL AND failure_code IS NULL
          END`,
    ),
    check('legacy_import_runs_window_check', sql`finished_at IS NULL OR finished_at >= started_at`),
    /** A run cannot finish before the progress it recorded (a skewed clock is clamped). */
    check(
      'legacy_import_runs_finish_after_progress_check',
      sql`finished_at IS NULL OR finished_at >= last_progress_at`,
    ),
  ],
);

/**
 * What a legacy record became. One row per `(tenant, legacy_table, legacy_id)` for ever: a
 * rerun updates the row it decided before rather than adding a second answer.
 *
 * No column can hold a source row or free text. `checksum` is the SHA-256 of the canonical
 * source row the decision was made from, so a rerun can tell "already done" from "the
 * source changed since" without keeping the row. `entity_id` has no foreign key on purpose:
 * it names one of several tables (`entity_type`), and provenance must survive a later
 * decision about that entity.
 */
export const legacyImportMap = pgTable(
  'legacy_import_map',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    legacyTable: text('legacy_table').notNull(),
    legacyId: text('legacy_id').notNull(),
    /** The run that last wrote this row. */
    runId: uuid('run_id').notNull(),
    checksum: text('checksum').notNull(),
    status: text('status').notNull(),
    reasonCode: text('reason_code'),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    /** How many runs have written a decision here; 1 on the first. */
    attempts: integer('attempts').notNull().default(1),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
    /**
     * Item 9 — the human side of a `MANUAL_REVIEW` row (`LEGACY_REVIEW_STATES`); NULL on
     * every other status. Changed only by conditional UPDATEs naming their from-state.
     */
    reviewState: text('review_state'),
    /** Why a person closed it (`LEGACY_REVIEW_RESOLUTION_CODES`); only while closed. */
    reviewResolutionCode: text('review_resolution_code'),
    reviewedAt: timestamptz('reviewed_at'),
    /** Who closed it: an actor type and its stable id (an admin uuid or a job id). */
    reviewedByActorType: text('reviewed_by_actor_type'),
    reviewedByActorId: text('reviewed_by_actor_id'),
    /** How many times a closed review came back OPEN (a reopen, or a retry that failed again). */
    reviewReopenedCount: integer('review_reopened_count').notNull().default(0),
    /**
     * Item 9: the row's non-identifying reference — what audit rows and outbox events name,
     * as they name a customer by its uuid. The legacy key of a `user` row IS a Telegram id,
     * and an append-only audit log must never carry one.
     */
    ref: uuid('ref')
      .notNull()
      .default(sql`gen_random_uuid()`),
  },
  (table) => [
    primaryKey({
      name: 'legacy_import_map_pk',
      columns: [table.tenantId, table.legacyTable, table.legacyId],
    }),
    foreignKey({
      columns: [table.tenantId, table.runId],
      foreignColumns: [legacyImportRuns.tenantId, legacyImportRuns.id],
      name: 'legacy_import_map_run_fk',
    }),
    index('legacy_import_map_tenant_run_idx').on(table.tenantId, table.runId, table.status),
    /** The reconcile / manual-review walk. */
    index('legacy_import_map_tenant_status_idx').on(
      table.tenantId,
      table.status,
      table.legacyTable,
      table.legacyId,
    ),
    index('legacy_import_map_tenant_entity_idx')
      .on(table.tenantId, table.entityType, table.entityId)
      .where(sql`entity_id IS NOT NULL`),
    unique('legacy_import_map_tenant_ref_key').on(table.tenantId, table.ref),
    /** Item 9: the review queue, filtered by state and keyset-paged by legacy key. */
    index('legacy_import_map_review_queue_idx')
      .on(table.tenantId, table.reviewState, table.legacyTable, table.legacyId)
      .where(sql`status = 'MANUAL_REVIEW'`),
    check('legacy_import_map_status_check', enumCheck('status', LEGACY_IMPORT_MAP_STATUSES)),
    check(
      'legacy_import_map_reason_check',
      sql`reason_code IS NULL OR ${enumCheck('reason_code', LEGACY_IMPORT_REASON_CODES)}`,
    ),
    check(
      'legacy_import_map_entity_type_check',
      sql`entity_type IS NULL OR ${enumCheck('entity_type', LEGACY_IMPORT_ENTITY_TYPES)}`,
    ),
    check('legacy_import_map_table_check', enumCheck('legacy_table', LEGACY_IMPORT_SOURCE_TABLES)),
    /**
     * Per table, the evidenced key shape — `LEGACY_ID_PATTERNS`, mirrored here and held in
     * step by `legacy-import-metadata.test.ts`. A table without an evidenced shape is not
     * in the set at all. `invoice` joined in 0191 from MirzaBot's public source
     * (`OQ-P4-01`, `docs/legacy-import-metadata.md`).
     */
    check(
      'legacy_import_map_legacy_key_check',
      sql`CASE legacy_table
            WHEN 'user' THEN legacy_id ~ '^[1-9][0-9]{0,19}$'
            WHEN 'invoice' THEN legacy_id ~ '^([1-9][0-9]{6})?([0-9a-f]{4}|[0-9a-f]{8})$'
            ELSE false
          END`,
    ),
    check('legacy_import_map_checksum_check', sql`checksum ~ '^[0-9a-f]{64}$'`),
    check('legacy_import_map_attempts_check', sql`attempts >= 1`),
    /** IMPORTED names exactly one entity; nothing else names any, and must say why. */
    check(
      'legacy_import_map_status_shape_check',
      sql`CASE status
            WHEN 'IMPORTED' THEN entity_type IS NOT NULL AND entity_id IS NOT NULL
            ELSE entity_type IS NULL AND entity_id IS NULL AND reason_code IS NOT NULL
          END`,
    ),
    /** Item 9: a review row carries a review reason — never a warning, skip or failure. */
    check(
      'legacy_import_map_review_reason_check',
      // `IS NOT NULL` explicitly: `NULL IN (…)` is NULL, and a CHECK passes on NULL.
      sql`status <> 'MANUAL_REVIEW' OR (reason_code IS NOT NULL AND ${enumCheck('reason_code', LEGACY_REVIEW_REASON_CODES)})`,
    ),
    /** Item 9: a review state exists exactly on MANUAL_REVIEW rows. */
    check(
      'legacy_import_map_review_state_check',
      sql`CASE status
            WHEN 'MANUAL_REVIEW' THEN review_state IS NOT NULL AND ${enumCheck('review_state', LEGACY_REVIEW_STATES)}
            ELSE review_state IS NULL
          END`,
    ),
    /**
     * Item 9: a closed review names its resolution, when and by whom, and the resolution
     * belongs to that closed state; an open (or absent) review names none of them. Every
     * IN list is guarded by an explicit `IS NOT NULL` (Codex P2 on #179): a NULL makes the
     * IN expression NULL, and a CHECK that evaluates to NULL passes.
     */
    check(
      'legacy_import_map_review_resolution_check',
      sql`CASE
            WHEN review_state IN ('RESOLVED', 'DISMISSED') THEN
              reviewed_at IS NOT NULL AND reviewed_by_actor_type IS NOT NULL
              AND reviewed_by_actor_id IS NOT NULL AND review_resolution_code IS NOT NULL
              AND CASE review_state
                    WHEN 'RESOLVED' THEN ${enumCheck('review_resolution_code', reviewCodesFor('RESOLVED'))}
                    ELSE ${enumCheck('review_resolution_code', reviewCodesFor('DISMISSED'))}
                  END
            ELSE review_resolution_code IS NULL AND reviewed_at IS NULL
              AND reviewed_by_actor_type IS NULL AND reviewed_by_actor_id IS NULL
          END`,
    ),
    check(
      'legacy_import_map_reviewed_by_actor_type_check',
      sql`reviewed_by_actor_type IS NULL OR ${enumCheck('reviewed_by_actor_type', ACTOR_TYPES)}`,
    ),
    /** An actor id is an identifier (uuid, job id), never free text. */
    check(
      'legacy_import_map_reviewed_by_actor_id_check',
      sql`reviewed_by_actor_id IS NULL OR reviewed_by_actor_id ~ '^[A-Za-z0-9._:-]{1,128}$'`,
    ),
    check('legacy_import_map_review_reopened_check', sql`review_reopened_count >= 0`),
  ],
);

/** The resolution codes that close a review into `state` (contract-derived, for the CHECK). */
function reviewCodesFor(state: 'RESOLVED' | 'DISMISSED'): readonly string[] {
  return LEGACY_REVIEW_RESOLUTION_CODES.filter((c) => LEGACY_REVIEW_RESOLUTION_STATE[c] === state);
}

/**
 * Migration P7 — what one import run was started FROM, recorded once
 * (`docs/legacy-migration/importer.md` §Run inputs).
 *
 * The run row carries the source fingerprint; this carries the rest of the run's identity
 * and the one figure the reconcile cannot recompute afterwards: the tenant's NEXA-native
 * wallet total (every entry but the openings) at the run's first start. A resume compares
 * the panel-mapping fingerprint and refuses a
 * different mapping; the pre-import total is taken at the run's first start and never
 * moved by a resume. Hashes, an engine name, a currency and two numbers — no source data.
 */
export const legacyImportRunInputs = pgTable(
  'legacy_import_run_inputs',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    runId: uuid('run_id').notNull(),
    sourceEngine: text('source_engine').notNull(),
    sourceSchemaHash: text('source_schema_hash').notNull(),
    panelMappingFingerprint: text('panel_mapping_fingerprint').notNull(),
    walletCurrency: text('wallet_currency').notNull(),
    /**
     * Σ signed wallet entries of the tenant in `wallet_currency` EXCEPT migration openings,
     * at the run's first start: the NEXA-native "pre-import" side of the wallet equation,
     * which a rerun or a resume measures the same way whatever openings already exist.
     */
    preImportWalletTotalMinor: bigint('pre_import_wallet_total_minor', {
      mode: 'bigint',
    }).notNull(),
    preImportCustomers: integer('pre_import_customers').notNull(),
    recordedAt: timestamptz('recorded_at').notNull(),
    /**
     * Mirza `.nxpkg` importer: SHA-256 of the ownership hold the run was started under (the
     * sorted held invoice keys and the decisions file's entries digest, `ownershipHoldDigest`).
     * NULL for a run without a hold. A resume, reconcile or report under another hold is
     * refused, so one run is never decided under two different holds.
     */
    ownershipHoldDigest: text('ownership_hold_digest'),
    /**
     * Mirza `.nxpkg` inventory hold: SHA-256 of the sorted held invoice keys
     * (`inventoryHoldDigest`) and the keys themselves, a JSON array. A dry run records the
     * invoices it quarantined because a needed username was left UNRESOLVED by a per-name read
     * that held; an apply records the approved hold it was given back. NULL for a run without
     * one. Legacy invoice keys only — the same keys `legacy_import_map` holds — and never in a
     * report: the report carries the count and this digest.
     */
    inventoryHoldDigest: text('inventory_hold_digest'),
    inventoryHoldKeys: jsonb('inventory_hold_keys'),
    /**
     * NEXA v096 PR-1 (demotions at apply): a DRY RUN's own `planTalliesDigest` and its adoptions
     * (`ApprovedAdoption` rows: invoice, panel, panel spelling, product path, customer), so an
     * apply bound to that digest can tell an account the live panel lost since from any other
     * change. Read only through the restored digest, never trusted alone. NULL for an apply and
     * for a run recorded before them. Operator data, never in a report.
     */
    planTalliesDigest: text('plan_tallies_digest'),
    approvedAdoptions: jsonb('approved_adoptions'),
    /**
     * NEXA v096 PR-1: the demotions an APPLY accepted when it started (`StoredDemotions`: cap,
     * approved adoptable services, rows `[invoice, panel, panel spelling, to]`). NULL for a dry
     * run and for an apply that demoted nothing.
     */
    demotions: jsonb('demotions'),
  },
  (table) => [
    primaryKey({ name: 'legacy_import_run_inputs_pk', columns: [table.tenantId, table.runId] }),
    foreignKey({
      columns: [table.tenantId, table.runId],
      foreignColumns: [legacyImportRuns.tenantId, legacyImportRuns.id],
      name: 'legacy_import_run_inputs_run_fk',
    }),
    check(
      'legacy_import_run_inputs_engine_check',
      sql`source_engine IN ('MYSQL', 'MARIADB', 'SYNTHETIC_FIXTURE', 'NXPKG')`,
    ),
    check(
      'legacy_import_run_inputs_hashes_check',
      sql`source_schema_hash ~ '^[0-9a-f]{64}$' AND panel_mapping_fingerprint ~ '^[0-9a-f]{64}$'`,
    ),
    check('legacy_import_run_inputs_currency_check', sql`wallet_currency ~ '^[A-Z]{3}$'`),
    check('legacy_import_run_inputs_customers_check', sql`pre_import_customers >= 0`),
    check(
      'legacy_import_run_inputs_hold_digest_check',
      sql`ownership_hold_digest IS NULL OR ownership_hold_digest ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'legacy_import_run_inputs_inventory_hold_check',
      sql`((inventory_hold_digest IS NULL) = (inventory_hold_keys IS NULL)) AND (inventory_hold_digest IS NULL OR inventory_hold_digest ~ '^[0-9a-f]{64}$') AND (inventory_hold_keys IS NULL OR jsonb_typeof(inventory_hold_keys) = 'array')`,
    ),
    check(
      'legacy_import_run_inputs_approved_adoptions_check',
      sql`((plan_tallies_digest IS NULL) = (approved_adoptions IS NULL)) AND (plan_tallies_digest IS NULL OR plan_tallies_digest ~ '^[0-9a-f]{64}$') AND (approved_adoptions IS NULL OR jsonb_typeof(approved_adoptions) = 'array')`,
    ),
    check(
      'legacy_import_run_inputs_demotions_check',
      sql`demotions IS NULL OR (jsonb_typeof(demotions) = 'object' AND jsonb_typeof(demotions->'entries') = 'array')`,
    ),
  ],
);

/**
 * Mirza migration PR1 — one versioned READ SET of the legacy source, as a run observed it
 * (`docs/legacy-migration/importer.md` §Read sets). Separate from
 * `legacy_import_run_inputs`, which is per APPLY run and compared on resume: a read set is
 * read by its own read-only session, and what binds it to the approved source is
 * `source_fingerprint` — the v1 import fingerprint that SAME session recomputed and found
 * equal to `--expected-fingerprint`.
 *
 * Fingerprints, counts, an engine name and a version — never a row, a table name list or
 * a value. One row per (tenant, read set, version, read-set fingerprint, source
 * fingerprint): observing the same thing again records nothing new. Append-only (0220).
 */
export const legacyReadSetRuns = pgTable(
  'legacy_read_set_runs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    readSet: text('read_set').notNull(),
    readSetVersion: integer('read_set_version').notNull(),
    /** `legacy-read-set:<read_set>:v<read_set_version>`, stored so a reader needs no code. */
    fingerprintVersion: text('fingerprint_version').notNull(),
    readSetFingerprint: text('read_set_fingerprint').notNull(),
    /** The v1 import fingerprint the same session recomputed: the approved source. */
    sourceFingerprint: text('source_fingerprint').notNull(),
    sourceSchemaHash: text('source_schema_hash').notNull(),
    sourceEngine: text('source_engine').notNull(),
    synthetic: boolean('synthetic').notNull(),
    tableCount: integer('table_count').notNull(),
    rowCount: bigint('row_count', { mode: 'bigint' }).notNull(),
    codeVersion: text('code_version'),
    recordedAt: timestamptz('recorded_at').notNull(),
  },
  (table) => [
    unique('legacy_read_set_runs_tenant_id_key').on(table.tenantId, table.id),
    unique('legacy_read_set_runs_observation_key').on(
      table.tenantId,
      table.readSet,
      table.readSetVersion,
      table.readSetFingerprint,
      table.sourceFingerprint,
    ),
    index('legacy_read_set_runs_tenant_recorded_idx').on(table.tenantId, table.recordedAt),
    check('legacy_read_set_runs_read_set_check', enumCheck('read_set', LEGACY_READ_SET_NAMES)),
    check(
      'legacy_read_set_runs_version_check',
      sql`read_set_version BETWEEN 1 AND 9999 AND fingerprint_version = 'legacy-read-set:' || read_set || ':v' || read_set_version::text`,
    ),
    check(
      'legacy_read_set_runs_hashes_check',
      sql`read_set_fingerprint ~ '^[0-9a-f]{64}$' AND source_fingerprint ~ '^[0-9a-f]{64}$' AND source_schema_hash ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'legacy_read_set_runs_engine_check',
      sql`source_engine IN ('MYSQL', 'MARIADB', 'SYNTHETIC_FIXTURE', 'NXPKG')`,
    ),
    check('legacy_read_set_runs_counts_check', sql`table_count >= 0 AND row_count >= 0`),
    check(
      'legacy_read_set_runs_code_version_check',
      sql`code_version IS NULL OR code_version ~ '^[A-Za-z0-9._+-]{1,64}$'`,
    ),
  ],
);

/**
 * Mirza migration PR2 — the legacy product review (`docs/legacy-product-review-design.md`).
 *
 * One row per legacy `code_product` (trimmed, as the importer matches it) per tenant: the
 * legacy row's cells VERBATIM (`legacy_facts`, an array because a duplicated code keeps
 * every row it has — `source_conflict`), their checksum, the fields parsed from them as a
 * proposal (with closed `parse_notes`), and the operator's decision.
 *
 * NOT a product. Nothing here is listed, ordered, priced or renewed, and no column of
 * `products` is touched by it except through the product service when an operator creates
 * a draft. `historical_price_*` is METADATA — the owner states Mirza prices are Toman, so
 * the normalised figure is IRT minor units (exponent 0) beside the raw text — and nothing
 * copies it to `products.price_*`.
 *
 * Every state change is a conditional UPDATE naming its from-states. An approval binds to
 * `facts_checksum` (`approved_facts_checksum`); a later read whose facts differ — or which
 * no longer has the code (`missing_since_read_fingerprint`) — moves a decided row to
 * SOURCE_CHANGED, remembering the decision it invalidated in `prior_state`.
 */
export const legacyProductReviews = pgTable(
  'legacy_product_reviews',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    codeProduct: text('code_product').notNull(),
    /** The legacy `product.id` (the first by byte order when the code is duplicated). */
    legacyProductId: text('legacy_product_id').notNull(),
    /** One object per legacy row naming this code: column name to the cell as read. */
    legacyFacts: jsonb('legacy_facts').notNull(),
    factsChecksum: text('facts_checksum').notNull(),
    sourceConflict: text('source_conflict'),
    title: text('title'),
    trafficBytes: bigint('traffic_bytes', { mode: 'bigint' }),
    durationDays: integer('duration_days'),
    /** The legacy `price_product` cell verbatim. */
    historicalPriceRaw: text('historical_price_raw'),
    /** Metadata only: whole Toman as IRT minor units. Never a selling price. */
    historicalPriceMinor: bigint('historical_price_minor', { mode: 'bigint' }),
    historicalPriceCurrency: text('historical_price_currency'),
    parseNotes: jsonb('parse_notes').notNull(),
    /** Live, non-test, non-custom invoices naming this code in the read's snapshot. */
    liveInvoiceCount: integer('live_invoice_count').notNull(),
    state: text('state').notNull(),
    priorState: text('prior_state'),
    approvedProductId: uuid('approved_product_id'),
    approvedFactsChecksum: text('approved_facts_checksum'),
    decisionReason: text('decision_reason'),
    decidedByAdminId: uuid('decided_by_admin_id'),
    decidedAt: timestamptz('decided_at'),
    /** The `products` read set fingerprint of the read that last saw this code. */
    readFingerprint: text('read_fingerprint').notNull(),
    /** The approved v1 source fingerprint that read was bound to. */
    sourceFingerprint: text('source_fingerprint').notNull(),
    missingSinceReadFingerprint: text('missing_since_read_fingerprint'),
    version: integer('version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    unique('legacy_product_reviews_tenant_id_key').on(table.tenantId, table.id),
    unique('legacy_product_reviews_tenant_code_key').on(table.tenantId, table.codeProduct),
    index('legacy_product_reviews_tenant_state_idx').on(table.tenantId, table.state),
    foreignKey({
      name: 'legacy_product_reviews_tenant_product_fk',
      columns: [table.tenantId, table.approvedProductId],
      foreignColumns: [products.tenantId, products.id],
    }),
    foreignKey({
      name: 'legacy_product_reviews_tenant_admin_fk',
      columns: [table.tenantId, table.decidedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    check('legacy_product_reviews_state_check', enumCheck('state', LEGACY_PRODUCT_REVIEW_STATES)),
    check(
      'legacy_product_reviews_prior_state_check',
      sql`(${nullableEnumCheck('prior_state', LEGACY_PRODUCT_REVIEW_DECIDED_STATES)}) AND ((state = 'SOURCE_CHANGED') = (prior_state IS NOT NULL))`,
    ),
    check(
      'legacy_product_reviews_conflict_check',
      sql`(${nullableEnumCheck('source_conflict', LEGACY_PRODUCT_SOURCE_CONFLICTS)}) AND jsonb_typeof(legacy_facts) = 'array' AND jsonb_array_length(legacy_facts) >= 1 AND ((source_conflict IS NULL) = (jsonb_array_length(legacy_facts) = 1))`,
    ),
    check(
      'legacy_product_reviews_approval_check',
      sql`((approved_product_id IS NULL) = (approved_facts_checksum IS NULL)) AND (state NOT IN ('APPROVED_EXISTING', 'APPROVED_NEW') OR approved_product_id IS NOT NULL) AND (state NOT IN ('PENDING_REVIEW', 'REJECTED') OR approved_product_id IS NULL)`,
    ),
    check(
      'legacy_product_reviews_decision_check',
      sql`(state NOT IN ('APPROVED_EXISTING', 'APPROVED_NEW', 'REJECTED') OR (decided_at IS NOT NULL AND decided_by_admin_id IS NOT NULL)) AND (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 1 AND 500)`,
    ),
    check(
      'legacy_product_reviews_price_check',
      sql`((historical_price_minor IS NULL) = (historical_price_currency IS NULL)) AND (historical_price_currency IS NULL OR historical_price_currency = 'IRT') AND (historical_price_minor IS NULL OR historical_price_minor >= 0)`,
    ),
    check(
      'legacy_product_reviews_code_check',
      sql`char_length(code_product) BETWEEN 1 AND 200 AND code_product !~ '[[:cntrl:]]' AND code_product = btrim(code_product)`,
    ),
    check(
      'legacy_product_reviews_hashes_check',
      sql`facts_checksum ~ '^[0-9a-f]{64}$' AND (approved_facts_checksum IS NULL OR approved_facts_checksum ~ '^[0-9a-f]{64}$') AND read_fingerprint ~ '^[0-9a-f]{64}$' AND source_fingerprint ~ '^[0-9a-f]{64}$' AND (missing_since_read_fingerprint IS NULL OR missing_since_read_fingerprint ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      'legacy_product_reviews_counts_check',
      sql`(traffic_bytes IS NULL OR traffic_bytes >= 0) AND (duration_days IS NULL OR duration_days >= 0) AND live_invoice_count >= 0 AND version >= 1 AND jsonb_typeof(parse_notes) = 'object'`,
    ),
  ],
);

/**
 * Mirza migration PR3 — one INGEST RUN of the legacy invoice archive
 * (`docs/legacy-migration/importer.md` §Invoice archive). The run is the archive's unit of
 * all-or-nothing:
 *
 * - STAGING: an APPROVED `invoice-archive` read is being delivered into
 *   `legacy_invoice_archive_staging` under this run's id, one transaction per batch. No
 *   archive row exists for it. A read that diverges, or a process that dies, leaves it
 *   STAGING or FAILED and its staging rows are deleted: nothing of it is ever archived.
 * - VERIFIED: the whole read was delivered, `readLegacyReadSet` proved the delivery equal
 *   to the verified pass, and the staged rows add up to the read's exact row counts. Only
 *   now are revisions written, a batch per transaction, behind `promoted_through` (the
 *   last staged key promoted), so a crash resumes where it stopped.
 * - COMPLETED: every staged invoice is accounted for — the CHECK below is the closure
 *   equation — and its revisions become visible to readers.
 *
 * Every state change is a conditional UPDATE naming its `from` state; at most one run per
 * tenant is open (STAGING or VERIFIED). Counts, hashes and codes — never a cell.
 */
export const legacyInvoiceArchiveRuns = pgTable(
  'legacy_invoice_archive_runs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    state: text('state').notNull(),
    failureCode: text('failure_code'),
    readSetVersion: integer('read_set_version').notNull(),
    readSetFingerprint: text('read_set_fingerprint').notNull(),
    /** The v1 import fingerprint the read's own session recomputed: the approved source. */
    sourceFingerprint: text('source_fingerprint').notNull(),
    sourceSchemaHash: text('source_schema_hash').notNull(),
    sourceEngine: text('source_engine').notNull(),
    synthetic: boolean('synthetic').notNull(),
    /** The read's exact row counts, set when the run is VERIFIED. */
    sourceInvoiceRows: bigint('source_invoice_rows', { mode: 'bigint' }),
    sourceUserRows: bigint('source_user_rows', { mode: 'bigint' }),
    sourceProductRows: bigint('source_product_rows', { mode: 'bigint' }),
    /** The last staged invoice key whose revision decision is committed. */
    promotedThrough: text('promoted_through'),
    promotedRows: bigint('promoted_rows', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    insertedNew: bigint('inserted_new', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    insertedRevision: bigint('inserted_revision', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    unchanged: bigint('unchanged', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /** Archived invoices this run's snapshot no longer has. Counted, never deleted. */
    missingInSnapshot: bigint('missing_in_snapshot', { mode: 'bigint' }),
    /** Distinct archived invoices once this run completed. */
    archiveInvoicesAfter: bigint('archive_invoices_after', { mode: 'bigint' }),
    codeVersion: text('code_version'),
    startedAt: timestamptz('started_at').notNull(),
    verifiedAt: timestamptz('verified_at'),
    finishedAt: timestamptz('finished_at'),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    unique('legacy_invoice_archive_runs_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('legacy_invoice_archive_runs_one_open_idx')
      .on(table.tenantId)
      .where(sql`state IN ('STAGING', 'VERIFIED')`),
    index('legacy_invoice_archive_runs_tenant_started_idx').on(table.tenantId, table.startedAt),
    check(
      'legacy_invoice_archive_runs_state_check',
      enumCheck('state', LEGACY_INVOICE_ARCHIVE_RUN_STATES),
    ),
    check(
      'legacy_invoice_archive_runs_failure_check',
      sql`(${nullableEnumCheck('failure_code', LEGACY_INVOICE_ARCHIVE_RUN_FAILURES)}) AND ((state = 'FAILED') = (failure_code IS NOT NULL))`,
    ),
    check(
      'legacy_invoice_archive_runs_lifecycle_check',
      sql`((verified_at IS NOT NULL) = (state IN ('VERIFIED', 'COMPLETED'))) AND ((finished_at IS NOT NULL) = (state IN ('COMPLETED', 'FAILED'))) AND ((source_invoice_rows IS NOT NULL) = (verified_at IS NOT NULL)) AND ((source_user_rows IS NOT NULL) = (verified_at IS NOT NULL)) AND ((source_product_rows IS NOT NULL) = (verified_at IS NOT NULL)) AND (state IN ('VERIFIED', 'COMPLETED') OR (promoted_rows = 0 AND promoted_through IS NULL))`,
    ),
    check(
      'legacy_invoice_archive_runs_closure_check',
      sql`promoted_rows = inserted_new + inserted_revision + unchanged AND (source_invoice_rows IS NULL OR promoted_rows <= source_invoice_rows) AND ((state = 'COMPLETED') = (missing_in_snapshot IS NOT NULL)) AND ((state = 'COMPLETED') = (archive_invoices_after IS NOT NULL)) AND (state <> 'COMPLETED' OR (promoted_rows = source_invoice_rows AND archive_invoices_after = source_invoice_rows + missing_in_snapshot))`,
    ),
    check(
      'legacy_invoice_archive_runs_counts_check',
      sql`read_set_version BETWEEN 1 AND 9999 AND inserted_new >= 0 AND inserted_revision >= 0 AND unchanged >= 0 AND (source_invoice_rows IS NULL OR source_invoice_rows >= 0) AND (source_user_rows IS NULL OR source_user_rows >= 0) AND (source_product_rows IS NULL OR source_product_rows >= 0) AND (missing_in_snapshot IS NULL OR missing_in_snapshot >= 0)`,
    ),
    check(
      'legacy_invoice_archive_runs_hashes_check',
      sql`read_set_fingerprint ~ '^[0-9a-f]{64}$' AND source_fingerprint ~ '^[0-9a-f]{64}$' AND source_schema_hash ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'legacy_invoice_archive_runs_engine_check',
      sql`source_engine IN ('MYSQL', 'MARIADB', 'SYNTHETIC_FIXTURE', 'NXPKG')`,
    ),
    check(
      'legacy_invoice_archive_runs_code_version_check',
      sql`code_version IS NULL OR code_version ~ '^[A-Za-z0-9._+-]{1,64}$'`,
    ),
  ],
);

/**
 * Mirza migration PR3 — SCRATCH rows of one STAGING or VERIFIED archive run: what an
 * approved `invoice-archive` read delivered, before anything is archived. Not history and
 * not evidence: deleted when the run completes or fails. `invoice` rows carry the cells
 * verbatim and their checksum; `user` rows only the legacy id (owner detection) and
 * `product` rows only the trimmed `code_product` (product reference) — the source-derived
 * context the archive's classification reads from the SAME snapshot.
 */
export const legacyInvoiceArchiveStaging = pgTable(
  'legacy_invoice_archive_staging',
  {
    runId: uuid('run_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    sourceTable: text('source_table').notNull(),
    /** The source row's primary key as read. */
    sourceKey: text('source_key').notNull(),
    /** `user`: the id; `product`: the trimmed non-empty `code_product` (else NULL). */
    lookup: text('lookup'),
    /** `invoice` only: column name to cell as read. */
    cells: jsonb('cells'),
    rowChecksum: text('row_checksum'),
  },
  (table) => [
    primaryKey({
      name: 'legacy_invoice_archive_staging_pk',
      columns: [table.runId, table.sourceTable, table.sourceKey],
    }),
    index('legacy_invoice_archive_staging_lookup_idx').on(
      table.runId,
      table.sourceTable,
      table.lookup,
    ),
    foreignKey({
      name: 'legacy_invoice_archive_staging_run_fk',
      columns: [table.tenantId, table.runId],
      foreignColumns: [legacyInvoiceArchiveRuns.tenantId, legacyInvoiceArchiveRuns.id],
    }),
    check(
      'legacy_invoice_archive_staging_table_check',
      sql`source_table IN ('invoice', 'user', 'product') AND ((source_table = 'invoice') = (cells IS NOT NULL)) AND ((source_table = 'invoice') = (row_checksum IS NOT NULL)) AND (cells IS NULL OR jsonb_typeof(cells) = 'object') AND (row_checksum IS NULL OR row_checksum ~ '^[0-9a-f]{64}$') AND (source_table <> 'user' OR lookup = source_key)`,
    ),
  ],
);
