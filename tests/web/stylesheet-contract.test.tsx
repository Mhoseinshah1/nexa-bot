import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import {
  ButtonGroup,
  Card,
  KV,
  Ltr,
  Money,
  Pills,
  RowActions,
  Tabs,
} from '../../apps/web/src/ui/kit';
import { renderPage } from './harness';

/**
 * The half of the presentation contract that lives in the stylesheet.
 *
 * jsdom parses no CSS, so every assertion in this suite that reads a class
 * name off an element proves only that the component EMITTED it. The rules
 * below are load-bearing — a bidi isolate that stops a Latin run reordering a
 * Persian sentence, a selected-state style that tells a sighted operator which
 * tab is open — and both were silently reverted at some point in this
 * project's history by a change on the other side of the seam.
 *
 * So this file asserts both ends: the class the component emits, and the rule
 * the stylesheet attaches to that exact class. Deleting either half fails it.
 */

const REPO_ROOT = join(import.meta.dirname, '../..');

/**
 * The stylesheet exactly as the browser receives it.
 *
 * `styles.css` is an entry point that `@import`s the split files (tokens,
 * base, kit, shell, one per page family) and then declares `[hidden]`. The
 * build inlines each import IN PLACE, so the cascade is the concatenation in
 * import order with the entry's own rules after it. Reading the entry alone
 * would assert against a file of import lines, and every rule below would be
 * "missing"; reading the parts in some other order would let `[hidden]` be
 * followed by a page rule and still pass. So the imports are expanded here, in
 * place and recursively, the way the bundler does it.
 */
function expandImports(path: string): string {
  const text = readFileSync(path, 'utf8');
  return text.replace(/@import\s+['"]([^'"]+)['"]\s*;/g, (_, target: string) =>
    expandImports(join(dirname(path), target)),
  );
}

const CSS = expandImports(join(REPO_ROOT, 'apps/web/src/styles.css'));

/**
 * The declarations of one rule, by selector, with comments stripped.
 *
 * Deliberately not a CSS parser: the point is to read what the file says about
 * one selector, and a regex over a stripped stylesheet is auditable in a way a
 * dependency would not be.
 */
function block(selector: string): string {
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(stripped);
  if (match === null) throw new Error(`No rule for ${selector} in styles.css.`);
  return match[2] ?? '';
}

describe('the split stylesheet', () => {
  /*
   * The expansion above is only as good as what it expands. If an import line
   * were mistyped (or a file dropped from the entry), the rules in it would
   * vanish from the bundle AND from this suite's view, and every `block()`
   * assertion about another file would go on passing.
   */
  it('inlines every part of the design system, in cascade order', () => {
    const entry = readFileSync(join(REPO_ROOT, 'apps/web/src/styles.css'), 'utf8');
    const imports = [...entry.matchAll(/@import\s+['"]([^'"]+)['"]\s*;/g)].map((m) => m[1]);
    expect(imports).toEqual([
      './styles/tokens.css',
      './styles/base.css',
      './styles/kit.css',
      './styles/shell.css',
      './styles/pages/dashboard.css',
      './styles/pages/commerce-a.css',
      './styles/pages/commerce-b.css',
      './styles/pages/ops-a.css',
      './styles/pages/ops-b.css',
    ]);
    expect(CSS).not.toMatch(/@import/);
    // The token sets and the kit arrived: one rule from each end of the chain.
    expect(block(":root[data-theme='light']")).toMatch(/--bg-0:/);
    expect(block('.btn')).toMatch(/border-radius/);
  });
});

describe('bidi isolation, at both ends of the seam', () => {
  /**
   * T25 — the CSS PROPERTY, not just the class name.
   *
   * `direction: ltr` alone does not stop the bidi algorithm resolving a Latin
   * run against its neighbours: `30 روز • 15 GB` still comes out reordered.
   * `unicode-bidi: isolate` is what makes the run one neutral object. The
   * component-side assertion could not see that property at all, so deleting it
   * from `.ltr` left the suite green and the reordering regression back.
   */
  it('gives the class Ltr emits a real isolate', () => {
    const { container } = renderPage(<Ltr>15 GB</Ltr>);
    const emitted = container.querySelector('span')?.className.split(' ') ?? [];
    expect(emitted).toContain('ltr');

    const rule = block('.ltr');
    expect(rule).toMatch(/direction:\s*ltr/);
    expect(rule, 'unicode-bidi: isolate is the half that stops the reordering').toMatch(
      /unicode-bidi:\s*isolate/,
    );
  });

  it('gives the class Money emits a real isolate', () => {
    const { container } = renderPage(
      <Money value={{ amountMinor: '13125012', currency: 'IRT' }} />,
    );
    expect(container.querySelector('.money')).not.toBeNull();
    expect(block('.money')).toMatch(/unicode-bidi:\s*isolate/);
  });

  it('keeps the shared isolate helpers meaning what they are named', () => {
    expect(block('.iso')).toMatch(/unicode-bidi:\s*isolate/);
    // `plaintext`, not `isolate`: a run whose direction is decided by its own
    // first strong character rather than imposed.
    expect(block('.plain')).toMatch(/unicode-bidi:\s*plaintext/);
  });
});

describe('spacing and wrapping the kit leaves to its containers', () => {
  /*
   * `.kv { margin: 0 }` out-ranked `.card-body > * + *` (same specificity,
   * later in the cascade), so a KV right after a banner in a card had no gap
   * and a page grew a wrapper of its own to space it. The list's margin is now
   * zeroed at zero specificity, where every container rhythm beats it.
   */
  it('lets the container space a definition list', () => {
    const { container } = renderPage(<KV items={[['الف', 'ب']]} />);
    expect(container.querySelector('dl.kv')).not.toBeNull();
    expect(block('.kv'), 'a margin on .kv defeats every container rhythm').not.toMatch(/margin/);
    expect(block(':where(dl)')).toMatch(/margin:\s*0/);
    expect(block('.card-body > * + *')).toMatch(/margin-top:\s*12px/);
  });

  it('wraps the row actions that ask to wrap, and only those', () => {
    const { container } = renderPage(
      <>
        <RowActions>
          <button type="button">الف</button>
        </RowActions>
        <RowActions wrap>
          <button type="button">ب</button>
        </RowActions>
      </>,
    );
    const [plain, wrapping] = [...container.querySelectorAll('.row-actions')];
    expect(plain?.className).toBe('row-actions');
    expect(wrapping?.className.split(' ')).toEqual(['row-actions', 'wrap']);
    expect(block('.tbl .row-actions')).not.toMatch(/flex-wrap/);
    const rule = block('.tbl .row-actions.wrap');
    expect(rule).toMatch(/flex-wrap:\s*wrap/);
    expect(rule).toMatch(/max-width:\s*var\(--row-actions-wrap-w\)/);
  });

  /*
   * Issue 15: `job:telegram-update:<uuid>:<n>` held on one line widened the
   * audit log past its card. The page emits `clamp-2 audit-id` on the value
   * (asserted in `audit-log.test.tsx`); these are the rules that make that
   * class wrap an unbroken id, stop at two lines, and stay in a bounded column.
   */
  it('wraps an unbroken id anywhere and clamps it to two lines', () => {
    const clamp = block('.clamp-2');
    expect(clamp).toMatch(/-webkit-line-clamp:\s*2/);
    expect(clamp).toMatch(/-webkit-box-orient:\s*vertical/);
    expect(clamp).toMatch(/display:\s*-webkit-box/);
    expect(clamp).toMatch(/overflow:\s*hidden/);
    // The table's cells are `nowrap`; the clamp has to undo that or it never wraps.
    expect(clamp).toMatch(/white-space:\s*normal/);
    // An id has no space to break at: `break-word` would leave it one line wide.
    expect(clamp).toMatch(/overflow-wrap:\s*anywhere/);
    expect(clamp).toMatch(/line-height:\s*1\.\d+/);
  });

  /*
   * The page puts `audit-id` only on a LONG actor label. Its floor stops auto
   * layout squeezing the id to a character a line; on every short label it
   * widened a page of `owner` rows past the card at 1280px (review of #191).
   * The action clamp is sized to itself — `fit-content`, no floor — so a short
   * `settings.update` stays at the start of its cell under its header.
   */
  it("bounds the audit log's id column with a floor and a ceiling", () => {
    const id = block('.audit-id');
    expect(id).toMatch(/max-width:\s*18rem/);
    expect(id).toMatch(/min-width:\s*10rem/);
    const action = block('.audit-action');
    expect(action).toMatch(/max-width:\s*18rem/);
    expect(action).toMatch(/width:\s*fit-content/);
    expect(action, 'a floor pushes a short action off the cell start').not.toMatch(/min-width/);
    const prose = ruleListing('.audit-reason');
    expect(prose).toMatch(/overflow-wrap:\s*anywhere/);
    expect(ruleListing('.audit-correlation')).toBe(prose);
  });
});

/**
 * The declarations of the rule whose selector LIST contains `selector` —
 * `block` needs the selector to be the last one before the brace.
 */
function ruleListing(selector: string): string {
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of stripped.matchAll(/(^|[};])\s*([^{}@;]+)\{([^}]*)\}/gm)) {
    const selectors = (match[2] ?? '').split(',').map((part) => part.trim());
    if (selectors.includes(selector)) return match[3] ?? '';
  }
  throw new Error(`No rule listing ${selector} in styles.css.`);
}

/** The body of every at-rule with exactly this prelude, braces balanced. */
function atRules(prelude: string): string[] {
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const at = stripped.indexOf(`${prelude} {`, from);
    if (at === -1) return bodies;
    const open = stripped.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (; end < stripped.length; end += 1) {
      if (stripped[end] === '{') depth += 1;
      else if (stripped[end] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push(stripped.slice(open + 1, end));
    from = end;
  }
}

describe('what the consistency pass found at 390 and 1440', () => {
  /*
   * With `flex: 1` (a zero basis) the titles shrank to nothing before the
   * actions would wrap, so a card head with three export buttons set its
   * heading one word a line on a phone (the referral analytics card).
   */
  it("wraps a card head's actions beneath titles that reach their floor", () => {
    const { container } = renderPage(
      <Card title="عنوان" hint="توضیح" actions={<button type="button">الف</button>}>
        <p>بدنه</p>
      </Card>,
    );
    expect(container.querySelector('.card-head > .titles + .actions')).not.toBeNull();
    expect(block('.card-head')).toMatch(/flex-wrap:\s*wrap/);
    expect(block('.card-head > .titles')).toMatch(/flex:\s*1 1 var\(--card-head-titles-min\)/);
    expect(block(':root')).toMatch(/--card-head-titles-min:\s*12rem/);
  });

  /*
   * A card whose only content is a filter toolbar drew the toolbar's bottom
   * rule and then the card's 16px padding under it: an empty band.
   */
  it('ends a card on its toolbar or filter row without a band beneath', () => {
    for (const selector of [
      '.card-body > .toolbar:last-child',
      '.card-body > .filter-row:last-child',
    ]) {
      const rule = ruleListing(selector);
      expect(rule, selector).toMatch(/margin-bottom:\s*-16px/);
      expect(rule, selector).toMatch(/border-bottom:\s*0/);
    }
    expect(block('.card-body')).toMatch(/padding:\s*16px/);
  });

  /*
   * A segmented set does not wrap, so the eight report periods ran off a 390px
   * card and the last of them could not be seen or pressed.
   */
  it('lets a segmented set wrap on a phone, and only there', () => {
    const { container } = renderPage(
      <ButtonGroup segmented label="بازه">
        <button type="button" className="btn">
          الف
        </button>
      </ButtonGroup>,
    );
    expect(container.querySelector('.btn-group.segmented')).not.toBeNull();
    expect(block('.btn-group.segmented')).toMatch(/flex-wrap:\s*nowrap/);
    const phone = atRules('@media (max-width: 640px)').join('\n');
    const wrap = /\.btn-group\.segmented\s*\{([^}]*)\}/.exec(phone);
    expect(wrap?.[1] ?? '', 'no phone rule wraps a segmented set').toMatch(/flex-wrap:\s*wrap/);
    expect(phone).toMatch(
      /\.btn-group\.segmented \.btn \+ \.btn\s*\{[^}]*margin-inline-start:\s*0/,
    );
  });

  /*
   * Six KPI cards abreast at 1440 leave a nine-digit toman figure no room for
   * its unit; the unit fell to its own line and the whole row grew with it.
   */
  it("sets a narrow dashboard KPI card's figure a step smaller", () => {
    expect(block('.dash-kpis > .stat')).toMatch(/container-type:\s*inline-size/);
    const narrow = atRules('@container (max-width: 200px)').join('\n');
    expect(narrow).toMatch(/\.dash-kpis \.stat \.val\s*\{[^}]*font-size:\s*var\(--fs-kpi-narrow\)/);
    expect(block(':root')).toMatch(/--fs-kpi-narrow:\s*17px/);
  });
});

describe('the page stylesheets take their values from the tokens', () => {
  const PAGES = ['dashboard', 'commerce-a', 'commerce-b', 'ops-a', 'ops-b'].map((name) =>
    readFileSync(join(REPO_ROOT, `apps/web/src/styles/pages/${name}.css`), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    ),
  );

  /* A literal colour is one theme's colour: it is wrong in the other. */
  it('writes no literal colour', () => {
    for (const css of PAGES) {
      expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(rgb|rgba|hsl|hsla)\(/);
    }
  });

  /* The control and bubble radii are tokens; a page's own 6/7/8px was three radii for one thing. */
  it('writes no literal control radius', () => {
    for (const css of PAGES) {
      expect(css).not.toMatch(/radius:\s*(4|5|6|7|8|10|12)px/);
    }
  });

  it('frames an inset block and a danger zone in the kit', () => {
    expect(block('.inset')).toMatch(/border:\s*1px solid var\(--line\)/);
    expect(block('.inset.danger-zone')).toMatch(/border-color:/);
  });
});

describe('selected state, at both ends of the seam', () => {
  const ITEMS = [
    { id: 'a' as const, label: 'یک' },
    { id: 'b' as const, label: 'دو' },
  ];

  /**
   * T10 — the class the component emits is the class the stylesheet styles.
   *
   * `Tabs` assigned `active` while the stylesheet styled only
   * `.tabs button.on`, and `Pills` repeated it against `.pills button.on`. So
   * changing a tab changed the content and the ARIA state and gave a sighted
   * operator no selected-state styling at all, in either theme — invisible to
   * every jsdom assertion, because jsdom applies no stylesheet.
   *
   * Asserted as a JOIN: read the class off the rendered selected button, then
   * require the stylesheet to carry a rule for that exact selector.
   */
  it('styles the class Tabs marks the selected tab with', () => {
    renderPage(<Tabs value="a" onChange={() => {}} items={ITEMS} panelId="p" />);
    const selected = screen.getByRole('tab', { selected: true });
    const marker = selected.className.trim();
    expect(marker, 'the selected tab carries a class at all').not.toBe('');
    // The join. A rename on either side breaks this.
    expect(() => block(`.tabs button.${marker}`)).not.toThrow();
    expect(block(`.tabs button.${marker}`)).toMatch(/color|background|border|box-shadow/);
  });

  it('styles the class Pills marks the selected pill with', () => {
    renderPage(<Pills value="a" onChange={() => {}} items={ITEMS} />);
    const pressed = screen
      .getAllByRole('button')
      .find((button) => button.getAttribute('aria-pressed') === 'true');
    const marker = (pressed?.className ?? '').trim();
    expect(marker).not.toBe('');
    expect(() => block(`.pills button.${marker}`)).not.toThrow();
  });

  it('gives the unselected control no selected-state class to be confused with', () => {
    renderPage(<Tabs value="a" onChange={() => {}} items={ITEMS} panelId="p" />);
    const other = screen.getByRole('tab', { name: 'دو' });
    expect(other.className.trim()).toBe('');
  });
});

/**
 * T24 — activating a tab from the keyboard MOVES FOCUS.
 *
 * The strip advertises a roving tabindex: only the selected tab is in the tab
 * order. Selecting with an arrow key while leaving `document.activeElement` on
 * the old button therefore parked focus on a tab that is now
 * `aria-selected=false` with `tabIndex=-1`, beside a panel it does not
 * control — so the mechanism did not work for exactly the users it exists for.
 */
describe('the tab strip keyboard contract', () => {
  const ITEMS = [
    { id: 'a' as const, label: 'یک' },
    { id: 'b' as const, label: 'دو' },
    { id: 'c' as const, label: 'سه' },
  ];

  function Harness({ initial }: { initial: 'a' | 'b' | 'c' }) {
    const [value, setValue] = useState<'a' | 'b' | 'c'>(initial);
    return <Tabs value={value} onChange={setValue} items={ITEMS} panelId="p" />;
  }

  const strip = () => screen.getByRole('tablist');

  it('focuses the newly selected tab on an arrow key', async () => {
    renderPage(<Harness initial="a" />);
    screen.getByRole('tab', { name: 'یک' }).focus();

    fireEvent.keyDown(strip(), { key: 'ArrowLeft' });
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));

    const selected = screen.getByRole('tab', { selected: true });
    expect(selected.textContent).toBe('دو');
    // The whole finding: focus followed the selection.
    expect(document.activeElement).toBe(selected);
    expect(selected.getAttribute('tabindex')).toBe('0');
  });

  it('focuses the first tab on Home and the last on End', async () => {
    renderPage(<Harness initial="b" />);
    screen.getByRole('tab', { name: 'دو' }).focus();

    fireEvent.keyDown(strip(), { key: 'End' });
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'سه' }));

    fireEvent.keyDown(strip(), { key: 'Home' });
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'یک' }));
  });

  it('never leaves focus on a tab that is out of the tab order', async () => {
    renderPage(<Harness initial="a" />);
    screen.getByRole('tab', { name: 'یک' }).focus();

    fireEvent.keyDown(strip(), { key: 'ArrowLeft' });
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));

    expect((document.activeElement as HTMLElement).getAttribute('aria-selected')).toBe('true');
    expect((document.activeElement as HTMLElement).getAttribute('tabindex')).not.toBe('-1');
  });
});

/**
 * F1 — `hidden` has to actually hide, and neither existing suite could see it.
 *
 * Round 28 withdrew the request-issuing filter toolbars from a denied or
 * finally-refused page with `<div className="toolbar" hidden={…}>`. The user
 * agent's `[hidden] { display: none }` is USER-AGENT origin, so the author's
 * `.toolbar { display: flex }` beat it: the toolbar stayed laid out, visible
 * and clickable, and a severity change still minted a new query key and one
 * more refused request. The commit said that harm had been removed.
 *
 * Two independent blindfolds kept every test green. The web vitest project
 * loads no CSS, so jsdom's own UA rule won there; and `getByRole` consults the
 * `hidden` IDL property and short-circuits before computed style, so a role
 * query returns null whether or not the element is painted. An assertion
 * written that way is structurally incapable of failing on this.
 *
 * So this asserts the two things a role query cannot: what the cascade
 * actually computes with the real stylesheet in the document, and — because
 * jsdom drops `!important` and decides on source order alone — that the
 * declaration carries `!important` for the browsers that decide on
 * specificity.
 */
describe('the hidden attribute, against the real cascade', () => {
  function withStylesheet(markup: string): HTMLElement {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    const host = document.createElement('div');
    host.innerHTML = markup;
    document.body.append(host);
    return host;
  }

  it('paints nothing for a styled element carrying hidden', () => {
    const host = withStylesheet(
      '<div class="toolbar" hidden id="a"><select></select></div>' +
        '<div hidden id="b"></div>' +
        '<div class="toolbar" id="c"></div>' +
        '<div class="tabs vertical"><button hidden id="d"></button></div>',
    );
    const display = (id: string) =>
      getComputedStyle(host.querySelector(`#${id}`) as Element).display;

    // The regression itself: `.toolbar { display: flex }` used to win here.
    expect(display('a'), '.toolbar[hidden] must not be painted').toBe('none');
    expect(display('b')).toBe('none');
    // …without hiding a toolbar that is NOT hidden. A rule that hides
    // everything passes the assertion above and breaks every page.
    expect(display('c')).toBe('flex');
    // (0,3,1) beats (0,1,0) on specificity, so this one needs `!important`
    // in a browser. jsdom cannot tell; the textual assertion below can.
    expect(display('d'), '.tabs.vertical button[hidden] must not be painted').toBe('none');
  });

  it('declares that rule important, and last', () => {
    expect(block('[hidden]'), 'specificity beats source order in a real browser').toMatch(
      /display:\s*none\s*!important/,
    );
    /*
     * Position is the OTHER half, and it is the half jsdom is sensitive to.
     * `!important` is dropped by jsdom's cascade — probed directly:
     * `.t{display:flex}` written after `[hidden]{display:none!important}`
     * still computes `flex`. So a `[hidden]` rule placed anywhere above
     * `.toolbar` would leave the test above unable to fail, and the seam
     * unguarded in exactly the way it was unguarded before.
     */
    /*
     * "Last" asserted as NOTHING FOLLOWS, which is what the word means.
     *
     * The first version of this checked that `[hidden]` came after the last
     * `.toolbar {`, that the slice between it and the final `}` contained a
     * `{`, and that the file ended in `}`. All three stay true when a rule is
     * appended below it — measured: appending `.dist-row { display: grid }`
     * left all 286 tests green while re-opening the jsdom seam for that class,
     * because jsdom decides on source order alone. An assertion about a
     * position has to be an assertion about what is on the other side of it.
     */
    /*
     * Anchored on the RULE, not on the last mention of the selector.
     *
     * The first version took `CSS.lastIndexOf('[hidden]')`, so anything whose
     * selector merely CONTAINS `[hidden]` moved the anchor past the rule and
     * the assertion then proved only that nothing follows that. Appending
     * `.dist-row[hidden] { display: grid }` — the likeliest thing anyone writes
     * near this rule — kept all 290 tests green while `.dist-row[hidden]`
     * computed `grid` against the real stylesheet. A position assertion has to
     * be anchored on the thing whose position it is asserting.
     */
    const rule = /(^|\n)\[hidden\]\s*\{[^}]*\}/g;
    const matches = [...CSS.matchAll(rule)];
    expect(matches, 'exactly one bare [hidden] rule').toHaveLength(1);
    const only = matches[0] as RegExpMatchArray;
    const end = (only.index ?? 0) + only[0].length;
    expect(end, '[hidden] must come after .toolbar').toBeGreaterThan(CSS.lastIndexOf('.toolbar {'));
    expect(CSS.slice(end).trim(), 'no rule may follow [hidden]; jsdom obeys source order').toBe('');
  });
});
