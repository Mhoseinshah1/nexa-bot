import type { ActorContext, LegacyReadSetName, TenantContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { TariffCandidate } from '../../../commerce/catalog/application/legacy-shape.js';
import type { ProductReviewRowFacts } from './product-map-review.js';
import type { PanelInventoryIndex } from '../../legacy-import/application/legacy-service-matching.js';
import type {
  AdoptionRuntimeFacts,
  LegacyAdoptionCandidate,
  LegacyAdoptionOutcome,
} from '../../../commerce/legacy-adoption/application/legacy-adoption-ports.js';
import type { FreshTargetCheck, FreshTargetOptions } from './fresh-target.js';
import type { PanelFacts } from './panel-mapping.js';
import type { LegacySourceEngine } from './source-port.js';

/**
 * Migration P7 — what the importer needs from NEXA and from the provider, as ports
 * (`docs/legacy-migration/importer.md`). Reads are tenant-scoped aggregates and batched
 * lookups; the only writes are the run-inputs row and the customer import, both inside
 * the caller's transaction.
 */

/** Mirza PR4: a legacy debt as the plan compares it — what makes two debts "the same". */
export interface RecordedDebt {
  readonly amountMinor: bigint;
  /** Recorded from a source carrying the synthetic-fixture marker. */
  readonly synthetic: boolean;
}

export interface LegacyImporterDestination {
  /** The tenant exists (any status); activity is read inside each write's transaction. */
  tenantExists(scope: TenantContext): Promise<boolean>;
  salesCurrency(scope: TenantContext): Promise<string>;
  panels(scope: TenantContext, panelIds: readonly string[]): Promise<readonly PanelFacts[]>;
  /** Which of these product ids are products of this tenant. */
  productIds(scope: TenantContext, productIds: readonly string[]): Promise<ReadonlySet<string>>;
  /**
   * aud5 F5 / aud6 F1: the fingerprint of the latest `products` read set recorded against this
   * v1 source fingerprint — the CURRENT products read of that source — or null.
   */
  latestProductsReadFingerprint(
    scope: TenantContext,
    sourceFingerprint: string,
  ): Promise<string | null>;
  /** Every legacy product review row of the tenant, as PR2's export predicate reads it. */
  productReviewRows(scope: TenantContext): Promise<readonly ProductReviewRowFacts[]>;
  /**
   * aud6 F2/F3: what moved in the tenant since `since` (an APPLY run's start): non-opening
   * wallet ledger entries (any currency) — count and signed net — and payments created.
   */
  movementSince(
    scope: TenantContext,
    since: Date,
  ): Promise<{
    readonly walletEntries: number;
    readonly walletNetMinor: bigint;
    readonly payments: number;
  }>;
  /** Telegram id → customer id, for the ids that are customers of this tenant. */
  customersByTelegramIds(
    scope: TenantContext,
    telegramUserIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  /** Telegram id → the SIGNED amount of the migration opening already posted. */
  openingsByTelegramId(scope: TenantContext): Promise<ReadonlyMap<string, bigint>>;
  /** Mirza PR4: Telegram id → the legacy debt already recorded (magnitude and evidence class). */
  debtsByTelegramId(scope: TenantContext): Promise<ReadonlyMap<string, RecordedDebt>>;
  /** Mirza PR4: count and Σ owed of the recorded legacy debts, in total and by state. */
  debtAggregates(scope: TenantContext): Promise<{
    readonly count: number;
    readonly sumMinor: bigint;
    readonly byState: Readonly<
      Record<string, { readonly count: number; readonly sumMinor: bigint }>
    >;
    /** Debts recorded from a source carrying the synthetic-fixture marker. */
    readonly synthetic: number;
  }>;
  /** Customer id → override limit, for the customers that hold one. */
  trialOverrides(
    scope: TenantContext,
    customerIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>>;
  /** Customers already decided by the legacy trial preservation. */
  trialDecided(scope: TenantContext, customerIds: readonly string[]): Promise<ReadonlySet<string>>;
  /** Shape key → its row's id and tariff status, for the keys that exist. */
  shapesByKey(
    scope: TenantContext,
    shapeKeys: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly id: string; readonly tariffStatus: string }>>;
  tariffCandidates(scope: TenantContext): Promise<readonly TariffCandidate[]>;
  /**
   * Σ signed wallet entries of the tenant in `currency`, and the customer count. With
   * `excludeOpenings`, the NEXA-native total — every entry but the migration openings: the
   * "pre-import NEXA balances" of the wallet equation, whichever run measures it.
   */
  walletTotals(
    scope: TenantContext,
    currency: string,
    options?: { readonly excludeOpenings?: boolean },
  ): Promise<{ readonly totalMinor: bigint; readonly customers: number }>;
  /** Count and Σ of migration openings, by sign. */
  openingAggregates(scope: TenantContext): Promise<{
    readonly count: number;
    readonly sumMinor: bigint;
    readonly positive: number;
    readonly negative: number;
    /** The most openings any one customer holds — 1 at most, or a duplicate exists. */
    readonly perCustomerMax: number;
  }>;
  trialDecisionCounts(scope: TenantContext): Promise<Readonly<Record<string, number>>>;
  shapeStatusCounts(scope: TenantContext): Promise<Readonly<Record<string, number>>>;
  /** A tenant named by uuid or slug, as the operator typed it; null when none matches. */
  resolveTenantId(ref: string): Promise<string | null>;
  /** The tenant's slug (the report names the tenant by it, never by a person). */
  tenantSlug(scope: TenantContext): Promise<string>;
  /** Hidden legacy shapes: created at or after `since`, before it, custom, unresolved. */
  shapeFacts(
    scope: TenantContext,
    since: Date,
  ): Promise<{
    readonly createdSinceRun: number;
    readonly before: number;
    readonly custom: number;
    readonly unresolved: number;
  }>;
  /** How many audit rows of `action` name this entity (a run's resumes). */
  auditCount(scope: TenantContext, action: string, entityId: string): Promise<number>;
  /**
   * Mirza `.nxpkg`: the fresh-target counts (`fresh-target.ts`). With `tx` and `lockTenant`,
   * inside the caller's transaction with the tenant row locked first, so the counts hold
   * until it commits (the authoritative check at an APPLY run's start).
   */
  freshTargetCounts(
    scope: TenantContext,
    options: FreshTargetOptions & { readonly lockTenant?: boolean },
    tx?: TransactionScope,
  ): Promise<FreshTargetCheck>;
  /** The tenant's RUNNING run (at most one, by a partial unique index), if any. */
  runningRun(scope: TenantContext): Promise<string | null>;
  /** The tenant's most recent run of a mode, if any. */
  latestRun(
    scope: TenantContext,
    mode: 'DRY_RUN' | 'APPLY',
  ): Promise<{ readonly id: string; readonly status: string } | null>;
}

/** What a run was started from, recorded once per run (`legacy_import_run_inputs`). */
export interface LegacyRunInputs {
  readonly runId: string;
  readonly sourceEngine: LegacySourceEngine;
  readonly sourceSchemaHash: string;
  readonly panelMappingFingerprint: string;
  readonly walletCurrency: string;
  readonly preImportWalletTotalMinor: bigint;
  readonly preImportCustomers: number;
  readonly recordedAt: Date;
  /**
   * Mirza `.nxpkg`: the ownership hold the run was started under (`ownershipHoldDigest`), or
   * null for a run without one. A resume, reconcile or report under another hold is refused.
   */
  readonly ownershipHoldDigest: string | null;
}

export interface LegacyRunInputsRepository {
  /** Insert-or-nothing; returns what is stored, which a resume compares. */
  record(
    scope: TenantContext,
    inputs: LegacyRunInputs,
    tx: TransactionScope,
  ): Promise<LegacyRunInputs>;
  find(scope: TenantContext, runId: string): Promise<LegacyRunInputs | null>;
}

/**
 * Mirza migration PR1 — one observation of a versioned read set (`legacy_read_set_runs`),
 * bound to the approved v1 source by `sourceFingerprint`. Hashes and counts only.
 */
export interface LegacyReadSetRun {
  readonly id: string;
  readonly readSet: LegacyReadSetName;
  readonly readSetVersion: number;
  readonly fingerprintVersion: string;
  readonly readSetFingerprint: string;
  readonly sourceFingerprint: string;
  readonly sourceSchemaHash: string;
  readonly sourceEngine: LegacySourceEngine;
  readonly synthetic: boolean;
  readonly tableCount: number;
  readonly rowCount: bigint;
  readonly codeVersion: string | null;
  readonly recordedAt: Date;
}

export interface LegacyReadSetRunRepository {
  /**
   * Insert-or-nothing on the observation key (tenant, read set, version, read-set
   * fingerprint, source fingerprint). Returns the stored row and whether THIS call wrote it.
   */
  recordReadSetRun(
    scope: TenantContext,
    run: LegacyReadSetRun,
    tx: TransactionScope,
  ): Promise<{ readonly run: LegacyReadSetRun; readonly created: boolean }>;

  /**
   * Every read set fingerprint recorded for `readSet` at `readSetVersion` against this v1
   * source fingerprint (OQ-LWD-07: the import refuses a second user-status of one source).
   */
  readSetFingerprintsOf(
    scope: TenantContext,
    readSet: LegacyReadSetName,
    readSetVersion: number,
    sourceFingerprint: string,
    tx: TransactionScope,
  ): Promise<readonly string[]>;
}

/** One legacy user, as the customer phase writes it. */
export interface LegacyCustomerInsert {
  readonly id: string;
  readonly telegramUserId: string;
  readonly username: string | null;
  /** The status a NEW customer is created with (OQ-LWD-07); never applied to an existing one. */
  readonly status: 'ACTIVE' | 'BLOCKED';
  readonly now: Date;
}

export interface LegacyCustomerWriter {
  /**
   * Inserts the customer unless `(tenant, telegram_user_id)` exists; NEVER touches an
   * existing row. Returns the customer's id and whether this statement created it.
   */
  insertIfAbsent(
    scope: TenantContext,
    input: LegacyCustomerInsert,
    tx: TransactionScope,
  ): Promise<{ readonly customerId: string; readonly created: boolean }>;
}

// --- provider --------------------------------------------------------------------------------

export interface AccountRuntime {
  readonly state: AdoptionRuntimeFacts['state'];
  readonly usage: AdoptionRuntimeFacts['usage'];
  /**
   * The account's subscription link, derived by the shared `subscriptionFrom` from the
   * same list row (exactly as the adapter's `lookupUser` derives it from the user's own
   * record), or null when the row carries none. A credential: it goes to P6 and nowhere
   * else — never into a report, log, audit row, outbox event or map row.
   */
  readonly subscriptionUrl: string | null;
}

export type LegacyInventoryRead =
  | {
      readonly ok: true;
      readonly complete: true;
      readonly index: PanelInventoryIndex;
      readonly accounts: number;
      readonly states: Readonly<Record<string, number>>;
      /**
       * Per account (keyed by the panel's EXACT spelling), the runtime facts of the same
       * complete walk the index was built from — what P6 adopts from. No link, no token.
       */
      readonly runtime: ReadonlyMap<string, AccountRuntime>;
      /** When the walk that produced these facts finished. */
      readonly observedAt: Date;
    }
  | { readonly ok: true; readonly complete: false; readonly reason: string }
  | { readonly ok: false; readonly failure: string };

/**
 * The READ-ONLY provider surface. Implemented over `RickpanelInventoryReader` and
 * `RickpanelReadOnlyHttp` only; it holds no adapter and no client that can write.
 */
export interface LegacyInventoryPort {
  read(scope: TenantContext, panelId: string): Promise<LegacyInventoryRead>;
  /** Requests sent (reads) and requests refused before sending (any non-read). */
  requestCounts(): { readonly reads: number; readonly refusedWrites: number };
  /**
   * The rows asked for per list page, as the walk applies it (clamped to the reader's
   * bounds). Reported, never a correctness input: a complete inventory is the same index
   * at any page size; a larger page only shortens the double walk.
   */
  pageSize(): number;
}

// --- P6 adoption seam ---------------------------------------------------------------------

/**
 * P6's own types (`legacy-adoption-ports.ts`, agent ADOPT): the importer hands
 * `container.legacyAdoption.adoptCandidate` exactly what it decided, and records nothing on
 * an eligible invoice's map row itself — P6 writes that row with the adoption it records.
 */
export type { AdoptionRuntimeFacts, LegacyAdoptionCandidate, LegacyAdoptionOutcome };

/**
 * The adoption step's port. Wired to P6 by the container; null only where a caller
 * explicitly runs without it (the eligible candidates are then reported PENDING, never
 * adopted and never dropped).
 */
export interface LegacyAdoptionPort {
  adopt(
    scope: TenantContext,
    actor: ActorContext,
    candidate: LegacyAdoptionCandidate,
  ): Promise<LegacyAdoptionOutcome>;
}

/**
 * WP-D3 — at most one importer PROCESS applies a tenant's import at a time.
 *
 * The RUNNING run row alone cannot say whether the process that owns it is alive: a resume
 * after `kill -9` and a second resume beside a live one look the same to it. Two resumes of
 * one run used to proceed together, walk the same rows, and deadlock in the database — the
 * "loser" died of a 40P01 rather than being refused. The holder is a database session: a
 * process that dies loses its connection and so its claim, at once, which is exactly the
 * takeover a resume after a crash needs, and a live holder refuses everyone else.
 */
export interface LegacyImportProcessLock {
  /** The claim, or null when another live process holds this tenant's import. */
  tryAcquire(tenantId: string): Promise<LegacyImportProcessLease | null>;
}

export interface LegacyImportProcessLease {
  /**
   * True once the claim's session ended without `release` — the lock is gone and another
   * process may hold it. The holder checks it between phases and stops as interrupted.
   */
  isLost(): boolean;
  release(): Promise<void>;
}
