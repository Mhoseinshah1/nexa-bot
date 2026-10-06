import type { ScopeContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { DrizzleSupportAiJobRepository } from '../infrastructure/drizzle-support-ai-job.repository.js';

/** D2 telemetry: knowledge entries a request carried, and how many there were to choose from. */
export interface KnowledgeCounts {
  readonly sent: number;
  readonly available: number;
}

/** A write that runs in a job's result transaction, after its own conditional transition. */
type JobWrite = (now: Date, tx: TransactionScope) => Promise<void>;

/**
 * `then`, followed by the job's knowledge counts — in the same transaction, so the counts are
 * recorded exactly when the job's result is (a job replaced or dropped meanwhile records
 * neither, and a stopped tenant writes neither). Only a request that reached a provider calls
 * this: those are the entries a model was actually given.
 */
export function withKnowledgeCounts(
  jobs: Pick<DrizzleSupportAiJobRepository, 'recordKnowledgeCounts'>,
  scope: ScopeContext,
  jobId: string,
  counts: KnowledgeCounts | undefined,
  then: JobWrite,
): JobWrite {
  if (counts === undefined) return then;
  return async (now, tx) => {
    await then(now, tx);
    await jobs.recordKnowledgeCounts(scope, jobId, counts, now, tx);
  };
}
