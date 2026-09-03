import { NexaError, PLATFORM_ERROR_CODES } from '@nexa/contracts';
import { configSchema, type AppConfig } from './config.schema.js';
import { parseKeyring, type KeyringInput } from '../crypto/keyring.js';

/**
 * Loads and validates configuration. Reports every problem at once.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (parsed.success) return parsed.data;

  const problems = parsed.error.issues.map((issue) => {
    const key = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  ${key}: ${issue.message}`;
  });

  // Zod skips an object's refinements once any FIELD has failed, so the
  // schema's keyring check does not run on a config that is also missing, say,
  // DATABASE_URL. Without this an operator starting from an empty file would
  // fix the database and Redis, restart, and only then be told the keyring was
  // never configured — which is the second restart this function exists to
  // prevent. Same parser, so there is still one implementation of the rule; it
  // is called here only because the schema's own call was skipped.
  const keyring = parseKeyring(env as KeyringInput);
  if (!keyring.ok) {
    for (const problem of keyring.problems) problems.push(`  SECRETS_KEYS: ${problem}`);
  }

  throw new NexaError({
    kind: 'CONFIGURATION',
    code: PLATFORM_ERROR_CODES.CONFIG_INVALID,
    message: `Invalid configuration (${problems.length} problem${
      problems.length === 1 ? '' : 's'
    }):\n${problems.join('\n')}`,
    details: { problems },
  });
}

/** The token used to inject configuration through Nest's DI container. */
export const APP_CONFIG = Symbol('APP_CONFIG');
