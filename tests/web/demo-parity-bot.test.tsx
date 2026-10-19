import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_BOT } from './shots/fixtures/demo-parity/bot.ts';

/**
 * Demo parity, the bot and content family (`docs/web-redesign/demo-parity/audit/bot.md`).
 *
 * The family's demo-parity fixtures are the bodies its side-by-sides photograph, so each
 * is parsed by the response schema it names — a drifted body would be photographed as an
 * error card. And the composition rules that live only in CSS are pinned here, each by the
 * declaration the demo decided, so reverting one fails this file.
 */
const REPO_ROOT = join(__dirname, '..', '..');
const css = readFileSync(join(REPO_ROOT, 'apps/web/src/styles/pages/demo-bot.css'), 'utf8');

function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
}

describe('the bot family demo-parity fixtures', () => {
  it.each(DEMO_BOT.map((fixture) => [`${fixture.method} ${fixture.path}`, fixture] as const))(
    '%s satisfies its response schema',
    (_, fixture) => {
      expect(() => fixture.schema?.parse(fixture.body)).not.toThrow();
    },
  );
});

describe('the bot family composition (CSS)', () => {
  it('stacks the bot-buttons builder in one column of framed cards', () => {
    expect(rule('.bb-card .bb-workspace')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(rule('.bb-card .bb-pool-list')).toMatch(/flex-direction:\s*column/);
  });

  it('draws a running broadcast in the chart blue', () => {
    expect(rule('.bc-list .progress.info rect')).toMatch(/fill:\s*var\(--chart-1\)/);
  });

  it('frames «افزودن ربات» as its own bordered card', () => {
    expect(rule('.bx-add')).toMatch(/border:\s*1px solid var\(--line\)/);
  });

  it('mutes a switched-off reminder value', () => {
    expect(rule('.bx-rem.off .bx-big')).toMatch(/color:\s*var\(--fg-3\)/);
  });

  it('spans «اطلاعات فنی» across a settings row', () => {
    expect(rule('.disclosure.set-tech')).toMatch(/inline-size:\s*100%/);
  });
});
