#!/usr/bin/env node
/**
 * A READ-ONLY RickPanel stand-in for the isolated Mirza → NEXA migration rehearsal
 * (`docs/legacy-migration/nxpkg-real-rehearsal.md`). Never part of a real installation.
 *
 * Why it exists. A Fresh Migration binds the package's panel code to an ACTIVE `rickpanel`
 * panel, and a panel becomes ACTIVE only after a connection test. A rehearsal with a real
 * backup must still contact NO real panel, so it registers this stand-in instead: the
 * customers, balances, debts, history and the importer's own reconciliation are rehearsed
 * in full against real data, and the panel side is an inventory this process serves.
 *
 * What it answers — exactly the reads NEXA's RickPanel code uses, and nothing else:
 *
 *   POST /api/admin/token        form username/password → a bearer token (a READ in NEXA)
 *   GET  /api/system             the connection test's second call
 *   GET  /api/users?offset&limit the inventory walk ({users, total}, Marzban's shape)
 *   GET  /api/user/{username}    one account
 *
 * Every other method or path — a create, a PUT, a DELETE, a reset, a revoke — is answered
 * 405 and counted as a REFUSED WRITE. The rehearsal requires that count to be zero: a
 * migration must never write to a panel, and on this stand-in any attempt is visible.
 *
 * The inventory is EMPTY unless `RICKPANEL_STANDIN_INVENTORY` names a JSON file holding an
 * array of account objects (or `{"users": [...]}`), served exactly as given. With an empty
 * inventory every live Mirza service is "not on the panel" and stays history/review; that
 * is the expected outcome of the first rehearsal stage, not a failure.
 *
 * One JSON line per request on stdout: time, method, path, status and kind
 * (`token` | `read` | `refused` | `unauthorized` | `not_found`). Never a body, a password,
 * a token or a header. `{"event":"listening",...}` is the first line.
 *
 * Plain Node (no dependencies), so it runs from the NEXA image itself in the rehearsal's
 * compose file and from the unit tests.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_PAGE = 5_000;

/**
 * @param {{ username: string, password: string, users?: unknown[], log?: (line: object) => void,
 *           version?: string }} options
 */
export function createStandin(options) {
  const { username, password } = options;
  if (typeof username !== 'string' || username.length === 0) throw new Error('username required');
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('password required (at least 12 characters)');
  }
  const users = (options.users ?? []).map(checkedAccount);
  const byName = new Map(users.map((user) => [String(user.username).toLowerCase(), user]));
  if (byName.size !== users.length) throw new Error('the inventory names an account twice');
  const log = options.log ?? ((line) => process.stdout.write(`${JSON.stringify(line)}\n`));
  const tokens = new Set();
  const counts = { token: 0, read: 0, refused: 0, unauthorized: 0, not_found: 0 };

  const server = createServer((request, response) => {
    const method = request.method ?? 'GET';
    const rawUrl = request.url ?? '/';
    const path = rawUrl.split('?')[0] ?? '/';
    let received = 0;
    const chunks = [];
    let overflow = false;
    request.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) overflow = true;
      else chunks.push(chunk);
    });
    request.on('end', () => {
      const answer = (status, kind, value) => {
        counts[kind] += 1;
        log({ at: new Date().toISOString(), method, path: loggedPath(rawUrl), status, kind });
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };

      if (method === 'POST' && path === '/api/admin/token' && !overflow) {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        if (form.get('username') !== username || form.get('password') !== password) {
          return answer(401, 'unauthorized', { detail: 'Incorrect username or password' });
        }
        const token = randomBytes(24).toString('base64url');
        tokens.add(token);
        return answer(200, 'token', { access_token: token, token_type: 'bearer' });
      }

      if (method !== 'GET' || !isReadPath(path)) {
        return answer(405, 'refused', {
          detail: 'read-only rehearsal stand-in: nothing is written',
        });
      }

      const authorization = String(request.headers['authorization'] ?? '');
      const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!tokens.has(bearer)) {
        return answer(401, 'unauthorized', { detail: 'Could not validate credentials' });
      }

      if (path === '/api/system') {
        return answer(200, 'read', { version: options.version ?? 'rehearsal-standin' });
      }
      if (path === '/api/users') {
        const query = new URLSearchParams(rawUrl.split('?')[1] ?? '');
        const offset = boundedInt(query.get('offset'), 0);
        const limit = Math.min(boundedInt(query.get('limit'), 0), MAX_PAGE);
        return answer(200, 'read', {
          users: users.slice(offset, offset + limit),
          total: users.length,
        });
      }
      const name = decodeURIComponent(path.slice('/api/user/'.length)).toLowerCase();
      const user = byName.get(name);
      if (user === undefined) return answer(404, 'not_found', { detail: 'User not found' });
      return answer(200, 'read', user);
    });
  });

  return { server, counts };
}

/** The three GET routes; anything deeper (`/api/user/x/files`, …) is not one of them. */
function isReadPath(path) {
  return path === '/api/system' || path === '/api/users' || /^\/api\/user\/[^/]+$/u.test(path);
}

/** The path with only `offset` and `limit` kept: nothing a caller sends is echoed. */
function loggedPath(rawUrl) {
  const [path, query] = rawUrl.split('?');
  if (query === undefined) return path;
  const params = new URLSearchParams(query);
  const kept = ['offset', 'limit']
    .filter((key) => params.has(key))
    .map((key) => `${key}=${String(boundedInt(params.get(key), 0))}`);
  return kept.length === 0 ? path : `${path}?${kept.join('&')}`;
}

function boundedInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

function checkedAccount(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof value.username !== 'string' ||
    value.username.length === 0
  ) {
    throw new Error('every inventory entry must be an object with a non-empty string username');
  }
  return value;
}

/** Reads `RICKPANEL_STANDIN_INVENTORY`: an array, or `{"users": [...]}`. */
export function readInventory(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const users = Array.isArray(parsed) ? parsed : parsed?.users;
  if (!Array.isArray(users)) throw new Error('the inventory file holds no account array');
  return users;
}

async function main() {
  const env = process.env;
  const port = boundedInt(env.RICKPANEL_STANDIN_PORT ?? '8000', 8000);
  const host = env.RICKPANEL_STANDIN_HOST ?? '0.0.0.0';
  const inventory = env.RICKPANEL_STANDIN_INVENTORY;
  const users = inventory ? readInventory(inventory) : [];
  const { server, counts } = createStandin({
    username: env.RICKPANEL_STANDIN_USERNAME ?? '',
    password: env.RICKPANEL_STANDIN_PASSWORD ?? '',
    users,
  });
  server.listen(port, host, () => {
    const address = server.address();
    process.stdout.write(
      `${JSON.stringify({
        event: 'listening',
        port: typeof address === 'object' && address !== null ? address.port : port,
        accounts: users.length,
      })}\n`,
    );
  });
  const stop = () => {
    process.stdout.write(`${JSON.stringify({ event: 'summary', counts })}\n`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `rickpanel-standin: ${error instanceof Error ? error.message : 'failed'}\n`,
    );
    process.exit(1);
  });
}
