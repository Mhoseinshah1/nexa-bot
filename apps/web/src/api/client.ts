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
  CONTROL_ROUTES,
  featureFlagListResponseSchema,
  featureFlagWriteResponseSchema,
  settingWriteResponseSchema,
  notificationDetailResponseSchema,
  notificationListResponseSchema,
  operationalEventListResponseSchema,
  previewTemplateResponseSchema,
  settingListResponseSchema,
  templateListResponseSchema,
  templateRevisionListResponseSchema,
  templateWriteResponseSchema,
  type FeatureFlagListResponse,
  type NotificationDetailResponse,
  type NotificationListResponse,
  type OperationalEventListResponse,
  type PreviewTemplateResponse,
  type FeatureFlagWriteResponse,
  type SettingWriteResponse,
  type SettingListResponse,
  type TemplateListResponse,
  type TemplateRevisionListResponse,
  type TemplateWriteResponse,
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
    /**
     * The structured half of the error.
     *
     * Carried because the server's `details` is where the useful part lives: a
     * rejected template body names the offending token, which is the entire
     * point of reporting `UNKNOWN_PLACEHOLDER { token }` rather than a
     * sentence. Dropping it here left an administrator with "this body is not
     * valid" and no way to see which of their placeholders was wrong.
     */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function toApiError(status: number, payload: unknown): ApiError {
  const parsed = errorResponseSchema.safeParse(payload);
  if (parsed.success) {
    return new ApiError(
      status,
      parsed.data.error.code,
      parsed.data.error.message,
      parsed.data.error.details,
    );
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

// ---------------------------------------------------------------------------
// The control plane
// ---------------------------------------------------------------------------

/** An authenticated GET that parses with the frozen schema. */
async function authedGet<T>(path: string, schema: { parse: (v: unknown) => T }): Promise<T> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw toApiError(response.status, payload);
  return schema.parse(payload);
}

/**
 * A key for a write, minted per submission.
 *
 * Every state-changing command takes one, so a double-submitted form or a retry
 * after a dropped connection produces one change rather than two. `randomUUID`
 * is available in every browser this admin supports and in the test environment.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function fetchSettings(): Promise<SettingListResponse> {
  return authedGet(CONTROL_ROUTES.settings, settingListResponseSchema);
}

export function saveSetting(input: {
  key: string;
  value: unknown;
  expectedVersion: number | null;
  idempotencyKey: string;
}): Promise<SettingWriteResponse> {
  const { key, ...body } = input;
  return post(CONTROL_ROUTES.setting(key), body, settingWriteResponseSchema);
}

export function fetchFeatureFlags(): Promise<FeatureFlagListResponse> {
  return authedGet(CONTROL_ROUTES.features, featureFlagListResponseSchema);
}

export function saveFeatureFlag(input: {
  key: string;
  enabled: boolean;
  expectedVersion: number | null;
  idempotencyKey: string;
  confirmKey?: string;
  reason?: string;
}): Promise<FeatureFlagWriteResponse> {
  const { key, ...body } = input;
  return post(CONTROL_ROUTES.feature(key), body, featureFlagWriteResponseSchema);
}

export function fetchTemplates(): Promise<TemplateListResponse> {
  return authedGet(CONTROL_ROUTES.templates, templateListResponseSchema);
}

export function fetchTemplateRevisions(key: string): Promise<TemplateRevisionListResponse> {
  return authedGet(CONTROL_ROUTES.templateRevisions(key), templateRevisionListResponseSchema);
}

export function saveTemplate(input: {
  key: string;
  body: string;
  expectedVersion: number | null;
  idempotencyKey: string;
}): Promise<TemplateWriteResponse> {
  const { key, ...rest } = input;
  return post(CONTROL_ROUTES.template(key), rest, templateWriteResponseSchema);
}

export function revertTemplate(input: {
  key: string;
  expectedVersion: number;
  idempotencyKey: string;
}): Promise<TemplateWriteResponse> {
  const { key, ...rest } = input;
  return post(CONTROL_ROUTES.templateRevert(key), rest, templateWriteResponseSchema);
}

/**
 * Renders a body with sample values and stores nothing.
 *
 * The values are the ones the administrator typed into the preview fields. They
 * are never taken from their own account — which is the difference between this
 * and the legacy edit screen, where `{first_name}` renders as the viewer's own
 * name and saving that view stores it.
 */
export function previewTemplate(
  key: string,
  body: string,
  values: Record<string, string>,
): Promise<PreviewTemplateResponse> {
  return post(CONTROL_ROUTES.templatePreview(key), { body, values }, previewTemplateResponseSchema);
}

export function fetchOpsLog(query: {
  severity?: string;
  open?: boolean;
}): Promise<OperationalEventListResponse> {
  const params = new URLSearchParams();
  if (query.severity) params.set('severity', query.severity);
  if (query.open !== undefined) params.set('open', String(query.open));
  const suffix = params.toString();
  return authedGet(
    suffix ? `${CONTROL_ROUTES.opsLog}?${suffix}` : CONTROL_ROUTES.opsLog,
    operationalEventListResponseSchema,
  );
}

export function fetchNotifications(): Promise<NotificationListResponse> {
  return authedGet(CONTROL_ROUTES.notifications, notificationListResponseSchema);
}

export function fetchNotification(id: string): Promise<NotificationDetailResponse> {
  return authedGet(CONTROL_ROUTES.notification(id), notificationDetailResponseSchema);
}

export function sendTestNotification(idempotencyKey: string): Promise<NotificationDetailResponse> {
  return post(
    CONTROL_ROUTES.notificationTest,
    { idempotencyKey },
    notificationDetailResponseSchema,
  );
}
