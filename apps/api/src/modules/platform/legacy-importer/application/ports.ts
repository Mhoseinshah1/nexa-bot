import type { ActorContext, TenantContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { TariffCandidate } from '../../../commerce/catalog/application/legacy-shape.js';
import type { PanelInventoryIndex } from '../../legacy-import/application/legacy-service-matching.js';
import type {
  AdoptionRuntimeFacts,
  LegacyAdoptionCandidate,
  LegacyAdoptionOutcome,
} from '../../../commerce/legacy-adoption/application/legacy-adoption-ports.js';
import type { PanelFacts } from './panel-mapping.js';
import type { LegacySourceEngine } from './source-port.js';

/**
 * Migration P7 — what the importer needs from NEXA and from the provider, as ports
 * (`docs/legacy-migration/importer.md`). Reads are tenant-scoped aggregates and batched
 * lookups; the only writes are the run-inputs row and the customer import, both inside
 * the caller's transaction.
 */

export interface LegacyImporterDestination {
  /** The tenant exists (any status); activity is read inside each write's transaction. */
  tenantExists(scope: TenantContext): Promise<boolean>;
  salesCurrency(scope: TenantContext): Promise<string>;
  panels(scope: TenantContext, panelIds: readonly string[]): Promise<readonly PanelFacts[]>;
  /** Which of these product ids are products of this tenant. */
  productIds(scope: TenantContext, productIds: readonly string[]): Promise<ReadonlySet<string>>;
  /** Telegram id → customer id, for the ids that are customers of this tenant. */
  customersByTelegramIds(
    scope: TenantContext,
    telegramUserIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  /** Telegram id → the SIGNED amount of the migration opening already posted. */
  openingsByTelegramId(scope: TenantContext): Promise<ReadonlyMap<string, bigint>>;
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
  /** Σ signed entries since `since` whose reason is NOT the migration opening. */
  nonOpeningMovementSince(scope: TenantContext, currency: string, since: Date): Promise<bigint>;
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

/** One legacy user, as the customer phase writes it. */
export interface LegacyCustomerInsert {
  readonly id: string;
  readonly telegramUserId: string;
  readonly username: string | null;
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
