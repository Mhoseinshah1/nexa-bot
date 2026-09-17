import { and, asc, eq, sql } from 'drizzle-orm';
import type {
  PaymentAccountId,
  PaymentDestinationSnapshot,
  PaymentId,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  paymentAccounts,
  paymentDestinations,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  PaymentAccountFields,
  PaymentAccountRecord,
  PaymentAccountRepository,
  PaymentDestinationRepository,
} from '../application/account-ports.js';

/** The columns the record is built from. Selected explicitly, in one place. */
const COLUMNS = {
  id: paymentAccounts.id,
  label: paymentAccounts.label,
  bankName: paymentAccounts.bankName,
  holderName: paymentAccounts.holderName,
  cardNumber: paymentAccounts.cardNumber,
  iban: paymentAccounts.iban,
  enabled: paymentAccounts.enabled,
  isDefault: paymentAccounts.isDefault,
  sortOrder: paymentAccounts.sortOrder,
  createdAt: paymentAccounts.createdAt,
  updatedAt: paymentAccounts.updatedAt,
} as const;

/** What a `select(COLUMNS)` yields. Written out, because the column type does not carry nullability. */
interface Row {
  readonly id: string;
  readonly label: string;
  readonly bankName: string;
  readonly holderName: string;
  readonly cardNumber: string;
  readonly iban: string | null;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toRecord(row: Row): PaymentAccountRecord {
  return {
    id: row.id as PaymentAccountId,
    label: row.label,
    bankName: row.bankName,
    holderName: row.holderName,
    cardNumber: row.cardNumber,
    iban: row.iban,
    enabled: row.enabled,
    isDefault: row.isDefault,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Manual-transfer accounts, in PostgreSQL.
 *
 * Every query carries `eq(paymentAccounts.tenantId, …)`, the primary-key lookups
 * included, for the reason the product repository states: a primary-key lookup without
 * the tenant returns another tenant's row and leaves the caller holding something it
 * should never have seen. Here that something is a card number.
 */
export class DrizzlePaymentAccountRepository implements PaymentAccountRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  /** `(sort_order, created_at, id)`, the one ordering, matching the index. */
  async list(scope: TenantContext, tx?: unknown): Promise<readonly PaymentAccountRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select(COLUMNS)
      .from(paymentAccounts)
      .where(eq(paymentAccounts.tenantId, tenantId))
      .orderBy(
        asc(paymentAccounts.sortOrder),
        asc(paymentAccounts.createdAt),
        asc(paymentAccounts.id),
      );
    return rows.map(toRecord);
  }

  async findById(
    scope: TenantContext,
    id: PaymentAccountId,
    tx?: unknown,
  ): Promise<PaymentAccountRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select(COLUMNS)
      .from(paymentAccounts)
      .where(and(eq(paymentAccounts.tenantId, tenantId), eq(paymentAccounts.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async count(scope: TenantContext, tx: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ n: sql<number>`count(*)::int` })
      .from(paymentAccounts)
      .where(eq(paymentAccounts.tenantId, tenantId));
    return rows[0]?.n ?? 0;
  }

  async create(
    scope: TenantContext,
    input: {
      readonly id: PaymentAccountId;
      readonly fields: PaymentAccountFields;
      readonly enabled: boolean;
      readonly isDefault: boolean;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<PaymentAccountRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(paymentAccounts)
      .values({
        id: input.id,
        tenantId,
        ...input.fields,
        enabled: input.enabled,
        isDefault: input.isDefault,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning(COLUMNS);
    const row = rows[0];
    if (row === undefined) throw new Error('payment_accounts insert returned no row.');
    return toRecord(row);
  }

  async update(
    scope: TenantContext,
    id: PaymentAccountId,
    fields: PaymentAccountFields,
    now: Date,
    tx: unknown,
  ): Promise<PaymentAccountRecord | null> {
    const tenantId = requireTenantId(scope);
    /*
     * `enabled` and `is_default` are absent from this SET, and that absence is the rule.
     * An edit changes what the account IS; where money goes is a separate command with
     * its own audit row, so "who moved the destination" is answerable.
     */
    const rows = await this.exec(tx)
      .update(paymentAccounts)
      .set({ ...fields, updatedAt: now })
      .where(and(eq(paymentAccounts.tenantId, tenantId), eq(paymentAccounts.id, id)))
      .returning(COLUMNS);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async setEnabled(
    scope: TenantContext,
    id: PaymentAccountId,
    enabled: boolean,
    now: Date,
    tx: unknown,
  ): Promise<PaymentAccountRecord | null> {
    const tenantId = requireTenantId(scope);
    /*
     * CONDITIONAL on the state it moves FROM, so two concurrent disables produce one
     * transition. The caller reads null as "nothing to do" and writes no audit row —
     * which is the difference between a replay and a second decision.
     */
    const rows = await this.exec(tx)
      .update(paymentAccounts)
      .set({ enabled, updatedAt: now })
      .where(
        and(
          eq(paymentAccounts.tenantId, tenantId),
          eq(paymentAccounts.id, id),
          eq(paymentAccounts.enabled, !enabled),
        ),
      )
      .returning(COLUMNS);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async clearDefault(
    scope: TenantContext,
    now: Date,
    tx: unknown,
  ): Promise<PaymentAccountId | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(paymentAccounts)
      .set({ isDefault: false, updatedAt: now })
      .where(and(eq(paymentAccounts.tenantId, tenantId), eq(paymentAccounts.isDefault, true)))
      .returning({ id: paymentAccounts.id });
    return (rows[0]?.id as PaymentAccountId | undefined) ?? null;
  }

  async setDefault(
    scope: TenantContext,
    id: PaymentAccountId,
    now: Date,
    tx: unknown,
  ): Promise<PaymentAccountRecord | null> {
    const tenantId = requireTenantId(scope);
    /*
     * Conditional on `enabled`, which is belt AND braces with
     * `payment_accounts_default_enabled_check`: the constraint makes the bad row
     * impossible, and this makes the refusal a null the service can name rather than a
     * 23514 the operator would read as a crash.
     */
    const rows = await this.exec(tx)
      .update(paymentAccounts)
      .set({ isDefault: true, updatedAt: now })
      .where(
        and(
          eq(paymentAccounts.tenantId, tenantId),
          eq(paymentAccounts.id, id),
          eq(paymentAccounts.enabled, true),
        ),
      )
      .returning(COLUMNS);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async selectDestination(scope: TenantContext, tx: unknown): Promise<PaymentAccountRecord | null> {
    const tenantId = requireTenantId(scope);
    /*
     * The default first, then the lowest-ordered enabled account. ONE query and ONE
     * ordering, so "which account is a new payment issued against" has a single answer
     * that a test can pin. `is_default DESC` puts true first; everything after it is the
     * list order the operator sees.
     */
    const rows = await this.exec(tx)
      .select(COLUMNS)
      .from(paymentAccounts)
      .where(and(eq(paymentAccounts.tenantId, tenantId), eq(paymentAccounts.enabled, true)))
      .orderBy(
        sql`${paymentAccounts.isDefault} DESC`,
        asc(paymentAccounts.sortOrder),
        asc(paymentAccounts.createdAt),
        asc(paymentAccounts.id),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async hasEnabled(scope: TenantContext, tx?: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ one: sql<number>`1` })
      .from(paymentAccounts)
      .where(and(eq(paymentAccounts.tenantId, tenantId), eq(paymentAccounts.enabled, true)))
      .limit(1);
    return rows.length > 0;
  }
}

/**
 * The frozen destination, in PostgreSQL.
 *
 * Insert and select, and nothing else. The table refuses UPDATE and DELETE by trigger
 * (migration 0063), so there is no method here to add later without first removing a
 * guard that says in the database what this class says in TypeScript.
 */
export class DrizzlePaymentDestinationRepository implements PaymentDestinationRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async capture(
    scope: TenantContext,
    input: {
      readonly paymentId: PaymentId;
      readonly account: PaymentAccountRecord;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<PaymentDestinationSnapshot> {
    const tenantId = requireTenantId(scope);
    const { account } = input;
    const rows = await this.exec(tx)
      .insert(paymentDestinations)
      .values({
        paymentId: input.paymentId,
        tenantId,
        accountId: account.id,
        label: account.label,
        bankName: account.bankName,
        holderName: account.holderName,
        cardNumber: account.cardNumber,
        iban: account.iban,
        createdAt: input.now,
      })
      .returning({
        label: paymentDestinations.label,
        bankName: paymentDestinations.bankName,
        holderName: paymentDestinations.holderName,
        cardNumber: paymentDestinations.cardNumber,
        iban: paymentDestinations.iban,
      });
    const row = rows[0];
    if (row === undefined) throw new Error('payment_destinations insert returned no row.');
    return row;
  }

  async findByPayment(
    scope: TenantContext,
    paymentId: PaymentId,
    tx?: unknown,
  ): Promise<PaymentDestinationSnapshot | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({
        label: paymentDestinations.label,
        bankName: paymentDestinations.bankName,
        holderName: paymentDestinations.holderName,
        cardNumber: paymentDestinations.cardNumber,
        iban: paymentDestinations.iban,
      })
      .from(paymentDestinations)
      .where(
        and(
          eq(paymentDestinations.tenantId, tenantId),
          eq(paymentDestinations.paymentId, paymentId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}
