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
const EXPECTED = 213;
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
 * Regex literals ARE parsed, and the first version of this said they were not
 * — that the residue, `/[)]/`, was "left stated rather than half-handled". It
 * was not a residue. `expect('x').not.toMatch(/[)]/)` is an ordinary
 * assertion, and one of them as the first `it` inside a skipped suite ended
 * the walk early, left the rest of that suite in the text, and took the check
 * to `ok`, exit 0, with 10 tests skipped. Documenting a hole does not close it.
 *
 * Telling a regex from division is done the way every hand-written scanner
 * does it: by what precedes the slash. After a value — an identifier, a
 * number, `)`, `]`, `}` — a slash is division; after an operator, a comma, an
 * opening bracket or one of the keywords that take an expression, it opens a
 * regex. The known-imperfect case is a slash after a `}` that closes a block
 * rather than an object, which cannot occur in an argument list.
 */
function closeOf(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
    } else if (ch === '/' && text[i + 1] !== '/' && text[i + 1] !== '*' && startsRegex(text, i)) {
      i = endOfRegex(text, i);
      if (i >= text.length) return text.length;
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

/** Whether the `/` at `at` opens a regex literal rather than dividing. */
function startsRegex(text, at) {
  let i = at - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  if (i < 0) return true;
  const prev = text[i];
  if (/[)\]}]/.test(prev)) return false;
  if (!/[A-Za-z0-9_$]/.test(prev)) return true;
  // An identifier ends here — division — unless it is a keyword that is
  // followed by an expression. `return /x/` and `case /x/` are regexes.
  const word = /[A-Za-z0-9_$]+$/.exec(text.slice(0, i + 1));
  return (
    word !== null &&
    [
      'return',
      'typeof',
      'instanceof',
      'in',
      'of',
      'new',
      'delete',
      'void',
      'throw',
      'case',
      'do',
      'else',
      'yield',
      'await',
    ].includes(word[0])
  );
}

/** The index of the `/` closing the regex opened at `start`. */
function endOfRegex(text, start) {
  let inClass = false;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') i += 1;
    else if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    // A `/` inside `[...]` is a literal slash, which is the whole reason a
    // character class has to be tracked rather than skipped.
    else if (ch === '/' && !inClass) return i;
    else if (ch === '\n') return text.length;
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
 * `runIf` is here with the others because whether it runs is a RUNTIME value
 * this script cannot read, and the two ways of being wrong are not symmetric:
 * treating a running suite as skipped fails its citations loudly, while
 * treating a skipped one as running is this script being green and wrong,
 * which is the single failure mode it exists to prevent.
 */
const SKIPPING = new Set(['skip', 'todo', 'skipIf', 'runIf']);

/**
 * A copy of a source with every comment, string and regex body blanked.
 *
 * Same length, same newlines, so an offset into it is an offset into the
 * original and a line number computed from it is right.
 *
 * Every scanner in this file that looks for a TOKEN runs over this rather than
 * over the source, because the alternative is a scanner that fires on prose.
 * `onlyMarkers` did: a comment reading "never write it.only( in a committed
 * file" failed the run. It fails closed, so it was loud rather than dangerous
 * — but a check that cannot describe its own hazard in its own comments is one
 * nobody can document, and the asymmetry with `describe.onlyish` (correctly
 * ignored) made it an inconsistency rather than a policy.
 */
function maskLiterals(text) {
  const out = text.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < text.length; k += 1) {
      if (text[k] !== '\n') out[k] = ' ';
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      const newline = text.indexOf('\n', i);
      const stop = newline === -1 ? text.length : newline;
      blank(i, stop);
      i = stop;
    } else if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const stop = close === -1 ? text.length : close + 2;
      blank(i, stop);
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      const close = endOfQuote(text, i);
      blank(i + 1, close);
      i = Math.min(close + 1, text.length);
    } else if (ch === '/' && startsRegex(text, i)) {
      const close = endOfRegex(text, i);
      blank(i + 1, close);
      i = Math.min(close + 1, text.length);
    } else {
      i += 1;
    }
  }
  return out.join('');
}

/**
 * The modifier chain after an identifier, and where the whole call expression
 * ends.
 *
 * ONE reader, used for the suites that are skipped AND for the `.only` that
 * skips everything else, because the round before this one wrote a careful
 * chain reader for the first and left the second matching `\.\s*only\s*\(` —
 * dot notation and whitespace only — twenty lines below it. `it['only'](…)`,
 * `it /*x*\/ .only(…)` and `it.only.each([1])(…)` all printed `ok 202`, exit 0,
 * against `1 failed | 61 skipped`. That is this branch's documented defect
 * class (the rule holds where the author was looking) occurring inside the
 * commit written about it, which is why the two callers now share a reader
 * instead of agreeing by care.
 */
function chainAfter(text, from) {
  const chain = [];
  let i = from;
  for (;;) {
    i = afterGap(text, i);
    // `describe?.skip(...)` is the same suite. One character defeated the
    // previous reader, on a branch whose parent commit is titled for exactly
    // that.
    if (text[i] === '?' && text[i + 1] === '.') i += 1;
    if (text[i] === '.') {
      i = afterGap(text, i + 1);
      const name = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
      if (name === null) break;
      chain.push(name[0]);
      i += name[0].length;
      continue;
    }
    if (text[i] === '[') {
      const close = closeBracket(text, i);
      const inner = text.slice(i + 1, close - 1).trim();
      const literal = /^(['"`])\s*([A-Za-z_$][\w$]*)\s*\1$/.exec(inner);
      // A computed key this script cannot evaluate counts as skipping: being
      // wrong that way fails citations loudly, the other way is green and
      // wrong. NOTE the masked text blanks string BODIES, so the literal is
      // read from the original — see the callers.
      chain.push(literal === null ? 'skip' : literal[2]);
      i = close;
      continue;
    }
    // `describe.skipIf(cond)('name', fn)` is TWO call groups and the suite ends
    // at the last one. Consuming each in turn is what finds it.
    if (text[i] === '(') {
      i = closeOf(text, i);
      continue;
    }
    break;
  }
  return { chain, end: i };
}

/**
 * The names that open a skipped suite in this source.
 *
 * `describe` always, plus any local bound to a skipping chain:
 * `const zz = describe.skip;` then `zz('the panel list', …)` skipped ten tests
 * with the check reporting `ok 202`, exit 0. A reader that follows only the
 * literal identifier cannot see an alias, and an alias is one line.
 */
function skippingOpeners(masked, source) {
  const names = ['describe'];
  const binding = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*describe\b/g;
  let match;
  while ((match = binding.exec(masked)) !== null) {
    const { chain } = readChain(masked, source, match.index + match[0].length);
    if (chain.some((link) => SKIPPING.has(link))) names.push(match[1]);
  }
  return names;
}

/** `chainAfter` over the masked text, with bracket keys read from the source. */
function readChain(masked, source, from) {
  const onMask = chainAfter(masked, from);
  if (!onMask.chain.includes('skip')) return onMask;
  // A bracket key is blanked in the masked copy, so re-read the chain from the
  // source to tell `describe['skip']` from a genuinely computed key.
  return chainAfter(source, from);
}

/**
 * A source with the body of every skipped `describe` removed.
 *
 * Three rounds of this were the same mistake in different clothes: a regex to
 * end of file, then a literal `describe.skip(` matcher, then a chain reader
 * that handled dots and brackets and not `?.` or an alias. The rule is not "a
 * spelling"; it is "this suite does not run", and every spelling that says so
 * has to reach the same reader.
 */
function withoutSkippedSuites(text) {
  const masked = maskLiterals(text);
  const openers = skippingOpeners(masked, text);
  const pattern = new RegExp(`\\b(?:${openers.join('|')})\\b`, 'g');
  let out = '';
  let cursor = 0;
  let match;
  while ((match = pattern.exec(masked)) !== null) {
    if (match.index < cursor) continue;
    const { chain, end } = readChain(masked, text, match.index + match[0].length);
    // A bare alias call — `zz('name', fn)` — is skipped by what it was bound
    // to, so it needs no skipping link of its own.
    const skips = match[0] !== 'describe' || chain.some((link) => SKIPPING.has(link));
    if (!skips) continue;
    out += text.slice(cursor, match.index);
    cursor = end;
    pattern.lastIndex = cursor;
  }
  return out + text.slice(cursor);
}

/**
 * The next index that is neither whitespace nor a comment.
 *
 * A comment inside the chain — `describe /*x*\/ .skip(...)` — was not read as a
 * chain at all, so the suite went unstripped and its citations resolved.
 * Whitespace was skipped and comments were not, which is the same omission one
 * token over.
 */
function afterGap(text, from) {
  let i = from;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] === '/' && text[i + 1] === '/') {
      const newline = text.indexOf('\n', i);
      if (newline === -1) return text.length;
      i = newline + 1;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return text.length;
      i = end + 2;
      continue;
    }
    return i;
  }
}

/** The index just past the `]` closing the bracket at `open`. */
function closeBracket(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') i += 1;
    else if (ch === '"' || ch === "'" || ch === '`') {
      i = endOfQuote(text, i);
      if (i >= text.length) return text.length;
    } else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
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
     * way. `.concurrent` does run; `.fails` runs and asserts its own failure,
     * so it is evidence too.
     *
     * `.only` is accepted HERE and refused by `onlyMarkers` below, because the
     * problem with it is not the marked test — that one runs — but its sixty
     * siblings, which do not. One `it.only` took this check to `ok 194`, exit
     * 0, with `1 passed | 60 skipped`.
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
/**
 * Every `.only` marker in a source, with its line.
 *
 * `.only` does not skip the test it marks; it skips everything else. A file
 * carrying one runs a single test, and this check went on resolving citations
 * into the sixty that no longer ran — reporting success for evidence that had
 * stopped existing, which is the one failure mode it exists to prevent. One
 * `it.only` in `panels.test.tsx` printed `ok 194`, exit 0, against
 * `1 passed | 60 skipped`.
 *
 * CI catches this by another route (vitest's `allowOnly` defaults to `!isCI`),
 * and `vitest.config.mts` now sets it false everywhere so a local `pnpm verify`
 * fails the same way. That is a second guard, not a reason to omit this one:
 * this check is what makes the RECORD's claims false, so it should say so
 * itself rather than depend on a runner setting somebody may relax.
 */
function onlyMarkers(text) {
  const masked = maskLiterals(text);
  const found = [];
  // THE SAME reader the skipped-suite scan uses. The previous version matched
  // `\.\s*only\s*\(` — dot notation, whitespace only — so `it['only'](…)`,
  // `it /*x*/ .only(…)` and `it.only.each([1])(…)` all passed while skipping
  // sixty-one tests. Sharing the reader is what stops the two drifting again.
  const opener = /\b(?:describe|it|test)\b/g;
  let match;
  while ((match = opener.exec(masked)) !== null) {
    const { chain } = readChain(masked, text, match.index + match[0].length);
    if (chain.includes('only')) {
      found.push(masked.slice(0, match.index).split('\n').length);
    }
  }
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
/*
 * A `.only` anywhere makes every citation in this record unverifiable, because
 * the tests they name have stopped running. Collected before anything else so
 * the run says that rather than reporting a resolved count nobody can trust.
 */
/*
 * A row label may name only one rule.
 *
 * The record carried `Y1`-`Y4` twice, `U13` twice and `U88` twice, so a
 * citation to any of them resolved to two different rules and neither could be
 * looked up. One of those collisions was created by the round that wrote the
 * table, which is why this is mechanical now rather than a thing to be careful
 * about. Labels are the record's own primary keys.
 */
const labels = new Map();
const duplicated = [];
for (const line of readFileSync(RECORD, 'utf8').split('\n')) {
  const label = /^\|\s*([A-Z]+[0-9]+[a-z]?)\s*\|/.exec(line);
  if (label === null) continue;
  const seen = labels.get(label[1]);
  if (seen === undefined) labels.set(label[1], line);
  else duplicated.push(label[1]);
}

const only = files.flatMap(([path, text]) => onlyMarkers(text).map((line) => `${path}:${line}`));
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
 * falsified — and that rule IS falsified (row WY): drop the in-loop
 * `unstructured.push(header)` with a header-only table appended and the check
 * goes green.
 *
 * The sentinel itself is not separately falsifiable, and saying so is the
 * point. Removing it changes nothing today, for exactly the reason round 28's
 * end-of-file copy could not fire: prettier and git guarantee a trailing
 * newline, so `lines` already ends in `''`. It is a guard against a file that
 * lacks one — not a rule — and it is here so the loop is total rather than
 * true-by-coincidence. A round that mistakes it for a tested rule would be
 * repeating the mistake it replaced.
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
  unstructured.length > 0 ||
  only.length > 0 ||
  duplicated.length > 0
) {
  if (duplicated.length > 0) {
    console.error(
      `\x1b[31mfail\x1b[0m  ${duplicated.length} row label(s) name more than one rule, so a citation to them resolves to neither:`,
    );
    for (const label of duplicated) console.error(`        ${label}`);
  }
  if (only.length > 0) {
    console.error(
      `\x1b[31mfail\x1b[0m  ${only.length} \`.only\` marker(s): every OTHER test in those files is skipped, so no citation into them means anything:`,
    );
    for (const site of only) console.error(`        ${site}`);
  }
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
