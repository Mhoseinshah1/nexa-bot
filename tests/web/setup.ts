import { afterEach, expect, vi } from 'vitest';
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
 * It ANSWERS THE QUERY rather than returning one verdict to everything. Two
 * call sites ask different questions — `theme.ts` asks
 * `(prefers-color-scheme: light)` and `app.tsx` asks `(max-width: 980px)` — so
 * a blanket `true` claimed light and dark at once, and claimed a narrow
 * viewport while `window.innerWidth` said 1024. Both were inert only by
 * accident, and a stub that contradicts itself is worse than none: the first
 * test to depend on either would have been written against a lie.
 *
 * Light, because that is what a headless browser reports; wide, because that is
 * what jsdom's default `innerWidth` says. An even earlier version returned
 * `false` under a comment calling it "the light-scheme answer" —
 * `resolveTheme('system', false)` is `'dark'`, so the comment named the
 * opposite of what it installed.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        // Light, because that is what a headless browser reports. Everything
        // else is `false`, which for `(max-width: 980px)` agrees with jsdom's
        // 1024px `innerWidth` — the value `app.tsx` reads for the same
        // decision. A future `(min-width: …)` caller would need its own arm
        // rather than this default.
        matches: /prefers-color-scheme:\s*light/.test(query),
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
  /*
   * `restoreMocks` restores `vi.spyOn` and NOT `vi.stubGlobal`, and
   * `unstubGlobals` is not set — so a stubbed `fetch` survived into the next
   * test and was displaced only because every following test happened to stub
   * one first. One of those stubs resolves a held promise after its own test
   * has returned. Latent, and exactly the kind of invariant nothing enforces.
   */
  vi.unstubAllGlobals();
  /*
   * And the timers, for the same reason one step further on.
   *
   * A test that installs fake timers restores them as its LAST statement, which
   * a failing assertion skips — so the test AFTER a failure runs on a clock
   * nothing is advancing. `restoreMocks` does not cover timers either. This
   * matters most exactly when it is hardest to see: a mutation run, where the
   * first failure is expected and every test after it is the evidence that the
   * mutation killed nothing else.
   */
  vi.useRealTimers();
});
