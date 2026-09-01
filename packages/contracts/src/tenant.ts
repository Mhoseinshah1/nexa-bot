import { z } from 'zod';
import type { BotInstanceId, TenantId } from './ids.js';
import type { Calendar } from './time.js';
import type { CurrencyCode } from './money.js';

/**
 * Tenancy.
 *
 * A Tenant is a commercial boundary. A BotInstance is a Telegram bot. They are
 * NOT the same thing: one tenant owns one or more bot instances, and a reseller
 * sales bot is modelled as its own tenant with a parent.
 *
 * The legacy system cannot answer whether its admins, texts and settings are
 * per-bot or deployment-wide (UNK-ADM-004, UNK-BC-003, UNK-TXT-009, UNK-GS-010).
 * Ours answers it once, here, for everything.
 */

export const TENANT_KINDS = ['PRIMARY', 'RESELLER_BOT'] as const;
export type TenantKind = (typeof TENANT_KINDS)[number];

/** STOPPED is not DELETED. A stopped tenant retains its data and its history. */
export const TENANT_STATUSES = ['ACTIVE', 'STOPPED', 'DISABLED'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const tenantKindSchema = z.enum(TENANT_KINDS);
export const tenantStatusSchema = z.enum(TENANT_STATUSES);

export interface Tenant {
  readonly id: TenantId;
  readonly kind: TenantKind;
  readonly parentTenantId: TenantId | null;
  readonly slug: string;
  readonly displayName: string;
  readonly status: TenantStatus;
  readonly locale: string;
  readonly displayTimezone: string;
  readonly calendar: Calendar;
  readonly currency: CurrencyCode;
}

export const BOT_INSTANCE_STATUSES = ['ACTIVE', 'STOPPED', 'DISABLED'] as const;
export type BotInstanceStatus = (typeof BOT_INSTANCE_STATUSES)[number];

export interface BotInstance {
  readonly id: BotInstanceId;
  readonly tenantId: TenantId;
  readonly username: string;
  readonly status: BotInstanceStatus;
  /**
   * The bot token is never held in plaintext and never returned by any API.
   * This is a reference to an envelope-encrypted secret.
   */
  readonly tokenSecretRef: string;
}

/**
 * The tenant a unit of work belongs to.
 *
 * Repositories refuse to run without one. The guard makes a missing tenant
 * predicate fail loudly in development and test rather than silently returning
 * another tenant's rows.
 */
export interface TenantContext {
  readonly tenantId: TenantId;
  readonly botInstanceId: BotInstanceId | null;
}

/**
 * The context for work that is genuinely not tenant-scoped: the outbox relay,
 * platform-level migrations, cross-tenant health checks.
 *
 * It is a distinct type rather than `null` so that "no tenant" is always a
 * deliberate, greppable decision instead of an omission.
 */
export interface SystemContext {
  readonly kind: 'SYSTEM';
  readonly reason: string;
}

export function systemContext(reason: string): SystemContext {
  return { kind: 'SYSTEM', reason };
}

export type ScopeContext = TenantContext | SystemContext;

export function isSystemContext(scope: ScopeContext): scope is SystemContext {
  return 'kind' in scope && scope.kind === 'SYSTEM';
}
