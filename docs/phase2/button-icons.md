# Phase 2 UX wave: Items 1 and 3, bot button layout and premium button icons

This document covers the owner's master prompt of 2026-10-05, Phase 2, Item 1 (button layout and
reordering) and Item 3 (premium custom emoji on bot buttons). Branch `phase2/a-button-icons`.

## Item 1: button layout and reordering, verified rather than rebuilt

The main-menu (reply keyboard) builder from round T already does what Item 1 asks:

- rows, with drag and keyboard reordering;
- a draft, publish, reset and restore lifecycle;
- revisions and audit;
- per-tenant storage;
- a legacy projection.

See `docs/round-t-button-builder-audit.md`. Nothing was rebuilt. Each Item 1 requirement maps to
existing code and tests as follows:

| Requirement (master prompt)                   | Where it holds                                                                                                                                | Test                                                                                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The saved order renders exactly               | `customerRowsOf` is the one rendering rule, used by both the runtime (`MainMenuLayout.keyboardFor`) and the Web preview                       | NEW: `main-menu-layout.test.ts` › "Item 1 (Phase 2): for 300 generated layouts…". Also `telegram-reply-keyboard.test.ts` (the exact rows on the wire). |
| Row and column placement                      | `explicitMainMenuSchema.rows`. Nothing reflows: a hidden button leaves its row shorter                                                        | `bot-menu-builder-contracts.test.ts` › `customerRowsOf`; `bot-menu-builder.test.ts` › publish                                                          |
| The legacy default stays stable               | With nothing published, the LEGACY path is byte for byte the same; `explicitFromLegacy` uses the same packing                                 | `main-menu-layout.test.ts` › "a LEGACY answer…"; `bot-menu-builder-contracts.test.ts` (500 generated legacy values)                                    |
| Callbacks and routing are unchanged           | A reply button routes by its label (`routesFor`). The layout never touches a route                                                            | `telegram-reply-keyboard.test.ts` › R-3                                                                                                                |
| Invalid or conflicting placements are refused | The schema refuses a button placed twice, an empty row, an over-long layout, and a layout with no enabled, ungated button                     | `bot-menu-builder-contracts.test.ts`                                                                                                                   |
| Tenant-aware; saved atomically; audited       | `main_menu_layouts` is keyed by tenant. A publish is one transaction writing the projection, the revision, the audit row and the outbox entry | `bot-menu-builder.test.ts`                                                                                                                             |

**Deferred, by PO decision: INLINE («شیشه‌ای») keyboard ordering.** It is recorded as
`OQ-P2-ICON-04` in `docs/open-questions.md`. Inline keyboards are contextual screens whose rows
are product logic, so no generic inline layout system was built. The PO must name the screens
that should become orderable.

## Item 3: premium custom emoji on bot buttons

### What Telegram supports (and so all that is built)

The evidence is the published types in `@grammyjs/types` (`markup.d.ts`), because
`core.telegram.org` answers 403 through this sandbox's proxy. Both `KeyboardButton` and
`InlineKeyboardButton` have:

- `icon_custom_emoji_id`: "Unique identifier of the custom emoji shown **before** the text of
  the button". It can be used only by bots that purchased additional usernames on Fragment, or
  in messages the bot sends directly to private, group and supergroup chats when the bot's
  owner has a Telegram Premium subscription.
- `style`: `danger`, `success` or `primary` (already in use since round T).

So:

1. **One icon per button, shown before the text.** There is no "after" position on a button.
2. **Button text carries no entities.** A premium emoji can never be put inside a label. A
   `{icon:slot}` marker typed into a button's label template is still drawn as its plain
   fallback emoji (`labelText`), exactly as before.
3. **Only an eligible bot may send one.** Nexa decides this per BOT INSTANCE from its own
   appearance test (`isCustomEmojiEligible`: a recorded `SENT`), never per tenant. Every other
   bot draws the same button without the icon.

What is still UNVERIFIED, and owed as a real-bot acceptance (`OQ-P2-ICON-01`):

- how a real client renders an icon on an INLINE button;
- the exact refusal an ineligible bot receives (the same open point as `OQ-T-API-05`);
- the tap behaviour of an iconed inline button.

The tests run against a stub and the repository's fake, so they can only prove that this code
agrees with itself.

### Main menu (reply keyboard): the retirement lifted

The 2026-10-02 retirement (`round-t-button-builder-audit.md` §16) is **superseded** by the
2026-10-05 master prompt (§16.4). The model is round T's, unchanged: `iconSlot`, an appearance
SLOT whose custom emoji the tenant configured in «ظاهر ربات».

- **Contracts.** `normalizeExplicitMainMenu` carries `iconSlot` instead of forcing it to null.
  `CustomerMainMenuButton` and `customerRowsOf` carry it again.
- **Runtime.** `MainMenuLayout.keyboardFor` passes the slot. `replyKeyboardFor` resolves it
  against the SENDING bot's decoration. The one icon-less retry and owner rule B5 work as in
  round T §15.
- **Web.** The Inspector's «آیکون دکمه» is optional; «بدون آیکون» is the default and the way
  to remove an icon. The Inspector also shows:
  - the list of bots that will show the icon;
  - the doubled-emoji warning;
  - whether the chosen slot has a custom emoji configured;
  - a dashed marker in every preview, which is never a fake of the custom emoji.
- **No schema change.** `iconSlot` never left the strict snapshot schema, so either release
  reads what the other wrote. The consequence for layouts published before 2026-10-02 is
  recorded in `OQ-P2-ICON-05`.

### Inline buttons: new

#### Setting

`bot.inline_button_icons` is a new settings key, keyed like `bot.inline_buttons`:

- Its value is a partial record from a registry key to a **custom emoji id**, validated by
  `customEmojiIdSchema` (digits only, 1 to 32).
- It is versioned, audited (`settings.set`), announced (`SettingChanged`), tenant-scoped, and
  requires `settings.edit`.
- It is NOT a widening of `bot.inline_buttons`. That value is parsed strictly by the previous
  release, and a test pins that it still refuses an id.
- The Web Admin accepts Persian (۰-۹) and Arabic-Indic (٠-٩) digits and stores them as ASCII.
- Why the contract commit `725a71ee` also touches two Web files (review N5): the Web's settings
  presentation map (`apps/web/src/settings-presentation.ts`) is TOTAL over the registry, so a
  new key does not typecheck without its entry and two strings. They went into the same commit
  to keep every commit buildable; nothing else of the Web is in it.

#### Transport API (`apps/api/src/infrastructure/telegram/send-message.ts`)

Agent B (category icons) builds on this:

- **`TelegramButton.iconCustomEmojiId?: string`.** `telegramButtonMarkup` writes it as
  `icon_custom_emoji_id`, beside the unchanged `text`, `callback_data`, `url` or `copy_text`,
  and `style`. An empty string is never sent.
- **`buttonsHaveIcons(buttons)`.** Says whether a keyboard owes the one icon-less retry.
- **`withoutButtonIcons(buttons)`.** Returns the retry's keyboard: every icon dropped, and
  everything else kept, the route included.

A caller sets `iconCustomEmojiId` only after resolving it for the SENDING bot's eligibility. In
the messenger that is `labelButtons(scope, buttons, decoration)`, which checks
`mayCarryCustomEmoji(decoration)`. A new icon source needs only to resolve an id there. The
retry is already wired into `send`, `edit`, `editCaption` and `sendFile`.

#### Runtime (`telegram-customer-messenger.ts`)

- `labelButtons` reads `bot.inline_button_icons` once per keyboard. It reads it only when the
  keyboard names a registry button AND the sending bot may carry custom emoji.
- An iconed keyboard counts as decorated in `deliverDecorated`. A definite 4xx is answered by
  exactly ONE retry, which carries the same text, labels, styles and routes without the icons.
  - **An inline icon NEVER switches the bot's eligibility off**, whatever the refusal says
    (review B1 of PR #215). The id was typed by an operator and checked for shape only; the
    appearance probe never sends it, so `CUSTOM_EMOJI_INVALID` may only mean a wrong id.
    Marking the bot REJECTED for it would have turned off every text decoration and main-menu
    icon of that bot, a re-test would have turned them back on, and the next message would
    have flipped it again. The messenger tells the two kinds apart (`IconSource`: `SLOT` for
    reply-keyboard icons from the proven appearance slots, `RAW` for inline ids). The operator
    is told under the existing `telegram.appearance_decoration_failed` condition, with
    `keyboardIcons: true`, `iconSource: 'RAW'`, `eligibilityChanged: false` and the inline keys
    whose icons were dropped.
  - Reply-keyboard (`SLOT`) icons keep owner rule B5: a refusal naming custom emoji
    (`isCustomEmojiDenial`) switches the bot off; a generic 400 does not.
  - A consequence (review N4): a message that carries an inline icon AND decorated text
    teaches the bot's state nothing from its refusal. A text-decoration refusal — even one the
    classifier would recognise — no longer switches the bot off when the same message carries
    an inline icon; that message costs one retry instead.
  - UNKNOWN (a timeout, a 5xx, an unreadable 2xx) and 429 are never resent.
- `sendMediaGroup` carries no buttons, so it is unchanged.

#### Web (`bot-buttons/inline-buttons.tsx`)

Each row has an optional «آیکون پریمیوم» field next to the colour:

- it reads «بدون آیکون» when empty, and has a «حذف آیکون» button;
- digits are validated before save, and an invalid id is refused with its reason and blocks
  the save;
- the preview shows a dashed marker before the label;
- a stated-limits line sits above the list.

The section's save writes only what changed (review N1 of #215: each setting has its own
idempotency key fingerprinted by its own command; when the colours land and the icons are
refused, the draft adopts the colours' new version, the operator reads «رنگ‌ها ذخیره شد، اما
آیکون‌ها ذخیره نشد», and the next click sends only the icons). Styles and icons are two settings, so they are
two writes, each with its own expected version and its own idempotency key, derived from the
one submission. An unreadable stored icon value is announced, and a save repairs it.

### Tests

- **Contracts:**
  - `tests/unit/bot-menu-builder-contracts.test.ts`: the icon restored;
  - `tests/unit/inline-buttons-contract.test.ts`: the new setting, invalid ids, the unwidened
    `bot.inline_buttons`.
- **Unit:** `tests/unit/telegram-inline-button-icons.test.ts` covers:
  - the descriptor;
  - eligible versus untested bot;
  - routes byte for byte;
  - a removed icon gives the legacy markup byte for byte;
  - denial, generic 400, refused twice, UNKNOWN and 429;
  - edit, caption edit, file.

  `tests/unit/main-menu-layout.test.ts` adds the Item 1 property and the icon slot drawn.

- **Integration:**
  - `tests/integration/telegram-reply-keyboard.test.ts`. Reply keyboard: icon only from the
    eligible bot, R-3 routing, R-4 denial, generic 400, R-5 UNKNOWN. Inline icons end to end:
    eligible bot only, never another tenant, routes unchanged, removal, invalid ids refused
    and audited, denial then retry.
  - `tests/integration/bot-menu-builder.test.ts`: stored, published and removed icons.
- **Web:**
  - `tests/web/bot-buttons-builder.test.tsx`: the icon control, eligibility, removal, the
    doubled-emoji warning, the live preview;
  - `tests/web/inline-buttons.test.tsx`: optional, save, invalid, remove, two writes,
    permission, repair.
- **Falsification:** `docs/phase2/button-icons-falsification.md`, driven by
  `scripts/mutate-p2-button-icons.py`.
