import { RECOVERY_TERMINAL_STATES, type Clock } from '@nexa/contracts';
import type { RecoveryRequestRow, RecoveryWorkspace } from './ports.js';

/**
 * SFR A3: how long a refused upload, or a workspace no request names, is left before it is
 * removed. A day: long enough for the owner to choose «ادامه؛ این‌ها را دوباره وارد می‌کنم» on a
 * restore refused for unreadable secrets (the one refusal that keeps its upload), and for an
 * upload still arriving to finish — an upload in flight writes to its directory constantly.
 */
export const RECOVERY_UPLOAD_SAFE_AGE_MS = 24 * 60 * 60 * 1000;

export interface RecoveryUploadSweeperDeps {
  readonly workspaces: {
    uploadDirectories(): Promise<
      readonly {
        readonly directory: string;
        readonly recoveryId: string;
        readonly lastWrittenAt: Date;
      }[]
    >;
    open(directory: string): Pick<RecoveryWorkspace, 'discard'>;
  };
  readonly requests: {
    byIdUnscoped(id: string): Promise<RecoveryRequestRow | null>;
    releaseKeptUpload(input: { id: string; workspacePath: string; now: Date }): Promise<boolean>;
  };
  readonly clock: Clock;
  readonly logger: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
  };
  readonly safeAgeMs?: number;
}

/** One sweep's outcome, for the log line and the tests. */
export interface RecoveryUploadSweep {
  readonly removed: readonly string[];
  readonly kept: number;
  readonly survivors: readonly string[];
}

/**
 * Removes the upload files of restores that were refused, and orphaned upload workspaces, from
 * `RECOVERY_WORK_DIR`. Run by the recovery role at start-up and every few hours.
 *
 * - A request that is NOT terminal (uploading, verifying, tested, confirmed, restoring) is in
 *   progress: its directory is never touched, whatever its age.
 * - A FAILED request that was never confirmed and still names its upload (a refusal that kept
 *   it for the owner's choice) is released once it finished more than the safe age ago: the row
 *   lets go of the path FIRST, by a conditional UPDATE, and only then is the directory removed.
 * - A directory no request names, or one a finished request no longer names (a refusal whose own
 *   cleanup failed), is removed once nothing has been written to it for the safe age.
 * - A SUCCEEDED request, and a FAILED one that was confirmed (the executor's evidence of a
 *   restore that ran), keep their workspace: `docs/backup.md` reports that debris on the row
 *   rather than removing it.
 */
export class RecoveryUploadSweeper {
  constructor(private readonly deps: RecoveryUploadSweeperDeps) {}

  async sweep(): Promise<RecoveryUploadSweep> {
    const now = this.deps.clock.now();
    const safeAge = this.deps.safeAgeMs ?? RECOVERY_UPLOAD_SAFE_AGE_MS;
    const old = (at: Date | null): boolean =>
      at !== null && now.getTime() - at.getTime() >= safeAge;
    const removed: string[] = [];
    const survivors: string[] = [];
    let kept = 0;
    for (const entry of await this.deps.workspaces.uploadDirectories()) {
      const row = await this.deps.requests.byIdUnscoped(entry.recoveryId);
      let remove: boolean;
      if (row === null) {
        remove = old(entry.lastWrittenAt);
      } else if (!(RECOVERY_TERMINAL_STATES as readonly string[]).includes(row.state)) {
        remove = false;
      } else if (row.workspacePath === entry.directory) {
        remove =
          row.state === 'FAILED' &&
          row.confirmedAt === null &&
          old(row.finishedAt) &&
          (await this.deps.requests.releaseKeptUpload({
            id: row.id,
            workspacePath: entry.directory,
            now,
          }));
      } else {
        remove = old(entry.lastWrittenAt);
      }
      if (!remove) {
        kept += 1;
        continue;
      }
      const left = await this.deps.workspaces.open(entry.directory).discard();
      if (left.length > 0) {
        survivors.push(...left);
        continue;
      }
      removed.push(entry.directory);
      this.deps.logger.info(
        {
          recoveryId: entry.recoveryId,
          state: row?.state ?? null,
          failureCode: row?.failureCode ?? null,
          orphan: row === null,
        },
        'removed the upload of a refused or abandoned restore',
      );
    }
    if (removed.length > 0 || survivors.length > 0) {
      this.deps.logger.warn(
        { removed: removed.length, kept, survivors: survivors.length },
        'recovery upload sweep',
      );
    }
    return { removed, kept, survivors };
  }
}
