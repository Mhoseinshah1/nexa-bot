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

  it('renders no QUERY view off a bare isError', () => {
    /*
     * MUTATIONS are exempt, and the distinction is the whole point.
     *
     * A mutation's `isError` reports one submission the operator just made:
     * there is no poll, no staleness and no "is this worth waiting through" —
     * it either failed or it did not, and the page says so beside the form.
     * A QUERY's `isError` is the ambiguous one, and it is the only one
     * `queryState` exists to interpret. Lumping them together would have this
     * scan demand a rewrite of eight correct error reports.
     */
    const queries = new Set<string>();
    for (const file of sources(ROOT)) {
      for (const match of file.text.matchAll(/const (\w+) = useQuery\(/g)) {
        queries.add(`${file.path}:${match[1]}`);
      }
    }
    const wrong: string[] = [];
    for (const file of sources(ROOT)) {
      if (file.path.endsWith('view-state.ts')) continue;
      file.text.split('\n').forEach((line, index) => {
        const match = /\{\s*(\w+)\.isError\s*&&/.exec(line);
        if (match === null) return;
        if (!queries.has(`${file.path}:${match[1]}`)) return;
        // `staleAfterError` on the same line IS asking the rule.
        if (line.includes('staleAfterError(')) return;
        wrong.push(`${file.path}:${index + 1}  ${line.trim()}`);
      });
    }
    expect(
      wrong,
      `these decide their own error state instead of asking queryState:\n${wrong.join('\n')}`,
    ).toEqual([]);
  });
});
