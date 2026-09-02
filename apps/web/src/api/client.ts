import {
  IDENTITY_ERROR_CODES,
  ADMIN_ROUTES,
  adminListResponseSchema,
  API_PREFIX,
  AUTH_ROUTES,
  errorResponseSchema,
  HEALTH_ROUTES,
  healthInfoResponseSchema,
  healthReadyResponseSchema,
  loginResponseSchema,
  logoutResponseSchema,
  sessionResponseSchema,
  type AdminListResponse,
  type HealthInfoResponse,
  type HealthReadyResponse,
  type LoginResponse,
  type LogoutResponse,
  type SessionResponse,
} from '@nexa/contracts';

/**
 * The typed API client.
 *
 * Responses are PARSED with the same zod schemas the server validates against.
 * A change to a shape in `@nexa/contracts` is therefore a type error here and
 * in the API at the same time — which is the whole reason the seam exists.
 */

async function get<T>(path: string, schema: { parse: (v: unknown) => T }): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  const body: unknown = await response.json();
  // A 503 from readiness is a valid, well-shaped answer, not a transport error.
  if (!response.ok && response.status !== 503) {
    throw new Error(`Request to ${path} failed with ${response.status}`);
  }
  return schema.parse(body);
}

export function fetchReadiness(): Promise<HealthReadyResponse> {
  return get(HEALTH_ROUTES.ready, healthReadyResponseSchema);
}

export function fetchInfo(): Promise<HealthInfoResponse> {
  return get(HEALTH_ROUTES.info, healthInfoResponseSchema);
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * The admin session is carried by an httpOnly cookie, so this client never
 * holds a token and never reads one. `credentials: 'same-origin'` is what sends
 * it; a token in JavaScript would be readable by anything that achieved script
 * execution on this page.
 */
async function post<T>(
  path: string,
  body: unknown,
  schema: { parse: (v: unknown) => T },
): Promise<T> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw toApiError(response.status, payload);
  return schema.parse(payload);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function toApiError(status: number, payload: unknown): ApiError {
  const parsed = errorResponseSchema.safeParse(payload);
  if (parsed.success) {
    return new ApiError(status, parsed.data.error.code, parsed.data.error.message);
  }
  return new ApiError(status, 'unknown', `Request failed with ${status}`);
}

export function signIn(username: string, password: string): Promise<LoginResponse> {
  return post(AUTH_ROUTES.login, { username, password }, loginResponseSchema);
}

export function signOut(): Promise<LogoutResponse> {
  return post(AUTH_ROUTES.logout, {}, logoutResponseSchema);
}

/** Resolves the current session, or null when nobody is signed in. */
export async function fetchSession(): Promise<SessionResponse | null> {
  const response = await fetch(`${API_PREFIX}${AUTH_ROUTES.session}`, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  const payload: unknown = await response.json().catch(() => null);

  if (response.status === 401) {
    // A 401 is not automatically "signed out". The server answers 401 both when
    // there is no valid session AND when the installation is paused — and in
    // the second case the cookie is deliberately left intact, so it works again
    // when the tenant restarts. Showing a sign-in form for that told an
    // operator to authenticate their way out of something authentication cannot
    // fix.
    const error = toApiError(response.status, payload);
    if (error.code === IDENTITY_ERROR_CODES.AUTH_TENANT_SUSPENDED) throw error;
    return null;
  }

  if (!response.ok) throw toApiError(response.status, payload);
  return sessionResponseSchema.parse(payload);
}

export async function fetchAdmins(): Promise<AdminListResponse> {
  const response = await fetch(`${API_PREFIX}${ADMIN_ROUTES.list}`, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw toApiError(response.status, payload);
  return adminListResponseSchema.parse(payload);
}
