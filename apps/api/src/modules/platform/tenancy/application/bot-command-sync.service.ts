import {
  systemJobActor,
  type ActorContext,
  type AuditWriter,
  type BotCommandCheck,
  type BotCommandEntry,
  type BotCommandSyncResult,
  type BotCommandSyncView,
  type BotInstanceId,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type OperationalEventRecorder,
  type ScopeContext,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { OperationalConditionReader } from '../../opslog/application/ports.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import {
  BOT_COMMAND_SYNC_BATCH,
  BOT_COMMAND_SYNC_RECONCILE_PAGE,
  BOT_COMMAND_SYNC_WARN_AFTER_ATTEMPTS,
  COMMAND_SYNC_FAILING_CODE,
  COMMAND_SYNC_RECOVERED_CODE,
  commandSyncBackoffMs,
  commandSyncDedupeKey,
  commandSyncLeaseMs,
  commandSyncStateOf,
} from '../domain/bot-command-sync.js';
import type {
  BotCommandSyncRepository,
  BotCommandSyncTelegram,
  ClaimedCommandSync,
} from './bot-command-sync-ports.js';
import { sameCommandMenu, type CommandMenu } from './command-menu.js';
import type { BotBootstrapRepository } from './ports.js';

export interface BotCommandSyncServiceDeps {
  readonly repository: BotCommandSyncRepository;
  /** `tokenForBotInstance` resolves an ACTIVE bot's token and nothing else's (`OQ-5R-02`). */
  readonly bots: {
    tokenForBotInstance(scope: ScopeContext, id: BotInstanceId): Promise<string | null>;
  } & Pick<BotBootstrapRepository, 'markCommandsRegistered'>;
  readonly telegram: BotCommandSyncTelegram;
  readonly menu: Pick<CommandMenu, 'desiredFor'>;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly conditions: Pick<OperationalConditionReader, 'openConditions'>;
  readonly clock: Clock;
  readonly ids: Pick<IdGenerator, 'uuid'>;
  readonly telegramCallTimeoutMs: number;
  readonly logger: {
    warn: (context: Record<string, unknown>, message: string) => void;
    error: (context: Record<string, unknown>, message: string) => void;
  };
}

/** What one tick did. */
export interface CommandSyncTickResult {
  readonly claimed: number;
  readonly synced: number;
  readonly failed: number;
  readonly released: number;
}

/**
 * The slash-command sync lane (round P, COMMAND-MENU; `docs/command-menu-audit.md`).
 *
 * ONE way to put a menu on a bot: `attempt` resolves the ACTIVE bot's token through the
 * repository every outbound use goes through, renders the tenant's desired list through
 * `CommandMenu`, calls `setMyCommands` OUTSIDE any transaction on the shared gateway, and
 * records the outcome in one transaction — `commands_revision` (what Telegram was given)
 * beside the sync row's bookkeeping, an audit row, and the operational condition opened
 * after repeated failure or closed by a success.
 *
 * Three callers, one implementation: the worker's tick (due rows across tenants, claimed
 * with a lease), the operator's «همگام‌سازی دوباره» and a token replacement (one bot, now,
 * `syncNow`), and the reconcile sweep (queues what the events missed — a release that
 * changed `BOT_COMMANDS`, a lost event). Every attempt is isolated: one bot's refusal is
 * recorded on that bot and the next is tried. Nothing here throws to a caller that asked
 * for a sync; `syncNow` answers `FAILED` with a code and the row keeps its back-off.
 */
export class BotCommandSyncService {
  constructor(private readonly deps: BotCommandSyncServiceDeps) {}

  /**
   * Records what the tenant wants and queues attempts (a DB write; no network). With
   * `botId` null, every bot of the tenant; `due` forces an attempt now (a token was
   * replaced, an operator asked), otherwise only a bot whose registered menu differs is
   * queued. Reads the desired list through the caller's transaction.
   */
  async requestSync(
    scope: TenantContext,
    botId: BotInstanceId | null,
    options: { readonly due: boolean },
    tx: TransactionScope,
  ): Promise<void> {
    const desired = await this.deps.menu.desiredFor(scope, tx);
    const now = this.deps.clock.now();
    const bots =
      botId === null
        ? (await this.deps.repository.listForTenant(scope, tx))
            .filter((record) => record.bot.status === 'ACTIVE')
            .map((record) => record.bot.id)
        : [botId];
    for (const id of bots) {
      await this.deps.repository.upsertDesired(
        scope,
        { botId: id, desiredHash: desired.hash, now, due: options.due },
        tx,
      );
    }
  }

  /** One bot, now. Never throws: a failure is the answer, with its code, and the row keeps its back-off. */
  async syncNow(scope: TenantContext, botId: BotInstanceId): Promise<BotCommandSyncResult> {
    try {
      const desired = await this.deps.menu.desiredFor(scope);
      const claimed = await this.deps.repository.claimOne(scope, botId, {
        desiredHash: desired.hash,
        now: this.deps.clock.now(),
        leaseMs: commandSyncLeaseMs(this.deps.telegramCallTimeoutMs),
      });
      if (claimed === null) return { botInstanceId: botId, outcome: 'SKIPPED', errorCode: null };
      return await this.attempt(claimed);
    } catch (error: unknown) {
      this.deps.logger.error({ err: String(error), botId }, 'command sync could not run');
      return { botInstanceId: botId, outcome: 'FAILED', errorCode: 'sync.unexpected' };
    }
  }

  /** The worker's tick: claim what is due across tenants and attempt each, isolated. */
  async tick(now: Date): Promise<CommandSyncTickResult> {
    const claimed = await this.deps.repository.claimDue(
      now,
      BOT_COMMAND_SYNC_BATCH,
      commandSyncLeaseMs(this.deps.telegramCallTimeoutMs),
    );
    const result = { claimed: claimed.length, synced: 0, failed: 0, released: 0 };
    for (const row of claimed) {
      const outcome = await this.attempt(row);
      if (outcome.outcome === 'SYNCED') result.synced += 1;
      else if (outcome.outcome === 'FAILED') result.failed += 1;
      else result.released += 1;
    }
    return result;
  }

  /**
   * The sweep: for every ACTIVE bot of every ACTIVE tenant, re-derive the desired menu and
   * queue what differs and is not queued. What catches a release that changed
   * `BOT_COMMANDS` on an installation the installer's reconcile did not reach, and any
   * event a consumer did not see. Answers how many were queued.
   */
  async reconcile(pageSize = BOT_COMMAND_SYNC_RECONCILE_PAGE): Promise<number> {
    const desiredByTenant = new Map<string, string>();
    let queued = 0;
    let after: string | null = null;
    // Page by bot id until a short page: an installation with more bots than one page is
    // swept whole, not its first page for ever (Codex #1).
    for (;;) {
      const page = await this.deps.repository.activeBotsAcrossTenants(pageSize, after);
      for (const bot of page) {
        queued += await this.reconcileOne(bot, desiredByTenant);
      }
      const last = page[page.length - 1];
      if (page.length < pageSize || last === undefined) break;
      after = last.botId;
    }
    return queued;
  }

  /** One bot of the sweep: queue it when its registered digest differs and nothing is queued. */
  private async reconcileOne(
    bot: {
      readonly tenantId: string;
      readonly botId: BotInstanceId;
      readonly syncedHash: string | null;
      readonly queued: boolean;
    },
    desiredByTenant: Map<string, string>,
  ): Promise<number> {
    let queued = 0;
    {
      if (bot.queued) return 0;
      const scope: TenantContext = { tenantId: bot.tenantId as never, botInstanceId: null };
      let hash = desiredByTenant.get(bot.tenantId);
      if (hash === undefined) {
        hash = (await this.deps.menu.desiredFor(scope)).hash;
        desiredByTenant.set(bot.tenantId, hash);
      }
      if (bot.syncedHash === hash) return 0;
      await this.deps.uow.run(scope, async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return;
        await this.deps.repository.upsertDesired(
          scope,
          { botId: bot.botId, desiredHash: hash as string, now: this.deps.clock.now(), due: false },
          tx,
        );
        queued += 1;
      });
    }
    return queued;
  }

  /** Every bot of the tenant with where its menu stands. A read. */
  async statusFor(scope: TenantContext, tx?: unknown): Promise<BotCommandSyncView[]> {
    const desired = await this.deps.menu.desiredFor(scope, tx);
    const records = await this.deps.repository.listForTenant(scope, tx);
    return records.map(({ bot, sync }) => ({
      botInstanceId: bot.id,
      username: bot.username,
      botStatus: bot.status,
      state: commandSyncStateOf({
        botStatus: bot.status,
        syncedHash: bot.syncedHash,
        desiredHash: desired.hash,
        nextAttemptAt: sync?.nextAttemptAt ?? null,
        attempts: sync?.attempts ?? 0,
      }),
      desiredHash: desired.hash,
      desiredVersion: sync?.desiredVersion ?? 0,
      syncedHash: bot.syncedHash,
      lastSyncedAt: sync?.lastSyncedAt?.toISOString() ?? null,
      lastAttemptedAt: sync?.lastAttemptedAt?.toISOString() ?? null,
      lastErrorCode: sync?.lastErrorCode ?? null,
      attempts: sync?.attempts ?? 0,
      nextAttemptAt: sync?.nextAttemptAt?.toISOString() ?? null,
    }));
  }

  /**
   * «بررسی وضعیت»: what Telegram holds now, against the desired list. A read; nothing is
   * stored — a live answer is not a durable state, and `commands_revision` records only
   * what THIS installation sent.
   */
  async check(
    scope: TenantContext,
    botId: BotInstanceId | null,
  ): Promise<{ readonly checks: BotCommandCheck[]; readonly desired: readonly BotCommandEntry[] }> {
    const desired = await this.deps.menu.desiredFor(scope);
    const bots = (await this.deps.repository.listForTenant(scope))
      .map((record) => record.bot)
      .filter((bot) => botId === null || bot.id === botId);
    const checks: BotCommandCheck[] = [];
    for (const bot of bots) {
      const token =
        bot.status === 'ACTIVE' ? await this.deps.bots.tokenForBotInstance(scope, bot.id) : null;
      if (token === null) {
        checks.push({ botInstanceId: bot.id, outcome: 'SKIPPED', matches: null, registered: null });
        continue;
      }
      const read = await this.deps.telegram.readCommands(token);
      checks.push(
        read.outcome === 'READ'
          ? {
              botInstanceId: bot.id,
              outcome: 'READ',
              matches: sameCommandMenu(read.commands, desired.entries),
              registered: [...read.commands],
            }
          : { botInstanceId: bot.id, outcome: read.outcome, matches: null, registered: null },
      );
    }
    return { checks, desired: desired.entries };
  }

  // -------------------------------------------------------------------------

  /** One claimed row: the call outside any transaction, the record inside one. */
  private async attempt(row: ClaimedCommandSync): Promise<BotCommandSyncResult> {
    const scope: TenantContext = { tenantId: row.tenantId as never, botInstanceId: null };
    const actor = this.actor();
    try {
      const token = await this.deps.bots.tokenForBotInstance(scope, row.botInstanceId);
      if (token === null) {
        // Stopped between the claim and now. Not an attempt; the start queues it again.
        await this.deps.repository.release(scope, row.botInstanceId, row.claimedUntil);
        return { botInstanceId: row.botInstanceId, outcome: 'SKIPPED', errorCode: null };
      }
      // Rendered NOW, not from the row: a description edited since the row was queued is
      // what should reach Telegram, and the digest stored is of what was sent.
      const desired = await this.deps.menu.desiredFor(scope);
      const registration = await this.deps.telegram.registerCommands({
        token,
        commands: desired.entries,
      });
      const now = this.deps.clock.now();
      if (registration.outcome === 'REGISTERED') {
        await this.deps.uow.run(scope, async (tx) => {
          if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
            await this.deps.repository.release(scope, row.botInstanceId, row.claimedUntil, tx);
            return;
          }
          // The row FIRST, WHERE it still holds this claim: a claim that lapsed and was
          // taken over records nothing on top of the newer worker's state (Codex #4).
          const held = await this.deps.repository.recordSuccess(
            scope,
            row.botInstanceId,
            { now, sentHash: desired.hash, claim: row.claimedUntil },
            tx,
          );
          if (!held) {
            this.deps.logger.warn(
              { botInstanceId: row.botInstanceId },
              'command sync claim lapsed before its record; the newer claim owns the row',
            );
            return;
          }
          await this.deps.bots.markCommandsRegistered(
            scope,
            row.botInstanceId,
            { revision: desired.hash, now },
            tx,
          );
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'bot.commands.sync',
              entityType: 'BotInstance',
              entityId: row.botInstanceId,
              before: { attempts: row.attempts },
              after: { commandsRevision: desired.hash, commands: desired.entries.length },
              result: 'SUCCESS',
            },
            tx,
          );
          const key = commandSyncDedupeKey(row.botInstanceId);
          const open = await this.deps.conditions.openConditions(scope, [key], tx);
          if (open.includes(COMMAND_SYNC_FAILING_CODE)) {
            await this.deps.opsLog.record(
              scope,
              {
                code: COMMAND_SYNC_RECOVERED_CODE,
                severity: 'INFO',
                message: 'The bot’s Telegram command menu was registered after earlier failures.',
                recoversCode: COMMAND_SYNC_FAILING_CODE,
                recoversDedupeKey: key,
                correlationId: actor.correlationId,
                context: { botInstanceId: row.botInstanceId, commandsRevision: desired.hash },
              },
              tx,
            );
          }
        });
        return { botInstanceId: row.botInstanceId, outcome: 'SYNCED', errorCode: null };
      }
      return await this.recordFailure(
        scope,
        actor,
        row,
        registration.code,
        registration.outcome === 'UNREACHABLE' ? (registration.retryAfterMs ?? null) : null,
        now,
      );
    } catch (error: unknown) {
      // The record itself failed (the database, a stopped scope mid-write). The claim
      // lapses with its lease and the row is met again; nothing is guessed about Telegram.
      this.deps.logger.error(
        { err: String(error), botInstanceId: row.botInstanceId },
        'command sync attempt could not be recorded; leaving it to its lease',
      );
      return { botInstanceId: row.botInstanceId, outcome: 'FAILED', errorCode: 'sync.unexpected' };
    }
  }

  private async recordFailure(
    scope: TenantContext,
    actor: ActorContext,
    row: ClaimedCommandSync,
    errorCode: string,
    retryAfterMs: number | null,
    now: Date,
  ): Promise<BotCommandSyncResult> {
    const attemptsAfter = row.attempts + 1;
    // The back-off, or Telegram's own hold when it named a longer one (Codex #2).
    const nextAttemptAt = new Date(
      now.getTime() + commandSyncBackoffMs(attemptsAfter, retryAfterMs),
    );
    await this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
        await this.deps.repository.release(scope, row.botInstanceId, row.claimedUntil, tx);
        return;
      }
      const attempts = await this.deps.repository.recordFailure(
        scope,
        row.botInstanceId,
        { now, errorCode, nextAttemptAt, claim: row.claimedUntil },
        tx,
      );
      if (attempts === null) {
        this.deps.logger.warn(
          { botInstanceId: row.botInstanceId },
          'command sync claim lapsed before its record; the newer claim owns the row',
        );
        return;
      }
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'bot.commands.sync',
          entityType: 'BotInstance',
          entityId: row.botInstanceId,
          before: { attempts: row.attempts },
          after: { attempts, errorCode, nextAttemptAt: nextAttemptAt.toISOString() },
          result: 'FAILED',
        },
        tx,
      );
      if (attempts >= BOT_COMMAND_SYNC_WARN_AFTER_ATTEMPTS) {
        // Deduped per bot: the condition opens once and counts occurrences after that.
        await this.deps.opsLog.record(
          scope,
          {
            code: COMMAND_SYNC_FAILING_CODE,
            severity: 'WARN',
            message:
              'The bot’s Telegram command menu could not be registered repeatedly; it is being ' +
              'retried with back-off. Customers can still type every command.',
            dedupeKey: commandSyncDedupeKey(row.botInstanceId),
            correlationId: actor.correlationId,
            context: { botInstanceId: row.botInstanceId, attempts, errorCode },
          },
          tx,
        );
      }
    });
    this.deps.logger.warn(
      { botInstanceId: row.botInstanceId, errorCode, attempts: attemptsAfter },
      'command menu registration failed; retrying with back-off',
    );
    return { botInstanceId: row.botInstanceId, outcome: 'FAILED', errorCode };
  }

  private actor(): ActorContext {
    return systemJobActor('bot-command-sync', this.deps.ids.uuid() as CorrelationId);
  }
}
