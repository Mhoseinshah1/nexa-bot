import { and, eq, sql } from 'drizzle-orm';
import {
  NexaError,
  TENANT_ARCHIVE_ERROR_CODES,
  type TenantContext,
  type TenantRestoreMode,
  type TenantRestoreStage,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { ScopeBound } from '../../../../infrastructure/persistence/database-scope.js';
import { redactStoredText } from '../../../../infrastructure/redaction.js';
import { tenantRestores } from '../../../../infrastructure/persistence/schema.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { TenantRestoreRepository } from '../application/tenant-archive.service.js';

/**
 * Phase 6B (ADR-0039 § 4): the `tenant_restores` request row, in the INSTALLATION tenant's own
 * scope (it is the owner's record). Every transition is a conditional UPDATE naming its `from`
 * states and, while the request is in progress, the lease owner; the single-active index
 * refuses a second active restore.
 *
 * Security review of PR #447, finding 3: the row carries ADR-0025's lease (`lease_owner`,
 * `lease_heartbeat_at`). A restore whose process died stops refreshing it, and the next
 * restore takes the slot over by FAILING the row (`tenant_archive.lease_expired`), never by
 * adopting it. A VERIFIED row waits for the owner and has no live worker: it is not reclaimed
 * here (its expiry is PR-2's, ADR-0039 § As built).
 */
const IN_PROGRESS = sql`${tenantRestores.state} IN ('VERIFYING', 'APPLYING')`;

@ScopeBound()
export class DrizzleTenantRestoreRepository implements TenantRestoreRepository {
  constructor(private readonly db: Database) {}

  async create(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly hostedTenantId: string;
      readonly mode: TenantRestoreMode;
      readonly artifactSha256: string;
      readonly archiveId: string;
      readonly requestedByAdminId: string;
      readonly leaseOwner: string;
      readonly now: Date;
    },
  ): Promise<void> {
    await this.db.insert(tenantRestores).values({
      id: input.id,
      tenantId: requireTenantId(scope),
      hostedTenantId: input.hostedTenantId,
      mode: input.mode,
      state: 'VERIFYING',
      stage: 'OPEN',
      artifactSha256: input.artifactSha256,
      archiveId: input.archiveId,
      requestedByAdminId: input.requestedByAdminId,
      leaseOwner: input.leaseOwner,
      leaseHeartbeatAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  async confirm(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly artifactSha256: string;
      readonly leaseOwner: string;
      readonly now: Date;
    },
  ): Promise<{ readonly hostedTenantId: string } | null> {
    const [row] = await this.db
      .update(tenantRestores)
      .set({
        state: 'VERIFYING',
        stage: 'OPEN',
        confirmedAt: input.now,
        leaseOwner: input.leaseOwner,
        leaseHeartbeatAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(tenantRestores.tenantId, requireTenantId(scope)),
          eq(tenantRestores.id, input.id),
          eq(tenantRestores.state, 'VERIFIED'),
          eq(tenantRestores.artifactSha256, input.artifactSha256),
        ),
      )
      .returning({ hostedTenantId: tenantRestores.hostedTenantId });
    return row ?? null;
  }

  async heartbeat(
    scope: TenantContext,
    input: { readonly id: string; readonly leaseOwner: string; readonly now: Date },
  ): Promise<void> {
    await this.db
      .update(tenantRestores)
      .set({ leaseHeartbeatAt: input.now })
      .where(
        and(
          eq(tenantRestores.tenantId, requireTenantId(scope)),
          eq(tenantRestores.id, input.id),
          eq(tenantRestores.leaseOwner, input.leaseOwner),
          IN_PROGRESS,
        ),
      );
  }

  async reclaimStale(
    scope: TenantContext,
    input: { readonly staleBefore: Date; readonly now: Date },
  ): Promise<number> {
    // A row written before the lease existed has no heartbeat: its last update stands in.
    const rows = await this.db
      .update(tenantRestores)
      .set({
        state: 'FAILED',
        failureCode: TENANT_ARCHIVE_ERROR_CODES.LEASE_EXPIRED,
        failureMessage:
          'This restore stopped reporting progress and its lease expired. The process that ' +
          'owned it is presumed gone; its work directory was left in place.',
        updatedAt: input.now,
        finishedAt: input.now,
      })
      .where(
        and(
          eq(tenantRestores.tenantId, requireTenantId(scope)),
          sql`${tenantRestores.state} IN ('REQUESTED', 'VERIFYING', 'APPLYING')`,
          sql`coalesce(${tenantRestores.leaseHeartbeatAt}, ${tenantRestores.updatedAt}) < ${input.staleBefore}`,
        ),
      )
      .returning({ id: tenantRestores.id });
    return rows.length;
  }

  async stage(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly stage: TenantRestoreStage;
      readonly applying: boolean;
      readonly leaseOwner: string;
      readonly now: Date;
    },
  ): Promise<void> {
    const rows = await this.db
      .update(tenantRestores)
      .set({
        stage: input.stage,
        state: input.applying ? 'APPLYING' : 'VERIFYING',
        updatedAt: input.now,
      })
      .where(
        and(
          eq(tenantRestores.tenantId, requireTenantId(scope)),
          eq(tenantRestores.id, input.id),
          eq(tenantRestores.leaseOwner, input.leaseOwner),
          IN_PROGRESS,
        ),
      )
      .returning({ id: tenantRestores.id });
    if (rows.length === 0) {
      throw new NexaError({
        kind: 'CONFLICT',
        code: TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
        message: 'The tenant restore request is no longer in progress.',
      });
    }
  }

  async finish(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly state: 'VERIFIED' | 'SUCCEEDED' | 'FAILED';
      readonly dryRun?: Readonly<Record<string, unknown>>;
      readonly failureCode?: string;
      readonly failureMessage?: string;
      readonly leaseOwner: string;
      readonly now: Date;
    },
  ): Promise<void> {
    const terminal = input.state !== 'VERIFIED';
    await this.db
      .update(tenantRestores)
      .set({
        state: input.state,
        stage: input.state === 'FAILED' ? sql`${tenantRestores.stage}` : 'DONE',
        ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
        failureCode: input.failureCode ?? null,
        // The caller stores no raw error text (finding 1); redacted once more, as a run's is.
        failureMessage: redactStoredText(input.failureMessage?.slice(0, 2000) ?? null),
        updatedAt: input.now,
        finishedAt: terminal ? input.now : null,
      })
      .where(
        and(
          eq(tenantRestores.tenantId, requireTenantId(scope)),
          eq(tenantRestores.id, input.id),
          eq(tenantRestores.leaseOwner, input.leaseOwner),
          IN_PROGRESS,
        ),
      );
  }
}
