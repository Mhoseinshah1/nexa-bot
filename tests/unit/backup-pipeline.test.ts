import { describe, expect, it, vi } from 'vitest';
import type {
  BackupDeliveryState,
  BackupManifest,
  BackupStage,
  BackupTrigger,
} from '@nexa/contracts';
import { BackupService } from '../../apps/api/src/modules/platform/backup/application/backup.service';
import { BackupScheduler } from '../../apps/api/src/modules/platform/backup/application/backup-scheduler';
import { BackupSchedulePolicy } from '../../apps/api/src/modules/platform/backup/application/backup-schedule';
import type {
  BackupDelivery,
  BackupDeliveryResolution,
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
  /**
   * Shared with the fake ops log, so the ORDER of the two writes is observable.
   *
   * The service records a recovery before finishing the row on purpose: a crash
   * between the two must leave the condition open rather than resolved. Nothing
   * could see that order, so swapping the two calls was a silent change.
   */
  readonly writes: string[] = [];

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
      archivePrunedAt: null,
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

  /**
   * Retention is not the pipeline's concern, and the fake says so.
   *
   * The exclusions that make a purge safe are SQL predicates — two of them
   * subqueries for "the most recent row" — so they are only testable against a
   * real database. `tests/integration/backup-retention.test.ts` does that; a fake
   * here that reimplemented them would be testing its own arithmetic, which is
   * the shape of test this repository keeps finding and deleting.
   */
  async purgeFinishedBefore(): Promise<number> {
    throw new Error('the backup pipeline must never purge run rows');
  }

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
    this.writes.push(`finish:${input.state}`);
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

  /*
   * The three methods the Web history needs, which this fake does not exercise.
   *
   * Present so the class satisfies the port rather than being cast to it: a
   * `as unknown as BackupRunRepository` would make every FUTURE method optional
   * here too, and the next one added would be missing from this fake silently.
   * They throw rather than returning empty, so a case that started depending on
   * one fails loudly instead of asserting against a fabricated answer.
   */
  async page(): Promise<{ rows: readonly BackupRunRow[]; nextCursor: string | null }> {
    throw new Error('the pipeline fake does not serve the Web history');
  }

  async countUnknownDeliveries(): Promise<number> {
    throw new Error('the pipeline fake does not count deliveries');
  }

  async active(): Promise<BackupRunRow | null> {
    throw new Error('the pipeline fake does not report the lock holder');
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
    recorded: {
      code: string;
      severity: string;
      message: string;
      context?: Record<string, unknown>;
      dedupeKey?: string;
      recoversCode?: string;
    }[];
    /** Null models an installation with no tenant provisioned yet. */
    scoped: boolean;
    opsLogThrows: boolean;
    /** Codes whose installation condition is open, for `conditionOpen`. */
    open: Set<string>;
    /** Called inside the DUMP stage, so a test can look at the service mid-run. */
    onDump?: () => void;
  };
}

const CHECKSUM = 'a'.repeat(64);
const DAY_MS = 24 * 3_600_000;
/** The production default tick: five minutes, NOT the thirty-second workaround. */
const TICK_MS = 5 * 60_000;
/** `BACKUP_LEASE_STALE_AFTER_MS`: how long a run's heartbeat may be silent. */
const RUN_STALE_MS = 15 * 60_000;

function harness(options: { delivery?: BackupDelivery } = {}): Harness {
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
    open: new Set<string>(),
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
        state.onDump?.();
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
    delivery: options.delivery ?? {
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
        runs.writes.push(`report:${event.code}`);
        state.recorded.push({
          code: event.code,
          severity: event.severity,
          message: event.message,
          ...(event.context === undefined ? {} : { context: event.context }),
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
    conditionOpen: async (code) => state.open.has(code),
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
    // Spec §13.1: a notice nobody can read as a delivered file — in Persian, first.
    expect(h.state.deliveredMessage?.split('\n')[0]).toMatch(/فایل ارسال نشد/);
    expect(run.deliveryState).toBe('SUCCEEDED');
    expect(run.deliveryDetail).toContain('retained on the server');
  });

  /*
   * Spec §13.1 — "a Telegram delivery failure does not destroy the local backup, and the
   * backup itself is not marked failed". Each case below is a way delivery can go wrong
   * that is NEW with routing: the router that reads the group can throw, the group can be
   * connected and unusable, and a channel can throw rather than answer.
   */
  describe('when routed delivery goes wrong', () => {
    const router = (resolve: () => Promise<BackupDeliveryResolution>): BackupDelivery => ({
      resolve,
      describe: async () => 'OPS_GROUP_TOPIC' as const,
    });

    it('keeps the run a success when the destination cannot even be resolved', async () => {
      const h = harness({
        delivery: router(async () => {
          throw new Error('the ops group table is unreachable');
        }),
      });
      const run = await completed(h);
      expect(run.state).toBe('SUCCEEDED');
      expect(run.verifiedAt).not.toBeNull();
      expect(run.deliveryState).toBe('FAILED_DEFINITIVE');
      expect(run.deliveryDetail).toContain('could not be resolved');
      // The verified archive stays on the server: only the plaintext was discarded.
      expect(h.state.everythingRemoved).toBe(false);
      expect(h.state.recorded.map((event) => event.code)).toContain('backup.run_ok');
    });

    it('records a connected-but-unusable group as a refusal, not a backup failure', async () => {
      const h = harness({
        delivery: router(async () => ({ kind: 'UNAVAILABLE', detail: 'topic unavailable' })),
      });
      const run = await completed(h);
      expect(run.state).toBe('SUCCEEDED');
      expect(run.deliveryState).toBe('FAILED_DEFINITIVE');
      expect(run.deliveryAttemptedAt).not.toBeNull();
      expect(h.state.everythingRemoved).toBe(false);
    });

    it('records a channel that throws as an unobserved outcome, never resent', async () => {
      let sends = 0;
      const h = harness({
        delivery: router(async () => ({
          kind: 'READY',
          destination: 'OPS_GROUP_TOPIC',
          channel: {
            async sendDocument() {
              sends += 1;
              throw new Error('socket hang up');
            },
            async sendMessage() {
              sends += 1;
              throw new Error('socket hang up');
            },
          },
        })),
      });
      const run = await completed(h);
      expect(run.state).toBe('SUCCEEDED');
      expect(run.deliveryState).toBe('OUTCOME_UNKNOWN');
      expect(sends).toBe(1);
      expect(await h.runs.withUnknownDelivery()).toHaveLength(1);
    });

    it('reports where the next archive would go', async () => {
      await expect(
        harness({ delivery: router(async () => ({ kind: 'NONE' })) }).service.deliveryDestination(),
      ).resolves.toBe('OPS_GROUP_TOPIC');
      const fixed = harness();
      await expect(fixed.service.deliveryDestination()).resolves.toBe('DEDICATED_CHAT');
      fixed.state.deliveryConfigured = false;
      await expect(fixed.service.deliveryDestination()).resolves.toBe('NONE');
    });
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

  it('records the recovery BEFORE it finishes the row', async () => {
    const h = harness();
    await completed(h, 'SCHEDULED');

    /*
     * The order is the rule, and it is a crash-safety rule rather than a
     * tidiness one. If the row were finished first and the process died before
     * the recovery was recorded, the run would read SUCCEEDED while
     * `backup.run_failed` stayed open — annoying, and self-correcting on the
     * next run. The other order fails the other way: the condition is resolved
     * while the row still reads RUNNING, so an operator is told the backup
     * recovered when the run that was supposed to prove it never finished.
     *
     * An hour chasing a backup that is fine is the acceptable cost. Believing a
     * broken backup recovered is not.
     */
    expect(h.runs.writes).toEqual(['report:backup.run_ok', 'finish:SUCCEEDED']);
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

  it('keeps the uncontrolled exception text out of the OPERATIONAL EVENT message', async () => {
    /*
     * `message` is the field `operational-event-projector.ts` queues for the Telegram
     * report group, and `docs/hardening-audit.md` § K records that it is never
     * redacted — safe "by author discipline". A message built from a caught
     * exception is not author-controlled, so the exception text goes in `context`,
     * which is redacted and is not projected.
     *
     * Asserted against the EXCEPTION's own text, which is the thing whose content
     * nobody here controls. The previous version of this case asserted
     * `not.toMatch(/postgres:\/\/|PGPASSWORD|SECRETS_/)` against a message built from
     * a string the fake itself supplies — so it could never fail whatever the
     * production code did with it.
     *
     * The stage and the failure CODE stay in the message, because both are closed
     * vocabularies and they are what makes the alert actionable.
     */
    const h = harness();
    h.state.dumpFails = true;
    const run = await completed(h);
    // The run ROW keeps the full text: it is read by an operator through the API,
    // not pushed to a chat.
    expect(run.failureMessage).toBe('pg_dump exploded');

    const reported = h.state.recorded.find((event) => event.code === 'backup.run_failed');
    expect(reported).toBeDefined();
    expect(reported?.message).not.toContain('pg_dump exploded');
    expect(reported?.message).toContain('DUMP');
    expect(reported?.message).toContain(run.failureCode ?? 'no-code');
    // And it is not simply dropped — an operator reading the event's detail can
    // still get to it.
    expect(reported?.context?.failureMessage).toBe('pg_dump exploded');
  });
});

describe('the run lease the scheduler reads', () => {
  it('names the run in flight from its claim, and nothing once it is over', async () => {
    const h = harness();
    expect(h.service.leaseHeartbeatAt()).toBeNull();
    let during: number | null = null;
    h.state.onDump = () => {
      during = h.service.leaseHeartbeatAt();
    };
    await completed(h);
    expect(during).toBe(NOW.getTime());
    expect(h.service.leaseHeartbeatAt()).toBeNull();
  });
});

describe('the backup scheduler', () => {
  function scheduled(
    options: {
      quiesced?: boolean;
      schedule?: () => Promise<{ enabled: boolean; intervalMs: number }>;
      h?: Harness;
    } = {},
  ): {
    scheduler: BackupScheduler;
    h: Harness;
  } {
    const h = options.h ?? harness();
    const scheduler = new BackupScheduler({
      service: h.service,
      runs: h.runs,
      // Whether a recovery holds the installation. The default is the ordinary
      // case; the case below sets it.
      quiesced: async () => options.quiesced === true,
      clock: h.clock,
      schedule: options.schedule ?? (async () => ({ enabled: true, intervalMs: DAY_MS })),
      tickIntervalMs: TICK_MS,
      runHeartbeatAt: () => null,
      runStaleAfterMs: RUN_STALE_MS,
      logger: { info() {}, warn() {}, error() {} },
    });
    return { scheduler, h };
  }

  it('backs up immediately when the installation has never had one', async () => {
    const { scheduler, h } = scheduled();
    await scheduler.tick();
    expect(h.runs.rows.size).toBe(1);
  });

  it('does not start a backup while a recovery holds the installation', async () => {
    /*
     * The unattended caller, and the one that needed the check most.
     *
     * `backup_runs` is written on the database handle rather than through the
     * unit of work, so no backup write passes either quiesce chokepoint — the
     * write gate cannot stop this one. The operator's own button is checked at
     * its surface for exactly that reason, and the scheduler was left out on the
     * strength of a comment that said it is the pre-restore backup's own path.
     * It is not: the executor calls `BackupService.run('PRE_RESTORE')` directly.
     *
     * Left unchecked, a tick landing in the window between the recovery's
     * pre-restore backup releasing the lock and the executor quiescing starts a
     * full `pg_dump` against a database that is about to be renamed away.
     */
    const { scheduler, h } = scheduled({ quiesced: true });
    await scheduler.tick();
    expect(h.runs.rows.size).toBe(0);

    // The POSITIVE CONTROL, on the same fixture: a scheduler that never backed
    // up would pass the assertion above whatever the reason.
    const ordinary = scheduled();
    await ordinary.scheduler.tick();
    expect(ordinary.h.runs.rows.size).toBe(1);
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
    h.clock.advance(3 * TICK_MS + 60_000);
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

  /*
   * Spec §14 — the startup-health defect, permanently. `lastTickAt` began null, the first
   * tick came one whole `BACKUP_TICK_MS` (five minutes) after start, and the worker's
   * health check answered "stalled" for all of it — longer than the container health
   * check waits. Production ran `BACKUP_TICK_MS=30000` to hide it. These run at the
   * DEFAULT five-minute tick, so a regression cannot hide behind a short one.
   */
  it('checks immediately on start, without waiting a tick interval', async () => {
    const { scheduler, h } = scheduled();
    scheduler.start();
    try {
      // No clock advance and no timer: the first check is fired by start() itself.
      await vi.waitFor(() => expect(h.runs.rows.size).toBe(1));
      expect(scheduler.isFresh(h.clock.now().getTime())).toBe(true);
    } finally {
      scheduler.stop();
    }
  });

  it('is healthy from start() until its first tick is overdue, not only after it', async () => {
    // A first check that never completes: the schedule read hangs.
    const { scheduler, h } = scheduled({ schedule: () => new Promise(() => {}) });
    expect(scheduler.isFresh(h.clock.now().getTime())).toBe(false);
    scheduler.start();
    try {
      // Pre-first-tick is startup, not failure.
      expect(scheduler.isFresh(h.clock.now().getTime())).toBe(true);
      h.clock.advance(2 * TICK_MS);
      expect(scheduler.isFresh(h.clock.now().getTime())).toBe(true);
      // ...and the grace is bounded: a scheduler that never completes a tick is reported.
      h.clock.advance(TICK_MS + 60_000);
      expect(scheduler.isFresh(h.clock.now().getTime())).toBe(false);
    } finally {
      scheduler.stop();
    }
  });

  it('never runs two backups at once from one process, however the ticks arrive', async () => {
    const h = harness();
    let release: () => void = () => {};
    let calls = 0;
    const slow = {
      async run() {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { kind: 'BUSY' as const, holder: [...h.runs.rows.values()][0] as BackupRunRow };
      },
    } as unknown as BackupService;
    const scheduler = new BackupScheduler({
      service: slow,
      runs: h.runs,
      quiesced: async () => false,
      clock: h.clock,
      schedule: async () => ({ enabled: true, intervalMs: DAY_MS }),
      tickIntervalMs: TICK_MS,
      runHeartbeatAt: () => null,
      runStaleAfterMs: RUN_STALE_MS,
      logger: { info() {}, warn() {}, error() {} },
    });
    scheduler.start();
    try {
      await vi.waitFor(() => expect(calls).toBe(1));
      // A timer tick (or anything else) arriving while the immediate check's run is in
      // flight starts nothing. The database lock is the cross-process guarantee; this is
      // the in-process one, and it is what makes the immediate tick safe beside the timer.
      await scheduler.tick();
      await scheduler.tick();
      expect(calls).toBe(1);
    } finally {
      release();
      scheduler.stop();
    }
  });

  /*
   * Codex review of PR #142, finding 5: a fixed run budget (dump + restore + delivery)
   * left out the checksum, encrypt and decrypt stages, which stream the whole database
   * with no timeout, so a large legitimate run was reported stalled. In flight, health is
   * now the run's LEASE heartbeat — the same signal that decides whether the run is
   * abandoned — with no budget at all.
   */
  it('stays healthy while the run lease heartbeat is alive, however long the run', async () => {
    const h = harness();
    let release: () => void = () => {};
    let started = false;
    let heartbeatAt: number | null = null;
    const slow = {
      run: () =>
        new Promise((resolve) => {
          started = true;
          release = () => resolve({ kind: 'BUSY', holder: null });
        }),
    } as unknown as BackupService;
    const scheduler = new BackupScheduler({
      service: slow,
      runs: h.runs,
      quiesced: async () => false,
      clock: h.clock,
      schedule: async () => ({ enabled: true, intervalMs: DAY_MS }),
      tickIntervalMs: TICK_MS,
      runHeartbeatAt: () => heartbeatAt,
      runStaleAfterMs: RUN_STALE_MS,
      logger: { info() {}, warn() {}, error() {} },
    });
    const ticking = scheduler.tick();
    await vi.waitFor(() => expect(started).toBe(true));
    // Ten hours of streaming a huge database, heartbeating every minute: working.
    for (let minute = 0; minute < 600; minute += 1) {
      h.clock.advance(60_000);
      heartbeatAt = h.clock.now().getTime();
    }
    expect(scheduler.isFresh(h.clock.now().getTime())).toBe(true);
    // The heartbeat stops: past the lease window the run is abandoned, and health says so.
    h.clock.advance(RUN_STALE_MS - 1_000);
    expect(scheduler.isFresh(h.clock.now().getTime())).toBe(true);
    h.clock.advance(2_000);
    expect(scheduler.isFresh(h.clock.now().getTime())).toBe(false);
    release();
    await ticking;
  });

  it('reports a run with no heartbeat at all as stalled once its lease window passes', async () => {
    const h = harness();
    let started = false;
    let release: () => void = () => {};
    const slow = {
      run: () =>
        new Promise((resolve) => {
          started = true;
          release = () => resolve({ kind: 'BUSY', holder: null });
        }),
    } as unknown as BackupService;
    const scheduler = new BackupScheduler({
      service: slow,
      runs: h.runs,
      quiesced: async () => false,
      clock: h.clock,
      schedule: async () => ({ enabled: true, intervalMs: DAY_MS }),
      tickIntervalMs: TICK_MS,
      runHeartbeatAt: () => null,
      runStaleAfterMs: RUN_STALE_MS,
      logger: { info() {}, warn() {}, error() {} },
    });
    const ticking = scheduler.tick();
    await vi.waitFor(() => expect(started).toBe(true));
    h.clock.advance(RUN_STALE_MS + 1_000);
    expect(scheduler.isFresh(h.clock.now().getTime())).toBe(false);
    release();
    await ticking;
  });

  it('reads the schedule on every tick: off takes nothing, on takes a backup, no restart', async () => {
    let schedule = { enabled: false, intervalMs: DAY_MS };
    const { scheduler, h } = scheduled({ schedule: async () => schedule });
    await scheduler.tick();
    expect(h.runs.rows.size).toBe(0);
    // Off is a decision, not a fault: the tick completed.
    expect(scheduler.isFresh(h.clock.now().getTime())).toBe(true);

    schedule = { enabled: true, intervalMs: DAY_MS };
    await scheduler.tick();
    expect(h.runs.rows.size).toBe(1);
  });

  it('measures the interval the schedule gives it, from the last success', async () => {
    let schedule = { enabled: true, intervalMs: 3 * 3_600_000 };
    const { scheduler, h } = scheduled({ schedule: async () => schedule });
    h.runs.lastSuccess = new Date(NOW.getTime() - 2 * 3_600_000);
    await scheduler.tick();
    expect(h.runs.rows.size).toBe(0);
    // An operator shortens the interval from the Web Admin: the next tick obeys it.
    schedule = { enabled: true, intervalMs: 3_600_000 };
    await scheduler.tick();
    expect(h.runs.rows.size).toBe(1);
  });
});

describe('the backup schedule policy', () => {
  const ENV = { enabled: false, intervalMs: DAY_MS };
  const SCOPE = { tenantId: 't1' as never, botInstanceId: null };

  function policy(
    stored: { enabled: boolean | null; intervalMinutes: number | null },
    scoped = true,
  ): BackupSchedulePolicy {
    return new BackupSchedulePolicy({
      settings: { read: async () => stored },
      scope: () => (scoped ? SCOPE : null),
      environment: ENV,
    });
  }

  it('is the environment when the Web Admin has set nothing (compatible default)', async () => {
    await expect(policy({ enabled: null, intervalMinutes: null }).effective()).resolves.toEqual({
      enabled: false,
      intervalMs: DAY_MS,
      source: { enabled: 'ENVIRONMENT', interval: 'ENVIRONMENT' },
    });
  });

  it('takes each stored half over the environment, independently', async () => {
    await expect(policy({ enabled: true, intervalMinutes: null }).effective()).resolves.toEqual({
      enabled: true,
      intervalMs: DAY_MS,
      source: { enabled: 'SETTING', interval: 'ENVIRONMENT' },
    });
    await expect(policy({ enabled: null, intervalMinutes: 180 }).effective()).resolves.toEqual({
      enabled: false,
      intervalMs: 3 * 3_600_000,
      source: { enabled: 'ENVIRONMENT', interval: 'SETTING' },
    });
    // A stored OFF is an answer, not an absence: it beats an environment that says on.
    const off = new BackupSchedulePolicy({
      settings: { read: async () => ({ enabled: false, intervalMinutes: null }) },
      scope: () => SCOPE,
      environment: { enabled: true, intervalMs: DAY_MS },
    });
    expect((await off.effective()).enabled).toBe(false);
  });

  it('is the environment before a tenant exists to hold a setting', async () => {
    const effective = await policy({ enabled: true, intervalMinutes: 60 }, false).effective();
    expect(effective.enabled).toBe(false);
    expect(effective.source).toEqual({ enabled: 'ENVIRONMENT', interval: 'ENVIRONMENT' });
  });
});

/**
 * E5: the two conditions the pipeline itself raises beside `backup.run_failed`.
 *
 * Before these, a run whose archive never left the host recorded `backup.run_ok`
 * and nothing else, and a run that left plaintext behind wrote a log line and a
 * column. Each case below fails if the rule it names is removed.
 */
describe('the backup conditions beside the run (E5)', () => {
  it.each(['FAILED_DEFINITIVE', 'OUTCOME_UNKNOWN'] as const)(
    'opens backup.delivery_failed when a verified archive did not leave the host (%s)',
    async (deliveryState) => {
      const h = harness();
      h.state.delivery =
        deliveryState === 'FAILED_DEFINITIVE'
          ? { state: 'FAILED_DEFINITIVE', detail: 'chat not found' }
          : { state: 'OUTCOME_UNKNOWN', detail: 'timed out after the upload' };
      const run = await completed(h);

      // The run is still a success: the archive is verified and on disk.
      expect(run.state).toBe('SUCCEEDED');
      expect(h.state.recorded.some((event) => event.code === 'backup.run_ok')).toBe(true);
      const failed = h.state.recorded.find((event) => event.code === 'backup.delivery_failed');
      expect(failed).toBeDefined();
      expect(failed?.severity).toBe('WARN');
      expect(failed?.dedupeKey).toBe('backup.delivery');
      expect(failed?.message).toContain(deliveryState);
    },
  );

  it('closes an OPEN delivery condition when a run delivers, and records nothing when none is open', async () => {
    const healthy = harness();
    await completed(healthy);
    // Nothing open, nothing recorded: a healthy installation is not told it is
    // healthy on every run.
    expect(healthy.state.recorded.map((event) => event.code)).not.toContain('backup.delivery_ok');

    const recovering = harness();
    recovering.state.open.add('backup.delivery_failed');
    await completed(recovering);
    const ok = recovering.state.recorded.find((event) => event.code === 'backup.delivery_ok');
    expect(ok?.recoversCode).toBe('backup.delivery_failed');
    expect(recovering.state.recorded.map((event) => event.code)).not.toContain(
      'backup.delivery_failed',
    );
  });

  it('opens backup.cleanup_failed when a successful run leaves plaintext, with a count and no path', async () => {
    const h = harness();
    h.state.cleanupFails = true;
    const run = await completed(h);

    expect(run.state).toBe('SUCCEEDED');
    expect(run.cleanupOk).toBe(false);
    const failed = h.state.recorded.find((event) => event.code === 'backup.cleanup_failed');
    expect(failed?.severity).toBe('ERROR');
    expect(failed?.dedupeKey).toBe('backup.cleanup');
    // `message` is projected to Telegram: the paths name plaintext dumps.
    expect(failed?.message).not.toContain('/w/');
    expect(failed?.message).toContain('left 1 artifact');
  });

  it('opens backup.cleanup_failed when a FAILED run leaves its workspace or a scratch database', async () => {
    const h = harness();
    h.state.dumpFails = true;
    h.state.leaked = ['nexa_verify_leftover'];
    const run = await completed(h);

    expect(run.state).toBe('FAILED');
    const failed = h.state.recorded.find((event) => event.code === 'backup.cleanup_failed');
    expect(failed).toBeDefined();
    expect(failed?.context).toMatchObject({ state: 'FAILED', leftovers: 1 });
  });

  it('opens no cleanup condition for a run that cleaned up', async () => {
    const h = harness();
    await completed(h);
    expect(h.state.recorded.map((event) => event.code)).not.toContain('backup.cleanup_failed');
  });
});
