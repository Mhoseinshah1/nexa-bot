import { mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorContext } from '@nexa/contracts';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * SFR A3 over a real PostgreSQL and the real upload directory: a refused restore's kept upload
 * is released on the row (a conditional UPDATE) and removed from disk once a day old; an upload
 * in progress is left; the owner's «ادامه» then says the upload is gone instead of confirming a
 * restore whose archive no longer exists.
 */
describe('recovery: refused uploads are removed, uploads in progress are not', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let recoveryRoot: string;
  const DAY = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    // The default root is under /var/lib/nexa, which a CI runner cannot create.
    recoveryRoot = await mkdtemp(join(tmpdir(), 'nexa-upload-sweep-'));
    ctx = await createTestContext({ RECOVERY_WORK_DIR: recoveryRoot });
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
    if (recoveryRoot) await rm(recoveryRoot, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-sweep', roleKeys: ['owner'] }),
    );
  });

  const begin = async () =>
    ctx.container.recoveryService.beginUpload(tenantA, owner, { clientFilename: 'old.nxb' });

  async function age(directory: string, ms: number): Promise<void> {
    const at = new Date(Date.now() - ms);
    for (const file of await readdir(directory)) await utimes(`${directory}/${file}`, at, at);
    await utimes(directory, at, at);
  }

  it('releases and removes a refused upload kept a day, and «ادامه» then refuses for the missing upload', async () => {
    const begun = await begin();
    const directory = begun.workspace.directory;
    await ctx.container.database.db.execute(sql`
      UPDATE recovery_requests
         SET state = 'FAILED', stage = 'CLEANUP',
             failure_code = 'recovery.candidate_secrets_unreadable',
             finished_at = now() - interval '2 days', updated_at = now() - interval '2 days',
             workspace_path = ${directory}
       WHERE id = ${begun.request.id}`);
    await age(directory, 2 * DAY);
    // In progress beside it: an upload begun just now, aged — never touched.
    const busy = await begin();
    const busyDirectory = busy.workspace.directory;
    await age(busyDirectory, 30 * DAY);

    const result = await ctx.container.recoveryUploadSweeper.sweep();
    expect(result.removed).toEqual([directory]);
    await expect(stat(directory)).rejects.toThrow();
    await expect(stat(busyDirectory)).resolves.toBeDefined();
    const row = await ctx.container.recoveryRequests.byIdUnscoped(begun.request.id);
    expect(row?.workspacePath).toBeNull();
    expect(row?.state).toBe('FAILED');

    const refused = await ctx.container.recoveryService
      .acknowledgeUnreadable(tenantA, owner, begun.request.id, {
        idempotencyKey: 'ack-after-sweep',
        unreadable: [{ purpose: 'bot_instance.token', count: 1 }],
      })
      .then(
        () => null,
        (error: unknown) => (error as { code?: string }).code ?? 'no-code',
      );
    expect(refused).toBe('recovery.refused');
  });

  it('releases only a never-confirmed FAILED row that still names that very directory', async () => {
    const repository = ctx.container.recoveryRequests;
    const begun = await begin();
    const directory = begun.workspace.directory;
    await ctx.container.database.db.execute(sql`
      UPDATE recovery_requests
         SET state = 'FAILED', stage = 'CLEANUP', failure_code = 'recovery.candidate_secrets_unreadable',
             finished_at = now(), workspace_path = ${directory}
       WHERE id = ${begun.request.id}`);
    const now = new Date();
    expect(
      await repository.releaseKeptUpload({
        id: begun.request.id,
        workspacePath: `${directory}x`,
        now,
      }),
    ).toBe(false);
    await ctx.container.database.db.execute(
      sql`UPDATE recovery_requests
             SET confirmed_at = now(), confirmed_by_admin_id = ${owner.id},
                 confirmed_checksum = 'c', confirmation_expires_at = now() + interval '1 hour'
           WHERE id = ${begun.request.id}`,
    );
    expect(
      await repository.releaseKeptUpload({ id: begun.request.id, workspacePath: directory, now }),
    ).toBe(false);
    await ctx.container.database.db.execute(
      sql`UPDATE recovery_requests
             SET confirmed_at = NULL, confirmed_by_admin_id = NULL,
                 confirmed_checksum = NULL, confirmation_expires_at = NULL
           WHERE id = ${begun.request.id}`,
    );
    expect(
      await repository.releaseKeptUpload({ id: begun.request.id, workspacePath: directory, now }),
    ).toBe(true);
    expect((await repository.byIdUnscoped(begun.request.id))?.workspacePath).toBeNull();
    expect(basename(directory)).toMatch(/^[0-9a-f-]{36}-[0-9a-f]{16}$/);
  });
});
