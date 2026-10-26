import { z } from 'zod';
import { normalizeClientAppUrl } from './client-apps.js';
import { directMessageFileSchema } from './direct-messages.js';
import { normalizeTicketText } from './tickets.js';

/**
 * R10 D2 — owner-defined main-menu buttons.
 *
 * The owner adds buttons of his own to the customer's main menu from the Web Admin and
 * places them with the existing button builder (`bot-menu-builder.ts`):
 *
 * - **LINK** opens an https address. The main menu is a REPLY keyboard, whose tap sends the
 *   button's label back as text and can open nothing, so a link button answers with a message
 *   carrying one inline URL button (`custom.link_open`).
 * - **TEXT**, **PHOTO** and **DOCUMENT** send stored content. The text is the operator's, the
 *   photo or document is stored as bytes (never as a Telegram `file_id`, which belongs to one
 *   bot) under support's own allow-list, and every send is a multipart upload.
 *
 * ## Where a button lives
 *
 * In its own tables, never in `bot.main_menu` or in the registry (`MAIN_MENU_BUTTONS` is
 * closed). The layout names it by a reference, `custom:<uuid>`, and a layout that places one is
 * written as `v: 2` (`bot-menu-builder.ts`); one that places none is still `v: 1`.
 *
 * ## Per-bot
 *
 * A button is shown on ALL of a tenant's bots or on SELECTED ones. That is a visibility rule,
 * evaluated for the SENDING bot like a gate: a custom button is always gated (by the feature
 * flag `custom_menu_buttons`, by not being archived and by the bot), so it can never be the
 * button that keeps a keyboard non-empty.
 *
 * ## Routing
 *
 * A custom label routes to the VALUE `mb:<uuid>` in the label map (`customMenuRouteValue`).
 * The runtime tests the map's value, never the typed text, so a customer typing `mb:<uuid>`
 * reaches nothing. A route is not authority: the tap asks the server again (flag, archive,
 * bot, published layout) and answers `bot.custom_button.unavailable` when any of them says no.
 */

export const CUSTOM_MENU_BUTTON_KINDS = ['LINK', 'TEXT', 'PHOTO', 'DOCUMENT'] as const;
export type CustomMenuButtonKind = (typeof CUSTOM_MENU_BUTTON_KINDS)[number];

/** Which of the tenant's bots draw the button. */
export const CUSTOM_MENU_BOT_SCOPES = ['ALL', 'SELECTED'] as const;
export type CustomMenuBotScope = (typeof CUSTOM_MENU_BOT_SCOPES)[number];

/** How many active (not archived) custom buttons a tenant may have. A rail, not a Telegram bound. */
export const CUSTOM_MENU_BUTTONS_MAX = 20;
/** A label, in code points. Telegram's bound for a keyboard button's text is far larger. */
export const CUSTOM_MENU_LABEL_MAX = 64;
/** A TEXT button's message, or a LINK button's optional note, in code points (Telegram's bound). */
export const CUSTOM_MENU_TEXT_MAX = 4096;
/** A photo's or document's caption, in code points (Telegram's bound). */
export const CUSTOM_MENU_CAPTION_MAX = 1024;
/** The most bytes of media one tenant keeps for custom buttons (the live files, not replaced ones). */
export const CUSTOM_MENU_STORAGE_MAX_BYTES = 50 * 1024 * 1024;
/** The most bots one button can name. */
export const CUSTOM_MENU_BOTS_MAX = 100;

// --- References and routes --------------------------------------------------------------

/** The prefix of a custom button's reference in a layout. */
export const CUSTOM_MENU_REF_PREFIX = 'custom:';
const UUID_SHAPE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CUSTOM_MENU_REF_PATTERN = new RegExp(`^${CUSTOM_MENU_REF_PREFIX}(${UUID_SHAPE})$`, 'u');
const CUSTOM_MENU_ROUTE_PATTERN = new RegExp(`^mb:(${UUID_SHAPE})$`, 'u');

/** A custom button as a layout names it: `custom:` and the button's id, lowercase. */
export type CustomMenuRef = `custom:${string}`;

export const customMenuRefSchema = z
  .string()
  .regex(CUSTOM_MENU_REF_PATTERN, 'must be custom:<uuid>')
  .transform((value) => value as CustomMenuRef);

export function isCustomMenuRef(value: unknown): value is CustomMenuRef {
  return typeof value === 'string' && CUSTOM_MENU_REF_PATTERN.test(value);
}

export function customMenuRefOf(id: string): CustomMenuRef {
  return `${CUSTOM_MENU_REF_PREFIX}${id.toLowerCase()}`;
}

/** The button id a reference names, or null when `value` is not a reference. */
export function customMenuIdOfRef(value: string): string | null {
  return CUSTOM_MENU_REF_PATTERN.exec(value)?.[1] ?? null;
}

/**
 * The VALUE a custom label maps to in the runtime's label table. It never starts with `/`,
 * so it cannot be mistaken for the slash command a registry label maps to.
 */
export function customMenuRouteValue(id: string): string {
  return `mb:${id.toLowerCase()}`;
}

/** The button id a route VALUE names, or null for anything else (a command, a typed string). */
export function customMenuIdOfRoute(value: string | undefined): string | null {
  if (value === undefined) return null;
  return CUSTOM_MENU_ROUTE_PATTERN.exec(value)?.[1] ?? null;
}

// --- Text -------------------------------------------------------------------------------

/**
 * A label as stored: trimmed, one line, no control character, 1..`CUSTOM_MENU_LABEL_MAX`
 * code points, and NOT reading as a slash command (a tap on `/start` would be indistinguishable
 * from `/start`). `null` when it is not acceptable.
 */
export function normalizeCustomMenuLabel(raw: unknown): string | null {
  const text = normalizeTicketText(raw);
  if (text === null || text.includes('\n') || text.includes('\t')) return null;
  if (text.startsWith('/')) return null;
  return Array.from(text).length <= CUSTOM_MENU_LABEL_MAX ? text : null;
}

/** A message or caption as stored, within `max` code points; `null` when empty or too long. */
export function normalizeCustomMenuBody(raw: unknown, max: number): string | null {
  const text = normalizeTicketText(raw);
  if (text === null) return null;
  return Array.from(text).length <= max ? text : null;
}

/** A link as stored: the strict https-only grammar shared with the client apps. */
export function normalizeCustomMenuUrl(raw: unknown): string | null {
  return typeof raw === 'string' ? normalizeClientAppUrl(raw) : null;
}

// --- Visibility -------------------------------------------------------------------------

/** What the keyboard needs to know about one button to decide whether to draw it. */
export interface CustomMenuVisibilityInput {
  readonly archivedAt: string | Date | null;
  readonly botScope: CustomMenuBotScope;
  readonly botInstanceIds: readonly string[];
}

/**
 * Whether a custom button is drawn for a bot — THE rule the runtime and the Web Admin's
 * preview share. `featureEnabled` is the flag `custom_menu_buttons`; `botInstanceId` is the
 * SENDING bot, or null for a view that names none (the builder's tenant-wide `live` rows),
 * which then ignores the bot filter.
 */
export function customMenuButtonVisible(
  button: CustomMenuVisibilityInput,
  featureEnabled: boolean,
  botInstanceId: string | null,
): boolean {
  if (!featureEnabled) return false;
  if (button.archivedAt !== null) return false;
  if (botInstanceId === null || button.botScope === 'ALL') return true;
  return button.botInstanceIds.includes(botInstanceId);
}

/** Whether each custom reference is drawn now — the server's answer, never a reader's own. */
export type CustomMenuVisibleById = Readonly<Record<string, boolean | null | undefined>>;

// --- Audit, errors, routes --------------------------------------------------------------

export const CUSTOM_MENU_BUTTON_AUDIT_ACTIONS = {
  CREATED: 'bot_menu.custom_button_created',
  UPDATED: 'bot_menu.custom_button_updated',
  ARCHIVED: 'bot_menu.custom_button_archived',
  MEDIA_SET: 'bot_menu.custom_button_media_set',
} as const;
export const CUSTOM_MENU_BUTTON_AUDIT_ENTITY = 'CustomMenuButton';

export const CUSTOM_MENU_BUTTON_ERROR_CODES = {
  /** Another active button, or a registry button as this tenant renders it, has that label. */
  LABEL_TAKEN: 'custom_menu_button.label_taken',
  /** Empty, too long, multi-line, or reading as a slash command. */
  LABEL_INVALID: 'custom_menu_button.label_invalid',
  /** Not an https:// link to a named host (userinfo, an IP, `http:`, `tg:` ... are refused). */
  URL_INVALID: 'custom_menu_button.url_invalid',
  /** The text or caption is empty where the kind needs one, or over its bound. */
  CONTENT_INVALID: 'custom_menu_button.content_invalid',
  /** The file is not on the allow-list, too large, misnamed or not what it says. */
  FILE_REFUSED: 'custom_menu_button.file_refused',
  /** The tenant already holds `CUSTOM_MENU_STORAGE_MAX_BYTES` of button media. */
  STORAGE_FULL: 'custom_menu_button.storage_full',
  /** The tenant already has `CUSTOM_MENU_BUTTONS_MAX` active buttons. */
  LIMIT_REACHED: 'custom_menu_button.limit_reached',
  /** No such button in this tenant, or it is archived and cannot be changed. */
  UNKNOWN_BUTTON: 'custom_menu_button.unknown_button',
  /** A layout places a button that is unknown to this tenant or archived. */
  ARCHIVED_IN_LAYOUT: 'custom_menu_button.archived_in_layout',
  /** A selected bot is not one of this tenant's bots. */
  BOT_INVALID: 'custom_menu_button.bot_invalid',
} as const;

export const CUSTOM_MENU_BUTTON_ROUTES = {
  list: '/bot-menu/custom-buttons',
  create: '/bot-menu/custom-buttons',
  updatePattern: '/bot-menu/custom-buttons/:id',
  update: (id: string) => `/bot-menu/custom-buttons/${encodeURIComponent(id)}`,
  archivePattern: '/bot-menu/custom-buttons/:id/archive',
  archive: (id: string) => `/bot-menu/custom-buttons/${encodeURIComponent(id)}/archive`,
  mediaPattern: '/bot-menu/custom-buttons/:id/media',
  media: (id: string) => `/bot-menu/custom-buttons/${encodeURIComponent(id)}/media`,
} as const;

// --- HTTP -------------------------------------------------------------------------------

const idempotencyKey = z.string().min(8).max(255);
const botIds = z.array(z.uuid()).max(CUSTOM_MENU_BOTS_MAX);

/**
 * `POST /bot-menu/custom-buttons`. The KIND is fixed at creation: a LINK has `url`, a TEXT has
 * `body`, a PHOTO or DOCUMENT has `file` (and `body` as its optional caption). The server
 * judges every field against the kind and answers a coded Persian-mapped error.
 */
export const createCustomMenuButtonRequestSchema = z
  .object({
    idempotencyKey,
    label: z.string().max(CUSTOM_MENU_LABEL_MAX * 4),
    kind: z.enum(CUSTOM_MENU_BUTTON_KINDS),
    url: z.string().max(4096).nullable().default(null),
    body: z
      .string()
      .max(CUSTOM_MENU_TEXT_MAX * 4)
      .nullable()
      .default(null),
    botScope: z.enum(CUSTOM_MENU_BOT_SCOPES).default('ALL'),
    botInstanceIds: botIds.default([]),
    file: directMessageFileSchema.nullable().default(null),
  })
  .strict();
export type CreateCustomMenuButtonRequest = z.input<typeof createCustomMenuButtonRequestSchema>;

/** `PATCH /bot-menu/custom-buttons/:id`. Only what is given changes; the kind never does. */
export const updateCustomMenuButtonRequestSchema = z
  .object({
    idempotencyKey,
    expectedVersion: z.number().int().positive(),
    label: z
      .string()
      .max(CUSTOM_MENU_LABEL_MAX * 4)
      .optional(),
    url: z.string().max(4096).nullable().optional(),
    body: z
      .string()
      .max(CUSTOM_MENU_TEXT_MAX * 4)
      .nullable()
      .optional(),
    botScope: z.enum(CUSTOM_MENU_BOT_SCOPES).optional(),
    botInstanceIds: botIds.optional(),
  })
  .strict();
export type UpdateCustomMenuButtonRequest = z.input<typeof updateCustomMenuButtonRequestSchema>;

/** `POST /bot-menu/custom-buttons/:id/archive`. Archived is final: the row stays for the revisions. */
export const archiveCustomMenuButtonRequestSchema = z
  .object({ idempotencyKey, expectedVersion: z.number().int().positive() })
  .strict();
export type ArchiveCustomMenuButtonRequest = z.input<typeof archiveCustomMenuButtonRequestSchema>;

/** `PUT /bot-menu/custom-buttons/:id/media`. Replaces a PHOTO or DOCUMENT button's file. */
export const setCustomMenuButtonMediaRequestSchema = z
  .object({
    idempotencyKey,
    expectedVersion: z.number().int().positive(),
    file: directMessageFileSchema,
  })
  .strict();
export type SetCustomMenuButtonMediaRequest = z.input<typeof setCustomMenuButtonMediaRequestSchema>;

export const customMenuButtonViewSchema = z.object({
  id: z.string(),
  /** `custom:<id>`, what a layout names it by. */
  ref: z.string(),
  label: z.string(),
  kind: z.enum(CUSTOM_MENU_BUTTON_KINDS),
  url: z.string().nullable(),
  /** The TEXT message, the caption of a PHOTO or DOCUMENT, or a LINK's optional note. */
  body: z.string().nullable(),
  botScope: z.enum(CUSTOM_MENU_BOT_SCOPES),
  botInstanceIds: z.array(z.string()),
  media: z
    .object({
      fileName: z.string(),
      mimeType: z.string(),
      byteLength: z.number().int().nonnegative(),
    })
    .nullable(),
  version: z.number().int().positive(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CustomMenuButtonView = z.infer<typeof customMenuButtonViewSchema>;

export const customMenuButtonListResponseSchema = z.object({
  /** The flag `custom_menu_buttons`: off means nothing here is drawn on any keyboard. */
  featureEnabled: z.boolean(),
  buttons: z.array(customMenuButtonViewSchema),
  storage: z.object({
    usedBytes: z.number().int().nonnegative(),
    maxBytes: z.number().int().positive(),
  }),
});
export type CustomMenuButtonListResponse = z.infer<typeof customMenuButtonListResponseSchema>;

/** What a write answers: whether it changed anything, and the button after it. */
export const customMenuButtonMutationResponseSchema = z.object({
  changed: z.boolean(),
  button: customMenuButtonViewSchema,
});
export type CustomMenuButtonMutationResponse = z.infer<
  typeof customMenuButtonMutationResponseSchema
>;
