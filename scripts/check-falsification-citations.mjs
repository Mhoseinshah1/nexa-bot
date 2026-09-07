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
 * The fewest citations this record may contain.
 *
 * Every one of the four rounds in which this script silently skipped part of
 * the record — a plural header, a citation column that was not last, escaped
 * pipes, a blank line mid-table — was a DROP in the number checked, and every
 * one of them exited 0 because nothing compared that number to anything. Each
 * fix closed one channel and the next round found another; fence-skipping,
 * added in the round before this one, is a fifth channel by construction.
 *
 * A floor closes the class rather than the instance: whatever new way is found
 * to stop reading part of this file, the count falls and the run goes red. Raise
 * it when rows are added; the failure tells you to.
 */
const FLOOR = 160;
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
/**
 * Tables that deliberately hold something OTHER than test citations.
 *
 * Declaring them is the price of the rule below: EVERY table in the record
 * either cites tests or says what it does instead. Nothing is skipped because
 * it did not look like a citation table — that judgement is what let two
 * tables go unread for twenty rounds.
 *
 * An earlier version narrowed the rule to tables with a `mutation` column, and
 * the commit that added it claimed removing that narrowing "kills nothing".
 * That was false: `| test | why it could not fail | what it is now |` — three
 * rows whose first column is literally headed `test` — was being skipped for
 * exactly that reason, which is the disease this script's own header comment
 * names. The narrowing is gone and the table is declared.
 */
const NON_CITING_HEADERS = ['what dies', 'what the check prints', 'what it is now'];

/** Every test source, by path, so a citation can be checked where it points. */
function sources(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry) ? [[path, readFileSync(path, 'utf8')]] : [];
  });
}

/*
 * Split on UNESCAPED pipes only.
 *
 * A mutation cell routinely contains one: `` `\|\|` → `&&` `` is how an
 * or-to-and mutation is written, and markdown escapes those as `\|`. Splitting
 * on every `|` turned three such rows into tables two columns wider than their
 * header. Reading only the last cell hid it — the last cell is the last cell
 * however many phantom ones precede it — so the defect surfaced the moment the
 * citation column was addressed by index instead.
 */
/**
 * Every `it`/`test` title in a body of source.
 *
 * `it.each([...])('title', ...)` is allowed between the name and the string,
 * and its titles carry printf placeholders — which is why a citation matches by
 * PREFIX rather than equality.
 */
function titles(text) {
  const found = [];
  const pattern =
    /*
     * `.skip` and `.todo` are NOT accepted.
     *
     * They were, and a citation therefore resolved to a name that never runs —
     * defeating this script's one sentence of purpose in the cheapest possible
     * way. `.only` and `.concurrent` do run; `.fails` runs and asserts its own
     * failure, so it is evidence too.
     */
    /\b(?:it|test)\s*(?:\.each\s*\([\s\S]*?\)\s*)?(?:\.(?:only|concurrent|fails))?\s*\(\s*(['"`])([\s\S]*?)\1/g;
  let match;
  while ((match = pattern.exec(text)) !== null) found.push(match[2]);
  return found;
}

const cells = (row) =>
  row
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
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
/** Rows whose cell count disagrees with their table's header. */
const malformed = [];
let checked = 0;
let inCitationTable = false;
let previous = null;

/** The previous table row, so a separator can identify the header above it. */
let header = null;
/** Which column of the current table holds its citations. */
let column = -1;
/** How many cells the current table's header declares. */
let width = 0;
/** Inside a fenced code block, where a pipe is illustration rather than data. */
let fenced = false;
/** Tables with no header/separator pair, in which nothing at all was checked. */
const unstructured = [];

for (const line of lines) {
  /*
   * A fenced block is prose, not a table.
   *
   * The record documents table SHAPES, and the moment one is written out
   * properly inside a fence the check failed the run for a table making no
   * claim at all. Two such lines already exist and escape only by not having a
   * separator row under them, which is luck rather than a rule.
   */
  if (/^\s*```/.test(line)) {
    fenced = !fenced;
    inCitationTable = false;
    header = null;
    width = 0;
    continue;
  }
  if (fenced) continue;
  if (!line.startsWith('|')) {
    /*
     * A blank line ENDS a table, and a table that ended without ever reaching a
     * separator was never checked for anything.
     *
     * That was silent and it dropped rows wholesale: one blank line inserted
     * mid-table took the count from 157 to 139 and still exited 0 — eighteen
     * citations unverified, no warning. Third consecutive round in which this
     * script skipped part of the record without saying so, which is precisely
     * what its own opening comment forbids.
     */
    if (header !== null && width === 0) unstructured.push(header);
    inCitationTable = false;
    header = null;
    // A table's width dies with the table. Without this the HEADER row of the
    // next one is measured against the previous one's column count, which is
    // a mismatch for every table that changes shape.
    width = 0;
    continue;
  }
  // A table declares its columns in the row ABOVE the separator, and nowhere
  // else. Deciding at the separator rather than on any row whose last cell
  // happens to read like a header is what keeps `a real test in dashboard.tsx`
  // — an ordinary sentence in an ordinary data row — from being mistaken for a
  // misspelled declaration.
  if (isSeparator(line)) {
    const declared = header === null ? [] : cells(header).map((cell) => cell.toLowerCase());
    /*
     * By NAME, at whatever position — not "the last column".
     *
     * The record's oldest and largest evidence table is headed
     * `| # | Rule | Mutation | Named test | Result |`. `Named test` was always
     * a recognised name; it simply is not last, so reading only the last cell
     * saw `result`, decided the table made no claims, and skipped all twelve of
     * its rows in silence — the same escape as the misspelled header, one
     * position over. Widening the header list would not have closed it.
     */
    column = declared.findIndex((cell) => CITATION_HEADERS.includes(cell));
    inCitationTable = column >= 0;
    previous = null;
    /*
     * Every table declares itself, or the run fails.
     *
     * By NAME at any position, exactly as the citation column is found — the
     * opt-out list was matched against the LAST cell alone, which is the same
     * positional escape that hid the record's largest table and would have hid
     * the next one written a column wider.
     */
    if (header === null) {
      // A separator with no header row above it. `declared` is empty, so every
      // rule below silently does nothing — the declaration check, the width
      // check and the citations all switch off for the rest of the table.
      unstructured.push(line);
      continue;
    }
    if (!inCitationTable && !declared.some((cell) => NON_CITING_HEADERS.includes(cell))) {
      unrecognised.push(header);
    }
    width = declared.length;
    header = null;
    continue;
  }
  const columns = cells(line);
  /*
   * A row that does not match its header's width is malformed, in ANY table.
   *
   * The escaped-pipe bug produced exactly this shape and nothing looked at it;
   * so did one hand-written row in the one table nothing was reading. A cell
   * count is the cheapest possible check for both, and it does not care whether
   * the table cites anything.
   */
  if (width > 0 && columns.length !== width) {
    malformed.push(line);
  }
  if (!inCitationTable) {
    header = line;
    continue;
  }

  const cell = columns[column] ?? '';
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
    // Matched against the TEST TITLES, not the file text.
    //
    // `includes` over the whole source made a `describe` name, a comment or a
    // sentence of prose satisfy "resolves to a committed test" — and one row
    // was doing exactly that. The guarantee this line prints has to be the one
    // it checks.
    // `includes` WITHIN a title, not within the file: an `it.each` title is
    // `'%s is reachable at ...'`, so the citation names a suffix of it.
    else if (!titles(haystack).some((title) => title.includes(needle)))
      missing.push(`${cited.name}  (${cited.file ?? 'any file'})`);
  }
}

if (
  missing.length > 0 ||
  unparsed.length > 0 ||
  unrecognised.length > 0 ||
  malformed.length > 0 ||
  unstructured.length > 0
) {
  if (unstructured.length > 0) {
    console.error(
      `\x1b[31mfail\x1b[0m  ${unstructured.length} table(s) have no header/separator pair, so nothing in them was checked:`,
    );
    for (const row of unstructured) console.error(`        ${row.trim().slice(0, 110)}`);
  }
  if (malformed.length > 0) {
    console.error(
      `\x1b[31mfail\x1b[0m  ${malformed.length} row(s) do not match their table's column count:`,
    );
    for (const row of malformed) console.error(`        ${row.trim().slice(0, 110)}`);
  }
  if (unrecognised.length > 0) {
    console.error(
      `\x1b[31mfail\x1b[0m  ${unrecognised.length} table(s) declare neither a citation column nor what they hold instead:`,
    );
    for (const row of unrecognised) console.error(`        ${row.trim().slice(0, 110)}`);
    console.error(`        citation columns: ${CITATION_HEADERS.join(', ')}`);
    console.error(`        or declare one column: ${NON_CITING_HEADERS.join(', ')}`);
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

if (checked < FLOOR) {
  console.error(
    `\x1b[31mfail\x1b[0m  only ${checked} citations were checked; this record must contain at least ${FLOOR}.`,
  );
  console.error('      Rows are not missing from the file — they are missing from this CHECK.');
  process.exit(1);
}

console.log(`\x1b[32mok\x1b[0m    ${checked} falsification citations resolve to a committed test`);
