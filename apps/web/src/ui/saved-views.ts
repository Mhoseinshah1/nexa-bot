import type { WebKey } from '../i18n/web.fa';

/**
 * Saved filters (W1.4) — the model and its storage. LOCAL ONLY in v1: per admin and per
 * installation, in `localStorage` under `nexa.views.v1:<scope>:<adminId>`, every access
 * wrapped in try/catch so the menu works (in memory) without storage. There is no shared
 * («همهٔ مدیران») option — that needs server storage and is a follow-up.
 *
 * A view's state is the page's FILTER QUERY PARAMETERS (the filters already live in the URL),
 * as a flat string record. `get` reads them from the route, `set` writes them with
 * `setQueries`, so applying a view is exactly the navigation the page's own controls make.
 *
 * PHASE-0 INTERFACE STUB — agent A implements the store (create, rename, default, reorder,
 * delete with undo, 12-per-page cap, unique names of 2+ characters) and its tests.
 */
export type ViewState = Readonly<Record<string, string>>;

export interface SavedView {
  readonly id: string;
  readonly name: string;
  readonly state: ViewState;
  readonly isDefault: boolean;
}

export interface ViewPreset {
  readonly id: string;
  readonly name: WebKey;
  /** Merged over `empty`. */
  readonly state: ViewState;
}

/** What a list registers with the menu. */
export interface SavedViewsRegistration {
  /** The page's storage id, e.g. `users`. */
  readonly page: string;
  /** The state with no filter applied. */
  readonly empty: ViewState;
  /** The filters in force now. */
  readonly get: () => ViewState;
  /** Applies a state (a navigation). */
  readonly set: (state: ViewState) => void;
  /**
   * How many rows a state would show — ONLY if the server can answer it as a real total. No
   * list has one today, so every registration leaves it out and the menu draws no count.
   */
  readonly count?: (state: ViewState) => number | undefined;
  readonly presets: readonly ViewPreset[];
}

export const SAVED_VIEWS_PREFIX = 'nexa.views.v1';
export const SAVED_VIEWS_MAX_PER_PAGE = 12;
export const SAVED_VIEW_NAME_MIN = 2;

export function savedViewsStorageKey(scope: string, adminId: string): string {
  return `${SAVED_VIEWS_PREFIX}:${scope}:${adminId}`;
}
