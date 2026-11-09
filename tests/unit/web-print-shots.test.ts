import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRINT_VIEWS, printProblems } from '../../scripts/web-shots/print-shots.mjs';

/**
 * SFR A4: the dry-run report prints whole. `pnpm web:print-shots` measures it in a real browser
 * (print media, A4 width, both themes); this pins the CSS it depends on and the refusal rule.
 */
const PRINT_CSS = readFileSync(join(__dirname, '../../apps/web/src/styles/print.css'), 'utf8');

describe('printing a Web Admin page', () => {
  it('drops the chrome, gives the page the whole width and lets nothing clip or overflow', () => {
    // MUTATION: removing any of these (or the import in styles.css) lets the left (RTL) value
    // column fall off the paper again, which `web:print-shots` measured at -9..47 px.
    expect(PRINT_CSS).toMatch(/@media print/);
    expect(PRINT_CSS).toMatch(/\.sidebar,[\s\S]*\.topbar,[\s\S]*display: none/);
    expect(PRINT_CSS).toMatch(/\.app \{\s*display: block;/);
    expect(PRINT_CSS).toMatch(/overflow: visible/);
    expect(PRINT_CSS).toMatch(/grid-template-columns: minmax\(0, max-content\) minmax\(0, 1fr\)/);
    expect(PRINT_CSS).not.toMatch(/\b(left|right):|margin-(left|right)|padding-(left|right)/);
    const entry = readFileSync(join(__dirname, '../../apps/web/src/styles.css'), 'utf8');
    expect(entry).toContain("@import './styles/print.css';");
  });

  it('measures both themes at A4, and refuses a value off the page or printed chrome', () => {
    expect(PRINT_VIEWS.map((v) => [v.theme, v.width, v.media])).toEqual([
      ['dark', 794, 'print'],
      ['light', 794, 'print'],
    ]);
    expect(printProblems({ values: 149, outside: [], chrome: [] })).toEqual([]);
    expect(printProblems({ values: 149, outside: ['-9..47'], chrome: [] })).toHaveLength(1);
    expect(printProblems({ values: 149, outside: [], chrome: ['.sidebar'] })).toHaveLength(1);
    expect(printProblems({ values: 0, outside: [], chrome: [] })).toHaveLength(1);
  });
});
