import { SUPPORT_AI_PROVIDERS, type SupportAiProvider } from '@nexa/contracts';
import { referenceProvider, type EvalProvider } from './runner.js';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * PR #244 (MINOR-4): any of these SET — to any value, the empty string included (an `env:`
 * override can leave `CI=`) — means CI, where a paid call is never made.
 */
export const CI_ENVIRONMENT_VARIABLES = [
  'CI',
  'GITHUB_ACTIONS',
  'BUILDKITE',
  'GITLAB_CI',
  'CONTINUOUS_INTEGRATION',
] as const;

export function isCiEnvironment(env: Env): boolean {
  return CI_ENVIRONMENT_VARIABLES.some((name) => env[name] !== undefined);
}

/** Refuses, whatever built them, a paid provider under CI. */
export function assertNoPaidProviderUnderCi(providers: readonly EvalProvider[], env: Env): void {
  if (isCiEnvironment(env) && providers.some((provider) => provider.paid)) {
    throw new Error('support-ai-eval: a paid provider under CI');
  }
}

/**
 * The providers a run uses: the reference always, and a live provider per model ONLY when
 * `liveRunRefusal` returns null — `factory` (which holds the key and builds an adapter) is never
 * called otherwise. The paid-call gate the CLI enforces, as a function a test can hold.
 */
export function evalProviders(
  args: EvalArgs,
  env: Env,
  factory: (provider: SupportAiProvider, model: string) => EvalProvider,
): { readonly providers: readonly EvalProvider[]; readonly refusal: string | null } {
  const reference = referenceProvider();
  if (!args.live) return { providers: [reference], refusal: null };
  const refusal = liveRunRefusal(args, env);
  if (refusal !== null || args.provider === null) return { providers: [reference], refusal };
  const provider = args.provider;
  const providers = [reference, ...args.models.map((model) => factory(provider, model))];
  assertNoPaidProviderUnderCi(providers, env);
  return { providers, refusal: null };
}

/**
 * A10 — the evaluation CLI's flags, and the one rule that decides whether a PAID run may start
 * (`liveRunRefusal`). Pure: the environment is passed in, so the rule is tested without a
 * process, and no provider is constructed here.
 */

export class UsageError extends Error {}

export interface EvalArgs {
  readonly live: boolean;
  readonly provider: SupportAiProvider | null;
  readonly models: readonly string[];
  readonly region: 'INTERNATIONAL' | 'CHINA' | null;
  readonly only: readonly string[];
  readonly json: string | null;
  readonly timeoutMs: number;
}

export const EVAL_USAGE =
  'usage: support-ai-eval [--live --provider OPENAI|ANTHROPIC|ZAI --model M [--model M2 ...] [--region INTERNATIONAL|CHINA]] [--only id,id] [--json report.json] [--timeout-ms N]';

export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const models: string[] = [];
  let live = false;
  let provider: SupportAiProvider | null = null;
  let region: EvalArgs['region'] = null;
  let only: string[] = [];
  let json: string | null = null;
  let timeoutMs = 60_000;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--'))
        throw new UsageError(`${String(flag)} needs a value.`);
      index += 1;
      return next;
    };
    switch (flag) {
      case '--':
        // A package manager's argument separator, passed through: not a flag.
        break;
      case '--live':
        live = true;
        break;
      case '--provider': {
        const named = value();
        if (!(SUPPORT_AI_PROVIDERS as readonly string[]).includes(named)) {
          throw new UsageError(`unknown provider ${named}`);
        }
        provider = named as SupportAiProvider;
        break;
      }
      case '--model':
        models.push(value());
        break;
      case '--region': {
        const named = value();
        if (named !== 'INTERNATIONAL' && named !== 'CHINA') throw new UsageError('bad --region');
        region = named;
        break;
      }
      case '--only':
        only = value()
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id !== '');
        break;
      case '--json':
        json = value();
        break;
      case '--timeout-ms': {
        const parsed = Number(value());
        if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 300_000) {
          throw new UsageError('--timeout-ms must be an integer from 1000 to 300000');
        }
        timeoutMs = parsed;
        break;
      }
      default:
        throw new UsageError(EVAL_USAGE);
    }
  }
  return { live, provider, models, region, only, json, timeoutMs };
}

/**
 * Whether a paid run may start. Every condition is required; the first one missing is the
 * reason it may not. `env` is passed in so the rule is testable without touching the process.
 */
export function liveRunRefusal(
  args: EvalArgs,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  if (!args.live) return 'not requested (--live)';
  if (isCiEnvironment(env)) return 'refused under CI: a live run is a paid call';
  if (args.provider === null) return '--provider is required with --live';
  if (args.models.length === 0) return 'at least one --model is required with --live';
  if ((env.SUPPORT_AI_EVAL_API_KEY ?? '') === '') {
    return 'SUPPORT_AI_EVAL_API_KEY (a TEST key) is required with --live';
  }
  if (args.provider === 'ZAI' && args.region === null) return '--region is required for ZAI';
  return null;
}
