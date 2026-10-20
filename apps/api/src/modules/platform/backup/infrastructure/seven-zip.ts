import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  backupManifestSchema,
  NexaError,
  PLATFORM_ERROR_CODES,
  type BackupManifest,
} from '@nexa/contracts';
import { assertOutsideTransaction } from '../../../../infrastructure/transaction-boundary.js';

/**
 * The 7-Zip backup archive (Round 4 PR-E, E4).
 *
 * WHY 7z, AND WHY LZMA2 INSIDE IT. The owner's requirement is an archive an operator can
 * open on Windows with 7-Zip and the backup password alone. 7-Zip opens its own `.7z`
 * container with AES-256 and ENCRYPTED HEADERS (`-mhe=on`: without the password not even
 * the file names are readable), and LZMA2 is 7-Zip's native method — a zstd stream inside
 * a 7z would need a 7-Zip fork to open. The measurement that chose LZMA2 over
 * `zstd -19 --long` is in `docs/backup.md` § Compression.
 *
 * WHAT IS INSIDE. Exactly two entries, both with fixed names:
 *
 *   manifest.json     the run's `BackupManifest`: identity, versions, and the SHA-256 of
 *                     the dump, so a restore checks the bytes against the archive's own claim
 *   <dump file>       the `pg_dump` custom-format archive, written with `-Z0` so that LZMA2
 *                     — not gzip — does the compressing
 *
 * NON-SOLID (`-ms=off`), so the manifest can be read without decompressing the dump.
 *
 * THE PASSWORD NEVER TOUCHES ARGV. `7z -p<secret>` would publish it in `/proc/<pid>/cmdline`
 * — readable by any user on the HOST, not only in the container. It is written to the
 * child's STDIN instead, which 7-Zip reads when `-p` is given with no value (`a`) or when
 * an encrypted archive is opened with no `-p` at all (`l`, `x`, `t`). That is also why the
 * dump is a file and not piped in with `-si`: stdin is the password's.
 *
 * SPLITTING is not done by 7-Zip. 7-Zip's volumes `.7z.001`, `.7z.002`… are byte-exact
 * slices of the single archive, so the archive is written whole, verified whole, and its
 * parts are ranges of THAT file (`archive-parts.ts`) — the bytes delivered are the bytes
 * that were verified, and a byte-concatenation of the parts is the archive.
 */

/** The 7z signature: `7z` BC AF 27 1C. */
export const SEVEN_ZIP_SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);

const MANIFEST_ENTRY = 'manifest.json';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_CAPTURED = 16 * 1024;

export interface SevenZipOptions {
  /** The 7-Zip console binary (`7z`, or `7zz` on Debian bookworm's `7zip`). */
  readonly binary: string;
  /** LZMA2 level, 1–9. */
  readonly level: number;
  /** Compression threads. */
  readonly threads: number;
  readonly sealTimeoutMs: number;
  readonly openTimeoutMs: number;
}

/** Whether a file begins with the 7z signature. Reads six bytes. */
export async function isSevenZipFile(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(SEVEN_ZIP_SIGNATURE.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead === buffer.length && buffer.equals(SEVEN_ZIP_SIGNATURE);
  } finally {
    await handle.close();
  }
}

function malformed(detail: string): NexaError {
  return new NexaError({
    kind: 'INTERNAL',
    code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_MALFORMED,
    message: `A 7-Zip backup archive is not readable: ${detail}`,
  });
}

/**
 * ONE answer for a wrong password, a modified byte and a corrupted part — the same
 * uniformity the `NXB` reader keeps (`archiveAuthFailed`): an error that told them apart
 * would tell whoever holds the archive which guess was closer.
 */
function authFailed(): NexaError {
  return new NexaError({
    kind: 'INTERNAL',
    code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_AUTH_FAILED,
    message:
      'A 7-Zip backup archive could not be opened: the password is not the one it was sealed ' +
      'with, or the archive (or one of its parts) is damaged.',
  });
}

interface ChildResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: Buffer;
}

/**
 * Runs 7-Zip with the password on stdin, and nothing secret in argv.
 *
 * `stdoutSink`, when given, receives stdout as a stream (the dump); otherwise stdout is
 * captured up to `maxStdout` bytes (a listing, the manifest) and an overflow is a failure.
 */
function run7z(input: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly password: string | null;
  readonly timeoutMs: number;
  readonly stdoutSink?: NodeJS.WritableStream;
  readonly maxStdout?: number;
}): Promise<ChildResult> {
  assertOutsideTransaction('The 7-Zip subprocess');
  return new Promise((resolve, reject) => {
    const child = spawn(input.binary, [...input.args], {
      cwd: input.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // A locale 7-Zip can print paths in; nothing from the parent's environment is needed.
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    });
    let stderr = '';
    const chunks: Buffer[] = [];
    let captured = 0;
    let overflow = false;
    let timedOut = false;
    let sinkError: unknown = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, input.timeoutMs);

    // The password, then end-of-input: 7-Zip reads one line. An archive opened with the
    // wrong one, or none, fails rather than prompting again.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input.password === null ? '' : `${input.password}\n`);

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURED) stderr += chunk.toString('utf8');
    });
    // 7-Zip prints its prompts and diagnostics to stdout as well when stdout is not the
    // data stream; with `-so` only the data is on stdout.
    if (input.stdoutSink !== undefined) {
      const sink = input.stdoutSink;
      void pipeline(child.stdout, sink).catch((error: unknown) => {
        sinkError = error;
        child.kill('SIGTERM');
      });
    } else {
      const limit = input.maxStdout ?? MAX_CAPTURED * 64;
      child.stdout.on('data', (chunk: Buffer) => {
        if (overflow) return;
        captured += chunk.length;
        if (captured > limit) {
          overflow = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
    }
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        new NexaError({
          kind: 'CONFIGURATION',
          code: PLATFORM_ERROR_CODES.BACKUP_TOOL_FAILED,
          message: `Could not run "${input.binary}". A 7-Zip backup needs 7-Zip on PATH.`,
          details: { reason: error.message },
        }),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new NexaError({
            kind: 'INTERNAL',
            code: PLATFORM_ERROR_CODES.BACKUP_TOOL_FAILED,
            message: `7-Zip did not finish within ${String(input.timeoutMs)}ms and was stopped.`,
          }),
        );
        return;
      }
      if (sinkError !== null) {
        reject(sinkError instanceof Error ? sinkError : new Error(String(sinkError)));
        return;
      }
      if (overflow) {
        reject(malformed('7-Zip wrote more output than a listing can be'));
        return;
      }
      resolve({ code, stderr, stdout: Buffer.concat(chunks) });
    });
  });
}

/** The archive-type switch: a `.001` is opened as 7-Zip's split set, anything else as 7z. */
function typeSwitch(archivePath: string): string {
  return /\.001$/.test(archivePath) ? '-t7z.split' : '-t7z';
}

/**
 * Seals `dumpPath` and its manifest into a new 7z at `archivePath`.
 *
 * The manifest is written beside the dump (it is plaintext of the same kind and goes with
 * it), added under the fixed name `manifest.json`, and removed afterwards whatever happens.
 */
export async function sealSevenZip(input: {
  readonly dumpPath: string;
  readonly archivePath: string;
  readonly manifest: BackupManifest;
  readonly password: string;
  readonly options: SevenZipOptions;
}): Promise<{ readonly archiveBytes: number }> {
  const directory = dirname(input.dumpPath);
  const manifestPath = join(directory, MANIFEST_ENTRY);
  const dumpName = basename(input.dumpPath);
  if (dumpName === MANIFEST_ENTRY) throw malformed('the dump cannot be named like the manifest');
  await rm(input.archivePath, { force: true });
  await writeFile(manifestPath, JSON.stringify(input.manifest), { mode: 0o600, flag: 'w' });
  try {
    const result = await run7z({
      binary: input.options.binary,
      cwd: directory,
      password: input.password,
      timeoutMs: input.options.sealTimeoutMs,
      args: [
        'a',
        '-t7z',
        '-m0=lzma2',
        `-mx=${String(input.options.level)}`,
        `-mmt=${String(input.options.threads)}`,
        '-ms=off',
        '-mhe=on',
        // `-p` with no value: read the password from stdin.
        '-p',
        '-bd',
        '-y',
        '--',
        input.archivePath,
        MANIFEST_ENTRY,
        dumpName,
      ],
    });
    if (result.code !== 0) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_TOOL_FAILED,
        message: '7-Zip could not write the backup archive.',
        details: { exitCode: result.code, stderr: result.stderr.slice(0, 2000) },
      });
    }
  } finally {
    await rm(manifestPath, { force: true });
  }
  const { size } = await stat(input.archivePath);
  return { archiveBytes: size };
}

interface Listing {
  readonly entries: readonly string[];
}

/** Lists the archive with one password. Null when the password does not open it. */
async function list(
  archivePath: string,
  password: string,
  options: SevenZipOptions,
): Promise<Listing | null> {
  const result = await run7z({
    binary: options.binary,
    password,
    timeoutMs: options.openTimeoutMs,
    args: ['l', '-slt', '-bd', typeSwitch(archivePath), '--', archivePath],
  });
  const text = result.stdout.toString('utf8');
  if (result.code !== 0) {
    if (/wrong password|cannot open encrypted archive/i.test(`${text}\n${result.stderr}`)) {
      return null;
    }
    if (
      /missing volume|unexpected end|is not archive|cannot open the file as/i.test(
        text + result.stderr,
      )
    ) {
      throw malformed('the archive (or a part of it) is missing or is not a 7z archive');
    }
    throw authFailed();
  }
  // `-slt` prints the archive's own blocks (one per layer: the split set, then the 7z),
  // then a line of ten dashes, then one `Path = …` per ENTRY.
  const separator = text.indexOf('\n----------\n');
  if (separator < 0) throw malformed('7-Zip printed a listing this release cannot read');
  const body = text.slice(separator + '\n----------\n'.length);
  const paths = [...body.matchAll(/^Path = (.*)$/gm)].map((match) => (match[1] ?? '').trim());
  return { entries: paths };
}

/**
 * Opens a 7z backup into `dumpPath`, trying each candidate password in order.
 *
 * The SAME function the pipeline's verification, the Web Admin's recovery and the CLI's
 * `verify`/`restore` use for a 7z (through `DualFormatBackupArchiver.open`). Streams the
 * dump through a SHA-256 to disk; 7-Zip's own CRC over every byte fails the extraction of
 * a damaged part, and the caller compares the digest with the manifest.
 */
export async function openSevenZip(input: {
  readonly archivePath: string;
  readonly dumpPath: string;
  readonly passwords: readonly string[];
  readonly options: SevenZipOptions;
}): Promise<{
  readonly manifest: BackupManifest;
  readonly dumpChecksum: string;
  readonly dumpBytes: number;
  /** Which of `passwords` opened it (its index). */
  readonly passwordIndex: number;
}> {
  if (input.passwords.length === 0) throw authFailed();
  let listing: Listing | null = null;
  let passwordIndex = -1;
  for (let index = 0; index < input.passwords.length; index += 1) {
    listing = await list(input.archivePath, input.passwords[index] ?? '', input.options);
    if (listing !== null) {
      passwordIndex = index;
      break;
    }
  }
  if (listing === null || passwordIndex < 0) throw authFailed();
  const password = input.passwords[passwordIndex] ?? '';

  const dumpEntries = listing.entries.filter((entry) => entry !== MANIFEST_ENTRY);
  if (!listing.entries.includes(MANIFEST_ENTRY) || dumpEntries.length !== 1) {
    throw malformed('it does not hold exactly one manifest and one dump');
  }
  const dumpEntry = dumpEntries[0] ?? '';
  if (dumpEntry.includes('/') || dumpEntry.includes('\\') || dumpEntry.startsWith('.')) {
    throw malformed('the dump entry has a path, which this format never writes');
  }

  const manifestRun = await run7z({
    binary: input.options.binary,
    password,
    timeoutMs: input.options.openTimeoutMs,
    maxStdout: MAX_MANIFEST_BYTES,
    args: [
      'x',
      '-so',
      '-bd',
      typeSwitch(input.archivePath),
      '--',
      input.archivePath,
      MANIFEST_ENTRY,
    ],
  });
  if (manifestRun.code !== 0) throw authFailed();
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRun.stdout.toString('utf8'));
  } catch {
    throw malformed('the manifest is not JSON');
  }
  const manifest = backupManifestSchema.safeParse(parsed);
  if (!manifest.success) {
    throw malformed('the manifest does not match the schema this release reads');
  }

  const digest = createHash('sha256');
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      digest.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  const out = createWriteStream(input.dumpPath, { mode: 0o600 });
  const sinkDone = pipeline(counter, out);
  const dumpRun = await run7z({
    binary: input.options.binary,
    password,
    timeoutMs: input.options.openTimeoutMs,
    stdoutSink: counter,
    args: ['x', '-so', '-bd', typeSwitch(input.archivePath), '--', input.archivePath, dumpEntry],
  });
  await sinkDone;
  if (dumpRun.code !== 0) {
    await rm(input.dumpPath, { force: true });
    if (/missing volume|unexpected end/i.test(dumpRun.stderr)) {
      throw malformed('a part of the archive is missing');
    }
    throw authFailed();
  }
  return {
    manifest: manifest.data,
    dumpChecksum: digest.digest('hex'),
    dumpBytes: bytes,
    passwordIndex,
  };
}
