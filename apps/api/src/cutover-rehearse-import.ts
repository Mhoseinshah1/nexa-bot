import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import type { ActorContext, LegacyMigrationImportView, TenantContext } from '@nexa/contracts';
import type { Container } from './container.js';
import type { AppConfig } from './infrastructure/config/config.schema.js';
import { panelUrlPolicy } from './infrastructure/net/installation-policy.js';
import { checkUrl } from './infrastructure/net/url-policy.js';
import type { NxpkgSecret } from './infrastructure/nxpkg/index.js';
import type {
  RehearsalQuiet,
  RehearsalStepStatus,
} from './modules/platform/legacy-cutover/application/cutover-rehearsal.js';
import type { RehearsalOutboundGuard } from './modules/platform/legacy-cutover/infrastructure/rehearsal-outbound-guard.js';

/**
 * The cutover rehearsal's moving parts (`cutover-rehearse.cli.ts` is the command): the
 * read-only panel stand-ins, the import as the owner drives it on the restore page, and the
 * read-only counts the rehearsal checks before and after it.
 */

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

// --- the read-only panel stand-ins ---------------------------------------------------------

export interface StandinCounts {
  readonly token: number;
  readonly read: number;
  readonly refused: number;
  readonly unauthorized: number;
  readonly not_found: number;
}
/**
 * The stand-in's HTTP server, as far as this file uses it. Declared here rather than imported
 * from `node:http`: this file opens no socket of its own (the stand-in module does, in the
 * rehearsal process), so it is not one of the network sinks `check-boundaries.sh` lists.
 */
export interface StandinServer {
  listen(port: number, host: string, callback: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  close(callback: () => void): unknown;
  address(): unknown;
}

export interface StandinModule {
  createStandin(options: {
    readonly username: string;
    readonly password: string;
    readonly users?: readonly unknown[];
    readonly log?: (line: object) => void;
  }): { readonly server: StandinServer; readonly counts: StandinCounts };
}

/**
 * The kit's own stand-in (`deploy/rehearsal/rickpanel-standin.mjs`), not a copy: `/app/deploy`
 * in the image (beside `/app/dist`), the checkout's `deploy/` from source or a local build.
 */
export async function loadStandin(): Promise<StandinModule> {
  for (const relative of [
    '../deploy/rehearsal/rickpanel-standin.mjs',
    '../../../deploy/rehearsal/rickpanel-standin.mjs',
  ]) {
    const url = new URL(relative, import.meta.url);
    if (existsSync(fileURLToPath(url))) return (await import(url.href)) as StandinModule;
  }
  throw Object.assign(new Error('the RickPanel stand-in is not in this build'), {
    code: 'STANDIN_MISSING',
  });
}

/**
 * Where the stand-ins listen: the first address the panel URL policy itself would let this
 * process call — loopback (127.0.0.2, .3, .1: the database and Redis may own 127.0.0.1, and
 * the policy refuses an infrastructure host) where the configuration allows loopback, which
 * is never in production; otherwise this host's first private IPv4 address outside the
 * installation's data network (in the one-off api container: its edge-network address).
 */
export function standinAddress(
  config: Pick<
    AppConfig,
    | 'PANEL_HTTP_ALLOW_LOOPBACK'
    | 'NEXA_DATA_SUBNET'
    | 'PANEL_HTTP_DENIED_SUBNETS'
    | 'DATABASE_URL'
    | 'REDIS_URL'
  >,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | null {
  const policy = panelUrlPolicy(config);
  const candidates = config.PANEL_HTTP_ALLOW_LOOPBACK
    ? ['127.0.0.2', '127.0.0.3', '127.0.0.1']
    : Object.values(interfaces)
        .flatMap((entries) => entries ?? [])
        .filter((entry) => entry.family === 'IPv4' && !entry.internal)
        .map((entry) => entry.address);
  return candidates.find((address) => checkUrl(`http://${address}:8000/`, policy).allowed) ?? null;
}

export interface RunningStandin {
  readonly code: string;
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly accounts: number;
  readonly server: StandinServer;
  readonly counts: StandinCounts;
}

export async function startStandin(
  module: StandinModule,
  host: string,
  code: string,
  users: readonly unknown[],
): Promise<RunningStandin> {
  const username = `rehearsal-${code}`.slice(0, 32);
  const password = randomBytes(24).toString('base64url');
  const { server, counts } = module.createStandin({
    username,
    password,
    users,
    log: () => undefined,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  const port = (server.address() as { readonly port: number }).port;
  return {
    code,
    baseUrl: `http://${host}:${String(port)}`,
    username,
    password,
    accounts: users.length,
    server,
    counts,
  };
}

const SETTLED_STATUSES = new Set([
  'VERIFY_FAILED',
  'DRY_RUN_FAILED',
  'FAILED',
  'COMPLETED',
  'COMPLETED_WITH_DISCREPANCY',
  'CANCELLED',
]);

export async function withMaintenance<T>(
  url: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function counts(container: Container, query: string): Promise<Record<string, number>> {
  return container.database.withClient(async (client) => {
    const r = await client.query<Record<string, number>>(query);
    return r.rows[0] ?? {};
  });
}

/** `verify-import.sql`'s "before" half: the target holds nothing a customer owns. */
export function freshTargetCounts(container: Container): Promise<Record<string, number>> {
  return counts(
    container,
    `SELECT (SELECT count(*) FROM customers)::int AS customers,
            (SELECT count(*) FROM wallet_entries)::int AS wallet_entries,
            (SELECT count(*) FROM payments)::int AS payments,
            (SELECT count(*) FROM orders)::int AS orders,
            (SELECT count(*) FROM bot_instances)::int AS bot_instances`,
  );
}

export async function quietFacts(
  container: Container,
  guard: RehearsalOutboundGuard,
  standins: readonly RunningStandin[],
): Promise<RehearsalQuiet> {
  const db = await counts(
    container,
    `SELECT (SELECT count(*) FROM customer_notifications)::int AS customer_notifications,
            (SELECT count(*) FROM broadcast_recipients)::int AS broadcast_recipients,
            (SELECT count(*) FROM notifications WHERE status = 'SENT')::int AS operator_sent,
            (SELECT count(*) FROM outbox_messages WHERE published_at IS NOT NULL)::int AS outbox_published,
            (SELECT count(*) FROM provisioning_operations)::int AS provisioning_operations,
            (SELECT count(*) FROM bot_instances)::int AS bot_instances`,
  );
  const outbound = guard.counts();
  return {
    customerNotifications: db['customer_notifications'] ?? -1,
    broadcastRecipients: db['broadcast_recipients'] ?? -1,
    operatorNotificationsSent: db['operator_sent'] ?? -1,
    outboxPublished: db['outbox_published'] ?? -1,
    provisioningOperations: db['provisioning_operations'] ?? -1,
    botInstances: db['bot_instances'] ?? -1,
    outboundRefused: outbound.refused,
    telegramRefused: outbound.telegram,
    panelWritesRefused: standins.reduce((n, s) => n + s.counts.refused, 0),
  };
}

/**
 * I3–I7, as the owner does them on «بکاپ و بازیابی ← عملیات بازیابی», through the SAME
 * service (every permission check, audit row and idempotency key) and the container's own
 * executor (`container.migrationExecutor`, the recovery role's): its real protective backup,
 * write freeze and post-import backup — into the rehearsal's private directory.
 */
export async function runImport(
  container: Container,
  scope: TenantContext,
  owner: ActorContext,
  input: {
    readonly packagePath: string;
    readonly secret: NxpkgSecret;
    readonly inventory: ReadonlyMap<string, readonly unknown[]>;
    readonly standinHost: string | null;
    readonly standins: RunningStandin[];
    /** Test seam: after the stand-in panels exist, before the binding and the dry run. */
    readonly afterPanels?: (
      panels: readonly { readonly codePanel: string; readonly panelId: string }[],
    ) => Promise<void>;
    readonly step: (
      page: string,
      name: string,
      status: RehearsalStepStatus,
      detail: string,
    ) => boolean;
  },
): Promise<LegacyMigrationImportView> {
  const service = container.legacyMigration;
  const executor = container.migrationExecutor;
  let keys = 0;
  const key = () => {
    keys += 1;
    return `cutover-rehearsal:${String(keys)}:${randomBytes(6).toString('hex')}`;
  };
  const settle = async (id: string, want: string): Promise<LegacyMigrationImportView> => {
    let view = await service.detail(scope, owner, id);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (view.status === want || SETTLED_STATUSES.has(view.status)) return view;
      await executor.tick();
      view = await service.detail(scope, owner, id);
      if (view.status !== want && !SETTLED_STATUSES.has(view.status)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    return view;
  };

  // I3 — upload and verify.
  const pending = await service.beginUpload(scope, owner, {
    fileName: basename(input.packagePath),
  });
  await copyFile(input.packagePath, pending.packagePath);
  const bytes = (await stat(pending.packagePath)).size;
  let view = await service.completeUpload(scope, owner, pending, {
    bytes,
    sha256: await sha256OfFile(pending.packagePath),
  });
  await service.setKey(scope, owner, view.id, { idempotencyKey: key(), ...input.secret });
  view = await settle(view.id, 'VERIFIED');
  if (view.status !== 'VERIFIED' || view.verifyReport === null) {
    input.step('04', 'verify', 'FAIL', failedDetail(view));
    return view;
  }
  input.step(
    '04',
    'verify',
    'PASS',
    `VERIFIED; contract ${view.packageSchemaVersion ?? '?'}; converter ${view.converterVersion ?? '?'}`,
  );

  // I4 — one read-only stand-in per package panel target, registered and tested as the owner
  // registers a panel in «پنل‌ها»; then the binding and the dry run.
  if (input.standinHost === null) {
    throw Object.assign(new Error('no address for the panel stand-ins'), {
      code: 'STANDIN_NO_ADDRESS',
    });
  }
  const module = await loadStandin();
  const bindings: { codePanel: string; panelId: string }[] = [];
  for (const targetPanel of view.verifyReport.panelTargets) {
    const standin = await startStandin(
      module,
      input.standinHost,
      targetPanel.codePanel,
      input.inventory.get(targetPanel.codePanel) ?? [],
    );
    input.standins.push(standin);
    const created = await container.panels.create(scope, owner, {
      name: `Rehearsal stand-in ${targetPanel.codePanel}`.slice(0, 60),
      providerType: 'rickpanel',
      baseUrl: standin.baseUrl,
      credentials: { username: standin.username, password: standin.password },
      activation: {},
      idempotencyKey: key(),
    });
    const panelId = created.view.panel.id;
    await container.panels.testConnection(scope, owner, panelId, { idempotencyKey: key() });
    if (created.view.panel.status !== 'ACTIVE') {
      await container.panels.setStatus(scope, owner, panelId, {
        status: 'ACTIVE',
        idempotencyKey: key(),
      });
    }
    bindings.push({ codePanel: targetPanel.codePanel, panelId });
  }
  input.step(
    '04',
    'panels',
    'PASS',
    `${String(input.standins.length)} read-only stand-in(s); inventory ${input.standins
      .map((s) => `${s.code}=${String(s.accounts)}`)
      .join(', ')}`,
  );
  await input.afterPanels?.(bindings);
  await service.setPanelBindings(scope, owner, view.id, { idempotencyKey: key(), bindings });
  await service.requestDryRun(scope, owner, view.id, { idempotencyKey: key() });
  view = await settle(view.id, 'DRY_RUN_DONE');
  if (view.status !== 'DRY_RUN_DONE' || view.dryRunSha256 === null) {
    input.step('04', 'dry-run', 'FAIL', failedDetail(view));
    return view;
  }
  input.step('04', 'dry-run', 'PASS', `DRY_RUN_DONE; digest ${view.dryRunSha256}`);

  // GO-2 / I6 — the owner's approval, exactly as the page sends it, then the apply.
  const capabilities = await service.capabilities(scope, owner);
  await service.approve(scope, owner, view.id, {
    idempotencyKey: key(),
    dryRunSha256: view.dryRunSha256,
    confirmation: capabilities.approvalPhrase,
    targetAcknowledgement: capabilities.productionLikeTarget
      ? capabilities.targetAcknowledgement
      : null,
  });
  return settle(view.id, 'COMPLETED');
}

/**
 * A failed step as the rehearsal report prints it: the status, the contract code and the
 * refusal counts the row carries — e.g. `SOURCE_SCHEMA_MISSING_COLUMN:user.Balance` — so the
 * owner reads WHICH column without opening a log. Codes and names only, never a value.
 */
export function failedDetail(view: LegacyMigrationImportView): string {
  const counts = view.progress.refusalCounts.map((c) =>
    c.count === 1 ? c.code : `${c.code}=${String(c.count)}`,
  );
  return [view.status, view.errorCode ?? '', counts.length > 0 ? `(${counts.join(', ')})` : '']
    .filter((part) => part !== '')
    .join(' ');
}
