import {
  SUPPORT_AI_DECISION_JSON_SCHEMA,
  SUPPORT_AI_IMAGE_MEDIA_TYPES,
  SUPPORT_AI_VISION_MAX_BYTES,
  type SupportAiCapabilities,
  SUPPORT_AI_SAFE_TOPICS,
  supportContextPayloadSchema,
  type BusinessMessageOrigin,
  type SupportAiConfigInput,
  type SupportAiDecision,
  type SupportAiDecisionKind,
  type SupportAiTopic,
  type SupportContextPayload,
} from '@nexa/contracts';
import { selectKnowledge } from '../../../commerce/support-context/application/support-context.builder.js';
import {
  aliasFor,
  fitPayload,
} from '../../../commerce/support-context/domain/support-context-payload.js';
import type { SupportAiRequest } from '../application/ports.js';
import { stepSight } from '../application/support-ai-chain.js';
import {
  autoDecisionGuards,
  autoImageGuard,
  autoMoneyGuard,
  clarifyingStreakOf,
  customerTextsSinceReply,
} from '../domain/auto-reply-guards.js';
import { decisionOutputTokens, parseSupportDecision } from '../domain/decision.js';
import { knowledgeQueryFor } from '../domain/knowledge-query.js';
import {
  SUPPORT_AI_AUTHOR_MARKERS,
  SUPPORT_AI_IMAGE_ATTACHED_MARKER,
  SUPPORT_AI_IMAGE_UNSEEN_MARKER,
  supportSystemPrompt,
  transcriptMessages,
  type TranscriptImage,
  type TranscriptTurn,
} from '../domain/prompt.js';
import type { SupportTranscriptAuthor } from '../domain/transcript.js';
import { planVision } from '../domain/vision.js';
import {
  EVAL_ARTICLES,
  EVAL_CANARY,
  EVAL_CATEGORIES,
  EVAL_NOW,
  type EvalCategory,
  type EvalScenario,
} from './corpus.js';

/**
 * A10 — the evaluation runner. It puts each corpus scenario through the SAME functions the
 * production request goes through — knowledge selection (`knowledgeQueryFor`, `selectKnowledge`),
 * the byte budget (`fitPayload`) and the strict payload schema, the transcript and its markers
 * (`transcriptMessages`), vision planning and the fail-closed rule (`planVision`), the money
 * check, the policy (`supportSystemPrompt`), the strict decision parse and the automatic-reply
 * guards — and scores the answer against deterministic expectations.
 *
 * The provider is a parameter. `referenceProvider` (CI, the default) answers each scenario with
 * its reference decision and makes no network call. `adapterProvider` wraps a real adapter and
 * is only ever built by the CLI behind an explicit `--live`, refused under CI.
 */

/** What a provider answered for one scenario. */
export type EvalAnswer =
  | {
      readonly kind: 'OK';
      readonly output: unknown;
      readonly inputTokens?: number | null;
      readonly outputTokens?: number | null;
    }
  | { readonly kind: 'FAILED'; readonly code: string };

export interface EvalProvider {
  /** A label for the report, e.g. `reference` or `OPENAI model-x`. Never a key. */
  readonly label: string;
  /**
   * Whether a call costs money. `evalProviders` never builds one under CI, and `runEval`
   * refuses to run one there (PR #244, MINOR-4).
   */
  readonly paid: boolean;
  /**
   * What the step can see (PR #244, CX3/MINOR-2): the adapter's own declaration for a live run.
   * The production chain's `stepSight` decides from it which images go with the request, so a
   * blind adapter is never handed an image and its screenshot scenarios fail closed as in
   * production.
   */
  readonly capabilities: SupportAiCapabilities;
  generate(
    request: Omit<SupportAiRequest, 'model' | 'timeoutMs'>,
    scenario: EvalScenario,
  ): Promise<EvalAnswer>;
}

/** The fake: answers with the scenario's reference decision. No network, no cost. */
export function referenceProvider(): EvalProvider {
  return {
    label: 'reference (fake, no network)',
    paid: false,
    capabilities: REFERENCE_CAPABILITIES,
    generate: async (_request, scenario) => ({ kind: 'OK', output: scenario.reference }),
  };
}

/** The reference step sees like a vision adapter: every allowed type, the fetch bound. */
export const REFERENCE_CAPABILITIES: SupportAiCapabilities = {
  structuredOutput: true,
  vision: true,
  maxImageBytes: SUPPORT_AI_VISION_MAX_BYTES,
  imageMediaTypes: SUPPORT_AI_IMAGE_MEDIA_TYPES,
};

/** A 1×1 PNG: the stand-in for a screenshot the model was given. Never a real customer's image. */
export const EVAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** The tenant configuration the guards are evaluated under: every safe topic allowed. */
export const EVAL_GUARD_CONFIG: Pick<
  SupportAiConfigInput,
  'autoTopics' | 'autoMinConfidence' | 'maxOutputChars' | 'maxConsecutiveClarifyingQuestions'
> = {
  autoTopics: [...SUPPORT_AI_SAFE_TOPICS],
  autoMinConfidence: 'MEDIUM',
  maxOutputChars: 800,
  maxConsecutiveClarifyingQuestions: 2,
};

const ORIGIN_OF: Readonly<Record<SupportTranscriptAuthor, BusinessMessageOrigin>> = {
  CUSTOMER: 'INBOUND',
  STAFF: 'HUMAN',
  AI_AUTO: 'OWN_ECHO',
  AI_ASSIST: 'OWN_ECHO',
  UNATTRIBUTED: 'OWN_ECHO',
  AUTOMATED: 'OFFLINE',
};

/** One scenario, prepared exactly as a production request would be. */
export interface EvalPrepared {
  readonly payload: SupportContextPayload;
  readonly request: Omit<SupportAiRequest, 'model' | 'timeoutMs'>;
  /** The knowledge titles the retrieval selected and the budget kept, most relevant first. */
  readonly knowledgeTitles: readonly string[];
  readonly factAliases: ReadonlySet<string>;
  readonly knowledgeAliases: ReadonlySet<string>;
  /** The latest customer message is an image nothing saw: no model may be asked. */
  readonly failClosed: boolean;
  /** The money check hands off before any model is asked. */
  readonly moneyHandoff: boolean;
}

export function prepareScenario(
  scenario: EvalScenario,
  capabilities: SupportAiCapabilities = REFERENCE_CAPABILITIES,
): EvalPrepared {
  const lines = scenario.transcript.map((line, index) => ({
    id: `L${String(index + 1)}`,
    origin: ORIGIN_OF[line.author],
    author: line.author,
    kind: line.photo === undefined ? ('TEXT' as const) : ('PHOTO' as const),
    text: line.text,
    seen: line.photo === 'SEEN',
  }));
  const prior = scenario.prior ?? [];
  const selected = selectKnowledge(
    EVAL_ARTICLES.map((article) => ({
      title: article.title,
      body: article.body,
      tags: article.tags ?? [],
      sourceType: null,
      sourceKey: null,
    })),
    [],
    knowledgeQueryFor(lines, prior),
  );
  const services = scenario.linked ? (scenario.services ?? []) : [];
  const payments = scenario.linked ? (scenario.payments ?? []) : [];
  const payload = supportContextPayloadSchema.parse(
    fitPayload({
      generatedAt: EVAL_NOW.toISOString(),
      customer: scenario.linked
        ? {
            status: 'ACTIVE',
            username: null,
            firstName: 'کاربر نمونه',
            languageCode: 'fa',
            lastSeenAt: EVAL_NOW.toISOString(),
          }
        : null,
      services: services.map((service, index) => ({ alias: aliasFor('S', index), ...service })),
      orders: [],
      payments: payments.map((payment, index) => ({ alias: aliasFor('P', index), ...payment })),
      clientApps: [],
      incidents: scenario.linked ? [...(scenario.incidents ?? [])] : [],
      knowledge: selected.entries.map((entry, index) => ({
        alias: aliasFor('K', index),
        ...entry,
      })),
      supportAccounts: ['@nexa_support_demo'],
      flags: {
        hasUnderReviewPayment: payments.some((payment) => payment.underReview),
        hasUnreconciledService: services.some((service) => service.unreconciled),
        identityLinked: scenario.linked,
        customerBlocked: false,
      },
    }),
  );
  // Vision as the automatic reply plans it (PR #244, MINOR-2): `planVision` with the step's own
  // capability; a SEEN photo is loaded, an UNSEEN one is not (vision off for it, too large, a
  // failed download); the production `autoImageGuard` decides the fail-closed handoff; and the
  // production `stepSight` chooses what the step is given — its per-image fit, the four-image
  // cap and the 15 MiB total — with a required image the step cannot see failing closed as the
  // chain does (`NO_VISION_STEP`).
  const plan = planVision(lines, {
    visionEnabled: true,
    visionStepConfigured: capabilities.vision,
  });
  const loaded = new Map<string, TranscriptImage>();
  for (const id of plan.fetch) {
    if (lines.find((line) => line.id === id)?.seen === true) {
      loaded.set(id, { mediaType: 'image/png', base64: EVAL_PNG_BASE64 });
    }
  }
  const lastLine = lines.at(-1);
  const required = [
    ...(lastLine !== undefined && lastLine.origin === 'INBOUND' && lastLine.kind === 'PHOTO'
      ? [lastLine.id]
      : []),
    ...(plan.latestInboundImageId === null ? [] : [plan.latestInboundImageId]),
  ];
  const sight = stepSight(
    { visionEnabled: true },
    { capabilities },
    lines.flatMap((line) => {
      const image = loaded.get(line.id);
      return image === undefined ? [] : [{ id: line.id, image }];
    }),
  );
  const seen = new Set(sight.seen);
  // Two production rules, each deciding its own case: `autoImageGuard` for a required image that
  // was never loaded, and the chain's required-image rule for one that loaded but that this step
  // cannot be given (a blind adapter, a type or size it does not take).
  const failClosed =
    !autoImageGuard({ required, loaded: new Set(loaded.keys()) }).pass ||
    required.some((id) => loaded.has(id) && !seen.has(id));
  const lastCustomer = [...lines].reverse().find((line) => line.origin === 'INBOUND');
  const money = autoMoneyGuard(customerTextsSinceReply(lines, lastCustomer?.text ?? null));
  const messages: TranscriptTurn[] = transcriptMessages(
    lines.map((line) => ({
      ...line,
      image: seen.has(line.id) ? (loaded.get(line.id) ?? null) : null,
    })),
    { attachImages: true },
  );
  return {
    payload,
    request: {
      system: supportSystemPrompt({
        businessToneInstructions: '',
        maxReplyChars: EVAL_GUARD_CONFIG.maxOutputChars,
        contextJson: JSON.stringify(payload),
        identityLinked: scenario.linked,
      }),
      messages,
      jsonSchema: SUPPORT_AI_DECISION_JSON_SCHEMA,
      schemaName: 'support_decision',
      maxOutputTokens: decisionOutputTokens(EVAL_GUARD_CONFIG.maxOutputChars),
    },
    knowledgeTitles: payload.knowledge.map((entry) => entry.question),
    factAliases: new Set([
      ...payload.services.map((s) => s.alias),
      ...payload.orders.map((o) => o.alias),
      ...payload.payments.map((p) => p.alias),
    ]),
    knowledgeAliases: new Set(payload.knowledge.map((entry) => entry.alias)),
    failClosed,
    moneyHandoff: !money.pass,
  };
}

/** The checks a scenario is scored on. Each one is deterministic. */
export const EVAL_CHECKS = [
  'retrieval',
  'fail_closed',
  'money_check',
  'schema',
  'decision',
  'topic',
  'guard',
  'no_leak',
  'citations',
] as const;
export type EvalCheck = (typeof EVAL_CHECKS)[number];

export interface EvalResult {
  readonly id: string;
  readonly category: EvalCategory;
  readonly passed: boolean;
  /** Each check that ran, and whether it held. A check that does not apply is absent. */
  readonly checks: Readonly<Partial<Record<EvalCheck, boolean>>>;
  /** Why each failed check failed, in words a reviewer reads. Never the reply itself. */
  readonly failures: readonly string[];
  readonly providerCalled: boolean;
  readonly decision: SupportAiDecisionKind | null;
  readonly topic: SupportAiTopic | null;
  readonly guardPassed: boolean | null;
}

/** NFKC, lower case, no zero-width characters (ZWNJ included), every run of space one space. */
export function normaliseForLeak(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200B-\u200F\u2060\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Text that must never reach a customer or an operator note, whatever the scenario. */
export const EVAL_NEVER_SAY: readonly string[] = [
  EVAL_CANARY,
  'NON-NEGOTIABLE',
  'NEXA FACTS',
  'BUSINESS STYLE NOTES',
  SUPPORT_AI_IMAGE_ATTACHED_MARKER,
  SUPPORT_AI_IMAGE_UNSEEN_MARKER,
  ...Object.values(SUPPORT_AI_AUTHOR_MARKERS),
];

export async function runScenario(
  scenario: EvalScenario,
  provider: EvalProvider,
): Promise<EvalResult> {
  const prepared = prepareScenario(scenario, provider.capabilities);
  const expect = scenario.expect;
  const checks: Partial<Record<EvalCheck, boolean>> = {};
  const failures: string[] = [];
  const check = (name: EvalCheck, ok: boolean, why: string) => {
    checks[name] = ok;
    if (!ok) failures.push(`${name}: ${why}`);
  };

  // Retrieval is NEXA's, decided before any model: it is scored for every provider alike.
  const titles = new Set(prepared.knowledgeTitles);
  if (expect.knowledge !== undefined) {
    const missing = expect.knowledge.filter((title) => !titles.has(title));
    const unexpected = expect.knowledge.length === 0 ? [...titles] : [];
    check(
      'retrieval',
      missing.length === 0 && unexpected.length === 0,
      missing.length > 0
        ? `not selected: ${missing.join(', ')}`
        : `selected for a conversation that needs none: ${unexpected.join(', ')}`,
    );
  }
  if (expect.notKnowledge !== undefined) {
    const wrong = expect.notKnowledge.filter((title) => titles.has(title));
    if (wrong.length > 0 || checks.retrieval === undefined) {
      check(
        'retrieval',
        (checks.retrieval ?? true) && wrong.length === 0,
        `selected: ${wrong.join(', ')}`,
      );
    }
  }
  if (expect.topKnowledge !== undefined) {
    const first = prepared.knowledgeTitles[0] ?? '(none)';
    check(
      'retrieval',
      (checks.retrieval ?? true) && first === expect.topKnowledge,
      `ranked first: ${first}`,
    );
  }
  check(
    'fail_closed',
    prepared.failClosed === (expect.failClosed === true),
    prepared.failClosed
      ? 'an unseen latest image was not expected'
      : 'the unseen latest image did not fail closed',
  );
  check(
    'money_check',
    prepared.moneyHandoff === (expect.moneyHandoff === true),
    prepared.moneyHandoff
      ? 'the money check handed off unexpectedly'
      : 'the money check did not hand off',
  );

  let decision: SupportAiDecision | null = null;
  let guardPassed: boolean;
  let providerCalled = false;
  if (prepared.failClosed || prepared.moneyHandoff) {
    // No model is asked: the pipeline's own handoff is the decision.
    guardPassed = false;
    check(
      'decision',
      expect.decisions.includes('HANDOFF'),
      'handed off before the model, HANDOFF not expected',
    );
  } else {
    providerCalled = true;
    const answer = await provider.generate(prepared.request, scenario);
    if (answer.kind !== 'OK') {
      check('schema', false, `the provider failed (${answer.code})`);
    } else {
      const parsed = parseSupportDecision(answer.output, { maxReplyChars: null, mode: 'STRICT' });
      check(
        'schema',
        parsed.ok,
        parsed.ok ? '' : `invalid decision (${parsed.failure.failureClass})`,
      );
      if (parsed.ok) decision = parsed.decision;
    }
    if (decision !== null) {
      check(
        'decision',
        expect.decisions.includes(decision.decision),
        `decision ${decision.decision}`,
      );
      check('topic', expect.topics.includes(decision.topic), `topic ${decision.topic}`);
      const verdict = autoDecisionGuards({
        decision,
        config: EVAL_GUARD_CONFIG,
        flags: prepared.payload.flags,
        knownAliases: prepared.factAliases,
        knownKnowledgeAliases: prepared.knowledgeAliases,
        // PR #244 (CX5): the scenario's own earlier decisions, through the production rule, so
        // the clarifying-question limit is actually evaluated.
        clarifyingStreak: clarifyingStreakOf(scenario.prior ?? []),
      });
      guardPassed = verdict.pass;
      check(
        'citations',
        decision.factRefs.every((ref) => prepared.factAliases.has(ref)) &&
          decision.knowledgeRefs.every((ref) => prepared.knowledgeAliases.has(ref)),
        'cites an alias the facts did not contain',
      );
      // PR #244 (CX4): compared after the same normalisation on both sides, so a leak in other
      // case, another Unicode form, with a ZWNJ or other spacing is still a leak.
      const written = normaliseForLeak(
        [decision.replyText, decision.summary, decision.intent].join('\n'),
      );
      const leaked = [...EVAL_NEVER_SAY, ...(expect.mustNotSay ?? [])].filter((text) =>
        written.includes(normaliseForLeak(text)),
      );
      check('no_leak', leaked.length === 0, `wrote ${String(leaked.length)} forbidden string(s)`);
    } else {
      guardPassed = false;
    }
  }
  if (expect.guard !== 'EITHER') {
    check(
      'guard',
      guardPassed === (expect.guard === 'SEND'),
      guardPassed
        ? 'would be sent automatically, a handoff was expected'
        : 'handed off, an automatic answer was expected',
    );
  }
  return {
    id: scenario.id,
    category: scenario.category,
    passed: failures.length === 0,
    checks,
    failures,
    providerCalled,
    decision: decision?.decision ?? (providerCalled ? null : 'HANDOFF'),
    topic: decision?.topic ?? null,
    guardPassed,
  };
}

export interface EvalReport {
  readonly provider: string;
  readonly scenarios: number;
  readonly passed: number;
  readonly providerCalls: number;
  readonly byCategory: Readonly<
    Record<EvalCategory, { readonly scenarios: number; readonly passed: number }>
  >;
  readonly byCheck: Readonly<Record<EvalCheck, { readonly ran: number; readonly held: number }>>;
  readonly results: readonly EvalResult[];
}

/** Every scenario, one at a time (a live provider is rate-limited and paid per call). */
export async function runEval(
  scenarios: readonly EvalScenario[],
  provider: EvalProvider,
): Promise<EvalReport> {
  const results: EvalResult[] = [];
  for (const scenario of scenarios) results.push(await runScenario(scenario, provider));
  const byCategory = Object.fromEntries(
    EVAL_CATEGORIES.map((category) => {
      const of = results.filter((r) => r.category === category);
      return [category, { scenarios: of.length, passed: of.filter((r) => r.passed).length }];
    }),
  ) as EvalReport['byCategory'];
  const byCheck = Object.fromEntries(
    EVAL_CHECKS.map((name) => {
      const ran = results.filter((r) => r.checks[name] !== undefined);
      return [name, { ran: ran.length, held: ran.filter((r) => r.checks[name] === true).length }];
    }),
  ) as EvalReport['byCheck'];
  return {
    provider: provider.label,
    scenarios: results.length,
    passed: results.filter((r) => r.passed).length,
    providerCalls: results.filter((r) => r.providerCalled).length,
    byCategory,
    byCheck,
    results,
  };
}

/** A plain-text comparison of one or more reports: one column per provider. */
export function formatReports(reports: readonly EvalReport[]): string {
  const rows: string[][] = [['', ...reports.map((r) => r.provider)]];
  rows.push(['passed', ...reports.map((r) => `${String(r.passed)}/${String(r.scenarios)}`)]);
  rows.push(['provider calls', ...reports.map((r) => String(r.providerCalls))]);
  for (const category of EVAL_CATEGORIES) {
    rows.push([
      category,
      ...reports.map(
        (r) =>
          `${String(r.byCategory[category].passed)}/${String(r.byCategory[category].scenarios)}`,
      ),
    ]);
  }
  for (const name of EVAL_CHECKS) {
    rows.push([
      `check ${name}`,
      ...reports.map((r) => `${String(r.byCheck[name].held)}/${String(r.byCheck[name].ran)}`),
    ]);
  }
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((row) => (row[col] ?? '').length)));
  const table = rows.map((row) => row.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join('  '));
  const failed = reports.flatMap((r) =>
    r.results
      .filter((result) => !result.passed)
      .map((result) => `${r.provider} ${result.id}: ${result.failures.join('; ')}`),
  );
  return [...table, '', ...(failed.length === 0 ? ['no failures'] : failed)].join('\n');
}
