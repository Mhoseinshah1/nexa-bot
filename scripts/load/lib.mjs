// Small helpers for scripts/load/run.mjs: statistics, /proc readers, a keep-alive HTTP
// client and the argument parser. No dependencies beyond Node and `pg`.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

export function latencySummary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (v) => (v === null ? null : Math.round(v * 10) / 10);
  return {
    count: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted.length === 0 ? null : sorted[sorted.length - 1]),
    mean: round(sorted.length === 0 ? null : sorted.reduce((a, b) => a + b, 0) / sorted.length),
  };
}

export function seriesSummary(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (v.length === 0) return { avg: null, p95: null, max: null };
  const sorted = [...v].sort((a, b) => a - b);
  const round = (x) => Math.round(x * 100) / 100;
  return {
    avg: round(v.reduce((a, b) => a + b, 0) / v.length),
    p95: round(percentile(sorted, 95)),
    max: round(sorted[sorted.length - 1]),
  };
}

// ---------------------------------------------------------------------------------- /proc

const CLK_TCK = (() => {
  try {
    return Number(execFileSync('getconf', ['CLK_TCK']).toString().trim()) || 100;
  } catch {
    return 100;
  }
})();

export function readCpuTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name is parenthesised and may contain spaces: split after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(fields[11]) + Number(fields[12]); // utime + stime
  } catch {
    return null;
  }
}

/** Resident set in MB; the proportional set (PSS) when the kernel exposes it, so postgres' shared buffers are not counted once per backend. */
export function readMemMb(pid) {
  try {
    const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const pss = /^Pss:\s+(\d+) kB/m.exec(rollup);
    if (pss) return Number(pss[1]) / 1024;
  } catch {
    /* fall through to VmRSS */
  }
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const rss = /^VmRSS:\s+(\d+) kB/m.exec(status);
    return rss ? Number(rss[1]) / 1024 : null;
  } catch {
    return null;
  }
}

/** Every pid whose command name is one of `names` (postgres has one per backend). */
export function pidsByName(names) {
  const found = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const comm = readFileSync(`/proc/${entry}/comm`, 'utf8').trim();
      if (names.includes(comm)) found.push(Number(entry));
    } catch {
      /* the process ended */
    }
  }
  return found;
}

export function readSystem() {
  const stat = readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
  const idle = stat[3] + (stat[4] ?? 0);
  const total = stat.reduce((a, b) => a + b, 0);
  const mem = readFileSync('/proc/meminfo', 'utf8');
  const avail = /^MemAvailable:\s+(\d+) kB/m.exec(mem);
  const totalMem = /^MemTotal:\s+(\d+) kB/m.exec(mem);
  return {
    idle,
    total,
    memAvailableMb: avail ? Number(avail[1]) / 1024 : null,
    memTotalMb: totalMem ? Number(totalMem[1]) / 1024 : null,
  };
}

/** A group of pids sampled as one: summed resident memory, CPU as a share of ONE core. */
export class ProcGroup {
  constructor(name, pidsFn) {
    this.name = name;
    this.pidsFn = pidsFn;
    this.last = null;
  }
  sample(now) {
    const pids = this.pidsFn();
    let ticks = 0;
    let mem = 0;
    for (const pid of pids) {
      const t = readCpuTicks(pid);
      const m = readMemMb(pid);
      if (t !== null) ticks += t;
      if (m !== null) mem += m;
    }
    let cpuPct = null;
    if (this.last !== null && now > this.last.at) {
      const delta = ticks - this.last.ticks;
      cpuPct = delta < 0 ? null : (delta / CLK_TCK / ((now - this.last.at) / 1000)) * 100;
    }
    this.last = { at: now, ticks };
    return {
      processes: pids.length,
      memMb: Math.round(mem * 10) / 10,
      cpuPct: cpuPct === null ? null : Math.round(cpuPct * 10) / 10,
    };
  }
}

// ---------------------------------------------------------------------------------- HTTP

/** One keep-alive agent per target; `request` resolves with the status and the elapsed ms, never rejects. */
export function makeClient(baseUrl, { maxSockets = 2048, timeoutMs = 10_000 } = {}) {
  const url = new URL(baseUrl);
  const lib = url.protocol === 'https:' ? https : http;
  const agent = new lib.Agent({ keepAlive: true, maxSockets, maxFreeSockets: 256 });
  return {
    agent,
    request(path, { method = 'POST', headers = {}, body = null } = {}) {
      return new Promise((resolve) => {
        const started = performance.now();
        const payload =
          body === null ? null : typeof body === 'string' ? body : JSON.stringify(body);
        const req = lib.request(
          {
            agent,
            hostname: url.hostname,
            port: url.port,
            path,
            method,
            timeout: timeoutMs,
            headers: {
              ...(payload === null
                ? {}
                : {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(payload),
                  }),
              ...headers,
            },
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                ms: performance.now() - started,
                text: Buffer.concat(chunks).toString('utf8'),
                headers: res.headers,
              }),
            );
            res.on('error', () =>
              resolve({ status: 0, ms: performance.now() - started, text: '', error: 'response' }),
            );
          },
        );
        req.on('timeout', () => {
          req.destroy();
          resolve({ status: 0, ms: performance.now() - started, text: '', error: 'timeout' });
        });
        req.on('error', (e) =>
          resolve({
            status: 0,
            ms: performance.now() - started,
            text: '',
            error: e.code ?? 'error',
          }),
        );
        if (payload !== null) req.write(payload);
        req.end();
      });
    },
    close: () => agent.destroy(),
  };
}

// ---------------------------------------------------------------------------------- args

/** `--flag value` and `--flag` (boolean). Unknown flags are an error, so a typo does not run a different test. */
export function parseArgs(argv, spec) {
  const out = {};
  for (const [key, def] of Object.entries(spec)) out[key] = def.default;
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === '--') continue; // `pnpm load -- --flag`
    if (!raw.startsWith('--')) throw new Error(`unexpected argument ${raw}`);
    const key = raw.slice(2);
    const def = spec[key];
    if (def === undefined) throw new Error(`unknown flag --${key}`);
    if (def.type === 'boolean') {
      out[key] = true;
    } else {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`--${key} needs a value`);
      i += 1;
      out[key] = def.type === 'number' ? Number(value) : value;
      if (def.type === 'number' && !Number.isFinite(out[key]))
        throw new Error(`--${key} must be a number`);
    }
  }
  return out;
}
