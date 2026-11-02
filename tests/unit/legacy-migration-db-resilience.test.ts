import { describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import { DatabaseError } from 'pg';
import {
  ERROR_MESSAGE_MAX_LENGTH,
  errorDiagnostics,
  sanitizeMessage,
} from '../../apps/api/src/modules/platform/legacy-migration/domain/error-diagnostics';
import { errorKind } from '../../apps/api/src/modules/platform/legacy-migration/domain/import-lifecycle';
import { isTransientDatabaseFailure } from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/transient-database-failure';
import {
  databaseProfileFor,
  leaseDatabaseProfile,
} from '../../apps/api/src/infrastructure/persistence/database-profile';
import { POOL_CONNECTION_TIMEOUT_MS } from '../../apps/api/src/infrastructure/persistence/database';
import { ResellersMaterializeStep } from '../../apps/api/src/modules/platform/legacy-materialize/application/resellers-step';

/**
 * The v0.9.3 field failure (a 197k-customer `.nxpkg` rehearsal): the import, its lease
 * heartbeat and its release each logged `{"type":"DrizzleQueryError","code":null}` and nothing
 * else. What failed was the wrapped error — and what a log line may show of it is narrow.
 */

const SQL = 'insert into "customers" ("telegram_id", "display_name") values ($1, $2)';
const PARAMS = ['5550001234', 'Customer Name'];

function serverError(
  code: string,
  message: string,
  fields: Partial<Record<'detail' | 'constraint' | 'table' | 'column' | 'schema', string>> = {},
): DatabaseError {
  const error = new DatabaseError(message, message.length, 'error');
  Object.assign(error, { code, severity: 'ERROR', ...fields });
  return error;
}

const wrapped = (cause: unknown) => new DrizzleQueryError(SQL, PARAMS, cause as Error);

describe('legacy-migration error diagnostics', () => {
  it('walks the cause of a DrizzleQueryError: the pool timeout the field log hid', () => {
    // MUTATION: errorKind without the cause chain (the old `{ type, code }`) fails this.
    expect(errorKind(wrapped(new Error('timeout exceeded when trying to connect')))).toEqual({
      type: 'DrizzleQueryError',
      code: null,
      cause: [{ type: 'Error', code: null, message: 'timeout exceeded when trying to connect' }],
    });
  });

  it('never logs the SQL, the parameters, a detail or a quoted value', () => {
    const duplicate = serverError(
      '23505',
      'duplicate key value violates unique constraint "customers_tenant_telegram_uq"',
      {
        detail: 'Key (tenant_id, telegram_id)=(t-1, 5550001234) already exists.',
        constraint: 'customers_tenant_telegram_uq',
        table: 'customers',
        schema: 'public',
      },
    );
    const described = errorKind(wrapped(duplicate));
    expect(described.cause).toEqual([
      {
        type: 'DatabaseError',
        code: '23505',
        message: 'duplicate key value violates unique constraint "…"',
        constraint: 'customers_tenant_telegram_uq',
        table: 'customers',
        schema: 'public',
      },
    ]);
    const text = JSON.stringify(described);
    for (const leaked of ['insert into', '$1', '5550001234', 'Customer Name', 'already exists']) {
      expect(text).not.toContain(leaked);
    }
    // A value PostgreSQL quotes in the primary message itself (22P02) is blanked too.
    const syntax = errorKind(
      serverError('22P02', 'invalid input syntax for type uuid: "5550001234"'),
    );
    expect(syntax).toEqual({
      type: 'DatabaseError',
      code: '22P02',
      message: 'invalid input syntax for type uuid: "…"',
    });
  });

  it('keeps no message of an error it does not know to be data-free', () => {
    const fsError = Object.assign(
      new Error("ENOENT: no such file or directory, open '/var/lib/nexa/x'"),
      {
        code: 'ENOENT',
      },
    );
    expect(errorKind(fsError)).toEqual({ type: 'Error', code: 'ENOENT' });
    expect(errorKind(wrapped(new Error('row 5550001234 refused')))).toEqual({
      type: 'DrizzleQueryError',
      code: null,
      cause: [{ type: 'Error', code: null }],
    });
    // A network errno says where, never what.
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(errorKind(reset)).toEqual({
      type: 'Error',
      code: 'ECONNRESET',
      message: 'read ECONNRESET',
    });
  });

  it('cuts a message to one line and a bounded length, and stops on a cycle', () => {
    const long = sanitizeMessage(`${'x'.repeat(500)}\nsecond line`);
    expect(long).toHaveLength(ERROR_MESSAGE_MAX_LENGTH);
    expect(long).not.toContain('second line');
    expect(sanitizeMessage("value 'abc' and (a)=(b)")).toBe("value '…' and (…)=(…)");
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(errorDiagnostics(a).cause).toHaveLength(1);
  });
});

describe('isTransientDatabaseFailure', () => {
  it.each([
    ['a pool checkout timeout', wrapped(new Error('timeout exceeded when trying to connect'))],
    [
      'a connect that timed out',
      wrapped(new Error('Connection terminated due to connection timeout')),
    ],
    ['a connection lost mid-query', wrapped(new Error('Connection terminated unexpectedly'))],
    ['a reset socket', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ['a terminated backend (57P01)', wrapped(serverError('57P01', 'terminating connection'))],
    ['a server starting up (57P03)', serverError('57P03', 'the database system is starting up')],
    ['a connection exception (08006)', serverError('08006', 'connection failure')],
    ['too many connections (53300)', serverError('53300', 'too many clients already')],
  ])('%s is transient', (_name, error) => {
    expect(isTransientDatabaseFailure(error)).toBe(true);
  });

  it.each([
    ['a constraint violation', wrapped(serverError('23505', 'duplicate key'))],
    [
      'a statement timeout',
      wrapped(serverError('57014', 'canceling statement due to statement timeout')),
    ],
    ['a deadlock', serverError('40P01', 'deadlock detected')],
    ['an importer refusal', new Error('timeout of the panel read')],
    ['a closed handle (shutdown)', new Error('Cannot use a pool after calling end on the pool')],
    ['not an error', 'timeout exceeded when trying to connect'],
  ])('%s is not', (_name, error) => {
    expect(isTransientDatabaseFailure(error)).toBe(false);
  });
});

describe('databaseProfileFor', () => {
  const config = {
    DATABASE_STATEMENT_TIMEOUT_MS: 15_000,
    DATABASE_LOCK_TIMEOUT_MS: 5_000,
    DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: 30_000,
    LEGACY_MIGRATION_DB_CONNECTION_TIMEOUT_MS: 120_000,
    LEGACY_MIGRATION_DB_STATEMENT_TIMEOUT_MS: 600_000,
    LEGACY_MIGRATION_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: 300_000,
  };

  it('keeps the request path bounds for every role that serves one', () => {
    for (const role of ['api', 'worker', 'monitor', 'provisioner', 'assistant']) {
      expect(databaseProfileFor(role, config)).toEqual({
        timeouts: {
          statementTimeoutMs: 15_000,
          lockTimeoutMs: 5_000,
          idleInTransactionTimeoutMs: 30_000,
        },
        pool: { connectionTimeoutMs: POOL_CONNECTION_TIMEOUT_MS },
      });
    }
  });

  it('sizes the import roles for the import, never below the installation and never the lock', () => {
    for (const role of ['migration', 'recovery']) {
      expect(databaseProfileFor(role, config)).toEqual({
        timeouts: {
          statementTimeoutMs: 600_000,
          lockTimeoutMs: 5_000,
          idleInTransactionTimeoutMs: 300_000,
        },
        pool: { connectionTimeoutMs: 120_000 },
      });
    }
    const lower = {
      ...config,
      LEGACY_MIGRATION_DB_STATEMENT_TIMEOUT_MS: 15_000,
      DATABASE_STATEMENT_TIMEOUT_MS: 60_000,
    };
    expect(databaseProfileFor('migration', lower).timeouts.statementTimeoutMs).toBe(60_000);
  });

  it('gives the lease connection the request path statement bounds and a longer checkout', () => {
    expect(leaseDatabaseProfile(config)).toEqual({
      timeouts: {
        statementTimeoutMs: 15_000,
        lockTimeoutMs: 5_000,
        idleInTransactionTimeoutMs: 30_000,
      },
      pool: { connectionTimeoutMs: 60_000 },
    });
  });
});

describe('one transaction, one query at a time', () => {
  it('the resellers step reads its three record types one after another', async () => {
    // pg@8 warns "Calling client.query() when the client is already executing a query" (the
    // v0.9.3 field rehearsal printed it) when one client is given a second query while the first
    // runs: here, `Promise.all` over three reads on the step's transaction.
    // MUTATION: putting the `Promise.all` back fails this.
    let inFlight = 0;
    let peak = 0;
    const repository = {
      rows: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return [];
      },
      customersByTelegram: async () => new Map<string, string>(),
      mirzaResellerRefs: async () => new Set<string>(),
      mirzaResellerTotals: async () => ({ count: 0 }),
      resellerCustomers: async () => new Set<string>(),
    };
    const step = new ResellersMaterializeStep(repository as never, {} as never);
    await step
      .match({
        scope: { tenantId: 't' as never, botInstanceId: null },
        actor: {} as never,
        packageImportId: 'p',
        sourceFingerprint: 'f',
        now: new Date(0),
      })
      .catch(() => undefined);
    expect(peak).toBe(1);
  });
});
