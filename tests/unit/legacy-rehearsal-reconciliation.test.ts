import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLOSURES,
  EQUATIONS,
  decide,
  render,
} from '../../scripts/legacy-rehearsal-reconciliation.mjs';

/**
 * WP-D5 — the reconciliation result table, generated from summary.json instead of
 * transcribed. Pinned to the document it fills and to the harness that records the checks.
 */
const ROOT = join(__dirname, '../..');
const DOC = readFileSync(join(ROOT, 'docs/legacy-migration/reconciliation.md'), 'utf8');
const HARNESS = readFileSync(join(ROOT, 'scripts/legacy-rehearsal.sh'), 'utf8');
const TOOL = join(ROOT, 'scripts/legacy-rehearsal-reconciliation.mjs');

type Check = { cycle: number; check: string; result: string; expected: string; actual: string };

const allNames = [
  ...new Set([...EQUATIONS, ...CLOSURES].flatMap(([, names]) => names as string[])),
];
const passing = (cycles = [1, 2]): Check[] =>
  cycles.flatMap((cycle) =>
    allNames.map((check) => ({ cycle, check, result: 'PASS', expected: 'x', actual: 'x' })),
  );

describe('the equation table is the document’s', () => {
  it('has exactly the 25 equations of the result table, in its order', () => {
    const table = DOC.slice(DOC.indexOf('## Result table'));
    const ids = [...table.matchAll(/^\| ([CWRSP][0-9]{1,2}) +\|/gmu)].map((m) => m[1]);
    expect(ids).toHaveLength(25);
    expect(EQUATIONS.map(([id]) => id)).toEqual(ids);
  });

  it('defines every equation it maps in the document body', () => {
    for (const [id] of EQUATIONS) expect(DOC, String(id)).toContain(`**${String(id)}**`);
  });

  it('maps only checks the harness actually records', () => {
    for (const name of allNames) {
      // `report_equation_$eq` and `legacy_$w8` are recorded through a loop variable.
      const literal = new RegExp(`\\b${name}\\b`, 'u');
      const looped =
        (/^report_equation_(C1|C3|W1|W4|W5|S3|P3)$/u.test(name) &&
          HARNESS.includes('for eq in C1 C3 W1 W4 W5 S3 P3')) ||
        (/^legacy_balance_(fractional|null)_users$/u.test(name) &&
          HARNESS.includes('for w8 in balance_fractional_users balance_null_users')) ||
        (/^unchanged_/u.test(name) &&
          HARNESS.includes(
            'for k in sale_orders_paid sale_orders_paid_total_minor payments_total wallet_topup_signed_total_minor',
          ));
      expect(literal.test(HARNESS) || looped, name).toBe(true);
    }
  });
});

describe('deciding an equation', () => {
  it('HOLDS only when every mapped check passed', () => {
    expect(decide(passing(), ['customer_closure', 'report_equation_C1'])).toEqual({
      state: 'HOLDS',
      detail: 'cycles 1,2',
    });
  });

  it('FAILS on any failed check, and names it', () => {
    const checks = passing().map((c) =>
      c.cycle === 2 && c.check === 'no_duplicate_openings'
        ? { ...c, result: 'FAIL', actual: '3' }
        : c,
    );
    const { states, markdown } = render({ evidenceClass: 'staging', checks });
    expect(states['W5']).toBe('FAILS');
    expect(markdown).toContain('c2 no_duplicate_openings: 3');
    expect(Object.entries(states).filter(([, s]) => s !== 'HOLDS')).toEqual([['W5', 'FAILS']]);
  });

  it('is PENDING — never HOLDS — when a mapped check waits on the owner', () => {
    const checks = passing().map((c) =>
      c.check === 'report_equation_C3' ? { ...c, result: 'PENDING', actual: 'false 0 / 1' } : c,
    );
    expect(render({ evidenceClass: 'staging', checks }).states['C3']).toBe('PENDING');
  });

  it('is MISSING when a mapped check was never recorded, and FAILS on an unknown result', () => {
    const checks = passing().filter((c) => c.check !== 'orphans_in_customer_missing');
    expect(render({ evidenceClass: 'staging', checks }).states['S4']).toBe('MISSING');
    expect(
      decide([{ cycle: 1, check: 'x', result: 'SKIPPED', expected: '', actual: '' }], ['x']).state,
    ).toBe('FAILS');
  });

  it('keeps a manual half NOT RUN even when the machine half holds', () => {
    const { markdown, states } = render({ evidenceClass: 'staging', checks: passing() });
    expect(states['R3']).toBe('HOLDS');
    const r3 = markdown.split('\n').find((l) => l.startsWith('| R3 |'));
    expect(r3).toContain('NOT RUN — manual half');
  });

  it('labels a synthetic table as never being the staging column', () => {
    expect(render({ evidenceClass: 'synthetic', checks: passing() }).markdown).toContain(
      'NOT the staging column',
    );
  });
});

describe('the CLI', () => {
  it('reads a summary.json and prints the table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexa-reconciliation-'));
    const file = join(dir, 'summary.json');
    writeFileSync(file, JSON.stringify({ evidenceClass: 'synthetic', checks: passing([1]) }));
    const result = spawnSync(process.execPath, [TOOL, file], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.match(/^\| [CWRSP][0-9]{1,2} +\| HOLDS \|/gmu)).toHaveLength(25);
  });
});
