/**
 * Per-section timing of the one-time Mirza import (dry run and apply).
 *
 * One structured line per section: its name, how many rows it handled and how long it took.
 * Counts and milliseconds ONLY — never a name, an id, an amount, a key or any row content —
 * so the line is safe in any log sink. It is how an operator (and the next person tuning the
 * importer) sees which section dominates a long import.
 */
export interface SectionTimingLogger {
  info(context: Record<string, unknown>, message: string): void;
}

export const SECTION_TIMING_MESSAGE = 'legacy import section timed';

/** Logs `{ section, rows, ms }` once `fn` settles (an error is logged as `failed: true`). */
export async function timedSection<T>(
  logger: SectionTimingLogger | undefined,
  section: string,
  fn: () => Promise<T>,
  rows?: (result: T) => number | undefined,
): Promise<T> {
  if (logger === undefined) return fn();
  const started = performance.now();
  let failed = true;
  let count: number | undefined;
  try {
    const result = await fn();
    failed = false;
    count = rows?.(result);
    return result;
  } finally {
    logger.info(
      {
        section,
        ...(count === undefined ? {} : { rows: count }),
        ms: Math.round(performance.now() - started),
        ...(failed ? { failed: true } : {}),
      },
      SECTION_TIMING_MESSAGE,
    );
  }
}
