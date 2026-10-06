/**
 * D2 — which knowledge entries go with a request: the ones RELEVANT to what the customer just
 * wrote, by a deterministic lexical score. No embedding service, no model, no I/O: the same
 * question over the same rows always selects the same entries, which a test can pin.
 *
 * Before this the context carried the twenty most recently UPDATED articles, whatever the
 * question, and the byte budget then cut knowledge first — so an approved «اتصال» article that
 * nobody had edited lately never reached the model.
 *
 * The score of an entry is, over the distinct terms of the query, the term's rarity among the
 * candidates (an inverse document frequency, so «سرویس», in every article, weighs little) times
 * where it matched: the title three, a tag two, the body one. Persian is folded first (Arabic
 * `ي`/`ك`, ZWNJ and the zero-width joiners, diacritics, digits) and a few inflections are
 * stripped, so «وصل نمی‌شود», «وصل نمیشه» and «اتصال» meet the article they mean as often as a
 * simple rule can make them.
 */

export interface KnowledgeRankInput {
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
}

/** Words that say nothing about the question: every article has them. */
const STOPWORDS = new Set([
  // Persian
  'و',
  'در',
  'به',
  'از',
  'که',
  'را',
  'رو',
  'با',
  'این',
  'آن',
  'اون',
  'من',
  'ما',
  'شما',
  'یک',
  'یه',
  'هم',
  'برای',
  'تا',
  'چه',
  'چی',
  'چرا',
  'چطور',
  'چگونه',
  'کنم',
  'کنید',
  'کن',
  'است',
  'هست',
  'بود',
  'شد',
  'شده',
  'شود',
  'میشه',
  'نمیشه',
  'میشود',
  'نمیشود',
  'لطفا',
  'سلام',
  'ممنون',
  'مرسی',
  'یا',
  'اگر',
  'اگه',
  'ولی',
  'اما',
  'باید',
  'دارم',
  'داره',
  'دارد',
  'هر',
  'همه',
  'بر',
  'روی',
  'تو',
  // English
  'the',
  'a',
  'an',
  'to',
  'is',
  'are',
  'and',
  'or',
  'of',
  'in',
  'on',
  'for',
  'my',
  'i',
  'it',
  'not',
  'do',
  'does',
  'how',
  'what',
  'why',
  'can',
  'with',
  'please',
  'hi',
  'hello',
]);

/** Inflections stripped from the END of a Persian word, longest first. */
const SUFFIXES = [
  'هایی',
  'هایم',
  'هاتو',
  'های',
  'ها',
  'مان',
  'تان',
  'شان',
  'مون',
  'تون',
  'شون',
  'ام',
  'ات',
  'اش',
  'مو',
  'تو',
  'شو',
  'ی',
  'م',
  'ت',
  'ش',
];
/** Verb prefixes stripped from the START: «نمی‌شود» → «شود», «می‌زنم» → «زنم». */
const PREFIXES = ['نمی', 'می'];

/** A text folded for matching: lower case, Persian letters, no joiners, no diacritics. */
export function foldForMatching(text: string): string {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      // Arabic yeh and alef maksura, kaf, teh marbuta, hamza-carrying alefs → Persian forms.
      .replace(/[\u064A\u0649]/gu, '\u06CC')
      .replace(/\u0643/gu, '\u06A9')
      .replace(/\u0629/gu, '\u0647')
      .replace(/[\u0622\u0623\u0625\u0671]/gu, '\u0627')
      // Diacritics, tatweel, ZWNJ and the other zero-width characters.
      .replace(/[\u064B-\u065F\u0670\u0640]/gu, '')
      .replace(/[\u200B-\u200F\u2060\uFEFF]/gu, '')
      // Persian and Arabic-Indic digits to ASCII.
      .replace(/[\u06F0-\u06F9]/gu, (d) => String(d.charCodeAt(0) - 0x06f0))
      .replace(/[\u0660-\u0669]/gu, (d) => String(d.charCodeAt(0) - 0x0660))
  );
}

function stem(word: string): string {
  let out = word;
  for (const prefix of PREFIXES) {
    if (out.startsWith(prefix) && out.length - prefix.length >= 3) {
      out = out.slice(prefix.length);
      break;
    }
  }
  for (const suffix of SUFFIXES) {
    if (out.endsWith(suffix) && out.length - suffix.length >= 3) {
      out = out.slice(0, -suffix.length);
      break;
    }
  }
  return out;
}

/** The distinct terms of a text: folded, split on anything not a letter or a digit, stemmed. */
export function matchTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const word of foldForMatching(text).split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    const term = stem(word);
    if (term.length >= 2 && !STOPWORDS.has(term)) terms.add(term);
  }
  return terms;
}

/** Equal, or — both at least four letters — one a prefix of the other (a missed inflection). */
function termMatches(query: string, terms: ReadonlySet<string>): boolean {
  if (terms.has(query)) return true;
  if (query.length < 4) return false;
  for (const term of terms) {
    if (term.length >= 4 && (term.startsWith(query) || query.startsWith(term))) return true;
  }
  return false;
}

const WEIGHT = { title: 3, tags: 2, body: 1 } as const;

/**
 * Each entry's score for `query` (0 when nothing matched, and for an empty query), aligned
 * with `entries`.
 */
export function knowledgeScores(
  entries: readonly KnowledgeRankInput[],
  query: string,
): readonly number[] {
  const queryTerms = [...matchTerms(query)];
  if (queryTerms.length === 0 || entries.length === 0) return entries.map(() => 0);
  const indexed = entries.map((entry) => ({
    title: matchTerms(entry.title),
    tags: matchTerms(entry.tags.join(' ')),
    body: matchTerms(entry.body),
  }));
  const rarity = new Map<string, number>();
  for (const term of queryTerms) {
    const df = indexed.filter(
      (entry) =>
        termMatches(term, entry.title) ||
        termMatches(term, entry.tags) ||
        termMatches(term, entry.body),
    ).length;
    rarity.set(term, Math.log(1 + entries.length / (1 + df)));
  }
  return indexed.map((entry) => {
    let score = 0;
    for (const term of queryTerms) {
      const weight =
        (termMatches(term, entry.title) ? WEIGHT.title : 0) +
        (termMatches(term, entry.tags) ? WEIGHT.tags : 0) +
        (termMatches(term, entry.body) ? WEIGHT.body : 0);
      score += weight * (rarity.get(term) ?? 0);
    }
    return score;
  });
}

/**
 * `entries` most relevant first, at most `limit`. Ties — every entry, for an empty query or a
 * question nothing matches — keep the order they were given in (the caller's: approved articles
 * newest first, then the FAQ), so the selection is a pure function of the rows and the query.
 */
export function selectRelevantKnowledge<T extends KnowledgeRankInput>(
  entries: readonly T[],
  query: string,
  limit: number,
): T[] {
  const scores = knowledgeScores(entries, query);
  return entries
    .map((entry, index) => ({ entry, index, score: scores[index] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map(({ entry }) => entry);
}
