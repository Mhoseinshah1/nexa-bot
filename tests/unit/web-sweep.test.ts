import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STATES,
  VIEWS,
  isAllowedDangerBanner,
  isEnglishSentence,
  sweepProblems,
} from '../../scripts/web-shots/sweep.mjs';

/** The decisions `pnpm web:sweep` makes without a browser (the approved Web Admin's gate). */
describe('the release sweep', () => {
  it('reads three Latin words in a row as an English sentence shown to an operator', () => {
    expect(isEnglishSentence('The request payload is invalid.')).toBe(true);
    expect(isEnglishSentence('Request failed with 500')).toBe(true);
  });

  it('does not read an identifier, a code or Persian text with a Latin name as a sentence', () => {
    expect(isEnglishSentence('panel.capability_unsupported')).toBe(false);
    expect(isEnglishSentence('سرویس nx_8f3a روی Germany-1')).toBe(false);
    expect(isEnglishSentence('v0.2.1')).toBe(false);
  });

  it('covers 1440 dark, 1440 light and 390 dark on a touch device', () => {
    expect(VIEWS.map((view) => view.name)).toEqual(['1440-dark', '1440-light', '390-dark']);
    expect(VIEWS[2]).toMatchObject({ width: 390, touch: true });
  });
});

describe('what fails a view of the sweep', () => {
  const clean = {
    route: '/payments',
    settled: true,
    errors: [],
    english: [],
    overflow: 0,
    skeletons: 0,
    errorCards: [],
    dangerBanners: [],
    unfixtured: [],
  };

  it('passes a view with nothing wrong', () => {
    expect(sweepProblems(clean)).toEqual([]);
  });

  it.each([
    ['an error card', { errorCards: ['سرور این درخواست را نپذیرفت'] }],
    ['a danger banner', { dangerBanners: ['خطا در ارتباط با سرور'] }],
    ['an English sentence', { english: ['Request failed with 500'] }],
    ['a horizontal overflow', { overflow: 24 }],
    ['a console error', { errors: ['TypeError: x is undefined'] }],
    ['a skeleton still drawn', { skeletons: 1 }],
    ['a request no fixture answered', { unfixtured: ['GET /api/admin/v1/incidents/x'] }],
    ['a network that never went quiet', { settled: false }],
  ])('fails on %s alone', (_, change) => {
    expect(sweepProblems({ ...clean, ...change })).toHaveLength(1);
  });

  it('lets a danger banner through only on the route it is allow-listed for', () => {
    const allowed = [
      { route: '/payments/x', contains: 'ناموفق', reason: 'the fixture is a failed payment' },
    ];
    expect(isAllowedDangerBanner('/payments/x', 'پرداخت ناموفق بود', allowed)).toBe(true);
    expect(isAllowedDangerBanner('/orders/x', 'پرداخت ناموفق بود', allowed)).toBe(false);
    expect(isAllowedDangerBanner('/payments/x', 'خطا در ارتباط با سرور', allowed)).toBe(false);
    expect(
      sweepProblems(
        { ...clean, route: '/payments/x', dangerBanners: ['پرداخت ناموفق بود'] },
        allowed,
      ),
    ).toEqual([]);
    expect(
      sweepProblems(
        { ...clean, route: '/orders/x', dangerBanners: ['پرداخت ناموفق بود'] },
        allowed,
      ),
    ).toHaveLength(1);
  });

  /*
   * The sweep once looked for `.error-state`, a class nothing renders, and so certified every
   * error card it photographed. The selectors are held to the classes the kit really draws.
   */
  it('looks for the classes the kit draws its error card and danger banner with', () => {
    const kit = readFileSync(join(__dirname, '../../apps/web/src/ui/kit.tsx'), 'utf8');
    expect(kit).toMatch(/className=\{cx\('empty', variant\)\}/);
    expect(kit).toMatch(/variant="error"/);
    // The slim strip (support-knowledge) only appends ` slim`; `banner <tone>` stays first.
    expect(kit).toMatch(/className=\{`banner \$\{tone\}(\$\{slim \? ' slim' : ''\})?`\}/);
    expect(STATES).toContain("'.empty.error'");
    expect(STATES).toContain("'.banner.danger'");
    expect(STATES).toContain("'.skel'");
  });
});
