import { writeFileSync } from 'node:fs';
import type { SupportAiProvider } from '@nexa/contracts';
import { AnthropicAdapter } from './infrastructure/ai/anthropic-adapter.js';
import { OpenAiAdapter } from './infrastructure/ai/openai-adapter.js';
import { ZaiAdapter } from './infrastructure/ai/zai-adapter.js';
import type {
  SupportAiAdapter,
  SupportAiCredential,
} from './modules/control/support-ai/application/ports.js';
import { EVAL_SCENARIOS } from './modules/control/support-ai/eval/corpus.js';
import {
  EVAL_USAGE,
  UsageError,
  liveRunRefusal,
  parseEvalArgs,
} from './modules/control/support-ai/eval/live-args.js';
import {
  formatReports,
  referenceProvider,
  runEval,
  type EvalProvider,
  type EvalReport,
} from './modules/control/support-ai/eval/runner.js';

/**
 * `support-ai-eval` — the support AI's evaluation corpus, scored (A10,
 * `docs/support-agent/sai-eval.md`).
 *
 * By default it runs the corpus against the REFERENCE provider: no network, no key, no cost.
 * That is what CI runs (through the unit suite) and what this command does with no flags.
 *
 * `--live` compares real models. It needs, all at once: the flag, a provider, at least one
 * model, a TEST key in `SUPPORT_AI_EVAL_API_KEY`, and NOT being in CI (`CI` set to anything
 * refuses it). It never reads a tenant's stored key, never touches the database, never sends
 * anything to a customer, and never changes the production model: it only reports. The key is
 * read from the environment for the duration of the run and never printed or written.
 */

function adapterFor(provider: SupportAiProvider): SupportAiAdapter {
  switch (provider) {
    case 'OPENAI':
      return new OpenAiAdapter();
    case 'ANTHROPIC':
      return new AnthropicAdapter();
    case 'ZAI':
      return new ZaiAdapter();
  }
}

/** A real adapter as an eval provider. Built only after `liveRunRefusal` returned null. */
function adapterProvider(
  adapter: SupportAiAdapter,
  credential: SupportAiCredential,
  model: string,
  timeoutMs: number,
): EvalProvider {
  return {
    label: `${adapter.provider} ${model}`,
    paid: true,
    generate: async (request) => {
      const outcome = await adapter.generate(credential, { ...request, model, timeoutMs });
      return outcome.outcome === 'OK'
        ? {
            kind: 'OK',
            output: outcome.output,
            inputTokens: outcome.usage.inputTokens,
            outputTokens: outcome.usage.outputTokens,
          }
        : { kind: 'FAILED', code: 'code' in outcome ? outcome.code : outcome.outcome };
    },
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseEvalArgs(argv);
  const scenarios =
    args.only.length === 0
      ? EVAL_SCENARIOS
      : EVAL_SCENARIOS.filter((s) => args.only.includes(s.id));
  if (scenarios.length === 0) throw new UsageError('--only matched no scenario');
  const providers: EvalProvider[] = [referenceProvider()];
  if (args.live) {
    const refusal = liveRunRefusal(args, process.env);
    if (refusal !== null) {
      process.stderr.write(`support-ai-eval: live run refused: ${refusal}\n`);
      return 2;
    }
    const provider = args.provider as SupportAiProvider;
    const credential: SupportAiCredential = {
      apiKey: process.env.SUPPORT_AI_EVAL_API_KEY ?? '',
      region: provider === 'ZAI' ? args.region : null,
    };
    process.stderr.write(
      `support-ai-eval: LIVE run against ${provider}, ${String(args.models.length)} model(s) × ${String(scenarios.length)} scenario(s): this is a paid call.\n`,
    );
    for (const model of args.models) {
      providers.push(adapterProvider(adapterFor(provider), credential, model, args.timeoutMs));
    }
  }
  const reports: EvalReport[] = [];
  for (const provider of providers) reports.push(await runEval(scenarios, provider));
  process.stdout.write(`${formatReports(reports)}\n`);
  if (args.json !== null) writeFileSync(args.json, `${JSON.stringify(reports, null, 2)}\n`);
  // The reference must pass in full: if it does not, the corpus or the pipeline is broken.
  return reports[0]?.passed === reports[0]?.scenarios ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `support-ai-eval: ${error instanceof UsageError ? error.message : 'failed'}\n${error instanceof UsageError ? `${EVAL_USAGE}\n` : ''}`,
    );
    process.exitCode = 2;
  },
);
