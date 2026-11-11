/**
 * The address fragment the page was loaded with, captured when this module is evaluated.
 *
 * It must be the first import of `main.tsx`: other modules (the router) rewrite the history
 * entry at load, and a one-time link's `#token=…` has to be read before anything can touch it.
 * No imports here on purpose, so nothing can run ahead of the capture. Memory only.
 */
const captured: string = typeof window === 'undefined' ? '' : window.location.hash;

export function getInitialFragment(): string {
  return captured;
}
