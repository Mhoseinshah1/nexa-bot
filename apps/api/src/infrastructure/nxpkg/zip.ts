import { createReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createInflateRaw, crc32 } from 'node:zlib';
import { NxpkgError, tampered } from './errors.js';
import { isSafeRelpath } from './manifest.js';

/**
 * A strict reader for the converter's deterministic payload ZIP (`payload_format = zip-v1`,
 * written by Python's `zipfile` as a stream: data descriptors, ZIP64 only where needed).
 *
 * Strict means the archive is accepted only when its bytes are exactly a sequence of
 * `local header · data · [descriptor]` records starting at offset 0, followed immediately by
 * the central directory, [the ZIP64 end record and locator,] and the end record with no
 * comment. No gap, overlap, prepended or appended byte, comment, unknown extra field,
 * encryption flag, compression method other than STORED/DEFLATE, directory, symlink or
 * special file, unsafe or duplicate name, or disagreement between a local header, its
 * descriptor and its central directory record is tolerated. Each entry's content is checked
 * against its declared size and CRC-32 whenever it is read.
 *
 * Everything here runs on plaintext the STREAM layer has already authenticated, so a
 * failure is `NXPKG_TAMPERED` (a holder of the key built a bad package, or the bytes on disk
 * changed after decryption), matching the converter's reader.
 */

export interface ZipEntry {
  name: string;
  method: 0 | 8;
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  dataOffset: number;
}

export interface ZipLimits {
  maxFiles: number;
  maxFileBytes: number;
  /** Upper bound on the SUM of every entry's declared uncompressed size, in bytes. */
  maxTotalBytes: number;
  /**
   * Upper bound on one DEFLATE entry's uncompressed / compressed ratio. Applied to entries
   * larger than `ratioFloorBytes` only: a tiny file compresses absurdly well and costs nothing.
   */
  maxCompressionRatio: number;
  ratioFloorBytes: number;
}

/**
 * Safe defaults for the two bomb checks. Deflate cannot exceed ~1032:1; the converter's JSONL
 * compresses far below 200:1 in practice. Sixteen gigabytes uncompressed is many times any
 * converted Mirza backup, and bounds the CPU a hostile key holder can make the reader spend.
 */
export const ZIP_DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024 * 1024;
export const ZIP_DEFAULT_MAX_COMPRESSION_RATIO = 200;
export const ZIP_DEFAULT_RATIO_FLOOR_BYTES = 1024 * 1024;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const EOCD_LEN = 22;
const LOCATOR64_LEN = 20;
const EOCD64_LEN = 56;
const CENTRAL_LEN = 46;
const LOCAL_LEN = 30;
const ZIP64_EXTRA_ID = 0x0001;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
/** Data descriptor (bit 3) and UTF-8 names (bit 11) are the only flags a valid entry may set. */
const ALLOWED_FLAGS = 0x0008 | 0x0800;
const FLAG_DESCRIPTOR = 0x0008;
const MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const DOS_DIRECTORY = 0x10;

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const { bytesRead } = await fh.read(buf, off, length - off, position + off);
    if (bytesRead === 0) break;
    off += bytesRead;
  }
  if (off !== length) throw tampered('zip_truncated');
  return buf;
}

function u64(buf: Buffer, off: number): number {
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw tampered('zip_size_out_of_range');
  return Number(v);
}

interface Zip64Fields {
  size?: number;
  compressedSize?: number;
  offset?: number;
}

/**
 * Parse an extra-field block that may hold only a ZIP64 record (id 0x0001). `want` lists, in
 * APPNOTE order, which of size / compressed size / offset the record must carry.
 */
function parseExtra(
  extra: Buffer,
  want: readonly ('size' | 'compressedSize' | 'offset')[],
  exactLocal: boolean,
): Zip64Fields | null {
  if (extra.length === 0) {
    if (want.length > 0) throw tampered('zip64_extra_missing');
    return null;
  }
  if (extra.length < 4) throw tampered('zip_extra_field');
  const id = extra.readUInt16LE(0);
  const len = extra.readUInt16LE(2);
  if (id !== ZIP64_EXTRA_ID || len + 4 !== extra.length) throw tampered('zip_extra_field');
  const out: Zip64Fields = {};
  if (exactLocal) {
    // A local ZIP64 record always carries both sizes (Python: `<HHQQ`).
    if (len !== 16) throw tampered('zip_extra_field');
    out.size = u64(extra, 4);
    out.compressedSize = u64(extra, 12);
    return out;
  }
  if (len !== want.length * 8) throw tampered('zip_extra_field');
  want.forEach((field, i) => {
    out[field] = u64(extra, 4 + i * 8);
  });
  return out;
}

/** Parse and cross-check the whole archive structure. Content is NOT read here. */
export async function readZipDirectory(
  fh: FileHandle,
  fileSize: number,
  limits: ZipLimits,
): Promise<ZipEntry[]> {
  if (fileSize < EOCD_LEN) throw tampered('zip_too_small');
  const eocdAt = fileSize - EOCD_LEN;
  const eocd = await readAt(fh, eocdAt, EOCD_LEN);
  if (eocd.readUInt32LE(0) !== SIG_EOCD) throw tampered('zip_eocd');
  if (eocd.readUInt16LE(4) !== 0 || eocd.readUInt16LE(6) !== 0) throw tampered('zip_multidisk');
  if (eocd.readUInt16LE(20) !== 0) throw tampered('zip_comment');
  const eDiskCount = eocd.readUInt16LE(8);
  let count = eocd.readUInt16LE(10);
  let cdSize = eocd.readUInt32LE(12);
  let cdOffset = eocd.readUInt32LE(16);
  if (eDiskCount !== count) throw tampered('zip_eocd');
  let cdEnd = eocdAt;

  // ZIP64: detected by the locator's presence, as Python's reader does. Names are restricted
  // to [A-Za-z0-9_.-/], so the locator signature cannot occur by accident inside the last
  // central record.
  if (eocdAt >= LOCATOR64_LEN + EOCD64_LEN) {
    const loc = await readAt(fh, eocdAt - LOCATOR64_LEN, LOCATOR64_LEN);
    if (loc.readUInt32LE(0) === SIG_LOCATOR64) {
      if (loc.readUInt32LE(4) !== 0 || loc.readUInt32LE(16) !== 1) throw tampered('zip_multidisk');
      const at = u64(loc, 8);
      if (at !== eocdAt - LOCATOR64_LEN - EOCD64_LEN) throw tampered('zip64_eocd_position');
      const rec = await readAt(fh, at, EOCD64_LEN);
      if (rec.readUInt32LE(0) !== SIG_EOCD64 || u64(rec, 4) !== EOCD64_LEN - 12) {
        throw tampered('zip64_eocd');
      }
      if (rec.readUInt32LE(16) !== 0 || rec.readUInt32LE(20) !== 0) throw tampered('zip_multidisk');
      const c64 = u64(rec, 24);
      if (u64(rec, 32) !== c64) throw tampered('zip64_eocd');
      const s64 = u64(rec, 40);
      const o64 = u64(rec, 48);
      // The 32-bit record holds the clamped values (Python: min(v, 0xFFFF / 0xFFFFFFFF)).
      if (
        count !== Math.min(c64, U16_MAX) ||
        cdSize !== Math.min(s64, U32_MAX) ||
        cdOffset !== Math.min(o64, U32_MAX)
      ) {
        throw tampered('zip64_eocd_mismatch');
      }
      count = c64;
      cdSize = s64;
      cdOffset = o64;
      cdEnd = at;
    }
  }

  if (count > limits.maxFiles) throw tampered('too_many_files');
  if (cdSize > MAX_CENTRAL_DIRECTORY) throw tampered('zip_central_directory_too_large');
  if (cdOffset + cdSize !== cdEnd) throw tampered('zip_central_directory_position');
  const cd = await readAt(fh, cdOffset, cdSize);

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let totalBytes = 0;
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + CENTRAL_LEN > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) {
      throw tampered('zip_central_record');
    }
    const madeBy = cd.readUInt16LE(p + 4);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let csize = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const diskStart = cd.readUInt16LE(p + 34);
    const externalAttr = cd.readUInt32LE(p + 38);
    let offset = cd.readUInt32LE(p + 42);
    const end = p + CENTRAL_LEN + nameLen + extraLen + commentLen;
    if (end > cd.length) throw tampered('zip_central_record');
    if ((flags & ~ALLOWED_FLAGS) !== 0) throw tampered('zip_flags');
    if (method !== 0 && method !== 8) throw tampered('zip_compression_method');
    if (commentLen !== 0) throw tampered('zip_comment');
    if (diskStart !== 0) throw tampered('zip_multidisk');
    const nameBytes = cd.subarray(p + CENTRAL_LEN, p + CENTRAL_LEN + nameLen);
    const name = nameBytes.toString('latin1');
    // Safe names are ASCII, so the latin1 view is the name whatever bit 11 says.
    if (!isSafeRelpath(name)) throw tampered('zip_unsafe_name');
    if (names.has(name)) throw tampered('zip_duplicate_name');
    names.add(name);
    const mode = externalAttr >>> 16;
    if (madeBy >>> 8 !== 3 || (mode & S_IFMT) !== S_IFREG || (externalAttr & DOS_DIRECTORY) !== 0) {
      throw tampered('zip_entry_type');
    }
    const want: ('size' | 'compressedSize' | 'offset')[] = [];
    if (usize === U32_MAX) want.push('size');
    if (csize === U32_MAX) want.push('compressedSize');
    if (offset === U32_MAX) want.push('offset');
    const z64 = parseExtra(
      cd.subarray(p + CENTRAL_LEN + nameLen, p + CENTRAL_LEN + nameLen + extraLen),
      want,
      false,
    );
    if (z64) {
      usize = z64.size ?? usize;
      csize = z64.compressedSize ?? csize;
      offset = z64.offset ?? offset;
    }
    if (usize > limits.maxFileBytes) throw tampered('file_too_large');
    if (method === 0 && csize !== usize) throw tampered('zip_size_mismatch');
    // Bomb checks on the DECLARED sizes, before anything is inflated; `readZipEntry` refuses
    // content that inflates past its declared size, so the declaration is what is spent.
    totalBytes += usize;
    if (totalBytes > limits.maxTotalBytes) throw tampered('zip_total_too_large');
    if (
      method === 8 &&
      usize > limits.ratioFloorBytes &&
      usize > csize * limits.maxCompressionRatio
    ) {
      throw tampered('zip_compression_ratio');
    }
    entries.push({
      name,
      method: method as 0 | 8,
      flags,
      crc32: crc,
      compressedSize: csize,
      size: usize,
      localOffset: offset,
      dataOffset: -1,
    });
    p = end;
  }
  if (p !== cd.length) throw tampered('zip_central_directory_trailing');

  // Local records: contiguous from offset 0, in central-directory order, agreeing with it.
  let cursor = 0;
  for (const e of entries) {
    if (e.localOffset !== cursor) throw tampered('zip_layout');
    const flags = e.flags;
    const head = await readAt(fh, e.localOffset, LOCAL_LEN);
    if (head.readUInt32LE(0) !== SIG_LOCAL) throw tampered('zip_local_header');
    const lFlags = head.readUInt16LE(6);
    const lMethod = head.readUInt16LE(8);
    const lCrc = head.readUInt32LE(14);
    const lCsize = head.readUInt32LE(18);
    const lUsize = head.readUInt32LE(22);
    const lNameLen = head.readUInt16LE(26);
    const lExtraLen = head.readUInt16LE(28);
    if (lFlags !== flags || lMethod !== e.method) throw tampered('zip_local_mismatch');
    const tail = await readAt(fh, e.localOffset + LOCAL_LEN, lNameLen + lExtraLen);
    if (tail.subarray(0, lNameLen).toString('latin1') !== e.name) {
      throw tampered('zip_local_mismatch');
    }
    const lz64 =
      lExtraLen === 0
        ? null
        : parseExtra(tail.subarray(lNameLen), ['size', 'compressedSize'], true);
    const descriptor = (flags & FLAG_DESCRIPTOR) !== 0;
    if (lz64 && (lCsize !== U32_MAX || lUsize !== U32_MAX)) throw tampered('zip_local_mismatch');
    if (descriptor) {
      // Python writes zeros here and the real values in the descriptor.
      const zeroOk =
        lCrc === 0 &&
        (lz64 ? lz64.size === 0 && lz64.compressedSize === 0 : lCsize === 0 && lUsize === 0);
      const exactOk =
        lCrc === e.crc32 &&
        (lz64
          ? lz64.size === e.size && lz64.compressedSize === e.compressedSize
          : lCsize === e.compressedSize && lUsize === e.size);
      if (!zeroOk && !exactOk) throw tampered('zip_local_mismatch');
    } else {
      const sizesOk = lz64
        ? lz64.size === e.size && lz64.compressedSize === e.compressedSize
        : lCsize === e.compressedSize && lUsize === e.size;
      if (lCrc !== e.crc32 || !sizesOk) throw tampered('zip_local_mismatch');
    }
    e.dataOffset = e.localOffset + LOCAL_LEN + lNameLen + lExtraLen;
    cursor = e.dataOffset + e.compressedSize;
    if (descriptor) {
      const wide = lz64 !== null;
      const dlen = wide ? 24 : 16;
      if (cursor + dlen > cdOffset) throw tampered('zip_layout');
      const d = await readAt(fh, cursor, dlen);
      if (d.readUInt32LE(0) !== SIG_DESCRIPTOR) throw tampered('zip_descriptor');
      const dCrc = d.readUInt32LE(4);
      const dCsize = wide ? u64(d, 8) : d.readUInt32LE(8);
      const dUsize = wide ? u64(d, 16) : d.readUInt32LE(12);
      if (dCrc !== e.crc32 || dCsize !== e.compressedSize || dUsize !== e.size) {
        throw tampered('zip_descriptor_mismatch');
      }
      cursor += dlen;
    }
    if (cursor > cdOffset) throw tampered('zip_layout');
  }
  if (cursor !== cdOffset) throw tampered('zip_layout');
  return entries;
}

/**
 * Stream one entry's content. Throws `NXPKG_TAMPERED` if the data inflates past its declared
 * size, ends short of it, or fails its CRC-32 — checked on every read, not once.
 */
export async function* readZipEntry(
  path: string,
  entry: ZipEntry,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  if (entry.dataOffset < 0) throw new Error('zip entry was not located');
  let total = 0;
  let crc = 0;
  if (entry.compressedSize === 0) {
    if (entry.size !== 0 || entry.method !== 0) throw tampered('zip_entry_corrupt');
    if (entry.crc32 !== 0) throw tampered('zip_entry_crc');
    return;
  }
  const raw = createReadStream(path, {
    start: entry.dataOffset,
    end: entry.dataOffset + entry.compressedSize - 1,
    highWaterMark: 1 << 16,
  });
  const inflater = entry.method === 8 ? createInflateRaw({ chunkSize: 1 << 16 }) : null;
  const src = inflater ?? raw;
  if (inflater) {
    raw.on('error', (err) => inflater.destroy(err));
    raw.pipe(inflater);
  }
  try {
    for await (const chunk of src as AsyncIterable<Buffer>) {
      signal?.throwIfAborted();
      total += chunk.length;
      if (total > entry.size) throw tampered('zip_entry_size');
      crc = crc32(chunk, crc);
      yield chunk;
    }
  } catch (err) {
    if (err instanceof NxpkgError) throw err;
    if (isZlibError(err)) throw tampered('zip_entry_corrupt');
    throw err;
  } finally {
    raw.destroy();
    inflater?.destroy();
  }
  if (total !== entry.size) throw tampered('zip_entry_size');
  if (crc >>> 0 !== entry.crc32) throw tampered('zip_entry_crc');
}

function isZlibError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('Z_');
}
