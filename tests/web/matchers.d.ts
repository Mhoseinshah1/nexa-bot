import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

/**
 * `toBeInTheDocument` and friends, taught to Vitest's `expect`.
 *
 * `@testing-library/jest-dom` ships its ambient types for Jest's globals, which
 * this repository does not use. The matchers are registered at runtime in
 * `setup.ts`; this is the half the type checker needs.
 */
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Matchers<T = unknown> extends TestingLibraryMatchers<unknown, T> {}
}
