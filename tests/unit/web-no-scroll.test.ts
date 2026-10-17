import { describe, expect, it } from 'vitest';
import {
  CLICKABLES,
  JUMP_TOLERANCE_PX,
  NO_SCROLL_VIEWS,
  TABS,
  isJump,
  onPage,
  parseArgs,
  tabPasses,
} from '../../scripts/web-shots/no-scroll.mjs';

/**
 * The decision `pnpm web:no-scroll` makes after every click (W2: no button may scroll
 * the page to another section). The browser part needs Chromium; this part does not.
 */
describe('a click that scrolls the page', () => {
  const at = (content: number, window = 0, route = '/users/x') => ({ route, content, window });

  it('is a jump when the content moved on the same route', () => {
    expect(isJump(at(0), at(640))).toBe(true);
  });

  it('is a jump when the window moved on the same route', () => {
    expect(isJump(at(0, 0), at(0, 300))).toBe(true);
  });

  it('is not a jump when nothing moved, or moved by no more than the tolerance', () => {
    expect(isJump(at(0), at(0))).toBe(false);
    expect(isJump(at(0), at(JUMP_TOLERANCE_PX))).toBe(false);
    expect(isJump(at(0), at(JUMP_TOLERANCE_PX + 1))).toBe(true);
  });

  it('is not a jump when the page got shorter and the browser clamped to its new end', () => {
    // A shorter tab: the content can now scroll to 208 at most, and that is where it is.
    expect(isJump(at(284), { ...at(208), contentMax: 208 })).toBe(false);
    // …but moving up to somewhere that is NOT the end is a jump, and so is any move down.
    expect(isJump(at(284), { ...at(100), contentMax: 208 })).toBe(true);
    expect(isJump(at(0), { ...at(640), contentMax: 640 })).toBe(true);
  });

  it('is not a jump when the click navigated: the next route starts at its own top', () => {
    expect(isJump(at(0, 0, '/users/x'), at(500, 0, '/services/y'))).toBe(false);
  });
});

/** What `pnpm web:no-scroll` clicks, in which views (PR #285 review, D3). */
describe('what the no-scroll check clicks', () => {
  it('runs at 1440 dark and at 390 dark on a touch device by default', () => {
    const { views } = parseArgs([]);
    expect(views.map((view) => view.name)).toEqual(['1440-dark', '390-dark']);
    expect(NO_SCROLL_VIEWS[1]).toMatchObject({ width: 390, theme: 'dark', touch: true });
    expect(NO_SCROLL_VIEWS[0]).toMatchObject({ width: 1440, theme: 'dark', touch: false });
  });

  it('runs one named view, or one custom view, when asked', () => {
    expect(parseArgs(['--view', '390-dark']).views.map((view) => view.name)).toEqual(['390-dark']);
    expect(parseArgs(['--width', '390', '--no-build', '/users'])).toMatchObject({
      build: false,
      routes: ['/users'],
      views: [{ width: 390, height: 844, theme: 'dark', touch: true }],
    });
    expect(() => parseArgs(['--view', '800-sepia'])).toThrow(/unknown --view/u);
  });

  it('clicks through every tab a route draws, one pass each, or once when it has none', () => {
    expect(tabPasses(0)).toEqual([null]);
    expect(tabPasses(9)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('clicks in-page anchors as well as buttons, and leaves tabs to their own pass', () => {
    expect(CLICKABLES).toContain('a[href^="#"]');
    expect(CLICKABLES).toContain("getAttribute('role') !== 'tab'");
    expect(TABS).toContain('[role=tab]');
  });

  it('judges a tab that writes itself into the query as a click on the same page', () => {
    const before = { route: '/users/x', content: 0, window: 0 };
    const after = { route: '/users/x?tab=wallet', content: 640, window: 0 };
    // As a navigation it would be waved through; on its own page it is a jump.
    expect(isJump(before, after)).toBe(false);
    expect(isJump(onPage(before), onPage(after))).toBe(true);
    expect(onPage(after).route).toBe('/users/x');
  });
});
