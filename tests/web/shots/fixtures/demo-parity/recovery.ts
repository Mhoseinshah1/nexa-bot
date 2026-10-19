import {
  backupHistoryResponseSchema,
  backupStatusResponseSchema,
  installationKeysResponseSchema,
  legacyMigrationImportListResponseSchema,
  recoveryListResponseSchema,
} from '@nexa/contracts';
import { ago, fixture, type ShotFixture } from '../../fixture.ts';

/*
 * DEMO PARITY — the recovery family: «بکاپ و بازیابی» (`/recovery`) — the three legacy review pages were retired
 * in Round 4 B4 — fed the approved demo's own sample rows (`approved-demo.html#/recovery`), so a side-by-side
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
];
