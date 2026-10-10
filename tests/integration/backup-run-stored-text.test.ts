import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from './harness';
import { backupRuns } from '../../apps/api/src/infrastructure/persistence/schema';
import { DrizzleBackupRunRepository } from '../../apps/api/src/modules/platform/backup/infrastructure/drizzle-backup-run.repository';

/**
 * FIX-04 (S4): `backup_runs.delivery_detail` and `failure_message` are written redacted.
 *
 * The Telegram delivery lane stores `The request did not complete: <error.message>` on an
 * unknown outcome, and a transport error can quote the request URL — whose path is
 * `/bot<token>/sendDocument`. The row is read back by the Web Admin's backup history and is
 * itself inside every later backup, so a token stored there is published twice over.
 *
 * Against the real table, through the repository the backup service uses, because the
 * claim is about what lands in the column. The credential is synthetic.
 */
describe('backup run error text', () => {
  let context: TestContext;
  let runs: DrizzleBackupRunRepository;
  const fakeToken = '7012345678:AAFakeTokenSynthetic0123456789xyzQ';
  const NOW = new Date('2026-10-10T08:00:00.000Z');

  beforeAll(async () => {
    context = await createTestContext();
    runs = new DrizzleBackupRunRepository(context.container.database.db);
  }, 60_000);

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  it('stores delivery detail and failure message with the credential redacted', async () => {
    const id = randomUUID();
    const started = await runs.start({ id, trigger: 'MANUAL', leaseOwner: 'test', now: NOW });
    expect(started.claimed).toBe(true);

    await runs.finish({
      id,
      leaseOwner: 'test',
      state: 'FAILED',
      stage: 'DELIVER',
      now: NOW,
      deliveryState: 'OUTCOME_UNKNOWN',
      deliveryAttemptedAt: NOW,
      deliveryDetail: `The request did not complete: Failed to parse URL from https://api.telegram.org:99999/bot${fakeToken}/sendDocument`,
      failureCode: 'backup.delivery_failed',
      failureMessage: `delivery failed: token=${fakeToken}`,
      cleanupOk: true,
    });

    const [row] = await context.container.database.db
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.id, id));
    expect(row?.deliveryDetail).toContain('The request did not complete');
    expect(row?.deliveryDetail).not.toContain('AAFakeTokenSynthetic');
    expect(row?.failureMessage).toContain('delivery failed');
    expect(row?.failureMessage).not.toContain('AAFakeTokenSynthetic');
  });
});
