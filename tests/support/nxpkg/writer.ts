import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, stat, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeflateRaw, crc32 } from 'node:zlib';
import { canonicalJson } from '../../../apps/api/src/infrastructure/nxpkg/canonical-json';
import {
  CIPHER,
  DEFAULT_CHUNK_SIZE,
  FORMAT_MAJOR,
  FORMAT_NAME,
  KEY_LEN,
  NONCE_PREFIX_LEN,
  SALT_LEN,
  chunkNonce,
  encodeHeader,
  encodeKeyFile,
  encryptionKeyOf,
  keyCheckOf,
  masterKey,
  parseKeyFile,
  sealChunk,
  type NxpkgHeader,
  type NxpkgKdf,
} from '../../../apps/api/src/infrastructure/nxpkg/crypto';
import {
  decisionsMac,
  DECISIONS_AUTH_ALG,
} from '../../../apps/api/src/infrastructure/nxpkg/decisions';

/**
 * TEST-ONLY `.nxpkg` writer. Never imported by application code.
 *
 * It produces packages in the converter's layout — deterministic ZIP (sorted names, data
 * descriptors, DEFLATE, Unix 0644, 1980-01-01), canonical `manifest.json` /
 * `checksums.json`, AES-256-GCM STREAM — so tests can build any package they need without
 * Python. Every hook below runs BEFORE encryption, so a "tampered" package built with one
 * still authenticates: it is how a test reaches the checks that sit behind the AEAD (a
 * checksum mismatch, a traversal name, a symlink entry, an unsupported version). Byte-level
 * tampering of the finished file is in `./tamper.ts`.
 *
 * Its output was checked once against the converter's own Python reader
 * (`PackageReader.verify`, mirza-to-nexa 0.4.x) — see `tests/fixtures/nxpkg/README.md`.
 *
 * It shares the key schedule and chunk primitives with the reader on purpose (one
 * implementation of HKDF/GCM); the cross-language fixture is what keeps that honest.
 */

export type WriterSecret =
  | { rawKey: Uint8Array }
  | { keyFileText: string }
  | { passphrase: string; kdfN?: number; kdfR?: number; kdfP?: number };

export type FileSource =
  | Buffer
  | string
  | { json: unknown }
  | { records: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>> }
  | { path: string };

export interface ZipMember {
  name: string;
  /** Raw (uncompressed) content. */
  source: Buffer | { path: string };
  /** Compression method written to the headers. 8 deflates; anything else stores the bytes. */
  method?: number;
  externalAttr?: number;
  madeBy?: number;
  /** Lie about the uncompressed size / CRC in every header (content unchanged). */
  sizeOverride?: number;
  crcOverride?: number;
}

export interface WriteNxpkgOptions {
  files: Record<string, FileSource>;
  secret: WriterSecret;
  /** Merged over the default caller manifest (shallow). `files`/`payload_format` are added. */
  manifest?: Record<string, unknown>;
  chunkSize?: number;
  salt?: Buffer;
  noncePrefix?: Buffer;
  createdBy?: { name: string; version: string };
  stagingDir?: string;
  /** Force ZIP64 local records/descriptors; `'full'` also ZIP64 central records + end record. */
  zip64?: boolean | 'full';
  transformManifest?: (m: Record<string, unknown>) => unknown;
  transformChecksums?: (c: Record<string, unknown>) => unknown;
  transformEntries?: (members: ZipMember[]) => ZipMember[];
  transformHeader?: (h: NxpkgHeader) => unknown;
  /** Replace the whole payload (the ZIP) with these bytes. */
  rawPayload?: Buffer;
}

export interface WrittenNxpkg {
  path: string;
  /** The key file text when the package uses a raw key. */
  keyFileText: string | null;
  headerSha256: string;
  payloadSha256: string;
  payloadSize: number;
  manifest: Record<string, unknown>;
  size: number;
}

export const DEFAULT_TEST_MANIFEST: Readonly<Record<string, unknown>> = {
  package_schema: 'nexa.migration.mirza',
  package_schema_version: '1.4.0',
  import_id: '0123456789abcdef0123456789abcdef',
  source_fingerprint: 'sha256:synthetic-test-writer',
  converter: { name: 'nexa-test-writer', version: '0.0.0' },
  created_at: '2026-10-10T00:00:00Z',
  compatibility: { min_importer_version: '1.0.0', target: 'nexa' },
};

export function newRawKey(): { rawKey: Buffer; keyFileText: string } {
  const rawKey = randomBytes(KEY_LEN);
  return { rawKey, keyFileText: encodeKeyFile(rawKey) };
}

// --------------------------------------------------------------------------- staging

interface Staged {
  source: Buffer | { path: string };
  sha256: string;
  size: number;
  records: number | null;
}

async function hashPath(path: string, countLines: boolean): Promise<Omit<Staged, 'source'>> {
  const h = createHash('sha256');
  let size = 0;
  let lines = 0;
  for await (const c of createReadStream(path) as AsyncIterable<Buffer>) {
    h.update(c);
    size += c.length;
    if (countLines) for (const b of c) if (b === 0x0a) lines++;
  }
  return { sha256: h.digest('hex'), size, records: countLines ? lines : null };
}

function hashBuffer(buf: Buffer, countLines: boolean): Omit<Staged, 'source'> {
  let lines = 0;
  if (countLines) for (const b of buf) if (b === 0x0a) lines++;
  return {
    sha256: createHash('sha256').update(buf).digest('hex'),
    size: buf.length,
    records: countLines ? lines : null,
  };
}

async function stage(rel: string, src: FileSource, dir: string, n: number): Promise<Staged> {
  const jsonl = rel.endsWith('.jsonl');
  if (Buffer.isBuffer(src) || typeof src === 'string') {
    const buf = Buffer.isBuffer(src) ? src : Buffer.from(src, 'utf8');
    return { source: buf, ...hashBuffer(buf, jsonl) };
  }
  if ('json' in src) {
    const buf = canonicalJson(src.json);
    return { source: buf, ...hashBuffer(buf, jsonl) };
  }
  if ('path' in src) return { source: { path: src.path }, ...(await hashPath(src.path, jsonl)) };
  const path = join(dir, `staged-${n}.jsonl`);
  const fh = await open(path, 'wx', 0o600);
  const h = createHash('sha256');
  let size = 0;
  let count = 0;
  let batch: Buffer[] = [];
  let batchLen = 0;
  try {
    for await (const rec of src.records as AsyncIterable<Record<string, unknown>>) {
      const line = Buffer.concat([canonicalJson(rec), Buffer.from('\n')]);
      h.update(line);
      size += line.length;
      count++;
      batch.push(line);
      batchLen += line.length;
      if (batchLen >= 1 << 20) {
        await fh.write(Buffer.concat(batch));
        batch = [];
        batchLen = 0;
      }
    }
    if (batchLen) await fh.write(Buffer.concat(batch));
  } finally {
    await fh.close();
  }
  return { source: { path }, sha256: h.digest('hex'), size, records: count };
}

// --------------------------------------------------------------------------- ZIP

const U32 = 0xffffffff;

async function* sourceChunks(src: Buffer | { path: string }): AsyncGenerator<Buffer> {
  if (Buffer.isBuffer(src)) {
    for (let i = 0; i < src.length; i += 1 << 20) yield src.subarray(i, i + (1 << 20));
    return;
  }
  yield* createReadStream(src.path, { highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>;
}

async function* deflate(
  src: AsyncIterable<Buffer>,
  onInput: (b: Buffer) => void,
): AsyncGenerator<Buffer> {
  const d = createDeflateRaw();
  const feeder = (async () => {
    for await (const c of src) {
      onInput(c);
      if (!d.write(c)) await once(d, 'drain');
    }
    d.end();
  })();
  feeder.catch((e: unknown) => d.destroy(e as Error));
  for await (const out of d as AsyncIterable<Buffer>) yield out;
  await feeder;
}

/** Python `write_deterministic_zip` over a non-seekable sink, as a byte stream. */
export async function* zipStream(
  members: readonly ZipMember[],
  zip64: boolean | 'full' = false,
): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;
  const z64local = zip64 !== false;
  const z64full = zip64 === 'full';
  for (const m of members) {
    const method = m.method ?? 8;
    const name = Buffer.from(m.name, 'utf8');
    const flags = 0x0008 | (isAscii(m.name) ? 0 : 0x0800);
    const version = z64local || z64full ? 45 : 20;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(version, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time 00:00:00
    local.writeUInt16LE(0x21, 12); // date 1980-01-01
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(z64local ? U32 : 0, 18);
    local.writeUInt32LE(z64local ? U32 : 0, 22);
    local.writeUInt16LE(name.length, 26);
    const lextra = z64local ? Buffer.alloc(20) : Buffer.alloc(0);
    if (z64local) {
      lextra.writeUInt16LE(1, 0);
      lextra.writeUInt16LE(16, 2);
    }
    local.writeUInt16LE(lextra.length, 28);
    const headerOffset = offset;
    const head = Buffer.concat([local, name, lextra]);
    yield head;
    offset += head.length;

    let crc = 0;
    let usize = 0;
    let csize = 0;
    const onInput = (b: Buffer): void => {
      crc = crc32(b, crc);
      usize += b.length;
    };
    const body = method === 8 ? deflate(sourceChunks(m.source), onInput) : sourceChunks(m.source);
    for await (const c of body) {
      if (method !== 8) onInput(c);
      csize += c.length;
      offset += c.length;
      yield c;
    }
    crc = m.crcOverride ?? crc >>> 0;
    usize = m.sizeOverride ?? usize;
    const desc = Buffer.alloc(z64local ? 24 : 16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc, 4);
    if (z64local) {
      desc.writeBigUInt64LE(BigInt(csize), 8);
      desc.writeBigUInt64LE(BigInt(usize), 16);
    } else {
      if (csize > U32 || usize > U32) throw new RangeError('entry needs zip64');
      desc.writeUInt32LE(csize, 8);
      desc.writeUInt32LE(usize, 12);
    }
    yield desc;
    offset += desc.length;

    const needU = z64full || usize > U32;
    const needC = z64full || csize > U32;
    const needO = z64full || headerOffset > U32;
    const cx: Buffer[] = [];
    if (needU) cx.push(u64(usize));
    if (needC) cx.push(u64(csize));
    if (needO) cx.push(u64(headerOffset));
    const cextra = cx.length ? Buffer.concat([u16(1), u16(cx.length * 8), ...cx]) : Buffer.alloc(0);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(m.madeBy ?? (3 << 8) | version, 4);
    c.writeUInt16LE(version, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(needC ? U32 : csize, 20);
    c.writeUInt32LE(needU ? U32 : usize, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(cextra.length, 30);
    c.writeUInt16LE(0, 32);
    c.writeUInt16LE(0, 34);
    c.writeUInt16LE(0, 36);
    c.writeUInt32LE((m.externalAttr ?? 0o100644 * 0x10000) >>> 0, 38);
    c.writeUInt32LE(needO ? U32 : headerOffset, 42);
    central.push(Buffer.concat([c, name, cextra]));
  }
  const cd = Buffer.concat(central);
  const cdOffset = offset;
  yield cd;
  offset += cd.length;
  const count = members.length;
  const need64 = z64full || count > 0xffff || cdOffset > U32 || cd.length > U32;
  if (need64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeUInt32LE(0, 16);
    rec.writeUInt32LE(0, 20);
    rec.writeBigUInt64LE(BigInt(count), 24);
    rec.writeBigUInt64LE(BigInt(count), 32);
    rec.writeBigUInt64LE(BigInt(cd.length), 40);
    rec.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(offset), 8);
    loc.writeUInt32LE(1, 16);
    yield Buffer.concat([rec, loc]);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(Math.min(count, 0xffff), 8);
  e.writeUInt16LE(Math.min(count, 0xffff), 10);
  e.writeUInt32LE(Math.min(cd.length, U32), 12);
  e.writeUInt32LE(Math.min(cdOffset, U32), 16);
  yield e;
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

function u16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}
function u64(v: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

// --------------------------------------------------------------------------- STREAM

class StreamEncryptor {
  private buf: Buffer[] = [];
  private len = 0;
  private counter = 0;
  readonly payloadHash = createHash('sha256');
  payloadSize = 0;

  constructor(
    private readonly out: FileHandle,
    private readonly aad: Buffer,
    private readonly key: Buffer,
    private readonly prefix: Buffer,
    private readonly chunkSize: number,
  ) {}

  async write(data: Buffer): Promise<void> {
    this.payloadHash.update(data);
    this.payloadSize += data.length;
    this.buf.push(data);
    this.len += data.length;
    // Emit only while strictly more than one chunk is buffered, so the final flag is decided
    // at finish() (Python EncryptingWriter).
    if (this.len > this.chunkSize) {
      let all = Buffer.concat(this.buf);
      while (all.length > this.chunkSize) {
        await this.emit(all.subarray(0, this.chunkSize), false);
        all = all.subarray(this.chunkSize);
      }
      this.buf = [Buffer.from(all)];
      this.len = all.length;
    }
  }

  private async emit(pt: Buffer, last: boolean): Promise<void> {
    const ct = sealChunk(this.key, chunkNonce(this.prefix, this.counter, last), this.aad, pt);
    const lb = Buffer.alloc(4);
    lb.writeUInt32BE(ct.length);
    await this.out.write(Buffer.concat([lb, ct]));
    this.counter++;
  }

  async finish(): Promise<void> {
    await this.emit(Buffer.concat(this.buf), true);
    this.buf = [];
    this.len = 0;
  }
}

// --------------------------------------------------------------------------- package

async function resolveMaster(
  secret: WriterSecret,
  salt: Buffer | undefined,
): Promise<{ kdf: NxpkgKdf; master: Buffer; keyFileText: string | null }> {
  if ('passphrase' in secret) {
    const kdf: NxpkgKdf = {
      name: 'scrypt',
      n: secret.kdfN ?? 1 << 10,
      r: secret.kdfR ?? 8,
      p: secret.kdfP ?? 1,
      salt: (salt ?? randomBytes(SALT_LEN)).toString('base64'),
    };
    return {
      kdf,
      master: await masterKey(kdf, { passphrase: secret.passphrase }),
      keyFileText: null,
    };
  }
  const raw = 'rawKey' in secret ? Buffer.from(secret.rawKey) : parseKeyFile(secret.keyFileText);
  return { kdf: { name: 'raw-key' }, master: raw, keyFileText: encodeKeyFile(raw) };
}

export async function writeNxpkg(outPath: string, opts: WriteNxpkgOptions): Promise<WrittenNxpkg> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const ownStaging = opts.stagingDir === undefined;
  const stagingDir = opts.stagingDir ?? (await mkdtemp(join(tmpdir(), 'nxpkg-writer-')));
  try {
    const staged = new Map<string, Staged>();
    let n = 0;
    for (const rel of Object.keys(opts.files).sort()) {
      staged.set(rel, await stage(rel, opts.files[rel] as FileSource, stagingDir, n++));
    }
    const entry = (s: Staged) => ({ records: s.records, sha256: s.sha256, size: s.size });
    const filesObj: Record<string, unknown> = {};
    for (const [rel, s] of staged) filesObj[rel] = entry(s);
    let manifest: Record<string, unknown> = {
      ...DEFAULT_TEST_MANIFEST,
      ...(opts.manifest ?? {}),
      files: filesObj,
      payload_format: 'zip-v1',
    };
    if (opts.transformManifest) manifest = opts.transformManifest(manifest) as typeof manifest;
    const manifestBytes = canonicalJson(manifest);
    const all: Record<string, unknown> = {
      ...filesObj,
      'manifest.json': entry({ source: manifestBytes, ...hashBuffer(manifestBytes, false) }),
    };
    const sortedAll: Record<string, unknown> = {};
    for (const k of Object.keys(all).sort()) sortedAll[k] = all[k];
    let checksums: Record<string, unknown> = { algorithm: 'sha256', files: sortedAll };
    if (opts.transformChecksums) checksums = opts.transformChecksums(checksums) as typeof checksums;
    const checksumsBytes = canonicalJson(checksums);

    let members: ZipMember[] = [
      ...[...staged].map(([name, s]) => ({ name, source: s.source })),
      { name: 'manifest.json', source: manifestBytes },
      { name: 'checksums.json', source: checksumsBytes },
    ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (opts.transformEntries) members = opts.transformEntries(members);

    const { kdf, master, keyFileText } = await resolveMaster(opts.secret, opts.salt);
    const noncePrefix = opts.noncePrefix ?? randomBytes(NONCE_PREFIX_LEN);
    let header: NxpkgHeader = {
      format: FORMAT_NAME,
      format_version: FORMAT_MAJOR,
      cipher: CIPHER,
      chunk_size: chunkSize,
      kdf,
      key_check: keyCheckOf(master).toString('base64'),
      nonce_prefix: noncePrefix.toString('base64'),
      created_by: opts.createdBy ?? { name: 'nexa-test-writer', version: '0.0.0' },
    } as NxpkgHeader;
    if (opts.transformHeader) header = opts.transformHeader(header) as NxpkgHeader;
    const headerBytes = encodeHeader(header);
    const encKey = encryptionKeyOf(master, noncePrefix);
    const aad = createHash('sha256').update(headerBytes).digest();

    const fh = await open(outPath, 'w', 0o600);
    let enc: StreamEncryptor;
    try {
      await fh.write(headerBytes);
      enc = new StreamEncryptor(fh, aad, encKey, noncePrefix, chunkSize);
      if (opts.rawPayload) {
        await enc.write(opts.rawPayload);
      } else {
        let pending: Buffer[] = [];
        let pendingLen = 0;
        for await (const piece of zipStream(members, opts.zip64 ?? false)) {
          pending.push(piece);
          pendingLen += piece.length;
          if (pendingLen >= 1 << 16) {
            await enc.write(Buffer.concat(pending));
            pending = [];
            pendingLen = 0;
          }
        }
        if (pendingLen) await enc.write(Buffer.concat(pending));
      }
      await enc.finish();
    } finally {
      await fh.close();
    }
    return {
      path: outPath,
      keyFileText,
      headerSha256: createHash('sha256').update(headerBytes).digest('hex'),
      payloadSha256: enc.payloadHash.digest('hex'),
      payloadSize: enc.payloadSize,
      manifest,
      size: (await stat(outPath)).size,
    };
  } finally {
    if (ownStaging) await rm(stagingDir, { recursive: true, force: true });
  }
}

/** Python `sign_export`: the document plus its `authentication` block. */
export function signDecisionsExport(
  doc: Record<string, unknown>,
  key: Uint8Array,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) if (k !== 'authentication') body[k] = v;
  return {
    ...body,
    authentication: {
      alg: DECISIONS_AUTH_ALG,
      key: 'HKDF-SHA256(package secret, info=nxpkg-v1/ownership-decisions)',
      mac: decisionsMac(body, key).toString('base64'),
    },
  };
}
