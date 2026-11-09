import { crc32, inflateRawSync } from 'node:zlib';

/**
 * A small ZIP reader for tests: the central directory, then each entry inflated and its CRC-32
 * and size checked against the directory. It reads what `ZipFileWriter` writes (and any
 * ordinary deflate/stored archive without ZIP64), and throws on a corrupt one — so a test that
 * unpacks an export also proves the archive is well formed.
 */
export function readZip(buffer: Buffer): Map<string, Buffer> {
  // The end-of-central-directory record: the last 22 bytes (no archive comment is written).
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('not a ZIP: no end record');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory record');
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const compressed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const offset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    if (buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error('bad local header');
    const dataStart =
      offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const raw = buffer.subarray(dataStart, dataStart + compressed);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (data.length !== size) throw new Error(`${name}: size mismatch`);
    if (crc32(data) >>> 0 !== crc) throw new Error(`${name}: CRC mismatch`);
    out.set(name, data);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** A CSV (RFC 4180, CRLF) into rows of cells; the UTF-8 BOM, if any, is left to the caller. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
