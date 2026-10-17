import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { ActionPanel } from '../../apps/web/src/ui/action-panel';
import { Button, Tabs } from '../../apps/web/src/ui/kit';
import { DotTabs } from '../../apps/web/src/pages/dot-tabs';
import { DotTabs as EditorDotTabs } from '../../apps/web/src/pages/editor-layout';
import { SectionTabs } from '../../apps/web/src/pages/ops-b-layout';
import { scrollTabIntoStrip } from '../../apps/web/src/ui/tab-strip';
import { renderPage } from './harness';

/**
 * The layout half of the PR #285 review fixes (B1, B2, B4, B5, B6). jsdom lays nothing
 * out, so — as in `stylesheet-contract.test.tsx` — each rule is asserted at both ends: the
 * class the component emits, and what the stylesheet the browser receives says about it,
 * media queries included. The measured browser results are in the PR description.
 */

const REPO_ROOT = join(import.meta.dirname, '../..');

function expandImports(path: string): string {
  const text = readFileSync(path, 'utf8');
  return text.replace(/@import\s+['"]([^'"]+)['"]\s*;/g, (_, target: string) =>
    expandImports(join(dirname(path), target)),
  );
}

interface Rule {
  readonly media: string | null;
  readonly selector: string;
  readonly body: string;
}

/** Every style rule in the bundle, with the `@media` prelude it sits in (or null). */
function rulesOf(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const walk = (from: number, to: number, media: string | null) => {
    let at = from;
    while (at < to) {
      const open = text.indexOf('{', at);
      if (open < 0 || open >= to) return;
      const prelude = text.slice(at, open).trim();
      let depth = 1;
      let close = open + 1;
      while (depth > 0 && close < to) {
        if (text[close] === '{') depth += 1;
        else if (text[close] === '}') depth -= 1;
        close += 1;
      }
      if (prelude.startsWith('@media')) walk(open + 1, close - 1, prelude);
      else if (!prelude.startsWith('@'))
        for (const selector of prelude.split(','))
          rules.push({ media, selector: selector.trim(), body: text.slice(open + 1, close - 1) });
      at = close;
    }
  };
  walk(0, text.length, null);
  return rules;
}

const RULES = rulesOf(expandImports(join(REPO_ROOT, 'apps/web/src/styles.css')));

/** The declarations every rule for `selector` under `media` makes, in cascade order. */
function declarations(selector: string, media: string | null = null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of RULES.filter((r) => r.selector === selector && r.media === media))
    for (const part of rule.body.split(';')) {
      const colon = part.indexOf(':');
      if (colon > 0) out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
    }
  return out;
}

const mediaOf = (selector: string) =>
  RULES.filter((r) => r.selector === selector && r.media !== null).map((r) => r.media);

describe('B1: the action panel never leaves an empty cell', () => {
  it('emits the groups as direct children of the grid', () => {
    renderPage(
      <ActionPanel
        groups={['a', 'b', 'c'].map((key) => ({
          key,
          title: key,
          actions: [<Button key={key}>{key}</Button>],
        }))}
      />,
    );
    const grid = document.querySelector('.action-grid')!;
    expect([...grid.children].map((child) => child.className)).toEqual([
      'action-group',
      'action-group',
      'action-group',
    ]);
  });

  it('wraps groups that grow to share their row, from a 260px floor', () => {
    const grid = declarations('.action-grid');
    expect(grid['display']).toBe('flex');
    expect(grid['flex-wrap']).toBe('wrap');
    // Fixed or auto-fit TRACKS leave the cell beside a lone last group empty.
    expect(grid['grid-template-columns']).toBeUndefined();
    expect(declarations('.action-grid > .action-group')['flex']).toBe('1 1 260px');
  });

  it('B6: stacks the groups one per row at the phone breakpoint, 760px', () => {
    expect(declarations('.action-grid > .action-group', '@media (max-width: 760px)')).toEqual({
      'flex-basis': '100%',
    });
    expect(mediaOf('.action-grid')).toEqual([]);
    expect(mediaOf('.action-group.danger')).toEqual(['@media (max-width: 760px)']);
  });
});

describe('B2: the bot-buttons builder between 761px and 1180px', () => {
  it('keeps the pool in its own column beside the phone, as tall as the phone', () => {
    expect(declarations('.bb-card .bb-workspace > .bb-pool', '@media (max-width: 1180px)')).toEqual(
      { 'grid-column': 'auto' },
    );
    expect(declarations('.bb-card .bb-workspace > .bb-pool')['align-self']).toBe('stretch');
  });

  it('goes from three editor columns straight to one', () => {
    expect(declarations('.bb-insp-cols')['grid-template-columns']).toBe(
      'repeat(3, minmax(0, 1fr))',
    );
    const narrowed = RULES.filter((r) => r.selector === '.bb-insp-cols' && r.media !== null);
    expect(narrowed.map((r) => [r.media, declarations('.bb-insp-cols', r.media)])).toEqual([
      ['@media (max-width: 1100px)', { 'grid-template-columns': 'minmax(0, 1fr)' }],
    ]);
  });
});

describe('B4, B5: cards that sit side by side end level', () => {
  it('stretches the referral footer cards to one height', () => {
    expect(declarations('.referrals-foot')['align-items']).toBe('stretch');
  });

  it('runs the incident side column the height of the summary, its last card taking the rest', () => {
    expect(declarations('.incident-detail')['align-items']).toBe('stretch');
    expect(declarations('.incident-side')).toMatchObject({
      display: 'flex',
      'flex-direction': 'column',
    });
    expect(declarations('.incident-side > :last-child')['flex']).toBe('1');
    const source = readFileSync(join(REPO_ROOT, 'apps/web/src/pages/incidents.tsx'), 'utf8');
    expect(source).toContain('className="stack incident-side"');
  });
});

describe('B6: the selected tab is brought into view inside its strip', () => {
  const original = {
    scrollBy: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollBy'),
    scrollIntoView: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView'),
  };
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [name, descriptor] of Object.entries(original)) {
      if (descriptor === undefined)
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      else Object.defineProperty(HTMLElement.prototype, name, descriptor);
    }
  });

  /**
   * A 300px strip holding 100px tabs side by side (left to right, for the arithmetic); the
   * strip scrolls, so `scrollWidth` exceeds `clientWidth`. Returns the strip's scroll calls.
   */
  function layOut() {
    const scrolled: unknown[] = [];
    const pageScroll = vi.fn();
    vi.stubGlobal('scrollTo', pageScroll);
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.getAttribute('role') === 'tablist' ? 900 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.getAttribute('role') === 'tablist' ? 300 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute('role') === 'tablist') return new DOMRect(0, 0, 300, 40);
      const index = [...(this.parentElement?.children ?? [])].indexOf(this);
      return new DOMRect(index * 100, 0, 100, 40);
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollBy', {
      configurable: true,
      value(this: HTMLElement, options: unknown) {
        scrolled.push([this.getAttribute('role'), options]);
      },
    });
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    return { scrolled, scrollIntoView, pageScroll };
  }

  const ITEMS = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, label: id }));

  it('scrolls the kit strip, and only the strip, when the tab is changed from elsewhere', () => {
    const { scrolled, scrollIntoView, pageScroll } = layOut();
    function Page() {
      const [tab, setTab] = useState('a');
      return (
        <>
          {/* A shortcut elsewhere on the page, as customer 360's wallet card is. */}
          <button type="button" onClick={() => setTab('f')}>
            shortcut
          </button>
          <Tabs value={tab} onChange={setTab} items={ITEMS} panelId="p" />
        </>
      );
    }
    renderPage(<Page />);
    // The first tab is in view on arrival: nothing moves.
    expect(scrolled).toEqual([]);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'shortcut' }));
    });
    // Tab f spans 500–600 in a 0–300 strip: the strip moves by 600 − 300 + the 12px inset.
    expect(scrolled).toEqual([['tablist', { left: 312 }]]);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(pageScroll).not.toHaveBeenCalled();
  });

  it('does the same for the dotted and section strips', () => {
    const { scrolled } = layOut();
    const strips = [
      (value: string) => (
        <DotTabs value={value} onChange={() => {}} items={ITEMS} panelId="m" label="m" />
      ),
      (value: string) => (
        <EditorDotTabs value={value} onChange={() => {}} items={ITEMS} panelId="e" />
      ),
      (value: string) => (
        <SectionTabs value={value} onChange={() => {}} items={ITEMS} panelId="s" label="s" />
      ),
    ];
    for (const strip of strips) {
      scrolled.length = 0;
      const view = renderPage(strip('a'));
      view.rerender(strip('e'));
      // Tab e spans 400–500: 500 − 300 + 12.
      expect(scrolled).toEqual([['tablist', { left: 212 }]]);
      view.unmount();
    }
  });

  it('moves nothing when the strip does not scroll or the tab is already in view', () => {
    const strip = {
      scrollWidth: 300,
      clientWidth: 300,
      scrollBy: vi.fn(),
    } as unknown as HTMLElement;
    scrollTabIntoStrip(strip, document.createElement('button'));
    expect(
      (strip as unknown as { scrollBy: ReturnType<typeof vi.fn> }).scrollBy,
    ).not.toHaveBeenCalled();

    const wide = {
      scrollWidth: 900,
      clientWidth: 300,
      scrollBy: vi.fn(),
      getBoundingClientRect: () => new DOMRect(0, 0, 300, 40),
    } as unknown as HTMLElement;
    const tab = { getBoundingClientRect: () => new DOMRect(100, 0, 100, 40) } as HTMLElement;
    scrollTabIntoStrip(wide, tab);
    expect(
      (wide as unknown as { scrollBy: ReturnType<typeof vi.fn> }).scrollBy,
    ).not.toHaveBeenCalled();
    // Past the START edge (in a right-to-left strip, the right): a negative move.
    const before = { getBoundingClientRect: () => new DOMRect(-150, 0, 100, 40) } as HTMLElement;
    scrollTabIntoStrip(wide, before);
    expect(
      (wide as unknown as { scrollBy: ReturnType<typeof vi.fn> }).scrollBy,
    ).toHaveBeenCalledWith({
      left: -162,
    });
  });
});
