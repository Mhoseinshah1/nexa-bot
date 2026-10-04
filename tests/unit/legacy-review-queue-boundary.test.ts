import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Program 4 Item 9: the legacy-import manual review queue is MIGRATION-ONLY.
 *
 * It closes import decisions under `maintenance.run`, as the P7 CLI's `SYSTEM_JOB`, and no
 * HTTP controller, Telegram handler or web page may reach it — nor the legacy-import module
 * at all (`docs/legacy-import-metadata.md`). This fails the day a surface imports either or
 * names the container member, as `migration-only-boundary.test.ts` does for the opening
 * balance.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('the legacy review queue boundary', () => {
  it('is reachable from no surface and no web page', () => {
    const files = [...sources('apps/api/src/surfaces'), ...sources('apps/web/src')];
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((file) =>
      /legacy-review-queue|legacyReviewQueue|LegacyReviewQueue|modules\/platform\/legacy-import/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
