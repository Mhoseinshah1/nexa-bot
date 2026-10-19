import {
  LEGACY_SERVICE_OUTCOMES,
  LEGACY_SERVICE_REVIEW_STATES,
  backupHistoryResponseSchema,
  backupStatusResponseSchema,
  installationKeysResponseSchema,
  legacyCutoverApplyRunListResponseSchema,
  legacyCutoverApprovalListResponseSchema,
  legacyCutoverReadSetListResponseSchema,
  legacyMigrationImportListResponseSchema,
  legacyProductReviewListResponseSchema,
  legacyServiceCandidateListResponseSchema,
  legacyServiceCandidateSummaryResponseSchema,
  recoveryListResponseSchema,
} from '@nexa/contracts';
import { ago, fixture, type ShotFixture } from '../../fixture.ts';

/*
 * DEMO PARITY — the recovery family: «بکاپ و بازیابی» (`/recovery`) and the three legacy
 * review pages (`/legacy-products`, `/legacy-services`, `/legacy-cutover`), fed the approved
 * demo's own sample rows (`approved-demo.html#/recovery`, `#/legacy-…`), so a side-by-side
 * compares like with like and every state a DIFFS bullet names is drawn: the latest backup
 * whose cleanup did not finish, the server's three keys, a failed restore request, the
 * earlier restores of a legacy package, a product whose source changed / is duplicated / was
 * absent from the last read, every result category of the service review, and an active and
 * a revoked cutover approval over synthetic and real read sets.
 *
 * Every body is parsed by its response schema in `tests/web/shots-fixtures.test.tsx`.
 */

type Json = Record<string, unknown>;

const H = (c: string): string => c.repeat(64);
const HOUR = 60;
const DAY = 24 * HOUR;
const RUN_ID = '019600ab-cdef-7012-8345-6789abcd0099';
const ADMIN_ID = '019600ab-cdef-7012-8345-6789abcd0201';

// --- /recovery ---------------------------------------------------------------------------------

function run(n: number, minutes: number, over: Json = {}): Json {
  return {
    id: `01a05e35-c9ad-7e93-bef3-1ed9b5529c${String(n).padStart(2, '0')}`,
    trigger: 'SCHEDULED',
    state: 'SUCCEEDED',
    stage: 'CLEANUP',
    startedAt: ago(minutes),
    finishedAt: ago(minutes - 4),
    dumpBytes: '1689600',
    archiveBytes: '422912',
    checksum: '52592509abc2717aec25af1a8ec65d3aebbb65db164a9d19254eaa2bbf5b9f51',
    verifiedAt: ago(minutes - 3),
    deliveryState: 'SUCCEEDED',
    deliveryAttemptedAt: ago(minutes - 3),
    deliveryDetailPresent: true,
    failureCode: null,
    cleanupOk: true,
    cleanupLeftovers: 0,
    archiveAvailable: false,
    archiveFormat: 'NXB',
    partCount: 1,
    partsDelivered: 0,
    parts: [],
    summaryDeliveryState: null,
    ...over,
  };
}

/** The demo's ten newest runs: the newest left plaintext behind; three can still be fetched. */
const RUNS = [
  run(1, 5 * HOUR, { cleanupOk: false, cleanupLeftovers: 2, archiveAvailable: true }),
  run(2, 17 * HOUR, { deliveryState: 'OUTCOME_UNKNOWN', archiveAvailable: true }),
  run(3, 19 * HOUR + 40, { trigger: 'MANUAL', archiveBytes: '421680', archiveAvailable: true }),
  run(4, 29 * HOUR, { archiveBytes: '420032' }),
  run(5, 41 * HOUR, {
    state: 'FAILED',
    stage: 'VERIFY_RESTORE',
    archiveBytes: null,
    checksum: null,
    verifiedAt: null,
    deliveryState: 'NOT_ATTEMPTED',
    deliveryAttemptedAt: null,
    deliveryDetailPresent: false,
    failureCode: 'RESTORE_FAILED',
  }),
  run(6, 53 * HOUR, { deliveryState: 'FAILED_DEFINITIVE' }),
  run(7, 65 * HOUR),
  run(8, 77 * HOUR),
  run(9, 83 * HOUR - 50, {
    trigger: 'PRE_RESTORE',
    deliveryState: 'NOT_ATTEMPTED',
    deliveryAttemptedAt: null,
    deliveryDetailPresent: false,
  }),
  run(10, 101 * HOUR),
];

const deps = (secrets: number, wrappedKeys: number, retainedArchives: number): Json => ({
  secrets,
  wrappedKeys,
  retainedArchives,
  openRecoveries: 0,
});

const KEYS = [
  {
    keyId: 'nexa-kek-2026a',
    fingerprint: 'b41c9e07d2aa3f58c1e09b7a24f6d3e5',
    origin: 'CONFIGURED_ACTIVE',
    encrypts: true,
    importedAt: null,
    importedBy: null,
    available: true,
    dependencies: deps(14, 2, 4),
    arrivedByRestore: false,
    removable: false,
  },
  {
    keyId: 'nexa-kek-2025b',
    fingerprint: '0e77a1c3b2d94f6a8b5c07e1d3f2a946',
    origin: 'CONFIGURED',
    encrypts: false,
    importedAt: null,
    importedBy: null,
    available: true,
    dependencies: deps(0, 0, 9),
    arrivedByRestore: false,
    removable: false,
  },
  {
    keyId: 'oldsrv-kek-2025',
    fingerprint: '9a8b7c6d5e4f30214b6c8d0e2f4a6b8c',
    origin: 'IMPORTED',
    encrypts: false,
    importedAt: ago(17 * DAY + 9 * HOUR),
    importedBy: 'owner',
    available: true,
    dependencies: deps(0, 0, 0),
    arrivedByRestore: false,
    removable: true,
  },
];

const recovery = (n: number, over: Json): Json => ({
  id: `01a05e35-c9ad-7e93-bef3-1ed9b5529d0${n}`,
  source: 'UPLOAD',
  state: 'SUCCEEDED',
  stage: 'DONE',
  createdAt: ago(9 * DAY),
  updatedAt: ago(9 * DAY - 40),
  requestedBy: 'm.hosein',
  backupId: null,
  artifactChecksum: H('b'),
  failureCode: null,
  correlationId: null,
  upload: null,
  verification: null,
  restoreTest: null,
  confirmedAt: null,
  confirmationExpiresAt: null,
  preRestoreBackupId: null,
  cutoverAt: null,
  displacedDatabase: null,
  finishedAt: ago(9 * DAY - 40),
  ...over,
});

const RECOVERIES = [
  recovery(1, {
    state: 'FAILED',
    stage: 'CLEANUP',
    createdAt: ago(4 * DAY + 2 * HOUR),
    updatedAt: ago(4 * DAY + HOUR),
    failureCode: 'recovery.checksum_mismatch',
    finishedAt: ago(4 * DAY + HOUR),
  }),
  recovery(2, {
    createdAt: ago(17 * DAY),
    updatedAt: ago(17 * DAY - 40),
    confirmedAt: ago(17 * DAY - 10),
    cutoverAt: ago(17 * DAY - 35),
    displacedDatabase: 'nexa_pre_restore_01a05e35',
    finishedAt: ago(17 * DAY - 40),
  }),
];

const PROGRESS = {
  phase: null,
  applyAttempts: 0,
  verifyAttempts: 0,
  dryRunAttempts: 0,
  adoptAttempts: 0,
  importerVerdict: null,
  reconcileVerdict: null,
  history: [],
  refusalCounts: [],
  backup: null,
  blocker: null,
};

const legacyImport = (n: number, fileName: string, minutes: number, over: Json): Json => ({
  id: `019600ab-cdef-7012-8345-6789abcd040${n}`,
  status: 'CANCELLED',
  errorCode: null,
  fileName,
  fileSha256: H(String(n)),
  fileBytes: '7340032',
  packageImportId: null,
  packageSourceFingerprint: null,
  packageSchemaVersion: null,
  converterVersion: null,
  keyPresent: false,
  keyKind: null,
  decisionsPresent: false,
  panelBindings: null,
  verifyReport: null,
  dryRunReport: null,
  dryRunSha256: null,
  approvedDryRunSha256: null,
  applyReport: null,
  adoptReport: null,
  dryRunLegacyRunId: null,
  applyLegacyRunId: null,
  adoptLegacyRunId: null,
  backupRunId: null,
  preImportBackupRunId: null,
  progress: PROGRESS,
  working: false,
  requestedByAdminId: ADMIN_ID,
  approvedByAdminId: null,
  approvedAt: null,
  createdAt: ago(minutes),
  updatedAt: ago(minutes - 30),
  finishedAt: ago(minutes - 30),
  ...over,
});

/** Earlier restores of a legacy package, all finished: one with a discrepancy, two stopped. */
const IMPORTS = [
  legacyImport(1, 'mirza-export-0712.nxpkg', 6 * DAY + 13 * HOUR, {
    status: 'COMPLETED_WITH_DISCREPANCY',
    preImportBackupRunId: '01a05e35-c9ad-7e93-bef3-1ed9b5529c71',
    approvedByAdminId: ADMIN_ID,
    approvedAt: ago(6 * DAY + 13 * HOUR - 20),
  }),
  legacyImport(2, 'mirza-export-0710.nxpkg', 8 * DAY + 16 * HOUR, {
    status: 'VERIFY_FAILED',
    errorCode: 'NXPKG_WRONG_KEY',
    keyPresent: true,
    keyKind: 'PASSPHRASE',
  }),
  legacyImport(3, 'mirza-test.nxpkg', 9 * DAY + 20 * HOUR, { errorCode: 'CANCELLED' }),
];

// --- /legacy-products --------------------------------------------------------------------------

const legacyProduct = (
  n: number,
  code: string,
  legacyId: number,
  name: string | null,
  gb: number | null,
  days: number | null,
  price: string | null,
  live: number,
  over: Json = {},
): Json => ({
  id: `019600ab-cdef-7012-8345-6789abcd05${String(n).padStart(2, '0')}`,
  codeProduct: code,
  legacyProductId: String(legacyId),
  state: 'PENDING_REVIEW',
  facts: [
    {
      id: String(legacyId),
      code_product: code,
      name_product: name,
      price_product: price,
      Volume_constraint: gb === null ? '0' : String(gb),
      Service_time: days === null ? null : String(days),
      hide_panel: '{}',
    },
  ],
  factsChecksum: H(String(n % 10)),
  sourceConflict: null,
  title: name,
  trafficBytes: gb === null ? null : String(BigInt(gb) * 1024n ** 3n),
  durationDays: days,
  historicalPriceRaw: price,
  historicalPriceMinor: price,
  historicalPriceCurrency: price === null ? null : 'IRT',
  parseNotes: {},
  liveInvoiceCount: live,
  approvedProductId: null,
  approvedProductTitle: null,
  approvedFactsChecksum: null,
  priorState: null,
  decisionReason: null,
  decidedByAdminId: null,
  decidedAt: null,
  readFingerprint: H('a'),
  sourceFingerprint: H('b'),
  missingSinceReadFingerprint: null,
  exportable: false,
  version: 1,
  createdAt: ago(2 * DAY),
  updatedAt: ago(2 * DAY),
  ...over,
});

const PRODUCTS = [
  legacyProduct(1, '1m50', 12, 'یک ماهه ۵۰ گیگ', 50, 30, '290000', 412),
  legacyProduct(2, '1mUL', 14, 'یک ماهه نامحدود', null, 30, '420000', 263),
  legacyProduct(3, 'vip500', 21, 'ویژه ۵۰۰ گیگ', 500, 30, '1900000', 7, {
    state: 'SOURCE_CHANGED',
  }),
  legacyProduct(4, 'test1', 2, 'تست رایگان', 1, 1, '0', 0),
  legacyProduct(5, 'gift20', 24, 'هدیه ۲۰ گیگ', 20, 15, null, 0, {
    missingSinceReadFingerprint: H('c'),
  }),
  legacyProduct(6, '2m80', 25, 'دو ماهه ۸۰ گیگ', 80, 60, '520000', 57, {
    sourceConflict: 'CODE_DUPLICATED',
  }),
  legacyProduct(7, '6mold', 9, 'شش ماهه ۳۰۰ گیگ', 300, 180, null, 3, {
    historicalPriceRaw: '۱,۲۰۰,۰۰۰',
  }),
  legacyProduct(8, 'nl1m', 27, 'هلند یک ماهه ۴۰ گیگ', 40, null, '330000', 41),
  legacyProduct(9, 'xk92', 29, null, 100, 30, '410000', 12),
];

// --- /legacy-services --------------------------------------------------------------------------

const candidate = (
  n: number,
  invoiceKey: string,
  outcome: string,
  panelCode: string | null,
  productCode: string,
  minutes: number,
): Json => ({
  id: `019600ab-cdef-7012-8345-6789abcd06${String(n).padStart(2, '0')}`,
  invoiceKey,
  outcome,
  blocker: null,
  reviewState: 'OPEN',
  panelCode,
  productCode,
  evidence: {
    panelCodeClass: panelCode === null ? 'EMPTY' : 'MAPPED',
    mappedPanelId: null,
    customer: 'IMPORTED',
    holders: [],
    incompletePanels: [],
    product: { path: 'HIDDEN_SHAPE', productId: null, resolved: true },
    claims: 1,
  },
  archiveId: null,
  serviceId: null,
  approvedPanelId: null,
  lastApprovalRefusal: null,
  decisionReason: null,
  decidedByAdminId: null,
  decidedAt: null,
  runId: RUN_ID,
  sourceFingerprint: H('b'),
  invoiceChecksum: H(String(n % 10)),
  synthetic: false,
  observedAt: ago(minutes),
  version: 1,
  firstDecidedAt: ago(minutes),
  updatedAt: ago(minutes),
});

const CANDIDATES = [
  candidate(1, 'd9bddb9d', 'NO_PANEL', null, '1m50', 5 * DAY + 11 * HOUR),
  candidate(2, 'cad9113b', 'NO_PANEL', null, '1mUL', 4 * DAY + 10 * HOUR),
  candidate(3, '07493034', 'AMBIGUOUS_PANEL', null, '3m150', 3 * DAY + 9 * HOUR),
  candidate(4, 'ca0c1557', 'ADOPTION_ELIGIBLE', 'NL-1', '1mUL', 2 * DAY + 8 * HOUR),
  candidate(5, 'b81cd214', 'PROVIDER_MISSING', 'TR-1', 'tr30', DAY + 7 * HOUR),
  candidate(6, 'c3eef490', 'PANEL_UNMAPPED', 'OLD-SRV-3', '1m50', 5 * DAY + 6 * HOUR),
  candidate(7, '4cc17b77', 'INVENTORY_INCOMPLETE', 'FI-1', '1m50', 3 * DAY + 5 * HOUR),
  candidate(8, '34d2e04f', 'PROVIDER_READ_FAILED', 'NL-1', '3m150', 2 * DAY + 4 * HOUR),
  candidate(9, '0739f993', 'CUSTOMER_NOT_IMPORTED', 'DE-1', '1m50', DAY + 3 * HOUR),
  candidate(10, 'c2662382', 'ORPHAN', 'DE-1', '1m50', 5 * DAY + 2 * HOUR),
];

/** The demo's counts: every result category it lists, each with its own number. */
const BY_OUTCOME: Readonly<Record<string, number>> = {
  ADOPTED: 2,
  ALREADY_ADOPTED: 1,
  ADOPTION_ELIGIBLE: 2,
  INVOICE_KEY_INVALID: 1,
  TEST_INVOICE_SKIPPED: 1,
  TEST_PANEL_SKIPPED: 1,
  INVALID_SOURCE_ROW: 1,
  ORPHAN: 1,
  CUSTOMER_NOT_IMPORTED: 1,
  INVALID_USERNAME: 1,
  INVENTORY_INCOMPLETE: 1,
  NO_PANEL: 3,
  PANEL_UNMAPPED: 2,
  PROVIDER_MISSING: 1,
  AMBIGUOUS_PANEL: 2,
  USERNAME_CASE_COLLISION: 1,
  AMBIGUOUS_OWNERSHIP: 1,
  UNSUPPORTED_SHAPE: 1,
  PRODUCT_UNRESOLVED: 1,
  SUBSCRIPTION_REF_BLOCKED: 1,
  PROVIDER_READ_FAILED: 1,
  REVIEW_CLOSED: 1,
};

// --- /legacy-cutover ---------------------------------------------------------------------------

const SOURCE_REAL = '0bea10bbfe80333f179b45da791b59751397fd1c945971d51dc797a1b5a83cd8';
const SOURCE_SYNTHETIC = '75bddf9b295576a72777d0e672ef1994974bb15fe22399bdc0cbc796e6fc88aa';
const SOURCE_FROZEN = '2d3f322b02f2d7c656f400990dbe868fba63cfd1a3e0bb8665df1651e75c664b';

const approval = (n: number, source: string, minutes: number, over: Json): Json => ({
  id: `019600ab-cdef-7012-8345-6789abcd070${n}`,
  kind: 'CUTOVER',
  sourceFingerprint: source,
  panelMapFingerprint: H('1'),
  inventoryFingerprint: H('2'),
  productsFingerprint: H('3'),
  invoiceArchiveFingerprint: H('4'),
  freezeProofSha256: H('5'),
  finalDumpSha256: H('6'),
  priorSourceFingerprint: null,
  synthetic: false,
  reason: 'انتقال نهایی پس از بازبینی',
  approvedByAdminId: ADMIN_ID,
  approvedAt: ago(minutes),
  revocation: null,
  ...over,
});

const APPROVALS = [
  approval(1, SOURCE_SYNTHETIC, 9 * DAY + 2 * HOUR, { synthetic: true }),
  approval(2, SOURCE_REAL, 16 * DAY + 4 * HOUR, {
    revocation: {
      revokedByAdminId: ADMIN_ID,
      revokedAt: ago(14 * DAY),
      reason: 'نسخهٔ منجمد تازه‌تری گرفته شد',
    },
  }),
];

const READ_SET_NAMES = ['invoices', 'products', 'inventory'] as const;
const READ_SETS = [
  ...READ_SET_NAMES.map((name, i) => [SOURCE_FROZEN, false, 2 * DAY + i * 4, name] as const),
  ...READ_SET_NAMES.map((name, i) => [SOURCE_SYNTHETIC, true, 10 * DAY + i, name] as const),
  ...READ_SET_NAMES.map((name, i) => [SOURCE_REAL, false, 16 * DAY + i * 3, name] as const),
].map(([source, synthetic, minutes, readSet], n) => ({
  id: `019600ab-cdef-7012-8345-6789abcd08${String(n).padStart(2, '0')}`,
  readSet,
  fingerprintVersion: `legacy-read-set:${readSet}:v1`,
  readSetFingerprint: H(String(n + 1)),
  sourceFingerprint: source,
  synthetic,
  tableCount: 3,
  rowCount: String(120 + n * 40),
  recordedAt: ago(minutes),
}));

const APPLY_RUNS = [
  { status: 'COMPLETED', source: SOURCE_REAL, minutes: 20 * DAY },
  { status: 'FAILED', source: SOURCE_REAL, minutes: 15 * DAY },
  { status: 'COMPLETED', source: SOURCE_SYNTHETIC, minutes: 9 * DAY },
].map((row, n) => ({
  id: `019600ab-cdef-7012-8345-6789abcd090${n}`,
  status: row.status,
  sourceFingerprint: row.source,
  startedAt: ago(row.minutes),
  finishedAt: ago(row.minutes - 30),
}));

export const DEMO_RECOVERY: readonly ShotFixture[] = [
  fixture('/backups/status', backupStatusResponseSchema, {
    scheduleEnabled: true,
    intervalMs: 12 * 60 * 60 * 1000,
    scheduleSource: { enabled: 'SETTING', interval: 'SETTING' },
    deliveryDestination: 'OPS_GROUP_TOPIC',
    lastSucceededAt: ago(5 * HOUR - 4),
    running: null,
    unknownDeliveries: 1,
    quiesced: false,
    archivePassword: { configured: false, setAt: null },
  }),
  fixture('/backups', backupHistoryResponseSchema, {
    runs: RUNS,
    nextCursor: '01a05e35-c9ad-7e93-bef3-1ed9b5529c10',
  }),
  fixture('/recovery-kit/keys', installationKeysResponseSchema, { keys: KEYS }),
  fixture('/recoveries', recoveryListResponseSchema, { recoveries: RECOVERIES, nextCursor: null }),
  fixture('/legacy-migration/imports', legacyMigrationImportListResponseSchema, {
    imports: IMPORTS,
    nextCursor: null,
  }),
  fixture('/legacy-products', legacyProductReviewListResponseSchema, {
    reviews: PRODUCTS,
    nextCursor: '019600ab-cdef-7012-8345-6789abcd0509',
  }),
  fixture('/legacy-services', legacyServiceCandidateListResponseSchema, {
    candidates: CANDIDATES,
    nextCursor: '019600ab-cdef-7012-8345-6789abcd0610',
  }),
  fixture('/legacy-services/summary', legacyServiceCandidateSummaryResponseSchema, {
    candidateCount: Object.values(BY_OUTCOME).reduce((sum, n) => sum + n, 0),
    byOutcome: Object.fromEntries(LEGACY_SERVICE_OUTCOMES.map((o) => [o, BY_OUTCOME[o] ?? 0])),
    byReviewState: Object.fromEntries(
      LEGACY_SERVICE_REVIEW_STATES.map((s) => [s, s === 'OPEN' ? 19 : s === 'ADOPTED' ? 3 : 0]),
    ),
  }),
  fixture('/legacy-cutover/approvals', legacyCutoverApprovalListResponseSchema, {
    approvals: APPROVALS,
    nextCursor: null,
  }),
  fixture('/legacy-cutover/read-sets', legacyCutoverReadSetListResponseSchema, {
    readSets: READ_SETS,
    nextCursor: null,
  }),
  fixture('/legacy-cutover/apply-runs', legacyCutoverApplyRunListResponseSchema, {
    runs: APPLY_RUNS,
    nextCursor: null,
  }),
];
