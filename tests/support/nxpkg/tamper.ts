/**
 * TEST-ONLY byte-level tampering of a finished `.nxpkg` (outside the AEAD). For tampering
 * that must still authenticate — a bad checksum, an unsafe ZIP name — use the hooks of
 * `writeNxpkg` in `./writer.ts` instead.
 */

export interface ChunkSpan {
  /** Offset of the 4-byte length prefix. */
  offset: number;
  /** Ciphertext length (tag included). */
  length: number;
}

export function headerLength(pkg: Buffer): number {
  return 11 + pkg.readUInt32BE(7);
}

/** The STREAM chunks of a package, in file order. */
export function listChunks(pkg: Buffer): ChunkSpan[] {
  const out: ChunkSpan[] = [];
  let pos = headerLength(pkg);
  while (pos + 4 <= pkg.length) {
    const length = pkg.readUInt32BE(pos);
    out.push({ offset: pos, length });
    pos += 4 + length;
  }
  return out;
}

export function flipByte(pkg: Buffer, offset: number, mask = 0x01): Buffer {
  const copy = Buffer.from(pkg);
  copy[offset] = (copy[offset] as number) ^ mask;
  return copy;
}

export function swapChunks(pkg: Buffer, a: number, b: number): Buffer {
  const chunks = listChunks(pkg);
  const ca = chunks[a];
  const cb = chunks[b];
  if (!ca || !cb || ca.length !== cb.length) throw new Error('chunks must exist and be equal size');
  const copy = Buffer.from(pkg);
  pkg.copy(copy, ca.offset, cb.offset, cb.offset + 4 + cb.length);
  pkg.copy(copy, cb.offset, ca.offset, ca.offset + 4 + ca.length);
  return copy;
}

export function dropChunk(pkg: Buffer, index: number): Buffer {
  const c = listChunks(pkg)[index];
  if (!c) throw new Error('no such chunk');
  return Buffer.concat([pkg.subarray(0, c.offset), pkg.subarray(c.offset + 4 + c.length)]);
}

/** Replace the header JSON (re-encoding the length), keeping the body as it is. */
export function replaceHeaderJson(pkg: Buffer, json: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length);
  return Buffer.concat([pkg.subarray(0, 7), len, json, pkg.subarray(headerLength(pkg))]);
}

export function headerJson(pkg: Buffer): Buffer {
  return pkg.subarray(11, headerLength(pkg));
}
