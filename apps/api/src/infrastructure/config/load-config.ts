import { NexaError, PLATFORM_ERROR_CODES } from '@nexa/contracts';
import { configSchema, type AppConfig } from './config.schema.js';

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
