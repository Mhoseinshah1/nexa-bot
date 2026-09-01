import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  errors,
  PLATFORM_ERROR_CODES,
  type IdGenerator,
  type IdempotencyRecord,
  type IdempotencyStore,
  type ScopeContext,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { requestIdempotency } from '../../../../infrastructure/persistence/schema.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { scopeRef, scopeTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * Durable idempotency.
 *
 * Telegram retries webhooks, BullMQ redelivers jobs, and payment gateways
 * double-post callbacks. Every command that changes state carries a key; a
 * replay returns the first result instead of doing the work twice.
 *
 * A key reused with a DIFFERENT payload is rejected rather than treated as a
 * replay. That combination is always a caller bug, and silently returning the
 * old result would hide it — the legacy system has no idempotency, no payment
 * record and no dedupe anywhere, which is why a duplicate callback there is
 * indistinguishable from a second purchase.
 */
export function hashRequest(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export class DrizzleIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly db: Database,
    private readonly ids: IdGenerator,
  ) {}

  async find<TResult>(
    scope: ScopeContext,
    key: string,
    requestHash: string,
  ): Promise<IdempotencyRecord<TResult> | null> {
    const [row] = await this.db
      .select()
      .from(requestIdempotency)
      .where(and(eq(requestIdempotency.scopeRef, scopeRef(scope)), eq(requestIdempotency.key, key)))
      .limit(1);

    if (!row) return null;

    if (row.requestHash !== requestHash) {
      throw errors.conflict(
        PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
        `Idempotency key "${key}" was already used with a different request payload. ` +
          'Reusing a key for different input is a bug, not a retry.',
        { key },
      );
    }

    return {
      key: row.key,
      requestHash: row.requestHash,
      result: row.result as TResult,
      createdAt: row.createdAt,
    };
  }

  async remember<TResult>(
    scope: ScopeContext,
    key: string,
    requestHash: string,
    result: TResult,
    tx?: unknown,
  ): Promise<void> {
    const executor = (tx as TransactionScope | undefined)?.tx ?? this.db;

    await executor
      .insert(requestIdempotency)
      .values({
        id: this.ids.uuid(),
        scopeRef: scopeRef(scope),
        tenantId: scopeTenantId(scope),
        key,
        requestHash,
        result: result as Record<string, unknown>,
      })
      .onConflictDoNothing();
  }
}
