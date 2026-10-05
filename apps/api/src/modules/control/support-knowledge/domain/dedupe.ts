import { foldDigits } from './scrubber.js';

/**
 * TB8 — duplicate detection for learning candidates (ADR-0035 §3).
 *
 * Two rules, both deterministic:
 *
 *   1. EXACT, by the normalised title. `support_learning_candidates.normalized_title` is unique
 *      per tenant across every state, so two replicas proposing the same lesson at once
 *      produce one candidate and one merge — the index decides, not a read.
 *   2. NEAR, by character-trigram similarity of the normalised titles (Jaccard over the
 *      sets of padded trigrams) at or above `NEAR_DUPLICATE_THRESHOLD`, checked in the
 *      application against the tenant's most recent candidates before an insert. A near
 *      match is merged into the existing candidate as an extra source, exactly as an exact
 *      match is. This rule is best-effort (a read, then a write); rule 1 is the backstop.
 *
 * Normalisation folds what Persian text varies in without changing meaning: Arabic ي/ك/ة/ۀ and
 * hamza-carrying alefs to their Persian forms, Persian and Arabic-Indic digits to ASCII,
 * diacritics and tatweel removed, zero-width joiners and every non-letter, non-digit run to
 * one space, lower case (for Latin), trimmed.
 */

export const NEAR_DUPLICATE_THRESHOLD = 0.8;

export function normalizeTitle(title: string): string {
  return foldDigits(title.normalize('NFKC'))
    .replace(/[يى]/gu, 'ی')
    .replace(/ك/gu, 'ک')
    .replace(/[ةۀ]/gu, 'ه')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/ؤ/gu, 'و')
    .replace(/[ً-ٰٟـ]/gu, '')
    .replace(/[\u200b-\u200f\u2060\ufeff]/gu, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The padded character trigrams of an (already normalised) string. */
export function trigrams(normalized: string): ReadonlySet<string> {
  const padded = `  ${normalized} `;
  const chars = [...padded];
  const out = new Set<string>();
  for (let i = 0; i + 3 <= chars.length; i += 1) out.add(chars.slice(i, i + 3).join(''));
  return out;
}

/** Jaccard similarity of two normalised titles' trigram sets, in [0, 1]. */
export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * The existing candidate a new proposal duplicates, if any: an exact normalised match first,
 * otherwise the most similar at or above the threshold (ties to the earlier entry).
 */
export function findDuplicate<T extends { readonly normalizedTitle: string }>(
  normalized: string,
  existing: readonly T[],
): T | null {
  const exact = existing.find((row) => row.normalizedTitle === normalized);
  if (exact !== undefined) return exact;
  let best: T | null = null;
  let bestScore = NEAR_DUPLICATE_THRESHOLD;
  for (const row of existing) {
    const score = trigramSimilarity(normalized, row.normalizedTitle);
    if (score >= bestScore && (best === null || score > bestScore)) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}
