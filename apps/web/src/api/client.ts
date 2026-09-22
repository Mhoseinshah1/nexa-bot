import {
  IDENTITY_ERROR_CODES,
  PAYMENT_ROUTES,
  SERVICE_ROUTES,
  serviceListResponseSchema,
  serviceActionResponseSchema,
  serviceOperationsResponseSchema,
  serviceResponseSchema,
  type ServiceDeliveryState,
  type ServiceActionResponse,
  type ServiceListResponse,
  type ServiceOperationsResponse,
  type ServiceResponse,
  type ServiceOperatorAction,
  type ServiceState,
  WALLET_ROUTES,
  paymentListResponseSchema,
  paymentReceiptListResponseSchema,
  paymentResponseSchema,
  walletEntryListResponseSchema,
  walletEntryResponseSchema,
  walletResponseSchema,
  type LedgerDirection,
  type PaymentListResponse,
  type PaymentMethod,
  type PaymentReceiptListResponse,
  type PaymentResponse,
  type PaymentState,
  type WalletEntryListResponse,
  type WalletEntryResponse,
  type WalletResponse,
  ADMIN_ROUTES,
  adminListResponseSchema,
  adminSessionListResponseSchema,
  roleListResponseSchema,
  adminSummarySchema,
  resetAdminPasswordResponseSchema,
  revokeAdminSessionsResponseSchema,
  API_PREFIX,
  AUTH_ROUTES,
  errorResponseSchema,
  healthInfoResponseSchema,
  loginResponseSchema,
  logoutResponseSchema,
  sessionResponseSchema,
  type AdminListResponse,
  type AdminSessionListResponse,
  type RoleListResponse,
  type AdminSummary,
  type ResetAdminPasswordResponse,
  type RevokeAdminSessionsResponse,
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
  type PanelUsernamePolicyInput,
  type PanelListArchivedMode,
  type PanelListResponse,
  type PanelResponse,
  type PanelStatus,
  type ProviderListResponse,
  type ProviderType,
  type TestPanelResponse,
  type OperationalScope,
  monitorProfileResponseSchema,
  type MonitorProfileResponse,
  BACKUP_ROUTES,
  RECOVERY_ROUTES,
  backupHistoryResponseSchema,
  backupStatusResponseSchema,
  recoveryCapabilitiesResponseSchema,
  recoveryDetailResponseSchema,
  recoveryListResponseSchema,
  runBackupResponseSchema,
  type BackupHistoryResponse,
  type BackupStatusResponse,
  type RecoveryCapabilitiesResponse,
  type RecoveryDetailResponse,
  type RecoveryListResponse,
  type RunBackupResponse,
  CUSTOMER_ROUTES,
  customerListResponseSchema,
  PRODUCT_ROUTES,
  productListResponseSchema,
  productResponseSchema,
  PRODUCT_CATEGORY_ROUTES,
  productCategoryListResponseSchema,
  productCategoryResponseSchema,
  productCategoryAssignedResponseSchema,
  categoryDeletedResponseSchema,
  type ProductCategoryListResponse,
  type ProductCategoryResponse,
  ORDER_ROUTES,
  orderListResponseSchema,
  orderResponseSchema,
  type OrderListResponse,
  type OrderResponse,
  type OrderState,
  type ProductAudience,
  type ProductListResponse,
  type ProductResponse,
  type ProductStatus,
  type CurrencyCode,
  customerResponseSchema,
  type CustomerListResponse,
  type CustomerResponse,
  type CustomerStatus,
  PAYMENT_ACCOUNT_ROUTES,
  paymentAccountListResponseSchema,
  paymentAccountResponseSchema,
  type PaymentAccountListResponse,
  type PaymentAccountResponse,
  PAYMENT_GATEWAY_ROUTES,
  paymentGatewayListResponseSchema,
  paymentGatewayResponseSchema,
  type PaymentGatewayListResponse,
  type PaymentGatewayResponse,
  type PaymentGatewayStatus,
  REFUND_ROUTES,
  refundListResponseSchema,
  refundResponseSchema,
  type RefundListResponse,
  type RefundResponse,
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

/**
 * DELETE, with a body.
 *
 * Unusual, and deliberate: every mutation on this surface carries an idempotency key,
 * and a delete is where a lost response most needs one — without it the operator's
 * second press either removes something recreated since or reports failure for work
 * that already succeeded. `fetch` sends a body on DELETE and Fastify parses it, so the
 * only cost is this note.
 */
async function del<T>(
  path: string,
  body: unknown,
  schema: { parse: (v: unknown) => T },
): Promise<T> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    method: 'DELETE',
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

/** The role catalogue, for the checkboxes that assign them. */
export function fetchRoles(): Promise<RoleListResponse> {
  return authedGet(ADMIN_ROUTES.rolesCatalog, roleListResponseSchema);
}

/**
 * Create an administrator. The password leaves the browser once and is never read back.
 *
 * `idempotencyKey` is required by this function even though the schema makes it
 * optional, and the asymmetry is deliberate: the browser is the caller that
 * RETRIES. `mutations.retry` in `main.tsx` re-sends a write the server did not
 * answer, so a create that committed and lost its response comes back as
 * `ADMIN_USERNAME_TAKEN` and the operator is told it failed — for an account
 * that exists with the credential they just chose. A caller with no retry of its
 * own may omit the key; this one may not.
 */
export function createAdmin(input: {
  username: string;
  displayName: string;
  password: string;
  roleKeys: string[];
  idempotencyKey: string;
  telegramUserId?: string | null;
}): Promise<AdminSummary> {
  return post(ADMIN_ROUTES.create, input, adminSummarySchema);
}

export function setAdminStatus(input: {
  id: string;
  status: 'ACTIVE' | 'DISABLED';
  reason: string;
}): Promise<AdminSummary> {
  const { id, ...body } = input;
  return post(ADMIN_ROUTES.status(id), body, adminSummarySchema);
}

export function setAdminRoles(input: {
  id: string;
  roleKeys: string[];
  reason: string;
}): Promise<AdminSummary> {
  const { id, ...body } = input;
  return post(ADMIN_ROUTES.roles(id), body, adminSummarySchema);
}

/**
 * Set a new password for an administrator who is NOT the signed-in one.
 *
 * The response carries no credential — the administrator as anybody may see
 * them, and how many sessions the reset ended.
 */
export function resetAdminPassword(input: {
  id: string;
  newPassword: string;
  reason: string;
}): Promise<ResetAdminPasswordResponse> {
  const { id, ...body } = input;
  return post(ADMIN_ROUTES.password(id), body, resetAdminPasswordResponseSchema);
}

export function fetchAdminSessions(id: string): Promise<AdminSessionListResponse> {
  return authedGet(ADMIN_ROUTES.sessions(id), adminSessionListResponseSchema);
}

export function revokeAdminSessions(input: {
  id: string;
  reason: string;
}): Promise<RevokeAdminSessionsResponse> {
  const { id, ...body } = input;
  return post(ADMIN_ROUTES.revokeSessions(id), body, revokeAdminSessionsResponseSchema);
}

/** Connect (`telegramUserId`), replace, or remove (`null`) an administrator's Telegram binding. */
export function setAdminTelegramBinding(input: {
  id: string;
  telegramUserId: string | null;
  reason: string;
}): Promise<AdminSummary> {
  const { id, ...body } = input;
  return post(ADMIN_ROUTES.telegram(id), body, adminSummarySchema);
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
  /**
   * The `firstSeenAt` of the oldest row already shown; returns older ones.
   *
   * NOT `lastSeenAt`: every repeat occurrence rewrites that, so a row below
   * the cursor that recurs would jump above it and appear on no later page.
   */
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
   * `GET /ops-log` now answers with a `nextCursor`, which is what actually
   * decides whether an "older" page exists — the pager reads that, not the row
   * count. This is still sent explicitly because the server's default and the
   * page size the caller renders must be the SAME number: two spellings of
   * "50" would make the pager offer a page that is not there, or hide one that
   * is. The comment that used to sit here described the pre-cursor server and
   * told the next reader to compare lengths, which is the bug the cursor
   * replaced.
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
 * promised — and the server refuses a cursor it did not mint, so a "clever"
 * client-side cursor is a 400 rather than a subtle bug.
 *
 * That second half was FALSE when it was first written and is true now. The
 * server used to answer 200 with page one for any unreadable cursor, so a
 * client that truncated one looped silently — the exact subtle bug the sentence
 * promised could not happen. The owner resolved the inconsistency in favour of
 * refusing, `panelListQuerySchema` carries the rule, and
 * `panels-http.test.ts` pins it against eighteen malformed cursors — a count
 * that test asserts about its own fixture, because this sentence and the
 * falsification record once said thirteen while a fourteenth was added and the
 * commit message said fifteen. The fifteenth is year zero; the last three are
 * a real cursor with a character appended, inserted and padded, which the
 * decoder used to accept because base64url decoding skips what it cannot read.
 */
// --- Customers (Phase 4A) ---------------------------------------------------

/**
 * One page of customers.
 *
 * `telegramUserId` and `username` are separate parameters because they are separate
 * questions on the server: the first is an exact match and the second a prefix, and the
 * exact one needs `users.search` just as the prefix does. Sent only when non-empty, so
 * clearing a search box is the unfiltered list rather than a search for the empty string
 * — which the server would answer with every row while charging the search permission
 * for it.
 */
export function fetchCustomers(
  query: {
    limit?: number;
    cursor?: string;
    telegramUserId?: string;
    username?: string;
    status?: CustomerStatus;
  } = {},
): Promise<CustomerListResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined && query.cursor !== '') params.set('cursor', query.cursor);
  if (query.telegramUserId !== undefined && query.telegramUserId !== '') {
    params.set('telegramUserId', query.telegramUserId);
  }
  if (query.username !== undefined && query.username !== '') params.set('username', query.username);
  if (query.status !== undefined) params.set('status', query.status);
  const suffix = params.toString();
  return authedGet(
    suffix ? `${CUSTOMER_ROUTES.list}?${suffix}` : CUSTOMER_ROUTES.list,
    customerListResponseSchema,
  );
}

export function fetchCustomer(id: string): Promise<CustomerResponse> {
  return authedGet(CUSTOMER_ROUTES.detail(id), customerResponseSchema);
}

export function blockCustomer(input: {
  id: string;
  reason?: string;
  idempotencyKey: string;
}): Promise<CustomerResponse> {
  const { id, ...body } = input;
  return post(CUSTOMER_ROUTES.block(id), body, customerResponseSchema);
}

export function unblockCustomer(input: {
  id: string;
  reason?: string;
  idempotencyKey: string;
}): Promise<CustomerResponse> {
  const { id, ...body } = input;
  return post(CUSTOMER_ROUTES.unblock(id), body, customerResponseSchema);
}

// --- Products and orders (Phase 4B) -----------------------------------------

/**
 * One page of products, for the OPERATOR's list.
 *
 * Not the customer catalogue: this returns withdrawn, unpriced and hidden products
 * too, because curating them is what the page is for. The catalogue's four predicates
 * live in `listCatalog` and are the bot's, not this surface's.
 */
export function fetchProducts(
  query: {
    limit?: number;
    cursor?: string;
    status?: ProductStatus;
    audience?: ProductAudience;
    title?: string;
    panelId?: string;
    /** A category id, or the literal `'none'` for the products filed under nothing. */
    categoryId?: string;
  } = {},
): Promise<ProductListResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined && query.cursor !== '') params.set('cursor', query.cursor);
  if (query.status !== undefined) params.set('status', query.status);
  if (query.audience !== undefined) params.set('audience', query.audience);
  // Omitted when empty, so clearing the box is the unfiltered list rather than a
  // search for the empty string.
  if (query.title !== undefined && query.title !== '') params.set('title', query.title);
  // Same emptiness rule as `title`, and the same reason `fetchServices` applies it to
  // its two ids: an empty string is not a filter, and the server validates this one as
  // a UUID rather than passing it to a `uuid` column.
  if (query.panelId !== undefined && query.panelId !== '') params.set('panelId', query.panelId);
  // Same emptiness rule. `'none'` is a real value here and passes through unchanged.
  if (query.categoryId !== undefined && query.categoryId !== '') {
    params.set('categoryId', query.categoryId);
  }
  const suffix = params.toString();
  return authedGet(
    suffix ? `${PRODUCT_ROUTES.list}?${suffix}` : PRODUCT_ROUTES.list,
    productListResponseSchema,
  );
}

export function fetchProduct(id: string): Promise<ProductResponse> {
  return authedGet(PRODUCT_ROUTES.detail(id), productResponseSchema);
}

/**
 * The write body for create and edit.
 *
 * One shape for both, because the set of mutable properties IS the set of writable
 * ones. `status` is absent: a product is created INACTIVE and becomes purchasable
 * through its own command, so one call cannot publish an unpriced plan.
 */
export interface ProductWriteInput {
  title: string;
  description: string | null;
  audience: ProductAudience;
  sortOrder: number;
  panelId: string | null;
  durationDays: number;
  trafficBytes: string;
  deviceLimit: number | null;
  priceAmount: string | null;
  priceCurrency: CurrencyCode | null;
  /** Required by the contract; `null` files the product under no category. */
  categoryId: string | null;
  idempotencyKey: string;
}

export function createProduct(input: ProductWriteInput): Promise<ProductResponse> {
  return post(PRODUCT_ROUTES.create, input, productResponseSchema);
}

export function updateProduct(input: ProductWriteInput & { id: string }): Promise<ProductResponse> {
  const { id, ...body } = input;
  return post(PRODUCT_ROUTES.update(id), body, productResponseSchema);
}

export function activateProduct(input: {
  id: string;
  idempotencyKey: string;
}): Promise<ProductResponse> {
  const { id, ...body } = input;
  return post(PRODUCT_ROUTES.activate(id), body, productResponseSchema);
}

export function deactivateProduct(input: {
  id: string;
  idempotencyKey: string;
}): Promise<ProductResponse> {
  const { id, ...body } = input;
  return post(PRODUCT_ROUTES.deactivate(id), body, productResponseSchema);
}

// --- Product categories ------------------------------------------------------

/**
 * Every category, with its product count.
 *
 * Unpaged, and that is the server's decision rather than this client's: a category
 * list is a handful of rows an operator arranges by hand, and paging it would make
 * "move this to the top" a question about which page the top is on.
 */
export function fetchProductCategories(): Promise<ProductCategoryListResponse> {
  return authedGet(PRODUCT_CATEGORY_ROUTES.list, productCategoryListResponseSchema);
}

export interface ProductCategoryWriteInput {
  name: string;
  description: string | null;
  emoji: string | null;
  idempotencyKey: string;
}

export function createProductCategory(
  input: ProductCategoryWriteInput & { sortOrder: number },
): Promise<ProductCategoryResponse> {
  return post(PRODUCT_CATEGORY_ROUTES.create, input, productCategoryResponseSchema);
}

export function updateProductCategory(
  input: ProductCategoryWriteInput & { id: string },
): Promise<ProductCategoryResponse> {
  const { id, ...body } = input;
  return post(PRODUCT_CATEGORY_ROUTES.update(id), body, productCategoryResponseSchema);
}

/**
 * The four flag transitions, through one function.
 *
 * `which` names the ROUTE rather than a target state, because status and visibility are
 * independent — `docs/wp5-categories-audit.md` §6.3 — and a single `setEnabled(flag)`
 * would be the shape that eventually lets one of them be written as the other.
 */
export function transitionProductCategory(input: {
  id: string;
  which: 'activate' | 'deactivate' | 'show' | 'hide';
  idempotencyKey: string;
}): Promise<ProductCategoryResponse> {
  const { id, which, ...body } = input;
  return post(PRODUCT_CATEGORY_ROUTES[which](id), body, productCategoryResponseSchema);
}

/**
 * A whole new order for every category named.
 *
 * The server refuses a SHORT match rather than reordering what it recognises, so this
 * always sends the complete list as the operator now has it — a subset believed
 * complete would otherwise be half-applied under a success message.
 */
export function reorderProductCategories(input: {
  positions: readonly { id: string; sortOrder: number }[];
  idempotencyKey: string;
}): Promise<ProductCategoryListResponse> {
  return post(PRODUCT_CATEGORY_ROUTES.reorder, input, productCategoryListResponseSchema);
}

export function assignProductCategory(input: {
  categoryId: string;
  productId: string;
  idempotencyKey: string;
}): Promise<{ productId: string; categoryId: string }> {
  const { categoryId, ...body } = input;
  return post(
    PRODUCT_CATEGORY_ROUTES.assign(categoryId),
    body,
    productCategoryAssignedResponseSchema,
  );
}

/**
 * Deletes a category, and is REFUSED while it still holds products.
 *
 * The refusal carries the count in `details.productCount`, which is what the screen
 * renders — "this category still holds eleven products" is what an operator can act on
 * where "cannot delete" is not.
 */
export function deleteProductCategory(input: {
  id: string;
  idempotencyKey: string;
}): Promise<{ deleted: true }> {
  const { id, ...body } = input;
  return del(PRODUCT_CATEGORY_ROUTES.remove(id), body, categoryDeletedResponseSchema);
}

/**
 * One page of orders.
 *
 * Read only. There is no `cancelOrder`, `settleOrder` or `refundOrder` here for the
 * reason `orders.controller.ts` gives: every one of them depends on a payment record
 * this release does not have, and a client function for a route that does not exist is
 * how a button comes to be drawn for it.
 */
export function fetchOrders(
  query: {
    limit?: number;
    cursor?: string;
    state?: OrderState;
    customerId?: string;
    productId?: string;
  } = {},
): Promise<OrderListResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined && query.cursor !== '') params.set('cursor', query.cursor);
  if (query.state !== undefined) params.set('state', query.state);
  if (query.customerId !== undefined && query.customerId !== '') {
    params.set('customerId', query.customerId);
  }
  if (query.productId !== undefined && query.productId !== '') {
    params.set('productId', query.productId);
  }
  const suffix = params.toString();
  return authedGet(
    suffix ? `${ORDER_ROUTES.list}?${suffix}` : ORDER_ROUTES.list,
    orderListResponseSchema,
  );
}

export function fetchOrder(id: string): Promise<OrderResponse> {
  return authedGet(ORDER_ROUTES.detail(id), orderResponseSchema);
}

/*
 * Wallet and payments (Phase 4C).
 *
 * What is NOT here, and would be the easiest thing to add by accident: no
 * `setWalletBalance`, no `editWalletEntry`, no `deleteWalletEntry`, and no
 * `createPayment`, `failPayment`, `cancelPayment`, `retryPayment` or `refundPayment`.
 * None of those routes exists, and a client function for a route that does not exist is
 * how a button comes to be drawn for it — the reason `fetchOrders` states for the same
 * absence one phase earlier.
 */
export function fetchWallet(customerId: string): Promise<WalletResponse> {
  return authedGet(WALLET_ROUTES.balance(customerId), walletResponseSchema);
}

export function fetchWalletEntries(
  customerId: string,
  query: { limit?: number; cursor?: string } = {},
): Promise<WalletEntryListResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined && query.cursor !== '') params.set('cursor', query.cursor);
  const suffix = params.toString();
  const base = WALLET_ROUTES.entries(customerId);
  return authedGet(suffix ? `${base}?${suffix}` : base, walletEntryListResponseSchema);
}

/**
 * An operator moving a customer's money by hand.
 *
 * `amount` is a decimal STRING in minor units, never a `number`: JSON has one numeric
 * type and it loses precision past 2^53. There is no `reason` parameter — the server
 * derives it from the direction, so a request cannot file a debit as a `PURCHASE`.
 */
export function adjustWallet(input: {
  customerId: string;
  idempotencyKey: string;
  direction: LedgerDirection;
  amount: string;
  currency: CurrencyCode;
  note: string;
}): Promise<WalletEntryResponse> {
  const { customerId, ...body } = input;
  return post(WALLET_ROUTES.adjust(customerId), body, walletEntryResponseSchema);
}

export function fetchPayments(
  query: {
    limit?: number;
    cursor?: string;
    state?: PaymentState;
    method?: PaymentMethod;
    customerId?: string;
    orderId?: string;
    reference?: string;
  } = {},
): Promise<PaymentListResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined && query.cursor !== '') params.set('cursor', query.cursor);
  if (query.state !== undefined) params.set('state', query.state);
  if (query.method !== undefined) params.set('method', query.method);
  if (query.customerId !== undefined && query.customerId !== '') {
    params.set('customerId', query.customerId);
  }
  if (query.orderId !== undefined && query.orderId !== '') params.set('orderId', query.orderId);
  if (query.reference !== undefined && query.reference !== '') {
    params.set('reference', query.reference);
  }
  const suffix = params.toString();
  return authedGet(
    suffix ? `${PAYMENT_ROUTES.list}?${suffix}` : PAYMENT_ROUTES.list,
    paymentListResponseSchema,
  );
}

/**
 * Services, as an operator reads them.
 *
 * The responses carry NO subscription URL, no subscription ref and no provider client
 * id — the server does not send them, and this client could not surface them if it
 * wanted to. See `serviceSummarySchema`: a credential travels one way, and a list is
 * the worst place to break that.
 */
export function fetchServices(
  query: {
    limit?: number;
    cursor?: string;
    state?: ServiceState;
    deliveryState?: ServiceDeliveryState;
    customerId?: string;
    orderId?: string;
    panelId?: string;
    providerUsername?: string;
  } = {},
): Promise<ServiceListResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined && query.cursor !== '') params.set('cursor', query.cursor);
  if (query.state !== undefined) params.set('state', query.state);
  if (query.deliveryState !== undefined) params.set('deliveryState', query.deliveryState);
  if (query.customerId !== undefined && query.customerId !== '') {
    params.set('customerId', query.customerId);
  }
  /*
   * The order that bought it. One row at most, which is the whole point: the order
   * page asks "what did this order produce" and gets an answer rather than a guess.
   */
  if (query.orderId !== undefined && query.orderId !== '') params.set('orderId', query.orderId);
  if (query.panelId !== undefined && query.panelId !== '') params.set('panelId', query.panelId);
  /*
   * The account name, sent RAW and canonicalised by the server.
   *
   * Not lowercased here: `providerUsernameLookupSchema` folds and validates it, and a
   * client that folded it first would be a second opinion about what a username is —
   * the one `ServiceSearch` names. An empty string is not a filter, the same rule the
   * two ids above apply.
   */
  if (query.providerUsername !== undefined && query.providerUsername !== '') {
    params.set('providerUsername', query.providerUsername);
  }
  const suffix = params.toString();
  return authedGet(
    suffix ? `${SERVICE_ROUTES.list}?${suffix}` : SERVICE_ROUTES.list,
    serviceListResponseSchema,
  );
}

export function fetchService(id: string): Promise<ServiceResponse> {
  return authedGet(SERVICE_ROUTES.detail(id), serviceResponseSchema);
}

/** What has been attempted on one service. Bounded by the server, newest first. */
export function fetchServiceOperations(id: string): Promise<ServiceOperationsResponse> {
  return authedGet(SERVICE_ROUTES.operations(id), serviceOperationsResponseSchema);
}

/**
 * The path each operator action POSTs to, taken from the frozen route table.
 *
 * A table rather than seven functions, because the seven differ in exactly one thing
 * that matters to this layer — terminate carries a phrase — and writing them out
 * separately would be seven chances to point a label at the wrong URL. The server
 * charges a different permission for terminate; that is its business, not the client's.
 */
const SERVICE_ACTION_PATHS: Readonly<Record<ServiceOperatorAction, (id: string) => string>> = {
  SYNC_USAGE: SERVICE_ROUTES.syncUsage,
  RESEND_CONFIG: SERVICE_ROUTES.resend,
  RETRY_PROVISION: SERVICE_ROUTES.retryProvision,
  RECONCILE: SERVICE_ROUTES.reconcile,
  SUSPEND: SERVICE_ROUTES.suspend,
  RESUME: SERVICE_ROUTES.resume,
  TERMINATE: SERVICE_ROUTES.terminate,
};

/**
 * Takes one action on one service.
 *
 * The response carries the service as it NOW is and the operation that was planned, so
 * the caller can redraw from it without a second round trip — and must, because the
 * action list in that response is the only truthful one after a write.
 *
 * `TERMINATE` is the only action that takes more than a key. The phrase is validated
 * again by the server, in full and after trimming, so sending it from here is not the
 * confirmation — the person typing it is.
 */
export function actOnService(input: {
  id: string;
  action: ServiceOperatorAction;
  idempotencyKey: string;
  confirm?: string;
}): Promise<ServiceActionResponse> {
  const body =
    input.action === 'TERMINATE'
      ? { idempotencyKey: input.idempotencyKey, confirm: input.confirm ?? '' }
      : { idempotencyKey: input.idempotencyKey };
  return post(SERVICE_ACTION_PATHS[input.action](input.id), body, serviceActionResponseSchema);
}

export function fetchPayment(id: string): Promise<PaymentResponse> {
  return authedGet(PAYMENT_ROUTES.detail(id), paymentResponseSchema);
}

/** What the customer sent against one payment. Behind `receipts.view` on the server. */
export function fetchPaymentReceipts(id: string): Promise<PaymentReceiptListResponse> {
  return authedGet(PAYMENT_ROUTES.receipts(id), paymentReceiptListResponseSchema);
}

/**
 * One receipt's bytes, as a Blob this tab owns.
 *
 * A fetch rather than the anchor a backup archive uses, and the difference is the
 * response: the API serves these as `application/octet-stream` with `nosniff` and
 * `attachment`, deliberately, so that a customer's «receipt» that is really an SVG or
 * an HTML document cannot execute on the admin origin. An anchor would therefore only
 * ever download. Reading the bytes here and deciding the type from what the record
 * SAYS it is — never from the bytes, never from the response — is what lets an image
 * be shown while a document stays a download.
 *
 * Buffering in the tab is bounded by `PAYMENT_RECEIPT_MAX_BYTES`, which the API
 * enforces on both sides of its own fetch.
 */
export async function fetchPaymentReceiptBytes(
  paymentId: string,
  receiptId: string,
): Promise<Blob> {
  const response = await fetch(
    `${API_PREFIX}${PAYMENT_ROUTES.receiptContent(paymentId, receiptId)}`,
    { credentials: 'same-origin', headers: { accept: 'application/octet-stream' } },
  );
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw toApiError(response.status, payload);
  }
  return response.blob();
}

/**
 * Confirming that an out-of-band transfer arrived.
 *
 * A NOTE and nothing else. There is no amount here and no currency: a confirmation
 * records that money the payment already names arrived, and an operator able to restate
 * the figure at approval time is an operator able to approve a different payment from
 * the one the customer made.
 */
/**
 * The manual-transfer destinations, all of them, with no cursor.
 *
 * The one list in this client that does not page. `PAYMENT_ACCOUNT_MAX_PER_TENANT`
 * makes it complete by construction, which a configuration screen needs and a paginated
 * one cannot promise.
 */
export function fetchPaymentAccounts(): Promise<PaymentAccountListResponse> {
  return authedGet(PAYMENT_ACCOUNT_ROUTES.list, paymentAccountListResponseSchema);
}

/**
 * Adds a destination.
 *
 * The card number and the Sheba are sent as the operator typed them — separators,
 * Persian digits and all. Normalisation happens on the SERVER, inside
 * `paymentAccountInputSchema`, so that what is stored and what is frozen onto a payment
 * are one representation decided in one place. A browser that normalised first would be
 * a second opinion about what a card number is, and the one nobody tests.
 */
export function createPaymentAccount(input: {
  idempotencyKey: string;
  label: string;
  bankName: string;
  holderName: string;
  cardNumber: string;
  iban: string | null;
  sortOrder: number;
  enabled: boolean;
  makeDefault: boolean;
}): Promise<PaymentAccountResponse> {
  return post(PAYMENT_ACCOUNT_ROUTES.create, input, paymentAccountResponseSchema);
}

/** Corrects the fields. It cannot enable, disable or promote — those are their own calls. */
export function updatePaymentAccount(input: {
  id: string;
  idempotencyKey: string;
  label: string;
  bankName: string;
  holderName: string;
  cardNumber: string;
  iban: string | null;
  sortOrder: number;
}): Promise<PaymentAccountResponse> {
  const { id, ...body } = input;
  return post(PAYMENT_ACCOUNT_ROUTES.update(id), body, paymentAccountResponseSchema);
}

/** Stops or resumes using one account. Disabling the default is refused by the server. */
export function setPaymentAccountEnabled(input: {
  id: string;
  idempotencyKey: string;
  enabled: boolean;
}): Promise<PaymentAccountResponse> {
  const { id, ...body } = input;
  return post(PAYMENT_ACCOUNT_ROUTES.enabled(id), body, paymentAccountResponseSchema);
}

/** Moves the destination new payments are issued against. Issued ones do not move. */
export function setDefaultPaymentAccount(input: {
  id: string;
  idempotencyKey: string;
}): Promise<PaymentAccountResponse> {
  const { id, ...body } = input;
  return post(PAYMENT_ACCOUNT_ROUTES.makeDefault(id), body, paymentAccountResponseSchema);
}

/**
 * The payment routes, with the denomination their bounds are in.
 *
 * The currency arrives WITH the list rather than from a second call, because a bound
 * rendered in the wrong denomination is a number an operator would act on.
 */
export function fetchPaymentGateways(): Promise<PaymentGatewayListResponse> {
  return authedGet(PAYMENT_GATEWAY_ROUTES.list, paymentGatewayListResponseSchema);
}

/**
 * Replaces one route's configuration.
 *
 * The amounts are sent as decimal STRINGS of minor units, and the browser does not
 * compute them: JSON has no bigint, and a `number` here is the float the money model
 * refuses — silently, above 2^53. The RULES (a maximum below the minimum, payment-count
 * bounds that cross) are checked on the server, inside `paymentGatewayConfigSchema`, so
 * this client cannot hold a second opinion about what a valid route is.
 *
 * It cannot switch a route on or off. That is the call below, so that "I changed the
 * limits" and "I stopped accepting this route" are two different audit rows.
 */
export function updatePaymentGateway(input: {
  provider: string;
  idempotencyKey: string;
  displayName: string | null;
  instructions: string | null;
  minAmountMinor: string;
  maxAmountMinor: string;
  eligibility: {
    activateAfterPayments: number;
    deactivateAfterPayments: number;
    activateAfterAccountDays: number;
  };
  sortOrder: number;
}): Promise<PaymentGatewayResponse> {
  const { provider, ...body } = input;
  return post(PAYMENT_GATEWAY_ROUTES.update(provider), body, paymentGatewayResponseSchema);
}

/** Switches one route on or off. A no-op when it is already there, and it says so. */
export function setPaymentGatewayStatus(input: {
  provider: string;
  idempotencyKey: string;
  status: PaymentGatewayStatus;
}): Promise<PaymentGatewayResponse> {
  const { provider, ...body } = input;
  return post(PAYMENT_GATEWAY_ROUTES.status(provider), body, paymentGatewayResponseSchema);
}

export function confirmPayment(input: {
  id: string;
  idempotencyKey: string;
  evidenceNote: string;
}): Promise<PaymentResponse> {
  const { id, ...body } = input;
  return post(PAYMENT_ROUTES.confirm(id), body, paymentResponseSchema);
}

/**
 * Rejecting a receipt: the other half of `receipts.review`.
 *
 * A NOTE and nothing else, exactly as the confirmation. There is no amount, no state
 * and no un-reject: `PAYMENT_MACHINE` has no edge out of FAILED, migration 0052 freezes
 * the row, and a confirmed payment is reversed by a refund rather than by an edit.
 */
export function rejectPayment(input: {
  id: string;
  idempotencyKey: string;
  resolutionNote: string;
}): Promise<PaymentResponse> {
  const { id, ...body } = input;
  return post(PAYMENT_ROUTES.reject(id), body, paymentResponseSchema);
}

export function fetchPanels(
  query: { limit?: number; cursor?: string; archived?: PanelListArchivedMode } = {},
): Promise<PanelListResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined && query.cursor !== '') params.set('cursor', query.cursor);
  // Sent only for the archive browser. Omitted means the working fleet, which
  // is the server's default too — one spelling of the default, not two.
  if (query.archived !== undefined) params.set('archived', query.archived);
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
  /** Absent means the defaults: both modes, and the derived generator. */
  usernamePolicy?: PanelUsernamePolicyInput;
  idempotencyKey: string;
}): Promise<PanelResponse> {
  return post(PANEL_ROUTES.create, input, panelResponseSchema);
}

export function updatePanel(input: {
  id: string;
  name?: string;
  baseUrl?: string;
  /**
   * Absent leaves the cap; `null` removes it; a positive integer sets one.
   *
   * `number | null | undefined` rather than `number | undefined`, because the
   * three states are three different instructions and the server reads them
   * that way. Collapsing null into undefined would make "remove the cap"
   * unsendable from this client.
   */
  maxServices?: number | null;
  /**
   * Absent leaves the whole policy; present replaces the whole policy.
   *
   * NOT three independent optionals, and the server's schema is the same shape for the
   * same reason: the one rule this policy has — at least one mode enabled — is a rule
   * about the pair, so a request carrying half of it could only be validated against
   * whatever happens to be stored.
   */
  usernamePolicy?: PanelUsernamePolicyInput;
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
  /**
   * A replacement name, accepted by the server ONLY on a transition out of
   * `ARCHIVED`.
   *
   * Archiving releases the panel's name — `panels_tenant_name_live_key` is
   * partial on `status <> 'ARCHIVED'` — so another panel may take it, and the
   * restore then answers 409 `panel.name_taken`. Without this the refusal told
   * the operator to rename the panel and no surface could: `POST /panels/:id`
   * refuses an archived panel outright, so the panel was unrestorable from the
   * Web Admin no matter what the API had gained.
   */
  name?: string;
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

// ---------------------------------------------------------------------------
// Backup and disaster recovery
// ---------------------------------------------------------------------------

export function fetchBackupStatus(): Promise<BackupStatusResponse> {
  return authedGet(BACKUP_ROUTES.status, backupStatusResponseSchema);
}

export function fetchBackupHistory(
  query: { limit?: number; cursor?: string } = {},
): Promise<BackupHistoryResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  // An empty cursor is OMITTED rather than sent empty: the server refuses a
  // cursor it did not mint, and `cursor=` is one of those. Sending it would turn
  // "the first page" into a 400.
  if (query.cursor !== undefined && query.cursor !== '') params.set('cursor', query.cursor);
  const suffix = params.toString();
  return authedGet(
    suffix ? `${BACKUP_ROUTES.history}?${suffix}` : BACKUP_ROUTES.history,
    backupHistoryResponseSchema,
  );
}

export function runBackupNow(input: { idempotencyKey: string }): Promise<RunBackupResponse> {
  return post(BACKUP_ROUTES.run, input, runBackupResponseSchema);
}

/**
 * The download URL for an encrypted archive.
 *
 * A URL rather than a fetch, because the browser's own navigation is what should
 * carry a multi-gigabyte file to disk: reading it through `fetch` would buffer
 * the whole archive in the tab's memory to hand it straight back to a blob, for
 * a file whose format streams precisely so that nothing has to.
 *
 * The session cookie rides the navigation, so this needs no token — which is
 * also why there is no token here to leak into a URL.
 */
export function backupArchiveUrl(id: string): string {
  return `${API_PREFIX}${BACKUP_ROUTES.download(id)}`;
}

export function fetchRecoveryCapabilities(): Promise<RecoveryCapabilitiesResponse> {
  return authedGet(RECOVERY_ROUTES.capabilities, recoveryCapabilitiesResponseSchema);
}

export function fetchRecoveries(
  query: { limit?: number; cursor?: string } = {},
): Promise<RecoveryListResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined && query.cursor !== '') params.set('cursor', query.cursor);
  const suffix = params.toString();
  return authedGet(
    suffix ? `${RECOVERY_ROUTES.list}?${suffix}` : RECOVERY_ROUTES.list,
    recoveryListResponseSchema,
  );
}

export function fetchRecovery(id: string): Promise<RecoveryDetailResponse> {
  return authedGet(RECOVERY_ROUTES.detail(id), recoveryDetailResponseSchema);
}

/**
 * Uploads an encrypted archive as a raw body.
 *
 * The `File` is handed to `fetch` directly rather than wrapped in a `FormData`:
 * the endpoint takes one file and no fields, and a multipart wrapper would mean
 * the browser buffers and re-encodes a file that may be gigabytes. A `File` IS a
 * `Blob`, so this streams.
 *
 * The declared name travels in a HEADER, and the server treats it as a label to
 * render and never as a path. Sending it at all is a convenience for an operator
 * recognising their own file.
 */
export async function uploadRecoveryArchive(file: File): Promise<RecoveryDetailResponse> {
  const response = await fetch(`${API_PREFIX}${RECOVERY_ROUTES.upload}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/octet-stream',
      accept: 'application/json',
      // `encodeURIComponent` because a header value cannot carry a newline or a
      // non-ASCII byte, and a filename can carry both. The server decodes,
      // sanitises and bounds it again — this is about the transport, not trust.
      'x-nexa-filename': encodeURIComponent(file.name),
    },
    body: file,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw toApiError(response.status, payload);
  return recoveryDetailResponseSchema.parse(payload);
}

export function verifyRecovery(id: string): Promise<RecoveryDetailResponse> {
  return post(`${RECOVERY_ROUTES.detail(id)}/verify`, {}, recoveryDetailResponseSchema);
}

export function confirmRecovery(input: {
  id: string;
  phrase: string;
  artifactChecksum: string;
  idempotencyKey: string;
}): Promise<RecoveryDetailResponse> {
  return post(
    RECOVERY_ROUTES.confirm(input.id),
    {
      phrase: input.phrase,
      artifactChecksum: input.artifactChecksum,
      idempotencyKey: input.idempotencyKey,
    },
    recoveryDetailResponseSchema,
  );
}

/**
 * One payment's refunds, and how much of it is left to give back.
 *
 * `refundableMinor` comes from the server and is not recomputed here. The browser could
 * subtract the rows it was just handed, and the figure it produced would be a second
 * opinion about money — the one an operator acts on if the two ever differed. The
 * server's is derived inside a transaction under a lock on the payment.
 *
 * `refundable: false` is a different fact from a refundable amount of zero: it means
 * this payment cannot be refunded AT ALL, because it never settled or because its
 * method has no channel in this release. A screen that conflated them would offer a
 * button for a gateway payment nobody can reverse.
 */
export function fetchRefunds(paymentId: string): Promise<RefundListResponse> {
  return authedGet(REFUND_ROUTES.list(paymentId), refundListResponseSchema);
}

/**
 * Asks for money to go back.
 *
 * The amount is a decimal string of minor units and it is a PROPOSAL. The server bounds
 * it against the CONFIRMED payment minus the refunds already consuming it, so a figure
 * this tab computed from a stale list is refused rather than honoured — with the
 * server's own remaining amount in the refusal.
 *
 * A wallet-funded payment is credited back inside the same transaction, so the refund
 * comes back COMPLETED. A manual transfer comes back AWAITING_EXTERNAL: nothing here
 * can move money through a bank, and saying otherwise is the silent success this
 * lifecycle exists to refuse.
 */
export function requestRefund(input: {
  paymentId: string;
  idempotencyKey: string;
  amountMinor: string;
  reason: string;
}): Promise<RefundResponse> {
  const { paymentId, ...body } = input;
  return post(REFUND_ROUTES.request(paymentId), { ...body, paymentId }, refundResponseSchema);
}

/** Records that the external transfer actually happened. The manual channel's second step. */
export function completeRefund(input: {
  refundId: string;
  idempotencyKey: string;
  note: string;
  externalReference: string | null;
}): Promise<RefundResponse> {
  const { refundId, ...body } = input;
  return post(REFUND_ROUTES.complete(refundId), body, refundResponseSchema);
}

/** Abandons a refund, releasing its amount back to the refundable balance. */
export function failRefund(input: {
  refundId: string;
  idempotencyKey: string;
  note: string;
}): Promise<RefundResponse> {
  const { refundId, ...body } = input;
  return post(REFUND_ROUTES.fail(refundId), body, refundResponseSchema);
}
