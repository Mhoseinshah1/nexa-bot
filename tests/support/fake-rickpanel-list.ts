import type { ProviderHttpClient, ProviderHttpRequest } from '@nexa/contracts';
import { RickpanelInventorySource } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/rickpanel-inventory-source';
import { InProcessPanelReadGate } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/panel-read-gate';

/**
 * A FAKE RickPanel account list (`GET api/users?offset=&limit=`) for the diagnostics and G6
 * probe tests: a list in the panel's own order, each row's `created_at`, and knobs for every
 * way a real panel could break the per-name resolution's assumptions — no `created_at`, an
 * out-of-order or epoch one, no `total`, a page cap, an order that changes by request or by
 * limit, deletions and inserts between pages. SYNTHETIC; it is not evidence about RickPanel.
 */

export interface FakeListPanel {
  /** The list, in the panel's own order. */
  names: string[];
  /** name → creation time in seconds since 2026-01-01T00:00:00Z. */
  created: Map<string, number>;
  clock: number;
  log: ProviderHttpRequest[];
  /** Runs before each list page is served (a sale, a deletion burst…). */
  beforePage: (offset: number, pageIndex: number) => void;
  pages: number;
  /** Rewrites a page's rows (an unstable order, a repeated row…). */
  view?: (rows: string[], offset: number, limit: number, pageIndex: number) => string[];
  /**
   * A row's `created_at` value as sent: by default the ISO string of its creation time; return
   * `undefined` to leave the field off.
   */
  createdAtOf?: (username: string, seconds: number) => unknown;
  noTotal?: boolean;
  /** Answers a bare array instead of `{users, total}` (another list shape). */
  bareArray?: boolean;
  /** The panel's page size cap, by page index (or one cap for every page). */
  cap?: number | ((pageIndex: number) => number);
}

export const fakeName = (i: number) => `acc${String(i).padStart(5, '0')}`;
export const isoOf = (t: number) => new Date(Date.UTC(2026, 0, 1) + t * 1000).toISOString();

export function fakeListPanel(count: number): FakeListPanel {
  const panel: FakeListPanel = {
    names: [],
    created: new Map(),
    clock: 0,
    log: [],
    beforePage: () => undefined,
    pages: 0,
  };
  for (let i = 1; i <= count; i += 1) appendAccount(panel, fakeName(i));
  return panel;
}

/** A sale: created now, at the end of the insertion order. */
export function appendAccount(panel: FakeListPanel, username: string): void {
  panel.clock += 1;
  panel.created.set(username, panel.clock);
  panel.names.push(username);
}

/** An account created now but listed at `index` (a panel not in insertion order). */
export function insertAccountAt(panel: FakeListPanel, index: number, username: string): void {
  panel.clock += 1;
  panel.created.set(username, panel.clock);
  panel.names.splice(index, 0, username);
}

const answer = (status: number, body: unknown) =>
  ({ ok: true, status, headers: {}, bodyText: JSON.stringify(body), setCookie: [] }) as const;

export const FAKE_TOKEN = 'synthetic-token-7f3a';
export const FAKE_PASSWORD = 'synthetic-password-91c2';
export const FAKE_BASE_URL = 'https://panel-g6.invalid';

export function fakeListClient(panel: FakeListPanel): ProviderHttpClient {
  return {
    send: async (request) => {
      panel.log.push(request);
      if (request.method === 'POST') return answer(200, { access_token: FAKE_TOKEN });
      if (request.path.startsWith('api/user/')) return answer(500, { detail: 'not expected' });
      const query = new URLSearchParams(request.path.split('?')[1] ?? '');
      const offset = Number(query.get('offset'));
      const pageIndex = panel.pages;
      const cap =
        typeof panel.cap === 'function'
          ? panel.cap(pageIndex)
          : (panel.cap ?? Number.MAX_SAFE_INTEGER);
      const limit = Math.min(Number(query.get('limit')), cap);
      panel.beforePage(offset, pageIndex);
      panel.pages += 1;
      const slice = panel.names.slice(offset, offset + limit);
      const rows = panel.view === undefined ? slice : panel.view(slice, offset, limit, pageIndex);
      const users = rows.map((username) => {
        const seconds = panel.created.get(username) ?? 0;
        const stamp =
          panel.createdAtOf === undefined ? isoOf(seconds) : panel.createdAtOf(username, seconds);
        return {
          username,
          status: 'active',
          ...(stamp === undefined ? {} : { created_at: stamp }),
        };
      });
      if (panel.bareArray === true) return answer(200, users);
      return answer(200, panel.noTotal === true ? { users } : { users, total: panel.names.length });
    },
  };
}

/**
 * The importer's source over the fake, with a fake clock that the pacing moves (so a test can
 * see the interval kept), an in-process read gate, and per-name resolution on.
 */
export function fakeListSource(
  panel: FakeListPanel,
  options: Record<string, unknown> = {},
  stamp = () => new Date('2026-10-14T08:00:00.000Z'),
): { source: RickpanelInventorySource; now: () => number } {
  let now = 0;
  const source = new RickpanelInventorySource(
    {
      panel: async () => ({ baseUrl: FAKE_BASE_URL, providerType: 'rickpanel' }),
      credentials: async () => ({ username: 'admin', password: FAKE_PASSWORD, apiToken: null }),
      http: () => fakeListClient(panel),
    },
    {
      pageSize: 100,
      clock: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      gate: new InProcessPanelReadGate(),
      targeted: true,
      ...options,
    },
    stamp,
  );
  return { source, now: () => now };
}
