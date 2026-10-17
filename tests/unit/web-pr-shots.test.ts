import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OUT_DIR, PR_SHOTS, shotFile } from '../../scripts/web-shots/pr-shots.mjs';

/**
 * `pnpm web:pr-shots` against what is committed: the pictures in the demo-implementation
 * folder are exactly the ones the script makes, and the README names every shot — so a
 * picture nobody can regenerate, or one the README does not explain, fails here.
 */
describe('the committed Web Admin screenshots', () => {
  const dir = join(__dirname, '../..', OUT_DIR);
  const expected = PR_SHOTS.flatMap((shot) => shot.views.map((view) => shotFile(shot.name, view)));

  it('names a file by shot, width and theme', () => {
    expect(shotFile('incident', { width: 1440, theme: 'dark' })).toBe('incident.1440-dark.jpg');
    expect(shotFile('users', { width: 390, theme: 'dark' })).toBe('users.390-dark.jpg');
  });

  it('commits exactly the pictures the script makes', () => {
    const committed = readdirSync(dir).filter((file) => file.endsWith('.jpg'));
    expect(committed.sort()).toEqual([...expected].sort());
  });

  it('lists every shot in the README table', () => {
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    for (const shot of PR_SHOTS) expect(readme).toContain(`\`${shot.name}.*\``);
  });
});
