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
  /**
   * The installation's primary tenant, resolved at boot.
   *
   * A RESELLER_BOT tenant is never it: reseller tenants are children, and the
   * Web Admin authenticates against the installation's own tenant.
   */
  findPrimary(): Promise<Tenant | null>;
  /** Scoped read: returns the tenant only if the scope permits seeing it. */
  findInScope(scope: ScopeContext): Promise<Tenant | null>;
}

export interface BotInstanceRepository {
  /**
   * Resolves a bot by id without a tenant, the way `TenantRepository.findById`
   * does: an inbound Telegram update names the bot, and the tenant is what this
   * lookup PRODUCES. Every call made afterwards is scoped to the tenant it
   * returns.
   */
  findById(id: BotInstance['id']): Promise<BotInstance | null>;
  /** Scoped: a tenant may only list its own bot instances. */
  listForTenant(scope: ScopeContext): Promise<BotInstance[]>;
  findByUsername(scope: ScopeContext, username: string): Promise<BotInstance | null>;
  /** Resolves the bot token for outbound calls. Decrypts; never returned to a surface. */
  resolveToken(scope: ScopeContext, id: BotInstance['id']): Promise<string>;
}

export const TENANT_REPOSITORY = Symbol('TENANT_REPOSITORY');
export const BOT_INSTANCE_REPOSITORY = Symbol('BOT_INSTANCE_REPOSITORY');
