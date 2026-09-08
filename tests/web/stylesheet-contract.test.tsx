import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Ltr, Money, Pills, Tabs } from '../../apps/web/src/ui/kit';
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
const CSS = readFileSync(join(REPO_ROOT, 'apps/web/src/styles.css'), 'utf8');

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
