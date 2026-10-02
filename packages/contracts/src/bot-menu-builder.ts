import { z } from 'zod';
import { APPEARANCE_SLOTS, type AppearanceSlot } from './appearance.js';
import {
  DEFAULT_MAIN_MENU_LAYOUT,
  MAIN_MENU_BUTTON_IDS,
  MAIN_MENU_TARGETS,
  mainMenuButton,
  mainMenuButtonIsGated,
  mainMenuEntryOf,
  packMainMenuRows,
  resolveMainMenuLayout,
  type MainMenuButtonId,
  type MainMenuLayoutEntry,
} from './bot-commands.js';
import { MAIN_MENU_GATES } from './bot-menu.js';
import { MENU_APPEARANCE_SLOTS } from './menu-appearance.js';
import { BOT_INSTANCE_STATUSES } from './tenant.js';

/**
 * Round T — the button builder (`docs/round-t-button-builder-audit.md` §11).
 *
 * An EXTENSION of the main menu, not a second one: the same closed registry
 * (`MAIN_MENU_BUTTONS`), the same targets, the same `bot.menu.*` labels, the same gates and
 * the same appearance slots. What it adds is an explicit arrangement — rows the operator
 * chose, a style per button, an icon slot per button — and a draft/publish/revision
 * lifecycle around it.
 *
 * ## Where it is stored, and why not in `bot.main_menu`
 *
 * `mainMenuLayoutEntrySchema` is `.strict()`, so a new field in `bot.main_menu` makes the
 * previous release's parser refuse the whole value and draw the default keyboard after a
 * rollback (audit §10). So the explicit model lives in its own tables, and `bot.main_menu`
 * stays — unchanged in shape — as the COMPATIBILITY PROJECTION a publish rewrites in the
 * same transaction (`legacyProjectionOf`). The previous release reads the projection as the
 * same order and the same visibility, packed two to a row, without styles or icons.
 *
 * ## The rules an explicit layout states
 *
 * - **Placed** buttons are in `rows`; a button in `buttons` and in no row is **unplaced** —
 *   in the Available pool, not drawn, its style and icon kept for when it is placed again.
 * - **Disabled** (`enabled: false`) keeps its position and is not drawn.
 * - A gated button whose gate is closed is not drawn either. Nothing REFLOWS: a hidden
 *   button leaves its row shorter, and a row left empty is dropped (`customerRowsOf`).
 * - A button declared by a later release and missing from `buttons` is unplaced
 *   (`normalizeExplicitMainMenu`): shipping a button never draws it on somebody's explicit
 *   layout (OQ-T-2).
 */

/**
 * The closed set of reply-keyboard styles. `KeyboardButton.style` accepts exactly
 * `primary`, `success` and `danger` (Bot API 9.4, confirmed by the owner); `default` is
 * Nexa's name for "no style" and is OMITTED on the wire. No custom colours.
 */
export const MAIN_MENU_BUTTON_STYLES = ['default', 'primary', 'success', 'danger'] as const;
export type MainMenuButtonStyle = (typeof MAIN_MENU_BUTTON_STYLES)[number];

/** The snapshot shape version. A stored layout of another `v` is unreadable, not guessed at. */
export const EXPLICIT_MAIN_MENU_VERSION = 1;

/**
 * At most one row per declared button, so one button per row is always legal.
 *
 * A Nexa DOMAIN bound derived from the closed registry — NOT a Telegram maximum. Each id is
 * placed at most once, so no layout can need more rows than there are buttons.
 */
export const MAIN_MENU_ROWS_MAX = MAIN_MENU_BUTTON_IDS.length;

/**
 * At most every declared button on one row.
 *
 * Like `MAIN_MENU_ROWS_MAX`, a Nexa DOMAIN bound derived from the registry (each id is placed
 * at most once, so a row can hold no more than all of them) — NOT a Telegram maximum. How
 * many buttons read well side by side is the operator's call in the builder, not a protocol
 * limit this schema invents. It grows with the registry, which is a widening an older
 * release's parser of its own snapshots never sees.
 */
export const MAIN_MENU_ROW_LENGTH_MAX = MAIN_MENU_BUTTON_IDS.length;

/** One button's configuration. Its label is the `bot.menu.*` template, never stored here. */
export const mainMenuButtonConfigSchema = z
  .object({
    button: z.enum(MAIN_MENU_BUTTON_IDS),
    /** Off keeps the button's place in its row; it is not drawn. */
    enabled: z.boolean(),
    style: z.enum(MAIN_MENU_BUTTON_STYLES),
    /**
     * The appearance slot whose custom emoji is the button's ICON, or null for none.
     *
     * `KeyboardButton.icon_custom_emoji_id` is official Bot API, for bots able to use custom
     * emoji (confirmed by the owner); whether a given bot is able is decided per BOT INSTANCE
     * by Nexa's own appearance test, never by the tenant.
     *
     * Distinct from `appearanceSlot` on purpose (audit §7): that field names the slot of the
     * screen the button OPENS, every button has a non-null default for it, and reusing it
     * would give every eligible bot icons on upgrade with no operator action. Null is the
     * default for every button and for every converted legacy layout. Resolved per SENDING
     * bot at send time; on a bot not proven eligible the icon is omitted, and the label text
     * is never altered — the tap is routed by that text.
     */
    iconSlot: z.enum(APPEARANCE_SLOTS).nullable(),
    /** Round P's slot for the screen the item opens; null is the button's default. Round-tripped. */
    appearanceSlot: z.enum(MENU_APPEARANCE_SLOTS).nullable(),
  })
  .strict();
export type MainMenuButtonConfig = z.infer<typeof mainMenuButtonConfigSchema>;

/** Every placed id, row-major. */
function placedIds(rows: readonly (readonly MainMenuButtonId[])[]): MainMenuButtonId[] {
  return rows.flat();
}

/**
 * An explicit main-menu layout: rows of button ids and one configuration per button.
 *
 * Refused: an id placed twice, a config given twice, a placed id with no config, an empty
 * row, more than `MAIN_MENU_ROWS_MAX` rows or `MAIN_MENU_ROW_LENGTH_MAX` buttons on a row,
 * an unknown id, style or slot, any key it does not declare, and a layout with no placed,
 * enabled, ungated button — the same rule `mainMenuLayoutSchema` states, because a keyboard
 * with no button is one Telegram refuses, taking down every reply that carries it.
 */
export const explicitMainMenuSchema = z
  .object({
    v: z.literal(EXPLICIT_MAIN_MENU_VERSION),
    rows: z
      .array(z.array(z.enum(MAIN_MENU_BUTTON_IDS)).min(1).max(MAIN_MENU_ROW_LENGTH_MAX))
      .max(MAIN_MENU_ROWS_MAX),
    buttons: z.array(mainMenuButtonConfigSchema).max(MAIN_MENU_BUTTON_IDS.length),
  })
  .strict()
  .refine(
    (layout) => {
      const placed = placedIds(layout.rows);
      return new Set(placed).size === placed.length;
    },
    { message: 'A button may be placed once.', path: ['rows'] },
  )
  .refine(
    (layout) =>
      new Set(layout.buttons.map((config) => config.button)).size === layout.buttons.length,
    { message: 'Each button has one configuration.', path: ['buttons'] },
  )
  .refine(
    (layout) => {
      const configured = new Set(layout.buttons.map((config) => config.button));
      return placedIds(layout.rows).every((id) => configured.has(id));
    },
    { message: 'Every placed button has a configuration.', path: ['buttons'] },
  )
  .refine(
    (layout) => {
      const byId = new Map(layout.buttons.map((config) => [config.button, config]));
      return placedIds(layout.rows).some(
        (id) => byId.get(id)?.enabled === true && !mainMenuButtonIsGated(mainMenuButton(id)),
      );
    },
    { message: 'At least one placed button that nothing else can hide must stay on.' },
  );
export type ExplicitMainMenu = z.infer<typeof explicitMainMenuSchema>;

/** The configuration a button has before anybody chose one. */
export function defaultMainMenuButtonConfig(id: MainMenuButtonId): MainMenuButtonConfig {
  return { button: id, enabled: true, style: 'default', iconSlot: null, appearanceSlot: null };
}

/**
 * A parsed layout in canonical form: one configuration per DECLARED button, in declared
 * order, the missing ones completed as unplaced and enabled (OQ-T-2), and an
 * `appearanceSlot` equal to the button's default written as null — the form the server
 * stores and compares, so "nothing changed" is decided on meaning rather than key order.
 */
export function normalizeExplicitMainMenu(layout: ExplicitMainMenu): ExplicitMainMenu {
  const byId = new Map(layout.buttons.map((config) => [config.button, config]));
  return {
    v: EXPLICIT_MAIN_MENU_VERSION,
    rows: layout.rows.map((row) => [...row]),
    buttons: MAIN_MENU_BUTTON_IDS.map((id) => {
      const config = byId.get(id) ?? defaultMainMenuButtonConfig(id);
      const slot = config.appearanceSlot;
      return {
        button: id,
        enabled: config.enabled,
        style: config.style,
        iconSlot: config.iconSlot,
        appearanceSlot: slot === null || slot === mainMenuButton(id).appearanceSlot ? null : slot,
      };
    }),
  };
}

/** Whether two layouts mean the same thing (compared in canonical form). */
export function explicitMainMenusEqual(a: ExplicitMainMenu, b: ExplicitMainMenu): boolean {
  return (
    JSON.stringify(normalizeExplicitMainMenu(a)) === JSON.stringify(normalizeExplicitMainMenu(b))
  );
}

/** The declared buttons in no row: the Available pool, in declared order. */
export function unplacedMainMenuButtons(layout: ExplicitMainMenu): MainMenuButtonId[] {
  const placed = new Set(placedIds(layout.rows));
  return MAIN_MENU_BUTTON_IDS.filter((id) => !placed.has(id));
}

/**
 * Whether each GATED button's gate is open now, by id — the server's answer
 * (`MainMenuLayout.describeFor`), never a reader's own. Anything but `true` for a gated
 * button is closed; an ungated button is not asked.
 */
export type MainMenuGateOpenById = Readonly<
  Partial<Record<MainMenuButtonId, boolean | null | undefined>>
>;

/** One button as the customer's keyboard draws it, before its label is rendered. */
export interface CustomerMainMenuButton {
  readonly button: MainMenuButtonId;
  readonly style: MainMenuButtonStyle;
  readonly iconSlot: AppearanceSlot | null;
}

/**
 * THE rendering rule of an explicit layout — the one function the runtime and the Web
 * Admin's customer preview both call, so the preview cannot draw a keyboard the bot does
 * not.
 *
 * Row by row, keep the placed buttons that are enabled and whose gate (if any) is open;
 * drop a row that is left empty. NO REFLOW between rows: the rows are the operator's, not
 * a packing, so a hidden button leaves its row shorter rather than pulling the next row's
 * first button up. Gates are not evaluated here — `gateOpenById` is the server's answer.
 */
export function customerRowsOf(
  layout: ExplicitMainMenu,
  gateOpenById: MainMenuGateOpenById,
): CustomerMainMenuButton[][] {
  const byId = new Map(layout.buttons.map((config) => [config.button, config]));
  const rows: CustomerMainMenuButton[][] = [];
  for (const row of layout.rows) {
    const drawn: CustomerMainMenuButton[] = [];
    for (const id of row) {
      const config = byId.get(id);
      if (config === undefined || !config.enabled) continue;
      if (mainMenuButtonIsGated(mainMenuButton(id)) && gateOpenById[id] !== true) continue;
      drawn.push({ button: id, style: config.style, iconSlot: config.iconSlot });
    }
    if (drawn.length > 0) rows.push(drawn);
  }
  return rows;
}

/**
 * A legacy arrangement (`bot.main_menu`) as an explicit layout — what seeds a draft for a
 * tenant that never used the builder, and what Reset to Default starts from.
 *
 * The enabled items, in their order, packed by the SAME `packMainMenuRows` the legacy
 * keyboard uses (a wide button alone, two to a row), so with every gate open the explicit
 * keyboard is the legacy one, row for row (tested). A legacy "off" is unplaced — not on the
 * keyboard — and keeps its slot. Every style `default`, every icon null: a conversion adds
 * nothing an operator did not choose.
 */
export function explicitFromLegacy(stored: readonly MainMenuLayoutEntry[]): ExplicitMainMenu {
  const resolved = resolveMainMenuLayout(stored);
  const placed = resolved
    .filter((item) => item.enabled)
    .map((item) => ({ id: item.button, wide: mainMenuButton(item.button).wide }));
  const entries = new Map(resolved.map((item) => [item.button, mainMenuEntryOf(item)]));
  return normalizeExplicitMainMenu({
    v: EXPLICIT_MAIN_MENU_VERSION,
    rows: packMainMenuRows(placed).map((row) => row.map((button) => button.id)),
    buttons: MAIN_MENU_BUTTON_IDS.map((id) => ({
      ...defaultMainMenuButtonConfig(id),
      appearanceSlot: entries.get(id)?.appearanceSlot ?? null,
    })),
  });
}

/** Every declared button, in its declared place: the registry's default as an explicit layout. */
export const DEFAULT_EXPLICIT_MAIN_MENU: ExplicitMainMenu =
  explicitFromLegacy(DEFAULT_MAIN_MENU_LAYOUT);

/**
 * The compatibility projection a publish writes to `bot.main_menu`: the placed buttons
 * row-major with their own switch, then the unplaced ones switched OFF, each with its
 * explicit target and its slot (null when default). Rows, styles and icons are not
 * projected — the previous release has nowhere to put them.
 *
 * Parses under the FROZEN `mainMenuLayoutSchema` (pinned by a test): at most one entry per
 * declared button, targets the declared ones, and the explicit layout's own "one placed,
 * enabled, ungated button" rule is what keeps one ungated entry on.
 */
export function legacyProjectionOf(layout: ExplicitMainMenu): MainMenuLayoutEntry[] {
  const normalized = normalizeExplicitMainMenu(layout);
  const byId = new Map(normalized.buttons.map((config) => [config.button, config]));
  const entryOf = (id: MainMenuButtonId, enabled: boolean): MainMenuLayoutEntry => ({
    button: id,
    enabled,
    target: mainMenuButton(id).command,
    appearanceSlot: byId.get(id)?.appearanceSlot ?? null,
  });
  return [
    ...placedIds(normalized.rows).map((id) => entryOf(id, byId.get(id)?.enabled === true)),
    ...unplacedMainMenuButtons(normalized).map((id) => entryOf(id, false)),
  ];
}

// --- Audit, operational events ------------------------------------------------------

/**
 * The audit actions of the builder. Drags are local and never audited: only these four
 * acts are. Entity `MainMenuLayout`, entity id the tenant's id.
 */
export const BOT_MENU_BUILDER_AUDIT_ACTIONS = {
  DRAFT_SAVED: 'bot_menu.draft_saved',
  PUBLISHED: 'bot_menu.published',
  RESET: 'bot_menu.reset',
  RESTORED: 'bot_menu.restored',
} as const;
export const BOT_MENU_BUILDER_AUDIT_ENTITY = 'MainMenuLayout';

/**
 * The published layout could not be read (another `v`, or a value a later release wrote
 * that this one does not parse, after a rollback). The keyboard falls back to the
 * projection in `bot.main_menu`, and this is recorded so the fallback is not silent.
 * Deduplicated per tenant; a publish closes it with the recovery below.
 */
export const BOT_MENU_PUBLISHED_UNREADABLE_CODE = 'bot_menu.published_unreadable';
export const BOT_MENU_PUBLISHED_READABLE_CODE = 'bot_menu.published_readable';

// --- HTTP ---------------------------------------------------------------------------

export const BOT_MENU_BUILDER_ROUTES = {
  view: '/bot-menu/builder',
  draft: '/bot-menu/builder/draft',
  publish: '/bot-menu/builder/publish',
  reset: '/bot-menu/builder/reset',
  revisions: '/bot-menu/builder/revisions',
  restorePattern: '/bot-menu/builder/revisions/:id/restore',
  restore: (id: string) => `/bot-menu/builder/revisions/${encodeURIComponent(id)}/restore`,
} as const;

/** The largest page of revisions one read returns. */
export const MAIN_MENU_REVISIONS_PAGE_MAX = 50;

const isoInstant = z.string();
const idempotencyKey = z.string().min(8).max(255);

/** A revision a draft was restored from, or a published revision was restored from. */
export const mainMenuRevisionRefSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
});
export type MainMenuRevisionRef = z.infer<typeof mainMenuRevisionRefSchema>;

/**
 * The draft as the builder edits it. With no saved draft, `layout` is the live keyboard
 * converted (`explicitFromLegacy` of `bot.main_menu`) and `version` is null — the
 * expectation a first save states. `storedValueInvalid`: a saved draft exists and no longer
 * parses (a later release wrote it); `layout` is then the converted live keyboard and
 * `version` the row's, so a save overwrites it.
 */
export const mainMenuDraftViewSchema = z.object({
  layout: explicitMainMenuSchema,
  version: z.number().int().positive().nullable(),
  updatedAt: isoInstant.nullable(),
  updatedByAdminId: z.string().nullable(),
  restoredFrom: mainMenuRevisionRefSchema.nullable(),
  /** Whether publishing this draft would change what is published (always true before a first publish). */
  differsFromPublished: z.boolean(),
  storedValueInvalid: z.boolean(),
  /**
   * The `bot.main_menu` version this draft was derived from — its LEGACY BASELINE, stored
   * with the draft (null: derived while the setting had no row). Set when the draft is first
   * saved (from the version the page was seeded from), by a reset or reseed, and by every
   * publish (to the projection's version).
   */
  legacyBaselineVersion: z.number().int().positive().nullable(),
  /**
   * The legacy arrangement moved since this draft's baseline, and it MATTERS: nothing is
   * published yet, or the published layout is superseded. A publish is then refused
   * (`control.version_conflict`) until the operator resets or reseeds the draft from the
   * live keyboard — the builder never rebases a draft onto a change nobody looked at.
   */
  legacyChangedSinceDraft: z.boolean(),
});
export type MainMenuDraftView = z.infer<typeof mainMenuDraftViewSchema>;

/** What is published. `layout` is null only when the stored snapshot is unreadable. */
export const mainMenuPublishedViewSchema = z.object({
  layout: explicitMainMenuSchema.nullable(),
  revision: z.number().int().positive(),
  publishedAt: isoInstant,
  publishedByAdminId: z.string().nullable(),
});
export type MainMenuPublishedView = z.infer<typeof mainMenuPublishedViewSchema>;

/** The `bot.main_menu` setting's version this answer was built from (null: no row). */
const settingVersion = z.number().int().positive().nullable();

/** The two heads every builder write answers with. JSON-native, so a replay returns it verbatim. */
export const mainMenuBuilderHeadSchema = z.object({
  draft: mainMenuDraftViewSchema,
  published: mainMenuPublishedViewSchema.nullable(),
  settingVersion,
});
export type MainMenuBuilderHead = z.infer<typeof mainMenuBuilderHeadSchema>;

/**
 * One registry button as the builder shows it: its target (read-only), its label as the
 * tenant renders it now, and the server's own gate answer. React holds no gate logic: the
 * preview passes `gateOpen` to `customerRowsOf`.
 */
export const mainMenuBuilderItemSchema = z.object({
  id: z.enum(MAIN_MENU_BUTTON_IDS),
  target: z.enum(MAIN_MENU_TARGETS),
  wide: z.boolean(),
  label: z.string(),
  defaultLabel: z.string(),
  labelOverridden: z.boolean(),
  defaultAppearanceSlot: z.enum(MENU_APPEARANCE_SLOTS),
  gate: z.enum(MAIN_MENU_GATES).nullable(),
  /** Null when the button has no gate. */
  gateOpen: z.boolean().nullable(),
  /** Another button renders the same label: a tap reaches only the earlier-declared one. */
  duplicateLabel: z.boolean(),
  /** The label reads as a slash command, so a tap on it routes nothing. */
  slashLabel: z.boolean(),
});
export type MainMenuBuilderItem = z.infer<typeof mainMenuBuilderItemSchema>;

/** Whether a bot may carry custom-emoji icons: its last appearance test was `SENT`. */
export const mainMenuIconEligibilitySchema = z.object({
  botInstanceId: z.string(),
  username: z.string(),
  status: z.enum(BOT_INSTANCE_STATUSES),
  eligible: z.boolean(),
});
export type MainMenuIconEligibility = z.infer<typeof mainMenuIconEligibilitySchema>;

export const botMenuBuilderResponseSchema = z.object({
  /** What the customer keyboard is drawn from now. */
  source: z.enum(['LEGACY', 'EXPLICIT']),
  /**
   * A layout is published, but `bot.main_menu` was written after it — by an older release
   * during a rollback. The keyboard follows the setting (the operator's latest act). The
   * existing draft does NOT publish over it (its legacy baseline is behind the setting):
   * reseed the draft from the live keyboard, restore a revision into it if the published
   * layout is wanted back, then publish.
   */
  superseded: z.boolean(),
  /** A layout is published and cannot be read by this release; the keyboard follows the setting. */
  publishedUnreadable: z.boolean(),
  /**
   * The `bot.main_menu` version read in the SAME statement as the draft and published head;
   * `source`, `superseded`, `live` and the draft's `legacyChangedSinceDraft` are all decided
   * from that one read.
   */
  settingVersion,
  draft: mainMenuDraftViewSchema,
  published: mainMenuPublishedViewSchema.nullable(),
  items: z.array(mainMenuBuilderItemSchema),
  /** The customer keyboard as drawn now: rows of rendered labels. */
  live: z.object({ rows: z.array(z.array(z.string())) }),
  iconEligibility: z.array(mainMenuIconEligibilitySchema),
});
export type BotMenuBuilderResponse = z.infer<typeof botMenuBuilderResponseSchema>;

/**
 * Save the draft. `layout` is validated by the SERVER against `explicitMainMenuSchema`
 * (refused as `control.invalid_value` with the issues); `expectedDraftVersion` is the draft
 * version read, null for "I read no saved draft".
 */
export const saveMainMenuDraftRequestSchema = z.object({
  idempotencyKey,
  expectedDraftVersion: z.number().int().positive().nullable(),
  layout: z.unknown(),
  /**
   * The `bot.main_menu` version the page's draft was seeded from (`draft.legacyBaselineVersion`
   * of the read). Stored as the draft's baseline by the FIRST save only — the save that
   * creates the row; a later save keeps the stored baseline. Carried by the request because
   * the server cannot know which version a page seeded its draft from.
   */
  legacyBaselineVersion: z.number().int().positive().nullable(),
});
export type SaveMainMenuDraftRequest = Omit<
  z.infer<typeof saveMainMenuDraftRequestSchema>,
  'layout'
> & { readonly layout: ExplicitMainMenu };

/** Publish the saved draft, against the draft version AND the published revision read. */
export const publishMainMenuRequestSchema = z.object({
  idempotencyKey,
  expectedDraftVersion: z.number().int().positive(),
  expectedPublishedRevision: z.number().int().positive().nullable(),
});
export type PublishMainMenuRequest = z.infer<typeof publishMainMenuRequestSchema>;

/** Where a reset takes the draft from. */
export const MAIN_MENU_RESET_SEEDS = ['DEFAULT', 'LIVE'] as const;
export type MainMenuResetSeed = (typeof MAIN_MENU_RESET_SEEDS)[number];

/**
 * Reset the DRAFT — to the registry's default (`DEFAULT`), or reseeded from the live
 * `bot.main_menu` arrangement (`LIVE`, what "the legacy menu changed since this draft" asks
 * for). Either way the draft's legacy baseline becomes the setting's CURRENT version: the
 * operator chose this, knowingly. `confirm` must be `true`: the page asked first.
 */
export const resetMainMenuDraftRequestSchema = z.object({
  idempotencyKey,
  expectedDraftVersion: z.number().int().positive().nullable(),
  confirm: z.literal(true),
  seed: z.enum(MAIN_MENU_RESET_SEEDS).default('DEFAULT'),
});
export type ResetMainMenuDraftRequest = z.input<typeof resetMainMenuDraftRequestSchema>;

/** Restore one revision INTO THE DRAFT. Never live: publishing it is a separate act. */
export const restoreMainMenuRevisionRequestSchema = z.object({
  idempotencyKey,
  expectedDraftVersion: z.number().int().positive().nullable(),
});
export type RestoreMainMenuRevisionRequest = z.infer<typeof restoreMainMenuRevisionRequestSchema>;

/** What every builder write answers: whether it changed anything, and the heads after it. */
export const mainMenuBuilderMutationResponseSchema = z.object({
  changed: z.boolean(),
  head: mainMenuBuilderHeadSchema,
});
export type MainMenuBuilderMutationResponse = z.infer<typeof mainMenuBuilderMutationResponseSchema>;

/** `?before=<revision>&limit=<n>`, newest first. */
export const mainMenuRevisionsQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(MAIN_MENU_REVISIONS_PAGE_MAX).default(20),
});
export type MainMenuRevisionsQuery = z.infer<typeof mainMenuRevisionsQuerySchema>;

export const mainMenuRevisionViewSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  /** Null when this release cannot read the snapshot (a later release wrote it). */
  layout: explicitMainMenuSchema.nullable(),
  createdAt: isoInstant,
  createdByAdminId: z.string().nullable(),
  restoredFrom: mainMenuRevisionRefSchema.nullable(),
});
export type MainMenuRevisionView = z.infer<typeof mainMenuRevisionViewSchema>;

export const mainMenuRevisionListResponseSchema = z.object({
  revisions: z.array(mainMenuRevisionViewSchema),
  /** The `before` for the next page, or null when this page reached revision 1. */
  nextBefore: z.number().int().positive().nullable(),
});
export type MainMenuRevisionListResponse = z.infer<typeof mainMenuRevisionListResponseSchema>;
