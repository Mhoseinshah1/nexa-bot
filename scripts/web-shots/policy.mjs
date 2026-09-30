/**
 * The two decisions `pnpm web:shots` makes that are worth a unit test.
 *
 * Kept apart from `shots.mjs`, which starts a server and a browser the moment
 * it is imported, so the suite can pin them without doing either.
 */

/**
 * Whether this Node must be re-run with `--experimental-strip-types` before
 * the script can import the TypeScript fixtures in `tests/web/shots/`.
 *
 * The repository's floor is Node 22.11 (`engines`), and type stripping is on
 * by default only from 22.18. Between the two, `process.features.typescript`
 * is `false` and a `.ts` import fails with `ERR_UNKNOWN_FILE_EXTENSION` before
 * a single screenshot is taken. `'strip'` or `'transform'` means it is on.
 *
 * @param {{ typescript?: unknown } | undefined} features `process.features`
 * @returns {boolean}
 */
export function needsTypeStripping(features) {
  const mode = features?.typescript;
  return mode !== 'strip' && mode !== 'transform';
}

/**
 * Everything about one capture that stops it certifying the page, as lines.
 *
 * An empty list prints `ok`. `settled: false` is on it: a capture whose network
 * never went quiet before `--timeout` may be an intermediate frame, even when
 * no skeleton or error card happens to be on screen at that instant.
 *
 * @param {{
 *   unfixtured: readonly string[];
 *   settled: boolean;
 *   stillLoading: boolean;
 *   errorStates: number;
 *   horizontalOverflow: number;
 *   errors: readonly string[];
 *   timeoutMs?: number;
 * }} entry
 * @returns {string[]}
 */
export function shotProblems(entry) {
  return [
    entry.unfixtured.length > 0 && `unfixtured: ${entry.unfixtured.join(', ')}`,
    !entry.settled &&
      `never settled${entry.timeoutMs !== undefined ? ` within ${entry.timeoutMs}ms` : ''} (requests were still active)`,
    entry.stillLoading && 'still loading (a skeleton was on screen)',
    entry.errorStates > 0 && `${entry.errorStates} error state(s) drawn`,
    entry.horizontalOverflow > 0 && `page overflows sideways by ${entry.horizontalOverflow}px`,
    entry.errors.length > 0 && `console: ${entry.errors.join(' | ')}`,
  ].filter((line) => typeof line === 'string');
}
