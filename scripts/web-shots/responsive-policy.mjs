/**
 * The decisions `pnpm web:responsive` makes, kept apart from the driver (which starts a
 * server and a browser the moment it runs) so the unit suite can pin them.
 */

/** The devices every route is measured on: a phone and a tablet, both touch. */
export const DEVICES = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
};

/** The smallest touch target, in CSS pixels, on a coarse pointer (WCAG 2.5.5). */
export const MIN_TARGET = 44;

/**
 * The floor for a checkbox or radio whose label sits apart from it (`<label for>`): the label
 * is a second target for the same control, so the box itself meets WCAG 2.5.8's 24px.
 */
export const MIN_LABELLED_BOX = 24;

/**
 * Whether a measured target is too small to hit with a finger.
 *
 * An inline link inside running text is exempt (WCAG 2.5.5's inline exception): its size is
 * the sentence's, and padding it would break the line. A checkbox or radio whose label sits
 * apart is held to `MIN_LABELLED_BOX`. Everything else — a button, a field, a tab, a link
 * drawn as a control — must be `MIN_TARGET` square at least.
 *
 * @param {{ kind: string, w: number, h: number }} target
 */
export function undersized(target) {
  if (target.kind === 'inline-link') return false;
  const floor = target.kind === 'labelled-box' ? MIN_LABELLED_BOX : MIN_TARGET;
  return target.w < floor || target.h < floor;
}

/**
 * Whether a target runs past the viewport's inline edges where the operator cannot scroll to
 * it. One inside a horizontally scrolling container (a wide table's wrapper) is reachable.
 *
 * @param {{ left: number, right: number, inScroller: boolean }} target
 * @param {number} width the viewport width
 */
export function clipped(target, width) {
  if (target.inScroller) return false;
  return target.left < -1 || target.right > width + 1;
}

/**
 * Everything about one measurement that fails the route on that device, as lines. An empty
 * list prints `ok`.
 *
 * @param {{
 *   coarse: boolean;
 *   width: number;
 *   horizontalOverflow: number;
 *   targets: readonly { kind: string, desc: string, w: number, h: number, left: number, right: number, inScroller: boolean }[];
 *   dialog?: { found: boolean, inside: boolean, footVisible: boolean } | null;
 *   errors: readonly string[];
 *   unfixtured: readonly string[];
 * }} facts
 * @returns {string[]}
 */
export function responsiveProblems(facts) {
  const small = facts.targets.filter(undersized);
  const cut = facts.targets.filter((target) => clipped(target, facts.width));
  const list = (items) =>
    items
      .slice(0, 6)
      .map((t) => `${t.desc} ${t.w}×${t.h}`)
      .join(', ') + (items.length > 6 ? `, … ${items.length - 6} more` : '');
  return [
    !facts.coarse && 'the device did not report a coarse pointer (touch emulation failed)',
    facts.horizontalOverflow > 0 && `page overflows sideways by ${facts.horizontalOverflow}px`,
    small.length > 0 && `${small.length} touch target(s) under ${MIN_TARGET}px: ${list(small)}`,
    cut.length > 0 && `${cut.length} control(s) cut off at the viewport edge: ${list(cut)}`,
    facts.dialog != null && !facts.dialog.found && 'the scenario opened no dialog',
    facts.dialog != null &&
      facts.dialog.found &&
      !facts.dialog.inside &&
      'the dialog does not fit inside the viewport',
    facts.dialog != null &&
      facts.dialog.found &&
      !facts.dialog.footVisible &&
      "the dialog's actions are off screen",
    facts.unfixtured.length > 0 && `unfixtured: ${facts.unfixtured.join(', ')}`,
    facts.errors.length > 0 && `console: ${facts.errors.join(' | ')}`,
  ].filter((line) => typeof line === 'string');
}
