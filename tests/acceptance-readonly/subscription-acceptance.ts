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

/**
 * Fields a provider write (modify, revoke_sub, reset, enable/disable) would change.
 *
 * Every property RickPanel's documented `PUT /api/user/{username}` accepts
 * (`docs/provider-capability-audit.md`: `proxies`, `expire`, `data_limit`,
 * `data_limit_reset_strategy`, `inbounds`, `note`, `on_hold_expire_duration`,
 * `on_hold_timeout`, `auto_delete_in_days`, and the three telemetry fields below), plus
 * what enable/disable (`status`) and `revoke_sub` (`sub_token`, the link fields) move,
 * and `username` itself. `RICKPANEL_DOCUMENTED_MODIFY_FIELDS` pins the documented set.
 */
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
  'auto_delete_in_days',
] as const;

/**
 * Fields the panel updates by itself when a client reads or uses the subscription. The
 * last three are also in the documented modify set, but a client's own GET moves them,
 * so a change is reported by NAME rather than failing the run.
 */
export const TELEMETRY_FIELDS = [
  'used_traffic',
  'lifetime_used_traffic',
  'sub_updated_at',
  'sub_last_user_agent',
  'online_at',
] as const;

/** RickPanel's documented `PUT /api/user/{username}` properties — the twelve. */
export const RICKPANEL_DOCUMENTED_MODIFY_FIELDS = [
  'proxies',
  'expire',
  'data_limit',
  'data_limit_reset_strategy',
  'inbounds',
  'note',
  'sub_updated_at',
  'sub_last_user_agent',
  'online_at',
  'on_hold_expire_duration',
  'on_hold_timeout',
  'auto_delete_in_days',
] as const;

/** The media types the report may name; anything else is `OTHER`, never the raw header. */
export const REPORTABLE_MEDIA_TYPES = [
  'text/plain',
  'text/html',
  'application/json',
  'application/octet-stream',
  'text/yaml',
  'text/x-yaml',
  'application/yaml',
  'application/x-yaml',
] as const;

/** The header reduced to an allowlisted media type: parameters (and anything in them) dropped. */
export function reportableMediaType(header: string | undefined): string | null {
  if (header === undefined) return null;
  const media = (header.split(';')[0] ?? '').trim().toLowerCase();
  return (REPORTABLE_MEDIA_TYPES as readonly string[]).includes(media) ? media : 'OTHER';
}

export type SubscriptionFormat =
  'BASE64_SHARE_LINKS' | 'PLAIN_SHARE_LINKS' | 'JSON_CONFIG' | 'CLASH_YAML' | 'UNRECOGNISED';

/** Share-link schemes a V2Ray-family client imports. `http(s)` is deliberately absent. */
const SHARE_LINK =
  /^(vless|vmess|trojan|ss|ssr|hysteria|hysteria2|hy2|tuic|wireguard|wg|socks|anytls):\/\//iu;

function shareLinks(text: string): number {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length > 0 && lines.every((line) => SHARE_LINK.test(line)) ? lines.length : 0;
}

/**
 * What a served body IS, without keeping or printing it: share links (plain, or base64 as
 * Marzban-lineage panels serve them — every non-empty line a known scheme), a JSON client
 * config (`outbounds`, or an array of such configs), or a Clash config (`proxies:` with
 * named entries). A login page, a WAF page or an error document is `UNRECOGNISED`.
 */
export function classifySubscription(body: string): {
  readonly format: SubscriptionFormat;
  readonly entries: number;
} {
  const trimmed = body.trim();
  if (trimmed === '') return { format: 'UNRECOGNISED', entries: 0 };

  const plain = shareLinks(trimmed);
  if (plain > 0) return { format: 'PLAIN_SHARE_LINKS', entries: plain };

  if (/^[A-Za-z0-9+/=_\-\s]+$/u.test(trimmed)) {
    const decoded = Buffer.from(
      trimmed.replace(/\s+/gu, '').replace(/-/gu, '+').replace(/_/gu, '/'),
      'base64',
    ).toString('utf8');
    const links = shareLinks(decoded);
    if (links > 0) return { format: 'BASE64_SHARE_LINKS', entries: links };
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const value: unknown = JSON.parse(trimmed);
      const outbounds = (config: unknown): number => {
        const list =
          typeof config === 'object' && config !== null && !Array.isArray(config)
            ? (config as Record<string, unknown>)['outbounds']
            : undefined;
        return Array.isArray(list) ? list.length : 0;
      };
      if (Array.isArray(value)) {
        if (value.length > 0 && value.every((config) => outbounds(config) > 0)) {
          return { format: 'JSON_CONFIG', entries: value.length };
        }
      } else if (outbounds(value) > 0) {
        return { format: 'JSON_CONFIG', entries: outbounds(value) };
      }
    } catch {
      // not JSON: falls through to UNRECOGNISED
    }
    return { format: 'UNRECOGNISED', entries: 0 };
  }

  if (/^proxies:[ \t]*$/mu.test(trimmed)) {
    const named = trimmed.match(/^[ \t]*-[ \t]+(\{[ \t]*)?name[ \t]*:/gmu)?.length ?? 0;
    if (named > 0) return { format: 'CLASH_YAML', entries: named };
  }
  return { format: 'UNRECOGNISED', entries: 0 };
}

export interface SubscriptionAcceptanceInput {
  readonly target: ProviderTarget;
  /** The client for the panel's own API. */
  readonly http: ProviderHttpClient;
  /** A client for the link's origin, which may be a separate subscription host. */
  readonly subscriptionHttp: (origin: string) => ProviderHttpClient;
  /** An account on this panel, spelled exactly as the panel spells it. */
  readonly knownUsername: string;
  /**
   * Origins besides the panel's own that the link may be fetched from — the operator's
   * explicit allowance (`NEXA_INVENTORY_SUBSCRIPTION_ORIGIN`). A link anywhere else is
   * refused without a request: a malformed record must not aim this at a private host.
   */
  readonly allowedOrigins?: readonly string[];
}

export interface SubscriptionAcceptanceReport {
  readonly recordBefore: ReadOutcome;
  readonly recordAfter: ReadOutcome;
  readonly linkPresent: boolean;
  /** Whether the link is served by the panel's configured origin (null without a link). */
  readonly linkOnPanelOrigin: boolean | null;
  readonly fetch: {
    readonly status: number | null;
    /** An allowlisted media type, `OTHER`, or null — never the header as sent. */
    readonly contentType: string | null;
    readonly bytes: number;
    /** What the served body is, and how many entries it holds — never the body. */
    readonly format: SubscriptionFormat | null;
    readonly entries: number;
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

/** `WRONG_ACCOUNT`: a 2xx record whose `username` is not the known name, exactly. */
export type ReadOutcome = 'FOUND' | 'NOT_FOUND' | 'WRONG_ACCOUNT' | 'FAILED';

type Read =
  | { readonly outcome: 'FOUND'; readonly record: Record<string, unknown> }
  | { readonly outcome: Exclude<ReadOutcome, 'FOUND'> };

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
    if (record === null) return { outcome: 'FAILED' };
    // The account asked for, in the panel's exact spelling — not a case fold of it, and
    // not whatever record a proxy or a misrouted request happened to answer with.
    if (record['username'] !== input.knownUsername) return { outcome: 'WRONG_ACCOUNT' };
    return { outcome: 'FOUND', record };
  };

  const before = await read();
  const link =
    before.outcome === 'FOUND' ? subscriptionFrom(input.target.baseUrl, before.record) : null;

  let fetch: SubscriptionAcceptanceReport['fetch'] = {
    status: null,
    contentType: null,
    bytes: 0,
    format: null,
    entries: 0,
    failure: link === null ? 'NO_LINK' : null,
  };
  const panelOrigin = new URL(input.target.baseUrl).origin;
  const allowedOrigins = new Set([
    panelOrigin,
    ...(input.allowedOrigins ?? []).map((origin) => new URL(origin).origin),
  ]);
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
    if (url !== null && !['http:', 'https:'].includes(url.protocol)) {
      fetch = { ...fetch, failure: 'LINK_NOT_HTTP' };
      url = null;
    }
    if (url !== null && !allowedOrigins.has(url.origin)) {
      linkOnPanelOrigin = false;
      fetch = { ...fetch, failure: 'ORIGIN_NOT_ALLOWED' };
      url = null;
    }
    if (url !== null) {
      linkOnPanelOrigin = url.origin === panelOrigin;
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
            contentType: reportableMediaType(answer.headers['content-type']),
            bytes: Buffer.byteLength(answer.bodyText, 'utf8'),
            ...classifySubscription(answer.bodyText),
            failure: null,
          }
        : {
            status: answer.status,
            contentType: null,
            bytes: 0,
            format: null,
            entries: 0,
            failure: answer.failure,
          };
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
    // Non-empty is not enough: a login or WAF page is a non-empty 2xx too.
    {
      name: 'the served body is a recognised subscription format',
      pass: served && fetch.format !== null && fetch.format !== 'UNRECOGNISED' && fetch.entries > 0,
    },
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
