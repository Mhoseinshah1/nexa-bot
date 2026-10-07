/**
 * What a focus trap may move focus to, shared by `useFocusTrap` and `ConfirmDialog`.
 *
 * A selector alone is not the answer. It also matches a control inside a `[hidden]` toolbar,
 * a closed `<details>`, an `inert` subtree, or a control taken out of the tab order with
 * `tabindex="-1"` (a menu's items). If such a control was the LAST match, the trap waited for
 * Tab on an element focus could never reach, and the browser's own Tab carried focus out of
 * the dialog to the page behind it.
 */
const FOCUSABLE =
  'button:not([disabled]), a[href], area[href], input:not([disabled]):not([type="hidden"]), ' +
  'select:not([disabled]), textarea:not([disabled]), summary, [tabindex]';

function reachable(element: HTMLElement): boolean {
  if (element.getAttribute('tabindex') === '-1') return false;
  if (element.closest('[hidden], [inert], fieldset[disabled]') !== null) return false;
  // Inside a closed <details>, only its own <summary> can take focus.
  const details = element.parentElement?.closest('details');
  if (details !== null && details !== undefined && !details.open) {
    const summary = details.querySelector(':scope > summary');
    if (summary === null || !summary.contains(element)) return false;
  }
  return true;
}

/** The controls Tab can actually reach inside `root`, in document order. */
export function tabbable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(reachable);
}

/**
 * The open focus traps, innermost last. Only the top one answers Tab and Escape: a dialog
 * opened over a drawer used to let BOTH document listeners run, so one Escape closed both and
 * the drawer's trap pulled Tab focus back out of the dialog.
 */
const traps: object[] = [];

export function pushTrap(token: object): () => void {
  traps.push(token);
  return () => {
    const at = traps.lastIndexOf(token);
    if (at !== -1) traps.splice(at, 1);
  };
}

export function isTopTrap(token: object): boolean {
  return traps[traps.length - 1] === token;
}
