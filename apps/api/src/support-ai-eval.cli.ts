import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import type { SupportAiProvider, TenantContext, TenantId } from '@nexa/contracts';
import { createDatabase } from './infrastructure/persistence/database.js';
import { tenants } from './infrastructure/persistence/schema.js';
import { DrizzleSupportAiConfigRepository } from './modules/control/support-ai/infrastructure/drizzle-support-ai.repository.js';
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
  assertNoPaidProviderUnderCi,
  evalProviders,
  parseEvalArgs,
} from './modules/control/support-ai/eval/live-args.js';
import {
  ReplayError,
  formatReplay,
  isInsideRepository,
  parseReplayFile,
  replayChats,
} from './modules/control/support-ai/eval/sai-replay.js';
import {
  formatSaiSummary,
  recommendedConfig,
  runSaiLive,
  runSaiOffline,
  storedConfig,
  type SaiConfigChoice,
  type SaiReport,
} from './modules/control/support-ai/eval/sai-runner.js';
import {
  formatReports,
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
    capabilities: adapter.capabilities,
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

/** The repository root: the directory holding `pnpm-workspace.yaml`, found upward from here. */
function repositoryRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    try {
      readFileSync(resolve(dir, 'pnpm-workspace.yaml'));
      return dir;
    } catch {
      dir = resolve(dir, '..');
    }
  }
  return process.cwd();
}

/**
 * `--config-from-db <slug>`: the tenant's stored support-AI configuration, READ-ONLY. One
 * `READ ONLY` transaction, one SELECT through the production repository; no credential, no
 * conversation and no customer row is read, and nothing is written.
 */
async function readStoredConfig(slug: string) {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (databaseUrl === '') throw new UsageError('--config-from-db needs DATABASE_URL');
  const handle = createDatabase(databaseUrl, 1);
  try {
    return await handle.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      const [tenant] = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .limit(1);
      if (tenant === undefined) throw new UsageError('no such tenant');
      const scope: TenantContext = { tenantId: tenant.id as TenantId, botInstanceId: null };
      return new DrizzleSupportAiConfigRepository(handle.db).get(scope, tx);
    });
  } finally {
    await handle.close();
  }
}

async function configChoice(args: ReturnType<typeof parseEvalArgs>): Promise<SaiConfigChoice> {
  if (args.configFromDb === null) return recommendedConfig();
  const stored = await readStoredConfig(args.configFromDb);
  return storedConfig(
    stored.config,
    `stored config of ${args.configFromDb} (v${String(stored.version)})`,
    args.preset,
  );
}

/** The SAI suite: offline always; with `--live`, each paid model too. Exit 1 on a broken target. */
async function runSai(
  args: ReturnType<typeof parseEvalArgs>,
  providers: readonly EvalProvider[],
): Promise<{ readonly code: number; readonly reports: SaiReport[] }> {
  const config = await configChoice(args);
  const reports: SaiReport[] = [await runSaiOffline(config, { only: args.only })];
  for (const provider of providers.filter((p) => p.paid)) {
    reports.push(await runSaiLive(provider, config, args.only));
  }
  for (const report of reports) process.stdout.write(`${formatSaiSummary(report)}\n\n`);
  // The OFFLINE run is the safety net: the pipeline must hold the hard set and every attack.
  const offline = reports[0];
  const broken =
    offline === undefined ||
    offline.hard.failures.length > 0 ||
    offline.attacks.failures.length > 0 ||
    offline.attacks.leaks + offline.attacks.promises + offline.attacks.toolEscapes > 0;
  return { code: broken ? 1 : 0, reports };
}

async function runReplay(
  args: ReturnType<typeof parseEvalArgs>,
  providers: readonly EvalProvider[],
): Promise<number> {
  const file = resolve(args.replay ?? '');
  const root = repositoryRoot();
  if (
    isInsideRepository(file, root) ||
    (args.json !== null && isInsideRepository(resolve(args.json), root))
  ) {
    throw new UsageError('the replay file and its report must live outside the repository');
  }
  const chats = parseReplayFile(readFileSync(file, 'utf8'));
  const config = await configChoice(args);
  const live = providers.find((p) => p.paid) ?? null;
  const report = await replayChats(chats, config, live);
  process.stdout.write(`${formatReplay(report, config.label)}\n`);
  if (args.json !== null) writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseEvalArgs(argv);
  const scenarios =
    args.suite === 'sai'
      ? []
      : args.only.length === 0
        ? EVAL_SCENARIOS
        : EVAL_SCENARIOS.filter((s) => args.only.includes(s.id));
  if (scenarios.length === 0 && args.suite === 'classic') {
    throw new UsageError('--only matched no scenario');
  }
  // The paid-call gate (`evalProviders`): the factory, which reads the key, runs only when
  // `liveRunRefusal` allowed the run; and no paid provider is ever run under CI.
  const { providers, refusal } = evalProviders(args, process.env, (provider, model) =>
    adapterProvider(
      adapterFor(provider),
      {
        apiKey: process.env.SUPPORT_AI_EVAL_API_KEY ?? '',
        region: provider === 'ZAI' ? args.region : null,
      },
      model,
      args.timeoutMs,
    ),
  );
  if (refusal !== null) {
    process.stderr.write(`support-ai-eval: live run refused: ${refusal}\n`);
    return 2;
  }
  assertNoPaidProviderUnderCi(providers, process.env);
  if (providers.some((provider) => provider.paid)) {
    process.stderr.write(
      `support-ai-eval: LIVE run, ${String(providers.length - 1)} model(s) × ${String(scenarios.length)} scenario(s): this is a paid call.\n`,
    );
  }
  if (args.replay !== null) return runReplay(args, providers);
  const reports: EvalReport[] = [];
  if (args.suite !== 'sai') {
    for (const provider of providers) reports.push(await runEval(scenarios, provider));
    process.stdout.write(`${formatReports(reports)}\n\n`);
  }
  let sai: { code: number; reports: SaiReport[] } = { code: 0, reports: [] };
  if (args.suite !== 'classic') sai = await runSai(args, providers);
  if (args.json !== null) {
    writeFileSync(
      args.json,
      `${JSON.stringify({ classic: reports, sai: sai.reports }, null, 2)}\n`,
    );
  }
  // The reference must pass in full: if it does not, the corpus or the pipeline is broken.
  const classicOk = reports.length === 0 || reports[0]?.passed === reports[0]?.scenarios;
  return classicOk && sai.code === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `support-ai-eval: ${error instanceof UsageError || error instanceof ReplayError ? error.message : 'failed'}\n${error instanceof UsageError ? `${EVAL_USAGE}\n` : ''}`,
    );
    process.exitCode = 2;
  },
);
