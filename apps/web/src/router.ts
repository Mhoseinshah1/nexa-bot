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
  window.addEventListener('popstate', refresh);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
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
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(value);
    else if (segment !== value) return null;
  }
  return params;
}

/** Replaces one query parameter, keeping the rest and the current path. */
export function setQuery(route: Route, key: string, value: string | null): void {
  const next = new URLSearchParams(route.query);
  if (value === null || value === '') next.delete(key);
  else next.set(key, value);
  const suffix = next.toString();
  // `replace`, not push: a filter change is not a place an operator navigated
  // to, and stacking one history entry per keystroke makes Back unusable.
  navigate(suffix ? `${route.path}?${suffix}` : route.path, { replace: true });
}

/** Puts the document title in step with the route, for tabs and history. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
