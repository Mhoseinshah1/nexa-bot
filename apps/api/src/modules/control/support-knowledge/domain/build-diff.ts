import { createHash } from 'node:crypto';
import type {
  SupportKnowledgeArticleState,
  SupportKnowledgeBuildSourceType,
  SupportKnowledgeCategory,
  SupportKnowledgeContent,
  SupportKnowledgeProposalKind,
} from '@nexa/contracts';

/**
 * TB9 — the build's diff (ADR-0035 §5): pure, so the rule that decides ADD, UPDATE, UNCHANGED
 * and CONFLICT is one function a unit test can run over every case.
 *
 * An article is matched to a source item ONLY by `(source type, source key)`, which only a
 * `NEXA_BUILD` article carries. MANUAL and LEARNED articles are never matched and therefore
 * never touched.
 *
 * The edit test is revision arithmetic, never a text comparison: `built_revision` is the
 * revision the last build apply wrote. An article whose live revision is anything else was
 * edited since — by a reviewer — and a changed source against it is a CONFLICT.
 *
 * A built article whose source is no longer in the allowlisted set is a RETIRE proposal
 * (substitute review of PR #204, S2): the product was withdrawn or made reseller-only, its
 * category hidden, the app disabled, the FAQ entry deactivated, the payment route switched off.
 * Only PROPOSED — a reviewer applies it or leaves it — and never for a source type whose read a
 * bound cut short, where a missing key proves nothing.
 */

/** One source item, already reduced to its customer-facing content. */
export interface BuildItem {
  readonly sourceType: SupportKnowledgeBuildSourceType;
  /** Stable per source: the row's id, or a fixed key for a singleton source. Never shown. */
  readonly sourceKey: string;
  readonly content: SupportKnowledgeContent;
}

/** What the diff needs to know of a built article. */
export interface BuiltArticle {
  readonly id: string;
  readonly sourceType: SupportKnowledgeBuildSourceType;
  readonly sourceKey: string;
  readonly state: SupportKnowledgeArticleState;
  readonly revision: number;
  readonly builtRevision: number | null;
  readonly builtHash: string | null;
  readonly title: string;
  readonly body: string;
  readonly category: SupportKnowledgeCategory;
  readonly tags: readonly string[];
}

export interface BuildProposalDraft {
  readonly item: BuildItem;
  readonly hash: string;
  readonly kind: SupportKnowledgeProposalKind;
  readonly article: BuiltArticle | null;
}

/** SHA-256 over a canonical JSON of the content: the same text always has the same hash. */
export function contentHash(content: SupportKnowledgeContent): string {
  return createHash('sha256')
    .update(
      JSON.stringify([content.title, content.body, content.category, [...content.tags]]),
      'utf8',
    )
    .digest('hex');
}

export function sourceRef(type: string, key: string): string {
  return `${type}:${key}`;
}

export interface DiffOptions {
  /**
   * Every source the allowlist still yields, as `sourceRef`s — including items left out of the
   * change-set (excluded by the scrubber): a source that is still there is not retired.
   * Defaults to the items themselves.
   */
  readonly present?: ReadonlySet<string>;
  /** Source types whose read a bound cut short: no RETIRE is proposed for them. */
  readonly incomplete?: ReadonlySet<SupportKnowledgeBuildSourceType>;
}

export function diffBuild(
  items: readonly BuildItem[],
  built: readonly BuiltArticle[],
  options: DiffOptions = {},
): readonly BuildProposalDraft[] {
  const byRef = new Map(
    built.map((article) => [sourceRef(article.sourceType, article.sourceKey), article]),
  );
  const drafts: BuildProposalDraft[] = items.map((item) => {
    const hash = contentHash(item.content);
    const article = byRef.get(sourceRef(item.sourceType, item.sourceKey)) ?? null;
    return { item, hash, article, kind: kindOf(hash, article) };
  });
  const present =
    options.present ?? new Set(items.map((item) => sourceRef(item.sourceType, item.sourceKey)));
  const incomplete = options.incomplete ?? new Set();
  for (const article of built) {
    // A reviewer already retired it; nothing to propose.
    if (article.state === 'RETIRED') continue;
    if (incomplete.has(article.sourceType)) continue;
    if (present.has(sourceRef(article.sourceType, article.sourceKey))) continue;
    // The proposal carries the article's own text: retiring changes no text, and the reviewer
    // sees exactly what would leave the agent's knowledge.
    const content: SupportKnowledgeContent = {
      title: article.title,
      body: article.body,
      category: article.category,
      tags: [...article.tags],
    };
    drafts.push({
      item: { sourceType: article.sourceType, sourceKey: article.sourceKey, content },
      hash: contentHash(content),
      article,
      kind: 'RETIRE',
    });
  }
  return drafts;
}

function kindOf(hash: string, article: BuiltArticle | null): SupportKnowledgeProposalKind {
  if (article === null) return 'ADD';
  // A reviewer retired it: the build never brings it back by itself.
  if (article.state === 'RETIRED') return 'UNCHANGED';
  // The source is as last built (or as last acknowledged): whatever was edited stays.
  if (article.builtHash === hash) return 'UNCHANGED';
  // Not edited since the last build apply: the build may replace its own text.
  if (article.builtRevision !== null && article.revision === article.builtRevision) return 'UPDATE';
  return 'CONFLICT';
}
