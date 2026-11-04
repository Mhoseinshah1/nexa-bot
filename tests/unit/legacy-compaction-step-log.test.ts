import { describe, expect, it } from 'vitest';
import { LegacyCompactionExecutor } from '../../apps/api/src/modules/platform/legacy-compaction/application/legacy-compaction.executor';

/**
 * v0.9.8: a failed stage logged `err: error.message`, which for a drizzle-wrapped query is the
 * SQL AND its bound parameters, and hid the cause (statement_timeout, 57014). The log line now
 * carries the cause chain's type, code and sanitised PostgreSQL message — never a parameter.
 */
describe('the legacy compaction stage-failure log line', () => {
  it('names the cause (57014, statement timeout) and never a bound parameter', async () => {
    const secret = 'S3CRET-TELEGRAM-ID-777001';
    const cause = Object.assign(new Error('canceling statement due to statement timeout'), {
      name: 'error',
      code: '57014',
      severity: 'ERROR',
    });
    const wrapped = Object.assign(
      new Error(`Failed query: VACUUM x\nparams: ${secret}`, { cause }),
      { name: 'DrizzleQueryError', params: [secret] },
    );
    const logged: Record<string, unknown>[] = [];
    const run = { id: 'r1', tenantId: 't1', state: 'VACUUMING', leaseOwner: 'me' };
    const executor = new LegacyCompactionExecutor({
      repository: {
        vacuum: async () => {
          throw wrapped;
        },
        latest: async () => run,
      },
      opsLog: { record: async () => undefined },
      clock: { now: () => new Date(0) },
      leaseOwner: 'me',
      logger: {
        info() {},
        warn() {},
        error(context: Record<string, unknown>) {
          logged.push(context);
        },
      },
    } as never);
    await executor.drive(run as never);
    const line = JSON.stringify(logged);
    expect(logged).toHaveLength(1);
    expect(line).toContain('57014');
    expect(line).toContain('canceling statement due to statement timeout');
    expect(line).not.toContain(secret);
  });
});
