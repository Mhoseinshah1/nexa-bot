import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * A history router, in about eighty lines.
 *
 * History rather than hash, because the edge already serves the SPA that way:
 * `deploy/caddy/routes.caddy` falls back with `try_files {path} /index.html`,
 * so `/panels/{id}` survives a refresh, a bookmark and a pasted link. The
 * preview used hash routing because it had no server; this one does.
 *
 * Not react-router. What this admin needs from a router is a current path, a
 * way to change it, and pattern matching — and a dependency that ships a data
 * layer, lazy boundaries and its own history abstraction to provide those is a
 * larger surface than the thing it replaces. If nested layouts or route-level
 * data loading ever earn their keep, swapping this out is a change to three
 * functions.
 */

export interface Route {
  /** Always begins with `/` and never ends with one, except the root itself. */
  readonly path: string;
  readonly query: URLSearchParams;
}

type Listener = () => void;

const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The snapshot must be REFERENTIALLY STABLE between navigations.
 *
 * `useSyncExternalStore` compares snapshots with `Object.is` and re-renders
 * whenever they differ. Building a fresh object on every call made every
 * snapshot a new reference, which React reads as "changed" — an infinite
 * render loop rather than a routing bug, and it only appears once something
 * else in the tree re-renders. So the snapshot is cached and replaced only
 * when the location string actually changes.
 */
/**
 * Initialised LAZILY, on the first read.
 *
 * Reading `window` at module scope makes importing anything that imports this
 * file throw in a non-browser environment — and `app.tsx` imports it, so a
 * pure unit test of a pure function in `app.tsx` died on `window is not
 * defined`. The router is only ever consulted from a component, by which point
 * there is a document.
 */
let snapshot: Route | null = null;
let snapshotKey = '';

function key(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function read(): Route {
  const raw = window.location.pathname || '/';
  const path = raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
  return { path, query: new URLSearchParams(window.location.search) };
}

function refresh(): void {
  const next = key();
  if (next === snapshotKey && snapshot !== null) return;
  snapshotKey = next;
  snapshot = read();
  emit();
}

/*
 * ---------------------------------------------------------------------------
 * Leaving a page with unsaved changes
 * ---------------------------------------------------------------------------
 *
 * A form that is dirty registers a GUARD (`useUnsavedChanges` in the kit). While
 * any guard is held, a navigation that would unmount the page — a different
 * path, or a query change the caller marks as guarded, such as a `?tab=` switch
 * that unmounts a tab's form — is not performed. It is parked as PENDING and the
 * shell's `LeaveGuardHost` asks the operator; confirming performs it, cancelling
 * drops it.
 *
 * Browser back/forward cannot be cancelled before it happens: `popstate` fires
 * after the URL has changed. So a guarded popstate puts the page's own URL
 * back (a push, since there is no way to undo a traversal) and parks the
 * destination the operator was heading for, which a confirmation then visits.
 *
 * With no host mounted (a page rendered on its own, as the web suite does)
 * nothing could ask, so nothing is blocked: a guard never becomes a navigation
 * that silently does not happen.
 */
export interface PendingLeave {
  readonly to: string;
  readonly replace: boolean;
  /** The question the most recent guard asked to be put, if it named one. */
  readonly message: string | undefined;
}

const guards = new Map<symbol, string | undefined>();
let hosts = 0;
let pending: PendingLeave | null = null;
const pendingListeners = new Set<Listener>();

function emitPending(): void {
  for (const listener of pendingListeners) listener();
}

/** Holds a guard until the returned release is called. */
export function holdLeaveGuard(message?: string): () => void {
  const id = Symbol('leave-guard');
  guards.set(id, message);
  return () => {
    guards.delete(id);
  };
}

/** Whether any page currently holds a guard. */
export function leaveGuarded(): boolean {
  return guards.size > 0 && hosts > 0;
}

function guardMessage(): string | undefined {
  let last: string | undefined;
  for (const message of guards.values()) if (message !== undefined) last = message;
  return last;
}

function pathOf(to: string): string {
  const path = new URL(to, window.location.origin).pathname || '/';
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function park(to: string, replace: boolean): void {
  pending = { to, replace, message: guardMessage() };
  emitPending();
}

/** For the shell's host: the navigation waiting on an answer, and the two answers. */
export function usePendingLeave(): {
  pending: PendingLeave | null;
  leave: () => void;
  stay: () => void;
} {
  useEffect(() => {
    hosts += 1;
    return () => {
      hosts -= 1;
      if (hosts === 0 && pending !== null) {
        pending = null;
        emitPending();
      }
    };
  }, []);
  const current = useSyncExternalStore(
    (listener) => {
      pendingListeners.add(listener);
      return () => {
        pendingListeners.delete(listener);
      };
    },
    () => pending,
    () => pending,
  );
  const leave = useCallback(() => {
    const target = pending;
    pending = null;
    emitPending();
    if (target !== null) navigate(target.to, { replace: target.replace, force: true });
  }, []);
  const stay = useCallback(() => {
    pending = null;
    emitPending();
  }, []);
  return { pending: current, leave, stay };
}

function onPopState(): void {
  const next = key();
  if (leaveGuarded() && snapshot !== null && pathOf(next) !== snapshot.path) {
    // Put the page the operator is on back, and ask about the one they were going to.
    const here = snapshotKey;
    window.history.pushState(null, '', here);
    park(next, false);
    return;
  }
  refresh();
}

function getSnapshot(): Route {
  if (snapshot === null) {
    snapshot = read();
    snapshotKey = key();
  }
  return snapshot;
}

/** The server never renders this admin, but the hook contract wants the case. */
function getServerSnapshot(): Route {
  return getSnapshot();
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', onPopState);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export interface NavigateOptions {
  readonly replace?: boolean;
  /**
   * `true` asks the leave guard even when only the query changes — a `?tab=`
   * switch that unmounts a tab's form. By default only a change of PATH is
   * guarded, so a filter or a pager never interrupts the operator.
   */
  readonly guard?: boolean;
  /** Skips the leave guard: the operator has already answered it. */
  readonly force?: boolean;
}

export function navigate(to: string, options: NavigateOptions = {}): void {
  if (options.force !== true && leaveGuarded()) {
    const current = getSnapshot();
    if (options.guard === true || pathOf(to) !== current.path) {
      park(to, options.replace === true);
      return;
    }
  }
  if (options.replace === true) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  refresh();
}

/**
 * An anchor's click handler that navigates without a full page load.
 *
 * Modified clicks are left alone on purpose: ctrl/cmd-click opens a new tab,
 * and a router that swallows that has taken a browser affordance away from the
 * operator to gain nothing.
 */
export function useLinkHandler(): (event: React.MouseEvent<HTMLAnchorElement>) => void {
  return useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const href = event.currentTarget.getAttribute('href');
    if (href === null || !href.startsWith('/')) return;
    event.preventDefault();
    navigate(href);
  }, []);
}

/**
 * `match('/panels/:id', '/panels/abc')` → `{ id: 'abc' }`, else null.
 *
 * Segment counts must be equal. A prefix match would make `/panels` match
 * `/panels/abc`, and the list would render over the detail.
 */
export function match(pattern: string, path: string): Record<string, string> | null {
  const wanted = pattern.split('/').filter(Boolean);
  const actual = path.split('/').filter(Boolean);
  if (wanted.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < wanted.length; index += 1) {
    const segment = wanted[index] ?? '';
    const value = actual[index] ?? '';
    if (segment.startsWith(':')) {
      // `decodeURIComponent` THROWS on a malformed escape such as `%E0`, and
      // `match` runs inside `resolve` during render — with no error boundary
      // above it, one hand-typed URL took the whole signed-in admin down. A
      // route that cannot be decoded is a route that does not match.
      let decoded: string;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        return null;
      }
      params[segment.slice(1)] = decoded;
    } else if (segment !== value) return null;
  }
  return params;
}

/** Replaces one query parameter, keeping the rest and the current path. */
export function setQuery(
  route: Route,
  key: string,
  value: string | null,
  options: { guard?: boolean } = {},
): void {
  const next = new URLSearchParams(route.query);
  if (value === null || value === '') next.delete(key);
  else next.set(key, value);
  const suffix = next.toString();
  // `replace`, not push: a filter change is not a place an operator navigated
  // to, and stacking one history entry per keystroke makes Back unusable.
  navigate(suffix ? `${route.path}?${suffix}` : route.path, {
    replace: true,
    ...(options.guard === true ? { guard: true } : {}),
  });
}

/**
 * Replaces SEVERAL query parameters at once, keeping the rest and the current path.
 *
 * This exists because calling `setQuery` twice in one handler silently drops the first
 * change. Each call builds its `URLSearchParams` from `route.query` — a PROP, captured
 * when the component rendered — and then navigates. The navigation is asynchronous with
 * respect to that prop, so the second call reads the same pre-navigation query the first
 * did and overwrites its result. A two-field filter applied one field.
 *
 * Found by the Codex review of the 4B branch on `/orders`; `/users` from 4A had it too.
 * The SHAPE is the bug, so the fix is a function that cannot be written that way rather
 * than two careful call sites.
 *
 * `replace`, not push, for the same reason `setQuery` gives.
 */
export function setQueries(
  route: Route,
  entries: ReadonlyArray<readonly [string, string | null]>,
): void {
  const next = new URLSearchParams(route.query);
  for (const [key, value] of entries) {
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
  }
  const suffix = next.toString();
  navigate(suffix ? `${route.path}?${suffix}` : route.path, { replace: true });
}

/** Puts the document title in step with the route, for tabs and history. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
