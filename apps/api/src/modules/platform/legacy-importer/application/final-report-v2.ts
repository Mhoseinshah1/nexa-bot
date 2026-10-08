import {
  LEGACY_APPLY_RUN_SECTION_VERSION,
  LEGACY_CUTOVER_SECTION_VERSION,
  LEGACY_FINAL_REPORT_V2_SCHEMA_VERSION,
  LEGACY_INVENTORY_SECTION_VERSION,
  LEGACY_INVOICE_ARCHIVE_SECTION_VERSION,
  LEGACY_PRODUCTS_SECTION_VERSION,
  LEGACY_PRODUCT_REVIEW_STATES,
  LEGACY_TABLE_CLASSES,
  type LegacyFinalReportV2Invariant,
  type LegacyProductReviewState,
  type LegacyTableClass,
} from '@nexa/contracts';
import { isExportable } from '../../../commerce/legacy-product-review/domain/review-transitions.js';
import type { LegacyCutoverReportFacts } from '../../legacy-cutover/application/legacy-cutover.service.js';
import {
  decideCutoverImport,
  supersededSources,
} from '../../legacy-cutover/domain/cutover-rules.js';
import type { FinalReport } from './final-report.js';
import {
  PRODUCT_MAP_REVIEW_REASONS,
  productMapAgainstReview,
  type ProductMapReviewReason,
} from './product-map-review.js';
import type { LegacyInventory } from './legacy-inventory.js';
import type { ServiceOutcomesSection } from './service-outcomes.js';
import type { LegacySnapshot } from './source-snapshot.js';
import type { UsersWalletsSection } from './users-wallets-reconciliation.js';

/**
 * Mirza migration PR6 — the final migration report, schema version 2
 * (`docs/legacy-migration/final-report-v2.schema.json`; `legacy-import report`).
 *
 * Version 1 (`final-report.ts`) is closed and stays exactly as it is: version 2 CARRIES it,
 * unchanged, as `core`, and folds in every section the later PRs added, each with its own
 * version string — the inventory (PR1), the products review (PR2), the invoice archive
 * (PR3), users and wallets (PR4), service outcomes (PR5) and the cutover (PR6).
 *
 * A section lists only the facts that were actually READ: a fresh inventory the report's
 * own session took (or `read: false`), the review rows, the archive run and the read set
 * observations recorded for THIS source, the approvals and APPLY runs. Nothing is assumed
 * present because it usually is.
 *
 * The verdict is the AND of every section and of the seven reconciliation invariants; each
 * one flips it on its own. Aggregates, fingerprints, codes and NEXA ids only — never a
 * Telegram id, a username, a phone, a subscription link or one person's balance.
 */

export interface FinalReportV2Input {
  readonly core: FinalReport;
  readonly usersWallets: UsersWalletsSection;
  readonly serviceOutcomes: ServiceOutcomesSection;
  readonly snapshot: Pick<LegacySnapshot, 'fingerprint' | 'synthetic' | 'productCodes' | 'tables'>;
  /** A fresh inventory read in a session bound to this source, or null when none was read. */
  readonly inventory: LegacyInventory | null;
  readonly facts: LegacyCutoverReportFacts;
  /** The panel map's `products` section (code → NEXA product): judged by check PR5. */
  readonly productMap: ReadonlyMap<string, string>;
  /** The most migration openings any one customer holds (the v1 W5 figure). */
  readonly openingsPerCustomerMax: number;
}

interface Check {
  readonly id: string;
  readonly what: string;
  readonly holds: boolean;
  readonly expected: string;
  readonly actual: string;
}

function check(id: string, what: string, expected: string, actual: string, holds?: boolean): Check {
  return { id, what, holds: holds ?? expected === actual, expected, actual };
}

const str = (v: bigint | number) => v.toString();

export function buildInventorySection(
  inventory: LegacyInventory | null,
  facts: LegacyCutoverReportFacts,
  sourceFingerprint: string,
) {
  const recorded = facts.readSets.inventory;
  if (inventory === null) {
    return {
      version: LEGACY_INVENTORY_SECTION_VERSION,
      read: false as const,
      recorded:
        recorded === null
          ? null
          : {
              readSetFingerprint: recorded.readSetFingerprint,
              recordedAt: recorded.recordedAt.toISOString(),
            },
      holds: false,
    };
  }
  const byClass = Object.fromEntries(LEGACY_TABLE_CLASSES.map((c) => [c, 0])) as Record<
    LegacyTableClass,
    number
  >;
  for (const table of inventory.tables) byClass[table.class] += 1;
  const checks = [
    check(
      'I1',
      'the inventory session was bound to this source',
      sourceFingerprint,
      inventory.importV1.fingerprint,
      inventory.importV1.bound && inventory.importV1.fingerprint === sourceFingerprint,
    ),
    check('I2', 'no table is UNCLASSIFIED (Area E)', '0', str(byClass.UNCLASSIFIED)),
    check('I3', 'the inventory is COMPLETE', 'COMPLETE', inventory.verdict),
    check(
      'I4',
      'the fresh inventory fingerprint is the one recorded for this source',
      inventory.fingerprint,
      recorded?.readSetFingerprint ?? 'none recorded',
    ),
  ];
  return {
    version: LEGACY_INVENTORY_SECTION_VERSION,
    read: true as const,
    fingerprintVersion: inventory.fingerprintVersion,
    fingerprint: inventory.fingerprint,
    synthetic: inventory.synthetic,
    recorded:
      recorded === null
        ? null
        : {
            readSetFingerprint: recorded.readSetFingerprint,
            recordedAt: recorded.recordedAt.toISOString(),
          },
    tables: inventory.totals.tables,
    rows: str(inventory.totals.rows),
    byClass,
    verdict: inventory.verdict,
    checks,
    holds: checks.every((c) => c.holds),
  };
}

export function buildProductsSection(
  snapshot: Pick<LegacySnapshot, 'fingerprint' | 'productCodes'>,
  facts: LegacyCutoverReportFacts,
  productMap: ReadonlyMap<string, string>,
) {
  const readSet = facts.readSets.products;
  const rows = facts.productRows;
  const present = rows.filter((r) => r.missingSinceReadFingerprint === null);
  const presentCodes = new Set(present.map((r) => r.codeProduct));
  const missingFromReview = [...snapshot.productCodes].filter((c) => !presentCodes.has(c)).length;
  const notInSource = [...presentCodes].filter((c) => !snapshot.productCodes.has(c)).length;
  const byState = Object.fromEntries(LEGACY_PRODUCT_REVIEW_STATES.map((s) => [s, 0])) as Record<
    LegacyProductReviewState,
    number
  >;
  for (const row of rows) byState[row.state] += 1;
  const fingerprint = readSet?.readSetFingerprint ?? null;
  let exportable = 0;
  const notExported: Record<string, number> = {};
  for (const row of rows) {
    if (fingerprint !== null && isExportable(row, fingerprint)) exportable += 1;
    else {
      const why =
        row.missingSinceReadFingerprint !== null
          ? 'ABSENT_FROM_READ'
          : row.sourceConflict !== null
            ? 'SOURCE_CONFLICT'
            : fingerprint !== null && row.readFingerprint !== fingerprint
              ? 'READ_BY_ANOTHER_READ'
              : row.state;
      notExported[why] = (notExported[why] ?? 0) + 1;
    }
  }
  const stale = present.filter((r) => r.readFingerprint !== fingerprint).length;
  const panelMap = productMapAgainstReview(productMap, rows, fingerprint);
  const byReason = Object.fromEntries(
    PRODUCT_MAP_REVIEW_REASONS.map((r) => [
      r,
      panelMap.refused.filter((x) => x.reason === r).length,
    ]),
  ) as Record<ProductMapReviewReason, number>;
  const checks = [
    check(
      'PR1',
      'a products read set is recorded for this source',
      'recorded',
      readSet === null ? 'none' : 'recorded',
    ),
    check(
      'PR2',
      'every distinct source product code has a present review row',
      '0',
      str(missingFromReview),
    ),
    check(
      'PR3',
      'no present review row names a code the source does not have',
      '0',
      str(notInSource),
    ),
    check('PR4', 'every present review row was read by that products read', '0', str(stale)),
    // aud5 F5 = aud6 F1 (PR2 Departure 9): the same answer the APPLY prepare refuses on.
    check(
      'PR5',
      'every panel-map products entry is exported by the approved review under that read, to the same product',
      '0',
      str(panelMap.refused.length),
    ),
  ];
  return {
    version: LEGACY_PRODUCTS_SECTION_VERSION,
    readSet:
      readSet === null
        ? null
        : {
            fingerprintVersion: readSet.fingerprintVersion,
            fingerprint: readSet.readSetFingerprint,
            synthetic: readSet.synthetic,
            recordedAt: readSet.recordedAt.toISOString(),
          },
    sourceDistinctCodes: snapshot.productCodes.size,
    reviewRows: rows.length,
    presentRows: present.length,
    absentRows: rows.length - present.length,
    missingFromReview,
    notInSource,
    byState,
    sourceConflicts: rows.filter((r) => r.sourceConflict !== null).length,
    exportReadiness: {
      ready: fingerprint !== null && stale === 0 && rows.length > 0,
      exportable,
      notExported,
    },
    panelMap: { entries: panelMap.entries, refused: panelMap.refused.length, byReason },
    checks,
    holds: checks.every((c) => c.holds),
  };
}

export function buildInvoiceArchiveSection(
  snapshot: Pick<LegacySnapshot, 'fingerprint' | 'synthetic' | 'tables'>,
  facts: LegacyCutoverReportFacts,
) {
  const readSet = facts.readSets['invoice-archive'];
  const run = facts.archive;
  const snapshotRows = BigInt(snapshot.tables.invoice.rows);
  const checks =
    run === null
      ? [check('A0', 'a COMPLETED invoice archive run of this source exists', 'COMPLETED', 'none')]
      : [
          check(
            'A1',
            "the archive run read exactly the snapshot's invoice rows",
            str(snapshotRows),
            str(run.sourceInvoiceRows),
          ),
          check(
            'A2',
            'every source invoice was promoted (promoted = source rows)',
            str(run.sourceInvoiceRows),
            str(run.promotedRows),
          ),
          check(
            'A3',
            'archived = source rows + archived invoices this snapshot no longer has',
            str(run.sourceInvoiceRows + run.missingInSnapshot),
            str(run.archiveInvoicesAfter),
          ),
          check(
            'A4',
            'the run read the invoice-archive read set recorded for this source',
            readSet?.readSetFingerprint ?? 'none recorded',
            run.readSetFingerprint,
          ),
          check(
            'A5',
            'nothing archived was removed since (archived now ≥ archived after the run)',
            'true',
            String(run.archivedInvoicesNow >= run.archiveInvoicesAfter),
          ),
          check(
            'A6',
            "the run's evidence class is the snapshot's",
            String(snapshot.synthetic),
            String(run.synthetic),
          ),
        ];
  return {
    version: LEGACY_INVOICE_ARCHIVE_SECTION_VERSION,
    readSet:
      readSet === null
        ? null
        : {
            fingerprintVersion: readSet.fingerprintVersion,
            fingerprint: readSet.readSetFingerprint,
            synthetic: readSet.synthetic,
            recordedAt: readSet.recordedAt.toISOString(),
          },
    snapshotInvoiceRows: str(snapshotRows),
    run:
      run === null
        ? null
        : {
            runId: run.runId,
            sourceInvoiceRows: str(run.sourceInvoiceRows),
            promotedRows: str(run.promotedRows),
            insertedNew: str(run.insertedNew),
            insertedRevision: str(run.insertedRevision),
            unchanged: str(run.unchanged),
            missingInSnapshot: str(run.missingInSnapshot),
            archiveInvoicesAfter: str(run.archiveInvoicesAfter),
            archivedInvoicesNow: str(run.archivedInvoicesNow),
          },
    checks,
    holds: checks.every((c) => c.holds),
  };
}

/**
 * The earlier sources NOT acknowledged as re-runs, decided by the ONE evaluator the import
 * uses (`decideCutoverImport`), never by a second rule: an acknowledgement counts only when
 * its complete binding — all seven values — is the applicable CUTOVER approval's, it is
 * unrevoked, and its evidence class is that approval's. The applicable approval is the one
 * the reported run started under (its start audit), or, for a run that recorded none, any
 * unrevoked CUTOVER approval of this source; with none at all, every earlier source is
 * unacknowledged.
 */
function unacknowledgedSources(
  sourceFingerprint: string,
  facts: LegacyCutoverReportFacts,
  prior: readonly string[],
): readonly string[] {
  if (prior.length === 0) return [];
  const approvals = facts.approvals.map((a) => ({ ...a, revoked: a.revocation !== null }));
  const applicable = approvals.filter(
    (a) =>
      a.kind === 'CUTOVER' &&
      !a.revoked &&
      a.sourceFingerprint === sourceFingerprint &&
      (facts.runCutoverApprovalId === null || a.id === facts.runCutoverApprovalId),
  );
  let best: readonly string[] = prior;
  for (const approval of applicable) {
    const decision = decideCutoverImport({
      expectation: {
        sourceFingerprint: approval.sourceFingerprint,
        panelMapFingerprint: approval.panelMapFingerprint,
        inventoryFingerprint: approval.inventoryFingerprint,
        productsFingerprint: approval.productsFingerprint,
        invoiceArchiveFingerprint: approval.invoiceArchiveFingerprint,
        freezeProofSha256: approval.freezeProofSha256,
        finalDumpSha256: approval.finalDumpSha256,
      },
      approvals,
      applyRuns: facts.applyRuns,
      snapshotSynthetic: approval.synthetic,
      productionLikeTarget: false,
    });
    const left = decision.ok ? [] : decision.code === 'SOURCE_SUPERSEDED' ? decision.detail : prior;
    if (left.length < best.length) best = left;
  }
  return best;
}

export function buildCutoverSection(sourceFingerprint: string, facts: LegacyCutoverReportFacts) {
  const prior = supersededSources(facts.applyRuns, sourceFingerprint);
  const unacknowledged = unacknowledgedSources(sourceFingerprint, facts, prior);
  const acknowledged = (source: string) => !unacknowledged.includes(source);
  const checks = [
    check(
      'X1',
      'every earlier source a finished APPLY run imported is acknowledged as a re-run (SOURCE_SUPERSEDED otherwise)',
      '0',
      str(unacknowledged.length),
    ),
  ];
  return {
    version: LEGACY_CUTOVER_SECTION_VERSION,
    sourceFingerprint,
    approvals: facts.approvals.map((a) => ({
      id: a.id,
      kind: a.kind,
      panelMapFingerprint: a.panelMapFingerprint,
      inventoryFingerprint: a.inventoryFingerprint,
      productsFingerprint: a.productsFingerprint,
      invoiceArchiveFingerprint: a.invoiceArchiveFingerprint,
      freezeProofSha256: a.freezeProofSha256,
      finalDumpSha256: a.finalDumpSha256,
      priorSourceFingerprint: a.priorSourceFingerprint,
      synthetic: a.synthetic,
      approvedByAdminId: a.approvedByAdminId,
      approvedAt: a.approvedAt.toISOString(),
      revoked: a.revocation !== null,
    })),
    applyRuns: facts.applyRuns.map((r) => ({
      runId: r.id,
      status: r.status,
      sourceFingerprint: r.sourceFingerprint,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt === null ? null : r.finishedAt.toISOString(),
      priorSource: r.sourceFingerprint !== sourceFingerprint,
    })),
    supersededSources: prior.map((source) => ({
      sourceFingerprint: source,
      acknowledged: acknowledged(source),
    })),
    duplicates: facts.duplicates,
    checks,
    holds: checks.every((c) => c.holds),
  };
}

/**
 * The apply-run section (PR5's counters, read back from the run's finish audit row). Holds
 * only when the run's leftovers were RECORDED (a run finished by an older release has none:
 * not assumed clean) and no adoption is ADOPTION_UNCONFIRMED — P6 said "adopted" and the map
 * does not hold the service, a broken invariant. Every other count is reported for a person.
 */
export function buildApplyRunSection(runId: string, facts: LegacyCutoverReportFacts) {
  const outcome = facts.applyOutcome;
  const unconfirmed = outcome?.serviceApprovals['unconfirmed'] ?? 0;
  const checks = [
    check(
      'R1',
      "the run's leftovers were recorded with its finish",
      'recorded',
      outcome === null ? 'none' : 'recorded',
    ),
    check(
      'R2',
      'no adoption is ADOPTION_UNCONFIRMED (P6 said adopted, the map does not hold it)',
      '0',
      String(unconfirmed),
    ),
  ];
  return {
    version: LEGACY_APPLY_RUN_SECTION_VERSION,
    runId,
    recorded: outcome !== null,
    serviceApprovals: outcome?.serviceApprovals ?? null,
    attention: outcome?.attention ?? null,
    checks,
    holds: checks.every((c) => c.holds),
  };
}

export function buildFinalReportV2(input: FinalReportV2Input) {
  const { core, usersWallets, serviceOutcomes, snapshot, facts } = input;
  const inventory = buildInventorySection(input.inventory, facts, snapshot.fingerprint);
  const products = buildProductsSection(snapshot, facts, input.productMap);
  const invoiceArchive = buildInvoiceArchiveSection(snapshot, facts);
  const cutover = buildCutoverSection(snapshot.fingerprint, facts);
  const applyRun = buildApplyRunSection(core.run.runId, facts);

  const v1 = (id: string) => core.reconciliation.find((r) => r.id === id)?.holds === true;
  const u = (id: string) => usersWallets.checks.find((c) => c.id === id)?.holds === true;
  const a = (id: string) => invoiceArchive.checks.find((c) => c.id === id)?.holds === true;
  const p = (id: string) => products.checks.find((c) => c.id === id)?.holds === true;
  const d = facts.duplicates;
  const debts = usersWallets.wallet.legacyDebts;

  const invariants: {
    readonly id: LegacyFinalReportV2Invariant;
    readonly statement: string;
    readonly holds: boolean;
    readonly evidence: string;
  }[] = [
    {
      id: 'USERS_ACCOUNTED',
      statement: 'every source user accounted for (v1 C1, PR4 U1)',
      holds: v1('C1') && u('U1'),
      evidence: `C1=${String(v1('C1'))} U1=${String(u('U1'))}`,
    },
    {
      id: 'INVOICES_ACCOUNTED',
      statement:
        'every source invoice accounted for: the archive of this fingerprint = its exact source count (A1–A3)',
      holds: a('A1') && a('A2') && a('A3'),
      evidence: `A1=${String(a('A1'))} A2=${String(a('A2'))} A3=${String(a('A3'))}`,
    },
    {
      id: 'PRODUCTS_ACCOUNTED',
      statement:
        'every source product accounted for: present review rows = distinct codes (PR1–PR3)',
      holds: p('PR1') && p('PR2') && p('PR3'),
      evidence: `PR1=${String(p('PR1'))} PR2=${String(p('PR2'))} PR3=${String(p('PR3'))}`,
    },
    {
      id: 'WALLETS_RECONCILED',
      statement:
        'wallet sums reconciled (v1 W1, W4, W5; PR4 U2–U8); debts and conflicts reported, never netted',
      holds:
        v1('W1') && v1('W4') && v1('W5') && ['U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8'].every(u),
      evidence:
        `debts=${String(debts.recorded)} debtsSumMinor=${debts.recordedSumMinor} ` +
        `conflicts=${String(usersWallets.wallet.perUser.conflicting)} sourceChanged=${String(usersWallets.sourceChanged.users)}`,
    },
    {
      id: 'SERVICES_ONE_OUTCOME',
      statement: 'every service candidate has exactly one outcome (PR5; v1 S3)',
      holds: serviceOutcomes.invariant.holds && v1('S3'),
      evidence: `candidates=${String(serviceOutcomes.candidates)} recorded=${String(serviceOutcomes.recorded)} S3=${String(v1('S3'))}`,
    },
    {
      id: 'UNRESOLVED_RETAINED',
      statement:
        'all unresolved records retained: archive never shrinks, every unadopted candidate kept as history, every debt recorded',
      holds:
        a('A5') &&
        serviceOutcomes.archivedHistory.notLinkedToArchive === 0 &&
        debts.recorded >= debts.users,
      evidence:
        `A5=${String(a('A5'))} notLinkedToArchive=${String(serviceOutcomes.archivedHistory.notLinkedToArchive)} ` +
        `debtsRecorded=${String(debts.recorded)} negativeUsers=${String(debts.users)}`,
    },
    {
      id: 'RERUN_NO_DUPLICATES',
      statement:
        'a rerun produced no duplicate business effect: openings, debts, customers, adopted services, archive revisions',
      holds:
        input.openingsPerCustomerMax <= 1 &&
        d.debtsPerCustomerMax <= 1 &&
        d.customersPerTelegramIdMax <= 1 &&
        d.invoicesPerAdoptedServiceMax <= 1 &&
        d.adoptionOrders === d.mappedAdoptedServices &&
        d.archiveRepeatedRevisions === 0,
      evidence:
        `openingsPerCustomerMax=${String(input.openingsPerCustomerMax)} debtsPerCustomerMax=${String(d.debtsPerCustomerMax)} ` +
        `customersPerTelegramIdMax=${String(d.customersPerTelegramIdMax)} invoicesPerAdoptedServiceMax=${String(d.invoicesPerAdoptedServiceMax)} ` +
        `adoptionOrders=${String(d.adoptionOrders)} mappedAdoptedServices=${String(d.mappedAdoptedServices)} ` +
        `archiveRepeatedRevisions=${String(d.archiveRepeatedRevisions)}`,
    },
  ];

  const sectionHolds = {
    core: core.reconciliation.every((r) => r.holds),
    inventory: inventory.holds,
    products: products.holds,
    invoiceArchive: invoiceArchive.holds,
    usersWallets: usersWallets.holds,
    serviceOutcomes: serviceOutcomes.invariant.holds,
    cutover: cutover.holds,
    applyRun: applyRun.holds,
  };
  const failedSections = Object.entries(sectionHolds)
    .filter(([, holds]) => !holds)
    .map(([name]) => name);
  const failedInvariants = invariants.filter((i) => !i.holds).map((i) => i.id);

  return {
    schemaVersion: LEGACY_FINAL_REPORT_V2_SCHEMA_VERSION,
    evidenceClass: core.evidenceClass,
    generatedAt: core.generatedAt,
    sourceFingerprint: snapshot.fingerprint,
    synthetic: snapshot.synthetic,
    verdict: {
      holds: failedSections.length === 0 && failedInvariants.length === 0,
      failedSections,
      failedInvariants,
    },
    core,
    sections: {
      inventory,
      products,
      invoiceArchive,
      usersWallets,
      serviceOutcomes,
      cutover,
      applyRun,
    },
    invariants,
  };
}

export type FinalReportV2 = ReturnType<typeof buildFinalReportV2>;
