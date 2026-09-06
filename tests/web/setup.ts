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

afterEach(() => {
  cleanup();
});
