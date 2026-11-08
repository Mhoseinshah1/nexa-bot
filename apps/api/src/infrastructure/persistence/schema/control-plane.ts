/**
 * Database schema — control plane: bot appearance, templates, settings, menus, feature flags, custom menu buttons.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import {
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
import { sql } from 'drizzle-orm';
import {
  CUSTOM_MENU_BOT_SCOPES,
  CUSTOM_MENU_BUTTON_KINDS,
  CUSTOM_MENU_CAPTION_MAX,
  CUSTOM_MENU_LABEL_MAX,
  CUSTOM_MENU_TEXT_MAX,
  TEMPLATE_REVISION_ACTIONS,
  CLIENT_APP_URL_MAX_LENGTH,
  TICKET_REPLY_FILE_TYPES,
  APPEARANCE_SLOTS,
} from '@nexa/contracts';
import { bytea, enumCheck, timestamptz } from './_shared.js';
import { botInstances, tenants } from './tenancy.js';
import { admins } from './identity.js';

/**
 * Premium UI — one row per appearance slot a tenant has configured
 * (`docs/premium-ui-audit.md` §3). A slot with no row is the catalogue fallback, switched
 * on; a row holds at most a Telegram `custom_emoji_id` and a switch. Never HTML, never a
 * rendered string. Per TENANT, deliberately: the icons are the tenant's brand, and every
 * bot of the tenant draws them — subject to that bot's own eligibility test on its row above.
 */
export const botAppearanceSlots = pgTable(
  'bot_appearance_slots',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    slot: text('slot').notNull(),
    /** Telegram's decimal custom emoji id. NULL means "no custom emoji; draw the fallback". */
    customEmojiId: text('custom_emoji_id'),
    enabled: boolean('enabled').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    updatedByAdminId: uuid('updated_by_admin_id'),
  },
  (table) => [
    uniqueIndex('bot_appearance_slots_tenant_slot_key').on(table.tenantId, table.slot),
    check('bot_appearance_slots_slot_check', enumCheck('slot', APPEARANCE_SLOTS)),
    check(
      'bot_appearance_slots_custom_emoji_id_check',
      sql`custom_emoji_id IS NULL OR custom_emoji_id ~ '^[0-9]{1,32}$'`,
    ),
    check('bot_appearance_slots_version_check', sql`version >= 1`),
    // Only an administrator of this tenant can have edited this tenant's slot.
    foreignKey({
      name: 'bot_appearance_slots_tenant_admin_fk',
      columns: [table.tenantId, table.updatedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

// ---------------------------------------------------------------------------
// Control plane — Phase 2
// ---------------------------------------------------------------------------

/**
 * A tenant's override of one template body.
 *
 * Current state, one row per `(tenant, key, locale)`. The RAW source, exactly as
 * an administrator typed it — never a rendered string. In the legacy system the
 * edit screen echoes the rendered text, so the raw template cannot be read back
 * from the screen that edits it, and a save from that view would store the
 * editor's own name where a placeholder was (TBR-TXT-004).
 *
 * `version` carries optimistic concurrency: an UPDATE matches on it and a zero
 * row count is a conflict, never a retry (ADR-0021).
 *
 * There is no `is_default` column and no copy of the default body. A tenant that
 * has not overridden a key has NO ROW, which is what lets an improved default
 * reach them.
 */
export const templateOverrides = pgTable(
  'template_overrides',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    templateKey: text('template_key').notNull(),
    locale: text('locale').notNull(),
    /** Raw source. Placeholders un-substituted. Never a rendered message. */
    body: text('body').notNull(),
    version: integer('version').notNull().default(1),
    /** The revision in `template_revisions` this body came from. */
    revision: integer('revision').notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    updatedByAdminId: uuid('updated_by_admin_id'),
  },
  (table) => [
    uniqueIndex('template_overrides_key').on(table.tenantId, table.templateKey, table.locale),
    check('template_overrides_version_check', sql`version >= 1`),
    check('template_overrides_body_check', sql`length(body) BETWEEN 1 AND 4096`),
    // Only an administrator of this tenant can have edited this tenant's copy.
    foreignKey({
      name: 'template_overrides_tenant_admin_fk',
      columns: [table.tenantId, table.updatedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * Every change to a tenant's template body, including the reverts.
 *
 * Append-only. A revert deletes the override row and writes a revision here
 * saying so, which is why `body` is nullable: a REVERT revision has no body,
 * because reverting means going back to the default rather than storing a copy
 * of it.
 *
 * This is NOT the audit log and does not duplicate it. The audit row answers
 * "who changed what", is redacted, and is governed by a retention policy; this
 * table holds the content itself, is read by a product feature, and lives as
 * long as the tenant. Both are written in the same transaction.
 */
export const templateRevisions = pgTable(
  'template_revisions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    templateKey: text('template_key').notNull(),
    locale: text('locale').notNull(),
    /** Monotonic per `(tenant, key, locale)`, starting at 1. */
    revision: integer('revision').notNull(),
    action: text('action').notNull(),
    /** Raw source for a SET. NULL for a REVERT. */
    body: text('body'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    createdByAdminId: uuid('created_by_admin_id'),
  },
  (table) => [
    uniqueIndex('template_revisions_key').on(
      table.tenantId,
      table.templateKey,
      table.locale,
      table.revision,
    ),
    check('template_revisions_action_check', enumCheck('action', TEMPLATE_REVISION_ACTIONS)),
    check('template_revisions_revision_check', sql`revision >= 1`),
    // A SET carries a body; a REVERT never does. Without this the two shapes
    // drift and "which revision restored the default" stops being answerable.
    check(
      'template_revisions_body_check',
      sql`(action = 'SET' AND body IS NOT NULL AND length(body) BETWEEN 1 AND 4096) OR (action = 'REVERT' AND body IS NULL)`,
    ),
    foreignKey({
      name: 'template_revisions_tenant_admin_fk',
      columns: [table.tenantId, table.createdByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * A tenant's value for one registered setting.
 *
 * Absence means the default applies. That is the whole source-resolution rule,
 * and it is stored as absence rather than as a flag beside the value, because a
 * flag and a value can disagree and absence cannot.
 *
 * The value is `jsonb` because the registry's schemas are heterogeneous — a
 * string, an integer, an enum, a nullable integer. It is NOT a free-form
 * document: it is parsed by that key's declared zod schema on the way in and on
 * the way out, and a key that is not registered has no row and cannot get one.
 */
export const settingValues = pgTable(
  'setting_values',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    settingKey: text('setting_key').notNull(),
    value: jsonb('value').notNull(),
    version: integer('version').notNull().default(1),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    updatedByAdminId: uuid('updated_by_admin_id'),
  },
  (table) => [
    uniqueIndex('setting_values_key').on(table.tenantId, table.settingKey),
    check('setting_values_version_check', sql`version >= 1`),
    /*
     * FIX-06 (2026-10-09): the QR template's quiet zone is a whole number of modules, 0..16
     * (`QR_TEMPLATE_QUIET_ZONE_MIN`..`_MAX`) — the registry's zod schema says so on the way in
     * and out, and this is the same rule for a writer that forgets it. Null is no template.
     * The CASE orders the type test before the cast: AND/OR do not short-circuit in SQL, and
     * a cast of a non-number must fail the check, never throw. 0 is a value, not "unset".
     */
    check(
      'setting_values_qr_template_quiet_zone_check',
      sql`setting_key <> 'delivery.qr_template' OR jsonb_typeof(value) = 'null' OR (CASE WHEN jsonb_typeof(value -> 'quietZoneModules') = 'number' THEN ((value ->> 'quietZoneModules')::numeric BETWEEN 0 AND 16 AND (value ->> 'quietZoneModules')::numeric = trunc((value ->> 'quietZoneModules')::numeric)) ELSE false END)`,
    ),
    foreignKey({
      name: 'setting_values_tenant_admin_fk',
      columns: [table.tenantId, table.updatedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * Round T — one row per PUBLISH of a tenant's main-menu layout
 * (`docs/round-t-button-builder-audit.md` §11.1, §11.8).
 *
 * Append-only, by trigger (`nexa_reject_mutation`, migration 0156), like
 * `template_revisions`, and kept for the tenant's life (OQ-T-3): the only record of what
 * the keyboard used to be. Only a publish writes one — a draft save, a reset and a restore
 * change the draft alone. `snapshot` is the explicit layout exactly as published, with its
 * own `v`, so a release that cannot read it says so instead of guessing.
 *
 * `restored_from_revision_id` names the revision a restored draft came from; the composite
 * foreign key keeps it inside the tenant.
 */
export const mainMenuRevisions = pgTable(
  'main_menu_revisions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Monotonic per tenant, starting at 1. */
    revision: integer('revision').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    restoredFromRevisionId: uuid('restored_from_revision_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    createdByAdminId: uuid('created_by_admin_id'),
  },
  (table) => [
    uniqueIndex('main_menu_revisions_tenant_revision_key').on(table.tenantId, table.revision),
    // The target of the tenant-scoped foreign keys below and on `main_menu_layouts`.
    unique('main_menu_revisions_tenant_id_key').on(table.tenantId, table.id),
    check('main_menu_revisions_revision_check', sql`revision >= 1`),
    check('main_menu_revisions_snapshot_check', sql`jsonb_typeof(snapshot) = 'object'`),
    foreignKey({
      name: 'main_menu_revisions_restored_from_fk',
      columns: [table.tenantId, table.restoredFromRevisionId],
      foreignColumns: [table.tenantId, table.id],
    }),
    foreignKey({
      name: 'main_menu_revisions_tenant_admin_fk',
      columns: [table.tenantId, table.createdByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * Round T — a tenant's main-menu builder state: the DRAFT and the PUBLISHED head, one row
 * per tenant (`docs/round-t-button-builder-audit.md` §11.1).
 *
 * No row means the tenant never saved a draft, and the keyboard is the legacy path over
 * `bot.main_menu`, byte for byte. The runtime reads `published` only, never `draft`.
 *
 * `projection_setting_version` is the `setting_values.version` of `bot.main_menu` the
 * publish wrote in the same transaction. When the setting's version has moved past it —
 * written by an older release during a rollback, the one remaining writer — the published
 * layout is SUPERSEDED: the keyboard follows the setting and the builder says so.
 *
 * Every write is a conditional UPDATE naming the version it read (`draft_version`, and for
 * a publish `published_revision` too); the first write is `INSERT … ON CONFLICT DO NOTHING`.
 */
export const mainMenuLayouts = pgTable(
  'main_menu_layouts',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    draft: jsonb('draft').notNull(),
    draftVersion: integer('draft_version').notNull().default(1),
    draftUpdatedAt: timestamptz('draft_updated_at').notNull(),
    draftUpdatedByAdminId: uuid('draft_updated_by_admin_id'),
    draftRestoredFromRevisionId: uuid('draft_restored_from_revision_id'),
    /**
     * The draft's LEGACY BASELINE: the `bot.main_menu` version it was derived from (NULL:
     * the setting had no row). Set by the first draft save (from the version the page was
     * seeded from), by a reset or reseed, and by every publish. While nothing is published,
     * or the published layout is superseded, a publish requires the setting to still be at
     * this version — a draft is never published over a legacy write nobody looked at.
     */
    draftLegacySettingVersion: integer('draft_legacy_setting_version'),
    published: jsonb('published'),
    publishedRevision: integer('published_revision'),
    publishedAt: timestamptz('published_at'),
    publishedByAdminId: uuid('published_by_admin_id'),
    projectionSettingVersion: integer('projection_setting_version'),
  },
  (table) => [
    check('main_menu_layouts_draft_check', sql`jsonb_typeof(draft) = 'object'`),
    check('main_menu_layouts_draft_version_check', sql`draft_version >= 1`),
    check(
      'main_menu_layouts_draft_legacy_setting_version_check',
      sql`draft_legacy_setting_version IS NULL OR draft_legacy_setting_version >= 1`,
    ),
    check(
      'main_menu_layouts_published_check',
      sql`published IS NULL OR jsonb_typeof(published) = 'object'`,
    ),
    check(
      'main_menu_layouts_published_revision_check',
      sql`published_revision IS NULL OR published_revision >= 1`,
    ),
    // A published head is whole or absent: never a layout without its revision, its time
    // or the projection version it wrote.
    check(
      'main_menu_layouts_published_shape_check',
      sql`(published IS NULL) = (published_revision IS NULL) AND (published IS NULL) = (published_at IS NULL) AND (published IS NULL) = (projection_setting_version IS NULL)`,
    ),
    foreignKey({
      name: 'main_menu_layouts_restored_from_fk',
      columns: [table.tenantId, table.draftRestoredFromRevisionId],
      foreignColumns: [mainMenuRevisions.tenantId, mainMenuRevisions.id],
    }),
    foreignKey({
      name: 'main_menu_layouts_draft_admin_fk',
      columns: [table.tenantId, table.draftUpdatedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    foreignKey({
      name: 'main_menu_layouts_published_admin_fk',
      columns: [table.tenantId, table.publishedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * A tenant's state for one registered feature flag.
 *
 * `enabled` is a boolean column, and that is a design constraint rather than an
 * incidental type: it gives configuration nowhere to hide. The legacy capability
 * screen has four shapes behind it (CBR-011), three of which are settings
 * wearing a toggle's clothes; those live in `setting_values`.
 */
export const featureFlagStates = pgTable(
  'feature_flag_states',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    flagKey: text('flag_key').notNull(),
    enabled: boolean('enabled').notNull(),
    version: integer('version').notNull().default(1),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    updatedByAdminId: uuid('updated_by_admin_id'),
    /** The latest change's optional note; since WP-A2 no flag requires one. */
    reason: text('reason'),
  },
  (table) => [
    uniqueIndex('feature_flag_states_key').on(table.tenantId, table.flagKey),
    check('feature_flag_states_version_check', sql`version >= 1`),
    foreignKey({
      name: 'feature_flag_states_tenant_admin_fk',
      columns: [table.tenantId, table.updatedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

// --- R10 D2: owner-defined main-menu buttons ---------------------------------------------

/**
 * R10 D2 — the media of an owner-defined main-menu button: ONE photo or document, as BYTES.
 *
 * The precedent is `tenant_media_assets` and `customer_direct_messages`: the bytes live in
 * PostgreSQL, bounded, and a Telegram `file_id` is never the source of truth because it is
 * scoped to the one bot that received the upload (another bot of the tenant would answer
 * "file not found"). Every send is a multipart upload. A backup carries the bytes.
 *
 * The allow-list is support's own (`TICKET_REPLY_FILE_TYPES`): the type CHECK is built from
 * it exactly as `customer_direct_messages_file_type_check` is, so a type, its kind (PHOTO or
 * DOCUMENT) and its size bound cannot disagree with the contract. A button's `kind` and its
 * media's `kind` are held equal by the composite foreign key on `custom_menu_buttons`.
 *
 * Replacing a button's file inserts a NEW row, repoints the button and deletes the old row in
 * one transaction, so the tenant's storage bound counts live files only.
 */
export const customMenuButtonMedia = pgTable(
  'custom_menu_button_media',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** PHOTO or DOCUMENT, decided from the verified type — never from the browser. */
    kind: text('kind').notNull(),
    mimeType: text('mime_type').notNull(),
    /** The name it is sent under: cleaned, ending in the verified type's extension. */
    fileName: text('file_name').notNull(),
    byteLength: integer('byte_length').notNull(),
    sha256: text('sha256').notNull(),
    content: bytea('content').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('custom_menu_button_media_tenant_id_key').on(table.tenantId, table.id),
    // The target of the button's (tenant, media, kind) foreign key.
    unique('custom_menu_button_media_tenant_kind_key').on(table.tenantId, table.id, table.kind),
    index('custom_menu_button_media_tenant_idx').on(table.tenantId),
    check('custom_menu_button_media_kind_check', enumCheck('kind', ['PHOTO', 'DOCUMENT'])),
    /** The allow-list, from the contract: each type with its kind and its own bound. */
    check(
      'custom_menu_button_media_type_check',
      sql`CASE mime_type ${sql.raw(
        TICKET_REPLY_FILE_TYPES.map((type) => {
          if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(type.mimeType) || !/^[A-Z]+$/.test(type.kind)) {
            throw new Error(`custom_menu_button_media: "${type.mimeType}" is not a plain literal.`);
          }
          return `WHEN '${type.mimeType}' THEN kind = '${type.kind}' AND byte_length BETWEEN 1 AND ${String(type.maxBytes)}`;
        }).join(' '),
      )} ELSE false END`,
    ),
    check('custom_menu_button_media_content_check', sql`octet_length(content) = byte_length`),
    check('custom_menu_button_media_sha256_check', sql`sha256 ~ '^[0-9a-f]{64}$'`),
    check(
      'custom_menu_button_media_file_name_check',
      sql`char_length(file_name) BETWEEN 1 AND 255`,
    ),
  ],
);

/**
 * R10 D2 — an owner-defined main-menu button (`packages/contracts/src/custom-menu-buttons.ts`).
 *
 * A row, not a registry entry: the layout places it by reference (`custom:<id>`, a `v: 2`
 * layout), and a button is shown on all of the tenant's bots or on the ones named in
 * `custom_menu_button_bots`. Rows are ARCHIVED, never deleted (a trigger refuses the DELETE):
 * published revisions reference the id, and a keyboard already sitting in a chat can still
 * be tapped and must be answered "unavailable" rather than "unknown". Archiving a PHOTO or
 * DOCUMENT button deletes its file (the storage bound counts live files) and clears `media_id`,
 * which is why the file is required only while the button is active.
 *
 * The SHAPE is one CHECK, whatever writes the row: a LINK has a normalised https `url`
 * and no file (a `body` is its optional note); a TEXT has a `body` of 1..4096; a PHOTO or
 * DOCUMENT has a file of its own kind and an optional caption of at most 1024. The label is
 * unique among the tenant's ACTIVE buttons only, one line, never reading as a slash command.
 *
 * Every write is a conditional UPDATE naming the `version` it read.
 */
export const customMenuButtons = pgTable(
  'custom_menu_buttons',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    label: text('label').notNull(),
    kind: text('kind').notNull(),
    url: text('url'),
    /** The TEXT message, a LINK's optional note, or a PHOTO or DOCUMENT's optional caption. */
    body: text('body'),
    mediaId: uuid('media_id'),
    botScope: text('bot_scope').notNull().default('ALL'),
    version: integer('version').notNull().default(1),
    archivedAt: timestamptz('archived_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdByAdminId: uuid('created_by_admin_id'),
    updatedByAdminId: uuid('updated_by_admin_id'),
  },
  (table) => [
    unique('custom_menu_buttons_tenant_id_key').on(table.tenantId, table.id),
    /** A label is one active button's: an archived button frees it. */
    uniqueIndex('custom_menu_buttons_active_label_key')
      .on(table.tenantId, table.label)
      .where(sql`archived_at IS NULL`),
    index('custom_menu_buttons_tenant_idx').on(table.tenantId, table.createdAt, table.id),
    check('custom_menu_buttons_kind_check', enumCheck('kind', CUSTOM_MENU_BUTTON_KINDS)),
    check('custom_menu_buttons_scope_check', enumCheck('bot_scope', CUSTOM_MENU_BOT_SCOPES)),
    check('custom_menu_buttons_version_check', sql`version >= 1`),
    check(
      'custom_menu_buttons_label_check',
      sql`char_length(label) BETWEEN 1 AND ${sql.raw(String(CUSTOM_MENU_LABEL_MAX))}
          AND label !~ '[[:cntrl:]]' AND left(label, 1) <> '/' AND label = btrim(label)`,
    ),
    check(
      'custom_menu_buttons_url_check',
      sql`url IS NULL OR (url ~ '^https://' AND char_length(url) <= ${sql.raw(String(CLIENT_APP_URL_MAX_LENGTH))})`,
    ),
    check(
      'custom_menu_buttons_shape_check',
      sql`CASE kind
            WHEN 'LINK' THEN url IS NOT NULL AND media_id IS NULL
              AND (body IS NULL OR char_length(body) BETWEEN 1 AND ${sql.raw(String(CUSTOM_MENU_TEXT_MAX))})
            WHEN 'TEXT' THEN url IS NULL AND media_id IS NULL AND body IS NOT NULL
              AND char_length(body) BETWEEN 1 AND ${sql.raw(String(CUSTOM_MENU_TEXT_MAX))}
            WHEN 'PHOTO' THEN url IS NULL AND (media_id IS NOT NULL OR archived_at IS NOT NULL)
              AND (body IS NULL OR char_length(body) BETWEEN 1 AND ${sql.raw(String(CUSTOM_MENU_CAPTION_MAX))})
            WHEN 'DOCUMENT' THEN url IS NULL AND (media_id IS NOT NULL OR archived_at IS NOT NULL)
              AND (body IS NULL OR char_length(body) BETWEEN 1 AND ${sql.raw(String(CUSTOM_MENU_CAPTION_MAX))})
            ELSE false
          END`,
    ),
    /*
     * The file belongs to this tenant AND is of this button's kind: a PHOTO button cannot
     * point at a PDF. A LINK or TEXT button has no media, and a NULL column skips the key.
     */
    foreignKey({
      name: 'custom_menu_buttons_media_fk',
      columns: [table.tenantId, table.mediaId, table.kind],
      foreignColumns: [
        customMenuButtonMedia.tenantId,
        customMenuButtonMedia.id,
        customMenuButtonMedia.kind,
      ],
    }),
    foreignKey({
      name: 'custom_menu_buttons_created_admin_fk',
      columns: [table.tenantId, table.createdByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    foreignKey({
      name: 'custom_menu_buttons_updated_admin_fk',
      columns: [table.tenantId, table.updatedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * R10 D2 — which bots show a `SELECTED` custom button. Rows exist only for a button whose
 * `bot_scope` is `SELECTED` (the service keeps that true; an `ALL` button has none). The button
 * foreign key carries the tenant; the bot foreign key is the plain one every table uses for
 * `bot_instances`, and the repository only accepts ids of the tenant's own bots (it reads them
 * with the tenant filter inside the write transaction).
 */
export const customMenuButtonBots = pgTable(
  'custom_menu_button_bots',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    buttonId: uuid('button_id').notNull(),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
  },
  (table) => [
    primaryKey({
      name: 'custom_menu_button_bots_pk',
      columns: [table.tenantId, table.buttonId, table.botInstanceId],
    }),
    index('custom_menu_button_bots_bot_idx').on(table.tenantId, table.botInstanceId),
    foreignKey({
      name: 'custom_menu_button_bots_button_fk',
      columns: [table.tenantId, table.buttonId],
      foreignColumns: [customMenuButtons.tenantId, customMenuButtons.id],
    }),
  ],
);
