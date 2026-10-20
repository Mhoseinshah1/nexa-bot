import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { BackupArchivePart } from '../application/ports.js';

/**
 * The parts of an archive: byte ranges of the ONE verified file (E4).
 *
 * Not files. A part is `[start, end)` of the archive that VERIFY_RESTORE opened, so what is
 * delivered is exactly what was verified, and there is no second copy on disk to drift
 * from it. 7-Zip's multi-volume layout is exactly this — `.7z.001` is the first `partBytes`
 * bytes of the `.7z`, and so on — so the parts open in 7-Zip from the `.001`, and `cat` of
 * every part in order is the archive, for an `.nxb` as much as for a `.7z`.
 *
 * One streaming pass computes every part's SHA-256 (the summary message lists them, so an
 * operator can check each downloaded part before joining them). An archive of `partBytes`
 * or less is ONE part, delivered under the archive's own name with no `.001`.
 */
export async function planArchiveParts(input: {
  readonly archivePath: string;
  readonly partBytes: number;
  /** The delivered file name of the whole archive, e.g. `nexa-backup-….7z`. */
  readonly filename: string;
}): Promise<readonly BackupArchivePart[]> {
  if (!Number.isSafeInteger(input.partBytes) || input.partBytes <= 0) {
    throw new RangeError('partBytes must be a positive integer');
  }
  const { size } = await stat(input.archivePath);
  const count = Math.max(1, Math.ceil(size / input.partBytes));
  const parts: BackupArchivePart[] = [];
  let index = 0;
  let digest = createHash('sha256');
  let inPart = 0;
  const close = (): void => {
    const start = index * input.partBytes;
    const end = Math.min(size, start + input.partBytes);
    parts.push({
      partNumber: index + 1,
      start,
      end,
      bytes: end - start,
      sha256: digest.digest('hex'),
      filename: count === 1 ? input.filename : `${input.filename}.${partSuffix(index + 1)}`,
    });
    index += 1;
    digest = createHash('sha256');
    inPart = 0;
  };
  for await (const chunk of createReadStream(input.archivePath, { highWaterMark: 1 << 20 })) {
    let buffer = chunk as Buffer;
    while (buffer.length > 0) {
      const room = input.partBytes - inPart;
      const take = Math.min(room, buffer.length);
      digest.update(buffer.subarray(0, take));
      inPart += take;
      buffer = buffer.subarray(take);
      if (inPart === input.partBytes) close();
    }
  }
  if (inPart > 0 || parts.length === 0) close();
  // A last chunk that ended exactly on a boundary was closed above; the count agrees.
  if (parts.length !== count) {
    throw new Error(
      `archive changed while its parts were planned (${String(parts.length)} != ${String(count)})`,
    );
  }
  return parts;
}

/** `001`, `002`… — 7-Zip's volume suffix, three digits minimum. */
export function partSuffix(partNumber: number): string {
  return String(partNumber).padStart(3, '0');
}
