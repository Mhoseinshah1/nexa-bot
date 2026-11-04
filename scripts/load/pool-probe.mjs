// Preloaded into the API and worker processes by scripts/load/run.mjs
// (`node --import scripts/load/pool-probe.mjs dist/main.js`). The application exposes no
// connection-pool metrics, so this wraps `pg`'s Pool#connect (every query and transaction
// goes through it) and, once a second, writes what the pools looked like to
// $LOAD_PROBE_FILE: per pool its size, idle and WAITING clients (sampled every 100 ms, the
// highest of the second), and since the start how many acquisitions there were, how many had
// to queue (no idle client and the pool at its maximum) and the acquisition-time histogram.
//
// It changes no behaviour and sends nothing anywhere. Never loaded outside the harness.
import { createRequire } from 'node:module';
import { writeFileSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(root, 'apps/api/package.json'));
const pg = require('pg');
const file = process.env.LOAD_PROBE_FILE;

const BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const pools = new Set();
const stats = new WeakMap();

function statsOf(pool) {
  let s = stats.get(pool);
  if (s === undefined) {
    s = {
      acquires: 0,
      queued: 0,
      waitSumMs: 0,
      waitMaxMs: 0,
      hist: new Array(BUCKETS_MS.length + 1).fill(0),
      waitingMax: 0,
      waitingMaxWindow: 0,
    };
    stats.set(pool, s);
    pools.add(pool);
  }
  return s;
}

const original = pg.Pool.prototype.connect;
pg.Pool.prototype.connect = function connect(callback) {
  const s = statsOf(this);
  const queued = this.idleCount === 0 && this.totalCount >= (this.options?.max ?? Infinity);
  const started = performance.now();
  const record = () => {
    const ms = performance.now() - started;
    s.acquires += 1;
    if (queued) s.queued += 1;
    s.waitSumMs += ms;
    if (ms > s.waitMaxMs) s.waitMaxMs = ms;
    let bucket = BUCKETS_MS.findIndex((limit) => ms <= limit);
    if (bucket === -1) bucket = BUCKETS_MS.length;
    s.hist[bucket] += 1;
  };
  if (typeof callback === 'function') {
    return original.call(this, (error, client, done) => {
      record();
      callback(error, client, done);
    });
  }
  return original.call(this).then((client) => {
    record();
    return client;
  });
};

if (file) {
  setInterval(() => {
    for (const pool of pools) {
      const s = statsOf(pool);
      s.waitingMaxWindow = Math.max(s.waitingMaxWindow, pool.waitingCount);
      s.waitingMax = Math.max(s.waitingMax, pool.waitingCount);
    }
  }, 100).unref();
  setInterval(() => {
    const snapshot = {
      role: process.env.LOAD_PROBE_ROLE ?? 'unknown',
      pid: process.pid,
      at: Date.now(),
      bucketsMs: BUCKETS_MS,
      pools: [...pools].map((pool) => {
        const s = statsOf(pool);
        const out = {
          max: pool.options?.max ?? null,
          total: pool.totalCount,
          idle: pool.idleCount,
          waitingNow: pool.waitingCount,
          waitingMaxLastSecond: s.waitingMaxWindow,
          waitingMax: s.waitingMax,
          acquires: s.acquires,
          queued: s.queued,
          waitSumMs: s.waitSumMs,
          waitMaxMs: s.waitMaxMs,
          hist: s.hist,
        };
        s.waitingMaxWindow = 0;
        return out;
      }),
    };
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(snapshot));
      renameSync(`${file}.tmp`, file);
    } catch {
      /* the harness may already have removed the directory */
    }
  }, 1000).unref();
}
