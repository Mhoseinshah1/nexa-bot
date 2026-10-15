import type {
  ProviderFailureKind,
  ProviderHttpClient,
  ProviderHttpResult,
  ProviderTarget,
  ProviderUsage,
} from '@nexa/contracts';
import { RICKPANEL_USAGE, readRecordUsage } from './provider-numbers.js';
import {
  TOKEN_PATH,
  USER_PATH,
  exchangeRickpanelToken,
  outcomeFromStatus,
  outcomeFromTransport,
  parseJson,
  subscriptionFrom,
  type RickpanelTokenForm,
} from './rickpanel-protocol.js';
import {
  canonicalLegacyUsername,
  type PanelInventoryIndex,
} from '../../legacy-import/application/legacy-service-matching.js';

/**
 * Migration P5 — a READ-ONLY RickPanel inventory (`docs/rickpanel-inventory.md`).
 *
 * What migration discovery needs from a live panel: every account on it (full
 * pagination), one account by exact lowercase username, and each account's usage,
 * expiry and state. Nothing else by default — in particular never a subscription link, a
 * token or a generated proxy credential: those are secrets discovery has no use for, so
 * the accounts never carry them. The one exception is opt-in and separate: the legacy
 * importer (P7) asks for `subscriptionLinks`, and gets each account's link derived by the
 * shared `subscriptionFrom` from the SAME list row, in a map beside the accounts — no
 * extra request, and nothing an inventory report or evidence serialises.
 *
 * ## Mutation is impossible by construction
 *
 * The inventory never holds a `ProviderHttpClient` (which can `PUT`, `DELETE` and `POST`
 * anywhere) and never imports `RickpanelAdapter` (whose methods create, modify, rotate
 * and delete). It holds a `RickpanelReadOnlyHttp`: an object with exactly three methods,
 * each of which sends ONE fixed request shape — the token exchange (a `POST` the panel's
 * contract makes a read, to one constant path), `GET` the user list, and `GET` one user.
 * There is no method, path or body a caller can supply that turns any of them into a
 * write. `tests/unit/rickpanel-inventory.test.ts` asserts this on the type, on the
 * source, and on every request the fake panel receives.
 *
 * ## The list route is NOT evidenced for RickPanel (OQ-P5-01)
 *
 * The owner's `rickpanel-openapi.json` is not in this repository, and nothing that is
 * (`docs/rickpanel-adapter-audit.md`, the adapter, the fake) names a list endpoint. The
 * shape implemented is Marzban v0.8.4's documented `GET /api/users?offset=&limit=`
 * answering `{"users": [...], "total": N}` — RickPanel is Marzban-derived and every
 * other route the audit compared matches Marzban v0.8.4's names. It is an inference,
 * recorded as open, and the parser fails CLOSED on any other shape: a body that is not
 * that object is `MALFORMED_RESPONSE`, never an empty inventory. Item C1's runbook
 * (`docs/rickpanel-inventory-acceptance.md`) is what settles it against a real panel.
 */

export const USERS_LIST_PATH = 'api/users';

/** The page size requested. Small enough to stay under the client's response cap. */
export const INVENTORY_DEFAULT_PAGE_SIZE = 50;
export const INVENTORY_MAX_PAGE_SIZE = 200;
/**
 * The page size a walk actually asks for: the requested one clamped to
 * `[1, INVENTORY_MAX_PAGE_SIZE]`, or the library default when none is requested. Exported
 * so a caller can REPORT the size it walked with, from the same rule the walk applies.
 */
export function effectiveInventoryPageSize(requested?: number): number {
  return Math.min(
    Math.max(1, Math.trunc(requested ?? INVENTORY_DEFAULT_PAGE_SIZE)),
    INVENTORY_MAX_PAGE_SIZE,
  );
}
/** An absolute bound on requests, whatever the panel claims its total is. */
export const INVENTORY_DEFAULT_MAX_PAGES = 5_000;

/**
 * The only network surface the inventory has. Three fixed reads; nothing else.
 * Deliberately NOT a `ProviderHttpClient` and not assignable to one.
 */
export interface RickpanelReadOnlyHttp {
  /** `POST api/admin/token` (form). Creates a session; changes no account. */
  exchangeToken(form: RickpanelTokenForm): Promise<ProviderHttpResult>;
  /** `GET api/users?offset=&limit=`. */
  listUsersPage(bearer: string, offset: number, limit: number): Promise<ProviderHttpResult>;
  /** `GET api/user/{username}`. */
  readUser(bearer: string, username: string): Promise<ProviderHttpResult>;
}

/**
 * Narrow a full client to the three reads. The full client is captured in this closure
 * and is not reachable from the returned object.
 */
export function readOnlyRickpanelHttp(http: ProviderHttpClient): RickpanelReadOnlyHttp {
  const send = http.send.bind(http);
  return Object.freeze({
    exchangeToken: (form: RickpanelTokenForm) =>
      send({
        method: 'POST',
        effect: 'READ',
        path: TOKEN_PATH,
        body: { kind: 'form', value: form },
      }),
    listUsersPage: (bearer: string, offset: number, limit: number) =>
      send({
        method: 'GET',
        effect: 'READ',
        path: `${USERS_LIST_PATH}?offset=${String(safeCount(offset))}&limit=${String(safeCount(limit))}`,
        headers: { authorization: `Bearer ${bearer}` },
      }),
    readUser: (bearer: string, username: string) =>
      send({
        method: 'GET',
        effect: 'READ',
        path: `${USER_PATH}/${encodeURIComponent(username)}`,
        headers: { authorization: `Bearer ${bearer}` },
      }),
  });
}

function safeCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('an inventory offset or limit must be a non-negative safe integer');
  }
  return value;
}

/** What the panel's `status` says, folded into a closed set. Anything else is UNKNOWN. */
export const RICKPANEL_ACCOUNT_STATES = [
  'active',
  'disabled',
  'limited',
  'expired',
  'on_hold',
  'UNKNOWN',
] as const;
export type RickpanelAccountState = (typeof RICKPANEL_ACCOUNT_STATES)[number];

/**
 * One account as the inventory keeps it: the canonical name, the provider's EXACT
 * spelling, state, and usage — and nothing a customer could use to connect.
 */
export interface RickpanelInventoryAccount {
  /** Lowercase. The matching key (§11: canonical username = lowercase). */
  readonly username: string;
  /**
   * The name exactly as the panel spells it. Every RickPanel route addresses an account
   * by this spelling, so it is what an adoption must store (C3 constraint 3) — never the
   * lowercase key.
   */
  readonly providerUsername: string;
  /** True when the panel's own spelling was not already lowercase. */
  readonly providerSpellingDiffers: boolean;
  readonly state: RickpanelAccountState;
  /** Null when the record's usage fields are absent or malformed — never a fake zero. */
  readonly usage: ProviderUsage | null;
}

export interface RickpanelInventoryEvidence {
  readonly pages: number;
  readonly rowsFetched: number;
  /** Distinct EXACT provider spellings. Two spellings of one lowercase key are two. */
  readonly distinctUsernames: number;
  /** Rows dropped because their exact provider spelling was already seen in this walk. */
  readonly duplicateRows: number;
  /** The panel's `total` on the first page; null when the panel reports none. */
  readonly reportedTotal: number | null;
  readonly firstPageRows: number;
  readonly lastPageRows: number;
}

/** Why a pagination answer was refused. Each is a way a loop could lie or not end. */
export const INVENTORY_PAGINATION_FAULTS = [
  /** Not `{users: [...], total?: N}`. */
  'NOT_A_PAGE',
  /** More rows than the `limit` asked for. */
  'PAGE_TOO_LONG',
  /** A row that is not an object with a usable `username`. */
  'INVALID_ROW',
  /** A non-empty page whose every row was already seen: the panel ignores `offset`. */
  'NO_PROGRESS',
  /** The page bound was reached before the end. */
  'PAGE_LIMIT_EXCEEDED',
  /** `total` present on one page and absent or non-integer on another. */
  'TOTAL_INCONSISTENT',
] as const;
export type InventoryPaginationFault = (typeof INVENTORY_PAGINATION_FAULTS)[number];

export interface RickpanelInventoryFailure {
  readonly ok: false;
  readonly failure: ProviderFailureKind;
  readonly status: number | null;
  readonly pagination?: InventoryPaginationFault;
  /** `LOGIN` when the token exchange failed, before any page was asked for. */
  readonly phase?: 'LOGIN';
}

/**
 * ONE offset walk. `consistent: true` says only that this walk did not visibly contradict
 * itself — the reported total held and the distinct names add up to it. It is NOT proof
 * of coverage: a deletion before the cursor plus an append after it keeps the total and
 * the count while shifting an unseen row behind the cursor (delete A, append K: the page
 * at offset 5 starts at G, F is never returned, and the count is still 10). So a single
 * walk has no `complete` field and cannot be indexed; `listAll` is what can be.
 */
export type RickpanelInventoryWalk =
  | {
      readonly ok: true;
      readonly consistent: true;
      readonly accounts: readonly RickpanelInventoryAccount[];
      readonly evidence: RickpanelInventoryEvidence;
      /** Only when `subscriptionLinks` was asked for. */
      readonly subscriptionLinks?: RickpanelSubscriptionLinks;
      /** Only when `overlap` was asked for. */
      readonly coverage?: RickpanelWalkCoverage;
    }
  | {
      readonly ok: true;
      /** The reported total moved during the walk, or the distinct names do not add up. */
      readonly consistent: false;
      readonly reason: 'TOTAL_CHANGED' | 'COUNT_MISMATCH';
      readonly evidence: RickpanelInventoryEvidence;
      /**
       * Every account this walk DID receive. Each one is real — the panel returned it — but
       * the set is not coverage: a row the cursor slipped past is simply not here. Only a
       * per-name resolution may use it, and only as positive evidence (`listAll` ignores it).
       */
      readonly observed: readonly RickpanelInventoryAccount[];
      /** Only when `subscriptionLinks` was asked for. */
      readonly subscriptionLinks?: RickpanelSubscriptionLinks;
      /** Only when `overlap` was asked for. */
      readonly coverage?: RickpanelWalkCoverage;
    }
  | RickpanelInventoryFailure;

/** Why `listAll` refused to call an inventory complete. A closed set. */
export const INVENTORY_INCOMPLETE_REASONS = [
  'TOTAL_CHANGED',
  'COUNT_MISMATCH',
  /** Two consecutive consistent walks returned different exact username sets. */
  'WALKS_DIFFER',
] as const;
export type InventoryIncompleteReason = (typeof INVENTORY_INCOMPLETE_REASONS)[number];

/**
 * A panel's inventory as the matcher may use it: `complete: true` only when TWO
 * consecutive walks were each consistent AND returned the identical set of exact provider
 * spellings. Anything a row could have slipped past in one walk shows up as a difference
 * between the two, and an incomplete inventory makes every decision depending on it
 * UNDECIDABLE rather than `provider_missing`.
 */
export type RickpanelInventoryOutcome =
  | {
      readonly ok: true;
      readonly complete: true;
      readonly accounts: readonly RickpanelInventoryAccount[];
      readonly evidence: {
        readonly first: RickpanelInventoryEvidence;
        readonly second: RickpanelInventoryEvidence;
      };
      /** Only when `subscriptionLinks` was asked for: the SECOND walk's, like the accounts. */
      readonly subscriptionLinks?: RickpanelSubscriptionLinks;
    }
  | {
      readonly ok: true;
      readonly complete: false;
      readonly reason: InventoryIncompleteReason;
      readonly evidence: {
        readonly first: RickpanelInventoryEvidence;
        readonly second: RickpanelInventoryEvidence | null;
      };
    }
  | RickpanelInventoryFailure;

export type RickpanelAccountLookup =
  | { readonly ok: true; readonly found: false }
  | { readonly ok: true; readonly found: true; readonly account: RickpanelInventoryAccount }
  | { readonly ok: false; readonly failure: ProviderFailureKind; readonly status: number | null };

/**
 * The canonical matching username: ASCII lowercase (§11). ONE definition, shared with the
 * matcher, so the inventory's keys and the legacy rows' keys are folded the same way. A
 * name outside printable ASCII, empty or longer than 128 is null — not compared.
 */
export const canonicalUsername = canonicalLegacyUsername;

/**
 * The matcher's index for one panel — only from a COMPLETE inventory. An incomplete or
 * failed walk yields null, and the matcher answers UNDECIDABLE for anything that depends
 * on that panel rather than reading its absence as "provider missing".
 */
export function inventoryIndex(
  panelId: string,
  outcome: RickpanelInventoryOutcome,
): PanelInventoryIndex | null {
  if (!outcome.ok || !outcome.complete) return null;
  const usernames = new Map<string, string[]>();
  for (const account of outcome.accounts) {
    const spellings = usernames.get(account.username) ?? [];
    spellings.push(account.providerUsername);
    usernames.set(account.username, spellings);
  }
  for (const spellings of usernames.values()) spellings.sort();
  return { panelId, usernames };
}

function accountFrom(record: Record<string, unknown>): RickpanelInventoryAccount | null {
  const raw = record['username'];
  if (typeof raw !== 'string') return null;
  const username = canonicalUsername(raw);
  if (username === null) return null;
  const status = record['status'];
  const state: RickpanelAccountState =
    typeof status === 'string' &&
    (RICKPANEL_ACCOUNT_STATES as readonly string[]).includes(status) &&
    status !== 'UNKNOWN'
      ? (status as RickpanelAccountState)
      : 'UNKNOWN';
  const usage = readRecordUsage(record, RICKPANEL_USAGE);
  return {
    username,
    providerUsername: raw,
    providerSpellingDiffers: raw !== username,
    state,
    usage: usage.ok ? usage.usage : null,
  };
}

export interface RickpanelInventoryOptions {
  readonly pageSize?: number;
  readonly maxPages?: number;
  /**
   * Opt-in (the legacy importer only): also return each account's subscription link,
   * derived by `subscriptionFrom` from the same list row the account came from, keyed by
   * the exact provider spelling. Absent by default, so discovery never holds a link.
   */
  readonly subscriptionLinks?: boolean;
  /**
   * Opt-in (the per-name resolution only): start each page `overlap` rows before the previous
   * one ended, and report whether the walk is GAP-FREE (`RickpanelWalkCoverage`). Offset
   * pagination can only skip a row at a page boundary, when rows before the cursor are deleted
   * between two page requests; a next page that still shares a row with the previous one
   * starts at or before that row, so nothing after it was skipped. Absent: the walk is exactly
   * as before.
   */
  readonly overlap?: number;
}

/**
 * What an overlapping walk can prove about its own coverage. `gapFree`: every row carried a
 * `created_at` and the rows came oldest first (the list is the panel's insertion order — one
 * order independent of offset, verified, not assumed); every page boundary was chained (the
 * next page shared at least one row — same name AND creation time — with the previous one, in
 * the same relative order, and no row inserted ahead of the cursor went unreturned); no page
 * was longer than a learned cap or too short to overlap before the end; and the walk ended
 * exactly at the `total` the final page itself reported. Such a walk returned every account that existed throughout it and every
 * one created during it — a snapshot of the panel as of its end, but for an insertion and a
 * deletion ahead of the cursor in the same interval, which cancel out (documented).
 * `order`: the exact spellings in the order first received (to check two walks agree on one
 * stable order). Only an overlapping walk reports these.
 */
export interface RickpanelWalkCoverage {
  readonly gapFree: boolean;
  readonly order: readonly string[];
  /**
   * Gap-free is not survival: a row read early may be deleted before the walk ends. Rows of a
   * page that the next page should have repeated (after the shared row) and did not were
   * deleted after being read: `gone`. A deletion BEHIND the cursor — in insertion order nothing
   * is ever inserted there, so the shared row arriving earlier than expected counts it — could
   * have taken any row read before it, unseen: every row last seen before the last such
   * deletion is `unconfirmed`. Exact spellings, both.
   */
  readonly gone: readonly string[];
  readonly unconfirmed: readonly string[];
  /** Exact spelling → the `created_at` its row carried (a row's identity across walks). */
  readonly createdAt: ReadonlyMap<string, string>;
}

/** Exact provider spelling → the link `subscriptionFrom` derives from its row, or null. */
export type RickpanelSubscriptionLinks = ReadonlyMap<string, string | null>;

/**
 * The inventory. Stateless; every call authenticates once and discards the token.
 */
export class RickpanelInventoryReader {
  /**
   * The panel's inventory, as the matcher may use it: two consecutive walks, compared.
   *
   * `complete: true` only when both walks are consistent and their EXACT username sets
   * are identical; otherwise `complete: false` with a closed reason (see
   * `RickpanelInventoryWalk` for why one walk is never enough).
   */
  async listAll(
    target: ProviderTarget,
    http: RickpanelReadOnlyHttp,
    options: RickpanelInventoryOptions = {},
  ): Promise<RickpanelInventoryOutcome> {
    const first = await this.walk(target, http, options);
    if (!first.ok) return first;
    if (!first.consistent) {
      return {
        ok: true,
        complete: false,
        reason: first.reason,
        evidence: { first: first.evidence, second: null },
      };
    }
    const second = await this.walk(target, http, options);
    if (!second.ok) return second;
    if (!second.consistent) {
      return {
        ok: true,
        complete: false,
        reason: second.reason,
        evidence: { first: first.evidence, second: second.evidence },
      };
    }
    const a = first.accounts.map((x) => x.providerUsername);
    const b = new Set(second.accounts.map((x) => x.providerUsername));
    const same = a.length === b.size && a.every((name) => b.has(name));
    if (!same) {
      return {
        ok: true,
        complete: false,
        reason: 'WALKS_DIFFER',
        evidence: { first: first.evidence, second: second.evidence },
      };
    }
    // The SECOND walk's records: the newer reading of usage and state (and links).
    return {
      ok: true,
      complete: true,
      accounts: second.accounts,
      evidence: { first: first.evidence, second: second.evidence },
      ...(second.subscriptionLinks === undefined
        ? {}
        : { subscriptionLinks: second.subscriptionLinks }),
    };
  }

  /**
   * One offset walk over the panel's list. Never indexable on its own.
   *
   * The walk advances `offset` by the rows RECEIVED (not by the limit asked for), so a
   * panel that caps its page size below ours loses nothing. It ends on an EMPTY page, or
   * once `offset` reaches the reported total — never on a merely short page, which is
   * how a capped page size would silently drop the tail. It is bounded three ways: the
   * absolute `maxPages`, a NO_PROGRESS stop for a panel that ignores `offset`, and
   * PAGE_TOO_LONG for one that ignores `limit`.
   */
  async walk(
    target: ProviderTarget,
    http: RickpanelReadOnlyHttp,
    options: RickpanelInventoryOptions = {},
  ): Promise<RickpanelInventoryWalk> {
    const pageSize = effectiveInventoryPageSize(options.pageSize);
    const maxPages = Math.max(1, Math.trunc(options.maxPages ?? INVENTORY_DEFAULT_MAX_PAGES));

    const auth = await exchangeRickpanelToken(target, (form) => http.exchangeToken(form));
    if (!auth.ok) return { ok: false, failure: auth.failure, status: auth.status, phase: 'LOGIN' };

    const byName = new Map<string, RickpanelInventoryAccount>();
    const links = options.subscriptionLinks === true ? new Map<string, string | null>() : null;
    let offset = 0;
    let pages = 0;
    let rowsFetched = 0;
    let duplicateRows = 0;
    let firstTotal: number | null | undefined;
    let totalChanged = false;
    let firstPageRows = 0;
    let lastPageRows: number;
    // Coverage, for an overlapping walk only (see `RickpanelInventoryOptions.overlap`).
    const requested = Math.max(0, Math.trunc(options.overlap ?? 0));
    const overlapAsked = requested > 0 && requested * 2 <= pageSize ? requested : 0;
    let overlap = overlapAsked;
    const order: string[] = [];
    // The proof needs ONE order independent of offset and limit. Not assumed: every row must
    // carry `created_at`, and the rows must come oldest first (the panel's insertion order) —
    // verified row by row. A row without it, or out of order, voids the walk's proof.
    let createdOrder = true;
    // Survival (see `RickpanelWalkCoverage.gone` / `unconfirmed`).
    const lastSeenPage = new Map<string, number>();
    const createdById = new Map<string, string>();
    const gone = new Set<string>();
    let lastDeletionBehind = 0;
    let lastCreated = -Infinity;
    let previousPage: readonly string[] | null = null;
    let chained = true;
    let shortBeforeEnd = false;
    let limit = pageSize;
    let lastStep = 0;
    let endedAtTotal = false;

    const fault = (pagination: InventoryPaginationFault, status: number | null) =>
      ({ ok: false, failure: 'MALFORMED_RESPONSE', status, pagination }) as const;

    for (;;) {
      if (pages >= maxPages) return fault('PAGE_LIMIT_EXCEEDED', null);
      const answer = await http.listUsersPage(auth.token, offset, pageSize);
      pages += 1;
      if (!answer.ok) return outcomeFromTransport(answer);
      if (answer.status < 200 || answer.status >= 300) {
        const failed = outcomeFromStatus(answer.status);
        return { ok: false, failure: failed.failure, status: failed.status };
      }
      const body = parseJson(answer.bodyText);
      const rows = body?.['users'];
      if (body === null || !Array.isArray(rows)) return fault('NOT_A_PAGE', answer.status);
      if (rows.length > pageSize) return fault('PAGE_TOO_LONG', answer.status);

      const rawTotal = body['total'];
      const total =
        rawTotal === undefined || rawTotal === null
          ? null
          : typeof rawTotal === 'number' && Number.isSafeInteger(rawTotal) && rawTotal >= 0
            ? rawTotal
            : undefined;
      if (total === undefined) return fault('TOTAL_INCONSISTENT', answer.status);
      if (firstTotal === undefined) {
        firstTotal = total;
        firstPageRows = rows.length;
      } else if ((firstTotal === null) !== (total === null)) {
        return fault('TOTAL_INCONSISTENT', answer.status);
      } else if (firstTotal !== total) {
        totalChanged = true;
      }

      lastPageRows = rows.length;
      if (rows.length === 0) break;

      const pageNames: string[] = [];
      // A row's identity for chaining: its name AND its creation time, so a row deleted and
      // created again under the same name is not mistaken for the row the previous page saw.
      const pageIds: string[] = [];
      let fresh = 0;
      for (const row of rows) {
        if (typeof row !== 'object' || row === null || Array.isArray(row)) {
          return fault('INVALID_ROW', answer.status);
        }
        const account = accountFrom(row as Record<string, unknown>);
        if (account === null) return fault('INVALID_ROW', answer.status);
        rowsFetched += 1;
        pageNames.push(account.providerUsername);
        lastSeenPage.set(account.providerUsername, pages);
        gone.delete(account.providerUsername);
        const createdRaw = (row as Record<string, unknown>)['created_at'];
        if (typeof createdRaw === 'string') createdById.set(account.providerUsername, createdRaw);
        const created = typeof createdRaw === 'string' ? Date.parse(createdRaw) : Number.NaN;
        pageIds.push(
          `${account.providerUsername}\u0000${typeof createdRaw === 'string' ? createdRaw : ''}`,
        );
        // Keyed by the EXACT provider spelling: `Alice` and `alice` are two accounts on a
        // case-sensitive panel, and folding them here would hide one of them.
        if (byName.has(account.providerUsername)) {
          duplicateRows += 1;
        } else {
          byName.set(account.providerUsername, account);
          links?.set(
            account.providerUsername,
            subscriptionFrom(target.baseUrl, row as Record<string, unknown>),
          );
          order.push(account.providerUsername);
          if (Number.isNaN(created) || created < lastCreated) createdOrder = false;
          else lastCreated = created;
          fresh += 1;
        }
      }
      if (overlapAsked === 0) {
        if (fresh === 0) return fault('NO_PROGRESS', answer.status);
        offset += rows.length;
        if (total !== null && offset >= total) break;
        continue;
      }

      // An overlapping walk. A boundary is chained when this page shares a row with the
      // previous one and their common rows come in the same order.
      // A page longer than the cap the first page taught is no cap: rows were withheld.
      if (pages > 1 && rows.length > limit) chained = false;
      if (previousPage !== null) {
        const here = new Set(pageIds);
        const before = new Set(previousPage);
        const commonHere = pageIds.filter((n) => before.has(n));
        const commonBefore = previousPage.filter((n) => here.has(n));
        if (
          commonHere.length === 0 ||
          commonHere.length !== commonBefore.length ||
          commonHere.some((n, i) => n !== commonBefore[i])
        ) {
          chained = false;
        } else {
          // An insertion ahead of the cursor. The first shared row `c` moved by (insertions −
          // deletions) before it since the previous page; insertions that landed between this
          // page's start and `c` are rows of this page the previous one did not have. More
          // movement than that is an inserted row this walk skipped — possibly a case variant
          // created mid-walk — so the walk is not gap-free.
          const c = commonHere[0] as string;
          const moved = pageIds.indexOf(c) - (previousPage.indexOf(c) - lastStep);
          const freshBefore = pageIds
            .slice(0, pageIds.indexOf(c))
            .filter((n) => !before.has(n)).length;
          if (moved > freshBefore) chained = false;
          // The shared row came EARLIER than expected: rows before it were deleted since the
          // previous page — possibly rows read pages ago, which then no longer exist.
          if (moved < freshBefore) lastDeletionBehind = pages;
          // Rows of the previous page after `c` belong in this page; missing, they were deleted.
          for (const id of previousPage.slice(previousPage.indexOf(c) + 1)) {
            if (!here.has(id)) gone.add(id.slice(0, id.indexOf('\u0000')));
          }
        }
      }
      // Every row of a page is accounted for: none twice in one page, and a row the walk had
      // already received must be one of the previous page's (the overlap). A row returned again
      // anywhere else stands in a position another account should hold — an account the walk
      // never sees (reviewer F-A: a tied `ORDER BY`, or a row repeated in a variant's place).
      if (new Set(pageIds).size !== pageIds.length) chained = false;
      if (previousPage !== null) {
        const fromPrevious = new Set(previousPage);
        const seenEarlier = new Set(order.slice(0, order.length - fresh));
        for (let i = 0; i < pageIds.length; i += 1) {
          if (seenEarlier.has(pageNames[i] as string) && !fromPrevious.has(pageIds[i] as string)) {
            chained = false;
          }
        }
      }
      previousPage = pageIds;
      // The panel's own page size: a first page shorter than asked, of a longer list, is a cap
      // (or a withheld row — which a later page longer than it then shows). The overlap follows
      // the cap, so a capped panel still steps by most of a page.
      if (pages === 1 && rows.length < limit && total !== null && rows.length < total) {
        limit = rows.length;
        overlap = Math.min(overlap, Math.floor(limit / 4));
      }
      // The list ends on a page SHORTER than the limit (that one statement returned the whole
      // remainder) — never on merely reaching `total`, which the panel counts in another
      // statement and which a concurrent change can make stale within the same response.
      if (rows.length < limit) {
        endedAtTotal = total !== null && offset + rows.length === total;
        break;
      }
      if (fresh === 0) return fault('NO_PROGRESS', answer.status);
      // A cap too small to overlap cannot chain its boundaries: such a walk is never gap-free.
      const step = overlap > 0 && rows.length > overlap ? rows.length - overlap : rows.length;
      if (step === rows.length) shortBeforeEnd = true;
      offset += step;
      lastStep = step;
    }
    const coverage: RickpanelWalkCoverage | null =
      overlapAsked === 0
        ? null
        : {
            gapFree:
              firstTotal !== null &&
              firstTotal !== undefined &&
              chained &&
              endedAtTotal &&
              !shortBeforeEnd &&
              createdOrder,
            order,
            gone: [...gone],
            unconfirmed: [...lastSeenPage]
              .filter(([n, page]) => page < lastDeletionBehind && !gone.has(n))
              .map(([n]) => n),
            createdAt: createdById,
          };

    const evidence: RickpanelInventoryEvidence = {
      pages,
      rowsFetched,
      distinctUsernames: byName.size,
      duplicateRows,
      reportedTotal: firstTotal ?? null,
      firstPageRows,
      lastPageRows,
    };
    const key = (a: RickpanelInventoryAccount) => `${a.username}\u0000${a.providerUsername}`;
    const accounts = [...byName.values()].sort((a, b) =>
      key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
    );
    const inconsistent = (reason: 'TOTAL_CHANGED' | 'COUNT_MISMATCH') =>
      ({
        ok: true,
        consistent: false,
        reason,
        evidence,
        observed: accounts,
        ...(links === null ? {} : { subscriptionLinks: links }),
        ...(coverage === null ? {} : { coverage }),
      }) as const;
    if (totalChanged) return inconsistent('TOTAL_CHANGED');
    if (evidence.reportedTotal !== null && byName.size !== evidence.reportedTotal) {
      return inconsistent('COUNT_MISMATCH');
    }
    return {
      ok: true,
      consistent: true,
      accounts,
      evidence,
      ...(links === null ? {} : { subscriptionLinks: links }),
      ...(coverage === null ? {} : { coverage }),
    };
  }

  /**
   * One account by name, sent exactly as given — the provider spelling the inventory
   * recorded, or a lowercase name. The record the panel returns must fold to the same
   * canonical name, or it is not the account asked for and the answer is MALFORMED
   * rather than a match. The result carries the panel's own spelling.
   */
  async findAccount(
    target: ProviderTarget,
    http: RickpanelReadOnlyHttp,
    username: string,
  ): Promise<RickpanelAccountLookup> {
    const canonical = canonicalUsername(username);
    if (canonical === null) {
      throw new Error('findAccount takes a username the matcher can compare');
    }
    const auth = await exchangeRickpanelToken(target, (form) => http.exchangeToken(form));
    if (!auth.ok) return { ok: false, failure: auth.failure, status: auth.status };

    const read = await http.readUser(auth.token, username);
    if (!read.ok) {
      const failed = outcomeFromTransport(read);
      return { ok: false, failure: failed.failure, status: failed.status };
    }
    if (read.status === 404) return { ok: true, found: false };
    if (read.status < 200 || read.status >= 300) {
      const failed = outcomeFromStatus(read.status);
      return { ok: false, failure: failed.failure, status: failed.status };
    }
    const record = parseJson(read.bodyText);
    const account = record === null ? null : accountFrom(record);
    if (account === null || account.username !== canonical) {
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: read.status };
    }
    return { ok: true, found: true, account };
  }
}
