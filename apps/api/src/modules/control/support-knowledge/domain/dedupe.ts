import { foldDigits } from './scrubber.js';
import { normalizePersian } from '../../../commerce/support-context/domain/persian-text.js';

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
 * Normalisation is `normalizePersian` (Phase 4 PR-2: the one shared with knowledge retrieval —
 * Arabic ي/ى/ئ/ك/ة/ۀ/ؤ and hamza-carrying alefs to their Persian forms, digits to ASCII,
 * diacritics, tatweel and zero-width joiners removed, lower case), then every non-letter,
 * non-digit run to one space, trimmed.
 */

export const NEAR_DUPLICATE_THRESHOLD = 0.8;

export function normalizeTitle(title: string): string {
  // Phase 4 PR-2: the one shared Persian normaliser (retrieval reads the same), then every
  // non-letter, non-digit run to one space.
  return normalizePersian(title)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Review of PR #367 — the key every candidate stored BEFORE Phase 4 PR-2 was written with (a ZWNJ
 * became a space, «ئ» was kept). Stored keys are not rewritten: the duplicate check matches a
 * proposal under BOTH forms (`titleKeys`), so an existing «چرا وصل نمی‌شود؟» candidate is still
 * found by the identical proposal.
 */
export function legacyNormalizeTitle(title: string): string {
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

/** The keys a title is compared under: today's form first, then the pre-PR-2 form if different. */
export function titleKeys(title: string): readonly string[] {
  const current = normalizeTitle(title);
  const legacy = legacyNormalizeTitle(title);
  return legacy === current ? [current] : [current, legacy];
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
  normalized: string | readonly string[],
  existing: readonly T[],
): T | null {
  const keys = typeof normalized === 'string' ? [normalized] : normalized;
  const exact = existing.find((row) => keys.includes(row.normalizedTitle));
  if (exact !== undefined) return exact;
  let best: T | null = null;
  let bestScore = NEAR_DUPLICATE_THRESHOLD;
  for (const row of existing) {
    const score = Math.max(...keys.map((key) => trigramSimilarity(key, row.normalizedTitle)));
    if (score >= bestScore && (best === null || score > bestScore)) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}
