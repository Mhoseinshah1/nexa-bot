import type { LegacyMaterializeOutcome } from '@nexa/contracts';
import type { ExactMatchRow, MaterializeContext, MaterializeStep } from './ports.js';

/**
 * The one-time import's MATERIALIZE phase: every history step, in order, then their part of
 * the exact-match report. A step is idempotent on its own, so a resumed phase runs them all
 * again and writes nothing twice.
 */
export class LegacyMaterializeService {
  constructor(private readonly steps: readonly MaterializeStep[]) {}

  get stepNames(): readonly string[] {
    return this.steps.map((s) => s.name);
  }

  async apply(ctx: MaterializeContext): Promise<LegacyMaterializeOutcome[]> {
    const outcomes: LegacyMaterializeOutcome[] = [];
    for (const step of this.steps) {
      const outcome = await step.apply(ctx);
      outcomes.push({
        step: outcome.step,
        written: outcome.written,
        alreadyPresent: outcome.alreadyPresent,
        diverged: outcome.diverged,
        skipped: Object.entries(outcome.skipped)
          .filter(([, n]) => n > 0)
          .map(([code, n]) => ({ code, count: n })),
      });
    }
    return outcomes;
  }

  async match(ctx: MaterializeContext): Promise<ExactMatchRow[]> {
    const rows: ExactMatchRow[] = [];
    for (const step of this.steps) rows.push(...(await step.match(ctx)));
    return rows;
  }
}
