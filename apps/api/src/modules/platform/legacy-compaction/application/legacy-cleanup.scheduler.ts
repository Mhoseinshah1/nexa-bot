import {
  LEGACY_CLEANUP_AWAITING_DESTINATION_CODE,
  LEGACY_CLEANUP_DESTINATION_READY_CODE,
  LEGACY_CLEANUP_RECONCILIATION_DIFFERS_CODE,
  type ActorContext,
  type BackupDeliveryDestination,
  type Clock,
  type OperationalEventRecorder,
  type TenantContext,
} from '@nexa/contracts';
import type { LegacyCompactionService } from './legacy-compaction.service.js';
import type { LegacyCompactionRepository } from './ports.js';

/**
 * v0.9.7 PR-1 — the AUTOMATIC cleanup after an import («پاک‌سازی داده‌های انتقال»).
 *
 * The owner refused a button: once an import is `COMPLETED`, `COMPLETED_WITH_DISCREPANCY` or
 * `ADOPT_DONE` and its balance reconciliation is clean, the worker requests the cleanup by
 * itself, and the ordinary executor runs it — the «آرشیو ربات قبلی» archive first, nothing
 * deleted unless every part of it reached Telegram.
 *
 * Asked by the executor on every tick and evaluates at most once per `intervalMs`. Per
 * tenant whose latest finished import has not been cleaned up:
 *
 * 1. the reconciliation is missing or names a blocking difference → nothing is requested;
 *    one `maintenance.legacy_cleanup_reconciliation_differs` condition says so;
 * 2. no backup destination is configured → nothing is requested (the archive could not be
 *    delivered, so nothing could be deleted); one
 *    `maintenance.legacy_cleanup_awaiting_backup_destination` condition is opened and
 *    repeated at most once a day while it lasts;
 * 3. otherwise the cleanup is requested (`LegacyCompactionService.requestAutomatic`), and an
 *    open «waiting for a destination» condition is recovered.
 *
 * No customer is told anything; the operations log is.
 */
export interface LegacyCleanupSchedulerDeps {
  readonly repository: Pick<
    LegacyCompactionRepository,
    'automaticCandidates' | 'importReadiness' | 'awaitingDestinationOpen'
  >;
  readonly service: Pick<LegacyCompactionService, 'requestAutomatic'>;
  /** Where the next backup would be delivered, from the database alone (`BackupService`). */
  readonly backupDestination: () => Promise<BackupDeliveryDestination>;
  readonly opsLog: OperationalEventRecorder;
  readonly clock: Clock;
  readonly actor: () => ActorContext;
  /** How often the candidates are evaluated. Default one hour. */
  readonly intervalMs?: number;
  readonly logger: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
  };
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export class LegacyCleanupScheduler {
  private lastEvaluatedAt: number | null = null;
  /** When each condition was last recorded, by `<code>:<tenant>`: at most once a day. */
  private readonly recordedAt = new Map<string, number>();

  constructor(private readonly deps: LegacyCleanupSchedulerDeps) {}

  async tick(): Promise<void> {
    const now = this.deps.clock.now();
    const at = now.getTime();
    if (
      this.lastEvaluatedAt !== null &&
      at - this.lastEvaluatedAt < (this.deps.intervalMs ?? HOUR_MS)
    ) {
      return;
    }
    this.lastEvaluatedAt = at;
    const candidates = await this.deps.repository.automaticCandidates({
      now,
      retryFailedBefore: new Date(at - DAY_MS),
    });
    for (const candidate of candidates) await this.consider(candidate, at);
  }

  private async consider(
    candidate: { readonly tenantId: string; readonly importId: string },
    at: number,
  ): Promise<void> {
    const scope: TenantContext = { tenantId: candidate.tenantId as never, botInstanceId: null };
    const readiness = await this.deps.repository.importReadiness(candidate.tenantId);
    if (!readiness.completed || readiness.inFlight) return;
    if (!readiness.reconciled) {
      await this.daily(scope, at, {
        code: LEGACY_CLEANUP_RECONCILIATION_DIFFERS_CODE,
        severity: 'WARN',
        message:
          'The import finished, but its balance reconciliation is missing or shows a difference; ' +
          'its working data is kept and nothing is cleaned up.',
        dedupeKey: `legacy-cleanup:reconciliation:${candidate.importId}`,
        context: { reason: 'reconciliation_not_clean' },
      });
      return;
    }
    if ((await this.deps.backupDestination()) === 'NONE') {
      await this.daily(scope, at, {
        code: LEGACY_CLEANUP_AWAITING_DESTINATION_CODE,
        severity: 'WARN',
        message:
          'The cleanup of the imported data waits for a backup destination: its archive must ' +
          'reach Telegram before anything is deleted. Checked again daily.',
        dedupeKey: `legacy-cleanup:destination:${candidate.tenantId}`,
        context: { reason: 'backup_destination_missing' },
      });
      return;
    }
    if (await this.deps.repository.awaitingDestinationOpen(candidate.tenantId)) {
      await this.deps.opsLog.record(scope, {
        code: LEGACY_CLEANUP_DESTINATION_READY_CODE,
        severity: 'INFO',
        message: 'A backup destination is configured; the cleanup of the imported data begins.',
        recoversCode: LEGACY_CLEANUP_AWAITING_DESTINATION_CODE,
        recoversDedupeKey: `legacy-cleanup:destination:${candidate.tenantId}`,
      });
      this.recordedAt.delete(`${LEGACY_CLEANUP_AWAITING_DESTINATION_CODE}:${candidate.tenantId}`);
    }
    // One request per import and day: a FAILED run is retried the next day, never in a loop.
    const day = new Date(at).toISOString().slice(0, 10);
    const run = await this.deps.service.requestAutomatic(scope, this.deps.actor(), {
      importId: candidate.importId,
      idempotencyKey: `legacy-cleanup:auto:${candidate.importId}:${day}`,
    });
    if (run !== null) {
      this.deps.logger.info(
        { compactionId: run.id, importId: candidate.importId },
        'the automatic cleanup of the imported legacy data was requested',
      );
    }
  }

  /** A condition recorded at most once a day per tenant (the recorder dedupes the row). */
  private async daily(
    scope: TenantContext,
    at: number,
    event: Parameters<OperationalEventRecorder['record']>[1],
  ): Promise<void> {
    const key = `${event.code}:${scope.tenantId}`;
    const last = this.recordedAt.get(key);
    if (last !== undefined && at - last < DAY_MS) return;
    this.recordedAt.set(key, at);
    await this.deps.opsLog.record(scope, event);
  }
}
