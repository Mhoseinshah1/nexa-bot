import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isNexaError,
  MOVE_ERROR_CODES,
  NexaError,
  systemJobActor,
  type ScopeContext,
} from '@nexa/contracts';
import { pointAtInstallation } from './backup.cli.js';
import { createContainer, type Container } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import type { AppConfig } from './infrastructure/config/config.schema.js';
import { newCorrelationId } from './infrastructure/logging/logger.js';
import { withDatabaseScope } from './infrastructure/persistence/database-scope.js';
import {
  expectedMigrations,
  migrationsFolder,
} from './infrastructure/persistence/migration-state.js';
import { telegramGetWebhookInfo } from './infrastructure/telegram/send-message.js';
import {
  moveChecklistFa,
  openMoveBundle,
  reopenMoveBundle,
  type MoveBundleManifest,
} from './modules/platform/backup/infrastructure/move-bundle.js';
import {
  clearActivationMarks,
  hostedActivations,
  hostedTenantPresence,
  isFreshTarget,
  liveDatabaseBytes,
  liveTenantDigest,
  moveBundleBots,
  moveTargetBusiness,
} from './modules/platform/backup/infrastructure/move-queries.js';
import {
  exportMoveBundle,
  refuseBundleHead,
  refuseMovePassword,
  verifyHostedMembers,
  volumeFreeBytes,
} from './modules/platform/backup/infrastructure/server-move.js';
import { readMemAvailableMb } from './modules/platform/backup/infrastructure/seven-zip-levels.js';
import type { SevenZipOptions } from './modules/platform/backup/infrastructure/seven-zip.js';
import { migrationHead } from './modules/platform/backup/infrastructure/tenant-archive-export.js';
import {
  archiveCanonicalDigests,
  openTenantArchive,
} from './modules/platform/backup/infrastructure/tenant-archive-restore.js';
import {
  keepScratchAlive,
  privateScratchDirectory,
} from './modules/platform/backup/infrastructure/workspace.js';
import { judgeDns, normaliseHost } from './modules/platform/hosting/domain/hosted-domain.js';
import { HttpsTlsProbe } from './modules/platform/hosting/infrastructure/https-tls-probe.js';
import { NodeDnsResolver } from './modules/platform/hosting/infrastructure/node-dns-resolver.js';

/**
 * `move export|import-installation|import-hosted|verify` — the container half of
 * `botctl move` (Phase 6B PR-4, ADR-0039 § 8). botctl freezes the old server, asks the bundle
 * password on the terminal (twice, hidden) and hands it over on STANDARD INPUT; this never
 * reads a password from an argument or the environment and never prints one. Progress goes
 * to stderr; the one line botctl parses goes to stdout and starts with `NEXA-MOVE `.
 */

class UsageError extends Error {}

const USAGE = [
  'usage:',
  '  move export --password-stdin [--image IMAGE]',
  '      a fresh installation backup and an archive of every hosted bot, each verified,',
  '      sealed into one bundle; prints "NEXA-MOVE bundle=PATH bytes=N sha256=HEX"',
  '  move import-installation --workspace DIR --password-stdin',
  '      opens DIR/bundle.7z, checks it, and restores the installation through the recovery',
  '      executor (source MOVE); waits until it finished',
  '  move import-hosted --workspace DIR --password-stdin [--domain D] [--here IP]...',
  '      verifies every hosted bot against the restored installation, clears the activation',
  '      marks, prints the Persian checklist',
  '  move verify [--domain D] [--here IP]...',
  '      DNS, TLS and every webhook against this server; a Persian table',
].join('\n');

type Command = 'export' | 'import-installation' | 'import-hosted' | 'verify';

export interface MoveArgs {
  readonly command: Command;
  readonly passwordStdin: boolean;
  readonly workspace: string | null;
  readonly image: string | null;
  readonly domains: readonly string[];
  readonly here: readonly string[];
}

export function parseMoveArgs(argv: readonly string[]): MoveArgs {
  const command = argv[0];
  if (
    command !== 'export' &&
    command !== 'import-installation' &&
    command !== 'import-hosted' &&
    command !== 'verify'
  ) {
    throw new UsageError(USAGE);
  }
  if (argv.some((arg) => arg === '--password' || arg.startsWith('--password='))) {
    throw new UsageError('The bundle password is read from standard input, never an argument.');
  }
  let workspace: string | null = null;
  let image: string | null = null;
  let passwordStdin = false;
  const domains: string[] = [];
  const here: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`${arg ?? ''} needs a value.`);
      }
      index += 1;
      return value;
    };
    if (arg === '--password-stdin') passwordStdin = true;
    else if (arg === '--workspace') workspace = next();
    else if (arg === '--image') image = next();
    else if (arg === '--domain') domains.push(next());
    else if (arg === '--here') here.push(next());
    else throw new UsageError(`unknown argument ${arg ?? ''}\n${USAGE}`);
  }
  if (command !== 'verify' && !passwordStdin) {
    throw new UsageError(`${command} needs --password-stdin.`);
  }
  if ((command === 'import-installation' || command === 'import-hosted') && workspace === null) {
    throw new UsageError(`${command} needs --workspace DIR.`);
  }
  return { command, passwordStdin, workspace, image, domains, here };
}

async function passwordFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new UsageError(
      'Pipe the bundle password on standard input; it is not read from a prompt.',
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const password = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
  if (password === '') throw new UsageError('--password-stdin read an empty password.');
  return password;
}

const say = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

function sevenZipOf(config: AppConfig): SevenZipOptions {
  return {
    binary: config.BACKUP_SEVEN_ZIP_BIN,
    level: config.BACKUP_SEVEN_ZIP_LEVEL,
    threads: config.BACKUP_SEVEN_ZIP_THREADS,
    memoryBudgetMb: config.BACKUP_SEVEN_ZIP_MEMORY_MB,
    memoryHeadroomMb: config.BACKUP_SEVEN_ZIP_HEADROOM_MB,
    readAvailableMb: readMemAvailableMb,
    sealTimeoutMs: config.BACKUP_DUMP_TIMEOUT_MS,
    openTimeoutMs: config.BACKUP_RESTORE_TIMEOUT_MS,
  };
}

/** The host names of `WEB_ADMIN_ORIGINS`, plus any given, normalised and unique. */
export function ownerDomainsOf(origins: readonly string[], extra: readonly string[]): string[] {
  const out = new Set<string>();
  for (const origin of origins) {
    try {
      const host = normaliseHost(new URL(origin).hostname);
      if (host !== null) out.add(host);
    } catch {
      // The config schema refuses a malformed origin.
    }
  }
  for (const name of extra) {
    const host = normaliseHost(name);
    if (host !== null) out.add(host);
  }
  return [...out];
}

function installationOf(container: Pick<Container, 'installationTenantId'>): string {
  const id = container.installationTenantId;
  if (id === null) {
    throw new NexaError({
      kind: 'PRECONDITION_FAILED',
      code: MOVE_ERROR_CODES.TARGET_NOT_FRESH,
      message: 'This database has no provisioned installation.',
    });
  }
  return id;
}

const HEAVY_QUEUE = {
  pollMs: 5_000,
  maxWaitMs: 30 * 60_000,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

async function cmdExport(container: Container, args: MoveArgs, password: string): Promise<number> {
  refuseMovePassword(password);
  if (await container.recoveryQuiesced()) {
    say('A recovery is restoring this installation; a move cannot be exported now.');
    return 4;
  }
  await pointAtInstallation(container);
  const installationTenantId = installationOf(container);
  const config = container.config;
  const root = config.BACKUP_WORK_DIR;
  const scratch = await privateScratchDirectory(root, 'move');
  const alive = keepScratchAlive(scratch);
  try {
    const migrations = await withDatabaseScope(
      { tenantId: installationTenantId as never, botInstanceId: null },
      () => migrationHead(container.database.db, migrationsFolder()),
    );
    const cname = normaliseHost(config.HOSTED_BOTS_CNAME_TARGET);
    const result = await exportMoveBundle(
      {
        installationTenantId,
        installationId: installationTenantId,
        release: config.BUILD_VERSION,
        image: args.image,
        migrations,
        now: () => container.clock.now(),
        sevenZip: sevenZipOf(config),
        environment: process.env,
        ownerDomains: ownerDomainsOf(config.WEB_ADMIN_ORIGINS, args.domains),
        cnameTarget: cname,
        serverIps: config.HOSTED_BOTS_SERVER_IPS,
        databaseBytes: () => liveDatabaseBytes(container.database),
        freeBytes: volumeFreeBytes,
        bots: () => moveBundleBots(container.database, installationTenantId),
        backupInstallation: async (sealPassword) => {
          const queued = await container.heavyJobs.runWhenAdmitted(
            'BACKUP',
            installationTenantId,
            () =>
              container.backup.run('MOVE', {
                deliver: false,
                localOnly: 'SERVER_MOVE',
                sealPassword,
              }),
            HEAVY_QUEUE,
          );
          if (!queued.ran || queued.result.kind !== 'COMPLETED') return null;
          const run = queued.result.run;
          return { run, archivePath: join(root, run.id, 'archive.7z') };
        },
        archiveHosted: async (tenantId, sealPassword) => {
          const outcome = await container.tenantArchives.run({
            tenantId,
            trigger: 'MOVE',
            password: sealPassword,
          });
          if (outcome.kind !== 'COMPLETED') return null;
          const run = outcome.run;
          return { run, archivePath: join(root, 'hosted', tenantId, run.id, 'archive.7z') };
        },
        progress: say,
      },
      { password, workDirectory: join(scratch, 'work') },
    );
    say(
      `bundle sealed: ${String(result.manifest.members.length)} member(s), ` +
        `${String(result.manifest.bots.filter((bot) => bot.kind === 'HOSTED').length)} hosted bot(s)`,
    );
    process.stdout.write(
      `NEXA-MOVE bundle=${result.bundlePath} bytes=${String(result.bytes)} sha256=${result.sha256}\n`,
    );
    return 0;
  } catch (error) {
    // Nothing of a failed export stays: the work directory with every member goes.
    await rm(scratch, { recursive: true, force: true });
    throw error;
  } finally {
    alive.stop();
  }
}

// ---------------------------------------------------------------------------
// import, step 1: the installation
// ---------------------------------------------------------------------------

const TERMINAL = new Set(['SUCCEEDED', 'FAILED']);
const RESTORE_WAIT_MS = 12 * 60 * 60_000;

async function cmdImportInstallation(
  container: Container,
  workspace: string,
  password: string,
): Promise<number> {
  await pointAtInstallation(container);
  const alive = keepScratchAlive(workspace);
  try {
    const opened = await openMoveBundle({
      bundlePath: join(workspace, 'bundle.7z'),
      password,
      directory: join(workspace, 'open'),
      sevenZip: sevenZipOf(container.config),
      freeBytes: () => volumeFreeBytes(workspace),
    });
    // The bundle file itself is not needed past the open: its members are checked on disk.
    await rm(join(workspace, 'bundle.7z'), { force: true });
    say(
      `bundle opened: ${String(opened.manifest.members.length)} member(s), taken ` +
        `${opened.manifest.createdAt} by release ${opened.manifest.source.release}`,
    );
    refuseBundleHead(opened.manifest, expectedMigrations(migrationsFolder()));
    const business = await moveTargetBusiness(container.database);
    if (!isFreshTarget(business)) {
      throw new NexaError({
        kind: 'PRECONDITION_FAILED',
        code: MOVE_ERROR_CODES.TARGET_NOT_FRESH,
        message:
          'This server already runs a business (a hosted bot, a customer, an order or a wallet ' +
          'entry). move import never merges: install a fresh server.',
        details: { ...business },
      });
    }
    const member = opened.manifest.members.find((candidate) => candidate.kind === 'INSTALLATION');
    if (member === undefined) throw new UsageError('the bundle has no installation member');
    say('restoring the installation through the recovery executor (verify, restore-test)');
    const requested = await container.recoveryService.requestMove({
      archivePath: opened.memberPath(member),
      password,
    });
    if (requested.failureCode !== null) {
      throw new NexaError({
        kind: 'PRECONDITION_FAILED',
        code: MOVE_ERROR_CODES.INSTALLATION_RESTORE_FAILED,
        message: `The installation member did not pass its verification (${requested.failureCode}).`,
        details: { recoveryId: requested.request.id, failureCode: requested.failureCode },
      });
    }
    return await waitForRecovery(container, requested.request.id);
  } finally {
    alive.stop();
  }
}

async function waitForRecovery(container: Container, id: string): Promise<number> {
  say(`recovery ${id} confirmed; the recovery role restores it now (this can take a while)`);
  const started = Date.now();
  let lastStage = '';
  let unclaimedSince: number | null = null;
  for (;;) {
    // The cutover terminates this process's connections and renames the database under
    // them: a failed read here is the expected moment, retried, never a verdict.
    const row = await container.recoveryRequests.byIdUnscoped(id).catch(() => null);
    if (row !== null) {
      const where = `${row.state}/${row.stage}`;
      if (where !== lastStage) {
        say(`  ${where}`);
        lastStage = where;
      }
      if (TERMINAL.has(row.state)) {
        if (row.state === 'SUCCEEDED') return 0;
        throw new NexaError({
          kind: 'INTERNAL',
          code: MOVE_ERROR_CODES.INSTALLATION_RESTORE_FAILED,
          message: `The installation restore failed (${row.failureCode ?? 'unknown'}).`,
          details: {
            recoveryId: id,
            failureCode: row.failureCode,
            displacedDatabase: row.displacedDatabase,
          },
        });
      }
      if (row.state === 'RESTORE_REQUESTED' && row.leaseOwner === null) {
        unclaimedSince ??= Date.now();
        if (Date.now() - unclaimedSince > 120_000) {
          say('  still waiting for the recovery role to claim it — is it running? (botctl status)');
          unclaimedSince = Date.now();
        }
      }
    }
    if (Date.now() - started > RESTORE_WAIT_MS) {
      say(`gave up waiting after 12 hours; follow recovery ${id} in the Web Admin`);
      return 3;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

// ---------------------------------------------------------------------------
// import, step 2: the hosted bots, the marks, the checklist
// ---------------------------------------------------------------------------

function hostsHere(config: AppConfig, here: readonly string[]): string[] {
  return [...new Set([...here, ...config.HOSTED_BOTS_SERVER_IPS].map((ip) => ip.toLowerCase()))];
}

function cnameTargetOf(config: AppConfig): string | null {
  return (
    normaliseHost(config.HOSTED_BOTS_CNAME_TARGET) ??
    ownerDomainsOf(config.WEB_ADMIN_ORIGINS.slice(0, 1), [])[0] ??
    null
  );
}

async function cmdImportHosted(
  container: Container,
  args: MoveArgs,
  workspace: string,
  password: string,
): Promise<number> {
  await pointAtInstallation(container);
  const installationTenantId = installationOf(container);
  const alive = keepScratchAlive(workspace);
  try {
    const bundle = await reopenMoveBundle(join(workspace, 'open'));
    const installationMember = bundle.manifest.members.find(
      (member) => member.kind === 'INSTALLATION',
    );
    if (installationMember?.tenantId !== installationTenantId) {
      throw new NexaError({
        kind: 'PRECONDITION_FAILED',
        code: MOVE_ERROR_CODES.INSTALLATION_RESTORE_FAILED,
        message: 'The live installation is not the one the bundle carries; was it restored?',
      });
    }
    const sevenZip = sevenZipOf(container.config);
    const result = await verifyHostedMembers(
      {
        installationTenantId,
        presence: (tenantId) =>
          hostedTenantPresence(container.database, installationTenantId, tenantId),
        openMember: async (member, fn) => {
          const directory = join(workspace, 'verify', member.tenantId);
          await mkdir(directory, { recursive: true, mode: 0o700 });
          try {
            const opened = await openTenantArchive({
              archivePath: bundle.memberPath(member),
              password,
              directory,
              sevenZip,
              limits: {
                maxExtractedBytes: 32 * 1024 ** 3,
                headroomBytes: 1024 ** 3,
                freeBytes: () => volumeFreeBytes(directory),
              },
            });
            try {
              return await fn(opened.manifest, await archiveCanonicalDigests(opened));
            } finally {
              opened.keyMaterial.fill(0);
            }
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        },
        live: (tenantId, manifest) =>
          liveTenantDigest(container.database, tenantId, manifest, container.cipher),
        progress: say,
      },
      bundle,
    );
    for (const done of result.verified) {
      say(`hosted ${done.tenantId}: identical (${String(done.tables)} tables)`);
    }
    const kept: string[] = [];
    if (result.missing.length > 0) {
      const directory = join(container.config.BACKUP_WORK_DIR, 'move-unrestored');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const tenantId of result.missing) {
        const member = bundle.manifest.members.find((candidate) => candidate.tenantId === tenantId);
        if (member === undefined) continue;
        const destination = join(directory, `${tenantId}.7z`);
        await copyFile(bundle.memberPath(member), destination);
        kept.push(destination);
      }
    }

    // The marks were earned on the OLD server: DNS, TLS and webhook are earned again here.
    const scope = {
      tenantId: installationTenantId,
      botInstanceId: null,
    } as unknown as ScopeContext;
    const actor = systemJobActor('server-move', newCorrelationId(container.ids.uuid()));
    const cleared = await withDatabaseScope(scope, () =>
      container.database.db.transaction(async (tx) => {
        if (!(await container.tenants.scopeIsActive(scope, tx))) {
          throw new NexaError({
            kind: 'PRECONDITION_FAILED',
            code: MOVE_ERROR_CODES.INSTALLATION_RESTORE_FAILED,
            message: 'The restored installation is not accepting work.',
          });
        }
        const n = await clearActivationMarks(tx, installationTenantId, container.clock.now());
        await container.audit.record(
          scope,
          actor,
          {
            action: 'hosting.move_marks_cleared',
            entityType: 'HostedBot',
            entityId: null,
            before: null,
            after: { cleared: n, hostedVerified: result.verified.length },
            reason: 'botctl move import: activation marks earned on the old server were cleared.',
            result: 'SUCCESS',
          },
          tx,
        );
        return n;
      }),
    );
    say(`activation marks cleared on ${String(cleared)} hosted bot(s)`);
    process.stdout.write(
      importReportFa({
        manifest: bundle.manifest,
        checklist: moveChecklistFa({
          ownerDomains: ownerDomainsOf(container.config.WEB_ADMIN_ORIGINS, args.domains),
          serverAddresses: hostsHere(container.config, args.here),
          cnameTarget: cnameTargetOf(container.config),
          hostedDomains: bundle.manifest.bots
            .filter((bot) => bot.kind === 'HOSTED' && bot.domain !== null)
            .map((bot) => ({ domain: bot.domain ?? '', username: bot.username })),
          bots: bundle.manifest.bots,
          secretNames: bundle.manifest.environment.secretNames,
        }),
        kept,
      }),
    );
    return kept.length > 0 ? 2 : 0;
  } finally {
    alive.stop();
  }
}

export function importReportFa(input: {
  readonly manifest: MoveBundleManifest;
  readonly checklist: string;
  readonly kept: readonly string[];
}): string {
  const lines = ['', 'انتقال وارد شد. ربات‌های میزبانی‌شده با بکاپ نصب یکی بودند.', ''];
  if (input.kept.length > 0) {
    lines.push('این ربات‌ها در بکاپ نصب نبودند و بازیابی نشدند. هر فایل را در «میزبانی‌ها» ←');
    lines.push('«بازیابی ربات از فایل» با همان رمز بسته بازیابی کنید:');
    for (const path of input.kept) lines.push(`  ${path}`);
    lines.push('');
  }
  const values = Object.entries(input.manifest.environment.values);
  if (values.length > 0) {
    lines.push('تنظیمات سرور قدیمی (برای مقایسه با /etc/nexa/nexa.env این سرور):');
    for (const [key, value] of values) lines.push(`  ${key}=${value}`);
    lines.push('');
  }
  lines.push('نقش‌های provisioner و monitor خاموش مانده‌اند.', '');
  return `${lines.join('\n')}\n${input.checklist}`;
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

interface VerifyRow {
  readonly name: string;
  readonly dns: boolean | null;
  readonly tls: boolean | null;
}

async function cmdVerify(container: Container, args: MoveArgs): Promise<number> {
  await pointAtInstallation(container);
  const installationTenantId = installationOf(container);
  const config = container.config;
  const here = hostsHere(config, args.here);
  const target = cnameTargetOf(config);
  const dns = new NodeDnsResolver();
  const tls = new HttpsTlsProbe(15_000);
  const owner = ownerDomainsOf(config.WEB_ADMIN_ORIGINS, args.domains);
  const activations = await hostedActivations(container.database, installationTenantId);
  const targetAddresses =
    target === null ? [] : await dns.addressesOf(target).catch(() => [] as readonly string[]);

  const rows: VerifyRow[] = [];
  const check = async (name: string, hostname: string | null, addresses: readonly string[]) => {
    const observed = await dns.observe(name).catch(() => null);
    const pointed = observed !== null && judgeDns(observed, { hostname, addresses }) === 'POINTED';
    const secure = pointed ? (await tls.probe(name)).ok : null;
    rows.push({ name, dns: observed === null ? null : pointed, tls: secure });
  };
  for (const name of owner) await check(name, null, here);
  for (const activation of activations) {
    if (activation.domain === null) continue;
    await check(activation.domain, target, [...here, ...targetAddresses]);
  }

  const bots = await moveBundleBots(container.database, installationTenantId);
  const webhooks: { name: string; ready: boolean; at: string | null }[] = [];
  const installationHost = owner[0] ?? null;
  for (const bot of bots) {
    if (bot.botInstanceId === null || (bot.kind === 'HOSTED' && bot.state === 'DELETED')) continue;
    const expected = bot.kind === 'INSTALLATION' ? installationHost : bot.domain;
    let at: string | null = null;
    try {
      const token = await container.botInstances.resolveToken(
        { tenantId: bot.tenantId as never, botInstanceId: null },
        bot.botInstanceId as never,
      );
      const info = await telegramGetWebhookInfo({
        token,
        apiBaseUrl: config.TELEGRAM_API_BASE_URL,
        timeoutMs: 10_000,
      });
      if (info.outcome === 'SUCCEEDED' && info.info.url !== null) {
        at = normaliseHost(new URL(info.info.url).hostname);
      }
    } catch {
      at = null;
    }
    webhooks.push({
      name: `@${bot.username ?? bot.tenantId}`,
      ready: at !== null && at === expected,
      at,
    });
  }
  process.stdout.write(verifyTableFa(rows, webhooks));
  const ready =
    rows.every((row) => row.dns === true && row.tls === true) &&
    webhooks.every((hook) => hook.ready);
  return ready ? 0 : 2;
}

export function verifyTableFa(
  rows: readonly VerifyRow[],
  webhooks: readonly {
    readonly name: string;
    readonly ready: boolean;
    readonly at: string | null;
  }[],
): string {
  const word = (value: boolean | null): string =>
    value === null ? '—' : value ? 'آماده' : 'نه هنوز';
  const lines = ['دامنه                                  DNS        TLS'];
  for (const row of rows) {
    lines.push(`${row.name.padEnd(38)} ${word(row.dns).padEnd(10)} ${word(row.tls)}`);
  }
  lines.push('', 'ربات                                   وب‌هوک');
  for (const hook of webhooks) {
    const where = hook.ready || hook.at === null ? '' : ` (اکنون: ${hook.at})`;
    lines.push(`${hook.name.padEnd(38)} ${word(hook.ready)}${where}`);
  }
  const allReady =
    rows.every((row) => row.dns === true && row.tls === true) &&
    webhooks.every((hook) => hook.ready);
  lines.push(
    '',
    allReady
      ? 'همه‌چیز به این سرور اشاره می‌کند. حالا: sudo botctl roles enable provisioner monitor'
      : 'هنوز همه آماده نیستند. DNS را بررسی کنید، سپس sudo botctl telegram register و دوباره این فرمان.',
  );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseMoveArgs(process.argv.slice(2));
  const password = args.passwordStdin ? await passwordFromStdin() : '';
  const config = loadConfig();
  const container = createContainer(config, 'worker');
  try {
    if (args.command === 'export') process.exitCode = await cmdExport(container, args, password);
    else if (args.command === 'import-installation')
      process.exitCode = await cmdImportInstallation(container, args.workspace ?? '', password);
    else if (args.command === 'import-hosted')
      process.exitCode = await cmdImportHosted(container, args, args.workspace ?? '', password);
    else process.exitCode = await cmdVerify(container, args);
  } finally {
    await container.shutdown();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((error: unknown) => {
      if (error instanceof UsageError) {
        console.error(error.message);
        process.exit(64);
      }
      if (isNexaError(error)) {
        // The code and the author-controlled message; details name a table or a tenant,
        // never a value or a password.
        console.error(`${error.code}: ${error.message}`);
        if (error.details !== undefined) console.error(JSON.stringify(error.details));
        process.exit(1);
      }
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

export { UsageError, USAGE };
