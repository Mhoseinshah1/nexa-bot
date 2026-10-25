/**
 * What a receipt image uploaded through the mini app IS, decided from its bytes (Round 9,
 * C5, owner correction of 2026-10-25): JPEG, PNG or WebP by their magic numbers, and
 * nothing else. The type a client declares is a claim; the leading bytes are the fact, and
 * the two must agree — a PNG declared as a JPEG is refused like a PDF declared as one.
 */

export type SniffedImage = 'image/jpeg' | 'image/png' | 'image/webp';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** The image type the bytes begin with, or null for anything that is not one of the three. */
export function sniffReceiptImage(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= PNG.length && PNG.every((byte, index) => bytes[index] === byte)) {
    return 'image/png';
  }
  // RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export type ReceiptImageVerdict =
  | { readonly outcome: 'ACCEPTED'; readonly mimeType: SniffedImage }
  | {
      readonly outcome: 'REFUSED';
      readonly reason: 'EMPTY' | 'TOO_LARGE' | 'NOT_AN_IMAGE' | 'TYPE_MISMATCH';
    };

/** The whole check: a size within the cap, a known image, and the declared type equal to it. */
export function checkReceiptImage(input: {
  readonly bytes: Uint8Array;
  readonly declaredMimeType: string;
  readonly maxBytes: number;
}): ReceiptImageVerdict {
  if (input.bytes.length === 0) return { outcome: 'REFUSED', reason: 'EMPTY' };
  if (input.bytes.length > input.maxBytes) return { outcome: 'REFUSED', reason: 'TOO_LARGE' };
  const sniffed = sniffReceiptImage(input.bytes);
  if (sniffed === null) return { outcome: 'REFUSED', reason: 'NOT_AN_IMAGE' };
  if (input.declaredMimeType.trim().toLowerCase() !== sniffed) {
    return { outcome: 'REFUSED', reason: 'TYPE_MISMATCH' };
  }
  return { outcome: 'ACCEPTED', mimeType: sniffed };
}
