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

  /**
   * FIX-12: the targets `pnpm web:responsive` measured under 44px on eight routes, each
   * raised inside its stylesheet's touch-only block. The measurement needs Chromium and is
   * not in the gate; this keeps a revert of any one of them from passing it silently.
   */
  it.each([
    ['pages/dashboard.css', '.attn-link'],
    ['pages/commerce-b.css', '.aud-segment'],
    ['pages/commerce-a.css', '.c360-nav a'],
    ['pages/commerce-a.css', '.c360ws-half-head a'],
    ['pages/commerce-a.css', '.gh-links a:not(.btn)'],
    ['kit.css', '.card-head .actions a:not(.btn)'],
  ])('%s raises %s to the 44px target on touch', (file, selector) => {
    const css = readFileSync(join(__dirname, '../../apps/web/src/styles', file), 'utf8');
    const rules = touchRules(css);
    const rule = rules.find((r) => r.selectors.includes(selector));
    expect(rule, `${selector} is in no touch-only rule of ${file}`).toBeDefined();
    expect(rule?.body).toMatch(/min-height:\s*var\(--ctl-h\)/);
  });
});

/** Every rule inside the `(pointer: coarse) and (hover: none)` blocks of one stylesheet. */
function touchRules(css: string): { selectors: string[]; body: string }[] {
  const rules: { selectors: string[]; body: string }[] = [];
  const opener = '@media (pointer: coarse) and (hover: none) {';
  let at = css.indexOf(opener);
  while (at !== -1) {
    // The block's extent, by brace depth.
    let depth = 1;
    let i = at + opener.length;
    const start = i;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
    }
    const block = css.slice(start, i - 1).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      rules.push({
        selectors: match[1]!.split(',').map((selector) => selector.trim()),
        body: match[2]!,
      });
    }
    at = css.indexOf(opener, i);
  }
  return rules;
}
