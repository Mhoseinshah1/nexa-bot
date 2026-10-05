import { createHash } from 'node:crypto';
import type {
  SupportKnowledgeArticleState,
  SupportKnowledgeBuildSourceType,
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

export function diffBuild(
  items: readonly BuildItem[],
  built: readonly BuiltArticle[],
): readonly BuildProposalDraft[] {
  const byRef = new Map(
    built.map((article) => [sourceRef(article.sourceType, article.sourceKey), article]),
  );
  return items.map((item) => {
    const hash = contentHash(item.content);
    const article = byRef.get(sourceRef(item.sourceType, item.sourceKey)) ?? null;
    return { item, hash, article, kind: kindOf(hash, article) };
  });
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
