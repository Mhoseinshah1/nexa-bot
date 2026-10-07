import type { ActorContext, TenantContext } from '@nexa/contracts';
import {
  DSN_PASSWORD_REFUSAL,
  PASSWORD_FLAG_REFUSAL,
  hasUrlPassword,
  isPasswordFlag,
} from './legacy-import-argv.js';
import type { LegacyImporterService } from './modules/platform/legacy-importer/application/legacy-importer.service.js';
import {
  INVOICE_ARCHIVE_EXCLUDED_COLUMNS,
  INVOICE_ARCHIVE_READ_SET,
} from './modules/platform/legacy-importer/application/invoice-archive-read-set.js';
import type { InvoicesReadOutcome } from './modules/platform/legacy-importer/application/invoice-archive-ingest.js';
import { READ_SET_MAX_BATCH } from './modules/platform/legacy-importer/application/read-set.js';
import type { LegacySourceConnector } from './modules/platform/legacy-importer/application/source-port.js';

/**
 * Mirza migration PR3 — `legacy-import invoices-read` (`docs/legacy-migration/importer.md`
 * §Invoice archive): the legacy `invoice` table through the `invoice-archive` read set.
 *
 * - with `--expected-fingerprint` only: prints the invoice-archive read set fingerprint for
 *   the owner to approve. Writes NOTHING. Exit 3 (not yet approved).
 * - with `--expected-invoice-archive-fingerprint` too: refuses (65, nothing archived) unless
 *   the same read-only session's v1 fingerprint and invoice-archive fingerprint both equal
 *   their approvals; stages the read in batches, verifies it, appends revisions batch by
 *   batch (`maintenance.run`, audited per run step, idempotent), and records the read set
 *   run. Exit 0. A crash at any point is finished or discarded by the next invocation; a
 *   rerun of the same read appends nothing.
 *
 * Output: codes, hashes and counts only — never an invoice id, a Telegram id, a username or
 * a price.
 */

export class InvoicesUsageError extends Error {}

export const INVOICES_READ_USAGE = [
  'usage: legacy-import invoices-read --tenant TENANT --source SOURCE --target TARGET',
  '                                   --expected-fingerprint HEX',
  '                                   [--expected-invoice-archive-fingerprint HEX]',
  '                                   [--batch-size N] [--format md|json]',
  '                                   [--source-password-env NAME] [--allow-production-target]',
  '',
  '  Reads every legacy invoice (the `invoice-archive` read set) into the append-only legacy',
  '  invoice archive. Without --expected-invoice-archive-fingerprint it only prints that',
  '  fingerprint for approval and writes nothing (exit 3). With it, both fingerprints are',
  '  checked in the same read-only session before any row is delivered (a mismatch is exit',
  '  65, nothing written). Batched and resumable: run it again after any interruption.',
  `  --batch-size N   rows per transaction, 1-${String(READ_SET_MAX_BATCH)} (default 1000; revisions are`,
  '                   written at most 1000 per transaction).',
].join('\n');

export interface InvoicesReadArgs {
  readonly tenant: string;
  readonly source: string;
  readonly sourcePasswordEnv: string | null;
  readonly target: string;
  readonly expectedFingerprint: string;
  readonly expectedInvoiceArchiveFingerprint: string | null;
  readonly batchSize: number;
  readonly format: 'md' | 'json';
  readonly allowProductionTarget: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--tenant',
  '--source',
  '--source-password-env',
  '--target',
  '--expected-fingerprint',
  '--expected-invoice-archive-fingerprint',
  '--batch-size',
  '--format',
]);

function hash(flag: string, value: string): string {
  if (!SHA256_HEX.test(value)) {
    throw new InvoicesUsageError(`${flag} is a SHA-256 as 64 lowercase hex characters.`);
  }
  return value;
}

export function parseInvoicesReadArgs(argv: readonly string[]): InvoicesReadArgs {
  const values = new Map<string, string>();
  let allowProductionTarget = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (isPasswordFlag(arg)) throw new InvoicesUsageError(PASSWORD_FLAG_REFUSAL);
    if (arg === '--allow-production-target') {
      allowProductionTarget = true;
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) {
      throw new InvoicesUsageError(`Unknown argument ${arg}.\n\n${INVOICES_READ_USAGE}`);
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new InvoicesUsageError(`${arg} needs a value.`);
    }
    if (values.has(arg)) throw new InvoicesUsageError(`${arg} is given twice.`);
    values.set(arg, next);
    i += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) {
      throw new InvoicesUsageError(
        `${flag} is required. There is no default.\n\n${INVOICES_READ_USAGE}`,
      );
    }
    return value;
  };
  const tenant = required('--tenant');
  if (!UUID.test(tenant) && !SLUG.test(tenant)) {
    throw new InvoicesUsageError('--tenant must be a lowercase tenant uuid or slug.');
  }
  const source = required('--source');
  if (hasUrlPassword(source)) throw new InvoicesUsageError(DSN_PASSWORD_REFUSAL);
  if (source.startsWith('env:') && !ENV_NAME.test(source.slice(4))) {
    throw new InvoicesUsageError(`${source} does not name an environment variable.`);
  }
  if (!/^(env:|mysql:\/\/|mariadb:\/\/|fixture:)/u.test(source)) {
    throw new InvoicesUsageError('--source must be env:NAME, mysql://… or fixture:PATH.');
  }
  const target = required('--target');
  if (hasUrlPassword(target)) throw new InvoicesUsageError(DSN_PASSWORD_REFUSAL);
  if (target.startsWith('env:') && !ENV_NAME.test(target.slice(4))) {
    throw new InvoicesUsageError(`${target} does not name an environment variable.`);
  }
  if (!/^(env:|postgres:\/\/|postgresql:\/\/)/u.test(target) && !DATABASE_NAME.test(target)) {
    throw new InvoicesUsageError('--target must be env:NAME, postgres://… or a database name.');
  }
  const sourcePasswordEnv = values.get('--source-password-env') ?? null;
  if (
    sourcePasswordEnv !== null &&
    (!ENV_NAME.test(sourcePasswordEnv) || !/^(mysql|mariadb):\/\//u.test(source))
  ) {
    throw new InvoicesUsageError(
      '--source-password-env names a variable and applies to a literal mysql:// source only.',
    );
  }
  const expectedFingerprint = hash('--expected-fingerprint', required('--expected-fingerprint'));
  const archiveFlag = values.get('--expected-invoice-archive-fingerprint');
  const expectedInvoiceArchiveFingerprint =
    archiveFlag === undefined ? null : hash('--expected-invoice-archive-fingerprint', archiveFlag);
  const batchText = values.get('--batch-size') ?? '1000';
  const batchSize = /^[0-9]{1,5}$/u.test(batchText) ? Number(batchText) : 0;
  if (batchSize < 1 || batchSize > READ_SET_MAX_BATCH) {
    throw new InvoicesUsageError(`--batch-size is 1-${String(READ_SET_MAX_BATCH)}.`);
  }
  const format = values.get('--format') ?? 'md';
  if (format !== 'md' && format !== 'json') {
    throw new InvoicesUsageError('--format must be md or json.');
  }
  return {
    tenant,
    source,
    sourcePasswordEnv,
    target,
    expectedFingerprint,
    expectedInvoiceArchiveFingerprint,
    batchSize,
    format,
    allowProductionTarget,
  };
}

/** Runs `invoices-read`; a SYNTHETIC source is never written to a production-like target. */
export function runInvoicesRead(
  importer: Pick<LegacyImporterService, 'readInvoiceArchive'>,
  connector: LegacySourceConnector,
  args: Pick<
    InvoicesReadArgs,
    'expectedFingerprint' | 'expectedInvoiceArchiveFingerprint' | 'batchSize'
  >,
  context: {
    readonly scope: TenantContext;
    readonly actor: ActorContext;
    readonly productionLikeTarget: boolean;
  },
): Promise<InvoicesReadOutcome> {
  return importer.readInvoiceArchive({
    scope: context.scope,
    actor: context.actor,
    connector,
    expectedFingerprint: args.expectedFingerprint,
    expectedInvoiceArchiveFingerprint: args.expectedInvoiceArchiveFingerprint,
    batchSize: args.batchSize,
    productionLikeTarget: context.productionLikeTarget,
  });
}

export function invoicesReadExitCode(outcome: InvoicesReadOutcome): number {
  return outcome.written === null ? 3 : 0;
}

/**
 * The outcome as text: codes, hashes and counts only — never a legacy cell value. The
 * closure line is the reconciliation the run's CHECK already enforced: every invoice of the
 * read is new, a new revision or unchanged, and the archive holds the read's invoices plus
 * the ones this snapshot no longer has.
 */
export function invoicesReadReport(outcome: InvoicesReadOutcome, format: 'md' | 'json'): string {
  const run = outcome.written?.run ?? null;
  const n = (value: bigint | null) => (value === null ? null : Number(value));
  const body = {
    format: 'nexa-legacy-invoices-read/v1',
    synthetic: outcome.synthetic,
    sourceFingerprint: outcome.v1?.fingerprint ?? run?.sourceFingerprint ?? null,
    fingerprintVersion: outcome.fingerprintVersion,
    invoiceArchiveFingerprint: outcome.fingerprint,
    invoiceArchiveSchemaHash: outcome.schemaHash,
    columnsRead: [
      ...(INVOICE_ARCHIVE_READ_SET.tables[0]?.columns ?? []),
      ...(INVOICE_ARCHIVE_READ_SET.tables[0]?.optionalColumns ?? []),
    ],
    columnsNeverRead: [...INVOICE_ARCHIVE_EXCLUDED_COLUMNS],
    rows: outcome.rows,
    verdict: outcome.written === null ? 'NOT_APPROVED_NOTHING_WRITTEN' : 'ARCHIVED',
    abandonedRunId: outcome.abandonedRunId,
    finishedEarlierRunId: outcome.finishedEarlierRun?.id ?? null,
    ...(run === null || outcome.written === null
      ? {}
      : {
          run: {
            id: run.id,
            state: run.state,
            insertedNew: n(run.insertedNew),
            insertedRevision: n(run.insertedRevision),
            unchanged: n(run.unchanged),
            missingInSnapshot: n(run.missingInSnapshot),
            archivedInvoices: n(run.archiveInvoicesAfter),
          },
          readSetRun: {
            id: outcome.written.recorded.run.id,
            created: outcome.written.recorded.created,
          },
        }),
  };
  if (format === 'json') return `${JSON.stringify(body, null, 2)}\n`;
  const lines = [
    `# Legacy invoices read${outcome.synthetic ? ' (SYNTHETIC — not evidence)' : ''}`,
    '',
    `- source fingerprint (v1, approved): \`${body.sourceFingerprint ?? '—'}\``,
    `- invoice-archive fingerprint (${body.fingerprintVersion}): \`${body.invoiceArchiveFingerprint}\``,
    `- rows in the snapshot: invoice ${String(outcome.rows.invoice)}, user ${String(outcome.rows.user)}, product ${String(outcome.rows.product)}`,
    `- columns never read: ${body.columnsNeverRead.join(', ')}`,
    `- verdict: **${body.verdict}**`,
  ];
  if (outcome.abandonedRunId !== null) {
    lines.push(
      `- an interrupted read (run ${outcome.abandonedRunId}) was discarded: nothing of it was archived`,
    );
  }
  if (outcome.finishedEarlierRun !== null) {
    lines.push(
      `- an interrupted promotion (run ${outcome.finishedEarlierRun.id}) was finished first`,
    );
  }
  if (run !== null && outcome.written !== null) {
    lines.push(
      `- run ${run.id}: new ${String(run.insertedNew)}, new revisions ${String(run.insertedRevision)}, ` +
        `unchanged ${String(run.unchanged)} (= ${String(outcome.rows.invoice)} read)`,
      `- archived invoices ${String(run.archiveInvoicesAfter)} = ${String(outcome.rows.invoice)} read + ` +
        `${String(run.missingInSnapshot)} no longer in this snapshot (kept, never deleted)`,
      `- read set run: ${outcome.written.recorded.run.id}${outcome.written.recorded.created ? '' : ' (already recorded)'}`,
    );
  } else {
    lines.push(
      '',
      'Nothing was written. Approve the invoice-archive fingerprint above, then run again with',
      '`--expected-invoice-archive-fingerprint` set to it.',
    );
  }
  return `${lines.join('\n')}\n`;
}
