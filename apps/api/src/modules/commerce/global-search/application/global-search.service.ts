import {
  GLOBAL_SEARCH_KINDS,
  GLOBAL_SEARCH_LIMIT_DEFAULT,
  GLOBAL_SEARCH_LIMIT_MAX,
  classifyListSearch,
  type ActorContext,
  type GlobalSearchGroup,
  type GlobalSearchHit,
  type GlobalSearchKind,
  type GlobalSearchResponse,
  type ListSearchTerm,
  type PermissionKey,
  type TenantContext,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';

/**
 * The Web Admin's global search (R11 A1): one question — "which customer, order or service is
 * this?" — asked of the three lists an operator already has.
 *
 * It adds no data access and no permission of its own. Each kind is a `GlobalSearchSource`,
 * which the composition root backs with that kind's EXISTING list service, so the tenant scope,
 * the index-bounded search and the list's own permission check are the list's, not a second
 * copy. What this service adds is the rule about WHICH kinds an actor gets:
 *
 *   - a kind is searched only when the actor holds every permission in `KIND_PERMISSIONS` —
 *     the permissions the kind's own list requires. Deny by default: a kind missing from the
 *     table is never searched;
 *   - a kind the actor may not read is ABSENT from the answer. Not an empty group and not an
 *     error, because either would tell someone who may not list orders that the search looked;
 *   - the check reads the actor's effective permissions once (`permissionsOf`), the same
 *     resolution `guard.check` uses, and the source's own `guard.check` repeats it.
 *
 * Read-only: nothing is written, so there is no idempotency key, outbox event or
 * `ScopeActivityReader` read here (a stopped scope's lists still answer reads, as they do today).
 * Bounded: `limit` hits per kind (default 5, at most 10), asked for as `limit + 1` so `hasMore` is
 * exact without a count.
 */

/** What each kind needs. The customers list needs both: it refuses a text search without the second. */
export const GLOBAL_SEARCH_KIND_PERMISSIONS: Readonly<
  Record<GlobalSearchKind, readonly PermissionKey[]>
> = {
  CUSTOMER: ['users.view', 'users.search'],
  ORDER: ['orders.view'],
  SERVICE: ['services.view'],
  // R12 F3 item 8: the payments list's and the tickets inbox's own permissions.
  PAYMENT: ['payments.view'],
  TICKET: ['tickets.view'],
};

export interface GlobalSearchSourceResult {
  readonly hits: readonly GlobalSearchHit[];
  readonly hasMore: boolean;
}

/** One kind's search: at most `limit` hits for the classified term, or `limit + 1` read internally. */
export interface GlobalSearchSource {
  search(
    scope: TenantContext,
    actor: ActorContext,
    term: ListSearchTerm,
    limit: number,
  ): Promise<GlobalSearchSourceResult>;
}

export interface GlobalSearchServiceDeps {
  readonly guard: PermissionGuard;
  readonly sources: Readonly<Record<GlobalSearchKind, GlobalSearchSource>>;
}

export class GlobalSearchService {
  constructor(private readonly deps: GlobalSearchServiceDeps) {}

  async search(
    scope: TenantContext,
    actor: ActorContext,
    query: { readonly q: string; readonly limit?: number | undefined },
  ): Promise<GlobalSearchResponse> {
    const term = classifyListSearch(query.q);
    // Whitespace is not a search: an empty answer, and no source is asked.
    if (term === null) return { groups: [] };
    const limit = Math.min(
      Math.max(Math.trunc(query.limit ?? GLOBAL_SEARCH_LIMIT_DEFAULT), 1),
      GLOBAL_SEARCH_LIMIT_MAX,
    );
    const held = await this.deps.guard.permissionsOf(scope, actor);
    const groups: GlobalSearchGroup[] = [];
    for (const kind of GLOBAL_SEARCH_KINDS) {
      const needed = GLOBAL_SEARCH_KIND_PERMISSIONS[kind];
      if (!needed.every((permission) => held.has(permission))) continue;
      const found = await this.deps.sources[kind].search(scope, actor, term, limit);
      groups.push({ kind, hits: found.hits.slice(0, limit), hasMore: found.hasMore });
    }
    return { groups };
  }
}
