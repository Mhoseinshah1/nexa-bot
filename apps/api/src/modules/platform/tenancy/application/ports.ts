import type { BotInstance, ScopeContext, Tenant, TenantId } from '@nexa/contracts';

/**
 * Ports owned by the tenancy module.
 *
 * The application layer declares what it needs; the persistence layer
 * implements it and depends inward. Nothing here knows about Drizzle.
 */

export interface TenantRepository {
  /** Looked up by id under the system scope — resolving a tenant precedes having one. */
  findById(id: TenantId): Promise<Tenant | null>;
  findBySlug(slug: string): Promise<Tenant | null>;
  /** Scoped read: returns the tenant only if the scope permits seeing it. */
  findInScope(scope: ScopeContext): Promise<Tenant | null>;
}

export interface BotInstanceRepository {
  /** Scoped: a tenant may only list its own bot instances. */
  listForTenant(scope: ScopeContext): Promise<BotInstance[]>;
  findByUsername(scope: ScopeContext, username: string): Promise<BotInstance | null>;
  /** Resolves the bot token for outbound calls. Decrypts; never returned to a surface. */
  resolveToken(scope: ScopeContext, id: BotInstance['id']): Promise<string>;
}

export const TENANT_REPOSITORY = Symbol('TENANT_REPOSITORY');
export const BOT_INSTANCE_REPOSITORY = Symbol('BOT_INSTANCE_REPOSITORY');
