import {
  RESELLER_API_PREFIX,
  RESELLER_IDEMPOTENCY_HEADER,
  RESELLER_PANEL_ROUTES,
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

export function fetchServices(input: { filter: ResellerServiceFilter; q: string; page: number }) {
  const query = new URLSearchParams({ filter: input.filter, page: String(input.page) });
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

export { newIdempotencyKey };
