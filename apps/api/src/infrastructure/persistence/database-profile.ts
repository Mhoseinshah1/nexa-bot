import { POOL_CONNECTION_TIMEOUT_MS, type DatabaseTimeouts, type PoolOptions } from './database.js';

/**
 * Which database bounds a process role gets.
 *
 * Every role but two serves, or is, a request path, and keeps the request path's bounds: a
 * five-second checkout (`POOL_CONNECTION_TIMEOUT_MS`) and the `DATABASE_*_TIMEOUT_MS`
 * statement, lock and idle-in-transaction bounds. The two roles that run the Mirza import
 * — `migration`, and `recovery` (which runs the same executor for the restore page) — serve no
 * request. Their work is ONE long import: minutes of statements over every imported customer,
 * fanned out up to ten reads wide, on a host whose disk a checkpoint can hold for minutes. For
 * them a five-second checkout is not a safety bound but a failure mode: it is exactly how the
 * v0.9.3 field import failed (`docs/legacy-migration/nxpkg-activation.md` § Database bounds).
 *
 * Their `LEGACY_MIGRATION_DB_*` bounds are still bounds — a statement or a transaction that
 * stalls for good is still cut off by the server — sized for the import instead of a click.
 * The lock bound stays the installation's: waiting long on a lock is wrong for anyone.
 *
 * The lease connection (`leaseDatabaseProfile`) is separate again: tiny statements, the
 * request path's statement bounds, a longer checkout for a host under I/O pressure.
 */
export interface DatabaseProfile {
  readonly timeouts: DatabaseTimeouts;
  readonly pool: PoolOptions;
}

export type ImportRoleConfig = {
  readonly DATABASE_STATEMENT_TIMEOUT_MS: number;
  readonly DATABASE_LOCK_TIMEOUT_MS: number;
  readonly DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: number;
  readonly LEGACY_MIGRATION_DB_CONNECTION_TIMEOUT_MS: number;
  readonly LEGACY_MIGRATION_DB_STATEMENT_TIMEOUT_MS: number;
  readonly LEGACY_MIGRATION_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: number;
};

/** The roles whose process runs the legacy-migration executor. */
export const IMPORT_ROLES = ['migration', 'recovery'] as const;

export function isImportRole(role: string): boolean {
  return (IMPORT_ROLES as readonly string[]).includes(role);
}

export function databaseProfileFor(role: string, config: ImportRoleConfig): DatabaseProfile {
  if (!isImportRole(role)) {
    return {
      timeouts: {
        statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
        lockTimeoutMs: config.DATABASE_LOCK_TIMEOUT_MS,
        idleInTransactionTimeoutMs: config.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      },
      pool: { connectionTimeoutMs: POOL_CONNECTION_TIMEOUT_MS },
    };
  }
  return {
    timeouts: {
      // Never BELOW the installation's own bound, whatever the two variables say.
      statementTimeoutMs: Math.max(
        config.LEGACY_MIGRATION_DB_STATEMENT_TIMEOUT_MS,
        config.DATABASE_STATEMENT_TIMEOUT_MS,
      ),
      lockTimeoutMs: config.DATABASE_LOCK_TIMEOUT_MS,
      idleInTransactionTimeoutMs: Math.max(
        config.LEGACY_MIGRATION_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
        config.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      ),
    },
    pool: { connectionTimeoutMs: config.LEGACY_MIGRATION_DB_CONNECTION_TIMEOUT_MS },
  };
}

/** Connections of the lease pool: the heartbeat and the release, never more at once. */
export const LEASE_POOL_MAX = 2;

/**
 * The lease connection's bounds: the request path's statement bounds (a heartbeat is one
 * indexed UPDATE), and the import roles' checkout — a NEW connection under a saturated disk
 * can take longer than five seconds to start, and a heartbeat that waits a minute still lands
 * well inside the five-minute lease.
 */
export function leaseDatabaseProfile(config: ImportRoleConfig): DatabaseProfile {
  return {
    timeouts: {
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
      lockTimeoutMs: config.DATABASE_LOCK_TIMEOUT_MS,
      idleInTransactionTimeoutMs: config.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    },
    pool: {
      connectionTimeoutMs: Math.min(config.LEGACY_MIGRATION_DB_CONNECTION_TIMEOUT_MS, 60_000),
    },
  };
}
