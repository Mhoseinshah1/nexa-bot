import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  errors,
  OWNER_ROLE_KEY,
  IDENTITY_ERROR_CODES,
  type AdminId,
  type BotInstanceStatus,
  type RoleId,
  type SystemContext,
  type TenantContext,
  type TenantStatus,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  ScopeBound,
  withSystemScope,
  withSystemScopeIn,
} from '../../../../infrastructure/persistence/database-scope.js';
import {
  adminSessions,
  admins,
  botInstances,
  customers,
  orders,
  payments,
  services,
  tenants,
} from '../../../../infrastructure/persistence/schema.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { HostedTenantFacts, HostedTenantSystemPath } from '../application/ports.js';

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

/**
 * The system path for one hosting operation (ADR-0037), under a LITERAL reason pinned in
 * `tests/unit/system-path-allowlist.ts`: on the owner's own transaction when given one
 * (`withSystemScopeIn`, where row-level security would otherwise confine every statement
 * to the installation tenant and refuse the hosted tenant's rows), else on the pool.
 */
function acrossTenants<T>(tx: unknown, reason: string, fn: () => Promise<T>): Promise<T> {
  const open = (tx as TransactionScope | undefined)?.tx;
  return open === undefined ? withSystemScope(reason, fn) : withSystemScopeIn(open, reason, fn);
}

/** What `provision` needs from identity: the same repositories every admin path uses. */
export interface HostedOwnerProvisioning {
  readonly admins: {
    create(
      scope: TenantContext,
      input: {
        readonly id: AdminId;
        readonly username: string;
        readonly displayName: string;
        readonly passwordHash: string;
        readonly telegramUserId: string | null;
        readonly now: Date;
      },
      tx?: unknown,
    ): Promise<void>;
  };
  readonly roles: {
    ensureSystemRoles(scope: TenantContext, tx?: unknown): Promise<void>;
    findByKey(scope: TenantContext, key: string, tx?: unknown): Promise<{ id: string } | null>;
    setAdminRoles(
      scope: TenantContext,
      adminId: AdminId,
      roleIds: readonly RoleId[],
      assignedBy: AdminId | null,
      tx?: unknown,
    ): Promise<void>;
  };
}

/**
 * Phase 6A PR-3 — THE creator panel's cross-tenant path (`HostedTenantSystemPath`).
 *
 * Every method takes an explicit `SystemContext` (`hosting.<operation>`): these are the
 * installation owner's reads and writes ACROSS hosted tenants, and each runs on the RLS
 * system path (ADR-0037) under its own literal reason (`acrossTenants`), on the caller's
 * transaction when it has one. The context is asserted, never ignored, so a call site
 * cannot reach here without naming why.
 *
 * Reads are aggregate (counts, usernames, statuses); nothing here returns a hosted tenant's
 * customers, credentials or messages.
 */
@ScopeBound()
export class DrizzleHostedTenantSystemPath implements HostedTenantSystemPath {
  constructor(
    private readonly db: Database,
    private readonly provisioning: HostedOwnerProvisioning,
  ) {}

  async facts(
    context: SystemContext,
    hosted: readonly { readonly tenantId: string; readonly ownerAdminId: string }[],
  ): Promise<ReadonlyMap<string, HostedTenantFacts>> {
    assertSystem(context);
    const out = new Map<string, HostedTenantFacts>();
    if (hosted.length === 0) return out;
    const ids = hosted.map((row) => row.tenantId);
    const [directory, counts, owners, bots] = await acrossTenants(
      undefined,
      'hosting: the hosted bot list, every hosted tenant',
      async () =>
        await Promise.all([
          this.db
            .select({
              id: tenants.id,
              slug: tenants.slug,
              displayName: tenants.displayName,
              status: tenants.status,
            })
            .from(tenants)
            .where(inArray(tenants.id, ids)),
          this.db
            .select({ tenantId: customers.tenantId, count: sql<number>`count(*)::int` })
            .from(customers)
            .where(inArray(customers.tenantId, ids))
            .groupBy(customers.tenantId),
          this.db
            .select({ tenantId: admins.tenantId, id: admins.id, username: admins.username })
            .from(admins)
            .where(
              and(
                inArray(admins.tenantId, ids),
                inArray(
                  admins.id,
                  hosted.map((row) => row.ownerAdminId),
                ),
              ),
            ),
          this.db
            .select({
              tenantId: botInstances.tenantId,
              username: botInstances.username,
              status: botInstances.status,
            })
            .from(botInstances)
            .where(inArray(botInstances.tenantId, ids))
            .orderBy(asc(botInstances.createdAt), asc(botInstances.id)),
        ]),
    );
    const countOf = new Map(counts.map((row) => [row.tenantId, row.count]));
    const ownerOf = new Map(owners.map((row) => [`${row.tenantId}:${row.id}`, row.username]));
    const botOf = new Map<string, { username: string; status: BotInstanceStatus }>();
    for (const bot of bots) {
      // The first bot a tenant connected is the one the panel names.
      if (!botOf.has(bot.tenantId)) {
        botOf.set(bot.tenantId, {
          username: bot.username,
          status: bot.status as BotInstanceStatus,
        });
      }
    }
    for (const row of directory) {
      const ownerAdminId = hosted.find((entry) => entry.tenantId === row.id)?.ownerAdminId;
      out.set(row.id, {
        tenantId: row.id,
        slug: row.slug,
        displayName: row.displayName,
        status: row.status as TenantStatus,
        customerCount: countOf.get(row.id) ?? 0,
        ownerUsername: ownerOf.get(`${row.id}:${ownerAdminId ?? ''}`) ?? null,
        bot: botOf.get(row.id) ?? null,
      });
    }
    return out;
  }

  async slugTaken(context: SystemContext, slug: string, tx?: unknown): Promise<boolean> {
    assertSystem(context);
    const [row] = await acrossTenants(tx, 'hosting: slug taken in any tenant', () =>
      executorOf(this.db, tx)
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .limit(1),
    );
    return row !== undefined;
  }

  async provision(
    context: SystemContext,
    input: Parameters<HostedTenantSystemPath['provision']>[1],
    tx: unknown,
  ): Promise<void> {
    assertSystem(context);
    // The hosted tenant's rows (the tenant, its roles, its first owner) are written from
    // the installation owner's transaction: on the system path, or RLS refuses them.
    await acrossTenants(tx, 'hosting: provision a hosted tenant', () =>
      this.provisionIn(input, tx),
    );
  }

  private async provisionIn(
    input: Parameters<HostedTenantSystemPath['provision']>[1],
    tx: unknown,
  ): Promise<void> {
    const executor = executorOf(this.db, tx);
    const [parent] = await executor
      .select({
        locale: tenants.locale,
        displayTimezone: tenants.displayTimezone,
        calendar: tenants.calendar,
        currency: tenants.currency,
      })
      .from(tenants)
      .where(eq(tenants.id, input.parentTenantId))
      .limit(1);
    if (parent === undefined) {
      throw errors.internal('platform.tenant_not_found', 'The installation tenant is missing.');
    }
    await executor.insert(tenants).values({
      id: input.tenantId,
      kind: 'HOSTED',
      parentTenantId: input.parentTenantId,
      slug: input.slug,
      displayName: input.displayName,
      status: 'ACTIVE',
      locale: parent.locale,
      displayTimezone: parent.displayTimezone,
      calendar: parent.calendar,
      currency: parent.currency,
      createdAt: input.now,
      updatedAt: input.now,
    });
    // The hosted tenant's OWN scope: its roles and its first owner are its rows.
    const hosted: TenantContext = { tenantId: input.tenantId as never, botInstanceId: null };
    await this.provisioning.roles.ensureSystemRoles(hosted, tx);
    const ownerRole = await this.provisioning.roles.findByKey(hosted, OWNER_ROLE_KEY, tx);
    if (ownerRole === null) {
      throw errors.internal(
        IDENTITY_ERROR_CODES.ROLE_NOT_FOUND,
        'The owner role was not seeded for the hosted tenant.',
      );
    }
    await this.provisioning.admins.create(
      hosted,
      {
        id: input.ownerAdminId,
        username: input.ownerUsername,
        displayName: input.ownerDisplayName,
        passwordHash: input.ownerPasswordHash,
        telegramUserId: null,
        now: input.now,
      },
      tx,
    );
    // Null `assignedBy`: no administrator OF THAT TENANT granted it (D5: the creator's act is
    // recorded in his own audit log, not theirs).
    await this.provisioning.roles.setAdminRoles(
      hosted,
      input.ownerAdminId,
      [ownerRole.id as RoleId],
      null,
      tx,
    );
  }

  async setTenantStatus(
    context: SystemContext,
    hostedTenantId: string,
    from: TenantStatus,
    to: TenantStatus,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    assertSystem(context);
    // Conditional on `from` and on the kind: this path never touches the installation's own
    // tenant or a reseller bot, whatever id it is handed.
    const rows = await acrossTenants(tx, 'hosting: set a hosted tenant status', () =>
      executorOf(this.db, tx)
        .update(tenants)
        .set({ status: to, updatedAt: now })
        .where(
          and(eq(tenants.id, hostedTenantId), eq(tenants.kind, 'HOSTED'), eq(tenants.status, from)),
        )
        .returning({ id: tenants.id }),
    );
    return rows.length === 1;
  }

  async closeForPurge(
    context: SystemContext,
    hostedTenantId: string,
    now: Date,
    tx: unknown,
  ): Promise<{ sessionsRevoked: number; botsDisabled: number }> {
    assertSystem(context);
    return acrossTenants(tx, 'hosting: close a hosted tenant for purge', () =>
      this.closeForPurgeIn(hostedTenantId, now, tx),
    );
  }

  private async closeForPurgeIn(
    hostedTenantId: string,
    now: Date,
    tx: unknown,
  ): Promise<{ sessionsRevoked: number; botsDisabled: number }> {
    const executor = executorOf(this.db, tx);
    const sessions = await executor
      .update(adminSessions)
      .set({ revokedAt: now, revokedReason: 'hosted_bot_purged' })
      .where(and(eq(adminSessions.tenantId, hostedTenantId), isNull(adminSessions.revokedAt)))
      .returning({ id: adminSessions.id });
    const bots = await executor
      .update(botInstances)
      .set({ status: 'DISABLED', updatedAt: now })
      .where(
        and(
          eq(botInstances.tenantId, hostedTenantId),
          inArray(botInstances.status, ['ACTIVE', 'STOPPED']),
        ),
      )
      .returning({ id: botInstances.id });
    return { sessionsRevoked: sessions.length, botsDisabled: bots.length };
  }

  async purgePreview(context: SystemContext, hostedTenantId: string) {
    assertSystem(context);
    const countIn = async (
      table: typeof customers | typeof orders | typeof services | typeof payments | typeof admins,
    ) => {
      const [row] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(table)
        .where(eq(table.tenantId, hostedTenantId));
      return row?.count ?? 0;
    };
    const [customerCount, orderCount, serviceCount, paymentCount, adminCount] = await acrossTenants(
      undefined,
      'hosting: purge preview counts of a hosted tenant',
      async () =>
        await Promise.all([
          countIn(customers),
          countIn(orders),
          countIn(services),
          countIn(payments),
          countIn(admins),
        ]),
    );
    return {
      customers: customerCount,
      orders: orderCount,
      services: serviceCount,
      payments: paymentCount,
      admins: adminCount,
    };
  }
}

function assertSystem(context: SystemContext): void {
  if (context.kind !== 'SYSTEM' || !context.reason.startsWith('hosting.')) {
    throw errors.internal(
      'platform.tenant_context_missing',
      'The hosting system path needs a SystemContext naming its hosting operation.',
    );
  }
}
