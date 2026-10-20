import type { ActorContext, TenantContext } from '@nexa/contracts';
import {
  DSN_PASSWORD_REFUSAL,
  PACKAGE_SECRET_VALUE_REFUSAL,
  PASSWORD_FLAG_REFUSAL,
  hasUrlPassword,
  isPackageKeyText,
  isPasswordFlag,
} from './legacy-import-argv.js';
import type { LegacyImporterService } from './modules/platform/legacy-importer/application/legacy-importer.service.js';
import { READ_SET_MAX_BATCH } from './modules/platform/legacy-importer/application/read-set.js';
import type { LegacySourceConnector } from './modules/platform/legacy-importer/application/source-port.js';
import type { TermsBackfillOutcome } from './modules/platform/legacy-importer/application/terms-backfill.js';

/**
 * R4 A4 — `legacy-import terms-backfill`: the previous bot's rules acceptance
 * (`user.roll_Status`) for an installation that was imported before the import carried it.
 *
 *   - with `--expected-fingerprint` only: prints the `user-terms` read set fingerprint for
 *     the owner to approve. Writes NOTHING. Exit 3.
 *   - with `--expected-terms-fingerprint` too: under the importer's claim, a read-only session
 *     bound to both approvals marks every accepted user's customer in batches — a conditional
 *     UPDATE (`IS NULL`), so it is idempotent and resumable. Sends no message. Exit 0.
 */

export class TermsUsageError extends Error {}

export const TERMS_BACKFILL_USAGE = [
  'usage: legacy-import terms-backfill --tenant TENANT --source SOURCE --target TARGET',
  '                                    --expected-fingerprint HEX',
  '                                    [--expected-terms-fingerprint HEX] [--batch-size N]',
  '                                    [--package-key-env NAME | --package-passphrase-env NAME]',
  '                                    [--package-work-dir DIR] [--source-password-env NAME]',
  '                                    [--format md|json] [--allow-production-target]',
  '',
  '  Carries the previous bot’s rules acceptance (user.roll_Status) onto the imported',
  '  customers. Without --expected-terms-fingerprint it prints that fingerprint and writes',
  '  nothing (exit 3). With it, both fingerprints are checked in one read-only session first.',
  '  Idempotent: a rerun marks nobody twice. No customer is sent anything.',
].join('\n');

export interface TermsBackfillArgs {
  readonly tenant: string;
  readonly source: string;
  readonly sourcePasswordEnv: string | null;
  readonly packageKeyEnv: string | null;
  readonly packagePassphraseEnv: string | null;
  readonly packageWorkDir: string | null;
  readonly target: string;
  readonly expectedFingerprint: string;
  readonly expectedTermsFingerprint: string | null;
  readonly batchSize: number;
  readonly format: 'md' | 'json';
  readonly allowProductionTarget: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const VALUE_FLAGS = new Set([
  '--tenant',
  '--source',
  '--source-password-env',
  '--package-key-env',
  '--package-passphrase-env',
  '--package-work-dir',
  '--target',
  '--expected-fingerprint',
  '--expected-terms-fingerprint',
  '--batch-size',
  '--format',
]);

function hash(flag: string, value: string): string {
  if (!SHA256_HEX.test(value)) {
    throw new TermsUsageError(`${flag} is a SHA-256 as 64 lowercase hex characters.`);
  }
  return value;
}

export function parseTermsBackfillArgs(argv: readonly string[]): TermsBackfillArgs {
  const values = new Map<string, string>();
  let allowProductionTarget = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (isPasswordFlag(arg)) throw new TermsUsageError(PASSWORD_FLAG_REFUSAL);
    if (arg === '--allow-production-target') {
      allowProductionTarget = true;
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) {
      throw new TermsUsageError(`Unknown argument ${arg}.\n\n${TERMS_BACKFILL_USAGE}`);
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--'))
      throw new TermsUsageError(`${arg} needs a value.`);
    if (values.has(arg)) throw new TermsUsageError(`${arg} is given twice.`);
    if (isPackageKeyText(next)) throw new TermsUsageError(PACKAGE_SECRET_VALUE_REFUSAL);
    values.set(arg, next);
    i += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) {
      throw new TermsUsageError(
        `${flag} is required. There is no default.\n\n${TERMS_BACKFILL_USAGE}`,
      );
    }
    return value;
  };
  const tenant = required('--tenant');
  if (!UUID.test(tenant) && !SLUG.test(tenant)) {
    throw new TermsUsageError('--tenant must be a lowercase tenant uuid or slug.');
  }
  const source = required('--source');
  const target = required('--target');
  if (hasUrlPassword(source) || hasUrlPassword(target)) {
    throw new TermsUsageError(DSN_PASSWORD_REFUSAL);
  }
  for (const spec of [source, target]) {
    if (spec.startsWith('env:') && !ENV_NAME.test(spec.slice(4))) {
      throw new TermsUsageError(`${spec} does not name an environment variable.`);
    }
  }
  if (!/^(env:|mysql:\/\/|mariadb:\/\/|fixture:|nxpkg:.)/u.test(source)) {
    throw new TermsUsageError('--source must be env:NAME, mysql://…, fixture:PATH or nxpkg:PATH.');
  }
  if (!/^(env:|postgres:\/\/|postgresql:\/\/)/u.test(target) && !DATABASE_NAME.test(target)) {
    throw new TermsUsageError('--target must be env:NAME, postgres://… or a database name.');
  }
  const named = (flag: string): string | null => {
    const value = values.get(flag) ?? null;
    if (value !== null && !ENV_NAME.test(value))
      throw new TermsUsageError(`${flag} names a variable.`);
    return value;
  };
  const sourcePasswordEnv = named('--source-password-env');
  if (sourcePasswordEnv !== null && !/^(mysql|mariadb):\/\//u.test(source)) {
    throw new TermsUsageError('--source-password-env applies to a literal mysql:// source only.');
  }
  const packageKeyEnv = named('--package-key-env');
  const packagePassphraseEnv = named('--package-passphrase-env');
  const packageWorkDir = values.get('--package-work-dir') ?? null;
  const nxpkg = source.startsWith('nxpkg:');
  if (nxpkg && (packageKeyEnv === null) === (packagePassphraseEnv === null)) {
    throw new TermsUsageError(
      '--source nxpkg: needs exactly one of --package-key-env NAME or --package-passphrase-env NAME.',
    );
  }
  if (
    !nxpkg &&
    (packageKeyEnv !== null || packagePassphraseEnv !== null || packageWorkDir !== null)
  ) {
    throw new TermsUsageError('The --package-* flags apply to an nxpkg: source only.');
  }
  const termsFlag = values.get('--expected-terms-fingerprint');
  const batchText = values.get('--batch-size') ?? '1000';
  const batchSize = /^[0-9]{1,5}$/u.test(batchText) ? Number(batchText) : Number.NaN;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > READ_SET_MAX_BATCH) {
    throw new TermsUsageError(`--batch-size is 1-${String(READ_SET_MAX_BATCH)}.`);
  }
  const format = values.get('--format') ?? 'md';
  if (format !== 'md' && format !== 'json')
    throw new TermsUsageError('--format must be md or json.');
  return {
    tenant,
    source,
    sourcePasswordEnv,
    packageKeyEnv,
    packagePassphraseEnv,
    packageWorkDir,
    target,
    expectedFingerprint: hash('--expected-fingerprint', required('--expected-fingerprint')),
    expectedTermsFingerprint:
      termsFlag === undefined ? null : hash('--expected-terms-fingerprint', termsFlag),
    batchSize,
    format,
    allowProductionTarget,
  };
}

export async function runTermsBackfill(
  importer: Pick<LegacyImporterService, 'backfillTerms'>,
  connector: LegacySourceConnector,
  args: Pick<TermsBackfillArgs, 'expectedFingerprint' | 'expectedTermsFingerprint' | 'batchSize'>,
  context: {
    readonly scope: TenantContext;
    readonly actor: ActorContext;
    readonly productionLikeTarget: boolean;
  },
): Promise<TermsBackfillOutcome> {
  return importer.backfillTerms({
    scope: context.scope,
    actor: context.actor,
    connector,
    expectedFingerprint: args.expectedFingerprint,
    expectedTermsFingerprint: args.expectedTermsFingerprint,
    batchSize: args.batchSize,
    productionLikeTarget: context.productionLikeTarget,
  });
}

export function termsBackfillExitCode(outcome: TermsBackfillOutcome): number {
  return outcome.written === null ? 3 : 0;
}

/** The outcome as text. Hashes and counts only — never a legacy id or value. */
export function termsBackfillReport(outcome: TermsBackfillOutcome, format: 'md' | 'json'): string {
  const body = {
    format: 'nexa-legacy-terms-backfill/v1',
    synthetic: outcome.synthetic,
    sourceFingerprint: outcome.v1.fingerprint,
    fingerprintVersion: outcome.fingerprintVersion,
    termsFingerprint: outcome.fingerprint,
    userRows: outcome.userRows,
    rollStatusColumn: outcome.columnPresent,
    verdict: outcome.written === null ? 'NOT_APPROVED_NOTHING_WRITTEN' : 'BACKFILLED',
    ...(outcome.written === null
      ? {}
      : { accepted: outcome.written.accepted, marked: outcome.written.marked }),
  };
  if (format === 'json') return `${JSON.stringify(body, null, 2)}\n`;
  const lines = [
    `# Previous bot rules acceptance${outcome.synthetic ? ' (SYNTHETIC — not evidence)' : ''}`,
    '',
    `- source fingerprint (v1, approved): \`${body.sourceFingerprint}\``,
    `- user-terms fingerprint (${body.fingerprintVersion}): \`${body.termsFingerprint}\``,
    `- user rows in the snapshot: ${String(body.userRows)}`,
    `- \`user.roll_Status\` present: ${body.rollStatusColumn ? 'yes' : 'no (nobody is carried as accepted)'}`,
    `- verdict: **${body.verdict}**`,
  ];
  if (outcome.written !== null) {
    lines.push(
      `- users who accepted in the source: ${String(outcome.written.accepted)}`,
      `- customers marked by this run: ${String(outcome.written.marked)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
