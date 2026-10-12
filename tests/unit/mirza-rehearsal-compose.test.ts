import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { ProviderHttpClient, ProviderTarget } from '@nexa/contracts';
import { configSchema } from '../../apps/api/src/infrastructure/config/config.schema';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { RickpanelAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel.adapter';
import {
  RickpanelInventoryReader,
  readOnlyRickpanelHttp,
} from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel-inventory';

/**
 * The isolated Mirza → NEXA rehearsal kit (`deploy/rehearsal/`,
 * `docs/legacy-migration/nxpkg-real-rehearsal.md`). Each isolation rule the compose file's
 * header states is read back here, so a change that quietly gives a NEXA process a route
 * out, starts the provisioner, or publishes a port on another interface fails the suite.
 */

const root = join(__dirname, '../..');
const rehearsal = join(root, 'deploy/rehearsal');
type Service = Record<string, unknown> & {
  networks?: unknown;
  profiles?: string[];
  ports?: string[];
};
const overlay = parse(
  readFileSync(join(rehearsal, 'compose.mirza-rehearsal.yml'), 'utf8'),
  // `!override` is a Compose tag; read it as the plain sequence it wraps.
  { customTags: [{ tag: '!override', collection: 'seq', resolve: (v: unknown) => v }] },
) as {
  name: string;
  services: Record<string, Service>;
  networks: Record<string, { internal?: boolean }>;
};
const production = parse(readFileSync(join(root, 'deploy/compose.yml'), 'utf8')) as {
  services: Record<string, Service>;
  networks: Record<string, { internal?: boolean }>;
};

const networksOf = (service: Service | undefined): string[] => {
  const n = service?.networks;
  if (Array.isArray(n)) return (n as unknown[]).map(String);
  if (n !== null && typeof n === 'object') return Object.keys(n);
  return [];
};
/** The overlay's value when it states one, the production file's otherwise. */
const effectiveNetworks = (name: string): string[] =>
  overlay.services[name]?.networks !== undefined
    ? networksOf(overlay.services[name])
    : networksOf(production.services[name]);
const internal = (name: string): boolean =>
  (overlay.networks[name] ?? production.networks[name])?.internal === true;

describe('the rehearsal compose overlay', () => {
  it('runs as its own Compose project', () => {
    expect(overlay.name).toBe('nexa-mirza-rehearsal');
  });

  it('no NEXA process has a network with a route out', () => {
    for (const service of ['api', 'worker', 'migration']) {
      const networks = effectiveNetworks(service);
      expect(networks.length, service).toBeGreaterThan(0);
      expect(networks, service).not.toContain('edge');
      for (const network of networks) expect(internal(network), `${service}/${network}`).toBe(true);
    }
    // The worker (notification delivery) is on the database network alone.
    expect(effectiveNetworks('worker')).toEqual(['data']);
  });

  it('the roles that act outside NEXA never start', () => {
    for (const service of ['provisioner', 'monitor', 'assistant', 'recovery']) {
      expect(overlay.services[service]?.profiles, service).toEqual(['never-in-rehearsal']);
    }
  });

  it('only Caddy publishes a port, on 127.0.0.1', () => {
    const published = Object.entries(overlay.services).filter(([, s]) => s.ports !== undefined);
    expect(published.map(([name]) => name)).toEqual(['caddy']);
    for (const port of overlay.services['caddy']?.ports ?? []) {
      expect(String(port)).toMatch(/^127\.0\.0\.1:/u);
    }
    // No other rehearsal-only service publishes anything either.
    for (const name of ['migration', 'rickpanel-standin']) {
      expect(overlay.services[name]?.ports, name).toBeUndefined();
    }
  });

  it('the migration role is the production image, command and heartbeat', () => {
    const migration = overlay.services['migration'] as Record<string, unknown>;
    expect(migration['command']).toEqual(['node', 'dist/main.migration.js']);
    expect(String(migration['image'])).toContain('NEXA_IMAGE');
    expect(migration['cap_drop']).toEqual(['ALL']);
    expect(migration['security_opt']).toEqual(['no-new-privileges:true']);
    const test = JSON.stringify((migration['healthcheck'] as { test: unknown }).test);
    // The same default path the configuration schema gives the role.
    const schemaSource = readFileSync(
      join(root, 'apps/api/src/infrastructure/config/config.schema.ts'),
      'utf8',
    );
    expect(schemaSource).toMatch(
      /LEGACY_MIGRATION_HEARTBEAT_PATH:[^;]*default\('\/tmp\/nexa-migration\.heartbeat'\)/u,
    );
    expect(test).toContain('/tmp/nexa-migration.heartbeat');
    expect(test).toContain('LEGACY_MIGRATION_HEARTBEAT_PATH');
  });

  it('the stand-in is reachable only on the internal panel network, read-only', () => {
    const standin = overlay.services['rickpanel-standin'] as Record<string, unknown>;
    expect(networksOf(standin as Service)).toEqual(['panelsim']);
    expect(standin['read_only']).toBe(true);
    expect(standin['cap_drop']).toEqual(['ALL']);
  });
});

describe('the rehearsal environment template', () => {
  const template = readFileSync(join(rehearsal, 'nexa.env.template'), 'utf8');
  const render = (): Record<string, string> => {
    const filled = template
      .split('__POSTGRES_PASSWORD__')
      .join('r4nd0m-postgres')
      .split('__REDIS_PASSWORD__')
      .join('r4nd0m-redis')
      .split('__SECRETS_KEK__')
      .join(Buffer.from('nexa-rehearsal-template-test-key').toString('base64'))
      .split('__SECRETS_ACTIVE_KEY_ID__')
      .join('rehearsal-1')
      .split('__HTTPS_PORT__')
      .join('18443')
      .split('__FRONT_SUBNET__')
      .join('172.30.242.0/24');
    const env: Record<string, string> = {};
    for (const line of filled.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      expect(eq, trimmed).toBeGreaterThan(0);
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return env;
  };

  it('parses through the application configuration schema, as production', () => {
    const result = configSchema.safeParse(render());
    const problems = result.success
      ? []
      : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(problems).toEqual([]);
    expect(Object.values(render()).join('\n')).not.toMatch(/__[A-Z_]+__/u);
  });

  it('switches off everything that leaves the process, and on the migration', () => {
    const config = configSchema.parse(render());
    expect(config.NODE_ENV).toBe('production');
    expect(config.TELEGRAM_WEBHOOK_ENABLED).toBe(false);
    expect(config.NOTIFICATION_DISPATCH_ENABLED).toBe(false);
    expect(config.BACKUP_TELEGRAM_BOT_TOKEN).toBe('');
    expect(config.BACKUP_TELEGRAM_CHAT_ID).toBe('');
    expect(config.BACKUP_SCHEDULE_ENABLED).toBe(false);
    expect(config.PANEL_MONITOR_ENABLED).toBe(false);
    expect(config.PROVISIONER_ENABLED).toBe(false);
    expect(config.RECOVERY_UPLOAD_ENABLED).toBe(false);
    expect(config.LEGACY_MIGRATION_ENABLED).toBe(true);
    expect(config.LEGACY_MIGRATION_RETAIN_PACKAGE).toBe(false);
    expect(config.DATABASE_URL).toMatch(/@postgres:5432\/nexa_mirza_rehearsal$/u);
    expect(config.WEB_ADMIN_ORIGINS).toEqual(['https://localhost:18443']);
  });
});

describe('mirza-rehearsal.sh', () => {
  let work: string;
  let fakeDocker: string;
  let calls: string;
  const script = join(rehearsal, 'mirza-rehearsal.sh');
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        MIRZA_REHEARSAL_DOCKER: fakeDocker,
        MIRZA_REHEARSAL_ETC_NEXA: join(work, 'etc-nexa'),
        MIRZA_REHEARSAL_OPT_NEXA: join(work, 'opt-nexa'),
        FAKE_DOCKER_CALLS: calls,
        ...extra,
      },
    });

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'nexa-mirza-rehearsal-'));
    fakeDocker = join(work, 'docker');
    calls = join(work, 'calls.log');
    // Records every call; `ps -a -q --filter …project=nexa` answers $FAKE_NEXA_PROJECT.
    writeFileSync(
      fakeDocker,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >>"$FAKE_DOCKER_CALLS"\n' +
        'case "$*" in *project=nexa*) printf "%s" "${FAKE_NEXA_PROJECT:-}";; esac\nexit 0\n',
      { mode: 0o755 },
    );
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('init writes a private directory with fresh secrets and prints none of them', () => {
    const dir = join(work, 'r1');
    const out = run(['init', '--dir', dir, '--image', `sha256:${'a'.repeat(64)}`]);
    expect(out.status, out.stderr).toBe(0);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const file of [
      'postgres.env',
      'redis.env',
      'nexa.env',
      'standin.env',
      'migration.env',
      'deploy.env',
    ]) {
      expect(statSync(join(dir, file)).mode & 0o777, file).toBe(0o600);
    }
    const env = readFileSync(join(dir, 'nexa.env'), 'utf8');
    const password = /^POSTGRES_PASSWORD=(.+)$/mu.exec(
      readFileSync(join(dir, 'postgres.env'), 'utf8'),
    )?.[1];
    expect(password).toMatch(/^[A-Za-z0-9]{20,}$/u);
    expect(env).toContain(`postgres://nexa:${String(password)}@postgres:5432/nexa_mirza_rehearsal`);
    expect(env).not.toMatch(/__[A-Z_]+__/u);
    expect(out.stdout).not.toContain(String(password));
    const standin = readFileSync(join(dir, 'standin.env'), 'utf8');
    const standinPassword = /RICKPANEL_STANDIN_PASSWORD=(.+)/u.exec(standin)?.[1] ?? '';
    expect(standinPassword.length).toBeGreaterThanOrEqual(20);
    expect(out.stdout).not.toContain(standinPassword);
    // Two directories never share a secret.
    const second = join(work, 'r2');
    expect(run(['init', '--dir', second]).status).toBe(0);
    expect(readFileSync(join(second, 'nexa.env'), 'utf8')).not.toEqual(env);
    // The rendered configuration is a valid production configuration.
    const parsed: Record<string, string> = {};
    for (const line of env.split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      parsed[line.slice(0, line.indexOf('='))] = line.slice(line.indexOf('=') + 1);
    }
    expect(configSchema.safeParse(parsed).success).toBe(true);
  });

  it('refuses a non-empty directory, a tag, and a host that carries an installation', () => {
    const used = join(work, 'used');
    mkdirSync(used);
    writeFileSync(join(used, 'x'), 'x');
    expect(run(['init', '--dir', used]).status).not.toBe(0);
    expect(run(['init', '--dir', join(work, 'tag'), '--image', 'nexa:latest']).status).not.toBe(0);

    mkdirSync(join(work, 'etc-nexa'));
    const refused = run(['init', '--dir', join(work, 'r3')]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/separate machine/u);
    rmSync(join(work, 'etc-nexa'), { recursive: true });

    const project = run(['init', '--dir', join(work, 'r4')], { FAKE_NEXA_PROJECT: 'abc123' });
    expect(project.status).not.toBe(0);
    expect(project.stderr).toMatch(/project named 'nexa'/u);
  });

  it('always names its own project and both compose files, and never removes a volume', () => {
    const dir = join(work, 'r1');
    writeFileSync(calls, '');
    expect(run(['down', '--dir', dir]).status).toBe(0);
    const logged = readFileSync(calls, 'utf8');
    expect(logged).toContain('compose -p nexa-mirza-rehearsal --env-file');
    expect(logged).toContain('deploy/compose.yml -f');
    expect(logged).toContain('deploy/rehearsal/compose.mirza-rehearsal.yml down');
    expect(logged).not.toMatch(/down.*(-v|--volumes)/u);
    expect(readFileSync(script, 'utf8')).not.toMatch(/(down|rm)\s+(-v|--volumes)|volume rm/u);
  });

  it('set-target-ack accepts only the 16-hex acknowledgement', () => {
    const dir = join(work, 'r1');
    expect(run(['set-target-ack', '--dir', dir, 'not-an-ack']).status).not.toBe(0);
    expect(readFileSync(join(dir, 'migration.env'), 'utf8')).not.toContain('=not');
  });
});

describe('the read-only RickPanel stand-in, against NEXA’s own RickPanel code', () => {
  let child: ReturnType<typeof spawn>;
  let base: string;
  const lines: Record<string, unknown>[] = [];
  const target = (): ProviderTarget => ({
    baseUrl: base,
    credentials: {
      shape: 'USERNAME_PASSWORD',
      username: 'rehearsal-admin',
      password: 'a-rehearsal-password-1234',
    },
  });
  const client = (): ProviderHttpClient =>
    new SafeHttpClient({
      allowLoopback: true,
      totalTimeoutMs: 2_000,
      maxResponseBytes: 512 * 1024,
      maxRetries: 0,
    }).forBase(base);

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexa-standin-'));
    const inventory = join(dir, 'inventory.json');
    writeFileSync(
      inventory,
      JSON.stringify({
        users: [
          { username: 'alpha1', status: 'active', expire: null, data_limit: null },
          { username: 'beta2', status: 'disabled', expire: null, data_limit: null },
        ],
      }),
    );
    child = spawn(process.execPath, [join(rehearsal, 'rickpanel-standin.mjs')], {
      env: {
        RICKPANEL_STANDIN_PORT: '0',
        RICKPANEL_STANDIN_HOST: '127.0.0.1',
        RICKPANEL_STANDIN_USERNAME: 'rehearsal-admin',
        RICKPANEL_STANDIN_PASSWORD: 'a-rehearsal-password-1234',
        RICKPANEL_STANDIN_INVENTORY: inventory,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let buffer = '';
    base = await new Promise<string>((resolve, reject) => {
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let at = buffer.indexOf('\n');
        while (at !== -1) {
          const line = JSON.parse(buffer.slice(0, at)) as Record<string, unknown>;
          buffer = buffer.slice(at + 1);
          lines.push(line);
          if (line['event'] === 'listening') {
            resolve(`http://127.0.0.1:${String(line['port'])}`);
          }
          at = buffer.indexOf('\n');
        }
      });
      child.on('exit', () => reject(new Error('the stand-in exited')));
    });
  });
  afterAll(() => {
    child.kill('SIGTERM');
  });

  it('passes NEXA’s connection test (the probe)', async () => {
    const outcome = await new RickpanelAdapter().probe(target(), client());
    expect(outcome.ok).toBe(true);
  });

  it('serves the inventory to NEXA’s read-only inventory reader, complete', async () => {
    const outcome = await new RickpanelInventoryReader().listAll(
      target(),
      readOnlyRickpanelHttp(client()),
      { pageSize: 1 },
    );
    expect(outcome.ok && outcome.complete).toBe(true);
    if (outcome.ok && outcome.complete) {
      expect(outcome.accounts.map((a) => a.username).sort()).toEqual(['alpha1', 'beta2']);
    }
  });

  it('refuses and counts every write, and never logs a credential', async () => {
    const auth = await fetch(`${base}/api/admin/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=rehearsal-admin&password=a-rehearsal-password-1234&grant_type=password',
    });
    const token = ((await auth.json()) as { access_token: string }).access_token;
    const bearer = { authorization: `Bearer ${token}` };
    for (const [method, path] of [
      ['POST', '/api/user'],
      ['PUT', '/api/user/alpha1'],
      ['DELETE', '/api/user/alpha1'],
      ['POST', '/api/user/alpha1/reset'],
      ['POST', '/api/user/alpha1/revoke_sub'],
    ] as const) {
      const answer = await fetch(`${base}${path}`, { method, headers: bearer, body: '{}' });
      expect(answer.status, `${method} ${path}`).toBe(405);
    }
    // The account is still there, unchanged.
    const read = await fetch(`${base}/api/user/alpha1`, { headers: bearer });
    expect(await read.json()).toMatchObject({ username: 'alpha1', status: 'active' });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const refused = lines.filter((l) => l['kind'] === 'refused');
    expect(refused.length).toBe(5);
    const all = JSON.stringify(lines);
    expect(all).not.toContain('a-rehearsal-password-1234');
    expect(all).not.toContain(token);
  });
});
