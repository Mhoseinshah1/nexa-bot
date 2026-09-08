import { readFileSync } from 'node:fs';
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
const SOURCE = readFileSync('scripts/check-falsification-citations.mjs', 'utf8');
const HEAD = SOURCE.slice(0, SOURCE.indexOf('const cells = (row)'));

interface Checker {
  maskLiterals: (text: string) => string;
  withoutSkippedSuites: (text: string) => string;
  onlyMarkers: (text: string) => number[];
  titles: (text: string) => string[];
}

async function load(): Promise<Checker> {
  const exported = `${HEAD}\nexport { maskLiterals, withoutSkippedSuites, onlyMarkers, titles };`;
  return (await import(
    `data:text/javascript,${encodeURIComponent(exported)}`
  )) as unknown as Checker;
}

describe('the falsification checker, on sources that look like this repository', () => {
  it('leaves JSX alone', async () => {
    const { maskLiterals } = await load();
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
    const { maskLiterals } = await load();
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
    const { withoutSkippedSuites, titles } = await load();
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
    const { withoutSkippedSuites, titles } = await load();
    const source = `${prelude}('x', () => {\n  it('hidden', () => {});\n});\ndescribe('live', () => {\n  it('shown', () => {});\n});\n`;
    const kept = titles(withoutSkippedSuites(source));
    expect(kept).not.toContain('hidden');
    expect(kept).toContain('shown');
  });

  it('does not strip a suite that runs', async () => {
    const { withoutSkippedSuites, titles } = await load();
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
    const { onlyMarkers } = await load();
    expect(onlyMarkers(source)).not.toHaveLength(0);
  });

  it.each([
    ['// never write it.only( in a committed file\n', 'a comment'],
    ["const advice = 'it.only( is banned';\n", 'a string'],
    ['const re = /it\\.only\\(/;\n', 'a regex'],
  ])('does not report a .only that is only mentioned in %s', async (source) => {
    const { onlyMarkers } = await load();
    expect(onlyMarkers(source)).toHaveLength(0);
  });

  it('reads the real test tree without blanking any of it', async () => {
    const { maskLiterals } = await load();
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
