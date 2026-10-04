import { createHash } from 'node:crypto';
import type { ProviderHttpClient, ProviderTarget } from '@nexa/contracts';
import { readOnlyRickpanelHttp } from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel-inventory';
import {
  exchangeRickpanelToken,
  parseJson,
} from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel-protocol';
import { subscriptionFrom } from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel.adapter';
import { readGuard } from './inventory-acceptance';

/**
 * Item C3 — an adopted RickPanel account stays usable with ZERO provider mutation
 * (`docs/c3-subscription-ref-rickpanel.md`, "Manual acceptance").
 *
 * For one account the operator knows is on the panel — one NEXA did not create — it:
 *
 * 1. reads the account (`GET api/user/{name}`, after the token exchange) through the SAME
 *    read-only surface the inventory holds (`readOnlyRickpanelHttp`, three fixed reads);
 * 2. takes the subscription link from that record with the adapter's own
 *    `subscriptionFrom` — the function `lookupUser` delivers with, so this is the link P6
 *    would store, not a second derivation of it;
 * 3. fetches the link ONCE with a `GET`, as the customer's client would, through a guard
 *    that refuses anything else;
 * 4. reads the account again and compares every field a provider WRITE would change.
 *
 * Nothing is printed but aggregates: whether a link was present, whether it is on the
 * panel's own origin, the fetch's status, content type and byte count, and the NAMES of
 * fields that changed. Never the username, the link, a token or a byte of the body.
 *
 * What the panel itself records about a fetch — `sub_updated_at`, `sub_last_user_agent`,
 * `online_at`, traffic counters — is telemetry any customer's client produces, reported
 * by name and not a failure: it is not a request NEXA made to change the account.
 */

/** Fields a provider write (modify, revoke_sub, reset, enable/disable) would change. */
export const WRITE_FIELDS = [
  'username',
  'status',
  'expire',
  'data_limit',
  'data_limit_reset_strategy',
  'sub_token',
  'subscription_url',
  'subscription_token',
  'links',
  'proxies',
  'inbounds',
  'note',
  'on_hold_expire_duration',
  'on_hold_timeout',
] as const;

/** Fields the panel updates by itself when a client reads or uses the subscription. */
export const TELEMETRY_FIELDS = [
  'used_traffic',
  'lifetime_used_traffic',
  'sub_updated_at',
  'sub_last_user_agent',
  'online_at',
] as const;

export interface SubscriptionAcceptanceInput {
  readonly target: ProviderTarget;
  /** The client for the panel's own API. */
  readonly http: ProviderHttpClient;
  /** A client for the link's origin, which may be a separate subscription host. */
  readonly subscriptionHttp: (origin: string) => ProviderHttpClient;
  /** An account on this panel, spelled exactly as the panel spells it. */
  readonly knownUsername: string;
}

export interface SubscriptionAcceptanceReport {
  readonly recordBefore: 'FOUND' | 'NOT_FOUND' | 'FAILED';
  readonly recordAfter: 'FOUND' | 'NOT_FOUND' | 'FAILED';
  readonly linkPresent: boolean;
  /** Whether the link is served by the panel's configured origin (null without a link). */
  readonly linkOnPanelOrigin: boolean | null;
  readonly fetch: {
    readonly status: number | null;
    readonly contentType: string | null;
    readonly bytes: number;
    readonly failure: string | null;
  };
  /** NAMES of write-relevant fields that differ between the two reads. Must be empty. */
  readonly changedWriteFields: readonly string[];
  /** NAMES of telemetry fields that differ — informational. */
  readonly changedTelemetryFields: readonly string[];
  readonly refusedWrites: number;
  readonly requests: number;
  readonly checks: readonly { readonly name: string; readonly pass: boolean }[];
}

type Read =
  | { readonly outcome: 'FOUND'; readonly record: Record<string, unknown> }
  | { readonly outcome: 'NOT_FOUND' | 'FAILED' };

/** A value's identity, never the value: compared, never printed. */
function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex');
}

function changed(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[],
): string[] {
  return fields.filter((field) => digest(before[field]) !== digest(after[field]));
}

export async function runSubscriptionAcceptance(
  input: SubscriptionAcceptanceInput,
): Promise<SubscriptionAcceptanceReport> {
  const panelGuard = readGuard(input.http);
  const http = readOnlyRickpanelHttp(panelGuard.client);

  const read = async (): Promise<Read> => {
    const auth = await exchangeRickpanelToken(input.target, (form) => http.exchangeToken(form));
    if (!auth.ok) return { outcome: 'FAILED' };
    const answer = await http.readUser(auth.token, input.knownUsername);
    if (!answer.ok) return { outcome: 'FAILED' };
    if (answer.status === 404) return { outcome: 'NOT_FOUND' };
    if (answer.status < 200 || answer.status >= 300) return { outcome: 'FAILED' };
    const record = parseJson(answer.bodyText);
    return record === null ? { outcome: 'FAILED' } : { outcome: 'FOUND', record };
  };

  const before = await read();
  const link =
    before.outcome === 'FOUND' ? subscriptionFrom(input.target.baseUrl, before.record) : null;

  let fetch: SubscriptionAcceptanceReport['fetch'] = {
    status: null,
    contentType: null,
    bytes: 0,
    failure: link === null ? 'NO_LINK' : null,
  };
  let linkOnPanelOrigin: boolean | null = null;
  let subscriptionRefused = 0;
  let subscriptionSent = 0;
  if (link !== null) {
    let url: URL | null = null;
    try {
      url = new URL(link);
    } catch {
      fetch = { ...fetch, failure: 'LINK_NOT_A_URL' };
    }
    if (url !== null) {
      linkOnPanelOrigin = url.origin === new URL(input.target.baseUrl).origin;
      const guard = readGuard(input.subscriptionHttp(url.origin));
      const answer = await guard.client.send({
        method: 'GET',
        effect: 'READ',
        path: `${url.pathname.replace(/^\/+/u, '')}${url.search}`,
      });
      subscriptionRefused = guard.refused();
      subscriptionSent = guard.sent();
      fetch = answer.ok
        ? {
            status: answer.status,
            contentType: answer.headers['content-type'] ?? null,
            bytes: Buffer.byteLength(answer.bodyText, 'utf8'),
            failure: null,
          }
        : { status: answer.status, contentType: null, bytes: 0, failure: answer.failure };
    }
  }

  const after = await read();
  const both = before.outcome === 'FOUND' && after.outcome === 'FOUND';
  const changedWriteFields = both ? changed(before.record, after.record, WRITE_FIELDS) : [];
  const changedTelemetryFields = both ? changed(before.record, after.record, TELEMETRY_FIELDS) : [];
  const refusedWrites = panelGuard.refused() + subscriptionRefused;
  const status = fetch.status;
  const served = status !== null && status >= 200 && status < 300;

  const checks = [
    { name: 'known account read by GET', pass: before.outcome === 'FOUND' },
    { name: "the panel's record carries a subscription link", pass: link !== null },
    { name: 'the subscription link answers 2xx to a GET', pass: served },
    // An error page has bytes too: only a served (2xx) body counts as a subscription.
    { name: 'the subscription body is non-empty', pass: served && fetch.bytes > 0 },
    { name: 'the account reads the same afterwards', pass: both },
    { name: 'no write-relevant field changed', pass: both && changedWriteFields.length === 0 },
    { name: 'no write was attempted', pass: refusedWrites === 0 },
  ];

  return {
    recordBefore: before.outcome,
    recordAfter: after.outcome,
    linkPresent: link !== null,
    linkOnPanelOrigin,
    fetch,
    changedWriteFields,
    changedTelemetryFields,
    refusedWrites,
    requests: panelGuard.sent() + subscriptionSent,
    checks,
  };
}
