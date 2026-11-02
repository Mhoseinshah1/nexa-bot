#!/usr/bin/env node
// R12 F2 item 8: a migration may not take a long blocking lock on a LARGE table.
//
// Drizzle runs every pending migration inside ONE transaction, and `botctl update`
// migrates while the outgoing release is still serving. So two statements that are
// harmless on a small table are an outage on a big one:
//
//   - `CREATE [UNIQUE] INDEX` without CONCURRENTLY takes a SHARE lock for the whole build,
//     blocking every insert, update and status change on the table. CONCURRENTLY is
//     refused inside a transaction, so such an index belongs in
//     apps/api/src/infrastructure/persistence/online-indexes.ts, which builds it outside
//     the migrator.
//   - `ADD CONSTRAINT … CHECK / FOREIGN KEY` without NOT VALID scans (and locks) every row
//     to validate it. Add it NOT VALID, then `VALIDATE CONSTRAINT` (a weaker lock) — or
//     validate outside the update window.
//
// A statement that really must do it anyway is ANNOTATED, on a comment line directly
// above it or inside it:   -- nexa:blocking-ddl-ok <the reason, naming the table size>
//
// Only migrations numbered ABOVE the baseline are checked: everything up to it has run on
// every installation already, and rewriting history is not the fix.
//
// Usage: node scripts/check-migration-ddl.mjs [--dir apps/api/drizzle] [--baseline 295]
//        [--tables scripts/large-tables.txt]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const dir = option('--dir', 'apps/api/drizzle');
const baseline = Number(option('--baseline', '295'));
const tablesFile = option('--tables', 'scripts/large-tables.txt');

const largeTables = new Set(
  readFileSync(tablesFile, 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter((line) => line !== ''),
);
if (largeTables.size === 0) {
  console.error(`${tablesFile} lists no tables: every check would pass vacuously.`);
  process.exit(2);
}

const ANNOTATION = /--\s*nexa:blocking-ddl-ok\s+\S/;

/** Statements with the comment lines directly above each, split on drizzle's breakpoints and `;`. */
function statements(sql) {
  const out = [];
  let pending = [];
  let leading = [];
  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (pending.length === 0 && (trimmed === '' || trimmed.startsWith('--'))) {
      if (trimmed.startsWith('--')) leading.push(trimmed);
      else leading = [];
      continue;
    }
    pending.push(line);
    if (
      /;\s*(--> statement-breakpoint)?\s*$/.test(trimmed) ||
      trimmed === '--> statement-breakpoint'
    ) {
      out.push({ text: pending.join('\n'), comments: leading.join('\n') });
      pending = [];
      leading = [];
    }
  }
  if (pending.length > 0) out.push({ text: pending.join('\n'), comments: leading.join('\n') });
  return out;
}

const ident = (raw) =>
  raw
    .replace(/"/g, '')
    .replace(/^public\./, '')
    .toLowerCase();

function violations(statement) {
  const text = statement.text
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const found = [];
  const index =
    /^CREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+(ONLY\s+)?("?[\w.]+"?)/i.exec(
      text,
    );
  if (index !== null && index[2] === undefined && largeTables.has(ident(index[5]))) {
    found.push(
      `CREATE INDEX on the large table ${ident(index[5])} without CONCURRENTLY — build it in online-indexes.ts`,
    );
  }
  const alter = /^ALTER\s+TABLE\s+(ONLY\s+)?(IF\s+EXISTS\s+)?("?[\w.]+"?)\s+(.*)$/i.exec(text);
  if (alter !== null && largeTables.has(ident(alter[3]))) {
    const rest = alter[4];
    const adds = /\bADD\s+(CONSTRAINT\s+\S+\s+)?(CHECK|FOREIGN\s+KEY)\b/i.test(rest);
    if (adds && !/\bNOT\s+VALID\b/i.test(rest)) {
      found.push(
        `ADD CONSTRAINT on the large table ${ident(alter[3])} without NOT VALID — add it NOT VALID, then VALIDATE`,
      );
    }
  }
  return found;
}

const problems = [];
for (const file of readdirSync(dir)
  .filter((name) => /^\d{4}_.*\.sql$/.test(name))
  .sort()) {
  if (Number(file.slice(0, 4)) <= baseline) continue;
  for (const statement of statements(readFileSync(join(dir, file), 'utf8'))) {
    if (ANNOTATION.test(statement.comments) || ANNOTATION.test(statement.text)) continue;
    for (const problem of violations(statement)) problems.push(`${file}: ${problem}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.log(problem);
  console.log(
    'Annotate a statement that must block anyway with `-- nexa:blocking-ddl-ok <reason>` directly above it.',
  );
  process.exit(1);
}
console.log(
  `ok: ${largeTables.size} large tables, migrations above ${String(baseline).padStart(4, '0')} checked`,
);
