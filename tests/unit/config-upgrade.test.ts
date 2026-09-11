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

describe('the subnet defaults are one decision, not several literals', () => {
  /**
   * An installation whose `deploy.env` predates a subnet key takes compose's
   * default; its `nexa.env` carries the `TRUSTED_PROXY_IPS` the installer derived
   * at install time. Those are literals in two files — and the installer spells
   * the edge default TWICE, once deriving `TRUSTED_PROXY_IPS` and once writing
   * `deploy.env`. If any of them disagreed, the API would stop trusting the proxy
   * in front of it: every request would appear to come from Caddy, and one
   * failed-login burst would lock out every administrator.
   *
   * EVERY occurrence, not the first. The first version of this took only
   * `exec()`'s single match, so a change to the installer's second spelling alone
   * would have left a fresh installation putting Caddy on one subnet and trusting
   * the other with this test still green — the exact scenario it exists to
   * prevent, surviving its own guard.
   */
  const compose = readFileSync(join(__dirname, '../../deploy/compose.yml'), 'utf8');
  const installer = readFileSync(join(__dirname, '../../deploy/install.sh'), 'utf8');

  /** Every `${KEY:-default}` default for KEY, in the order they appear. */
  const defaultsFor = (text: string, key: string): string[] =>
    [...text.matchAll(new RegExp(`\\$\\{${key}:-([^}]+)\\}`, 'g'))].map((m) => m[1] ?? '');

  const agreed = (key: string, expectedOccurrences: { compose: number; installer: number }) => {
    const fromCompose = defaultsFor(compose, key);
    const fromInstaller = defaultsFor(installer, key);
    expect(fromCompose.length, `compose spells ${key}'s default`).toBe(expectedOccurrences.compose);
    expect(fromInstaller.length, `install.sh spells ${key}'s default`).toBe(
      expectedOccurrences.installer,
    );
    const distinct = [...new Set([...fromCompose, ...fromInstaller])];
    expect(distinct, `${key} has more than one default across the deployment`).toHaveLength(1);
    return distinct[0] ?? '';
  };

  /**
   * First address and prefix length of a CIDR, as a 32-bit number.
   *
   * Every component is required to be non-empty decimal TEXT before `Number` sees
   * it. JavaScript turns '' into 0, so the first version of this accepted
   * `172.29.0./24` as `172.29.0.0/24` and `172.29.0.0/` as a `/0` — and a
   * malformed literal changed consistently at every occurrence would then pass
   * both the agreement and the overlap case while Docker refused the subnet and a
   * fresh deployment failed.
   */
  const parseCidr = (cidr: string): { base: number; bits: number } => {
    const parts = cidr.split('/');
    expect(parts, `${cidr} is not address/prefix`).toHaveLength(2);
    const [address = '', prefix = ''] = parts;
    const rawOctets = address.split('.');
    expect(rawOctets, `${cidr} is not four octets`).toHaveLength(4);
    for (const raw of [...rawOctets, prefix]) {
      expect(/^\d+$/.test(raw), `${cidr} has a non-decimal or empty component`).toBe(true);
    }
    const octets = rawOctets.map((part) => Number(part));
    for (const octet of octets) expect(octet >= 0 && octet <= 255, `${cidr}`).toBe(true);
    const bits = Number(prefix);
    expect(bits >= 0 && bits <= 32, `${cidr} has an out-of-range prefix length`).toBe(true);
    const value = octets.reduce((acc, octet) => acc * 256 + octet, 0);
    // The network address, so a host bit somebody left set cannot shift the range.
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return { base: (value & mask) >>> 0, bits };
  };

  const overlaps = (a: string, b: string): boolean => {
    const left = parseCidr(a);
    const right = parseCidr(b);
    // Two CIDRs intersect exactly when one contains the other's network address,
    // which is decided by the SHORTER prefix.
    const bits = Math.min(left.bits, right.bits);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (left.base & mask) >>> 0 === (right.base & mask) >>> 0;
  };

  it('agrees on the edge subnet across every place it is spelled', () => {
    // compose: the network. install.sh: TRUSTED_PROXY_IPS, and deploy.env.
    expect(agreed('NEXA_EDGE_SUBNET', { compose: 1, installer: 2 })).toBeTruthy();
  });

  it('agrees on the data subnet across every place it is spelled', () => {
    // compose: the network, and the value handed to the application.
    expect(agreed('NEXA_DATA_SUBNET', { compose: 2, installer: 1 })).toBeTruthy();
  });

  it('keeps the two networks from OVERLAPPING at their defaults, not merely differing', () => {
    // String inequality does not establish disjointness: `172.29.0.0/16` and
    // `172.29.1.0/24` are different strings and the second is inside the first.
    // Either Docker refuses the deployment or the edge/data separation the whole
    // topology rests on is gone.
    const edge = agreed('NEXA_EDGE_SUBNET', { compose: 1, installer: 2 });
    const data = agreed('NEXA_DATA_SUBNET', { compose: 2, installer: 1 });
    expect(overlaps(edge, data), `${edge} and ${data} intersect`).toBe(false);
  });

  it('refuses a malformed CIDR instead of coercing its empty parts to zero', () => {
    // `172.29.0./24` and `172.29.0.0/` both became valid under `Number('')  === 0`,
    // so a malformed literal changed consistently everywhere would have passed
    // both cases above while Docker refused the subnet.
    for (const malformed of [
      '172.29.0./24',
      '172.29.0.0/',
      '172.29.0.0',
      '172.29/24',
      'x.y.z.w/8',
    ]) {
      expect(() => parseCidr(malformed), `${malformed} was accepted`).toThrow();
    }
    expect(() => parseCidr('172.29.0.0/24')).not.toThrow();
  });

  it('can tell an overlap from a difference, so the case above is not vacuous', () => {
    // The comparator itself, because a predicate that always answered `false`
    // would make the assertion above pass for ever.
    expect(overlaps('172.29.0.0/24', '172.29.1.0/24')).toBe(false);
    expect(overlaps('172.29.0.0/16', '172.29.1.0/24')).toBe(true);
    expect(overlaps('172.29.1.0/24', '172.29.0.0/16')).toBe(true);
    expect(overlaps('10.0.0.0/8', '10.255.255.0/24')).toBe(true);
    expect(overlaps('10.0.0.0/8', '11.0.0.0/8')).toBe(false);
    expect(overlaps('0.0.0.0/0', '192.168.1.0/24')).toBe(true);
  });
});

describe("botctl reads the application's booleans per key, not one vocabulary for all", () => {
  /**
   * `botctl status` reports which capabilities are on by reading nexa.env itself,
   * because the application cannot be asked while it is down — which makes the
   * shell a second implementation of the schema's boolean parsing. It is not ONE
   * parse: `booleanish` accepts true/false/1/0/yes/no, while
   * `PANEL_MONITOR_ENABLED` is `z.enum(['true', 'false'])` and nothing wider.
   *
   * Both directions are a lie an operator would act on. A reader that took only
   * `true` would report a monitor enabled with `yes` as disabled; a reader that
   * took `yes` for the enum key would report `on` for a value the next start
   * REFUSES. The first version of this test bound one global vocabulary and so
   * proved only the first half.
   *
   * So every key the section reports is bound here to the validator the schema
   * gives it, and to the default the schema gives it.
   */
  const schemaSource = readFileSync(
    join(__dirname, '../../apps/api/src/infrastructure/config/config.schema.ts'),
    'utf8',
  );
  const lib = readFileSync(join(__dirname, '../../deploy/bin/nexa-lib.sh'), 'utf8');
  const botctl = readFileSync(join(__dirname, '../../deploy/bin/botctl'), 'utf8');

  /**
   * The table `status_capabilities` iterates:
   * KEY|label|default|vocabulary|owning process.
   */
  const reported = [
    ...botctl.matchAll(
      /^\s*'([A-Z][A-Z0-9_]*)\|([^|]*)\|(on|off)\|(loose|strict)\|(worker|monitor|api)'$/gm,
    ),
  ].map((m) => ({
    key: m[1] ?? '',
    fallback: m[3] ?? '',
    vocab: m[4] ?? '',
    owner: m[5] ?? '',
  }));

  /** The schema's declaration for one key, to the start of the next. */
  const declaration = (key: string): string => {
    const lines = schemaSource.split('\n');
    const at = lines.findIndex((line) => new RegExp(`^ {4}${key}:`).test(line));
    expect(at, `${key} is not declared in the schema`).toBeGreaterThan(-1);
    const next = lines.findIndex((line, index) => index > at && /^ {4}[A-Z][A-Z0-9_]*:/.test(line));
    return lines.slice(at, next < 0 ? undefined : next).join('\n');
  };

  it('reports the six settings the section is built from', () => {
    expect(reported.map((r) => r.key).sort()).toEqual([
      'BACKUP_SCHEDULE_ENABLED',
      'NOTIFICATION_DISPATCH_ENABLED',
      'OUTBOX_RELAY_ENABLED',
      'PANEL_MONITOR_ENABLED',
      'RECOVERY_UPLOAD_ENABLED',
      'TELEGRAM_WEBHOOK_ENABLED',
    ]);
  });

  it('gives each key the vocabulary its own validator allows', () => {
    for (const { key, vocab } of reported) {
      const declared = declaration(key);
      const isBooleanish = /:\s*booleanish/.test(declared);
      const isStrictEnum = /z\s*\n?\s*\.enum\(\['true', 'false'\]\)/.test(declared);
      expect(
        isBooleanish || isStrictEnum,
        `${key} is neither booleanish nor a true/false enum, so this test cannot classify it`,
      ).toBe(true);
      expect(vocab, `${key} is read with the wrong vocabulary`).toBe(
        isBooleanish ? 'loose' : 'strict',
      );
    }
  });

  it('gives each key the default its own declaration gives it', () => {
    for (const { key, fallback } of reported) {
      const declared = declaration(key);
      const asWritten = /\.default\((true|false|'true'|'false')\)/.exec(declared)?.[1];
      expect(asWritten, `${key} has no boolean default this test can read`).toBeTruthy();
      const on = asWritten === 'true' || asWritten === "'true'";
      expect(fallback, `status falls back to the wrong default for ${key}`).toBe(on ? 'on' : 'off');
    }
  });

  it("accepts exactly the schema spellings in each of the shell reader's two arms", () => {
    const block = /const booleanish = [\s\S]*?\.transform\(/.exec(schemaSource)?.[0];
    expect(block, 'booleanish no longer looks the way this test reads it').toBeTruthy();
    const accepted = [...(block ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    expect(accepted.sort()).toEqual(['0', '1', 'false', 'no', 'true', 'yes']);

    const reader = /nexa_env_boolean\(\) \{[\s\S]*?\n\}/.exec(lib)?.[0] ?? '';
    expect(reader, 'nexa_env_boolean is not where this test looks for it').toContain('vocab');
    const arms = (from: string) => {
      const truthy = /\n\s*(.*?)\) printf 'on'/.exec(from)?.[1] ?? '';
      const falsy = /\n\s*(.*?)\) printf 'off'/.exec(from)?.[1] ?? '';
      const split = (arm: string) =>
        arm
          .split('|')
          .map((part) => part.trim())
          .filter(Boolean)
          .sort();
      return { truthy: split(truthy), falsy: split(falsy) };
    };
    // The strict branch comes first in the function; split on it so each arm pair
    // is read from the branch it belongs to.
    const strictAt = reader.indexOf('if [ "$vocab" = strict ]');
    expect(strictAt).toBeGreaterThan(-1);
    const strict = arms(reader.slice(strictAt));
    const loose = arms(
      reader.slice(reader.indexOf('case "$raw" in', reader.indexOf('return 0', strictAt))),
    );

    expect(strict.truthy).toEqual(['true']);
    expect(strict.falsy).toEqual(['false']);
    expect(loose.truthy).toEqual(['1', 'true', 'yes']);
    expect(loose.falsy).toEqual(['0', 'false', 'no']);
    expect([...loose.truthy, ...loose.falsy].sort()).toEqual(accepted.sort());
  });

  it('attributes each setting to the entrypoint that actually reads it', () => {
    // `status` names the owning process per line, and a wrong name is a wrong
    // instruction: an operator asking "which container has to restart" acts on it.
    // Bound to the source rather than to a comment — `PANEL_MONITOR_ENABLED` is
    // read by main.monitor.ts, the webhook flag by app.module.ts which only the
    // api serves, and the rest by main.worker.ts.
    const readers: Record<string, string> = {
      worker: readFileSync(join(__dirname, '../../apps/api/src/main.worker.ts'), 'utf8'),
      monitor: readFileSync(join(__dirname, '../../apps/api/src/main.monitor.ts'), 'utf8'),
    };
    for (const { key, owner } of reported) {
      if (owner === 'api') {
        // The api is the only role that serves HTTP, so a flag gating a route or a
        // module belongs to it — and must NOT be read by either loop entrypoint.
        expect(readers.worker, `${key} is read by the worker, not only the api`).not.toContain(key);
        expect(readers.monitor, `${key} is read by the monitor, not only the api`).not.toContain(
          key,
        );
        continue;
      }
      expect(readers[owner], `${owner} does not read ${key}`).toContain(key);
    }
  });

  it('treats an EMPTY assignment as invalid, which is what the schema does', () => {
    // The reader's rule, checked against the thing it is a second implementation
    // of. Zod applies `.default()` to an UNDEFINED value, and an environment
    // variable is a string — so `KEY=` arrives as '' and is refused, by the enum
    // and by `booleanish` alike. A reader that mapped it to the default reported a
    // healthy value for a file the next start rejects.
    const base = {
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      REDIS_URL: 'redis://h:6379',
      SECRETS_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
      SECRETS_ACTIVE_KEY_ID: 'k1',
      DEPLOYMENT_TOPOLOGY: 'direct',
    };
    // Absent: accepted, and defaulted.
    expect(configSchema.safeParse(base).success).toBe(true);
    // Empty: refused, for both vocabularies.
    expect(
      configSchema.safeParse({ ...base, PANEL_MONITOR_ENABLED: '' }).success,
      'an empty enum assignment was accepted',
    ).toBe(false);
    expect(
      configSchema.safeParse({ ...base, BACKUP_SCHEDULE_ENABLED: '' }).success,
      'an empty booleanish assignment was accepted',
    ).toBe(false);
    // And the shell says so by testing PRESENCE before it reads the value.
    expect(lib, 'nexa_env_boolean infers absence from an empty value').toMatch(
      /grep -qE "\^\$\{key\}=" -- "\$file"/,
    );
  });

  it('names the same obsolete keys the upgrade audit does', () => {
    const frozen = /NEXA_OBSOLETE_APP_ENV_KEYS="([^"]*)"/.exec(lib)?.[1] ?? '';
    expect(frozen.split(/\s+/).filter(Boolean).sort()).toEqual([
      'BUILD_COMMIT',
      'BUILD_TIME',
      'BUILD_VERSION',
    ]);
  });
});

describe('the obsolete build keys are detected by provenance, not by presence', () => {
  const lib = readFileSync(join(__dirname, '../../deploy/bin/nexa-lib.sh'), 'utf8');
  const dockerfile = readFileSync(join(__dirname, '../../Dockerfile'), 'utf8');

  it('stamps every obsolete key into the RUNTIME image, which is the premise', () => {
    // The fact the whole check rests on, and the one a presence check got wrong.
    //
    // These three keys are where the release's identity is SUPPOSED to come from:
    // the runtime stage puts them in the image's own ENV, so every correctly built
    // container carries all three. A `botctl status` that warned whenever they were
    // present therefore warned on every healthy installation, and the restart it
    // advised recreated the same image environment — so the warning could never
    // clear.
    //
    // Pinned here because the shell can only be tested against a fake docker, and a
    // fake is free to model an image that stamps nothing. If a future change moved
    // the identity out of the image, the provenance comparison would be comparing
    // two empty strings and this test is what says so.
    const frozen = /NEXA_OBSOLETE_APP_ENV_KEYS="([^"]*)"/.exec(lib)?.[1] ?? '';
    const keys = frozen.split(/\s+/).filter(Boolean);
    expect(keys.length).toBe(3);
    // The RUNTIME stage, not the builder: an ENV in an earlier stage reaches no
    // container. Everything from the last `FROM` onwards.
    const stages = dockerfile.split(/^FROM .*$/m);
    const runtime = stages[stages.length - 1] ?? '';
    expect(runtime, 'the runtime stage was not found').toContain('CMD ["node", "dist/main.js"]');
    for (const key of keys) {
      expect(
        new RegExp(`(^|\\n)\\s*(ENV\\s+)?${key}=\\$\\{${key}\\}`).test(runtime),
        `the runtime image does not stamp ${key}, so nothing can be compared against it`,
      ).toBe(true);
    }
    // And the production compose file sets none of them, so `nexa.env` is the only
    // thing that can override the image. If compose gained a BUILD_* line the
    // provenance check would report every container as overridden — truthfully, but
    // for a reason no operator could act on with a restart.
    const compose = readFileSync(join(__dirname, '../../deploy/compose.yml'), 'utf8');
    for (const key of keys) {
      expect(compose, `deploy/compose.yml sets ${key}, which would mask the image`).not.toContain(
        key,
      );
    }
  });

  it('compares the container against its image rather than asking whether a value exists', () => {
    // The rule in the shell, asserted as a rule: both halves are read and the
    // decision is the comparison. A reader that kept only one half is the presence
    // check this replaced.
    const fn = /nexa_container_overridden_obsolete_keys\(\) \{[\s\S]*?\n\}/.exec(lib)?.[0] ?? '';
    expect(fn, 'nexa_container_overridden_obsolete_keys is gone').not.toBe('');
    expect(fn, 'the container half is not read').toContain('nexa_inspect_env container');
    expect(fn, 'the image half is not read').toContain('nexa_inspect_env image');
    expect(fn, 'the decision is not a comparison of the two').toMatch(
      /\[ "\$running" = "\$stamped" \]/,
    );
    // THREE lookups can fail, and each must stop the report: a provenance that could
    // not be computed is not an override, and the restart it would advise would not
    // change the answer. A guard covering only the image id was the defect in the
    // previous revision — a failed `image inspect` made every stamped value read as
    // empty, so all three keys looked overridden on every host.
    expect(fn, 'a missing image id does not stop the report').toMatch(
      /\[ -n "\$image" \] \|\| return 0/,
    );
    expect(fn, 'a failed container inspect does not stop the report').toMatch(
      /running_env="\$\(nexa_inspect_env container "\$id"\)" \|\| return 0/,
    );
    expect(fn, 'a failed image inspect does not stop the report').toMatch(
      /stamped_env="\$\(nexa_inspect_env image "\$image"\)" \|\| return 0/,
    );
    // And the per-key reads come out of those listings rather than re-inspecting,
    // which is what makes one checked status cover every key.
    expect(fn, 'the keys are not read out of the already-checked listings').toContain(
      'nexa_env_listing_value',
    );
  });

  it('validates what COMPOSE produces, not what the file literally says', () => {
    // Two stages, because that is what a deployed installation is: the application
    // never reads `nexa.env`, it reads what Compose made of it. The shell reader is
    // the first stage and `configSchema` is the second, and a rule that skipped
    // either was wrong in a different direction in each of the last two rounds.
    //
    // What this case pins is stage two plus the wiring. Stage one — Compose's own
    // resolution — is pinned in `tests/deploy/botctl.test.sh`, against expectations
    // taken from `docker compose config` on Compose v5.1.1 rather than from reading
    // the documentation.
    const base = {
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      REDIS_URL: 'redis://h:6379',
      SECRETS_KEYS: `k1:${Buffer.alloc(32, 9).toString('base64')}`,
      SECRETS_ACTIVE_KEY_ID: 'k1',
      DEPLOYMENT_TOPOLOGY: 'direct',
    };
    // INTERNAL whitespace survives Compose, reaches `booleanish` — a bare enum with
    // no `.trim()` — and is refused. So the reader must refuse it too, and a version
    // that normalised it reported a working schedule for a file the next start
    // rejects.
    for (const spelling of ['t rue', 'tr ue', 'fa lse']) {
      expect(
        configSchema.safeParse({ ...base, BACKUP_SCHEDULE_ENABLED: spelling }).success,
        `booleanish accepted [${spelling}]`,
      ).toBe(false);
      expect(
        configSchema.safeParse({ ...base, PANEL_MONITOR_ENABLED: spelling }).success,
        `the strict enum accepted [${spelling}]`,
      ).toBe(false);
    }
    // An empty assignment is refused and an absent key is defaulted, which is why
    // presence is tested separately from the value.
    expect(configSchema.safeParse({ ...base, PANEL_MONITOR_ENABLED: '' }).success).toBe(false);
    expect(configSchema.safeParse(base).success).toBe(true);
    // The exact spellings parse, so the schema is strict about whitespace rather than
    // about everything.
    expect(configSchema.safeParse({ ...base, BACKUP_SCHEDULE_ENABLED: 'true' }).success).toBe(true);
    expect(configSchema.safeParse({ ...base, PANEL_MONITOR_ENABLED: 'false' }).success).toBe(true);
    // And the wiring: the reader's first stage is the Compose resolver, not the raw
    // line. `nexa_env_value` there would refuse ` true `, which Compose trims and the
    // application accepts — crying wolf about a working file.
    const fn = /nexa_env_boolean\(\) \{[\s\S]*?\n\}/.exec(lib)?.[0] ?? '';
    expect(fn, 'nexa_env_boolean is gone').not.toBe('');
    expect(fn, 'nexa_env_boolean does not resolve the value the way Compose does').toContain(
      'nexa_compose_env_value',
    );
    expect(fn, 'nexa_env_boolean still reads the raw line').not.toMatch(/raw="\$\(nexa_env_value /);
    expect(fn, 'nexa_env_boolean normalises whitespace out of the value').not.toMatch(
      /raw="\$\{raw\/\/\[\[:space:\]\]\/\}"/,
    );
  });

  it('reads nexa.env through the Compose resolver everywhere, not only in status', () => {
    // `nexa.env` is the file operators edit and the file the application consumes, so
    // every read of it has to agree with what the container receives. The two reads
    // that make this more than tidiness are in `botctl secrets migrate-config`, which
    // carries SECRETS_KEK_ID and SECRETS_KEK INTO the file it rewrites: reading them
    // as the file spells them would write an active key id with a comment in it and a
    // SECRETS_KEYS entry the base64 refinement refuses at boot — a conversion that
    // leaves an installation unable to decrypt anything.
    const botctl = readFileSync(join(__dirname, '../../deploy/bin/botctl'), 'utf8');
    const raw = [...botctl.matchAll(/nexa_env_value "\$file"[^\n]*/g)].map((m) => m[0]);
    expect(raw, `these nexa.env reads bypass the Compose resolver: ${raw.join(' | ')}`).toEqual([]);
    // And the reads that matter are there, so this is not satisfied by a file that
    // stopped reading nexa.env altogether.
    expect(botctl).toContain('nexa_compose_env_value "$file" SECRETS_KEK_ID');
    expect(botctl).toContain('nexa_compose_env_value "$file" SECRETS_KEK ');
    expect(botctl).toMatch(
      /nexa_compose_env_value "\$file" BACKUP_SCHEDULE_ENABLED|nexa_env_boolean/,
    );
    // `/etc/os-release` is deliberately NOT a Compose file and keeps the raw reader.
    const install = readFileSync(join(__dirname, '../../deploy/install.sh'), 'utf8');
    expect(install, 'os-release stopped using the raw reader').toContain(
      'nexa_env_value /etc/os-release',
    );
  });

  it('names every process that delivers a backup, not the worker alone', () => {
    // The delivery line's owner label, bound to the call sites rather than to a
    // belief about them. One `BackupService` is built in `createContainer` and every
    // role gets it, so the destination is the worker's, the API's and the recovery
    // executor's — and after a service-specific recreation those three can hold
    // different ones.
    const root = join(__dirname, '../../apps/api/src');
    const container = readFileSync(join(root, 'container.ts'), 'utf8');
    expect(container, 'the delivery credentials are not built in createContainer').toMatch(
      /new TelegramBackupDelivery\(\{[\s\S]*?BACKUP_TELEGRAM_BOT_TOKEN/,
    );
    const admin = readFileSync(
      join(root, 'modules/platform/recovery/application/backup-admin.service.ts'),
      'utf8',
    );
    expect(admin, 'the Web Admin manual run does not use BackupService').toContain('BackupService');
    const executor = readFileSync(
      join(root, 'modules/platform/recovery/application/recovery-executor.ts'),
      'utf8',
    );
    expect(executor, 'the recovery executor does not use BackupService').toContain('BackupService');
    // So the label says so.
    const botctl = readFileSync(join(__dirname, '../../deploy/bin/botctl'), 'utf8');
    expect(botctl, 'the delivery line still names the worker alone').toMatch(
      /backup delivery[^\n]*'worker, api, recovery'/,
    );
    // The schedule, by contrast, IS the worker's: it gates the scheduler there and
    // nowhere else. A label that named everything would carry no information.
    const worker = readFileSync(join(root, 'main.worker.ts'), 'utf8');
    expect(worker).toContain('BACKUP_SCHEDULE_ENABLED');
    expect(
      readFileSync(join(root, 'main.monitor.ts'), 'utf8'),
      'the monitor reads the backup schedule',
    ).not.toContain('BACKUP_SCHEDULE_ENABLED');
  });
});
