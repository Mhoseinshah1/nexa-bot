import {
  SUPPORT_AI_INTENT_MAX_CHARS,
  SUPPORT_AI_REF_PATTERN,
  SUPPORT_AI_REPLY_MAX_CHARS,
  SUPPORT_AI_SUMMARY_MAX_CHARS,
  supportAiDecisionSchema,
  type SupportAiDecision,
  type SupportAiFailureClass,
} from '@nexa/contracts';

/**
 * The one way a model's output becomes a `SupportAiDecision` — Assist, Auto Reply and the
 * provider capability test all read it here, so the test proves what production does.
 *
 * Two modes, and only one of them tolerates anything:
 *
 * - `STRICT` — Auto Reply and the capability test. `supportAiDecisionSchema` decides, exactly:
 *   an operator note over its bound or any citation that is not alias-shaped is a failure
 *   (`schema_invalid`, with its path), and an automatic reply hands off (ADR-0034 §1: invalid
 *   output sends nothing). Lead decision, review of this branch.
 * - `ASSIST` — an Assist draft, which a PERSON reads, edits and sends. The operator-only notes
 *   (`summary`, `intent`) are cut to their bounds, and a citation that is not alias-shaped
 *   (`["FAQ"]`, a title) is dropped — as unknown citations always were — rather than throwing
 *   away a draft the operator could use. The suggested reply is never altered.
 *
 * The root-cause fix is the same for both: knowledge carries `K…` aliases and the prompt
 * defines both reference lists and both note bounds, so a correct model has something valid
 * to write. The tolerance is Assist's backstop, not the fix.
 */

/** Why an output is not a decision: the class, and the first zod issue's path and code. */
export interface DecisionValidationFailure {
  readonly failureClass: Extract<SupportAiFailureClass, 'schema_invalid' | 'reply_too_long'>;
  /** Property names and indices only (`intent`, `factRefs.0`), `(root)` for the object. */
  readonly issuePath: string;
  readonly issueCode: string;
}

export type DecisionParse =
  | { readonly ok: true; readonly decision: SupportAiDecision }
  | { readonly ok: false; readonly failure: DecisionValidationFailure };

export function parseSupportDecision(
  output: unknown,
  options: {
    /**
     * The tenant's reply limit, enforced as a parse failure (Assist, the capability test).
     * Null where a deterministic guard enforces it instead (Auto Reply's `reply_bounds`).
     */
    readonly maxReplyChars: number | null;
    /** `STRICT` (Auto Reply, the capability test) or `ASSIST` (a draft a person edits). */
    readonly mode: 'STRICT' | 'ASSIST';
  },
): DecisionParse {
  const parsed = supportAiDecisionSchema.safeParse(
    options.mode === 'ASSIST' ? tolerateRefs(clampOperatorNotes(output)) : output,
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issuePathOf(issue?.path ?? []);
    const code = safeIssueCode(issue?.code);
    return {
      ok: false,
      failure: {
        failureClass:
          path === 'replyText' && code === 'too_big' ? 'reply_too_long' : 'schema_invalid',
        issuePath: path,
        issueCode: code,
      },
    };
  }
  if (options.maxReplyChars !== null && parsed.data.replyText.length > options.maxReplyChars) {
    return {
      ok: false,
      failure: { failureClass: 'reply_too_long', issuePath: 'replyText', issueCode: 'too_big' },
    };
  }
  return { ok: true, decision: parsed.data };
}

/**
 * Output tokens a decision may need, worst case, at the tenant's reply limit: every character
 * of the reply and both notes at TWO tokens (a Persian letter is two UTF-8 bytes, and a
 * byte-level tokenizer's worst case is a token per byte), plus the keys, enums and refs.
 * `outputTokenBudget` adds the reasoning headroom on top. The previous figure,
 * `min(4000, chars × 3 + 600)`, was capped BELOW a 4,000-character reply's own worst case.
 */
export const DECISION_STRUCTURE_TOKENS = 512;
export function decisionOutputTokens(maxReplyChars: number): number {
  const chars =
    Math.min(maxReplyChars, SUPPORT_AI_REPLY_MAX_CHARS) +
    SUPPORT_AI_SUMMARY_MAX_CHARS +
    SUPPORT_AI_INTENT_MAX_CHARS;
  return chars * 2 + DECISION_STRUCTURE_TOKENS;
}

function tolerateRefs(output: unknown): unknown {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return output;
  const record = output as Record<string, unknown>;
  const wellFormed = (refs: unknown) =>
    Array.isArray(refs)
      ? refs.filter((ref) => typeof ref === 'string' && SUPPORT_AI_REF_PATTERN.test(ref))
      : refs;
  return {
    ...record,
    ...('knowledgeRefs' in record ? { knowledgeRefs: wellFormed(record.knowledgeRefs) } : {}),
    ...('factRefs' in record ? { factRefs: wellFormed(record.factRefs) } : {}),
  };
}

function clampOperatorNotes(output: unknown): unknown {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return output;
  const record = output as Record<string, unknown>;
  return {
    ...record,
    ...(typeof record.summary === 'string'
      ? { summary: clampText(record.summary, SUPPORT_AI_SUMMARY_MAX_CHARS) }
      : {}),
    ...(typeof record.intent === 'string'
      ? { intent: clampText(record.intent, SUPPORT_AI_INTENT_MAX_CHARS) }
      : {}),
  };
}

/** Cut to `max` UTF-16 units (zod's measure) without leaving half a surrogate pair. */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function issuePathOf(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  const joined = path
    .map((part) => (typeof part === 'number' ? String(part) : String(part)))
    .join('.')
    .replace(/[^A-Za-z0-9_.]/gu, '_');
  return joined.slice(0, 128);
}

function safeIssueCode(code: unknown): string {
  return typeof code === 'string' && /^[a-z_]{1,64}$/u.test(code) ? code : 'invalid';
}
