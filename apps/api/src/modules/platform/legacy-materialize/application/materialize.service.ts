import type { LegacyMaterializeOutcome } from '@nexa/contracts';
import type { ExactMatchRow, MaterializeContext, MaterializeStep } from './ports.js';
import {
  timedSection,
  type SectionTimingLogger,
} from '../../legacy-importer/application/section-timing.js';

/**
 * The one-time import's MATERIALIZE phase: every history step, in order, then their part of
 * the exact-match report. A step is idempotent on its own, so a resumed phase runs them all
 * again and writes nothing twice.
 */
export class LegacyMaterializeService {
  constructor(
    private readonly steps: readonly MaterializeStep[],
    /** Per-step timing lines (`section-timing.ts`): counts and milliseconds only. */
    private readonly logger?: SectionTimingLogger,
  ) {}

  get stepNames(): readonly string[] {
    return this.steps.map((s) => s.name);
  }

  async apply(ctx: MaterializeContext): Promise<LegacyMaterializeOutcome[]> {
    const outcomes: LegacyMaterializeOutcome[] = [];
    for (const step of this.steps) {
      const outcome = await timedSection(
        this.logger,
        `materialize.${step.name}`,
        () => step.apply(ctx),
        (o) => o.written + o.alreadyPresent + o.diverged,
      );
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
    for (const step of this.steps) {
      rows.push(
        ...(await timedSection(this.logger, `materialize.match.${step.name}`, () =>
          step.match(ctx),
        )),
      );
    }
    return rows;
  }
}
