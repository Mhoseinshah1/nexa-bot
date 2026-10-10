import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { parseStrictJson } from './canonical-json.js';
import {
  MAX_CHUNKS,
  PREFIX_LEN,
  TAG_LEN,
  b64dCanonical,
  chunkNonce,
  deriveVerifiedKeys,
  headerInfo,
  openChunk,
  parseHeaderBody,
  parsePrefix,
  type NxpkgHeader,
  type NxpkgHeaderInfo,
  type NxpkgSecret,
} from './crypto.js';
import { NxpkgError, containerInvalid, tampered } from './errors.js';
import {
  CHECKSUMS_NAME,
  MANIFEST_NAME,
  gateManifestVersion,
  isSafeRelpath,
  jsonEqual,
  validateFileEntries,
  validateManifest,
  type NxpkgFileEntry,
  type NxpkgManifest,
} from './manifest.js';
import { readZipDirectory, readZipEntry, type ZipEntry } from './zip.js';

/**
 * A strict, streaming `.nxpkg` reader — the TypeScript twin of the converter's
 * `mirza2nexa/nxpkg/reader.py`. `openNxpkg` authenticates EVERYTHING before it returns:
 *
 *   1. the public header (magic, container major, canonical JSON, exact key set);
 *   2. the secret against `key_check` (`NXPKG_WRONG_KEY` before any decryption);
 *   3. every STREAM chunk: tag, position (counter), the final-chunk flag, no truncation and
 *      no byte after the final chunk. Plaintext goes to a 0600 file in a private 0700
 *      directory, and is deleted if anything fails;
 *   4. the payload ZIP's structure (`zip.ts`), the manifest's version gate, `checksums.json`
 *      against every entry (SHA-256, size, JSONL record count and final newline, CRC-32),
 *      no extra or missing entry, and the full manifest.
 *
 * Reads after `openNxpkg` (`readJson`, `iterJsonl`) stream from the decrypted ZIP and check
 * the file's SHA-256 again at the end, as the converter's reader does, in case the
 * plaintext was changed on disk after verification.
 *
 * Errors are `NxpkgError` (see `errors.ts`). Operating-system failures (the package path
 * does not exist, the disk is full) propagate as the `Error` Node raised.
 */

export interface NxpkgOpenOptions {
  /** Parent of the private working directory; created 0700 if missing. */
  workDir: string;
  /** Upper bound on the decrypted payload (the ZIP), in bytes. */
  maxPayloadBytes: number;
  /** Upper bound on ZIP entries, `manifest.json` and `checksums.json` included. */
  maxFiles: number;
  /** Upper bound on any one file's uncompressed size, in bytes. */
  maxFileBytes: number;
  signal?: AbortSignal;
}

export interface NxpkgFileInfo extends NxpkgFileEntry {
  path: string;
}

export interface NxpkgPackage {
  readonly header: NxpkgHeader;
  readonly manifest: NxpkgManifest;
  /** Hex SHA-256 of the header bytes (MAGIC..header JSON): `package_header_sha256`. */
  readonly headerSha256: string;
  /** Hex SHA-256 of the whole `.nxpkg` file as read. */
  readonly fileSha256: string;
  /** Hex SHA-256 of the decrypted payload ZIP (independent of key, salt and nonce). */
  readonly payloadSha256: string;
  readonly payloadSize: number;
  readonly chunks: number;
  /** Every file listed by `checksums.json` (manifest.json included), sorted by path. */
  files(): NxpkgFileInfo[];
  has(rel: string): boolean;
  readJson(rel: string): Promise<unknown>;
  iterJsonl(rel: string): AsyncGenerator<Record<string, unknown>>;
  /** Delete the private working directory. Idempotent. */
  close(): Promise<void>;
}

/** Bound for `manifest.json`, `checksums.json`, `readJson()` and any one JSONL line. */
export const MAX_META_JSON = 64 * 1024 * 1024;
const PAYLOAD_NAME = 'payload.zip';

// --------------------------------------------------------------------------- header

async function readExactly(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const { bytesRead } = await fh.read(buf, off, length - off, position + off);
    if (bytesRead === 0) break;
    off += bytesRead;
  }
  return off === length ? buf : buf.subarray(0, off);
}

async function readHeaderFrom(fh: FileHandle): Promise<NxpkgHeaderInfo> {
  const prefix = await readExactly(fh, 0, PREFIX_LEN);
  const hlen = parsePrefix(prefix);
  const body = await readExactly(fh, PREFIX_LEN, hlen);
  if (body.length !== hlen) throw containerInvalid('header_truncated');
  const header = parseHeaderBody(body);
  return headerInfo(header, Buffer.concat([prefix, body]));
}

/** Parse and validate the public header. Needs no secret; holds no customer data. */
export async function readNxpkgHeader(path: string): Promise<NxpkgHeaderInfo> {
  const fh = await open(path, 'r');
  try {
    return await readHeaderFrom(fh);
  } finally {
    await fh.close();
  }
}

// --------------------------------------------------------------------------- open

function checkLimit(name: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
    throw new RangeError(`openNxpkg: ${name} must be a positive integer`);
  }
  return v;
}

export async function openNxpkg(
  path: string,
  secret: NxpkgSecret,
  opts: NxpkgOpenOptions,
): Promise<NxpkgPackage> {
  const maxPayloadBytes = checkLimit('maxPayloadBytes', opts.maxPayloadBytes);
  const maxFiles = checkLimit('maxFiles', opts.maxFiles);
  const maxFileBytes = checkLimit('maxFileBytes', opts.maxFileBytes);
  const signal = opts.signal;

  await mkdir(opts.workDir, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(opts.workDir, 'nxpkg-'));
  try {
    await chmod(dir, 0o700);
    const st = await lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('nxpkg work dir is not private');
    const payloadPath = join(dir, PAYLOAD_NAME);
    const decrypted = await decryptToFile(path, secret, payloadPath, maxPayloadBytes, signal);
    const verified = await verifyPayload(payloadPath, { maxFiles, maxFileBytes }, signal);
    return new Package(dir, payloadPath, decrypted, verified, signal);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

interface Decrypted {
  info: NxpkgHeaderInfo;
  fileSha256: string;
  payloadSha256: string;
  payloadSize: number;
  chunks: number;
}

async function decryptToFile(
  path: string,
  secret: NxpkgSecret,
  payloadPath: string,
  maxPayloadBytes: number,
  signal: AbortSignal | undefined,
): Promise<Decrypted> {
  const partial = `${payloadPath}.partial`;
  const fh = await open(path, 'r');
  let out: FileHandle | null = null;
  try {
    const fileSize = (await fh.stat()).size;
    const info = await readHeaderFrom(fh);
    const { header } = info;
    const chunkSize = header.chunk_size;
    // Upper bound on a package that could hold maxPayloadBytes: header, then one 4-byte
    // length and one tag per chunk (plus the possibly empty final chunk).
    const maxChunks = Math.floor(maxPayloadBytes / chunkSize) + 1;
    if (fileSize - info.headerBytes.length > maxPayloadBytes + maxChunks * (4 + TAG_LEN)) {
      throw containerInvalid('payload_too_large');
    }
    const keys = await deriveVerifiedKeys(header, secret);
    const noncePrefix = b64dCanonical(header.nonce_prefix) as Buffer;
    const aad = createHash('sha256').update(info.headerBytes).digest();
    const fileHash = createHash('sha256').update(info.headerBytes);
    const payloadHash = createHash('sha256');
    out = await open(partial, 'wx', 0o600);

    const maxCt = chunkSize + TAG_LEN;
    let pos = info.headerBytes.length;
    let counter = 0;
    let size = 0;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const lb = await readExactly(fh, pos, 4);
        if (lb.length === 0) throw tampered('truncated_final_chunk_missing');
        if (lb.length !== 4) throw tampered('truncated_chunk_length');
        const ctLen = lb.readUInt32BE(0);
        if (ctLen < TAG_LEN || ctLen > maxCt) throw tampered('chunk_length_out_of_range');
        const ct = await readExactly(fh, pos + 4, ctLen);
        if (ct.length !== ctLen) throw tampered('truncated_chunk');
        fileHash.update(lb).update(ct);
        pos += 4 + ctLen;
        // A full-size chunk may be non-final or final; a short one can only be final.
        let pt: Buffer | null = null;
        let last = false;
        if (ctLen === maxCt) {
          pt = openChunk(keys.encKey, chunkNonce(noncePrefix, counter, false), aad, ct);
        }
        if (pt === null) {
          pt = openChunk(keys.encKey, chunkNonce(noncePrefix, counter, true), aad, ct);
          last = true;
          if (pt === null) throw tampered('chunk_authentication_failed');
        }
        counter += 1;
        size += pt.length;
        if (size > maxPayloadBytes) throw containerInvalid('payload_too_large');
        payloadHash.update(pt);
        await out.write(pt);
        if (last) {
          const extra = await readExactly(fh, pos, 1);
          if (extra.length !== 0) throw tampered('trailing_data');
          break;
        }
        if (counter >= MAX_CHUNKS) throw tampered('too_many_chunks');
      }
    } finally {
      keys.encKey.fill(0);
    }
    await out.sync();
    await out.close();
    out = null;
    await rename(partial, payloadPath);
    return {
      info,
      fileSha256: fileHash.digest('hex'),
      payloadSha256: payloadHash.digest('hex'),
      payloadSize: size,
      chunks: counter,
    };
  } finally {
    await fh.close();
    if (out !== null) await out.close();
  }
}

// --------------------------------------------------------------------------- payload

interface Verified {
  manifest: NxpkgManifest;
  files: Record<string, NxpkgFileEntry>;
  entries: Map<string, ZipEntry>;
}

async function readWholeEntry(
  payloadPath: string,
  entry: ZipEntry,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of readZipEntry(payloadPath, entry, signal)) parts.push(chunk);
  return Buffer.concat(parts);
}

async function loadMetaJson(
  payloadPath: string,
  entry: ZipEntry,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (entry.size > MAX_META_JSON) throw tampered('meta_json_too_large');
  const data = await readWholeEntry(payloadPath, entry, signal);
  try {
    return parseStrictJson(data);
  } catch (err) {
    if (err instanceof NxpkgError) throw tampered('meta_json_unreadable');
    throw err;
  }
}

async function verifyPayload(
  payloadPath: string,
  limits: { maxFiles: number; maxFileBytes: number },
  signal: AbortSignal | undefined,
): Promise<Verified> {
  const fh = await open(payloadPath, 'r');
  let list: ZipEntry[];
  try {
    list = await readZipDirectory(fh, (await fh.stat()).size, limits);
  } finally {
    await fh.close();
  }
  const byName = new Map(list.map((e) => [e.name, e] as const));
  const manifestEntry = byName.get(MANIFEST_NAME);
  const checksumsEntry = byName.get(CHECKSUMS_NAME);
  if (!manifestEntry || !checksumsEntry) throw tampered('manifest_or_checksums_missing');

  // Version gate first, so a future-format package yields "unsupported", not "tampered".
  const manifest = await loadMetaJson(payloadPath, manifestEntry, signal);
  gateManifestVersion(manifest);

  const checksums = await loadMetaJson(payloadPath, checksumsEntry, signal);
  if (
    typeof checksums !== 'object' ||
    checksums === null ||
    Array.isArray(checksums) ||
    Object.keys(checksums).sort().join(',') !== 'algorithm,files'
  ) {
    throw tampered('checksums_structure');
  }
  const cs = checksums as { algorithm: unknown; files: unknown };
  if (cs.algorithm !== 'sha256') throw tampered('checksums_algorithm');
  validateFileEntries(cs.files);
  const files = cs.files;
  const listed = Object.keys(files);
  if (listed.includes(CHECKSUMS_NAME) || !listed.includes(MANIFEST_NAME)) {
    throw tampered('checksums_file_list');
  }
  if (byName.size !== listed.length + 1 || !listed.every((n) => byName.has(n))) {
    throw tampered('zip_entries_differ_from_checksums');
  }

  for (const name of [...listed].sort()) {
    const want = files[name] as NxpkgFileEntry;
    const entry = byName.get(name) as ZipEntry;
    if (entry.size !== want.size) throw tampered('size_mismatch');
    const h = createHash('sha256');
    let n = 0;
    let lines = 0;
    let lastByte = -1;
    for await (const chunk of readZipEntry(payloadPath, entry, signal)) {
      h.update(chunk);
      n += chunk.length;
      lines += countNewlines(chunk);
      lastByte = chunk[chunk.length - 1] ?? lastByte;
    }
    if (n !== want.size || h.digest('hex') !== want.sha256) throw tampered('checksum_mismatch');
    if (name.endsWith('.jsonl')) {
      if (n > 0 && lastByte !== 0x0a) throw tampered('jsonl_not_newline_terminated');
      if (want.records !== lines) throw tampered('record_count_mismatch');
    }
  }

  validateManifest(manifest);
  const expected: Record<string, NxpkgFileEntry> = {};
  for (const [k, v] of Object.entries(files)) if (k !== MANIFEST_NAME) expected[k] = v;
  if (!jsonEqual(manifest.files, expected)) throw tampered('manifest_files_differ_from_checksums');
  return { manifest, files, entries: byName };
}

function countNewlines(buf: Buffer): number {
  let count = 0;
  let i = buf.indexOf(0x0a);
  while (i !== -1) {
    count += 1;
    i = buf.indexOf(0x0a, i + 1);
  }
  return count;
}

// --------------------------------------------------------------------------- package

class Package implements NxpkgPackage {
  readonly header: NxpkgHeader;
  readonly manifest: NxpkgManifest;
  readonly headerSha256: string;
  readonly fileSha256: string;
  readonly payloadSha256: string;
  readonly payloadSize: number;
  readonly chunks: number;
  private closed = false;

  constructor(
    private readonly dir: string,
    private readonly payloadPath: string,
    d: Decrypted,
    private readonly verified: Verified,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.header = d.info.header;
    this.headerSha256 = d.info.headerSha256;
    this.fileSha256 = d.fileSha256;
    this.payloadSha256 = d.payloadSha256;
    this.payloadSize = d.payloadSize;
    this.chunks = d.chunks;
    this.manifest = verified.manifest;
  }

  files(): NxpkgFileInfo[] {
    return Object.keys(this.verified.files)
      .sort()
      .map((path) => ({ path, ...(this.verified.files[path] as NxpkgFileEntry) }));
  }

  has(rel: string): boolean {
    return isSafeRelpath(rel) && Object.hasOwn(this.verified.files, rel);
  }

  private entry(rel: string): { want: NxpkgFileEntry; zip: ZipEntry } {
    if (this.closed) throw new Error('nxpkg package is closed');
    if (!this.has(rel)) throw containerInvalid('missing_file');
    return {
      want: this.verified.files[rel] as NxpkgFileEntry,
      zip: this.verified.entries.get(rel) as ZipEntry,
    };
  }

  async readJson(rel: string): Promise<unknown> {
    const { want, zip } = this.entry(rel);
    if (want.size > MAX_META_JSON) throw containerInvalid('file_too_large_for_read_json');
    const data = await readWholeEntry(this.payloadPath, zip, this.signal);
    if (createHash('sha256').update(data).digest('hex') !== want.sha256) {
      throw tampered('changed_after_verification');
    }
    try {
      return parseStrictJson(data);
    } catch (err) {
      if (err instanceof NxpkgError) throw containerInvalid('invalid_json_file');
      throw err;
    }
  }

  async *iterJsonl(rel: string): AsyncGenerator<Record<string, unknown>> {
    const { want, zip } = this.entry(rel);
    const h = createHash('sha256');
    let pending: Buffer[] = [];
    let pendingLen = 0;
    for await (const chunk of readZipEntry(this.payloadPath, zip, this.signal)) {
      h.update(chunk);
      let start = 0;
      let nl = chunk.indexOf(0x0a);
      while (nl !== -1) {
        const piece = chunk.subarray(start, nl + 1);
        const line = pendingLen === 0 ? piece : Buffer.concat([...pending, piece]);
        pending = [];
        pendingLen = 0;
        yield parseRecord(line);
        start = nl + 1;
        nl = chunk.indexOf(0x0a, start);
      }
      if (start < chunk.length) {
        pendingLen += chunk.length - start;
        if (pendingLen > MAX_META_JSON) throw containerInvalid('record_too_large');
        pending.push(chunk.subarray(start));
      }
    }
    if (pendingLen > 0) throw tampered('jsonl_not_newline_terminated');
    if (h.digest('hex') !== want.sha256) throw tampered('changed_after_verification');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await rm(this.dir, { recursive: true, force: true });
  }
}

function parseRecord(line: Buffer): Record<string, unknown> {
  let obj: unknown;
  try {
    obj = parseStrictJson(line);
  } catch (err) {
    if (err instanceof NxpkgError) throw containerInvalid('invalid_record');
    throw err;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw containerInvalid('invalid_record');
  }
  return obj as Record<string, unknown>;
}
