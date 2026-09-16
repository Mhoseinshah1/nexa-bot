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
import ts from 'typescript';
import { basename, join } from 'node:path';

/**
 * The falsification records this check reads.
 *
 * A LIST, because a phase gets its own record and the alternative was to keep
 * appending to Phase 3D's — which would make one file's title a lie and,
 * worse, would let a new phase's rows inherit an old phase's certification by
 * sitting under it. Every record here is checked by the same rules; nothing is
 * checked by being named here and skipped for not being.
 *
 * `EXPECTED` below is the TOTAL across all of them, for the reason it is exact
 * rather than a floor: the number is a claim about these files and should be
 * re-stated deliberately when they grow.
 */
const RECORDS = [
  'docs/phase3d-falsification.md',
  'docs/backup-falsification.md',
  'docs/hardening-falsification.md',
  'docs/disaster-recovery-falsification.md',
  'docs/config-upgrade-falsification.md',
  'docs/phase4a-falsification.md',
  'docs/phase4b-falsification.md',
  'docs/phase4c-falsification.md',
  'docs/telegram-bootstrap-falsification.md',
  'docs/phase4d-falsification.md',
  'docs/phase4e-falsification.md',
  'docs/phase4f-falsification.md',
  'docs/phase4g-falsification.md',
];
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
 * to, which is the point: the number is a claim about these files and should be
 * re-stated deliberately, not drifted into.
 *
 * It is the TOTAL over `RECORDS`, not a per-file figure. A per-file count would
 * have to be a map, and a map is a place for a record to be added with no entry
 * and checked against nothing — which is this script's own failure mode.
 */
const EXPECTED = 980;
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
const NON_CITING_HEADERS = [
  'what dies',
  'what the check prints',
  'what it is now',
  /*
   * A rule held by a MECHANISM rather than by a mutation — a boundary check, a
   * SQL predicate, a capability that does not exist to be called.
   *
   * Declared rather than omitted, because "absent from the falsification table"
   * reads as "unchecked", and a record that silently drops such rules is making
   * the same understatement this script exists to refuse from the other
   * direction. Nothing in such a table cites a test, so nothing in one is
   * resolvable; naming the header is how it stays readable AND unchecked
   * on purpose.
   */
  'what holds it',
];

/**
 * Every shell test suite, by path, and the test names it declares.
 *
 * Separate from `sources` on purpose, and not merged into it: every other reader
 * in this file is a TypeScript reader. `maskLiterals`, `withoutSkippedSuites`,
 * `onlyMarkers` and `unresolvedModifiers` all assume JS syntax, and handing them
 * bash would not fail loudly — it would return nothing, which reads as "no tests
 * here" and makes every citation into a shell suite resolve against the empty
 * set.
 *
 * Shell suites exist because the deployment state machine is a shell program:
 * `tests/deploy/botctl.test.sh` drives the real `botctl` against a fake docker,
 * and the rules it proves — the update and rollback ordering, the host-asset
 * activation, the edge-configuration adoption — have no other behavioural test.
 * Before this they could not be CITED, so they were falsified by hand and the
 * evidence lived in a commit message. That is the shape this whole script exists
 * to refuse.
 *
 * One declaration form: `test_case '<name>'`, which is the harness's own. A suite
 * that invents a second way to name a test would be invisible here, so
 * `harness.sh` is asserted to define exactly this one.
 */
function shellSuites(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return shellSuites(path);
    if (!/\.test\.sh$/.test(entry)) return [];
    const text = readFileSync(path, 'utf8');
    // Single or double quoted, and the name runs to the matching quote. A bash
    // test name is a literal; nothing here interpolates one.
    const names = [...text.matchAll(/^\s*test_case\s+(['"])([\s\S]*?)\1/gm)].map(
      (match) => match[2],
    );
    return [[path, names]];
  });
}

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
 * Plain counting, because every caller passes text whose strings, comments,
 * templates and regexes are already blanked by `maskLiterals`. The three
 * heuristics this used to need — `startsRegex`, `endOfRegex`, `endOfQuote` —
 * are gone with the hand-rolled lexer they served.
 */
function closeOf(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** The index just past the `]` closing the bracket at `open`. */
function closeBracket(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '[') depth += 1;
    else if (text[i] === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
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
 * A key this script cannot evaluate, e.g. `it['on' + 'ly']`.
 *
 * It counted as skipping for `describe` and as nothing at all for `.only`, so
 * the same spelling was fail-closed on one scanner and fail-open on the other
 * — a policy the file states and did not keep. One sentinel, honoured by both.
 */
const COMPUTED = '\u0000computed';

/**
 * A copy of a source with every comment, string, template and regex body
 * blanked. Same length, same newlines, so an offset into it is an offset into
 * the original.
 *
 * THE PARSER, not a heuristic. Four consecutive rounds hand-rolled this and
 * each fix introduced the next defect in the same function:
 *
 *   r31  `<` and `"` were treated as opening a regex, so every JSX closing tag
 *        blanked the rest of the file. 4 of 113 sources went dark.
 *   r32  an allow-list fixed that and omitted `>`, so a concise arrow body
 *        `(v) => /['"]/.test(v)` opened a phantom STRING and ran away.
 *   r33  bounding `'`/`"` to one line fixed that, on the claim that such a
 *        string cannot span a line. In TSX it can: a JSX attribute
 *        `title="…"` spans lines freely, so its text was scanned as code, a
 *        backtick in it opened a phantom TEMPLATE — which is deliberately not
 *        line-bounded — and 5169 characters over 409 lines were blanked, with
 *        a `describe.skip` and nine skipped tests reported `ok`, exit 0.
 *
 * Each of those was a green gate away from shipping, and the third was found
 * by a reviewer building a TypeScript-scanner oracle to check the second. The
 * lesson is not "be more careful with the fifth heuristic": telling a regex
 * from a division, or a JSX attribute from a string, IS parsing, and the
 * parser is already a dependency of this repository.
 *
 * `ts.createSourceFile` resolves all of it — regex versus division, JSX text,
 * attributes, template interpolation, nesting — because it is the same code
 * that compiles the sources. Comments are removed in a second pass, which is
 * safe only because it runs on text whose string bodies are already gone.
 */
export function maskLiterals(text, fileName = 'source.tsx') {
  const out = text.split('');
  const blank = (from, to) => {
    for (let i = from; i < to && i < text.length; i += 1) {
      if (text[i] !== '\n') out[i] = ' ';
    }
  };
  /*
   * The SCRIPT KIND follows the extension, and getting that wrong is its own
   * blind spot.
   *
   * Parsing every file as TSX misreads a `.ts` file's angle brackets: a
   * generic arrow becomes JSX, and the "JSX text" after it is blanked. On the
   * current tree that damages exactly one source —
   * `notification-claim-exclusivity.test.ts`, 1451 characters of its mask —
   * and an earlier version of this comment claimed the damage cost that file
   * its five titles. It does not: measured with the kind forced to TSX, all
   * five still resolve, because the blanked run falls between them.
   *
   * The real cost is a FALSE NEGATIVE. A `describe.skip` inside a blanked run
   * is not seen by the chain reader, so the parked suite is never stripped and
   * its titles resolve as though they run — a citation into a suite nobody
   * executes, which is this script's one sentence of purpose. That is the
   * shape the fixture asserts, and it is the shape three earlier fixtures for
   * this rule missed while passing.
   */
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const BODIES = new Set([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.RegularExpressionLiteral,
    ts.SyntaxKind.JsxText,
  ]);
  const visit = (node) => {
    if (BODIES.has(node.kind)) {
      // Keep the delimiters, blank what is between them: the chain readers
      // look for `'`/`"` to tell a literal bracket key from a computed one.
      const from = node.getStart(source);
      blank(from + 1, node.end - 1);
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);

  // Comments, on the literal-blanked text. No string can hide a `//` now.
  const stripped = out.join('');
  const withoutComments = out.slice();
  let i = 0;
  while (i < stripped.length) {
    if (stripped[i] === '/' && stripped[i + 1] === '/') {
      const newline = stripped.indexOf('\n', i);
      const stop = newline === -1 ? stripped.length : newline;
      for (let k = i; k < stop; k += 1) withoutComments[k] = ' ';
      i = stop;
    } else if (stripped[i] === '/' && stripped[i + 1] === '*') {
      const close = stripped.indexOf('*/', i + 2);
      const stop = close === -1 ? stripped.length : close + 2;
      for (let k = i; k < stop; k += 1) {
        if (stripped[k] !== '\n') withoutComments[k] = ' ';
      }
      i = stop;
    } else {
      i += 1;
    }
  }
  return withoutComments.join('');
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
      chain.push(literal === null ? COMPUTED : literal[2]);
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
  const always = [];
  const describeLike = ['describe'];
  /*
   * Four alias shapes, because one was handled and four were not.
   *
   * `const zz = describe.skip` was read; `const zz = describe` then `zz.skip(…)`,
   * `const { skip } = describe`, and a plain `d = describe.skip` after a bare
   * `let d` were not, and each hid a suite with the check reporting `ok`. The
   * binding is also matched without requiring `const`/`let`/`var` so a later
   * assignment counts.
   */
  const bound = /([A-Za-z_$][\w$]*)\s*=\s*describe\b/g;
  let match;
  while ((match = bound.exec(masked)) !== null) {
    const { chain } = readChain(masked, source, match.index + match[0].length);
    if (chain.some((link) => SKIPPING.has(link) || link === COMPUTED)) always.push(match[1]);
    else if (chain.length === 0) describeLike.push(match[1]);
  }
  /*
   * `import { describe as d } from 'vitest'` needs no local binding at all,
   * and is the most idiomatic way to rename it. The two patterns above match
   * only assignment and destructuring, so this reached neither: a `d.skip(`
   * suite skipped nine tests with the check reporting `ok`, exit 0.
   */
  const imported = /import\s*\{([^}]*)\}\s*from\s*['"`]/g;
  while ((match = imported.exec(masked)) !== null) {
    for (const clause of match[1].split(',')) {
      const renamed = /^\s*describe\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(clause);
      if (renamed !== null) describeLike.push(renamed[1]);
    }
  }
  const destructured = /\{([^}]*)\}\s*=\s*describe\b/g;
  while ((match = destructured.exec(masked)) !== null) {
    for (const part of match[1].split(',')) {
      const name = /([A-Za-z_$][\w$]*)\s*$/.exec(part.split(':').pop() ?? '');
      if (name !== null && SKIPPING.has(/^[A-Za-z_$][\w$]*/.exec(part.trim())?.[0] ?? '')) {
        always.push(name[1]);
      }
    }
  }
  return { always, describeLike };
}

/** A name used inside a generated pattern. `$d` is a legal identifier. */
function escapeName(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `chainAfter` over the masked text, with bracket keys read from the source. */
function readChain(masked, source, from) {
  const onMask = chainAfter(masked, from);
  /*
   * The guard tests for the SENTINEL, which is what a blanked bracket key
   * yields — and it used to test for the literal `'skip'`, which is what the
   * sentinel used to be. Renaming the sentinel and leaving the guard behind
   * made this re-read dead: every bracket key stayed `COMPUTED`, so
   * `describe['skip'](…)` was reported as a `.only` MARKER, a false statement
   * about the file printed by the check whose subject is false statements.
   * It also made two of the new unit cases pass for the wrong reason.
   */
  if (!onMask.chain.includes(COMPUTED)) return onMask;
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
export function withoutSkippedSuites(text, fileName = 'source.tsx') {
  const masked = maskLiterals(text, fileName);
  const { always, describeLike } = skippingOpeners(masked, text);
  const names = [...new Set([...always, ...describeLike])].map(escapeName);
  /*
   * Identifier-char lookaround, not `\b`.
   *
   * `$` is a legal identifier character and NOT a word character, so
   * `\b\$d\b` never matches ` $d(` — the boundary needs a word character on
   * one side. An alias named `$d` therefore stayed invisible after the escaping
   * fix, which is the alias feature's own bug rather than an inherited one.
   */
  const pattern = new RegExp(`(?<![A-Za-z0-9_$])(?:${names.join('|')})(?![A-Za-z0-9_$])`, 'g');
  const alwaysSkips = new Set(always);
  let out = '';
  let cursor = 0;
  let match;
  while ((match = pattern.exec(masked)) !== null) {
    if (match.index < cursor) continue;
    const { chain, end } = readChain(masked, text, match.index + match[0].length);
    // A name bound to a skipping chain is skipped however it is called; a name
    // bound to bare `describe` needs a skipping link of its own, exactly as
    // `describe` does.
    const skips =
      alwaysSkips.has(match[0]) || chain.some((link) => SKIPPING.has(link) || link === COMPUTED);
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

/**
 * Every `it`/`test` title in a body of source.
 *
 * `it.each([...])('title', ...)` is allowed between the name and the string,
 * and its titles carry printf placeholders — which is why a citation matches by
 * PREFIX rather than equality.
 */
export function titles(text, fileName = 'source.tsx') {
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
  text = withoutSkippedSuites(text, fileName);
  /*
   * MATCHED on the mask, READ from the source.
   *
   * `withoutSkippedSuites` returns the source, so this used to run its regex
   * over raw text — and every other reader in this file runs over the mask.
   * A citation could therefore resolve against `it('…')` written inside a
   * COMMENT or a STRING: "resolves to prose, not to a test", which is the
   * failure this script exists to prevent and which its own header comment
   * claims to have removed. Measured over the committed tree, 23 `it(` calls
   * live inside string fixtures in `falsification-checker.test.ts` alone.
   *
   * Matching on the mask cannot read the title, because the title IS a string
   * literal and the mask blanks it. So the offsets come from the mask and the
   * text comes from the source: the closing quote is the last character of the
   * match, which makes the body's span exact without re-scanning for a quote
   * that `.each([...])` may also contain.
   */
  const masked = maskLiterals(text, fileName);
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
  while ((match = pattern.exec(masked)) !== null) {
    const body = match[2] ?? '';
    const end = match.index + match[0].length - 1;
    found.push(text.slice(end - body.length, end));
  }
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
export function onlyMarkers(text, fileName = 'source.tsx') {
  const masked = maskLiterals(text, fileName);
  const found = [];
  // THE SAME reader the skipped-suite scan uses. The previous version matched
  // `\.\s*only\s*\(` — dot notation, whitespace only — so `it['only'](…)`,
  // `it /*x*/ .only(…)` and `it.only.each([1])(…)` all passed while skipping
  // sixty-one tests. Sharing the reader is what stops the two drifting again.
  const opener = /\b(?:describe|it|test)\b/g;
  let match;
  while ((match = opener.exec(masked)) !== null) {
    const { chain } = readChain(masked, text, match.index + match[0].length);
    if (chain.includes('only') || chain.includes(COMPUTED)) {
      found.push(masked.slice(0, match.index).split('\n').length);
    }
  }
  return found;
}

/**
 * Every skipping modifier called on a receiver this file cannot resolve.
 *
 * The alias scan reads four shapes and the namespace form falls out for free:
 * `v.describe.skip(` still contains the token `describe`, and the identifier
 * lookaround admits it because the character before it is a dot. What it
 * cannot read is a rename that removes the token altogether —
 * `import d from './helpers'` re-exporting `describe`, then `d.skip(`. That
 * needs the OTHER file, and this script reads one at a time.
 *
 * So it does not guess and it does not shrug. An unresolved receiver is an
 * error, exactly as an unrecognised table header is: the alternative is the
 * disease this file's header comment names, a checker deciding for itself what
 * to ignore. Measured over the 109 sources in `tests/`: zero. The guard costs
 * nothing today and refuses to be silently wrong the day somebody writes one.
 */
export function unresolvedModifiers(text, fileName = 'source.tsx') {
  const masked = maskLiterals(text, fileName);
  const { always, describeLike } = skippingOpeners(masked, text);
  /*
   * `it` and `test` are not describe-like — they take no suite — but they
   * carry the same modifiers and `titles`/`onlyMarkers` already read them by
   * name. `bench` and `suite` are vitest's own, listed so adopting one is not
   * reported as an alias nobody can resolve.
   */
  const resolved = new Set([...always, ...describeLike, 'it', 'test', 'bench', 'suite']);
  const found = [];
  for (const match of masked.matchAll(
    /([A-Za-z_$][\w$]*)\s*\.\s*(skip|only|todo|skipIf|runIf)\s*\(/g,
  )) {
    if (resolved.has(match[1])) continue;
    found.push(`${masked.slice(0, match.index).split('\n').length}  ${match[1]}.${match[2]}(`);
  }
  return found;
}

/**
 * Row labels that name more than one rule, and transcripts quoting a count
 * that is no longer this record's.
 *
 * Pure, and above `cells`, so the unit suite can reach them. They were inline
 * in the script body with no fixture anywhere, and all three of the rules they
 * carry — fence tracking in each loop, and the label pattern — reverted with
 * the whole gate green.
 */
export function recordIssues(record, expected) {
  const labels = new Set();
  const duplicated = [];
  const staleCounts = [];
  let fenced = false;
  let inLabelTable = false;
  for (const [index, line] of record.split('\n').entries()) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    // A label is the first cell of a row in a table whose first column is `#`.
    // Widening the pattern to admit digit-less labels (`VX`, `WY`) also made it
    // assert that every capitalised first cell is a label, so a `| verdict |`
    // table with two `Green` rows failed for a duplicate that is not one.
    if (/^\|\s*#\s*\|/.test(line)) inLabelTable = true;
    else if (!line.startsWith('|')) inLabelTable = false;
    if (line.startsWith('|') && inLabelTable && !/^\|\s*-/.test(line)) {
      const label = /^\|\s*([A-Z][A-Za-z0-9]*)\s*\|/.exec(line);
      if (label !== null) {
        if (labels.has(label[1])) duplicated.push(label[1]);
        else labels.add(label[1]);
      }
    }
    /*
     * `(then)` marks a row deliberately, at the END of its cell.
     *
     * Matching it anywhere in the line meant a row whose CITED TEST TITLE
     * contains the words — "leaves a row marked (then) alone" — exempted
     * itself by accident, so the rule it certifies was unfalsifiable through
     * the record.
     */
    if (!line.startsWith('|') || /\(then\)\s*\|/.test(line)) continue;
    // A LEFT boundary: without it `took 812 ms` reads as `ok 812`, and this
    // record's genre is timings.
    for (const quoted of line.matchAll(/(?<![A-Za-z])(?:ok|declares)\s+([0-9]{2,4})/g)) {
      if (Number(quoted[1]) !== expected) {
        staleCounts.push(`${index + 1}: ${quoted[0]} — EXPECTED is ${expected}`);
      }
    }
  }
  return { duplicated, staleCounts };
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

/**
 * The check itself, behind a guard so the module can be imported.
 *
 * The unit suite used to slice this file at `const cells` and import the
 * prefix through a `data:` URL. That broke the moment the masking started
 * using the TypeScript parser, because a data URL cannot resolve a bare
 * specifier — and it had always been a way of testing something that was
 * not quite the module. Ordinary exports, and an entry-point guard.
 */
function main() {
  const files = sources('tests');
  /*
   * A `.only` anywhere makes every citation in this record unverifiable, because
   * the tests they name have stopped running. Collected before anything else so
   * the run says that rather than reporting a resolved count nobody can trust.
   */
  const duplicated = [];
  const staleCounts = [];
  for (const record of RECORDS) {
    const issues = recordIssues(readFileSync(record, 'utf8'), EXPECTED);
    duplicated.push(...issues.duplicated.map((label) => `${record}: ${label}`));
    staleCounts.push(...issues.staleCounts.map((row) => `${record}:${row}`));
  }

  const only = files.flatMap(([path, text]) =>
    onlyMarkers(text, path).map((line) => `${path}:${line}`),
  );
  /*
   * And every skipping modifier whose receiver this script could not resolve.
   * Not a warning: an alias it cannot follow is a suite it cannot see, and a
   * citation into an invisible suite resolves exactly like a real one.
   */
  const unresolvable = files.flatMap(([path, text]) =>
    unresolvedModifiers(text, path).map((site) => `${path}:${site}`),
  );
  /*
   * Titles PER FILE, not one concatenated haystack.
   *
   * The haystack used to be every source joined with a newline and parsed as a
   * single unit. That cannot be told which language it is — and concatenating
   * sources can produce syntax that parses unlike any of its parts. Each file
   * is read as itself, with its own extension, and the titles are unioned.
   */
  const titlesByPath = new Map(files.map(([path, text]) => [path, titles(text, path)]));
  /*
   * And the shell suites, which are tests too.
   *
   * `tests/deploy/botctl.test.sh` is the only behavioural test of the update and
   * rollback state machines — the real `botctl`, against a fake docker — so a
   * record that cites it is citing the test that actually covers the rule.
   * Without this the citation resolved against nothing and the row could not be
   * written at all, which is how those rules ended up falsified by hand with the
   * evidence only in a commit message.
   */
  const shellFound = shellSuites('tests');
  /*
   * A guard on the guard, of the kind `check-boundaries.sh` documents at length.
   * If the harness renames `test_case`, or the suites move, this collector
   * silently returns nothing — and every citation into a shell suite then
   * resolves against the empty set and is reported as missing. That failure is at
   * least loud. The quieter one is a suite that yields ZERO names while another
   * still yields some, so the count is asserted per suite rather than in total.
   */
  for (const [path, names] of shellFound) {
    if (names.length === 0) {
      process.stdout.write(
        `\x1b[31mfail\x1b[0m  ${path} declares no test_case names; this script cannot see its tests.\n`,
      );
      process.exit(1);
    }
    titlesByPath.set(path, names);
  }
  const everyTitle = [...titlesByPath.values()].flat();

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
  /** Tables with no header/separator pair, in which nothing at all was checked. */
  const unstructured = [];

  // Per RECORD, and every piece of table state is re-declared inside the loop.
  // Carrying `fenced`, `header` or `width` across a file boundary would let one
  // record's unterminated fence blank the start of the next one — the same
  // "silently checked nothing" failure this script's header comment is about.
  for (const record of RECORDS) {
    const lines = readFileSync(record, 'utf8').split('\n');
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
        const named =
          cited.file === null
            ? null
            : [...titlesByPath].filter(([path]) => path.endsWith(cited.file));
        const candidates = named === null ? everyTitle : named.flatMap(([, names]) => names);
        if (named !== null && named.length === 0) {
          missing.push(`${cited.name}  (no such file: ${cited.file})`);
        }
        // Matched against the TEST TITLES, not the file text.
        //
        // `includes` over the whole source made a `describe` name, a comment or a
        // sentence of prose satisfy "resolves to a committed test" — and one row
        // was doing exactly that. The guarantee this line prints has to be the one
        // it checks.
        // `includes` WITHIN a title, not within the file: an `it.each` title is
        // `'%s is reachable at ...'`, so the citation names a suffix of it.
        else if (!candidates.some((title) => title.includes(needle)))
          missing.push(`${cited.name}  (${cited.file ?? 'any file'})`);
      }
    }
  }

  if (
    missing.length > 0 ||
    unparsed.length > 0 ||
    unrecognised.length > 0 ||
    malformed.length > 0 ||
    unstructured.length > 0 ||
    only.length > 0 ||
    unresolvable.length > 0 ||
    duplicated.length > 0 ||
    staleCounts.length > 0
  ) {
    if (staleCounts.length > 0) {
      console.error(
        `\x1b[31mfail\x1b[0m  ${staleCounts.length} transcript(s) quote a citation count that is no longer this record's. Re-run them, or mark the row (then):`,
      );
      for (const row of staleCounts) console.error(`        ${row}`);
    }
    if (duplicated.length > 0) {
      console.error(
        `\x1b[31mfail\x1b[0m  ${duplicated.length} row label(s) name more than one rule, so a citation to them resolves to neither:`,
      );
      for (const label of duplicated) console.error(`        ${label}`);
    }
    if (unresolvable.length > 0) {
      console.error(
        `\x1b[31mfail\x1b[0m  ${unresolvable.length} skipping modifier(s) on a receiver this check cannot resolve, so the suites they park are invisible to it:`,
      );
      for (const site of unresolvable) console.error(`        ${site}`);
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
      console.error(
        `\x1b[31mfail\x1b[0m  ${missing.length} of ${checked} cited tests do not exist:`,
      );
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

  console.log(
    `\x1b[32mok\x1b[0m    ${checked} falsification citations resolve to a committed test`,
  );
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]))) {
  main();
}
