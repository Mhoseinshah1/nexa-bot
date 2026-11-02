import { tmpdir } from 'node:os';
import type { NxpkgSecret } from './infrastructure/nxpkg/index.js';
import { createDatabase } from './infrastructure/persistence/database.js';
import {
  agentProfileIdOf,
  agentStateOf,
  cutoverExitCode,
  cutoverReportJson,
  cutoverReportText,
  reconcileCutover,
  type MirzaAgentState,
  type MirzaUserRow,
} from './modules/platform/legacy-cutover/application/cutover-reconciliation.js';
import {
  CutoverTenantNotFound,
  readNexaCutoverState,
} from './modules/platform/legacy-cutover/infrastructure/pg-cutover-reconciliation.reader.js';
import {
  classifyTarget,
  type TargetIdentity,
} from './modules/platform/legacy-importer/application/production-guard.js';
import {
  readLegacySnapshot,
  serviceCandidateInvoices,
} from './modules/platform/legacy-importer/application/source-snapshot.js';
import type { MirzaServiceInvoice } from './modules/platform/legacy-cutover/application/cutover-service-reconciliation.js';
import { nxpkgSourceConnector } from './modules/platform/legacy-importer/infrastructure/nxpkg-legacy-source.js';

/**
 * `pnpm cutover-reconcile` — the cutover's balance reconciliation, a DRY RUN by construction.
 *
 * Opens a Mirza `.nxpkg` (authenticated, decrypted into a private directory that is deleted
 * afterwards), reads its own snapshot of `user` and its agent states, and compares them,
 * customer by customer and with zero tolerance, with the wallets of a NEXA database that
 * imported it (`docs/cutover/`). Agent credit is listed on its own line and never added.
 *
 * It never touches the installation's live database, by three rules:
 *
 * - `--database NAME` is required and replaces only the database name of `DATABASE_URL`, so
 *   no credential is ever typed on the command line, and the live database is never the
 *   default;
 * - NAME must carry a non-production word (`test`, `staging`, `rehearsal`, `scratch`, …, the
 *   importer's own list): `nexa` is refused whatever else is true. At the cutover it runs
 *   against a COPY — the post-import backup restored with `botctl restore --target
 *   nexa_cutover_scratch` — never against production;
 * - every statement runs in one `REPEATABLE READ, READ ONLY` transaction that is rolled back.
 *
 * Unlike the importer, NODE_ENV is not a refusal here: nothing is written, and the copy lives
 * on a production host. The name rule is what keeps it off the live database.
 *
 *   --package PATH                 the .nxpkg the import read
 *   --package-key-env NAME         the variable holding the key file's text, or
 *   --package-passphrase-env NAME  the variable holding the passphrase (never argv)
 *   --database NAME                the database to read (a copy; see above)
 *   --tenant SLUG                  a tenant other than the primary one
 *   --work-dir DIR                 where the package is decrypted (default: the OS temp dir)
 *   --json                         the report as JSON (bigint amounts as decimal text)
 *   --list-differences             also list each difference (NEXA ids, Mirza row numbers,
 *                                  amounts — never a Telegram id). Terminal only.
 *   --timeout-ms N                 statement timeout (default 600000)
 *
 * Exit: 0 RECONCILED, 2 RECONCILED_WITH_HELD (rows held for review; the owner signs them off
 * by name), 3 DIFFERENCES, 64 usage, 65 refused target, 1 anything else.
 */

export class UsageError extends Error {
  override readonly name = 'UsageError';
}
export class TargetRefused extends Error {
  override readonly name = 'TargetRefused';
}

export interface ReconcileArgs {
  readonly packagePath: string;
  readonly packageKeyEnv: string | null;
  readonly packagePassphraseEnv: string | null;
  readonly database: string;
  readonly tenantSlug: string | null;
  readonly workDir: string | null;
  readonly json: boolean;
  readonly listDifferences: boolean;
  readonly timeoutMs: number;
}

const VALUE_FLAGS = new Set([
  '--package',
  '--package-key-env',
  '--package-passphrase-env',
  '--database',
  '--tenant',
  '--work-dir',
  '--timeout-ms',
]);
const BOOLEAN_FLAGS = new Set(['--json', '--list-differences']);

export function parseReconcileArgs(argv: readonly string[]): ReconcileArgs {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] as string;
    if (BOOLEAN_FLAGS.has(flag)) {
      booleans.add(flag);
      continue;
    }
    // Nothing from argv is echoed back: a mistyped secret must not land in a terminal log.
    if (!VALUE_FLAGS.has(flag))
      throw new UsageError(`unknown argument at position ${String(i + 1)}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--'))
      throw new UsageError(`${flag} needs a value.`);
    if (values.has(flag)) throw new UsageError(`${flag} was given twice.`);
    values.set(flag, value);
    i += 1;
  }
  const packagePath = values.get('--package');
  if (packagePath === undefined) throw new UsageError('--package PATH is required.');
  const database = values.get('--database');
  if (database === undefined) throw new UsageError('--database NAME is required.');
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/u.test(database)) {
    throw new UsageError('--database must be a plain database name.');
  }
  const packageKeyEnv = values.get('--package-key-env') ?? null;
  const packagePassphraseEnv = values.get('--package-passphrase-env') ?? null;
  if ((packageKeyEnv === null) === (packagePassphraseEnv === null)) {
    throw new UsageError(
      'exactly one of --package-key-env or --package-passphrase-env is required.',
    );
  }
  for (const name of [packageKeyEnv, packagePassphraseEnv]) {
    if (name !== null && !/^[A-Z_][A-Z0-9_]*$/u.test(name)) {
      throw new UsageError('--package-key-env / --package-passphrase-env name a variable.');
    }
  }
  const timeout = values.get('--timeout-ms') ?? '600000';
  if (!/^[0-9]{4,7}$/u.test(timeout)) throw new UsageError('--timeout-ms must be 1000..9999999.');
  return {
    packagePath,
    packageKeyEnv,
    packagePassphraseEnv,
    database,
    tenantSlug: values.get('--tenant') ?? null,
    workDir: values.get('--work-dir') ?? null,
    json: booleans.has('--json'),
    listDifferences: booleans.has('--list-differences'),
    timeoutMs: Number(timeout),
  };
}

/**
 * `DATABASE_URL` with its database replaced by `database`, after the name rule. Throws
 * `TargetRefused` for a production-like name and `UsageError` for an unusable URL.
 */
export function reconcileTargetUrl(
  databaseUrl: string | undefined,
  database: string,
): { readonly url: string; readonly target: TargetIdentity } {
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new UsageError('DATABASE_URL must be set (only its server and credentials are used).');
  }
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new UsageError('DATABASE_URL is not a URL.');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new UsageError('DATABASE_URL must be a postgres:// URL.');
  }
  const target: TargetIdentity = {
    host: parsed.hostname || 'localhost',
    port: parsed.port || '5432',
    database,
  };
  // Name only, deliberately (see the header): NODE_ENV is production on the host that holds
  // the restored copy, and this command writes nothing.
  const classification = classifyTarget(target, {});
  if (classification.productionLike) {
    throw new TargetRefused(
      `Refused: ${database} looks like a production database (${classification.reasons.join('; ')}). ` +
        'This reconciliation runs against a COPY: restore the post-import backup into a database ' +
        'whose name carries a non-production word (for example nexa_cutover_scratch) and name that.',
    );
  }
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return { url: parsed.toString(), target };
}

export function packageSecret(args: ReconcileArgs, env: NodeJS.ProcessEnv): NxpkgSecret {
  const name = (args.packageKeyEnv ?? args.packagePassphraseEnv) as string;
  const value = env[name];
  if (value === undefined || value === '') throw new UsageError(`${name} is not set.`);
  return args.packageKeyEnv !== null ? { keyFileText: value } : { passphrase: value };
}

/**
 * The Mirza half: the package's own `user` snapshot and its agent states, and the service
 * candidates the importer decides from (the rehearsal's service reconciliation reads them).
 */
export async function readMirzaSide(
  packagePath: string,
  secret: NxpkgSecret,
  workDir: string,
): Promise<{
  readonly users: MirzaUserRow[];
  readonly agentStates: MirzaAgentState[];
  readonly agentProfileIds: ReadonlySet<string>;
  readonly serviceInvoices: MirzaServiceInvoice[];
}> {
  const connector = await nxpkgSourceConnector(packagePath, secret, workDir);
  try {
    const snapshot = await readLegacySnapshot(connector);
    const users = snapshot.users.map((u) => ({ id: u.id, balance: u.balance, agent: u.agent }));
    const serviceInvoices = serviceCandidateInvoices(snapshot).map((invoice) => ({
      invoiceKey: invoice.idInvoice,
      ownerTelegramId: invoice.idUser,
    }));
    const agentStates: MirzaAgentState[] = [];
    const pkg = connector.pkg;
    const agentProfileIds = new Set<string>();
    const statePath = 'records/agents/state.jsonl';
    const profilePath = 'records/agents/profiles.jsonl';
    if (pkg !== null && pkg.has(statePath)) {
      for await (const record of pkg.iterJsonl(statePath)) {
        const state = agentStateOf(record);
        if (state !== null) agentStates.push(state);
      }
    }
    if (pkg !== null && pkg.has(profilePath)) {
      for await (const record of pkg.iterJsonl(profilePath)) {
        const id = agentProfileIdOf(record);
        if (id !== null) agentProfileIds.add(id);
      }
    }
    return { users, agentStates, agentProfileIds, serviceInvoices };
  } finally {
    await connector.close();
  }
}

export async function runCutoverReconcile(
  args: ReconcileArgs,
  env: NodeJS.ProcessEnv,
  out: (text: string) => void,
): Promise<number> {
  const { url } = reconcileTargetUrl(env['DATABASE_URL'], args.database);
  const secret = packageSecret(args, env);
  const mirza = await readMirzaSide(args.packagePath, secret, args.workDir ?? tmpdir());
  const handle = createDatabase(url, 1);
  try {
    const nexa = await readNexaCutoverState(handle, {
      tenantSlug: args.tenantSlug,
      statementTimeoutMs: args.timeoutMs,
    });
    const result = reconcileCutover({ ...mirza, ...nexa });
    const options = { listDifferences: args.listDifferences };
    out(args.json ? cutoverReportJson(result, options) : cutoverReportText(result, options));
    return cutoverExitCode(result.verdict);
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  try {
    const args = parseReconcileArgs(process.argv.slice(2));
    process.exitCode = await runCutoverReconcile(args, process.env, (t) => process.stdout.write(t));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exitCode = 64;
    } else if (error instanceof TargetRefused || error instanceof CutoverTenantNotFound) {
      console.error(error.message);
      process.exitCode = 65;
    } else {
      // A package or database failure: its name and code only, never a value it carried.
      const e = error as { name?: unknown; code?: unknown };
      console.error(
        `cutover-reconcile failed: ${String(e.name ?? 'Error')} ${String(e.code ?? '')}`,
      );
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main();
}
