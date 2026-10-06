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
 * `supportAiDecisionSchema` stays the authority: nothing that fails it is a decision, and the
 * reply an automatic answer would SEND is never altered. The two operator-only notes are the
 * exception: `summary` and `intent` are never shown to a customer, so a model that writes
 * a longer note than the bound is cut to the bound rather than having a correct reply thrown
 * away for it (the prompt states both bounds; this is the backstop).
 *
 * Citations. `knowledgeRefs` is read by no guard — it only labels a draft — so an entry that is
 * not alias-shaped (`["FAQ"]`, a title) is DROPPED everywhere rather than discarding the whole
 * answer. `factRefs` is the automatic reply's grounding evidence (TB7's `grounding` guard): a
 * malformed one stays a parse failure there (`dropMalformedRefs: false`), and is dropped only
 * for an Assist draft, which a person reads and whose unknown citations were always dropped.
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
    /** Drop a malformed FACT ref too (Assist). Knowledge refs are always tolerated. */
    readonly dropMalformedRefs: boolean;
  },
): DecisionParse {
  const parsed = supportAiDecisionSchema.safeParse(
    tolerateRefs(clampOperatorNotes(output), options.dropMalformedRefs),
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

function tolerateRefs(output: unknown, facts: boolean): unknown {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return output;
  const record = output as Record<string, unknown>;
  const wellFormed = (refs: unknown) =>
    Array.isArray(refs)
      ? refs.filter((ref) => typeof ref === 'string' && SUPPORT_AI_REF_PATTERN.test(ref))
      : refs;
  return {
    ...record,
    ...('knowledgeRefs' in record ? { knowledgeRefs: wellFormed(record.knowledgeRefs) } : {}),
    ...(facts && 'factRefs' in record ? { factRefs: wellFormed(record.factRefs) } : {}),
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
