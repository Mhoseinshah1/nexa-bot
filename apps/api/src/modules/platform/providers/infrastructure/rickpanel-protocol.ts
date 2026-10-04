import type { ProviderFailureResult, ProviderHttpResult, ProviderTarget } from '@nexa/contracts';

/**
 * The RickPanel wire protocol pieces that BOTH the mutating adapter
 * (`rickpanel.adapter.ts`) and the read-only migration inventory
 * (`rickpanel-inventory.ts`) need: the routes, the failure taxonomy, the JSON reader and
 * the token exchange.
 *
 * Extracted (Migration P5) so the inventory can authenticate WITHOUT importing the
 * adapter: the inventory must not be able to reach a mutating method, and a module it
 * imports is a module whose methods it can call. One token exchange, two callers — not a
 * copy that drifts.
 */

/** Form-encoded, as an OAuth2 password grant. The document's prose, not its schema. */
export const TOKEN_PATH = 'api/admin/token';
/** Create is a POST to the collection; read, modify and delete address `/{username}`. */
export const USER_PATH = 'api/user';

/**
 * A failed HTTP exchange, as a probe outcome.
 *
 * The same taxonomy the other two adapters use, and deliberately WITHOUT the
 * create path's `PROVIDER_REFUSED`: a probe asks the panel about itself, and a
 * 400 to `GET /api/system` is a panel behaving oddly rather than a rule being
 * applied to a request. The distinction is raised only where the document says
 * a refusal carries a reason, which is the create.
 */
export function outcomeFromStatus(status: number): ProviderFailureResult {
  if (status === 401 || status === 403) {
    return { ok: false, failure: 'AUTHENTICATION_FAILED', status };
  }
  if (status === 429) return { ok: false, failure: 'RATE_LIMITED', status };
  return { ok: false, failure: 'PROVIDER_ERROR', status };
}

export function outcomeFromTransport(
  result: Extract<ProviderHttpResult, { ok: false }>,
): ProviderFailureResult {
  return result.detail === undefined
    ? { ok: false, failure: result.failure, status: result.status }
    : { ok: false, failure: result.failure, status: result.status, detail: result.detail };
}

/**
 * A JSON body, or null.
 *
 * Never throws and never carries the body forward: a panel behind a misconfigured
 * proxy answers with an HTML login page, and `MALFORMED_RESPONSE` is a more
 * useful thing to tell an operator than a syntax error quoting somebody's form.
 */
export function parseJson(bodyText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export type RickpanelAuth = { readonly ok: true; readonly token: string } | ProviderFailureResult;

/** The form a token exchange carries. */
export type RickpanelTokenForm = Readonly<Record<'username' | 'password' | 'grant_type', string>>;

/**
 * Exchange the operator's credentials for a bearer JWT.
 *
 * Form-encoded, because the document's prose says so however its schema is
 * typed. A 401 is a wrong username or password; a 403 is a DISABLED account
 * with the right password — the document distinguishes them and this function
 * does not, deliberately: both are "an operator has to go and look at their own
 * admin account", both must never be retried, and `AUTHENTICATION_FAILED` is
 * the kind that says so.
 *
 * `exchange` is the ONE request: `POST TOKEN_PATH` with the form. It is a parameter so
 * the adapter (holding a full client) and the inventory (holding a read-only one) can
 * each send it through what they hold.
 */
export async function exchangeRickpanelToken(
  target: ProviderTarget,
  exchange: (form: RickpanelTokenForm) => Promise<ProviderHttpResult>,
): Promise<RickpanelAuth> {
  if (target.credentials.shape !== 'USERNAME_PASSWORD') {
    // Reported as unsupported rather than attempted: sending an empty password
    // to find out would be one more failed login on the operator's own panel.
    return { ok: false, failure: 'UNSUPPORTED_CAPABILITY', status: null };
  }

  const login = await exchange({
    username: target.credentials.username,
    password: target.credentials.password,
    grant_type: 'password',
  });
  if (!login.ok) return outcomeFromTransport(login);
  if (login.status < 200 || login.status >= 300) return outcomeFromStatus(login.status);

  const body = parseJson(login.bodyText);
  const token = body?.['access_token'];
  if (typeof token !== 'string' || token.length === 0) {
    // A 200 carrying no token is not a successful login, and treating it as one
    // would report a healthy panel that nothing can actually call.
    return { ok: false, failure: 'MALFORMED_RESPONSE', status: login.status };
  }
  return { ok: true, token };
}
