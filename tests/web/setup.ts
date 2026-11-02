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

/**
 * Latin digits everywhere (owner decision, R11): after EVERY web test, the document the test
 * rendered must hold no Persian digit (U+06F0-U+06F9), in text or in an attribute (`title`,
 * `aria-label`, `placeholder`...). This is the rule's guard: a formatter, a catalogue string or
 * a stylesheet-free page that reintroduces one fails the test that rendered it. A test that
 * renders typed Persian digits on purpose (to prove they are normalised) opts out for itself
 * with `globalThis.__NEXA_ALLOW_PERSIAN_DIGITS__ = true`; the flag resets after each test.
 */
const PERSIAN_DIGIT = /[\u06f0-\u06f9]/u;
afterEach(() => {
  const flags = globalThis as { __NEXA_ALLOW_PERSIAN_DIGITS__?: boolean };
  const allowed = flags.__NEXA_ALLOW_PERSIAN_DIGITS__ === true;
  flags.__NEXA_ALLOW_PERSIAN_DIGITS__ = false;
  if (allowed || typeof document === 'undefined') return;
  const found: string[] = [];
  if (PERSIAN_DIGIT.test(document.body.textContent ?? '')) found.push('text');
  for (const element of Array.from(document.body.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      // A typed `value` is the operator's own input, normalised on the way out, not drawn text.
      if (attribute.name !== 'value' && PERSIAN_DIGIT.test(attribute.value)) {
        found.push(`${element.tagName.toLowerCase()}[${attribute.name}]`);
      }
    }
  }
  if (found.length > 0) {
    cleanup();
    throw new Error(
      `Persian digits (U+06F0-U+06F9) were rendered into the DOM (${found.slice(0, 5).join(', ')}); ` +
        'the admin draws Latin digits everywhere.',
    );
  }
});

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
