#!/usr/bin/env node
/**
 * Every test the falsification record cites must exist in the committed tests.
 *
 * The falsification harness verifies a mutation against the WORKING TREE: the
 * suite fails, it fails for the named reason, the file restores byte-for-byte,
 * the suite goes green again. All four are true of a test that never reaches a
 * commit — which is what happened to row U09, whose mutation was genuinely
 * killed by a test that no commit contains. The record then carried a claim
 * that read exactly like a verified one.
 *
 * The FIRST version of this check had the same disease it was written to cure.
 * It recognised two spellings of a citation and silently skipped anything else
 * — including `_a test name_ (a parenthetical)`, which is how the two newest
 * rows were written. It reported "52 citations, all resolving" while never
 * looking at the evidence for the newest rule on the branch. A checker that
 * decides for itself what to ignore is a checker that can be green and wrong.
 *
 * So it no longer guesses. It finds the tables that HAVE a citation column, by
 * their header, and requires every data row in one to yield a name. A row it
 * cannot parse is a failure, not a skip.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RECORD = 'docs/phase3d-falsification.md';
/**
 * A table whose last column is one of these is making citations.
 *
 * The plural is here because it was NOT, and a table headed `tests that die`
 * was therefore not a citation table as far as this check was concerned: all
 * eleven of its rows were skipped in silence and the run reported the same
 * count as before they existed. That is the third instance on this branch of
 * the exact disease named in the comment above — a checker deciding for itself
 * what to ignore — and the second time it was this checker.
 */
const CITATION_HEADERS = ['named test', 'test that dies', 'tests that die'];

/** Every test source, by path, so a citation can be checked where it points. */
function sources(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry) ? [[path, readFileSync(path, 'utf8')]] : [];
  });
}

const cells = (row) =>
  row
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
const isSeparator = (row) => /^\|[\s\-:|]+\|$/.test(row);

/**
 * The citation in a row's last cell, as `{ file, name }`.
 *
 * Three spellings are in use, and the third is why this is not a regex:
 * `` `file.tsx` › the name ``, `_the name_`, and `_the name_ (an aside)` —
 * the aside being commentary on HOW the test dies. The name is the first
 * italic run either way, and `(same test)` and `(same)` genuinely cite the
 * row above rather than nothing.
 */
function citation(cell) {
  if (/^\(same/i.test(cell)) return 'INHERIT';
  if (cell.includes('›')) {
    const [file, ...rest] = cell.split('›');
    const name = rest.join('›').trim().replace(/^`|`$/g, '');
    return { file: file.trim().replace(/`/g, ''), name };
  }
  const italic = /_([^_]+)_/.exec(cell);
  return italic === null ? null : { file: null, name: italic[1].trim() };
}

/**
 * Every citation in a row's last cell.
 *
 * One mutation may kill several tests, and saying so is stronger evidence than
 * naming one of them — but only if every name is checked. They are written
 * `` `file.tsx` › first; › second ``, a continuation inheriting the file of the
 * citation before it, and an unresolvable continuation is a failure like any
 * other row.
 */
function citationsIn(cell) {
  const parts = cell
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length <= 1) {
    const one = citation(cell);
    return one === null ? null : [one];
  }
  const found = [];
  let file = null;
  for (const part of parts) {
    const cited = citation(part);
    if (cited === null || cited === 'INHERIT') return null;
    // An EMPTY file, not just a null one, is a continuation. `› name` splits to
    // `['', ' name']`, and `''` passed straight through would make the haystack
    // `endsWith('')` — every test file in the tree — so a continuation naming a
    // test that lives somewhere else entirely would have resolved. That is the
    // "resolves in some other file is not evidence" rule this check states
    // twenty lines below and had just stopped enforcing for continuations.
    const named = cited.file === null || cited.file === '' ? null : cited.file;
    file = named ?? file;
    if (file === null) return null;
    found.push({ file, name: cited.name });
  }
  return found;
}

const lines = readFileSync(RECORD, 'utf8').split('\n');
const files = sources('tests');
const everything = files.map(([, text]) => text).join('\n');

const missing = [];
const unparsed = [];
/**
 * Headers that LOOK like citations and are not recognised.
 *
 * Adding the plural fixed one table; it did not fix the reason that table was
 * skipped, which is that an unrecognised header is indistinguishable from a
 * table that makes no claims. So a header whose last column mentions a test and
 * is not on the list is an error now, and a future round inventing a fourth
 * spelling gets a red run instead of a green one that checked nothing.
 */
const unrecognised = [];
let checked = 0;
let inCitationTable = false;
let previous = null;

/** The previous table row, so a separator can identify the header above it. */
let header = null;

for (const line of lines) {
  if (!line.startsWith('|')) {
    inCitationTable = false;
    header = null;
    continue;
  }
  // A table declares its columns in the row ABOVE the separator, and nowhere
  // else. Deciding at the separator rather than on any row whose last cell
  // happens to read like a header is what keeps `a real test in dashboard.tsx`
  // — an ordinary sentence in an ordinary data row — from being mistaken for a
  // misspelled declaration.
  if (isSeparator(line)) {
    const declared = header === null ? '' : (cells(header).at(-1) ?? '').toLowerCase();
    inCitationTable = CITATION_HEADERS.includes(declared);
    previous = null;
    if (!inCitationTable && /\btests?\b/.test(declared)) unrecognised.push(header);
    header = null;
    continue;
  }
  const columns = cells(line);
  if (!inCitationTable) {
    header = line;
    continue;
  }

  const cell = columns[columns.length - 1] ?? '';
  if (/^\(same/i.test(cell.trim())) {
    if (previous === null) unparsed.push(line);
    continue;
  }
  const cites = citationsIn(cell);
  if (cites === null) {
    // NOT skipped. A row in a citation table that names no test is the defect.
    unparsed.push(line);
    continue;
  }
  previous = cites[cites.length - 1];

  for (const cited of cites) {
    checked += 1;
    // `it.each` titles carry a printf placeholder; the literal head of the name
    // is what distinguishes one test from another anyway.
    const needle = cited.name.includes('%')
      ? cited.name.slice(0, cited.name.indexOf('%'))
      : cited.name;
    // Checked in the file the citation NAMES, when it names one. A name that
    // resolves in some other file is not evidence for the row that cites it.
    const haystack =
      cited.file === null
        ? everything
        : files
            .filter(([path]) => path.endsWith(cited.file))
            .map(([, text]) => text)
            .join('\n');
    if (haystack === '') missing.push(`${cited.name}  (no such file: ${cited.file})`);
    else if (!haystack.includes(needle))
      missing.push(`${cited.name}  (${cited.file ?? 'any file'})`);
  }
}

if (missing.length > 0 || unparsed.length > 0 || unrecognised.length > 0) {
  if (unrecognised.length > 0) {
    console.error(
      `\x1b[31mfail\x1b[0m  ${unrecognised.length} table header(s) name a test column this check does not recognise:`,
    );
    for (const row of unrecognised) console.error(`        ${row.trim().slice(0, 110)}`);
    console.error(`        recognised: ${CITATION_HEADERS.join(', ')}`);
  }
  if (missing.length > 0) {
    console.error(`\x1b[31mfail\x1b[0m  ${missing.length} of ${checked} cited tests do not exist:`);
    for (const name of missing) console.error(`        ${name}`);
  }
  if (unparsed.length > 0) {
    console.error(
      `\x1b[31mfail\x1b[0m  ${unparsed.length} row(s) in a citation table name no test:`,
    );
    for (const row of unparsed) console.error(`        ${row.trim().slice(0, 110)}`);
  }
  console.error('\n      Commit the probe or do not cite it.');
  process.exit(1);
}

console.log(`\x1b[32mok\x1b[0m    ${checked} falsification citations resolve to a committed test`);
