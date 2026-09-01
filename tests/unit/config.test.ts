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
  // The default topology is `reverse-proxy`, which requires a trusted upstream.
  TRUSTED_PROXY_IPS: '127.0.0.1,::1',
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

  it('defaults to real password authentication', () => {
    // Phase 1 ships username and password. `none` survives only as a
    // development escape hatch and is no longer what an unset variable means.
    expect(loadConfig(valid).AUTH_MODE).toBe('password');
  });

  it('refuses to boot without authentication outside development', () => {
    // A stub login gets copied into the next phase; a hard failure does not.
    expect(() =>
      loadConfig({
        ...valid,
        NODE_ENV: 'production',
        AUTH_MODE: 'none',
        WEB_ADMIN_ORIGINS: 'https://admin.example.test',
      }),
    ).toThrowError(/AUTH_MODE/);
  });

  it('refuses the fast password hash profile in production', () => {
    // It reduces the scrypt work factor by more than two orders of magnitude.
    // Inferring the profile from NODE_ENV would let an install left on
    // `development` store every password at that strength without saying so.
    expect(() =>
      loadConfig({
        ...valid,
        NODE_ENV: 'production',
        PASSWORD_HASH_PROFILE: 'fast',
        WEB_ADMIN_ORIGINS: 'https://admin.example.test',
      }),
    ).toThrowError(/PASSWORD_HASH_PROFILE/);
  });

  it('requires an admin origin in production', () => {
    // The Origin check is the half of the CSRF defence that does not depend on
    // the browser honouring SameSite.
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production' })).toThrowError(
      /WEB_ADMIN_ORIGINS/,
    );
  });

  it('parses the admin origin list', () => {
    const config = loadConfig({
      ...valid,
      WEB_ADMIN_ORIGINS: 'https://a.example.test, https://b.example.test ,',
    });
    expect(config.WEB_ADMIN_ORIGINS).toEqual(['https://a.example.test', 'https://b.example.test']);
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

describe('deployment topology and trusted proxies', () => {
  it('requires a trusted upstream behind a reverse proxy', () => {
    // Left empty, every request appears to come from the proxy — so one failed
    // login burst would lock out every administrator at once. Nothing at
    // runtime can distinguish that from a real client at the proxy's address,
    // which is why it is a configuration error rather than a detection.
    expect(() =>
      loadConfig({ ...valid, DEPLOYMENT_TOPOLOGY: 'reverse-proxy', TRUSTED_PROXY_IPS: '' }),
    ).toThrowError(/TRUSTED_PROXY_IPS/);
  });

  it('supports a genuine direct deployment, explicitly', () => {
    // Modelled rather than inferred: an empty list is correct for this topology
    // and a serious misconfiguration for the other.
    const config = loadConfig({
      ...valid,
      DEPLOYMENT_TOPOLOGY: 'direct',
      TRUSTED_PROXY_IPS: '',
    });
    expect(config.TRUSTED_PROXY_IPS).toEqual([]);
  });

  it('refuses trusted upstreams in a direct deployment', () => {
    expect(() =>
      loadConfig({ ...valid, DEPLOYMENT_TOPOLOGY: 'direct', TRUSTED_PROXY_IPS: '127.0.0.1' }),
    ).toThrowError(/TRUSTED_PROXY_IPS/);
  });

  it('rejects a malformed address or CIDR clearly', () => {
    // A typo that silently voids the trusted set is the lockout above; one that
    // silently widens it trusts an upstream nobody chose.
    for (const entry of ['not-an-ip', '10.0.0.0/', '10.0.0.0/33', '10.0.0.0/abc', '1.2.3']) {
      expect(() => loadConfig({ ...valid, TRUSTED_PROXY_IPS: entry })).toThrowError(
        /TRUSTED_PROXY_IPS/,
      );
    }
  });

  it('rejects a /0 prefix, which is trustProxy=true spelled differently', () => {
    expect(() => loadConfig({ ...valid, TRUSTED_PROXY_IPS: '0.0.0.0/0' })).toThrowError(
      /TRUSTED_PROXY_IPS/,
    );
    expect(() => loadConfig({ ...valid, TRUSTED_PROXY_IPS: '::/0' })).toThrowError(
      /TRUSTED_PROXY_IPS/,
    );
  });

  it('accepts the shapes an operator actually writes', () => {
    const config = loadConfig({ ...valid, TRUSTED_PROXY_IPS: '127.0.0.1, ::1, 10.0.0.0/8' });
    expect(config.TRUSTED_PROXY_IPS).toEqual(['127.0.0.1', '::1', '10.0.0.0/8']);
  });
});
