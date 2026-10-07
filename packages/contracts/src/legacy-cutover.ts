import { z } from 'zod';

/**
 * Mirza migration PR6 — the final cutover (owner constraints 3 and 4;
 * `docs/legacy-migration/cutover-runbook.md`).
 *
 * The verified Mirza database is a HISTORICAL staging snapshot. The cutover imports a NEW,
 * frozen snapshot, and only with the owner's approval recorded in the database and bound to
 * exactly what was verified:
 *
 * - the v1 import source fingerprint (`legacy-source-fingerprint:v1`, what `audit` prints);
 * - the panel-map fingerprint;
 * - the three read-set fingerprints — `inventory`, `products`, `invoice-archive` — each
 *   RECORDED in `legacy_read_set_runs` against that same source fingerprint;
 * - the SHA-256 of the freeze proof file (`scripts/legacy-freeze-checksum.sql`'s output at
 *   the freeze, which `scripts/legacy-freeze-checksum-verify.sh` accepted);
 * - the SHA-256 of the final dump.
 *
 * A production-like import refuses without an unrevoked approval matching EVERY value it is
 * given, so any changed value voids it. An approval is append-only: it is never edited, only
 * revoked by a second append-only record.
 *
 * `SOURCE_SUPERSEDED` (audit §6.2): a production-like import on a tenant that already holds
 * a finished APPLY run of a DIFFERENT source fingerprint is refused unless the owner records
 * an explicit `RERUN_OVER_PRIOR_IMPORT` acknowledgement bound to the same values AND that
 * prior fingerprint. Even then it is a re-run, never a merge: unchanged rows are skipped, a
 * changed row is `SOURCE_CHANGED` and reported, nothing is applied twice, and no balance
 * delta is ever applied (OQ-LWD-02).
 */

/** What an approval approves. */
export const LEGACY_CUTOVER_APPROVAL_KINDS = [
  /** This frozen snapshot may be imported (the cutover itself). */
  'CUTOVER',
  /** This snapshot may be imported OVER an earlier import of another snapshot (a re-run). */
  'RERUN_OVER_PRIOR_IMPORT',
] as const;
export type LegacyCutoverApprovalKind = (typeof LEGACY_CUTOVER_APPROVAL_KINDS)[number];
export const legacyCutoverApprovalKindSchema = z.enum(LEGACY_CUTOVER_APPROVAL_KINDS);

/**
 * The values an approval is bound to, in the order the import's `--expected-*` flags and
 * the runbook name them. Every one must match; there is no partial approval.
 */
export const LEGACY_CUTOVER_BINDING_FIELDS = [
  'sourceFingerprint',
  'panelMapFingerprint',
  'inventoryFingerprint',
  'productsFingerprint',
  'invoiceArchiveFingerprint',
  'freezeProofSha256',
  'finalDumpSha256',
] as const;
export type LegacyCutoverBindingField = (typeof LEGACY_CUTOVER_BINDING_FIELDS)[number];
export type LegacyCutoverBinding = Readonly<Record<LegacyCutoverBindingField, string>>;

/** The read sets an approval names, and the binding field each one fills. */
export const LEGACY_CUTOVER_READ_SET_FIELDS = {
  inventory: 'inventoryFingerprint',
  products: 'productsFingerprint',
  'invoice-archive': 'invoiceArchiveFingerprint',
} as const satisfies Readonly<Record<string, LegacyCutoverBindingField>>;

/**
 * A finished APPLY run that a later source supersedes. FAILED is included on purpose: a run
 * fails after its first phases may have written customers and openings, so it is as much a
 * prior import as a COMPLETED or ABORTED one. Only a RUNNING run is not (it is resumed, or
 * refused by the run table's own one-RUNNING rule).
 */
export const LEGACY_CUTOVER_SUPERSEDING_RUN_STATUSES = ['COMPLETED', 'ABORTED', 'FAILED'] as const;

export const LEGACY_CUTOVER_ERROR_CODES = {
  NOT_FOUND: 'legacy_cutover.not_found',
  REQUEST_INVALID: 'legacy_cutover.request_invalid',
  SCOPE_STOPPED: 'legacy_cutover.scope_stopped',
  /** A named read-set fingerprint is not recorded in `legacy_read_set_runs` for that source. */
  READ_SET_NOT_RECORDED: 'legacy_cutover.read_set_not_recorded',
  /** The read sets named disagree on whether their source was synthetic. */
  READ_SET_EVIDENCE_MIXED: 'legacy_cutover.read_set_evidence_mixed',
  /** A re-run acknowledgement names a prior source this tenant never imported. */
  NO_PRIOR_IMPORT: 'legacy_cutover.no_prior_import',
  /** An unrevoked approval with exactly this binding already exists. */
  ALREADY_APPROVED: 'legacy_cutover.already_approved',
  ALREADY_REVOKED: 'legacy_cutover.already_revoked',
  /** The import was refused: no unrevoked approval matches every value it was given. */
  APPROVAL_MISSING: 'legacy_cutover.approval_missing',
  /** The import was refused: the matching approval was made over a synthetic source. */
  APPROVAL_SYNTHETIC: 'legacy_cutover.approval_synthetic',
  /** The import was refused: not every `--expected-*` value was given. */
  EXPECTATION_INCOMPLETE: 'legacy_cutover.expectation_incomplete',
  /**
   * The import was refused: this tenant already holds a finished APPLY run of another source
   * fingerprint, and no re-run acknowledgement names it.
   */
  SOURCE_SUPERSEDED: 'legacy_cutover.source_superseded',
  /** The import was refused: the fresh inventory has a table nobody classified. */
  TABLES_UNCLASSIFIED: 'legacy_cutover.tables_unclassified',
} as const;
export type LegacyCutoverErrorCode =
  (typeof LEGACY_CUTOVER_ERROR_CODES)[keyof typeof LEGACY_CUTOVER_ERROR_CODES];

export const LEGACY_CUTOVER_AUDIT_ACTIONS = {
  /** The owner recorded an approval (`legacy.cutover.approve`). */
  approve: 'legacy.cutover.approve',
  /** The owner revoked one (`legacy.cutover.approve`). */
  revoke: 'legacy.cutover.revoke',
} as const;

export const LEGACY_CUTOVER_REASON_MAX_LENGTH = 500;
export const LEGACY_CUTOVER_PAGE_MAX = 200;

// --- the cutover gate ----------------------------------------------------------------------

/** `legacy-import cutover-gate`'s output version. */
export const LEGACY_CUTOVER_GATE_VERSION = 'nexa-legacy-cutover-gate/v1' as const;

/**
 * The gate's steps, IN ORDER (audit §6.2, policy 6). Each is checked only when every step
 * before it passed; the first failure stops the gate and the rest are `NOT_REACHED`.
 */
export const LEGACY_CUTOVER_GATE_STEPS = [
  /** An ACTIVE MAINTENANCE incident with `stop_sales`; every active panel drained, every gateway off. */
  'STOP_SALES_ACTIVE',
  /** PR1's checker accepted the freeze proof and the restored copy's, and found them EQUAL. */
  'FREEZE_PROOF_VERIFIED',
  /** A fresh read of the source: v1, inventory, products, invoice-archive fingerprints as expected. */
  'FRESH_FINGERPRINTS',
  /** The fresh inventory has no UNCLASSIFIED table (Area E). */
  'TABLES_CLASSIFIED',
  /** An unrevoked owner approval matches every value, not synthetic on a production-like target. */
  'APPROVAL_MATCHES',
  /** No finished APPLY run of another source, or each one acknowledged. */
  'SOURCE_NOT_SUPERSEDED',
  /** The tenant's latest APPLY run is COMPLETED, from this source and this panel map. */
  'IMPORT_COMPLETED',
  /** `reconcile` is RECONCILED. */
  'RECONCILED',
  /** The final report, schema version 2, holds. */
  'REPORT_V2_HOLDS',
] as const;
export type LegacyCutoverGateStep = (typeof LEGACY_CUTOVER_GATE_STEPS)[number];

export const LEGACY_CUTOVER_GATE_RESULTS = ['PASS', 'FAIL', 'NOT_REACHED'] as const;
export type LegacyCutoverGateResult = (typeof LEGACY_CUTOVER_GATE_RESULTS)[number];

// --- the final report, schema version 2 ----------------------------------------------------

/** `docs/legacy-migration/final-report-v2.schema.json`. Version 1 stays readable, unchanged. */
export const LEGACY_FINAL_REPORT_V2_SCHEMA_VERSION = '2' as const;

/** The inventory section (PR1's read set, as `report` re-read it). Aggregates only. */
export const LEGACY_INVENTORY_SECTION_VERSION = 'nexa-legacy-inventory/v1' as const;
/** The products section (PR2's review). Counts by state, export readiness, fingerprint. */
export const LEGACY_PRODUCTS_SECTION_VERSION = 'nexa-legacy-products/v1' as const;
/** The invoice archive section (PR3's closure equations). */
export const LEGACY_INVOICE_ARCHIVE_SECTION_VERSION = 'nexa-legacy-invoice-archive/v1' as const;
/** The cutover section: approvals, prior APPLY runs and the duplicate-effect counters. */
export const LEGACY_CUTOVER_SECTION_VERSION = 'nexa-legacy-cutover/v1' as const;

/**
 * The report's reconciliation invariants. Each one flips the verdict on its own
 * (`tests/unit/legacy-final-report-v2.test.ts`).
 */
export const LEGACY_FINAL_REPORT_V2_INVARIANTS = [
  /** Every source user row is in exactly one outcome (v1 C1 and PR4's user closure). */
  'USERS_ACCOUNTED',
  /** The archive holds every source invoice of this fingerprint: archived = source rows. */
  'INVOICES_ACCOUNTED',
  /** The product review has one present row per distinct source product code. */
  'PRODUCTS_ACCOUNTED',
  /** The wallet equations hold; debts and conflicts are reported, never netted. */
  'WALLETS_RECONCILED',
  /** Every service candidate has exactly one outcome (PR5). */
  'SERVICES_ONE_OUTCOME',
  /** Nothing unresolved was dropped: absent invoices kept, unadopted invoices kept as history. */
  'UNRESOLVED_RETAINED',
  /** No duplicate business effect: openings, debts, customers, services, archive revisions. */
  'RERUN_NO_DUPLICATES',
] as const;
export type LegacyFinalReportV2Invariant = (typeof LEGACY_FINAL_REPORT_V2_INVARIANTS)[number];

// --- HTTP ---------------------------------------------------------------------------------

export const LEGACY_CUTOVER_ROUTES = {
  approvals: '/legacy-cutover/approvals',
  readSets: '/legacy-cutover/read-sets',
  applyRuns: '/legacy-cutover/apply-runs',
  revoke: (id: string) => `/legacy-cutover/approvals/${encodeURIComponent(id)}/revoke`,
} as const;

/**
 * A SHA-256 exactly as the CLI prints it: 64 lowercase hex characters. Never trimmed or
 * case-folded — a value that is not already exact is a different value, refused.
 */
export const legacyCutoverHexSchema = z.string().regex(/^[0-9a-f]{64}$/u);

const idempotencyKey = z.string().min(8).max(255);
const reason = z
  .string()
  .trim()
  .min(1)
  .max(LEGACY_CUTOVER_REASON_MAX_LENGTH)
  .refine((value) => !/\p{Cc}/u.test(value), { message: 'no control characters' });

export const legacyCutoverApprovalViewSchema = z.object({
  id: z.string(),
  kind: legacyCutoverApprovalKindSchema,
  sourceFingerprint: z.string(),
  panelMapFingerprint: z.string(),
  inventoryFingerprint: z.string(),
  productsFingerprint: z.string(),
  invoiceArchiveFingerprint: z.string(),
  freezeProofSha256: z.string(),
  finalDumpSha256: z.string(),
  /** RERUN_OVER_PRIOR_IMPORT only: the earlier source this re-run goes over. */
  priorSourceFingerprint: z.string().nullable(),
  /** The read sets it binds were read from a SYNTHETIC-marked source: never a real approval. */
  synthetic: z.boolean(),
  reason: z.string(),
  approvedByAdminId: z.string(),
  approvedAt: z.iso.datetime(),
  revocation: z
    .object({
      revokedByAdminId: z.string(),
      revokedAt: z.iso.datetime(),
      reason: z.string(),
    })
    .nullable(),
});
export type LegacyCutoverApprovalView = z.infer<typeof legacyCutoverApprovalViewSchema>;

export const legacyCutoverListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(LEGACY_CUTOVER_PAGE_MAX).optional(),
  /** The last `id` of the page before (uuid v7, so id order is record order). */
  after: z.uuid().optional(),
});
export type LegacyCutoverListQuery = z.infer<typeof legacyCutoverListQuerySchema>;

export const legacyCutoverApprovalListResponseSchema = z.object({
  approvals: z.array(legacyCutoverApprovalViewSchema),
  nextCursor: z.string().nullable(),
});
export type LegacyCutoverApprovalListResponse = z.infer<
  typeof legacyCutoverApprovalListResponseSchema
>;

/** One recorded read set observation an approval can bind to. Hashes and counts only. */
export const legacyCutoverReadSetViewSchema = z.object({
  id: z.string(),
  readSet: z.string(),
  fingerprintVersion: z.string(),
  readSetFingerprint: z.string(),
  sourceFingerprint: z.string(),
  synthetic: z.boolean(),
  tableCount: z.number().int().nonnegative(),
  rowCount: z.string(),
  recordedAt: z.iso.datetime(),
});
export type LegacyCutoverReadSetView = z.infer<typeof legacyCutoverReadSetViewSchema>;

export const legacyCutoverReadSetListResponseSchema = z.object({
  readSets: z.array(legacyCutoverReadSetViewSchema),
  nextCursor: z.string().nullable(),
});
export type LegacyCutoverReadSetListResponse = z.infer<
  typeof legacyCutoverReadSetListResponseSchema
>;

/** One APPLY run of this tenant: what a re-run acknowledgement can name as prior. */
export const legacyCutoverApplyRunViewSchema = z.object({
  id: z.string(),
  status: z.string(),
  sourceFingerprint: z.string(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type LegacyCutoverApplyRunView = z.infer<typeof legacyCutoverApplyRunViewSchema>;

export const legacyCutoverApplyRunListResponseSchema = z.object({
  runs: z.array(legacyCutoverApplyRunViewSchema),
  nextCursor: z.string().nullable(),
});
export type LegacyCutoverApplyRunListResponse = z.infer<
  typeof legacyCutoverApplyRunListResponseSchema
>;

/**
 * Record an approval. Every binding value is required and exact; `priorSourceFingerprint` is
 * required for (and only for) `RERUN_OVER_PRIOR_IMPORT`.
 */
export const legacyCutoverApproveRequestSchema = z
  .object({
    idempotencyKey,
    kind: legacyCutoverApprovalKindSchema,
    sourceFingerprint: legacyCutoverHexSchema,
    panelMapFingerprint: legacyCutoverHexSchema,
    inventoryFingerprint: legacyCutoverHexSchema,
    productsFingerprint: legacyCutoverHexSchema,
    invoiceArchiveFingerprint: legacyCutoverHexSchema,
    freezeProofSha256: legacyCutoverHexSchema,
    finalDumpSha256: legacyCutoverHexSchema,
    priorSourceFingerprint: legacyCutoverHexSchema.nullable(),
    reason,
  })
  .strict()
  .refine(
    (r) =>
      r.kind === 'RERUN_OVER_PRIOR_IMPORT'
        ? r.priorSourceFingerprint !== null && r.priorSourceFingerprint !== r.sourceFingerprint
        : r.priorSourceFingerprint === null,
    {
      message:
        'a re-run acknowledgement names a prior source other than this one; a cutover approval names none',
      path: ['priorSourceFingerprint'],
    },
  );
export type LegacyCutoverApproveRequest = z.infer<typeof legacyCutoverApproveRequestSchema>;

export const legacyCutoverRevokeRequestSchema = z.object({ idempotencyKey, reason }).strict();
export type LegacyCutoverRevokeRequest = z.infer<typeof legacyCutoverRevokeRequestSchema>;

export const legacyCutoverApprovalResponseSchema = z.object({
  approval: legacyCutoverApprovalViewSchema,
});
export type LegacyCutoverApprovalResponse = z.infer<typeof legacyCutoverApprovalResponseSchema>;
