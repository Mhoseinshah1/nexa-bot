import {
  IDENTITY_ERROR_CODES,
  ADMIN_ROUTES,
  adminListResponseSchema,
  API_PREFIX,
  AUTH_ROUTES,
  errorResponseSchema,
  healthInfoResponseSchema,
  loginResponseSchema,
  logoutResponseSchema,
  sessionResponseSchema,
  type AdminListResponse,
  type HealthInfoResponse,
  type LoginResponse,
  type LogoutResponse,
  type SessionResponse,
  CONTROL_ROUTES,
  HEALTH_ROUTES,
  featureFlagListResponseSchema,
  featureFlagWriteResponseSchema,
  settingWriteResponseSchema,
  notificationDetailResponseSchema,
  sendTestNotificationResponseSchema,
  notificationListResponseSchema,
  operationalEventListResponseSchema,
  previewTemplateResponseSchema,
  settingListResponseSchema,
  templateListResponseSchema,
  templateRevisionListResponseSchema,
  templateWriteResponseSchema,
  type FeatureFlagListResponse,
  type NotificationDetailResponse,
  type SendTestNotificationResponse,
  type NotificationListResponse,
  type OperationalEventListResponse,
  type PreviewTemplateResponse,
  type FeatureFlagWriteResponse,
  type SettingWriteResponse,
  type SettingListResponse,
  type TemplateListResponse,
  type TemplateRevisionListResponse,
  type TemplateWriteResponse,
  systemReadinessResponseSchema,
  type SystemReadinessResponse,
  PANEL_ROUTES,
  panelListResponseSchema,
  panelResponseSchema,
  providerListResponseSchema,
  testPanelResponseSchema,
  type PanelCredentialsInput,
  type PanelListResponse,
  type PanelResponse,
  type PanelStatus,
  type ProviderListResponse,
  type ProviderType,
  type TestPanelResponse,
  type OperationalScope,
  monitorProfileResponseSchema,
  type MonitorProfileResponse,
} from '@nexa/contracts';

/**
 * The typed API client.
 *
 * Responses are PARSED with the same zod schemas the server validates against.
 * A change to a shape in `@nexa/contracts` is therefore a type error here and
 * in the API at the same time — which is the whole reason the seam exists.
 */

/**
 * What the background panel monitor is configured to do, and what that
 * configuration can carry.
 *
 * Fetched rather than derived. The shipped health cadence is three minutes and
 * a deployment can set anything the schema accepts; a screen that printed
 * "every 3 minutes" from a constant in this bundle would be stating a number
 * the installation may not be running.
 */
export function fetchMonitorProfile(): Promise<MonitorProfileResponse> {
  return authedGet(CONTROL_ROUTES.systemMonitor, monitorProfileResponseSchema);
}

/** Readiness with dependency detail. Requires a session. */
export function fetchReadiness(): Promise<SystemReadinessResponse> {
  return authedGet(CONTROL_ROUTES.systemReadiness, systemReadinessResponseSchema);
}

/**
 * Build metadata. Requires a session, so it goes through `authedGet`.
 *
 * It worked through the anonymous `get()` only because the Fetch spec defaults
 * `credentials` to `same-origin` — the implicit behaviour this file elsewhere
 * says it does not rely on. Relying on it here would have been the same bet,
 * made silently.
 */
export function fetchInfo(): Promise<HealthInfoResponse> {
  return authedGet(HEALTH_ROUTES.info, healthInfoResponseSchema, { absolute: true });
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
/**
 * An authenticated GET.
 *
 * `absolute` is for the health routes, which live outside `API_PREFIX` but are
 * no longer anonymous. `credentials: 'same-origin'` is explicit throughout: it
 * is the spec's default, and a default nobody wrote down is a default nobody
 * notices changing.
 */
async function authedGet<T>(
  path: string,
  schema: { parse: (v: unknown) => T },
  options: { absolute?: boolean } = {},
): Promise<T> {
  const response = await fetch(options.absolute === true ? path : `${API_PREFIX}${path}`, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw toApiError(response.status, payload);
  return schema.parse(payload);
}

/**
 * A key for one SUBMISSION, minted when the submission begins.
 *
 * Every state-changing command takes one, so a retry after a dropped connection
 * produces one change rather than two. That only holds if the key survives the
 * retry: minting it inside the call meant every attempt carried a NEW key, and
 * an idempotency key that changes per attempt protects nothing at all. So the
 * callers mint it once and pass it as the mutation's VARIABLE, which react-query
 * hands back unchanged on a retry and on an offline-paused mutation's resume.
 *
 * `main.tsx` sets `mutations.retry`, without which there are no retries to
 * protect and this whole paragraph would be describing something unreachable —
 * which is what it was doing when it was first written.
 *
 * `randomUUID` is available in every browser this admin supports and in the test
 * environment.
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
  expectedRevision: number | null;
  idempotencyKey: string;
}): Promise<TemplateWriteResponse> {
  const { key, ...rest } = input;
  return post(CONTROL_ROUTES.template(key), rest, templateWriteResponseSchema);
}

export function revertTemplate(input: {
  key: string;
  expectedVersion: number;
  expectedRevision: number;
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
  /** The `lastSeenAt` of the oldest row already shown; returns older ones. */
  before?: string;
  /** Its id, which breaks ties when several rows share that timestamp. */
  beforeId?: string;
  /**
   * `MANAGEMENT` narrows to the codes that want a person's attention.
   *
   * Sent to the server rather than applied to the answer: filtering a page of
   * fifty rows down to two here would leave the cursor having already walked
   * past the other forty-eight, so paging would drop rows silently.
   */
  scope?: OperationalScope;
  /**
   * Sent EXPLICITLY, even when it matches the server default.
   *
   * `GET /ops-log` answers with rows and no `nextCursor`, so the only way a
   * caller can tell a full page from the last one is to know the page size it
   * asked for. Relying on the server's default meant the pager could not tell
   * them apart and enabled "older" whenever the page had any row at all — one
   * press past the end rendered "there are no open alerts" over an alert that
   * existed, in the subsystem whose stated rule is that silence is the one
   * outcome it may not produce.
   */
  limit?: number;
}): Promise<OperationalEventListResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.severity) params.set('severity', query.severity);
  if (query.open !== undefined) params.set('open', String(query.open));
  if (query.before) params.set('before', query.before);
  if (query.beforeId) params.set('beforeId', query.beforeId);
  if (query.scope) params.set('scope', query.scope);
  const suffix = params.toString();
  return authedGet(
    suffix ? `${CONTROL_ROUTES.opsLog}?${suffix}` : CONTROL_ROUTES.opsLog,
    operationalEventListResponseSchema,
  );
}

export function fetchNotifications(
  query: {
    limit?: number;
    /** The `createdAt` of the oldest intent already shown; returns older ones. */
    before?: string;
    /** Its id, which breaks ties when several intents share that timestamp. */
    beforeId?: string;
  } = {},
): Promise<NotificationListResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.before) params.set('before', query.before);
  if (query.beforeId) params.set('beforeId', query.beforeId);
  const suffix = params.toString();
  return authedGet(
    suffix ? `${CONTROL_ROUTES.notifications}?${suffix}` : CONTROL_ROUTES.notifications,
    notificationListResponseSchema,
  );
}

export function fetchNotification(id: string): Promise<NotificationDetailResponse> {
  return authedGet(CONTROL_ROUTES.notification(id), notificationDetailResponseSchema);
}

export function sendTestNotification(
  idempotencyKey: string,
): Promise<SendTestNotificationResponse> {
  return post(
    CONTROL_ROUTES.notificationTest,
    { idempotencyKey },
    sendTestNotificationResponseSchema,
  );
}

// ---------------------------------------------------------------------------
// Panels and providers
// ---------------------------------------------------------------------------

/**
 * The provider catalogue.
 *
 * Fetched rather than hardcoded, because a provider is CODE: its capabilities
 * come from the adapter's descriptor, and a copy of that list in the browser is
 * a copy that goes stale the release a capability is added. The picker on the
 * add-panel form is populated from this and from nothing else.
 */
export function fetchProviders(): Promise<ProviderListResponse> {
  return authedGet(PANEL_ROUTES.providers, providerListResponseSchema);
}

/**
 * One page of panels.
 *
 * `cursor` is opaque and is passed back exactly as received. Parsing it here
 * would make this client depend on an ordering the API has deliberately not
 * promised — and the server rejects a cursor it did not mint, so a "clever"
 * client-side cursor is a 400 rather than a subtle bug.
 */
export function fetchPanels(
  query: { limit?: number; cursor?: string } = {},
): Promise<PanelListResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined && query.cursor !== '') params.set('cursor', query.cursor);
  const suffix = params.toString();
  return authedGet(
    suffix ? `${PANEL_ROUTES.list}?${suffix}` : PANEL_ROUTES.list,
    panelListResponseSchema,
  );
}

export function fetchPanel(id: string): Promise<PanelResponse> {
  return authedGet(PANEL_ROUTES.detail(id), panelResponseSchema);
}

export function createPanel(input: {
  name: string;
  providerType: ProviderType;
  baseUrl: string;
  credentials?: PanelCredentialsInput;
  idempotencyKey: string;
}): Promise<PanelResponse> {
  return post(PANEL_ROUTES.create, input, panelResponseSchema);
}

export function updatePanel(input: {
  id: string;
  name?: string;
  baseUrl?: string;
  idempotencyKey: string;
}): Promise<PanelResponse> {
  const { id, ...body } = input;
  return post(PANEL_ROUTES.update(id), body, panelResponseSchema);
}

/**
 * Replacing a credential is its own route because it is its own permission:
 * `panels.credentials.rotate` is CRITICAL and `panels.edit` is HIGH. Folding
 * them together would force every name change to require the right to rotate.
 */
export function setPanelCredentials(input: {
  id: string;
  credentials: PanelCredentialsInput;
  idempotencyKey: string;
}): Promise<PanelResponse> {
  const { id, ...body } = input;
  return post(PANEL_ROUTES.credentials(id), body, panelResponseSchema);
}

export function setPanelStatus(input: {
  id: string;
  status: PanelStatus;
  idempotencyKey: string;
}): Promise<PanelResponse> {
  const { id, ...body } = input;
  return post(PANEL_ROUTES.status(id), body, panelResponseSchema);
}

/**
 * A connection test. It is a state-changing command and carries a key like one:
 * it writes a health row and an audit entry, and `probed: false` in the answer
 * means the stored health came back without a new probe being made.
 */
export function testPanel(input: {
  id: string;
  idempotencyKey: string;
}): Promise<TestPanelResponse> {
  const { id, ...body } = input;
  return post(PANEL_ROUTES.test(id), body, testPanelResponseSchema);
}
