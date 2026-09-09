import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * No query-driven view decides its own states.
 *
 * `StateSwitch` now takes the QUERY and derives the state, the staleness and
 * the retry from it, so the three cannot disagree and TypeScript refuses a call
 * site that omits it. That removes by construction what the previous version of
 * this file tried and failed to assert: it grepped for the token `stale=`, so
 * `stale={false}` at all eighteen sites passed, a site wired to a DIFFERENT
 * query than its state passed, and a call site one directory over was invisible.
 *
 * What types cannot catch is a view that never uses `StateSwitch` at all. One
 * did — the notification detail rendered `{q.isError && …}` beside `{q.data &&
 * …}`, which kept a stale list through a FINAL refusal and offered a retry that
 * could only be refused again. `isError` does not distinguish a blip from an
 * answer, and that is the whole rule. So the scan is aimed there instead.
 */
const ROOT = 'apps/web/src';

function sources(dir: string): { path: string; text: string }[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(path) ? [{ path, text: readFileSync(path, 'utf8') }] : [];
  });
}

describe('the query-view contract', () => {
  it('finds the sources it is meant to be checking', () => {
    const files = sources(ROOT);
    // A scan over an empty tree passes every assertion beneath it.
    expect(files.length).toBeGreaterThan(15);
    expect(files.some((file) => file.path.endsWith('ui/kit.tsx'))).toBe(true);
    expect(files.filter((file) => file.text.includes('<StateSwitch')).length).toBeGreaterThan(5);
  });

  it('hands StateSwitch a query rather than a state it computed', () => {
    const wrong: string[] = [];
    for (const file of sources(ROOT)) {
      file.text.split('\n').forEach((line, index) => {
        // Prose describing the old shape is not the old shape. Only JSX.
        if (line.trimStart().startsWith('*')) return;
        if (/\bstate=\{/.test(line) || /\bstale=\{/.test(line)) {
          wrong.push(`${file.path}:${index + 1}  ${line.trim()}`);
        }
      });
    }
    expect(wrong, `these pass a computed state instead of the query:\n${wrong.join('\n')}`).toEqual(
      [],
    );
  });

  it('renders no view off a bare isError unless it is a mutation', () => {
    /*
     * FAIL CLOSED. Everything is a query unless proved a mutation.
     *
     * The first version of this exemption did the opposite — it flagged only
     * names matched by `const X = useQuery(` IN THE SAME FILE, so everything
     * else was exempt by default, including a genuine polled query arriving as
     * a prop. Inserting `{query.isError && …}` into `AttentionCard`, which is
     * exactly that, left the scan green. An exemption that fails open exempts
     * the cases nobody thought of, which are the ones a scan is for.
     *
     * A mutation's `isError` reports one submission the operator just made:
     * no poll, no staleness, nothing to interpret. That is the only exemption,
     * and it has to be earned by a `useMutation` in the same file.
     */
    const mutations = new Set<string>();
    for (const file of sources(ROOT)) {
      for (const match of file.text.matchAll(/const (\w+) = useMutation\(/g)) {
        mutations.add(`${file.path}:${match[1]}`);
      }
    }
    const wrong: string[] = [];
    /*
     * ONE pattern, over the whole file rather than line by line.
     *
     * Three separate line-anchored regexes had let four spellings through, one
     * per round, and the fifth was `{!detail.isError ? … : null}` — the
     * negated TERNARY, which the negated pattern missed because it demanded
     * `&&`, and the un-negated one missed because of the `!`. Adding a fourth
     * regex would have been the fifth instance of the same mistake.
     *
     * Line-anchoring was the other half of it. Prettier breaks a long JSX
     * condition after the operand, so `{!detail.isError &&` and its `&&` can
     * end up on different lines and a line-by-line scan sees neither. `\s*`
     * over the whole text spans that; the line number is recovered from the
     * match offset for the report.
     */
    const spelling = /\{\s*(!\s*)?(\w+)\s*\.\s*(?:isError\s*[&?]|status\s*!?==\s*'error')/g;
    for (const file of sources(ROOT)) {
      if (file.path.endsWith('view-state.ts')) continue;
      for (const match of file.text.matchAll(spelling)) {
        const name = match[2] as string;
        if (mutations.has(`${file.path}:${name}`)) continue;
        // The offset of the NAME, not of the `{`. A split condition puts the
        // brace on a line of its own, and reporting `alerts.tsx:600  {` tells
        // the reader nothing about what was found.
        const index = (match.index ?? 0) + match[0].indexOf(name);
        const start = file.text.lastIndexOf('\n', index) + 1;
        const lineEnd = file.text.indexOf('\n', index);
        const line = file.text.slice(start, lineEnd === -1 ? undefined : lineEnd);
        // Prose describing the old shape is not the old shape.
        if (line.trimStart().startsWith('*')) continue;
        // `staleAfterError` on the same line IS asking the rule.
        if (line.includes('staleAfterError(')) continue;
        wrong.push(`${file.path}:${file.text.slice(0, index).split('\n').length}  ${line.trim()}`);
      }
    }
    expect(
      wrong,
      `these decide their own error state instead of asking queryState:\n${wrong.join('\n')}`,
    ).toEqual([]);
  });

  /*
   * What this scan CANNOT catch, stated rather than implied.
   *
   * A view that renders `{q.data && …}` and mentions no error at all has no
   * spelling to match — and that was a live defect in `content.tsx`'s revision
   * pane, found by a reviewer and not by this file. A scan over spellings
   * cannot find an absence. The types catch a missing `query` prop on
   * `StateSwitch`; nothing mechanical catches a query that was never given one.
   */
});
