import type {
  LegacyImportRunRecord,
  LegacyImportSummaryRow,
} from '../../legacy-import/application/legacy-import-ports.js';
import { parseLegacyBalance, type ServiceCandidateCategory } from './decisions.js';
import type { PlanTallies } from './plan.js';
import type { LegacyRunInputs } from './ports.js';
import type { LegacySnapshot } from './source-snapshot.js';

/**
 * Item 16 — the final migration report, machine-readable, in the shape of
 * `docs/legacy-migration/final-report.schema.json` (schemaVersion 1, REHEARSE's schema).
 * `legacy-import report --format json` prints exactly this object.
 *
 * Built from the run, its recorded inputs, what NEXA holds now and a fresh plan over the
 * same snapshot. Aggregates only. Two definitions the schema leaves to P7:
 *
 * - `customers.blocked` — legacy rows whose `user.id` is not a Telegram id. No customer and
 *   no map key can exist for them (C3), so they are refused, not routed to review.
 * - `wallet.preImportTotalMinor` — the NEXA-native total NOW: every wallet entry of the
 *   selling currency except the migration openings. With it, `pre + imported = expected`
 *   holds exactly even when customers bought something after the import, which a figure
 *   frozen at the run's start would not.
 * - `services.manualReview` includes eligible candidates P6 has not adopted yet, under the
 *   reason `ADOPTION_PENDING_P6`, so the closure holds before P6 is wired and says why.
 * - `wallet.importedTotalMinor` (Mirza PR4, owner decision 6) — Σ POSITIVE legacy balances
 *   of importable users: the only figures that reach the ledger. A negative balance is a
 *   legacy debt held for review beside the ledger, so it is in `notImportedTotalMinor`
 *   (still listed under `negative`), and W1/W4 count openings against positives only. The
 *   debts' own closure is the `usersWallets` section (U4/U5), not a v1 field: v1 is closed.
 * - C1 counts a source id that occurs on several rows once on the map (one review row,
 *   `DUPLICATE_SOURCE_ID`), so its extra rows are added back to close over source rows.
 */

export const FINAL_REPORT_SCHEMA_VERSION = '1';

export interface FinalReportInput {
  readonly generatedAt: Date;
  readonly evidenceClass: 'synthetic' | 'staging' | 'production';
  readonly tenantSlug: string;
  readonly run: LegacyImportRunRecord;
  readonly inputs: LegacyRunInputs | null;
  readonly resumes: number;
  readonly snapshot: LegacySnapshot;
  readonly plan: PlanTallies;
  readonly map: readonly LegacyImportSummaryRow[];
  readonly openings: { readonly count: number; readonly perCustomerMax: number };
  readonly walletCurrency: string;
  readonly nativeTotalMinor: bigint;
  readonly actualTotalMinor: bigint;
  readonly trials: Readonly<Record<string, number>>;
  readonly shapes: {
    readonly createdSinceRun: number;
    readonly before: number;
    readonly custom: number;
    readonly unresolved: number;
  };
  /**
   * What P6 recorded on the map rows of the plan's ADOPTION_ELIGIBLE invoices, by status.
   * `undecided` = eligible invoices with no map row: P6 has not decided them (not wired).
   */
  readonly eligible: {
    readonly IMPORTED: number;
    readonly SKIPPED: number;
    readonly MANUAL_REVIEW: number;
    readonly FAILED: number;
    readonly undecided: number;
  };
  readonly provider: {
    readonly reads: number;
    readonly refusedWrites: number;
    readonly inventoriesComplete: boolean;
  };
}

function mapCount(
  rows: readonly LegacyImportSummaryRow[],
  table: string,
  filter: (r: LegacyImportSummaryRow) => boolean,
): number {
  return rows.filter((r) => r.legacyTable === table && filter(r)).reduce((a, r) => a + r.count, 0);
}

const minor = (v: bigint) => v.toString();

export function buildFinalReport(input: FinalReportInput) {
  const { plan, map, run } = input;
  const c = plan.services.categories;
  const cat = (k: ServiceCandidateCategory) => c[k];

  // customers
  const existing = mapCount(
    map,
    'user',
    (r) => r.status === 'IMPORTED' && r.reasonCode === 'EXISTING_CUSTOMER',
  );
  const created = mapCount(
    map,
    'user',
    (r) => r.status === 'IMPORTED' && r.reasonCode !== 'EXISTING_CUSTOMER',
  );
  const userReview = mapCount(map, 'user', (r) => r.status === 'MANUAL_REVIEW');
  const userSkipped = mapCount(map, 'user', (r) => r.status === 'SKIPPED');
  const userErrors = mapCount(map, 'user', (r) => r.status === 'FAILED');

  // wallet
  let legacyTotal = 0n;
  for (const u of input.snapshot.users) legacyTotal += parseLegacyBalance(u.balance) ?? 0n;
  // Owner decision 6: only positive balances are ledger openings.
  const imported = plan.wallet.positive.sumMinor;
  const expected = input.nativeTotalMinor + imported;

  // services
  // Eligible invoices end where P6 put them: adopted, skipped, held for review or a failed
  // read (retried by a rerun). Their review rows are already in the map-derived reasons
  // below; only the undecided ones (P6 not wired) are added as ADOPTION_PENDING_P6.
  const adopted = input.eligible.IMPORTED;
  const pendingAdoption = input.eligible.undecided;
  const services = {
    candidates: plan.services.candidates,
    adopted,
    alreadyMapped: 0,
    testSkipped: cat('TEST_INVOICE_SKIPPED') + cat('TEST_PANEL_SKIPPED') + input.eligible.SKIPPED,
    providerMissing: cat('PROVIDER_MISSING'),
    ambiguous: cat('AMBIGUOUS_PANEL') + cat('USERNAME_CASE_COLLISION'),
    mappingMissing: cat('PANEL_UNMAPPED'),
    productUnresolved: cat('PRODUCT_UNRESOLVED'),
    unsupported: cat('UNSUPPORTED_SHAPE') + cat('INVALID_USERNAME') + cat('INVALID_SOURCE_ROW'),
    // An incomplete inventory is held for review (INVENTORY_INCOMPLETE) and decided again by
    // a rerun with a complete one; nothing is a failure the importer itself could not finish.
    manualReview:
      cat('ORPHAN') +
      cat('CUSTOMER_NOT_IMPORTED') +
      cat('INVOICE_KEY_INVALID') +
      cat('INVENTORY_INCOMPLETE') +
      pendingAdoption +
      input.eligible.MANUAL_REVIEW,
    failed: input.eligible.FAILED,
  };
  const serviceSum =
    services.adopted +
    services.alreadyMapped +
    services.testSkipped +
    services.providerMissing +
    services.ambiguous +
    services.mappingMissing +
    services.productUnresolved +
    services.unsupported +
    services.manualReview +
    services.failed;

  // Manual review by closed reason: every MANUAL_REVIEW map row (user and invoice, the
  // review queue's own record), plus the two kinds that are not rows — an invoice key the
  // map cannot hold, and eligible candidates P6 has not adopted yet.
  const byReason: Record<string, number> = {};
  const add = (reason: string, n: number) => {
    if (n > 0) byReason[reason] = (byReason[reason] ?? 0) + n;
  };
  for (const r of map) if (r.status === 'MANUAL_REVIEW') add(r.reasonCode ?? 'UNKNOWN', r.count);
  add('INVOICE_KEY_INVALID', cat('INVOICE_KEY_INVALID'));
  add('ADOPTION_PENDING_P6', pendingAdoption);
  const reviewTotal = Object.values(byReason).reduce((a, b) => a + b, 0);

  const startedAt = run.startedAt;
  const finishedAt = run.finishedAt;
  const customers = {
    source: plan.customers.source,
    existing,
    created,
    blocked: plan.customers.invalidIdentity,
    skipped: userSkipped,
    manualReview: userReview,
    errors: userErrors,
  };
  const duplicateExtraRows =
    plan.customers.duplicateSourceIds.rows - plan.customers.duplicateSourceIds.ids;
  const customerSum =
    existing +
    created +
    customers.blocked +
    userSkipped +
    userReview +
    userErrors +
    duplicateExtraRows;
  // One opening per POSITIVE imported balance: a negative one is a debt, never an entry.
  const nonZero = plan.wallet.positive.count;

  return {
    schemaVersion: FINAL_REPORT_SCHEMA_VERSION,
    evidenceClass: input.evidenceClass,
    generatedAt: input.generatedAt.toISOString(),
    run: {
      runId: run.id,
      tenant: input.tenantSlug,
      mode: run.mode,
      status: run.status,
      failureCode: run.failureCode,
      codeVersion: run.codeVersion ?? '0.0.0-unknown',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt?.toISOString() ?? null,
      durationSeconds: Math.max(
        0,
        Math.round(((finishedAt ?? input.generatedAt).getTime() - startedAt.getTime()) / 1000),
      ),
      resumes: input.resumes,
      errors: userErrors + mapCount(map, 'invoice', (r) => r.status === 'FAILED'),
      rowsSeen: run.rowsSeen,
    },
    source: {
      fingerprint: input.snapshot.fingerprint,
      snapshotAt: (input.inputs?.recordedAt ?? input.generatedAt).toISOString(),
      checksumTable: {
        user: input.snapshot.tables.user.digest,
        invoice: input.snapshot.tables.invoice.digest,
      },
      schemaEvidence: {
        serverVersion: input.snapshot.descriptor.version,
        tablesRead: ['user', 'invoice', 'product'],
        ...(input.snapshot.balanceColumnType === null
          ? {}
          : { balanceColumnType: input.snapshot.balanceColumnType }),
      },
    },
    customers,
    wallet: {
      currency: input.walletCurrency,
      legacyTotalMinor: minor(legacyTotal),
      importedTotalMinor: minor(imported),
      notImportedTotalMinor: minor(legacyTotal - imported),
      positive: {
        count: plan.wallet.positive.count,
        sumMinor: minor(plan.wallet.positive.sumMinor),
      },
      zero: { count: plan.wallet.zero },
      negative: {
        count: plan.wallet.negative.count,
        sumMinor: minor(plan.wallet.negative.sumMinor),
      },
      openingEntries: input.openings.count,
      duplicatesPrevented: plan.wallet.openings.ALREADY_POSTED,
      preImportTotalMinor: minor(input.nativeTotalMinor),
      expectedPostImportTotalMinor: minor(expected),
      actualPostImportTotalMinor: minor(input.actualTotalMinor),
    },
    services,
    products: {
      hiddenCreated: input.shapes.createdSinceRun,
      hiddenReused: input.shapes.before,
      custom: input.shapes.custom,
      unresolved: input.shapes.unresolved,
    },
    trials: {
      eligible: input.trials['INHERIT_NEXA_POLICY'] ?? 0,
      ineligible: input.trials['LEGACY_LIMIT_UNREADABLE'] ?? 0,
      used: input.trials['LEGACY_TRIAL_CONSUMED'] ?? 0,
      noTrial: input.trials['LEGACY_NO_TRIALS'] ?? 0,
      existingConflict: input.trials['KEPT_EXISTING_OVERRIDE'] ?? 0,
    },
    provider: {
      reads: input.provider.reads,
      // Requests the read guard REFUSED. None is ever sent; any at all is a defect to see.
      writes: input.provider.refusedWrites,
      inventoriesComplete: input.provider.inventoriesComplete,
    },
    manualReview: { total: reviewTotal, byReason },
    reconciliation: [
      {
        id: 'C1',
        holds: customerSum === customers.source,
        expected: String(customers.source),
        actual: String(customerSum),
      },
      {
        id: 'C3',
        holds: customers.blocked === 0,
        expected: '0',
        actual: String(customers.blocked),
      },
      {
        id: 'W1',
        holds: expected === input.actualTotalMinor,
        expected: minor(expected),
        actual: minor(input.actualTotalMinor),
      },
      {
        id: 'W4',
        holds: input.openings.count === nonZero,
        expected: String(nonZero),
        actual: String(input.openings.count),
      },
      {
        id: 'W5',
        holds: input.openings.perCustomerMax <= 1,
        expected: '1',
        actual: String(input.openings.perCustomerMax),
      },
      {
        id: 'S3',
        holds: serviceSum === services.candidates,
        expected: String(services.candidates),
        actual: String(serviceSum),
      },
      {
        id: 'P3',
        holds: input.provider.refusedWrites === 0 && input.provider.reads > 0,
        expected: 'writes=0 reads>0',
        actual: `writes=${String(input.provider.refusedWrites)} reads=${String(input.provider.reads)}`,
      },
    ],
  };
}

export type FinalReport = ReturnType<typeof buildFinalReport>;
