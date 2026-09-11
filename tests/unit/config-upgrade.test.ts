import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../apps/api/src/infrastructure/config/config.schema';

/**
 * An installation that has been upgraded repeatedly, booting on the current image.
 *
 * `deploy/nexa.env.template` lists only the values a deployment must DECIDE;
 * everything the schema defaults sensibly is left out, because restating a default
 * is a second place for it to be wrong. That policy is correct, and it has a
 * consequence nothing tested: an installation created at an earlier release has
 * whatever that release's template wrote and NOTHING SINCE — `botctl update` never
 * rewrites `/etc/nexa/nexa.env`. So "a missing line is safe" was an argument, not
 * a result, for every variable added after the first install.
 *
 * `tests/unit/deployment-config.test.ts` renders the CURRENT template. These
 * render the templates real installations were created with, read out of git and
 * committed as fixtures, through the CURRENT schema — which is precisely what
 * `botctl update` asks the application to do.
 *
 * See `docs/config-upgrade-audit.md` for the classification of every variable.
 */

const SUBSTITUTIONS: Record<string, string> = {
  __POSTGRES_PASSWORD__: 'r4nd0m-postgres-password',
  __REDIS_PASSWORD__: 'r4nd0m-redis-password',
  // 32 bytes, base64, and deliberately not all zero: the schema refuses an
  // all-zero key, which is the shape a "fill it in later" placeholder takes.
  __SECRETS_KEK__: Buffer.from('nexa-config-upgrade-test-key-----'.slice(0, 32)).toString('base64'),
  __SECRETS_KEK_ID__: 'install-1',
  __SECRETS_ACTIVE_KEY_ID__: 'install-1',
  __DOMAIN__: 'admin.example.com',
  __EDGE_SUBNET__: '172.29.0.0/24',
  // The first production template substituted these three. They are the reason
  // this file exists; see the BUILD_* case below.
  __BUILD_VERSION__: 'v0.1.0-staging.1',
  __BUILD_COMMIT__: 'pending',
  __BUILD_TIME__: 'pending',
};

function parseEnvFile(text: string): Record<string, string> {
  let filled = text;
  for (const [token, value] of Object.entries(SUBSTITUTIONS)) {
    filled = filled.split(token).join(value);
  }
  const env: Record<string, string> = {};
  for (const line of filled.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    expect(eq, `not a KEY=VALUE line: ${trimmed}`).toBeGreaterThan(0);
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

const LEGACY_DIR = join(__dirname, '../fixtures/legacy-nexa-env');

/**
 * The templates real installations were created with.
 *
 * Reproduce any of them with `git show <sha>:deploy/nexa.env.template`. They are
 * committed rather than read from git because a test that shells out to git is a
 * test that fails in a shallow clone, and because these are fixed historical
 * facts that must not change when history is rewritten or reinterpreted.
 */
const legacy = readdirSync(LEGACY_DIR)
  .filter((name) => name.endsWith('.env'))
  .sort()
  .map((name) => ({ name, env: parseEnvFile(readFileSync(join(LEGACY_DIR, name), 'utf8')) }));

const problems = (env: Record<string, string>): string[] => {
  const result = configSchema.safeParse(env);
  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
};

describe('an upgraded installation on the current image', () => {
  it('has fixtures to test at all', () => {
    // Without this the whole file is a loop over an empty array reporting
    // success — which is how a suite comes to certify nothing.
    expect(legacy.length).toBeGreaterThanOrEqual(3);
    expect(legacy.map((l) => l.name)).toContain('150d8c4.env');
  });

  /**
   * Named one per fixture rather than generated in a loop.
   *
   * A template-literal test name cannot be CITED — `check:citations` resolves a
   * falsification row's named test against the committed source, and a name
   * assembled at run time is not in it. It also cannot be skipped by accident:
   * a loop over an array that came back empty reports success, which is what the
   * `has fixtures to test at all` case above exists to catch and what naming
   * them makes unnecessary.
   */
  const fixture = (name: string): Record<string, string> => {
    const entry = legacy.find((l) => l.name === name);
    expect(entry, `${name} is missing from tests/fixtures/legacy-nexa-env`).toBeTruthy();
    return entry?.env ?? {};
  };

  it('boots from the 150d8c4.env template through the current schema', () => {
    // The FIRST production template: the legacy keyring pair, the three build
    // keys, no SECRETS_ACCEPT_V1, and nothing about backup or recovery at all.
    expect(problems(fixture('150d8c4.env'))).toEqual([]);
  });

  it('boots from the 2916442.env template through the current schema', () => {
    // The keyring release: canonical spelling, acceptance made explicit.
    expect(problems(fixture('2916442.env'))).toEqual([]);
  });

  it('boots from the 1968444.env template through the current schema', () => {
    // The release before disaster recovery, which is what a host updated to
    // v0.1.0-staging.13 would have had written for it had it been installed then.
    expect(problems(fixture('1968444.env'))).toEqual([]);
  });

  it('resolves the SAME configuration for every process role', () => {
    // compose gives api, worker, monitor and recovery one `env_file` and one
    // `environment` block through the shared `x-app-common` anchor, so there is
    // one parse and one result. Asserted against the schema rather than against
    // compose's text, because the claim is about what the four PROCESSES see.
    for (const { name, env } of legacy) {
      const parsed = configSchema.parse(env);
      // The three role-specific paths every container healthcheck reads.
      expect(parsed.WORKER_HEARTBEAT_PATH, name).toBe('/tmp/nexa-worker.heartbeat');
      expect(parsed.PANEL_MONITOR_HEARTBEAT_PATH, name).toBe('/tmp/nexa-monitor.heartbeat');
      expect(parsed.RECOVERY_HEARTBEAT_PATH, name).toBe('/tmp/nexa-recovery.heartbeat');
      // One interval, from which all three healthchecks derive their maximum age.
      expect(parsed.WORKER_HEARTBEAT_INTERVAL_MS, name).toBe(10_000);
    }
  });

  it('keeps the old keyring spelling decrypting, and v1 acceptance ON for it', () => {
    // The compatibility path, stated as a result. `SECRETS_KEK` aliases to a
    // one-entry keyring whose only key is the active one — which is what v1 did
    // — so ciphertext written before the keyring release stays readable without
    // anybody hand-editing nexa.env or replacing key material.
    const first = legacy.find((l) => l.name === '150d8c4.env');
    expect(first, 'the first production template is the compatibility case').toBeTruthy();
    const parsed = configSchema.parse(first?.env ?? {});
    expect(parsed.SECRETS_KEK).toBeDefined();
    expect(parsed.SECRETS_KEYS).toBeUndefined();
    // Acceptance is DERIVED, not defaulted: a host still on the legacy spelling
    // has v1 rows to read, and one on the canonical spelling does not.
    expect(parsed.SECRETS_ACCEPT_V1).toBeUndefined();
  });

  it('leaves a backup destination unset, which is a supported state', () => {
    // No template ever wrote these. Empty means delivery is not configured, and
    // a run that dumps, verifies and retains is still a backup — the outcome is
    // NOT_ATTEMPTED rather than a failure. Nothing here invents a chat or a token.
    for (const { name, env } of legacy) {
      const parsed = configSchema.parse(env);
      expect(parsed.BACKUP_TELEGRAM_CHAT_ID, name).toBe('');
      expect(parsed.BACKUP_TELEGRAM_BOT_TOKEN, name).toBe('');
    }
  });

  it('leaves the scheduled backup OFF, and an upgrade must not turn it on', () => {
    // The default is false and that is deliberate: an upgrade that started
    // taking and delivering backups an operator had not asked for would be
    // writing the whole database somewhere on its own initiative. The cost is
    // that an upgraded installation has no automatic backups and nothing in the
    // application says so, which is why `botctl status` now reports it.
    for (const { name, env } of legacy) {
      expect(configSchema.parse(env).BACKUP_SCHEDULE_ENABLED, name).toBe(false);
    }
  });

  it('leaves recovery upload ENABLED, which the capabilities endpoint reports', () => {
    for (const { name, env } of legacy) {
      expect(configSchema.parse(env).RECOVERY_UPLOAD_ENABLED, name).toBe(true);
    }
  });

  it('carries the stale build identity the first template wrote, and it masks the image', () => {
    // The defect `botctl update` now reconciles. `env_file` beats an image's own
    // ENV, so these three lines REPLACE the values stamped into the release at
    // build time — permanently, because nothing rewrote nexa.env. The installer
    // substituted `pending` for two of them; it had built nothing and could not
    // know. So /health/info reported `pending` on a correctly built release for
    // the life of the installation.
    const first = legacy.find((l) => l.name === '150d8c4.env');
    const parsed = configSchema.parse(first?.env ?? {});
    expect(parsed.BUILD_COMMIT).toBe('pending');
    expect(parsed.BUILD_TIME).toBe('pending');
    // And with those lines gone, the schema's own defaults say something true.
    const withoutBuild = { ...(first?.env ?? {}) };
    delete withoutBuild.BUILD_VERSION;
    delete withoutBuild.BUILD_COMMIT;
    delete withoutBuild.BUILD_TIME;
    const repaired = configSchema.parse(withoutBuild);
    expect(repaired.BUILD_COMMIT).toBe('unknown');
    expect(repaired.BUILD_TIME).toBe('unknown');
    // `unknown` is a fact. `pending` was a claim that something was about to be
    // filled in, and nothing ever filled it in.
  });

  describe('configurations an operator may legitimately have', () => {
    const current = parseEnvFile(
      readFileSync(join(__dirname, '../../deploy/nexa.env.template'), 'utf8'),
    );

    it('accepts deliberate non-default overrides and does not quietly normalise them', () => {
      const parsed = configSchema.parse({
        ...current,
        BACKUP_SCHEDULE_ENABLED: 'true',
        BACKUP_INTERVAL_MS: '21600000',
        RECOVERY_UPLOAD_ENABLED: 'false',
        PANEL_MONITOR_ENABLED: 'false',
        SESSION_TTL_SECONDS: '1800',
      });
      expect(parsed.BACKUP_SCHEDULE_ENABLED).toBe(true);
      expect(parsed.BACKUP_INTERVAL_MS).toBe(21_600_000);
      expect(parsed.RECOVERY_UPLOAD_ENABLED).toBe(false);
      expect(parsed.PANEL_MONITOR_ENABLED).toBe(false);
      expect(parsed.SESSION_TTL_SECONDS).toBe(1800);
    });

    it('accepts a fully configured backup destination', () => {
      const parsed = configSchema.parse({
        ...current,
        BACKUP_SCHEDULE_ENABLED: 'true',
        BACKUP_TELEGRAM_CHAT_ID: '-1001234567890',
        BACKUP_TELEGRAM_BOT_TOKEN: '123456:AAnotarealtoken',
      });
      expect(parsed.BACKUP_TELEGRAM_CHAT_ID).toBe('-1001234567890');
    });

    it('REFUSES a half-configured backup destination, either way round', () => {
      expect(problems({ ...current, BACKUP_TELEGRAM_CHAT_ID: '-1001234567890' }).join(' ')).toMatch(
        /BACKUP_TELEGRAM_BOT_TOKEN/,
      );
      expect(
        problems({ ...current, BACKUP_TELEGRAM_BOT_TOKEN: '123456:AAnotarealtoken' }).join(' '),
      ).toMatch(/BACKUP_TELEGRAM_CHAT_ID/);
    });

    it('accepts the boolean spellings it documents, and only those', () => {
      // `booleanish` takes true/false/1/0/yes/no deliberately, so an operator who
      // wrote `yes` gets what they meant rather than a refusal. Asserted because
      // the first version of this case assumed `yes` was invalid and therefore
      // proved nothing: it expected a refusal, got a valid `true`, and the
      // surrounding case would have passed on the other two assertions alone.
      for (const [written, meaning] of [
        ['true', true],
        ['yes', true],
        ['1', true],
        ['false', false],
        ['no', false],
        ['0', false],
      ] as const) {
        expect(
          configSchema.parse({ ...current, BACKUP_SCHEDULE_ENABLED: written })
            .BACKUP_SCHEDULE_ENABLED,
          written,
        ).toBe(meaning);
      }
      expect(problems({ ...current, BACKUP_SCHEDULE_ENABLED: 'maybe' }).length).toBeGreaterThan(0);
      expect(problems({ ...current, RECOVERY_UPLOAD_ENABLED: 'off' }).length).toBeGreaterThan(0);
    });

    it('refuses a wrong line rather than coercing it', () => {
      // A missing line must not be the only thing that is safe; a WRONG line has
      // to be refused, or "the schema validates it" means nothing.
      expect(problems({ ...current, RECOVERY_UPLOAD_MAX_BYTES: '10' }).length).toBeGreaterThan(0);
      expect(problems({ ...current, NOTIFICATION_TRANSPORT: 'recording' }).length).toBeGreaterThan(
        0,
      );
      expect(problems({ ...current, BACKUP_INTERVAL_MS: '1000' }).length).toBeGreaterThan(0);
      expect(problems({ ...current, TRUSTED_PROXY_IPS: '0.0.0.0/0' }).length).toBeGreaterThan(0);
    });
  });
});

describe('.env.example names every variable the application reads', () => {
  /**
   * The developer-facing example, which is a different document from the
   * deployment template and has the opposite rule.
   *
   * The template lists only what a deployment must DECIDE. This file is how a
   * contributor discovers what exists, so a key absent from it is a key nobody
   * finds — and the omission had teeth: the Secrets section offered only
   * `SECRETS_KEK`/`SECRETS_KEK_ID`, the RETIRED spelling, so a new configuration
   * adopted the v1 envelope and, because acceptance is derived from the spelling
   * rather than defaulted, turned v1 acceptance on with it.
   */
  const example = readFileSync(join(__dirname, '../../.env.example'), 'utf8');

  /**
   * The declared keys, read from the schema SOURCE.
   *
   * Not `Object.keys(configSchema.parse(...))`: an optional key with no value is
   * absent from the parsed object, so that list silently omitted `SECRETS_KEK`,
   * `SECRETS_KEK_ID`, `SECRETS_ACCEPT_V1`, `PANEL_HTTP_CA_FILE` and
   * `NEXA_DATA_SUBNET` — five variables, two of which are the legacy spelling
   * this section exists to talk about. Measured; the first version of this test
   * reported an empty commented set for exactly that reason.
   */
  const schemaSource = readFileSync(
    join(__dirname, '../../apps/api/src/infrastructure/config/config.schema.ts'),
    'utf8',
  );
  const schemaKeys = [...schemaSource.matchAll(/^ {4}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1] ?? '');

  const assigned = (key: string) => new RegExp(`^${key}=`, 'm').test(example);
  const commented = (key: string) => new RegExp(`^# ${key}=`, 'm').test(example);

  it('parsed a non-trivial set of keys out of the schema', () => {
    expect(schemaKeys.length).toBeGreaterThanOrEqual(80);
  });

  it('names every one of them, as an assignment or a commented alternative', () => {
    const absent = schemaKeys.filter((key) => !assigned(key) && !commented(key)).sort();
    expect(absent, 'these variables exist and .env.example does not mention them').toEqual([]);
  });

  it('leaves exactly the retired keyring spelling commented out', () => {
    // Commenting a key is how an ALTERNATIVE is offered, and it must not become
    // a way for a new variable to satisfy the rule above without being visible.
    // So the commented set is named, not merely bounded.
    const onlyCommented = schemaKeys.filter((key) => !assigned(key) && commented(key)).sort();
    expect(onlyCommented).toEqual(['SECRETS_KEK', 'SECRETS_KEK_ID']);
  });

  it('leads with the canonical keyring, above the legacy pair', () => {
    const canonical = example.indexOf('\nSECRETS_KEYS=');
    const legacyPair = example.indexOf('\n# SECRETS_KEK=');
    expect(canonical).toBeGreaterThan(-1);
    expect(legacyPair).toBeGreaterThan(-1);
    expect(canonical, 'the retired spelling is offered first').toBeLessThan(legacyPair);
  });
});

describe('the subnet defaults are one decision, not three literals', () => {
  /**
   * An installation whose `deploy.env` predates a subnet key takes compose's
   * default; its `nexa.env` carries the `TRUSTED_PROXY_IPS` the installer derived
   * at install time. Those are three separate literals in three files, and if any
   * two ever disagreed the API would stop trusting the proxy in front of it —
   * after which every request appears to come from Caddy and one failed-login
   * burst locks out every administrator. The template's own comment warns about
   * an operator causing that by hand; nothing stopped the repository causing it.
   */
  const compose = readFileSync(join(__dirname, '../../deploy/compose.yml'), 'utf8');
  const installer = readFileSync(join(__dirname, '../../deploy/install.sh'), 'utf8');

  const composeDefault = (key: string): string | undefined =>
    new RegExp(`\\$\\{${key}:-([^}]+)\\}`).exec(compose)?.[1];
  const installerDefault = (key: string): string | undefined =>
    new RegExp(`\\$\\{${key}:-([^}]+)\\}`).exec(installer)?.[1];

  it('agrees on the edge subnet between compose and the installer', () => {
    const fromCompose = composeDefault('NEXA_EDGE_SUBNET');
    const fromInstaller = installerDefault('NEXA_EDGE_SUBNET');
    expect(fromCompose, 'compose declares no default edge subnet').toBeTruthy();
    expect(fromInstaller, 'the installer declares no default edge subnet').toBeTruthy();
    expect(fromCompose).toBe(fromInstaller);
  });

  it('agrees on the data subnet, in every place compose spells it', () => {
    const fromCompose = composeDefault('NEXA_DATA_SUBNET');
    const fromInstaller = installerDefault('NEXA_DATA_SUBNET');
    expect(fromCompose).toBeTruthy();
    expect(fromInstaller).toBe(fromCompose);
    // compose uses the expression twice — the network's subnet and the value it
    // hands the application — and both must be the same expression.
    const occurrences = compose.split(`\${NEXA_DATA_SUBNET:-${fromCompose}}`).length - 1;
    expect(occurrences, 'the data-subnet expression is not used exactly twice').toBe(2);
  });

  it('keeps the two networks from overlapping at their defaults', () => {
    // Equal defaults would put the database on the network Caddy sits on, which
    // is the separation the whole topology rests on.
    expect(composeDefault('NEXA_EDGE_SUBNET')).not.toBe(composeDefault('NEXA_DATA_SUBNET'));
  });
});

describe("botctl reads the application's booleans, not a second opinion", () => {
  /**
   * `botctl status` reports which capabilities are on by reading nexa.env itself,
   * because the application cannot be asked while it is down — and that makes the
   * shell a SECOND implementation of `booleanish`. A reader that accepted only
   * `true` would report a monitor an operator had enabled with `yes` as disabled,
   * and an operator acting on that would be acting on a lie about their own
   * installation.
   *
   * So the two spelling sets are bound together here. The shell suite proves the
   * reader behaves; this proves it is reading the same vocabulary.
   */
  const schemaSource = readFileSync(
    join(__dirname, '../../apps/api/src/infrastructure/config/config.schema.ts'),
    'utf8',
  );
  const lib = readFileSync(join(__dirname, '../../deploy/bin/nexa-lib.sh'), 'utf8');

  /**
   * The declaration block, then the quoted strings inside it.
   *
   * Matching the block and then its literals, rather than one regex over the
   * whole `z.union([z.boolean(), z.enum([...])])` shape: the first version of
   * this test tried the latter, the regex did not compile, and the file reported
   * `no tests` — which is a suite that certifies nothing while exiting zero.
   */
  const booleanishBlock = /const booleanish = [\s\S]*?\.transform\(/.exec(schemaSource)?.[0];

  it("finds the schema's accepted spellings at all", () => {
    expect(booleanishBlock, 'booleanish no longer looks the way this test reads it').toBeTruthy();
  });

  it('accepts exactly the same spellings in the shell', () => {
    const accepted = [...(booleanishBlock ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    expect(accepted.sort()).toEqual(['0', '1', 'false', 'no', 'true', 'yes']);

    // The shell's two case arms, read out of the function that implements them.
    const reader = /nexa_env_boolean\(\) \{[\s\S]*?\n\}/.exec(lib)?.[0] ?? '';
    expect(reader, 'nexa_env_boolean is not where this test looks for it').toContain(
      'case "$raw" in',
    );
    const truthy = /\n\s*(.*?)\) printf 'on'/.exec(reader)?.[1] ?? '';
    const falsy = /\n\s*(.*?)\) printf 'off'/.exec(reader)?.[1] ?? '';
    const spellings = (arm: string) =>
      arm
        .split('|')
        .map((part) => part.trim())
        .filter(Boolean)
        .sort();
    expect(spellings(truthy)).toEqual(['1', 'true', 'yes']);
    expect(spellings(falsy)).toEqual(['0', 'false', 'no']);
    // And together they are the schema's set exactly — neither wider nor narrower.
    expect([...spellings(truthy), ...spellings(falsy)].sort()).toEqual(accepted.sort());
  });

  it('names the same obsolete keys the upgrade audit does', () => {
    // The frozen list lives in one place. A key added to it without a reason is
    // a key removed from an operator's configuration without a reason.
    const frozen = /NEXA_OBSOLETE_APP_ENV_KEYS="([^"]*)"/.exec(lib)?.[1] ?? '';
    expect(frozen.split(/\s+/).filter(Boolean).sort()).toEqual([
      'BUILD_COMMIT',
      'BUILD_TIME',
      'BUILD_VERSION',
    ]);
  });
});
