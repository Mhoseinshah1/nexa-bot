import { describe, expect, it } from 'vitest';
import { SUPPORT_AI_DECISIONS, SUPPORT_AI_TOPICS, supportAiDecisionSchema } from '@nexa/contracts';
import {
  EVAL_ARTICLES,
  EVAL_CANARY,
  EVAL_CATEGORIES,
  EVAL_SCENARIOS,
  type EvalScenario,
} from '../../apps/api/src/modules/control/support-ai/eval/corpus';
import {
  EVAL_CHECKS,
  formatReports,
  prepareScenario,
  referenceProvider,
  runEval,
  runScenario,
  type EvalProvider,
} from '../../apps/api/src/modules/control/support-ai/eval/runner';
import {
  liveRunRefusal,
  parseEvalArgs,
} from '../../apps/api/src/modules/control/support-ai/eval/live-args';
import { SUPPORT_AI_AUTHOR_MARKERS } from '../../apps/api/src/modules/control/support-ai/domain/prompt';

/**
 * A10 — the evaluation corpus and its runner. CI runs the whole corpus against the REFERENCE
 * provider (no network, no key, no cost): every scenario must pass, which proves the corpus is
 * coherent with the production pipeline. Hostile fakes then prove the scorer catches what a bad
 * model would do — a scorer that passes everything is not a scorer.
 */

const byId = (id: string): EvalScenario => {
  const scenario = EVAL_SCENARIOS.find((s) => s.id === id);
  if (scenario === undefined) throw new Error(`no scenario ${id}`);
  return scenario;
};

/** A fake that always answers `output`, whatever the scenario. */
function answering(output: (scenario: EvalScenario) => unknown, label = 'hostile'): EvalProvider {
  return {
    label,
    paid: false,
    generate: async (_request, scenario) => ({ kind: 'OK', output: output(scenario) }),
  };
}

describe('A10 — the corpus', () => {
  it('holds 30–50 scenarios with unique ids, and covers every required category', () => {
    expect(EVAL_SCENARIOS.length).toBeGreaterThanOrEqual(30);
    expect(EVAL_SCENARIOS.length).toBeLessThanOrEqual(50);
    expect(new Set(EVAL_SCENARIOS.map((s) => s.id)).size).toBe(EVAL_SCENARIOS.length);
    for (const category of EVAL_CATEGORIES) {
      expect(
        EVAL_SCENARIOS.filter((s) => s.category === category).length,
        category,
      ).toBeGreaterThanOrEqual(3);
    }
    expect([...EVAL_CATEGORIES].sort()).toEqual(
      [
        'APP_SETUP',
        'CONNECTION',
        'GREETING',
        'KNOWN_INCIDENT',
        'LONG_TROUBLESHOOTING',
        'MONEY_REFUND',
        'PAYMENT_UNDER_REVIEW',
        'PROMPT_INJECTION',
        'REPEATED_FAILURE',
        'SCREENSHOT',
        'SOLVED_THANKS',
        'UNLINKED',
      ].sort(),
    );
  });

  it('carries no real personal data: no phone, card, e-mail, Telegram id or link', () => {
    // Every string a person wrote for the corpus: the conversations, the articles, the incident
    // notices and the reference replies (byte counts and instants are numbers, not data).
    const all = JSON.stringify([
      EVAL_SCENARIOS.map((s) => [
        s.transcript,
        s.incidents?.map((i) => i.customerMessage),
        s.reference.replyText,
        s.reference.summary,
        s.services?.map((service) => service.label),
      ]),
      EVAL_ARTICLES,
    ]);
    // Iranian mobile numbers, in Latin or Persian digits.
    expect(all).not.toMatch(/(?:\+98|0)9\d{9}/u);
    expect(all).not.toMatch(/[۰0][۹9][۰-۹]{9}/u);
    // Card numbers (16 digits, optionally grouped), e-mail addresses, links and handles.
    expect(all).not.toMatch(/\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}/u);
    expect(all).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/u);
    expect(all).not.toMatch(/https?:\/\/|vless:\/\/|vmess:\/\/|t\.me\//u);
    // Telegram ids are long digit runs.
    expect(all).not.toMatch(/\d{8,}/u);
  });

  it('every scenario is Persian conversation data with a valid, self-consistent reference', () => {
    for (const scenario of EVAL_SCENARIOS) {
      expect(supportAiDecisionSchema.safeParse(scenario.reference).success, scenario.id).toBe(true);
      expect(scenario.expect.decisions.length, scenario.id).toBeGreaterThan(0);
      for (const decision of scenario.expect.decisions)
        expect(SUPPORT_AI_DECISIONS).toContain(decision);
      for (const topic of scenario.expect.topics) expect(SUPPORT_AI_TOPICS).toContain(topic);
      expect(scenario.transcript.at(-1)?.author, scenario.id).toBe('CUSTOMER');
    }
  });
});

describe('A10 — the runner against the reference provider (what CI runs)', () => {
  it('every scenario passes every check that applies, with no network call', async () => {
    const report = await runEval(EVAL_SCENARIOS, referenceProvider());
    const failed = report.results
      .filter((r) => !r.passed)
      .map((r) => `${r.id}: ${r.failures.join('; ')}`);
    expect(failed).toEqual([]);
    expect(report.passed).toBe(EVAL_SCENARIOS.length);
    // Every check really ran somewhere.
    for (const name of EVAL_CHECKS) expect(report.byCheck[name].ran, name).toBeGreaterThan(0);
  });

  it('a fail-closed image and the money check ask no model at all', async () => {
    let calls = 0;
    const counting: EvalProvider = {
      label: 'counting',
      paid: false,
      generate: async (_r, s) => {
        calls += 1;
        return { kind: 'OK', output: s.reference };
      },
    };
    for (const id of ['screenshot-02', 'money-01', 'money-02', 'review-01']) {
      const result = await runScenario(byId(id), counting);
      expect(result.providerCalled, id).toBe(false);
      expect(result.decision, id).toBe('HANDOFF');
    }
    expect(calls).toBe(0);
  });

  it('prepares the request through the production prompt, transcript and retrieval', () => {
    const repeated = prepareScenario(byId('repeated-01'));
    expect(repeated.knowledgeTitles[0]).toBe('وصل نمی‌شود');
    expect(repeated.request.system).toContain('NON-NEGOTIABLE RULES');
    expect(repeated.request.system).toContain(EVAL_CANARY);
    // The AI's earlier step is marked as the AI's.
    expect(repeated.request.messages.map((m) => m.text).join('\n')).toContain(
      SUPPORT_AI_AUTHOR_MARKERS.AI_AUTO,
    );
    // A seen screenshot goes with the request; the long conversation is cut to the window.
    expect(
      prepareScenario(byId('screenshot-01')).request.messages.flatMap((m) => m.images ?? []),
    ).toHaveLength(1);
    const long = prepareScenario(byId('long-02'))
      .request.messages.map((m) => m.text)
      .join('\n');
    expect(long).not.toContain('پیام شماره 1\n');
    expect(long).toContain('هنوز وصل نمیشه');
    // A greeting carries no knowledge; an unlinked customer no account fact.
    expect(prepareScenario(byId('greeting-01')).knowledgeTitles).toEqual([]);
    expect(prepareScenario(byId('unlinked-01')).payload.services).toEqual([]);
  });
});

describe('A10 — the scorer catches a bad model', () => {
  it('a leak of the canary, a marker or the policy is caught', async () => {
    for (const leak of [EVAL_CANARY, SUPPORT_AI_AUTHOR_MARKERS.STAFF, 'NON-NEGOTIABLE RULES']) {
      const result = await runScenario(
        byId('connection-01'),
        answering((s) => ({ ...s.reference, replyText: `بفرمایید: ${leak}` })),
      );
      expect(result.checks.no_leak, leak).toBe(false);
      expect(result.passed).toBe(false);
    }
  });

  it('a wrong decision, a wrong topic and an invented citation are each caught', async () => {
    const wrongDecision = await runScenario(
      byId('injection-02'),
      answering(() => ({ ...byId('connection-01').reference })),
    );
    // injection-02 hands off before the model (money), so try a model-answered one.
    expect(wrongDecision.providerCalled).toBe(false);
    const greeting = byId('greeting-01');
    const asHandoff = await runScenario(
      greeting,
      answering((s) => ({ ...s.reference, decision: 'HANDOFF', replyText: '' })),
    );
    expect(asHandoff.checks.decision).toBe(false);
    expect(asHandoff.checks.guard).toBe(false);
    const wrongTopic = await runScenario(
      greeting,
      answering((s) => ({ ...s.reference, topic: 'PLAN_INFO' })),
    );
    expect(wrongTopic.checks.topic).toBe(false);
    const invented = await runScenario(
      greeting,
      answering((s) => ({ ...s.reference, factRefs: ['S9'] })),
    );
    expect(invented.checks.citations).toBe(false);
  });

  it('an automatic answer where a person must answer is caught by the guard check', async () => {
    // review-02: a payment under review; a model that happily replies is stopped by the guards,
    // and a scenario expecting SEND that the guards stop is a failure too.
    const replied = await runScenario(
      byId('review-02'),
      answering(() => ({
        ...byId('connection-01').reference,
        topic: 'SERVICE_INFO',
        factRefs: [],
        knowledgeRefs: [],
      })),
    );
    expect(replied.guardPassed).toBe(false);
    expect(replied.checks.guard).toBe(true);
    const lowConfidence = await runScenario(
      byId('connection-01'),
      answering((s) => ({ ...s.reference, confidence: 'LOW' })),
    );
    expect(lowConfidence.checks.guard).toBe(false);
  });

  it('an answer outside the decision schema fails the schema check, and a provider failure too', async () => {
    const extraKey = await runScenario(
      byId('greeting-01'),
      answering((s) => ({ ...s.reference, refund: 1 })),
    );
    expect(extraKey.checks.schema).toBe(false);
    const down: EvalProvider = {
      label: 'down',
      paid: false,
      generate: async () => ({ kind: 'FAILED', code: 'TIMEOUT' }),
    };
    const failed = await runScenario(byId('greeting-01'), down);
    expect(failed.checks.schema).toBe(false);
    expect(failed.passed).toBe(false);
  });

  it('the comparison table names each provider and every failure', async () => {
    const reports = [
      await runEval([byId('greeting-01')], referenceProvider()),
      await runEval(
        [byId('greeting-01')],
        answering((s) => ({ ...s.reference, topic: 'PLAN_INFO' }), 'model-b'),
      ),
    ];
    const table = formatReports(reports);
    expect(table).toContain('reference (fake, no network)');
    expect(table).toContain('model-b greeting-01: topic: topic PLAN_INFO');
    expect(table).not.toContain(byId('greeting-01').reference.replyText);
  });
});

describe('A10 — the retrieval check is NEXA’s own, and it can fail', () => {
  it('a missing article, a wrong first article and an excluded article are each caught', async () => {
    const base = byId('repeated-01');
    const missing = await runScenario(
      { ...base, expect: { ...base.expect, knowledge: ['مقاله‌ای که وجود ندارد'] } },
      referenceProvider(),
    );
    expect(missing.checks.retrieval).toBe(false);
    const wrongFirst = await runScenario(
      { ...base, expect: { ...base.expect, topKnowledge: 'قطع و وصل شدن' } },
      referenceProvider(),
    );
    expect(wrongFirst.checks.retrieval).toBe(false);
    const excluded = await runScenario(
      { ...base, expect: { ...base.expect, notKnowledge: ['وصل نمی‌شود'] } },
      referenceProvider(),
    );
    expect(excluded.checks.retrieval).toBe(false);
    const none = await runScenario(
      { ...byId('connection-01'), expect: { ...byId('connection-01').expect, knowledge: [] } },
      referenceProvider(),
    );
    expect(none.checks.retrieval).toBe(false);
  });
});

describe('A10 — a live run is never the default and never in CI', () => {
  const key = { SUPPORT_AI_EVAL_API_KEY: 'test-key-not-real' };
  const live = parseEvalArgs([
    '--live',
    '--provider',
    'OPENAI',
    '--model',
    'model-a',
    '--model',
    'model-b',
  ]);

  it('parses the flags; no flag is a reference-only run', () => {
    expect(parseEvalArgs([])).toMatchObject({ live: false, provider: null, models: [] });
    expect(parseEvalArgs(['--'])).toMatchObject({ live: false });
    expect(live).toMatchObject({ live: true, provider: 'OPENAI', models: ['model-a', 'model-b'] });
    expect(() => parseEvalArgs(['--provider', 'NOPE'])).toThrow();
    expect(() => parseEvalArgs(['--model'])).toThrow();
    expect(() => parseEvalArgs(['--whatever'])).toThrow();
  });

  it('every condition is required, and CI refuses outright', () => {
    expect(liveRunRefusal(parseEvalArgs([]), key)).toMatch(/not requested/u);
    expect(liveRunRefusal(live, { ...key, CI: 'true' })).toMatch(/CI/u);
    expect(liveRunRefusal(live, { ...key, CI: '1' })).toMatch(/CI/u);
    expect(liveRunRefusal(live, {})).toMatch(/SUPPORT_AI_EVAL_API_KEY/u);
    expect(liveRunRefusal(parseEvalArgs(['--live', '--model', 'm']), key)).toMatch(/--provider/u);
    expect(liveRunRefusal(parseEvalArgs(['--live', '--provider', 'ANTHROPIC']), key)).toMatch(
      /--model/u,
    );
    expect(
      liveRunRefusal(parseEvalArgs(['--live', '--provider', 'ZAI', '--model', 'm']), key),
    ).toMatch(/--region/u);
    expect(liveRunRefusal(live, key)).toBeNull();
  });

  it('the reference provider is free and the CI suite uses nothing else', () => {
    expect(referenceProvider().paid).toBe(false);
  });
});
