import { describe, expect, it } from 'vitest';
import { isNexaError } from '@nexa/contracts';
import { loadConfig } from '../../apps/api/src/infrastructure/config/load-config';

const KEK = Buffer.alloc(32, 7).toString('base64');

const valid = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  SECRETS_KEK: KEK,
  SECRETS_KEK_ID: 'dev-1',
} satisfies NodeJS.ProcessEnv;

describe('configuration', () => {
  it('accepts a complete environment and applies defaults', () => {
    const config = loadConfig(valid);
    expect(config.API_PORT).toBe(3000);
    expect(config.TELEGRAM_WEBHOOK_ENABLED).toBe(false);
    expect(config.OUTBOX_RELAY_ENABLED).toBe(true);
  });

  it('reports every problem at once, not just the first', () => {
    // A misconfigured deployment should be diagnosed in one pass, not four restarts.
    let caught: unknown;
    try {
      loadConfig({ NODE_ENV: 'development' });
    } catch (error) {
      caught = error;
    }
    expect(isNexaError(caught)).toBe(true);
    const problems = (caught as { details: { problems: string[] } }).details.problems;
    expect(problems.length).toBeGreaterThanOrEqual(4);
    expect(problems.join('\n')).toContain('DATABASE_URL');
    expect(problems.join('\n')).toContain('REDIS_URL');
    expect(problems.join('\n')).toContain('SECRETS_KEK');
  });

  it('refuses to boot without authentication outside development', () => {
    // A stub login gets copied into the next phase; a hard failure does not.
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production' })).toThrowError(/AUTH_MODE/);
  });

  it('refuses a weak Telegram webhook secret when the webhook is enabled', () => {
    expect(() =>
      loadConfig({ ...valid, TELEGRAM_WEBHOOK_ENABLED: 'true', TELEGRAM_WEBHOOK_SECRET: 'short' }),
    ).toThrowError(/TELEGRAM_WEBHOOK_SECRET/);
  });

  it('rejects a key-encryption key that is not 32 bytes', () => {
    expect(() => loadConfig({ ...valid, SECRETS_KEK: 'dG9vLXNob3J0' })).toThrowError(/SECRETS_KEK/);
  });
});
