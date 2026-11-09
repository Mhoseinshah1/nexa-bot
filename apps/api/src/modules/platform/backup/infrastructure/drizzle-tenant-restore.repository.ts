import { and, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import {
  NexaError,
  TENANT_ARCHIVE_ERROR_CODES,
  type TenantContext,
  type TenantRestoreMode,
  type TenantRestoreStage,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { ScopeBound } from '../../../../infrastructure/persistence/database-scope.js';
import { tenantRestores } from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { TenantRestoreRepository } from '../application/tenant-archive.service.js';

/**
 * Phase 6B (ADR-0039 § 4): the `tenant_restores` request row, in the INSTALLATION tenant's own
 * scope (it is the owner's record). Every transition is a conditional UPDATE naming its `from`
 * states; the single-active index refuses a second active restore.
 */
export type TenantRestoreRow = typeof tenantRestores.$inferSelect;

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

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
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  async confirm(
    scope: TenantContext,
    input: { readonly id: string; readonly artifactSha256: string; readonly now: Date },
  ): Promise<{ readonly hostedTenantId: string } | null> {
    const [row] = await this.db
      .update(tenantRestores)
      .set({ state: 'VERIFYING', stage: 'OPEN', confirmedAt: input.now, updatedAt: input.now })
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

  async stage(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly stage: TenantRestoreStage;
      readonly applying: boolean;
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
          sql`${tenantRestores.state} IN ('VERIFYING', 'APPLYING')`,
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
        failureMessage: input.failureMessage?.slice(0, 2000) ?? null,
        updatedAt: input.now,
        finishedAt: terminal ? input.now : null,
      })
      .where(
        and(
          eq(tenantRestores.tenantId, requireTenantId(scope)),
          eq(tenantRestores.id, input.id),
          sql`${tenantRestores.state} IN ('VERIFYING', 'APPLYING')`,
        ),
      );
  }

  // --- Phase 6B PR-2: the owner's page and the recovery role's worker ---------------------

  async byId(scope: TenantContext, id: string): Promise<TenantRestoreRow | null> {
    const [row] = await this.db
      .select()
      .from(tenantRestores)
      .where(and(eq(tenantRestores.tenantId, requireTenantId(scope)), eq(tenantRestores.id, id)))
      .limit(1);
    return row ?? null;
  }

  async recent(scope: TenantContext, limit: number): Promise<readonly TenantRestoreRow[]> {
    return this.db
      .select()
      .from(tenantRestores)
      .where(eq(tenantRestores.tenantId, requireTenantId(scope)))
      .orderBy(desc(tenantRestores.createdAt), desc(tenantRestores.id))
      .limit(limit);
  }

  /** The owner's confirmation of a VERIFIED dry run, once. The recovery role applies it. */
  async requestConfirm(
    scope: TenantContext,
    input: { readonly id: string; readonly now: Date },
    tx?: unknown,
  ): Promise<boolean> {
    const rows = await executorOf(this.db, tx)
      .update(tenantRestores)
      .set({ confirmRequestedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(tenantRestores.tenantId, requireTenantId(scope)),
          eq(tenantRestores.id, input.id),
          eq(tenantRestores.state, 'VERIFIED'),
          isNull(tenantRestores.confirmRequestedAt),
        ),
      )
      .returning({ id: tenantRestores.id });
    return rows.length > 0;
  }

  /**
   * Withdraws a VERIFIED dry run nobody confirmed — the owner's «لغو», or its expiry — and
   * releases the installation's one restore slot. A confirmed one is the worker's.
   */
  async withdraw(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly failureCode: string;
      readonly failureMessage: string;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<boolean> {
    const rows = await executorOf(this.db, tx)
      .update(tenantRestores)
      .set({
        state: 'FAILED',
        failureCode: input.failureCode,
        failureMessage: input.failureMessage,
        updatedAt: input.now,
        finishedAt: input.now,
      })
      .where(
        and(
          eq(tenantRestores.tenantId, requireTenantId(scope)),
          eq(tenantRestores.id, input.id),
          eq(tenantRestores.state, 'VERIFIED'),
          isNull(tenantRestores.confirmRequestedAt),
        ),
      )
      .returning({ id: tenantRestores.id });
    return rows.length > 0;
  }

  /** VERIFIED dry runs last touched before `before` and never confirmed. */
  async staleDryRuns(scope: TenantContext, before: Date): Promise<readonly string[]> {
    const rows = await this.db
      .select({ id: tenantRestores.id })
      .from(tenantRestores)
      .where(
        and(
          eq(tenantRestores.tenantId, requireTenantId(scope)),
          eq(tenantRestores.state, 'VERIFIED'),
          isNull(tenantRestores.confirmRequestedAt),
          lt(tenantRestores.updatedAt, before),
        ),
      );
    return rows.map((row) => row.id);
  }

  /** The confirmed dry runs the recovery role has not applied yet (at most one: the slot). */
  async confirmedPending(scope: TenantContext): Promise<readonly TenantRestoreRow[]> {
    return this.db
      .select()
      .from(tenantRestores)
      .where(
        and(
          eq(tenantRestores.tenantId, requireTenantId(scope)),
          eq(tenantRestores.state, 'VERIFIED'),
          isNotNull(tenantRestores.confirmRequestedAt),
        ),
      );
  }
}
