import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Roadmap B7: the colour tokens meet WCAG AA (4.5:1) for text, in both themes, on every
 * surface text is drawn on. Computed from `tokens.css` itself, so a token edited back to a
 * lower-contrast value fails here rather than on an operator's screen.
 */

const TOKENS = readFileSync(join(__dirname, '../../apps/web/src/styles/tokens.css'), 'utf8');

function theme(selector: string): Record<string, string> {
  const at = TOKENS.indexOf(selector);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const block = TOKENS.slice(at, TOKENS.indexOf('}', at));
  const out: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/gi)) {
    out[name!] = value!;
  }
  return out;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const TEXT = ['fg', 'fg-2', 'fg-3', 'accent', 'ok', 'warn', 'danger'] as const;
const SURFACES = ['bg-0', 'bg-1', 'bg-2', 'bg-3'] as const;

describe.each([
  ['dark', ":root[data-theme='dark']"],
  ['light', ":root[data-theme='light']"],
])('the %s theme', (_name, selector) => {
  const tokens = theme(selector);

  it.each(TEXT)('draws --%s at 4.5:1 or more on every surface', (text) => {
    for (const surface of SURFACES) {
      expect(
        contrast(tokens[text]!, tokens[surface]!),
        `--${text} on --${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('draws text on the solid fills at 4.5:1 or more', () => {
    expect(contrast(tokens['accent-fg']!, tokens.accent!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens['on-danger']!, tokens.danger!)).toBeGreaterThanOrEqual(4.5);
  });
});
