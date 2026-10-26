import { execFileSync } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A mock BRIDGE for Nexa's custom panel protocol, v1 — tests only, never shipped (R10 C2).
 *
 * Written from `docs/protocols/custom-panel.md`, not from the adapter: it VERIFIES every
 * request the way the document tells a bridge to (protocol header, ±300 s timestamp
 * window, constant-time HMAC over the canonical string, nonce never reused), SIGNS every
 * answer over status + the request's nonce + the body hash, keeps the `operationId`
 * idempotency log and the `nexaRef` binding, and answers read-your-writes. A real HTTPS
 * socket and the real `SafeHttpClient` sit between it and the adapter, so a timeout is a
 * real deadline and a dropped connection is a real dropped connection.
 *
 * What it proves is that the adapter and the DOCUMENT agree. What it cannot prove is
 * that any real bridge does — that is the acceptance run the document asks for against
 * the first real bridge (`OQ-C2-02`).
 *
 * Failure modes are injected per ROUTE with `behave(route, behaviour, times?)`.
 */

export type BridgeRoute =
  'health' | 'create' | 'get' | 'allowance' | 'disable' | 'enable' | 'delete' | 'rotate' | 'links';

export type BadPayload =
  | 'non-json'
  | 'missing-field'
  | 'bytes-as-number'
  | 'negative'
  | 'leading-zero'
  | 'offset-timestamp'
  | 'unknown-status'
  | 'http-link'
  | 'wrong-username'
  | 'null-nexaRef'
  | 'other-nexaRef';

export type BridgeBehaviour =
  /** Never answer, and apply nothing. The client's deadline must fire. */
  | 'hang'
  /** Apply, then never answer. */
  | 'hang-after-apply'
  /** A signed 500 INTERNAL_ERROR, nothing applied. */
  | '500-before-apply'
  /** Apply, then a signed 500 INTERNAL_ERROR. */
  | '500-after-apply'
  /** Apply, then kill the connection without answering. */
  | 'drop-after-apply'
  /** The real answer, with no signature header. */
  | 'unsigned'
  /** The real answer, with a signature that does not verify. */
  | 'bad-signature'
  /** An UNSIGNED 404 HTML page, as a wrong base URL would answer. Nothing applied. */
  | 'unsigned-404'
  /** A signed 429 RATE_LIMITED. */
  | 'rate-limited'
  /** A signed 409 carrying a code the protocol does not define. Nothing applied. */
  | 'unknown-code'
  /** A signed 409 carrying ACCOUNT_NOT_FOUND — a known code under the wrong status. */
  | 'wrong-status-code'
  /** A signed 422 RULE_REFUSED. Nothing applied. */
  | 'rule-refused'
  /** health: upstream DOWN; any other route: a signed 503 UPSTREAM_UNAVAILABLE. */
  | 'upstream-down'
  /** A signed 501 UNSUPPORTED_OPERATION. */
  | 'unsupported'
  /** rotate: answer 200 with the account and rotate NOTHING (a lying bridge). */
  | 'rotate-same-link'
  /** Apply, then a signed 2xx whose account is malformed in this one way. */
  | { readonly badPayload: BadPayload };

export interface BridgeAccount {
  readonly username: string;
  readonly nexaRef: string | null;
  readonly disabled: boolean;
  readonly usedBytes: bigint;
  readonly limitBytes: bigint;
  readonly expiresAt: string | null;
  readonly deviceLimit: number | null;
  readonly linkSeq: number;
  readonly lastConnection:
    { readonly supported: false } | { readonly supported: true; readonly at: string | null };
}

export interface BridgeRequest {
  readonly method: string;
  readonly path: string;
  readonly route: BridgeRoute | null;
  /** Whether the request's signature verified (refused requests are logged too). */
  readonly verified: boolean;
  readonly body: Record<string, unknown> | null;
  /** The exact bytes received. */
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface FakeCustomBridge {
  readonly baseUrl: string;
  readonly secret: string;
  readonly requests: BridgeRequest[];
  readonly accounts: Map<string, BridgeAccount>;
  /** `operationId -> what it applied`: the idempotency log. */
  readonly operations: Map<string, { op: BridgeRoute; username: string; nexaRef: string | null }>;
  behave(route: BridgeRoute, behaviour: BridgeBehaviour, times?: number): void;
  /** How many VERIFIED requests reached a route. */
  count(route: BridgeRoute): number;
  /** Plant an account Nexa did not create (a different or no `nexaRef`). */
  seed(account: Partial<BridgeAccount> & { readonly username: string }): void;
  useTraffic(username: string, bytes: bigint): void;
  setLastConnection(username: string, at: string | null | 'UNSUPPORTED'): void;
  /** Move the bridge's clock, in seconds, to exercise the timestamp window. */
  setSkewSeconds(seconds: number): void;
  subscriptionUrl(username: string): string;
  close(): Promise<void>;
}

export interface FakeCustomBridgeOptions {
  readonly secret?: string;
  readonly host?: string;
  /** A path prefix the bridge sits behind, e.g. `/nexa/` — stripped before verifying. */
  readonly prefix?: string;
  readonly tls?: BridgeTls;
  /** The bridge's clock in ms. Defaults to the wall clock, which the adapter also uses. */
  readonly now?: () => number;
}

export const BRIDGE_SECRET = 'k7Qz3N9vR2xW8pL5mT1yB6cH4jD0fG2sA9eU3iO7nK5q';

export interface BridgeTls {
  readonly key: string;
  readonly cert: string;
  /** The CA certificate, PEM, to give the client. */
  readonly ca: string;
  /** The same, on disk, for `PANEL_HTTP_CA_FILE`. */
  readonly caFile: string;
}

let cachedTls: BridgeTls | null = null;

/**
 * A private CA and a leaf for 127.0.0.1, 127.0.0.2 and localhost, made once per process.
 * The adapter refuses `http://`, so the mock bridge is HTTPS, verified through the CA —
 * never with verification switched off.
 */
export function bridgeTls(): BridgeTls {
  if (cachedTls !== null) return cachedTls;
  const dir = mkdtempSync(join(tmpdir(), 'nexa-bridge-tls-'));
  const at = (name: string) => join(dir, name);
  const openssl = (args: string[]) => execFileSync('openssl', args, { stdio: 'pipe' });
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-sha256',
    '-subj',
    '/CN=Nexa Bridge Test CA',
    '-keyout',
    at('ca.key'),
    '-out',
    at('ca.pem'),
  ]);
  openssl([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-subj',
    '/CN=localhost',
    '-keyout',
    at('leaf.key'),
    '-out',
    at('leaf.csr'),
  ]);
  writeFileSync(
    at('ext.cnf'),
    'subjectAltName=IP:127.0.0.1,IP:127.0.0.2,DNS:localhost\nextendedKeyUsage=serverAuth\n',
  );
  openssl([
    'x509',
    '-req',
    '-in',
    at('leaf.csr'),
    '-CA',
    at('ca.pem'),
    '-CAkey',
    at('ca.key'),
    '-CAcreateserial',
    '-days',
    '2',
    '-sha256',
    '-extfile',
    at('ext.cnf'),
    '-out',
    at('leaf.pem'),
  ]);
  cachedTls = {
    key: readFileSync(at('leaf.key'), 'utf8'),
    cert: readFileSync(at('leaf.pem'), 'utf8'),
    ca: readFileSync(at('ca.pem'), 'utf8'),
    caFile: at('ca.pem'),
  };
  return cachedTls;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const hmac = (secret: string, text: string) =>
  `v1=${createHmac('sha256', Buffer.from(secret, 'utf8')).update(text, 'utf8').digest('hex')}`;
const BYTES = /^(0|[1-9][0-9]{0,18})$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z0-9_-]{4,20}$/;
const WRITE_ROUTES: readonly BridgeRoute[] = [
  'create',
  'allowance',
  'disable',
  'enable',
  'delete',
  'rotate',
];

export async function startFakeCustomBridge(
  options: FakeCustomBridgeOptions = {},
): Promise<FakeCustomBridge> {
  const secret = options.secret ?? BRIDGE_SECRET;
  const prefix = options.prefix ?? '/';
  const tls = options.tls ?? bridgeTls();
  const now = options.now ?? (() => Date.now());
  let skewSeconds = 0;
  const accounts = new Map<string, BridgeAccount>();
  const operations = new Map<
    string,
    { op: BridgeRoute; username: string; nexaRef: string | null }
  >();
  const nonces = new Set<string>();
  const requests: BridgeRequest[] = [];
  const behaviours = new Map<BridgeRoute, { behaviour: BridgeBehaviour; left: number }[]>();
  const sockets = new Set<Socket>();

  const subscriptionUrl = (username: string): string => {
    const account = accounts.get(username);
    return `https://sub.bridge.test/s/${username}-${String(account?.linkSeq ?? 0)}`;
  };

  const statusOf = (account: BridgeAccount): string => {
    if (account.disabled) return 'DISABLED';
    if (account.expiresAt !== null && Date.parse(account.expiresAt) <= now()) return 'EXPIRED';
    if (account.limitBytes > 0n && account.usedBytes >= account.limitBytes) return 'LIMITED';
    return 'ACTIVE';
  };

  const wire = (account: BridgeAccount): Record<string, unknown> => ({
    username: account.username,
    nexaRef: account.nexaRef,
    status: statusOf(account),
    trafficUsedBytes: account.usedBytes.toString(),
    trafficLimitBytes: account.limitBytes.toString(),
    expiresAt: account.expiresAt,
    deviceLimit: account.deviceLimit,
    lastConnection: account.lastConnection,
    subscriptionUrl: subscriptionUrl(account.username),
    createdAt: '2026-10-26T07:33:21Z',
  });

  const take = (route: BridgeRoute): BridgeBehaviour | null => {
    const queue = behaviours.get(route);
    const head = queue?.[0];
    if (head === undefined) return null;
    head.left -= 1;
    if (head.left <= 0) queue!.shift();
    return head.behaviour;
  };

  const routeOf = (
    method: string,
    path: string,
  ): { route: BridgeRoute; username: string | null } | null => {
    if (method === 'GET' && path === '/v1/health') return { route: 'health', username: null };
    if (method === 'POST' && path === '/v1/accounts') return { route: 'create', username: null };
    const match = /^\/v1\/accounts\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
    if (match === null) return null;
    const username = match[1]!;
    const suffix = match[2];
    if (suffix === undefined) return method === 'GET' ? { route: 'get', username } : null;
    if (method === 'GET' && suffix === 'links') return { route: 'links', username };
    if (method !== 'POST') return null;
    const table: Record<string, BridgeRoute> = {
      allowance: 'allowance',
      disable: 'disable',
      enable: 'enable',
      delete: 'delete',
      'rotate-link': 'rotate',
    };
    const route = table[suffix];
    return route === undefined ? null : { route, username };
  };

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const nonce = String(request.headers['x-nexa-nonce'] ?? '');
      const method = request.method ?? '';
      const url = request.url ?? '/';

      let signMode: 'signed' | 'unsigned' | 'bad' = 'signed';
      const respond = (status: number, body: string, contentType = 'application/json'): void => {
        const headers: Record<string, string> = { 'content-type': contentType };
        if (signMode !== 'unsigned') {
          const signature = hmac(
            secret,
            ['NEXA-HMAC-SHA256-RESPONSE', String(status), nonce, sha256(body)].join('\n'),
          );
          headers['x-nexa-bridge-signature'] =
            signMode === 'bad' ? `v1=${'0'.repeat(64)}` : signature;
        }
        response.writeHead(status, headers);
        response.end(body);
      };
      const json = (status: number, value: unknown) => respond(status, JSON.stringify(value));
      const error = (status: number, code: string) =>
        json(status, { error: { code, message: `fake bridge: ${code}` } });

      const log = (entry: Omit<BridgeRequest, 'method' | 'rawBody' | 'headers' | 'body'>) => {
        let body: Record<string, unknown> | null;
        try {
          const parsed: unknown = rawBody.length === 0 ? null : JSON.parse(rawBody);
          body =
            typeof parsed === 'object' && parsed !== null
              ? (parsed as Record<string, unknown>)
              : null;
        } catch {
          body = null;
        }
        requests.push({ ...entry, method, rawBody, headers: request.headers, body });
        return body;
      };

      // The base path the operator configured is stripped BEFORE verifying (§1).
      if (!url.startsWith(prefix)) {
        log({ path: url, route: null, verified: false });
        signMode = 'unsigned';
        return respond(404, '<html>not here</html>', 'text/html');
      }
      const protocolPath = `/${url.slice(prefix.length)}`;
      const hasQuery = protocolPath.includes('?');

      // §3.3, in order.
      if (request.headers['x-nexa-protocol'] !== '1') {
        log({ path: protocolPath, route: null, verified: false });
        return error(400, 'UNSUPPORTED_PROTOCOL_VERSION');
      }
      const timestamp = String(request.headers['x-nexa-timestamp'] ?? '');
      const bridgeNow = Math.floor(now() / 1000) + skewSeconds;
      if (!/^\d+$/.test(timestamp) || Math.abs(bridgeNow - Number(timestamp)) > 300) {
        log({ path: protocolPath, route: null, verified: false });
        return error(401, 'TIMESTAMP_OUT_OF_WINDOW');
      }
      const expected = hmac(
        secret,
        ['NEXA-HMAC-SHA256', method, protocolPath, timestamp, nonce, sha256(rawBody)].join('\n'),
      );
      const given = String(request.headers['x-nexa-signature'] ?? '');
      const verified =
        given.length === expected.length &&
        timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'));
      if (!verified) {
        log({ path: protocolPath, route: null, verified: false });
        return error(401, 'INVALID_SIGNATURE');
      }
      if (!/^[0-9a-f]{32}$/.test(nonce) || nonces.has(nonce)) {
        log({ path: protocolPath, route: null, verified: false });
        return error(401, 'NONCE_REPLAYED');
      }
      nonces.add(nonce);

      const matched = hasQuery ? null : routeOf(method, protocolPath);
      const body = log({ path: protocolPath, route: matched?.route ?? null, verified: true });
      if (matched === null) return error(400, 'INVALID_REQUEST');
      const { route, username } = matched;

      const behaviour = take(route);

      // --- behaviours that decide BEFORE anything is applied --------------------------
      if (behaviour === 'hang') return; // the socket stays open; nothing applied
      if (behaviour === '500-before-apply') return error(500, 'INTERNAL_ERROR');
      if (behaviour === 'rate-limited') return error(429, 'RATE_LIMITED');
      if (behaviour === 'unknown-code') return error(409, 'SOMETHING_NEW');
      if (behaviour === 'wrong-status-code') return error(409, 'ACCOUNT_NOT_FOUND');
      if (behaviour === 'rule-refused') return error(422, 'RULE_REFUSED');
      if (behaviour === 'unsupported') return error(501, 'UNSUPPORTED_OPERATION');
      if (behaviour === 'upstream-down' && route !== 'health') {
        return error(503, 'UPSTREAM_UNAVAILABLE');
      }
      if (behaviour === 'unsigned-404') {
        signMode = 'unsigned';
        return respond(404, '<html><body>404 page not found</body></html>', 'text/html');
      }
      if (behaviour === 'unsigned') signMode = 'unsigned';
      if (behaviour === 'bad-signature') signMode = 'bad';

      // --- the operation ------------------------------------------------------------
      const answer = apply(route, username, body, behaviour);

      // --- behaviours AFTER the effect -----------------------------------------------
      if (behaviour === 'hang-after-apply') return;
      if (behaviour === 'drop-after-apply') {
        request.socket.destroy();
        return;
      }
      if (behaviour === '500-after-apply') return error(500, 'INTERNAL_ERROR');
      if (
        behaviour !== null &&
        typeof behaviour === 'object' &&
        answer.status >= 200 &&
        answer.status < 300
      ) {
        if (behaviour.badPayload === 'non-json') return respond(answer.status, 'this is not json');
        const account = (answer.body as { account?: Record<string, unknown> }).account;
        if (account !== undefined) corrupt(account, behaviour.badPayload);
      }
      return json(answer.status, answer.body);
    });
  };

  const corrupt = (account: Record<string, unknown>, how: BadPayload): void => {
    switch (how) {
      case 'missing-field':
        delete account['subscriptionUrl'];
        return;
      case 'bytes-as-number':
        account['trafficUsedBytes'] = Number(account['trafficUsedBytes']);
        return;
      case 'negative':
        account['trafficUsedBytes'] = '-1';
        return;
      case 'leading-zero':
        account['trafficLimitBytes'] = `0${String(account['trafficLimitBytes'])}`;
        return;
      case 'offset-timestamp':
        account['expiresAt'] = '2026-11-25T11:43:20+03:30';
        return;
      case 'unknown-status':
        account['status'] = 'SUSPENDED';
        return;
      case 'http-link':
        account['subscriptionUrl'] = 'http://sub.bridge.test/s/plain';
        return;
      case 'wrong-username':
        account['username'] = 'someone-else';
        return;
      case 'null-nexaRef':
        account['nexaRef'] = null;
        return;
      case 'other-nexaRef':
        account['nexaRef'] = '00000000-0000-4000-8000-000000000000';
        return;
      case 'non-json':
        return;
    }
  };

  const apply = (
    route: BridgeRoute,
    username: string | null,
    body: Record<string, unknown> | null,
    behaviour: BridgeBehaviour | null,
  ): { status: number; body: unknown } => {
    const err = (status: number, code: string) => ({
      status,
      body: { error: { code, message: `fake bridge: ${code}` } },
    });

    if (route === 'health') {
      return {
        status: 200,
        body: {
          protocol: 'nexa-custom-panel',
          protocolVersions: [1],
          bridge: { name: 'fake-bridge', version: '1.4.2' },
          upstream: behaviour === 'upstream-down' ? 'DOWN' : 'OK',
          time: new Date(now()).toISOString(),
        },
      };
    }
    if (route === 'get' || route === 'links') {
      const account = accounts.get(username!);
      if (account === undefined) return err(404, 'ACCOUNT_NOT_FOUND');
      return route === 'get'
        ? { status: 200, body: { account: wire(account) } }
        : {
            status: 200,
            body: { subscriptionUrl: subscriptionUrl(account.username), configs: [] },
          };
    }

    // Every write: a JSON object with an operation id.
    if (body === null) return err(400, 'INVALID_REQUEST');
    const operationId = body['operationId'];
    if (typeof operationId !== 'string' || !UUID.test(operationId)) {
      return err(400, 'INVALID_REQUEST');
    }
    const nexaRef = body['nexaRef'];
    if (typeof nexaRef !== 'string' || !UUID.test(nexaRef)) return err(400, 'INVALID_REQUEST');

    if (route === 'create') {
      const name = body['username'];
      const limit = body['trafficLimitBytes'];
      const expiresAt = body['expiresAt'];
      const deviceLimit = body['deviceLimit'];
      if (
        typeof name !== 'string' ||
        !NAME.test(name) ||
        typeof limit !== 'string' ||
        !BYTES.test(limit) ||
        !(expiresAt === null || (typeof expiresAt === 'string' && STAMP.test(expiresAt))) ||
        !(
          deviceLimit === null ||
          (typeof deviceLimit === 'number' && Number.isInteger(deviceLimit))
        )
      ) {
        return err(400, 'INVALID_REQUEST');
      }
      const prior = operations.get(operationId);
      if (prior !== undefined) {
        if (prior.op !== 'create' || prior.username !== name || prior.nexaRef !== nexaRef) {
          return err(409, 'IDEMPOTENCY_KEY_REUSED');
        }
        const account = accounts.get(name);
        if (account === undefined) return err(404, 'ACCOUNT_NOT_FOUND');
        return { status: 200, body: { account: wire(account), replayed: true } };
      }
      if (accounts.has(name)) return err(409, 'ALREADY_EXISTS');
      accounts.set(name, {
        username: name,
        nexaRef,
        disabled: false,
        usedBytes: 0n,
        limitBytes: BigInt(limit),
        expiresAt: expiresAt as string | null,
        deviceLimit: deviceLimit as number | null,
        linkSeq: 1,
        lastConnection: { supported: true, at: null },
      });
      operations.set(operationId, { op: 'create', username: name, nexaRef });
      return { status: 201, body: { account: wire(accounts.get(name)!), replayed: false } };
    }

    const account = accounts.get(username!);
    if (account === undefined) return err(404, 'ACCOUNT_NOT_FOUND');
    if (account.nexaRef !== nexaRef) return err(409, 'ACCOUNT_NOT_BOUND');
    const prior = operations.get(operationId);
    if (prior !== undefined) {
      if (prior.op !== route || prior.username !== username || prior.nexaRef !== nexaRef) {
        return err(409, 'IDEMPOTENCY_KEY_REUSED');
      }
      return route === 'delete'
        ? { status: 200, body: { deleted: true, replayed: true } }
        : { status: 200, body: { account: wire(account), replayed: true } };
    }

    let next: BridgeAccount = account;
    if (route === 'allowance') {
      const hasExpiry = Object.prototype.hasOwnProperty.call(body, 'expiresAt');
      const hasLimit = Object.prototype.hasOwnProperty.call(body, 'trafficLimitBytes');
      const expiresAt = body['expiresAt'];
      const limit = body['trafficLimitBytes'];
      if (
        (!hasExpiry && !hasLimit) ||
        (hasExpiry && !(typeof expiresAt === 'string' && STAMP.test(expiresAt))) ||
        (hasLimit && !(typeof limit === 'string' && BYTES.test(limit)))
      ) {
        return err(400, 'INVALID_REQUEST');
      }
      next = {
        ...account,
        ...(hasExpiry ? { expiresAt: expiresAt as string } : {}),
        ...(hasLimit ? { limitBytes: BigInt(limit as string) } : {}),
      };
    } else if (route === 'disable') {
      next = { ...account, disabled: true };
    } else if (route === 'enable') {
      next = { ...account, disabled: false };
    } else if (route === 'rotate') {
      if (behaviour !== 'rotate-same-link') next = { ...account, linkSeq: account.linkSeq + 1 };
    }

    operations.set(operationId, { op: route, username: username!, nexaRef });
    if (route === 'delete') {
      accounts.delete(username!);
      return { status: 200, body: { deleted: true } };
    }
    accounts.set(username!, next);
    return { status: 200, body: { account: wire(next) } };
  };

  const server: Server = createServer({ key: tls.key, cert: tls.cert }, handler);
  server.on('secureConnection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const bind = options.host ?? '127.0.0.1';
  server.listen(0, bind);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const host = `https://${bind}:${String(port)}`;

  return {
    baseUrl: `${host}${prefix}`,
    secret,
    requests,
    accounts,
    operations,
    behave(route, behaviour, times = Number.POSITIVE_INFINITY) {
      const queue = behaviours.get(route) ?? [];
      queue.push({ behaviour, left: times });
      behaviours.set(route, queue);
    },
    count(route) {
      return requests.filter((one) => one.verified && one.route === route).length;
    },
    seed(partial) {
      accounts.set(partial.username, {
        nexaRef: null,
        disabled: false,
        usedBytes: 0n,
        limitBytes: 0n,
        expiresAt: null,
        deviceLimit: null,
        linkSeq: 1,
        lastConnection: { supported: false },
        ...partial,
      });
    },
    useTraffic(username, bytes) {
      const account = accounts.get(username);
      if (account === undefined) throw new Error(`the fake bridge has no account ${username}`);
      accounts.set(username, { ...account, usedBytes: account.usedBytes + bytes });
    },
    setLastConnection(username, at) {
      const account = accounts.get(username);
      if (account === undefined) throw new Error(`the fake bridge has no account ${username}`);
      accounts.set(username, {
        ...account,
        lastConnection: at === 'UNSUPPORTED' ? { supported: false } : { supported: true, at },
      });
    },
    setSkewSeconds(seconds) {
      skewSeconds = seconds;
    },
    subscriptionUrl,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Whether a route changes state on the bridge. */
export function isWriteRoute(route: BridgeRoute): boolean {
  return WRITE_ROUTES.includes(route);
}
