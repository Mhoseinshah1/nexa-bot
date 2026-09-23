import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PANEL_ACTIVATION_SCHEMAS,
  PROVIDER_FAILURE_DEFINITIVE,
  PROVIDER_FAILURE_RETRYABLE,
  SAFE_TO_REPLAY_FAILURE_KINDS,
  operationFailureOutcome,
  providerDescriptor,
  type CreateProviderUserInput,
  type ProviderServiceTarget,
  type ProviderTarget,
  type ProviderUserRef,
} from '@nexa/contracts';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import {
  RICKPANEL_CREATE_PROXY_SEED,
  RickpanelAdapter,
} from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel.adapter';
import {
  providerAdapter,
  providerServiceAdapter,
  SERVICE_PROVIDER_TYPES,
} from '../../apps/api/src/modules/platform/providers/infrastructure/adapter-registry';

/**
 * The RickPanel adapter, against a deterministic fake RickPanel.
 *
 * ## What these tests prove, and what they do not
 *
 * They prove the adapter handles the shapes `rickpanel-openapi.json` DESCRIBES:
 * a form-encoded token exchange, a create that returns before the nodes have the
 * user, a 409 for a name in use, a 400 that carries a rule, a 403 on a delete a
 * service will not allow.
 *
 * They do not prove those shapes are right. `docs/real-panel-acceptance.md` is
 * explicit that a fake this repository wrote and an adapter this repository
 * wrote can only prove they agree with each other — four defects reached `main`
 * that way. **No RickPanel has been contacted.**
 * `tests/acceptance/real-panel-rickpanel.test.ts` is what turns this into
 * evidence and it has not been run.
 *
 * ## The fake is built from the document's PROSE
 *
 * Deliberately, because the document's schemas are lossy: `UserCreate` types
 * `expire` as a string while its own description calls it "a UTC timestamp in
 * seconds", and declares no `username` at all while documenting a 409 for a name
 * in use. `docs/rickpanel-adapter-audit.md` §1 records which half is trusted.
 */

interface FakeUser {
  readonly username: string;
  expire: number;
  data_limit: number;
  used_traffic: number;
  status: string;
  subscription_url: string;
  /**
   * What RickPanel materialises from the create's seed: a credential per protocol.
   * Real-panel evidence (`docs/rickpanel-create-hotfix.md` §2) — a create seeded with
   * `{"vless": {}}` came back holding records for SEVERAL protocols. Carried here so a
   * test can prove none of it leaves the adapter.
   */
  proxies: Record<string, Record<string, string>>;
  sub_token: string;
}

type CreateMode =
  | 'accepts'
  /** The documented asynchronous case: accepted, not readable for N reads. */
  | 'accepts-after-delay'
  /** A name already in use, held by THIS admin. */
  | 'conflict-owned'
  /** A name in use by ANOTHER admin: 409 on create, 404 on read. */
  | 'conflict-foreign'
  /** "a rejection answers 400 saying which rule was hit" */
  | 'refuses-rule'
  | 'forbidden'
  | 'rate-limited'
  | 'server-error'
  /** A body the panel will not process. What a real one answers is `OQ-RP-06`. */
  | 'unprocessable'
  /** A 200 whose user, once readable, carries no subscription of any shape. */
  | 'no-subscription';

let server: Server;
let base: string;
let tokenStatus = 200;
let tokenBody: unknown = { access_token: 'a-real-jwt', token_type: 'bearer' };
let createMode: CreateMode = 'accepts';
let readsBeforeVisible = 0;
let deleteStatus: number | null = null;
let putStatus: number | null = null;
/**
 * The status the fake answers a create whose `proxies` is missing or empty.
 *
 * The REFUSAL is real-panel evidence: the create that omitted `proxies` failed on the
 * owner's correctly connected panel, and the same create seeded with `{"vless": {}}`
 * answered 200. The STATUS is not: nobody has captured it. 422 is what a FastAPI body
 * validator answers and what the observed create-reconcile-create cycle needs, but it
 * is `OQ-RP-06`, not a fact — which is why it is a variable and the tests that depend
 * on it name both candidates.
 */
let missingSeedStatus = 422;
/**
 * How `POST /api/user/{name}/revoke_sub` behaves. Each mode is one row of
 * `docs/rickpanel-rotate-audit.md` D4 — the modes that ROTATE change the stored link
 * before answering, so a test can tell a rotation from its answer.
 */
type RevokeMode =
  /** The owner's evidence: 200, and the link and token change. */
  | 'rotates'
  /** Rotates, then answers 500: the rotation happened and its answer was lost. */
  | 'rotates-then-500'
  /**
   * Rotates, then drops the connection without answering. The client reports a
   * socket that died after the request was written, which it classifies as
   * UNREACHABLE; the read is what says the rotation happened.
   */
  | 'rotates-then-drops'
  /** 500, and nothing changed. */
  | 'fails-500'
  /** 200, and nothing changed: a panel claiming a rotation it did not make. */
  | 'no-op-200'
  | 'refuses'
  | 'rate-limited';
let revokeMode: RevokeMode = 'rotates';
let rotations = 0;
let users = new Map<string, FakeUser>();
let foreign = new Set<string>();
let requests: { method: string; path: string; body: string; auth: string }[] = [];

const userRecord = (username: string): FakeUser => ({
  username,
  expire: 1_800_000_000,
  data_limit: 53_687_091_200,
  used_traffic: 0,
  status: 'active',
  subscription_url: `/sub/${username}-token`,
  proxies: {
    vless: { id: 'internal-vless-credential' },
    vmess: { id: 'internal-vmess-credential' },
    trojan: { password: 'internal-trojan-credential' },
  },
  sub_token: `${username}-token`,
});

/** A non-empty object, which is the one shape the real panel was seen to accept. */
const isSeeded = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = (request.url ?? '/').split('?')[0] ?? '/';
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: request.method ?? 'GET',
        path: url,
        body,
        auth: String(request.headers['authorization'] ?? ''),
      });
      const json = (status: number, value: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };

      if (url === '/api/admin/token') return json(tokenStatus, tokenBody);
      if (url === '/api/system') return json(200, { version: '2.1.0' });

      if (url === '/api/user' && request.method === 'POST') {
        const sent = JSON.parse(body) as { username?: unknown; proxies?: unknown };
        const name = String(sent.username ?? '');
        /*
         * Checked BEFORE any rule, as a body validator runs before the handler that
         * applies them: an unseeded create never reaches the user limit.
         */
        if (!isSeeded(sent.proxies)) {
          return json(missingSeedStatus, {
            detail: [{ loc: ['body', 'proxies'], msg: 'field required', type: 'value_error' }],
          });
        }
        switch (createMode) {
          case 'refuses-rule':
            return json(400, { detail: 'user limit reached for this admin' });
          case 'forbidden':
            return json(403, { detail: 'forbidden' });
          case 'rate-limited':
            return json(429, { detail: 'slow down' });
          case 'server-error':
            return json(500, { detail: 'boom' });
          case 'unprocessable':
            return json(422, { detail: [{ loc: ['body'], msg: 'invalid', type: 'value_error' }] });
          case 'conflict-owned':
            users.set(name, userRecord(name));
            return json(409, { detail: 'username already exists' });
          case 'conflict-foreign':
            foreign.add(name);
            return json(409, { detail: 'username already exists' });
          case 'no-subscription': {
            const held = userRecord(name);
            users.set(name, { ...held, subscription_url: '' });
            return json(200, { username: name });
          }
          case 'accepts-after-delay':
          case 'accepts':
          default:
            users.set(name, {
              ...userRecord(name),
              // The entitlement as SENT, so a test can prove the adapter asked for
              // exactly what the order bought.
              expire: Number((JSON.parse(body) as { expire?: unknown }).expire ?? 0),
              data_limit: Number((JSON.parse(body) as { data_limit?: unknown }).data_limit ?? 0),
            });
            // The documented behaviour: the response carries no proof, and the
            // adapter must not read a subscription out of it.
            return json(200, { username: name, detail: 'accepted' });
        }
      }

      const revoke = /^\/api\/user\/([^/]+)\/revoke_sub$/.exec(url);
      if (revoke !== null && request.method === 'POST') {
        const held = users.get(decodeURIComponent(revoke[1] ?? ''));
        if (held === undefined) return json(404, { detail: 'User not found' });
        const rotate = (): void => {
          rotations += 1;
          held.subscription_url = `/sub/${held.username}-rotated-${String(rotations)}`;
          held.sub_token = `${held.username}-rotated-${String(rotations)}`;
        };
        switch (revokeMode) {
          case 'rotates':
            rotate();
            return json(200, { username: held.username });
          case 'rotates-then-500':
            rotate();
            return json(500, { detail: 'boom' });
          case 'rotates-then-drops':
            rotate();
            response.destroy();
            return;
          case 'fails-500':
            return json(500, { detail: 'boom' });
          case 'no-op-200':
            return json(200, { username: held.username });
          case 'refuses':
            return json(400, { detail: 'your service does not allow this' });
          case 'rate-limited':
            return json(429, { detail: 'slow down' });
        }
      }

      const match = /^\/api\/user\/([^/]+)$/.exec(url);
      if (match !== null) {
        const name = decodeURIComponent(match[1] ?? '');
        if (request.method === 'GET') {
          if (createMode === 'accepts-after-delay' && readsBeforeVisible > 0) {
            readsBeforeVisible -= 1;
            return json(404, { detail: 'User not found' });
          }
          // A user another admin owns answers 404 "the same as one that does
          // not exist" — the document's own words, and the whole reason a 409
          // cannot be adopted without asking.
          if (foreign.has(name)) return json(404, { detail: 'User not found' });
          const held = users.get(name);
          if (held === undefined) return json(404, { detail: 'User not found' });
          if (held.subscription_url === '') {
            const { subscription_url: _dropped, ...rest } = held;
            return json(200, rest);
          }
          return json(200, held);
        }
        if (request.method === 'PUT') {
          if (putStatus !== null) return json(putStatus, { detail: 'refused' });
          const held = users.get(name);
          if (held === undefined) return json(404, { detail: 'User not found' });
          const patch = JSON.parse(body) as Record<string, unknown>;
          if (typeof patch['status'] === 'string') held.status = patch['status'];
          if (typeof patch['expire'] === 'number') held.expire = patch['expire'];
          if (typeof patch['data_limit'] === 'number') held.data_limit = patch['data_limit'];
          return json(200, held);
        }
        if (request.method === 'DELETE') {
          if (deleteStatus !== null) return json(deleteStatus, { detail: 'refused' });
          if (!users.delete(name)) return json(404, { detail: 'User not found' });
          return json(200, { detail: 'User successfully deleted' });
        }
      }
      json(404, { detail: 'not found' });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  tokenStatus = 200;
  tokenBody = { access_token: 'a-real-jwt', token_type: 'bearer' };
  createMode = 'accepts';
  readsBeforeVisible = 0;
  deleteStatus = null;
  putStatus = null;
  missingSeedStatus = 422;
  revokeMode = 'rotates';
  rotations = 0;
  users = new Map();
  foreign = new Set();
  requests = [];
});

const http = () =>
  new SafeHttpClient({
    allowLoopback: true,
    totalTimeoutMs: 2_000,
    maxResponseBytes: 64 * 1024,
    maxRetries: 0,
  }).forBase(base);

const CREDENTIALS: ProviderTarget['credentials'] = {
  shape: 'USERNAME_PASSWORD',
  username: 'admin',
  password: 'a-real-password',
};

/** No real waiting: the poll's SHAPE is what is under test, not the calendar. */
const adapter = () => new RickpanelAdapter({ readBackDelayMs: 0, sleep: () => Promise.resolve() });

/*
 * An EMPTY activation, and the tests below are what make that meaningful:
 * RickPanel needs nothing configured, so every call here runs against a panel an
 * operator has set no protocol and no inbound on. Under `marzban` this target
 * could not be sold onto at all.
 */
const target = (): ProviderServiceTarget => ({
  baseUrl: base,
  credentials: CREDENTIALS,
  activation: {},
});

/** The three handles a service row carries. Only the first reaches this panel. */
const REF: ProviderUserRef = {
  username: 'nxuhdjwuc3m5',
  subscriptionRef: 'sub-ref-not-sent-to-rickpanel',
  clientId: '019250ab-cdef-7012-8345-6789abcdef01',
};

const ref = (username: string): ProviderUserRef => ({ ...REF, username });

const CREATE: CreateProviderUserInput = {
  ...REF,
  serviceId: '019240ab-cdef-7012-8345-6789abcdef01' as CreateProviderUserInput['serviceId'],
  expiresAt: new Date('2027-01-01T00:00:00.000Z'),
  volumeBytes: 53_687_091_200n,
  durationDays: 30,
  deviceLimit: null,
};

const reads = () =>
  requests.filter((one) => one.method === 'GET' && one.path.includes('/api/user/'));

// ---------------------------------------------------------------------------
// The contract: what the type declares before any wire is touched
// ---------------------------------------------------------------------------

describe('RickPanel as a provider type', () => {
  it('is registered, and is not an alias of marzban', () => {
    const rick = providerAdapter('rickpanel');
    const marzban = providerAdapter('marzban');
    expect(rick.descriptor.key).toBe('rickpanel');
    expect(marzban.descriptor.key).toBe('marzban');
    // The failure this guards is a registry entry pointing one type at the
    // other's adapter, which is how a RickPanel comes to be operated by
    // Marzban's rules.
    expect(rick.constructor).not.toBe(marzban.constructor);
  });

  it('can create services, so a rickpanel panel is sellable at all', () => {
    expect(SERVICE_PROVIDER_TYPES).toContain('rickpanel');
    expect(providerServiceAdapter('rickpanel').descriptor.key).toBe('rickpanel');
  });

  /**
   * The finding that connects this to the hotfix.
   *
   * `decideEligibility` refuses a sale when a panel's activation does not parse.
   * A RickPanel registered as `marzban` would need `proxyProtocols` and
   * `inboundTags` configured — two fields RickPanel documents it IGNORES — so
   * the operator would have to invent a fiction to make their own panel
   * sellable. Under its own type there is nothing to configure.
   */
  it('requires no activation, where marzban requires two fields', () => {
    expect(providerDescriptor('rickpanel')?.requiredActivationFields).toEqual([]);
    expect(providerDescriptor('marzban')?.requiredActivationFields).toEqual([
      'proxyProtocols',
      'inboundTags',
    ]);
    // An empty object satisfies it, and so does the absence of one.
    expect(PANEL_ACTIVATION_SCHEMAS.rickpanel.safeParse({}).success).toBe(true);
    // And a Marzban payload pasted in is REFUSED rather than silently kept,
    // because accepting it would let an operator believe they configured
    // something this panel will throw away.
    expect(
      PANEL_ACTIVATION_SCHEMAS.rickpanel.safeParse({ proxyProtocols: ['vless'] }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('RickPanel authentication', () => {
  it('exchanges the credentials as a FORM grant and carries a bearer afterwards', async () => {
    const outcome = await adapter().probe(target(), http());
    expect(outcome.ok).toBe(true);

    const login = requests.find((one) => one.path === '/api/admin/token');
    // The document's schema says JSON and its description says form-encoded.
    // The description is the contract; this is the assertion that pins it.
    expect(login?.body).toContain('username=admin');
    expect(login?.body).toContain('grant_type=password');
    expect(login?.body.startsWith('{')).toBe(false);

    const system = requests.find((one) => one.path === '/api/system');
    expect(system?.auth).toBe('Bearer a-real-jwt');
  });

  it('never puts the password on any request but the token exchange', async () => {
    await adapter().createUser(target(), http(), CREATE);
    for (const one of requests) {
      if (one.path === '/api/admin/token') continue;
      expect(one.body).not.toContain('a-real-password');
      expect(one.auth).not.toContain('a-real-password');
    }
  });

  it('reports a rejected credential as AUTHENTICATION_FAILED, never as a panel fault', async () => {
    for (const status of [401, 403]) {
      tokenStatus = status;
      tokenBody = { detail: 'no' };
      const outcome = await adapter().createUser(target(), http(), CREATE);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.failure).toBe('AUTHENTICATION_FAILED');
      // And nothing was created: the create never ran.
      expect(users.size).toBe(0);
    }
  });

  it('refuses a 200 that carries no token rather than reporting a working panel', async () => {
    tokenBody = { token_type: 'bearer' };
    const outcome = await adapter().probe(target(), http());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toBe('MALFORMED_RESPONSE');
  });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe('RickPanel create', () => {
  it('sends the fixed proxies seed and no inbounds', async () => {
    await adapter().createUser(target(), http(), CREATE);
    const create = requests.find((one) => one.method === 'POST' && one.path === '/api/user');
    const payload = JSON.parse(create?.body ?? '{}') as Record<string, unknown>;

    expect(payload['username']).toBe('nxuhdjwuc3m5');
    // Seconds, not milliseconds. The factor of a thousand is an expiry in 2027
    // against one in 1970.
    expect(payload['expire']).toBe(Math.floor(Date.parse('2027-01-01T00:00:00.000Z') / 1000));
    expect(payload['data_limit']).toBe(53_687_091_200);
    // The one seed measured on a real panel, byte for byte: one protocol key and an
    // EMPTY object, which asks the panel to generate the credential. A seed that
    // carried a credential would be Nexa inventing one.
    expect(payload['proxies']).toEqual({ vless: {} });
    expect(RICKPANEL_CREATE_PROXY_SEED).toEqual({ vless: {} });
    // Sending a value the panel throws away would leave an operator believing
    // they had configured something.
    expect(payload).not.toHaveProperty('inbounds');
    // OQ-RP-02: the create is not documented to take a status, so none is sent.
    expect(payload).not.toHaveProperty('status');
  });

  /**
   * THE ASYNCHRONOUS RULE. A 200 is an acknowledgement, not a delivery.
   *
   * Asserted on the REQUESTS rather than only on the outcome: an adapter that
   * read the subscription out of the create response would return the same
   * `ok: true` and make no second call, so counting the reads is what
   * distinguishes the two implementations.
   */
  it('reads the user back before it claims a delivery', async () => {
    const outcome = await adapter().createUser(target(), http(), CREATE);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.delivery).toEqual({
      kind: 'SUBSCRIPTION_LINK',
      url: `${base}/sub/nxuhdjwuc3m5-token`,
    });
    expect(reads()).toHaveLength(1);
    // The link came from the RECORD. The create response carries no such field
    // at all, so an adapter reading it would have produced nothing.
    const created = requests.find((one) => one.method === 'POST' && one.path === '/api/user');
    expect(created?.body).not.toContain('subscription');
  });

  it('polls a bounded number of times while the user is still propagating', async () => {
    createMode = 'accepts-after-delay';
    readsBeforeVisible = 2;
    const outcome = await adapter().createUser(target(), http(), CREATE);
    expect(outcome.ok).toBe(true);
    // Two 404s then the record: exactly the three the adapter is configured for.
    expect(reads()).toHaveLength(3);
  });

  /**
   * Propagation that outlasts the poll is UNKNOWN, never a retryable create.
   *
   * The distinction is the whole safety property. A retryable kind on a
   * PROVISION means the CREATE runs again, which is a second account the
   * customer did not buy. `UNKNOWN` sends the service to `UNRECONCILED` and a
   * READ adopts the account when it appears.
   */
  it('reports a still-invisible user as UNKNOWN rather than retrying the create', async () => {
    createMode = 'accepts-after-delay';
    readsBeforeVisible = 99;
    const outcome = await adapter().createUser(target(), http(), CREATE);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toBe('MALFORMED_RESPONSE');
    expect(operationFailureOutcome(outcome.failure, 'PROVISION')).toBe('UNKNOWN');
    expect(PROVIDER_FAILURE_RETRYABLE[outcome.failure]).toBe(false);
    expect(reads()).toHaveLength(3);
  });

  it('reports a created user with no readable subscription as UNKNOWN, not delivered', async () => {
    createMode = 'no-subscription';
    const outcome = await adapter().createUser(target(), http(), CREATE);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The account exists and cannot be delivered. Claiming success would mark a
    // service DELIVERED that no customer received.
    expect(outcome.failure).toBe('MALFORMED_RESPONSE');
    expect(operationFailureOutcome(outcome.failure, 'PROVISION')).toBe('UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// The NEW_SERVICE hotfix: docs/rickpanel-create-hotfix.md
// ---------------------------------------------------------------------------

describe('RickPanel create hotfix', () => {
  /**
   * The defect, reproduced. A panel that refuses an unseeded create refused EVERY
   * create this adapter sent, whichever status it used: 400 refunded at once, and 422
   * — `PROVIDER_ERROR`, so UNKNOWN for a PROVISION — went round create, reconcile,
   * absent, create until the cycle limit refunded it. Both end in the customer's
   * money coming back and no service, which is what the owner saw.
   *
   * The seed is what changes the answer, for either status.
   */
  it.each([400, 422])(
    'is delivered by a panel that refuses an unseeded create with %i',
    async (status) => {
      missingSeedStatus = status;
      const outcome = await adapter().createUser(target(), http(), CREATE);
      expect(outcome.ok, 'the create was refused: the proxies seed did not reach the panel').toBe(
        true,
      );
      if (!outcome.ok) return;
      expect(outcome.delivery).toEqual({
        kind: 'SUBSCRIPTION_LINK',
        url: `${base}/sub/nxuhdjwuc3m5-token`,
      });
      expect(users.has('nxuhdjwuc3m5')).toBe(true);
    },
  );

  /**
   * A 422 is NOT generalised into a refusal. Nobody has captured what this panel
   * answers a body it will not parse (`OQ-RP-06`), and the two mistakes cost
   * different things: calling an ambiguous answer a refusal refunds an account the
   * customer may be holding, while calling a refusal ambiguous costs a READ. So it
   * stays `PROVIDER_ERROR` — UNKNOWN, reconciled by a read, never a second blind
   * create — until real evidence moves it.
   */
  it('keeps a 422 on create UNKNOWN until real evidence classifies it', async () => {
    createMode = 'unprocessable';
    const outcome = await adapter().createUser(target(), http(), CREATE);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toBe('PROVIDER_ERROR');
    expect(outcome.status).toBe(422);
    expect(operationFailureOutcome(outcome.failure, 'PROVISION')).toBe('UNKNOWN');
    expect(SAFE_TO_REPLAY_FAILURE_KINDS).not.toContain(outcome.failure);
    // No read on the create path: the reconcile that follows is the read, once.
    expect(reads()).toHaveLength(0);
  });

  /**
   * A LIMITED plan reaches the panel as bought. The fake stores what it was sent,
   * so the record read back is the request, not a default: a create that dropped the
   * cap to satisfy a panel would show zero here.
   */
  it('creates a limited plan with exactly the traffic and expiry it was sold', async () => {
    const outcome = await adapter().createUser(target(), http(), {
      ...CREATE,
      volumeBytes: 1_073_741_824n,
    });
    expect(outcome.ok).toBe(true);
    const held = users.get('nxuhdjwuc3m5');
    expect(held?.data_limit).toBe(1_073_741_824);
    expect(held?.expire).toBe(Math.floor(Date.parse('2027-01-01T00:00:00.000Z') / 1000));
  });

  /**
   * An UNLIMITED plan is the panel's 0, for traffic and for time. Nothing is
   * invented to fill the gap: no default cap, no default term.
   */
  it('creates an unlimited plan as the panel unlimited, with nothing invented', async () => {
    const outcome = await adapter().createUser(target(), http(), {
      ...CREATE,
      volumeBytes: null,
      expiresAt: null,
    });
    expect(outcome.ok).toBe(true);
    const create = requests.find((one) => one.method === 'POST' && one.path === '/api/user');
    const payload = JSON.parse(create?.body ?? '{}') as Record<string, unknown>;
    expect(payload['data_limit']).toBe(0);
    expect(payload['expire']).toBe(0);
    expect(users.get('nxuhdjwuc3m5')?.data_limit).toBe(0);
  });

  /**
   * The panel's generated credentials stay on the panel.
   *
   * The read-back record holds a credential per protocol and a `sub_token`. The
   * customer receives the subscription link; nothing else from that record may
   * leave the adapter, in the delivery or beside it.
   */
  it('delivers the subscription link and none of the credentials the panel generated', async () => {
    const outcome = await adapter().createUser(target(), http(), CREATE);
    expect(outcome.ok).toBe(true);
    const text = asLogged(outcome);
    expect(text).not.toContain('internal-vless-credential');
    expect(text).not.toContain('internal-vmess-credential');
    expect(text).not.toContain('internal-trojan-credential');
    expect(text).not.toContain('proxies');
    expect(text).not.toContain('sub_token');
  });
});

// ---------------------------------------------------------------------------
// 409
// ---------------------------------------------------------------------------

describe('RickPanel 409 is refused, never adopted', () => {
  /**
   * The name exists and the panel will show it to us, and we still refuse.
   *
   * This case used to assert the opposite — that the record was adopted as our
   * own earlier create landing — and Codex C2 (P1) on PR #58 is why it now
   * asserts a refusal. A panel answers for every user ITS ADMIN owns, not for
   * every user WE made, so "visible to us" never proved "created by us". An
   * operator pointing Nexa at a panel that already has customers on it is the
   * documented way to adopt one, and a customer typing an existing CUSTOM name
   * would have been handed that account's subscription URL as their own.
   *
   * The delivery assertion is the load-bearing one: whatever else changes, the
   * outcome must not carry a URL read off somebody else's record.
   */
  it('refuses a name that already exists even when the panel will show it to us', async () => {
    createMode = 'conflict-owned';
    const outcome = await adapter().createUser(target(), http(), CREATE);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toBe('PROVIDER_REFUSED');
    expect(outcome.status).toBe(409);
    // Never a second create, and never a create under a different name.
    const creates = requests.filter((one) => one.method === 'POST' && one.path === '/api/user');
    expect(creates).toHaveLength(1);
    // And no read at all: there is no question a read could answer here, and
    // asking one is what produced the adoption this case exists to forbid.
    expect(reads()).toHaveLength(0);
  });

  /**
   * The same answer when the name belongs to another admin and the read would
   * have returned 404 — the document says a user you do not own answers 404
   * "the same as one that does not exist".
   *
   * Both 409 shapes now end identically, which is the point: the adapter cannot
   * tell them apart and no longer pretends to. Terminal on the first attempt, so
   * the order fails once and the customer is refunded rather than waiting out
   * five attempts against a name that will never be free.
   */
  it('refuses a name held by another admin instead of retrying it', async () => {
    createMode = 'conflict-foreign';
    const outcome = await adapter().createUser(target(), http(), CREATE);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toBe('PROVIDER_REFUSED');
    expect(outcome.status).toBe(409);
    expect(PROVIDER_FAILURE_RETRYABLE[outcome.failure]).toBe(false);
    expect(operationFailureOutcome(outcome.failure, 'PROVISION')).toBe('FAILED');
    expect(reads()).toHaveLength(0);
  });

  /**
   * A refusal must not leak what it saw. `conflict-owned` is the case where a
   * real subscription URL was within reach, so this asserts the refusal carries
   * a status and a kind and nothing read off the panel.
   */
  it('carries no subscription, token or panel text out of a conflict', async () => {
    createMode = 'conflict-owned';
    const outcome = await adapter().createUser(target(), http(), CREATE);
    const logged = asLogged(outcome);
    expect(logged).not.toContain('token');
    expect(logged).not.toContain('/sub/');
    expect(logged).not.toContain('already exists');
  });
});

// ---------------------------------------------------------------------------
// Terminal and retryable classification
// ---------------------------------------------------------------------------

describe('RickPanel failure classification', () => {
  /**
   * The production incident, in one assertion.
   *
   * A deterministic refusal retried five times over seven minutes is what order
   * `01a0c54b` cost. `PROVIDER_REFUSED` is non-retryable AND safe to replay, so
   * the operation fails once, terminally, and the refund runs in that
   * transaction rather than after four more attempts.
   */
  it('treats a 400 rule refusal as terminal and refundable, not as a retry', async () => {
    createMode = 'refuses-rule';
    const outcome = await adapter().createUser(target(), http(), CREATE);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toBe('PROVIDER_REFUSED');
    expect(outcome.status).toBe(400);
    expect(PROVIDER_FAILURE_RETRYABLE.PROVIDER_REFUSED).toBe(false);
    expect(PROVIDER_FAILURE_DEFINITIVE.PROVIDER_REFUSED).toBe('DEFINITIVE');
    expect(SAFE_TO_REPLAY_FAILURE_KINDS).toContain('PROVIDER_REFUSED');
    expect(operationFailureOutcome('PROVIDER_REFUSED', 'PROVISION')).toBe('FAILED');
    // And nothing reached the panel's user table, which is why FAILED is safe.
    expect(users.size).toBe(0);
    // No read either: there is nothing to adopt.
    expect(reads()).toHaveLength(0);
  });

  it('treats a 403 on create the same way', async () => {
    createMode = 'forbidden';
    const outcome = await adapter().createUser(target(), http(), CREATE);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toBe('PROVIDER_REFUSED');
    expect(outcome.status).toBe(403);
  });

  it('keeps a rate limit apart from both a refusal and a fault', async () => {
    createMode = 'rate-limited';
    const outcome = await adapter().createUser(target(), http(), CREATE);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Three kinds, three remedies. A 429 says the cadence is ours to fix; a 400
    // says the panel's rules are the operator's; a 500 says look at the panel.
    expect(outcome.failure).toBe('RATE_LIMITED');
    expect(PROVIDER_FAILURE_RETRYABLE.RATE_LIMITED).toBe(true);
  });

  it('keeps a 5xx retryable, because a create that 500s may have committed', async () => {
    createMode = 'server-error';
    const outcome = await adapter().createUser(target(), http(), CREATE);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toBe('PROVIDER_ERROR');
    // NOT safe to replay: the create may have landed, so this reconciles rather
    // than refunding. The difference from `PROVIDER_REFUSED` is the whole point
    // of declaring a second kind.
    expect(operationFailureOutcome('PROVIDER_ERROR', 'PROVISION')).toBe('UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// Rotation: docs/rickpanel-rotate-audit.md D4, one test per row
// ---------------------------------------------------------------------------

describe('RickPanel subscription rotation', () => {
  const NAME = 'nxuhdjwuc3m5';
  const previous = () => `${base}/sub/${NAME}-token`;
  const rotate = () => adapter().rotateSubscription(target(), http(), ref(NAME), previous());
  const posts = () =>
    requests.filter((one) => one.method === 'POST' && one.path.endsWith('/revoke_sub'));

  beforeEach(() => {
    users.set(NAME, userRecord(NAME));
  });

  it('rotates through revoke_sub and returns the link it READ back', async () => {
    const outcome = await rotate();
    expect(outcome).toEqual({
      ok: true,
      found: true,
      subscriptionUrl: `${base}/sub/${NAME}-rotated-1`,
    });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.path).toBe(`/api/user/${NAME}/revoke_sub`);
    // A rotation asks for nothing else: no PUT, so expiry, limit and status cannot move.
    expect(requests.some((one) => one.method === 'PUT')).toBe(false);
    expect(reads()).toHaveLength(1);
  });

  it('refuses a 200 that left the link unchanged, and it is terminal', async () => {
    revokeMode = 'no-op-200';
    const outcome = await rotate();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toBe('MALFORMED_RESPONSE');
    expect(PROVIDER_FAILURE_RETRYABLE[outcome.failure]).toBe(false);
    expect(operationFailureOutcome(outcome.failure, 'ROTATE_SUBSCRIPTION')).toBe('FAILED');
  });

  it('reports a rotation that happened even when its answer was a 500', async () => {
    revokeMode = 'rotates-then-500';
    const outcome = await rotate();
    expect(outcome).toEqual({
      ok: true,
      found: true,
      subscriptionUrl: `${base}/sub/${NAME}-rotated-1`,
    });
  });

  it('reads back after a connection that dropped, and counts the rotation it finds', async () => {
    /*
     * The transport classifies a socket that died after the request was written as
     * UNREACHABLE, a kind the contract lists as never read. For a rotation that is
     * not safe to believe: the panel may have acted. So every transport failure is
     * followed by the read, and the read decides.
     */
    revokeMode = 'rotates-then-drops';
    const outcome = await rotate();
    expect(outcome).toEqual({
      ok: true,
      found: true,
      subscriptionUrl: `${base}/sub/${NAME}-rotated-1`,
    });
    expect(posts()).toHaveLength(1);
  });

  it('returns the original failure when the read proves nothing rotated', async () => {
    revokeMode = 'fails-500';
    const outcome = await rotate();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toBe('PROVIDER_ERROR');
    expect(outcome.status).toBe(500);
    // Retried, never UNKNOWN: a rotation is a convergent mutation.
    expect(operationFailureOutcome(outcome.failure, 'ROTATE_SUBSCRIPTION')).toBe('FAILED');
    expect(reads()).toHaveLength(3);
  });

  it('answers found:false for an account the panel does not hold', async () => {
    users.delete(NAME);
    expect(await rotate()).toEqual({ ok: true, found: false });
  });

  it.each([
    ['refuses', 'PROVIDER_REFUSED', 400],
    ['rate-limited', 'RATE_LIMITED', 429],
  ] as const)('returns a %s answer as it is, without reading', async (mode, failure, status) => {
    revokeMode = mode;
    const outcome = await rotate();
    expect(outcome).toEqual({ ok: false, failure, status });
    expect(reads()).toHaveLength(0);
    expect(users.get(NAME)?.subscription_url).toBe(`/sub/${NAME}-token`);
  });

  it('carries the new link in one field and no credential anywhere', async () => {
    const outcome = await rotate();
    const text = asLogged(outcome);
    expect(text).not.toContain('a-real-password');
    expect(text).not.toContain('a-real-jwt');
    expect(text).not.toContain('internal-vless-credential');
    expect(text).not.toContain('sub_token');
  });
});

// ---------------------------------------------------------------------------
// Read, lifecycle and usage
// ---------------------------------------------------------------------------

describe('RickPanel user retrieval and lifecycle', () => {
  it('reads a user back with its subscription and usage', async () => {
    users.set('nxuhdjwuc3m5', { ...userRecord('nxuhdjwuc3m5'), used_traffic: 1024 });
    const found = await adapter().lookupUser(target(), http(), ref('nxuhdjwuc3m5'));
    expect(found.ok).toBe(true);
    if (!found.ok || !found.found) return;
    expect(found.delivery).toEqual({
      kind: 'SUBSCRIPTION_LINK',
      url: `${base}/sub/nxuhdjwuc3m5-token`,
    });
    expect(found.usage?.usedBytes).toBe(1024n);
    expect(found.usage?.totalBytes).toBe(53_687_091_200n);
  });

  it('reports an absent user as absent rather than as a failure', async () => {
    const found = await adapter().lookupUser(target(), http(), ref('nxnothinghere'));
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.found).toBe(false);
  });

  it('suspends and resumes by status alone, touching no allowance', async () => {
    users.set('nxuhdjwuc3m5', userRecord('nxuhdjwuc3m5'));
    const suspended = await adapter().suspendUser(target(), http(), ref('nxuhdjwuc3m5'));
    expect(suspended.ok).toBe(true);
    expect(users.get('nxuhdjwuc3m5')?.status).toBe('disabled');

    const put = requests.filter((one) => one.method === 'PUT');
    const body = JSON.parse(put[0]?.body ?? '{}') as Record<string, unknown>;
    // A suspend changes ONE thing. A present `expire` or `data_limit` would be
    // applied, so a suspend carrying either would silently rewrite what the
    // customer bought. `proxies` is absent for a second reason: an edit leaving
    // a user with no proxies answers 400 on this panel.
    expect(Object.keys(body)).toEqual(['status']);

    const resumed = await adapter().resumeUser(target(), http(), ref('nxuhdjwuc3m5'));
    expect(resumed.ok).toBe(true);
    expect(users.get('nxuhdjwuc3m5')?.status).toBe('active');
  });

  it('refuses a delete the panel will not allow, instead of retrying it', async () => {
    users.set('nxuhdjwuc3m5', userRecord('nxuhdjwuc3m5'));
    deleteStatus = 403;
    const removed = await adapter().terminateUser(target(), http(), ref('nxuhdjwuc3m5'));
    expect(removed.ok).toBe(false);
    if (removed.ok) return;
    // "Your service may only allow deleting expired users, and a refusal answers
    // 403." The account is still there, and that rule does not change in thirty
    // seconds.
    expect(removed.failure).toBe('PROVIDER_REFUSED');
    expect(users.has('nxuhdjwuc3m5')).toBe(true);
  });

  it('treats a delete of something already gone as done', async () => {
    const removed = await adapter().terminateUser(target(), http(), ref('nxgonealready'));
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.wasPresent).toBe(false);
  });

  it('applies an allowance absolutely and verifies it from the panel record', async () => {
    users.set('nxuhdjwuc3m5', userRecord('nxuhdjwuc3m5'));
    const when = new Date('2028-06-01T00:00:00.000Z');
    const applied = await adapter().applyAllowance(target(), http(), ref('nxuhdjwuc3m5'), {
      expiresAt: when,
      trafficLimitBytes: 107_374_182_400n,
    });
    expect(applied.ok).toBe(true);
    expect(users.get('nxuhdjwuc3m5')?.expire).toBe(Math.floor(when.getTime() / 1000));
    expect(users.get('nxuhdjwuc3m5')?.data_limit).toBe(107_374_182_400);
    // Replaying it writes the same two numbers, which is the basis on which
    // RENEW, ADD_TRAFFIC and ADD_TIME are idempotent mutations.
    const again = await adapter().applyAllowance(target(), http(), ref('nxuhdjwuc3m5'), {
      expiresAt: when,
      trafficLimitBytes: 107_374_182_400n,
    });
    expect(again.ok).toBe(true);
    expect(users.get('nxuhdjwuc3m5')?.expire).toBe(Math.floor(when.getTime() / 1000));
  });

  it('refuses an allowance change the panel rejects by rule', async () => {
    users.set('nxuhdjwuc3m5', userRecord('nxuhdjwuc3m5'));
    putStatus = 400;
    const applied = await adapter().applyAllowance(target(), http(), ref('nxuhdjwuc3m5'), {
      expiresAt: new Date('2028-06-01T00:00:00.000Z'),
      trafficLimitBytes: null,
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.failure).toBe('PROVIDER_REFUSED');
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/**
 * `JSON.stringify` refuses a BigInt, and every usage figure is one. Serialised
 * the way a structured logger would — pino's own bigint handling is the same
 * `toString` — so the assertion is about what a log line would contain rather
 * than about a stringifier's limits.
 */
const asLogged = (value: unknown): string =>
  JSON.stringify(value, (_key, held: unknown) =>
    typeof held === 'bigint' ? held.toString() : held,
  ) ?? '';

describe('RickPanel logging safety', () => {
  /**
   * The adapter's RESULTS are what reach a log line — `provisioner-loop.ts`
   * logs the `ExecutionResult` — so the assertion that matters is that no
   * outcome shape has anywhere to put a secret.
   *
   * Asserted by serialising every outcome this suite can produce and looking for
   * the three things that must never travel: the password, the bearer token, and
   * the subscription URL, which is a bearer capability of its own.
   */
  it('returns no credential and no token in any outcome it produces', async () => {
    users.set('nxuhdjwuc3m5', userRecord('nxuhdjwuc3m5'));
    const outcomes = [
      await adapter().probe(target(), http()),
      await adapter().lookupUser(target(), http(), ref('nxuhdjwuc3m5')),
      await adapter().suspendUser(target(), http(), ref('nxuhdjwuc3m5')),
      await adapter().readUsage(target(), http(), ref('nxuhdjwuc3m5')),
    ];
    for (const outcome of outcomes) {
      const text = asLogged(outcome);
      expect(text).not.toContain('a-real-password');
      expect(text).not.toContain('a-real-jwt');
    }
  });

  /**
   * The create outcome DOES carry a subscription URL, and must: it is what the
   * customer receives. The rule it has to satisfy is different — the URL may
   * reach the customer and must never reach a log — and
   * `provision-executor.ts`'s `ExecutionResult` is where that is enforced. This
   * asserts the boundary from the adapter's side: the link is in `delivery` and
   * nowhere else, so a logger that takes the failure fields cannot pick it up.
   */
  it('puts the subscription only in the delivery, never beside the diagnostics', async () => {
    const outcome = await adapter().createUser(target(), http(), CREATE);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { delivery, ...rest } = outcome;
    expect(asLogged(rest)).not.toContain('/sub/');
    expect(asLogged(delivery)).toContain('/sub/');
  });
});
