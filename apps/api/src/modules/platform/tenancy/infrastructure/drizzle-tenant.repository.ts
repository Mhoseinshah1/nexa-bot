import { and, eq, isNull } from 'drizzle-orm';
import {
  isSystemContext,
  asId,
  errors,
  PLATFORM_ERROR_CODES,
  type BotInstance,
  type BotInstanceId,
  type BotInstanceStatus,
  type Calendar,
  type CurrencyCode,
  type ScopeContext,
  type SecretCipher,
  type Tenant,
  type TenantId,
  type TenantKind,
  type TenantStatus,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { isUniqueViolation } from '../../../../infrastructure/persistence/sqlstate.js';
import { botInstances, tenants } from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  BotBootstrapRepository,
  BotBootstrapView,
  BotInstanceRepository,
  TenantRepository,
} from '../application/ports.js';

type TenantRow = typeof tenants.$inferSelect;
type BotInstanceRow = typeof botInstances.$inferSelect;

function toTenant(row: TenantRow): Tenant {
  return {
    id: asId<'TenantId'>(row.id),
    kind: row.kind as TenantKind,
    parentTenantId: row.parentTenantId === null ? null : asId<'TenantId'>(row.parentTenantId),
    slug: row.slug,
    displayName: row.displayName,
    status: row.status as TenantStatus,
    locale: row.locale,
    displayTimezone: row.displayTimezone,
    calendar: row.calendar as Calendar,
    currency: row.currency as CurrencyCode,
  };
}

function toBotInstance(row: BotInstanceRow): BotInstance {
  return {
    id: asId<'BotInstanceId'>(row.id),
    tenantId: asId<'TenantId'>(row.tenantId),
    username: row.username,
    status: row.status as BotInstance['status'],
    // A reference, never the token. Surfaces receive this and can do nothing with it.
    tokenSecretRef: `secret:${row.tokenKeyId}`,
  };
}

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

export class DrizzleTenantRepository implements TenantRepository {
  constructor(private readonly db: Database) {}

  /**
   * Holds this scope's tenant and bot rows still, and says whether both are
   * ACTIVE.
   *
   * A surface checks these when the request arrives, which is a snapshot: a
   * stop can commit in between, return to the operator, and the write still
   * lands — audit, idempotency and outbox rows created for an installation
   * somebody had already switched off. `FOR SHARE` holds the answer for the
   * rest of the transaction, and lets concurrent writers read it at once; only
   * a status change waits.
   *
   * A system scope has no tenant to be inactive, so it passes.
   */
  /**
   * Whether this scope is still accepting work.
   *
   * `FOR SHARE` ONLY inside a caller's transaction, and that distinction is
   * the point. In a transaction the lock is what makes the answer hold until
   * the caller commits: a stop cannot slip in between the check and the write.
   * In autocommit the same lock is taken and released within the statement, so
   * it guarantees nothing at all — and it is a row lock on `tenants`, which is
   * this installation's single busiest row. The monitor reads this once per
   * DUE PANEL before it dials, so an unqualified `FOR SHARE` put a batch of
   * those behind every `FOR UPDATE` an administrator takes, to buy a
   * guarantee the call could not have.
   */
  async scopeIsActive(scope: ScopeContext, tx?: unknown): Promise<boolean> {
    if (isSystemContext(scope)) return true;
    const executor = executorOf(this.db, tx);
    const held = tx !== undefined;

    const tenantQuery = executor
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, scope.tenantId));
    const [tenant] = await (held ? tenantQuery.for('share') : tenantQuery);
    if (tenant?.status !== 'ACTIVE') return false;

    if (scope.botInstanceId === null) return true;

    const botQuery = executor
      .select({ status: botInstances.status })
      .from(botInstances)
      .where(eq(botInstances.id, scope.botInstanceId));
    const [bot] = await (held ? botQuery.for('share') : botQuery);
    return bot?.status === 'ACTIVE';
  }

  async findById(id: TenantId): Promise<Tenant | null> {
    const [row] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return row ? toTenant(row) : null;
  }

  async findBySlug(slug: string): Promise<Tenant | null> {
    const [row] = await this.db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
    return row ? toTenant(row) : null;
  }

  async findPrimary(): Promise<Tenant | null> {
    // Ordered by creation so a deployment that somehow acquired two primary
    // tenants resolves the same one on every boot rather than whichever the
    // planner returned first.
    const [row] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.kind, 'PRIMARY'))
      .orderBy(tenants.createdAt, tenants.id)
      .limit(1);
    return row ? toTenant(row) : null;
  }

  async findInScope(scope: ScopeContext): Promise<Tenant | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return row ? toTenant(row) : null;
  }
}

function toBootstrapView(row: BotInstanceRow): BotBootstrapView {
  return {
    id: asId<'BotInstanceId'>(row.id),
    username: row.username,
    status: row.status as BotInstanceStatus,
    telegramBotId: row.telegramBotId,
    webhookRegisteredAt: row.webhookRegisteredAt,
    webhookUrl: row.webhookUrl,
    webhookSecretFingerprint: row.webhookSecretFingerprint,
  };
}

export class DrizzleBotInstanceRepository implements BotInstanceRepository, BotBootstrapRepository {
  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher,
  ) {}

  /**
   * Unscoped by necessity, and safe for the same reason `TenantRepository`'s is:
   * it resolves WHICH tenant an inbound update belongs to. It returns no secret
   * — `tokenSecretRef` is a reference — and everything downstream runs under the
   * tenant it yields.
   */
  async findById(id: BotInstanceId): Promise<BotInstance | null> {
    const [row] = await this.db.select().from(botInstances).where(eq(botInstances.id, id)).limit(1);
    return row ? toBotInstance(row) : null;
  }

  async listForTenant(scope: ScopeContext): Promise<BotInstance[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(botInstances)
      .where(eq(botInstances.tenantId, tenantId));
    return rows.map(toBotInstance);
  }

  async findByUsername(scope: ScopeContext, username: string): Promise<BotInstance | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select()
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.username, username)))
      .limit(1);
    return row ? toBotInstance(row) : null;
  }

  async resolveToken(scope: ScopeContext, id: BotInstanceId): Promise<string> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select()
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.id, id)))
      .limit(1);

    if (!row) {
      throw errors.notFound(
        PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
        'No bot instance with that id in this tenant.',
      );
    }
    return this.cipher.decrypt(
      { keyId: row.tokenKeyId, ciphertext: row.tokenCiphertext },
      { purpose: 'bot_instance.token', tenantId, entityId: row.id },
    );
  }

  /**
   * The token of the tenant's active bot, for sending on the tenant's behalf.
   *
   * Returns null rather than throwing when the tenant has no active bot: that is
   * a configuration state an operator can be told about, not an exception. A
   * suspended bot is not used — stopping a bot should stop it sending.
   *
   * Ordered by creation so a tenant with several bots resolves the same one on
   * every call instead of whichever the planner happened to return.
   */
  async activeTokenForTenant(scope: ScopeContext): Promise<string | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select()
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.status, 'ACTIVE')))
      .orderBy(botInstances.createdAt, botInstances.id)
      .limit(1);
    if (!row) return null;
    // The context names the row that was actually selected, not the tenant's
    // "current" bot in the abstract. If these two ever disagree the decryption
    // fails rather than returning another row's credential.
    return this.cipher.decrypt(
      { keyId: row.tokenKeyId, ciphertext: row.tokenCiphertext },
      { purpose: 'bot_instance.token', tenantId, entityId: row.id },
    );
  }

  /**
   * The token of ONE named bot instance.
   *
   * Distinct from `activeTokenForTenant` on purpose, and the distinction is the point.
   * Operational notifications go to the people running the installation and any of the
   * tenant's bots will do; a CUSTOMER reply must come from the bot they wrote to. A
   * tenant running a public bot and a reseller bot would otherwise answer from the wrong
   * account — which leaks that the two are related.
   *
   * Scoped by tenant as well as id, so a bot instance id from another tenant resolves to
   * null rather than to that tenant's credential. `ACTIVE` only: stopping a bot should
   * stop it sending, inbound and outbound alike.
   */
  async tokenForBotInstance(
    scope: ScopeContext,
    botInstanceId: BotInstanceId,
  ): Promise<string | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select()
      .from(botInstances)
      .where(
        and(
          eq(botInstances.tenantId, tenantId),
          eq(botInstances.id, botInstanceId),
          eq(botInstances.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    if (!row) return null;
    return this.cipher.decrypt(
      { keyId: row.tokenKeyId, ciphertext: row.tokenCiphertext },
      { purpose: 'bot_instance.token', tenantId, entityId: row.id },
    );
  }

  // -------------------------------------------------------------------------
  // BotBootstrapRepository — reachable only from the fresh-install bootstrap
  // -------------------------------------------------------------------------

  async lockTenantForBotChange(scope: ScopeContext, tx: unknown): Promise<TenantStatus> {
    const tenantId = requireTenantId(scope);
    // The TENANT row, not the bot row — because on a fresh install there is no
    // bot row to lock and the whole race is two installers both finding none.
    // The same row `lockTenantForAdminChange` takes, which costs nothing: an
    // installer creating an owner and an installer creating a bot are the same
    // installer, one step apart.
    const [row] = await executorOf(this.db, tx)
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .for('update');

    return (row?.status ?? 'DISABLED') as TenantStatus;
  }

  async findBootstrapTarget(scope: ScopeContext, tx?: unknown): Promise<BotBootstrapView | null> {
    const tenantId = requireTenantId(scope);
    // Ordered by creation so a tenant that somehow acquired two bots resolves
    // the same one on every call, the way `findPrimary` and
    // `activeTokenForTenant` already do. Status is deliberately not filtered.
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(botInstances)
      .where(eq(botInstances.tenantId, tenantId))
      .orderBy(botInstances.createdAt, botInstances.id)
      .limit(1);
    return row ? toBootstrapView(row) : null;
  }

  async createFromBootstrap(
    scope: ScopeContext,
    input: {
      readonly id: BotInstanceId;
      readonly username: string;
      readonly telegramBotId: string;
      readonly token: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    // Encrypted HERE, bound to the id this row is about to be inserted under.
    // The context is recomputed at decrypt time from the row that is read, so a
    // ciphertext moved to another row or another tenant fails authentication
    // rather than decrypting somebody else's credential.
    const secret = this.cipher.encrypt(input.token, {
      purpose: 'bot_instance.token',
      tenantId,
      entityId: input.id,
    });

    try {
      await executorOf(this.db, tx).insert(botInstances).values({
        id: input.id,
        tenantId,
        username: input.username,
        telegramBotId: input.telegramBotId,
        status: 'ACTIVE',
        tokenCiphertext: secret.ciphertext,
        tokenKeyId: secret.keyId,
        createdAt: input.now,
        updatedAt: input.now,
      });
    } catch (error: unknown) {
      /*
       * Another TENANT on this installation is already bound to this bot.
       *
       * The service's `refuseRepointing` asks the same question of one row and
       * cannot see this: it compares a supplied token against the tenant's OWN
       * bot, and here the tenant has none. The index is the rule — cross-tenant
       * deliberately, because two tenants binding one bot is exactly the
       * collision — and this is how the rule reaches the operator instead of a
       * bare 23505 leaving the CLI as a stack trace.
       *
       * Telegram keeps ONE webhook per bot, so the second binding would not
       * coexist with the first: it moves the delivery, and the first tenant goes
       * on reporting `ready` for a URL that receives nothing.
       *
       * Named constraint, not bare 23505. `bot_instances` also has a unique index
       * on `username`, and answering "already bound to another tenant" for that
       * one would be a confident wrong answer — the username index catches a
       * genuinely different mistake, and it is not this one.
       */
      rethrowAlreadyBound(error, input.telegramBotId);
    }
  }

  async markWebhookRegistered(
    scope: ScopeContext,
    id: BotInstanceId,
    input: { readonly url: string; readonly secretFingerprint: string; readonly now: Date },
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await executorOf(this.db, tx)
      .update(botInstances)
      .set({
        webhookRegisteredAt: input.now,
        webhookUrl: input.url,
        webhookSecretFingerprint: input.secretFingerprint,
        updatedAt: input.now,
      })
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.id, id)));
  }

  async recordTelegramIdentity(
    scope: ScopeContext,
    id: BotInstanceId,
    input: { readonly telegramBotId: string; readonly username: string; readonly now: Date },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    // `telegram_bot_id IS NULL` is part of the WHERE, not just a caller-side
    // check. It is what makes this fill-a-blank rather than a rewrite: a row
    // that already names a bot is never repointed by this statement, whatever
    // a caller believes it is doing.
    // The affected rows are RETURNED, not assumed. A concurrent run can fill the
    // blank between the caller's unlocked read and this statement, and a caller
    // that audited regardless would write a row asserting a `before` that was
    // not true and a change that did not happen.
    /*
     * The SECOND writer of `telegram_bot_id`, and it violates the same index.
     *
     * Two rows predating migration 0038 can hold credentials for the SAME bot —
     * the username index never stopped that, which is the whole reason 0041
     * exists. The first reconciliation fills its id; the second reaches this
     * statement and collides. Only `createFromBootstrap` translated the
     * violation, so this path emitted a raw database error, the CLI printed a
     * stack trace, and the installer fell through to the webhook summary whose
     * suggested retry repeats it exactly.
     */
    try {
      const filled = await executorOf(this.db, tx)
        .update(botInstances)
        .set({
          telegramBotId: input.telegramBotId,
          username: input.username,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(botInstances.tenantId, tenantId),
            eq(botInstances.id, id),
            isNull(botInstances.telegramBotId),
          ),
        )
        .returning({ id: botInstances.id });
      return filled.length > 0;
    } catch (error: unknown) {
      rethrowAlreadyBound(error, input.telegramBotId);
    }
  }
}

/**
 * One Telegram bot, one row — as an operator reads it.
 *
 * Shared by the two statements that write `telegram_bot_id`, because the first
 * version translated only the INSERT and the UPDATE beside it went on emitting a
 * raw 23505. Two copies of one refusal drift, and the copy that drifts is the
 * one nobody reached in testing.
 *
 * Named constraint, not bare 23505: `bot_instances` also has a unique index on
 * `username`, and answering "already bound to another tenant" for that one would
 * be a confident wrong answer about a genuinely different mistake.
 */
function rethrowAlreadyBound(error: unknown, telegramBotId: string): never {
  if (isUniqueViolation(error, 'bot_instances_telegram_bot_id_key')) {
    throw errors.conflict(
      PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_BOT_ALREADY_BOUND,
      `Telegram bot ${telegramBotId} is already configured for another tenant on this ` +
        "installation, and Telegram delivers a bot's updates to one webhook only — binding it " +
        'here would silently stop the other tenant receiving anything. Nothing was changed. Use ' +
        'a separate bot for this tenant.',
    );
  }
  throw error;
}
