import { sql, type SQL } from 'drizzle-orm';
import type { TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CustomerPruneRepository,
  PruneCandidate,
  PruneListing,
} from '../application/customer-prune.service.js';

/**
 * One way a table can point at a customer: the child column(s) and the `customers` column
 * each is compared with. A composite foreign key `(tenant_id, customer_id) -> customers
 * (tenant_id, id)` is TWO pairs, joined with AND.
 */
export interface DependentReference {
  readonly table: string;
  readonly pairs: readonly {
    readonly child: string;
    readonly parent: string;
    readonly asText: boolean;
  }[];
  /** A fixed extra condition on the child row (a discriminator column), already safe SQL. */
  readonly where?: SQL;
}

/**
 * References that have neither a foreign key nor a column called `customer_id`, found by
 * reading the schema for every column that holds a customer's id. Everything else comes
 * from the catalogue at run time (`discoverDependents`), so a table added next month is
 * covered without anyone editing this list.
 *
 *   - `telegram_wizards.subject_id`: a conversation's subject; transient, but a row naming a
 *     deleted customer would dangle.
 *   - `legacy_import_map.entity_id` where `entity_type = 'CUSTOMER'`: the import's record of
 *     the customer it created or matched. An imported customer is never pruned.
 *
 * NOT listed, deliberately: `audit_logs.entity_id`, `outbox_messages.aggregate_id`,
 * `aggregate_sequences.aggregate_id` and the idempotency rows. They are history keyed by an
 * id, they are append-only or unread by anything that needs the customer, and
 * `docs/deployment.md` says why that is safe.
 */
const KNOWN_NON_FK_REFERENCES: readonly DependentReference[] = [
  {
    table: 'telegram_wizards',
    pairs: [{ child: 'subject_id', parent: 'id', asText: false }],
  },
  {
    table: 'legacy_import_map',
    pairs: [{ child: 'entity_id', parent: 'id', asText: false }],
    where: sql`r.entity_type = 'CUSTOMER'`,
  },
];

interface FkRow {
  readonly tbl: string;
  readonly child_cols: readonly string[];
  readonly parent_cols: readonly string[];
}
interface ColumnRow {
  readonly tbl: string;
  readonly col: string;
  readonly is_uuid: boolean;
}

/**
 * Every table that refers to a customer, from the DATABASE and not from a list in this file:
 *
 *   1. each foreign key whose referenced table is `customers` (all of its column pairs);
 *   2. each column in the public schema named `customer_id` or ending in `_customer_id`
 *      that no foreign key covers (a reference nobody declared is still a reference);
 *   3. the two fixed references above.
 *
 * A dependent of a dependent needs no recursion: the first row is already a dependent, and
 * the customer is kept for as long as it exists.
 */
export async function discoverDependents(exec: Executor): Promise<readonly DependentReference[]> {
  const fks = await exec.execute(sql`
    SELECT cl.relname::text AS tbl,
           array_agg(ca.attname::text ORDER BY k.ord) AS child_cols,
           array_agg(pa.attname::text ORDER BY k.ord) AS parent_cols
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
     CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(child, parent, ord)
      JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = k.child
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = k.parent
     WHERE c.contype = 'f' AND c.confrelid = 'public.customers'::regclass
     GROUP BY cl.relname, c.oid
     ORDER BY cl.relname, c.oid`);
  const found: DependentReference[] = [];
  const covered = new Set<string>();
  for (const row of fks.rows as unknown as FkRow[]) {
    found.push({
      table: row.tbl,
      pairs: row.child_cols.map((child, index) => ({
        child,
        parent: row.parent_cols[index] as string,
        asText: false,
      })),
    });
    for (const child of row.child_cols) covered.add(`${row.tbl}.${child}`);
  }

  const columns = await exec.execute(sql`
    SELECT cl.relname::text AS tbl, a.attname::text AS col, (a.atttypid = 'uuid'::regtype) AS is_uuid
      FROM pg_attribute a
      JOIN pg_class cl ON cl.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
     WHERE cl.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname ~ ${'(^|_)customer_id$'} AND cl.relname <> 'customers'
     ORDER BY cl.relname, a.attname`);
  for (const row of columns.rows as unknown as ColumnRow[]) {
    if (covered.has(`${row.tbl}.${row.col}`)) continue;
    found.push({
      table: row.tbl,
      pairs: [{ child: row.col, parent: 'id', asText: !row.is_uuid }],
    });
  }
  return [...found, ...KNOWN_NON_FK_REFERENCES];
}

/** `NOT EXISTS` for every dependent: the customer `c` has no row anywhere. */
export function noDependents(dependents: readonly DependentReference[]): SQL {
  const clauses = dependents.map((d) => {
    const joins = d.pairs.map((p) =>
      p.asText
        ? sql`r.${sql.identifier(p.child)}::text = c.${sql.identifier(p.parent)}::text`
        : sql`r.${sql.identifier(p.child)} = c.${sql.identifier(p.parent)}`,
    );
    const where = d.where === undefined ? sql`` : sql` AND ${d.where}`;
    return sql`NOT EXISTS (SELECT 1 FROM public.${sql.identifier(d.table)} r WHERE ${sql.join(joins, sql` AND `)}${where})`;
  });
  return clauses.length === 0 ? sql`TRUE` : sql.join(clauses, sql` AND `);
}

/**
 * What a customer must also be, beyond having no dependents, to be pruned: a customer the
 * bot itself registered (not an import), in good standing (a block is an operator's
 * decision, and deleting the customer would lift it), with no data an operator or the
 * customer entered (a phone, a personal discount).
 *
 * Nor a stored CHOICE that lives on the row itself: a promotional or reminder opt-out
 * (`/stop`), an operator's channel-membership or phone-verification exemption, or a phone
 * flow left to resume. Each is written with only audit, outbox and idempotency rows beside
 * it, so the dependent check does not see it; deleting the row would drop it, and the
 * person's next private message would re-register them without it — opted back into
 * broadcasts, or gated again by a check an operator had lifted for them.
 */
function pruneable(tenantId: string): SQL {
  return sql`c.tenant_id = ${tenantId} AND c.status = 'ACTIVE' AND c.source = 'NEXA'
    AND c.phone_number IS NULL AND c.personal_discount_percent = 0
    AND c.marketing_opt_out_at IS NULL AND c.reminders_opt_out_at IS NULL
    AND c.channel_membership_exempt_at IS NULL AND c.phone_verification_exempt_at IS NULL
    AND c.phone_resume IS NULL`;
}

interface CandidateRow {
  readonly id: string;
  readonly telegram_user_id: string;
  readonly display_name: string;
  readonly created_at: Date;
}

function toCandidate(row: CandidateRow): PruneCandidate {
  return {
    id: row.id,
    telegramUserId: row.telegram_user_id,
    displayName: row.display_name,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

const DISPLAY_NAME = sql`COALESCE(NULLIF(btrim(concat_ws(' ', c.first_name, c.last_name)), ''),
  CASE WHEN c.username IS NULL THEN NULL ELSE '@' || c.username END, '—')`;

export class DrizzleCustomerPruneRepository implements CustomerPruneRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async list(scope: TenantContext): Promise<PruneListing> {
    const tenantId = requireTenantId(scope);
    const dependents = await discoverDependents(this.db);
    const rows = await this.db.execute(sql`
      SELECT c.id, c.telegram_user_id, ${DISPLAY_NAME} AS display_name, c.created_at
        FROM customers c
       WHERE ${pruneable(tenantId)} AND ${noDependents(dependents)}
       ORDER BY c.created_at, c.id`);
    // Customers with no dependents that the extra conditions keep out: shown as a count, so
    // an operator who expected them can see why they are not on the list.
    const any = await this.db.execute(sql`
      SELECT count(*)::int AS n FROM customers c
       WHERE c.tenant_id = ${tenantId} AND ${noDependents(dependents)}`);
    const candidates = (rows.rows as unknown as CandidateRow[]).map(toCandidate);
    const withoutDependents = Number((any.rows[0] as { n: number } | undefined)?.n ?? 0);
    return {
      candidates,
      keptForStanding: Math.max(0, withoutDependents - candidates.length),
      dependentTables: new Set(dependents.map((d) => d.table)).size,
    };
  }

  async lockAndRecheck(scope: TenantContext, tx: unknown): Promise<readonly PruneCandidate[]> {
    const tenantId = requireTenantId(scope);
    const db = this.exec(tx);
    const dependents = await discoverDependents(db);
    // 1. Lock the rows that look empty. FOR UPDATE conflicts with the FOR KEY SHARE lock
    //    every foreign-key insert takes on its parent, so from here no new dependent that has
    //    a foreign key can be attached until this transaction ends. Ordered by id so two runs
    //    cannot deadlock.
    const locked = await db.execute(sql`
      SELECT c.id FROM customers c
       WHERE ${pruneable(tenantId)} AND ${noDependents(dependents)}
       ORDER BY c.id
         FOR UPDATE OF c`);
    const ids = (locked.rows as { id: string }[]).map((row) => row.id);
    if (ids.length === 0) return [];
    // 2. Check again, as a NEW statement. The first one's snapshot predates any lock wait: a
    //    dependent committed while it waited is invisible to its own subqueries, and only a
    //    fresh statement sees it. This is the check that decides what is deleted.
    const rows = await db.execute(sql`
      SELECT c.id, c.telegram_user_id, ${DISPLAY_NAME} AS display_name, c.created_at
        FROM customers c
       WHERE c.id = ANY(string_to_array(${ids.join(',')}, ',')::uuid[]) AND ${pruneable(tenantId)} AND ${noDependents(dependents)}
       ORDER BY c.created_at, c.id`);
    return (rows.rows as unknown as CandidateRow[]).map(toCandidate);
  }

  async deleteByIds(scope: TenantContext, ids: readonly string[], tx: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    if (ids.length === 0) return 0;
    const list = ids.join(',');
    const db = this.exec(tx);
    const result = await db.execute(sql`
      DELETE FROM customers WHERE tenant_id = ${tenantId} AND id = ANY(string_to_array(${list}, ',')::uuid[])
      RETURNING id`);
    // The update's idempotency row names the customer it created. Left behind, a redelivery
    // of that update finds no customer, resolves again and then collides with its own old key
    // (`rememberOnce`), so it goes with the customer. Only this tenant's Telegram namespace.
    await db.execute(sql`
      DELETE FROM request_idempotency
       WHERE scope_ref = ${`${tenantId}|TELEGRAM`}
         AND result ->> 'customerId' = ANY(string_to_array(${list}, ','))`);
    return result.rows.length;
  }
}
