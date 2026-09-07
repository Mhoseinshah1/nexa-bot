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
 * A FLOOR does not close the class, and round 27 claimed it had been replaced
 * by an exact count when the edit had silently never applied: the script that
 * made it threw on a later assertion before writing, and the `ok 171` printed
 * by the next command was read as confirmation of a change that did not exist.
 * Measured afterwards: fencing 17 of the record's 25 citation tables still
 * exited 0 under the floor, one of them the table certifying that very commit.
 *
 * So it is EXACT. Adding rows fails the run and the failure says what to set it
 * to, which is the point: the number is a claim about this file and should be
 * re-stated deliberately, not drifted into.
 */
const EXPECTED = 194;
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

/**
 * The index just past the `)` that closes the paren at `open`.
 *
 * Counting bare parens is not enough, and the direction it goes wrong in is
 * the dangerous one. A `)` inside a test title — `it('refuses a 403)')` — ends
 * the walk EARLY, so the tail of a skipped suite survives the strip and a
 * citation into it resolves: this script's one sentence of purpose, defeated.
 * (Overshooting is the safe direction: live suites vanish and their citations
 * fail loudly.) So strings, template literals and comments are skipped rather
 * than counted.
 *
 * Regex literals are NOT parsed — telling `/` from division needs the parse
 * this script deliberately does not do. Honouring a backslash escape in code
 * position covers the case that matters, `\)`, since a backslash cannot
 * legally appear in code position for any other reason. The residue is an
 * unescaped paren in a character class, `/[)]/`, and it is left stated rather
 * than half-handled.
 */
function closeOf(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      const newline = text.indexOf('\n', i);
      if (newline === -1) return text.length;
      i = newline;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return text.length;
      i = end + 1;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      i = endOfQuote(text, i);
      if (i >= text.length) return text.length;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** The index of the quote closing the one at `start`, or the end of the text. */
function endOfQuote(text, start) {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === quote) return i;
  }
  return text.length;
}

/**
 * Modifiers on a `describe` chain that mean the suite may not run.
 *
 * `runIf` is here with the two obvious ones because whether it runs is a
 * RUNTIME value this script cannot read, and the two ways of being wrong are
 * not symmetric: treating a running suite as skipped fails its citations
 * loudly, while treating a skipped one as running is this script being green
 * and wrong, which is the single failure mode it exists to prevent.
 */
const SKIPPING = new Set(['skip', 'todo', 'skipIf', 'runIf']);

/**
 * A source with the body of every skipped `describe` removed.
 *
 * Two rounds of this were the same mistake in different clothes.
 *
 * The first matched `describe.skip(` and deleted `[\s\S]*` — to END OF FILE.
 * One skipped suite would have erased every LIVE suite after it and every
 * citation into them, and because the cross-file haystack is the sources
 * concatenated, one skipped suite anywhere would have done it to every
 * `file: null` citation too.
 *
 * The second bounded the deletion and kept matching the literal spelling
 * `describe.skip(`. `describe.skipIf(true)(…)` is a first-class vitest API and
 * does not match it — `skip` there is followed by `If`, not `(`. Probed on
 * `panels.test.tsx`, the file this record cites 46 times: the suite went to
 * `12 passed | 47 skipped` and this check still printed `ok 178`, exit 0. The
 * whole point of the script, defeated by two characters.
 *
 * So it no longer matches a spelling. It reads the MODIFIER CHAIN after
 * `describe` — every `.name`, with any call group between them consumed — and
 * asks whether any link in it skips. `describe.skip.each([…])(…)` and
 * `describe.skipIf(cond)(…)` are the same question as `describe.skip(…)`.
 */
function withoutSkippedSuites(text) {
  const opener = /\bdescribe\b/g;
  let out = '';
  let cursor = 0;
  let match;
  while ((match = opener.exec(text)) !== null) {
    if (match.index < cursor) continue;
    const chain = [];
    let i = match.index + 'describe'.length;
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i += 1;
      if (text[i] === '.') {
        i += 1;
        while (i < text.length && /\s/.test(text[i])) i += 1;
        const name = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
        if (name === null) break;
        chain.push(name[0]);
        i += name[0].length;
        continue;
      }
      // `describe.skipIf(cond)('name', fn)` is TWO call groups, and the suite
      // ends at the last one. Consuming each in turn is what finds it.
      if (text[i] === '(') {
        i = closeOf(text, i);
        continue;
      }
      break;
    }
    if (!chain.some((link) => SKIPPING.has(link))) continue;
    out += text.slice(cursor, match.index);
    cursor = i;
    opener.lastIndex = cursor;
  }
  return out + text.slice(cursor);
}

/**
 * Every `it`/`test` title in a body of source.
 *
 * `it.each([...])('title', ...)` is allowed between the name and the string,
 * and its titles carry printf placeholders — which is why a citation matches by
 * PREFIX rather than equality.
 */
function titles(text) {
  const found = [];
  /*
   * A test inside a `describe.skip` never runs either.
   *
   * Round 27 closed `it.skip`/`it.todo` and left the same hole one level up,
   * which is the shape of most of this script's history: the instance fixed,
   * the class left open. A skipped SUITE contributes no titles at all.
   *
   * Only that suite, though, and `withoutSkippedSuites` says why finding where
   * it ends is not the one-line regex it looks like.
   */
  text = withoutSkippedSuites(text);
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

/*
 * A sentinel blank line, so END OF FILE is not a second copy of the rule.
 *
 * The end-of-table detector fired only on a non-`|` line, so a table at the
 * end of the file was never closed — and the end of this file is exactly where
 * every round appends its own table. The fix for that was a COPY of the check
 * after the loop, and the copy could not fire: `split('\n')` on a file with a
 * trailing newline already yields a final `''`, which is a non-`|` line, so
 * the in-loop check had always been handling EOF for any file git and prettier
 * would accept. Its certifying row in the record passed with the rule reverted
 * — the definition of a test that is not a test.
 *
 * One rule, reached the same way in both cases, is the version that can be
 * falsified. The sentinel costs one array element.
 */
for (const line of [...lines, '']) {
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

if (checked !== EXPECTED) {
  console.error(
    `\x1b[31mfail\x1b[0m  ${checked} citations were checked; this record declares ${EXPECTED}.`,
  );
  console.error(
    checked < EXPECTED
      ? '      Rows may not be missing from the FILE — they may be missing from this CHECK.'
      : `      Rows were added. Set EXPECTED to ${checked} in the same commit that adds them.`,
  );
  process.exit(1);
}

console.log(`\x1b[32mok\x1b[0m    ${checked} falsification citations resolve to a committed test`);
