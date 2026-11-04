#!/usr/bin/env node
// NEXA load harness. One command:
//
//   node scripts/load/run.mjs --database-url postgres://nexa:nexa@127.0.0.1:5432/nexa_test_load
//
// Starts a local Telegram Bot API stub, seeds N tenants (+ a 50k-customer broadcast audience on
// the installation tenant) into the named LOAD/TEST database, starts the real API and worker
// processes from apps/api/dist, drives M virtual customers per tenant through the real webhook
// route (/start, menu taps, the buy flow up to the pre-invoice, the wallet screen), launches
// ONE broadcast to the whole audience through the admin API, runs the real `backup run` at the
// same time, samples CPU / RAM / Postgres / pool / queue lag every second, and writes
// results.json + results.md. `--mode ramp` raises the concurrency until p95 > 1 s or errors > 1 %.
//
// Not part of `pnpm verify` or CI. See scripts/load/README.md.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  createWriteStream,
  statSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  API_PREFIX,
  AUTH_ROUTES,
  BROADCAST_ROUTES,
  TELEGRAM_SECRET_TOKEN_HEADER,
} from '@nexa/contracts';
import { startTelegramStub } from './telegram-stub.mjs';
import {
  latencySummary,
  makeClient,
  parseArgs,
  pidsByName,
  ProcGroup,
  readSystem,
  seriesSummary,
  sleep,
} from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

const SPEC = {
  'database-url': { type: 'string', default: process.env.LOAD_DATABASE_URL ?? '' },
  tenants: { type: 'number', default: 50 },
  customers: { type: 'number', default: 2 }, // concurrent virtual customers PER TENANT
  duration: { type: 'number', default: 120 }, // steady mode: measured seconds
  warmup: { type: 'number', default: 15 },
  'think-ms': { type: 'number', default: 1000 }, // mean pause between a customer's taps
  mode: { type: 'string', default: 'steady' }, // steady | ramp
  'ramp-start': { type: 'number', default: 25 }, // TOTAL concurrent virtual customers at the first stage (spread round-robin over the tenants)
  'ramp-step': { type: 'number', default: 25 },
  'ramp-stage': { type: 'number', default: 30 }, // seconds per stage
  'ramp-max': { type: 'number', default: 1000 },
  'p95-limit-ms': { type: 'number', default: 1000 },
  'error-limit': { type: 'number', default: 0.01 },
  audience: { type: 'number', default: 50_000 }, // broadcast recipients on the installation tenant; 0 = no broadcast
  'broadcast-at': { type: 'number', default: 5 }, // seconds after the warm-up
  'no-backup': { type: 'boolean', default: false },
  'backup-at': { type: 'number', default: 10 },
  'backup-cmd': { type: 'string', default: 'auto' }, // auto | cli | pg_dump
  'backup-loop': { type: 'boolean', default: false }, // repeat back to back (default in ramp mode)
  'stub-latency-ms': { type: 'number', default: 40 },
  'stub-port': { type: 'number', default: 0 },
  'api-port': { type: 'number', default: 13_000 },
  'pool-max': { type: 'number', default: 0 }, // DATABASE_POOL_MAX for the spawned API/worker; 0 = the application default
  'skip-setup': { type: 'boolean', default: false }, // reuse <out>/../fixture.json from an earlier run on this database
  fixture: { type: 'string', default: '' },
  'api-url': { type: 'string', default: '' }, // an API that is already running: nothing is spawned
  docker: { type: 'string', default: '' }, // comma list of containers to sample with `docker stats`
  'out-dir': { type: 'string', default: '' },
  label: { type: 'string', default: 'run' },
  'keep-running': { type: 'boolean', default: false },
};

const args = parseArgs(process.argv.slice(2), SPEC);
const log = (message) =>
  process.stderr.write(`[load ${new Date().toISOString().slice(11, 19)}] ${message}\n`);

// ------------------------------------------------------------------------------ guards

if (args['database-url'] === '') {
  throw new Error(
    '--database-url is required (or LOAD_DATABASE_URL): the load harness writes to the database you name, and only to one named explicitly.',
  );
}
const databaseName = decodeURIComponent(new URL(args['database-url']).pathname.replace(/^\//, ''));
if (!/(^|[_-])(load|test)/i.test(databaseName)) {
  throw new Error(
    `refusing database "${databaseName}": the harness resets, seeds and loads it. Its name must contain a word starting "load" or "test" (nexa_load, nexa_test_1).`,
  );
}
if (!['steady', 'ramp'].includes(args.mode)) throw new Error('--mode is steady or ramp');
const spawnLocal = args['api-url'] === '';
if (spawnLocal) {
  for (const entry of ['main.js', 'main.worker.js', 'backup.cli.js']) {
    if (!existsSync(resolve(root, 'apps/api/dist', entry))) {
      throw new Error(
        `apps/api/dist/${entry} is missing: run \`pnpm build\` first (the harness runs the compiled API, as production does).`,
      );
    }
  }
}

const startedAt = new Date();
const outDir = resolve(
  args['out-dir'] ||
    resolve(root, 'load-results', `${startedAt.toISOString().replace(/[:.]/g, '-')}-${args.label}`),
);
mkdirSync(outDir, { recursive: true });
const fixturePath = resolve(args.fixture || resolve(outDir, 'fixture.json'));

// A throwaway keyring and webhook secret, fixed so a fixture seeded by one run opens in the next.
// They protect nothing: the database is a load-test database holding fabricated tokens.
const LOAD_KEK = createHash('sha256').update('nexa-load-harness-throwaway-key').digest('base64');
const WEBHOOK_MASTER = 'nexa-load-harness-webhook-secret-0123456789';

// ------------------------------------------------------------------------------ stub

const stub = await startTelegramStub({
  latencyMs: args['stub-latency-ms'],
  jitterMs: Math.round(args['stub-latency-ms'] / 2),
  port: args['stub-port'],
});
log(
  `telegram stub on ${stub.url} (latency ${args['stub-latency-ms']} ms) — no request leaves this machine`,
);

const baseEnv = {
  ...process.env,
  NODE_ENV: 'development',
  LOG_LEVEL: 'warn',
  DATABASE_URL: args['database-url'],
  TEST_DATABASE_URL: args['database-url'],
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  SECRETS_KEK: LOAD_KEK,
  SECRETS_KEK_ID: 'load-1',
  TELEGRAM_WEBHOOK_ENABLED: 'true',
  TELEGRAM_WEBHOOK_SECRET: WEBHOOK_MASTER,
  TELEGRAM_API_BASE_URL: stub.url,
  DEPLOYMENT_TOPOLOGY: 'direct',
  PASSWORD_HASH_PROFILE: 'fast',
  API_HOST: '127.0.0.1',
  API_PORT: String(args['api-port']),
  BACKUP_WORK_DIR: resolve(outDir, 'backup-work'),
  ...(args['pool-max'] > 0 ? { DATABASE_POOL_MAX: String(args['pool-max']) } : {}),
};
mkdirSync(baseEnv.BACKUP_WORK_DIR, { recursive: true });
const apiUrl = spawnLocal
  ? `http://127.0.0.1:${args['api-port']}`
  : args['api-url'].replace(/\/$/, '');

// ------------------------------------------------------------------------------ setup

if (!args['skip-setup']) {
  log(
    `seeding ${args.tenants} tenants and ${args.audience} audience customers into ${databaseName} (this resets the database)`,
  );
  const t0 = Date.now();
  execFileSync(
    resolve(root, 'apps/api/node_modules/.bin/tsx'),
    [
      resolve(here, 'setup.mts'),
      '--tenants',
      String(args.tenants),
      '--audience',
      String(args.audience),
      '--out',
      fixturePath,
    ],
    { env: baseEnv, stdio: ['ignore', 'inherit', 'inherit'], cwd: root },
  );
  log(`seeded in ${Math.round((Date.now() - t0) / 1000)} s`);
}
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
if (fixture.database !== databaseName)
  throw new Error(`fixture is for database ${fixture.database}, not ${databaseName}`);
if (fixture.tenants.length < args.tenants)
  throw new Error(
    `fixture holds ${fixture.tenants.length} tenants, --tenants asks ${args.tenants}`,
  );
const tenants = fixture.tenants.slice(0, args.tenants);

// ------------------------------------------------------------------------------ processes

const children = new Map(); // role -> ChildProcess
const probeFiles = new Map();
function startRole(role, entry) {
  const probeFile = resolve(outDir, `pool-${role}.json`);
  probeFiles.set(role, probeFile);
  const logStream = createWriteStream(resolve(outDir, `${role}.log`));
  const child = spawn(
    process.execPath,
    ['--import', resolve(here, 'pool-probe.mjs'), resolve(root, 'apps/api/dist', entry)],
    {
      env: { ...baseEnv, LOAD_PROBE_FILE: probeFile, LOAD_PROBE_ROLE: role },
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  children.set(role, child);
  child.on('exit', (code) => log(`${role} exited with ${code}`));
  return child;
}

async function waitReady(url, seconds) {
  const probe = makeClient(url, { timeoutMs: 3000 });
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const r = await probe.request('/health/ready', { method: 'GET' });
    if (r.status === 200) {
      probe.close();
      return;
    }
    await sleep(500);
  }
  probe.close();
  throw new Error(`${url} was not ready within ${seconds} s`);
}

async function shutdownAll() {
  for (const child of children.values()) child.kill('SIGTERM');
  await Promise.race([
    sleep(8000),
    Promise.all(
      [...children.values()].map(
        (c) => new Promise((r) => (c.exitCode !== null ? r() : c.once('exit', r))),
      ),
    ),
  ]);
  for (const child of children.values()) if (child.exitCode === null) child.kill('SIGKILL');
}

let sampler = null;
let pgClient = null;
const cleanup = async () => {
  sampler?.stop();
  if (spawnLocal && !args['keep-running']) await shutdownAll();
  await stub.close().catch(() => undefined);
  await pgClient?.end().catch(() => undefined);
};
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void cleanup().finally(() => process.exit(130));
  });
}

try {
  if (spawnLocal) {
    startRole('api', 'main.js');
    startRole('worker', 'main.worker.js');
    log('starting api + worker (the API takes ~20 s to become ready)');
  }
  await waitReady(apiUrl, 180);
  log('api ready');

  // ---------------------------------------------------------------------------- sampling
  pgClient = new pg.Client({
    connectionString: args['database-url'],
    application_name: 'load-sampler',
  });
  await pgClient.connect();

  const groups = [];
  if (spawnLocal) {
    groups.push(
      new ProcGroup('api', () => (children.get('api')?.pid ? [children.get('api').pid] : [])),
    );
    groups.push(
      new ProcGroup('worker', () =>
        children.get('worker')?.pid ? [children.get('worker').pid] : [],
      ),
    );
  }
  groups.push(new ProcGroup('postgres', () => pidsByName(['postgres'])));
  groups.push(new ProcGroup('redis', () => pidsByName(['redis-server'])));
  groups.push(new ProcGroup('harness', () => [process.pid]));

  const samples = [];
  const waitEvents = new Map();
  const dockerSamples = [];
  let prevSys = readSystem();
  let stopSampling = false;
  let runStartMs = null;

  const QUEUE_SQL = {
    outbox: `SELECT count(*)::int AS depth,
                    coalesce(extract(epoch FROM now() - min(occurred_at)), 0)::float AS oldest_s
               FROM outbox_messages WHERE published_at IS NULL AND exhausted_at IS NULL`,
    notifications: `SELECT count(*)::int AS depth,
                           coalesce(extract(epoch FROM greatest(now() - min(next_attempt_at), interval '0')), 0)::float AS oldest_s
                      FROM notifications WHERE status = 'PENDING'`,
    broadcast: `SELECT state, count(*)::int AS n FROM broadcast_recipients GROUP BY state`,
  };
  const ACTIVITY_SQL = `SELECT count(*)::int AS total,
        count(*) FILTER (WHERE state = 'active')::int AS active,
        count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_tx,
        count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS lock_waiting,
        count(*) FILTER (WHERE state = 'active' AND wait_event_type IN ('Lock','LWLock','BufferPin','IO','IPC'))::int AS waiting
      FROM pg_stat_activity
     WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()`;
  const EVENTS_SQL = `SELECT wait_event_type, wait_event, count(*)::int AS n FROM pg_stat_activity
     WHERE datname = current_database() AND state = 'active' AND wait_event IS NOT NULL AND pid <> pg_backend_pid()
     GROUP BY 1, 2`;

  const readProbe = (role) => {
    try {
      return JSON.parse(readFileSync(probeFiles.get(role), 'utf8'));
    } catch {
      return null;
    }
  };

  let tick = 0;
  const sampleOnce = async () => {
    const now = Date.now();
    const row = { t: runStartMs === null ? null : Math.round((now - runStartMs) / 100) / 10 };
    for (const group of groups) row[group.name] = group.sample(now);
    const sys = readSystem();
    const dTotal = sys.total - prevSys.total;
    row.system = {
      cpuPct: dTotal > 0 ? Math.round((1 - (sys.idle - prevSys.idle) / dTotal) * 1000) / 10 : null,
      memAvailableMb: Math.round(sys.memAvailableMb),
    };
    prevSys = sys;
    try {
      const a = (await pgClient.query(ACTIVITY_SQL)).rows[0];
      row.db = {
        backends: a.total,
        active: a.active,
        idleInTx: a.idle_in_tx,
        lockWaiting: a.lock_waiting,
        waiting: a.waiting,
      };
      for (const e of (await pgClient.query(EVENTS_SQL)).rows) {
        const key = `${e.wait_event_type}:${e.wait_event}`;
        waitEvents.set(key, (waitEvents.get(key) ?? 0) + e.n);
      }
      if (tick % 2 === 0) {
        const ob = (await pgClient.query(QUEUE_SQL.outbox)).rows[0];
        const nt = (await pgClient.query(QUEUE_SQL.notifications)).rows[0];
        const bc = Object.fromEntries(
          (await pgClient.query(QUEUE_SQL.broadcast)).rows.map((r) => [r.state, r.n]),
        );
        row.queues = {
          outboxDepth: ob.depth,
          outboxOldestS: Math.round(ob.oldest_s * 10) / 10,
          notificationsPending: nt.depth,
          notificationsOldestS: Math.round(nt.oldest_s * 10) / 10,
          broadcast: bc,
        };
      }
    } catch (error) {
      row.dbError = String(error.message ?? error);
    }
    for (const role of ['api', 'worker']) {
      const p = readProbe(role);
      if (p === null) continue;
      row[`pool_${role}`] = {
        waitingMax: Math.max(0, ...p.pools.map((x) => x.waitingMaxLastSecond)),
        inUse: p.pools.reduce((s, x) => s + (x.total - x.idle), 0),
        total: p.pools.reduce((s, x) => s + x.total, 0),
        max: p.pools.reduce((s, x) => s + (x.max ?? 0), 0),
      };
    }
    tick += 1;
    samples.push(row);
  };
  const samplerLoop = (async () => {
    while (!stopSampling) {
      const t0 = Date.now();
      await sampleOnce();
      await sleep(Math.max(0, 1000 - (Date.now() - t0)));
    }
  })();
  const dockerNames = args.docker
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const dockerLoop = (async () => {
    while (!stopSampling && dockerNames.length > 0) {
      try {
        const out = execFileSync(
          'docker',
          ['stats', '--no-stream', '--format', '{{json .}}', ...dockerNames],
          { encoding: 'utf8' },
        );
        const t = runStartMs === null ? null : Math.round((Date.now() - runStartMs) / 1000);
        for (const line of out.trim().split('\n')) {
          const j = JSON.parse(line);
          const mem = /^([\d.]+)(B|KiB|MiB|GiB)/.exec(j.MemUsage);
          const mb = mem
            ? Number(mem[1]) * { B: 1 / 1048576, KiB: 1 / 1024, MiB: 1, GiB: 1024 }[mem[2]]
            : null;
          dockerSamples.push({ t, name: j.Name, cpuPct: Number.parseFloat(j.CPUPerc), memMb: mb });
        }
      } catch {
        await sleep(2000);
      }
      await sleep(3000);
    }
  })();
  sampler = { stop: () => (stopSampling = true) };

  // ---------------------------------------------------------------------------- load driver
  const client = makeClient(apiUrl, { maxSockets: 4096 });
  const requests = []; // { t (s since runStart), ms, status, kind, stage }
  const mismatches = { count: 0, byStep: {} };
  const journeys = { completed: 0, aborted: 0 };
  let stage = 0;
  let stopping = false;
  const stageOf = () => stage;
  const updateCounters = new Map(tenants.map((t) => [t.tenantId, Date.now()]));
  const now = () => Math.floor(Date.now() / 1000);

  const BUY = /خرید/;
  const WALLET = /کیف پول/;

  async function send(tenant, update, kind) {
    const r = await client.request(`/telegram/webhook/${tenant.botInstanceId}`, {
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: tenant.webhookSecret },
      body: update,
    });
    requests.push({
      t: (Date.now() - runStartMs) / 1000,
      ms: r.ms,
      status: r.status,
      kind,
      stage: stageOf(),
      error: r.error,
    });
    return r;
  }

  class VirtualCustomer {
    constructor(tenant, index) {
      this.tenant = tenant;
      this.id = 800_000_000 + tenant.index * 100_000 + index;
      this.from = { id: this.id, is_bot: false, first_name: 'Load', language_code: 'fa' };
      this.chat = { id: this.id, type: 'private' };
      this.alive = true;
    }
    nextId() {
      const next = updateCounters.get(this.tenant.tenantId) + 1;
      updateCounters.set(this.tenant.tenantId, next);
      return next;
    }
    think() {
      return sleep(args['think-ms'] * (0.5 + Math.random()));
    }
    text(value, kind) {
      const message = {
        message_id: this.nextId() % 2_000_000_000,
        date: now(),
        chat: this.chat,
        from: this.from,
        text: value,
      };
      if (value.startsWith('/'))
        message.entities = [{ type: 'bot_command', offset: 0, length: value.split(' ')[0].length }];
      return send(this.tenant, { update_id: this.nextId(), message }, kind);
    }
    async press(predicate, kind) {
      const rows = stub.keyboardOf(this.id) ?? [];
      const button = rows
        .flat()
        .find((b) => b.callback_data !== undefined && predicate(b.callback_data));
      if (button === undefined) {
        mismatches.count += 1;
        mismatches.byStep[kind] = (mismatches.byStep[kind] ?? 0) + 1;
        return false;
      }
      const message = {
        message_id: this.nextId() % 2_000_000_000,
        date: now(),
        chat: this.chat,
        from: { id: 1, is_bot: true, first_name: 'bot' },
      };
      const r = await send(
        this.tenant,
        {
          update_id: this.nextId(),
          callback_query: {
            id: `cb${this.nextId()}`,
            from: this.from,
            data: button.callback_data,
            message,
          },
        },
        kind,
      );
      return r.status >= 200 && r.status < 300;
    }
    label(pattern, fallbackIndex) {
      const labels = (stub.replyKeyboardOf(this.id) ?? []).flat();
      return (
        labels.find((l) => pattern.test(l)) ??
        labels[fallbackIndex] ??
        (pattern === BUY ? '🛒 خرید اشتراک' : '💰 کیف پول')
      );
    }
    async journey() {
      const steps = [
        () => this.text('/start', 'start'),
        () => this.text(this.label(BUY, 0), 'menu_buy'),
        () => this.press((d) => d.startsWith('ck:'), 'tap_category'),
        () => this.press((d) => d.startsWith('p:'), 'tap_product'),
        () => this.press((d) => d.startsWith('Z:'), 'tap_invoice'), // the pre-invoice screen
        () => this.press((d) => d === 'mm:', 'tap_main_menu'),
        () => this.text(this.label(WALLET, 2), 'menu_wallet'),
        () => this.press((d) => d === 'mm:', 'tap_main_menu'),
      ];
      for (const step of steps) {
        if (!this.alive) return;
        const result = await step();
        if (result === false) {
          journeys.aborted += 1;
          return;
        }
        await this.think();
      }
      journeys.completed += 1;
    }
    async run() {
      await sleep(Math.random() * args['think-ms']); // spread the starts
      while (this.alive && !stopping) await this.journey();
    }
  }

  const customers = [];
  /** Total concurrent virtual customers, added round-robin so the tenants stay within one customer of each other. */
  function growTo(total) {
    while (customers.length < total) {
      const n = customers.length;
      const c = new VirtualCustomer(tenants[n % tenants.length], Math.floor(n / tenants.length));
      customers.push(c);
      void c.run();
    }
  }

  // ---------------------------------------------------------------------------- admin API: the broadcast
  const admin = { cookie: null };
  const broadcast = {
    requested: args.audience > 0,
    steps: {},
    id: null,
    launchedAtS: null,
    error: null,
    finalCounts: null,
  };
  async function adminCall(path, body, method = 'POST') {
    const r = await client.request(`${API_PREFIX}${path}`, {
      method,
      headers: { cookie: admin.cookie ?? '', origin: 'http://load.test' },
      body,
    });
    return r;
  }
  async function launchBroadcast() {
    try {
      const t0 = performance.now();
      const login = await client.request(`${API_PREFIX}${AUTH_ROUTES.login}`, {
        headers: { origin: 'http://load.test' },
        body: { username: fixture.admin.username, password: fixture.admin.password },
      });
      const cookies = [].concat(login.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]);
      if (login.status >= 300 || cookies.length === 0)
        throw new Error(`admin login answered ${login.status}`);
      admin.cookie = cookies.join('; ');
      broadcast.steps.loginMs = Math.round(performance.now() - t0);
      const create = await adminCall(BROADCAST_ROUTES.create, {
        idempotencyKey: `load-broadcast-${Date.now()}`,
        title: 'Load test broadcast',
        contentKind: 'TEXT',
        body: 'Load test broadcast {firstName}',
        buttons: [],
        audience: { version: 1 },
      });
      if (create.status !== 201)
        throw new Error(`create answered ${create.status}: ${create.text.slice(0, 200)}`);
      const draft = JSON.parse(create.text).broadcast;
      broadcast.id = draft.id;
      const tp = performance.now();
      const preview = await adminCall(BROADCAST_ROUTES.preview(draft.id), {});
      if (preview.status >= 300)
        throw new Error(`preview answered ${preview.status}: ${preview.text.slice(0, 200)}`);
      const p = JSON.parse(preview.text).preview;
      broadcast.steps.previewMs = Math.round(performance.now() - tp);
      broadcast.audienceCustomers = p.customers;
      const tl = performance.now();
      const launch = await adminCall(BROADCAST_ROUTES.launch(draft.id), {
        idempotencyKey: `load-launch-${Date.now()}`,
        mode: 'NOW',
        scheduledAt: null,
        expectedVersion: draft.version,
        expectedDefinitionHash: p.definitionHash,
        expectedRecipients: p.customers,
        expectedFingerprint: p.fingerprint,
        confirmed: true,
        typedCount: p.customers >= 1000 ? p.customers : null,
      });
      if (launch.status !== 201)
        throw new Error(`launch answered ${launch.status}: ${launch.text.slice(0, 300)}`);
      broadcast.steps.launchMs = Math.round(performance.now() - tl);
      broadcast.launchedAtS = Math.round((Date.now() - runStartMs) / 100) / 10;
      broadcast.recipientCount = JSON.parse(launch.text).broadcast.recipientCount;
      log(
        `broadcast ${draft.id} launched: ${broadcast.recipientCount} recipients (preview ${broadcast.steps.previewMs} ms, launch ${broadcast.steps.launchMs} ms)`,
      );
    } catch (error) {
      broadcast.error = String(error.message ?? error);
      log(`broadcast FAILED: ${broadcast.error}`);
    }
  }

  // ---------------------------------------------------------------------------- backup
  const backups = [];
  const preexistingVerifyDbs = new Set();
  async function runBackupOnce() {
    const entry = {
      startedAtS: Math.round((Date.now() - runStartMs) / 100) / 10,
      command: null,
      exitCode: null,
      durationS: null,
      substitution: null,
      output: '',
    };
    const t0 = Date.now();
    const mode = args['backup-cmd'];
    const runCli = () =>
      new Promise((resolveRun) => {
        const child = spawn(
          process.execPath,
          [resolve(root, 'apps/api/dist/backup.cli.js'), 'run'],
          { env: baseEnv, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('exit', (code) => resolveRun({ code, out }));
      });
    const runPgDump = () =>
      new Promise((resolveRun) => {
        const file = resolve(baseEnv.BACKUP_WORK_DIR, `pg_dump-${Date.now()}.dump`);
        const child = spawn('pg_dump', ['-Fc', '--dbname', args['database-url'], '--file', file], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stderr.on('data', (d) => (out += d));
        child.on('exit', (code) =>
          resolveRun({
            code,
            out: `${out}\ndump ${existsSync(file) ? statSync(file).size : 0} bytes`,
          }),
        );
      });
    let result;
    if (mode === 'pg_dump') {
      result = await runPgDump();
      entry.command = 'pg_dump -Fc';
      entry.substitution = 'requested: pg_dump instead of `backup run`';
    } else {
      result = await runCli();
      entry.command = 'node apps/api/dist/backup.cli.js run';
      if (result.code !== 0 && mode === 'auto') {
        entry.cliFailure = result.out.slice(-600);
        result = await runPgDump();
        entry.command = 'pg_dump -Fc';
        entry.substitution =
          '`backup run` failed here; pg_dump -Fc of the same database is the closest equivalent';
      }
    }
    entry.exitCode = result.code;
    entry.durationS = Math.round((Date.now() - t0) / 100) / 10;
    entry.output = result.out
      .split('\n')
      .filter((l) => /^(backup|state|dump|archive|verified|delivery|cleanup)\b/.test(l))
      .join('\n');
    backups.push(entry);
    log(`backup finished: ${entry.command} exit=${entry.exitCode} in ${entry.durationS} s`);
  }
  async function dropLeftoverVerifyDatabases() {
    // `backup run` verifies by restoring into a scratch database on the same server; when the
    // cleanup could not drop it (a connection still open) it is left behind. Local runs only.
    try {
      const admin2 = new pg.Client({ connectionString: args['database-url'] });
      await admin2.connect();
      const rows = (
        await admin2.query(`SELECT datname FROM pg_database WHERE datname LIKE 'nexa\\_verify\\_%'`)
      ).rows;
      for (const r of rows)
        if (!preexistingVerifyDbs.has(r.datname))
          await admin2
            .query(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`)
            .catch(() => undefined);
      await admin2.end();
    } catch {
      /* best effort */
    }
  }
  const backupWanted = !args['no-backup'];
  const backupLoop = args['backup-loop'] || args.mode === 'ramp';
  let backupsRunning = Promise.resolve();
  const scheduleBackups = () => {
    if (!backupWanted) return;
    backupsRunning = (async () => {
      await sleep(args['backup-at'] * 1000);
      do {
        if (stopping) break;
        await runBackupOnce();
        await dropLeftoverVerifyDatabases();
        if (backupLoop) await sleep(5000);
      } while (backupLoop && !stopping);
    })();
  };

  // ---------------------------------------------------------------------------- run
  // Other work on this machine (a test run, a build) lands in the numbers: measure how busy it is first.
  const idleBefore = readSystem();
  await sleep(3000);
  const idleAfter = readSystem();
  const noise = {
    cpuBusyPctBeforeStart:
      Math.round(
        (1 - (idleAfter.idle - idleBefore.idle) / (idleAfter.total - idleBefore.total)) * 1000,
      ) / 10,
    loadAvg: os.loadavg(),
  };
  runStartMs = Date.now();
  const stages = []; // ramp: { stage, perTenant, startS, endS }
  const warmupS = args.warmup;
  let breakPoint = null;
  log(`mode=${args.mode}: ${args.tenants} tenants, warm-up ${warmupS} s`);

  if (args.mode === 'steady') {
    growTo(args.customers * tenants.length);
    await sleep(warmupS * 1000);
    const measureStart = (Date.now() - runStartMs) / 1000;
    stages.push({
      stage: 0,
      virtualCustomers: args.customers * tenants.length,
      startS: measureStart,
      endS: null,
    });
    if (broadcast.requested) void sleep(args['broadcast-at'] * 1000).then(launchBroadcast);
    scheduleBackups();
    await sleep(args.duration * 1000);
    stages[0].endS = (Date.now() - runStartMs) / 1000;
  } else {
    if (broadcast.requested)
      void sleep((warmupS + args['broadcast-at']) * 1000).then(launchBroadcast);
    growTo(args['ramp-start']);
    await sleep(warmupS * 1000);
    scheduleBackups();
    for (
      let level = args['ramp-start'], k = 0;
      level <= args['ramp-max'];
      level += args['ramp-step'], k += 1
    ) {
      growTo(level);
      stage = k;
      const stageStart = (Date.now() - runStartMs) / 1000;
      await sleep(args['ramp-stage'] * 1000);
      const stageEnd = (Date.now() - runStartMs) / 1000;
      const settle = stageStart + (stageEnd - stageStart) * 0.25; // the first quarter is the new customers joining
      const mine = requests.filter((r) => r.stage === k && r.t >= settle);
      const ok = mine.filter((r) => r.status >= 200 && r.status < 300);
      const summary = latencySummary(mine.map((r) => r.ms));
      const errorRate = mine.length === 0 ? 0 : (mine.length - ok.length) / mine.length;
      const entry = {
        stage: k,
        virtualCustomers: level,
        startS: stageStart,
        endS: stageEnd,
        requests: mine.length,
        rps: Math.round((mine.length / (stageEnd - settle)) * 10) / 10,
        errorRate,
        latencyMs: summary,
      };
      stages.push(entry);
      log(
        `stage ${k}: ${level} virtual customers p95=${summary.p95} ms err=${(errorRate * 100).toFixed(2)}% rps=${entry.rps}`,
      );
      if ((summary.p95 ?? 0) > args['p95-limit-ms'] || errorRate > args['error-limit']) {
        breakPoint = {
          stage: k,
          virtualCustomers: level,
          reason:
            (summary.p95 ?? 0) > args['p95-limit-ms']
              ? `p95 ${summary.p95} ms > ${args['p95-limit-ms']} ms`
              : `error rate ${(errorRate * 100).toFixed(2)}% > ${args['error-limit'] * 100}%`,
          lastGood: stages.length > 1 ? stages[stages.length - 2].virtualCustomers : null,
        };
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------- wind down
  stopping = true;
  for (const c of customers) c.alive = false;
  const runEndS = (Date.now() - runStartMs) / 1000;
  // A backup that has started is finished and reported, not cut off.
  if (backupWanted) await Promise.race([backupsRunning, sleep(600_000)]);
  await sleep(3000);
  // The broadcast keeps sending at its own pace (20/s per bot) long after the window ends: report where it was.
  stopSampling = true;
  await Promise.all([samplerLoop, dockerLoop]);
  const probeFinal = { api: readProbe('api'), worker: readProbe('worker') };
  const apiLog = spawnLocal ? readFileSync(resolve(outDir, 'api.log'), 'utf8') : '';
  const workerLog = spawnLocal ? readFileSync(resolve(outDir, 'worker.log'), 'utf8') : '';
  client.close();

  // ---------------------------------------------------------------------------- results
  const inWindow = (r) =>
    args.mode === 'steady' ? r.t >= stages[0].startS && r.t <= stages[0].endS : r.t >= warmupS;
  const measured = requests.filter(inWindow);
  const okReq = measured.filter((r) => r.status >= 200 && r.status < 300);
  const byStatus = {};
  for (const r of measured) {
    const key = r.status === 0 ? `network:${r.error ?? 'error'}` : String(r.status);
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }
  const byKind = {};
  for (const kind of [...new Set(measured.map((r) => r.kind))])
    byKind[kind] = latencySummary(measured.filter((r) => r.kind === kind).map((r) => r.ms));
  const windowStart = args.mode === 'steady' ? stages[0].startS : warmupS;
  const windowEnd = args.mode === 'steady' ? stages[0].endS : runEndS;
  const inSamples = samples.filter((s) => s.t !== null && s.t >= windowStart && s.t <= windowEnd);
  const series = (pick) => seriesSummary(inSamples.map(pick));
  const timeline = [];
  for (let t = Math.floor(windowStart / 10) * 10; t < windowEnd; t += 10) {
    const slice = measured.filter((r) => r.t >= t && r.t < t + 10);
    const s = latencySummary(slice.map((r) => r.ms));
    timeline.push({
      fromS: t,
      rps: Math.round((slice.length / 10) * 10) / 10,
      p95: s.p95,
      errors: slice.filter((r) => r.status < 200 || r.status >= 300).length,
    });
  }

  const lastQueues = [...samples].reverse().find((s) => s.queues)?.queues ?? null;
  const queueSeries = (pick) =>
    seriesSummary(inSamples.filter((s) => s.queues).map((s) => pick(s.queues)));
  const bcSent = (q) => q?.broadcast?.SENT ?? 0;
  const bcSamples = inSamples
    .filter((s) => s.queues)
    .map((s) => ({ t: s.t, sent: bcSent(s.queues), pending: s.queues.broadcast?.PENDING ?? 0 }));
  const bcFirst = bcSamples.find((s) => s.sent > 0);
  const bcLast = bcSamples[bcSamples.length - 1];
  const sendRate =
    bcFirst && bcLast && bcLast.t > bcFirst.t
      ? Math.round(((bcLast.sent - bcFirst.sent) / (bcLast.t - bcFirst.t)) * 10) / 10
      : null;

  const poolReport = {};
  for (const role of ['api', 'worker']) {
    const p = probeFinal[role];
    if (p === null) continue;
    const agg = {
      pools: p.pools.length,
      max: p.pools.reduce((s, x) => s + (x.max ?? 0), 0),
      acquires: 0,
      queued: 0,
      waitSumMs: 0,
      waitMaxMs: 0,
      waitingMax: 0,
      hist: new Array(p.bucketsMs.length + 1).fill(0),
    };
    for (const x of p.pools) {
      agg.acquires += x.acquires;
      agg.queued += x.queued;
      agg.waitSumMs += x.waitSumMs;
      agg.waitMaxMs = Math.max(agg.waitMaxMs, x.waitMaxMs);
      agg.waitingMax = Math.max(agg.waitingMax, x.waitingMax);
      x.hist.forEach((n, i) => (agg.hist[i] += n));
    }
    const quantile = (q) => {
      const target = agg.acquires * q;
      let seen = 0;
      for (let i = 0; i < agg.hist.length; i += 1) {
        seen += agg.hist[i];
        if (seen >= target)
          return i < p.bucketsMs.length
            ? `<= ${p.bucketsMs[i]} ms`
            : `> ${p.bucketsMs[p.bucketsMs.length - 1]} ms`;
      }
      return null;
    };
    poolReport[role] = {
      pools: agg.pools,
      maxConnections: agg.max,
      acquires: agg.acquires,
      queuedAcquires: agg.queued,
      queuedShare:
        agg.acquires === 0 ? 0 : Math.round((agg.queued / agg.acquires) * 10_000) / 10_000,
      acquireMeanMs:
        agg.acquires === 0 ? null : Math.round((agg.waitSumMs / agg.acquires) * 100) / 100,
      acquireP95: quantile(0.95),
      acquireP99: quantile(0.99),
      acquireMaxMs: Math.round(agg.waitMaxMs),
      waitingClientsMax: agg.waitingMax,
    };
  }
  const poolTimeouts = (apiLog.match(/timeout exceeded when trying to connect/g) ?? []).length;
  const poolTimeoutsWorker = (workerLog.match(/timeout exceeded when trying to connect/g) ?? [])
    .length;
  const countLog = (text, re) => (text.match(re) ?? []).length;

  const gitSha = (() => {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  })();
  const cgroup = (file) => {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch {
      return null;
    }
  };
  const machine = {
    hostname: os.hostname(),
    kernel: os.release(),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? null,
    memTotalMb: Math.round(os.totalmem() / 1048576),
    cgroupCpuMax: cgroup('/sys/fs/cgroup/cpu.max'),
    cgroupMemoryMax: cgroup('/sys/fs/cgroup/memory.max'),
    node: process.version,
    loadAvgAtEnd: os.loadavg(),
    noiseBeforeStart: noise,
  };

  const results = {
    label: args.label,
    startedAt: startedAt.toISOString(),
    gitSha,
    machine,
    parameters: {
      mode: args.mode,
      tenants: args.tenants,
      customersPerTenant: args.mode === 'steady' ? args.customers : null,
      ramp:
        args.mode === 'ramp'
          ? {
              startVirtualCustomers: args['ramp-start'],
              step: args['ramp-step'],
              stageSeconds: args['ramp-stage'],
              max: args['ramp-max'],
            }
          : null,
      virtualCustomers: args.mode === 'steady' ? args.tenants * args.customers : null,
      durationSeconds: args.mode === 'steady' ? args.duration : null,
      warmupSeconds: warmupS,
      thinkMs: args['think-ms'],
      broadcastAudience: args.audience,
      backup: backupWanted ? (backupLoop ? 'loop' : 'once') : 'off',
      stubLatencyMs: args['stub-latency-ms'],
      databasePoolMax: args['pool-max'] || 'application default',
      database: databaseName,
      apiUrl: spawnLocal ? 'spawned locally (apps/api/dist, NODE_ENV=development)' : apiUrl,
    },
    webhook: {
      requests: measured.length,
      rps: Math.round((measured.length / Math.max(1, windowEnd - windowStart)) * 10) / 10,
      latencyMs: latencySummary(measured.map((r) => r.ms)),
      latencyOkOnlyMs: latencySummary(okReq.map((r) => r.ms)),
      errorRate:
        measured.length === 0
          ? null
          : Math.round(((measured.length - okReq.length) / measured.length) * 100_000) / 100_000,
      errors: measured.length - okReq.length,
      byStatus,
      byStep: byKind,
      flowMismatches: mismatches,
      journeys,
      timeline,
    },
    stages: args.mode === 'ramp' ? stages : undefined,
    breakingPoint:
      args.mode === 'ramp'
        ? (breakPoint ?? {
            reached: false,
            note: `no stage up to ${args['ramp-max']} virtual customers crossed p95 > ${args['p95-limit-ms']} ms or errors > ${args['error-limit'] * 100}%`,
          })
        : undefined,
    resources: {
      api: spawnLocal
        ? { memMb: series((s) => s.api?.memMb), cpuPctOfOneCore: series((s) => s.api?.cpuPct) }
        : null,
      worker: spawnLocal
        ? {
            memMb: series((s) => s.worker?.memMb),
            cpuPctOfOneCore: series((s) => s.worker?.cpuPct),
          }
        : null,
      postgres: {
        memMbPss: series((s) => s.postgres?.memMb),
        cpuPctOfOneCore: series((s) => s.postgres?.cpuPct),
      },
      redis: {
        memMb: series((s) => s.redis?.memMb),
        cpuPctOfOneCore: series((s) => s.redis?.cpuPct),
      },
      loadGenerator: {
        memMb: series((s) => s.harness?.memMb),
        cpuPctOfOneCore: series((s) => s.harness?.cpuPct),
      },
      machine: {
        cpuPctOfAllCores: series((s) => s.system?.cpuPct),
        memAvailableMbMin: Math.min(...inSamples.map((s) => s.system.memAvailableMb)),
      },
      docker:
        dockerNames.length === 0
          ? null
          : Object.fromEntries(
              dockerNames.map((n) => [
                n,
                {
                  memMb: seriesSummary(
                    dockerSamples.filter((d) => d.name === n).map((d) => d.memMb),
                  ),
                  cpuPct: seriesSummary(
                    dockerSamples.filter((d) => d.name === n).map((d) => d.cpuPct),
                  ),
                },
              ]),
            ),
    },
    database: {
      backends: series((s) => s.db?.backends),
      active: series((s) => s.db?.active),
      idleInTransaction: series((s) => s.db?.idleInTx),
      waiting: series((s) => s.db?.waiting),
      lockWaiting: series((s) => s.db?.lockWaiting),
      topWaitEvents: [...waitEvents.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([event, samplesSeen]) => ({ event, activeSessionSamples: samplesSeen })),
      poolFromInsideTheProcesses: poolReport,
      poolCheckoutTimeoutsInApiLog: poolTimeouts,
      poolCheckoutTimeoutsInWorkerLog: poolTimeoutsWorker,
    },
    queues: {
      outboxDepth: queueSeries((q) => q.outboxDepth),
      outboxOldestUnprocessedSeconds: queueSeries((q) => q.outboxOldestS),
      notificationsPending: queueSeries((q) => q.notificationsPending),
      notificationsOldestPendingSeconds: queueSeries((q) => q.notificationsOldestS),
      atEnd: lastQueues,
    },
    broadcast: broadcast.requested
      ? {
          ...broadcast,
          sentWhenTheWindowEnded: bcLast?.sent ?? null,
          pendingWhenTheWindowEnded: bcLast?.pending ?? null,
          measuredSendRatePerSecond: sendRate,
          note: 'The broadcast lane sends at most BROADCAST_SENDS_PER_SECOND (20) per bot (contract constant), so one bot takes audience/20 seconds to finish; the run reports progress at the end of the window, not completion.',
        }
      : null,
    backups,
    logs: spawnLocal
      ? {
          apiErrorLines: countLog(apiLog, /"level":"(error|fatal)"/g),
          apiWarnLines: countLog(apiLog, /"level":"warn"/g),
          workerErrorLines: countLog(workerLog, /"level":"(error|fatal)"/g),
          sampleErrors: [...apiLog.split('\n'), ...workerLog.split('\n')]
            .filter((l) => /"level":"(error|fatal)"/.test(l))
            .slice(0, 5)
            .map((l) => l.slice(0, 300)),
        }
      : null,
    outputDir: outDir,
  };

  writeFileSync(resolve(outDir, 'results.json'), JSON.stringify(results, null, 2));
  writeFileSync(resolve(outDir, 'samples.json'), JSON.stringify(samples));
  writeFileSync(resolve(outDir, 'results.md'), renderMarkdown(results));
  log(`wrote ${resolve(outDir, 'results.md')}`);
  process.stdout.write(`${resolve(outDir, 'results.md')}\n`);
} finally {
  await cleanup();
}
// Timers left by the waits above would hold the process open for minutes.
process.exit(0);

// ------------------------------------------------------------------------------ markdown

function renderMarkdown(r) {
  const f = (v, unit = '') => (v === null || v === undefined ? 'n/a' : `${v}${unit}`);
  const lat = (l) => `${f(l.p50)} / ${f(l.p95)} / ${f(l.p99)} ms (max ${f(l.max)}, n=${l.count})`;
  const m = r.machine;
  const lines = [];
  lines.push(`# Load run: ${r.label}`, '');
  lines.push(
    `- Started ${r.startedAt}, commit \`${r.gitSha ?? 'unknown'}\`, mode **${r.parameters.mode}**`,
  );
  lines.push(
    `- Machine noise before the run started: CPU ${m.noiseBeforeStart.cpuBusyPctBeforeStart} % busy, load average ${m.noiseBeforeStart.loadAvg.map((x) => x.toFixed(2)).join(' ')}`,
  );
  lines.push(
    `- Machine: ${m.cpus} CPUs (${m.cpuModel}), ${m.memTotalMb} MB RAM, kernel ${m.kernel}, Node ${m.node}; cgroup cpu.max=${f(m.cgroupCpuMax)} memory.max=${f(m.cgroupMemoryMax)}`,
  );
  lines.push(
    `- Parameters: ${r.parameters.tenants} tenants x ${r.parameters.ramp ? `a ramp of ${r.parameters.ramp.startVirtualCustomers}..${r.parameters.ramp.max} virtual customers in steps of ${r.parameters.ramp.step} every ${r.parameters.ramp.stageSeconds} s (spread over the tenants)` : `${r.parameters.customersPerTenant} customers`}` +
      (r.parameters.virtualCustomers
        ? ` = ${r.parameters.virtualCustomers} concurrent virtual customers`
        : '') +
      `, think ${r.parameters.thinkMs} ms, warm-up ${r.parameters.warmupSeconds} s` +
      (r.parameters.durationSeconds ? `, measured ${r.parameters.durationSeconds} s` : ''),
  );
  lines.push(
    `- Background: broadcast audience ${r.parameters.broadcastAudience}, backup ${r.parameters.backup}; Telegram stub latency ${r.parameters.stubLatencyMs} ms; DB pool max ${r.parameters.databasePoolMax}; database \`${r.parameters.database}\``,
    '',
  );
  lines.push('## Webhook', '');
  lines.push(
    `- Requests ${r.webhook.requests} (${r.webhook.rps}/s), errors ${r.webhook.errors}, **error rate ${r.webhook.errorRate === null ? 'n/a' : `${(r.webhook.errorRate * 100).toFixed(3)} %`}**`,
  );
  lines.push(`- **Response time p50 / p95 / p99:** ${lat(r.webhook.latencyMs)}`);
  lines.push(
    `- By status: ${Object.entries(r.webhook.byStatus)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`,
  );
  lines.push(
    `- Journeys completed ${r.webhook.journeys.completed}, aborted ${r.webhook.journeys.aborted}; flow mismatches (a button the bot did not draw) ${r.webhook.flowMismatches.count}`,
    '',
  );
  lines.push('| step | p50 | p95 | p99 | n |', '|---|---|---|---|---|');
  for (const [k, v] of Object.entries(r.webhook.byStep))
    lines.push(`| ${k} | ${f(v.p50)} | ${f(v.p95)} | ${f(v.p99)} | ${v.count} |`);
  lines.push('');
  if (r.stages) {
    lines.push(
      '## Ramp',
      '',
      '| stage | virtual customers | req/s | p50 | p95 | p99 | error rate |',
      '|---|---|---|---|---|---|---|',
    );
    for (const s of r.stages)
      lines.push(
        `| ${s.stage} | ${s.virtualCustomers} | ${s.rps} | ${f(s.latencyMs.p50)} | ${f(s.latencyMs.p95)} | ${f(s.latencyMs.p99)} | ${(s.errorRate * 100).toFixed(2)} % |`,
      );
    lines.push(
      '',
      `**Breaking point:** ${r.breakingPoint.reached === false ? r.breakingPoint.note : `${r.breakingPoint.virtualCustomers} concurrent virtual customers: ${r.breakingPoint.reason}; last good level ${f(r.breakingPoint.lastGood)}`}`,
      '',
    );
  }
  const R = r.resources;
  const mm = (s, unit) => `avg ${f(s.avg, unit)}, p95 ${f(s.p95, unit)}, max ${f(s.max, unit)}`;
  lines.push(
    '## CPU and RAM (during the measured window)',
    '',
    '| process | RAM (MB) | CPU (% of one core) |',
    '|---|---|---|',
  );
  for (const [name, v] of Object.entries({
    api: R.api,
    worker: R.worker,
    postgres: R.postgres,
    redis: R.redis,
    'load generator + stub (this harness)': R.loadGenerator,
  })) {
    if (v) lines.push(`| ${name} | ${mm(v.memMb ?? v.memMbPss)} | ${mm(v.cpuPctOfOneCore)} |`);
  }
  lines.push(
    '',
    `Whole machine: CPU ${mm(R.machine.cpuPctOfAllCores, ' %')} of all ${m.cpus} cores; lowest MemAvailable ${R.machine.memAvailableMbMin} MB.`,
  );
  if (R.docker)
    for (const [n, v] of Object.entries(R.docker))
      lines.push(`- docker \`${n}\`: RAM ${mm(v.memMb)} MB, CPU ${mm(v.cpuPct)} %`);
  lines.push('');
  const D = r.database;
  lines.push('## Database', '');
  lines.push(
    `- Backends (this database): ${mm(D.backends)}; active ${mm(D.active)}; idle in transaction ${mm(D.idleInTransaction)}; waiting on a lock/IO/LWLock ${mm(D.waiting)}`,
  );
  lines.push(
    `- Top wait events (active-session samples): ${D.topWaitEvents.map((e) => `${e.event}=${e.activeSessionSamples}`).join(', ') || 'none'}`,
  );
  for (const [role, p] of Object.entries(D.poolFromInsideTheProcesses)) {
    lines.push(
      `- Pool, ${role} process (pg Pool#connect probe): max ${p.maxConnections}, acquisitions ${p.acquires}, queued ${p.queuedAcquires} (${(p.queuedShare * 100).toFixed(2)} %), acquire mean ${f(p.acquireMeanMs)} ms, p95 ${p.acquireP95}, p99 ${p.acquireP99}, max ${p.acquireMaxMs} ms, most clients waiting at once ${p.waitingClientsMax}`,
    );
  }
  lines.push(
    `- Pool checkout timeouts (5 s) in logs: api ${D.poolCheckoutTimeoutsInApiLog}, worker ${D.poolCheckoutTimeoutsInWorkerLog}`,
    '',
  );
  const Q = r.queues;
  lines.push('## Queues', '');
  lines.push(
    `- Outbox unprocessed: depth ${mm(Q.outboxDepth)}; **oldest unprocessed age (s)** ${mm(Q.outboxOldestUnprocessedSeconds)}`,
  );
  lines.push(
    `- Notifications pending: depth ${mm(Q.notificationsPending)}; oldest due age (s) ${mm(Q.notificationsOldestPendingSeconds)}`,
  );
  if (r.broadcast) {
    const b = r.broadcast;
    lines.push(
      `- Broadcast: ${b.error ? `FAILED to launch: ${b.error}` : `${b.recipientCount} recipients launched at +${b.launchedAtS} s (preview ${b.steps.previewMs} ms, launch ${b.steps.launchMs} ms); at the end of the window ${b.sentWhenTheWindowEnded} sent, ${b.pendingWhenTheWindowEnded} pending, measured ${f(b.measuredSendRatePerSecond)} sends/s`}`,
    );
  }
  lines.push('');
  lines.push('## Backup', '');
  if (r.backups.length === 0) lines.push('No backup ran.');
  for (const b of r.backups) {
    lines.push(
      `- at +${b.startedAtS} s: \`${b.command}\` exit ${b.exitCode} in ${b.durationS} s${b.substitution ? ` (SUBSTITUTION: ${b.substitution})` : ''}`,
    );
    if (b.output) lines.push('', '  ```', ...b.output.split('\n').map((l) => `  ${l}`), '  ```');
  }
  lines.push('');
  if (r.logs) {
    lines.push(
      `Logs: api error lines ${r.logs.apiErrorLines}, api warn lines ${r.logs.apiWarnLines}, worker error lines ${r.logs.workerErrorLines} (full logs next to results.json).`,
    );
    for (const e of r.logs.sampleErrors) lines.push(`- \`${e}\``);
    lines.push('');
  }
  return lines.join('\n');
}
