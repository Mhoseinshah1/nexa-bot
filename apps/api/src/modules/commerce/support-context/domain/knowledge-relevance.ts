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

/**
 * A8 — one part of a weighted query: its text and how much a term of it counts. A term in two
 * parts counts at the higher weight, once. `titleAndTagsOnly` (PR #236 review, N4): the part's
 * terms count only where they match an entry's title or tags, never its body — for generic
 * vocabulary («سرویس», «خطا») that half the bodies contain.
 */
export interface KnowledgeQueryPart {
  readonly text: string;
  readonly weight: number;
  readonly titleAndTagsOnly?: boolean;
}

/** A query: plain text (every term weight 1), or weighted parts in priority order. */
export type KnowledgeQuery = string | readonly KnowledgeQueryPart[];

/**
 * A8: at most this many distinct query terms are scored, the highest-priority part's first, so
 * scoring a thousand candidates stays bounded whatever the transcript holds.
 */
export const KNOWLEDGE_QUERY_MAX_TERMS = 64;
/**
 * PR #236 review, N3: of those, the first part (the customer's words) takes at most
 * `MAX - RESERVED` before every later part has had `KNOWLEDGE_QUERY_TERMS_PER_PART` of its own,
 * so a long pasted log cannot switch the conversation's memory off.
 */
export const KNOWLEDGE_QUERY_RESERVED_TERMS = 16;
export const KNOWLEDGE_QUERY_TERMS_PER_PART = 4;

interface QueryTerm {
  weight: number;
  /** Whether a part that may match bodies contributed it. */
  body: boolean;
}

/** Each distinct term of `query`, its weight and where it may match, bounded. */
function queryTerms(query: KnowledgeQuery): ReadonlyMap<string, QueryTerm> {
  const parts = (typeof query === 'string' ? [{ text: query, weight: 1 }] : query)
    .filter((part) => part.weight > 0)
    .map((part) => ({
      weight: part.weight,
      body: part.titleAndTagsOnly !== true,
      terms: [...matchTerms(part.text)],
    }));
  const terms = new Map<string, QueryTerm>();
  const take = (part: (typeof parts)[number], limit: number) => {
    let added = 0;
    for (const term of part.terms) {
      const known = terms.get(term);
      if (known !== undefined) {
        known.weight = Math.max(known.weight, part.weight);
        known.body ||= part.body;
        continue;
      }
      if (added >= limit || terms.size >= KNOWLEDGE_QUERY_MAX_TERMS) continue;
      terms.set(term, { weight: part.weight, body: part.body });
      added += 1;
    }
  };
  const [first, ...rest] = parts;
  if (first !== undefined) take(first, KNOWLEDGE_QUERY_MAX_TERMS - KNOWLEDGE_QUERY_RESERVED_TERMS);
  for (const part of rest) take(part, KNOWLEDGE_QUERY_TERMS_PER_PART);
  for (const part of parts) take(part, KNOWLEDGE_QUERY_MAX_TERMS);
  return terms;
}

/** Each distinct term of `query` and its weight, in priority order, bounded. */
export function weightedQueryTerms(query: KnowledgeQuery): ReadonlyMap<string, number> {
  return new Map([...queryTerms(query)].map(([term, { weight }]) => [term, weight]));
}

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
 * with `entries`. A8: a term counts at its part's weight (`weightedQueryTerms`).
 */
export function knowledgeScores(
  entries: readonly KnowledgeRankInput[],
  query: KnowledgeQuery,
): readonly number[] {
  const terms = queryTerms(query);
  const words = [...terms.keys()];
  if (words.length === 0 || entries.length === 0) return entries.map(() => 0);
  const indexed = entries.map((entry) => ({
    title: matchTerms(entry.title),
    tags: matchTerms(entry.tags.join(' ')),
    body: matchTerms(entry.body),
  }));
  const rarity = new Map<string, number>();
  for (const term of words) {
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
    for (const term of words) {
      const { weight: termWeight, body } = terms.get(term) ?? { weight: 0, body: false };
      const where =
        (termMatches(term, entry.title) ? WEIGHT.title : 0) +
        (termMatches(term, entry.tags) ? WEIGHT.tags : 0) +
        (body && termMatches(term, entry.body) ? WEIGHT.body : 0);
      score += where * termWeight * (rarity.get(term) ?? 0);
    }
    return score;
  });
}

/**
 * `entries` most relevant first, at most `limit`, and ONLY entries the query matched (A8): an
 * entry scoring zero is never sent, so an empty query or a question nothing matches selects
 * nothing rather than the newest articles. Ties keep the order they were given in (the
 * caller's: approved articles newest first, then the FAQ), so the selection is a pure function
 * of the rows and the query.
 */
export function selectRelevantKnowledge<T extends KnowledgeRankInput>(
  entries: readonly T[],
  query: KnowledgeQuery,
  limit: number,
): T[] {
  const scores = knowledgeScores(entries, query);
  return entries
    .map((entry, index) => ({ entry, index, score: scores[index] ?? 0 }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map(({ entry }) => entry);
}
