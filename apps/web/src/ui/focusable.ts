/**
 * What a focus trap may move focus to, shared by `useFocusTrap` and `ConfirmDialog`.
 *
 * A selector alone is not the answer. It also matches a control inside a `[hidden]` toolbar,
 * a closed `<details>`, an `inert` subtree, or a control taken out of the tab order with
 * `tabindex="-1"` (a menu's items). If such a control was the LAST match, the trap waited for
 * Tab on an element focus could never reach, and the browser's own Tab carried focus out of
 * the dialog to the page behind it. The same holds for a control hidden by CSS
 * (`display: none` from a class or a media query, `visibility: hidden`).
 */
const FOCUSABLE =
  'button:not([disabled]), a[href], area[href], input:not([disabled]):not([type="hidden"]), ' +
  'select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([disabled])';

/**
 * Whether CSS draws the element at all. `checkVisibility` where the browser has it (one
 * call, no layout walk of our own); otherwise the computed style of the element and its
 * ancestors up to `root`, which is what a test DOM can answer.
 */
function rendered(element: HTMLElement, root: HTMLElement): boolean {
  const probe = element as HTMLElement & {
    checkVisibility?: (options?: { visibilityProperty?: boolean }) => boolean;
  };
  if (typeof probe.checkVisibility === 'function') {
    return probe.checkVisibility({ visibilityProperty: true });
  }
  const view = element.ownerDocument.defaultView;
  if (view === null) return true;
  if (view.getComputedStyle(element).visibility === 'hidden') return false;
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    if (view.getComputedStyle(node).display === 'none') return false;
    if (node === root) break;
  }
  return true;
}

function reachable(element: HTMLElement, root: HTMLElement): boolean {
  if (element.getAttribute('tabindex') === '-1') return false;
  if (element.closest('[hidden], [inert], fieldset[disabled]') !== null) return false;
  // Inside a closed <details> — at any depth — only that details' own <summary> takes focus.
  for (
    let details = element.parentElement?.closest('details') ?? null;
    details !== null;
    details = details.parentElement?.closest('details') ?? null
  ) {
    if (details.open) continue;
    const summary = details.querySelector(':scope > summary');
    if (summary === null || !summary.contains(element)) return false;
  }
  return rendered(element, root);
}

/** The controls Tab can actually reach inside `root`, in document order. */
export function tabbable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) =>
    reachable(element, root),
  );
}

/**
 * The open focus traps. Only the top one answers Tab and Escape: a dialog opened over a
 * drawer used to let BOTH document listeners run, so one Escape closed both and the drawer's
 * trap pulled Tab focus back out of the dialog.
 *
 * "Top" is the highest RANK, not the last registration. Effects run child-first, so a drawer
 * and the dialog inside it activating in the same commit registered the dialog first and the
 * drawer on top of it. A rank is taken during RENDER, which runs parent-first, at the moment
 * a trap turns active (`nextTrapRank`): the inner dialog always outranks the drawer it sits in,
 * and a trap opened later outranks one opened before.
 */
const traps: { token: object; rank: number }[] = [];
let lastRank = 0;

export function nextTrapRank(): number {
  lastRank += 1;
  return lastRank;
}

export function pushTrap(token: object, rank: number): () => void {
  traps.push({ token, rank });
  return () => {
    const at = traps.findIndex((entry) => entry.token === token);
    if (at !== -1) traps.splice(at, 1);
  };
}

export function isTopTrap(token: object): boolean {
  let top: { token: object; rank: number } | undefined;
  for (const entry of traps) if (top === undefined || entry.rank > top.rank) top = entry;
  return top?.token === token;
}
