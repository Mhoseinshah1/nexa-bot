import {
  LEGACY_HISTORY_AUDIT_ACTIONS,
  LEGACY_HISTORY_ERROR_CODES,
  errors,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type LegacyHistoryRecordType,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../access/application/authorized-mutation.js';
import type { SessionRepository } from '../../identity/application/ports.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  HistoryRecordSource,
  LegacyHistoryRepository,
  NewLegacyHistoryRecord,
} from './ports.js';
import {
  LegacyHistoryIngestRefused,
  planHistoryFiles,
  readHistoryRecord,
  type PlannedHistoryFile,
  type ReadHistoryRecord,
} from './record-map.js';

/**
 * Mirza `.nxpkg` importer — the history ingest (`docs/legacy-migration/nxpkg-importer.md` §5).
 *
 * Walks every history file of a verified package into `legacy_history_records`. It is a
 * SYSTEM_JOB step (`maintenance.run`, re-checked inside each transaction like every legacy
 * importer write) and it touches nothing else: no balance, ledger entry, order, payment,
 * service, panel or role is read for writing, let alone written.
 *
 * Fail closed, in two passes. The first pass reads and validates EVERY record — known file,
 * known `record_type` in its own file, `legacy:` key unique in the package, no live-state flag
 * set — and writes nothing; any refusal stops the ingest before the first insert. The second
 * pass (skipped by a dry run) inserts in batches with ON CONFLICT DO NOTHING, so a rerun or a
 * resume after a crash inserts nothing twice. A record's customer is resolved BEFORE its insert:
 * the table is append-only and a row is never updated to link it later.
 */

export const LEGACY_HISTORY_INGEST_PERMISSION = 'maintenance.run' satisfies PermissionKey;
export const LEGACY_HISTORY_BATCH_DEFAULT = 500;
export const LEGACY_HISTORY_BATCH_MAX = 1000;

const ENTITY = 'LegacyNxpkgImport';

/** Telegram id → NEXA customer id, for the ids it knows. Called once per batch. */
export type LegacyHistoryCustomerLookup = (
  legacyUserIds: readonly string[],
  tx?: TransactionScope,
) => ReadonlyMap<string, string> | Promise<ReadonlyMap<string, string>>;

export interface LegacyHistoryIngestOptions {
  /** The `legacy_nxpkg_imports` row the records name as their provenance. */
  readonly nxpkgImportId: string;
  /** The package's own `manifest.import_id`. */
  readonly packageImportId: string;
  readonly source: HistoryRecordSource;
  /**
   * Resolves customers. Defaults to the legacy importer's map (`legacy_import_map`, users
   * IMPORTED as customers) — run the ingest after the customers phase.
   */
  readonly customerIdByTelegram?: LegacyHistoryCustomerLookup;
  readonly batchSize?: number;
  /** Validate and count; write nothing. */
  readonly dryRun?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Per record type. `source = inserted + alreadyPresent`; `inserted = linkedToCustomer + unlinked`
 * (in a dry run, `inserted` is what WOULD be inserted).
 */
export interface LegacyHistorySectionCounts {
  source: number;
  inserted: number;
  alreadyPresent: number;
  linkedToCustomer: number;
  unlinked: number;
}

export interface LegacyHistoryIngestResult {
  readonly dryRun: boolean;
  readonly packageImportId: string;
  readonly files: readonly string[];
  /** Present record files left to the legacy importer (customers, openings, invoices, …). */
  readonly operationalFiles: readonly string[];
  readonly sections: Readonly<Partial<Record<LegacyHistoryRecordType, LegacyHistorySectionCounts>>>;
  readonly totals: LegacyHistorySectionCounts;
}

export interface LegacyHistoryIngestDeps {
  readonly repository: LegacyHistoryRepository;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const zero = (): LegacyHistorySectionCounts => ({
  source: 0,
  inserted: 0,
  alreadyPresent: 0,
  linkedToCustomer: 0,
  unlinked: 0,
});

export class LegacyHistoryIngest {
  constructor(private readonly deps: LegacyHistoryIngestDeps) {}

  async ingest(
    scope: TenantContext,
    actor: ActorContext,
    options: LegacyHistoryIngestOptions,
  ): Promise<LegacyHistoryIngestResult> {
    const batchSize = options.batchSize ?? LEGACY_HISTORY_BATCH_DEFAULT;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > LEGACY_HISTORY_BATCH_MAX) {
      throw errors.validation(
        LEGACY_HISTORY_ERROR_CODES.REQUEST_INVALID,
        `The batch size must be 1..${LEGACY_HISTORY_BATCH_MAX}.`,
      );
    }
    const packageImportId = options.packageImportId;
    if (packageImportId.length < 1 || packageImportId.length > 200) {
      throw new LegacyHistoryIngestRefused('PACKAGE_IMPORT_MISMATCH', null, null);
    }
    const dryRun = options.dryRun === true;
    // Charged before anything is read: a dry run is the same SYSTEM_JOB work, minus the writes.
    await this.deps.guard.check(scope, actor, LEGACY_HISTORY_INGEST_PERMISSION);
    await this.assertImport(scope, options);

    const plan = planHistoryFiles(options.source.files().map((file) => file.path));
    for (const file of plan.files) {
      if (!options.source.has(file.path)) {
        throw new LegacyHistoryIngestRefused('UNKNOWN_FILE', file.path, null);
      }
    }

    // Pass 1: every record validated, counted, its key checked unique. Nothing written.
    const sections: Partial<Record<LegacyHistoryRecordType, LegacyHistorySectionCounts>> = {};
    let validated = 0;
    {
      const seen = new Set<string>();
      for (const file of plan.files) {
        for await (const record of this.records(options, file, seen)) {
          (sections[record.historyType] ??= zero()).source += 1;
          validated += 1;
        }
      }
    }

    const lookup = options.customerIdByTelegram ?? this.defaultLookup(scope);
    const counted: Partial<Record<LegacyHistoryRecordType, LegacyHistorySectionCounts>> = {};
    let written = 0;
    // Pass 2: the same walk, in batches; a dry run only reads what is there.
    const seen = new Set<string>();
    let batch: ReadHistoryRecord[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const rows = batch;
      batch = [];
      options.signal?.throwIfAborted();
      if (dryRun) {
        await this.countBatch(scope, packageImportId, rows, lookup, counted);
      } else {
        await this.writeBatch(scope, actor, options, rows, lookup, counted);
      }
      written += rows.length;
    };
    for (const file of plan.files) {
      for await (const record of this.records(options, file, seen)) {
        batch.push(record);
        if (batch.length >= batchSize) await flush();
      }
    }
    await flush();
    if (written !== validated) {
      // The source changed between the passes: the reader verifies every file's SHA-256, so
      // this is a defect, and it is not silently accepted.
      throw new LegacyHistoryIngestRefused('RECORD_INVALID', null, null, 'source_changed');
    }

    const totals = zero();
    for (const [type, section] of Object.entries(sections) as [
      LegacyHistoryRecordType,
      LegacyHistorySectionCounts,
    ][]) {
      const got = counted[type] ?? zero();
      section.inserted = got.inserted;
      section.alreadyPresent = got.alreadyPresent;
      section.linkedToCustomer = got.linkedToCustomer;
      section.unlinked = got.unlinked;
      for (const k of Object.keys(totals) as (keyof LegacyHistorySectionCounts)[]) {
        totals[k] += section[k];
      }
    }
    const result: LegacyHistoryIngestResult = {
      dryRun,
      packageImportId,
      files: plan.files.map((file) => file.path),
      operationalFiles: plan.operational,
      sections,
      totals,
    };
    if (!dryRun) await this.auditIngest(scope, actor, options, result);
    return result;
  }

  /** One file's records, validated; a key already seen in this package is a refusal. */
  private async *records(
    options: LegacyHistoryIngestOptions,
    file: PlannedHistoryFile,
    seen: Set<string>,
  ): AsyncGenerator<ReadHistoryRecord> {
    let line = 0;
    for await (const raw of options.source.iterJsonl(file.path)) {
      line += 1;
      const record = readHistoryRecord(file, line, raw);
      if (seen.has(record.idempotencyKey)) {
        throw new LegacyHistoryIngestRefused('IDEMPOTENCY_KEY_DUPLICATED', file.path, line);
      }
      seen.add(record.idempotencyKey);
      yield record;
    }
  }

  private async writeBatch(
    scope: TenantContext,
    actor: ActorContext,
    options: LegacyHistoryIngestOptions,
    records: readonly ReadHistoryRecord[],
    lookup: LegacyHistoryCustomerLookup,
    counted: Partial<Record<LegacyHistoryRecordType, LegacyHistorySectionCounts>>,
  ): Promise<void> {
    const local: Partial<Record<LegacyHistoryRecordType, LegacyHistorySectionCounts>> = {};
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      LEGACY_HISTORY_INGEST_PERMISSION,
      {
        action: LEGACY_HISTORY_AUDIT_ACTIONS.ingest,
        entityType: ENTITY,
        entityId: options.nxpkgImportId,
      },
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            LEGACY_HISTORY_ERROR_CODES.SCOPE_STOPPED,
            'This installation has stopped accepting work.',
          );
        }
        await this.assertImport(scope, options, tx);
        const customers = await lookup(legacyUsersOf(records), tx);
        const rows: NewLegacyHistoryRecord[] = records.map((record) => ({
          id: this.deps.ids.uuid(),
          recordType: record.historyType,
          idempotencyKey: record.idempotencyKey,
          legacyUserId: record.legacyUserId,
          customerId:
            record.legacyUserId === null ? null : (customers.get(record.legacyUserId) ?? null),
          occurredAt: record.occurredAt,
          payload: record.payload,
        }));
        const inserted = await this.deps.repository.insertMany(
          scope,
          options.nxpkgImportId,
          options.packageImportId,
          rows,
          this.deps.clock.now(),
          tx,
        );
        for (const row of rows) {
          const section = (local[row.recordType] ??= zero());
          if (!inserted.has(row.idempotencyKey)) {
            section.alreadyPresent += 1;
            continue;
          }
          section.inserted += 1;
          if (row.customerId === null) section.unlinked += 1;
          else section.linkedToCustomer += 1;
        }
      },
    );
    // Added only once the batch committed: a rolled-back batch counts nothing.
    mergeCounts(counted, local);
  }

  private async countBatch(
    scope: TenantContext,
    packageImportId: string,
    records: readonly ReadHistoryRecord[],
    lookup: LegacyHistoryCustomerLookup,
    counted: Partial<Record<LegacyHistoryRecordType, LegacyHistorySectionCounts>>,
  ): Promise<void> {
    const present = await this.deps.repository.existingKeys(
      scope,
      packageImportId,
      records.map((record) => record.idempotencyKey),
    );
    const customers = await lookup(legacyUsersOf(records));
    const local: Partial<Record<LegacyHistoryRecordType, LegacyHistorySectionCounts>> = {};
    for (const record of records) {
      const section = (local[record.historyType] ??= zero());
      if (present.has(record.idempotencyKey)) {
        section.alreadyPresent += 1;
        continue;
      }
      section.inserted += 1;
      if (record.legacyUserId !== null && customers.has(record.legacyUserId)) {
        section.linkedToCustomer += 1;
      } else {
        section.unlinked += 1;
      }
    }
    mergeCounts(counted, local);
  }

  /** The import row must be this tenant's, and name this package once it names one. */
  private async assertImport(
    scope: TenantContext,
    options: LegacyHistoryIngestOptions,
    tx?: TransactionScope,
  ): Promise<void> {
    const recorded = await this.deps.repository.packageImportIdOf(scope, options.nxpkgImportId, tx);
    if (recorded === undefined || (recorded !== null && recorded !== options.packageImportId)) {
      throw new LegacyHistoryIngestRefused('PACKAGE_IMPORT_MISMATCH', null, null);
    }
  }

  private defaultLookup(scope: TenantContext): LegacyHistoryCustomerLookup {
    return (ids, tx) => this.deps.repository.customersByLegacyUser(scope, ids, tx);
  }

  private async auditIngest(
    scope: TenantContext,
    actor: ActorContext,
    options: LegacyHistoryIngestOptions,
    result: LegacyHistoryIngestResult,
  ): Promise<void> {
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      LEGACY_HISTORY_INGEST_PERMISSION,
      {
        action: LEGACY_HISTORY_AUDIT_ACTIONS.ingest,
        entityType: ENTITY,
        entityId: options.nxpkgImportId,
      },
      async (tx) => {
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: LEGACY_HISTORY_AUDIT_ACTIONS.ingest,
            entityType: ENTITY,
            entityId: options.nxpkgImportId,
            before: null,
            // Counts and the package's own import id only: never a record value.
            after: {
              packageImportId: result.packageImportId,
              files: result.files.length,
              totals: { ...result.totals },
              sections: Object.fromEntries(
                Object.entries(result.sections).map(([type, counts]) => [type, { ...counts }]),
              ),
            },
            result: 'SUCCESS',
          },
          tx,
        );
      },
    );
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}

function legacyUsersOf(records: readonly ReadHistoryRecord[]): string[] {
  return [
    ...new Set(
      records.map((record) => record.legacyUserId).filter((id): id is string => id !== null),
    ),
  ];
}

function mergeCounts(
  into: Partial<Record<LegacyHistoryRecordType, LegacyHistorySectionCounts>>,
  from: Partial<Record<LegacyHistoryRecordType, LegacyHistorySectionCounts>>,
): void {
  for (const [type, counts] of Object.entries(from) as [
    LegacyHistoryRecordType,
    LegacyHistorySectionCounts,
  ][]) {
    const target = (into[type] ??= zero());
    for (const k of Object.keys(target) as (keyof LegacyHistorySectionCounts)[]) {
      target[k] += counts[k];
    }
  }
}
