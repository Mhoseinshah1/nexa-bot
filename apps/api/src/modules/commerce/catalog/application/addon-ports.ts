import type {
  Money,
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
  listOfferable(
    scope: TenantContext,
    kind: ServiceAddonKind,
    limit: number,
    tx?: unknown,
  ): Promise<{ readonly items: readonly ServiceAddonRecord[]; readonly hasMore: boolean }>;
}
