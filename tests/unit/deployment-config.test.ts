import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../apps/api/src/infrastructure/config/config.schema';

/**
 * The deployment's configuration, checked against the application's own schema.
 *
 * This is the anti-drift mechanism, and it is the reason `deploy/` carries no
 * hand-written list of environment variables. The template is filled with the
 * values the installer would generate and parsed through the REAL
 * `configSchema` — so a variable the application starts requiring fails here,
 * at build time, rather than on an operator's first production boot.
 *
 * It also runs the schema's production refusals against the deployment for
 * real: `AUTH_MODE=none`, a recording transport, a `direct` topology, an empty
 * trusted-proxy set and a non-canonical admin origin are each rejected by the
 * application, and each is a mistake this template could plausibly make.
 */
describe('the production environment template', () => {
  const templatePath = join(__dirname, '../../deploy/nexa.env.template');
  const template = readFileSync(templatePath, 'utf8');

  /** Values of the shape the installer generates. Nothing here is a real key. */
  const SUBSTITUTIONS: Record<string, string> = {
    __POSTGRES_PASSWORD__: 'r4nd0m-postgres-password',
    __REDIS_PASSWORD__: 'r4nd0m-redis-password',
    // 32 bytes, base64, and deliberately not all zero: the schema refuses an
    // all-zero key, which is the shape a "just fill it in later" placeholder
    // takes. Nothing here is a real key.
    __SECRETS_KEK__: Buffer.from('nexa-deployment-template-test-key'.slice(0, 32)).toString(
      'base64',
    ),
    __SECRETS_ACTIVE_KEY_ID__: 'install-1',
    __DOMAIN__: 'admin.example.com',
    __EDGE_SUBNET__: '172.29.0.0/24',
  };

  function render(overrides: Record<string, string> = {}): Record<string, string> {
    let filled = template;
    for (const [token, value] of Object.entries(SUBSTITUTIONS)) {
      filled = filled.split(token).join(value);
    }
    const env: Record<string, string> = {};
    for (const line of filled.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      // A template line that is neither a comment nor an assignment is a typo
      // that would silently vanish into the environment file.
      expect(eq, `not a KEY=VALUE line: ${trimmed}`).toBeGreaterThan(0);
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return { ...env, ...overrides };
  }

  it('leaves no unsubstituted placeholder', () => {
    // A token the installer forgets to replace reaches production as the
    // literal string `__SECRETS_KEK__`, which the schema would reject — but
    // only for the values it validates. Catching it here covers all of them.
    const rendered = Object.values(render()).join('\n');
    expect(rendered).not.toMatch(/__[A-Z_]+__/);
  });

  it('parses cleanly through the application configuration schema', () => {
    const result = configSchema.safeParse(render());
    const problems = result.success
      ? []
      : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    expect(problems, "the deployment template does not satisfy the app's own schema").toEqual([]);
  });

  it('produces a production configuration, not a development one', () => {
    const config = configSchema.parse(render());
    expect(config.NODE_ENV).toBe('production');
    // Authentication is real from Phase 1 onward. The schema permits `none`
    // only in development; this asserts the deployment never asks for it.
    expect(config.AUTH_MODE).toBe('password');
    // `recording` keeps messages in memory. An installation running it looks
    // healthy while every operational alert goes nowhere.
    expect(config.NOTIFICATION_TRANSPORT).toBe('telegram');
    // The scrypt work factor. `fast` is a test affordance, two orders of
    // magnitude weaker.
    expect(config.PASSWORD_HASH_PROFILE).toBe('production');
    expect(config.DEPLOYMENT_TOPOLOGY).toBe('reverse-proxy');
  });

  it('trusts the edge network and nothing wider', () => {
    const config = configSchema.parse(render());
    expect(config.TRUSTED_PROXY_IPS.length).toBeGreaterThan(0);
    // A /0 is `trustProxy: true` spelled differently: every request would
    // appear to come from the proxy, so one failed-login burst would lock out
    // every administrator at once.
    for (const entry of config.TRUSTED_PROXY_IPS) {
      expect(entry, 'the deployment trusts every address').not.toMatch(/\/0$/);
    }
  });

  it('names the admin origin as a canonical https origin', () => {
    const config = configSchema.parse(render());
    expect(config.WEB_ADMIN_ORIGINS).toEqual(['https://admin.example.com']);
  });

  it('does not name the build identity at all', () => {
    // `env_file` beats an image's own ENV, so anything this template sets
    // REPLACES the values stamped into the release at build time. The
    // installer wrote `pending` for the commit and the build time — it cannot
    // know either, having built nothing — and that placeholder then masked the
    // real metadata permanently: /health/info reported `pending` on a
    // correctly built release, for the life of the installation.
    //
    // Asserted against the raw template, not the parsed config, because the
    // schema's defaults would hide a line that is present.
    const raw = readFileSync(templatePath, 'utf8');
    for (const key of ['BUILD_VERSION', 'BUILD_COMMIT', 'BUILD_TIME']) {
      expect(raw, `the template sets ${key}, which would mask the image`).not.toMatch(
        new RegExp(`^\\s*${key}=`, 'm'),
      );
    }
    // And the installer must not reintroduce them through substitution.
    const installer = readFileSync(join(__dirname, '../../deploy/install.sh'), 'utf8');
    expect(installer, 'the installer still substitutes a build placeholder').not.toMatch(
      /__BUILD_(VERSION|COMMIT|TIME)__/,
    );
    expect(installer, 'the installer still writes a pending placeholder').not.toMatch(/=pending/);
  });

  it('does not carry a copy of the data subnet', () => {
    // Fix B. The runtime learns the installation subnet from compose, which
    // reads deploy.env. A second copy in nexa.env was the value the real
    // staging host did NOT have after its upgrade, and it is exactly the
    // value an operator who moves the network would forget.
    const raw = readFileSync(templatePath, 'utf8');
    expect(raw).not.toMatch(/^\s*PANEL_HTTP_DENIED_SUBNETS=/m);
    expect(raw).not.toMatch(/^\s*NEXA_DATA_SUBNET=/m);
    const config = configSchema.parse(render());
    expect(config.NEXA_DATA_SUBNET).toBeUndefined();
    expect(config.PANEL_HTTP_DENIED_SUBNETS).toEqual([]);
  });

  it('substitutes every placeholder the template contains, everywhere it is rendered', () => {
    // The template and the scripts that fill it in are one mechanism split
    // across a repository. A key added to the template with no matching
    // substitution produces a literal `__NAME__` in the rendered file, which
    // the schema rejects at boot — after the script has reported success. The
    // test above proves the RENDER leaves nothing behind; this proves the
    // render is the same set the scripts actually perform.
    //
    // THREE renderers, not one, and that is the lesson. `PANEL_HTTP_DENIED_SUBNETS`
    // was added to the template and to the installer, and both deployment
    // smoke tests then failed in CI on a literal placeholder, because each
    // renders the same template through its own substitution list. A check
    // that knew only about the installer would not have said so.
    const raw = readFileSync(templatePath, 'utf8');
    const renderers = (
      [
        'deploy/install.sh',
        'scripts/deployment-smoke.sh',
        'scripts/deployment-update-smoke.sh',
      ] as const
    ).map((path) => [path, readFileSync(join(__dirname, '../..', path), 'utf8')] as const);
    // Assignments only. The header comment names `__PLACEHOLDER__` when it
    // explains the mechanism, and that is prose, not a value to fill in.
    const placeholders = new Set(
      [...raw.matchAll(/^[A-Z][A-Z0-9_]*=.*$/gm)].flatMap((line) =>
        [...line[0].matchAll(/__[A-Z0-9_]+__/g)].map((m) => m[0]),
      ),
    );
    expect(placeholders.size, 'the template has no placeholders at all').toBeGreaterThan(0);
    for (const placeholder of placeholders) {
      for (const [path, text] of renderers) {
        expect(text, `${path} never substitutes ${placeholder}`).toContain(placeholder);
      }
      expect(
        SUBSTITUTIONS,
        `this test never renders ${placeholder}, so it proves nothing about it`,
      ).toHaveProperty(placeholder);
    }
  });

  it('the installer checks the LAST key in the template for a torn write', () => {
    // `secrets_complete` names one key from the end of the template as its
    // proof that a write reached the end. That rule already rotted once — it
    // named BUILD_TIME, which left the file — and the consequence is quiet: a
    // torn write losing DEPLOYMENT_TOPOLOGY means TRUSTED_PROXY_IPS stops
    // being required, and the API boots ignoring X-Forwarded-For.
    const raw = readFileSync(templatePath, 'utf8');
    const assignments = [...raw.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    const last = assignments.at(-1);
    expect(last, 'the template has no assignments').toBeTruthy();

    const installer = readFileSync(join(__dirname, '../../deploy/install.sh'), 'utf8');
    const checked = /secrets_complete "\$app_env"([^;]*?); then/s.exec(installer)?.[1] ?? '';
    expect(
      checked.split(/\s+/).filter(Boolean),
      `install.sh does not check ${last}, the last key in the template`,
    ).toContain(last);
  });

  it('still boots without a build identity, reporting the schema defaults', () => {
    // The image supplies these in production. A container run outside the
    // release flow must still start and still say something true about
    // itself — `unknown` is a fact, `pending` was a claim nothing fulfilled.
    const config = configSchema.parse(render());
    expect(config.BUILD_VERSION).toBe('0.0.0-dev');
    expect(config.BUILD_COMMIT).toBe('unknown');
    expect(config.BUILD_TIME).toBe('unknown');
  });

  /**
   * The template is only worth testing if the test can fail.
   *
   * Each case below is a plausible edit to the template — a domain pasted with
   * its scheme wrong, a trusted set emptied "because Docker assigns it
   * anyway", a transport switched while debugging — and each must be refused
   * by the application's schema rather than by a rule restated here.
   */
  it.each([
    ['an http admin origin', { WEB_ADMIN_ORIGINS: 'http://admin.example.com' }],
    ['an admin origin with a trailing slash', { WEB_ADMIN_ORIGINS: 'https://admin.example.com/' }],
    ['an empty trusted proxy set', { TRUSTED_PROXY_IPS: '' }],
    ['a trusted proxy set of everything', { TRUSTED_PROXY_IPS: '0.0.0.0/0' }],
    ['the recording transport', { NOTIFICATION_TRANSPORT: 'recording' }],
    ['authentication turned off', { AUTH_MODE: 'none' }],
    ['a direct topology', { DEPLOYMENT_TOPOLOGY: 'direct', TRUSTED_PROXY_IPS: '' }],
    ['the fast password profile', { PASSWORD_HASH_PROFILE: 'fast' }],
    ['a plaintext Telegram base URL', { TELEGRAM_API_BASE_URL: 'http://api.telegram.org' }],
    ['a short KEK', { SECRETS_KEK: Buffer.alloc(16).toString('base64') }],
    // The placeholder shape a hurried installer leaves behind.
    ['an all-zero KEK', { SECRETS_KEK: Buffer.alloc(32).toString('base64') }],
  ])('is refused with %s', (_name, overrides) => {
    expect(configSchema.safeParse(render(overrides)).success).toBe(false);
  });
});
