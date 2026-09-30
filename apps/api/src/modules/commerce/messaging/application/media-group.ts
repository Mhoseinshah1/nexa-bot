/**
 * Round N (F2): how a run of files is cut into Telegram albums (`sendMediaGroup`).
 *
 * The Bot API's rules, and nothing else:
 *
 * - an album holds 2 to 10 items (`TELEGRAM_MEDIA_GROUP_MAX`); one file is not an album
 *   and goes by its own method;
 * - documents group only with documents; photos (and videos) group with each other; an
 *   audio album is audio only. So files of different classes can never share an album.
 *
 * The plan keeps the files' ORDER — the provider's order is the order the customer reads —
 * and uses the FEWEST consecutive batches: every maximal run of one class is split into
 * `ceil(n / 10)` albums of as-equal-as-possible size, so no album of a run is left with a
 * single item when two could be made (eleven documents are 6 + 5, never 10 + 1). A run of
 * exactly one file, the only case that cannot be an album, is a single send — the smallest
 * fallback — in its place in the sequence.
 */

/** Telegram's bound on an album. */
export const TELEGRAM_MEDIA_GROUP_MAX = 10;

/** The media kinds this installation sends as files, and the album class each one joins. */
export type GroupableMediaKind = 'DOCUMENT' | 'PHOTO';

export function mediaGroupClass(kind: GroupableMediaKind): 'document' | 'visual' {
  return kind === 'DOCUMENT' ? 'document' : 'visual';
}

/** One batch of the plan: the indices of the files it carries, in order. */
export type MediaBatch = readonly number[];

export function planMediaBatches(
  kinds: readonly GroupableMediaKind[],
  max: number = TELEGRAM_MEDIA_GROUP_MAX,
): readonly MediaBatch[] {
  const batches: MediaBatch[] = [];
  let runStart = 0;
  while (runStart < kinds.length) {
    const cls = mediaGroupClass(kinds[runStart] as GroupableMediaKind);
    let runEnd = runStart + 1;
    while (runEnd < kinds.length && mediaGroupClass(kinds[runEnd] as GroupableMediaKind) === cls) {
      runEnd += 1;
    }
    const size = runEnd - runStart;
    const count = Math.ceil(size / max);
    const base = Math.floor(size / count);
    const larger = size % count;
    let at = runStart;
    for (let batch = 0; batch < count; batch += 1) {
      const length = base + (batch < larger ? 1 : 0);
      batches.push(Array.from({ length }, (_, offset) => at + offset));
      at += length;
    }
    runStart = runEnd;
  }
  return batches;
}
