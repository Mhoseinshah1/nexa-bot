import { and, asc, eq, sql } from 'drizzle-orm';
import {
  asId,
  isAppearanceSlot,
  type AppearanceSlot,
  type AppearanceTestErrorCode,
  type AppearanceTestOutcome,
  type BotInstanceId,
  type BotInstanceStatus,
  type Clock,
  type ScopeContext,
  type TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { botAppearanceSlots, botInstances } from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  NO_DECORATION,
  type AppearanceDecoration,
} from '../../../commerce/messaging/application/appearance-render.js';
import type { AppearanceReader } from '../../../commerce/messaging/application/ports.js';
import { isCustomEmojiEligible } from '../application/eligibility.js';
import type {
  AppearanceBotRecord,
  AppearanceRepository,
  StoredAppearanceSlot,
} from '../application/ports.js';

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

type SlotRow = typeof botAppearanceSlots.$inferSelect;

function toSlot(row: SlotRow): StoredAppearanceSlot {
  return {
    // The column is CHECK-pinned to the catalogue; a row this build cannot name is skipped
    // by `listSlots` rather than thrown on, so a later release's slot never breaks the page.
    slot: row.slot as AppearanceSlot,
    customEmojiId: row.customEmojiId,
    enabled: row.enabled,
    version: row.version,
    updatedAt: row.updatedAt,
    updatedByAdminId: row.updatedByAdminId,
  };
}

/** The bot columns this repository reads: never a token, a key id or a fingerprint. */
const BOT_COLUMNS = {
  id: botInstances.id,
  username: botInstances.username,
  status: botInstances.status,
  testedAt: botInstances.customEmojiTestedAt,
  outcome: botInstances.customEmojiTestOutcome,
  errorCode: botInstances.customEmojiTestErrorCode,
};

type BotRow = {
  id: string;
  username: string;
  status: string;
  testedAt: Date | null;
  outcome: string | null;
  errorCode: string | null;
};

function toBot(row: BotRow): AppearanceBotRecord {
  return {
    id: asId<'BotInstanceId'>(row.id) as BotInstanceId,
    username: row.username,
    status: row.status as BotInstanceStatus,
    test:
      row.testedAt === null || row.outcome === null
        ? null
        : {
            testedAt: row.testedAt,
            outcome: row.outcome as AppearanceTestOutcome,
            errorCode: row.errorCode as AppearanceTestErrorCode | null,
          },
  };
}

/**
 * The appearance rows (`bot_appearance_slots`) and the test columns on `bot_instances`.
 *
 * Every SELECT on the bot table names its columns: no token ciphertext, no key id, no
 * fingerprint ever leaves this repository — the rule `DrizzleBotManagementRepository`
 * states for the same table.
 */
export class DrizzleAppearanceRepository implements AppearanceRepository {
  constructor(private readonly db: Database) {}

  async listSlots(scope: ScopeContext, tx?: unknown): Promise<StoredAppearanceSlot[]> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select()
      .from(botAppearanceSlots)
      .where(eq(botAppearanceSlots.tenantId, tenantId));
    return rows.filter((row) => isAppearanceSlot(row.slot)).map(toSlot);
  }

  async findSlot(
    scope: ScopeContext,
    slot: AppearanceSlot,
    tx?: unknown,
    forUpdate = false,
  ): Promise<StoredAppearanceSlot | null> {
    const tenantId = requireTenantId(scope);
    const query = executorOf(this.db, tx)
      .select()
      .from(botAppearanceSlots)
      .where(and(eq(botAppearanceSlots.tenantId, tenantId), eq(botAppearanceSlots.slot, slot)))
      .limit(1);
    const [row] = forUpdate ? await query.for('update') : await query;
    return row === undefined ? null : toSlot(row);
  }

  async insertSlot(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly slot: AppearanceSlot;
      readonly customEmojiId: string | null;
      readonly enabled: boolean;
      readonly now: Date;
      readonly updatedByAdminId: string | null;
    },
    tx: unknown,
  ): Promise<StoredAppearanceSlot | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .insert(botAppearanceSlots)
      .values({
        id: input.id,
        tenantId,
        slot: input.slot,
        customEmojiId: input.customEmojiId,
        enabled: input.enabled,
        version: 1,
        createdAt: input.now,
        updatedAt: input.now,
        updatedByAdminId: input.updatedByAdminId,
      })
      // Never DO UPDATE: the second of two first saves must lose, not overwrite.
      .onConflictDoNothing({ target: [botAppearanceSlots.tenantId, botAppearanceSlots.slot] })
      .returning();
    return row === undefined ? null : toSlot(row);
  }

  async updateSlot(
    scope: ScopeContext,
    input: {
      readonly slot: AppearanceSlot;
      readonly expectedVersion: number;
      readonly customEmojiId: string | null;
      readonly enabled: boolean;
      readonly now: Date;
      readonly updatedByAdminId: string | null;
    },
    tx: unknown,
  ): Promise<StoredAppearanceSlot | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .update(botAppearanceSlots)
      .set({
        customEmojiId: input.customEmojiId,
        enabled: input.enabled,
        version: sql`${botAppearanceSlots.version} + 1`,
        updatedAt: input.now,
        updatedByAdminId: input.updatedByAdminId,
      })
      .where(
        and(
          eq(botAppearanceSlots.tenantId, tenantId),
          eq(botAppearanceSlots.slot, input.slot),
          eq(botAppearanceSlots.version, input.expectedVersion),
        ),
      )
      .returning();
    return row === undefined ? null : toSlot(row);
  }

  async deleteSlot(
    scope: ScopeContext,
    slot: AppearanceSlot,
    expectedVersion: number,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const deleted = await executorOf(this.db, tx)
      .delete(botAppearanceSlots)
      .where(
        and(
          eq(botAppearanceSlots.tenantId, tenantId),
          eq(botAppearanceSlots.slot, slot),
          eq(botAppearanceSlots.version, expectedVersion),
        ),
      )
      .returning({ id: botAppearanceSlots.id });
    return deleted.length > 0;
  }

  async listBots(scope: ScopeContext, tx?: unknown): Promise<AppearanceBotRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select(BOT_COLUMNS)
      .from(botInstances)
      .where(eq(botInstances.tenantId, tenantId))
      .orderBy(asc(botInstances.createdAt), asc(botInstances.id));
    return rows.map(toBot);
  }

  async lockBot(
    scope: ScopeContext,
    botInstanceId: BotInstanceId,
    tx: unknown,
  ): Promise<AppearanceBotRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select(BOT_COLUMNS)
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.id, botInstanceId)))
      .limit(1)
      .for('update');
    return row === undefined ? null : toBot(row);
  }

  async recordTest(
    scope: ScopeContext,
    botInstanceId: BotInstanceId,
    result: {
      readonly testedAt: Date;
      readonly outcome: AppearanceTestOutcome;
      readonly errorCode: AppearanceTestErrorCode | null;
    },
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const updated = await executorOf(this.db, tx)
      .update(botInstances)
      .set({
        customEmojiTestedAt: result.testedAt,
        customEmojiTestOutcome: result.outcome,
        customEmojiTestErrorCode: result.errorCode,
        updatedAt: result.testedAt,
      })
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.id, botInstanceId)))
      .returning({ id: botInstances.id });
    return updated.length > 0;
  }
}

/** How long one bot's decoration is reused before the rows are read again. */
export const APPEARANCE_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  readonly decoration: AppearanceDecoration;
  readonly staleAt: number;
}

/**
 * The messenger's view of the appearance rows, remembered for thirty seconds per bot.
 *
 * Every customer message would otherwise cost two reads; thirty seconds is the stated
 * bound on how long a saved slot or a test's verdict takes to reach the bot's messages.
 * The cache is keyed by tenant AND bot, because the decoration is (the slots are the
 * tenant's, the eligibility is the bot's), and a runtime refusal clears the bot's entry so
 * decoration stops on the very next message.
 */
export class CachedAppearanceReader implements AppearanceReader {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly repository: Pick<
      AppearanceRepository,
      'listSlots' | 'listBots' | 'recordTest'
    >,
    private readonly clock: Clock,
  ) {}

  async decorationFor(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
  ): Promise<AppearanceDecoration> {
    const key = `${scope.tenantId}:${botInstanceId}`;
    const now = this.clock.now().getTime();
    const cached = this.cache.get(key);
    if (cached !== undefined && now < cached.staleAt) return cached.decoration;

    const bots = await this.repository.listBots(scope);
    const bot = bots.find((one) => one.id === botInstanceId);
    // Untested is not eligible. Never assumed: the Bot API grants custom emoji per bot and
    // answers nothing in advance, so only a recorded `SENT` decorates. The builder's
    // Inspector asks the same predicate.
    const decoration = isCustomEmojiEligible(bot)
      ? await this.configuredDecoration(scope)
      : NO_DECORATION;
    this.cache.set(key, { decoration, staleAt: now + APPEARANCE_CACHE_TTL_MS });
    return decoration;
  }

  async configuredDecoration(scope: TenantContext): Promise<AppearanceDecoration> {
    const customEmoji = new Map<AppearanceSlot, string>();
    for (const slot of await this.repository.listSlots(scope)) {
      if (slot.enabled && slot.customEmojiId !== null)
        customEmoji.set(slot.slot, slot.customEmojiId);
    }
    // Returned to a bot only through `decorationFor`'s eligibility check (or to the probe,
    // whose whole purpose is to try): so whoever holds it may carry custom emoji.
    return { customEmoji, eligible: true };
  }

  async recordRuntimeRefusal(scope: TenantContext, botInstanceId: BotInstanceId): Promise<void> {
    await this.repository.recordTest(scope, botInstanceId, {
      testedAt: this.clock.now(),
      outcome: 'REJECTED',
      errorCode: 'appearance.custom_emoji_refused',
    });
    this.cache.delete(`${scope.tenantId}:${botInstanceId}`);
  }

  /** A saved slot or a recorded test reaches this process's messages at once, not in 30 s. */
  forget(scope: TenantContext): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${scope.tenantId}:`)) this.cache.delete(key);
    }
  }
}
