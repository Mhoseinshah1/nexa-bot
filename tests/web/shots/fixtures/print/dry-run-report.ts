import { legacyMigrationImportListResponseSchema } from '@nexa/contracts';
import { ago, fixture, type ShotFixture } from '../../fixture.ts';

/*
 * SFR A4 — the recovery page with a Mirza import whose dry run is DONE, so its report is drawn:
 * the fixture `pnpm web:print-shots` prints, to prove the report (labels AND numbers) fits the
 * printed page. Sample numbers for a screenshot, never the app's.
 */
const H = (c: string): string => c.repeat(64);
const ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292e1';

const sections = [
  {
    section: 'customers',
    source: 197_412,
    imported: 196_980,
    archived: 0,
    skipped: 432,
    quarantined: 0,
  },
  {
    section: 'table:user',
    source: 197_412,
    imported: 196_980,
    archived: 0,
    skipped: 432,
    quarantined: 0,
  },
  {
    section: 'table:invoice',
    source: 138_220,
    imported: 31_004,
    archived: 107_216,
    skipped: 0,
    quarantined: 0,
  },
  {
    section: 'history:payment',
    source: 1_031_877,
    imported: 0,
    archived: 1_031_877,
    skipped: 0,
    quarantined: 0,
  },
];

export const PRINT_DRY_RUN_REPORT: readonly ShotFixture[] = [
  fixture('/legacy-migration/imports', legacyMigrationImportListResponseSchema, {
    imports: [
      {
        id: ID,
        status: 'DRY_RUN_DONE',
        errorCode: null,
        fileName: 'nexa-restore-mirza-2026-11-08.nxpkg',
        fileSha256: H('a'),
        fileBytes: '139460608',
        packageImportId: 'pkg-print',
        packageSourceFingerprint: H('b'),
        packageSchemaVersion: '1.4.0',
        converterVersion: '0.5.0',
        keyPresent: true,
        keyKind: 'PASSPHRASE',
        decisionsPresent: false,
        panelBindings: null,
        verifyReport: {
          packageImportId: 'pkg-print',
          sourceFingerprint: H('b'),
          packageSchemaVersion: '1.4.0',
          converterVersion: '0.5.0',
          synthetic: false,
          panelTargets: [{ codePanel: 'P1', providerType: 'rickpanel', services: 31_004 }],
          recordCounts: [{ code: 'user', count: 197_412 }],
          decisions: null,
        },
        dryRunReport: {
          importerVerdict: 'READY',
          sections,
          warnings: [{ code: 'TRIAL_CONSUMED', count: 1_204 }],
          quarantine: [{ code: 'SERVICE_OWNER_UNPROVEN', count: 87 }],
          wallets: {
            currency: 'IRT',
            customers: 196_980,
            beforeTotalMinor: '0',
            afterTotalMinor: '4812300000',
          },
          debts: { currency: 'IRT', count: 312, totalMinor: '-18450000' },
          ownership: {
            decisionsProvided: false,
            proven: 30_917,
            adminApprovedUnverified: 0,
            quarantined: 87,
            rejected: 0,
            pending: 0,
            stale: 0,
          },
          cutover: {
            sourceFingerprint: H('b'),
            panelMapFingerprint: H('c'),
            inventoryFingerprint: H('d'),
            productsFingerprint: H('e'),
            invoiceArchiveFingerprint: H('f'),
            freezeProofSha256: H('1'),
            finalDumpSha256: H('2'),
          },
          planTalliesDigest: H('3'),
        },
        dryRunSha256: H('4'),
        approvedDryRunSha256: null,
        applyReport: null,
        adoptReport: null,
        dryRunLegacyRunId: null,
        applyLegacyRunId: null,
        adoptLegacyRunId: null,
        backupRunId: null,
        preImportBackupRunId: null,
        progress: {
          phase: 'DRY_RUN',
          applyAttempts: 0,
          verifyAttempts: 1,
          dryRunAttempts: 1,
          adoptAttempts: 0,
          importerVerdict: null,
          reconcileVerdict: null,
          history: [],
          refusalCounts: [],
          backup: null,
          blocker: null,
        },
        working: false,
        requestedByAdminId: '01900000-0000-7000-8000-000000000a01',
        approvedByAdminId: null,
        approvedAt: null,
        createdAt: ago(90),
        updatedAt: ago(30),
        finishedAt: null,
      },
    ],
    nextCursor: null,
  }),
];
