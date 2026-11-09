import { NexaError } from '@nexa/contracts';
import {
  errorDiagnostics,
  type ErrorLink,
} from '../../legacy-migration/domain/error-diagnostics.js';

/**
 * What a tenant archive run or a tenant restore may write into its row's `failure_message`
 * (security review of PR #447, finding 1).
 *
 * A tenant restore inserts an ARCHIVE's rows, and drizzle wraps a failed statement in a
 * `DrizzleQueryError` whose message is `Failed query: <SQL> params: <values>` — the row's
 * values, customer data, in a durable column an operator page reads. So a row stores:
 *
 * - a `NexaError`'s own message: written by this codebase, never built from a row;
 * - for anything else, the `cause` chain as `legacy-migration/domain/error-diagnostics.ts`
 *   describes it for a log line: each link's type and code, PostgreSQL's identifiers
 *   (constraint, table, column — the schema, never a value) and a server message only with
 *   every quoted span blanked. Never a raw `error.message`.
 */
export const STORED_FAILURE_MAX_LENGTH = 2000;

function describe(link: ErrorLink): string {
  const parts = [link.type];
  if (link.code !== null) parts.push(`code=${link.code}`);
  if (link.constraint !== undefined) parts.push(`constraint=${link.constraint}`);
  if (link.table !== undefined) parts.push(`table=${link.table}`);
  if (link.column !== undefined) parts.push(`column=${link.column}`);
  if (link.message !== undefined) parts.push(`(${link.message})`);
  return parts.join(' ');
}

export function storedFailureMessage(error: unknown): string {
  if (error instanceof NexaError) return error.message.slice(0, STORED_FAILURE_MAX_LENGTH);
  const diagnostics = errorDiagnostics(error);
  const chain = [diagnostics, ...(diagnostics.cause ?? [])].map(describe).join(' <- ');
  return `Unexpected failure: ${chain}`.slice(0, STORED_FAILURE_MAX_LENGTH);
}
