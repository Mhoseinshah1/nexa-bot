import {
  RESELLER_API_PREFIX,
  RESELLER_IDEMPOTENCY_HEADER,
  RESELLER_PANEL_ROUTES,
  RESELLER_SELLING_ROUTES,
  miniAppOrderSchema,
  miniAppPaymentStatusSchema,
  miniAppReceiptResponseSchema,
  miniAppServiceOfferSchema,
  miniAppTicketCategoriesResponseSchema,
  miniAppTicketDetailSchema,
  miniAppTicketsResponseSchema,
  miniAppTopupQuoteResponseSchema,
  miniAppTopupResponseSchema,
  miniAppTransferSentResponseSchema,
  miniAppWalletEntriesSchema,
  miniAppWalletPayResponseSchema,
  miniAppWalletResponseSchema,
  resellerActivityResponseSchema,
  resellerAutoRenewSchema,
  resellerCategoriesResponseSchema,
  resellerClientSchema,
  resellerClientServicesResponseSchema,
  resellerClientsResponseSchema,
  resellerCustomOfferSchema,
  resellerPlansResponseSchema,
  resellerPurchaseBatchSchema,
  resellerPurchaseQuoteSchema,
  resellerRenewAllQuoteSchema,
  resellerRenewAllResultSchema,
  resellerSendLinksResponseSchema,
  resellerServersResponseSchema,
  resellerTierProgressSchema,
  resellerTrialIssuedSchema,
  resellerTrialStatusSchema,
  resellerConnectionFilesResponseSchema,
  resellerDashboardSchema,
  resellerExchangeResponseSchema,
  resellerMeResponseSchema,
  resellerPreferencesSchema,
  resellerPricesResponseSchema,
  resellerSendResultSchema,
  resellerServiceDetailSchema,
  resellerServicesResponseSchema,
  resellerSessionsResponseSchema,
  resellerTotpEnrolResponseSchema,
  type MiniAppServiceAction,
  type MoneyWire,
  type ResellerClientWrite,
  type ResellerPurchaseQuoteRequest,
  type ResellerPreferences,
  type ResellerServiceFilter,
} from '@nexa/contracts';
import { newIdempotencyKey, toApiError } from '../api/client';

/**
 * The reseller panel's own API client (`/api/reseller/v1`, PR-4 API half).
 *
 * Same discipline as the admin client: same-origin credentials (the session is an httpOnly cookie
 * this code never sees), every answer parsed by its contract schema, every refusal an `ApiError`
 * that `errorText` renders in Persian. A state-changing request names an idempotency key in the
 * header the API reads; a retry of the SAME press reuses the key it was given.
 */
type Parser<T> = { parse: (value: unknown) => T };

function path(template: string, params: Readonly<Record<string, string | number>> = {}): string {
  return template.replace(/:([A-Za-z]+)/gu, (_, name: string) =>
    encodeURIComponent(String(params[name] ?? '')),
  );
}

async function call<T>(
  method: 'GET' | 'POST' | 'PUT',
  route: string,
  schema: Parser<T>,
  options: { body?: unknown; key?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.key !== undefined) headers[RESELLER_IDEMPOTENCY_HEADER] = options.key;
  const response = await fetch(`${RESELLER_API_PREFIX}${route}`, {
    method,
    credentials: 'same-origin',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw toApiError(response.status, payload);
  return schema.parse(payload);
}

const R = RESELLER_PANEL_ROUTES;

const okParser: Parser<{ ok: true }> = { parse: () => ({ ok: true }) };

function numberField(name: string): Parser<number> {
  return {
    parse(value) {
      const found = (value as Record<string, unknown> | null)?.[name];
      if (typeof found !== 'number') throw new Error(`Missing ${name}.`);
      return found;
    },
  };
}

const noteParser: Parser<string | null> = {
  parse(value) {
    const found = (value as Record<string, unknown> | null)?.['note'];
    return typeof found === 'string' ? found : null;
  },
};

// --- Access and security ------------------------------------------------------------------

export const exchangeLink = (token: string) =>
  call('POST', R.exchange, resellerExchangeResponseSchema, { body: { token } });
export const submitSecondFactor = (code: string) =>
  call('POST', R.secondFactor, resellerExchangeResponseSchema, { body: { code } });
export const signOutPanel = () => call('POST', R.logout, okParser);
/** The query key the signed-in reseller (`/me`) is cached under. */
export const ME_KEY = ['reseller', 'me'] as const;
export const fetchMe = () => call('GET', R.me, resellerMeResponseSchema);
export const fetchSessions = () => call('GET', R.sessions, resellerSessionsResponseSchema);
export const revokeSession = (id: string) =>
  call('POST', path(R.sessionRevoke, { sessionId: id }), okParser);
export const revokeAllSessions = () => call('POST', R.sessionsRevokeAll, numberField('ended'));
export const fetchActivity = (cursor?: string) =>
  call(
    'GET',
    `${R.activity}${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
    resellerActivityResponseSchema,
  );
export const enrolTotp = () => call('POST', R.totpEnrol, resellerTotpEnrolResponseSchema);
export const activateTotp = (code: string) =>
  call('POST', R.totpActivate, numberField('ended'), { body: { code } });
export const disableTotp = (code: string) =>
  call('POST', R.totpDisable, okParser, { body: { code } });
export const fetchPreferences = () => call('GET', R.preferences, resellerPreferencesSchema);
export const savePreferences = (patch: Partial<ResellerPreferences>) =>
  call('PUT', R.preferences, resellerPreferencesSchema, { body: patch });

// --- Dashboard and services ---------------------------------------------------------------

export const fetchDashboard = () => call('GET', R.dashboard, resellerDashboardSchema);

export function fetchServices(input: {
  filter: ResellerServiceFilter;
  q: string;
  page: number;
  clientId?: string | null;
}) {
  const query = new URLSearchParams({ filter: input.filter, page: String(input.page) });
  if (input.clientId !== undefined && input.clientId !== null) {
    query.set('clientId', input.clientId);
  }
  if (input.q.trim() !== '') query.set('q', input.q.trim());
  return call('GET', `${R.services}?${query.toString()}`, resellerServicesResponseSchema);
}
export const fetchServiceDetail = (id: string) =>
  call('GET', path(R.service, { serviceId: id }), resellerServiceDetailSchema);
export const saveServiceNote = (id: string, note: string | null) =>
  call('PUT', path(R.serviceNote, { serviceId: id }), noteParser, { body: { note } });
/**
 * `version` names the link the QR encodes, so a rotated link is a new image address rather than
 * the old picture the browser already holds; absent, the plain address.
 */
export const serviceQrUrl = (id: string, kind: string, version?: string) =>
  `${RESELLER_API_PREFIX}${path(R.serviceQr, { serviceId: id, kind })}${
    version === undefined ? '' : `?v=${encodeURIComponent(version)}`
  }`;
export const serviceFileUrl = (id: string, index: number) =>
  `${RESELLER_API_PREFIX}${path(R.serviceFile, { serviceId: id, index })}`;
export const serviceFilesZipUrl = (id: string) =>
  `${RESELLER_API_PREFIX}${path(R.serviceFilesZip, { serviceId: id })}`;
export const sendConnection = (id: string) =>
  call('POST', path(R.serviceSendConnection, { serviceId: id }), resellerSendResultSchema);
export const rotateLink = (id: string, key: string) =>
  call('POST', path(R.serviceRotateLink, { serviceId: id }), okParser, { key });
export const fetchConnectionFiles = (id: string) =>
  call('GET', path(R.serviceFiles, { serviceId: id }), resellerConnectionFilesResponseSchema);
export const sendConnectionFiles = (id: string) =>
  call('POST', path(R.serviceFilesSend, { serviceId: id }), resellerSendResultSchema);

export const fetchOffer = (id: string, kind: MiniAppServiceAction) =>
  call('GET', path(R.serviceOffer, { serviceId: id, kind }), miniAppServiceOfferSchema);
export const quoteService = (
  id: string,
  body: { kind: MiniAppServiceAction; addonId: string | null; planId: string | null },
  key: string,
) => call('POST', path(R.serviceQuote, { serviceId: id }), miniAppOrderSchema, { body, key });
export const payOrderFromWallet = (orderId: string, key: string) =>
  call('POST', path(R.orderPayWallet, { orderId }), miniAppWalletPayResponseSchema, { key });

// --- Wallet ---------------------------------------------------------------------------------

export const fetchWallet = () =>
  call('GET', R.wallet, miniAppWalletResponseSchema.omit({ giftCards: true }));
export function fetchWalletEntries(direction: 'ALL' | 'CREDIT' | 'DEBIT', cursor?: string) {
  const query = new URLSearchParams({ direction });
  if (cursor !== undefined) query.set('cursor', cursor);
  return call('GET', `${R.walletEntries}?${query.toString()}`, miniAppWalletEntriesSchema);
}
export const quoteTopup = (amount: MoneyWire) =>
  call('POST', R.walletTopupQuote, miniAppTopupQuoteResponseSchema, {
    body: { amount },
    key: newIdempotencyKey(),
  });
export const startTopup = (amount: MoneyWire, provider: string, key: string) =>
  call('POST', R.walletTopup, miniAppTopupResponseSchema, { body: { amount, provider }, key });
/** One of the reseller's own payments — re-read while a gateway attempt's invoice is made. */
export const fetchPayment = (paymentId: string) =>
  call('GET', path(R.payment, { paymentId }), miniAppPaymentStatusSchema);
export const markTransferSent = (paymentId: string, key: string) =>
  call('POST', path(R.paymentTransferSent, { paymentId }), miniAppTransferSentResponseSchema, {
    key,
  });
export const uploadReceipt = (
  paymentId: string,
  body: { imageBase64: string; mimeType: string },
  key: string,
) =>
  call('POST', path(R.paymentReceipt, { paymentId }), miniAppReceiptResponseSchema, { body, key });

// --- Prices and support ----------------------------------------------------------------------

export const fetchPrices = () => call('GET', R.prices, resellerPricesResponseSchema);
export const fetchTicketCategories = () =>
  call('GET', R.ticketCategories, miniAppTicketCategoriesResponseSchema);
export const fetchTickets = () => call('GET', R.tickets, miniAppTicketsResponseSchema);
export const fetchTicket = (id: string) =>
  call('GET', path(R.ticket, { ticketId: id }), miniAppTicketDetailSchema);
export const createTicket = (body: { categoryId: string; text: string }, key: string) =>
  call('POST', R.tickets, miniAppTicketDetailSchema, { body, key });
export const replyToTicket = (id: string, text: string, key: string) =>
  call('POST', path(R.ticketReplies, { ticketId: id }), miniAppTicketDetailSchema, {
    body: { text },
    key,
  });

// --- Buying (PR-5 §5.5) -------------------------------------------------------------------

const S = RESELLER_SELLING_ROUTES;

function withQuery(route: string, params: Readonly<Record<string, string | undefined>>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) query.set(name, value);
  }
  const text = query.toString();
  return text === '' ? route : `${route}?${text}`;
}

export const fetchCatalogueServers = (page = 0) =>
  call(
    'GET',
    withQuery(S.catalogueServers, { page: page === 0 ? undefined : String(page) }),
    resellerServersResponseSchema,
  );
export const fetchCatalogueCategories = (serverId: string | null, page = 0) =>
  call(
    'GET',
    withQuery(S.catalogueCategories, {
      serverId: serverId ?? undefined,
      page: page === 0 ? undefined : String(page),
    }),
    resellerCategoriesResponseSchema,
  );
export const fetchCataloguePlans = (categoryId: string, serverId: string | null, page = 0) =>
  call(
    'GET',
    withQuery(path(S.catalogueCategory, { categoryId }), {
      serverId: serverId ?? undefined,
      page: page === 0 ? undefined : String(page),
    }),
    resellerPlansResponseSchema,
  );
export const fetchCatalogueCustom = () => call('GET', S.catalogueCustom, resellerCustomOfferSchema);
/** The header IS the batch key: the same key re-reads the same quote. */
export const quotePurchase = (body: ResellerPurchaseQuoteRequest, key: string) =>
  call('POST', S.purchaseQuote, resellerPurchaseQuoteSchema, { body, key });
export const fetchPurchase = (batchId: string) =>
  call('GET', path(S.purchase, { batchId }), resellerPurchaseBatchSchema);
export const confirmPurchase = (batchId: string, key: string) =>
  call('POST', path(S.purchaseConfirm, { batchId }), resellerPurchaseBatchSchema, { key });
export const sendPurchaseLinks = (batchId: string) =>
  call('POST', path(S.purchaseSendLinks, { batchId }), resellerSendLinksResponseSchema);

// --- Clients book and auto-renew (PR-5 §5.6) ----------------------------------------------

export const fetchClients = (archived = false) =>
  call(
    'GET',
    withQuery(S.clients, { archived: archived ? 'true' : undefined }),
    resellerClientsResponseSchema,
  );
export const createClient = (body: ResellerClientWrite) =>
  call('POST', S.clients, resellerClientSchema, { body });
export const updateClient = (id: string, body: ResellerClientWrite) =>
  call('PUT', path(S.client, { clientId: id }), resellerClientSchema, { body });
export const archiveClient = (id: string) =>
  call('POST', path(S.clientArchive, { clientId: id }), resellerClientSchema);
export const fetchClientServices = (id: string) =>
  call('GET', path(S.clientServices, { clientId: id }), resellerClientServicesResponseSchema);
export const fetchRenewAllQuote = (id: string) =>
  call('GET', path(S.clientRenewAll, { clientId: id }), resellerRenewAllQuoteSchema);
export const renewAll = (id: string, key: string) =>
  call('POST', path(S.clientRenewAll, { clientId: id }), resellerRenewAllResultSchema, { key });
export const assignServiceClient = (serviceId: string, clientId: string | null) =>
  call('PUT', path(S.serviceClient, { serviceId }), okParser, { body: { clientId } });
export const fetchAutoRenew = (serviceId: string) =>
  call('GET', path(S.serviceAutoRenew, { serviceId }), resellerAutoRenewSchema);
export const saveAutoRenew = (
  serviceId: string,
  body: { enabled: boolean; expected: MoneyWire | null; planId: string | null },
  key: string,
) => call('PUT', path(S.serviceAutoRenew, { serviceId }), resellerAutoRenewSchema, { body, key });

// --- Trials and tier progress (PR-5 §5.7, §5.8) --------------------------------------------

export const fetchTrial = () => call('GET', S.trial, resellerTrialStatusSchema);
export const makeTrial = (key: string) => call('POST', S.trial, resellerTrialIssuedSchema, { key });
export const fetchTierProgress = () => call('GET', S.tierProgress, resellerTierProgressSchema);

export { newIdempotencyKey };
