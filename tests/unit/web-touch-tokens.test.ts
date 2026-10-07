import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The rule the measurement holds the app to, at its source: on a coarse pointer both control
 * tokens are the 44px target. Reverting the block leaves every route failing
 * `pnpm web:responsive`; this keeps that from happening silently in the gate.
 */
describe('the touch tokens', () => {
  it('raise both control heights to 44px on a coarse pointer, and only there', () => {
    const tokens = readFileSync(join(__dirname, '../../apps/web/src/styles/tokens.css'), 'utf8');
    const coarse = /@media \(pointer: coarse\) \{\s*:root \{([^}]*)\}/.exec(tokens);
    expect(coarse).not.toBeNull();
    expect(coarse?.[1]).toMatch(/--ctl-h:\s*44px/);
    expect(coarse?.[1]).toMatch(/--ctl-h-sm:\s*44px/);
    // The desk keeps its dense controls.
    expect(tokens).toMatch(/--ctl-h:\s*32px/);
  });
});
