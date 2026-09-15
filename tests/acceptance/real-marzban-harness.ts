import { randomUUID } from 'node:crypto';
import type { MarzbanActivation, ProviderTarget } from '@nexa/contracts';

/**
 * The connection to a REAL Marzban panel, and the operator-side reads this suite
 * needs that are not Nexa's to make.
 *
 * ## The rule this file exists to keep
 *
 * `MarzbanAdapter` is the thing under test, so it may not also be the thing that
 * checks the answer. Every assertion about what the panel actually holds — what
 * status it stored, whether an account is still there, what its subscription
 * serves — is read HERE, through the panel's own API, on plain `fetch`, with its
 * own token. If the adapter and the checker were the same code, a wrong write and
 * a wrong read would agree and the suite would be green.
 *
 * The Marzban adapter has already cost one defect of exactly that shape: it
 * asserted that omitting `inbounds` on a create means "every inbound", and the
 * only thing that disagreed was a panel.
 */

export interface RealMarzban {
  /** Where the panel's API lives. The adapter appends `api/...` itself. */
  readonly baseUrl: string;
  /** What Nexa would hold in `panel_credentials` for it. */
  readonly credentials: ProviderTarget['credentials'];
  /** The activation an operator would have configured for this panel. */
  readonly activation: MarzbanActivation;
  /** Distinguishes this run's disposable accounts from a previous run's. */
  readonly runId: string;
  readonly startedAt: Date;
}

const ENV = {
  url: 'NEXA_ACCEPTANCE_MARZBAN_URL',
  username: 'NEXA_ACCEPTANCE_MARZBAN_USERNAME',
  password: 'NEXA_ACCEPTANCE_MARZBAN_PASSWORD',
  protocol: 'NEXA_ACCEPTANCE_MARZBAN_PROTOCOL',
  inboundTag: 'NEXA_ACCEPTANCE_MARZBAN_INBOUND_TAG',
} as const;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set. This suite talks to a REAL Marzban panel and will not ` +
        `pretend to have checked one. See docs/real-panel-acceptance.md for how to ` +
        `stand up a disposable v0.8.4 panel, and never point it at an installation ` +
        `carrying real customers.`,
    );
  }
  return value.trim();
}

/**
 * The panel, or a failure that says why.
 *
 * Deliberately NOT a skip. A skipped acceptance suite reports the same green as a
 * passing one, and the claim being tested is that this adapter works against a
 * real panel.
 */
export async function requireRealMarzban(): Promise<RealMarzban> {
  const baseUrl = required(ENV.url);
  const username = required(ENV.username);
  const password = required(ENV.password);
  const protocol = required(ENV.protocol);
  const inboundTag = required(ENV.inboundTag);

  const panel: RealMarzban = {
    baseUrl,
    credentials: { shape: 'USERNAME_PASSWORD', username, password },
    activation: {
      proxyProtocols: [protocol as MarzbanActivation['proxyProtocols'][number]],
      inboundTags: { [protocol]: [inboundTag] },
    },
    runId: randomUUID().slice(0, 8),
    startedAt: new Date(),
  };

  // Fail fast and loudly if the panel is not actually there, rather than letting
  // every test report its own connection error.
  const token = await observerToken(panel);
  if (token === null) {
    throw new Error(
      `could not obtain an operator token on ${baseUrl}. ` +
        `The suite cannot check a panel it cannot reach.`,
    );
  }
  const inbounds = await observerInbounds(panel, token);
  if (!inbounds.includes(inboundTag)) {
    throw new Error(
      `${ENV.inboundTag} is "${inboundTag}", which this panel does not have. ` +
        `It reports: ${inbounds.join(', ') || '(none)'}. An acceptance run against ` +
        `a tag the panel does not serve would produce accounts with no configuration ` +
        `and call it a pass.`,
    );
  }
  return panel;
}

const base = (panel: RealMarzban): string =>
  panel.baseUrl.endsWith('/') ? panel.baseUrl : `${panel.baseUrl}/`;

/**
 * An operator token, by the panel's own documented flow.
 *
 * Hand-written on `fetch` on purpose. This is the independent observer; sharing
 * `SafeHttpClient` or the adapter's `authenticate` would make the observation
 * depend on the code being observed.
 */
export async function observerToken(panel: RealMarzban): Promise<string | null> {
  const credentials = panel.credentials;
  if (credentials.shape !== 'USERNAME_PASSWORD') return null;
  let response: Response;
  try {
    response = await fetch(new URL('api/admin/token', base(panel)), {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: credentials.username,
        password: credentials.password,
        grant_type: 'password',
      }).toString(),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body = (await response.json()) as { access_token?: unknown };
  return typeof body.access_token === 'string' && body.access_token !== ''
    ? body.access_token
    : null;
}

/** Which inbound tags this panel serves, per protocol, flattened. */
export async function observerInbounds(
  panel: RealMarzban,
  token: string,
): Promise<readonly string[]> {
  const response = await fetch(new URL('api/inbounds', base(panel)), {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error',
  });
  if (!response.ok) return [];
  const body = (await response.json()) as Record<string, { tag?: unknown }[]>;
  const tags: string[] = [];
  for (const list of Object.values(body)) {
    for (const entry of list) if (typeof entry.tag === 'string') tags.push(entry.tag);
  }
  return tags;
}

/** What the panel actually stored for one account. `null` when it has none. */
export interface ObservedUser {
  readonly username: string;
  readonly status: string;
  readonly usedTraffic: number;
  readonly dataLimit: number | null;
  readonly expire: number | null;
  readonly links: readonly string[];
  readonly subscriptionUrl: string;
  readonly proxyIds: Readonly<Record<string, string>>;
}

export async function observeUser(
  panel: RealMarzban,
  token: string,
  username: string,
): Promise<ObservedUser | null> {
  const response = await fetch(new URL(`api/user/${encodeURIComponent(username)}`, base(panel)), {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`observer read of ${username} answered ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  const proxies = (body['proxies'] ?? {}) as Record<string, { id?: unknown }>;
  const proxyIds: Record<string, string> = {};
  for (const [protocol, settings] of Object.entries(proxies)) {
    if (typeof settings.id === 'string') proxyIds[protocol] = settings.id;
  }
  return {
    username: String(body['username'] ?? ''),
    status: String(body['status'] ?? ''),
    usedTraffic: Number(body['used_traffic'] ?? 0),
    dataLimit: typeof body['data_limit'] === 'number' ? body['data_limit'] : null,
    expire: typeof body['expire'] === 'number' ? body['expire'] : null,
    links: Array.isArray(body['links']) ? (body['links'] as string[]) : [],
    subscriptionUrl: String(body['subscription_url'] ?? ''),
    proxyIds,
  };
}

/**
 * What a customer's client would actually receive from a subscription URL.
 *
 * The end of the chain, and the only check that distinguishes "the panel says the
 * account exists" from "the account is usable". An account created without its
 * inbound tags answers this with a zero-byte body while every status code says
 * success — which is the defect that made this function necessary.
 */
export async function fetchSubscription(panel: RealMarzban, url: string): Promise<string> {
  /*
   * The panel renders `subscription_url` from XRAY_SUBSCRIPTION_URL_PREFIX, which an
   * operator sets to the address customers use — not necessarily the one this suite
   * reaches the panel on. Rewriting the origin keeps the PATH (which carries the
   * signed token, the thing under test) while dialling the address we were given.
   */
  const target = new URL(url, base(panel));
  const reachable = new URL(target.pathname + target.search, base(panel));
  const response = await fetch(reachable, {
    headers: { 'user-agent': 'v2rayNG/1.8.5' },
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`subscription fetch answered ${response.status}`);
  return await response.text();
}

/** Remove one account, as the operator, so a run cleans up after itself. */
export async function observerDelete(
  panel: RealMarzban,
  token: string,
  username: string,
): Promise<void> {
  await fetch(new URL(`api/user/${encodeURIComponent(username)}`, base(panel)), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error',
  });
}
