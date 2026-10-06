import { describe, expect, it } from 'vitest';
import {
  SUPPORT_AI_CONFIDENCES,
  SUPPORT_AI_DECISION_JSON_SCHEMA,
  SUPPORT_AI_DECISIONS,
  SUPPORT_AI_LIMITS,
  SUPPORT_AI_TICKET_ACTIONS,
  SUPPORT_AI_TOPICS,
  supportAiDecisionSchema,
} from '@nexa/contracts';
import {
  AI_OUTPUT_TOKEN_BUDGET_MAX,
  AI_OUTPUT_TOKEN_HEADROOM,
  outputTokenBudget,
} from '../../apps/api/src/infrastructure/ai/ai-http';
import {
  clampText,
  decisionOutputTokens,
  parseSupportDecision,
} from '../../apps/api/src/modules/control/support-ai/domain/decision';
import { supportSystemPrompt } from '../../apps/api/src/modules/control/support-ai/domain/prompt';

/**
 * Program §A4 — the structured decision contract, audited.
 *
 * The JSON Schema every adapter sends is checked against OpenAI's STRICT structured-output
 * rules (the strictest of the three providers): a root object, every object closed, every
 * property required, only the keywords strict mode supports, and enums and keys that are
 * exactly what the zod parser (the authority) accepts. Then the token budget, then the parser
 * against real-shaped model answers.
 */

type Schema = Record<string, unknown>;

/** The keywords OpenAI strict mode accepts (its structured-outputs "supported schemas"). */
const STRICT_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'description',
  'anyOf',
  '$defs',
  '$ref',
  'const',
]);

function walk(schema: Schema, path: string, visit: (node: Schema, path: string) => void): void {
  visit(schema, path);
  const properties = schema.properties as Record<string, Schema> | undefined;
  for (const [key, child] of Object.entries(properties ?? {})) walk(child, `${path}.${key}`, visit);
  if (schema.items !== undefined) walk(schema.items as Schema, `${path}[]`, visit);
}

describe('SUPPORT_AI_DECISION_JSON_SCHEMA is valid for strict structured output', () => {
  const schema = SUPPORT_AI_DECISION_JSON_SCHEMA;

  it('has an object at the root', () => {
    expect(schema.type).toBe('object');
  });

  it('closes every object and requires every property', () => {
    walk(schema, '$', (node, path) => {
      if (node.type !== 'object') return;
      expect(node.additionalProperties, path).toBe(false);
      const keys = Object.keys((node.properties ?? {}) as Schema).sort();
      expect([...((node.required ?? []) as string[])].sort(), path).toEqual(keys);
    });
  });

  it('uses only keywords strict mode supports — no length, numeric or pattern bound', () => {
    walk(schema, '$', (node, path) => {
      for (const keyword of Object.keys(node)) {
        expect(STRICT_KEYWORDS.has(keyword), `${path}: ${keyword}`).toBe(true);
      }
    });
  });

  it('names exactly the keys the zod parser accepts', () => {
    expect(Object.keys(schema.properties as Schema).sort()).toEqual(
      Object.keys(supportAiDecisionSchema.shape).sort(),
    );
  });

  it('offers every enum value the parser accepts, and no other', () => {
    const properties = schema.properties as Record<string, { enum?: string[] }>;
    expect(properties.decision?.enum).toEqual([...SUPPORT_AI_DECISIONS]);
    expect(properties.topic?.enum).toEqual([...SUPPORT_AI_TOPICS]);
    expect(properties.confidence?.enum).toEqual([...SUPPORT_AI_CONFIDENCES]);
    expect(properties.ticketAction?.enum).toEqual([...SUPPORT_AI_TICKET_ACTIONS]);
    for (const [key, property] of Object.entries(properties)) {
      if (property.enum === undefined) continue;
      for (const value of property.enum) {
        const probe = {
          ...validDecision(),
          [key]: value,
        };
        expect(supportAiDecisionSchema.safeParse(probe).success, `${key}=${value}`).toBe(true);
      }
    }
  });
});

describe('the output-token budget cannot truncate a normal decision', () => {
  // Worst case: every character of the reply and both notes at two tokens (a Persian letter is
  // two UTF-8 bytes; a byte-level tokenizer's worst case is a token per byte), plus structure.
  const worstCase = (chars: number) => (chars + 600 + 120) * 2 + 400;

  it.each([SUPPORT_AI_LIMITS.maxOutputChars.min, 1_200, SUPPORT_AI_LIMITS.maxOutputChars.max])(
    'at maxOutputChars = %i the decision fits, with the reasoning headroom on top',
    (chars) => {
      const requested = decisionOutputTokens(chars);
      expect(requested).toBeGreaterThanOrEqual(worstCase(chars));
      expect(outputTokenBudget(requested)).toBeGreaterThanOrEqual(
        requested + AI_OUTPUT_TOKEN_HEADROOM,
      );
      // Never above the smallest output limit of a strict-structured-output model.
      expect(outputTokenBudget(requested)).toBeLessThanOrEqual(16_384);
    },
  );

  it('the former figure was capped below a 4,000-character reply’s own worst case', () => {
    const former = Math.min(4_000, 4_000 * 3 + 600);
    expect(former).toBeLessThan(worstCase(4_000));
    expect(AI_OUTPUT_TOKEN_BUDGET_MAX).toBe(16_384);
  });
});

function validDecision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision: 'REPLY',
    replyText: 'لطفاً برنامه را ببندید و دوباره باز کنید.',
    topic: 'CONNECTION_TROUBLESHOOTING',
    confidence: 'HIGH',
    factRefs: [],
    knowledgeRefs: ['K1'],
    ticketAction: 'NONE',
    summary: 'مشتری می‌گوید سرویسش وصل نمی‌شود.',
    intent: 'رفع مشکل اتصال',
    ...overrides,
  };
}

const assist = { maxReplyChars: null, mode: 'ASSIST' } as const;
const auto = { maxReplyChars: null, mode: 'STRICT' } as const;

describe('parseSupportDecision — real-shaped model answers', () => {
  it('accepts a correct decision unchanged', () => {
    const parsed = parseSupportDecision(validDecision(), auto);
    expect(parsed).toEqual({ ok: true, decision: validDecision() });
  });

  // Regression: an Assist draft whose operator-only intent ran long was thrown away whole.
  it('ASSIST cuts an over-long intent or summary to its bound instead of failing the draft', () => {
    const intent = 'مشتری می‌گوید سرویس او وصل نمی‌شود و ' + 'ا'.repeat(200);
    const summary = 'خلاصه '.repeat(200);
    const parsed = parseSupportDecision(validDecision({ intent, summary }), assist);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.decision.intent).toBe(intent.slice(0, 120));
      expect(parsed.decision.summary.length).toBe(600);
      expect(parsed.decision.replyText).toBe(validDecision().replyText);
    }
  });

  // ADR-0034 §1, lead decision: an automatic reply is held to the schema exactly.
  it('STRICT refuses an over-long intent or summary, naming the field', () => {
    expect(parseSupportDecision(validDecision({ intent: 'ا'.repeat(121) }), auto)).toEqual({
      ok: false,
      failure: { failureClass: 'schema_invalid', issuePath: 'intent', issueCode: 'too_big' },
    });
    expect(parseSupportDecision(validDecision({ summary: 'ا'.repeat(601) }), auto)).toMatchObject({
      ok: false,
      failure: { issuePath: 'summary', issueCode: 'too_big' },
    });
  });

  it('never alters the reply that would be sent: an over-long reply is still refused', () => {
    const parsed = parseSupportDecision(validDecision({ replyText: 'ب'.repeat(4_001) }), auto);
    expect(parsed).toEqual({
      ok: false,
      failure: { failureClass: 'reply_too_long', issuePath: 'replyText', issueCode: 'too_big' },
    });
  });

  it('enforces the tenant limit only where asked to', () => {
    const long = validDecision({ replyText: 'ب'.repeat(900) });
    expect(parseSupportDecision(long, { ...auto, maxReplyChars: 800 })).toMatchObject({
      ok: false,
      failure: { failureClass: 'reply_too_long' },
    });
    expect(parseSupportDecision(long, assist).ok).toBe(true);
  });

  // Regression (agent audit D1): knowledge carried no alias, so a model citing it wrote
  // something like "FAQ", and the whole draft failed the parse.
  it('ASSIST drops a knowledge citation that is not an alias; STRICT refuses it', () => {
    const answer = validDecision({ knowledgeRefs: ['FAQ', 'K2', 'سرویس وصل نمی‌شود'] });
    const parsed = parseSupportDecision(answer, assist);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.decision.knowledgeRefs).toEqual(['K2']);
    expect(parseSupportDecision(answer, auto)).toEqual({
      ok: false,
      failure: {
        failureClass: 'schema_invalid',
        issuePath: 'knowledgeRefs.0',
        issueCode: 'invalid_format',
      },
    });
  });

  it('keeps a malformed FACT citation fatal for an automatic reply, and drops it for Assist', () => {
    const answer = validDecision({ factRefs: ['S1', 'service of the customer'] });
    expect(parseSupportDecision(answer, auto)).toEqual({
      ok: false,
      failure: {
        failureClass: 'schema_invalid',
        issuePath: 'factRefs.1',
        issueCode: 'invalid_format',
      },
    });
    const drafted = parseSupportDecision(answer, assist);
    expect(drafted.ok && drafted.decision.factRefs).toEqual(['S1']);
  });

  it('reports a path and a code, never a value', () => {
    const secret = 'sk-live-THIS-MUST-NOT-LEAK';
    const parsed = parseSupportDecision(validDecision({ topic: secret }), auto);
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain(secret);
    expect(parsed).toMatchObject({ failure: { issuePath: 'topic' } });
    const extra = parseSupportDecision(validDecision({ [secret]: 1 }), auto);
    expect(JSON.stringify(extra)).not.toContain(secret);
    expect(extra).toMatchObject({
      failure: {
        failureClass: 'schema_invalid',
        issuePath: '(root)',
        issueCode: 'unrecognized_keys',
      },
    });
  });

  it('a missing field is schema_invalid at that field', () => {
    const answer = validDecision();
    delete answer.intent;
    expect(parseSupportDecision(answer, auto)).toMatchObject({
      ok: false,
      failure: { failureClass: 'schema_invalid', issuePath: 'intent' },
    });
  });

  it('clamps without splitting a surrogate pair', () => {
    expect(clampText('ab😀', 3)).toBe('ab');
    expect(clampText('abc', 3)).toBe('abc');
  });
});

describe('the prompt tells the model what each field holds', () => {
  const prompt = supportSystemPrompt({
    businessToneInstructions: '',
    maxReplyChars: 1_200,
    contextJson: '{}',
    identityLinked: true,
  });

  it('defines factRefs and knowledgeRefs, their alias shape and the empty list', () => {
    expect(prompt).toContain('factRefs lists ONLY the "alias" values');
    expect(prompt).toContain(
      'knowledgeRefs lists ONLY the "alias" values of the knowledge entries',
    );
    expect(prompt).toContain('never a title, a question, an app name, a source name such as FAQ');
    expect(prompt).toContain('Use an empty list []');
  });

  it('states the bounds of summary and intent', () => {
    expect(prompt).toContain('at most 600 characters');
    expect(prompt).toContain('at most 120 characters');
    expect(prompt).toContain('at most 1200 characters');
  });
});
