import type {
  CurrencyCode,
  Money,
  PanelId,
  ProductId,
  ServiceAddonId,
  ServiceAddonKind,
  ServiceAddonSpecification,
  ServiceAddonStatus,
  TenantContext,
} from '@nexa/contracts';

/**
 * A configured add-on as the application layer sees it.
 *
 * It lives in the `catalog` module beside products, and under the same
 * `catalog.view` / `catalog.edit` permissions, because it is the same KIND of thing: a
 * priced offer an operator curates. Giving it its own permission pair would have meant
 * a contracts change, a migration backfilling grants into every existing role, and an
 * operator who can edit the catalogue discovering they cannot edit half of it.
 *
 * It is a SEPARATE file from `ports.ts` rather than more exports in one, because the
 * two have no type in common and nothing here should be reachable by autocomplete from
 * a product.
 */
export interface ServiceAddonRecord {
  readonly id: ServiceAddonId;
  readonly kind: ServiceAddonKind;
  readonly title: string;
  readonly status: ServiceAddonStatus;
  readonly sortOrder: number;
  /**
   * What the customer gets, as the union its kind decides between.
   *
   * `serviceAddonAmountMatchesKind` is the rule, `service_addons_amount_matches_kind`
   * is the same rule in the database, and both assert the amount is POSITIVE. Zero
   * would read as `UNLIMITED_TRAFFIC_BYTES`, which is what it means on a product — and
   * an unlimited amount is not something that can be added to an allowance.
   */
  readonly specification: ServiceAddonSpecification;
  /**
   * One nullable value, not two nullable columns. The products rule, for the reason
   * `ProductRecord.price` gives: a null price means unsellable, never free.
   */
  readonly price: Money | null;
  /**
   * WP-A5, `ADD_DEVICES` only: the panel and / or product this per-device rate applies
   * to. Null is "every"; `service_addons_scope_kind_check` keeps both null on the two
   * package kinds.
   */
  readonly panelId: PanelId | null;
  readonly productId: ProductId | null;
  /** Bumped on every edit; a device purchase snapshots the version it was priced from. */
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The admin list's cursor: the immutable `(createdAt, id)`, never `sortOrder`. */
export interface ServiceAddonCursor {
  readonly createdAt: string;
  readonly id: ServiceAddonId;
}

export interface ServiceAddonPage {
  readonly items: readonly ServiceAddonRecord[];
  readonly nextCursor: ServiceAddonCursor | null;
}

export interface ServiceAddonSearch {
  readonly kind?: ServiceAddonKind;
  readonly status?: ServiceAddonStatus;
}

/**
 * The fields an operator may set.
 *
 * `status` is absent for the reason it is absent from `ProductDraft`: the column
 * defaults to `INACTIVE` and an add-on becomes purchasable through its own state
 * change, so one call cannot publish an unpriced one.
 */
export interface ServiceAddonDraft {
  readonly kind: ServiceAddonKind;
  readonly title: string;
  readonly sortOrder: number;
  readonly specification: ServiceAddonSpecification;
  readonly price: Money | null;
  /** WP-A5, `ADD_DEVICES` only. Absent or null is "every panel" / "every product". */
  readonly panelId?: PanelId | null;
  readonly productId?: ProductId | null;
}

/**
 * What an edit may change — everything except the KIND.
 *
 * Changing an `ADD_TRAFFIC` into an `ADD_TIME` would leave every
 * `service_commercial_actions` row that already named it describing a quantity in the
 * wrong unit, and those rows are append-only evidence: there is no correcting them
 * afterwards. An operator who wants the other kind creates one and withdraws this.
 */
export type ServiceAddonEdit = Omit<ServiceAddonDraft, 'kind'>;

/** WP-A8: the largest single package a panel admits; null for no cap on that axis. */
export interface AddonCap {
  readonly maxTrafficBytes: bigint | null;
  readonly maxDurationDays: number | null;
}

export interface ServiceAddonRepository {
  create(
    scope: TenantContext,
    input: { readonly id: ServiceAddonId; readonly draft: ServiceAddonDraft; readonly now: Date },
    tx?: unknown,
  ): Promise<ServiceAddonRecord>;

  findById(
    scope: TenantContext,
    id: ServiceAddonId,
    tx?: unknown,
  ): Promise<ServiceAddonRecord | null>;

  list(
    scope: TenantContext,
    search: ServiceAddonSearch,
    limit: number,
    cursor: ServiceAddonCursor | null,
    tx?: unknown,
  ): Promise<ServiceAddonPage>;

  /** Null when the id names no add-on in this tenant. The kind is never changed. */
  update(
    scope: TenantContext,
    id: ServiceAddonId,
    edit: ServiceAddonEdit,
    now: Date,
    tx?: unknown,
  ): Promise<ServiceAddonRecord | null>;

  /** A conditional `UPDATE … WHERE status = from`. `false` is a successful no-op. */
  setStatus(
    scope: TenantContext,
    id: ServiceAddonId,
    from: ServiceAddonStatus,
    to: ServiceAddonStatus,
    now: Date,
    tx?: unknown,
  ): Promise<boolean>;

  /**
   * What a customer may actually buy, of one kind: ACTIVE and priced.
   *
   * A BOUNDED page in `sortOrder` order rather than a traversal, exactly as
   * `listCatalog` is and for the same reason — `sort_order` is mutable and a keyset
   * over it can skip a row an operator re-ordered mid-browse. The predicates are
   * applied in SQL so an unpriced add-on never leaves the database: `catalog.ts` is
   * explicit that an absent price means unsellable, and a surface that received one
   * would have to decide what to render beside it.
   */
  /**
   * The packages of one kind a customer could actually be sold, right now.
   *
   * `currency` is REQUIRED rather than optional, and it is the tenant's `sales.currency`
   * read where this is called. An add-on is refused at create unless it is priced in
   * that currency, and the setting can move afterwards while the row keeps the currency
   * it was stored with — deliberately, because reinterpreting a stored amount under a
   * new unit is the factor of ten the setting exists to prevent.
   *
   * So a store that has moved to Rial still has Toman-priced rows, and listing them
   * draws buttons whose tap `quoteAddon` refuses. Filtering HERE is what makes the
   * offer and the purchase agree; `quoteAddon`'s own check stays, because a callback
   * outlives the message it was drawn on.
   */
  listOfferable(
    scope: TenantContext,
    kind: ServiceAddonKind,
    currency: CurrencyCode,
    limit: number,
    /**
     * WP-A8: a panel's per-purchase cap, applied IN the query, before the limit. Filtering
     * a first page afterwards reported "nothing offered" whenever that page was all over
     * the cap while a later package fitted. Absent or null means no cap.
     */
    within?: AddonCap,
    tx?: unknown,
  ): Promise<{ readonly items: readonly ServiceAddonRecord[]; readonly hasMore: boolean }>;

  /**
   * The ONE per-device rate that applies to a service (WP-A5), or null.
   *
   * ACTIVE, priced, in the tenant's selling currency, and scoped to this service's panel
   * and product or to neither — the most specific wins: a product match over a panel
   * match over a tenant-wide row, then the operator's sort order. One rate per service
   * rather than a list, because its `maxQuantity` is a cap on the SERVICE, and two rates
   * offered side by side would be two caps with no answer to which one holds.
   */
  deviceRateFor(
    scope: TenantContext,
    service: { readonly panelId: string; readonly productId: string | null },
    currency: CurrencyCode,
    tx?: unknown,
  ): Promise<ServiceAddonRecord | null>;
}
