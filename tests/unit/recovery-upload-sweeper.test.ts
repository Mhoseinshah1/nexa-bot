import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecoveryState } from '@nexa/contracts';
import { RecoveryUploadSweeper } from '../../apps/api/src/modules/platform/recovery/application/upload-sweeper';
import type { RecoveryRequestRow } from '../../apps/api/src/modules/platform/recovery/application/ports';
import { FilesystemRecoveryWorkspaces } from '../../apps/api/src/modules/platform/recovery/infrastructure/recovery-workspace';

/**
 * SFR A3: the uploads of refused restores and orphaned workspaces are removed; a restore in
 * progress never is. Real directories under a real root; the request rows are a fake.
 */

const NOW = new Date('2026-11-09T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const HEX = 'abcdef0123456789';
const id = (n: number) => `01a05e35-c9ad-7e93-bef3-1ed9b55292${String(n).padStart(2, '0')}`;

describe('the recovery upload sweep', () => {
  let root: string;
  const rows = new Map<string, Partial<RecoveryRequestRow>>();
  const released: string[] = [];
  const logs: string[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexa-upload-sweep-'));
    rows.clear();
    released.length = 0;
    logs.length = 0;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function upload(n: number, ageMs: number): Promise<string> {
    const directory = join(root, `${id(n)}-${HEX}`);
    await mkdir(directory);
    await writeFile(join(directory, 'upload.nxb'), 'ciphertext');
    const at = new Date(NOW.getTime() - ageMs);
    await utimes(join(directory, 'upload.nxb'), at, at);
    await utimes(directory, at, at);
    return directory;
  }

  function row(n: number, state: RecoveryState, over: Partial<RecoveryRequestRow> = {}): void {
    rows.set(id(n), {
      id: id(n),
      state,
      confirmedAt: null,
      finishedAt:
        state === 'FAILED' || state === 'SUCCEEDED' ? new Date(NOW.getTime() - 2 * DAY) : null,
      workspacePath: null,
      failureCode: null,
      ...over,
    });
  }

  const sweeper = () =>
    new RecoveryUploadSweeper({
      workspaces: new FilesystemRecoveryWorkspaces(root),
      requests: {
        byIdUnscoped: async (key) => (rows.get(key) as RecoveryRequestRow | undefined) ?? null,
        releaseKeptUpload: async (input) => {
          const current = rows.get(input.id);
          if (
            current?.state !== 'FAILED' ||
            current.workspacePath !== input.workspacePath ||
            current.confirmedAt !== null
          ) {
            return false;
          }
          rows.set(input.id, { ...current, workspacePath: null });
          released.push(input.id);
          return true;
        },
      },
      clock: { now: () => NOW },
      logger: { info: (_c, m) => logs.push(m), warn: (_c, m) => logs.push(m) },
    });

  const left = async () => (await readdir(root)).sort();

  it('removes a refused upload kept for the owner once it finished a day ago, releasing the row first', async () => {
    // MUTATION: not releasing the row, or removing without the age, fails this.
    const kept = await upload(1, 2 * DAY);
    row(1, 'FAILED', { workspacePath: kept, failureCode: 'recovery.candidate_secrets_unreadable' });
    const young = await upload(2, 2 * DAY);
    row(2, 'FAILED', {
      workspacePath: young,
      failureCode: 'recovery.candidate_secrets_unreadable',
      finishedAt: new Date(NOW.getTime() - 60_000),
    });
    const result = await sweeper().sweep();
    expect(result.removed).toEqual([kept]);
    expect(released).toEqual([id(1)]);
    expect(rows.get(id(1))?.workspacePath).toBeNull();
    expect(await left()).toEqual([`${id(2)}-${HEX}`]);
    expect(logs).toContain('removed the upload of a refused or abandoned restore');
  });

  it('never touches a restore in progress, however old its files', async () => {
    // MUTATION: dropping the non-terminal check removes these and fails this.
    for (const [n, state] of [
      [3, 'UPLOADED'],
      [4, 'VERIFYING'],
      [5, 'RESTORE_TEST_PASSED'],
      [6, 'RESTORE_REQUESTED'],
      [7, 'RESTORING'],
    ] as const) {
      const directory = await upload(n, 30 * DAY);
      // Some not yet recorded on the row (the directory is made before the row names it):
      // the state alone must keep them.
      row(n, state, { workspacePath: n % 2 === 0 ? directory : null });
    }
    const result = await sweeper().sweep();
    expect(result.removed).toEqual([]);
    expect(await left()).toHaveLength(5);
  });

  it('sweeps an orphan (no request) idle a day, keeps a young one, and leaves other files alone', async () => {
    const orphan = await upload(8, 2 * DAY);
    await upload(9, 60_000);
    await writeFile(join(root, 'cutover-journal.json'), '{}');
    await mkdir(join(root, 'not-a-workspace'));
    const result = await sweeper().sweep();
    expect(result.removed).toEqual([orphan]);
    expect(await left()).toEqual(
      [`${id(9)}-${HEX}`, 'cutover-journal.json', 'not-a-workspace'].sort(),
    );
  });

  it('keeps the evidence of a restore that ran: SUCCEEDED, and a FAILED one that was confirmed', async () => {
    const done = await upload(10, 5 * DAY);
    row(10, 'SUCCEEDED', { workspacePath: done });
    const failed = await upload(11, 5 * DAY);
    row(11, 'FAILED', {
      workspacePath: failed,
      failureCode: 'recovery.cutover_failed',
      confirmedAt: new Date(NOW.getTime() - 3 * DAY),
    });
    expect((await sweeper().sweep()).removed).toEqual([]);
    expect(await left()).toHaveLength(2);
  });

  it('removes debris a finished request no longer names, once idle a day', async () => {
    const debris = await upload(12, 2 * DAY);
    row(12, 'FAILED', { workspacePath: null, failureCode: 'recovery.archive_malformed' });
    expect((await sweeper().sweep()).removed).toEqual([debris]);
  });
});
