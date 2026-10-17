import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DateField } from '../../apps/web/src/ui/date-field';
import { Field, ToastProvider } from '../../apps/web/src/ui/kit';
import { ListFilterBar } from '../../apps/web/src/ui/filter-bar';
import { SavedViewsMenu } from '../../apps/web/src/ui/saved-views-menu';
import type { SavedViewsRegistration, ViewState } from '../../apps/web/src/ui/saved-views';
import { t } from '../../apps/web/src/i18n/web.fa';
import { openFilterPanel } from './ui-helpers';

/**
 * PR #285 review, A3 — the shared components' phone layout.
 *
 * The phone breakpoint is 760px, not 640px, and every popover that becomes a bottom sheet
 * there dims the page behind it: a tap on the dim, Escape or the sheet's × closes it. jsdom
 * applies no media query, so the breakpoint is asserted on the stylesheet and the backdrop
 * and × on the DOM.
 */

const CSS = readFileSync(
  join(import.meta.dirname, '../../apps/web/src/styles/ui.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `@media (max-width: Npx)` block of `ui.css`, brace-matched, with its width. */
function mediaBlocks(): { width: number; body: string }[] {
  const out: { width: number; body: string }[] = [];
  const head = /@media \(max-width: (\d+)px\) \{/g;
  for (let found = head.exec(CSS); found !== null; found = head.exec(CSS)) {
    let depth = 1;
    let at = head.lastIndex;
    while (depth > 0 && at < CSS.length) {
      if (CSS[at] === '{') depth += 1;
      else if (CSS[at] === '}') depth -= 1;
      at += 1;
    }
    out.push({ width: Number(found[1]), body: CSS.slice(head.lastIndex, at - 1) });
  }
  return out;
}

const ruleIn = (body: string, selector: string): string | null => {
  // The selector alone or in a group (`a,\n b {`), never as the prefix of a longer one.
  const at = body.search(new RegExp(`(^|[\\s,}])${selector.replace(/\./g, '\\.')}\\s*[,{]`));
  if (at < 0) return null;
  const open = body.indexOf('{', at);
  return body.slice(open + 1, body.indexOf('}', open));
};

describe('the phone breakpoint of the shared components', () => {
  const SHEETS = [
    '.date-pop',
    '.date-pop-backdrop',
    '.date-pop-sheet',
    '.file-picker',
    '.lfb-panel',
    '.lfb-backdrop',
    '.saved-views-pop',
    '.saved-views-backdrop',
    '.saved-views-sheet',
    '.aq-rh',
  ];

  it.each(SHEETS)('%s changes at ≤760px and at no narrower breakpoint', (selector) => {
    const blocks = mediaBlocks().filter((block) => ruleIn(block.body, selector) !== null);
    expect(blocks.length, `no phone rule for ${selector}`).toBeGreaterThan(0);
    expect(blocks.map((block) => block.width)).toEqual(blocks.map(() => 760));
  });

  it.each(['.date-pop-backdrop', '.saved-views-backdrop', '.lfb-backdrop'])(
    '%s is hidden on a wide screen and a fixed dim layer on a phone',
    (selector) => {
      const wide = ruleIn(CSS.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, ''), selector);
      expect(wide).toMatch(/display:\s*none/);
      const phone = mediaBlocks().find(
        (block) => block.width === 760 && ruleIn(block.body, selector),
      );
      const rule = phone === undefined ? null : ruleIn(phone.body, selector);
      expect(rule).toMatch(/display:\s*block/);
      expect(rule).toMatch(/position:\s*fixed/);
      expect(rule).toMatch(/background:\s*var\(--overlay\)/);
    },
  );
});

function DateHarness() {
  const [value, setValue] = useState('');
  return (
    <Field label="تاریخ" htmlFor="d">
      <DateField id="d" mode="date" value={value} onChange={setValue} />
    </Field>
  );
}
const dateField = () => screen.getByLabelText('تاریخ');
const tap = (node: Element) => {
  fireEvent.mouseDown(node);
  fireEvent.mouseUp(node);
  fireEvent.click(node);
};

describe('the date picker sheet', () => {
  it('draws a backdrop that closes the picker when tapped', () => {
    render(<DateHarness />);
    fireEvent.click(dateField());
    const backdrop = document.querySelector('.date-pop-backdrop');
    expect(backdrop).not.toBeNull();
    expect(backdrop).toHaveAttribute('aria-hidden', 'true');
    tap(backdrop as Element);
    expect(dateField()).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('.date-pop-backdrop')).toBeNull();
  });

  it('closes with its × and with Escape', () => {
    render(<DateHarness />);
    fireEvent.click(dateField());
    const pop = screen.getByRole('dialog', { name: t('web.date_pick') });
    fireEvent.click(within(pop).getByRole('button', { name: t('web.close') }));
    expect(dateField()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(dateField());
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(dateField()).toHaveAttribute('aria-expanded', 'false');
  });

  it('inside a filter panel: a tap on its backdrop closes the picker and keeps the panel', () => {
    render(
      <ListFilterBar
        filters={[
          {
            key: 'from',
            label: 'از',
            active: null,
            onClear: () => undefined,
            control: <DateHarness />,
          },
        ]}
      />,
    );
    const panel = openFilterPanel();
    fireEvent.click(within(panel).getByLabelText('تاریخ'));
    tap(document.querySelector('.date-pop-backdrop') as Element);
    expect(within(panel).getByLabelText('تاریخ')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('dialog', { name: t('web.filters') })).toBeInTheDocument();
  });
});

const EMPTY: ViewState = { status: '' };
function SavedHarness() {
  const [state, setState] = useState<ViewState>(EMPTY);
  const registration: SavedViewsRegistration = {
    page: 'users',
    empty: EMPTY,
    get: () => state,
    set: (next) => setState({ ...next }),
    presets: [{ id: 'blocked', name: 'web.saved_views_presets', state: { status: 'BLOCKED' } }],
  };
  return (
    <ToastProvider>
      <SavedViewsMenu registration={registration} />
    </ToastProvider>
  );
}
const savedButton = () => document.querySelector('.saved-views-btn') as HTMLElement;

describe('the saved-filters sheet', () => {
  it('draws a backdrop that closes the menu when tapped', () => {
    render(<SavedHarness />);
    fireEvent.click(savedButton());
    const backdrop = document.querySelector('.saved-views-backdrop');
    expect(backdrop).not.toBeNull();
    expect(backdrop).toHaveAttribute('aria-hidden', 'true');
    tap(backdrop as Element);
    expect(savedButton()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog', { name: t('web.saved_views') })).toBeNull();
  });

  it('closes with its × and with Escape', () => {
    render(<SavedHarness />);
    fireEvent.click(savedButton());
    const pop = screen.getByRole('dialog', { name: t('web.saved_views') });
    fireEvent.click(within(pop).getByRole('button', { name: t('web.close') }));
    expect(savedButton()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(savedButton());
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(savedButton()).toHaveAttribute('aria-expanded', 'false');
  });
});
