import { describe, expect, it, vi } from 'vitest';
import {
  NexaError,
  PLATFORM_ERROR_CODES,
  type BackupDeliveryState,
  type BackupManifest,
  type BackupStage,
  type BackupTrigger,
} from '@nexa/contracts';
import { BackupService } from '../../apps/api/src/modules/platform/backup/application/backup.service';
import { BackupScheduler } from '../../apps/api/src/modules/platform/backup/application/backup-scheduler';
import {
  BackupSchedulePolicy,
  latestDailySlot,
} from '../../apps/api/src/modules/platform/backup/application/backup-schedule';
import type {
  BackupArchivePart,
  BackupDelivery,
  BackupDeliveryResolution,
  BackupRunPartRow,
  BackupRunPartStore,
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

class FakeRuns implements BackupRunRepository, BackupRunPartStore {
  readonly rows = new Map<string, BackupRunRow>();
  /** Every part row, by `<run>:<part>`, as the repository would hold them (E4). */
  readonly partRows = new Map<string, BackupRunPartRow>();

  async recordParts(input: {
    id: string;
    leaseOwner: string;
    parts: readonly BackupArchivePart[];
  }): Promise<void> {
    this.writes.push(`parts:${String(input.parts.length)}`);
    for (const part of input.parts) {
      this.partRows.set(`${input.id}:${String(part.partNumber)}`, {
        backupId: input.id,
        partNumber: part.partNumber,
        filename: part.filename,
        bytes: BigInt(part.bytes),
        sha256: part.sha256,
        deliveryState: 'NOT_ATTEMPTED',
        deliveryAttemptedAt: null,
        telegramMessageId: null,
        deliveryDetail: null,
      });
    }
  }

  async recordPartOutcome(input: {
    id: string;
    partNumber: number;
    state: BackupDeliveryState;
    attemptedAt: Date;
    messageId: number | null;
    detail: string | null;
  }): Promise<void> {
    this.writes.push(`part:${String(input.partNumber)}:${input.state}`);
    const key = `${input.id}:${String(input.partNumber)}`;
    const row = this.partRows.get(key);
    if (row === undefined) throw new Error('a part outcome was recorded for a part never planned');
    this.partRows.set(key, {
      ...row,
      deliveryState: input.state,
      deliveryAttemptedAt: input.attemptedAt,
      telegramMessageId: input.messageId === null ? null : BigInt(input.messageId),
      deliveryDetail: input.detail,
    });
  }

  async parts(id: string): Promise<readonly BackupRunPartRow[]> {
    return [...this.partRows.values()]
      .filter((row) => row.backupId === id)
      .sort((a, b) => a.partNumber - b.partNumber);
  }
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
      archiveFormat: null,
      partCount: null,
      archiveSealId: null,
      summaryDeliveryState: null,
      phaseDurationsMs: null,
    };
    this.rows.set(row.id, row);
    return { claimed: true, run: row };
  }

  async progress(input: { id: string; stage: BackupStage }): Promise<void> {
    this.stages.push(input.stage);
    const row = this.rows.get(input.id);
    if (row !== undefined) this.rows.set(input.id, { ...row, stage: input.stage });
  }

  /** Scripted: the nth heartbeat's behaviour (1-based); default succeeds. */
  heartbeatCalls = 0;
  heartbeatScript: ((call: number) => Promise<void>) | null = null;
  async heartbeat(): Promise<void> {
    this.heartbeatCalls += 1;
    if (this.heartbeatScript !== null) await this.heartbeatScript(this.heartbeatCalls);
  }

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
    archiveFormat?: BackupRunRow['archiveFormat'];
    partCount?: number | null;
    archiveSealId?: string | null;
    summaryDeliveryState?: BackupDeliveryState | null;
    phaseDurationsMs?: BackupRunRow['phaseDurationsMs'];
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
      archiveFormat: input.archiveFormat ?? null,
      partCount: input.partCount ?? null,
      archiveSealId: input.archiveSealId ?? null,
      summaryDeliveryState: input.summaryDeliveryState ?? null,
      phaseDurationsMs: input.phaseDurationsMs ?? null,
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
    // Newest first, as the repository returns it.
    return [...this.rows.values()].reverse();
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
    /** Every document sent, in order, with its range (E4). */
    documents: {
      caption: string;
      filename: string;
      range: { start: number; end: number } | null;
    }[];
    /** Per-call outcomes for `sendDocument`, consumed in order; `delivery` once empty. */
    documentOutcomes: DeliveryAttempt[];
    /** The part size the planner splits at (E4). */
    partBytes: number;
    /** The container `seal` reports; absent is the pre-E4 answer (NXB). */
    sealFormat?: 'NXB' | 'SEVEN_ZIP';
    deliveredMessage: string | null;
    leaked: string[];
    cleanupFails: boolean;
    /** Every operational event the run recorded, in order. */
    /** Events recorded on the QUIET recorder (not projected to Telegram). */
    quiet: string[];
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
    /** Milliseconds each stage's tool takes on the fake clock (Round 5B phase durations). */
    delays: { dump: number; encrypt: number; verify: number; deliver: number };
    /** Thrown by the archiver's `preflight` before the dump, when set (Round 5B). */
    preflightError: Error | null;
    /** The number of times `dump` ran: a refused preflight must leave it at zero. */
    dumps: number;
    /** Thrown by `seal`, when set, instead of the generic `sealFails` Error. */
    sealError: Error | null;
    /** Real milliseconds the dump takes, so the lease heartbeat has time to fire. */
    dumpRealMs: number;
  };
}

const CHECKSUM = 'a'.repeat(64);
const DAY_MS = 24 * 3_600_000;
/** The production default tick: five minutes, NOT the thirty-second workaround. */
const TICK_MS = 5 * 60_000;
/** `BACKUP_LEASE_STALE_AFTER_MS`: how long a run's heartbeat may be silent. */
const RUN_STALE_MS = 15 * 60_000;

function harness(
  options: {
    delivery?: BackupDelivery;
    renderCaption?: ConstructorParameters<typeof BackupService>[0]['renderCaption'];
    heartbeat?: ConstructorParameters<typeof BackupService>[0]['heartbeat'];
    logger?: ConstructorParameters<typeof BackupService>[0]['logger'];
    orphanSweep?: ConstructorParameters<typeof BackupService>[0]['orphanSweep'];
  } = {},
): Harness {
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
    documents: [],
    documentOutcomes: [],
    partBytes: 45 * 1024 * 1024,
    deliveredMessage: null,
    leaked: [],
    cleanupFails: false,
    recorded: [],
    quiet: [],
    scoped: true,
    opsLogThrows: false,
    open: new Set<string>(),
    delays: { dump: 0, encrypt: 0, verify: 0, deliver: 0 },
    preflightError: null,
    dumps: 0,
    sealError: null,
    dumpRealMs: 0,
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
        state.dumps += 1;
        clock.advance(state.delays.dump);
        if (state.dumpRealMs > 0) await new Promise((r) => setTimeout(r, state.dumpRealMs));
        state.onDump?.();
        if (state.dumpFails) throw new Error('pg_dump exploded');
        return { databaseName: 'nexa', pgDumpVersion: 'pg_dump 16.13' };
      },
      async verifyRestore() {
        clock.advance(state.delays.verify);
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
      async preflight() {
        if (state.preflightError !== null) throw state.preflightError;
      },
      async seal() {
        clock.advance(state.delays.encrypt);
        if (state.sealError !== null) throw state.sealError;
        if (state.sealFails) throw new Error('encryption failed');
        return {
          archiveBytes: state.archiveBytes,
          keyId: 'k1',
          ...(state.sealFormat === undefined ? {} : { format: state.sealFormat }),
        };
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
        clock.advance(state.delays.deliver);
        state.deliveredDocument = { caption: input.caption, filename: input.filename };
        state.documents.push({
          caption: input.caption,
          filename: input.filename,
          range: input.range ?? null,
        });
        return state.documentOutcomes.shift() ?? state.delivery;
      },
      async sendMessage(text) {
        state.deliveredMessage = text;
        return state.delivery;
      },
    },
    ...(options.renderCaption === undefined ? {} : { renderCaption: options.renderCaption }),
    clock,
    ids: {
      uuid: () => `run-${String(++counter)}`,
      callbackRef: () => 'ref',
    },
    installationId: () => 'installation-1',
    quietOpsLog: {
      async record(_scope, event) {
        state.quiet.push(event.code);
        return {
          id: 'q1',
          code: event.code,
          severity: event.severity,
          message: event.message,
          occurrenceCount: 1,
          firstSeenAt: NOW,
          lastSeenAt: NOW,
          isNew: true,
          reopened: false,
        } as never;
      },
    },
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
    logger: options.logger ?? { info() {}, warn() {}, error() {} },
    ...(options.heartbeat === undefined ? {} : { heartbeat: options.heartbeat }),
    ...(options.orphanSweep === undefined ? {} : { orphanSweep: options.orphanSweep }),
    leaseOwner: 'worker:1:aaaa',
    // The planner's arithmetic, without a file: ranges of `archiveBytes` at `partBytes`.
    parts: {
      async plan(input) {
        const count = Math.max(1, Math.ceil(state.archiveBytes / state.partBytes));
        return Array.from({ length: count }, (_, index) => {
          const start = index * state.partBytes;
          const end = Math.min(state.archiveBytes, start + state.partBytes);
          return {
            partNumber: index + 1,
            start,
            end,
            bytes: end - start,
            sha256: String(index + 1)
              .repeat(64)
              .slice(0, 64),
            filename:
              count === 1
                ? input.filename
                : `${input.filename}.${String(index + 1).padStart(3, '0')}`,
          };
        });
      },
    },
    restoreCommand: 'botctl restore --target <db> <parts>',
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

  it('deliver: false keeps a verified archive on the server and sends nothing (Mirza restore)', async () => {
    const h = harness();
    const outcome = await h.service.run('PRE_RESTORE', { deliver: false });
    if (outcome.kind !== 'COMPLETED') throw new Error('expected the run to complete');
    const run = outcome.run;
    expect(run.state).toBe('SUCCEEDED');
    expect(run.verifiedAt).not.toBeNull();
    expect(run.deliveryState).toBe('NOT_ATTEMPTED');
    expect(run.deliveryAttemptedAt).toBeNull();
    expect(h.state.deliveredDocument).toBeNull();
    expect(h.state.deliveredMessage).toBeNull();
    // Without the option, the same harness delivers: the difference is the option.
    const delivered = await completed(harness());
    expect(delivered.deliveryState).toBe('SUCCEEDED');
  });

  it('deliver: false announces nothing and leaves the delivery condition alone (review M2)', async () => {
    const h = harness();
    // An open delivery condition a "not attempted" run must NOT close as "not configured".
    h.state.open.add('backup.delivery_failed');
    const ok = await h.service.run('PRE_RESTORE', { deliver: false });
    expect(ok.kind).toBe('COMPLETED');
    // run_ok is recorded (the run condition closes as for any success) — on the QUIET
    // recorder, which nothing projects to Telegram; nothing reaches the announcing one.
    expect(h.state.quiet).toEqual(['backup.run_ok']);
    expect(h.state.recorded).toEqual([]);
    // A failing local-only run is quiet too.
    const failing = harness();
    failing.state.dumpFails = true;
    await failing.service.run('MANUAL', { deliver: false });
    expect(failing.state.quiet).toEqual(['backup.run_failed']);
    expect(failing.state.recorded).toEqual([]);
    // The control: an ordinary run announces, and closes the delivery condition.
    const loud = harness();
    loud.state.open.add('backup.delivery_failed');
    await loud.service.run('MANUAL');
    expect(loud.state.recorded.map((r) => r.code)).toEqual(['backup.run_ok', 'backup.delivery_ok']);
    expect(loud.state.quiet).toEqual([]);
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

  it('keeps a verification pg_restore OOM kill as backup.tool_oom_killed (memory cooldown)', async () => {
    const h = harness();
    h.state.verify = {
      ok: false,
      scratchDatabase: 'nexa_verify_x',
      tableCount: 0,
      detail: 'pg_restore was killed by the system',
      oomKilled: true,
    };

    const run = await completed(h);

    expect(run.state).toBe('FAILED');
    expect(run.stage).toBe('VERIFY_RESTORE');
    expect(run.failureCode).toBe('backup.tool_oom_killed');
    expect(h.state.deliveredDocument).toBeNull();
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

  /*
   * E4 (Round 4 PR-E): above 45 MiB the archive is SPLIT, never retained with a notice.
   * Each part is its own document with its own recorded outcome; the summary follows only
   * when every part arrived.
   */
  describe('split delivery (E4)', () => {
    const MiB = 1024 * 1024;

    it('sends one document per ≤45 MiB part, as ranges of the one archive, then one summary', async () => {
      const h = harness();
      h.state.archiveBytes = 100 * MiB;
      h.state.sealFormat = 'SEVEN_ZIP';
      h.state.documentOutcomes = [
        { state: 'SUCCEEDED', detail: null, messageId: 11 },
        { state: 'SUCCEEDED', detail: null, messageId: 12 },
        { state: 'SUCCEEDED', detail: null, messageId: 13 },
      ];
      const run = await completed(h);
      expect(run.state).toBe('SUCCEEDED');
      expect(run.deliveryState).toBe('SUCCEEDED');
      expect(run.partCount).toBe(3);
      expect(h.state.documents.map((doc) => doc.range)).toEqual([
        { start: 0, end: 45 * MiB },
        { start: 45 * MiB, end: 90 * MiB },
        { start: 90 * MiB, end: 100 * MiB },
      ]);
      expect(h.state.documents.map((doc) => doc.filename.slice(-4))).toEqual([
        '.001',
        '.002',
        '.003',
      ]);
      // Every part carries its own digest in its caption.
      expect(h.state.documents[1]?.caption).toContain('2'.repeat(64));
      const parts = await h.runs.parts(run.id);
      expect(parts.map((part) => part.telegramMessageId)).toEqual([11n, 12n, 13n]);
      // The summary: the owner's restore sentence, the botctl command, every part's digest.
      expect(h.state.deliveredMessage).toContain('همهٔ بخش‌ها را در یک پوشه بگذارید');
      expect(h.state.deliveredMessage).toContain('botctl restore');
      expect(h.state.deliveredMessage).toContain('3'.repeat(64));
      expect(run.summaryDeliveryState).toBe('SUCCEEDED');
      // The plan is on the row BEFORE the first send.
      const order = h.runs.writes.filter((write) => write.startsWith('part'));
      expect(order[0]).toBe('parts:3');
    });

    it('sends a single part whole, with the summary in its caption and no second message', async () => {
      const h = harness();
      h.state.archiveBytes = 45 * MiB;
      h.state.documentOutcomes = [{ state: 'SUCCEEDED', detail: null, messageId: 7 }];
      const run = await completed(h);
      expect(run.partCount).toBe(1);
      expect(h.state.documents).toHaveLength(1);
      expect(h.state.documents[0]?.range).toBeNull();
      expect(h.state.documents[0]?.filename).not.toMatch(/\.001$/);
      expect(h.state.deliveredMessage).toBeNull();
      expect(run.summaryDeliveryState).toBeNull();
    });

    it('stops at an unknown part: never resends it, never sends the rest, reports PARTIAL in ERRORS', async () => {
      const h = harness();
      h.state.archiveBytes = 100 * MiB;
      h.state.documentOutcomes = [
        { state: 'SUCCEEDED', detail: null, messageId: 21 },
        { state: 'OUTCOME_UNKNOWN', detail: 'HTTP 502' },
        { state: 'SUCCEEDED', detail: null, messageId: 23 },
      ];
      const run = await completed(h);
      expect(run.state).toBe('SUCCEEDED');
      expect(run.deliveryState).toBe('OUTCOME_UNKNOWN');
      // Exactly two attempts: the unknown part once, and nothing after it.
      expect(h.state.documents).toHaveLength(2);
      expect(h.state.deliveredMessage).toBeNull();
      const parts = await h.runs.parts(run.id);
      expect(parts.map((part) => part.deliveryState)).toEqual([
        'SUCCEEDED',
        'OUTCOME_UNKNOWN',
        'NOT_ATTEMPTED',
      ]);
      expect(parts.map((part) => part.telegramMessageId)).toEqual([21n, null, null]);
      const partial = h.state.recorded.find((event) => event.code === 'backup.delivery_partial');
      expect(partial?.message).toContain('1 of 3');
      expect(partial?.dedupeKey).toBe('backup.delivery_partial');
      // The verified archive stays: only the plaintext went.
      expect(h.state.everythingRemoved).toBe(false);
    });

    it('a refused FIRST part is a failed delivery, not a partial one', async () => {
      const h = harness();
      h.state.archiveBytes = 100 * MiB;
      h.state.documentOutcomes = [{ state: 'FAILED_DEFINITIVE', detail: 'HTTP 400' }];
      const run = await completed(h);
      expect(run.deliveryState).toBe('FAILED_DEFINITIVE');
      expect(h.state.documents).toHaveLength(1);
      const codes = h.state.recorded.map((event) => event.code);
      expect(codes).toContain('backup.delivery_failed');
      expect(codes).not.toContain('backup.delivery_partial');
    });

    it('a channel that THROWS mid-delivery is an unknown part, recorded and never resent', async () => {
      let calls = 0;
      const h = harness({
        delivery: {
          configured: true,
          async sendDocument() {
            calls += 1;
            if (calls === 2) throw new Error('socket hang up');
            return { state: 'SUCCEEDED', detail: null, messageId: calls };
          },
          async sendMessage() {
            return { state: 'SUCCEEDED', detail: null };
          },
        },
      });
      h.state.archiveBytes = 100 * MiB;
      const run = await completed(h);
      expect(calls).toBe(2);
      expect(run.deliveryState).toBe('OUTCOME_UNKNOWN');
      const parts = await h.runs.parts(run.id);
      expect(parts[1]?.deliveryState).toBe('OUTCOME_UNKNOWN');
    });

    it('a full delivery closes an open partial-delivery condition', async () => {
      const h = harness();
      h.state.open.add('backup.delivery_partial');
      h.state.archiveBytes = 50 * MiB;
      h.state.documentOutcomes = [
        { state: 'SUCCEEDED', detail: null, messageId: 1 },
        { state: 'SUCCEEDED', detail: null, messageId: 2 },
      ];
      await completed(h);
      const closing = h.state.recorded.find((event) => event.code === 'backup.delivery_partial_ok');
      expect(closing?.recoversCode).toBe('backup.delivery_partial');
    });
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

  it('L31: a one-file caption takes the operator’s Persian head, timed at COMPLETION, and keeps the technical block', async () => {
    const seen: { at: Date; startedAt: Date }[] = [];
    const h = harness({
      renderCaption: async (facts) => {
        seen.push({ at: facts.at, startedAt: facts.startedAt });
        return '💾 بکاپ — سرآغاز اپراتور';
      },
    });
    h.state.onDump = () => h.clock.advance(7 * 60_000);
    const run = await completed(h);
    const caption = h.state.deliveredDocument?.caption ?? '';
    expect(caption.startsWith('💾 بکاپ — سرآغاز اپراتور\n\n')).toBe(true);
    // The technical block is never traded for the head.
    expect(caption).toContain(run.id);
    expect(caption).toContain(CHECKSUM);
    // The head's time is when the backup COMPLETED; the next run counts from its start.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.startedAt.getTime()).toBe(NOW.getTime());
    expect(seen[0]!.at.getTime()).toBe(NOW.getTime() + 7 * 60_000);
  });

  it('L31: a head that would pass Telegram’s caption limit, or a renderer that throws, leaves the built-in caption', async () => {
    const long = harness({ renderCaption: async () => 'ب'.repeat(1_100) });
    await completed(long);
    expect(long.state.deliveredDocument?.caption).not.toContain('ببب');
    expect(long.state.deliveredDocument?.caption).toContain(CHECKSUM);
    const broken = harness({
      renderCaption: async () => {
        throw new Error('no template');
      },
    });
    const run = await completed(broken);
    expect(run.state).toBe('SUCCEEDED');
    expect(broken.state.deliveredDocument?.caption).toContain(CHECKSUM);
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
    // The part writes (E4) happen at DELIVER, before both; the ORDER of these two is the rule.
    expect(h.runs.writes.filter((write) => !write.startsWith('part'))).toEqual([
      'report:backup.run_ok',
      'finish:SUCCEEDED',
    ]);
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
      dailyTime: null,
      source: { enabled: 'ENVIRONMENT', interval: 'ENVIRONMENT', dailyTime: 'ENVIRONMENT' },
    });
  });

  it('takes each stored half over the environment, independently', async () => {
    await expect(policy({ enabled: true, intervalMinutes: null }).effective()).resolves.toEqual({
      enabled: true,
      intervalMs: DAY_MS,
      dailyTime: null,
      source: { enabled: 'SETTING', interval: 'ENVIRONMENT', dailyTime: 'ENVIRONMENT' },
    });
    await expect(policy({ enabled: null, intervalMinutes: 180 }).effective()).resolves.toEqual({
      enabled: false,
      intervalMs: 3 * 3_600_000,
      dailyTime: null,
      source: { enabled: 'ENVIRONMENT', interval: 'SETTING', dailyTime: 'ENVIRONMENT' },
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
    expect(effective.source).toEqual({
      enabled: 'ENVIRONMENT',
      interval: 'ENVIRONMENT',
      dailyTime: 'ENVIRONMENT',
    });
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

describe('Round 5B: phase durations, memory failures and the lease heartbeat', () => {
  it('records how long each stage took, from the clock the pipeline runs on', async () => {
    const h = harness();
    h.state.delays = { dump: 5_000, encrypt: 7_000, verify: 3_000, deliver: 2_000 };
    const run = await completed(h);

    expect(run.phaseDurationsMs).toEqual({
      DUMP: 5_000,
      CHECKSUM: 0,
      ENCRYPT: 7_000,
      VERIFY_RESTORE: 3_000,
      DELIVER: 2_000,
      CLEANUP: 0,
    });
  });

  it('times a failing stage up to its failure and leaves the stages after it absent', async () => {
    const h = harness();
    h.state.delays = { dump: 4_000, encrypt: 9_000, verify: 3_000, deliver: 2_000 };
    h.state.sealFails = true;
    const run = await completed(h);

    expect(run.state).toBe('FAILED');
    // "Not run" is an absent key, never a zero.
    expect(run.phaseDurationsMs).toEqual({ DUMP: 4_000, CHECKSUM: 0, ENCRYPT: 9_000 });
  });

  it('refuses a host without the memory to compress BEFORE the dump, and reports it once', async () => {
    const h = harness();
    h.state.preflightError = new NexaError({
      kind: 'INTERNAL',
      code: PLATFORM_ERROR_CODES.BACKUP_MEMORY_INSUFFICIENT,
      message: 'There is not enough free memory to compress the backup.',
    });
    const run = await completed(h);

    expect(run.state).toBe('FAILED');
    expect(run.failureCode).toBe('backup.memory_insufficient');
    // Nothing was dumped for nothing.
    expect(h.state.dumps).toBe(0);
    const failures = h.state.recorded.filter((event) => event.code === 'backup.run_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.severity).toBe('ERROR');
    expect(failures[0]?.context).toMatchObject({ failureCode: 'backup.memory_insufficient' });
  });

  it('records a tool killed by the kernel with its own code, once', async () => {
    const h = harness();
    h.state.sealError = new NexaError({
      kind: 'INTERNAL',
      code: PLATFORM_ERROR_CODES.BACKUP_TOOL_OOM_KILLED,
      message: '7-Zip was killed by the system.',
    });
    const run = await completed(h);

    expect(run.state).toBe('FAILED');
    expect(run.stage).toBe('ENCRYPT');
    expect(run.failureCode).toBe('backup.tool_oom_killed');
    expect(h.state.recorded.filter((event) => event.code === 'backup.run_failed')).toHaveLength(1);
  });

  describe('the scheduler after a memory failure', () => {
    function schedulerFor(h: Harness, dailyTime: string | null = null): BackupScheduler {
      return new BackupScheduler({
        service: h.service,
        runs: h.runs,
        quiesced: async () => false,
        clock: h.clock,
        schedule: async () => ({ enabled: true, intervalMs: DAY_MS, dailyTime }),
        tickIntervalMs: TICK_MS,
        runHeartbeatAt: () => null,
        runStaleAfterMs: RUN_STALE_MS,
        logger: { info() {}, warn() {}, error() {} },
      });
    }
    const oom = () =>
      new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_TOOL_OOM_KILLED,
        message: 'killed',
      });

    it('does not start another run for an hour, then does', async () => {
      const h = harness();
      const scheduler = schedulerFor(h);
      h.state.sealError = oom();
      await scheduler.tick();
      expect(h.runs.rows.size).toBe(1);

      // Five minutes later, thirty, and fifty-nine: held back.
      for (const minutes of [5, 25, 29]) {
        h.clock.advance(minutes * 60_000);
        await scheduler.tick();
      }
      expect(h.runs.rows.size).toBe(1);

      // Past the hour (the failure finished at t=0): tried again.
      h.clock.advance(2 * 60_000);
      h.state.sealError = null;
      await scheduler.tick();
      expect(h.runs.rows.size).toBe(2);
    });

    it('holds back after a refusal for memory for an hour, and after an ordinary failure for the 30-minute backoff only', async () => {
      const refused = harness();
      refused.state.preflightError = new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_MEMORY_INSUFFICIENT,
        message: 'no memory',
      });
      const a = schedulerFor(refused);
      await a.tick();
      refused.clock.advance(10 * 60_000);
      await a.tick();
      expect(refused.runs.rows.size).toBe(1);

      // Round 8 (B4): an ordinary failure no longer retries on the next tick either — it
      // waits the first backoff step, thirty minutes, and not the memory failure's hour.
      const ordinary = harness();
      ordinary.state.sealError = new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_TOOL_FAILED,
        message: 'exited 2',
      });
      const b = schedulerFor(ordinary);
      await b.tick();
      ordinary.clock.advance(10 * 60_000);
      await b.tick();
      expect(ordinary.runs.rows.size).toBe(1);
      ordinary.clock.advance(21 * 60_000);
      await b.tick();
      expect(ordinary.runs.rows.size).toBe(2);
      // The memory refusal at the same 31 minutes is still held.
      refused.clock.advance(21 * 60_000);
      await a.tick();
      expect(refused.runs.rows.size).toBe(1);
    });

    it('does not hold back a MANUAL run', async () => {
      const h = harness();
      const scheduler = schedulerFor(h);
      h.state.sealError = oom();
      await scheduler.tick();
      h.state.sealError = null;
      const manual = await completed(h, 'MANUAL');
      expect(manual.state).toBe('SUCCEEDED');
    });
  });

  describe('the once-a-day time', () => {
    // 2026-03-01T09:00Z is 12:30 in Tehran (UTC+3:30), so today's 04:00 was at 00:30Z.
    it('computes the latest slot in the installation zone', () => {
      expect(latestDailySlot(new Date('2026-03-01T09:00:00Z'), '04:00').toISOString()).toBe(
        '2026-03-01T00:30:00.000Z',
      );
      // Before today's 04:00 Tehran (03:30 local): the slot is yesterday's.
      expect(latestDailySlot(new Date('2026-03-01T00:00:00Z'), '04:00').toISOString()).toBe(
        '2026-02-28T00:30:00.000Z',
      );
    });

    it('is due once the day passes the time and nothing verified has run since', async () => {
      const due = harness();
      due.runs.lastSuccess = new Date('2026-02-28T20:00:00Z'); // 23:30 Tehran, before today's slot
      const dueScheduler = new BackupScheduler({
        service: due.service,
        runs: due.runs,
        quiesced: async () => false,
        clock: due.clock,
        schedule: async () => ({ enabled: true, intervalMs: DAY_MS, dailyTime: '04:00' }),
        tickIntervalMs: TICK_MS,
        runHeartbeatAt: () => null,
        runStaleAfterMs: RUN_STALE_MS,
        logger: { info() {}, warn() {}, error() {} },
      });
      await dueScheduler.tick();
      expect(due.runs.rows.size).toBe(1);

      const done = harness();
      done.runs.lastSuccess = new Date('2026-03-01T01:00:00Z'); // 04:30 Tehran, after the slot
      const doneScheduler = new BackupScheduler({
        service: done.service,
        runs: done.runs,
        quiesced: async () => false,
        clock: done.clock,
        schedule: async () => ({ enabled: true, intervalMs: DAY_MS, dailyTime: '04:00' }),
        tickIntervalMs: TICK_MS,
        runHeartbeatAt: () => null,
        runStaleAfterMs: RUN_STALE_MS,
        logger: { info() {}, warn() {}, error() {} },
      });
      await doneScheduler.tick();
      expect(done.runs.rows.size).toBe(0);
    });

    it('a stored interval beats the environment default time; a stored time beats both', async () => {
      const settings = (stored: {
        enabled: boolean | null;
        intervalMinutes: number | null;
        dailyTime: string | null;
      }) =>
        new BackupSchedulePolicy({
          settings: { read: async () => stored },
          scope: () => ({ tenantId: 't1' as never, botInstanceId: null }),
          environment: { enabled: true, intervalMs: DAY_MS, dailyTime: '04:00' },
        }).effective();

      // A new install: nothing stored, the template's 04:00 governs.
      expect(
        await settings({ enabled: null, intervalMinutes: null, dailyTime: null }),
      ).toMatchObject({
        dailyTime: '04:00',
        intervalMs: DAY_MS,
        source: { dailyTime: 'ENVIRONMENT' },
      });
      // An owner who stored every 6 hours keeps it: the environment's time does not override.
      expect(
        await settings({ enabled: null, intervalMinutes: 360, dailyTime: null }),
      ).toMatchObject({ dailyTime: null, intervalMs: 360 * 60_000 });
      // A time the owner stored wins over everything.
      expect(
        await settings({ enabled: null, intervalMinutes: 360, dailyTime: '02:15' }),
      ).toMatchObject({ dailyTime: '02:15', source: { dailyTime: 'SETTING' } });
    });

    it('leaves an existing installation alone: no environment time, no stored one', async () => {
      const policy = new BackupSchedulePolicy({
        settings: { read: async () => ({ enabled: null, intervalMinutes: null, dailyTime: null }) },
        scope: () => ({ tenantId: 't1' as never, botInstanceId: null }),
        environment: { enabled: true, intervalMs: 6 * 3_600_000, dailyTime: '' },
      });
      expect(await policy.effective()).toMatchObject({
        dailyTime: null,
        intervalMs: 6 * 3_600_000,
      });
    });
  });

  describe('the lease heartbeat', () => {
    const warnings: string[] = [];
    const logger = {
      info() {},
      warn(_context: Record<string, unknown>, message: string) {
        warnings.push(message);
      },
      error() {},
    };

    it('survives a single transient failure without reporting it', async () => {
      warnings.length = 0;
      const h = harness({
        heartbeat: { intervalMs: 20, timeoutMs: 1_000, retryMs: 5 },
        logger,
      });
      h.state.dumpRealMs = 150;
      h.runs.heartbeatScript = async (call) => {
        if (call === 1) throw new Error('the database is busy');
      };
      const run = await completed(h);

      expect(run.state).toBe('SUCCEEDED');
      expect(h.runs.heartbeatCalls).toBeGreaterThanOrEqual(2);
      expect(warnings).not.toContain('backup lease heartbeat failed');
    });

    it('reports only after three consecutive failures, and still does not fail the run', async () => {
      warnings.length = 0;
      const h = harness({
        heartbeat: { intervalMs: 15, timeoutMs: 1_000, retryMs: 5 },
        logger,
      });
      h.state.dumpRealMs = 250;
      h.runs.heartbeatScript = async () => {
        throw new Error('the database is gone');
      };
      const run = await completed(h);

      expect(run.state).toBe('SUCCEEDED');
      expect(warnings).toContain('backup lease heartbeat failed');
    });

    it('gives each attempt its own timeout, so one hung statement does not stop the beat', async () => {
      warnings.length = 0;
      const h = harness({
        heartbeat: { intervalMs: 20, timeoutMs: 15, retryMs: 5 },
        logger,
      });
      h.state.dumpRealMs = 250;
      h.runs.heartbeatScript = async (call) => {
        // The first statement never answers.
        if (call === 1) await new Promise(() => undefined);
      };
      const run = await completed(h);

      expect(run.state).toBe('SUCCEEDED');
      expect(h.runs.heartbeatCalls).toBeGreaterThanOrEqual(3);
      expect(warnings).not.toContain('backup lease heartbeat failed');
    });
  });
});

describe('Round 8 B4: no retry storm after a failed scheduled run', () => {
  const MINUTE = 60_000;

  /** Ticks every five minutes (the production default) for `forMs`, returning run offsets. */
  async function storm(
    h: Harness,
    scheduler: BackupScheduler,
    forMs: number,
  ): Promise<readonly number[]> {
    const start = h.clock.now().getTime();
    for (let at = 0; at < forMs; at += TICK_MS) {
      await scheduler.tick();
      h.clock.advance(TICK_MS);
    }
    return [...h.runs.rows.values()].map((row) => row.startedAt.getTime() - start);
  }

  function schedulerFor(h: Harness, dailyTime: string | null): BackupScheduler {
    return new BackupScheduler({
      service: h.service,
      runs: h.runs,
      quiesced: async () => false,
      clock: h.clock,
      schedule: async () => ({ enabled: true, intervalMs: DAY_MS, dailyTime }),
      tickIntervalMs: TICK_MS,
      runHeartbeatAt: () => null,
      runStaleAfterMs: RUN_STALE_MS,
      logger: { info() {}, warn() {}, error() {} },
    });
  }

  it('backs off 30 m, 1 h, 2 h, then waits for the next interval slot — never every tick', async () => {
    const h = harness();
    h.state.dumpFails = true;
    // Last verified backup 25 hours ago on a 24-hour interval: due now, and the next slot
    // after this one is 23 hours away.
    h.runs.lastSuccess = new Date(NOW.getTime() - 25 * 3_600_000);
    const scheduler = schedulerFor(h, null);

    const offsets = await storm(h, scheduler, 23 * 3_600_000);
    expect(offsets).toEqual([0, 30 * MINUTE, 90 * MINUTE, 210 * MINUTE]);
    for (let i = 1; i < offsets.length; i += 1) {
      expect((offsets[i] ?? 0) - (offsets[i - 1] ?? 0)).toBeGreaterThanOrEqual(30 * MINUTE);
    }

    // The next slot (last success + 48 h) is the next attempt, and only one.
    await scheduler.tick();
    expect(h.runs.rows.size).toBe(5);
    await storm(h, scheduler, 6 * 3_600_000);
    expect(h.runs.rows.size).toBe(5);
  });

  it('with a daily time, an exhausted chain waits for tomorrow’s slot', async () => {
    // 09:00Z is 12:30 Tehran; today's 04:00 slot was 00:30Z, tomorrow's is 15 h 30 m away.
    const h = harness();
    h.state.dumpFails = true;
    h.runs.lastSuccess = new Date('2026-02-28T01:00:00Z');
    const scheduler = schedulerFor(h, '04:00');

    const offsets = await storm(h, scheduler, 15 * 3_600_000 + 30 * MINUTE);
    expect(offsets).toEqual([0, 30 * MINUTE, 90 * MINUTE, 210 * MINUTE]);
    // 15:30 after the start is exactly tomorrow's slot.
    await scheduler.tick();
    expect(h.runs.rows.size).toBe(5);
  });

  it('a failure that is not the scheduler’s does not hold a scheduled run back', async () => {
    const h = harness();
    h.state.dumpFails = true;
    await completed(h, 'MANUAL');
    h.state.dumpFails = false;
    const scheduler = schedulerFor(h, null);
    h.clock.advance(TICK_MS);
    await scheduler.tick();
    expect([...h.runs.rows.values()].map((row) => row.state)).toEqual(['FAILED', 'SUCCEEDED']);
  });

  it('logs a hold once per failure, not once per tick', async () => {
    const h = harness();
    h.state.dumpFails = true;
    const lines: string[] = [];
    const scheduler = new BackupScheduler({
      service: h.service,
      runs: h.runs,
      quiesced: async () => false,
      clock: h.clock,
      schedule: async () => ({ enabled: true, intervalMs: DAY_MS }),
      tickIntervalMs: TICK_MS,
      runHeartbeatAt: () => null,
      runStaleAfterMs: RUN_STALE_MS,
      logger: { info: (_c, m) => void lines.push(m), warn() {}, error() {} },
    });
    await storm(h, scheduler, 25 * MINUTE);
    expect(lines.filter((line) => line.includes('held back'))).toHaveLength(1);
  });
});

describe('Round 8 B1: a run always cleans up after itself', () => {
  it('removes the whole workspace in `finally` when the failure path itself throws', async () => {
    // The `catch` begins with a log line; a logger that throws there used to skip the
    // workspace removal entirely and leave a full dump behind.
    const h = harness({
      logger: {
        info() {},
        warn() {},
        error(_context, message) {
          if (message === 'backup run failed') throw new Error('the log transport is down');
        },
      },
    });
    h.state.dumpFails = true;
    await expect(h.service.run('SCHEDULED')).rejects.toThrow('the log transport is down');
    expect(h.state.everythingRemoved).toBe(true);
  });

  it('keeps a VERIFIED archive when the run fails after verification, e.g. finish throwing', async () => {
    // A `finish(SUCCEEDED)` whose answer was lost after it committed reaches the `catch`
    // with a SUCCEEDED row; removing the archive there removed the newest good backup.
    const h = harness();
    const finish = h.runs.finish.bind(h.runs);
    let thrown = false;
    h.runs.finish = async (input) => {
      if (input.state === 'SUCCEEDED' && !thrown) {
        thrown = true;
        await finish(input);
        throw new Error('the connection died after the commit');
      }
      await finish(input);
    };
    await h.service.run('SCHEDULED');
    expect(h.state.plaintextRemoved).toBe(true);
    expect(h.state.everythingRemoved).toBe(false);

    // The control: a failure BEFORE verification still removes everything.
    const before = harness();
    before.state.sealFails = true;
    await before.service.run('SCHEDULED');
    expect(before.state.everythingRemoved).toBe(true);
  });

  it('does not remove a SUCCEEDED run’s archive in `finally`', async () => {
    const h = harness();
    const run = await completed(h, 'SCHEDULED');
    expect(run.state).toBe('SUCCEEDED');
    expect(h.state.plaintextRemoved).toBe(true);
    expect(h.state.everythingRemoved).toBe(false);
  });

  it('on shutdown, removes the in-flight run’s plaintext and never its archive', async () => {
    const h = harness();
    let discarded: Promise<readonly string[]> | null = null;
    h.state.onDump = () => {
      discarded = h.service.discardInFlightPlaintext();
    };
    const run = await completed(h, 'SCHEDULED');
    expect(discarded).not.toBeNull();
    expect(await discarded).toEqual([]);
    expect(h.state.plaintextRemoved).toBe(true);
    // The run reached its end anyway: its verified archive is kept.
    expect(run.state).toBe('SUCCEEDED');
    expect(h.state.everythingRemoved).toBe(false);

    // And once no run is in flight, a shutdown touches nothing.
    h.state.plaintextRemoved = false;
    expect(await h.service.discardInFlightPlaintext()).toEqual([]);
    expect(h.state.plaintextRemoved).toBe(false);
  });

  it('sweeps killed runs once it holds the lock, before the dump, never its own directory', async () => {
    const calls: { exceptId: string; dumpsSoFar: number }[] = [];
    let h: Harness | null = null;
    h = harness({
      orphanSweep: {
        async sweep(input) {
          calls.push({ exceptId: input.exceptId, dumpsSoFar: h?.state.dumps ?? -1 });
          return { directories: [], files: [], survived: ['/w/old/dump.pgcustom'] };
        },
      },
    });
    const run = await completed(h, 'SCHEDULED');
    expect(calls).toEqual([{ exceptId: run.id, dumpsSoFar: 0 }]);
    // What it could not remove is the cleanup condition, under its one key.
    const cleanup = h.state.recorded.filter((event) => event.code === 'backup.cleanup_failed');
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]?.dedupeKey).toBe('backup.cleanup');
    expect(run.state).toBe('SUCCEEDED');
  });

  it('a BUSY caller does not sweep, and a sweep that throws does not fail the run', async () => {
    let swept = 0;
    const h = harness({
      orphanSweep: {
        async sweep() {
          swept += 1;
          throw new Error('the backup root is unreadable');
        },
      },
    });
    const run = await completed(h, 'SCHEDULED');
    expect(run.state).toBe('SUCCEEDED');
    expect(swept).toBe(1);
    h.runs.busyWith = run;
    const busy = await h.service.run('SCHEDULED');
    expect(busy.kind).toBe('BUSY');
    expect(swept).toBe(1);
  });
});
