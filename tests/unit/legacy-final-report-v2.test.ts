import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_FINAL_REPORT_V2_INVARIANTS,
  type LegacyFinalReportV2Invariant,
} from '@nexa/contracts';
import {
  buildFinalReportV2,
  type FinalReportV2Input,
} from '../../apps/api/src/modules/platform/legacy-importer/application/final-report-v2';
import { reportHolds } from '../../apps/api/src/modules/platform/legacy-importer/application/legacy-importer.service';
import { loadRefs, validate } from '../../scripts/legacy-rehearsal-report-check.mjs';

/**
 * Mirza migration PR6 — the final report, schema version 2. Its verdict is the AND of every
 * section and of the seven reconciliation invariants: each case below breaks ONE fact and
 * requires the verdict to flip, naming exactly what failed. Version 1's schema is pinned by its
 * SHA-256 (it is never edited; version 2 carries it), and version 2's schema uses only the
 * keywords the rehearsal's validator implements.
 */

const FP = 'f'.repeat(64);
const H = (c: string) => c.repeat(64);
const V1_SCHEMA = 'docs/legacy-migration/final-report.schema.json';
const V2_SCHEMA = 'docs/legacy-migration/final-report-v2.schema.json';
/** Version 1, byte for byte, as on origin/main before Mirza PR6. Editing it is a new version. */
const V1_PINNED = '697efa8ab07ef3258fba6500f633c7112cff1fe492c8d8b049f5d55efd39ae84';
const V1_SCHEMA_SHA256 = createHash('sha256').update(readFileSync(V1_SCHEMA)).digest('hex');

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

function holdingInput(): Mutable<FinalReportV2Input> {
  const check = (id: string) => ({ id, what: id, holds: true, expected: '1', actual: '1' });
  return {
    core: {
      evidenceClass: 'staging',
      generatedAt: '2026-10-07T00:00:00.000Z',
      run: { runId: '0190aaaa-0000-7000-8000-000000000001' },
      reconciliation: ['C1', 'C3', 'W1', 'W4', 'W5', 'S3', 'P3'].map((id) => ({
        id,
        holds: true,
        expected: '1',
        actual: '1',
      })),
    } as never,
    usersWallets: {
      checks: ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8'].map(check),
      holds: true,
      wallet: {
        legacyDebts: { users: 1, recorded: 1, recordedSumMinor: '20000' },
        perUser: { conflicting: 0 },
      },
      sourceChanged: { users: 0 },
    } as never,
    serviceOutcomes: {
      invariant: { holds: true },
      candidates: 2,
      recorded: 2,
      archivedHistory: { notAdopted: 1, linkedToArchive: 1, notLinkedToArchive: 0 },
    } as never,
    snapshot: {
      fingerprint: FP,
      synthetic: false,
      productCodes: new Set(['p1', 'p2']),
      tables: { invoice: { rows: 3 } } as never,
    },
    inventory: {
      fingerprintVersion: 'legacy-read-set:inventory:v1',
      fingerprint: H('1'),
      synthetic: false,
      importV1: { fingerprint: FP, schemaHash: H('2'), expected: FP, bound: true },
      tables: [{ class: 'SUPPORTED' }, { class: 'SUPPORTED' }],
      totals: { tables: 2, rows: 5 },
      verdict: 'COMPLETE',
    } as never,
    facts: {
      approvals: [],
      applyRuns: [],
      readSets: {
        inventory: readSet('inventory', H('1')),
        products: readSet('products', H('3')),
        'invoice-archive': readSet('invoice-archive', H('4')),
      },
      productRows: ['p1', 'p2'].map((codeProduct) => ({
        codeProduct,
        state: 'PENDING_REVIEW',
        readFingerprint: H('3'),
        sourceFingerprint: FP,
        missingSinceReadFingerprint: null,
        sourceConflict: null,
        approvedProductId: null,
        approvedFactsChecksum: null,
        factsChecksum: H('5'),
      })),
      archive: {
        runId: '0190aaaa-0000-7000-8000-000000000002',
        readSetFingerprint: H('4'),
        synthetic: false,
        sourceInvoiceRows: 3n,
        promotedRows: 3n,
        insertedNew: 3n,
        insertedRevision: 0n,
        unchanged: 0n,
        missingInSnapshot: 0n,
        archiveInvoicesAfter: 3n,
        archivedInvoicesNow: 3n,
      },
      duplicates: {
        debtsPerCustomerMax: 1,
        customersPerTelegramIdMax: 1,
        invoicesPerAdoptedServiceMax: 1,
        adoptionOrders: 1,
        mappedAdoptedServices: 1,
        archiveRepeatedRevisions: 0,
      },
      applyOutcome: {
        serviceApprovals: { executed: 0, withdrawnDuringRun: 0, unconfirmed: 0 },
        attention: { approvalUnconfirmed: 0, total: 0 },
      },
      runCutoverApprovalId: null,
    },
    productMap: new Map<string, string>(),
    openingsPerCustomerMax: 1,
  } as Mutable<FinalReportV2Input>;
}

function readSet(name: string, fingerprint: string) {
  return {
    id: '0190aaaa-0000-7000-8000-00000000000a',
    readSet: name as never,
    fingerprintVersion: `legacy-read-set:${name}:v1`,
    readSetFingerprint: fingerprint,
    sourceFingerprint: FP,
    synthetic: false,
    tableCount: 1,
    rowCount: 1n,
    recordedAt: new Date('2026-10-07T00:00:00Z'),
  };
}

const failed = (input: Mutable<FinalReportV2Input>) => buildFinalReportV2(input as never).verdict;

describe('final report v2: the verdict is the AND of every section and every invariant', () => {
  it('a report where everything was read and holds, holds', () => {
    expect(failed(holdingInput())).toEqual({
      holds: true,
      failedSections: [],
      failedInvariants: [],
    });
  });

  const invariantCases: readonly [
    LegacyFinalReportV2Invariant,
    string,
    (i: Mutable<FinalReportV2Input>) => void,
  ][] = [
    [
      'USERS_ACCOUNTED',
      'a source user in no outcome (C1)',
      (i) => {
        (i.core as any).reconciliation[0].holds = false;
      },
    ],
    [
      'USERS_ACCOUNTED',
      'PR4 user closure U1',
      (i) => {
        (i.usersWallets as any).checks[0].holds = false;
      },
    ],
    [
      'INVOICES_ACCOUNTED',
      'the archive read another invoice count than the snapshot (A1)',
      (i) => {
        (i.facts.archive as any).sourceInvoiceRows = 2n;
        (i.facts.archive as any).promotedRows = 2n;
        (i.facts.archive as any).archiveInvoicesAfter = 2n;
      },
    ],
    [
      'INVOICES_ACCOUNTED',
      'no archive run of this source',
      (i) => {
        i.facts.archive = null;
      },
    ],
    [
      'PRODUCTS_ACCOUNTED',
      'a source code with no review row',
      (i) => {
        i.facts.productRows.pop();
      },
    ],
    [
      'PRODUCTS_ACCOUNTED',
      'no products read set recorded for this source',
      (i) => {
        (i.facts.readSets as any).products = null;
      },
    ],
    [
      'WALLETS_RECONCILED',
      'the wallet equation W1',
      (i) => {
        (i.core as any).reconciliation[2].holds = false;
      },
    ],
    [
      'WALLETS_RECONCILED',
      'a debt check U4',
      (i) => {
        (i.usersWallets as any).checks[3].holds = false;
      },
    ],
    [
      'SERVICES_ONE_OUTCOME',
      'a candidate with no outcome',
      (i) => {
        (i.serviceOutcomes as any).invariant.holds = false;
      },
    ],
    [
      'UNRESOLVED_RETAINED',
      'an unadopted invoice not kept as history',
      (i) => {
        (i.serviceOutcomes as any).archivedHistory.notLinkedToArchive = 1;
      },
    ],
    [
      'UNRESOLVED_RETAINED',
      'the archive shrank',
      (i) => {
        (i.facts.archive as any).archivedInvoicesNow = 2n;
      },
    ],
    [
      'UNRESOLVED_RETAINED',
      'a negative user without a recorded debt',
      (i) => {
        (i.usersWallets as any).wallet.legacyDebts.recorded = 0;
      },
    ],
    [
      'RERUN_NO_DUPLICATES',
      'two openings for one customer',
      (i) => {
        i.openingsPerCustomerMax = 2;
      },
    ],
    [
      'RERUN_NO_DUPLICATES',
      'two debts for one customer',
      (i) => {
        i.facts.duplicates.debtsPerCustomerMax = 2;
      },
    ],
    [
      'RERUN_NO_DUPLICATES',
      'two customers for one Telegram id',
      (i) => {
        i.facts.duplicates.customersPerTelegramIdMax = 2;
      },
    ],
    [
      'RERUN_NO_DUPLICATES',
      'one service mapped from two invoices',
      (i) => {
        i.facts.duplicates.invoicesPerAdoptedServiceMax = 2;
      },
    ],
    [
      'RERUN_NO_DUPLICATES',
      'an adoption order with no mapped service',
      (i) => {
        i.facts.duplicates.adoptionOrders = 2;
      },
    ],
    [
      'RERUN_NO_DUPLICATES',
      'an archive revision repeating the one before it',
      (i) => {
        i.facts.duplicates.archiveRepeatedRevisions = 1;
      },
    ],
  ];

  for (const [invariant, what, mutate] of invariantCases) {
    it(`${invariant} flips the verdict: ${what}`, () => {
      const input = holdingInput();
      mutate(input);
      const verdict = failed(input);
      expect(verdict.holds).toBe(false);
      expect(verdict.failedInvariants).toContain(invariant);
    });
  }

  it('every invariant has a case that flips it', () => {
    expect(new Set(invariantCases.map(([id]) => id))).toEqual(
      new Set(LEGACY_FINAL_REPORT_V2_INVARIANTS),
    );
  });

  const sectionCases: readonly [string, string, (i: Mutable<FinalReportV2Input>) => void][] = [
    [
      'core',
      'a v1 equation that no invariant names (C3)',
      (i) => {
        (i.core as any).reconciliation[1].holds = false;
      },
    ],
    [
      'inventory',
      'no fresh inventory was read',
      (i) => {
        i.inventory = null;
      },
    ],
    [
      'inventory',
      'an UNCLASSIFIED table',
      (i) => {
        (i.inventory as any).tables.push({ class: 'UNCLASSIFIED' });
        (i.inventory as any).verdict = 'UNCLASSIFIED_TABLES';
      },
    ],
    [
      'inventory',
      'the fresh inventory is not the one recorded',
      (i) => {
        (i.facts.readSets as any).inventory = readSet('inventory', H('9'));
      },
    ],
    [
      'products',
      'a review row read by another read',
      (i) => {
        (i.facts.productRows[0] as any).readFingerprint = H('9');
      },
    ],
    [
      'invoiceArchive',
      'the archive run read another read set than the one recorded',
      (i) => {
        (i.facts.archive as any).readSetFingerprint = H('9');
      },
    ],
    [
      'invoiceArchive',
      "the archive run's evidence class is not the snapshot's",
      (i) => {
        (i.facts.archive as any).synthetic = true;
      },
    ],
    [
      'usersWallets',
      'the section itself',
      (i) => {
        (i.usersWallets as any).holds = false;
      },
    ],
    [
      'serviceOutcomes',
      'the section itself',
      (i) => {
        (i.serviceOutcomes as any).invariant.holds = false;
      },
    ],
    [
      'cutover',
      'an earlier import superseded unacknowledged',
      (i) => {
        i.facts.applyRuns = [
          {
            id: '0190aaaa-0000-7000-8000-000000000003',
            status: 'COMPLETED',
            sourceFingerprint: H('e'),
            startedAt: new Date(),
            finishedAt: new Date(),
          },
        ];
      },
    ],
    [
      'applyRun',
      "the run's leftovers were never recorded",
      (i) => {
        i.facts.applyOutcome = null;
      },
    ],
    [
      'applyRun',
      'an ADOPTION_UNCONFIRMED adoption',
      (i) => {
        (i.facts.applyOutcome as any).serviceApprovals.unconfirmed = 1;
      },
    ],
  ];

  it('aud5 F5 / aud6 F1: a panel-map products entry the review does not export flips the products section (PR5)', () => {
    const P = '0190aaaa-0000-7000-8000-0000000000f1';
    const input = holdingInput();
    // p1 is PENDING_REVIEW: the map naming it is refused.
    input.productMap = new Map([['p1', P]]);
    let v = buildFinalReportV2(input as never);
    expect(v.sections.products.panelMap).toEqual({
      entries: 1,
      refused: 1,
      byReason: { NO_PRODUCTS_READ: 0, NO_REVIEW_ROW: 0, NOT_EXPORTABLE: 1, TARGET_DIFFERS: 0 },
    });
    expect(v.sections.products.checks.find((c) => c.id === 'PR5')?.holds).toBe(false);
    expect(v.verdict.failedSections).toEqual(['products']);
    // Approved to P, under the recorded read: holds. Approved to another product: refused.
    const approve = (productId: string) => {
      input.facts.productRows = input.facts.productRows.map((r) =>
        r.codeProduct === 'p1'
          ? {
              ...r,
              state: 'APPROVED_EXISTING',
              approvedProductId: productId,
              approvedFactsChecksum: r.factsChecksum,
            }
          : r,
      );
    };
    approve(P);
    v = buildFinalReportV2(input as never);
    expect(v.sections.products.panelMap.refused).toBe(0);
    expect(v.verdict.holds).toBe(true);
    approve('0190aaaa-0000-7000-8000-0000000000f2');
    v = buildFinalReportV2(input as never);
    expect(v.sections.products.panelMap.byReason.TARGET_DIFFERS).toBe(1);
    expect(v.verdict.failedSections).toEqual(['products']);
    // No products read recorded for the source.
    approve(P);
    input.facts.readSets.products = null;
    v = buildFinalReportV2(input as never);
    expect(v.sections.products.panelMap.byReason.NO_PRODUCTS_READ).toBe(1);
  });

  for (const [section, what, mutate] of sectionCases) {
    it(`section ${section} flips the verdict: ${what}`, () => {
      const input = holdingInput();
      mutate(input);
      const verdict = failed(input);
      expect(verdict.holds).toBe(false);
      expect(verdict.failedSections).toContain(section);
    });
  }

  it('an acknowledged earlier import is a re-run, and holds', () => {
    const input = holdingInput();
    input.facts.applyRuns = [
      {
        id: '0190aaaa-0000-7000-8000-000000000003',
        status: 'FAILED',
        sourceFingerprint: H('e'),
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    ];
    const binding = {
      sourceFingerprint: FP,
      panelMapFingerprint: H('6'),
      inventoryFingerprint: H('1'),
      productsFingerprint: H('3'),
      invoiceArchiveFingerprint: H('4'),
      freezeProofSha256: H('7'),
      finalDumpSha256: H('8'),
    };
    const approval = (id: string, kind: string, prior: string | null, over = {}) =>
      ({
        id,
        kind,
        ...binding,
        priorSourceFingerprint: prior,
        synthetic: false,
        approvedAt: new Date('2026-10-07T00:00:00Z'),
        revocation: null,
        ...over,
      }) as never;
    const CUT = '0190aaaa-0000-7000-8000-0000000000c1';
    const ACK = '0190aaaa-0000-7000-8000-0000000000c2';
    input.facts.approvals = [
      approval(CUT, 'CUTOVER', null),
      approval(ACK, 'RERUN_OVER_PRIOR_IMPORT', H('e')),
    ];
    expect(failed(input).holds).toBe(true);
    input.facts.runCutoverApprovalId = CUT;
    expect(failed(input).holds).toBe(true);

    // The acknowledgement's WHOLE binding must be the applicable CUTOVER approval's: one value
    // different (here the final dump) and it acknowledges nothing — as decideCutoverImport says.
    for (const field of Object.keys(binding).filter((f) => f !== 'sourceFingerprint')) {
      input.facts.approvals = [
        approval(CUT, 'CUTOVER', null),
        approval(ACK, 'RERUN_OVER_PRIOR_IMPORT', H('e'), { [field]: H('9') }),
      ];
      expect(failed(input).failedSections, field).toEqual(['cutover']);
    }
    // Another evidence class acknowledges nothing either.
    input.facts.approvals = [
      approval(CUT, 'CUTOVER', null),
      approval(ACK, 'RERUN_OVER_PRIOR_IMPORT', H('e'), { synthetic: true }),
    ];
    expect(failed(input).failedSections).toEqual(['cutover']);
    // An acknowledgement with no CUTOVER approval beside it acknowledges nothing.
    input.facts.approvals = [approval(ACK, 'RERUN_OVER_PRIOR_IMPORT', H('e'))];
    expect(failed(input).failedSections).toEqual(['cutover']);
    // The run started under ANOTHER approval: this pair is not the applicable one.
    input.facts.approvals = [
      approval(CUT, 'CUTOVER', null),
      approval(ACK, 'RERUN_OVER_PRIOR_IMPORT', H('e')),
    ];
    input.facts.runCutoverApprovalId = '0190aaaa-0000-7000-8000-0000000000c9';
    expect(failed(input).failedSections).toEqual(['cutover']);
    input.facts.runCutoverApprovalId = CUT;
    // Revoked, it acknowledges nothing.
    input.facts.approvals = [
      approval(CUT, 'CUTOVER', null),
      approval(ACK, 'RERUN_OVER_PRIOR_IMPORT', H('e'), { revocation: { revokedAt: new Date() } }),
    ];
    expect(failed(input).failedSections).toEqual(['cutover']);
  });

  it('the report verdict uses the v2 verdict on top of PR5’s rule', () => {
    // `reportHolds` (PR5) is unchanged; `finalReport` ANDs it with the v2 verdict.
    const source = readFileSync(
      'apps/api/src/modules/platform/legacy-importer/application/legacy-importer.service.ts',
      'utf8',
    );
    expect(source).toMatch(
      /reportHolds\(final, usersWallets, serviceOutcomes\) && finalV2\.verdict\.holds/u,
    );
    expect(
      reportHolds({ reconciliation: [] }, { holds: true }, { invariant: { holds: true } }),
    ).toBe(true);
  });
});

describe('final report schemas', () => {
  it('version 1 is unchanged, byte for byte', () => {
    expect(V1_SCHEMA_SHA256).toBe(V1_PINNED);
  });

  it('version 2 carries version 1 by reference and uses only keywords the validator implements', () => {
    const schema = JSON.parse(readFileSync(V2_SCHEMA, 'utf8'));
    expect(schema.properties.schemaVersion).toEqual({ const: '2' });
    expect(schema.properties.core.$ref).toBe('final-report.schema.json');
    const refs = loadRefs(V2_SCHEMA, schema);
    expect(Object.keys(refs)).toEqual(['final-report.schema.json']);
    // An unknown keyword anywhere would throw; an empty document fails only on `required`.
    const errors = validate(schema, {}, schema, refs);
    expect(errors.every((e: string) => /missing required/u.test(e))).toBe(true);
    // Closed: an extra top-level field is refused.
    expect(validate(schema, { extra: 1 }, schema, refs)).toContain(
      '<root>: unexpected property "extra"',
    );
    // The core is validated by version 1's own schema.
    expect(
      validate(schema, { core: { schemaVersion: '2' } }, schema, refs).some((e: string) =>
        e.startsWith('core.schemaVersion: must be "1"'),
      ),
    ).toBe(true);
  });
});
