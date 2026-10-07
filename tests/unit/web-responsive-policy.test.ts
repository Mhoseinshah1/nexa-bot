import { describe, expect, it } from 'vitest';
import {
  DEVICES,
  MIN_LABELLED_BOX,
  MIN_TARGET,
  clipped,
  responsiveProblems,
  undersized,
} from '../../scripts/web-shots/responsive-policy.mjs';

/**
 * `pnpm web:responsive` (roadmap B2/B7): what it calls a failure on a phone or a tablet.
 * The driver needs a Chromium and is not in the gate; the judgement it applies is, here.
 */
describe('a touch target', () => {
  it('is 44px square at least', () => {
    expect(MIN_TARGET).toBe(44);
    expect(undersized({ kind: 'button', w: 44, h: 44 })).toBe(false);
    expect(undersized({ kind: 'button', w: 120, h: 43 })).toBe(true);
    expect(undersized({ kind: 'button', w: 43, h: 120 })).toBe(true);
  });

  it('exempts only an inline link in running text', () => {
    expect(undersized({ kind: 'inline-link', w: 30, h: 16 })).toBe(false);
    expect(undersized({ kind: 'a', w: 30, h: 16 })).toBe(true);
  });

  it('holds a checkbox whose label sits apart to 24px, not to nothing', () => {
    expect(MIN_LABELLED_BOX).toBe(24);
    expect(undersized({ kind: 'labelled-box', w: 24, h: 24 })).toBe(false);
    expect(undersized({ kind: 'labelled-box', w: 15, h: 15 })).toBe(true);
  });
});

describe('a clipped control', () => {
  it('runs past an inline edge with nothing to scroll it into view', () => {
    expect(clipped({ left: 10, right: 390, inScroller: false }, 390)).toBe(false);
    expect(clipped({ left: 10, right: 420, inScroller: false }, 390)).toBe(true);
    expect(clipped({ left: -40, right: 20, inScroller: false }, 390)).toBe(true);
    // A wide table's wrapper scrolls: its cells are reachable.
    expect(clipped({ left: 10, right: 900, inScroller: true }, 390)).toBe(false);
  });
});

describe('what a measurement reports', () => {
  const clean = {
    coarse: true,
    width: 390,
    horizontalOverflow: 0,
    targets: [{ kind: 'button', desc: 'b', w: 44, h: 44, left: 0, right: 44, inScroller: false }],
    dialog: null,
    errors: [],
    unfixtured: [],
  };

  it('certifies a clean page', () => {
    expect(responsiveProblems(clean)).toEqual([]);
  });

  it('fails a device that is not touch, a sideways page, a small target and a cut control', () => {
    expect(responsiveProblems({ ...clean, coarse: false })[0]).toMatch(/coarse pointer/);
    expect(responsiveProblems({ ...clean, horizontalOverflow: 12 })[0]).toMatch(/12px/);
    expect(
      responsiveProblems({
        ...clean,
        targets: [{ ...clean.targets[0], w: 30 }],
      })[0],
    ).toMatch(/1 touch target/);
    expect(
      responsiveProblems({
        ...clean,
        targets: [{ ...clean.targets[0], left: 380, right: 424 }],
      })[0],
    ).toMatch(/cut off/);
  });

  it('fails a scenario dialog that is missing, too big, or hides its actions', () => {
    const dialog = { found: true, inside: true, footVisible: true };
    expect(responsiveProblems({ ...clean, dialog })).toEqual([]);
    expect(responsiveProblems({ ...clean, dialog: { ...dialog, found: false } })).toHaveLength(1);
    expect(responsiveProblems({ ...clean, dialog: { ...dialog, inside: false } })).toHaveLength(1);
    expect(
      responsiveProblems({ ...clean, dialog: { ...dialog, footVisible: false } }),
    ).toHaveLength(1);
  });

  it('measures a phone and a tablet', () => {
    expect(DEVICES.phone.width).toBeLessThan(640);
    expect(DEVICES.tablet.width).toBeGreaterThan(640);
    expect(DEVICES.tablet.width).toBeLessThan(980);
  });
});
