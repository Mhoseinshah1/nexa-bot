import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import type { PaymentGatewayProvider, SecretCipher, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  botInstances,
  paymentGatewayCallBudgets,
  paymentGatewayCredentials,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  GatewayCallBudget,
  GatewayCredentialStore,
  PublicOriginReader,
} from '../application/gateway-invoice-ports.js';

/**
 * A payment route's API key, encrypted at rest (WP11A).
 *
 * The panel-credential store's rules: the AEAD context `(payment_gateway.api_key,
 * tenant, row id)` is rebuilt from the caller's scope on every read, never stored; this
 * file is the only place the key exists in plaintext, for the length of one expression;
 * and nothing here logs. `setAt` is the only read a response builder can reach, and it
 * selects a timestamp — never the ciphertext.
 */
export class DrizzleGatewayCredentialStore implements GatewayCredentialStore {
  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher,
    private readonly newId: () => string,
  ) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async setAt(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    tx?: unknown,
  ): Promise<Date | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select({ setAt: paymentGatewayCredentials.apiKeySetAt })
      .from(paymentGatewayCredentials)
      .where(
        and(
          eq(paymentGatewayCredentials.tenantId, tenantId),
          eq(paymentGatewayCredentials.provider, provider),
        ),
      )
      .limit(1);
    return row?.setAt ?? null;
  }

  async read(scope: TenantContext, provider: PaymentGatewayProvider): Promise<string | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select({
        id: paymentGatewayCredentials.id,
        ciphertext: paymentGatewayCredentials.apiKeyCiphertext,
        keyId: paymentGatewayCredentials.apiKeyKeyId,
      })
      .from(paymentGatewayCredentials)
      // Scoped by tenant AND provider: a key read that trusted either alone would be the
      // worst place in the payment module to omit a predicate.
      .where(
        and(
          eq(paymentGatewayCredentials.tenantId, tenantId),
          eq(paymentGatewayCredentials.provider, provider),
        ),
      )
      .limit(1);
    if (row === undefined) return null;
    return this.cipher.decrypt(
      { keyId: row.keyId, ciphertext: row.ciphertext },
      { purpose: 'payment_gateway.api_key', tenantId, entityId: row.id },
    );
  }

  async replace(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    apiKey: string,
    now: Date,
    tx: unknown,
  ): Promise<Date> {
    const tenantId = requireTenantId(scope);
    const executor = this.exec(tx);
    /*
     * The row's id is what the ciphertext is bound to, so it is decided BEFORE encrypting:
     * the existing row's when there is one (locked), a fresh one otherwise.
     */
    const [existing] = await executor
      .select({ id: paymentGatewayCredentials.id })
      .from(paymentGatewayCredentials)
      .where(
        and(
          eq(paymentGatewayCredentials.tenantId, tenantId),
          eq(paymentGatewayCredentials.provider, provider),
        ),
      )
      .for('update')
      .limit(1);
    const id = existing?.id ?? this.newId();
    const sealed = this.cipher.encrypt(apiKey, {
      purpose: 'payment_gateway.api_key',
      tenantId,
      entityId: id,
    });
    if (existing === undefined) {
      await executor.insert(paymentGatewayCredentials).values({
        id,
        tenantId,
        provider,
        apiKeyCiphertext: sealed.ciphertext,
        apiKeyKeyId: sealed.keyId,
        apiKeySetAt: now,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await executor
        .update(paymentGatewayCredentials)
        .set({
          apiKeyCiphertext: sealed.ciphertext,
          apiKeyKeyId: sealed.keyId,
          apiKeySetAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(paymentGatewayCredentials.tenantId, tenantId),
            eq(paymentGatewayCredentials.id, id),
          ),
        );
    }
    return now;
  }
}

/**
 * The per-minute call budget, one conditional upsert per call (WP11A §5.7).
 *
 * A fresh window resets the counter; an open window grants while `used < limit`. The
 * `WHERE` on the conflict update is the whole decision, so two replicas asking at once
 * are serialised by the row and at most `limit` calls are granted per window.
 */
export class DrizzleGatewayCallBudget implements GatewayCallBudget {
  constructor(private readonly db: Database) {}

  async take(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    limit: number,
    now: Date,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const windowFloor = new Date(now.getTime() - 60_000);
    const stale = sql`${paymentGatewayCallBudgets.windowStartedAt} <= ${windowFloor}::timestamptz`;
    const rows = await this.db
      .insert(paymentGatewayCallBudgets)
      .values({ tenantId, provider, windowStartedAt: now, used: 1 })
      .onConflictDoUpdate({
        target: [paymentGatewayCallBudgets.tenantId, paymentGatewayCallBudgets.provider],
        set: {
          windowStartedAt: sql`CASE WHEN ${stale} THEN ${now}::timestamptz ELSE ${paymentGatewayCallBudgets.windowStartedAt} END`,
          used: sql`CASE WHEN ${stale} THEN 1 ELSE ${paymentGatewayCallBudgets.used} + 1 END`,
        },
        setWhere: sql`${stale} OR ${paymentGatewayCallBudgets.used} < ${limit}`,
      })
      .returning({ used: paymentGatewayCallBudgets.used });
    return rows.length > 0;
  }
}

/**
 * The origin of the tenant's registered Telegram webhook — the one public origin this
 * installation has already proven it serves — for the gateway callback URL. No new
 * configuration, and no URL an operator types (brief §14).
 */
export class DrizzlePublicOriginReader implements PublicOriginReader {
  constructor(private readonly db: Database) {}

  async originFor(scope: TenantContext): Promise<string | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select({ url: botInstances.webhookUrl })
      .from(botInstances)
      .where(
        and(
          eq(botInstances.tenantId, tenantId),
          eq(botInstances.status, 'ACTIVE'),
          isNotNull(botInstances.webhookUrl),
        ),
      )
      .orderBy(asc(botInstances.createdAt), asc(botInstances.id))
      .limit(1);
    if (row?.url === undefined || row.url === null) return null;
    try {
      const parsed = new URL(row.url);
      return parsed.protocol === 'https:' ? parsed.origin : null;
    } catch {
      return null;
    }
  }
}
