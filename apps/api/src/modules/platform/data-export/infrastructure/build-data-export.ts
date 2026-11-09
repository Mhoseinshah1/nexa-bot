import type {
  AuditWriter,
  Clock,
  IdempotencyStore,
  IdGenerator,
  OperationalEventRecorder,
  UnitOfWork,
} from '@nexa/contracts';
import type { Database, DatabaseHandle } from '../../../../infrastructure/persistence/database.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import type { HostingOwnerGuard } from '../../hosting/application/hosting-owner-guard.js';
import type { HostingSectionService } from '../../hosting/application/hosting-section.service.js';
import type { SessionRepository } from '../../identity/application/ports.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import { DataExportRunner } from '../application/data-export.runner.js';
import { DataExportService } from '../application/data-export.service.js';
import type { DataExportQueue, HostedBotLookup } from '../application/ports.js';
import { FilesystemDataExportFiles } from './data-export-files.js';
import { writeDataExport } from './data-export-writer.js';
import { DrizzleDataExportRepository } from './drizzle-data-export.repository.js';

/** The worker's loop: how often it looks for work, and how long silence means abandoned. */
export const DATA_EXPORT_TICK_MS = 15_000;
const HEARTBEAT_MS = 30_000;
const STALE_AFTER_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const QUEUE_POLL_MS = 5_000;
const QUEUE_MAX_WAIT_MS = 10 * 60_000;

/**
 * Phase 6B PR-3: the data export's service and worker, assembled in one place so
 * `container.ts` gains a call rather than another page.
 */
export function buildDataExport(deps: {
  readonly database: DatabaseHandle;
  readonly db: Database;
  readonly workDir: string;
  readonly leaseOwner: string;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly hostedBots: HostedBotLookup;
  readonly section: HostingSectionService;
  readonly owner: HostingOwnerGuard;
  readonly heavyJobs: DataExportQueue;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly installationTenantId: () => string | null;
  readonly logger: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
}): { readonly dataExport: DataExportService; readonly dataExportRunner: DataExportRunner } {
  const repository = new DrizzleDataExportRepository(deps.db);
  const files = new FilesystemDataExportFiles(deps.workDir);
  const dataExport = new DataExportService({
    repository,
    files,
    uow: deps.uow,
    guard: deps.guard,
    audit: deps.audit,
    opsLog: deps.opsLog,
    sessions: deps.sessions,
    idempotency: deps.idempotency,
    scopeActivity: deps.scopeActivity,
    hostedBots: deps.hostedBots,
    section: deps.section,
    owner: deps.owner,
    clock: deps.clock,
    ids: deps.ids,
    installationTenantId: deps.installationTenantId,
  });
  const dataExportRunner = new DataExportRunner({
    repository,
    files,
    writer: {
      write: (input) => writeDataExport({ database: deps.database, ...input }),
    },
    queue: deps.heavyJobs,
    clock: deps.clock,
    leaseOwner: deps.leaseOwner,
    tickIntervalMs: DATA_EXPORT_TICK_MS,
    queueOptions: {
      pollMs: QUEUE_POLL_MS,
      maxWaitMs: QUEUE_MAX_WAIT_MS,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    heartbeatMs: HEARTBEAT_MS,
    staleAfterMs: STALE_AFTER_MS,
    maxAttempts: MAX_ATTEMPTS,
    logger: deps.logger,
  });
  return { dataExport, dataExportRunner };
}
