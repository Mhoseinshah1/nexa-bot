import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOVE_ERROR_CODES, type TenantArchiveManifest } from '@nexa/contracts';
import type { BackupRunRow } from '../../apps/api/src/modules/platform/backup/application/ports';
import { TenantArchiveService } from '../../apps/api/src/modules/platform/backup/application/tenant-archive.service';
import {
  isMoveBundleEntry,
  moveBundleManifestSchema,
  moveChecklistFa,
  openMoveBundle,
  sealMoveBundle,
  type MoveBundleManifest,
} from '../../apps/api/src/modules/platform/backup/infrastructure/move-bundle';
import {
  exportMoveBundle,
  refuseBundleHead,
  refuseMovePassword,
  verifyHostedMembers,
  type MoveExportDeps,
} from '../../apps/api/src/modules/platform/backup/infrastructure/server-move';
import {
  importReportFa,
  ownerDomainsOf,
  parseMoveArgs,
  verifyTableFa,
} from '../../apps/api/src/move.cli';

/**
 * Phase 6B PR-4 (ADR-0039 § 8): the server move's rules that need no database — the bundle
 * format and its open, the export's all-or-nothing, the head policy, the hosted verification's
 * verdicts, the CLI's password handling and the Persian output. The integration half
 * (`tests/integration/isolation-proof/server-move.test.ts`) moves real tenants.
 */

const PASSWORD = 'bundle-password-0123';
const INSTALLATION = '01900000-0000-7000-8000-00000000000a';
const HOSTED_A = '01900000-0000-7000-8000-0000000000a1';
const HOSTED_B = '01900000-0000-7000-8000-0000000000b2';
const SEVEN_ZIP = {
  binary: process.env['BACKUP_SEVEN_ZIP_BIN'] ?? '7z',
  level: 1,
  threads: 1,
  memoryBudgetMb: 1_000,
  memoryHeadroomMb: 0,
  readAvailableMb: async () => null,
  lowPriorityPrefix: [] as string[],
  sealTimeoutMs: 60_000,
  openTimeoutMs: 60_000,
};
const MIGRATIONS = { count: 3, lastTag: '0002_x', lastHash: 'h2', lastWhen: 3 };
const EXPECTED = [
  { tag: '0000_a', hash: 'h0', when: 1 },
  { tag: '0001_b', hash: 'h1', when: 2 },
  { tag: '0002_x', hash: 'h2', when: 3 },
];

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexa-move-unit-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

let runNumber = 0;
function run(overrides: Partial<BackupRunRow> = {}): BackupRunRow {
  runNumber += 1;
  return {
    id: `01900000-0000-7000-8000-${String(runNumber).padStart(12, '0')}`,
    trigger: 'MOVE',
    state: 'SUCCEEDED',
    stage: 'CLEANUP',
    startedAt: new Date('2026-11-09T10:00:00Z'),
    verifiedAt: new Date('2026-11-09T10:05:00Z'),
    archiveFormat: 'SEVEN_ZIP',
    failureCode: null,
    ...overrides,
  } as BackupRunRow;
}

/** A member's sealed file where its run would leave it. */
async function memberFile(name: string, body: string): Promise<string> {
  const directory = join(root, 'runs', name);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'archive.7z');
  await writeFile(path, body);
  return path;
}

function deps(overrides: Partial<MoveExportDeps> = {}): MoveExportDeps {
  return {
    installationTenantId: INSTALLATION,
    installationId: INSTALLATION,
    release: '1.2.3',
    image: 'ghcr.io/x/nexa@sha256:abc',
    migrations: MIGRATIONS,
    now: () => new Date('2026-11-09T11:00:00Z'),
    sevenZip: SEVEN_ZIP,
    environment: {
      WEB_ADMIN_ORIGINS: 'https://owner.example',
      BACKUP_TELEGRAM_BOT_TOKEN: 'secret-token-value',
      SECRETS_KEYS: 'never-carried',
    },
    ownerDomains: ['owner.example'],
    cnameTarget: 'owner.example',
    serverIps: ['203.0.113.7'],
    databaseBytes: async () => 1_000,
    freeBytes: async () => 10_000_000,
    bots: async () => [
      {
        tenantId: INSTALLATION,
        kind: 'INSTALLATION',
        botInstanceId: 'i',
        username: 'owner_bot',
        telegramBotId: '11',
        domain: null,
        state: null,
      },
      {
        tenantId: HOSTED_A,
        kind: 'HOSTED',
        botInstanceId: 'a',
        username: 'a_bot',
        telegramBotId: '22',
        domain: 'a.example',
        state: 'ACTIVE',
      },
      {
        tenantId: HOSTED_B,
        kind: 'HOSTED',
        botInstanceId: 'b',
        username: 'b_bot',
        telegramBotId: '33',
        domain: 'b.example',
        state: 'SUSPENDED',
      },
    ],
    backupInstallation: async () => ({
      run: run(),
      archivePath: await memberFile('installation', 'installation-member'),
    }),
    archiveHosted: async (tenantId) => ({
      run: run(),
      archivePath: await memberFile(tenantId, `hosted-member-${tenantId}`),
    }),
    progress: () => undefined,
    ...overrides,
  };
}

describe('the bundle password', () => {
  it('is refused below the backup password length, and only read from stdin', () => {
    expect(() => refuseMovePassword('short')).toThrow(
      expect.objectContaining({ code: MOVE_ERROR_CODES.PASSWORD_REFUSED }),
    );
    expect(() => refuseMovePassword(PASSWORD)).not.toThrow();
    expect(() => parseMoveArgs(['export', '--password', PASSWORD])).toThrow(/standard input/);
    expect(() => parseMoveArgs(['export', `--password=${PASSWORD}`])).toThrow(/standard input/);
    expect(() => parseMoveArgs(['export'])).toThrow(/--password-stdin/);
    expect(() => parseMoveArgs(['import-installation', '--password-stdin'])).toThrow(/--workspace/);
    expect(parseMoveArgs(['verify', '--here', '1.2.3.4', '--domain', 'a.b']).here).toEqual([
      '1.2.3.4',
    ]);
  });
});

describe('exportMoveBundle (ADR-0039 § 8)', () => {
  it('seals every VERIFIED member with the bundle password and leaves only the bundle', async () => {
    const work = join(root, 'work');
    const result = await exportMoveBundle(deps(), { password: PASSWORD, workDirectory: work });
    expect(await readdir(work)).toEqual(
      expect.arrayContaining(['nexa-move.7z', 'move-manifest.json', 'checklist.fa.txt']),
    );
    expect(await readdir(work)).not.toContain('installation');
    expect(result.manifest.members.map((member) => member.kind)).toEqual([
      'INSTALLATION',
      'HOSTED',
      'HOSTED',
    ]);
    expect(result.manifest.members[1]?.path).toBe(`hosted/${HOSTED_A}.7z`);
    expect(result.manifest.members[1]?.sha256).toBe(
      createHash('sha256').update(`hosted-member-${HOSTED_A}`).digest('hex'),
    );
    // Secrets by NAME, never value; the keyring never named.
    expect(result.manifest.environment.secretNames).toEqual(['BACKUP_TELEGRAM_BOT_TOKEN']);
    expect(JSON.stringify(result.manifest)).not.toContain('secret-token-value');
    expect(JSON.stringify(result.manifest)).not.toContain('SECRETS_KEYS');
    // Moved, not copied: no second copy left in the run directories.
    await expect(stat(join(root, 'runs', HOSTED_A, 'archive.7z'))).rejects.toThrow();

    const opened = await openMoveBundle({
      bundlePath: result.bundlePath,
      password: PASSWORD,
      directory: join(root, 'open'),
      sevenZip: SEVEN_ZIP,
      freeBytes: async () => null,
    });
    expect(opened.manifest).toEqual(result.manifest);
    await expect(
      openMoveBundle({
        bundlePath: result.bundlePath,
        password: 'another-password-123',
        directory: join(root, 'open-2'),
        sevenZip: SEVEN_ZIP,
        freeBytes: async () => null,
      }),
    ).rejects.toMatchObject({ code: 'backup.archive_auth_failed' });
  });

  it('writes no bundle when one hosted member did not verify, and removes everything', async () => {
    const work = join(root, 'work');
    await expect(
      exportMoveBundle(
        deps({
          archiveHosted: async (tenantId) => ({
            run: run(
              tenantId === HOSTED_B ? { state: 'FAILED', verifiedAt: null, failureCode: 'x' } : {},
            ),
            archivePath: await memberFile(tenantId, 'm'),
          }),
        }),
        { password: PASSWORD, workDirectory: work },
      ),
    ).rejects.toMatchObject({ code: MOVE_ERROR_CODES.MEMBER_FAILED });
    await expect(stat(work)).rejects.toThrow();
  });

  it('refuses an installation member that never passed VERIFY_RESTORE (ADR-0025)', async () => {
    const work = join(root, 'work');
    await expect(
      exportMoveBundle(
        deps({
          backupInstallation: async () => ({
            run: run({ verifiedAt: null }),
            archivePath: await memberFile('installation', 'x'),
          }),
        }),
        { password: PASSWORD, workDirectory: work },
      ),
    ).rejects.toMatchObject({ code: MOVE_ERROR_CODES.MEMBER_FAILED });
    await expect(stat(work)).rejects.toThrow();
  });

  it('refuses before any member when the disk cannot hold twice the database', async () => {
    const backupInstallation = vi.fn();
    await expect(
      exportMoveBundle(deps({ freeBytes: async () => 1_500, backupInstallation }), {
        password: PASSWORD,
        workDirectory: join(root, 'work'),
      }),
    ).rejects.toMatchObject({ code: 'backup.disk_insufficient' });
    expect(backupInstallation).not.toHaveBeenCalled();
  });
});

async function handMadeBundle(
  mutate: (manifest: MoveBundleManifest) => MoveBundleManifest,
  memberBody = 'installation-member',
): Promise<string> {
  const directory = join(root, 'hand');
  await mkdir(join(directory, 'installation'), { recursive: true });
  const path = 'installation/nexa-backup-20261109-1000-01900000.7z';
  await writeFile(join(directory, path), memberBody);
  const manifest = mutate({
    format: 'nexa.move-bundle',
    formatVersion: 1,
    createdAt: '2026-11-09T11:00:00.000Z',
    source: { installationId: INSTALLATION, release: '1', image: null },
    migrations: MIGRATIONS,
    members: [
      {
        path,
        kind: 'INSTALLATION',
        tenantId: INSTALLATION,
        runId: INSTALLATION,
        bytes: Buffer.byteLength('installation-member'),
        sha256: createHash('sha256').update('installation-member').digest('hex'),
      },
    ],
    domains: { owner: [], cnameTarget: null, serverIps: [] },
    bots: [],
    environment: { values: {}, secretNames: [] },
  });
  await writeFile(join(directory, 'move-manifest.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'checklist.fa.txt'), 'x');
  const bundlePath = join(root, 'hand.7z');
  await sealMoveBundle({ directory, bundlePath, password: PASSWORD, sevenZip: SEVEN_ZIP });
  return bundlePath;
}

describe('openMoveBundle', () => {
  const open = (bundlePath: string) =>
    openMoveBundle({
      bundlePath,
      password: PASSWORD,
      directory: join(root, 'opened'),
      sevenZip: SEVEN_ZIP,
      freeBytes: async () => null,
    });

  it('opens a well-formed bundle', async () => {
    const opened = await open(await handMadeBundle((manifest) => manifest));
    expect(opened.manifest.members).toHaveLength(1);
  });

  it('refuses a member whose bytes are not the manifest’s', async () => {
    await expect(
      open(await handMadeBundle((manifest) => manifest, 'installation-membeR')),
    ).rejects.toMatchObject({ code: MOVE_ERROR_CODES.MEMBER_CHECKSUM_MISMATCH });
  });

  it('refuses a manifest that is not the format', async () => {
    await expect(
      open(await handMadeBundle((manifest) => ({ ...manifest, formatVersion: 2 as never }))),
    ).rejects.toMatchObject({ code: MOVE_ERROR_CODES.BUNDLE_MALFORMED });
  });

  it('knows only the entries it writes', () => {
    expect(isMoveBundleEntry('move-manifest.json')).toBe(true);
    expect(isMoveBundleEntry(`hosted/${HOSTED_A}.7z`)).toBe(true);
    expect(isMoveBundleEntry('hosted/../etc.7z')).toBe(false);
    expect(isMoveBundleEntry('installation/x.sh')).toBe(false);
    expect(isMoveBundleEntry('nexa.env')).toBe(false);
  });
});

describe('the manifest schema', () => {
  const base = (): MoveBundleManifest =>
    ({
      format: 'nexa.move-bundle',
      formatVersion: 1,
      createdAt: '2026-11-09T11:00:00.000Z',
      source: { installationId: INSTALLATION, release: '1', image: null },
      migrations: MIGRATIONS,
      members: [
        {
          path: 'installation/nexa-backup-20261109-1000-01900000.7z',
          kind: 'INSTALLATION',
          tenantId: INSTALLATION,
          runId: INSTALLATION,
          bytes: 1,
          sha256: 'a'.repeat(64),
        },
      ],
      domains: { owner: [], cnameTarget: null, serverIps: [] },
      bots: [],
      environment: { values: {}, secretNames: [] },
    }) as MoveBundleManifest;

  it('takes exactly one installation member and hosted members named by their tenant', () => {
    expect(moveBundleManifestSchema.safeParse(base()).success).toBe(true);
    const twice = base();
    expect(
      moveBundleManifestSchema.safeParse({
        ...twice,
        members: [...twice.members, { ...twice.members[0], runId: HOSTED_A }],
      }).success,
    ).toBe(false);
    const misnamed = base();
    expect(
      moveBundleManifestSchema.safeParse({
        ...misnamed,
        members: [
          ...misnamed.members,
          {
            path: `hosted/${HOSTED_B}.7z`,
            kind: 'HOSTED',
            tenantId: HOSTED_A,
            runId: HOSTED_A,
            bytes: 1,
            sha256: 'b'.repeat(64),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('carries no environment key outside its allow-lists', () => {
    const leaky = base();
    expect(
      moveBundleManifestSchema.safeParse({
        ...leaky,
        environment: { values: { SECRETS_KEYS: 'x' }, secretNames: [] },
      }).success,
    ).toBe(false);
    expect(
      moveBundleManifestSchema.safeParse({
        ...leaky,
        environment: { values: {}, secretNames: ['SECRETS_KEYS'] },
      }).success,
    ).toBe(false);
  });
});

describe('the bundle head (ADR-0039 § 3)', () => {
  const manifest = (migrations: typeof MIGRATIONS) => ({ migrations }) as MoveBundleManifest;

  it('takes an equal or older head and refuses a newer one in Persian', () => {
    expect(refuseBundleHead(manifest(MIGRATIONS), EXPECTED)).toBe('EQUAL');
    expect(
      refuseBundleHead(
        manifest({ count: 2, lastTag: '0001_b', lastHash: 'h1', lastWhen: 2 }),
        EXPECTED,
      ),
    ).toBe('OLDER');
    expect(() =>
      refuseBundleHead(
        manifest({ count: 4, lastTag: '0003_y', lastHash: 'h3', lastWhen: 4 }),
        EXPECTED,
      ),
    ).toThrow(
      expect.objectContaining({
        code: MOVE_ERROR_CODES.HEAD_NEWER,
        message: 'اول نکسای مقصد را به‌روز کنید',
      }),
    );
    expect(() =>
      refuseBundleHead(
        manifest({ count: 3, lastTag: '0002_x', lastHash: 'other', lastWhen: 3 }),
        EXPECTED,
      ),
    ).toThrow(expect.objectContaining({ code: MOVE_ERROR_CODES.HEAD_DIVERGED }));
  });
});

describe('verifyHostedMembers', () => {
  const archive = {
    tenant: { id: HOSTED_A },
    tables: [
      { name: 'customers', rows: 2 },
      { name: 'orders', rows: 1 },
    ],
  } as unknown as TenantArchiveManifest;
  const bundle = {
    manifest: {
      members: [
        { kind: 'INSTALLATION', tenantId: INSTALLATION, path: 'installation/x.7z' },
        { kind: 'HOSTED', tenantId: HOSTED_A, path: `hosted/${HOSTED_A}.7z` },
      ],
    },
    directory: root,
    memberPath: () => '/unused',
  } as never;
  const digests = { customers: '2:aa', orders: '1:bb' };

  const verify = (live: Record<string, string>, extra: string[] = [], presence = 'PRESENT') =>
    verifyHostedMembers(
      {
        installationTenantId: INSTALLATION,
        presence: async () => presence as never,
        openMember: async (_member, fn) => fn(archive, digests),
        live: async () => ({ digests: live, extraTables: extra }),
        progress: () => undefined,
      },
      bundle,
    );

  it('passes identical counts and digests', async () => {
    await expect(verify({ ...digests })).resolves.toEqual({
      verified: [{ tenantId: HOSTED_A, tables: 2 }],
      missing: [],
    });
  });

  it('stops at a changed row, naming the tenant and the table, never a value', async () => {
    await expect(verify({ ...digests, orders: '1:cc' })).rejects.toMatchObject({
      code: MOVE_ERROR_CODES.HOSTED_MISMATCH,
      details: { tenantId: HOSTED_A, table: 'orders' },
    });
  });

  it('stops at a lost row', async () => {
    await expect(verify({ ...digests, customers: '1:aa' })).rejects.toMatchObject({
      code: MOVE_ERROR_CODES.HOSTED_MISMATCH,
      details: { table: 'customers' },
    });
  });

  it('stops at live rows the archive does not have', async () => {
    await expect(verify({ ...digests }, ['tickets'])).rejects.toMatchObject({
      code: MOVE_ERROR_CODES.HOSTED_MISMATCH,
      details: { table: 'tickets' },
    });
  });

  it('keeps an absent tenant aside and refuses a tenant that is not hosted here', async () => {
    await expect(verify({}, [], 'ABSENT')).resolves.toEqual({
      verified: [],
      missing: [HOSTED_A],
    });
    await expect(verify({}, [], 'NOT_HOSTED')).rejects.toMatchObject({
      code: MOVE_ERROR_CODES.HOSTED_MISMATCH,
    });
  });
});

describe('TenantArchiveService — a MOVE member is never delivered', () => {
  it('skips the hosted group delivery for MOVE and keeps it for a scheduled run', async () => {
    const deliver = vi.fn(async () => ({
      state: 'DELIVERED' as const,
      detail: null,
      attemptedAt: new Date(0),
    }));
    const service = new TenantArchiveService({
      runs: {
        reclaimStale: async () => 0,
        start: async () => ({ claimed: true }),
        heartbeat: async () => undefined,
        progress: async () => undefined,
        finish: async () => undefined,
        byId: async () => ({ id: 'run-1' }),
      } as never,
      delivery: { deliver } as never,
      engine: {
        leaked: [],
        sweepAbandonedScratch: async () => ({ dropped: [], survived: [] }),
        workspace: async () => ({
          plainDirectory: '/p',
          verifyDirectory: '/v',
          archivePath: '/a',
          discardPlaintext: async () => [],
          discardAll: async () => [],
        }),
        dump: async () => ({ manifest: {}, manifestSha256: 'a'.repeat(64), dataBytes: 1 }),
        seal: async () => ({ archiveBytes: 1 }),
        verify: async () => ({ tables: 1, rows: 1 }),
      } as never,
      heavyJobs: {
        runWhenAdmitted: async (_k: unknown, _t: unknown, job: () => Promise<unknown>) => ({
          ran: true,
          result: await job(),
        }),
      } as never,
      clock: { now: () => new Date(0) } as never,
      ids: { uuid: () => 'run-1' } as never,
      leaseOwner: 'test',
      queue: { pollMs: 1, maxWaitMs: 1, sleep: async () => undefined },
      logger: { info: () => undefined, error: () => undefined },
    });
    await service.run({ tenantId: 't', trigger: 'MOVE', password: PASSWORD });
    expect(deliver).not.toHaveBeenCalled();
    await service.run({ tenantId: 't', trigger: 'SCHEDULED', password: PASSWORD });
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe('the Persian output', () => {
  it('lists every DNS record, then the webhooks, the secrets and the roles last', () => {
    const text = moveChecklistFa({
      ownerDomains: ['owner.example'],
      serverAddresses: ['198.51.100.9'],
      cnameTarget: 'owner.example',
      hostedDomains: [{ domain: 'a.example', username: 'a_bot' }],
      bots: [
        { kind: 'INSTALLATION', username: 'owner_bot' },
        { kind: 'HOSTED', username: 'a_bot' },
      ],
      secretNames: ['BACKUP_TELEGRAM_BOT_TOKEN'],
    });
    expect(text).toContain('owner.example  →  رکورد A/AAAA به 198.51.100.9');
    expect(text).toContain('a.example (@a_bot)  →  CNAME به owner.example');
    expect(text).toContain('sudo botctl telegram register');
    expect(text).toContain('sudo botctl telegram register-hosted');
    expect(text).toContain('کد بخش «میزبانی‌ها»');
    expect(text.indexOf('sudo botctl telegram register-hosted')).toBeLessThan(
      text.indexOf('sudo botctl roles enable provisioner monitor'),
    );
    expect(text).toContain('BACKUP_TELEGRAM_BOT_TOKEN');
    expect(text.indexOf('sudo botctl telegram register')).toBeLessThan(
      text.indexOf('sudo botctl roles enable provisioner monitor'),
    );
    expect(text.indexOf('رکورد A/AAAA')).toBeLessThan(text.indexOf('sudo botctl move verify'));
  });

  it('reads the verify table as ready only when every row and webhook is', () => {
    const ready = verifyTableFa(
      [{ name: 'owner.example', dns: true, tls: true }],
      [{ name: '@owner_bot', ready: true, at: 'owner.example' }],
    );
    expect(ready).toContain('همه‌چیز به این سرور اشاره می‌کند');
    const waiting = verifyTableFa(
      [{ name: 'a.example', dns: false, tls: null }],
      [{ name: '@a_bot', ready: false, at: 'old.example' }],
    );
    expect(waiting).toContain('نه هنوز');
    expect(waiting).toContain('(اکنون: old.example)');
    expect(waiting).not.toContain('همه‌چیز به این سرور اشاره می‌کند');
  });

  it('names the members kept for «بازیابی ربات از فایل»', () => {
    const text = importReportFa({
      manifest: { environment: { values: {}, secretNames: [] } } as never,
      checklist: 'CHECKLIST',
      kept: ['/var/lib/nexa/backups/move-unrestored/x.7z'],
    });
    expect(text).toContain('بازیابی ربات از فایل');
    expect(text).toContain('/var/lib/nexa/backups/move-unrestored/x.7z');
    expect(text.endsWith('CHECKLIST')).toBe(true);
  });

  it('takes the owner domains from WEB_ADMIN_ORIGINS and the given names', () => {
    expect(ownerDomainsOf(['https://Owner.Example/', 'bad url'], ['bot.example.'])).toEqual([
      'owner.example',
      'bot.example',
    ]);
  });
});
