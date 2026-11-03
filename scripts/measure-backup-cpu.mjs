#!/usr/bin/env node
// Measures the CPU a real backup run uses, as a share of ONE core, per stage and overall
// (v0.9.7 PR-2). Runs `backup run` (the operator's command, the scheduler's service) once and
// samples, every second, everything attributable to that backup:
//
//   client   the CLI process and every descendant it spawns — pg_dump, 7-Zip, pg_restore,
//            psql — including the CPU of children already reaped (cutime/cstime);
//   verify   the backup-verify container's cgroup (cpuacct v1 or cpu.stat v2): the
//            verification SERVER's work, capped by Docker;
//   live     the live server's backends connected to the dumped database (a NATIVE
//            PostgreSQL on this host, whose backends are visible in /proc): the dump's
//            COPY and the pipeline's own bookkeeping.
//
//   node scripts/measure-backup-cpu.mjs --env FILE --container ID --database NAME [--expect P]
//       [--seal-password]
//
// --seal-password first stores a throwaway backup password (scripts/measure-backup-cpu-seal.mts)
// so the run takes the production 7-Zip path; without it the archive is the keyring NXB.
//
// FILE is a nexa env file for the CLI (DATABASE_URL naming NAME, BACKUP_VERIFY_PGHOST at the
// container; `--container none` measures a run that verifies on the live server, for
// comparison). Prints per-stage wall time and the three shares, the whole run's share, and the
// highest 5-second window. Reads; the run it starts is an ordinary MANUAL backup.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : argv[at + 1];
};
const envFile = arg('--env');
const container = arg('--container');
const database = arg('--database');
const expect = Number(arg('--expect', '70'));
if (!envFile || !container || !database) {
  console.error(
    'usage: measure-backup-cpu.mjs --env FILE --container ID --database NAME [--expect P]',
  );
  process.exit(2);
}

const TICK = Number(execFileSync('getconf', ['CLK_TCK']).toString().trim());
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}

function stat(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    // fields[0] is state (field 3); utime=14, stime=15, cutime=16, cstime=17, ppid=4.
    return {
      ppid: Number(fields[1]),
      own: Number(fields[11]) + Number(fields[12]),
      reaped: Number(fields[13]) + Number(fields[14]),
    };
  } catch {
    return null;
  }
}

function cmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return '';
  }
}

/** CPU seconds of the root and all its descendants, reaped children included. */
function treeSeconds(rootPid) {
  const all = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const s = stat(entry);
    if (s) all.set(Number(entry), s);
  }
  const inTree = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, s] of all) {
      if (!inTree.has(pid) && inTree.has(s.ppid)) {
        inTree.add(pid);
        grew = true;
      }
    }
  }
  let ticks = 0;
  for (const pid of inTree) {
    const s = all.get(pid);
    if (s) ticks += s.own + s.reaped;
  }
  return ticks / TICK;
}

/** CPU seconds of the live server's backends on the measured database. */
function liveBackendSeconds() {
  let ticks = 0;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const line = cmdline(entry);
    if (!line.startsWith('postgres: ')) continue;
    // The measured database, and a verification's scratch database when the verification
    // runs on THIS server (no backup-verify: the comparison run).
    if (!line.includes(` ${database} `) && !/ nexa_verify_[0-9a-f]+ /.test(line)) continue;
    const s = stat(entry);
    if (s) ticks += s.own;
  }
  return ticks / TICK;
}

const fullId =
  container === 'none'
    ? null
    : execFileSync('docker', ['inspect', container, '--format', '{{.Id}}']).toString().trim();
function verifySeconds() {
  if (fullId === null) return 0;
  const v1 = `/sys/fs/cgroup/cpuacct/docker/${fullId}/cpuacct.usage`;
  if (existsSync(v1)) return Number(readFileSync(v1, 'utf8')) / 1e9;
  for (const v2 of [
    `/sys/fs/cgroup/system.slice/docker-${fullId}.scope/cpu.stat`,
    `/sys/fs/cgroup/docker/${fullId}/cpu.stat`,
  ]) {
    if (existsSync(v2)) {
      const usage = /usage_usec (\d+)/.exec(readFileSync(v2, 'utf8'));
      if (usage) return Number(usage[1]) / 1e6;
    }
  }
  throw new Error('cannot find the backup-verify container cgroup');
}

function stage() {
  try {
    return (
      execFileSync(
        'psql',
        [
          env.DATABASE_URL,
          '-XAtqc',
          "SELECT stage FROM backup_runs WHERE state = 'RUNNING' ORDER BY started_at DESC LIMIT 1",
        ],
        { env: { PATH: process.env.PATH } },
      )
        .toString()
        .trim() || 'outside a run'
    );
  } catch {
    return 'unknown';
  }
}

if (argv.includes('--seal-password')) {
  // The production 7-Zip path needs a backup password; store a throwaway one first.
  execFileSync(
    resolve(root, 'apps/api/node_modules/.bin/tsx'),
    [resolve(root, 'scripts/measure-backup-cpu-seal.mts')],
    { env, stdio: 'inherit' },
  );
}

const child = spawn(
  resolve(root, 'apps/api/node_modules/.bin/tsx'),
  [resolve(root, 'apps/api/src/backup.cli.ts'), 'run'],
  { env, stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
child.stdout.on('data', (b) => (output += b));
child.stderr.on('data', (b) => (output += b));

const samples = [];
const startedAt = Date.now();
const base = { client: 0, verify: verifySeconds(), live: liveBackendSeconds() };
let done = false;
child.on('exit', () => (done = true));
while (!done) {
  await new Promise((r) => setTimeout(r, 1000));
  samples.push({
    t: (Date.now() - startedAt) / 1000,
    stage: stage(),
    client: treeSeconds(child.pid),
    verify: verifySeconds() - base.verify,
    live: liveBackendSeconds() - base.live,
  });
}
// The CLI's own exit: whatever its tree used is now in this process's reaped children.
const final = Math.max(...samples.map((sample) => sample.client));

const byStage = new Map();
for (let i = 1; i < samples.length; i += 1) {
  const a = samples[i - 1];
  const b = samples[i];
  const key = b.stage.split('/')[0];
  const row = byStage.get(key) ?? { wall: 0, client: 0, verify: 0, live: 0 };
  row.wall += b.t - a.t;
  row.client += Math.max(0, b.client - a.client);
  row.verify += Math.max(0, b.verify - a.verify);
  row.live += Math.max(0, b.live - a.live);
  byStage.set(key, row);
}
const pct = (cpu, wall) => (wall > 0 ? ((100 * cpu) / wall).toFixed(1) : '-');
console.log(output.trim().split('\n').slice(-8).join('\n'));
console.log('\nstage            wall_s  client%  verify%  live%  total%');
let total = { wall: 0, client: 0, verify: 0, live: 0 };
for (const [key, r] of byStage) {
  total = {
    wall: total.wall + r.wall,
    client: total.client + r.client,
    verify: total.verify + r.verify,
    live: total.live + r.live,
  };
  console.log(
    `${key.padEnd(16)} ${r.wall.toFixed(0).padStart(6)} ${pct(r.client, r.wall).padStart(8)} ${pct(r.verify, r.wall).padStart(8)} ${pct(r.live, r.wall).padStart(6)} ${pct(r.client + r.verify + r.live, r.wall).padStart(7)}`,
  );
}
const all = total.client + total.verify + total.live;
console.log(
  `${'WHOLE RUN'.padEnd(16)} ${total.wall.toFixed(0).padStart(6)} ${pct(total.client, total.wall).padStart(8)} ${pct(total.verify, total.wall).padStart(8)} ${pct(total.live, total.wall).padStart(6)} ${pct(all, total.wall).padStart(7)}`,
);
let peak = 0;
for (let i = 5; i < samples.length; i += 1) {
  const a = samples[i - 5];
  const b = samples[i];
  const cpu = b.client - a.client + (b.verify - a.verify) + (b.live - a.live);
  peak = Math.max(peak, (100 * cpu) / (b.t - a.t));
}
console.log(`highest 5-second window: ${peak.toFixed(1)}% of one core (setting ${expect}%)`);
console.log(`client CPU seen: ${final.toFixed(1)} s`);
process.exit(child.exitCode ?? 1);
