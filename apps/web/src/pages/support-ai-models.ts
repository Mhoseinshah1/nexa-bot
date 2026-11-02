import type { SupportAiProvider } from '@nexa/contracts';

/**
 * Phase 4 PR-5 — models offered in the dropdown, per provider. A list for convenience, not a
 * guarantee: whether a model answers in NEXA's strict JSON decision shape is what the capability
 * test («اجرای آزمایش») and the readiness card verify. Anything not listed is «سایر» and typed.
 * Ordered cheapest-sensible first; no model is selected for the owner.
 */
export const SUPPORT_AI_KNOWN_MODELS: Readonly<Record<SupportAiProvider, readonly string[]>> = {
  OPENAI: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
  ANTHROPIC: ['claude-haiku-4-5', 'claude-sonnet-4-5'],
  ZAI: ['glm-4.5-air', 'glm-4.5', 'glm-4.6'],
};

/**
 * The select's value for «سایر». Never a model id (it contains characters no id has).
 */
export const SUPPORT_AI_OTHER_MODEL = '__other__';
