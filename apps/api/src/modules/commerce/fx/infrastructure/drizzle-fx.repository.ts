import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { FxBaseAsset, FxSource, SalesCurrencyCode, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId, type TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { fxQuotes, fxSourceStates } from '../../../../infrastructure/persistence/schema.js';
import type {
  FxPair,
  FxQuoteRepository,
  FxQuoteRow,
  FxSourceStateRow,
  FxStoredQuote,
} from '../application/ports.js';

/**
 * The central rate's rows (package FX). Every statement names the tenant, and every
 * decision — the lease, the "only if newer" store — is a conditional write, never a
 * read followed by a write in a process: two worker replicas is the normal case on every
 * rolling update, and both may ask at once.
 */
export class DrizzleFxQuoteRepository implements FxQuoteRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async find(scope: TenantContext, pair: FxPair, tx?: unknown): Promise<FxQuoteRow | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(fxQuotes)
      .where(
        and(
          eq(fxQuotes.tenantId, tenantId),
          eq(fxQuotes.baseAsset, pair.baseAsset),
          eq(fxQuotes.quoteCurrency, pair.quoteCurrency),
        ),
      )
      .limit(1);
    if (row === undefined) return null;
    return {
      baseAsset: row.baseAsset as FxBaseAsset,
      quoteCurrency: row.quoteCurrency as SalesCurrencyCode,
      quote:
        row.quoteId === null ||
        row.rateMantissa === null ||
        row.rateScale === null ||
        row.source === null ||
        row.fetchedAt === null ||
        row.policyVersion === null
          ? null
          : {
              rate: { mantissa: row.rateMantissa, scale: row.rateScale },
              source: row.source as FxSource,
              sourceAt: row.sourceAt,
              fetchedAt: row.fetchedAt,
              quoteId: row.quoteId,
              policyVersion: row.policyVersion,
            },
      refreshClaimedUntil: row.refreshClaimedUntil,
      lastAttemptAt: row.lastAttemptAt,
      lastErrorCode: row.lastErrorCode,
    };
  }

  async claimRefresh(
    scope: TenantContext,
    pair: FxPair,
    input: { readonly now: Date; readonly leaseUntil: Date; readonly dueBefore: Date | null },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const free = or(isNull(fxQuotes.refreshClaimedUntil), lte(fxQuotes.refreshClaimedUntil, input.now));
    const due =
      input.dueBefore === null
        ? sql`true`
        : or(isNull(fxQuotes.fetchedAt), lte(fxQuotes.fetchedAt, input.dueBefore));
    // One statement: insert the row if it is missing, or claim it if it is free and due.
    const rows = await this.exec(tx)
      .insert(fxQuotes)
      .values({
        tenantId,
        baseAsset: pair.baseAsset,
        quoteCurrency: pair.quoteCurrency,
        refreshClaimedUntil: input.leaseUntil,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [fxQuotes.tenantId, fxQuotes.baseAsset, fxQuotes.quoteCurrency],
        set: { refreshClaimedUntil: input.leaseUntil, updatedAt: input.now },
        // `and` is typed as possibly undefined for an empty argument list; both are given.
        setWhere: and(free, due) ?? sql`false`,
      })
      .returning({ tenantId: fxQuotes.tenantId });
    return rows.length > 0;
  }

  async storeQuote(
    scope: TenantContext,
    pair: FxPair,
    quote: FxStoredQuote,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(fxQuotes)
      .set({
        rateMantissa: quote.rate.mantissa,
        rateScale: quote.rate.scale,
        source: quote.source,
        sourceAt: quote.sourceAt,
        fetchedAt: quote.fetchedAt,
        quoteId: quote.quoteId,
        policyVersion: quote.policyVersion,
        refreshClaimedUntil: null,
        lastAttemptAt: now,
        lastErrorCode: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(fxQuotes.tenantId, tenantId),
          eq(fxQuotes.baseAsset, pair.baseAsset),
          eq(fxQuotes.quoteCurrency, pair.quoteCurrency),
          // Never backwards: a quote fetched earlier than the stored one is not newer news.
          or(isNull(fxQuotes.fetchedAt), sql`${fxQuotes.fetchedAt} < ${quote.fetchedAt}`),
        ),
      )
      .returning({ tenantId: fxQuotes.tenantId });
    return rows.length > 0;
  }

  async releaseRefresh(
    scope: TenantContext,
    pair: FxPair,
    input: { readonly now: Date; readonly errorCode: string | null },
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx)
      .update(fxQuotes)
      .set({
        refreshClaimedUntil: null,
        lastAttemptAt: input.now,
        lastErrorCode: input.errorCode,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(fxQuotes.tenantId, tenantId),
          eq(fxQuotes.baseAsset, pair.baseAsset),
          eq(fxQuotes.quoteCurrency, pair.quoteCurrency),
        ),
      );
  }

  async sourceStates(scope: TenantContext, tx?: unknown): Promise<FxSourceStateRow[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(fxSourceStates)
      .where(eq(fxSourceStates.tenantId, tenantId));
    return rows.map((row) => ({
      source: row.source as FxSource,
      lastSuccessAt: row.lastSuccessAt,
      lastFailureAt: row.lastFailureAt,
      lastFailureCode: row.lastFailureCode,
      retryAfter: row.retryAfter,
      consecutiveFailures: row.consecutiveFailures,
    }));
  }

  async recordSourceSuccess(
    scope: TenantContext,
    source: FxSource,
    now: Date,
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx)
      .insert(fxSourceStates)
      .values({ tenantId, source, lastSuccessAt: now, consecutiveFailures: 0, updatedAt: now })
      .onConflictDoUpdate({
        target: [fxSourceStates.tenantId, fxSourceStates.source],
        set: { lastSuccessAt: now, retryAfter: null, consecutiveFailures: 0, updatedAt: now },
      });
  }

  async recordSourceFailure(
    scope: TenantContext,
    source: FxSource,
    input: { readonly now: Date; readonly code: string; readonly retryAfter: Date | null },
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    const code = input.code.slice(0, 64);
    await this.exec(tx)
      .insert(fxSourceStates)
      .values({
        tenantId,
        source,
        lastFailureAt: input.now,
        lastFailureCode: code,
        retryAfter: input.retryAfter,
        consecutiveFailures: 1,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [fxSourceStates.tenantId, fxSourceStates.source],
        set: {
          lastFailureAt: input.now,
          lastFailureCode: code,
          retryAfter: input.retryAfter,
          consecutiveFailures: sql`${fxSourceStates.consecutiveFailures} + 1`,
          updatedAt: input.now,
        },
      });
  }
}
