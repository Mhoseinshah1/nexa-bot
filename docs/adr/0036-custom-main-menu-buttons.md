# ADR 0036 — Owner-defined main-menu buttons, and why the layout became version 2

**Status: accepted (R10 D2).** The ADR number is provisional and is renumbered at merge
with the migration (`0282`/`0283` in this branch) if another PR claims it first.

## Context

The owner asked for buttons of his own on the customer main menu, added from the Web Admin:
a **link** that opens a URL, or **content** (a stored text, photo or document) that the bot
sends. They must be placed through the existing button builder (order, on/off, style), be
shown per bot, ship disabled behind a feature flag, and refuse bad input in Persian.

Three facts about the existing menu decide the shape of the answer:

- The registry (`MAIN_MENU_BUTTONS`) is **closed**, and the builder's explicit layout is `v: 1`,
  `.strict()`, with rows of `z.enum(MAIN_MENU_BUTTON_IDS)`. A custom button cannot be a row item
  of it, and the v1 schema is what a rolled-back release parses.
- The main menu is a **reply keyboard**. A tap sends the label back as TEXT and can open
  nothing, so a link button has to answer with a message that carries an inline URL button.
- `bot.main_menu` is the compatibility projection a publish rewrites for the previous release,
  and it must keep parsing under the frozen schema.

## Decision

1. **A custom button is a row in its own tables**, never a registry entry: `custom_menu_buttons`
   (archived, never deleted — a trigger refuses the DELETE), `custom_menu_button_bots` (which bots
   show a `SELECTED` button, tenant-scoped foreign keys to the button and to `bot_instances`) and
   `custom_menu_button_media` (the file as BYTES).
2. **The layout places it by reference, `custom:<uuid>`, in a `v: 2` layout.** `explicitMainMenuSchema`
   (v1) is untouched. `normalizeExplicitMainMenu` decides the version a layout is WRITTEN as: a
   layout that places no custom button is v1 whatever the editor held. A tenant that never uses the
   feature never has a v2 value, so a rollback changes nothing for it. A v2 head read by an older
   release is "published unreadable": the keyboard falls back to the projection (registry buttons,
   same order and visibility, no styles) and records `bot_menu.published_unreadable`. That is the
   documented degrade; the release notes of D2 say so. `legacyProjectionOf` never names a custom
   button.
3. **A custom button is always gated** — by the flag `custom_menu_buttons`, by not being archived
   and by the sending bot — so it never satisfies "one placed, enabled, ungated button": a layout
   whose only enabled button is custom is refused.
4. **Per-bot is a visibility rule, evaluated like a gate** (`customMenuButtonVisible`), by the
   server, for the SENDING bot, shared by the runtime and the Web Admin's preview
   (`customerRowsOf` takes `customVisibleById`).
5. **Routing.** A custom label maps to the VALUE `mb:<uuid>` in the label map (never a slash
   command). `intentOf` tests the map's value, not the typed text, so typed `mb:<uuid>` reaches
   nothing. A registry label wins a collision, and a custom label never takes over a label the
   shared table already routes (an older default label, the management panel's).
6. **A route is not authority.** The tap asks `CustomMenuButtonRuntime.forTap` again: flag on,
   button not archived, shown on this bot, and placed with its switch on in the PUBLISHED layout.
   Anything else is `bot.custom_button.unavailable`. A tap writes no order, ledger or notification.
7. **Content is stored as bytes, never as a Telegram `file_id`** (it belongs to one bot). The
   allow-list is support's (`TICKET_REPLY_FILE_TYPES`), built into the table's CHECK; every send is a
   multipart upload. Limits: 20 buttons, label 64, text 4096, caption 1024, 50 MB of media per
   tenant. Archiving deletes the file.
8. **A link is validated by the existing https-only grammar** (`normalizeClientAppUrl`) and stored
   normalised. The operator's text is a VALUE of a PLAIN_TEXT template, so no markup is interpreted.

## Rejected

- Adding custom ids to `MAIN_MENU_BUTTON_IDS`: it is a closed registry, and widening it widens the
  rolled-back release's parser of its own snapshots.
- Writing custom buttons into `bot.main_menu`: its entries are `.strict()`; a new field makes the
  previous release draw the default keyboard.
- A per-bot `file_id` cache: fewer uploads, but a second source of truth that can go stale
  (open question 2 below).

## Open questions (defaults move no money and send no unsolicited message)

1. Rollback after a v2 publish draws the projection. Accepted and documented; a pre-rollback
   "unpublish custom" step is the alternative.
2. A per-bot `file_id` cache. Default: none; the anti-spam counter already bounds re-uploads.
3. Schemes beyond https (`tg://`, `http://`). Default: refused.
4. The size caps (20 buttons, 50 MB). Default: the ticket-file bounds; owner to confirm.
5. Gates on a custom tap (membership, terms, captcha). Default: the tap goes through `guardedAct`
   like every customer intent, with no exemption.
6. A registry label renamed later onto a custom label makes the custom one unreachable: the registry
   wins and the builder warns. No automatic rename.
7. The legacy `/bot-menu` table (`BotMenuService`) does not list custom buttons; the builder is
   their only editor.
