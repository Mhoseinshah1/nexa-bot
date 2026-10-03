import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderHttpClient, ProviderTarget } from '@nexa/contracts';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import {
  RickpanelInventoryReader,
  canonicalUsername,
  inventoryIndex,
  readOnlyRickpanelHttp,
  type RickpanelInventoryOutcome,
  type RickpanelReadOnlyHttp,
} from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel-inventory';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';

/**
 * Migration P5: the read-only RickPanel inventory against the fake panel, on a real socket
 * through the real `SafeHttpClient`.
 *
 * What this does NOT prove: that RickPanel's list route is `GET /api/users?offset=&limit=`
 * answering `{users, total}`. That is inferred from Marzban v0.8.4 (`OQ-P5-01`) and the fake
 * implements the inference; `docs/rickpanel-inventory-acceptance.md` is the real-panel run.
 */

let panel: FakeRickpanel;
let target: ProviderTarget;
let http: RickpanelReadOnlyHttp;
const reader = new RickpanelInventoryReader();

const client = (base: string): ProviderHttpClient =>
  new SafeHttpClient({
    allowLoopback: true,
    totalTimeoutMs: 2_000,
    maxResponseBytes: 512 * 1024,
    maxRetries: 0,
  }).forBase(base);

function seed(n: number, prefix = 'user'): string[] {
  const names: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const name = `${prefix}${String(i).padStart(3, '0')}`;
    panel.seedUser(name);
    names.push(name);
  }
  return names;
}

function complete(outcome: RickpanelInventoryOutcome) {
  if (!outcome.ok || !outcome.complete) {
    throw new Error(`expected a complete inventory, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

beforeEach(async () => {
  panel = await startFakeRickpanel();
  target = {
    baseUrl: panel.baseUrl,
    credentials: { shape: 'USERNAME_PASSWORD', username: panel.username, password: panel.password },
  };
  http = readOnlyRickpanelHttp(client(panel.baseUrl));
});
afterEach(async () => {
  await panel.close();
});

describe('pagination', () => {
  it('first page only: fewer accounts than one page', async () => {
    const names = seed(3);
    const out = complete(await reader.listAll(target, http, { pageSize: 5 }));
    expect(out.accounts.map((a) => a.username)).toEqual(names);
    expect(out.evidence).toMatchObject({ pages: 1, reportedTotal: 3, rowsFetched: 3 });
  });

  it('multiple pages, final short page NOT omitted', async () => {
    const names = seed(12);
    const out = complete(await reader.listAll(target, http, { pageSize: 5 }));
    expect(out.accounts.map((a) => a.username)).toEqual(names);
    expect(out.evidence).toMatchObject({
      pages: 3,
      firstPageRows: 5,
      lastPageRows: 2,
      distinctUsernames: 12,
      duplicateRows: 0,
    });
  });

  it('an exact multiple of the page size stops at the total, without a wasted request', async () => {
    seed(10);
    const out = complete(await reader.listAll(target, http, { pageSize: 5 }));
    expect(out.evidence.pages).toBe(2);
    expect(out.accounts).toHaveLength(10);
  });

  it('an empty panel is a complete, empty inventory', async () => {
    const out = complete(await reader.listAll(target, http, { pageSize: 5 }));
    expect(out.accounts).toEqual([]);
    expect(out.evidence).toMatchObject({ pages: 1, reportedTotal: 0, lastPageRows: 0 });
  });

  it('with no reported total the walk ends on the EMPTY page', async () => {
    panel.listMode = 'no-total';
    seed(7);
    const out = complete(await reader.listAll(target, http, { pageSize: 5 }));
    expect(out.accounts).toHaveLength(7);
    expect(out.evidence).toMatchObject({ pages: 3, reportedTotal: null, lastPageRows: 0 });
  });

  it('a panel capping its page size below ours loses nothing (offset advances by rows received)', async () => {
    panel.listMode = 'caps-page-size';
    panel.listPageCap = 4;
    const names = seed(10);
    const out = complete(await reader.listAll(target, http, { pageSize: 50 }));
    expect(out.accounts.map((a) => a.username)).toEqual(names);
    expect(out.evidence.pages).toBe(3);
  });

  it('a panel ignoring offset is refused as NO_PROGRESS, bounded to two requests', async () => {
    panel.listMode = 'ignores-offset';
    seed(12);
    const out = await reader.listAll(target, http, { pageSize: 5 });
    expect(out).toMatchObject({
      ok: false,
      failure: 'MALFORMED_RESPONSE',
      pagination: 'NO_PROGRESS',
    });
    expect(panel.listCalls()).toBe(2);
  });

  it('a panel ignoring limit is refused as PAGE_TOO_LONG', async () => {
    panel.listMode = 'ignores-limit';
    seed(12);
    const out = await reader.listAll(target, http, { pageSize: 5 });
    expect(out).toMatchObject({ ok: false, pagination: 'PAGE_TOO_LONG' });
  });

  it('a bare array is NOT_A_PAGE, never an empty inventory', async () => {
    panel.listMode = 'bare-array';
    seed(2);
    const out = await reader.listAll(target, http, { pageSize: 5 });
    expect(out).toMatchObject({ ok: false, pagination: 'NOT_A_PAGE' });
  });

  it('the page bound stops a walk that would not end', async () => {
    seed(30);
    const out = await reader.listAll(target, http, { pageSize: 5, maxPages: 3 });
    expect(out).toMatchObject({ ok: false, pagination: 'PAGE_LIMIT_EXCEEDED' });
    expect(panel.listCalls()).toBe(3);
  });

  it('a deletion mid-walk shifts the pages: reported as TOTAL_CHANGED, not complete', async () => {
    const names = seed(12);
    panel.beforeListPage = (offset) => {
      if (offset === 5) (panel.users as Map<string, unknown>).delete(names[0] as string);
    };
    const out = await reader.listAll(target, http, { pageSize: 5 });
    expect(out).toMatchObject({ ok: true, complete: false, reason: 'TOTAL_CHANGED' });
    expect(inventoryIndex('p', out)).toBeNull();
  });

  it('a reorder mid-walk yields a duplicate row: counted once, and the gap is reported', async () => {
    const names = seed(12);
    panel.beforeListPage = (offset) => {
      if (offset === 5) {
        const map = panel.users as Map<string, unknown>;
        const first = map.get(names[0] as string);
        map.delete(names[0] as string);
        map.set(names[0] as string, first);
      }
    };
    const out = await reader.listAll(target, http, { pageSize: 5 });
    expect(out).toMatchObject({
      ok: true,
      complete: false,
      reason: 'COUNT_MISMATCH',
      evidence: { duplicateRows: 1, distinctUsernames: 11, reportedTotal: 12 },
    });
  });
});

describe('accounts', () => {
  it('reads state, usage and expiry, and folds the username to lowercase', async () => {
    panel.seedUser('Alice', {
      status: 'disabled',
      usedTraffic: 1024,
      dataLimit: 4096,
      expire: 1_900_000_000,
    });
    panel.seedUser('bob', { status: 'something-new' });
    const out = complete(await reader.listAll(target, http));
    expect(out.accounts).toEqual([
      {
        username: 'alice',
        providerSpellingDiffers: true,
        state: 'disabled',
        usage: {
          usedBytes: 1024n,
          totalBytes: 4096n,
          expiresAt: new Date(1_900_000_000_000),
          lastSeen: { kind: 'UNSUPPORTED' },
        },
      },
      {
        username: 'bob',
        providerSpellingDiffers: false,
        state: 'UNKNOWN',
        usage: {
          usedBytes: 0n,
          totalBytes: null,
          expiresAt: null,
          lastSeen: { kind: 'UNSUPPORTED' },
        },
      },
    ]);
  });

  it('carries no subscription link, token or proxy credential', async () => {
    panel.seedUser('carol', {
      subToken: 'SECRET-SUB-TOKEN-123',
      proxies: { vless: { id: 'SECRET-UUID' } },
    });
    const out = complete(await reader.listAll(target, http));
    const text = JSON.stringify(out, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
    expect(text).not.toMatch(/SECRET|sub_|subscription|proxies|token/i);
  });

  it('exact lowercase lookup: found, not found, and only a canonical name is asked', async () => {
    panel.seedUser('dave', { usedTraffic: 7 });
    expect(await reader.findAccount(target, http, 'dave')).toMatchObject({
      ok: true,
      found: true,
      account: { username: 'dave', usage: { usedBytes: 7n } },
    });
    expect(await reader.findAccount(target, http, 'nobody')).toEqual({ ok: true, found: false });
    await expect(reader.findAccount(target, http, 'Dave')).rejects.toThrow(/canonical/);
  });

  it('a lookup answered with a DIFFERENT account is malformed, not a match', async () => {
    panel.seedUser('Eve');
    // The fake addresses by exact key; ask for "eve" while it holds "Eve" through a
    // panel that resolves case-insensitively.
    const sloppy: RickpanelReadOnlyHttp = {
      exchangeToken: (form) => http.exchangeToken(form),
      listUsersPage: (b, o, l) => http.listUsersPage(b, o, l),
      readUser: (b) => http.readUser(b, 'Eve'),
    };
    // Eve folds to eve, so this one IS the same account.
    expect(await reader.findAccount(target, sloppy, 'eve')).toMatchObject({ found: true });
    panel.seedUser('mallory');
    const wrong: RickpanelReadOnlyHttp = {
      ...sloppy,
      readUser: (b) => http.readUser(b, 'mallory'),
    };
    expect(await reader.findAccount(target, wrong, 'eve')).toMatchObject({
      ok: false,
      failure: 'MALFORMED_RESPONSE',
    });
  });

  it('a wrong password is AUTHENTICATION_FAILED, and no list is requested', async () => {
    const bad: ProviderTarget = {
      ...target,
      credentials: { shape: 'USERNAME_PASSWORD', username: panel.username, password: 'nope' },
    };
    expect(await reader.listAll(bad, http)).toMatchObject({
      ok: false,
      failure: 'AUTHENTICATION_FAILED',
    });
    expect(panel.listCalls()).toBe(0);
  });
});

describe('read-only by construction', () => {
  it('every request the panel received is a GET or the token exchange', async () => {
    seed(12);
    await reader.listAll(target, http, { pageSize: 5 });
    await reader.findAccount(target, http, 'user001');
    await reader.findAccount(target, http, 'absent');
    expect(panel.requests.length).toBeGreaterThan(0);
    for (const request of panel.requests) {
      const path = request.path.split('?')[0];
      const allowed =
        request.method === 'GET' || (request.method === 'POST' && path === '/api/admin/token');
      expect({ method: request.method, path, allowed }).toMatchObject({ allowed: true });
    }
    expect(panel.createCalls()).toBe(0);
    expect(panel.putCalls()).toBe(0);
    expect(panel.revokeCalls()).toBe(0);
  });

  it('the read-only client exposes exactly three reads and no send', () => {
    expect(Object.keys(http).sort()).toEqual(['exchangeToken', 'listUsersPage', 'readUser']);
    expect(Object.isFrozen(http)).toBe(true);
    // @ts-expect-error — the read-only client has no `send`; nothing can pass a method.
    expect(http.send).toBeUndefined();
    // @ts-expect-error — and it is not a ProviderHttpClient.
    const widened: ProviderHttpClient = http;
    expect(widened).toBe(http);
  });

  it('source: the inventory never imports the adapter and sends no write method', () => {
    const source = readFileSync(
      new URL(
        '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel-inventory.ts',
        import.meta.url,
      ),
      'utf8',
    );
    const code = stripComments(source);
    expect(code).not.toMatch(/rickpanel\.adapter/);
    expect(code).not.toMatch(/RickpanelAdapter/);
    expect(code).not.toMatch(/method:\s*'(PUT|DELETE|PATCH)'/);
    // Exactly one POST, and it is the token exchange to the constant path.
    const posts = code.match(/method:\s*'POST'/g) ?? [];
    expect(posts).toHaveLength(1);
    expect(code).toMatch(/method:\s*'POST',\s*effect:\s*'READ',\s*path:\s*TOKEN_PATH,/);
    // The reader's public methods take the read-only client, never the full one.
    expect(code).not.toMatch(/http:\s*ProviderHttpClient,?\s*\n?\s*(username|options)/);
    const fullClientUses = code.match(/ProviderHttpClient/g) ?? [];
    // The type import and `readOnlyRickpanelHttp`'s parameter: nowhere else.
    expect(fullClientUses).toHaveLength(2);
  });

  it('canonicalUsername folds ASCII and refuses what it will not compare', () => {
    expect(canonicalUsername('MiXeD_1')).toBe('mixed_1');
    expect(canonicalUsername('')).toBeNull();
    expect(canonicalUsername('has space')).toBeNull();
    expect(canonicalUsername('ﾑ')).toBeNull();
    expect(canonicalUsername('x'.repeat(129))).toBeNull();
  });
});

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
