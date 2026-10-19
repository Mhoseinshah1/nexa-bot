# R4 PR-F — Telegram rich messages and the new Bot API features

Round 4, PR-F (`feat/r4-telegram-rich`). The owner's spec is §1 «PR-F», items F1–F8. This page
records what the Bot API documentation says (§1), what was built on it (§2–§4), and what was
not built and why (§5). Open questions are `OQ-R4F-*` in `docs/open-questions.md`.

## 1. API verification

**Source.** `core.telegram.org` is refused by this session's egress proxy (`CONNECT` 403, the
same block `docs/premium-ui-audit.md` §2 and `docs/support-agent/tb0-audit.md` record). The
reference was read instead from two verbatim copies of it, fetched from
`raw.githubusercontent.com` on 2026-10-19:

- `PaulSonOfLars/telegram-bot-api-spec` `api.json` — the machine-readable copy of
  `core.telegram.org/bots/api`, header "Bot API 10.3, August 24, 2026". Every method, type,
  field and description quoted below is from it, by its `#anchor`.
- `aiogram/aiogram` `CHANGES.rst` — for the version a feature arrived in. It cites each
  official changelog entry (`core.telegram.org/bots/api-changelog#<date>`).
- `grammyjs/types` `message.ts` — the "Formatting options" section, including "Date-time
  entity formatting", which `api.json` does not carry.

Nothing below is from memory, and nothing was resolved by guessing. A real-bot acceptance of
the rendering is still owed (`OQ-R4F-10`).

| #   | Fact asked                                                                                  | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                | Where                                                                                     |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | `sendRichMessage` exists, takes `rich_message: InputRichMessage` and `reply_markup`         | **CONFIRMED** — `reply_markup` accepts `InlineKeyboardMarkup`, `ReplyKeyboardMarkup`, `ReplyKeyboardRemove`, `ForceReply`; returns the sent `Message`                                                                                                                                                                                                                                                                  | `#sendrichmessage`; added Bot API 10.1 (June 11, 2026)                                    |
| 2   | `InputRichMessage` is html \| markdown \| blocks, with media and `is_rtl`                   | **CONFIRMED** — "Exactly one of the fields html, markdown, or blocks must be used"; `media`, `is_rtl`, `skip_entity_detection`. `html`/`markdown` arrived in 10.1, `blocks` and `media` in **10.2** (July 14, 2026), not 10.1                                                                                                                                                                                          | `#inputrichmessage`                                                                       |
| 3   | `InputRichBlockButtons` `{type:"buttons", buttons:[RichMessageButton], align}`, 1–8 per row | **CONFIRMED** — "A block containing a list of buttons that are shown in one row"; `buttons` "List of 1-8 buttons"; `align` left \| center \| right                                                                                                                                                                                                                                                                     | `#inputrichblockbuttons`; 10.3                                                            |
| 4   | `RichMessageButton.style`, `callback_data` 1–64 bytes                                       | **CONFIRMED** — style danger \| success \| primary \| **link** ("link" only for callback buttons); `callback_data` "1-64 bytes". Kinds: url, callback_data, web_app, login_url, switch_inline_query(_current_chat/_chosen_chat), copy_text, disabled. **No `icon_custom_emoji_id`, no `pay`, no `callback_game`**; `text` is a `RichText` that "May contain only plain text, RichTextCustomEmoji and RichTextDateTime" | `#richmessagebutton`; 10.3                                                                |
| 5   | `RichBlockTable.is_compact`                                                                 | **CONFIRMED** — "Pass True if table cells must have smaller indents" (also `is_bordered`, `is_striped`, `caption`)                                                                                                                                                                                                                                                                                                     | `#inputrichblocktable`; 10.3                                                              |
| 6   | Expandable quotations                                                                       | **CONFIRMED** — `InputRichBlockExpandableBlockQuotation` (`expandable_blockquote`), plus `InputRichBlockDetails` ("An expandable block for details disclosure", `summary`, `is_open`)                                                                                                                                                                                                                                  | `#inputrichblockexpandableblockquotation`, `#inputrichblockdetails`; 10.3 / 10.2          |
| 7   | Document block                                                                              | **CONFIRMED** — `InputRichBlockDocument` (`document: InputMediaDocument`); `tg://document?id=` media links                                                                                                                                                                                                                                                                                                             | `#inputrichblockdocument`; 10.3                                                           |
| 8   | `DisabledButton`                                                                            | **CONFIRMED** — "a disabled button which does nothing. Currently holds no information"; field `disabled` on both `RichMessageButton` and `InlineKeyboardButton`                                                                                                                                                                                                                                                        | `#disabledbutton`; 10.3                                                                   |
| 9   | `editMessageText` accepts `rich_message`                                                    | **CONFIRMED** — "Use this method to edit text, rich and game messages"; `rich_message` "New rich content of the message; required if text isn't specified"; `reply_markup` `InlineKeyboardMarkup`                                                                                                                                                                                                                      | `#editmessagetext`; 10.1                                                                  |
| 10  | Button `style` colours for all bots                                                         | **CONFIRMED** — `InlineKeyboardButton.style` / `KeyboardButton.style`: danger (red), success (green), primary (blue); no bot restriction stated                                                                                                                                                                                                                                                                        | `#inlinekeyboardbutton`; 9.4 (February 9, 2026)                                           |
| 11  | Custom emoji in bot messages only if the bot owner has Premium                              | **CONFIRMED** — 9.4: "Bots with Premium subscriptions can now use custom emoji directly in messages to private, group, and supergroup chats". The grammY copy of "Formatting options" still says "only … bots that purchased additional usernames on Fragment"                                                                                                                                                         | changelog 9.4; `#formatting-options`                                                      |
| 12  | Custom-emoji button icons follow the same rule                                              | **CONFIRMED** for the ordinary keyboards — `icon_custom_emoji_id` "Can only be used by bots that purchased additional usernames on Fragment or in the messages directly sent by the bot to private, group and supergroup chats if the owner of the bot has a Telegram Premium subscription". A `RichMessageButton` has no icon field at all                                                                            | `#inlinekeyboardbutton`, `#keyboardbutton`; 9.4                                           |
| 13  | The `date_time` entity                                                                      | **CONFIRMED** — `MessageEntity.type` "date_time" with `unix_time` and `date_time_format`; `RichTextDateTime` (`text`, `unix_time`, `date_time_format`); format `r\|w?[dD]?[tT]?`, and "If the format string is empty, the underlying text is displayed as-is; however, the user can still receive the underlying date in their local format"                                                                           | `#messageentity`, `#richtextdatetime`, "Date-time entity formatting"; 9.5 (March 1, 2026) |
| 14  | `sendMessageDraft` for all bots                                                             | **CONFIRMED** — "allowed for all bots" (9.5). Parameters: `chat_id` ("target **private** chat"), `draft_id`, `text`, `parse_mode`, `entities`, `can_stop`, `keep_on_stop` (10.3). **No `business_connection_id`.** `sendRichMessageDraft` (10.1) the same, with `rich_message`                                                                                                                                         | `#sendmessagedraft`, `#sendrichmessagedraft`                                              |

**The four questions.**

1. _Does a button inside a rich message deliver an ordinary `callback_query`?_ — The docs say
   `RichMessageButton.callback_data` is "Data to be sent in a callback query to the bot when the
   button is pressed", and `CallbackQuery.data` is "Data associated with the callback button".
   So the tap arrives as a `callback_query` carrying the same `data`, and routing — which reads
   only `data` — is the same. `CallbackQuery`'s own description still says "from a callback
   button in an inline keyboard", so whether `message` is present for a rich button is not
   stated (`OQ-R4F-09`).
2. _Do URL buttons and emoji icons work inside a buttons block?_ — URL: **yes**, `url` is a
   `RichMessageButton` kind (also `copy_text`). Icons: **not as a field** — `RichMessageButton`
   has no `icon_custom_emoji_id`; its `text` may contain a `RichTextCustomEmoji`, which needs an
   `alternative_text` emoji an operator-typed icon id does not have. Whether the Premium rule
   applies to custom emoji inside rich messages is not stated (`OQ-R4F-03`).
3. _How do old clients render a rich message?_ — **Not documented** (`OQ-R4F-01`). The docs
   describe no fallback rendering, so this PR relies on none.
4. _Can photo screens (receipt, QR) be rich messages?_ — A rich message may carry
   `InputRichBlockPhoto` / media through `sendRichMessage`, so a NEW photo screen could be one.
   But the receipt and QR screens are photo messages edited with `editMessageCaption`, and
   `editMessageText` edits "text, rich and game messages" only — a photo message cannot be
   edited into a rich one. Photo screens are therefore left exactly as they are.

## 2. F1 — one shared sender path

Every inline-keyboard screen already reaches Telegram through ONE class,
`TelegramCustomerMessenger` (`send` and `edit`); the seam is there, so no screen builder was
touched for F1. The bodies are built in one new pure module,
`apps/api/src/infrastructure/telegram/rich-message.ts`.

- **Switch.** `rich_messages` («دکمه‌های داخل پیام», «قابلیت‌ها»), default off, read per
  tenant through `RichMessageSupport.modeFor` (`container.ts`). A failed read is "off".
- **Which screens.** A ONE-part message with inline buttons and no reply keyboard
  (`send`), and every edit that carries buttons (`edit`); a failure while building the rich screen sends the ordinary message. The main menu (a reply keyboard), a message without
  buttons, a body over 4096 units and every file/photo send take the ordinary path, unchanged.
- **Off.** `richSend`/`richEdit` return before any request; the ordinary loop runs exactly as
  before. `tests/unit/telegram-messenger-rich.test.ts` sends every screen shape through a
  messenger without the seam and one with every switch off and compares the requests byte for
  byte, and pins the plan list's body literally; every existing messenger suite passes
  unchanged.
- **On.** `sendRichMessage` with `rich_message.blocks` and `is_rtl: true`; edits are
  `editMessageText` with `rich_message` (the keyboard always replaced, as before). Buttons are
  grouped by the SAME `telegramButtonMarkup`, so every route and style is the same bytes; a row
  with more than 8 buttons, or with a premium icon, or of a kind a `RichMessageButton` does not
  hold, stays WHOLE in `reply_markup.inline_keyboard` under the message — never dropped.
- **Text.** `blocks`, never the `html` field (whose dialect is on a page this build could not
  read, `OQ-R4F-04`). One paragraph per line; `•` lines become a list; a rule line a divider;
  per-key layouts make the list headings a heading and fold the rules and the connection guides
  into a `details` block (`RICH_SCREEN_LAYOUTS`). Anything not converted EXACTLY — an unknown
  tag or entity, a tag across lines — sends the ordinary message, with no request and no log.
- **Fallback.** A definite refusal (4xx) of the rich request → the screen is sent once more the
  ordinary way, byte for byte as with the switch off, and ONE operational event is written:
  `telegram.rich_message_refused`, ERROR, WINDOW-deduplicated per bot per hour
  (`opsAggregationKey`), routed to the ERRORS topic. A timeout, 5xx, unreadable answer or 429 is
  the message's answer and is never resent — the rule every send in the messenger keeps. "Message
  is not modified" on a rich edit is success.
- **Routing.** The test extracts every `callback_data`, `url` and `copy_text` from both modes'
  requests for every screen shape and requires them equal.

## 3. F2–F6, F8

- **F2 tables and structure.** The plan list is a compact, bordered, striped table — name |
  traffic | days | price — above the plan buttons, built from `planFacts` the plan buttons now
  carry (`bot-runtime.ts` `categoryPage`, one field). Headings and cells are template keys
  (`bot.catalog.table_*`) except the plan name (tenant data) and the price (`formatMoney`).
  Headings, lists, dividers and details blocks as in §2.
- **F3 premium emoji.** `rich_premium_emoji` («ایموجی پریمیوم»), default off, inert without
  `rich_messages`. On, and only for a bot whose appearance test answered `SENT`, a slot marker is
  a `RichTextCustomEmoji` with the plain emoji as `alternative_text`; otherwise the plain emoji.
  An ordinary message is decorated exactly as before, by the appearance test alone — the switch
  changes nothing outside rich messages, which is what keeps "all switches off" byte-identical.
  A refusal falls back to the ordinary send (with its own one undecorated retry), so a refused
  premium emoji never costs the screen. A missing render cannot be detected (`OQ-R4F-03`).
- **F4 colours.** `INLINE_BUTTONS[*].suggestedStyle` — success = pay/confirm, danger =
  cancel/destructive confirm, primary = main action. `defaultStyle` stays `default` for every
  button, so an upgrade changes no keyboard. «رنگ‌های پیشنهادی (n)» in the inline-button builder
  fills the draft for every button still at the default (an operator's choice is never
  replaced); nothing is written until Save, the ordinary versioned, audited setting write. The
  colours reach the rich buttons unchanged.
- **F6 `date_time`.** `renderTemplateBody({ markInstants })` wraps each `DATETIME`/`DATE` value
  in three private-use marks; `TemplateResolver.renderWithInstants` renders the plain and the
  marked text from ONE resolution. In a rich message each marked date is a `RichTextDateTime`
  over exactly the text the customer reads, with an empty format — "displayed as-is", the
  tenant's own calendar kept, the instant attached for the client (`OQ-R4F-06`). Every date, not
  only expiry; the ordinary message is unchanged.
- **F8 preview.** The inline-button builder shows where the buttons sit under the tenant's two
  switches — under the message (off), inside the bubble (on), an iconed button kept under the
  message while premium emoji are on — with the real labels and styles, and no sample text.

## 4. Decisions taken without asking

- `rich_premium_emoji` governs rich messages only (see F3): a switch default-off that also
  turned off the existing appearance decoration would have changed every decorated tenant's
  messages, against "all switches off → byte-identical".
- An inline button with a premium icon stays in the inline keyboard while rich messages are on
  and premium emoji are on: the block has no icon field, and the spec forbids dropping it.
- Only one-part screens are sent rich; rich-message size limits are undocumented (`OQ-R4F-05`).
- `is_rtl: true` on every rich message: the customer text is Persian.
- Tables are drawn for the plan list only. The service card, wallet history, invoice and the
  reseller tier price list (PR-G) would mean editing screens PR-A and PR-G are rewriting at the
  same time; the table builder is ready for them (`richTableBlock`).

## 5. Not built, and why

- **F5 `DisabledButton`.** The reference says it "does nothing". The spec asks that "pressing
  one explains why" — which a disabled button cannot do. Today an unavailable action is either
  hidden or (the wallet button) explains itself on press, which is the behaviour asked for.
  No switch was added for it: a flag that turns nothing on is a dead switch (`features.ts`).
  `OQ-R4F-07`.
- **F7 streaming drafts.** `sendMessageDraft` / `sendRichMessageDraft` take a private `chat_id`
  and no `business_connection_id`; the AI support assistant answers inside Telegram Business
  chats, on behalf of the business account. Its provider port is one request and one answer
  (`SupportAiAdapter.generate`), so a "stream" would be a fabricated animation of an answer
  already complete. `OQ-R4F-08`.
- **F2 collage/slideshow for tutorials.** The tutorials are video and photo messages
  (`sendFile`), the screens §1 Q4 leaves unchanged.
