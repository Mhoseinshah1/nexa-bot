import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Roadmap B7: the colour tokens meet WCAG AA (4.5:1) for text, in both themes, wherever
 * that text is drawn:
 *
 * - every text token on every surface, bg-0 to bg-4;
 * - every tone as a badge: the tone's text on its own `-soft` tint, composited over the
 *   surfaces a badge sits on (bg-0 to bg-3);
 * - the text token drawn on each solid fill (`--accent-fg`, `--on-danger`, `--on-warn`).
 *
 * Computed from `tokens.css` itself, so a token edited back to a lower-contrast value fails
 * here rather than on an operator's screen.
 */

const TOKENS = readFileSync(join(__dirname, '../../apps/web/src/styles/tokens.css'), 'utf8');

type Rgb = readonly [number, number, number];

function theme(selector: string): {
  hex: Record<string, Rgb>;
  alpha: Record<string, Rgb & { a?: number }>;
} {
  const at = TOKENS.indexOf(selector);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const block = TOKENS.slice(at, TOKENS.indexOf('}', at));
  const hex: Record<string, Rgb> = {};
  for (const [, name, value] of block.matchAll(/--([a-z0-9-]+):\s*#([0-9a-f]{6});/gi)) {
    hex[name!] = [0, 2, 4].map((i) => parseInt(value!.slice(i, i + 2), 16)) as unknown as Rgb;
  }
  const alpha: Record<string, Rgb & { a?: number }> = {};
  for (const [, name, r, g, b, a] of block.matchAll(
    /--([a-z0-9-]+):\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\);/gi,
  )) {
    alpha[name!] = Object.assign([Number(r), Number(g), Number(b)] as unknown as Rgb, {
      a: Number(a),
    });
  }
  return { hex, alpha };
}

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function over(tint: Rgb & { a?: number }, base: Rgb): Rgb {
  const a = tint.a ?? 1;
  return [0, 1, 2].map((i) => tint[i]! * a + base[i]! * (1 - a)) as unknown as Rgb;
}

const TEXT = ['fg', 'fg-2', 'fg-3', 'accent', 'ok', 'warn', 'danger', 'info', 'violet', 'teal'];
const SURFACES = ['bg-0', 'bg-1', 'bg-2', 'bg-3', 'bg-4'];
const BADGE_TONES = ['accent', 'ok', 'warn', 'danger', 'info', 'violet', 'teal'];
const BADGE_SURFACES = ['bg-0', 'bg-1', 'bg-2', 'bg-3'];

describe.each([
  ['dark', ":root[data-theme='dark']"],
  ['light', ":root[data-theme='light']"],
])('the %s theme', (_name, selector) => {
  const { hex, alpha } = theme(selector);

  it.each(TEXT)('draws --%s at 4.5:1 or more on every surface, bg-0 to bg-4', (text) => {
    for (const surface of SURFACES) {
      expect(
        contrast(hex[text]!, hex[surface]!),
        `--${text} on --${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(BADGE_TONES)('draws a %s badge at 4.5:1 or more on its tint', (tone) => {
    const tint = alpha[`${tone}-soft`];
    expect(tint, `--${tone}-soft`).toBeDefined();
    for (const surface of BADGE_SURFACES) {
      expect(
        contrast(hex[tone]!, over(tint!, hex[surface]!)),
        `--${tone} on --${tone}-soft over --${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('draws text on the solid fills at 4.5:1 or more', () => {
    expect(contrast(hex['accent-fg']!, hex.accent!), 'accent-fg on accent').toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrast(hex['on-danger']!, hex.danger!), 'on-danger on danger').toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrast(hex['on-warn']!, hex.warn!), 'on-warn on warn').toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * The stylesheets draw text on a solid tone fill only with that fill's own text token: a
 * white `--on-solid` on the dark theme's light fills read 2.02–3.11.
 */
describe('text on a solid tone fill', () => {
  const root = join(__dirname, '../../apps/web/src/styles');
  const files = ['kit.css', 'shell.css', 'pages/commerce-a.css', 'pages/ops-b.css'];
  const FILL_TEXT: Record<string, string> = {
    accent: 'accent-fg',
    danger: 'on-danger',
    warn: 'on-warn',
  };

  it.each(files)(
    'pairs every solid accent/danger/warn background with its text token in %s',
    (file) => {
      const css = readFileSync(join(root, file), 'utf8');
      for (const [, body] of css.matchAll(/\{([^{}]*)\}/g)) {
        const fill = /(?:^|;|\s)background:\s*var\(--(accent|danger|warn)\);/.exec(body!);
        const color = /(?:^|;|\s)color:\s*var\(--([a-z0-9-]+)\);/.exec(body!);
        if (fill === null || color === null) continue;
        expect(color[1], `${file}: ${body!.trim().slice(0, 80)}`).toBe(FILL_TEXT[fill[1]!]);
      }
    },
  );
});
