import {
  providerDescriptor,
  type ProviderConnectionAdapter,
  type ProviderCapability,
  type ProviderDescriptor,
  type ProviderHttpClient,
  type ProviderHttpResult,
  type ProviderProbeOutcome,
  type ProviderTarget,
} from '@nexa/contracts';

/**
 * Marzban.
 *
 * **Where these endpoints come from.** Marzban's own documented API, not from
 * the research corpus. That distinction matters and is stated because the
 * corpus is explicit about the gap: not one Marzban path, method, auth scheme
 * or payload was observable through the legacy bot's Telegram UI, and the
 * investigation briefs forbade recording tokens and Authorization headers. So
 * the corpus establishes that Marzban connects with a username and password and
 * that a reachable panel renders a version and a user count — and says nothing
 * about how. These two calls are validated against a deterministic fake server
 * in `tests/unit/marzban-adapter.test.ts` and have NOT been run against a real
 * Marzban in this phase.
 *
 * The probe is two steps, and the second one is what makes `DEGRADED` a real
 * state rather than a hedge:
 *
 *   1. `POST /api/admin/token` exchanges the credentials for a bearer token.
 *      Rejected here means the credentials are wrong, which is the one failure
 *      an operator can fix directly and the one that must never be retried.
 *   2. `GET /api/system` reads what the panel says about itself. Authentication
 *      has already succeeded at this point, so a failure here is a panel that
 *      is up and correctly configured and unwell — which is exactly what
 *      DEGRADED means, and it is a different remedy from UNREACHABLE.
 *
 * The token is never stored. It lives for one probe and is discarded, so there
 * is no third credential to rotate and nothing extra in a database dump.
 */

/** Marzban's token endpoint. Form-encoded, as an OAuth2 password grant. */
const TOKEN_PATH = 'api/admin/token';
const SYSTEM_PATH = 'api/system';

const DESCRIPTOR: ProviderDescriptor = providerDescriptor('marzban') ?? {
  // Unreachable: `marzban` is in `PROVIDER_TYPES`, and a unit test proves every
  // type has a descriptor. Written as a fallback rather than a `!` so that a
  // contract edit that removed it fails at the type level instead of at
  // runtime on somebody's installation.
  key: 'marzban',
  canonicalName: 'Marzban',
  credentialShape: 'USERNAME_PASSWORD',
  capabilities: ['HEALTH_CHECK'],
  requiredActivationFields: [],
};

/**
 * A failed HTTP exchange, as a probe outcome.
 *
 * `401` and `403` become `AUTHENTICATION_FAILED` — the credentials were seen
 * and refused. Everything else 4xx or 5xx is the panel's own error: it
 * answered, so it is reachable, and the problem is on its side.
 */
function outcomeFromStatus(status: number): ProviderProbeOutcome {
  if (status === 401 || status === 403) {
    return { ok: false, failure: 'AUTHENTICATION_FAILED', status };
  }
  return { ok: false, failure: 'PROVIDER_ERROR', status };
}

/** A transport failure keeps the kind the client already normalized. */
function outcomeFromTransport(
  result: Extract<ProviderHttpResult, { ok: false }>,
): ProviderProbeOutcome {
  return { ok: false, failure: result.failure, status: result.status };
}

/**
 * A JSON body, or null.
 *
 * Never throws and never carries the body forward. A panel that answers with
 * an HTML login page — which is what a misconfigured reverse proxy in front of
 * Marzban does — parses to null here and becomes `MALFORMED_RESPONSE`, which
 * is a far more useful thing to tell an operator than a JSON syntax error
 * quoting the first eighty characters of somebody's login form.
 */
function parseJson(bodyText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A version string, if the panel reported one that is safe to keep.
 *
 * Bounded and character-restricted rather than taken as given. It is persisted
 * and shown to an operator, so an unbounded string from an unauthenticated-ish
 * surface would be a place to store whatever the remote end felt like sending.
 */
function safeVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  return /^[A-Za-z0-9._+-]+$/.test(trimmed) ? trimmed : null;
}

export class MarzbanAdapter implements ProviderConnectionAdapter {
  readonly descriptor = DESCRIPTOR;

  supports(capability: ProviderCapability): boolean {
    return this.descriptor.capabilities.includes(capability);
  }

  async probe(target: ProviderTarget, http: ProviderHttpClient): Promise<ProviderProbeOutcome> {
    if (target.credentials.shape !== 'USERNAME_PASSWORD') {
      // The panel is configured with a credential shape Marzban cannot use.
      // Reported as unsupported rather than attempted: sending an empty
      // password to find out would be one more failed login on the operator's
      // own panel, and some of them lock an account for that.
      return { ok: false, failure: 'UNSUPPORTED_CAPABILITY', status: null };
    }

    const login = await http.send({
      method: 'POST',
      path: TOKEN_PATH,
      body: {
        kind: 'form',
        value: {
          username: target.credentials.username,
          password: target.credentials.password,
          grant_type: 'password',
        },
      },
    });
    if (!login.ok) return outcomeFromTransport(login);
    if (login.status < 200 || login.status >= 300) return outcomeFromStatus(login.status);

    const body = parseJson(login.bodyText);
    const token = body?.['access_token'];
    if (typeof token !== 'string' || token.length === 0) {
      // A 200 that carries no token is not a successful login. Treating it as
      // one would report a healthy panel that nothing can actually call.
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: login.status };
    }

    const system = await http.send({
      method: 'GET',
      path: SYSTEM_PATH,
      headers: { authorization: `Bearer ${token}` },
    });

    // From here on the credentials are known good, so nothing below may report
    // an authentication failure — it would send an operator to replace a
    // password that just worked.
    if (!system.ok) {
      return { ok: true, providerVersion: null, degraded: true };
    }
    if (system.status < 200 || system.status >= 300) {
      return { ok: true, providerVersion: null, degraded: true };
    }
    const info = parseJson(system.bodyText);
    if (info === null) {
      return { ok: true, providerVersion: null, degraded: true };
    }

    return { ok: true, providerVersion: safeVersion(info['version']), degraded: false };
  }
}
