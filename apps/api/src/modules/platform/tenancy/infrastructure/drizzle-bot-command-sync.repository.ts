import { and, asc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { BotInstanceId, BotInstanceStatus, ScopeContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  botCommandSyncs,
  botInstances,
  tenants,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  BotCommandSyncRepository,
  ClaimedCommandSync,
  CommandSyncStatusRecord,
} from '../application/bot-command-sync-ports.js';

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

/**
 * The command-sync rows (round P), and the conditional UPDATEs that move them.
 *
 * No SELECT here names a credential column: the lane resolves a token through
 * `DrizzleBotInstanceRepository.tokenForBotInstance`, which is the one place that decrypts
 * an ACTIVE bot's token for outbound use. What is read from `bot_instances` is the status,
 * the username and `commands_revision`.
 */
export class DrizzleBotCommandSyncRepository implements BotCommandSyncRepository {
  constructor(private readonly db: Database) {}

  async listForTenant(scope: ScopeContext, tx?: unknown): Promise<CommandSyncStatusRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select({
        id: botInstances.id,
        username: botInstances.username,
        status: botInstances.status,
        syncedHash: botInstances.commandsRevision,
        desiredHash: botCommandSyncs.desiredHash,
        desiredVersion: botCommandSyncs.desiredVersion,
        lastSyncedAt: botCommandSyncs.lastSyncedAt,
        lastAttemptedAt: botCommandSyncs.lastAttemptedAt,
        lastErrorCode: botCommandSyncs.lastErrorCode,
        attempts: botCommandSyncs.attempts,
        nextAttemptAt: botCommandSyncs.nextAttemptAt,
        claimedUntil: botCommandSyncs.claimedUntil,
      })
      .from(botInstances)
      .leftJoin(botCommandSyncs, eq(botCommandSyncs.botInstanceId, botInstances.id))
      .where(eq(botInstances.tenantId, tenantId))
      .orderBy(asc(botInstances.createdAt), asc(botInstances.id));
    return rows.map((row) => ({
      bot: {
        id: row.id as BotInstanceId,
        username: row.username,
        status: row.status as BotInstanceStatus,
        syncedHash: row.syncedHash,
      },
      sync:
        row.desiredHash === null
          ? null
          : {
              desiredHash: row.desiredHash,
              desiredVersion: row.desiredVersion ?? 1,
              lastSyncedAt: row.lastSyncedAt,
              lastAttemptedAt: row.lastAttemptedAt,
              lastErrorCode: row.lastErrorCode,
              attempts: row.attempts ?? 0,
              nextAttemptAt: row.nextAttemptAt,
              claimedUntil: row.claimedUntil,
            },
    }));
  }

  async upsertDesired(
    scope: ScopeContext,
    input: {
      readonly botId: BotInstanceId;
      readonly desiredHash: string;
      readonly now: Date;
      readonly due: boolean;
    },
    tx: unknown,
  ): Promise<void> {
    await this.upsertWith(executorOf(this.db, tx), requireTenantId(scope), input);
  }

  /** `upsertDesired` on a given executor, so `claimOne` runs it inside its own transaction. */
  private async upsertWith(
    db: Executor,
    tenantId: string,
    input: {
      readonly botId: BotInstanceId;
      readonly desiredHash: string;
      readonly now: Date;
      readonly due: boolean;
    },
  ): Promise<void> {
    // The bot row FOR UPDATE: the comparison with `commands_revision` below and the
    // upsert must see one state, and a concurrent success must not be undone by a stale
    // "differs" read.
    const [bot] = await db
      .select({ id: botInstances.id, syncedHash: botInstances.commandsRevision })
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.id, input.botId)))
      .for('update');
    if (bot === undefined) return;
    const differs = bot.syncedHash !== input.desiredHash;
    const queue = input.due || differs;
    await db
      .insert(botCommandSyncs)
      .values({
        botInstanceId: input.botId,
        tenantId,
        desiredHash: input.desiredHash,
        desiredVersion: 1,
        attempts: 0,
        nextAttemptAt: queue ? input.now : null,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: botCommandSyncs.botInstanceId,
        set: {
          desiredHash: input.desiredHash,
          desiredVersion: sql`CASE WHEN ${botCommandSyncs.desiredHash} = ${input.desiredHash} THEN ${botCommandSyncs.desiredVersion} ELSE ${botCommandSyncs.desiredVersion} + 1 END`,
          // A forced request queues NOW and forgets the failures; an event-driven one
          // queues only what is not queued already, and keeps a running back-off.
          nextAttemptAt: input.due
            ? input.now
            : queue
              ? sql`COALESCE(${botCommandSyncs.nextAttemptAt}, ${input.now})`
              : botCommandSyncs.nextAttemptAt,
          attempts: input.due ? 0 : botCommandSyncs.attempts,
          updatedAt: input.now,
        },
      });
  }

  async claimDue(now: Date, limit: number, leaseMs: number): Promise<ClaimedCommandSync[]> {
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select({ botInstanceId: botCommandSyncs.botInstanceId })
        .from(botCommandSyncs)
        .where(
          and(
            lte(botCommandSyncs.nextAttemptAt, now),
            or(isNull(botCommandSyncs.claimedUntil), lt(botCommandSyncs.claimedUntil, now)),
            // The tenant has to be open for business and the bot ACTIVE: a stopped
            // bot's credential is not used (`OQ-5R-02`), and a stopped tenant's work
            // waits (`docs/conventions.md`, the stopped-scope rule).
            inArray(
              botCommandSyncs.tenantId,
              tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'ACTIVE')),
            ),
            inArray(
              botCommandSyncs.botInstanceId,
              tx
                .select({ id: botInstances.id })
                .from(botInstances)
                .where(eq(botInstances.status, 'ACTIVE')),
            ),
          ),
        )
        .orderBy(asc(botCommandSyncs.nextAttemptAt), asc(botCommandSyncs.botInstanceId))
        .limit(limit)
        .for('update', { skipLocked: true });
      if (due.length === 0) return [];
      const claimed = await tx
        .update(botCommandSyncs)
        .set({ claimedUntil: new Date(now.getTime() + leaseMs), updatedAt: now })
        .where(
          inArray(
            botCommandSyncs.botInstanceId,
            due.map((row) => row.botInstanceId),
          ),
        )
        .returning({
          tenantId: botCommandSyncs.tenantId,
          botInstanceId: botCommandSyncs.botInstanceId,
          desiredHash: botCommandSyncs.desiredHash,
          attempts: botCommandSyncs.attempts,
          claimedUntil: botCommandSyncs.claimedUntil,
        });
      return claimed.map((row) => ({
        tenantId: row.tenantId,
        botInstanceId: row.botInstanceId as BotInstanceId,
        desiredHash: row.desiredHash,
        attempts: row.attempts,
        claimedUntil: row.claimedUntil as Date,
      }));
    });
  }

  async claimOne(
    scope: ScopeContext,
    botId: BotInstanceId,
    input: { readonly desiredHash: string; readonly now: Date; readonly leaseMs: number },
  ): Promise<ClaimedCommandSync | null> {
    const tenantId = requireTenantId(scope);
    return this.db.transaction(async (tx) => {
      const [bot] = await tx
        .select({ id: botInstances.id })
        .from(botInstances)
        .where(
          and(
            eq(botInstances.tenantId, tenantId),
            eq(botInstances.id, botId),
            eq(botInstances.status, 'ACTIVE'),
          ),
        )
        .for('update');
      if (bot === undefined) return null;
      await this.upsertWith(tx, tenantId, {
        botId,
        desiredHash: input.desiredHash,
        now: input.now,
        due: true,
      });
      const [claimed] = await tx
        .update(botCommandSyncs)
        .set({ claimedUntil: new Date(input.now.getTime() + input.leaseMs), updatedAt: input.now })
        .where(
          and(
            eq(botCommandSyncs.botInstanceId, botId),
            eq(botCommandSyncs.tenantId, tenantId),
            or(isNull(botCommandSyncs.claimedUntil), lt(botCommandSyncs.claimedUntil, input.now)),
          ),
        )
        .returning({
          desiredHash: botCommandSyncs.desiredHash,
          attempts: botCommandSyncs.attempts,
          claimedUntil: botCommandSyncs.claimedUntil,
        });
      if (claimed === undefined) return null;
      return {
        tenantId,
        botInstanceId: botId,
        desiredHash: claimed.desiredHash,
        attempts: claimed.attempts,
        claimedUntil: claimed.claimedUntil as Date,
      };
    });
  }

  async recordSuccess(
    scope: ScopeContext,
    botId: BotInstanceId,
    input: { readonly now: Date; readonly sentHash: string; readonly claim: Date },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const updated = await executorOf(this.db, tx)
      .update(botCommandSyncs)
      .set({
        lastSyncedAt: input.now,
        lastAttemptedAt: input.now,
        lastErrorCode: null,
        attempts: 0,
        // Cleared only when what was sent is still what is wanted. A row whose desired
        // digest moved on while the call was in flight stays due — queued now if nothing
        // queued it meanwhile — so the newer text reaches Telegram on the next tick.
        nextAttemptAt: sql`CASE WHEN ${botCommandSyncs.desiredHash} = ${input.sentHash} THEN NULL ELSE COALESCE(${botCommandSyncs.nextAttemptAt}, ${input.now}) END`,
        claimedUntil: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(botCommandSyncs.botInstanceId, botId),
          eq(botCommandSyncs.tenantId, tenantId),
          eq(botCommandSyncs.claimedUntil, input.claim),
        ),
      )
      .returning({ id: botCommandSyncs.botInstanceId });
    return updated.length === 1;
  }

  async recordFailure(
    scope: ScopeContext,
    botId: BotInstanceId,
    input: {
      readonly now: Date;
      readonly errorCode: string;
      readonly nextAttemptAt: Date;
      readonly claim: Date;
    },
    tx: unknown,
  ): Promise<number | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .update(botCommandSyncs)
      .set({
        lastAttemptedAt: input.now,
        lastErrorCode: input.errorCode,
        attempts: sql`${botCommandSyncs.attempts} + 1`,
        nextAttemptAt: input.nextAttemptAt,
        claimedUntil: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(botCommandSyncs.botInstanceId, botId),
          eq(botCommandSyncs.tenantId, tenantId),
          eq(botCommandSyncs.claimedUntil, input.claim),
        ),
      )
      .returning({ attempts: botCommandSyncs.attempts });
    return row?.attempts ?? null;
  }

  async release(
    scope: ScopeContext,
    botId: BotInstanceId,
    claim: Date,
    tx?: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await executorOf(this.db, tx)
      .update(botCommandSyncs)
      .set({ claimedUntil: null })
      .where(
        and(
          eq(botCommandSyncs.botInstanceId, botId),
          eq(botCommandSyncs.tenantId, tenantId),
          eq(botCommandSyncs.claimedUntil, claim),
        ),
      );
  }

  async activeBotsAcrossTenants(
    limit: number,
    afterBotId: string | null,
  ): Promise<
    ReadonlyArray<{
      readonly tenantId: string;
      readonly botId: BotInstanceId;
      readonly syncedHash: string | null;
      readonly queued: boolean;
    }>
  > {
    const rows = await this.db
      .select({
        tenantId: botInstances.tenantId,
        botId: botInstances.id,
        syncedHash: botInstances.commandsRevision,
        nextAttemptAt: botCommandSyncs.nextAttemptAt,
      })
      .from(botInstances)
      .innerJoin(tenants, eq(tenants.id, botInstances.tenantId))
      .leftJoin(botCommandSyncs, eq(botCommandSyncs.botInstanceId, botInstances.id))
      .where(
        and(
          eq(botInstances.status, 'ACTIVE'),
          eq(tenants.status, 'ACTIVE'),
          ...(afterBotId === null ? [] : [gt(botInstances.id, afterBotId)]),
        ),
      )
      // Keyset on the bot id (unique, UUIDv7): the page after `afterBotId` is exactly the
      // rows a previous page did not cover, whatever moved in between.
      .orderBy(asc(botInstances.id))
      .limit(limit);
    return rows.map((row) => ({
      tenantId: row.tenantId,
      botId: row.botId as BotInstanceId,
      syncedHash: row.syncedHash,
      queued: row.nextAttemptAt !== null,
    }));
  }
}
