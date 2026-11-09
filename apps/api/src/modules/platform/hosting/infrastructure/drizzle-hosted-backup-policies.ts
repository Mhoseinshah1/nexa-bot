import { and, eq, isNotNull } from 'drizzle-orm';
import type { ScopeContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { ScopeBound } from '../../../../infrastructure/persistence/database-scope.js';
import { hostedBotBackupPolicies } from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  HostedBackupPolicyRow,
  HostedBackupPolicyStore,
} from '../application/hosted-backup.ports.js';
import { acrossTenants } from './hosting-system-path.js';

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

type Row = typeof hostedBotBackupPolicies.$inferSelect;

function toPolicy(row: Row): HostedBackupPolicyRow {
  return {
    id: row.id,
    hostedTenantId: row.hostedTenantId,
    enabled: row.enabled,
    dailyTime: row.dailyTime,
    keep: row.keep,
    passwordCiphertext: row.passwordCiphertext,
    passwordKeyId: row.passwordKeyId,
    passwordSetAt: row.passwordSetAt,
    runRequestedAt: row.runRequestedAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Phase 6B PR-2: `hosted_bot_backup_policies`, every row the INSTALLATION tenant's. Every
 * method but one is tenant-scoped through `requireTenantId` (row-level security binds the
 * same tenant). `enabledFor` is the hosted owner's own view, read from the HOSTED tenant's
 * request on the system path under a pinned literal reason, one row, named by its tenant.
 */
@ScopeBound()
export class DrizzleHostedBackupPolicies implements HostedBackupPolicyStore {
  constructor(private readonly db: Database) {}

  async find(
    scope: ScopeContext,
    hostedTenantId: string,
    tx?: unknown,
  ): Promise<HostedBackupPolicyRow | null> {
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(hostedBotBackupPolicies)
      .where(
        and(
          eq(hostedBotBackupPolicies.tenantId, requireTenantId(scope)),
          eq(hostedBotBackupPolicies.hostedTenantId, hostedTenantId),
        ),
      )
      .limit(1);
    return row === undefined ? null : toPolicy(row);
  }

  /** The policy row, created with the defaults when there is none. Answers its id. */
  async ensure(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly hostedTenantId: string;
      readonly enabled: boolean;
      readonly dailyTime: string;
      readonly keep: number;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<HostedBackupPolicyRow> {
    await executorOf(this.db, tx)
      .insert(hostedBotBackupPolicies)
      .values({
        id: input.id,
        tenantId: requireTenantId(scope),
        hostedTenantId: input.hostedTenantId,
        enabled: input.enabled,
        dailyTime: input.dailyTime,
        keep: input.keep,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({
        target: [hostedBotBackupPolicies.tenantId, hostedBotBackupPolicies.hostedTenantId],
      });
    const row = await this.find(scope, input.hostedTenantId, tx);
    if (row === null) throw new Error('hosted backup policy row vanished after its upsert');
    return row;
  }

  async setSchedule(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly enabled: boolean;
      readonly dailyTime: string;
      readonly keep: number;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<void> {
    await executorOf(this.db, tx)
      .update(hostedBotBackupPolicies)
      .set({
        enabled: input.enabled,
        dailyTime: input.dailyTime,
        keep: input.keep,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(hostedBotBackupPolicies.tenantId, requireTenantId(scope)),
          eq(hostedBotBackupPolicies.id, input.id),
        ),
      );
  }

  async setPassword(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly ciphertext: string;
      readonly keyId: string;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<void> {
    await executorOf(this.db, tx)
      .update(hostedBotBackupPolicies)
      .set({
        passwordCiphertext: input.ciphertext,
        passwordKeyId: input.keyId,
        passwordSetAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(hostedBotBackupPolicies.tenantId, requireTenantId(scope)),
          eq(hostedBotBackupPolicies.id, input.id),
        ),
      );
  }

  async requestRun(
    scope: ScopeContext,
    input: { readonly id: string; readonly now: Date },
    tx?: unknown,
  ): Promise<void> {
    await executorOf(this.db, tx)
      .update(hostedBotBackupPolicies)
      .set({ runRequestedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(hostedBotBackupPolicies.tenantId, requireTenantId(scope)),
          eq(hostedBotBackupPolicies.id, input.id),
        ),
      );
  }

  /** Clears «بکاپ الان» only if it is still the request the run took (a later press stays). */
  async clearRunRequest(
    scope: ScopeContext,
    input: { readonly id: string; readonly requestedAt: Date },
  ): Promise<void> {
    await this.db
      .update(hostedBotBackupPolicies)
      .set({ runRequestedAt: null })
      .where(
        and(
          eq(hostedBotBackupPolicies.tenantId, requireTenantId(scope)),
          eq(hostedBotBackupPolicies.id, input.id),
          eq(hostedBotBackupPolicies.runRequestedAt, input.requestedAt),
        ),
      );
  }

  /** Every policy with a password set: the scheduler's candidates. */
  async withPassword(scope: ScopeContext): Promise<readonly HostedBackupPolicyRow[]> {
    const rows = await this.db
      .select()
      .from(hostedBotBackupPolicies)
      .where(
        and(
          eq(hostedBotBackupPolicies.tenantId, requireTenantId(scope)),
          isNotNull(hostedBotBackupPolicies.passwordCiphertext),
        ),
      );
    return rows.map(toPolicy);
  }

  /** The hosted owner's own view: whether the host left this bot's backups on (default on). */
  async enabledFor(scope: ScopeContext): Promise<boolean | null> {
    const hostedTenantId = requireTenantId(scope);
    const rows = await acrossTenants(
      undefined,
      'hosting: hosted backup policy for the hosted owner view',
      () =>
        this.db
          .select({ enabled: hostedBotBackupPolicies.enabled })
          .from(hostedBotBackupPolicies)
          .where(eq(hostedBotBackupPolicies.hostedTenantId, hostedTenantId))
          .limit(1),
    );
    return rows[0]?.enabled ?? null;
  }
}
