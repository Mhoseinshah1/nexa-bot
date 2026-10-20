/**
 * A backup delivered in parts (Round 4 PR-E, E4), put back together in the browser.
 *
 * The parts are byte-exact slices of one archive (`….001`, `….002` …, 7-Zip's own
 * multi-volume layout), so the archive is their concatenation in order. `new File(parts)`
 * is that concatenation WITHOUT reading anything: a Blob made of File parts references
 * them, and the upload streams each part from disk in turn — a gigabyte backup is never in
 * the tab's memory.
 *
 * The NAMES are only used to order the parts, and a set that is not exactly `.001` …
 * `.N` of one base name is refused here, before a byte is uploaded: a missing part would
 * otherwise upload and fail as an unreadable archive, which names the wrong problem.
 */

const PART = /^(.*)\.(\d{3,})$/;

export type AssembledParts =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'INVALID' }
  | { readonly kind: 'OK'; readonly file: File; readonly parts: number };

export function assembleParts(files: readonly File[]): AssembledParts {
  if (files.length === 0) return { kind: 'NONE' };
  if (files.length === 1) {
    const only = files[0];
    return only === undefined ? { kind: 'NONE' } : { kind: 'OK', file: only, parts: 1 };
  }
  const numbered: { file: File; base: string; n: number }[] = [];
  for (const file of files) {
    const match = PART.exec(file.name);
    if (match === null) return { kind: 'INVALID' };
    numbered.push({ file, base: match[1] ?? '', n: Number(match[2]) });
  }
  const base = numbered[0]?.base ?? '';
  if (numbered.some((part) => part.base !== base)) return { kind: 'INVALID' };
  numbered.sort((a, b) => a.n - b.n);
  if (numbered.some((part, index) => part.n !== index + 1)) return { kind: 'INVALID' };
  const file = new File(
    numbered.map((part) => part.file),
    base,
    { type: 'application/octet-stream' },
  );
  return { kind: 'OK', file, parts: numbered.length };
}

/** The 7z signature: `7z` BC AF 27 1C. */
export const SEVEN_ZIP_MAGIC: readonly number[] = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
