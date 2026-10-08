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
  REFERENCE_CAPABILITIES,
  formatReports,
  normaliseForLeak,
  prepareScenario,
  referenceProvider,
  runEval,
  runScenario,
  type EvalProvider,
} from '../../apps/api/src/modules/control/support-ai/eval/runner';
import {
  assertNoPaidProviderUnderCi,
  evalProviders,
  isCiEnvironment,
  liveRunRefusal,
  parseEvalArgs,
} from '../../apps/api/src/modules/control/support-ai/eval/live-args';
import { autoImageGuard } from '../../apps/api/src/modules/control/support-ai/domain/auto-reply-guards';
import { SUPPORT_AI_AUTHOR_MARKERS } from '../../apps/api/src/modules/control/support-ai/domain/prompt';
import { foldForMatching } from '../../apps/api/src/modules/commerce/support-context/domain/knowledge-relevance';

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
    capabilities: REFERENCE_CAPABILITIES,
    generate: async (_request, scenario) => ({ kind: 'OK', output: output(scenario) }),
  };
}

/** Byte counts, money in minor units and instants are numbers, not personal data. */
const NUMERIC_FIELDS = new Set([
  'trafficLimitBytes',
  'trafficUsedBytes',
  'remainingTrafficBytes',
  'amountMinor',
  'expiresAt',
  'usageSyncedAt',
  'createdAt',
  'confirmedAt',
  'startedAt',
  'scheduledEndAt',
]);
function stripNumericFields(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, field: unknown) => (NUMERIC_FIELDS.has(key) ? undefined : field)),
  );
}
/** Every field of the corpus and its articles, as one text. */
function corpusText(): string {
  return JSON.stringify(stripNumericFields([EVAL_SCENARIOS, EVAL_ARTICLES]));
}
/** The handles a fixture may name: the demo support account. */
const ALLOWED_HANDLES = new Set(['@nexa_support_demo']);
/**
 * Personal-data shapes in `text`: digits folded to ASCII first (Persian and Arabic-Indic), and
 * spaces or dashes between digits removed, so «۰۹۱۲ ۳۴۵ ۶۷۸۹» is a phone like 09123456789.
 */
function piiFindings(text: string): string[] {
  const folded = foldForMatching(text).replace(/(?<=\d)[\s\-\u2010-\u2015]+(?=\d)/gu, '');
  const patterns: readonly RegExp[] = [
    /(?:\+98|0098|(?<!\d)0)9\d{9}/gu, // an Iranian mobile
    /\d{8,}/gu, // a card number, a national id, a Telegram id
    /[\w.+-]+@[\w-]+\.[a-z]{2,}/gu, // an e-mail address
    /https?:\/\/|vless:\/\/|vmess:\/\/|trojan:\/\/|ss:\/\/|t\.me\//gu, // a link
  ];
  const findings = patterns.flatMap((pattern) => [...folded.matchAll(pattern)].map((m) => m[0]));
  const handles = [...text.matchAll(/(?<![\w.])@[A-Za-z][A-Za-z0-9_]{4,}/gu)]
    .map((m) => m[0])
    .filter((handle) => !ALLOWED_HANDLES.has(handle));
  return [...findings, ...handles];
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

  it('carries no real personal data: no phone, card, e-mail, id, handle or link, in any field', () => {
    expect(piiFindings(corpusText())).toEqual([]);
  });

  /*
   * PR #244, MINOR-3: a guard with no planted positive is a rule with no test. Each probe below
   * is a shape the first version let through (Persian digits, +۹۸, spaced numbers, a handle).
   */
  it.each([
    ['a Persian-digit card number', '۶۰۳۷۹۹۷۱۲۳۴۵۶۷۸۹'],
    ['a +۹۸ phone', '+۹۸۹۱۲۳۴۵۶۷۸۹'],
    ['an Arabic-Indic phone', '٠٩١٢٣٤٥٦٧٨٩'],
    ['a Persian-digit long id', '۱۲۳۴۵۶۷۸۹۰'],
    ['a spaced phone', '0912 345 6789'],
    ['a dashed card number', '6037-9971-2345-6789'],
    ['a Telegram handle', 'پیام بدید به @ali_rezaei_92'],
    ['an e-mail address', 'user.name@example.org'],
    ['a link', 'https://example.org/x'],
    ['a subscription link', 'vless://abc'],
  ])('the guard fires on %s', (_label, probe) => {
    expect(piiFindings(`${corpusText()} ${probe}`).length).toBeGreaterThan(0);
  });

  it('the guard scans every text field: intent, prior, payments, about and mustNotSay included', () => {
    const planted = (over: Partial<EvalScenario>) =>
      piiFindings(JSON.stringify(stripNumericFields([{ ...EVAL_SCENARIOS[0]!, ...over }])));
    const base = EVAL_SCENARIOS[0]!;
    expect(planted({ about: '0912 345 6789' })).not.toEqual([]);
    expect(planted({ reference: { ...base.reference, intent: '@ali_rezaei_92' } })).not.toEqual([]);
    expect(
      planted({
        prior: [{ decision: 'REPLY', topic: null, intent: '۰۹۱۲۳۴۵۶۷۸۹', knowledgeLabels: [] }],
      }),
    ).not.toEqual([]);
    expect(planted({ expect: { ...base.expect, mustNotSay: ['۶۰۳۷۹۹۷۱۲۳۴۵۶۷۸۹'] } })).not.toEqual(
      [],
    );
    // The allowlisted demo handle is not a finding.
    expect(piiFindings('@nexa_support_demo')).toEqual([]);
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
      capabilities: REFERENCE_CAPABILITIES,
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

  it('roadmap A3: the production progress guards hand off before the model, and repeated advice is caught', async () => {
    const base = byId('repeated-01');
    const [customer, step] = base.transcript;
    const said = (text: string) => ({ ...customer!, text });
    const advised = (text: string) => ({ ...step!, text });
    const looping = {
      ...base,
      transcript: [
        said('سلام، سرویس روی آیفون وصل نمیشه'),
        advised('لطفاً برنامه را کامل ببندید و دوباره باز کنید.'),
        said('نشد'),
        advised('از تنظیمات برنامه، پروتکل را روی TCP بگذارید.'),
        said('هنوز وصل نمیشه'),
        advised('لینک اشتراک را از ربات دوباره دریافت کنید.'),
        said('بازم همونه'),
      ],
    };
    expect(prepareScenario(looping).progressHandoff).toBe(true);
    expect(prepareScenario(base).progressHandoff).toBe(false);
    let calls = 0;
    const counting: EvalProvider = {
      label: 'counting',
      paid: false,
      capabilities: REFERENCE_CAPABILITIES,
      generate: async (_r, sc) => {
        calls += 1;
        return { kind: 'OK', output: sc.reference };
      },
    };
    const result = await runScenario(looping, counting);
    expect(result.providerCalled).toBe(false);
    expect(calls).toBe(0);
    // The model repeating the step the customer already had does not pass the guard.
    const repeating = {
      ...base,
      reference: { ...base.reference, replyText: 'لطفاً برنامه را کامل ببندید و دوباره باز کنید.' },
    };
    expect((await runScenario(repeating, counting)).guardPassed).toBe(false);
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
      capabilities: REFERENCE_CAPABILITIES,
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

describe('PR #244 — the eval runs production vision, guards and normalisation', () => {
  const blind: EvalProvider = {
    label: 'blind',
    paid: false,
    capabilities: { structuredOutput: true, vision: false, maxImageBytes: 0, imageMediaTypes: [] },
    generate: async () => {
      throw new Error('a blind step must never be called with a screenshot to answer');
    },
  };

  it('CX3/MINOR-2: a blind adapter is never given an image; a latest screenshot fails closed', async () => {
    for (const id of ['screenshot-01', 'screenshot-04', 'injection-04']) {
      const prepared = prepareScenario(byId(id), blind.capabilities);
      expect(prepared.failClosed, id).toBe(true);
      expect(
        prepared.request.messages.flatMap((m) => m.images ?? []),
        id,
      ).toEqual([]);
    }
    const result = await runScenario(byId('screenshot-01'), blind);
    expect(result.providerCalled).toBe(false);
    expect(result.decision).toBe('HANDOFF');
    // An earlier image and a later text still reach a blind step, the image marked unseen.
    expect(prepareScenario(byId('screenshot-03'), blind.capabilities).failClosed).toBe(false);
  });

  it('MINOR-2: the per-adapter fit decides too — a type the step does not take fails closed', () => {
    const jpegOnly = { ...REFERENCE_CAPABILITIES, imageMediaTypes: ['image/jpeg'] };
    expect(prepareScenario(byId('screenshot-01'), jpegOnly).failClosed).toBe(true);
    expect(prepareScenario(byId('screenshot-01')).failClosed).toBe(false);
  });

  it('MINOR-2: an unseen latest image fails closed through autoImageGuard, whatever the step', () => {
    // screenshot-02's latest photo was never loaded: the production guard decides it.
    expect(prepareScenario(byId('screenshot-02')).failClosed).toBe(true);
    expect(autoImageGuard({ required: ['L2'], loaded: new Set<string>() }).pass).toBe(false);
  });

  it('CX5: the clarifying limit is evaluated from the scenario’s earlier decisions', async () => {
    const ask = byId('greeting-03');
    const asked = {
      decision: 'ASK_CLARIFYING_QUESTION' as const,
      topic: 'GREETING' as const,
      intent: null,
      knowledgeLabels: [],
    };
    const fresh = await runScenario(ask, referenceProvider());
    expect(fresh.guardPassed).toBe(true);
    const third = await runScenario(
      { ...ask, prior: [asked, asked], expect: { ...ask.expect, guard: 'HANDOFF' } },
      referenceProvider(),
    );
    expect(third.guardPassed).toBe(false);
    expect(third.checks.guard).toBe(true);
  });

  it('CX4: a leak in another case, Unicode form, spacing or with a ZWNJ is still a leak', async () => {
    const zwnj = String.fromCharCode(0x200c);
    for (const leak of [
      EVAL_CANARY.toLowerCase(),
      'ＮＸＣＡＮＡＲＹ７Ｑ４Ｚ',
      '[support  staff (a person)\nwrote]',
      `NEXA${zwnj} FACTS`,
    ]) {
      const result = await runScenario(
        byId('connection-01'),
        answering((sc) => ({ ...sc.reference, replyText: `بفرمایید ${leak}` })),
      );
      expect(result.checks.no_leak, leak).toBe(false);
    }
    expect(normaliseForLeak(`A${zwnj}B  C`)).toBe('ab c');
  });
});

describe('PR #244 MINOR-4 — the paid-call gate', () => {
  const key = { SUPPORT_AI_EVAL_API_KEY: 'test-key-not-real' };
  const live = parseEvalArgs(['--live', '--provider', 'OPENAI', '--model', 'a', '--model', 'b']);
  const never = () => {
    throw new Error('the factory (which holds the key) must not run');
  };
  const paid = (provider: string, model: string): EvalProvider => ({
    label: `${provider} ${model}`,
    paid: true,
    capabilities: REFERENCE_CAPABILITIES,
    generate: async () => ({ kind: 'FAILED', code: 'never called' }),
  });

  it.each([
    ['CI=true', { CI: 'true' }],
    ['CI set to the empty string', { CI: '' }],
    ['GITHUB_ACTIONS', { GITHUB_ACTIONS: '' }],
    ['BUILDKITE', { BUILDKITE: 'true' }],
  ])('%s: no paid provider is built, the factory never runs', (_label, ci) => {
    const { providers, refusal } = evalProviders(live, { ...key, ...ci }, never);
    expect(refusal).toMatch(/CI/u);
    expect(providers.map((p) => p.paid)).toEqual([false]);
  });

  it('without --live only the reference runs, whatever the environment', () => {
    expect(evalProviders(parseEvalArgs([]), key, never).providers.map((p) => p.paid)).toEqual([
      false,
    ]);
  });

  it('outside CI, with every condition met, one paid provider per model', () => {
    const { providers, refusal } = evalProviders(live, key, paid);
    expect(refusal).toBeNull();
    expect(providers.map((p) => [p.label, p.paid])).toEqual([
      ['reference (fake, no network)', false],
      ['OPENAI a', true],
      ['OPENAI b', true],
    ]);
  });

  it('a paid provider under CI is refused, however it was built', () => {
    expect(() => assertNoPaidProviderUnderCi([paid('OPENAI', 'x')], { CI: '' })).toThrow();
    expect(() => assertNoPaidProviderUnderCi([referenceProvider()], { CI: 'true' })).not.toThrow();
    expect(isCiEnvironment({})).toBe(false);
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
