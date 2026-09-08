import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The citation checker, tested rather than transcribed.
 *
 * `scripts/check-falsification-citations.mjs` had no test at all. 269 of its
 * lines were rewritten in one commit, verified only by hand-run transcripts
 * pasted into the record — and two of its rules died silently in that rewrite.
 *
 * The one that matters: `startsRegex` returned true for a `/` preceded by `<`
 * or `"`. Those are JSX — `</QueryClientProvider>` and `display="…" />` — so
 * `endOfRegex` ran to the newline, returned END OF FILE, and `maskLiterals`
 * blanked everything after it. Four of 113 test sources went dark from some
 * line onwards, including two the same commit was editing, and a
 * `describe.skip` on the suite holding that commit's own falsification rows
 * printed `ok 213`, exit 0. The PARENT commit's checker caught it.
 *
 * A hand-run transcript cannot notice that, because the transcript is run on
 * the file the author is looking at. These are.
 *
 * The module's head is imported directly — everything above `const cells`,
 * which is where the top-level script body begins — so the pure functions can
 * be exercised without running the check itself.
 */
/*
 * Imported, not sliced.
 *
 * This used to read the script, cut it at `const cells`, and import the prefix
 * through a `data:text/javascript` URL. That tested a text-derived
 * approximation of the module rather than the module — and it broke outright
 * the moment masking started using the TypeScript parser, because a data URL
 * cannot resolve a bare specifier. The script exports its pure functions and
 * guards its entry point, so this is an ordinary import.
 */
import {
  maskLiterals,
  onlyMarkers,
  recordIssues,
  titles,
  unresolvedModifiers,
  withoutSkippedSuites,
} from '../../scripts/check-falsification-citations.mjs';

/*
 * The import is TYPED, and this is what says so.
 *
 * `tsconfig.tests.json` turns on `allowJs` so TypeScript infers the script's
 * exports from the script itself. A comment claiming that is not evidence: a
 * `.d.mts` returning `any`, or `allowJs` traded for a blanket suppression,
 * would leave every assertion below compiling and meaning nothing.
 *
 * `@ts-expect-error` fails the BUILD when the line beneath it stops being an
 * error, so it holds the claim in both directions — and `pnpm typecheck` is
 * where it is checked, not the runner.
 */
// @ts-expect-error `titles` returns an array of strings, not a number.
const TYPED_IMPORT_PROBE: number = titles('const a = 1;\n', 'probe.ts');
void TYPED_IMPORT_PROBE;

describe('the falsification checker, on sources that look like this repository', () => {
  it('leaves JSX alone', async () => {
    const jsx = [
      'const ui = (',
      '  <Providers client={client}>',
      '    <App display="0x8f3a" />',
      '  </Providers>',
      ');',
      "describe('a live suite', () => {",
      "  it('a live test', () => {});",
      '});',
    ].join('\n');
    const masked = maskLiterals(jsx);

    // The whole point: nothing after a closing tag or a self-closing tag is
    // blanked, so both scanners can still see the suite below them.
    expect(masked).toHaveLength(jsx.length);
    expect(masked).toContain("describe('");
    expect(masked.split('\n')).toHaveLength(jsx.split('\n').length);
  });

  it('keeps offsets and line numbers exact', async () => {
    const text = "const a = 'one';\nconst b = `two`;\n// three\nconst c = /re/;\n";
    const masked = maskLiterals(text);
    expect(masked).toHaveLength(text.length);
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '\n') expect(masked[i]).toBe('\n');
    }
  });

  it.each([
    ["describe.skip('x', () => {", 'the plain spelling'],
    ["describe['skip']('x', () => {", 'a bracket key'],
    ["describe /*c*/ .skip('x', () => {", 'a comment in the chain'],
    ["describe?.skip('x', () => {", 'optional chaining'],
    ["describe.skipIf(true)('x', () => {", 'a conditional skip'],
  ])('strips a suite skipped by %s', async (opener) => {
    const source = `${opener}\n  it('hidden', () => {});\n});\ndescribe('live', () => {\n  it('shown', () => {});\n});\n`;
    const kept = titles(withoutSkippedSuites(source));
    expect(kept).not.toContain('hidden');
    // …and ONLY that suite. A strip that runs to end of file passes the first
    // assertion and destroys the record; that was round 28's defect.
    expect(kept).toContain('shown');
  });

  it.each([
    ['const zz = describe.skip;\nzz', 'an alias of a skipping chain'],
    ['const zz = describe;\nzz.skip', 'an alias of describe itself'],
    ['const { skip } = describe;\nskip', 'a destructured modifier'],
    ['const $d = describe.skip;\n$d', 'an alias named with a dollar'],
    ['let d;\nd = describe.skip;\nd', 'a later assignment'],
  ])('strips a suite hidden behind %s', async (prelude) => {
    const source = `${prelude}('x', () => {\n  it('hidden', () => {});\n});\ndescribe('live', () => {\n  it('shown', () => {});\n});\n`;
    const kept = titles(withoutSkippedSuites(source));
    expect(kept).not.toContain('hidden');
    expect(kept).toContain('shown');
  });

  it('does not strip a suite that runs', async () => {
    const source =
      "describe.onlyish('x', () => {\n  it('shown', () => {});\n});\n" +
      "const describeThing = 1;\ndescribe.each([1])('y %s', () => {\n  it('also shown', () => {});\n});\n";
    const kept = titles(withoutSkippedSuites(source));
    expect(kept).toContain('shown');
    expect(kept).toContain('also shown');
  });

  it.each([
    ["it.only('x', () => {});", 'dot notation'],
    ["it['only']('x', () => {});", 'a bracket key'],
    ["it /*c*/ .only('x', () => {});", 'a comment in the chain'],
    ["it.only.each([1])('x %s', () => {});", 'a chained each'],
    ["it['on' + 'ly']('x', () => {});", 'a computed key'],
  ])('reports a .only written as %s', async (source) => {
    expect(onlyMarkers(source)).not.toHaveLength(0);
  });

  it.each([
    ['// never write it.only( in a committed file\n', 'a comment'],
    ["const advice = 'it.only( is banned';\n", 'a string'],
    ['const re = /it\\.only\\(/;\n', 'a regex'],
  ])('does not report a .only that is only mentioned in %s', async (source) => {
    expect(onlyMarkers(source)).toHaveLength(0);
  });

  /**
   * The two halves of the masking guard, pinned SEPATELY.
   *
   * Round 32's row `AA1` reverted `startsRegex` and `endOfRegex` together and
   * called that a falsification. It was not: with either half in place the
   * other is unreachable, so each could be reverted on its own with the whole
   * gate green. Two rules need two tests.
   */
  it('recognises a regex in a concise arrow body', async () => {
    // `>` must open a regex, because `=>` does. Without it the `'` inside the
    // character class opens a phantom string.
    const text = `const quoted = (v: string) => /['"]/.test(v);\n`;
    const masked = maskLiterals(text);
    expect(masked).toContain('=> /');
    // The body is spaces between the two slashes — which is only true if the
    // `/` was read as opening a regex at all.
    expect(masked, 'the regex body must be blanked, proving it was read').toMatch(/\/ +\//);
    expect(masked, 'and the quotes inside it must be gone').not.toContain('\'"');
  });

  it('lets an unterminated quote blank nothing past its own line', async () => {
    // A `'` or `"` string cannot span a line. If the scan may run past one, a
    // single mis-read quote takes the rest of the file with it.
    const text =
      "const broken = 'no closing quote on this line\n" +
      "describe.skip('x', () => {\n  it('hidden', () => {});\n});\n" +
      "describe('live', () => {\n  it('shown', () => {});\n});\n";
    const kept = titles(withoutSkippedSuites(text));
    expect(kept).not.toContain('hidden');
    expect(kept).toContain('shown');
  });

  it('treats an alias of bare describe as describe, not as always-skipping', async () => {
    // `const zz = describe` needs a skipping link of its own. Round 32 stated
    // that and nothing tested it, so reverting to "any alias always skips"
    // stayed green.
    const text = "const zz = describe;\nzz('live', () => {\n  it('shown', () => {});\n});\n";
    expect(titles(withoutSkippedSuites(text))).toContain('shown');
  });

  it('finds a suite skipped through an import rename', async () => {
    const text =
      "import { describe as d } from 'vitest';\n" +
      "d.skip('x', () => {\n  it('hidden', () => {});\n});\n" +
      "describe('live', () => {\n  it('shown', () => {});\n});\n";
    const kept = titles(withoutSkippedSuites(text));
    expect(kept).not.toContain('hidden');
    expect(kept).toContain('shown');
  });

  it('does not resolve a citation against an it( written in prose', async () => {
    /*
     * `titles` is the ONE reader in that script that ran over the raw source
     * while every other ran over the mask, so an `it('…')` inside a comment or
     * a string counted as a committed test — "resolves to prose, not to a
     * test", which is the failure the script exists to prevent and which its
     * own header comment claimed to have removed.
     *
     * Matching on the mask cannot read the title, because the title IS a
     * string literal and the mask blanks it. The offsets come from the mask
     * and the text from the source, so the real titles below are still exact —
     * including a printf placeholder and a template literal, which is what a
     * naive "read the mask" fix would have returned blank.
     */
    const prose =
      "// it('a phantom in a comment', () => {});\n" +
      'const advice = "write it(\'a phantom in a string\', fn)";\n' +
      "/* it('a phantom in a block', () => {}); */\n" +
      "it('a real test', () => {});\n" +
      "it.each([1])('a real %s test', () => {});\n" +
      'it(`a real template title`, () => {});\n';
    expect(titles(prose, 'a.ts')).toEqual([
      'a real test',
      'a real %s test',
      'a real template title',
    ]);
  });

  it('reports a skip on a receiver it cannot resolve, rather than ignoring it', async () => {
    /*
     * The one alias shape a single-file scan cannot follow: a default import
     * of a local helper that re-exports `describe`. `d.skip('x', …)` contains
     * no token this file can bind, so the parked suite is invisible and its
     * titles resolve as though they run — measured: `['hidden', 'shown']`.
     *
     * Following it needs the other file. Refusing to be silently wrong about
     * it does not, and that is what is asserted: reported, not guessed at.
     */
    const opaque =
      "import d from './helpers';\n" +
      "d.skip('x', () => {\n  it('hidden', () => {});\n});\n" +
      "describe('live', () => {\n  it('shown', () => {});\n});\n";
    expect(unresolvedModifiers(opaque, 'a.ts')).toEqual(['2  d.skip(']);
    // And the shapes it CAN resolve are not reported. A guard that fires on
    // `describe.skip` would be turned off within a day.
    const namespaced =
      "import * as v from 'vitest';\n" +
      "v.describe.skip('x', () => {\n  it('hidden', () => {});\n});\n";
    expect(unresolvedModifiers(namespaced, 'a.ts')).toEqual([]);
    const renamed =
      "import { describe as zz } from 'vitest';\nzz.skip('x', () => {\n  it('hidden', () => {});\n});\n";
    expect(unresolvedModifiers(renamed, 'a.ts')).toEqual([]);
    // Prose quoting one is not one either — the guard reads the MASK.
    expect(unresolvedModifiers("const advice = 'never write d.skip(x)';\n", 'a.ts')).toEqual([]);
  });

  it('finds no unresolvable modifier in the committed test tree', async () => {
    /*
     * The claim that makes the guard worth having: it is green across the
     * WHOLE tree today, so a red run is a new alias rather than a backlog
     * somebody learns to scroll past.
     *
     * Over the tree, not over one file. The first version of this named the
     * tree in its title and read `falsification-checker.test.ts` alone — a
     * fixture that cannot see the thing it claims to have checked, which is
     * the defect this file is full of corrections for.
     */
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return walk(path);
        return /\.tsx?$/.test(entry) ? [path] : [];
      });
    const files = walk('tests');
    expect(files.length).toBeGreaterThan(80);
    const reported = files.flatMap((path) =>
      unresolvedModifiers(readFileSync(path, 'utf8'), path).map((site) => `${path}:${site}`),
    );
    expect(reported).toEqual([]);
  });

  it('reads a literal bracket key rather than calling everything computed', async () => {
    // `describe['skip']` is a skip, not a `.only`. Renaming the sentinel and
    // leaving the re-read guard behind made the checker report a `.only`
    // marker on a line that has none.
    expect(onlyMarkers("describe['skip']('x', () => {});")).toHaveLength(0);
    expect(onlyMarkers("it['each']([1])('x %s', () => {});")).toHaveLength(0);
    expect(onlyMarkers("it['only']('x', () => {});")).not.toHaveLength(0);
  });

  describe('the record-level checks', () => {
    const table = (rows: string) => `| #   | rule |\n| --- | ---- |\n${rows}`;

    it('reports a label that names two rules', async () => {
      const issues = recordIssues(table('| Z1 | one |\n| Z1 | two |\n'), 10);
      expect(issues.duplicated).toEqual(['Z1']);
    });

    it('reports a digit-less duplicate too', async () => {
      expect(recordIssues(table('| VX | one |\n| VX | two |\n'), 10).duplicated).toEqual(['VX']);
    });

    it('does not read a fenced illustration as a row', async () => {
      const record = table('| Z1 | one |\n') + '\n```\n| Z1 | an illustration |\n```\n';
      expect(recordIssues(record, 10).duplicated).toEqual([]);
    });
    it('does not read a count quoted inside a fence', async () => {
      /*
       * The fixture above passes with fence tracking DELETED, because a fence
       * opener is itself a non-`|` line and the `#`-table gate suppresses the
       * row anyway. The stale-count check has no such gate, so this is where
       * fence tracking is actually load-bearing — and it had no fixture.
       */
      const record = table('| Z1 | one |\n') + '\n```\n| Z1 | prints ok 42 |\n```\n';
      expect(recordIssues(record, 10).staleCounts).toEqual([]);
    });

    it('exempts a row only when (then) ends its cell', async () => {
      const { staleCounts } = recordIssues(
        table('| Z1 | a title saying "leaves a row marked (then) alone" prints ok 42 |\n'),
        10,
      );
      expect(staleCounts, 'the marker must be deliberate, not a phrase in a title').toHaveLength(1);
    });

    it('does not treat a capitalised word as a label outside a # table', async () => {
      const record = '| verdict | what |\n| --- | ---- |\n| Green | one |\n| Green | two |\n';
      expect(recordIssues(record, 10).duplicated).toEqual([]);
    });

    it('reports a transcript quoting a superseded count', async () => {
      expect(recordIssues(table('| Z1 | prints ok 42 |\n'), 10).staleCounts).toHaveLength(1);
      expect(recordIssues(table('| Z1 | prints ok 10 |\n'), 10).staleCounts).toHaveLength(0);
    });

    it('leaves a row marked (then) alone, and does not read "took" as "ok"', async () => {
      expect(recordIssues(table('| Z1 | prints ok 42 (then) |\n'), 10).staleCounts).toHaveLength(0);
      expect(recordIssues(table('| Z1 | the suite took 812 ms |\n'), 10).staleCounts).toHaveLength(
        0,
      );
    });
  });

  /**
   * The three inputs that defeated three successive hand-rolled lexers.
   *
   * r31 blanked from every JSX closing tag to EOF. r32's allow-list missed
   * `>`, so an arrow-body regex opened a phantom string. r33 bounded `'`/`"`
   * to a line, which is false in TSX: a JSX attribute spans lines freely, so
   * its text was read as code and a backtick in it opened a phantom TEMPLATE
   * — 5169 characters over 409 lines, with a `describe.skip` reported `ok`.
   *
   * The parser ends the class. These are the fixtures each round would have
   * needed and did not have.
   */
  it('is not fooled by a JSX attribute that spans lines', async () => {
    const source =
      'const hint = (\n  <p\n    title="press the ` key\n      to open it"\n  >\n    x\n  </p>\n);\n' +
      "describe.skip('x', () => {\n  it('hidden', () => {});\n});\n" +
      "describe('live', () => {\n  it('shown', () => {});\n});\n";
    const kept = titles(withoutSkippedSuites(source, 'a.tsx'), 'a.tsx');
    expect(kept).not.toContain('hidden');
    expect(kept).toContain('shown');
  });

  it('does not read an it.only written out as JSX TEXT', async () => {
    /*
     * TWO earlier versions of this fixture could not fail, for two different
     * reasons, and both passed a green suite.
     *
     * The first put a backtick in JSX text — the parser already knows that
     * text is not a template. The second quoted `describe.skip(...)` and
     * asserted the live suite below survived, which it does either way: the
     * strip runs from the quoted `describe` to its own closing paren, inside
     * the prose, and never reaches the suite. Both were written against
     * `titles`, and `titles` reads the RAW text.
     *
     * The mask feeds the CHAIN READERS, so that is the only place it can be
     * falsified. Prose quoting `it.only(` is reported as a real marker with
     * JsxText blanking removed — measured: `[]` becomes `[1]` — and one
     * `.only` makes every citation in the record unverifiable.
     */
    const source =
      'export const Help = () => <p>never write it.only(x) — it skips the rest</p>;\n' +
      "describe('live', () => {\n  it('shown', () => {});\n});\n";
    expect(onlyMarkers(source, 'a.tsx')).toEqual([]);
    expect(titles(withoutSkippedSuites(source, 'a.tsx'), 'a.tsx')).toContain('shown');
  });

  it('reads a .ts file as TypeScript rather than as TSX', async () => {
    /*
     * Parsing everything as TSX misreads a `.ts` file's angle brackets and
     * blanks the "JSX text" between them. THREE versions of this fixture
     * could not fail: a generic CALL parses the same in both modes, and
     * `<Row>one;` blanks only as far as the next `{`, which the following
     * `describe(` supplies before any `it(` is reached.
     *
     * A generic ARROW is what separates them, and the damage is not a lost
     * title but a FALSE NEGATIVE: the `describe.skip` below sits inside the
     * blanked run, so the parked suite is never stripped and its title
     * resolves as though it runs — a citation into a suite nobody executes,
     * which is the one failure mode this script exists to prevent. Measured
     * with the kind forced to TSX: `['never runs', 'runs']`.
     */
    const source =
      'const f = async <T>(x: T): Promise<T> => x;\n' +
      "describe.skip('parked', () => {\n  it('never runs', () => {});\n});\n" +
      "it('runs', () => {});\n";
    const kept = titles(source, 'a.ts');
    expect(kept).not.toContain('never runs');
    expect(kept).toContain('runs');
  });

  it('does not read an it.only written out inside a template literal', async () => {
    /*
     * The same correction as the JSX-text fixture, one literal over, and the
     * previous version could not fail for the same reason: a quoted
     * `describe.skip` strips only itself. Measured with
     * `NoSubstitutionTemplateLiteral` removed from the blanked kinds: `[]`
     * becomes `[1]`.
     */
    const source = 'const doc = `never write it.only(x) here`;\nvoid doc;\n';
    expect(onlyMarkers(source, 'a.ts')).toEqual([]);
  });

  it('blanks all three parts of an interpolated template, not just a plain one', async () => {
    /*
     * `TemplateHead`, `TemplateMiddle` and `TemplateTail` are three separate
     * SyntaxKinds. A set carrying only `NoSubstitutionTemplateLiteral` passes
     * the fixture above while leaving every INTERPOLATED template readable as
     * code — and an interpolated template is the common one in this codebase
     * (157 of 249 sources change under that mutation). Measured with the
     * three parts removed: each of these reports `[1]`.
     */
    const head = 'const doc = `never write it.only(x) before ${n}`;\nvoid doc;\n';
    const middle = 'const doc = `${a} never write it.only(x) between ${b}`;\nvoid doc;\n';
    const tail = 'const doc = `${n} and never write it.only(x)`;\nvoid doc;\n';
    for (const source of [head, middle, tail]) {
      expect(onlyMarkers(source, 'a.ts')).toEqual([]);
    }
  });

  it('does not report a .only mentioned in a multi-line JSX attribute', async () => {
    const source =
      'export const warning = (\n  <p\n    title="never write it.only( here\n      — it skips the rest"\n  >\n    x\n  </p>\n);\n';
    expect(onlyMarkers(source, 'a.tsx')).toHaveLength(0);
  });

  it('reads the real test tree without blanking any of it', async () => {
    // The regression, asserted over the actual sources rather than a sample.
    const files = ['tests/web/shell-recovery.test.tsx', 'tests/web/harness.tsx'];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const masked = maskLiterals(text);
      const all = (text.match(/\bdescribe\s*\(/g) ?? []).length;
      const seen = (masked.match(/\bdescribe\s*\(/g) ?? []).length;
      expect(seen, `${file} lost describe( calls to masking`).toBe(all);
    }
  });
});
