import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Migration P2: the legacy opening balance is MIGRATION-ONLY.
 *
 * It is the one writer allowed to take a wallet below zero, so no surface may reach it —
 * no controller, no Telegram handler, no web page. The composition root constructs it and
 * the importer (P7, HOLD) will be its one caller. This fails the day a surface imports it
 * or names the container member (`docs/migration-opening-balance.md`).
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('the migration opening balance boundary', () => {
  it('is reachable from no surface and no web page', () => {
    const files = [...sources('apps/api/src/surfaces'), ...sources('apps/web/src')];
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((file) =>
      /migration-opening-balance|migrationOpeningBalance|MigrationOpeningBalance/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
