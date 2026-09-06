#!/usr/bin/env node
/**
 * Every test the falsification record cites must exist in the committed tests.
 *
 * The falsification harness verifies a mutation against the WORKING TREE: the
 * suite fails, it fails for the named reason, the file restores byte-for-byte,
 * the suite goes green again. All four are true of a test that never reaches a
 * commit — which is what happened to row U09, whose mutation was genuinely
 * killed by a test that no commit contains. The record then carried a claim
 * that read exactly like a verified one, and the rule it named was free to be
 * reverted silently.
 *
 * So this check reads the citations out of the record and resolves each one
 * against the test sources. It is deliberately dumb: a substring search for the
 * test's name. That is enough, because the failure it exists to catch is a name
 * that resolves to nothing at all.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RECORD = 'docs/phase3d-falsification.md';

/** Every test source, concatenated — the haystack. */
function sources(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry) ? [readFileSync(path, 'utf8')] : [];
  });
}

/**
 * The cited name in a table row's last cell.
 *
 * Two spellings are in use: `` `file.tsx` › the test name `` and the older
 * _italic name_. Anything else in that column is prose about the result, and
 * naming no test is not a defect — claiming one that does not exist is.
 */
function citation(cell) {
  if (cell.includes('›')) return cell.split('›', 2)[1].trim().replace(/^`|`$/g, '');
  const italic = /^_([^_]+)_$/.exec(cell.trim());
  return italic === null ? null : italic[1].trim();
}

const rows = readFileSync(RECORD, 'utf8')
  .split('\n')
  .filter((line) => line.startsWith('|') && !/^\|[\s\-:|]+\|$/.test(line));

const haystack = sources('tests').join('\n');
const missing = [];
let checked = 0;

for (const row of rows) {
  const cells = row.replace(/^\||\|$/g, '').split('|');
  const name = citation(cells[cells.length - 1] ?? '');
  // A parenthetical, a result word, or a header is not a citation.
  if (name === null || name.length < 10 || name.startsWith('(')) continue;
  // `it.each` titles carry a printf placeholder; match the literal head of the
  // name, which is what distinguishes one test from another anyway.
  const needle = name.includes('%') ? name.slice(0, name.indexOf('%')) : name;
  checked += 1;
  if (!haystack.includes(needle)) missing.push(name);
}

if (missing.length > 0) {
  console.error(`\x1b[31mfail\x1b[0m  ${missing.length} of ${checked} cited tests do not exist:`);
  for (const name of missing) console.error(`        ${name}`);
  console.error('\n      Commit the probe or do not cite it.');
  process.exit(1);
}

console.log(`\x1b[32mok\x1b[0m    ${checked} falsification citations resolve to a committed test`);
