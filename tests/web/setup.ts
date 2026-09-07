import { afterEach, expect } from 'vitest';
import { cleanup } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

/**
 * The Web Admin suite's environment.
 *
 * `cleanup` after every test because these render into a shared document: a
 * leftover tree makes the next test's `getByRole` ambiguous, and the failure
 * reads as a duplicate element rather than as a test that forgot to tidy up.
 */
expect.extend(matchers);

/**
 * jsdom implements no `matchMedia`, and `useTheme` calls it while the choice is
 * `system` — which is the default. Every test that renders the whole shell
 * therefore threw an unhandled error AFTER its assertions had passed, so the
 * suite reported "233 passed" and a failing exit code at the same time.
 *
 * A real `MediaQueryList` shape rather than a no-op object: the effect
 * subscribes and unsubscribes, and a stub missing either method would fail on
 * cleanup instead.
 *
 * `matches: true` because the query `theme.ts` asks is
 * `(prefers-color-scheme: light)`, so `true` means LIGHT — which is what a
 * headless browser reports, and therefore what a test should get. An earlier
 * version returned `false` under a comment calling it "the light-scheme
 * answer"; `resolveTheme('system', false)` is `'dark'`, so the comment named
 * the opposite of what it installed. Nothing depended on it yet, which is
 * exactly when a comment like that survives to mislead the first test that
 * does.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}

afterEach(() => {
  cleanup();
});
