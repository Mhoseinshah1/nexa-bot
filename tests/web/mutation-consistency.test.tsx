import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Mutation consistency across the Web Admin (roadmap B3).
 *
 * One idempotency key per LOGICAL attempt: the same key across the client's automatic retry
 * (`query-client.ts`) and across an operator's re-press after a failure that left the outcome
 * unknown, and a new key once the server has answered. `useSubmissionKey` is the one
 * implementation of that lifecycle; a page that calls `newIdempotencyKey()` itself gets a
 * fresh key per call — inside `mutationFn` even the automatic retry of a 5xx changed key,
 * which is how a backup run, a recovery confirmation and a recovery-kit import could each be
 * sent twice as two commands.
 */

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');
const PAGES = join(REPO_ROOT, 'apps/web/src/pages');

/**
 * Pages allowed to mint keys themselves, each with the reason. Keep this short: a new entry
 * needs the same justification.
 */
const MINTS_ITS_OWN_KEY: Readonly<Record<string, string>> = {
  // «درخواست پیش‌نویس»: a second press is deliberately a second draft request, and the
  // button is disabled while a draft is queued, so a duplicate cannot be produced unseen.
  'support-assist.tsx': 'a second press is a second draft by design',
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.tsx') || name.endsWith('.ts') ? [path] : [];
  });
}

describe('idempotency keys on the Web Admin pages', () => {
  it('come from useSubmissionKey, never from newIdempotencyKey() at the call site', () => {
    const offenders = sources(PAGES)
      .filter((path) => MINTS_ITS_OWN_KEY[relative(PAGES, path)] === undefined)
      .filter((path) => /newIdempotencyKey\(\)/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(REPO_ROOT, path));
    expect(offenders).toEqual([]);
  });

  it('are never minted inside a mutationFn, where the automatic retry re-runs it', () => {
    const offenders: string[] = [];
    for (const path of sources(PAGES)) {
      const text = readFileSync(path, 'utf8');
      for (const found of text.matchAll(/mutationFn:/g)) {
        const rest = text.slice(found.index);
        const end = rest.search(/\n\s+on(Success|Error|Settled|Mutate):|\n\s*\}\);/);
        const body = end === -1 ? rest : rest.slice(0, end);
        if (/newIdempotencyKey\(\)/.test(body)) offenders.push(relative(REPO_ROOT, path));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('lists only allowances that are still used', () => {
    for (const name of Object.keys(MINTS_ITS_OWN_KEY)) {
      expect(readFileSync(join(PAGES, name), 'utf8'), name).toMatch(/newIdempotencyKey\(\)/);
    }
  });
});
