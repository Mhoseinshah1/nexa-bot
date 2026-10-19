import type { ActorContext, AuditEntry, AuditWriter, ScopeContext } from '@nexa/contracts';

/** A writer that can insert many rows of one actor at once (the Drizzle writer can). */
export interface BulkAuditWriter extends AuditWriter {
  recordMany(
    scope: ScopeContext,
    actor: ActorContext,
    entries: readonly AuditEntry[],
    tx?: unknown,
  ): Promise<void>;
}

/**
 * Many audit rows through `recordMany` when the writer has it, else one `record` each — the
 * same rows, in the same order, either way. The `AuditWriter` port (the contract) stays one
 * row at a time; this is the bulk writers' (the one-time import's) convenience over it.
 */
export async function recordAuditMany(
  writer: AuditWriter,
  scope: ScopeContext,
  actor: ActorContext,
  entries: readonly AuditEntry[],
  tx?: unknown,
): Promise<void> {
  if (entries.length === 0) return;
  const bulk = writer as Partial<BulkAuditWriter>;
  if (typeof bulk.recordMany === 'function') {
    await bulk.recordMany(scope, actor, entries, tx);
    return;
  }
  for (const entry of entries) await writer.record(scope, actor, entry, tx);
}
