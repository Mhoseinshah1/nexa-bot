import { sql } from 'drizzle-orm';
import type { Database } from '../../apps/api/src/infrastructure/persistence/database';

/**
 * Every base table of the `public` schema: its row count and an md5 over its rows' text,
 * in row-text order (so the digest depends on content, never on physical order).
 *
 * For "this wrote nothing at all" assertions: a read-only claim checked against a handful
 * of tables is a claim about those tables only, and a write to any other one — a probe
 * budget, an operational event, a cache — would pass it. This covers the whole schema.
 * Meant for test databases; it reads every row.
 */
export async function databaseFingerprint(
  db: Database,
): Promise<Readonly<Record<string, { readonly rows: number; readonly md5: string }>>> {
  const tables = await db.execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`);
  const out: Record<string, { rows: number; md5: string }> = {};
  for (const { table_name: name } of tables.rows) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(name)) throw new Error(`unexpected table name ${name}`);
    const result = await db.execute<{ rows: number; md5: string | null }>(
      sql.raw(
        `SELECT count(*)::int AS rows, md5(string_agg(t::text, E'\\n' ORDER BY t::text)) AS md5 FROM "${name}" t`,
      ),
    );
    const row = result.rows[0];
    out[name] = { rows: row?.rows ?? 0, md5: row?.md5 ?? '' };
  }
  return out;
}

/** The tables whose fingerprint differs between two readings, with both readings. */
export function changedTables(
  before: Awaited<ReturnType<typeof databaseFingerprint>>,
  after: Awaited<ReturnType<typeof databaseFingerprint>>,
): Record<string, { before: unknown; after: unknown }> {
  const changed: Record<string, { before: unknown; after: unknown }> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[name];
    const b = after[name];
    if (a?.rows !== b?.rows || a?.md5 !== b?.md5) changed[name] = { before: a, after: b };
  }
  return changed;
}
