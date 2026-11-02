import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ActorContext,
  CorrelationId,
  LegacyMigrationImportView,
  TenantContext,
  TenantId,
} from '@nexa/contracts';
import { resolveInstallationTenant } from './bootstrap.js';
import { createContainer, type Container } from './container.js';
import {
  TargetRefused,
  UsageError,
  readMirzaSide,
  reconcileTargetUrl,
} from './cutover-reconcile.cli.js';
import {
  freshTargetCounts,
  quietFacts,
  runImport,
  sha256OfFile,
  standinAddress,
  withMaintenance,
  type RunningStandin,
} from './cutover-rehearse-import.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import type { NxpkgSecret } from './infrastructure/nxpkg/index.js';
import { checkMigrations, runMigrations } from './infrastructure/persistence/migrate.js';
import {
  REHEARSAL_FORCED_SETTINGS,
  defaultRehearsalDatabase,
  messagingProblems,
  outcomeLines,
  quietProblems,
  rehearsalEnvironment,
  rehearsalExitCode,
  rehearsalOutcome,
  stepLines,
  type RehearsalOutcome,
  type RehearsalQuiet,
  type RehearsalStep,
  type RehearsalStepStatus,
} from './modules/platform/legacy-cutover/application/cutover-rehearsal.js';
import {
  cutoverReportText,
  reconcileCutover,
  type CutoverReconciliation,
} from './modules/platform/legacy-cutover/application/cutover-reconciliation.js';
import {
  reconcileServices,
  serviceReportText,
  type ServiceReconciliation,
} from './modules/platform/legacy-cutover/application/cutover-service-reconciliation.js';
import {
  readNexaCutoverState,
  readNexaServiceState,
} from './modules/platform/legacy-cutover/infrastructure/pg-cutover-reconciliation.reader.js';
import { RehearsalOutboundGuard } from './modules/platform/legacy-cutover/infrastructure/rehearsal-outbound-guard.js';
import { errorKind } from './modules/platform/legacy-migration/domain/import-lifecycle.js';
import { provisionInstallation } from './provision-installation.cli.js';

/**
 * `pnpm cutover-rehearse` (`node dist/cutover-rehearse.cli.js`; `sudo botctl cutover
 * rehearse` on a host) — the MirzaBot → NEXA cutover runbook (`docs/cutover/`), rehearsed
 * end to end against a DISPOSABLE database this command creates, and never anything else.
 *
 * What it runs, in the runbook's order (`docs/cutover/12-rehearsal.md`):
 *
 *   02 freeze, equivalent  the target is not the live database; this process's messaging
 *                          channels are off and its outbound `fetch` is walled off; the
 *                          package's SHA-256 is taken (and taken again at the end)
 *   01/04 I2               a NEW database is created, migrated (`current`), provisioned (one
 *                          PRIMARY tenant, IRT), and proven fresh (no customer, ledger entry,
 *                          payment, order or bot)
 *   04 I3–I7               the import, through the SAME service and executor the restore page
 *                          and the `recovery` role use: upload, key, verify, panel binding,
 *                          dry run, the owner's approval, apply (protective backup, write
 *                          freeze, history, resellers with no credit, reconcile, final report,
 *                          post-import backup) — the panels are read-only stand-ins in this
 *                          process (`deploy/rehearsal/rickpanel-standin.mjs`), never a real one
 *   05 C3–C5               the balance reconciliation (`cutover-reconcile`'s own rules, zero
 *                          tolerance, agent credit listed and never credited, reseller credit
 *                          zero) and the SERVICE reconciliation, Mirza package vs NEXA
 *   06                     SKIPPED, always: no token, no webhook, no bot
 *   07                     dry: no background role is started; what they would start from is
 *                          checked quiet (no customer notification, no outbox publication, no
 *                          provisioning operation, no bot, no outbound call, no panel write)
 *
 * and then drops the database it created (`--keep-database` keeps it for inspection), and
 * prints the report and a go/no-go.
 *
 * NEVER: the live database (refused by name, and refused when it equals `DATABASE_URL`'s),
 * an existing database (refused: it neither reuses nor drops one it did not create), the
 * token handover, a webhook change, the bot or the worker against the rehearsal database, a
 * Telegram call, a customer message, a real panel, the live tenant.
 *
 *   --package PATH                 the Mirza `.nxpkg` (the final export)
 *   --package-key-env NAME         the variable holding the key file's text, or
 *   --package-passphrase-env NAME  the variable holding the passphrase (never argv)
 *   --owner-telegram-id N          the rehearsing owner's numeric Telegram id: the owner the
 *                                  approval is recorded under, in the disposable database only
 *   --database NAME                the disposable database (default nexa_cutover_rehearsal_<UTC>);
 *                                  must carry a non-production word and must not exist yet
 *   --keep-database                keep it afterwards (default: dropped)
 *   --panel-inventory FILE         JSON {"<code_panel>": [accounts…]} the stand-ins serve
 *                                  (default: empty — every live Mirza service is held as
 *                                  PROVIDER_MISSING, the expected stage-A result)
 *   --standin-host ADDR            the address the stand-ins listen on (default: loopback where
 *                                  the configuration allows it, else this host's first private
 *                                  address the panel policy allows)
 *   --work-dir DIR                 where its private working directory is made (default: tmp)
 *   --json                         the whole report as one JSON document
 *   --list-differences             also list each difference (NEXA ids, Mirza row numbers,
 *                                  amounts — never a Telegram id). Terminal only.
 *   --timeout-ms N                 the reconciliation's statement timeout (default 600000)
 *
 * Exit: 0 GO, 2 GO_WITH_HELD (rows held for review: each class signed off by name), 3 NO_GO,
 * 64 usage, 65 refused target, 1 anything else. Progress goes to stderr; stdout is the report.
 */

export interface RehearseArgs {
  readonly packagePath: string;
  readonly packageKeyEnv: string | null;
  readonly packagePassphraseEnv: string | null;
  readonly ownerTelegramId: string;
  readonly database: string | null;
  readonly keepDatabase: boolean;
  readonly panelInventory: string | null;
  readonly standinHost: string | null;
  readonly workDir: string | null;
  readonly json: boolean;
  readonly listDifferences: boolean;
  readonly timeoutMs: number;
}

const VALUE_FLAGS = new Set([
  '--package',
  '--package-key-env',
  '--package-passphrase-env',
  '--owner-telegram-id',
  '--database',
  '--panel-inventory',
  '--standin-host',
  '--work-dir',
  '--timeout-ms',
]);
const BOOLEAN_FLAGS = new Set(['--keep-database', '--json', '--list-differences']);
/** Lowercase only: the name is quoted into CREATE / DROP DATABASE. */
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;

export function parseRehearseArgs(argv: readonly string[]): RehearseArgs {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] as string;
    if (BOOLEAN_FLAGS.has(flag)) {
      booleans.add(flag);
      continue;
    }
    // Nothing from argv is echoed back: a mistyped secret must not land in a terminal log.
    if (!VALUE_FLAGS.has(flag)) {
      throw new UsageError(`unknown argument at position ${String(i + 1)}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${flag} needs a value.`);
    }
    if (values.has(flag)) throw new UsageError(`${flag} was given twice.`);
    values.set(flag, value);
    i += 1;
  }
  const packagePath = values.get('--package');
  if (packagePath === undefined) throw new UsageError('--package PATH is required.');
  const packageKeyEnv = values.get('--package-key-env') ?? null;
  const packagePassphraseEnv = values.get('--package-passphrase-env') ?? null;
  if ((packageKeyEnv === null) === (packagePassphraseEnv === null)) {
    throw new UsageError(
      'exactly one of --package-key-env or --package-passphrase-env is required.',
    );
  }
  for (const name of [packageKeyEnv, packagePassphraseEnv]) {
    if (name !== null && !ENV_NAME.test(name)) {
      throw new UsageError('--package-key-env / --package-passphrase-env name a variable.');
    }
  }
  const ownerTelegramId = values.get('--owner-telegram-id');
  if (ownerTelegramId === undefined || !/^[1-9][0-9]{4,15}$/u.test(ownerTelegramId)) {
    throw new UsageError('--owner-telegram-id must be the owner’s numeric Telegram id.');
  }
  const database = values.get('--database') ?? null;
  if (database !== null && !DATABASE_NAME.test(database)) {
    throw new UsageError('--database must be a plain lowercase database name.');
  }
  const timeout = values.get('--timeout-ms') ?? '600000';
  if (!/^[0-9]{4,7}$/u.test(timeout)) throw new UsageError('--timeout-ms must be 1000..9999999.');
  return {
    packagePath,
    packageKeyEnv,
    packagePassphraseEnv,
    ownerTelegramId,
    database,
    keepDatabase: booleans.has('--keep-database'),
    panelInventory: values.get('--panel-inventory') ?? null,
    standinHost: values.get('--standin-host') ?? null,
    workDir: values.get('--work-dir') ?? null,
    json: booleans.has('--json'),
    listDifferences: booleans.has('--list-differences'),
    timeoutMs: Number(timeout),
  };
}

/**
 * The disposable target: `DATABASE_URL` with only its database replaced. Refused
 * (`TargetRefused`, exit 65) when the name looks like production (`cutover-reconcile`'s own
 * rule) or IS the live database `DATABASE_URL` names — whatever word it carries. The second
 * rule is the one that keeps a live database named, say, `nexa_staging` out of reach.
 */
export function rehearsalTarget(
  liveUrl: string | undefined,
  database: string,
): { readonly url: string; readonly maintenanceUrl: string; readonly live: string } {
  const { url } = reconcileTargetUrl(liveUrl, database);
  const live = new URL(liveUrl as string);
  const liveName = decodeURIComponent(live.pathname.replace(/^\//u, ''));
  if (liveName === database) {
    throw new TargetRefused(
      `Refused: ${database} is the live database DATABASE_URL names. The rehearsal only ever ` +
        'creates and uses a NEW database of its own.',
    );
  }
  if (database === 'postgres' || database.startsWith('template')) {
    throw new TargetRefused(`Refused: ${database} is a PostgreSQL system database.`);
  }
  const maintenance = new URL(liveUrl as string);
  maintenance.pathname = '/postgres';
  return { url, maintenanceUrl: maintenance.toString(), live: liveName };
}

/** The package secret from the variable the operator named — never argv. */
function packageSecret(args: RehearseArgs, env: NodeJS.ProcessEnv): NxpkgSecret {
  const name = (args.packageKeyEnv ?? args.packagePassphraseEnv) as string;
  const value = env[name];
  if (value === undefined || value === '') throw new UsageError(`${name} is not set.`);
  return args.packageKeyEnv !== null ? { keyFileText: value } : { passphrase: value };
}

/** `--panel-inventory`: `{"<code_panel>": [account, …]}`, each account an object. */
export function parsePanelInventory(text: string): ReadonlyMap<string, readonly unknown[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError('--panel-inventory is not JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError('--panel-inventory must be an object: {"<code_panel>": [accounts]}.');
  }
  const inventory = new Map<string, readonly unknown[]>();
  for (const [code, accounts] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(accounts)) {
      throw new UsageError('--panel-inventory: every panel code maps to an array of accounts.');
    }
    inventory.set(code, accounts);
  }
  return inventory;
}

// --- the run ----------------------------------------------------------------------------

/** Test seams. Production passes none. */
export interface RehearsalSeams {
  /** After the tenant and its owner exist, before the import (a test's tariff product). */
  readonly afterProvision?: (context: RehearsalContext) => Promise<void>;
  /** After the stand-in panels exist, before the dry run (a test's tariff product). */
  readonly afterPanels?: (
    context: RehearsalContext,
    panels: readonly { readonly codePanel: string; readonly panelId: string }[],
  ) => Promise<void>;
  /** After the import, before the reconciliation (a test's deliberate mismatch). */
  readonly afterImport?: (context: RehearsalContext) => Promise<void>;
}

export interface RehearsalContext {
  readonly container: Container;
  readonly scope: TenantContext;
  readonly owner: ActorContext;
  readonly databaseUrl: string;
}

export interface RehearsalResult {
  readonly exitCode: number;
  readonly database: string;
  readonly kept: boolean;
  readonly steps: readonly RehearsalStep[];
  readonly quiet: RehearsalQuiet | null;
  readonly balances: CutoverReconciliation | null;
  readonly services: ServiceReconciliation | null;
  readonly outcome: RehearsalOutcome;
  readonly importView: LegacyMigrationImportView | null;
  /** The configuration the rehearsal ran with: its messaging channels, for the record. */
  readonly messaging: Readonly<Record<keyof typeof REHEARSAL_FORCED_SETTINGS, string>>;
}

/**
 * The rehearsal, as a function: `out` receives the report, `progress` one line per step.
 * Throws only before anything was created (`UsageError`, `TargetRefused`); from then on every
 * failure is a FAIL step and the database it created is still dropped (unless kept).
 */
export async function runCutoverRehearsal(
  args: RehearseArgs,
  env: NodeJS.ProcessEnv,
  io: { readonly out: (text: string) => void; readonly progress: (text: string) => void },
  seams: RehearsalSeams = {},
): Promise<RehearsalResult> {
  // -- refusals, before anything exists -----------------------------------------------------
  const database = args.database ?? defaultRehearsalDatabase(new Date());
  const target = rehearsalTarget(env['DATABASE_URL'], database);
  const secret = packageSecret(args, env);
  const inventory =
    args.panelInventory === null
      ? new Map<string, readonly unknown[]>()
      : parsePanelInventory(await readFile(args.panelInventory, 'utf8'));
  await stat(args.packagePath);
  const exists = await withMaintenance(target.maintenanceUrl, async (client) => {
    const r = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    return r.rowCount !== 0;
  });
  if (exists) {
    throw new TargetRefused(
      `Refused: ${database} already exists. The rehearsal never reuses, empties or drops a ` +
        'database it did not create: name a new one, or drop that one yourself.',
    );
  }

  const steps: RehearsalStep[] = [];
  const step = (page: string, name: string, status: RehearsalStepStatus, detail: string) => {
    const s: RehearsalStep = { page, name, status, detail };
    steps.push(s);
    io.progress(stepLines([s]));
    return status !== 'FAIL';
  };
  const fail = (page: string, name: string, error: unknown): false => {
    const kind = errorKind(error);
    step(page, name, 'FAIL', `${kind.type}${kind.code === null ? '' : ` ${kind.code}`}`);
    return false;
  };

  step(
    '02',
    'target',
    'PASS',
    `${database} is new, carries a non-production word, and is not the live database (${target.live})`,
  );

  const workRoot = await mkdtemp(join(args.workDir ?? tmpdir(), 'nexa-cutover-rehearsal-'));
  await chmod(workRoot, 0o700);
  const config = loadConfig(
    rehearsalEnvironment(env, { databaseUrl: target.url, workDir: workRoot }),
  );
  const messaging = Object.fromEntries(
    Object.keys(REHEARSAL_FORCED_SETTINGS).map((k) => [
      k,
      String((config as unknown as Record<string, unknown>)[k] ?? ''),
    ]),
  ) as RehearsalResult['messaging'];
  const telegramHost = new URL(config.TELEGRAM_API_BASE_URL).hostname.toLowerCase();
  const guard = new RehearsalOutboundGuard([...new Set(['telegram.org', telegramHost])]);
  guard.install();

  const problems = messagingProblems(config);
  let proceed = step(
    '02',
    'messaging',
    problems.length === 0 ? 'PASS' : 'FAIL',
    problems.length === 0
      ? 'notification dispatch, webhook, backup delivery, schedule, provisioner, monitor: off; every outbound fetch refused'
      : problems.join('; '),
  );

  let packageSha: string | null = null;
  if (proceed) {
    try {
      packageSha = await sha256OfFile(args.packagePath);
      proceed = step('03', 'package', 'PASS', `sha256 ${packageSha} (finalDumpSha256)`);
    } catch (error) {
      proceed = fail('03', 'package', error);
    }
  }

  let created = false;
  let container: Container | null = null;
  const standins: RunningStandin[] = [];
  let quiet: RehearsalQuiet | null = null;
  let balances: CutoverReconciliation | null = null;
  let services: ServiceReconciliation | null = null;
  let importView: LegacyMigrationImportView | null = null;
  try {
    // -- 01/04 I2: a NEW database, migrated, provisioned, fresh ----------------------------
    if (proceed) {
      try {
        await withMaintenance(target.maintenanceUrl, (client) =>
          client.query(`CREATE DATABASE "${database}"`),
        );
        created = true;
        await runMigrations(target.url);
        const verdict = await checkMigrations(target.url);
        proceed = step(
          '01',
          'database',
          verdict.state === 'current' ? 'PASS' : 'FAIL',
          `created ${database}; migrations ${verdict.state}`,
        );
      } catch (error) {
        proceed = fail('01', 'database', error);
      }
    }

    let scope: TenantContext | null = null;
    let owner: ActorContext | null = null;
    if (proceed) {
      try {
        const provisioned = await provisionInstallation(target.url, {
          slug: 'cutover-rehearsal',
          displayName: 'Cutover rehearsal',
          locale: 'fa',
          timezone: 'Asia/Tehran',
          calendar: 'jalali',
          currency: 'IRT',
        });
        container = createContainer(config, 'migration', { logTo: 'stderr' });
        await resolveInstallationTenant(container);
        scope = { tenantId: provisioned.tenantId as TenantId, botInstanceId: null };
        const bootstrapped = await container.bootstrapOwner.execute(scope, {
          username: 'cutover-rehearsal',
          displayName: 'Cutover rehearsal',
          // Nobody signs in with it: it is never printed, and the database is disposable.
          password: randomBytes(24).toString('base64url'),
          telegramUserId: args.ownerTelegramId,
        });
        owner = {
          type: 'WEB_ADMIN',
          id: bootstrapped.adminId,
          label: bootstrapped.username,
          surface: 'WEB',
          correlationId: `cutover-rehearsal-${randomBytes(8).toString('hex')}` as CorrelationId,
          requestId: 'cutover-rehearse',
        };
        await seams.afterProvision?.({
          container,
          scope,
          owner,
          databaseUrl: target.url,
        });
        const fresh = await freshTargetCounts(container);
        const dirty = Object.entries(fresh).filter(([, n]) => n !== 0);
        proceed = step(
          '04',
          'fresh-target',
          dirty.length === 0 ? 'PASS' : 'FAIL',
          `tenant cutover-rehearsal (IRT); ${Object.entries(fresh)
            .map(([k, n]) => `${k} ${String(n)}`)
            .join(', ')}`,
        );
      } catch (error) {
        proceed = fail('04', 'fresh-target', error);
      }
    }

    // -- 04 I3–I7: the import, through the restore page's own service and executor ----------
    if (proceed && container !== null && scope !== null && owner !== null) {
      const context: RehearsalContext = { container, scope, owner, databaseUrl: target.url };
      const afterPanels = seams.afterPanels;
      try {
        importView = await runImport(container, scope, owner, {
          packagePath: args.packagePath,
          secret,
          inventory,
          standinHost: args.standinHost ?? standinAddress(config),
          standins,
          step,
          ...(afterPanels === undefined
            ? {}
            : { afterPanels: (panels) => afterPanels(context, panels) }),
        });
        proceed = step(
          '04',
          'import',
          importView.status === 'COMPLETED' ? 'PASS' : 'FAIL',
          `${importView.status}${importView.errorCode === null ? '' : ` ${importView.errorCode}`}; ` +
            `protective backup ${importView.preImportBackupRunId === null ? 'none' : 'taken'}; ` +
            `post-import backup ${importView.backupRunId === null ? 'none' : 'taken'}`,
        );
      } catch (error) {
        proceed = fail('04', 'import', error);
      }
    }

    // -- 05: the reconciliation, Mirza package vs NEXA --------------------------------------
    if (
      container !== null &&
      scope !== null &&
      owner !== null &&
      importView !== null &&
      (importView.status === 'COMPLETED' || importView.status === 'COMPLETED_WITH_DISCREPANCY')
    ) {
      try {
        await seams.afterImport?.({ container, scope, owner, databaseUrl: target.url });
        const mirza = await readMirzaSide(args.packagePath, secret, workRoot);
        const options = { tenantSlug: null, statementTimeoutMs: args.timeoutMs };
        const nexa = await readNexaCutoverState(container.database, options);
        balances = reconcileCutover({ ...mirza, ...nexa });
        const nexaServices = await readNexaServiceState(container.database, options);
        services = reconcileServices({
          mirza: mirza.serviceInvoices,
          candidates: nexaServices.candidates,
          services: nexaServices.services,
        });
        step(
          '05',
          'reconciliation',
          balances.verdict === 'DIFFERENCES' || services.verdict === 'DIFFERENCES'
            ? 'FAIL'
            : 'PASS',
          `balances ${balances.verdict}; services ${services.verdict}; reseller credit ` +
            `${String(balances.agents.resellers)} reseller(s), agent credit listed not credited ` +
            `${String(balances.agents.creditListedNotCredited.rows)} row(s)`,
        );
      } catch (error) {
        fail('05', 'reconciliation', error);
      }
    }

    // -- 06 never; 07 dry --------------------------------------------------------------------
    step('06', 'token-handover', 'SKIP', 'never in a rehearsal: no token, no webhook, no bot');
    if (container !== null) {
      try {
        quiet = await quietFacts(container, guard, standins);
        const loud = quietProblems(quiet);
        step(
          '10',
          'no-messages',
          loud.length === 0 ? 'PASS' : 'FAIL',
          loud.length === 0
            ? 'customer notifications 0, broadcasts 0, outbox published 0, operator alerts sent 0, Telegram calls 0, outbound requests 0, panel writes 0'
            : loud.join('; '),
        );
      } catch (error) {
        fail('10', 'no-messages', error);
      }
      step(
        '07',
        'background-roles',
        'SKIP',
        `dry: provisioner, monitor, customer link and sales are not started; provisioning operations ${String(quiet?.provisioningOperations ?? '?')}`,
      );
    }
    if (packageSha !== null) {
      try {
        const again = await sha256OfFile(args.packagePath);
        step(
          '03',
          'package-unchanged',
          again === packageSha ? 'PASS' : 'FAIL',
          again === packageSha
            ? 'the same SHA-256 at the end'
            : 'the package changed during the run',
        );
      } catch (error) {
        fail('03', 'package-unchanged', error);
      }
    }
  } finally {
    guard.uninstall();
    for (const s of standins) await new Promise<void>((resolve) => s.server.close(() => resolve()));
    if (container !== null) await container.shutdown();
    if (created && !args.keepDatabase) {
      try {
        await withMaintenance(target.maintenanceUrl, (client) =>
          client.query(`DROP DATABASE "${database}" WITH (FORCE)`),
        );
        step('--', 'cleanup', 'PASS', `${database} dropped (it was created by this run)`);
      } catch (error) {
        fail('--', 'cleanup', error);
      }
    } else if (created) {
      step('--', 'cleanup', 'PASS', `${database} KEPT (--keep-database); drop it yourself`);
    }
    await rm(workRoot, { recursive: true, force: true });
  }

  const outcome = rehearsalOutcome({ steps, balances, services });
  const result: RehearsalResult = {
    exitCode: rehearsalExitCode(outcome.verdict),
    database,
    kept: created && args.keepDatabase,
    steps,
    quiet,
    balances,
    services,
    outcome,
    importView,
    messaging,
  };
  io.out(args.json ? reportJson(result, args.listDifferences) : reportText(result, args));
  return result;
}

// --- the report -------------------------------------------------------------------------

function reportText(result: RehearsalResult, args: RehearseArgs): string {
  const parts = [
    `Cutover rehearsal — disposable database ${result.database} (${result.kept ? 'kept' : 'dropped'}); never the live one; nothing here reaches a customer or Telegram\n\n`,
    stepLines(result.steps),
    '\n',
  ];
  if (result.balances !== null) {
    parts.push(cutoverReportText(result.balances, { listDifferences: args.listDifferences }), '\n');
  }
  if (result.services !== null) {
    parts.push(serviceReportText(result.services, { listDifferences: args.listDifferences }), '\n');
  }
  parts.push(outcomeLines(result.outcome));
  return parts.join('');
}

function reportJson(result: RehearsalResult, listDifferences: boolean): string {
  const strip = <T extends { differences: unknown }>(r: T | null) =>
    r === null ? null : listDifferences ? r : { ...r, differences: undefined };
  return `${JSON.stringify(
    {
      format: 'nexa-cutover-rehearsal/v1',
      database: result.database,
      kept: result.kept,
      messaging: result.messaging,
      steps: result.steps,
      quiet: result.quiet,
      balances: strip(result.balances),
      services: strip(result.services),
      outcome: result.outcome,
    },
    (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  )}\n`;
}

async function main(): Promise<void> {
  try {
    const args = parseRehearseArgs(process.argv.slice(2));
    const result = await runCutoverRehearsal(args, process.env, {
      out: (t) => process.stdout.write(t),
      progress: (t) => process.stderr.write(t),
    });
    process.exitCode = result.exitCode;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exitCode = 64;
    } else if (error instanceof TargetRefused) {
      console.error(error.message);
      process.exitCode = 65;
    } else {
      // Its name and code only, never a value it carried.
      const kind = errorKind(error);
      console.error(`cutover-rehearse failed: ${kind.type} ${kind.code ?? ''}`.trim());
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main();
}
