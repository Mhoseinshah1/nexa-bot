import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackupDeliveryReason, BackupDeliveryState } from '@nexa/contracts';
import {
  deliverPartsInOrder,
  PART_DEADLINE_DETAIL,
  type DeliverablePart,
  type PartOutcome,
} from '../../apps/api/src/modules/platform/backup/application/backup-part-delivery';
import {
  BackupRedelivery,
  type BackupRedeliveryDeps,
} from '../../apps/api/src/modules/platform/backup/application/backup-redelivery';
import {
  BACKUP_PART_DELIVERY_ATTEMPTS,
  partMaySendAgain,
} from '../../apps/api/src/modules/platform/backup/application/backup-retry-policy';
import type {
  BackupDeliveryChannel,
  BackupRunPartRow,
  BackupRunRow,
  DeliveryAttempt,
} from '../../apps/api/src/modules/platform/backup/application/ports';
import { TelegramBackupDelivery } from '../../apps/api/src/modules/platform/backup/infrastructure/telegram-backup-delivery';

/**
 * NEXA-BACKUP-DELIVERY: the parts of an archive reach Telegram IN ORDER, a part whose answer
 * was lost is sent again a bounded number of times (the owner's rule: sent twice is
 * acceptable, lost is not — Telegram gives a bot no way to check), every part's message id
 * is recorded, and a finished run's undelivered parts can be re-delivered — never a run kept
 * on the server by design.
 */

const NOW = new Date('2026-11-13T08:00:00Z');

class FakeClock {
  constructor(private ms = NOW.getTime()) {}
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

const quiet = { warn() {}, info() {} };

function parts(count: number): DeliverablePart[] {
  return Array.from({ length: count }, (_, index) => ({
    partNumber: index + 1,
    start: index * 10,
    end: index * 10 + 10,
    filename: `a.7z.${String(index + 1).padStart(3, '0')}`,
    attemptsSoFar: 0,
  }));
}

/** A channel answering from a script, then SUCCEEDED with a fresh message id. */
function scripted(script: DeliveryAttempt[]) {
  const sent: { filename: string; caption: string; range: unknown }[] = [];
  let id = 100;
  const channel: Pick<BackupDeliveryChannel, 'sendDocument'> = {
    async sendDocument(input) {
      sent.push({ filename: input.filename, caption: input.caption, range: input.range });
      return script.shift() ?? { state: 'SUCCEEDED', detail: null, messageId: ++id };
    },
  };
  return { channel, sent };
}

async function pass(
  channel: Pick<BackupDeliveryChannel, 'sendDocument'>,
  count: number,
  options: { deadline?: Date | null; clock?: FakeClock } = {},
) {
  const clock = options.clock ?? new FakeClock();
  const recorded: PartOutcome[] = [];
  const sleeps: number[] = [];
  const result = await deliverPartsInOrder(
    {
      backupId: 'run-1',
      channel,
      archivePath: '/w/archive.7z',
      whole: count === 1,
      parts: parts(count),
      caption: async (part, resend) => `part ${String(part.partNumber)}${resend ? ' RESEND' : ''}`,
      record: async (outcome) => {
        recorded.push(outcome);
      },
      ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    },
    {
      clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.advance(ms);
      },
      logger: quiet,
    },
  );
  return { result, recorded, sleeps };
}

describe('delivering an archive part by part (NEXA-BACKUP-DELIVERY)', () => {
  it('delivers all five parts of a 5-part archive in order, recording each message id', async () => {
    const { channel, sent } = scripted([]);
    const { result, recorded } = await pass(channel, 5);
    expect(result).toEqual({ delivered: 5, stopped: null });
    expect(sent.map((one) => one.filename)).toEqual([
      'a.7z.001',
      'a.7z.002',
      'a.7z.003',
      'a.7z.004',
      'a.7z.005',
    ]);
    expect(sent.map((one) => one.range)).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 20 },
      { start: 20, end: 30 },
      { start: 30, end: 40 },
      { start: 40, end: 50 },
    ]);
    expect(recorded.map((one) => [one.partNumber, one.state, one.messageId, one.attempts])).toEqual(
      [
        [1, 'SUCCEEDED', 101, 1],
        [2, 'SUCCEEDED', 102, 1],
        [3, 'SUCCEEDED', 103, 1],
        [4, 'SUCCEEDED', 104, 1],
        [5, 'SUCCEEDED', 105, 1],
      ],
    );
  });

  it('sends an unknown part again after the backoff, says so in the caption, and goes on in order', async () => {
    const { channel, sent } = scripted([
      { state: 'SUCCEEDED', detail: null, messageId: 1 },
      {
        state: 'OUTCOME_UNKNOWN',
        reason: 'CONNECTION_RESET',
        detail: 'read ECONNRESET (ECONNRESET)',
      },
    ]);
    const { result, recorded, sleeps } = await pass(channel, 3);
    expect(result.stopped).toBeNull();
    expect(sent.map((one) => one.filename)).toEqual([
      'a.7z.001',
      'a.7z.002',
      'a.7z.002',
      'a.7z.003',
    ]);
    expect(sent[1]?.caption).toBe('part 2');
    expect(sent[2]?.caption).toBe('part 2 RESEND');
    expect(sleeps).toEqual([30_000]);
    // The unknown answer was on the row (with its real reason) before the resend replaced it.
    expect(recorded[1]).toMatchObject({
      partNumber: 2,
      state: 'OUTCOME_UNKNOWN',
      reason: 'CONNECTION_RESET',
      attempts: 1,
    });
    expect(recorded[2]).toMatchObject({ partNumber: 2, state: 'SUCCEEDED', attempts: 2 });
    expect(recorded[2]?.messageId).not.toBeNull();
  });

  it('stops at a part that stays unknown after the bounded sends; the rest are never sent', async () => {
    const unknown: DeliveryAttempt = {
      state: 'OUTCOME_UNKNOWN',
      reason: 'DEADLINE_EXCEEDED',
      detail: 'no answer',
    };
    const { channel, sent } = scripted([
      { state: 'SUCCEEDED', detail: null, messageId: 1 },
      unknown,
      unknown,
      unknown,
    ]);
    const { result, sleeps } = await pass(channel, 5);
    expect(BACKUP_PART_DELIVERY_ATTEMPTS).toBe(3);
    expect(sent).toHaveLength(1 + BACKUP_PART_DELIVERY_ATTEMPTS);
    expect(result).toEqual({
      delivered: 1,
      stopped: {
        partNumber: 2,
        state: 'OUTCOME_UNKNOWN',
        detail: 'no answer',
        reason: 'DEADLINE_EXCEEDED',
      },
    });
    expect(sleeps).toEqual([30_000, 120_000]);
  });

  it('never resends a refusal; resends a connection that was never made', async () => {
    const refused = scripted([
      {
        state: 'FAILED_DEFINITIVE',
        reason: 'TELEGRAM_REFUSED',
        detail: 'HTTP 400: chat not found',
      },
    ]);
    const first = await pass(refused.channel, 2);
    expect(refused.sent).toHaveLength(1);
    expect(first.result.stopped).toMatchObject({
      state: 'FAILED_DEFINITIVE',
      reason: 'TELEGRAM_REFUSED',
    });

    const unreachable = scripted([
      { state: 'FAILED_DEFINITIVE', reason: 'CONNECT_FAILED', detail: 'connect ECONNREFUSED' },
    ]);
    const second = await pass(unreachable.channel, 1);
    expect(unreachable.sent).toHaveLength(2);
    expect(second.result).toEqual({ delivered: 1, stopped: null });
  });

  it('honours a 429 retry_after, and gives the part up when it asks for longer than the cap', async () => {
    const limited = scripted([
      { state: 'OUTCOME_UNKNOWN', reason: 'RATE_LIMITED', detail: '429', retryAfterMs: 90_000 },
    ]);
    const short = await pass(limited.channel, 1);
    expect(short.sleeps).toEqual([90_000]);
    expect(short.result.stopped).toBeNull();

    const long = scripted([
      { state: 'OUTCOME_UNKNOWN', reason: 'RATE_LIMITED', detail: '429', retryAfterMs: 3_600_000 },
    ]);
    const capped = await pass(long.channel, 1);
    expect(long.sent).toHaveLength(1);
    expect(capped.result.stopped).toMatchObject({ reason: 'RATE_LIMITED' });
  });

  it('starts no resend after its deadline', async () => {
    const clock = new FakeClock();
    const { channel, sent } = scripted([
      { state: 'OUTCOME_UNKNOWN', reason: 'CONNECTION_RESET', detail: 'reset' },
    ]);
    const { result } = await pass(channel, 1, {
      clock,
      deadline: new Date(NOW.getTime() + 10_000),
    });
    expect(sent).toHaveLength(1);
    expect(result.stopped).toMatchObject({ state: 'OUTCOME_UNKNOWN' });
  });

  // Codex review of #479: the deadline bounds every SEND, not only a resend's pause.
  it('starts no part after its deadline, even when every earlier part succeeded', async () => {
    const clock = new FakeClock();
    const sent: string[] = [];
    // Each upload takes 20 minutes and succeeds; the window is 30 minutes.
    const slow: Pick<BackupDeliveryChannel, 'sendDocument'> = {
      async sendDocument(input) {
        sent.push(input.filename);
        clock.advance(20 * 60_000);
        return { state: 'SUCCEEDED', detail: null, messageId: sent.length };
      },
    };
    const { result, recorded } = await pass(slow, 3, {
      clock,
      deadline: new Date(NOW.getTime() + 30 * 60_000),
    });
    // Part 1 (0→20 min) and part 2 (20→40 min) started inside the window; part 3 would start
    // at 40 min, past it, and is never sent.
    expect(sent).toEqual(['a.7z.001', 'a.7z.002']);
    expect(result).toEqual({
      delivered: 2,
      stopped: {
        partNumber: 3,
        state: 'NOT_ATTEMPTED',
        detail: PART_DEADLINE_DETAIL,
        reason: null,
        deadlinePassed: true,
      },
    });
    // Recorded, so the compaction card says why part 3 is not in the group.
    expect(recorded.at(-1)).toMatchObject({
      partNumber: 3,
      state: 'NOT_ATTEMPTED',
      detail: PART_DEADLINE_DETAIL,
      attempts: 0,
    });
  });

  it('the run’s own pass (no deadline) sends every part however long the uploads take', async () => {
    const clock = new FakeClock();
    let sends = 0;
    const slow: Pick<BackupDeliveryChannel, 'sendDocument'> = {
      async sendDocument() {
        sends += 1;
        clock.advance(60 * 60_000);
        return { state: 'SUCCEEDED', detail: null, messageId: sends };
      },
    };
    const { result } = await pass(slow, 5, { clock, deadline: null });
    expect(result).toEqual({ delivered: 5, stopped: null });
  });

  it('the rule itself: unknown and never-connected may go again, a refusal may not', () => {
    expect(partMaySendAgain({ state: 'OUTCOME_UNKNOWN' })).toBe(true);
    expect(partMaySendAgain({ state: 'FAILED_DEFINITIVE', reason: 'CONNECT_FAILED' })).toBe(true);
    expect(partMaySendAgain({ state: 'FAILED_DEFINITIVE', reason: 'TELEGRAM_REFUSED' })).toBe(
      false,
    );
    expect(partMaySendAgain({ state: 'FAILED_DEFINITIVE', reason: 'ARCHIVE_UNREADABLE' })).toBe(
      false,
    );
    expect(partMaySendAgain({ state: 'SUCCEEDED' })).toBe(false);
  });

  /*
   * End to end through the REAL transport: Telegram's socket drops in the middle of the
   * first upload of part 1 (the owner's «fetch failed»), the part is recorded
   * OUTCOME_UNKNOWN with the real cause, sent again, and arrives with its message id.
   */
  describe('through the real transport', () => {
    let server: Server;
    let dir: string;
    let requests = 0;

    beforeEach(async () => {
      requests = 0;
      dir = await mkdtemp(join(tmpdir(), 'nexa-redeliver-'));
      server = createServer((request, response) => {
        requests += 1;
        if (requests === 1) {
          let seen = 0;
          request.on('data', (chunk: Buffer) => {
            seen += chunk.length;
            if (seen > 128 * 1024) request.socket.destroy();
          });
          return;
        }
        request.resume();
        request.on('end', () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, result: { message_id: 500 + requests } }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    });

    it('a socket reset mid-upload is OUTCOME_UNKNOWN with its cause, then a resend that arrives', async () => {
      const archivePath = join(dir, 'archive.7z');
      await writeFile(archivePath, Buffer.alloc(4 * 1024 * 1024, 3));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      const channel = new TelegramBackupDelivery({
        apiBaseUrl: `http://127.0.0.1:${String(address.port)}`,
        token: '123:TEST',
        chatId: '-100',
        timeoutMs: 10_000,
      });
      const recorded: PartOutcome[] = [];
      const clock = new FakeClock();
      const result = await deliverPartsInOrder(
        {
          backupId: 'run-1',
          channel,
          archivePath,
          whole: false,
          parts: [
            {
              partNumber: 1,
              start: 0,
              end: 2 * 1024 * 1024,
              filename: 'a.7z.001',
              attemptsSoFar: 0,
            },
            {
              partNumber: 2,
              start: 2 * 1024 * 1024,
              end: 4 * 1024 * 1024,
              filename: 'a.7z.002',
              attemptsSoFar: 0,
            },
          ],
          caption: async () => 'c',
          record: async (outcome) => {
            recorded.push(outcome);
          },
        },
        { clock, sleep: async (ms) => clock.advance(ms), logger: quiet },
      );
      expect(result).toEqual({ delivered: 2, stopped: null });
      expect(recorded[0]).toMatchObject({
        partNumber: 1,
        state: 'OUTCOME_UNKNOWN',
        reason: 'CONNECTION_RESET',
        attempts: 1,
      });
      expect(recorded[0]?.detail).toMatch(/ECONNRESET|EPIPE/);
      expect(recorded.slice(1).map((one) => [one.partNumber, one.state, one.messageId])).toEqual([
        [1, 'SUCCEEDED', 502],
        [2, 'SUCCEEDED', 503],
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// The re-delivery of a finished run
// ---------------------------------------------------------------------------

function runRow(overrides: Partial<BackupRunRow> = {}): BackupRunRow {
  return {
    id: '0193ab12-0000-7000-8000-000000000001',
    trigger: 'MANUAL',
    state: 'SUCCEEDED',
    stage: 'CLEANUP',
    startedAt: NOW,
    finishedAt: NOW,
    leaseOwner: 'w',
    leaseHeartbeatAt: NOW,
    dumpBytes: 100n,
    archiveBytes: 50n,
    checksum: 'c'.repeat(64),
    verifiedAt: NOW,
    deliveryState: 'OUTCOME_UNKNOWN',
    deliveryAttemptedAt: NOW,
    deliveryDetail: 'x',
    deliveryReason: 'CONNECTION_RESET',
    failureCode: null,
    failureMessage: null,
    cleanupOk: true,
    cleanupDetail: null,
    archivePrunedAt: null,
    archiveFormat: 'SEVEN_ZIP',
    partCount: 5,
    archiveSealId: null,
    summaryDeliveryState: null,
    phaseDurationsMs: null,
    subjectTenantId: null,
    ...overrides,
  };
}

/** Five parts: `delivered` carry a message id; the first other one was sent 3 times, unknown. */
function partRows(delivered: readonly number[]): BackupRunPartRow[] {
  const firstMissing = [1, 2, 3, 4, 5].find((n) => !delivered.includes(n));
  return [1, 2, 3, 4, 5].map((partNumber) => ({
    backupId: runRow().id,
    partNumber,
    filename: `a.7z.${String(partNumber).padStart(3, '0')}`,
    bytes: 10n,
    sha256: String(partNumber).repeat(64),
    deliveryState: delivered.includes(partNumber)
      ? 'SUCCEEDED'
      : partNumber === firstMissing
        ? 'OUTCOME_UNKNOWN'
        : 'NOT_ATTEMPTED',
    deliveryAttemptedAt: null,
    telegramMessageId: delivered.includes(partNumber) ? BigInt(partNumber) : null,
    deliveryDetail: null,
    rangeStart: BigInt((partNumber - 1) * 10),
    deliveryReason: null,
    deliveryAttempts: delivered.includes(partNumber) ? 1 : partNumber === firstMissing ? 3 : 0,
  }));
}

function redelivery(input: {
  run: BackupRunRow;
  parts: BackupRunPartRow[];
  script?: DeliveryAttempt[];
  leaseHeld?: boolean;
  archiveExists?: boolean;
}) {
  const store = {
    run: input.run,
    parts: input.parts,
    owner: input.leaseHeld === true ? 'someone-else' : (null as string | null),
    finished: [] as Parameters<BackupRedeliveryDeps['runs']['finishRedelivery']>[0][],
    released: 0,
  };
  const reports: [BackupDeliveryState, number, number][] = [];
  const summaries: number[] = [];
  const { channel, sent } = scripted(input.script ?? []);
  const clock = new FakeClock();
  const deps: BackupRedeliveryDeps = {
    runs: {
      byId: async () => store.run,
      parts: async () => store.parts.map((part) => ({ ...part })),
      claimRedelivery: async ({ owner }) => {
        if (store.owner !== null) return false;
        store.owner = owner;
        return true;
      },
      extendRedelivery: async ({ owner }) => store.owner === owner,
      recordRedeliveredPart: async (outcome) => {
        if (store.owner !== outcome.owner) return;
        store.parts = store.parts.map((part) =>
          part.partNumber === outcome.partNumber && part.telegramMessageId === null
            ? {
                ...part,
                deliveryState: outcome.state,
                telegramMessageId:
                  outcome.state === 'SUCCEEDED' && outcome.messageId !== null
                    ? BigInt(outcome.messageId)
                    : null,
                deliveryReason: outcome.reason,
                deliveryAttempts: outcome.attempts,
              }
            : part,
        );
      },
      releaseRedelivery: async () => {
        store.released += 1;
        store.owner = null;
      },
      finishRedelivery: async (finish) => {
        store.finished.push(finish);
        store.owner = null;
        store.run = {
          ...store.run,
          deliveryState: finish.deliveryState,
          deliveryReason: finish.deliveryReason,
        };
      },
    },
    pipeline: {
      resolveDelivery: async () => ({
        kind: 'READY',
        destination: 'OPS_GROUP_TOPIC',
        channel: { ...channel, sendMessage: async () => ({ state: 'SUCCEEDED', detail: null }) },
      }),
      sendSummary: async (_channel, summary) => {
        summaries.push(summary.parts.length);
        return {
          detail: `All ${String(summary.parts.length)} parts delivered.`,
          summaryState: 'SUCCEEDED',
        };
      },
      reportDelivery: async (_id, state, delivered, count) => {
        reports.push([state, delivered, count]);
      },
    },
    archivePathOf: () => '/w/archive.7z',
    archiveExists: async () => input.archiveExists ?? true,
    clock,
    sleep: async (ms) => clock.advance(ms),
    logger: quiet,
    owner: 'worker-1',
    leaseMs: 60_000,
  };
  return { service: new BackupRedelivery(deps), store, sent, reports, summaries };
}

describe('re-delivering the parts that did not arrive (NEXA-BACKUP-DELIVERY)', () => {
  it('sends only the parts without a message id, in order, from their ranges, then the summary', async () => {
    const h = redelivery({ run: runRow(), parts: partRows([1, 2]) });
    await expect(h.service.redeliver(runRow().id)).resolves.toEqual({ kind: 'DELIVERED' });
    expect(h.sent.map((one) => one.filename)).toEqual(['a.7z.003', 'a.7z.004', 'a.7z.005']);
    expect(h.sent.map((one) => one.range)).toEqual([
      { start: 20, end: 30 },
      { start: 30, end: 40 },
      { start: 40, end: 50 },
    ]);
    // Part 3 had been sent before (its answer lost): its caption says this is a resend.
    expect(h.sent[0]?.caption).toContain('ارسال دوباره');
    expect(h.store.parts.every((part) => part.telegramMessageId !== null)).toBe(true);
    expect(h.summaries).toEqual([5]);
    expect(h.store.finished.at(-1)).toMatchObject({
      deliveryState: 'SUCCEEDED',
      deliveryReason: null,
    });
    expect(h.reports).toEqual([['SUCCEEDED', 5, 5]]);
    expect(h.store.owner).toBeNull();
  });

  it('never sends a backup kept on the server by design (a Mirza import backup)', async () => {
    const h = redelivery({
      run: runRow({ deliveryState: 'NOT_ATTEMPTED', deliveryReason: 'LOCAL_ONLY_IMPORT' }),
      parts: partRows([]),
    });
    await expect(h.service.redeliver(runRow().id)).resolves.toEqual({
      kind: 'REFUSED',
      why: 'LOCAL_ONLY',
    });
    expect(h.sent).toHaveLength(0);
    expect(h.store.owner).toBeNull();
  });

  it('answers BUSY when another re-delivery of the run holds the lease, and sends nothing', async () => {
    const h = redelivery({ run: runRow(), parts: partRows([1]), leaseHeld: true });
    await expect(h.service.redeliver(runRow().id)).resolves.toEqual({ kind: 'BUSY' });
    expect(h.sent).toHaveLength(0);
  });

  it('refuses a run whose archive is no longer on the host, or that is not finished', async () => {
    const gone = redelivery({ run: runRow(), parts: partRows([1]), archiveExists: false });
    await expect(gone.service.redeliver(runRow().id)).resolves.toEqual({
      kind: 'REFUSED',
      why: 'ARCHIVE_GONE',
    });
    const running = redelivery({ run: runRow({ state: 'RUNNING' }), parts: partRows([1]) });
    await expect(running.service.redeliver(runRow().id)).resolves.toEqual({
      kind: 'REFUSED',
      why: 'NOT_FINISHED',
    });
    expect(gone.sent).toHaveLength(0);
    expect(running.sent).toHaveLength(0);
  });

  it('records a part that still does not arrive, with its reason, and gives the lease back', async () => {
    const reset: DeliveryAttempt = {
      state: 'OUTCOME_UNKNOWN',
      reason: 'CONNECTION_RESET',
      detail: 'read ECONNRESET',
    };
    const h = redelivery({
      run: runRow(),
      parts: partRows([1, 2]),
      script: [{ state: 'SUCCEEDED', detail: null, messageId: 33 }, reset, reset, reset],
    });
    const outcome = await h.service.redeliver(runRow().id);
    expect(outcome).toEqual({ kind: 'NOT_DELIVERED', reason: 'CONNECTION_RESET' });
    expect(h.sent.map((one) => one.filename)).toEqual([
      'a.7z.003',
      'a.7z.004',
      'a.7z.004',
      'a.7z.004',
    ]);
    const part4 = h.store.parts[3];
    expect(part4?.deliveryState).toBe('OUTCOME_UNKNOWN');
    expect(part4?.deliveryReason as BackupDeliveryReason).toBe('CONNECTION_RESET');
    expect(part4?.deliveryAttempts).toBe(3);
    expect(h.store.finished.at(-1)).toMatchObject({
      deliveryState: 'OUTCOME_UNKNOWN',
      deliveryReason: 'CONNECTION_RESET',
    });
    expect(h.reports).toEqual([['OUTCOME_UNKNOWN', 3, 5]]);
    expect(h.store.owner).toBeNull();
  });

  it('sends nothing once its window has ended, and keeps the run’s state with the reason', async () => {
    const h = redelivery({ run: runRow(), parts: partRows([1, 2]) });
    const outcome = await h.service.redeliver(runRow().id, {
      deadline: new Date(NOW.getTime() - 1),
    });
    expect(outcome).toEqual({ kind: 'NOT_DELIVERED', reason: 'CONNECTION_RESET' });
    expect(h.sent).toHaveLength(0);
    expect(h.store.finished.at(-1)).toMatchObject({
      deliveryState: 'OUTCOME_UNKNOWN',
      deliveryReason: 'CONNECTION_RESET',
    });
    expect(h.store.finished.at(-1)?.deliveryDetail).toContain(PART_DEADLINE_DETAIL);
    // Part 3 was sent before (unknown): it stays unknown, never rewritten as "not attempted".
    expect(h.store.parts[2]?.deliveryState).toBe('OUTCOME_UNKNOWN');
    expect(h.store.owner).toBeNull();
  });

  it('answers DELIVERED without sending anything when every part already has a message id', async () => {
    const h = redelivery({
      run: runRow({ deliveryState: 'SUCCEEDED' }),
      parts: partRows([1, 2, 3, 4, 5]),
    });
    await expect(h.service.redeliver(runRow().id)).resolves.toEqual({ kind: 'DELIVERED' });
    expect(h.sent).toHaveLength(0);
  });
});
