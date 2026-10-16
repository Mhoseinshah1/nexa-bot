import { useSyncExternalStore } from 'react';
import type { WebKey } from '../i18n/web.fa';
import { setQueries, type Route } from '../router';
import { resetSearchDrafts } from './list-search';

/**
 * Saved filters (W1.4) — the model and its storage. LOCAL ONLY in v1: per admin and per
 * installation, in `localStorage` under `nexa.views.v1:<scope>:<adminId>`, every access
 * wrapped in try/catch so the menu works (in memory) without storage. There is no shared
 * («همهٔ مدیران») option — that needs server storage and is a follow-up.
 *
 * A view's state is the page's FILTER QUERY PARAMETERS (the filters already live in the URL),
 * as a flat string record. `get` reads them from the route, `set` writes them with
 * `setQueries`, so applying a view is exactly the navigation the page's own controls make.
 * `routeViewRegistration` builds that pair from a route and a list of keys.
 *
 * Rules: at most 12 views per page, names trimmed, at least 2 characters, unique on the page
 * (ignoring case); at most one default per page. Everything is a pure function over the
 * page's list (`addView`, `renameView`, …), and `useSavedViews` binds them to the store.
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
export const SAVED_VIEW_NAME_MAX = 40;

export function savedViewsStorageKey(scope: string, adminId: string): string {
  return `${SAVED_VIEWS_PREFIX}:${scope}:${adminId}`;
}

/* ------------------------------------------------------------------ states --- */

/** The state with every key the page knows, and only those whose value differs from empty. */
export function normalizeViewState(empty: ViewState, state: ViewState): ViewState {
  const out: Record<string, string> = {};
  for (const key of Object.keys(empty).sort()) {
    const value = state[key] ?? empty[key] ?? '';
    if (value !== (empty[key] ?? '')) out[key] = value;
  }
  return out;
}

export function sameViewState(empty: ViewState, a: ViewState, b: ViewState): boolean {
  return (
    JSON.stringify(normalizeViewState(empty, a)) === JSON.stringify(normalizeViewState(empty, b))
  );
}

export function isEmptyViewState(empty: ViewState, state: ViewState): boolean {
  return Object.keys(normalizeViewState(empty, state)).length === 0;
}

/* ------------------------------------------------------------- the rules --- */

export type ViewNameError = 'too_short' | 'taken' | 'full';

function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase('fa');
}

export function validateViewName(
  views: readonly SavedView[],
  name: string,
  exceptId?: string,
): ViewNameError | null {
  const trimmed = name.trim();
  if (trimmed.length < SAVED_VIEW_NAME_MIN) return 'too_short';
  if (views.some((view) => view.id !== exceptId && nameKey(view.name) === nameKey(trimmed))) {
    return 'taken';
  }
  return null;
}

let sequence = 0;
function newId(): string {
  sequence += 1;
  return `v${Date.now().toString(36)}${sequence.toString(36)}`;
}

export function addView(
  views: readonly SavedView[],
  input: { name: string; state: ViewState; isDefault: boolean },
): { views: readonly SavedView[]; view: SavedView } | { error: ViewNameError } {
  if (views.length >= SAVED_VIEWS_MAX_PER_PAGE) return { error: 'full' };
  const error = validateViewName(views, input.name);
  if (error !== null) return { error };
  const view: SavedView = {
    id: newId(),
    name: input.name.trim().slice(0, SAVED_VIEW_NAME_MAX),
    state: input.state,
    isDefault: input.isDefault,
  };
  const rest = input.isDefault ? views.map((one) => ({ ...one, isDefault: false })) : views;
  return { views: [...rest, view], view };
}

export function renameView(
  views: readonly SavedView[],
  id: string,
  name: string,
): { views: readonly SavedView[] } | { error: ViewNameError } {
  const error = validateViewName(views, name, id);
  if (error !== null) return { error };
  const trimmed = name.trim().slice(0, SAVED_VIEW_NAME_MAX);
  return { views: views.map((view) => (view.id === id ? { ...view, name: trimmed } : view)) };
}

export function updateViewState(
  views: readonly SavedView[],
  id: string,
  state: ViewState,
): readonly SavedView[] {
  return views.map((view) => (view.id === id ? { ...view, state } : view));
}

/** `null` clears the default. */
export function setDefaultView(
  views: readonly SavedView[],
  id: string | null,
): readonly SavedView[] {
  return views.map((view) => ({ ...view, isDefault: view.id === id }));
}

export function moveView(
  views: readonly SavedView[],
  id: string,
  delta: -1 | 1,
): readonly SavedView[] {
  const at = views.findIndex((view) => view.id === id);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= views.length) return views;
  const next = [...views];
  const [moved] = next.splice(at, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

export function removeView(
  views: readonly SavedView[],
  id: string,
): { views: readonly SavedView[]; removed: { view: SavedView; index: number } | null } {
  const index = views.findIndex((view) => view.id === id);
  const view = views[index];
  if (view === undefined) return { views, removed: null };
  return { views: views.filter((one) => one.id !== id), removed: { view, index } };
}

/** Undo of `removeView`: back where it was (a default stays the only default). */
export function restoreView(
  views: readonly SavedView[],
  removed: { view: SavedView; index: number },
): readonly SavedView[] {
  if (views.some((one) => one.id === removed.view.id)) return views;
  if (views.length >= SAVED_VIEWS_MAX_PER_PAGE) return views;
  const base = removed.view.isDefault ? views.map((one) => ({ ...one, isDefault: false })) : views;
  const next = [...base];
  next.splice(Math.min(removed.index, next.length), 0, removed.view);
  return next;
}

/* ----------------------------------------------------------------- storage --- */

type Data = Readonly<Record<string, readonly SavedView[]>>;

const NO_VIEWS: readonly SavedView[] = [];
/** Read once per key, then held here: the store when storage is unavailable. */
const memory = new Map<string, Data>();
const listeners = new Map<string, Set<() => void>>();

function sanitize(raw: unknown): Data {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, readonly SavedView[]> = {};
  for (const [page, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const views: SavedView[] = [];
    for (const item of list as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const { id, name, state, isDefault } = item as Record<string, unknown>;
      if (typeof id !== 'string' || typeof name !== 'string') continue;
      if (typeof state !== 'object' || state === null || Array.isArray(state)) continue;
      const clean: Record<string, string> = {};
      for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
        if (typeof value === 'string') clean[key] = value;
      }
      views.push({ id, name, state: clean, isDefault: isDefault === true });
      if (views.length >= SAVED_VIEWS_MAX_PER_PAGE) break;
    }
    out[page] = views;
  }
  return out;
}

function read(key: string): Data {
  const held = memory.get(key);
  if (held !== undefined) return held;
  let data: Data = {};
  try {
    const raw = window.localStorage.getItem(key);
    if (raw !== null) data = sanitize(JSON.parse(raw));
  } catch {
    // No storage, or a value that is not ours: start empty, in memory.
  }
  memory.set(key, data);
  return data;
}

function write(key: string, page: string, views: readonly SavedView[]): void {
  const data = { ...read(key), [page]: views };
  memory.set(key, data);
  try {
    window.localStorage.setItem(key, JSON.stringify(data));
  } catch {
    // Storage is full or refused: the views live in memory for this session.
  }
  for (const listener of listeners.get(key) ?? []) listener();
}

/** For tests: forget what was read, so the next read goes to storage again. */
export function forgetSavedViewsMemory(): void {
  memory.clear();
}

/** The views of one page under one storage key, and the one way to change them. */
export function useSavedViews(
  key: string,
  page: string,
): {
  views: readonly SavedView[];
  replace: (next: readonly SavedView[]) => void;
} {
  const views = useSyncExternalStore(
    (listener) => {
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => set.delete(listener);
    },
    () => read(key)[page] ?? NO_VIEWS,
  );
  return { views, replace: (next) => write(key, page, next) };
}

/* ------------------------------------------------------------ registration --- */

/**
 * A registration for a list whose filters live in the URL: `keys` are its filter query
 * parameters (the search's `q` included, when it has one). Applying a view is ONE
 * `setQueries` that sets every key and drops the list's `cursor`, and empties the search
 * box's draft as «پاک کردن همه» does.
 */
export function routeViewRegistration(
  route: Route,
  page: string,
  keys: readonly string[],
  presets: readonly ViewPreset[] = [],
  empty: ViewState = Object.fromEntries(keys.map((key) => [key, ''])),
): SavedViewsRegistration {
  return {
    page,
    empty,
    get: () =>
      Object.fromEntries(keys.map((key) => [key, route.query.get(key) ?? empty[key] ?? ''])),
    set: (state) => {
      resetSearchDrafts();
      setQueries(route, [
        ...keys.map((key) => {
          const value = state[key] ?? empty[key] ?? '';
          // A value equal to the page's default is left out of the URL, as its controls do.
          return [key, value === '' || value === (empty[key] ?? '') ? null : value] as const;
        }),
        ['cursor', null] as const,
      ]);
    },
    presets,
  };
}
