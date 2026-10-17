import { describe, expect, it } from 'vitest';
import { JUMP_TOLERANCE_PX, isJump } from '../../scripts/web-shots/no-scroll.mjs';

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
