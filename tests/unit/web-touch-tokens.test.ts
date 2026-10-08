import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The rule the measurement holds the app to, at its source: on a coarse pointer both control
 * tokens are the 44px target. Reverting the block leaves every route failing
 * `pnpm web:responsive`; this keeps that from happening silently in the gate.
 */
describe('the touch tokens', () => {
  it('raise both control heights to 44px on a touch-only pointer, and only there', () => {
    const tokens = readFileSync(join(__dirname, '../../apps/web/src/styles/tokens.css'), 'utf8');
    const coarse = /@media \(pointer: coarse\) and \(hover: none\) \{\s*:root \{([^}]*)\}/.exec(
      tokens,
    );
    expect(coarse).not.toBeNull();
    expect(coarse?.[1]).toMatch(/--ctl-h:\s*44px/);
    expect(coarse?.[1]).toMatch(/--ctl-h-sm:\s*44px/);
    // The desk keeps its dense controls.
    expect(tokens).toMatch(/--ctl-h:\s*32px/);
  });

  it('scales for touch only where the primary pointer cannot hover, in every stylesheet', () => {
    const root = join(__dirname, '../../apps/web/src/styles');
    const files = [
      ...readdirSync(root).filter((name) => name.endsWith('.css')),
      ...readdirSync(join(root, 'pages')).map((name) => `pages/${name}`),
    ];
    for (const file of files) {
      const css = readFileSync(join(root, file), 'utf8');
      // A bare coarse query also matches an iPad with a trackpad showing the desk layout.
      expect(css, file).not.toMatch(/@media \(pointer: coarse\)\s*\{/);
    }
  });
});
