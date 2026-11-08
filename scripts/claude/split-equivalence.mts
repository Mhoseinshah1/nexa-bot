/**
 * One-off proof for the large-file split (chore/split-large-files): the catalogue and
 * the schema after the move are the ones before it.
 *
 *   apps/api/node_modules/.bin/tsx scripts/claude/split-equivalence.mts [<base-ref>]
 *
 * <base-ref> (default `origin/main`) must still hold the single-file `web.fa.ts` and
 * `schema.ts`. Both are copied out of git into a scratch directory and imported beside the
 * working tree's versions:
 *
 *   - `WEB_FA`: the same keys, each with the same value (key ORDER is reported, not
 *     compared: the slices group keys by page);
 *   - the schema: every export of the old module exists in the new one with the same kind;
 *     drizzle-kit's own snapshot JSON of both (tables, columns, indexes, foreign keys,
 *     CHECKs, unique constraints, RLS policies) is identical, so is the SQL it would emit
 *     for each from an empty database; plain values (APPEND_ONLY_TABLES, `schema`) map to
 *     the same table names, and helper functions have the same source.
 *
 * Exit 0 and `identical=yes` on success.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = resolve(import.meta.dirname, '../..');
const base = process.argv[2] ?? 'origin/main';
const scratch = join(root, 'apps/api/.split-equivalence');
let failed = false;
const fail = (message: string): void => {
  console.error(`FAIL  ${message}`);
  failed = true;
};
const say = (line: string): boolean => process.stdout.write(`${line}\n`);
const sha = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const fromBase = (path: string, name: string): string => {
  const file = join(scratch, name);
  writeFileSync(
    file,
    execFileSync('git', ['show', `${base}:${path}`], { cwd: root, maxBuffer: 64 << 20 }),
  );
  return file;
};

try {
  // --- web.fa ----------------------------------------------------------------
  const oldWeb = (await import(
    pathToFileURL(fromBase('apps/web/src/i18n/web.fa.ts', 'web.fa.old.ts')).href
  )) as { WEB_FA: Record<string, string> };
  const newWeb = (await import(pathToFileURL(join(root, 'apps/web/src/i18n/web.fa.ts')).href)) as {
    WEB_FA: Record<string, string>;
  };
  const sorted = (o: Record<string, string>) =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const oldKeys = Object.keys(oldWeb.WEB_FA);
  const newKeys = Object.keys(newWeb.WEB_FA);
  const missing = oldKeys.filter((k) => !(k in newWeb.WEB_FA));
  const added = newKeys.filter((k) => !(k in oldWeb.WEB_FA));
  const changed = oldKeys.filter(
    (k) => k in newWeb.WEB_FA && oldWeb.WEB_FA[k] !== newWeb.WEB_FA[k],
  );
  if (missing.length) fail(`web: ${missing.length} keys missing, e.g. ${missing.slice(0, 5)}`);
  if (added.length) fail(`web: ${added.length} keys added, e.g. ${added.slice(0, 5)}`);
  if (changed.length) fail(`web: ${changed.length} values changed, e.g. ${changed.slice(0, 5)}`);
  say(
    `web     keys old=${oldKeys.length} new=${newKeys.length} missing=${missing.length} added=${added.length} changed=${changed.length}` +
      ` map-sha old=${sha(sorted(oldWeb.WEB_FA))} new=${sha(sorted(newWeb.WEB_FA))}` +
      ` order=${isDeepStrictEqual(oldKeys, newKeys) ? 'same' : 'grouped'}`,
  );

  // --- schema ----------------------------------------------------------------
  const persistence = 'apps/api/src/infrastructure/persistence';
  const oldSchema = (await import(
    pathToFileURL(fromBase(`${persistence}/schema.ts`, 'schema.old.ts')).href
  )) as Record<string, unknown>;
  const newSchema = (await import(
    pathToFileURL(join(root, `${persistence}/schema.ts`)).href
  )) as Record<string, unknown>;
  const require = createRequire(join(root, 'apps/api/package.json'));
  const kit = require('drizzle-kit/api') as {
    generateDrizzleJson: (imports: Record<string, unknown>) => Record<string, unknown>;
    generateMigration: (prev: unknown, cur: unknown) => Promise<string[]>;
  };
  const { is } = require('drizzle-orm') as { is: (v: unknown, c: unknown) => boolean };
  const { PgTable } = require('drizzle-orm/pg-core') as { PgTable: unknown };
  const tableName = (v: unknown): string | undefined =>
    is(v, PgTable) ? (v as Record<symbol, string>)[Symbol.for('drizzle:Name')] : undefined;

  const oldNames = Object.keys(oldSchema).sort();
  const newNames = Object.keys(newSchema).sort();
  const lost = oldNames.filter((n) => !(n in newSchema));
  const gained = newNames.filter((n) => !(n in oldSchema));
  if (lost.length) fail(`schema: exports lost: ${lost}`);
  if (gained.length) fail(`schema: exports gained: ${gained}`);

  let tables = 0;
  for (const name of oldNames) {
    if (!(name in newSchema)) continue;
    const a = oldSchema[name];
    const b = newSchema[name];
    if (tableName(a) !== undefined) {
      tables += 1;
      if (tableName(a) !== tableName(b))
        fail(`schema: ${name} names ${tableName(b)}, was ${tableName(a)}`);
    } else if (typeof a === 'function') {
      if (typeof b !== 'function' || a.toString() !== b.toString())
        fail(`schema: function ${name} differs`);
    } else {
      // Plain values: tables inside are compared by their SQL name.
      const norm = (v: unknown): unknown =>
        JSON.parse(
          JSON.stringify(
            v,
            (_k, x: unknown) => tableName(x) ?? (typeof x === 'bigint' ? `${x}n` : x),
          ),
        );
      if (!isDeepStrictEqual(norm(a), norm(b))) fail(`schema: value ${name} differs`);
    }
  }

  const strip = (j: Record<string, unknown>) => ({ ...j, id: '', prevId: '' });
  const oldJson = strip(kit.generateDrizzleJson(oldSchema));
  const newJson = strip(kit.generateDrizzleJson(newSchema));
  if (!isDeepStrictEqual(oldJson, newJson)) fail('schema: drizzle-kit snapshot JSON differs');
  const empty = strip(kit.generateDrizzleJson({}));
  const oldSql = (await kit.generateMigration(empty, oldJson)).join('\n');
  const newSql = (await kit.generateMigration(empty, newJson)).join('\n');
  if (oldSql !== newSql) fail('schema: generated SQL differs');
  const between = await kit.generateMigration(oldJson, newJson);
  if (between.length) fail(`schema: old → new would migrate: ${between.slice(0, 3)}`);
  say(
    `schema  exports old=${oldNames.length} new=${newNames.length} tables=${tables}` +
      ` snapshot-sha old=${sha(oldJson)} new=${sha(newJson)}` +
      ` sql-bytes old=${oldSql.length} new=${newSql.length} sql-sha old=${sha(oldSql)} new=${sha(newSql)}` +
      ` old→new statements=${between.length}`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

say(`identical=${failed ? 'no' : 'yes'}`);
process.exit(failed ? 1 : 0);
