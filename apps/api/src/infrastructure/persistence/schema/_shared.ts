/**
 * Database schema — shared column helpers and CHECK builders used by every module.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import {
  check,
  text,
  timestamp,
  uniqueIndex,
  customType,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import { RECORD_SOURCES } from '@nexa/contracts';

/**
 * Builds a CHECK constraint from a contract enum, so the database rejects any
 * value the contract does not define. The legacy system encodes one service
 * status four different ways — `active`, `فعال`, and two emoji-prefixed Persian
 * phrases — because nothing constrained the column.
 */
/**
 * What an enum literal may contain.
 *
 * Letters, digits, underscore, hyphen and DOT. The dot arrived with
 * `RECOVERY_FAILURE_CODES`, whose members are dotted (`recovery.cutover_failed`)
 * for the same reason error codes and operational event codes are — they are
 * namespaced, and flattening them to match a character class would make the
 * database's vocabulary differ from the contract's.
 *
 * Widening it is safe for the reason the original class was narrow: this is not
 * the escaping. The `'` doubling below is the escaping, and it still runs. This
 * pattern is the assertion that the input is a compile-time enum literal and
 * not something derived at runtime, and a dot does not weaken that — a quote, a
 * backslash, a space, a semicolon and a comment marker are all still refused,
 * which `tests/unit/schema-ddl-guards.test.ts` asserts one character at a time.
 */
export const ENUM_LITERAL = /^[A-Za-z0-9_.-]+$/;

/**
 * The one-time Mirza import's provenance (owner decision 2026-10-17,
 * `docs/migration/mirza-import-plan-fa.md` §2), on every NORMAL table it writes rows into.
 *
 * `source` is `NEXA` by default, so every existing writer is untouched and the migration is
 * expand-only; `MIRZA` marks a row the import wrote, and `source_ref` is that row's id in
 * Mirza. The pair is pinned by a CHECK (NEXA exactly when there is no ref) and the ref is
 * unique per tenant, which is what makes a rerun of the import find its row instead of
 * writing a second one.
 */
export function recordSourceColumns() {
  return {
    source: text('source').notNull().default('NEXA'),
    sourceRef: text('source_ref'),
  };
}

export function recordSourceChecks(
  name: string,
  table: { readonly tenantId: AnyPgColumn; readonly sourceRef: AnyPgColumn },
) {
  return [
    check(`${name}_source_check`, enumCheck('source', RECORD_SOURCES)),
    check(
      `${name}_source_ref_check`,
      sql`(source = 'NEXA') = (source_ref IS NULL) AND (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 128)`,
    ),
    uniqueIndex(`${name}_tenant_source_ref_key`)
      .on(table.tenantId, table.sourceRef)
      .where(sql`source_ref IS NOT NULL`),
  ];
}

/**
 * The short public code (Round 4, PR-C; `@nexa/contracts` `public-code.ts`): 8 characters of
 * Crockford base32 without 0/O/1/I/L, unique per tenant and table, beside the uuid key and
 * never instead of it. Nullable only for the expand step: `nexa_assign_public_code` (0263)
 * fills it on every INSERT from every writer, and the post-migration backfill
 * (`public-code-backfill.ts`) fills every row that existed before. Written once: the
 * database refuses changing a code that is set.
 */
export function publicCodeColumns() {
  return { code: text('code') };
}

/*
 * The per-tenant unique key, `<table>_tenant_code_key`, is built ONLINE (`online-indexes.ts`)
 * and so deliberately not declared here (Codex review of #299).
 */
export function publicCodeChecks(name: string) {
  return [check(`${name}_code_check`, sql`code IS NULL OR code ~ '^[2-9A-HJKMNP-TV-Z]{8}$'`)];
}

export function enumCheck(column: string, values: readonly string[]): SQL {
  // This is the only sql.raw in the codebase. Every argument today is a
  // compile-time literal from a contract enum, which is what makes it safe — so
  // assert that rather than trust it, and escape anyway. A runtime-derived list
  // would otherwise turn a DDL helper into an injection point.
  if (!/^[a-z_][a-z0-9_]*$/.test(column)) {
    throw new Error(`enumCheck: "${column}" is not a plain column name.`);
  }
  const list = values
    .map((value) => {
      if (!ENUM_LITERAL.test(value)) {
        throw new Error(`enumCheck: "${value}" is not a plain enum literal.`);
      }
      return `'${value.replace(/'/g, "''")}'`;
    })
    .join(', ');
  return sql.raw(`${column} IN (${list})`);
}

/**
 * A text-array column holding a non-empty subset of an enum (WP8: `applies_to`).
 *
 * The array counterpart of `enumCheck`, with the same assertions and the same escaping:
 * every member is a compile-time enum literal, and the column name is a plain one. Empty
 * is refused because "applies to nothing" is a rule that silently never fires.
 */
export function enumSubsetCheck(column: string, values: readonly string[]): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(column)) {
    throw new Error(`enumSubsetCheck: "${column}" is not a plain column name.`);
  }
  const list = values
    .map((value) => {
      if (!ENUM_LITERAL.test(value)) {
        throw new Error(`enumSubsetCheck: "${value}" is not a plain enum literal.`);
      }
      return `'${value.replace(/'/g, "''")}'`;
    })
    .join(', ');
  return sql.raw(`cardinality(${column}) > 0 AND ${column} <@ ARRAY[${list}]::text[]`);
}

/**
 * The same constraint for a column that is allowed to be NULL.
 *
 * `column IN (...)` is NULL — not false — when the column is NULL, and a CHECK
 * passes on NULL. Relying on that is correct SQL and completely invisible to a
 * reader, so it is stated: this column holds one of these values, or nothing.
 */
export function nullableEnumCheck(column: string, values: readonly string[]): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(column)) {
    throw new Error(`nullableEnumCheck: "${column}" is not a plain column name.`);
  }
  const list = values
    .map((value) => {
      if (!ENUM_LITERAL.test(value)) {
        throw new Error(`nullableEnumCheck: "${value}" is not a plain enum literal.`);
      }
      return `'${value.replace(/'/g, "''")}'`;
    })
    .join(', ');
  return sql.raw(`${column} IS NULL OR ${column} IN (${list})`);
}

/**
 * A text-array column holding any subset of an enum, the empty set included (WP-A4:
 * `ops_log_groups.problems`, where no problem is the normal case). `enumSubsetCheck`'s
 * assertions and escaping, without its non-empty rule.
 */
export function enumArrayCheck(column: string, values: readonly string[]): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(column)) {
    throw new Error(`enumArrayCheck: "${column}" is not a plain column name.`);
  }
  const list = values
    .map((value) => {
      if (!ENUM_LITERAL.test(value)) {
        throw new Error(`enumArrayCheck: "${value}" is not a plain enum literal.`);
      }
      return `'${value.replace(/'/g, "''")}'`;
    })
    .join(', ');
  return sql.raw(`${column} <@ ARRAY[${list}]::text[]`);
}

/**
 * Phase 0 schema — the foundation tables, and nothing else.
 *
 * Conventions, all enforced here rather than by memory:
 *   - `id` is UUIDv7, generated in the application so the value exists before
 *     the INSERT and can be written into an outbox row in the same statement.
 *   - every timestamp is `timestamptz`, stored UTC.
 *   - every status is a CHECK-constrained text column, never free text.
 *   - tenant-owned rows carry `tenant_id NOT NULL`; rows that genuinely belong
 *     to no tenant carry NULL and say so.
 *   - append-only tables are protected by a trigger, not by convention
 *     (see migrations/0001_foundation.sql).
 *
 * There is deliberately no `balance` column, no money column and no product
 * table here. Phase 0 has no business features.
 */

export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// --- Customer UX completion (docs/customer-ux-completion-audit.md) -------------

/**
 * PostgreSQL `bytea`, which drizzle's pg-core does not model. Two consumers, both below:
 * the tenant media slot and support's staged reply files (HF-A7) — one definition, never a
 * second.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});
