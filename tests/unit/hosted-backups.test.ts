import { describe, expect, it } from 'vitest';
import type { SecretCipher, TemplateKey, TenantContext } from '@nexa/contracts';
import { HostedBackupService } from '../../apps/api/src/modules/platform/hosting/application/hosted-backup.service';
import { HostedBackupLoop } from '../../apps/api/src/modules/platform/hosting/application/hosted-backup-loop';
import type { HostedBackupPolicyRow } from '../../apps/api/src/modules/platform/hosting/application/hosted-backup.ports';
import { HostedGroupArchiveDelivery } from '../../apps/api/src/modules/platform/backup/application/hosted-group-delivery';
import {
  TenantRestoreAdminService,
  type TenantRestoreRecord,
} from '../../apps/api/src/modules/platform/hosting/application/tenant-restore-admin.service';
import type { BackupRunRow } from '../../apps/api/src/modules/platform/backup/application/ports';

/**
 * Phase 6B PR-2 (ADR-0039 § 7): the hosted schedule's rules, the delivery's one destination,
 * and the restore page's lifecycle — each reachable without a database, so each is pinned here
 * and reverted by `scripts/claude/hosted-backup-mutation.sh`.
 */
const INSTALLATION = '01900000-0000-7000-8000-000000000001';
const BOT_A = '01900000-0000-7000-8000-00000000000a';
const BOT_B = '01900000-0000-7000-8000-00000000000b';

const cipher = {
  encrypt: (plain: string) => ({ ciphertext: `sealed:${plain}`, keyId: 'k1' }),
  decrypt: (secret: { ciphertext: string }) => secret.ciphertext.replace(/^sealed:/, ''),
} as unknown as SecretCipher;

function policy(over: Partial<HostedBackupPolicyRow> = {}): HostedBackupPolicyRow {
  return {
    id: '01900000-0000-7000-8000-0000000000f1',
    hostedTenantId: BOT_A,
    enabled: true,
    dailyTime: '04:30',
    keep: 7,
    passwordCiphertext: 'sealed:pw',
    passwordKeyId: 'k1',
    passwordSetAt: new Date('2026-11-01T00:00:00Z'),
    runRequestedAt: null,
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    ...over,
  };
}

function run(id: string, startedAt: string): BackupRunRow {
  return {
    id,
    state: 'SUCCEEDED',
    startedAt: new Date(startedAt),
    verifiedAt: new Date(startedAt),
  } as unknown as BackupRunRow;
}

function serviceWith(input: {
  policies: HostedBackupPolicyRow[];
  now: string;
  lastAttempt?: Record<string, Date | null>;
  outcome?: 'COMPLETED' | 'NOT_ADMITTED' | 'BUSY';
  candidates?: BackupRunRow[];
}) {
  const ran: { tenantId: string; trigger: string; password: string }[] = [];
  const removed: string[] = [];
  const cleared: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const service = new HostedBackupService({
    section: {} as never,
    owner: {} as never,
    bots: {
      findHosted: async (_s: unknown, id: string) => ({ hostedTenantId: id, state: 'ACTIVE' }),
    } as never,
    policies: {
      withPassword: async () => input.policies,
      clearRunRequest: async (_s: unknown, p: { id: string }) => {
        cleared.push(p.id);
      },
    } as never,
    runs: {
      lastAttemptAt: async (id: string) => input.lastAttempt?.[id] ?? null,
      pruneCandidates: async () => input.candidates ?? [],
      markPruned: async () => true,
    } as never,
    archives: {
      run: async (job) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        ran.push(job);
        const kind = input.outcome ?? 'COMPLETED';
        if (kind === 'COMPLETED') {
          return { kind, run: { id: 'r', state: 'SUCCEEDED' } as BackupRunRow };
        }
        if (kind === 'BUSY') return { kind, holder: {} as BackupRunRow };
        return { kind };
      },
    },
    files: {
      archive: async () => null,
      remove: async (_t: string, id: string) => {
        removed.push(id);
        return true;
      },
    },
    cipher,
    guard: {} as never,
    idempotency: {} as never,
    audit: {} as never,
    clock: { now: () => new Date(input.now) },
    ids: { uuid: () => 'x' } as never,
    installationTenantId: () => INSTALLATION,
    logger: { info: () => undefined, warn: () => undefined },
  });
  return { service, ran, removed, cleared, maxInFlight: () => maxInFlight };
}

describe('the hosted schedule (runDue)', () => {
  // 2026-11-09T01:30Z is 05:00 in Asia/Tehran (UTC+03:30): today's 04:30 slot has passed.
  const AFTER_SLOT = '2026-11-09T01:30:00Z';
  const BEFORE_SLOT = '2026-11-09T00:30:00Z';

  it('takes a bot whose last attempt is older than today’s slot, as SCHEDULED, with its password', async () => {
    const t = serviceWith({
      policies: [policy()],
      now: AFTER_SLOT,
      lastAttempt: { [BOT_A]: new Date('2026-11-08T01:00:00Z') },
    });
    const pass = await t.service.runDue();
    expect(pass.ran).toEqual([BOT_A]);
    expect(t.ran).toEqual([{ tenantId: BOT_A, trigger: 'SCHEDULED', password: 'pw' }]);
  });

  it('does not take a bot already attempted since the slot, before the slot, or switched off', async () => {
    const since = serviceWith({
      policies: [policy()],
      now: AFTER_SLOT,
      lastAttempt: { [BOT_A]: new Date('2026-11-09T01:05:00Z') },
    });
    expect((await since.service.runDue()).ran).toEqual([]);
    const before = serviceWith({
      policies: [policy()],
      now: BEFORE_SLOT,
      lastAttempt: { [BOT_A]: new Date('2026-11-08T01:05:00Z') },
    });
    expect((await before.service.runDue()).ran).toEqual([]);
    const off = serviceWith({ policies: [policy({ enabled: false })], now: AFTER_SLOT });
    expect((await off.service.runDue()).ran).toEqual([]);
  });

  it('takes «بکاپ الان» as MANUAL even with the schedule off, and clears that request', async () => {
    const requested = new Date('2026-11-09T00:10:00Z');
    const t = serviceWith({
      policies: [policy({ enabled: false, runRequestedAt: requested })],
      now: BEFORE_SLOT,
      lastAttempt: { [BOT_A]: new Date('2026-11-09T00:20:00Z') },
    });
    await t.service.runDue();
    expect(t.ran.map((job) => job.trigger)).toEqual(['MANUAL']);
    expect(t.cleared).toHaveLength(1);
  });

  it('runs due bots one at a time, and a queue that does not admit ends the pass', async () => {
    const t = serviceWith({
      policies: [policy(), policy({ id: 'p2', hostedTenantId: BOT_B })],
      now: AFTER_SLOT,
    });
    await t.service.runDue();
    expect(t.ran.map((job) => job.tenantId)).toEqual([BOT_A, BOT_B]);
    expect(t.maxInFlight()).toBe(1);
    const busy = serviceWith({
      policies: [policy(), policy({ id: 'p2', hostedTenantId: BOT_B })],
      now: AFTER_SLOT,
      outcome: 'NOT_ADMITTED',
    });
    const pass = await busy.service.runDue();
    expect(pass.deferred).toBe(true);
    expect(busy.ran.map((job) => job.tenantId)).toEqual([BOT_A]);
  });

  it('removes only what its own retention names after a run', async () => {
    const t = serviceWith({
      policies: [policy({ keep: 1 })],
      now: AFTER_SLOT,
      candidates: [run('old-1', '2026-11-01T00:00:00Z')],
    });
    expect((await t.service.runDue()).pruned).toBe(1);
    expect(t.removed).toEqual(['old-1']);
  });

  it('the loop never starts a second pass while one runs', async () => {
    let concurrent = 0;
    let peak = 0;
    const loop = new HostedBackupLoop(
      {
        runDue: async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 10));
          concurrent -= 1;
          return { ran: [], failed: [], pruned: 0, deferred: false };
        },
      },
      {
        intervalMs: 60_000,
        now: () => 0,
        quiesced: async () => false,
        logger: { info: () => undefined, error: () => undefined },
      },
    );
    await Promise.all([loop.tick(), loop.tick(), loop.tick()]);
    expect(peak).toBe(1);
  });
});

describe('hosted archive delivery: the hosted bot’s own group, never the owner’s', () => {
  function delivery(route: unknown) {
    const asked: TenantContext[] = [];
    const sent: { token: string; chatId: string }[] = [];
    const captions: TemplateKey[] = [];
    const d = new HostedGroupArchiveDelivery({
      opsGroup: {
        route: async (scope) => {
          asked.push(scope as TenantContext);
          return route as never;
        },
        delivered: async () => undefined,
      },
      channelFor: (target) => ({
        sendDocument: async () => {
          sent.push(target);
          return { state: 'SUCCEEDED', detail: null };
        },
      }),
      settings: { valueOf: async () => [] as never },
      render: async (_scope, key) => {
        captions.push(key);
        return 'caption';
      },
      clock: { now: () => new Date('2026-11-09T00:00:00Z') },
    });
    const go = () =>
      d.deliver({
        tenantId: BOT_A,
        runId: '01900000-0000-7000-8000-0000000000r1',
        archivePath: '/x/archive.7z',
        archiveBytes: 1024,
        checksum: 'f'.repeat(64),
        at: new Date('2026-11-09T00:00:00Z'),
      });
    return { go, asked, sent, captions };
  }

  it('asks the topic in the HOSTED tenant’s scope only, and posts with its own caption', async () => {
    const t = delivery({ kind: 'ROUTED', chatId: '-100hosted', threadId: 7, token: 'hosted-bot' });
    expect((await t.go()).state).toBe('SUCCEEDED');
    expect(t.asked.map((scope) => scope.tenantId)).toEqual([BOT_A]);
    expect(t.sent).toEqual([{ token: 'hosted-bot', chatId: '-100hosted', threadId: 7 }]);
    expect(t.captions).toEqual(['ops.log.hosted_backup_caption']);
  });

  it('with no hosted group it keeps the archive — no installation scope, no fallback chat', async () => {
    const t = delivery({ kind: 'NOT_CONNECTED' });
    expect((await t.go()).state).toBe('NOT_ATTEMPTED');
    expect(t.asked.map((scope) => scope.tenantId)).toEqual([BOT_A]);
    expect(t.asked.map((scope) => scope.tenantId)).not.toContain(INSTALLATION);
    expect(t.sent).toEqual([]);
  });
});

describe('«بازیابی ربات از فایل»: the recovery role’s pass', () => {
  function admin(
    rows: TenantRestoreRecord[],
    files: Record<string, string | null>,
    restoreFails?: Error,
    withdrawResult = true,
  ) {
    const restored: { confirmRequestId?: string; password: string; slug?: string }[] = [];
    const withdrawn: {
      id: string;
      failureCode: string;
      failureMessage?: string;
      includeConfirmed?: boolean;
    }[] = [];
    const removed: string[] = [];
    const service = new TenantRestoreAdminService({
      section: {} as never,
      owner: {} as never,
      restores: {
        restore: async (input) => {
          if (restoreFails) throw restoreFails;
          restored.push(input);
          return { requestId: input.confirmRequestId ?? 'x', summary: {} as never };
        },
      },
      requests: {
        byId: async (_s, id) =>
          (rows.find((row) => row.id === id) as TenantRestoreRecord & {
            requestedByAdminId: string;
          }) ?? null,
        recent: async () => rows,
        requestConfirm: async () => true,
        withdraw: async (_s, input) => {
          withdrawn.push(input);
          return withdrawResult;
        },
        staleDryRuns: async (_s, before) =>
          rows
            .filter(
              (row) =>
                row.state === 'VERIFIED' &&
                row.confirmRequestedAt === null &&
                row.createdAt.getTime() < before.getTime(),
            )
            .map((row) => row.id),
        confirmedPending: async () =>
          rows.filter((row) => row.state === 'VERIFIED' && row.confirmRequestedAt !== null),
      },
      workspaces: {
        create: async () => ({ archivePath: 'a' }),
        open: (id) => ({
          archivePath: `/w/${id}/archive.7z`,
          scratchDirectory: `/w/${id}/work`,
          exists: async () => true,
          writeSealedPassword: async () => undefined,
          readSealedPassword: async () => files[id] ?? null,
          remove: async () => {
            removed.push(id);
            return true;
          },
        }),
        list: async () =>
          Object.keys(files).map((restoreId) => ({
            restoreId,
            lastWrittenAt: new Date('2026-11-01T00:00:00Z'),
          })),
      },
      cipher,
      idempotency: {} as never,
      audit: {} as never,
      clock: { now: () => new Date('2026-11-09T00:00:00Z') },
      ids: { uuid: () => 'x' } as never,
      installationTenantId: () => INSTALLATION,
      logger: { info: () => undefined, warn: () => undefined },
    });
    return { service, restored, withdrawn, removed };
  }

  const record = (over: Partial<TenantRestoreRecord> & { id: string }): TenantRestoreRecord =>
    ({
      hostedTenantId: BOT_A,
      state: 'VERIFIED',
      stage: 'DONE',
      dryRun: {},
      failureCode: null,
      createdAt: new Date('2026-11-08T23:00:00Z'),
      confirmRequestedAt: null,
      finishedAt: null,
      requestedByAdminId: '01900000-0000-7000-8000-0000000000ad',
      ...over,
    }) as TenantRestoreRecord;

  it('applies a confirmed dry run with its sealed password, then removes its upload', async () => {
    const id = '01900000-0000-7000-8000-0000000000c1';
    const t = admin([record({ id, confirmRequestedAt: new Date('2026-11-08T23:30:00Z') })], {
      [id]: JSON.stringify({ ciphertext: 'sealed:the archive password', keyId: 'k1' }),
    });
    expect((await t.service.tick()).applied).toBe(1);
    expect(t.restored).toEqual([
      expect.objectContaining({ confirmRequestId: id, password: 'the archive password' }),
    ]);
    expect(t.removed).toContain(id);
  });

  it('a plain error from the restore never reaches the persisted failure message', async () => {
    const id = '01900000-0000-7000-8000-0000000000c3';
    const marker = '01900000-0000-7000-8000-0000000000ff';
    const t = admin(
      [record({ id, confirmRequestedAt: new Date('2026-11-08T23:30:00Z') })],
      { [id]: JSON.stringify({ ciphertext: 'sealed:pw', keyId: 'k1' }) },
      new Error(`Failed query: insert into customers values ($1) params: ${marker}`),
    );
    await t.service.tick();
    expect(t.withdrawn).toHaveLength(1);
    const message = t.withdrawn[0]?.failureMessage ?? '';
    expect(message).not.toContain('params:');
    expect(message).not.toContain(marker);
  });

  it('applies the slug the owner chose at the dry run', async () => {
    const id = '01900000-0000-7000-8000-0000000000c4';
    const t = admin(
      [
        record({
          id,
          confirmRequestedAt: new Date('2026-11-08T23:30:00Z'),
          dryRun: { slug: 'chosen-slug' },
        }),
      ],
      { [id]: JSON.stringify({ ciphertext: 'sealed:pw', keyId: 'k1' }) },
    );
    await t.service.tick();
    expect(t.restored).toEqual([expect.objectContaining({ slug: 'chosen-slug' })]);
  });

  it('fails a confirmed row it never claimed, and keeps its upload when that did not land', async () => {
    const id = '01900000-0000-7000-8000-0000000000c5';
    const rows = [record({ id, confirmRequestedAt: new Date('2026-11-08T23:30:00Z') })];
    const landed = admin(rows, { [id]: null });
    await landed.service.tick();
    expect(landed.withdrawn).toEqual([expect.objectContaining({ id, includeConfirmed: true })]);
    expect(landed.removed).toContain(id);
    const missed = admin(rows, { [id]: null }, undefined, false);
    await missed.service.tick();
    expect(missed.removed).not.toContain(id);
  });

  it('expires a dry run nobody confirmed within a day; a fresh one stays', async () => {
    const stale = '01900000-0000-7000-8000-0000000000e1';
    const fresh = '01900000-0000-7000-8000-0000000000e2';
    const t = admin(
      [
        record({ id: stale, createdAt: new Date('2026-11-07T00:00:00Z') }),
        record({ id: fresh, createdAt: new Date('2026-11-08T23:00:00Z') }),
      ],
      {},
    );
    expect((await t.service.tick()).expired).toBe(1);
    expect(t.withdrawn).toEqual([
      expect.objectContaining({ id: stale, failureCode: 'tenant_archive.dry_run_expired' }),
    ]);
  });

  it('a confirmed row with no readable password is failed, never applied', async () => {
    const id = '01900000-0000-7000-8000-0000000000c2';
    const t = admin([record({ id, confirmRequestedAt: new Date('2026-11-08T23:30:00Z') })], {
      [id]: null,
    });
    await t.service.tick();
    expect(t.restored).toEqual([]);
    expect(t.withdrawn).toEqual([
      expect.objectContaining({ id, failureCode: 'tenant_archive.verification_failed' }),
    ]);
    expect(t.removed).toContain(id);
  });

  it('A3: removes an upload whose request finished, and an orphan older than a day; keeps a live one', async () => {
    const done = '01900000-0000-7000-8000-0000000000d1';
    const orphan = '01900000-0000-7000-8000-0000000000d2';
    const live = '01900000-0000-7000-8000-0000000000d3';
    const t = admin(
      [
        record({ id: done, state: 'FAILED', failureCode: 'x', finishedAt: new Date() }),
        record({ id: live, createdAt: new Date('2026-11-08T23:59:00Z') }),
      ],
      { [done]: null, [orphan]: null, [live]: null },
    );
    await t.service.tick();
    expect(t.removed.sort()).toEqual([done, orphan].sort());
  });
});
