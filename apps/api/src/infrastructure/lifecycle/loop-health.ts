/**
 * Which of a process's background loops have stopped making progress.
 *
 * One function, extracted from `main.worker.ts`, for one reason: inside that
 * file it was a closure inside `main()`, reachable only by booting the whole
 * role, and so it had no test. Replacing its `filter` with `[]` — a worker that
 * reports healthy whatever its loops are doing — left the suite green. The
 * comment above it said the aggregation "is a `filter` and needs no test",
 * which is the kind of claim this repository has learned to distrust: the
 * mutation that inverts a rule is never the one that looks hard.
 *
 * The flag is taken as data rather than folded into the boolean by the caller
 * (`!config.X || loop.isFresh(now)`) because "a disabled loop is not a broken
 * loop" is itself a rule worth being able to falsify. A disabled loop never had
 * `begin()` called, so its `isFresh` is false for ever — read as a failure, that
 * would make every deployment with the relay switched off permanently unhealthy.
 */
export type LoopHealth = readonly [name: string, enabled: boolean, isFresh: () => boolean];

/**
 * The names of the loops that are enabled and are not fresh, in the order given.
 *
 * Freshness is a thunk so a disabled loop is never CONSULTED, not merely
 * ignored after the fact. That matters beyond tidiness: reading `isFresh` on a
 * loop that was never started is reading a value whose meaning is "no claim",
 * and a future implementation is free to make that read do work or assert.
 */
export function stalledLoops(loops: readonly LoopHealth[]): readonly string[] {
  return loops.filter(([, enabled, isFresh]) => enabled && !isFresh()).map(([name]) => name);
}
