import { describe, expect, it } from 'vitest';
import type { ProviderHttpClient, ProviderHttpRequest, ProviderHttpResult } from '@nexa/contracts';
import { RickpanelInventorySource } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/rickpanel-inventory-source';
import {
  InProcessPanelReadGate,
  panelReadKey,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/panel-read-gate';
import {
  DEFAULT_PANEL_READ_POLICY,
  INVENTORY_REQUEST_INTERVAL_MS,
  MAX_SLOW_GAP_MS,
  SLOW_RESPONSE_MS,
  retryAfterDelayMs,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/rickpanel-read-session';

/**
 * Owner requirement on PR #281: a migration's live RickPanel inventory read must never press
 * on the panel — paginated, one request in flight, paced (1 s by default) across every
 * concurrent job of the same panel, one login per read, bounded retries that honour
 * Retry-After, and cancellation that stops the next request and every wait. The read's
 * criterion (two walks, identical exact sets) is untouched. SYNTHETIC data, fake panels only.
 */

const SCOPE = { tenantId: '11111111-1111-4111-8111-111111111111' } as never;
const STAMP = () => new Date('2026-10-14T08:00:00.000Z');

const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({ ok: true, status, headers, bodyText: JSON.stringify(body), setCookie: [] }) as const;

interface FakePanel {
  names: string[];
  /** Every request, with when it started and ended on the panel's clock. */
  log: { request: ProviderHttpRequest; start: number; end: number }[];
  inFlight: number;
  maxInFlight: number;
  tokens: number;
  /** The token the panel currently accepts (an older one answers 401). */
  valid: string;
  /** Before a list page: may answer in the panel's place. */
  beforePage: (offset: number) => ProviderHttpResult | undefined;
  /** How long the panel takes to answer (ms of the clock in use). */
  latency: number;
}

function fakePanel(count: number): FakePanel {
  return {
    names: Array.from({ length: count }, (_, i) => `acc${String(i + 1).padStart(5, '0')}`),
    log: [],
    inFlight: 0,
    maxInFlight: 0,
    tokens: 0,
    valid: 'token-1',
    beforePage: () => undefined,
    latency: 0,
  };
}

/** A panel client over a clock (fake or real); `wait` is how the panel spends its latency. */
function clientOf(
  panel: FakePanel,
  now: () => number,
  wait: (ms: number) => Promise<void>,
): ProviderHttpClient {
  return {
    send: async (request) => {
      const start = now();
      panel.inFlight += 1;
      panel.maxInFlight = Math.max(panel.maxInFlight, panel.inFlight);
      try {
        await wait(panel.latency);
        if (request.method === 'POST') {
          panel.tokens += 1;
          panel.valid = `token-${String(panel.tokens)}`;
          return answer(200, { access_token: panel.valid });
        }
        if (request.headers?.['authorization'] !== `Bearer ${panel.valid}`) {
          return answer(401, { detail: 'Could not validate credentials' });
        }
        const query = new URLSearchParams(request.path.split('?')[1] ?? '');
        const offset = Number(query.get('offset'));
        const limit = Number(query.get('limit'));
        const instead = panel.beforePage(offset);
        if (instead !== undefined) return instead;
        const users = panel.names
          .slice(offset, offset + limit)
          .map((username) => ({ username, status: 'active' }));
        return answer(200, { users, total: panel.names.length });
      } finally {
        panel.inFlight -= 1;
        panel.log.push({ request, start, end: now() });
      }
    },
  };
}

/** A source on a FAKE clock: every wait moves time, nothing really sleeps. */
function fakeClockSource(panel: FakePanel, options: Record<string, unknown> = {}) {
  let now = 0;
  const waits: { ms: number; kind: string | undefined }[] = [];
  const clock = () => now;
  const source = new RickpanelInventorySource(
    {
      panel: async () => ({ baseUrl: 'https://panel.invalid', providerType: 'rickpanel' }),
      credentials: async () => ({
        username: 'admin',
        password: 'synthetic-secret',
        apiToken: null,
      }),
      http: () =>
        clientOf(panel, clock, async (ms) => {
          now += ms;
        }),
    },
    {
      pageSize: 100,
      clock,
      sleep: async (ms: number, _signal?: AbortSignal, kind?: string) => {
        waits.push({ ms, kind });
        now += ms;
      },
      gate: new InProcessPanelReadGate(),
      ...options,
    },
    STAMP,
  );
  return { source, waits, clock };
}

const starts = (panel: FakePanel) => panel.log.map((x) => x.start).sort((a, b) => a - b);
const gaps = (times: readonly number[]) => times.slice(1).map((t, i) => t - (times[i] ?? 0));

describe('a large inventory, read paginated and paced', () => {
  it('2,345 accounts at 100 a page: complete, one login, 24 pages a walk, every request ≥ 1 s apart, one in flight', async () => {
    const panel = fakePanel(2_345);
    const { source } = fakeClockSource(panel);
    const read = await source.read(SCOPE, 'panel');
    expect(read).toMatchObject({ ok: true, complete: true, accounts: 2_345 });
    // ceil(2345 / 100) = 24 pages per walk, two walks, ONE login.
    const pages = panel.log.filter((x) => x.request.method === 'GET');
    expect(pages).toHaveLength(48);
    expect(panel.tokens).toBe(1);
    expect(read.diagnostics?.load).toMatchObject({
      requests: 49,
      logins: 1,
      tokenReuses: 1,
      retries: 0,
      pageSize: 100,
    });
    // Paced: no two request starts closer than the interval, and never two at once.
    for (const gap of gaps(starts(panel))) {
      expect(gap).toBeGreaterThanOrEqual(INVENTORY_REQUEST_INTERVAL_MS);
    }
    expect(panel.maxInFlight).toBe(1);
    // 49 requests a second apart, the first a full interval after the read began.
    expect(read.diagnostics?.load.durationMs).toBe(49 * INVENTORY_REQUEST_INTERVAL_MS);
    // The largest page is reported, in bytes, to tune the page size from evidence.
    expect(read.diagnostics?.load.maxPageBytes).toBeGreaterThan(0);
  });

  it('a slow panel (answers taking 5 s) is asked at most half the time: the next request waits as long again', async () => {
    const panel = fakePanel(250);
    panel.latency = 5_000;
    const { source } = fakeClockSource(panel);
    const read = await source.read(SCOPE, 'panel');
    expect(read).toMatchObject({ ok: true, complete: true });
    for (const [i, entry] of panel.log.entries()) {
      const next = panel.log[i + 1];
      if (next === undefined) continue;
      // Idle at least as long as the panel was busy (≥ 50 % rest), within the cap.
      expect(next.start - entry.end).toBeGreaterThanOrEqual(
        Math.min(panel.latency, MAX_SLOW_GAP_MS),
      );
    }
    expect(panel.latency).toBeGreaterThanOrEqual(SLOW_RESPONSE_MS);
  });

  it('an account created on the panel mid-walk: still TOTAL_CHANGED under pacing — the criterion is not relaxed', async () => {
    const panel = fakePanel(1_000);
    panel.beforePage = (offset) => {
      if (offset === 300) panel.names.push(`late${String(panel.names.length)}`);
      return undefined;
    };
    const { source } = fakeClockSource(panel);
    expect(await source.read(SCOPE, 'panel')).toMatchObject({
      ok: true,
      complete: false,
      reason: 'TOTAL_CHANGED',
    });
  });
});

describe('concurrent jobs on one panel: one read at a time, one request at a time', () => {
  it('two reads of the same panel at once never overlap: no two requests in flight, every start ≥ the interval apart', async () => {
    const panel = fakePanel(30);
    const gate = new InProcessPanelReadGate();
    const interval = 15;
    const real = () => Date.now();
    const sourceOf = () =>
      new RickpanelInventorySource(
        {
          panel: async () => ({ baseUrl: 'https://panel.invalid', providerType: 'rickpanel' }),
          credentials: async () => ({ username: 'admin', password: 'synthetic', apiToken: null }),
          http: () =>
            clientOf(panel, real, (ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        },
        { pageSize: 10, requestIntervalMs: interval, gate },
        STAMP,
      );
    panel.latency = 3;
    const [a, b] = await Promise.all([
      sourceOf().read(SCOPE, 'panel'),
      sourceOf().read(SCOPE, 'panel'),
    ]);
    expect(a).toMatchObject({ ok: true, complete: true });
    expect(b).toMatchObject({ ok: true, complete: true });
    expect(panel.maxInFlight).toBe(1);
    // One job queued behind the other: it reports the time it waited for its turn.
    const waited = [a.diagnostics?.load.lockWaitMs ?? 0, b.diagnostics?.load.lockWaitMs ?? 0];
    expect(Math.max(...waited)).toBeGreaterThan(0);
    // Across BOTH jobs, the panel never saw two starts closer than the interval (1 ms of
    // timer slack).
    for (const gap of gaps(starts(panel))) expect(gap).toBeGreaterThanOrEqual(interval - 1);
  });

  it('the gate is keyed by the panel origin: two rows pointing at one machine share it, two machines do not', () => {
    expect(panelReadKey('https://Panel.example.invalid:8443/')).toBe(
      panelReadKey('https://panel.example.invalid:8443/dashboard'),
    );
    expect(panelReadKey('https://a.invalid')).not.toBe(panelReadKey('https://b.invalid'));
  });

  it('a read that gives up waiting for its turn (lease lost) takes nothing, and the next in line still proceeds', async () => {
    const gate = new InProcessPanelReadGate();
    const first = await gate.acquire('https://panel.invalid');
    const abandoned = new AbortController();
    const waiting = gate.acquire('https://panel.invalid', abandoned.signal);
    const third = gate.acquire('https://panel.invalid');
    abandoned.abort(new Error('lease lost'));
    await expect(waiting).rejects.toThrow('lease lost');
    await first.release();
    const lease = await third;
    await lease.release();
  });
});

describe('logins: one per read, never a storm', () => {
  it('a token that expires mid-read buys ONE fresh login, and the walk continues from the same page', async () => {
    const panel = fakePanel(500);
    let expired = false;
    panel.beforePage = (offset) => {
      if (offset === 200 && !expired) {
        expired = true;
        panel.valid = 'rotated-by-the-panel';
      }
      return undefined;
    };
    const { source } = fakeClockSource(panel);
    const read = await source.read(SCOPE, 'panel');
    expect(read).toMatchObject({ ok: true, complete: true, accounts: 500 });
    expect(panel.tokens).toBe(2);
    expect(read.diagnostics?.load).toMatchObject({ logins: 2, tokenRefreshes: 1 });
  });

  it('a panel that refuses every token: one refresh, then the read fails AUTHENTICATION_FAILED — two logins in all', async () => {
    const panel = fakePanel(500);
    panel.beforePage = () => answer(401, { detail: 'Could not validate credentials' });
    const { source } = fakeClockSource(panel);
    expect(await source.read(SCOPE, 'panel')).toMatchObject({
      ok: false,
      failure: 'AUTHENTICATION_FAILED',
    });
    expect(panel.tokens).toBe(1 + DEFAULT_PANEL_READ_POLICY.maxTokenRefreshes);
  });

  it('three attempts of a moving panel still log in once', async () => {
    const panel = fakePanel(300);
    let moved = 0;
    panel.beforePage = (offset) => {
      if (offset === 100) panel.names.push(`moving${String((moved += 1))}`);
      return undefined;
    };
    const { source } = fakeClockSource(panel, { attempts: 3 });
    const read = await source.read(SCOPE, 'panel');
    expect(read).toMatchObject({ ok: true, complete: false });
    expect(panel.tokens).toBe(1);
  });
});

describe('429, timeouts and the retry budget', () => {
  it('Retry-After as delta-seconds or an HTTP date; unreadable is null (the backoff applies)', () => {
    expect(retryAfterDelayMs('12', 0)).toBe(12_000);
    const now = Date.parse('2026-10-14T08:00:00Z');
    expect(retryAfterDelayMs('Wed, 14 Oct 2026 08:00:30 GMT', now)).toBe(30_000);
    expect(retryAfterDelayMs('Wed, 14 Oct 2026 07:00:00 GMT', now)).toBe(0);
    expect(retryAfterDelayMs('soon', now)).toBeNull();
    expect(retryAfterDelayMs(undefined, now)).toBeNull();
  });

  it('a panel that keeps answering 429: the read stops when the ONE budget is spent, having waited what it was told', async () => {
    const panel = fakePanel(500);
    panel.beforePage = () => answer(429, { detail: 'slow down' }, { 'retry-after': '10' });
    const { source, waits } = fakeClockSource(panel);
    expect(await source.read(SCOPE, 'panel')).toMatchObject({ ok: false, failure: 'RATE_LIMITED' });
    const budget = DEFAULT_PANEL_READ_POLICY.maxRetries;
    expect(waits.filter((w) => w.kind === 'retry-after').map((w) => w.ms)).toEqual(
      Array.from({ length: budget }, () => 10_000),
    );
    // Login + the page + one per retry. Nothing else.
    expect(panel.log).toHaveLength(1 + 1 + budget);
  });
});

describe('cancellation', () => {
  it('a lost lease ends the PACING wait at once: no request after it', async () => {
    const panel = fakePanel(500);
    const lease = new AbortController();
    const source = new RickpanelInventorySource(
      {
        panel: async () => ({ baseUrl: 'https://panel.invalid', providerType: 'rickpanel' }),
        credentials: async () => ({ username: 'admin', password: 'synthetic', apiToken: null }),
        http: () =>
          clientOf(
            panel,
            () => Date.now(),
            async () => undefined,
          ),
      },
      // Ten seconds between requests, REAL time: the read is waiting almost all the while.
      {
        pageSize: 100,
        requestIntervalMs: 10_000,
        signal: lease.signal,
        gate: new InProcessPanelReadGate(),
      },
      STAMP,
    );
    setTimeout(() => {
      lease.abort(new Error('lease lost'));
    }, 30);
    const started = Date.now();
    await expect(source.read(SCOPE, 'panel')).rejects.toThrow('lease lost');
    expect(Date.now() - started).toBeLessThan(2_000);
    const sent = panel.log.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(panel.log).toHaveLength(sent);
  });

  it('a cancelled job waiting for the panel behind another read gives up its place and sends nothing', async () => {
    const panel = fakePanel(50);
    const gate = new InProcessPanelReadGate();
    const holder = await gate.acquire(panelReadKey('https://panel.invalid'));
    const job = new AbortController();
    const { source } = fakeClockSource(panel, { gate, signal: job.signal });
    const reading = source.read(SCOPE, 'panel');
    job.abort(new Error('job cancelled'));
    await expect(reading).rejects.toThrow('job cancelled');
    expect(panel.log).toHaveLength(0);
    await holder.release();
  });
});

describe('what the read reports', () => {
  it('counts and milliseconds only: never the password, a token or an account name', async () => {
    const panel = fakePanel(120);
    const { source } = fakeClockSource(panel);
    const read = await source.read(SCOPE, 'panel');
    const text = JSON.stringify(read.diagnostics);
    expect(text).not.toContain('synthetic-secret');
    expect(text).not.toContain('token-1');
    expect(text).not.toContain('acc0');
    for (const value of Object.values(read.diagnostics?.load ?? {})) {
      expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
    }
  });
});
