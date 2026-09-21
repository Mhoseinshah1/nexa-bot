import { randomUUID } from 'node:crypto';
import type { ProviderTarget } from '@nexa/contracts';

/**
 * The connection to a REAL RickPanel, and the operator-side reads this suite
 * needs that are not Nexa's to make.
 *
 * ## The rule this file exists to keep
 *
 * `RickpanelAdapter` is the thing under test, so it may not also be the thing
 * that checks the answer. Every assertion about what the panel actually holds —
 * whether an account is there, what its subscription serves, whether a delete
 * took — is read HERE, through the panel's own API, on plain `fetch`, with its
 * own token. If the adapter and the checker were the same code, a wrong write
 * and a wrong read would agree and the suite would be green.
 *
 * The Marzban adapter already cost one defect of exactly that shape, and the
 * RickPanel adapter is in a strictly worse position: it was written from a
 * document whose schemas are lossy — `UserCreate` declares no `username` and
 * types `expire` as a string — so more of it is inference than was the case
 * there. `docs/rickpanel-adapter-audit.md` §1 lists what is inferred, and this
 * suite is how each inference becomes a fact or a bug.
 *
 * ## What running this settles
 *
 * `OQ-RP-01` — which field carries the subscription.
 * `OQ-RP-02` — whether the create takes a status.
 * `OQ-RP-03` — what the create actually returns.
 * `OQ-RP-04` — how long node propagation takes.
 *
 * Each is recorded as open in the audit, and each is closed by a panel rather
 * than by a reading.
 */

export interface RealRickpanel {
  /** Where the panel's API lives. The adapter appends `api/...` itself. */
  readonly baseUrl: string;
  /** What Nexa would hold in `panel_credentials` for it. */
  readonly credentials: ProviderTarget['credentials'];
  /** Distinguishes this run's disposable accounts from a previous run's. */
  readonly runId: string;
  readonly startedAt: Date;
}

const ENV = {
  url: 'NEXA_ACCEPTANCE_RICKPANEL_URL',
  username: 'NEXA_ACCEPTANCE_RICKPANEL_USERNAME',
  password: 'NEXA_ACCEPTANCE_RICKPANEL_PASSWORD',
} as const;

/*
 * THREE variables, where Marzban's harness needs five.
 *
 * There is no protocol and no inbound tag to ask for, and that absence is the
 * product fact this whole provider type exists to express: "every user gets
 * every protocol and every inbound". A harness that demanded them would be
 * asking an operator to supply configuration their panel ignores — the same
 * demand that made the production panel unsellable.
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set. This suite talks to a REAL RickPanel and will not ` +
        `pretend to have checked one. A Marzban is NOT a substitute: the two ` +
        `panels answer the same routes and mean different things by them, which ` +
        `is why they are separate provider types. See ` +
        `docs/providers/rickpanel.md, and never point this at an installation ` +
        `carrying real customers.`,
    );
  }
  return value.trim();
}

/**
 * The panel, or a failure that says why.
 *
 * Deliberately NOT a skip. A skipped acceptance suite reports the same green as
 * a passing one, and the claim being tested is that this adapter works against a
 * real RickPanel — a claim that is currently UNPROVEN and must not be reported
 * as anything else.
 */
export async function requireRealRickpanel(): Promise<RealRickpanel> {
  const panel: RealRickpanel = {
    baseUrl: required(ENV.url),
    credentials: {
      shape: 'USERNAME_PASSWORD',
      username: required(ENV.username),
      password: required(ENV.password),
    },
    runId: randomUUID().slice(0, 8),
    startedAt: new Date(),
  };

  // Fail fast and loudly if the panel is not actually there, rather than letting
  // every test report its own connection error.
  const token = await observerToken(panel);
  if (token === null) {
    throw new Error(
      `could not obtain an operator token on ${panel.baseUrl}. ` +
        `The suite cannot check a panel it cannot reach.`,
    );
  }
  return panel;
}

const base = (panel: RealRickpanel): string =>
  panel.baseUrl.endsWith('/') ? panel.baseUrl : `${panel.baseUrl}/`;

/**
 * An operator token, obtained WITHOUT the adapter.
 *
 * Form-encoded because the document's prose says so. If that turns out to be
 * wrong, this function fails and the whole suite stops — which is the right
 * outcome, because the adapter makes the same assumption and an observer that
 * silently worked around it would hide the defect it exists to find.
 */
export async function observerToken(panel: RealRickpanel): Promise<string | null> {
  if (panel.credentials.shape !== 'USERNAME_PASSWORD') return null;
  const response = await fetch(`${base(panel)}api/admin/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: panel.credentials.username,
      password: panel.credentials.password,
      grant_type: 'password',
    }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { access_token?: unknown };
  return typeof body.access_token === 'string' ? body.access_token : null;
}

/** One user, exactly as the panel holds it. The raw record, deliberately untyped. */
export async function observeUser(
  panel: RealRickpanel,
  token: string,
  username: string,
): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${base(panel)}api/user/${encodeURIComponent(username)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`observer read failed: ${String(response.status)}`);
  return (await response.json()) as Record<string, unknown>;
}

/**
 * What a subscription URL actually SERVES.
 *
 * The assertion that no fake can make and the one the Marzban acceptance was
 * written for: a create can answer 200, return a URL, and deliver zero bytes.
 * The length of this body is the only thing that distinguishes a delivered
 * service from a plausible one.
 */
export async function fetchSubscription(url: string): Promise<{ status: number; bytes: number }> {
  const response = await fetch(url, { headers: { 'user-agent': 'nexa-acceptance' } });
  const text = await response.text();
  return { status: response.status, bytes: text.length };
}

/** Remove one of this run's accounts, without the adapter. Used for cleanup. */
export async function observerDelete(
  panel: RealRickpanel,
  token: string,
  username: string,
): Promise<void> {
  await fetch(`${base(panel)}api/user/${encodeURIComponent(username)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
}
