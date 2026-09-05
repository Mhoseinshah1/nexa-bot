import { describe, expect, it } from 'vitest';
import { isNexaError } from '@nexa/contracts';
import { loadConfig } from '../../apps/api/src/infrastructure/config/load-config';
import {
  effectiveFreshPanelUpperBound,
  schedulerFreshPanelUpperBound,
  tenantBudgetFreshPanelUpperBound,
  worstCaseLatencyFreshPanelUpperBound,
} from '../../apps/api/src/modules/platform/panels/domain/monitor-cadence';

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

  describe('the Telegram API base URL', () => {
    // A bot token is part of the PATH of every Telegram call, so an http://
    // base publishes the credential on the wire with each send.
    const production = {
      ...valid,
      NODE_ENV: 'production',
      WEB_ADMIN_ORIGINS: 'https://admin.example.com',
      SESSION_COOKIE_SECURE: 'true',
    };

    it('refuses an insecure base URL in production', () => {
      expect(() =>
        loadConfig({ ...production, TELEGRAM_API_BASE_URL: 'http://api.telegram.org' }),
      ).toThrowError(/TELEGRAM_API_BASE_URL must use https/);
    });

    it('is not fooled by a URL that merely contains https', () => {
      // An `includes('https')` accepts this. The check parses the URL and
      // reads its protocol instead.
      expect(() =>
        loadConfig({
          ...production,
          TELEGRAM_API_BASE_URL: 'http://evil.example.com/?x=https://api.telegram.org',
        }),
      ).toThrowError(/TELEGRAM_API_BASE_URL must use https/);
    });

    it('accepts an uppercase scheme, which is the same scheme', () => {
      // And stores it as given: a `startsWith('https')` would reject this, and
      // a normaliser would quietly change what the operator configured.
      const config = loadConfig({
        ...production,
        TELEGRAM_API_BASE_URL: 'HTTPS://api.telegram.org',
      });
      expect(config.TELEGRAM_API_BASE_URL).toBe('HTTPS://api.telegram.org');
    });

    it('does not rewrite an accepted URL', () => {
      // A rewrite can only be observed on a value that is ACCEPTED — the
      // rejected case above proves refusal, not preservation. Silently
      // upgrading an insecure URL would hide that somebody had configured one,
      // which is exactly what is worth knowing about a deployment.
      const config = loadConfig({
        ...production,
        TELEGRAM_API_BASE_URL: 'https://api.telegram.org/bot/',
      });
      expect(config.TELEGRAM_API_BASE_URL).toBe('https://api.telegram.org/bot/');
    });

    it('still allows a local http stub outside production', () => {
      const config = loadConfig({ ...valid, TELEGRAM_API_BASE_URL: 'http://127.0.0.1:8081' });
      expect(config.TELEGRAM_API_BASE_URL).toBe('http://127.0.0.1:8081');
    });
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
    // Reported ALONGSIDE the others rather than after they are fixed. Zod
    // skips an object refinement once a field has failed, so this is the case
    // that regressed silently when the single KEK became an optional keyring.
    expect(problems.join('\n')).toContain('SECRETS_KEYS');
    expect(problems.join('\n')).toContain('no secret keys are configured');
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

  it('refuses a plain-HTTP admin origin in production', () => {
    // Not a style rule. Production issues the session as a `Secure` `__Host-`
    // cookie, which a browser will not store from an insecure origin — so an
    // `http://` origin boots, passes the Origin check, logs in successfully and
    // authenticates nothing, with no error anywhere to point at. HSTS cannot
    // repair the first response, because a browser ignores HSTS over HTTP.
    expect(() =>
      loadConfig({
        ...valid,
        NODE_ENV: 'production',
        PASSWORD_HASH_PROFILE: 'production',
        WEB_ADMIN_ORIGINS: 'http://admin.example.test',
      }),
    ).toThrowError(/https/i);

    // One bad entry in a list is still a bad configuration.
    expect(() =>
      loadConfig({
        ...valid,
        NODE_ENV: 'production',
        PASSWORD_HASH_PROFILE: 'production',
        WEB_ADMIN_ORIGINS: 'https://good.example.test,http://bad.example.test',
      }),
    ).toThrowError(/bad\.example\.test/);

    // And an https origin boots.
    expect(() =>
      loadConfig({
        ...valid,
        NODE_ENV: 'production',
        PASSWORD_HASH_PROFILE: 'production',
        WEB_ADMIN_ORIGINS: 'https://admin.example.test',
      }),
    ).not.toThrow();
  });

  it('refuses the direct topology in production, because the API serves plain HTTP', () => {
    // `direct` means nothing sits in front of this process, and this process
    // calls the plain-HTTP `app.listen` with no TLS configuration. Production
    // nevertheless always issues a Secure `__Host-` cookie, which a browser
    // refuses to store over HTTP — so every login would appear to succeed and
    // authenticate nothing, with no error to point at. Validating that the
    // ORIGIN is https does not put TLS on the transport.
    expect(() =>
      loadConfig({
        ...valid,
        NODE_ENV: 'production',
        PASSWORD_HASH_PROFILE: 'production',
        WEB_ADMIN_ORIGINS: 'https://admin.example.test',
        DEPLOYMENT_TOPOLOGY: 'direct',
        TRUSTED_PROXY_IPS: '',
      }),
    ).toThrowError(/DEPLOYMENT_TOPOLOGY/);

    // Behind a declared proxy it boots, which is the supported shape.
    expect(() =>
      loadConfig({
        ...valid,
        NODE_ENV: 'production',
        PASSWORD_HASH_PROFILE: 'production',
        WEB_ADMIN_ORIGINS: 'https://admin.example.test',
      }),
    ).not.toThrow();

    // And `direct` remains legal outside production, where the suite uses it.
    expect(() =>
      loadConfig({ ...valid, DEPLOYMENT_TOPOLOGY: 'direct', TRUSTED_PROXY_IPS: '' }),
    ).not.toThrow();
  });

  it('refuses a production origin that is not a canonical serialized origin', () => {
    // A browser sends `Origin: https://admin.example.test` and nothing else,
    // and the check compares exactly. `https://admin.example.test/` — one
    // trailing slash — would validate, boot, and then reject every login and
    // every write, with the configuration looking correct.
    for (const origin of [
      'https://admin.example.test/',
      'https://admin.example.test/admin',
      'https://admin.example.test?x=1',
      'https://user:pass@admin.example.test',
      'not-a-url',
    ]) {
      expect(() =>
        loadConfig({
          ...valid,
          NODE_ENV: 'production',
          PASSWORD_HASH_PROFILE: 'production',
          WEB_ADMIN_ORIGINS: origin,
        }),
      ).toThrowError(/canonical https origin/);
    }

    // An explicit port is part of a serialized origin, so it is allowed.
    expect(() =>
      loadConfig({
        ...valid,
        NODE_ENV: 'production',
        PASSWORD_HASH_PROFILE: 'production',
        WEB_ADMIN_ORIGINS: 'https://admin.example.test:8443',
      }),
    ).not.toThrow();
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

  describe('background monitoring safety', () => {
    // Both of these are cross-field rules, and both are refusals rather than
    // clamps. A configuration that would defeat the reason a protection exists
    // should stop the process at boot, where somebody is reading the message.

    it('refuses a cadence that would let healthy panels go stale', () => {
      // Twelve minutes is fine at a thirty-second tick. The SAME twelve minutes
      // with a ten-minute tick is not, because worst-case refresh is the
      // interval plus the spread plus one tick of scheduling delay — which is
      // exactly why neither field alone can express the rule.
      expect(
        loadConfig({
          ...valid,
          PANEL_MONITOR_HEALTHY_INTERVAL_MS: String(12 * 60 * 1000),
          PANEL_MONITOR_TICK_MS: '30000',
        }).PANEL_MONITOR_HEALTHY_INTERVAL_MS,
      ).toBe(12 * 60 * 1000);

      expect(() =>
        loadConfig({
          ...valid,
          PANEL_MONITOR_HEALTHY_INTERVAL_MS: String(12 * 60 * 1000),
          PANEL_MONITOR_TICK_MS: String(10 * 60 * 1000),
        }),
      ).toThrowError(/would let a healthy panel's health go stale/);
    });

    it('accepts a long tick with a cadence that leaves room for it', () => {
      const config = loadConfig({
        ...valid,
        PANEL_MONITOR_HEALTHY_INTERVAL_MS: String(4 * 60 * 1000),
        PANEL_MONITOR_TICK_MS: String(10 * 60 * 1000),
      });
      expect(config.PANEL_MONITOR_TICK_MS).toBe(10 * 60 * 1000);
    });

    it('refuses a retry interval short enough to hammer a rejected credential', () => {
      // A minute-scale first retry that doubles still spends four or five
      // attempts against the operator's own panel before it slows down, and
      // both providers this release speaks to lock an account for fewer.
      expect(() =>
        loadConfig({ ...valid, PANEL_MONITOR_NONRETRYABLE_INTERVAL_MS: '60000' }),
      ).toThrowError(/PANEL_MONITOR_NONRETRYABLE_INTERVAL_MS/);
      expect(
        loadConfig({ ...valid, PANEL_MONITOR_NONRETRYABLE_INTERVAL_MS: String(30 * 60 * 1000) })
          .PANEL_MONITOR_NONRETRYABLE_INTERVAL_MS,
      ).toBe(30 * 60 * 1000);
    });

    it('refuses a zero background reserve while monitoring is enabled', () => {
      // The invariant is that an operator always outranks the background loop
      // for a tenant's last outbound probe. A zero reserve is that invariant
      // switched off, so it is refused rather than quietly rounded.
      expect(() =>
        loadConfig({ ...valid, PANEL_MONITOR_BUDGET_RESERVE_PERCENT: '0' }),
      ).toThrowError(/PANEL_MONITOR_BUDGET_RESERVE_PERCENT=0/);

      // With monitoring off there is no background lane to reserve against, so
      // the same value is fine.
      expect(
        loadConfig({
          ...valid,
          PANEL_MONITOR_ENABLED: 'false',
          PANEL_MONITOR_BUDGET_RESERVE_PERCENT: '0',
        }).PANEL_MONITOR_BUDGET_RESERVE_PERCENT,
      ).toBe(0);
    });
  });
});

describe('the monitor cannot claim more tenants than a tick can serve', () => {
  it('refuses a tenants-per-tick above the batch size', () => {
    // `claimTenants` spends every claimed tenant's turn, and the due scan is
    // capped globally by the batch. Two hundred tenants for a batch of one
    // marks two hundred as served while one panel is probed, so the documented
    // ceil(d / t) fairness bound is simply false.
    expect(() =>
      loadConfig({
        ...valid,
        PANEL_MONITOR_ENABLED: 'true',
        PANEL_MONITOR_TENANTS_PER_TICK: '200',
        PANEL_MONITOR_BATCH_SIZE: '1',
      }),
    ).toThrow(/PANEL_MONITOR_TENANTS_PER_TICK/);
  });

  it('accepts them equal, which is the tightest honest configuration', () => {
    const config = loadConfig({
      ...valid,
      PANEL_MONITOR_ENABLED: 'true',
      PANEL_MONITOR_TENANTS_PER_TICK: '10',
      PANEL_MONITOR_BATCH_SIZE: '10',
    });
    expect(config.PANEL_MONITOR_TENANTS_PER_TICK).toBe(10);
  });
});

describe('the reserve must leave the monitor a token it can reach', () => {
  it('refuses a bucket that reserves everything for manual tests', () => {
    // The floor rounds UP so a positive reserve is never silently zero — that
    // keeps an operator's last manual probe available at small capacities. The
    // other side was unchecked: at a limit of 1 the floor is the whole bucket,
    // so every background attempt is refused AFTER claiming its panel and no
    // panel of that tenant is ever monitored, while the process reports itself
    // perfectly healthy.
    expect(() =>
      loadConfig({
        ...valid,
        PANEL_MONITOR_ENABLED: 'true',
        PANEL_PROBE_TENANT_LIMIT: '1',
        PANEL_MONITOR_BUDGET_RESERVE_PERCENT: '40',
      }),
    ).toThrow(/PANEL_PROBE_TENANT_LIMIT/);
  });

  it('accepts a bucket of two, where each lane gets one', () => {
    const config = loadConfig({
      ...valid,
      PANEL_MONITOR_ENABLED: 'true',
      PANEL_PROBE_TENANT_LIMIT: '2',
      PANEL_MONITOR_BUDGET_RESERVE_PERCENT: '40',
    });
    expect(config.PANEL_PROBE_TENANT_LIMIT).toBe(2);
  });

  it('allows a capacity of one when monitoring is deliberately off', () => {
    // The contradiction is between the two lanes, not in the number itself.
    const config = loadConfig({
      ...valid,
      PANEL_MONITOR_ENABLED: 'false',
      PANEL_PROBE_TENANT_LIMIT: '1',
    });
    expect(config.PANEL_PROBE_TENANT_LIMIT).toBe(1);
  });
});

describe('the fresh-panel bound is the smallest of several, not one number', () => {
  it('derives the tenant budget ceiling from the refill rate', () => {
    // 30 tokens per 5 minutes is six a minute; ten minutes of those is sixty.
    expect(tenantBudgetFreshPanelUpperBound(30, 300_000, 10 * 60 * 1000)).toBe(60);
    expect(tenantBudgetFreshPanelUpperBound(300, 300_000, 10 * 60 * 1000)).toBe(600);
    // A shorter interval needs more probes per panel, so it supports fewer.
    expect(tenantBudgetFreshPanelUpperBound(30, 300_000, 5 * 60 * 1000)).toBe(30);
  });

  it('derives the scheduler ceiling from the batch and the tick', () => {
    // 50 candidates every 30s is 1000 starts across a 10-minute interval.
    expect(schedulerFreshPanelUpperBound(50, 30_000, 10 * 60 * 1000)).toBe(1000);
    expect(schedulerFreshPanelUpperBound(1, 60_000, 10 * 60 * 1000)).toBe(10);
  });

  it('takes the smaller of the two, whichever it is', () => {
    // At the shipped defaults the BUDGET binds: 60 against the scheduler's 1000.
    expect(
      effectiveFreshPanelUpperBound({
        tenantLimit: 30,
        windowMs: 300_000,
        batchSize: 50,
        tickMs: 30_000,
        healthyIntervalMs: 10 * 60 * 1000,
      }),
    ).toBe(60);

    // A large bucket does not help when the scheduler cannot start the probes.
    // This is the case the first version of this model got wrong by asserting
    // that batch size and tick "cannot change it": they cannot RAISE the
    // budget ceiling, but they impose one of their own.
    expect(
      effectiveFreshPanelUpperBound({
        tenantLimit: 3_000,
        windowMs: 300_000,
        batchSize: 1,
        tickMs: 60_000,
        healthyIntervalMs: 10 * 60 * 1000,
      }),
    ).toBe(10);
    expect(tenantBudgetFreshPanelUpperBound(3_000, 300_000, 10 * 60 * 1000)).toBe(6_000);
  });

  it('reports the worst-case latency figure separately, as a worst case', () => {
    // Four in flight, each running to a 10s timeout, across ten minutes.
    expect(worstCaseLatencyFreshPanelUpperBound(4, 10_000, 10 * 60 * 1000)).toBe(240);
    // Not folded into the effective bound: it is the pessimistic end of a range
    // whose real value is a round trip to somebody else's server.
  });
});
