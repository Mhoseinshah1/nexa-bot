import {
  CLIENT_CONNECTION_FAILURE_MESSAGES,
  NETWORK_ERROR_CODES,
  causeChain,
  isServerError,
} from '../domain/error-diagnostics.js';

/**
 * The executor's `TransientFailureClassifier` (application/ports.ts) for PostgreSQL: whether
 * a step failed because a database CONNECTION could not be had or was lost — never because of
 * anything the statement or the data did.
 *
 * Field evidence (v0.9.3, a 197k-customer package on 4 vCPU / 4 GB): an import failed with
 * `DrizzleQueryError` code null; its cause was a client-side connection failure while a
 * checkpoint saturated the disk for four and a half minutes. Such a failure says nothing
 * about the import, and every write of the import is idempotent (each phase resumes from its
 * bookmark), so it is run again — a bounded number of times, by the executor.
 *
 * Transient, on ANY link of the `cause` chain (drizzle wraps the pg error):
 *
 * - `pg` / `pg-pool`'s own connection sentences (a checkout or a connect that timed out, a
 *   connection terminated under the query);
 * - a network errno (`ECONNRESET`, `ECONNREFUSED`, `EPIPE`, `ETIMEDOUT`, …);
 * - SQLSTATE class 08 (connection exception), 57P01 `admin_shutdown`, 57P02
 *   `crash_shutdown`, 57P03 `cannot_connect_now` (recovery / startup), 53300
 *   `too_many_connections`.
 *
 * NOT transient: everything else — a constraint violation, a statement timeout (57014: a
 * statement that overran its bound is a sizing fact to read, not to retry blindly), a lock
 * timeout, a deadlock, a serialization failure, any importer refusal.
 */
export function isTransientDatabaseFailure(error: unknown): boolean {
  return [error, ...causeChain(error)].some(isTransientLink);
}

const TRANSIENT_SQLSTATES = new Set(['57P01', '57P02', '57P03', '53300']);

function isTransientLink(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (isServerError(error) && typeof code === 'string') {
    return code.startsWith('08') || TRANSIENT_SQLSTATES.has(code);
  }
  if (typeof code === 'string' && (NETWORK_ERROR_CODES as readonly string[]).includes(code)) {
    return true;
  }
  return TRANSIENT_CLIENT_MESSAGES.some((known) => error.message.startsWith(known));
}

/**
 * The client sentences of a connection that could not be had or was lost. Not `Client was
 * closed` nor `Cannot use a pool after calling end`: those are this process closing its own
 * handle (a shutdown), which another attempt in the same process would only meet again.
 */
const TRANSIENT_CLIENT_MESSAGES = CLIENT_CONNECTION_FAILURE_MESSAGES.filter(
  (known) =>
    known !== 'Client was closed and is not queryable' &&
    known !== 'Cannot use a pool after calling end on the pool',
);
