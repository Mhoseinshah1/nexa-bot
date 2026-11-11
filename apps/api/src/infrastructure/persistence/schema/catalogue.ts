/**
 * Database schema — catalogue: categories, products, add-ons, client apps, delivery tutorials.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import {
  CURRENCY_CODES,
  PRODUCT_DESCRIPTION_CAPTURE_CLOSE_REASONS,
  PRODUCT_DESCRIPTION_MAX_LENGTH,
  PRODUCT_SORT_MAX,
  PRODUCT_SORT_MIN,
  PRODUCT_CATEGORY_EMOJI_MAX_CODE_POINTS,
  PRODUCT_CATEGORY_NAME_MAX_LENGTH,
  PRODUCT_CATEGORY_STATUSES,
  PRODUCT_CATEGORY_VISIBILITIES,
  PROVIDER_TYPES,
  PRODUCT_STATUSES,
  PRODUCT_AUDIENCES,
  SERVICE_ADDON_KINDS,
  SERVICE_ADDON_STATUSES,
  DELIVERY_TUTORIAL_MODES,
  DELIVERY_TUTORIAL_TEXT_MAX_LENGTH,
  PRODUCT_SERVICE_LOCATION_LABEL_MAX_LENGTH,
  CLIENT_APP_DELIVERY_KINDS,
  CLIENT_APP_DESCRIPTION_MAX_LENGTH,
  CLIENT_APP_GUIDE_MAX_LENGTH,
  CLIENT_APP_ICON_MAX_LENGTH,
  CLIENT_APP_IMAGE_MAX_BYTES,
  CLIENT_APP_IMAGE_MAX_SIDE,
  CLIENT_APP_IMAGE_MIME_TYPES,
  CLIENT_APP_IMAGE_MIN_SIDE,
  CLIENT_APP_NAME_MAX_LENGTH,
  CLIENT_APP_PLATFORMS,
  CLIENT_APP_VIDEO_FILE_ID_MAX_LENGTH,
  CLIENT_APP_VIDEO_FILE_UNIQUE_ID_MAX_LENGTH,
  CLIENT_APP_PROTOCOLS,
  CLIENT_APP_SORT_MAX,
  CLIENT_APP_SORT_MIN,
  CLIENT_APP_STATUSES,
  CLIENT_APP_URL_MAX_LENGTH,
} from '@nexa/contracts';
import {
  ENUM_LITERAL,
  bytea,
  enumCheck,
  nullableEnumCheck,
  recordSourceChecks,
  recordSourceColumns,
  timestamptz,
} from './_shared.js';
import { botInstances, tenants } from './tenancy.js';
import { admins } from './identity.js';
import { panels } from './panels.js';

/**
 * A product — one sellable plan.
 *
 * `price_amount` and `price_currency` are NULLABLE together, and that is the
 * "do not invent a value" rule expressed in DDL: a tenant that has not priced a plan
 * has an unpriced plan, not a free one. `PRODUCT_NOT_PRICED` is the refusal, and it
 * fires at order confirmation where an operator can read it.
 *
 * `panel_id` is nullable for the same reason: a product an operator is still
 * configuring cannot be fulfilled, and the honest encoding of that is an absent
 * panel rather than a pointer to an arbitrary one.
 */
/**
 * A group a customer browses before they browse products.
 *
 * Tenant-scoped like everything a tenant owns, and it carries the same two dimensions a
 * product does — `status` and `visibility` — for the reason `catalog.ts` gives: a
 * category with its own vocabulary would be a second way to say "stop selling this",
 * and two vocabularies for one idea disagree the first time somebody edits only one.
 *
 * `emoji` is nullable and ordinary when absent. It is short text with a CHECK that
 * bounds its length and refuses control characters, and deliberately no check that it
 * IS an emoji — `isValidCategoryEmoji` says why, and the short version is that the
 * stronger check is an icon library wearing a regex.
 *
 * There is no `is_empty` column and no product counter. An empty category is one with no
 * customer-visible product in it, which is a property of the products, and a cached
 * count is a second answer to that question that goes stale the moment a product is
 * deactivated. `nexa-conventions` has the same rule about balances for the same reason.
 */
/**
 * The control characters a rendered label may not contain, as a PostgreSQL regex.
 *
 * Built from code points rather than written as a literal, because writing the class
 * inline in a template literal is how the first version of this constraint shipped
 * broken: TypeScript interpreted the `\u` escapes and `drizzle-kit` wrote the resulting
 * RAW CONTROL CHARACTERS into the migration file, producing a constraint no reviewer
 * could read and a `.sql` file carrying a literal DEL byte. Caught by reading the
 * generated SQL, which is the artifact under review.
 *
 * `U&'...'` is PostgreSQL's Unicode string literal syntax, so the escapes are resolved
 * by the SERVER from text that stays ASCII all the way through the file.
 *
 * NUL is deliberately absent: PostgreSQL `text` cannot hold one at all, so a term for it
 * would be a check against a value the type system already refuses.
 */
const CONTROL_CHARACTER_CLASS = String.raw`U&'[\0001-\001f\007f\0085\2028\2029]'`;

export const productCategories = pgTable(
  'product_categories',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    description: text('description'),
    /** Optional. Absence is ordinary, never an error. */
    emoji: text('emoji'),
    status: text('status').notNull().default('ACTIVE'),
    visibility: text('visibility').notNull().default('VISIBLE'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /**
     * The customer's order, and it matches the ORDER BY exactly.
     *
     * `(tenant, sort_order, id)` rather than `(tenant, sort_order, created_at, id)`,
     * because the owner specified `sort_order ASC, id ASC` for the paged customer
     * surfaces and an index whose columns are a superset still leaves the planner
     * sorting on `id` within each `sort_order` group. Added by 0098 for that reason;
     * 0097 shipped the four-column shape, which was right for the ordering assumed
     * before the paging decision and wrong for the one specified after it.
     */
    index('product_categories_tenant_sort_id_idx').on(table.tenantId, table.sortOrder, table.id),
    /** The admin list's keyset, on the IMMUTABLE pair. Migration 0026's lesson. */
    index('product_categories_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    check('product_categories_status_check', enumCheck('status', PRODUCT_CATEGORY_STATUSES)),
    check(
      'product_categories_visibility_check',
      enumCheck('visibility', PRODUCT_CATEGORY_VISIBILITIES),
    ),
    check(
      'product_categories_name_check',
      sql`length(name) > 0 AND length(name) <= ${sql.raw(String(PRODUCT_CATEGORY_NAME_MAX_LENGTH))}`,
    ),
    /*
     * The emoji's shape, at the database.
     *
     * Bounded in CHARACTERS, which is what PostgreSQL's `length()` counts for `text` —
     * code points, not UTF-16 units — so this is the same measure
     * `isValidCategoryEmoji` uses and the two cannot disagree about a family emoji.
     *
     * The control-character term is the one that matters for a surface: this value is
     * rendered into a Telegram inline-keyboard label, and a newline there is a broken
     * button. `~` with a character class is refused rather than accepted, so a row
     * carrying one cannot be written at all.
     */
    check(
      'product_categories_emoji_check',
      sql`emoji IS NULL OR (
        length(emoji) > 0
        AND length(emoji) <= ${sql.raw(String(PRODUCT_CATEGORY_EMOJI_MAX_CODE_POINTS))}
        AND btrim(emoji) <> ''
        AND emoji !~ ${sql.raw(CONTROL_CHARACTER_CLASS)}
      )`,
    ),
    check(
      'product_categories_sort_check',
      sql`sort_order >= ${sql.raw(String(PRODUCT_SORT_MIN))} AND sort_order <= ${sql.raw(String(PRODUCT_SORT_MAX))}`,
    ),
    /** What a composite foreign key from `products` needs to point at. */
    unique('product_categories_tenant_id_key').on(table.tenantId, table.id),
  ],
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull().default('INACTIVE'),
    audience: text('audience').notNull().default('EVERYONE'),
    sortOrder: integer('sort_order').notNull().default(0),
    /**
     * Where a purchase of this plan is fulfilled. Null until configured.
     *
     * The single-column reference is KEPT alongside the composite one below, and that
     * is not an oversight. It is implied by `products_tenant_panel_fk` and therefore
     * redundant — but 0032 shipped it, and `migration-compatibility.test.ts` requires
     * every dropped constraint to be re-added by the same file: a migration that
     * removed it would take a constraint away from the release still running during a
     * rolling update. Expand only.
     */
    panelId: uuid('panel_id').references(() => panels.id),
    /**
     * The category a customer browses this product under.
     *
     * NULLABLE at the database, and that is not the same as "optional to the product".
     * Migration 0097 creates one category per tenant that has products and backfills
     * every row, so no product reaches a customer uncategorised. The column stays
     * nullable for two reasons: a NOT NULL on this table is a rewrite-and-lock during a
     * rolling update, and the release still running during that update writes products
     * without the column at all — expand only.
     *
     * The foreign key is `ON DELETE NO ACTION`, deliberately, and that is what makes
     * "a category holding products cannot be deleted" true at the DATABASE rather than
     * only in a service. `SET NULL` was considered and is worse: it would let the
     * delete succeed and silently strand every product in it uncategorised, which is
     * the shape where an operator's tidy-up empties a shop.
     *
     * The application refuses to sell a product with no category. The database's job
     * here is to stop the pointer being wrong, not to decide the sale.
     */
    categoryId: uuid('category_id'),
    /** 0 means no time limit (`UNLIMITED_DURATION_DAYS`). */
    durationDays: integer('duration_days').notNull(),
    /** 0 means no traffic limit (`UNLIMITED_TRAFFIC_BYTES`). Bytes, never gigabytes. */
    trafficBytes: bigint('traffic_bytes', { mode: 'bigint' }).notNull(),
    /** Null means "the provider's default", which is not the same as a cap of zero. */
    deviceLimit: integer('device_limit'),
    priceAmount: bigint('price_amount', { mode: 'bigint' }),
    priceCurrency: text('price_currency'),
    /**
     * Customer-facing DISPLAY data (customer UX completion §C): ordered strings the
     * pre-invoice and the cards render as written. Marketing copy, not routing — the
     * provisioner reads `panel_id` and never these. JSON arrays of strings, bounded at
     * the contract; `'[]'` is the default every existing row takes, which the screens
     * render as no section rather than an empty one.
     */
    displayLocations: jsonb('display_locations')
      .notNull()
      .default(sql`'[]'::jsonb`),
    displayFeatures: jsonb('display_features')
      .notNull()
      .default(sql`'[]'::jsonb`),
    serviceLocationLabel: text('service_location_label'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    ...recordSourceColumns(),
    /**
     * The per-tenant product number behind `P-102` (Round 4, PR-C; `productCode`). Assigned at
     * INSERT by `nexa_assign_product_code` under a per-tenant advisory lock, backfilled for every
     * product that existed before, and never changed afterwards.
     */
    codeNumber: integer('code_number'),
  },
  (table) => [
    ...recordSourceChecks('products', table),
    check('products_code_number_check', sql`code_number IS NULL OR code_number > 0`),
    // `products_tenant_code_number_key` is built online (`online-indexes.ts`).
    index('products_tenant_status_idx').on(table.tenantId, table.status),
    /** The catalogue's order, and the list's keyset: sort, then created, then id. */
    index('products_tenant_sort_idx').on(
      table.tenantId,
      table.sortOrder,
      table.createdAt,
      table.id,
    ),
    check('products_status_check', enumCheck('status', PRODUCT_STATUSES)),
    check('products_audience_check', enumCheck('audience', PRODUCT_AUDIENCES)),
    check('products_price_currency_check', nullableEnumCheck('price_currency', CURRENCY_CODES)),
    /**
     * A price is an amount AND a currency, or it is absent.
     *
     * Half a price is the shape that makes a total meaningless, and it is exactly what
     * an interrupted edit or a partial import leaves behind.
     */
    check('products_price_pair_check', sql`(price_amount IS NULL) = (price_currency IS NULL)`),
    check('products_price_positive_check', sql`price_amount IS NULL OR price_amount > 0`),
    check('products_duration_check', sql`duration_days >= 0 AND duration_days <= 3650`),
    check('products_traffic_check', sql`traffic_bytes >= 0`),
    check('products_device_limit_check', sql`device_limit IS NULL OR device_limit > 0`),
    check(
      'products_display_lists_check',
      sql`jsonb_typeof(display_locations) = 'array' AND jsonb_typeof(display_features) = 'array'`,
    ),
    check(
      'products_service_location_label_check',
      sql`service_location_label IS NULL OR length(btrim(service_location_label)) BETWEEN 1 AND ${sql.raw(String(PRODUCT_SERVICE_LOCATION_LABEL_MAX_LENGTH))}`,
    ),
    /**
     * The pair, not the two halves. The same defect 0018 fixed for panel children.
     *
     * `panel_id` alone referenced `panels(id)`, which constrained it to SOME panel in
     * the installation and said nothing about it being THIS tenant's. A product could
     * therefore name another tenant's panel, and every downstream reader — the
     * catalogue's fulfillable predicate, the order snapshot, and eventually the
     * provisioning call that dials it — would have believed the pointer.
     *
     * MATCH SIMPLE is what makes this work with a nullable column: a composite foreign
     * key is not enforced when any of its columns is NULL, so an unconfigured product
     * (`panel_id IS NULL`) is still legal, exactly as `payments_order_fk` above.
     */
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'products_tenant_panel_fk',
    }),
    /**
     * The pair again, for the same reason `products_tenant_panel_fk` is a pair: a
     * single-column reference would let a product name ANOTHER TENANT'S category, and
     * every reader downstream — the catalogue's grouping, the order snapshot — would
     * have believed it. MATCH SIMPLE means a NULL `category_id` is still legal.
     */
    foreignKey({
      columns: [table.tenantId, table.categoryId],
      foreignColumns: [productCategories.tenantId, productCategories.id],
      name: 'products_tenant_category_fk',
    }),
    /**
     * The customer's page within one category, matching `sort_order ASC, id ASC`.
     *
     * Every predicate the paged query applies is either in this index's leading
     * columns or cheap on the rows it returns — the point being that the LIMIT applies
     * to rows already filtered, never to rows a surface filters afterwards. §1.4 of
     * `docs/wp5-categories-audit.md` is the failure this shape exists to prevent.
     */
    index('products_tenant_category_sort_id_idx').on(
      table.tenantId,
      table.categoryId,
      table.sortOrder,
      table.id,
    ),
    unique('products_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * A configured quantity a customer can buy for a service they already own.
 *
 * Not a product: a product is provisioned into a new account, and one of these is
 * applied to an account that exists. They share almost no columns for that reason —
 * there is no panel, no audience, no device limit and no description, because none of
 * them means anything about a quantity added to something already running.
 *
 * ## Why rows rather than a per-unit rate
 *
 * The legacy system prices these per unit, per panel, and takes a free-text quantity
 * (`TBR-009`, `PBR-009`). This bot has no FSM and no conversation state — the rule with
 * `INCIDENT-FIN-001` behind it, where the legacy prompt capture swallowed an ordinary
 * message and overwrote a production gateway setting — so there is nowhere for a typed
 * number to arrive, and a callback carries an intent and an identifier rather than a
 * quantity. The amounts a customer may buy therefore have to be rows they select.
 * `OQ-4F-05` records that as a deliberate divergence and what would have to exist for
 * the per-unit form to come back.
 *
 * ## The two amount columns are a union
 *
 * `kind` decides which one means anything, and `service_addons_amount_matches_kind`
 * makes the other one NULL rather than zero. Zero would be readable as
 * `UNLIMITED_TRAFFIC_BYTES`, which is what it means on a product, and an unlimited
 * amount is not a thing that can be ADDED to an allowance.
 */
export const serviceAddons = pgTable(
  'service_addons',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull().default('INACTIVE'),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Bytes added to the allowance. Set for `ADD_TRAFFIC`, NULL otherwise. */
    trafficBytes: bigint('traffic_bytes', { mode: 'bigint' }),
    /** Days added to the window. Set for `ADD_TIME`, NULL otherwise. */
    durationDays: integer('duration_days'),
    /**
     * WP-A5, `ADD_DEVICES` only: the most extra users / devices ONE service may be sold
     * through this add-on in total, counted from its live purchases at read time. For that
     * kind `price_amount` is the price of ONE, and the customer chooses how many.
     */
    maxQuantity: integer('max_quantity'),
    /**
     * WP-A5, `ADD_DEVICES` only: the panel and / or product the rate applies to. NULL is
     * "every", never "none"; the most specific ACTIVE row wins for a service. Both are
     * forbidden on the two package kinds, which apply tenant-wide.
     */
    panelId: uuid('panel_id'),
    productId: uuid('product_id'),
    /**
     * Bumped on every edit. A purchase copies the version it was priced from onto its
     * commercial action, so "which rule, as it read then" is answerable after the row
     * has been re-priced — the rule id AND version the brief requires on the snapshot.
     */
    version: integer('version').notNull().default(1),
    priceAmount: bigint('price_amount', { mode: 'bigint' }),
    priceCurrency: text('price_currency'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'service_addons_panel_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'service_addons_product_fk',
    }),
    index('service_addons_tenant_status_idx').on(table.tenantId, table.status),
    /** The operator's list, and its keyset: kind, then sort, then created, then id. */
    index('service_addons_tenant_sort_idx').on(
      table.tenantId,
      table.kind,
      table.sortOrder,
      table.createdAt,
      table.id,
    ),
    check('service_addons_kind_check', enumCheck('kind', SERVICE_ADDON_KINDS)),
    check('service_addons_status_check', enumCheck('status', SERVICE_ADDON_STATUSES)),
    check(
      'service_addons_price_currency_check',
      nullableEnumCheck('price_currency', CURRENCY_CODES),
    ),
    /** A price is an amount AND a currency, or it is absent. The products rule. */
    check(
      'service_addons_price_pair_check',
      sql`(price_amount IS NULL) = (price_currency IS NULL)`,
    ),
    check('service_addons_price_positive_check', sql`price_amount IS NULL OR price_amount > 0`),
    /**
     * The union, as a constraint rather than as application discipline.
     *
     * An `ADD_TRAFFIC` row whose bytes sit in `duration_days` would be sold for a
     * quantity of nothing, and the surface reading it would show a plausible price
     * beside an amount it could not find. Both halves are asserted — the field the kind
     * reads is positive, and the other is NULL — so neither a swap nor a stray write can
     * produce one.
     */
    check(
      'service_addons_amount_matches_kind',
      sql`(kind = 'ADD_TRAFFIC' AND traffic_bytes IS NOT NULL AND traffic_bytes > 0 AND duration_days IS NULL AND max_quantity IS NULL)
          OR (kind = 'ADD_TIME' AND duration_days IS NOT NULL AND duration_days > 0 AND traffic_bytes IS NULL AND max_quantity IS NULL)
          OR (kind = 'ADD_DEVICES' AND max_quantity IS NOT NULL AND max_quantity >= 1 AND max_quantity <= 20 AND traffic_bytes IS NULL AND duration_days IS NULL)`,
    ),
    /** Only the per-device rate is scoped; the two packages apply tenant-wide (WP-A5). */
    check(
      'service_addons_scope_kind_check',
      sql`kind = 'ADD_DEVICES' OR (panel_id IS NULL AND product_id IS NULL)`,
    ),
    check('service_addons_version_check', sql`version >= 1`),
    check(
      'service_addons_duration_bound_check',
      sql`duration_days IS NULL OR duration_days <= 3650`,
    ),
    unique('service_addons_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * Phase 2 item 5: the OPTIONAL tutorial a panel sends a customer once, automatically, right
 * after a service on it was delivered (`DeliveryTutorialSender`). One row per configured
 * panel; no row is the same as `DISABLED`.
 *
 * Its own table, never `panels.policy`: that jsonb is parsed strictly, and a rollback that
 * met a policy carrying a tutorial would refuse every customer action on the panel.
 *
 * `text` and `video_client_app_id` are KEPT while the mode does not use them, so an operator
 * who turns the tutorial off and on again gets it back; the CHECK only demands what the mode
 * sends. `video_client_app_id` names a client app whose tutorial video (`client_app_videos`,
 * one per bot) is sent — deliberately NOT a foreign key: deleting the app must not delete or
 * block the tutorial, and the send reads the video through `ClientAppVideoService.videoFor`,
 * which answers nothing for a missing or disabled app.
 */
export const deliveryTutorials = pgTable(
  'delivery_tutorials',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    panelId: uuid('panel_id').notNull(),
    mode: text('mode').notNull().default('DISABLED'),
    /** Stored RAW, as the operator wrote it; drawn by `renderClientAppGuide` at send. */
    text: text('text'),
    videoClientAppId: uuid('video_client_app_id'),
    appliesToPurchase: boolean('applies_to_purchase').notNull().default(true),
    appliesToTrial: boolean('applies_to_trial').notNull().default(true),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.panelId], name: 'delivery_tutorials_pk' }),
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'delivery_tutorials_panel_fk',
    }),
    check('delivery_tutorials_mode_check', enumCheck('mode', DELIVERY_TUTORIAL_MODES)),
    check(
      'delivery_tutorials_text_check',
      sql`text IS NULL OR length(btrim(text)) BETWEEN 1 AND ${sql.raw(String(DELIVERY_TUTORIAL_TEXT_MAX_LENGTH))}`,
    ),
    check(
      'delivery_tutorials_content_check',
      sql`(mode NOT IN ('TEXT', 'VIDEO_TEXT') OR text IS NOT NULL)
          AND (mode NOT IN ('VIDEO', 'VIDEO_TEXT') OR video_client_app_id IS NOT NULL)`,
    ),
    check('delivery_tutorials_revision_check', sql`revision >= 1`),
  ],
);

// --- WP-A10: client apps and connection guides -------------------------------------------

/**
 * An array column holding a subset of an enum, EMPTY included — `enumSubsetCheck` refuses
 * empty, and here empty is the meaning "any": an app that names no provider type is offered
 * whatever panel a service is on. The same assertions and escaping as its sibling.
 */
function enumSubsetOrEmptyCheck(column: string, values: readonly string[]): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(column)) {
    throw new Error(`enumSubsetOrEmptyCheck: "${column}" is not a plain column name.`);
  }
  const list = values
    .map((value) => {
      if (!ENUM_LITERAL.test(value)) {
        throw new Error(`enumSubsetOrEmptyCheck: "${value}" is not a plain enum literal.`);
      }
      return `'${value.replace(/'/g, "''")}'`;
    })
    .join(', ');
  return sql.raw(`${column} <@ ARRAY[${list}]::text[]`);
}

/**
 * One client app a tenant recommends, on one platform (WP-A10).
 *
 * Tenant CONTENT, like `support_faqs`: an operator writes it in the Web Admin and the bot
 * reads it on every tap, so a link or a guide changes without a deploy. No row is seeded.
 *
 * The three compatibility arrays are what context filtering reads, and empty means "any"
 * for each. Their members are pinned to the contract here; `provider_types` too, so a
 * provider type this release does not know cannot be stored against a row that a future
 * release would then read as a real restriction.
 *
 * The links are stored NORMALISED by `normalizeClientAppUrl` and the constraint repeats
 * the one property the database can check cheaply — the scheme — so a row written around
 * the service still cannot hand Telegram a `javascript:` button.
 */
export const clientApps = pgTable(
  'client_apps',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    platform: text('platform').notNull(),
    name: text('name').notNull(),
    icon: text('icon'),
    description: text('description').notNull(),
    officialUrl: text('official_url').notNull(),
    alternativeUrl: text('alternative_url'),
    helpUrl: text('help_url'),
    guide: text('guide').notNull(),
    deliveryKinds: text('delivery_kinds')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    protocols: text('protocols')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    providerTypes: text('provider_types')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text('status').notNull().default('ENABLED'),
    sortOrder: integer('sort_order').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    /*
     * HF-A10 — the entry's optional picture. All six set, or none (`client_apps_image_check`).
     * The bytes are selected by one repository method only, for the bot and the editor's
     * preview; every other read names the metadata columns and never `image_content`.
     */
    imageContent: bytea('image_content'),
    imageMimeType: text('image_mime_type'),
    imageByteLength: integer('image_byte_length'),
    imageWidth: integer('image_width'),
    imageHeight: integer('image_height'),
    imageSha256: text('image_sha256'),
    imageUpdatedAt: timestamptz('image_updated_at'),
  },
  (table) => [
    /** The customer's read: one platform's enabled rows, in the operator's order. */
    index('client_apps_tenant_platform_idx').on(
      table.tenantId,
      table.platform,
      table.status,
      table.sortOrder,
      table.createdAt,
      table.id,
    ),
    unique('client_apps_tenant_id_key').on(table.tenantId, table.id),
    check('client_apps_platform_check', enumCheck('platform', CLIENT_APP_PLATFORMS)),
    check('client_apps_status_check', enumCheck('status', CLIENT_APP_STATUSES)),
    check(
      'client_apps_name_check',
      sql`length(btrim(name)) BETWEEN 1 AND ${sql.raw(String(CLIENT_APP_NAME_MAX_LENGTH))}`,
    ),
    check(
      'client_apps_icon_check',
      sql`icon IS NULL OR length(btrim(icon)) BETWEEN 1 AND ${sql.raw(String(CLIENT_APP_ICON_MAX_LENGTH))}`,
    ),
    check(
      'client_apps_description_check',
      sql`length(btrim(description)) BETWEEN 1 AND ${sql.raw(String(CLIENT_APP_DESCRIPTION_MAX_LENGTH))}`,
    ),
    check(
      'client_apps_guide_check',
      sql`length(btrim(guide)) BETWEEN 1 AND ${sql.raw(String(CLIENT_APP_GUIDE_MAX_LENGTH))}`,
    ),
    check(
      'client_apps_urls_check',
      sql`official_url LIKE 'https://%' AND length(official_url) <= ${sql.raw(String(CLIENT_APP_URL_MAX_LENGTH))}
          AND (alternative_url IS NULL OR (alternative_url LIKE 'https://%' AND length(alternative_url) <= ${sql.raw(String(CLIENT_APP_URL_MAX_LENGTH))}))
          AND (help_url IS NULL OR (help_url LIKE 'https://%' AND length(help_url) <= ${sql.raw(String(CLIENT_APP_URL_MAX_LENGTH))}))`,
    ),
    check(
      'client_apps_delivery_kinds_check',
      enumSubsetOrEmptyCheck('delivery_kinds', CLIENT_APP_DELIVERY_KINDS),
    ),
    check('client_apps_protocols_check', enumSubsetOrEmptyCheck('protocols', CLIENT_APP_PROTOCOLS)),
    check(
      'client_apps_provider_types_check',
      enumSubsetOrEmptyCheck('provider_types', PROVIDER_TYPES),
    ),
    check(
      'client_apps_sort_order_check',
      sql`sort_order BETWEEN ${sql.raw(String(CLIENT_APP_SORT_MIN))} AND ${sql.raw(String(CLIENT_APP_SORT_MAX))}`,
    ),
    check('client_apps_version_check', sql`version >= 1`),
    /*
     * The image is whole or absent, bounded, of a contract type, and its stated length is
     * its real one. Every column is named `IS NOT NULL` in the second arm on purpose: a
     * CHECK passes when it evaluates to NULL, so `image_mime_type IN (…)` alone would admit
     * bytes with no type. The MIME list by hand for `tenant_media_assets_mime_check`'s reason:
     * `enumCheck` refuses a literal with a slash.
     */
    check(
      'client_apps_image_check',
      sql`(image_content IS NULL AND image_mime_type IS NULL AND image_byte_length IS NULL
            AND image_width IS NULL AND image_height IS NULL AND image_sha256 IS NULL
            AND image_updated_at IS NULL)
          OR (image_content IS NOT NULL AND image_mime_type IS NOT NULL
            AND image_byte_length IS NOT NULL AND image_width IS NOT NULL
            AND image_height IS NOT NULL AND image_sha256 IS NOT NULL
            AND image_updated_at IS NOT NULL
            AND image_mime_type IN (${sql.raw(
              CLIENT_APP_IMAGE_MIME_TYPES.map((value) => {
                if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(value)) {
                  throw new Error(`client_apps: "${value}" is not a plain MIME literal.`);
                }
                return `'${value}'`;
              }).join(', '),
            )})
            AND image_byte_length BETWEEN 1 AND ${sql.raw(String(CLIENT_APP_IMAGE_MAX_BYTES))}
            AND image_byte_length = octet_length(image_content)
            AND image_width BETWEEN ${sql.raw(String(CLIENT_APP_IMAGE_MIN_SIDE))} AND ${sql.raw(String(CLIENT_APP_IMAGE_MAX_SIDE))}
            AND image_height BETWEEN ${sql.raw(String(CLIENT_APP_IMAGE_MIN_SIDE))} AND ${sql.raw(String(CLIENT_APP_IMAGE_MAX_SIDE))}
            AND image_sha256 ~ '^[0-9a-f]{64}$')`,
    ),
  ],
);

/**
 * Spec §7: a client app's tutorial VIDEO, set from Telegram by an administrator («تنظیم
 * ویدیو»), one per (app, bot).
 *
 * The media architecture decides the shape (`docs/package-h-tutorials-marketing-stars.md`): the app's
 * PICTURE is bytes in `client_apps` because it is uploaded in the Web Admin and must be
 * sent by any bot; a VIDEO arrives at Telegram from the administrator's phone, so the bytes
 * are already there and this installation keeps only Telegram's reference — `file_id`, which
 * re-sends it with nothing downloaded, and `file_unique_id`, stable across bots. A `file_id`
 * is valid only for the bot that received it, which is why the row is keyed by bot: the bot
 * an administrator sent the video to is the bot that shows it, and a tenant's other bot gets
 * its own. Known limitation, as for receipts: a backup carries this row, not the video.
 *
 * Replacing is an UPDATE that bumps `version`; deleting removes the row. Both are audited
 * (`client_app.video_set`, `client_app.video_delete`). Deleting the app deletes its videos.
 */
export const clientAppVideos = pgTable(
  'client_app_videos',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    clientAppId: uuid('client_app_id').notNull(),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    /** What `sendVideo` takes. Bot-scoped, and never returned to a browser. */
    fileId: text('file_id').notNull(),
    fileUniqueId: text('file_unique_id').notNull(),
    mimeType: text('mime_type'),
    durationSeconds: integer('duration_seconds'),
    fileSize: bigint('file_size', { mode: 'bigint' }),
    /** The administrator whose message set it. */
    setByAdminId: uuid('set_by_admin_id').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('client_app_videos_app_bot_key').on(
      table.tenantId,
      table.clientAppId,
      table.botInstanceId,
    ),
    foreignKey({
      columns: [table.tenantId, table.clientAppId],
      foreignColumns: [clientApps.tenantId, clientApps.id],
      name: 'client_app_videos_app_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.tenantId, table.setByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'client_app_videos_admin_fk',
    }),
    check(
      'client_app_videos_file_check',
      sql`length(file_id) BETWEEN 1 AND ${sql.raw(String(CLIENT_APP_VIDEO_FILE_ID_MAX_LENGTH))}
          AND length(file_unique_id) BETWEEN 1 AND ${sql.raw(String(CLIENT_APP_VIDEO_FILE_UNIQUE_ID_MAX_LENGTH))}
          AND (mime_type IS NULL OR length(mime_type) BETWEEN 1 AND 128)
          AND (duration_seconds IS NULL OR duration_seconds >= 0)
          AND (file_size IS NULL OR file_size > 0)`,
    ),
    check('client_app_videos_version_check', sql`version >= 1`),
  ],
);

/**
 * «ارسال توضیح از تلگرام»: a capture request the Web Admin opens for ONE administrator, tenant
 * and product, and the bot completes with that administrator's next text or caption message.
 *
 * Single use and short lived: it closes `CAPTURED` on the first message it reads (the converted
 * text is stored in `captured_text`, for the page to fill into the description field — nothing
 * is saved to the product), `EXPIRED` once its ten minutes are over and something writes to it,
 * or `SUPERSEDED` when the same administrator opens another. One open request per administrator
 * is a partial unique index, so two messages arriving together read one request, once.
 */
export const productDescriptionCaptures = pgTable(
  'product_description_captures',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    productId: uuid('product_id').notNull(),
    openedAt: timestamptz('opened_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    closedAt: timestamptz('closed_at'),
    closeReason: text('close_reason'),
    /** The captured message in its stored form (`descriptionFromTelegramText`), once read. */
    capturedText: text('captured_text'),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'product_description_captures_admin_fk',
    }),
    // A withdrawn product is never deleted; deleting one deletes its open request with it.
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'product_description_captures_product_fk',
    }).onDelete('cascade'),
    uniqueIndex('product_description_captures_open_key')
      .on(table.tenantId, table.adminId)
      .where(sql`closed_at IS NULL`),
    check(
      'product_description_captures_close_reason_check',
      nullableEnumCheck('close_reason', PRODUCT_DESCRIPTION_CAPTURE_CLOSE_REASONS),
    ),
    check(
      'product_description_captures_closed_check',
      sql`(closed_at IS NULL) = (close_reason IS NULL)`,
    ),
    check('product_description_captures_expiry_check', sql`expires_at > opened_at`),
    check(
      'product_description_captures_captured_check',
      sql`(close_reason = 'CAPTURED') = (captured_text IS NOT NULL)
          AND (captured_text IS NULL OR char_length(captured_text) BETWEEN 1 AND ${sql.raw(String(PRODUCT_DESCRIPTION_MAX_LENGTH))})`,
    ),
  ],
);
