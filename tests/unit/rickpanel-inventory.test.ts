import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderHttpClient, ProviderTarget } from '@nexa/contracts';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { RickpanelAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel.adapter';
import {
  RickpanelInventoryReader,
  canonicalUsername,
  inventoryIndex,
  readOnlyRickpanelHttp,
  type RickpanelInventoryOutcome,
  type RickpanelInventoryWalk,
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

function consistent(outcome: RickpanelInventoryWalk) {
  if (!outcome.ok || !outcome.consistent) {
    throw new Error(`expected a consistent walk, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
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
    const out = consistent(await reader.walk(target, http, { pageSize: 5 }));
    expect(out.accounts.map((a) => a.username)).toEqual(names);
    expect(out.evidence).toMatchObject({ pages: 1, reportedTotal: 3, rowsFetched: 3 });
  });

  it('multiple pages, final short page NOT omitted', async () => {
    const names = seed(12);
    const out = consistent(await reader.walk(target, http, { pageSize: 5 }));
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
    const out = consistent(await reader.walk(target, http, { pageSize: 5 }));
    expect(out.evidence.pages).toBe(2);
    expect(out.accounts).toHaveLength(10);
  });

  it('an empty panel is a consistent, empty walk', async () => {
    const out = consistent(await reader.walk(target, http, { pageSize: 5 }));
    expect(out.accounts).toEqual([]);
    expect(out.evidence).toMatchObject({ pages: 1, reportedTotal: 0, lastPageRows: 0 });
  });

  it('with no reported total the walk ends on the EMPTY page', async () => {
    panel.listMode = 'no-total';
    seed(7);
    const out = consistent(await reader.walk(target, http, { pageSize: 5 }));
    expect(out.accounts).toHaveLength(7);
    expect(out.evidence).toMatchObject({ pages: 3, reportedTotal: null, lastPageRows: 0 });
  });

  it('a panel capping its page size below ours loses nothing (offset advances by rows received)', async () => {
    panel.listMode = 'caps-page-size';
    panel.listPageCap = 4;
    const names = seed(10);
    const out = consistent(await reader.walk(target, http, { pageSize: 50 }));
    expect(out.accounts.map((a) => a.username)).toEqual(names);
    expect(out.evidence.pages).toBe(3);
  });

  it('a panel ignoring offset is refused as NO_PROGRESS, bounded to two requests', async () => {
    panel.listMode = 'ignores-offset';
    seed(12);
    const out = await reader.walk(target, http, { pageSize: 5 });
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
    const out = await reader.walk(target, http, { pageSize: 5 });
    expect(out).toMatchObject({ ok: false, pagination: 'PAGE_TOO_LONG' });
  });

  it('a bare array is NOT_A_PAGE, never an empty inventory', async () => {
    panel.listMode = 'bare-array';
    seed(2);
    const out = await reader.walk(target, http, { pageSize: 5 });
    expect(out).toMatchObject({ ok: false, pagination: 'NOT_A_PAGE' });
  });

  it('the page bound stops a walk that would not end', async () => {
    seed(30);
    const out = await reader.walk(target, http, { pageSize: 5, maxPages: 3 });
    expect(out).toMatchObject({ ok: false, pagination: 'PAGE_LIMIT_EXCEEDED' });
    expect(panel.listCalls()).toBe(3);
  });

  it('a deletion mid-walk shifts the pages: reported as TOTAL_CHANGED, not complete', async () => {
    const names = seed(12);
    panel.beforeListPage = (offset) => {
      if (offset === 5) (panel.users as Map<string, unknown>).delete(names[0] as string);
    };
    const out = await reader.walk(target, http, { pageSize: 5 });
    expect(out).toMatchObject({ ok: true, consistent: false, reason: 'TOTAL_CHANGED' });
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
    const out = await reader.walk(target, http, { pageSize: 5 });
    expect(out).toMatchObject({
      ok: true,
      consistent: false,
      reason: 'COUNT_MISMATCH',
      evidence: { duplicateRows: 1, distinctUsernames: 11, reportedTotal: 12 },
    });
  });
});

describe('completeness needs two identical walks (Codex P1, #169)', () => {
  it('delete-A / append-K keeps total and count, so ONE walk looks consistent and misses F', async () => {
    const names = seed(10, 'u'); // u000..u009: A..J
    panel.beforeListPage = (offset) => {
      if (offset === 5) {
        (panel.users as Map<string, unknown>).delete(names[0] as string); // delete A
        panel.seedUser('u010'); // append K
        panel.beforeListPage = null;
      }
    };
    const walk = consistent(await reader.walk(target, http, { pageSize: 5 }));
    const seen = walk.accounts.map((a) => a.username);
    // The hazard, demonstrated: F (u005) is on the panel the whole time and never returned.
    expect(seen).not.toContain('u005');
    expect(panel.users.has('u005')).toBe(true);
    expect(walk.evidence).toMatchObject({ reportedTotal: 10, distinctUsernames: 10 });
  });

  it('the same change makes listAll WALKS_DIFFER, so it cannot be indexed', async () => {
    const names = seed(10, 'u');
    panel.beforeListPage = (offset) => {
      if (offset === 5) {
        (panel.users as Map<string, unknown>).delete(names[0] as string);
        panel.seedUser('u010');
        panel.beforeListPage = null;
      }
    };
    const out = await reader.listAll(target, http, { pageSize: 5 });
    expect(out).toMatchObject({ ok: true, complete: false, reason: 'WALKS_DIFFER' });
    expect(inventoryIndex('p', out)).toBeNull();
  });

  it('a single walk cannot be indexed, by type', async () => {
    seed(3);
    const walk = await reader.walk(target, http);
    // @ts-expect-error — `inventoryIndex` takes a two-walk `listAll` outcome, never one walk.
    expect(() => inventoryIndex('p', walk)).not.toThrow();
  });

  it('a quiet panel: two identical walks are complete and indexable', async () => {
    const names = seed(12);
    const out = complete(await reader.listAll(target, http, { pageSize: 5 }));
    expect(out.accounts.map((a) => a.username)).toEqual(names);
    expect(out.evidence.first).toEqual(out.evidence.second);
    expect(panel.listCalls()).toBe(6);
    expect(inventoryIndex('p', out)?.usernames.get('user003')).toEqual(['user003']);
  });

  it('an inconsistent first walk is incomplete without a second walk', async () => {
    const names = seed(12);
    panel.beforeListPage = (offset) => {
      if (offset === 5) (panel.users as Map<string, unknown>).delete(names[0] as string);
    };
    const out = await reader.listAll(target, http, { pageSize: 5 });
    expect(out).toMatchObject({
      ok: true,
      complete: false,
      reason: 'TOTAL_CHANGED',
      evidence: { second: null },
    });
    expect(inventoryIndex('p', out)).toBeNull();
  });
});

describe('accounts', () => {
  it('reads state, usage and expiry, and folds the username to lowercase', async () => {
    panel.seedUser('Alice', {
      status: 'disabled',
      usedTraffic: 1024,
      dataLimit: 4096,
      expire: 1_900_000_000,
      // C1: the list carries `online_at` too; naive, so UTC.
      onlineAt: '2026-10-06T08:30:00',
    });
    panel.seedUser('bob', { status: 'something-new' });
    const out = complete(await reader.listAll(target, http));
    expect(out.accounts).toEqual([
      {
        username: 'alice',
        providerUsername: 'Alice',
        providerSpellingDiffers: true,
        state: 'disabled',
        usage: {
          usedBytes: 1024n,
          totalBytes: 4096n,
          expiresAt: new Date(1_900_000_000_000),
          lastSeen: { kind: 'AT', at: new Date('2026-10-06T08:30:00.000Z') },
        },
      },
      {
        username: 'bob',
        providerUsername: 'bob',
        providerSpellingDiffers: false,
        state: 'UNKNOWN',
        usage: {
          usedBytes: 0n,
          totalBytes: null,
          expiresAt: null,
          lastSeen: { kind: 'NEVER' },
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

  it('subscription links are opt-in, beside the accounts, and equal what the adapter derives', async () => {
    panel.seedUser('erin', { subToken: 'tok-erin-0001' });
    panel.seedUser('Frank', { subToken: 'tok-frank-0002' });
    // Default: no links at all, and the accounts never carry one either way.
    const plain = complete(await reader.listAll(target, http));
    expect(plain.subscriptionLinks).toBeUndefined();
    const listsBefore = panel.listCalls();
    const requestsBefore = panel.requests.length;

    const out = complete(await reader.listAll(target, http, { subscriptionLinks: true }));
    // Derived from the SAME list rows: two walks, exactly the requests a plain read makes.
    expect(panel.listCalls() - listsBefore).toBe(listsBefore);
    expect(panel.requests.length - requestsBefore).toBe(requestsBefore);
    expect(
      JSON.stringify(out.accounts, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toMatch(/tok-|sub/u);
    const links = out.subscriptionLinks;
    if (links === undefined) throw new Error('links were asked for');
    expect([...links.keys()].sort()).toEqual(['Frank', 'erin']);

    // Each equals what the adapter's own `lookupUser` delivers for that account.
    const adapter = new RickpanelAdapter();
    for (const name of ['erin', 'Frank']) {
      const found = await adapter.lookupUser({ ...target, activation: {} }, client(panel.baseUrl), {
        username: name,
        subscriptionRef: 'unused',
        clientId: '019250ab-cdef-7012-8345-6789abcdef01',
      });
      if (!found.ok || !found.found || found.delivery.kind !== 'SUBSCRIPTION_LINK') {
        throw new Error(`expected the adapter to deliver a link for ${name}`);
      }
      expect(links.get(name)).toBe(found.delivery.url);
    }
  });

  it('a row carrying no link is null — never a link assembled from something else', async () => {
    panel.seedUser('gina');
    panel.omitSubscriptionLink = true;
    const out = complete(await reader.listAll(target, http, { subscriptionLinks: true }));
    expect(out.subscriptionLinks?.get('gina')).toBeNull();
  });

  it('lookup: found, not found, the panel spelling kept, an uncomparable name refused', async () => {
    panel.seedUser('dave', { usedTraffic: 7 });
    panel.seedUser('Frank');
    expect(await reader.findAccount(target, http, 'dave')).toMatchObject({
      ok: true,
      found: true,
      account: { username: 'dave', providerUsername: 'dave', usage: { usedBytes: 7n } },
    });
    expect(await reader.findAccount(target, http, 'Frank')).toMatchObject({
      found: true,
      account: { username: 'frank', providerUsername: 'Frank' },
    });
    expect(await reader.findAccount(target, http, 'nobody')).toEqual({ ok: true, found: false });
    await expect(reader.findAccount(target, http, 'has space')).rejects.toThrow(/compare/);
  });

  it('two spellings of one name are two accounts, both kept in the index (Codex P2, #169)', async () => {
    panel.seedUser('Alice');
    panel.seedUser('alice');
    panel.seedUser('bob');
    const out = complete(await reader.listAll(target, http));
    expect(out.accounts.map((a) => a.providerUsername)).toEqual(['Alice', 'alice', 'bob']);
    expect(out.evidence.second).toMatchObject({ distinctUsernames: 3, duplicateRows: 0 });
    const index = inventoryIndex('p', out);
    expect(index?.usernames.get('alice')).toEqual(['Alice', 'alice']);
    expect(index?.usernames.get('bob')).toEqual(['bob']);
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
