import { describe, expect, it } from 'vitest';
import type {
  BackupDeliveryState,
  BackupManifest,
  BackupStage,
  BackupTrigger,
} from '@nexa/contracts';
import { BackupService } from '../../apps/api/src/modules/platform/backup/application/backup.service';
import { BackupScheduler } from '../../apps/api/src/modules/platform/backup/application/backup-scheduler';
import type {
  BackupRunRepository,
  BackupRunRow,
  BackupWorkspace,
  DeliveryAttempt,
  StartOutcome,
  VerifyOutcome,
} from '../../apps/api/src/modules/platform/backup/application/ports';

/**
 * The pipeline's rules, driven against fakes that can fail on demand.
 *
 * Fakes rather than mocks, and the difference is load-bearing here: every
 * assertion below is about a STATE the pipeline left behind — a row, a deleted
 * file, a delivery that did or did not happen — and never about whether a
 * method was called. A test that asserted `expect(deliver).toHaveBeenCalled()`
 * would pass just as happily against a pipeline that delivered an unverified
 * archive, which is the one thing this file exists to forbid.
 *
 * The real archive format, the real cipher and the real pg_dump are tested
 * where they live: `backup-archive.test.ts` and `tests/integration/backup.test.ts`.
 */

const NOW = new Date('2026-03-01T09:00:00.000Z');

class FakeClock {
  constructor(private ms = NOW.getTime()) {}
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

class FakeRuns implements BackupRunRepository {
  readonly rows = new Map<string, BackupRunRow>();
  readonly stages: BackupStage[] = [];
  reclaimed = 0;
  /** When set, `start` reports the installation is already busy. */
  busyWith: BackupRunRow | null = null;

  async start(input: {
    id: string;
    trigger: BackupTrigger;
    leaseOwner: string;
    now: Date;
  }): Promise<StartOutcome> {
    if (this.busyWith !== null) {
      return { claimed: false, reason: 'BUSY', holder: this.busyWith };
    }
    const row: BackupRunRow = {
      id: input.id,
      trigger: input.trigger,
      state: 'RUNNING',
      stage: 'DUMP',
      startedAt: input.now,
      finishedAt: null,
      leaseOwner: input.leaseOwner,
      leaseHeartbeatAt: input.now,
      dumpBytes: null,
      archiveBytes: null,
      checksum: null,
      verifiedAt: null,
      deliveryState: 'NOT_ATTEMPTED',
      deliveryAttemptedAt: null,
      deliveryDetail: null,
      failureCode: null,
      failureMessage: null,
      cleanupOk: true,
      cleanupDetail: null,
    };
    this.rows.set(row.id, row);
    return { claimed: true, run: row };
  }

  async progress(input: { id: string; stage: BackupStage }): Promise<void> {
    this.stages.push(input.stage);
    const row = this.rows.get(input.id);
    if (row !== undefined) this.rows.set(input.id, { ...row, stage: input.stage });
  }

  async heartbeat(): Promise<void> {}

  async finish(input: {
    id: string;
    state: 'SUCCEEDED' | 'FAILED';
    stage: BackupStage;
    now: Date;
    dumpBytes?: bigint | null;
    archiveBytes?: bigint | null;
    checksum?: string | null;
    verifiedAt?: Date | null;
    deliveryState: BackupDeliveryState;
    deliveryAttemptedAt?: Date | null;
    deliveryDetail?: string | null;
    failureCode?: string | null;
    failureMessage?: string | null;
    cleanupOk: boolean;
    cleanupDetail?: string | null;
  }): Promise<void> {
    const row = this.rows.get(input.id);
    if (row === undefined) return;
    this.rows.set(input.id, {
      ...row,
      state: input.state,
      stage: input.stage,
      finishedAt: input.now,
      dumpBytes: input.dumpBytes ?? null,
      archiveBytes: input.archiveBytes ?? null,
      checksum: input.checksum ?? null,
      verifiedAt: input.verifiedAt ?? null,
      deliveryState: input.deliveryState,
      deliveryAttemptedAt: input.deliveryAttemptedAt ?? null,
      deliveryDetail: input.deliveryDetail ?? null,
      failureCode: input.failureCode ?? null,
      failureMessage: input.failureMessage ?? null,
      cleanupOk: input.cleanupOk,
      cleanupDetail: input.cleanupDetail ?? null,
    });
  }

  async reclaimStale(): Promise<number> {
    return this.reclaimed;
  }

  async latest(): Promise<readonly BackupRunRow[]> {
    return [...this.rows.values()];
  }

  async byId(id: string): Promise<BackupRunRow | null> {
    return this.rows.get(id) ?? null;
  }

  async withUnknownDelivery(): Promise<readonly BackupRunRow[]> {
    return [...this.rows.values()].filter((row) => row.deliveryState === 'OUTCOME_UNKNOWN');
  }

  lastSuccess: Date | null = null;
  async lastSucceededAt(): Promise<Date | null> {
    return this.lastSuccess;
  }
}

interface Harness {
  readonly service: BackupService;
  readonly runs: FakeRuns;
  readonly clock: FakeClock;
  readonly state: {
    dumpBytes: number;
    dumpFails: boolean;
    verify: VerifyOutcome;
    delivery: DeliveryAttempt;
    deliveryConfigured: boolean;
    archiveBytes: number;
    /** The checksum `open` reports, so a mismatch can be forced. */
    openedChecksum: string | null;
    sealFails: boolean;
    plaintextRemoved: boolean;
    everythingRemoved: boolean;
    deliveredDocument: { caption: string; filename: string } | null;
    deliveredMessage: string | null;
    leaked: string[];
    cleanupFails: boolean;
    /** Every operational event the run recorded, in order. */
    recorded: { code: string; severity: string; dedupeKey?: string; recoversCode?: string }[];
    /** Null models an installation with no tenant provisioned yet. */
    scoped: boolean;
    opsLogThrows: boolean;
  };
}

const CHECKSUM = 'a'.repeat(64);

function harness(): Harness {
  const clock = new FakeClock();
  const runs = new FakeRuns();
  const state: Harness['state'] = {
    dumpBytes: 4096,
    dumpFails: false,
    verify: { ok: true, scratchDatabase: 'nexa_verify_x', tableCount: 30, detail: null },
    delivery: { state: 'SUCCEEDED', detail: null },
    deliveryConfigured: true,
    archiveBytes: 5000,
    openedChecksum: null,
    sealFails: false,
    plaintextRemoved: false,
    everythingRemoved: false,
    deliveredDocument: null,
    deliveredMessage: null,
    leaked: [],
    cleanupFails: false,
    recorded: [],
    scoped: true,
    opsLogThrows: false,
  };

  const workspace: BackupWorkspace = {
    dumpPath: '/w/dump',
    archivePath: '/w/archive',
    verifyDumpPath: '/w/verify',
    async discardPlaintext() {
      state.plaintextRemoved = true;
      return state.cleanupFails ? ['/w/dump'] : [];
    },
    async discardAll() {
      state.everythingRemoved = true;
      return state.cleanupFails ? ['/w'] : [];
    },
  };

  let counter = 0;
  const service = new BackupService({
    runs,
    tools: {
      databaseName: 'nexa',
      async pgDumpVersion() {
        return 'pg_dump 16.13';
      },
      async serverVersion() {
        return '16.13';
      },
      async dump() {
        if (state.dumpFails) throw new Error('pg_dump exploded');
        return { databaseName: 'nexa', pgDumpVersion: 'pg_dump 16.13' };
      },
      async verifyRestore() {
        return state.verify;
      },
      async restoreInto() {
        throw new Error('the pipeline must never call restoreInto');
      },
      get leaked() {
        return state.leaked;
      },
    },
    archiver: {
      async seal() {
        if (state.sealFails) throw new Error('encryption failed');
        return { archiveBytes: state.archiveBytes, keyId: 'k1' };
      },
      async open(): Promise<{ manifest: BackupManifest; dumpChecksum: string; dumpBytes: number }> {
        return {
          manifest: {
            manifestVersion: 1,
            backupId: 'b',
            installationId: 'i',
            createdAt: NOW.toISOString(),
            databaseName: 'nexa',
            postgresVersion: '16.13',
            pgDumpVersion: 'pg_dump 16.13',
            dumpFormat: 'custom',
            dumpBytes: state.dumpBytes,
            checksumAlgorithm: 'sha256',
            checksum: CHECKSUM,
            exclusions: [],
          },
          dumpChecksum: state.openedChecksum ?? CHECKSUM,
          dumpBytes: state.dumpBytes,
        };
      },
      async checksum() {
        return { checksum: CHECKSUM, bytes: state.dumpBytes };
      },
    },
    workspaces: {
      async create() {
        return workspace;
      },
    },
    delivery: {
      get configured() {
        return state.deliveryConfigured;
      },
      async sendDocument(input) {
        state.deliveredDocument = { caption: input.caption, filename: input.filename };
        return state.delivery;
      },
      async sendMessage(text) {
        state.deliveredMessage = text;
        return state.delivery;
      },
    },
    clock,
    ids: {
      uuid: () => `run-${String(++counter)}`,
      callbackRef: () => 'ref',
    },
    installationId: () => 'installation-1',
    opsLog: {
      async record(_scope, event) {
        if (state.opsLogThrows) throw new Error('the ops log is unreachable');
        state.recorded.push({
          code: event.code,
          severity: event.severity,
          ...(event.dedupeKey === undefined ? {} : { dedupeKey: event.dedupeKey }),
          ...(event.recoversCode === undefined ? {} : { recoversCode: event.recoversCode }),
        });
        return {
          id: 'e1',
          code: event.code,
          severity: event.severity,
          message: event.message,
          occurrenceCount: 1,
          firstSeenAt: NOW,
          lastSeenAt: NOW,
          isNew: true,
          reopened: false,
        };
      },
    },
    scope: () => (state.scoped ? { tenantId: 't1' as never, botInstanceId: null } : null),
    logger: { info() {}, warn() {}, error() {} },
    leaseOwner: 'worker:1:aaaa',
    retainedArchiveHint: '/var/lib/nexa/backups',
  });

  return { service, runs, clock, state };
}

async function completed(h: Harness, trigger: BackupTrigger = 'MANUAL'): Promise<BackupRunRow> {
  const outcome = await h.service.run(trigger);
  if (outcome.kind !== 'COMPLETED') throw new Error('expected the run to complete');
  return outcome.run;
}

describe('the backup pipeline', () => {
  it('runs its stages in order and records a verified, delivered success', async () => {
    const h = harness();
    const run = await completed(h);

    expect(h.runs.stages).toEqual(['DUMP', 'CHECKSUM', 'ENCRYPT', 'VERIFY_RESTORE', 'DELIVER']);
    expect(run.state).toBe('SUCCEEDED');
    expect(run.checksum).toBe(CHECKSUM);
    expect(run.dumpBytes).toBe(4096n);
    expect(run.archiveBytes).toBe(5000n);
    expect(run.verifiedAt).not.toBeNull();
    expect(run.deliveryState).toBe('SUCCEEDED');
    expect(run.cleanupOk).toBe(true);
  });

  it('never delivers an archive whose restore verification failed', async () => {
    const h = harness();
    // `ok: false` with a NON-ZERO table count, deliberately. A partial
    // `pg_restore --exit-on-error` really does leave tables behind, and a
    // fixture using zero here would be killed by the empty-restore rule below
    // instead — so this test would pass with the "did the restore succeed"
    // check deleted, which the falsification run proved (row B01 survived).
    h.state.verify = {
      ok: false,
      scratchDatabase: 'nexa_verify_x',
      tableCount: 12,
      detail: 'pg_restore: error: could not read',
    };

    const run = await completed(h);

    // The whole point of the stage order. Not "delivery was not called" — the
    // artifact is gone, the run is FAILED at the stage that failed, and nothing
    // reached Telegram.
    expect(run.state).toBe('FAILED');
    expect(run.stage).toBe('VERIFY_RESTORE');
    expect(run.failureCode).toBe('backup.verification_failed');
    expect(run.deliveryState).toBe('NOT_ATTEMPTED');
    expect(h.state.deliveredDocument).toBeNull();
    expect(h.state.deliveredMessage).toBeNull();
    expect(h.state.everythingRemoved).toBe(true);
    expect(run.verifiedAt).toBeNull();
  });

  it('fails a restore that succeeds and produces no tables', async () => {
    const h = harness();
    // An empty dump restores perfectly. This is the failure that looks most
    // like a success anywhere else in the pipeline.
    h.state.verify = { ok: true, scratchDatabase: 'nexa_verify_x', tableCount: 0, detail: null };

    const run = await completed(h);
    expect(run.state).toBe('FAILED');
    expect(run.stage).toBe('VERIFY_RESTORE');
    expect(h.state.deliveredDocument).toBeNull();
  });

  it('fails when the decrypted bytes do not match the checksum that was taken', async () => {
    const h = harness();
    h.state.openedChecksum = 'b'.repeat(64);

    const run = await completed(h);
    expect(run.state).toBe('FAILED');
    expect(run.failureCode).toBe('backup.checksum_mismatch');
    expect(h.state.deliveredDocument).toBeNull();
  });

  it('fails a zero-byte dump rather than encrypting and delivering it', async () => {
    const h = harness();
    h.state.dumpBytes = 0;

    const run = await completed(h);
    expect(run.state).toBe('FAILED');
    expect(run.stage).toBe('CHECKSUM');
    expect(h.state.deliveredDocument).toBeNull();
  });

  it('removes the plaintext dump before delivery, and everything on failure', async () => {
    const success = harness();
    await completed(success);
    // Before the network stage, not at the end: delivery is the longest and
    // least predictable part of the run, and there is no reason the unencrypted
    // database should still exist while it happens.
    expect(success.state.plaintextRemoved).toBe(true);
    expect(success.state.everythingRemoved).toBe(false);

    for (const failure of ['dump', 'seal'] as const) {
      const h = harness();
      if (failure === 'dump') h.state.dumpFails = true;
      else h.state.sealFails = true;
      await completed(h);
      // An archive from a run that failed before verification is unproven, and
      // an unproven archive on disk is what stops somebody looking for a real
      // one. Everything goes.
      expect(h.state.everythingRemoved).toBe(true);
    }
  });

  it('reports an incomplete cleanup instead of a clean success', async () => {
    const h = harness();
    h.state.cleanupFails = true;
    h.state.leaked = ['nexa_verify_leftover'];

    const run = await completed(h);
    expect(run.state).toBe('SUCCEEDED');
    // Visible, because what is left behind is plaintext database bytes and a
    // scratch database on the operator's own server.
    expect(run.cleanupOk).toBe(false);
    expect(run.cleanupDetail).toContain('nexa_verify_leftover');
    expect(run.cleanupDetail).toContain('/w/dump');
  });

  it('keeps a verified archive a success when its delivery is definitively refused', async () => {
    const h = harness();
    h.state.delivery = { state: 'FAILED_DEFINITIVE', detail: 'HTTP 400 (400): chat not found' };

    const run = await completed(h);
    // The artifact dumped, checksummed, encrypted and restored. Calling that a
    // failed backup would tell an operator their data is unprotected while it
    // sits verified on their own disk.
    expect(run.state).toBe('SUCCEEDED');
    expect(run.verifiedAt).not.toBeNull();
    expect(run.deliveryState).toBe('FAILED_DEFINITIVE');
    expect(run.deliveryDetail).toContain('chat not found');
  });

  it('records an unobserved delivery as unknown and resends nothing', async () => {
    const h = harness();
    h.state.delivery = { state: 'OUTCOME_UNKNOWN', detail: 'The request did not complete' };

    const run = await completed(h);
    expect(run.state).toBe('SUCCEEDED');
    expect(run.deliveryState).toBe('OUTCOME_UNKNOWN');
    expect(run.deliveryAttemptedAt).not.toBeNull();
    // Exactly one attempt. The state exists because the system does not know
    // enough to decide; a resend would be deciding.
    expect(h.state.deliveredDocument).not.toBeNull();
    expect(await h.runs.withUnknownDelivery()).toHaveLength(1);
  });

  it('distinguishes no destination from a failed delivery', async () => {
    const h = harness();
    h.state.deliveryConfigured = false;

    const run = await completed(h);
    expect(run.state).toBe('SUCCEEDED');
    expect(run.deliveryState).toBe('NOT_ATTEMPTED');
    expect(run.deliveryAttemptedAt).toBeNull();
    expect(h.state.deliveredDocument).toBeNull();
  });

  it('notifies rather than sends when the archive is above the Telegram ceiling', async () => {
    const h = harness();
    h.state.archiveBytes = 50 * 1024 * 1024 + 1;

    const run = await completed(h);
    expect(h.state.deliveredDocument).toBeNull();
    expect(h.state.deliveredMessage).toContain('RETAINED: /var/lib/nexa/backups');
    expect(h.state.deliveredMessage).toContain(CHECKSUM);
    expect(run.deliveryState).toBe('SUCCEEDED');
  });

  it('puts identity, size, checksum and the verification in the caption and nothing else', async () => {
    const h = harness();
    const run = await completed(h);
    const caption = h.state.deliveredDocument?.caption ?? '';

    expect(caption).toContain(run.id);
    expect(caption).toContain(CHECKSUM);
    expect(caption).toContain('30 tables');
    expect(caption).toContain('PostgreSQL 16.13');
    // Nothing that could be a credential, a connection string, or a hint at
    // which key opens the archive.
    expect(caption).not.toMatch(/postgres:\/\//);
    expect(caption).not.toMatch(/token/i);
    expect(caption).not.toMatch(/password/i);
    expect(caption).not.toMatch(/\bk1\b/);
    expect(caption).not.toMatch(/SECRETS_/);
  });

  it('reports BUSY truthfully instead of taking a second backup', async () => {
    const h = harness();
    const first = await completed(h);
    h.runs.busyWith = { ...first, state: 'RUNNING', finishedAt: null };

    const second = await h.service.run('SCHEDULED');
    expect(second.kind).toBe('BUSY');
    if (second.kind !== 'BUSY') throw new Error('unreachable');
    expect(second.holder.id).toBe(first.id);
    // One row, not two. A BUSY caller must not have created a run.
    expect(h.runs.rows.size).toBe(1);
  });

  it('runs manual and scheduled backups through the identical path', async () => {
    const manual = harness();
    const scheduled = harness();
    const a = await completed(manual, 'MANUAL');
    const b = await completed(scheduled, 'SCHEDULED');

    // Same stages, same verification, same delivery. The trigger is recorded
    // and is the ONLY difference — which is the property that stops the
    // unattended path from being the untested one.
    expect(manual.runs.stages).toEqual(scheduled.runs.stages);
    expect(a.trigger).toBe('MANUAL');
    expect(b.trigger).toBe('SCHEDULED');
    expect({ ...a, id: '', trigger: 'MANUAL', startedAt: null, finishedAt: null }).toEqual({
      ...b,
      id: '',
      trigger: 'MANUAL',
      startedAt: null,
      finishedAt: null,
    });
  });

  it('reports a failed run as an operational condition, not just a log line', async () => {
    const h = harness();
    h.state.dumpFails = true;
    const run = await completed(h, 'SCHEDULED');

    expect(run.state).toBe('FAILED');
    // The gap Backup V1 shipped with: a failed SCHEDULED backup produced a log
    // line and a row and nothing else — silent on the channel this installation
    // built to report failures, for the one subsystem that runs unattended.
    const failure = h.state.recorded.find((event) => event.code === 'backup.run_failed');
    expect(failure).toBeDefined();
    expect(failure?.severity).toBe('ERROR');
    // ONE installation-wide key, so a nightly failure is one open condition
    // with a rising count rather than a fresh alert every night.
    expect(failure?.dedupeKey).toBe('backup.run');
  });

  it('closes the open failure when a run succeeds', async () => {
    const h = harness();
    await completed(h, 'SCHEDULED');

    const recovery = h.state.recorded.find((event) => event.code === 'backup.run_ok');
    expect(recovery).toBeDefined();
    expect(recovery?.recoversCode).toBe('backup.run_failed');
    // A success that did not close the failure would leave an operator with a
    // permanently open condition and no way to clear it.
  });

  it('records nothing rather than addressing an alert to nobody', async () => {
    const h = harness();
    h.state.scoped = false;
    h.state.dumpFails = true;
    const run = await completed(h);

    // A backup can legitimately be taken before a tenant is provisioned.
    // Inventing a scope would be worse than staying quiet: it would file the
    // alert against an addressee that does not exist.
    expect(run.state).toBe('FAILED');
    expect(h.state.recorded).toEqual([]);
  });

  it('does not let a failing ops log replace the failure it was reporting', async () => {
    const h = harness();
    h.state.dumpFails = true;
    h.state.opsLogThrows = true;
    const run = await completed(h);

    // The run's own failure survives. Reporting that failed would otherwise
    // overwrite the message an operator needs with a message about why they
    // did not get it.
    expect(run.state).toBe('FAILED');
    expect(run.failureMessage).toBe('pg_dump exploded');
  });

  it('keeps no secret in a failure message', async () => {
    const h = harness();
    h.state.dumpFails = true;
    const run = await completed(h);
    expect(run.failureMessage).toBe('pg_dump exploded');
    expect(run.failureMessage).not.toMatch(/postgres:\/\/|PGPASSWORD|SECRETS_/);
  });
});

describe('the backup scheduler', () => {
  function scheduled(): { scheduler: BackupScheduler; h: Harness } {
    const h = harness();
    const scheduler = new BackupScheduler({
      service: h.service,
      runs: h.runs,
      clock: h.clock,
      intervalMs: 24 * 3_600_000,
      tickIntervalMs: 60_000,
      logger: { info() {}, warn() {}, error() {} },
    });
    return { scheduler, h };
  }

  it('backs up immediately when the installation has never had one', async () => {
    const { scheduler, h } = scheduled();
    await scheduler.tick();
    expect(h.runs.rows.size).toBe(1);
  });

  it('measures the interval from the last SUCCESS, not from process start', async () => {
    const { scheduler, h } = scheduled();
    h.runs.lastSuccess = new Date(NOW.getTime() - 3_600_000);

    await scheduler.tick();
    // An hour after a success, with a daily interval: not due. A scheduler
    // counting from its own start would back up here on every restart.
    expect(h.runs.rows.size).toBe(0);

    h.clock.advance(24 * 3_600_000);
    await scheduler.tick();
    expect(h.runs.rows.size).toBe(1);
  });

  it('is not fresh until a tick completes, and stops being fresh when ticks throw', async () => {
    const { scheduler, h } = scheduled();
    // Health is a claim about work, not about a timer existing.
    expect(scheduler.isFresh(h.clock.now().getTime())).toBe(false);

    await scheduler.tick();
    expect(scheduler.isFresh(h.clock.now().getTime())).toBe(true);

    h.runs.lastSucceededAt = async () => {
      throw new Error('the database is unreachable');
    };
    h.clock.advance(4 * 60_000);
    await scheduler.tick();
    // The tick threw, so progress did not advance and the worker's health check
    // says so rather than reporting a live timer as a working scheduler.
    expect(scheduler.isFresh(h.clock.now().getTime())).toBe(false);
  });

  it('survives a throwing tick rather than ending scheduled backups', async () => {
    const { scheduler, h } = scheduled();
    let calls = 0;
    const real = h.runs.lastSucceededAt.bind(h.runs);
    h.runs.lastSucceededAt = async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return real();
    };

    await scheduler.tick();
    expect(h.runs.rows.size).toBe(0);
    await scheduler.tick();
    // One transient database error must not end scheduled backups for the life
    // of the process.
    expect(h.runs.rows.size).toBe(1);
  });
});
