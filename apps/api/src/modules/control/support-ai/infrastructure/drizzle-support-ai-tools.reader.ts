import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  errors,
  isSystemContext,
  money,
  type CurrencyCode,
  type PaymentMethod,
  type PaymentState,
  type ProductId,
  type ScopeContext,
  type SettingKey,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import {
  PAYMENT_METHOD_NAMES_FA,
  SUPPORT_PAYMENT_STATE_LABELS_FA,
  SUPPORT_PAYMENT_UNDER_REVIEW_FA,
  formatMoney,
} from '@nexa/i18n';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { payments, services } from '../../../../infrastructure/persistence/schema.js';
import { underReviewCondition } from '../../../commerce/support-context/infrastructure/drizzle-support-context.reader.js';
import type { ProductRepository } from '../../../commerce/catalog/application/ports.js';
import type { PaymentCheckFact } from '../domain/actions.js';
import type {
  SupportAiToolReader,
  SupportAiToolSettings,
} from '../application/support-ai-tools.js';

/** The services «سرویس‌های من» offers a link for (`ProvisioningService.isDeliverable`). */
const DELIVERABLE_STATES = ['ACTIVE', 'SUSPENDED', 'EXPIRED'] as const;
const CHECK_PAYMENTS = 5;

/**
 * Phase 4 PR-3 — the support AI's read-only tools, in PostgreSQL. Each statement names its
 * columns and puts the tenant AND the conversation's customer in its WHERE: a service or payment
 * of anybody else is unreachable from here by construction (cross-cutting item 1).
 */
export class DrizzleSupportAiToolReader implements SupportAiToolReader {
  constructor(
    private readonly deps: {
      readonly db: Database;
      /** R11 A4: «فقط فایل، بدون لینک ساب» — the one reader every link-showing place asks. */
      readonly filesOnly: {
        isFilesOnly(scope: TenantContext, panelId: string, tx?: unknown): Promise<boolean>;
      };
      readonly trials: {
        eligibleForSupportOffer(scope: TenantContext, customerId: UserId): Promise<boolean>;
      };
      readonly products: Pick<ProductRepository, 'findById'>;
    },
  ) {}

  async subscriptionOf(
    scope: ScopeContext,
    customerId: string,
    serviceId: string,
    tx?: unknown,
  ): ReturnType<SupportAiToolReader['subscriptionOf']> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.executor(tx)
      .select({
        username: services.providerUsername,
        panelId: services.panelId,
        state: services.state,
        link: services.subscriptionUrl,
      })
      .from(services)
      .where(
        and(
          eq(services.tenantId, tenantId),
          eq(services.id, serviceId),
          eq(services.customerId, customerId),
        ),
      )
      .limit(1);
    if (row === undefined) return null;
    const filesOnly = await this.deps.filesOnly.isFilesOnly(tenantOf(scope), row.panelId, tx);
    const deliverable =
      (DELIVERABLE_STATES as readonly string[]).includes(row.state) && row.link !== null;
    return {
      username: row.username,
      // A «فقط فایل» panel's link is never returned at all: nothing downstream can show it.
      link: deliverable && !filesOnly ? row.link : null,
      filesOnly: deliverable && filesOnly,
    };
  }

  async paymentsForCheck(
    scope: ScopeContext,
    customerId: string,
    since: Date,
    tx?: unknown,
  ): Promise<readonly PaymentCheckFact[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.executor(tx)
      .select({
        id: payments.id,
        code: payments.code,
        orderId: payments.orderId,
        amount: payments.amount,
        currency: payments.currency,
        method: payments.method,
        gatewayProvider: payments.gatewayProvider,
        state: payments.state,
        createdAt: payments.createdAt,
        underReview: sql<boolean>`${underReviewCondition()}`,
      })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.customerId, customerId),
          gte(payments.createdAt, since),
        ),
      )
      .orderBy(desc(payments.createdAt), desc(payments.id))
      .limit(CHECK_PAYMENTS);
    // The services a CONFIRMED purchase created: the customer's own, live, with a link to give.
    const orderIds = rows
      .filter((row) => row.state === 'CONFIRMED' && row.orderId !== null)
      .map((row) => row.orderId as string);
    const delivered =
      orderIds.length === 0
        ? []
        : await this.executor(tx)
            .select({
              id: services.id,
              orderId: services.orderId,
              username: services.providerUsername,
            })
            .from(services)
            .where(
              and(
                eq(services.tenantId, tenantId),
                eq(services.customerId, customerId),
                inArray(services.orderId, orderIds),
                inArray(services.state, [...DELIVERABLE_STATES]),
                isNotNull(services.subscriptionUrl),
              ),
            );
    return rows.map((row) => {
      const state = row.state as PaymentState;
      const underReview = row.underReview === true;
      const service = delivered.find((candidate) => candidate.orderId === row.orderId);
      return {
        code: row.code,
        amount: formatMoney(money(row.amount, row.currency as CurrencyCode)),
        route: PAYMENT_METHOD_NAMES_FA[row.method as PaymentMethod] ?? row.method,
        gateway: row.gatewayProvider,
        state,
        underReview,
        stateLabel: underReview
          ? SUPPORT_PAYMENT_UNDER_REVIEW_FA
          : SUPPORT_PAYMENT_STATE_LABELS_FA[state],
        createdAt: row.createdAt,
        delivered:
          state === 'CONFIRMED' && service !== undefined
            ? { serviceId: service.id, username: service.username }
            : null,
      };
    });
  }

  async trialEligible(scope: ScopeContext, customerId: string): Promise<boolean> {
    return this.deps.trials.eligibleForSupportOffer(tenantOf(scope), customerId as UserId);
  }

  async categoryOfProduct(scope: ScopeContext, productId: string): Promise<string | null> {
    const product = await this.deps.products.findById(tenantOf(scope), productId as ProductId);
    return product?.categoryId ?? null;
  }

  private executor(tx: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.deps.db;
  }
}

export const SUPPORT_AI_ACTIONS_ENABLED_KEY = 'support.ai.actions_enabled' satisfies SettingKey;
export const SUPPORT_AI_LABEL_ENABLED_KEY = 'support.ai.label_enabled' satisfies SettingKey;
export const SUPPORT_AI_FEEDBACK_ENABLED_KEY = 'support.ai.feedback_enabled' satisfies SettingKey;

/** The three PR-3 switches, read through the settings resolver (its defaults included). */
export class SettingsSupportAiToolSettings implements SupportAiToolSettings {
  constructor(
    private readonly settings: {
      valueOf<T>(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<T>;
    },
  ) {}

  async read(scope: ScopeContext, tx?: unknown) {
    const [actions, label, feedback] = await Promise.all([
      this.settings.valueOf<boolean>(scope, SUPPORT_AI_ACTIONS_ENABLED_KEY, tx),
      this.settings.valueOf<boolean>(scope, SUPPORT_AI_LABEL_ENABLED_KEY, tx),
      this.settings.valueOf<boolean>(scope, SUPPORT_AI_FEEDBACK_ENABLED_KEY, tx),
    ]);
    return { actions: actions === true, label: label === true, feedback: feedback === true };
  }
}

function tenantOf(scope: ScopeContext): TenantContext {
  if (isSystemContext(scope)) {
    throw errors.internal('support_ai.scope', 'The support AI tools need a tenant scope.');
  }
  return scope;
}
