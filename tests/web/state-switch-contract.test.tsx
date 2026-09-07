import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every `StateSwitch` says whether its data is stale, and every `queryState`
 * call is handed a real query.
 *
 * Asserted over the SOURCES, because the way this comes back is somebody adding
 * a nineteenth call site, not somebody editing a rendered screen a test happens
 * to cover. Eighteen sites existed when this was written and exactly one of
 * them — the panel detail — was covered by a rendering test; deleting
 * `stale={...}` from the other seventeen left 264 of 264 green, and on four of
 * the files it would not even have shown up as an unused import.
 *
 * That is the shape of the defect this branch keeps rediscovering: a rule
 * applied at the screen somebody was looking at, and nowhere else.
 */
const SOURCES = 'apps/web/src/pages';

function pages(): { path: string; text: string }[] {
  return readdirSync(SOURCES)
    .filter((entry) => entry.endsWith('.tsx'))
    .map((entry) => ({
      path: join(SOURCES, entry),
      text: readFileSync(join(SOURCES, entry), 'utf8'),
    }));
}

describe('the StateSwitch contract', () => {
  it('finds the call sites it is meant to be checking', () => {
    const total = pages().reduce(
      (count, page) => count + (page.text.match(/queryState\(/g) ?? []).length,
      0,
    );
    // One of these is the definition in `dashboard.tsx`. A scan that matched
    // nothing would pass every assertion below it.
    expect(total).toBeGreaterThan(15);
  });

  it('passes stale beside every queryState', () => {
    const missing: string[] = [];
    for (const page of pages()) {
      const lines = page.text.split('\n');
      lines.forEach((line, index) => {
        if (!line.includes('queryState(') || line.includes('export function')) return;
        // The prop may sit on either side of the state prop, so a small window
        // around the call is what is read rather than the line alone.
        const window = lines.slice(Math.max(0, index - 2), index + 4).join('\n');
        if (!window.includes('stale=')) missing.push(`${page.path}:${index + 1}`);
      });
    }
    expect(
      missing,
      `these StateSwitch call sites say nothing when their data is stale:\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});
