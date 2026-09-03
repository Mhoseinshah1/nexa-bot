import {
  isNexaError,
  systemJobActor,
  type CorrelationId,
  type TenantContext,
  type TenantId,
} from '@nexa/contracts';
import { createContainer, type Container } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import { envelopeKeyId, envelopeVersion } from './infrastructure/crypto/secret-cipher.js';
import { resolveKeyring } from './infrastructure/crypto/resolve-keyring.js';
import type { KeyringFormat, SecretKeyring } from './infrastructure/crypto/keyring.js';
import { acceptsV1, type AppConfig } from './infrastructure/config/config.schema.js';
import { SECRET_COLUMNS, type SecretColumn } from './infrastructure/crypto/secret-registry.js';

/**
 * `secrets status` and `secrets rewrap` — cryptographic maintenance.
 *
 * Neither runs on its own. Re-encryption is never automatic at boot, because a
 * migration that starts when the process starts is a startup that never
 * finishes on a large table; and never opportunistic on read, because that
 * turns every credential read into a write inside request handling. It is an
 * operator running a bounded command and watching it converge.
 *
 * Nothing here ever holds a decrypted value beyond the statement that
 * re-encrypts it, and nothing logs, audits or reports one.
 */

interface Args {
  readonly command: 'status' | 'rewrap' | 'retire-check' | 'shutdown-check';
  readonly batch: number;
  readonly max: number;
  readonly keyId: string | null;
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Args {
  const command = argv[0];
  if (
    command !== 'status' &&
    command !== 'rewrap' &&
    command !== 'retire-check' &&
    command !== 'shutdown-check'
  ) {
    throw new UsageError(
      'usage: secrets <status|rewrap|retire-check|shutdown-check> [--batch N] [--max N] [--key ID]',
    );
  }
  const value = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    if (index === -1) return null;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} needs a value.`);
    return next;
  };
  const positive = (flag: string, fallback: number): number => {
    const raw = value(flag);
    if (raw === null) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1)
      throw new UsageError(`${flag} must be a positive integer.`);
    return parsed;
  };
  const keyId = value('--key');
  if (command === 'retire-check' && keyId === null) {
    throw new UsageError('retire-check needs --key <id>: the key you are asking about.');
  }
  return {
    command,
    batch: positive('--batch', 100),
    max: positive('--max', Number.MAX_SAFE_INTEGER),
    keyId,
  };
}

interface ColumnStatus {
  readonly column: SecretColumn;
  /** How many rows carry this secret. A count, not an amount. */
  readonly rowCount: number;
  readonly byVersion: Map<string, number>;
  readonly byKeyId: Map<string, number>;
  /** Rows whose stored key id disagrees with the one inside their envelope. */
  readonly mismatched: number;
}

/**
 * Counted by reading every row's envelope prefix rather than by decrypting.
 *
 * The stored key-id column is what retirement counts, so status must also
 * check that it AGREES with the envelope. A row where the two disagree is
 * reported and makes the whole status non-success: retirement's dependency
 * count reads the column, so a lying column could let a key be retired while a
 * ciphertext still needs it.
 */
async function statusOf(container: Container, column: SecretColumn): Promise<ColumnStatus> {
  const rows = await column.all(container.database.db);

  const byVersion = new Map<string, number>();
  const byKeyId = new Map<string, number>();
  let mismatched = 0;
  for (const row of rows) {
    const version = envelopeVersion(row.ciphertext);
    byVersion.set(version, (byVersion.get(version) ?? 0) + 1);
    byKeyId.set(row.keyId, (byKeyId.get(row.keyId) ?? 0) + 1);
    if (envelopeKeyId(row.ciphertext) !== row.keyId) mismatched += 1;
  }
  return { column, rowCount: rows.length, byVersion, byKeyId, mismatched };
}

/**
 * What this installation is configured to do, printed before the row counts.
 *
 * The acceptance line says "(default)" when nothing in `nexa.env` decided it,
 * because an operator reading `accept v1  yes` has to be able to tell a
 * deliberate setting from an inherited one — the inherited one is the one that
 * describes every host installed before the setting existed.
 */
function configurationLines(
  keyring: SecretKeyring,
  config: Pick<AppConfig, 'SECRETS_ACCEPT_V1'>,
): string[] {
  const explicit = config.SECRETS_ACCEPT_V1 !== undefined;
  const accept = acceptsV1(config, keyring);
  return [
    `configuration  ${keyring.format}` +
      (keyring.format === 'legacy'
        ? '  (pre-keyring SECRETS_KEK spelling; `botctl secrets migrate-config` converts it)'
        : ''),
    `active key     ${keyring.activeKeyId}`,
    `keyring        ${[...keyring.keys.keys()].join(', ')}`,
    `accept v1      ${accept ? 'yes' : 'no'}  ${explicit ? '(SECRETS_ACCEPT_V1)' : '(default)'}`,
    '',
  ];
}

function report(statuses: readonly ColumnStatus[]): { text: string; healthy: boolean } {
  const lines: string[] = [];
  let healthy = true;
  for (const status of statuses) {
    lines.push(
      `${status.column.purpose}  (${status.column.table}.${status.column.ciphertextColumn})`,
    );
    lines.push(`  rows        ${status.rowCount}`);
    const versions = [...status.byVersion.entries()].sort(([a], [b]) => a.localeCompare(b));
    lines.push(`  versions    ${versions.map(([v, n]) => `${v}=${n}`).join('  ') || '-'}`);
    const keys = [...status.byKeyId.entries()].sort(([a], [b]) => a.localeCompare(b));
    lines.push(`  key ids     ${keys.map(([k, n]) => `${k}=${n}`).join('  ') || '-'}`);
    if (status.mismatched > 0) {
      healthy = false;
      lines.push(
        `  MISMATCH    ${status.mismatched} row(s) record a key id that is not the one inside ` +
          'their envelope. Key retirement counts the recorded value, so no key may be retired ' +
          'until these are corrected.',
      );
    }
  }
  return { text: lines.join('\n'), healthy };
}

/**
 * What `shutdown-check` is allowed to look at.
 *
 * A plain record rather than a container, so the rule below can be exercised
 * against every combination without a database, a keyring or a process. The
 * command's job is to gather these honestly; the rule's job is to judge them.
 */
interface ShutdownEvidence {
  /** Rows whose envelope is v1. */
  readonly v1Rows: number;
  /** Rows whose envelope is neither v1 nor v2 — unreadable, and not evidence of anything. */
  readonly unknownRows: number;
  /** Rows whose stored key id disagrees with the one inside their envelope. */
  readonly mismatchedRows: number;
  readonly format: KeyringFormat;
  readonly activeKeyId: string;
  readonly configuredKeyIds: readonly string[];
}

interface ShutdownVerdict {
  readonly ready: boolean;
  /** Each one names what is wrong AND the command that fixes it. */
  readonly blockers: readonly string[];
}

/**
 * Whether this installation can stop reading v1 — the gate, as one function.
 *
 * It fails closed: readiness is the absence of every blocker, never the
 * presence of a reassuring signal. Turning v1 off on an installation that
 * still holds a v1 row does not fail at boot; it fails the first time
 * something reads that row, in production, one credential at a time. So the
 * question has to be answered before the switch is flipped, from the rows
 * themselves rather than from an operator's recollection.
 *
 * Four conditions, and each blocker names the command that resolves it —
 * "not ready" without a next step is how an operator ends up editing
 * `nexa.env` by hand.
 */
export function shutdownVerdict(evidence: ShutdownEvidence): ShutdownVerdict {
  const blockers: string[] = [];

  if (evidence.v1Rows > 0) {
    blockers.push(
      `${evidence.v1Rows} row(s) still hold a v1 envelope. Refusing v1 now would make them ` +
        'unreadable. Run `botctl secrets rewrap` until it reports nothing left to re-encrypt.',
    );
  }
  if (evidence.unknownRows > 0) {
    blockers.push(
      `${evidence.unknownRows} row(s) hold an envelope that is neither v1 nor v2. They are ` +
        'already unreadable by this release, and nothing here can call that ready. Investigate ' +
        'before changing anything else.',
    );
  }
  if (evidence.mismatchedRows > 0) {
    blockers.push(
      `${evidence.mismatchedRows} row(s) record a key id that is not the one inside their ` +
        'envelope. Key retirement counts the recorded value, so this must be corrected first; ' +
        '`botctl secrets rewrap` rewrites both together.',
    );
  }
  // The pre-keyring spelling is the marker of a host that predates v2, and it
  // also leaves the active key implicit — derived from there being exactly one.
  // "The active encryption key is explicit" is part of the final state, so a
  // legacy-configured host is not ready however clean its rows are.
  if (evidence.format !== 'canonical') {
    blockers.push(
      'this host is still configured with the pre-keyring SECRETS_KEK spelling, which leaves the ' +
        'active key implicit. Run `botctl secrets migrate-config` first — it converts the ' +
        'configuration in place and changes no key material.',
    );
  }
  // Boot already refuses an active key that names no configured key. Checked
  // again here rather than assumed: a gate that leans on another layer's
  // guarantee stops being a gate the day that layer changes, and this one is
  // the last thing standing between an operator and an unreadable installation.
  if (
    evidence.activeKeyId.length === 0 ||
    !evidence.configuredKeyIds.includes(evidence.activeKeyId)
  ) {
    blockers.push(
      `the active key "${evidence.activeKeyId}" is not in the keyring (${
        evidence.configuredKeyIds.join(', ') || 'no keys configured'
      }). New secrets would be encrypted with a key nothing holds.`,
    );
  }

  return { ready: blockers.length === 0, blockers };
}

/** The evidence the rule needs, gathered from the rows and the keyring. */
function evidenceFrom(statuses: readonly ColumnStatus[], keyring: SecretKeyring): ShutdownEvidence {
  const count = (version: string): number =>
    statuses.reduce((total, status) => total + (status.byVersion.get(version) ?? 0), 0);
  return {
    v1Rows: count('v1'),
    unknownRows: count('unknown'),
    mismatchedRows: statuses.reduce((total, status) => total + status.mismatched, 0),
    format: keyring.format,
    activeKeyId: keyring.activeKeyId,
    configuredKeyIds: [...keyring.keys.keys()],
  };
}

/**
 * Rows that still depend on a key, counted from the stored column.
 *
 * `statusOf` has already established that the column and the envelope agree for
 * every row; without that this count would be a claim about bookkeeping rather
 * than about ciphertext.
 */
function dependenciesOn(statuses: readonly ColumnStatus[], keyId: string): number {
  return statuses.reduce((total, status) => total + (status.byKeyId.get(keyId) ?? 0), 0);
}

/**
 * One row, one short transaction.
 *
 * Bounded by `--batch` and `--max`; resumable because there is no state to
 * lose, and a killed run re-runs from the beginning and skips what converged;
 * idempotent because a row already v2 under the active key is skipped before
 * anything is decrypted.
 */
async function rewrapColumn(
  container: Container,
  column: SecretColumn,
  args: Args,
  activeKeyId: string,
): Promise<{ scanned: number; rewrapped: number; skipped: number }> {
  let cursor: string | null = null;
  let scanned = 0;
  let rewrapped = 0;
  let skipped = 0;

  while (scanned < args.max) {
    const limit = Math.min(args.batch, args.max - scanned);
    const page = await column.page(container.database.db, cursor, limit);
    if (page.length === 0) break;

    for (const entityId of page) {
      cursor = entityId;
      scanned += 1;

      const done = await container.database.db.transaction(async (tx) => {
        const row = await column.lock(tx, entityId);
        if (row === null) return false;

        // The skip predicate. Without it a converged run rewrites every row on
        // every invocation, which is not idempotence but churn — and it would
        // make "run it again until it reports zero" meaningless.
        if (envelopeVersion(row.ciphertext) === 'v2' && row.keyId === activeKeyId) return false;

        const scope: TenantContext = {
          tenantId: row.tenantId as TenantId,
          botInstanceId: null,
        };
        const context = {
          purpose: column.purpose,
          tenantId: row.tenantId,
          entityId,
        };
        const plaintext = container.cipher.decrypt(
          { keyId: row.keyId, ciphertext: row.ciphertext },
          context,
        );
        const next = container.cipher.encrypt(plaintext, context);

        if (!(await column.replace(tx, entityId, row.ciphertext, next))) return false;

        // Ids, key labels and versions. There is no branch of this function in
        // which a plaintext reaches an audit row.
        await container.audit.record(
          scope,
          systemJobActor('secrets:rewrap', container.ids.uuid() as CorrelationId),
          {
            action: 'secret.rewrap',
            entityType: 'Secret',
            entityId,
            before: {
              purpose: column.purpose,
              keyId: row.keyId,
              version: envelopeVersion(row.ciphertext),
            },
            after: { purpose: column.purpose, keyId: next.keyId, version: 'v2' },
            reason: 'Cryptographic maintenance: re-encrypted under the active key.',
            result: 'SUCCESS',
          },
          { tx, scope },
        );
        return true;
      });

      if (done) rewrapped += 1;
      else skipped += 1;
    }

    if (page.length < limit) break;
  }

  return { scanned, rewrapped, skipped };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const container = createContainer(config, 'worker');

  try {
    const keyring = resolveKeyring(config);
    const activeKeyId = keyring.activeKeyId;
    const statuses: ColumnStatus[] = [];
    for (const column of SECRET_COLUMNS) statuses.push(await statusOf(container, column));
    const { text, healthy } = report(statuses);
    const preamble = configurationLines(keyring, config).join('\n');

    if (args.command === 'status') {
      process.stdout.write(`${preamble}${text}\n`);
      if (!healthy) process.exitCode = 1;
      return;
    }

    if (args.command === 'shutdown-check') {
      // The gate `botctl secrets disable-v1` acts on. It answers one question —
      // may this installation stop reading v1 — and it answers it from the rows
      // and the keyring rather than from a claim. It never writes: the
      // configuration change is the operator's command, taken on this evidence.
      const verdict = shutdownVerdict(evidenceFrom(statuses, keyring));
      if (!verdict.ready) {
        process.stdout.write(
          `${preamble}${text}\n\nNOT READY to disable v1:\n` +
            verdict.blockers.map((blocker) => `  - ${blocker}`).join('\n') +
            '\n',
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `${preamble}${text}\n\nREADY: no v1 ciphertext, no key-id mismatch, canonical keyring, ` +
          `active key "${activeKeyId}" present.\n\n` +
          'Disabling v1 does NOT make old backups readable under the new rule. A dump taken\n' +
          'before the re-encryption still contains v1 ciphertext, and restoring it into an\n' +
          'installation that refuses v1 leaves those rows unreadable. Keep the old key material\n' +
          'AND re-enable SECRETS_ACCEPT_V1 for the duration of any such restore.\n',
      );
      return;
    }

    if (args.command === 'retire-check') {
      const keyId = args.keyId as string;
      // A check, never a mutation. It answers whether removing a key from
      // SECRETS_KEYS would strand ciphertext; the operator edits the file.
      if (keyId === activeKeyId) {
        process.stdout.write(
          `${preamble}${text}\nREFUSED: "${keyId}" is the active key. New secrets are encrypted with it.\n`,
        );
        process.exitCode = 1;
        return;
      }
      if (!healthy) {
        process.stdout.write(
          `${preamble}${text}\nREFUSED: some rows record a key id their envelope does not name.\n`,
        );
        process.exitCode = 1;
        return;
      }
      const dependencies = dependenciesOn(statuses, keyId);
      if (dependencies > 0) {
        process.stdout.write(
          `${preamble}${text}\nREFUSED: ${dependencies} row(s) still decrypt with "${keyId}". Run ` +
            '`botctl secrets rewrap` until none do.\n',
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `${preamble}${text}\nSAFE TO REMOVE FROM THE KEYRING: no live ciphertext depends on "${keyId}".\n\n` +
          'This is NOT permission to destroy the key material. Every retained backup taken before\n' +
          'the re-encryption still contains ciphertext under it, and a fresh backup does not make\n' +
          'those readable. Keep the key offline until the last such backup has passed its\n' +
          'retention window.\n',
      );
      return;
    }

    let scanned = 0;
    let rewrapped = 0;
    let skipped = 0;
    for (const column of SECRET_COLUMNS) {
      const result = await rewrapColumn(container, column, args, activeKeyId);
      scanned += result.scanned;
      rewrapped += result.rewrapped;
      skipped += result.skipped;
    }
    process.stdout.write(
      `scanned ${scanned}, re-encrypted ${rewrapped}, already current ${skipped}, active key ${activeKeyId}\n`,
    );
  } finally {
    await container.shutdown();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    if (error instanceof UsageError) console.error(error.message);
    else if (isNexaError(error)) console.error(`${error.code}: ${error.message}`);
    else console.error(error);
    process.exitCode = 1;
  });
}

export { parseArgs, report, dependenciesOn, statusOf, rewrapColumn, evidenceFrom };
export type { ColumnStatus, ShutdownEvidence, ShutdownVerdict };
