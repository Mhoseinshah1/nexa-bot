import { randomUUID } from 'node:crypto';
import type { ProviderTarget } from '@nexa/contracts';

/**
 * The connection to a REAL 3X-UI panel, and the few operator-side reads this
 * suite needs that are not Nexa's to make.
 *
 * ## The rule this file exists to keep
 *
 * Nexa's adapter is the thing under test, so it may not also be the thing that
 * checks the answer. Every assertion about what the panel actually holds — what
 * `totalGB` it stored, what `expiryTime`, what `limitIp` — is read here,
 * through the panel's OWN operator API, with its own session. If the adapter
 * and the checker were the same code, a wrong write and a wrong read would
 * agree and the suite would be green.
 *
 * So: `SanaeiAdapter` writes, this file reads, and they share no code.
 */

export interface RealPanel {
  /** Where the panel's admin API lives, `webBasePath` included. */
  readonly baseUrl: string;
  /** What Nexa would hold in `panel_credentials` for it. */
  readonly credentials: ProviderTarget['credentials'];
  /** The inbound a created client is added to. */
  readonly inboundId: number;
  /** The port that inbound listens on, so a served config can be checked against it. */
  readonly inboundPort: number;
  /** Host and optional port of the subscription listener — the activation field. */
  readonly subscriptionDomain: string;
  /** Where to actually FETCH a subscription, which is a URL and not a host. */
  readonly subscriptionBaseUrl: string;
  /** Distinguishes this run's disposable accounts from a previous run's. */
  readonly runId: string;
  readonly startedAt: Date;
  close(): Promise<void>;
}

const ENV = {
  url: 'NEXA_ACCEPTANCE_PANEL_URL',
  username: 'NEXA_ACCEPTANCE_PANEL_USERNAME',
  password: 'NEXA_ACCEPTANCE_PANEL_PASSWORD',
  inbound: 'NEXA_ACCEPTANCE_PANEL_INBOUND_ID',
  inboundPort: 'NEXA_ACCEPTANCE_PANEL_INBOUND_PORT',
  sub: 'NEXA_ACCEPTANCE_SUB_URL',
} as const;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set. This suite talks to a REAL 3X-UI panel and will not ` +
        `pretend to have checked one. See docs/real-panel-acceptance.md for how to ` +
        `stand up a disposable v3.7.0 panel, and never point it at an installation ` +
        `carrying real customers.`,
    );
  }
  return value.trim();
}

/**
 * The panel, or a failure that says why.
 *
 * Deliberately NOT a skip. A skipped acceptance suite reports the same green as
 * a passing one, and the thing being acceptance-tested is the claim that this
 * adapter works against a real panel.
 */
export async function requireRealPanel(): Promise<RealPanel> {
  const baseUrl = required(ENV.url);
  const username = required(ENV.username);
  const password = required(ENV.password);
  const inboundId = Number.parseInt(required(ENV.inbound), 10);
  if (!Number.isInteger(inboundId) || inboundId <= 0) {
    throw new Error(`${ENV.inbound} must be a positive integer.`);
  }
  const subscriptionBaseUrl = required(ENV.sub);
  const subHost = new URL(subscriptionBaseUrl).host;
  const inboundPort = Number.parseInt(required(ENV.inboundPort), 10);
  if (!Number.isInteger(inboundPort) || inboundPort <= 0) {
    throw new Error(`${ENV.inboundPort} must be a positive integer.`);
  }

  const panel: RealPanel = {
    baseUrl,
    credentials: { shape: 'USERNAME_PASSWORD', username, password },
    inboundId,
    inboundPort,
    subscriptionDomain: subHost,
    subscriptionBaseUrl,
    runId: randomUUID().slice(0, 8),
    startedAt: new Date(),
    close: async () => {
      /* the panel outlives the suite; the caller that started it stops it */
    },
  };

  // Fail fast and loudly if the panel is not actually there, rather than
  // letting every test report its own connection error.
  const session = await panelAdminSession(panel);
  if (!session.ok) {
    throw new Error(
      `could not open an operator session on ${baseUrl}: ${session.reason}. ` +
        `The suite cannot check a panel it cannot reach.`,
    );
  }
  return panel;
}

interface Session {
  readonly ok: true;
  readonly cookie: string;
  readonly csrf: string;
}
type SessionResult = Session | { readonly ok: false; readonly reason: string };

const cookiesOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((line) => line.split(';', 1)[0])
    .filter((pair): pair is string => pair !== undefined)
    .join('; ');

/**
 * An operator session, by the panel's own documented flow: `csrf-token`, then
 * `login`, carrying the cookie the token is bound to.
 *
 * Hand-written on `fetch` on purpose. This is the independent observer; sharing
 * `SafeHttpClient` or the adapter's session code would make the observation
 * depend on the code being observed.
 */
export async function panelAdminSession(panel: RealPanel): Promise<SessionResult> {
  const base = panel.baseUrl.endsWith('/') ? panel.baseUrl : `${panel.baseUrl}/`;
  let response: Response;
  try {
    response = await fetch(new URL('csrf-token', base), { redirect: 'error' });
  } catch (error) {
    return { ok: false, reason: `csrf-token unreachable (${(error as Error).message})` };
  }
  if (!response.ok) return { ok: false, reason: `csrf-token answered ${response.status}` };
  const cookie = cookiesOf(response);
  const csrf = (((await response.json()) as { obj?: unknown }).obj ?? '') as string;
  if (csrf === '') return { ok: false, reason: 'csrf-token returned no token' };

  const credentials = panel.credentials;
  if (credentials.shape !== 'USERNAME_PASSWORD') {
    return { ok: false, reason: 'the observer session needs username/password credentials' };
  }
  const login = await fetch(new URL('login', base), {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      'x-requested-with': 'XMLHttpRequest',
      cookie,
    },
    body: JSON.stringify({ username: credentials.username, password: credentials.password }),
  });
  if (!login.ok) return { ok: false, reason: `login answered ${login.status}` };
  const envelope = (await login.json()) as { success?: boolean };
  if (envelope.success !== true) return { ok: false, reason: 'login was refused' };
  return { ok: true, cookie: cookiesOf(login) || cookie, csrf };
}

/** The fields the panel actually stored for one client. */
export interface StoredClient {
  readonly email: string;
  /** The VLESS UUID the config authenticates with. `uuid`, not `id`. */
  readonly uuid: string;
  readonly subId: string;
  readonly totalGB: number;
  readonly expiryTime: number;
  readonly limitIp: number;
  readonly enable: boolean;
  readonly inboundIds: readonly number[];
}

/**
 * One client, read through `panel/api/clients/get/{email}` as the operator.
 *
 * Not through `clients/traffic/{email}`, which is what the adapter reads: the
 * traffic record does not carry the UUID, `subId` or `limitIp`, and those are
 * three of the things Nexa promised the customer.
 *
 * The envelope is `{obj: {client: {...}, inboundIds, externalLinks, usedTraffic}}`,
 * and inside `client` the VLESS UUID is `uuid` while `id` is the DATABASE ROW
 * ID — an integer. Reading `id` as the UUID is how this checker first reported
 * an empty string for every field: it was looking one level too high, and then
 * at the wrong key. Both are recorded here because both are easy to repeat.
 */
export async function readClientAsOperator(
  panel: RealPanel,
  email: string,
): Promise<StoredClient | null> {
  const session = await panelAdminSession(panel);
  if (!session.ok) throw new Error(`operator session failed: ${session.reason}`);
  const base = panel.baseUrl.endsWith('/') ? panel.baseUrl : `${panel.baseUrl}/`;
  const response = await fetch(
    new URL(`panel/api/clients/get/${encodeURIComponent(email)}`, base),
    {
      redirect: 'error',
      headers: { cookie: session.cookie, 'x-requested-with': 'XMLHttpRequest' },
    },
  );
  if (!response.ok) throw new Error(`clients/get answered ${response.status}`);
  const body = (await response.json()) as { success?: boolean; obj?: unknown };
  if (body.success !== true) return null;
  if (body.obj === null || body.obj === undefined) return null;
  const wrapper = body.obj as { client?: unknown; inboundIds?: unknown };
  if (wrapper.client === null || wrapper.client === undefined) return null;
  const raw = wrapper.client as Record<string, unknown>;
  return {
    email: String(raw['email'] ?? ''),
    uuid: String(raw['uuid'] ?? ''),
    subId: String(raw['subId'] ?? ''),
    totalGB: Number(raw['totalGB'] ?? 0),
    expiryTime: Number(raw['expiryTime'] ?? 0),
    limitIp: Number(raw['limitIp'] ?? 0),
    enable: raw['enable'] === true,
    inboundIds: Array.isArray(wrapper.inboundIds) ? (wrapper.inboundIds as number[]) : [],
  };
}

/** How many clients on this panel carry that email. Duplicate detection. */
export async function countClientsNamed(panel: RealPanel, email: string): Promise<number> {
  const session = await panelAdminSession(panel);
  if (!session.ok) throw new Error(`operator session failed: ${session.reason}`);
  const base = panel.baseUrl.endsWith('/') ? panel.baseUrl : `${panel.baseUrl}/`;
  const response = await fetch(new URL('panel/api/inbounds/list', base), {
    redirect: 'error',
    headers: { cookie: session.cookie, 'x-requested-with': 'XMLHttpRequest' },
  });
  if (!response.ok) throw new Error(`inbounds/list answered ${response.status}`);
  const body = (await response.json()) as { obj?: readonly unknown[] };
  let count = 0;
  for (const inbound of body.obj ?? []) {
    const settings = (inbound as { settings?: unknown }).settings;
    const parsed =
      typeof settings === 'string' ? (JSON.parse(settings) as { clients?: readonly unknown[] }) : ((settings ?? {}) as { clients?: readonly unknown[] });
    for (const client of parsed.clients ?? []) {
      if ((client as { email?: unknown }).email === email) count += 1;
    }
  }
  return count;
}

/** The raw body the subscription listener serves for one `subId`. */
export async function subscriptionPayload(
  panel: RealPanel,
  subscriptionRef: string,
): Promise<{ status: number; body: string }> {
  const base = panel.subscriptionBaseUrl.endsWith('/')
    ? panel.subscriptionBaseUrl
    : `${panel.subscriptionBaseUrl}/`;
  const response = await fetch(new URL(`sub/${encodeURIComponent(subscriptionRef)}`, base), {
    redirect: 'error',
  });
  return { status: response.status, body: await response.text() };
}
