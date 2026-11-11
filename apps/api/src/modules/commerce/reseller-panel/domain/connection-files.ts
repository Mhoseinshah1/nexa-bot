import { crc32, deflateRawSync } from 'node:zlib';

/**
 * PR-4 «فایل‌های اتصال» in the reseller panel: how a file the panel handed over is named and
 * typed in a browser download, and the in-memory ZIP of all of them. Pure: bytes in, bytes out,
 * nothing touches a disk.
 */

/** The download name: the panel's own name, made safe for a header and a file system. */
export function sanitizeFileName(name: string, fallback = 'connection'): string {
  const base = name.split(/[\\/]/u).pop() ?? '';
  const cleaned = Array.from(base, (char) => {
    const code = char.codePointAt(0) ?? 0;
    // Control characters, quotes and the characters no file system or header takes.
    return code < 0x20 || code === 0x7f || '"<>:|?*;\\'.includes(char) ? '_' : char;
  })
    .join('')
    .replace(/^[.\s]+/u, '')
    .trim()
    .slice(0, 120);
  return cleaned.length === 0 ? fallback : cleaned;
}

const BY_EXTENSION: Readonly<Record<string, string>> = {
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  txt: 'text/plain',
  conf: 'text/plain',
  ovpn: 'application/x-openvpn-profile',
  xml: 'application/xml',
  png: 'image/png',
  zip: 'application/zip',
};

/** The type a download is sent with: by extension, else `application/octet-stream`. */
export function contentTypeFor(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return 'application/octet-stream';
  return BY_EXTENSION[fileName.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * `Content-Disposition: attachment` with the name twice: an ASCII fallback (anything else
 * replaced) and the RFC 5987 UTF-8 form, so a Persian name survives in every browser.
 */
export function attachmentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** Distinct names inside one archive: a repeated name gets ` (2)`, ` (3)` before its extension. */
export function uniqueNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count === 1) return name;
    const dot = name.lastIndexOf('.');
    return dot > 0
      ? `${name.slice(0, dot)} (${String(count)})${name.slice(dot)}`
      : `${name} (${String(count)})`;
  });
}

const DOS_DATE = (1 << 5) | 1; // 1980-01-01, so the bytes depend only on the contents

/**
 * One ZIP (APPNOTE 6.3, no ZIP64: a panel's files are kilobytes), every entry deflated,
 * names UTF-8 (flag 0x0800). Built in memory for one response and never written anywhere.
 */
export function buildZip(
  entries: readonly { readonly name: string; readonly bytes: Uint8Array }[],
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.bytes);
    const compressed = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
