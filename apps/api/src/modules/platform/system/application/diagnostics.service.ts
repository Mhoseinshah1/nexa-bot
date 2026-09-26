import {
  SYSTEM_DIAGNOSTICS_SAMPLE_MAX,
  UNANNOUNCED_GRACE_MS,
  type ActorContext,
  type Clock,
  type OperationState,
  type OperationType,
  type PermissionKey,
  type StuckOperationReason,
  type TenantContext,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';

/**
 * What is stuck, and where (WP16 D2, `docs/wp16-admin-ops-audit.md`).
 *
 * Read-only. `opslog.view`, because this is the same audience as the operations log:
 * the people who find out something is wrong and go and look. Nothing here changes a
 * row; the remedy for each item is an existing single-entity action behind its own
 * permission and state machine.
 */
export const DIAGNOSTICS_VIEW_PERMISSION: PermissionKey = 'opslog.view';

export interface OutboxDiagnostics {
  readonly pending: number;
  readonly oldestPendingAt: Date | null;
  readonly failing: number;
  readonly failingSample: readonly {
    readonly id: string;
    readonly eventType: string;
    readonly aggregateType: string;
    readonly attempts: number;
    readonly occurredAt: Date;
    readonly lastError: string | null;
  }[];
}

export interface StuckOperation {
  readonly operationId: string;
  readonly serviceId: string;
  readonly type: OperationType;
  readonly state: OperationState;
  readonly reason: StuckOperationReason;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProvisioningDiagnostics {
  readonly counts: Readonly<Record<StuckOperationReason, number>>;
  readonly sample: readonly StuckOperation[];
}

export interface DiagnosticsReader {
  outbox(scope: TenantContext, sampleSize: number): Promise<OutboxDiagnostics>;
  provisioning(
    scope: TenantContext,
    now: Date,
    unannouncedBefore: Date,
    sampleSize: number,
  ): Promise<ProvisioningDiagnostics>;
}

export interface SystemDiagnostics {
  readonly generatedAt: Date;
  readonly outbox: OutboxDiagnostics;
  readonly provisioning: ProvisioningDiagnostics;
}

/** At most this much of a consumer's error is shown, after URLs are removed. */
export const LAST_ERROR_DISPLAY_MAX = 300;

/**
 * A consumer's stored error, as an operator may see it.
 *
 * The stored text is whatever the consumer threw. A URL in it could be a subscription
 * link — a bearer capability — or a panel address with a query string, so every URL is
 * replaced before it leaves the server, and the text is bounded. The rest is kept:
 * "which consumer failed and roughly why" is the whole value of the field.
 */
export function displayableError(stored: string | null): string | null {
  if (stored === null) return null;
  const scrubbed = stored.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/giu, '[url]');
  return scrubbed.length > LAST_ERROR_DISPLAY_MAX
    ? `${scrubbed.slice(0, LAST_ERROR_DISPLAY_MAX)}…`
    : scrubbed;
}

export class DiagnosticsService {
  constructor(
    private readonly deps: {
      readonly guard: PermissionGuard;
      readonly reader: DiagnosticsReader;
      readonly clock: Clock;
    },
  ) {}

  async read(scope: TenantContext, actor: ActorContext): Promise<SystemDiagnostics> {
    await this.deps.guard.check(scope, actor, DIAGNOSTICS_VIEW_PERMISSION);
    const now = this.deps.clock.now();
    const [outbox, provisioning] = await Promise.all([
      this.deps.reader.outbox(scope, SYSTEM_DIAGNOSTICS_SAMPLE_MAX),
      this.deps.reader.provisioning(
        scope,
        now,
        new Date(now.getTime() - UNANNOUNCED_GRACE_MS),
        SYSTEM_DIAGNOSTICS_SAMPLE_MAX,
      ),
    ]);
    return {
      generatedAt: now,
      outbox: {
        ...outbox,
        failingSample: outbox.failingSample.map((row) => ({
          ...row,
          lastError: displayableError(row.lastError),
        })),
      },
      provisioning,
    };
  }
}
