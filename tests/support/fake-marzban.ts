import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

/**
 * A deterministic Marzban, on a real socket.
 *
 * Modelled on Gozargah/Marzban v0.8.4 at commit
 * `7f396db3e703d71a28060bc9ce4a532ec64cb1f4`, and — this is the part that matters —
 * corrected against a panel built from that commit rather than from a reading of it.
 * `docs/providers/marzban.md` is the table; every behaviour here cites it.
 *
 * The distinction is not pedantry. The Marzban adapter shipped asserting that omitting
 * `inbounds` on a create means "every inbound", had no fake to disagree with it, and
 * was wrong. So this fake reproduces the panel's actual `excluded_inbounds` arithmetic
 * — a create with no tags for a protocol yields an account with NO links — which is the
 * one behaviour a fake written from the adapter would never have.
 *
 * Real sockets, and the real `SafeHttpClient` against them, for the same reason the
 * 3X-UI fake uses them: mocking the client away erases URL composition, the redirect
 * policy, and whether a credential can escape to another origin.
 */

export type MarzbanBehaviour =
  /** Answers exactly as the pinned binary does. */
  | 'healthy'
  /** The token route refuses the credentials. */
  | 'bad-credentials'
  /** Every authenticated route answers 429. */
  | 'rate-limited'
  /** Every authenticated route answers 500. */
  | 'server-error'
  /** A 200 from a modify whose body is not JSON at all. */
  | 'modify-html'
  /**
   * A 200 from a modify whose record reports a DIFFERENT status than the one asked for.
   *
   * Not a shape v0.8.4 produces, and that is why it is here: it is the shape a panel
   * that is not v0.8.4 produces, and the adapter's guard against it is otherwise
   * unreachable. A suspend reported as successful while the account stayed active is
   * the failure that guard exists for.
   */
  | 'modify-ignores-status'
  /** The delete route answers 200 with a body that is not JSON. Must still succeed. */
  | 'delete-nonjson-2xx';

export interface FakeMarzbanOptions {
  readonly username?: string;
  readonly password?: string;
  readonly behaviour?: MarzbanBehaviour;
  readonly host?: string;
  /** Inbound tags this panel has, per protocol, as `GET /api/inbounds` would list. */
  readonly inbounds?: Readonly<Record<string, readonly string[]>>;
}

export interface FakeMarzbanUser {
  username: string;
  status: string;
  /** Epoch SECONDS, or null. Marzban stores 0 as NULL. */
  expire: number | null;
  dataLimit: number | null;
  usedTraffic: number;
  /** Which inbounds this account is NOT excluded from, per protocol. */
  inbounds: Record<string, string[]>;
  proxies: Record<string, { id: string }>;
}

export interface FakeMarzbanRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface FakeMarzban {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  behaviour: MarzbanBehaviour;
  readonly requests: readonly FakeMarzbanRequest[];
  /** Everything this panel holds, keyed by username — the observer's view. */
  readonly users: ReadonlyMap<string, FakeMarzbanUser>;
  /** Put a user there without going through the adapter. */
  seed(user: Partial<FakeMarzbanUser> & { username: string }): FakeMarzbanUser;
  /**
   * Take a user away without going through the adapter.
   *
   * What an operator poking the panel directly does, which is the one way a service
   * Nexa believes is ACTIVE ends up with no account behind it. `users` is exposed as a
   * ReadonlyMap on purpose — a test reaching in to `delete` would be a test quietly
   * granting itself write access to the subject — so the fake offers the operation by
   * name and says what it stands for.
   */
  forget(username: string): void;
  /** The subscription body a client would receive, as the real panel builds it. */
  subscriptionFor(username: string): string;
  reset(): void;
  close(): Promise<void>;
}

const DEFAULT_INBOUNDS: Readonly<Record<string, readonly string[]>> = {
  vless: ['VLESS TCP'],
  vmess: ['VMess WS'],
};

/**
 * The status values `UserStatusModify` accepts.
 *
 * `limited` and `expired` are in `UserStatus` and NOT here: they are states Marzban
 * puts a user into, and a modify carrying one answers 422. Verified on the binary.
 */
const MODIFIABLE_STATUSES = new Set(['active', 'disabled', 'on_hold']);

export async function startFakeMarzban(options: FakeMarzbanOptions = {}): Promise<FakeMarzban> {
  const username = options.username ?? 'panel-admin';
  const password = options.password ?? 'panel-password';
  const panelInbounds = options.inbounds ?? DEFAULT_INBOUNDS;
  const users = new Map<string, FakeMarzbanUser>();
  const requests: FakeMarzbanRequest[] = [];
  let behaviour: MarzbanBehaviour = options.behaviour ?? 'healthy';
  /** Every token this panel has minted. Real ones only; nothing else is accepted. */
  const tokens = new Set<string>();
  let tokenCounter = 0;

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const rawUrl = request.url ?? '/';
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers[key] = value;
      }
      requests.push({ method: request.method ?? 'GET', path: rawUrl, headers, body });

      const json = (status: number, value: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      const path = rawUrl.split('?')[0] ?? '/';

      if (path === '/api/admin/token') {
        if (request.method !== 'POST') return void json(405, { detail: 'Method Not Allowed' });
        const form = new URLSearchParams(body);
        if (behaviour === 'bad-credentials') {
          return void json(401, { detail: 'Incorrect username or password' });
        }
        if (form.get('username') !== username || form.get('password') !== password) {
          return void json(401, { detail: 'Incorrect username or password' });
        }
        tokenCounter += 1;
        const minted = `fake-marzban-token-${tokenCounter}`;
        tokens.add(minted);
        return void json(200, { access_token: minted, token_type: 'bearer' });
      }

      /*
       * Everything past here is authenticated, and the check is against tokens this
       * panel actually minted. Accepting any non-empty Authorization header would make
       * every test that thinks it proves a token was sent prove nothing at all.
       */
      const authorization = headers['authorization'] ?? '';
      const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!tokens.has(presented)) {
        return void json(401, { detail: 'Could not validate credentials' });
      }
      if (behaviour === 'rate-limited') return void json(429, { detail: 'Too Many Requests' });
      if (behaviour === 'server-error') return void json(500, { detail: 'Internal Server Error' });

      if (path === '/api/system') {
        return void json(200, { version: '0.8.4', total_user: users.size, online_users: 0 });
      }

      if (path === '/api/user' && request.method === 'POST') {
        const payload = safeJson(body);
        if (payload === null) return void json(422, { detail: 'malformed' });
        const name = String(payload['username'] ?? '');
        if (users.has(name)) return void json(409, { detail: 'User already exists' });
        const proxies: Record<string, { id: string }> = {};
        for (const protocol of Object.keys(asRecord(payload['proxies']))) {
          proxies[protocol] = { id: `uuid-${name}-${protocol}` };
        }
        /*
         * `excluded_inbounds`, the actual arithmetic.
         *
         * `UserCreate.excluded_inbounds` excludes every inbound for a requested protocol
         * that is NOT named in `inbounds`, so what the account keeps is the intersection
         * of what the panel has with what the payload named — and an absent key keeps
         * NOTHING. That is the defect this fake exists to be able to reproduce.
         */
        const requested = asRecord(payload['inbounds']);
        const kept: Record<string, string[]> = {};
        for (const protocol of Object.keys(proxies)) {
          const named = Array.isArray(requested[protocol]) ? (requested[protocol] as string[]) : [];
          kept[protocol] = (panelInbounds[protocol] ?? []).filter((tag) => named.includes(tag));
        }
        const expire = numberOrNull(payload['expire']);
        const created: FakeMarzbanUser = {
          username: name,
          status: typeof payload['status'] === 'string' ? payload['status'] : 'active',
          // Marzban stores 0 as SQL NULL for both, so "unlimited" reads back as absent.
          expire: expire === null || expire === 0 ? null : expire,
          dataLimit: zeroToNull(numberOrNull(payload['data_limit'])),
          usedTraffic: 0,
          inbounds: kept,
          proxies,
        };
        users.set(name, created);
        return void json(200, present(created));
      }

      const single = /^\/api\/user\/([^/]+)$/.exec(path);
      if (single !== null) {
        const name = decodeURIComponent(single[1] ?? '');
        const existing = users.get(name);

        if (request.method === 'GET') {
          if (existing === undefined) return void json(404, { detail: 'User not found' });
          return void json(200, present(existing));
        }

        if (request.method === 'PUT') {
          // 404 BEFORE the body is looked at, exactly as `get_validated_user` does.
          if (existing === undefined) return void json(404, { detail: 'User not found' });
          const payload = safeJson(body);
          if (payload === null) return void json(422, { detail: { body: 'malformed' } });
          const status = payload['status'];
          if (typeof status === 'string' && !MODIFIABLE_STATUSES.has(status)) {
            return void json(422, {
              detail: { status: "Input should be 'active', 'disabled' or 'on_hold'" },
            });
          }
          if (behaviour === 'modify-html') {
            response.writeHead(200, { 'content-type': 'text/html' });
            return void response.end('<html><body>login</body></html>');
          }
          if (typeof status === 'string' && behaviour !== 'modify-ignores-status') {
            existing.status = status;
          }
          /*
           * Every other field is "no change" when absent, per `UserModify`. Applied here
           * so that an adapter sending more than a status has somewhere to be caught.
           */
          const expire = numberOrNull(payload['expire']);
          if (expire !== null) existing.expire = expire === 0 ? null : expire;
          const limit = numberOrNull(payload['data_limit']);
          if (limit !== null) existing.dataLimit = zeroToNull(limit);
          return void json(200, present(existing));
        }

        if (request.method === 'DELETE') {
          if (existing === undefined) return void json(404, { detail: 'User not found' });
          users.delete(name);
          if (behaviour === 'delete-nonjson-2xx') {
            response.writeHead(200, { 'content-type': 'text/plain' });
            return void response.end('deleted');
          }
          return void json(200, { detail: 'User successfully deleted' });
        }

        return void json(405, { detail: 'Method Not Allowed' });
      }

      return void json(404, { detail: 'Not Found' });
    });
  });

  /*
   * A path, not an absolute URL, and no `/api` prefix here.
   *
   * The adapter's path constants already carry `api/...`, so a base URL that repeated
   * it would let a wrong constant pass. The fake serves what a real panel serves.
   */
  function present(user: FakeMarzbanUser): Record<string, unknown> {
    const links: string[] = [];
    for (const [protocol, tags] of Object.entries(user.inbounds)) {
      for (const tag of tags) {
        links.push(`${protocol}://${user.proxies[protocol]?.id ?? ''}@panel.test:443#${tag}`);
      }
    }
    return {
      username: user.username,
      status: user.status,
      expire: user.expire,
      data_limit: user.dataLimit,
      used_traffic: user.usedTraffic,
      lifetime_used_traffic: user.usedTraffic,
      links,
      /*
       * A PATH, and a different one every time it is rendered.
       *
       * v0.8.4 mints the token from `ceil(time.time())` at response time, so two reads
       * of one unchanged user return two different URLs and nothing may treat a changed
       * URL as evidence that anything changed. The counter reproduces that without a
       * clock.
       */
      subscription_url: `/sub/${user.username}-${(tokenCounter += 1)}`,
      proxies: user.proxies,
    };
  }

  server.listen(0, options.host ?? '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const host = options.host ?? '127.0.0.1';

  return {
    baseUrl: `http://${host}:${address.port}/`,
    username,
    password,
    get behaviour() {
      return behaviour;
    },
    set behaviour(next: MarzbanBehaviour) {
      behaviour = next;
    },
    get requests() {
      return requests;
    },
    get users() {
      return users;
    },
    seed(user) {
      const seeded: FakeMarzbanUser = {
        status: 'active',
        expire: null,
        dataLimit: null,
        usedTraffic: 0,
        inbounds: { vless: ['VLESS TCP'] },
        proxies: { vless: { id: `uuid-${user.username}-vless` } },
        ...user,
      };
      users.set(seeded.username, seeded);
      return seeded;
    },
    forget(name) {
      users.delete(name);
    },
    subscriptionFor(name) {
      const user = users.get(name);
      if (user === undefined) return '';
      return (present(user)['links'] as string[]).join('\n');
    },
    reset() {
      users.clear();
      requests.length = 0;
      behaviour = options.behaviour ?? 'healthy';
    },
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

function safeJson(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function zeroToNull(value: number | null): number | null {
  return value === null || value === 0 ? null : value;
}
