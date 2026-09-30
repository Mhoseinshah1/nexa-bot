# Premium UI — custom emoji and the bot's appearance: audit and design

Round P, package PREMIUM-UI. Branch `claude/p-ui`, from `39c5d53` (the head of
`claude/n-f-campaigns`, which carries `main` at `9758ce2` plus #117 and #118).

This document records four things: how text reached Telegram before this package
(§1), what the Bot API documents about custom emoji and which of its two encodings is
used and why (§2), each design decision (§3–§7), and the tests and the mutation
evidence that hold each rule (§8).

---

## 1. How text reached Telegram at `39c5d53`

**One transport.** `apps/api/src/infrastructure/telegram/send-message.ts` is the one
`sendMessage` this installation makes (`telegramSend` over `telegramCall`): abort
timeout, `redirect: 'error'` because the token is in the path, the retryable/permanent
taxonomy, a 429 honoured with `retry_after`. Bodies are built by named builders in the
same file — `textMessageBody`, `editMessageBody`, `fileMessageBody`, `fileUploadBody`,
`editCaptionBody`, `mediaGroupUploadBody` — and each decided `parse_mode: 'HTML'` from a
boolean the caller passed. Before this package, `entities` existed on the wire only as
`caption_entities` for a provider's ready-made caption (round N, F2).

**One customer messenger.** `modules/commerce/messaging/infrastructure/telegram-customer-messenger.ts`
(`TelegramCustomerMessenger`) is the only thing that talks to a customer: `send`
(split into parts over `TELEGRAM_MESSAGE_MAX`, buttons and the keyboard on the last
part), `edit` (`editMessageText`, "message is not modified" is success), `sendFile`,
`sendMediaGroup`, `editCaption`, `clearButtons`, `remove`, `acknowledge`. It renders
every text through the tenant's `TemplateResolver.render` and decides the parse mode
from the key's declared `format` (`PLAIN_TEXT` or `TELEGRAM_HTML`), never from a flag a
caller passes. The three other `telegramSend` callers are the operations-log
transport (`telegram-transport.ts`, ops messages to operators), the ops-group adapter
and the broadcast transport (operator-authored content). None of those is customer UI
and none is changed here.

**Templates.** A body is stored raw with `{token}` placeholders
(`PLACEHOLDER_TOKEN_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`, no colon) and rendered once, at
send, by `renderTemplateBody` in `@nexa/i18n`: declared tokens are substituted, values
are HTML-escaped for a `TELEGRAM_HTML` key, an undeclared braced expression is left
literal. `validateTemplateBody` refuses an undeclared `{token}` when an operator saves.
The tenant's override, when one exists and `template_overrides` is on, replaces the
default body whole — there is no per-line merge, which is what makes "never rewrite a
tenant's body" a property rather than a promise (§5).

**HTML escaping.** `escapeTelegramHtml` escapes `& < > " '` in VALUES of an HTML key;
the body is trusted markup. A `{icon:…}` marker contains none of those characters, and
a slot's fallback emoji contains none either.

**Bots.** `bot_instances` is one row per Telegram bot, per tenant (`Tenant ≠ BotInstance`).
`tokenForBotInstance` resolves ACTIVE rows only. An administrator's Telegram account is
bound per tenant on `admins.telegram_user_id` (HB-3); the numeric user id is the private
chat id, and `DrizzleAdminRepository.findById` reads it.

**`editMessageText` / `editMessageCaption` call sites.** All inside the messenger
(`edit`, `editCaption`), reached from the wizard screens (R2), the service card (R3), the
receipt review and the campaign/broadcast pages. No surface builds a Telegram body.

## 2. What the Bot API documents, and the one rendering path

`core.telegram.org` is blocked by this session's egress proxy. The wording below is
quoted from two mirrors that copy the page verbatim: the machine-readable spec
`PaulSonOfLars/telegram-bot-api-spec` (`api.json`, "Bot API 10.3, August 24, 2026") and
`grammyjs/types` (`message.ts`, which carries the "Formatting options" section as a doc
comment). Both were fetched from `raw.githubusercontent.com` during this package.

`MessageEntity` (`#messageentity`):

- `type` — "Type of the entity. Currently, can be … "custom_emoji" (for inline custom
  emoji stickers), …"
- `offset` — "Offset in UTF-16 code units to the start of the entity"
- `length` — "Length of the entity in UTF-16 code units"
- `custom_emoji_id` — "Optional. For "custom_emoji" only, unique identifier of the custom
  emoji. Use getCustomEmojiStickers to get full information about the sticker."

`sendMessage` / `editMessageText`: `entities` — "A JSON-serialized list of special
entities that appear in message text, which can be specified instead of parse_mode".
`sendPhoto` / `editMessageCaption`: `caption_entities`, the same sentence for a caption.

"Formatting options" (`#formatting-options`), HTML style — the tag is listed among the
supported tags:

```html
<tg-emoji emoji-id="5368324170671202286">👍</tg-emoji>
```

and its notes say:

- "A valid emoji must be used as the content of the tg-emoji tag. The emoji will be
  shown instead of the custom emoji in places where a custom emoji cannot be displayed
  (e.g., system notifications) or if the message is forwarded by a non-premium user. It
  is recommended to use the emoji from the emoji field of the custom emoji sticker."
- "Custom emoji entities can only be used by bots that purchased additional usernames
  on Fragment."

MarkdownV2 has the same rule with `![👍](tg://emoji?id=5368324170671202286)`; legacy
Markdown states "There is no way to specify … "custom_emoji" … entities, use parse mode
MarkdownV2 instead." The brief's "the entity must cover exactly one emoji" is the
documented content rule — a valid emoji as the covered text — not a separate sentence.

**Decision: ONE renderer, two wire encodings, chosen by the key's format.**
`appearance-render.ts` is the only code that turns a marker into anything. For a
`PLAIN_TEXT` key it emits the fallback emoji covered by a `custom_emoji` entity and the
messenger sends `entities` (or `caption_entities`) with no `parse_mode`. For a
`TELEGRAM_HTML` key it emits `<tg-emoji emoji-id="…">fallback</tg-emoji>` inside the body
and the messenger sends `parse_mode: 'HTML'` as before. It cannot be one encoding:
`entities` is documented as an alternative to `parse_mode`, so an HTML body cannot carry
entities, and turning every HTML template into plain text plus self-parsed entities
would re-implement Telegram's HTML parser for `<a href>`, `<code>`, nesting and the
named entities on every existing message — a second renderer for a catalogue that is
rendered in one place on purpose. The one-path guarantee is the function, not the
encoding: `sendMessage`, `editMessageText`, `sendPhoto`/`sendDocument`, `sendMediaGroup`
and `editMessageCaption` all call `decorateAppearance` on the whole rendered body, and
`telegram-messenger-appearance.test.ts` asserts the send/edit parity byte for byte.

What the documentation does NOT say, and this package therefore does not assume: what
Telegram answers a bot that has not "purchased additional usernames on Fragment" when
it sends a `custom_emoji` entity. §6 is the consequence.

## 3. Contracts and schema

`packages/contracts/src/appearance.ts` (its own commits, `3b2c0e7` and the follow-up
that adds `NOTHING_TO_TEST`):

- `APPEARANCE_SLOTS` — 21 semantic slots: the brief's seventeen (success, error,
  warning, info, payment, wallet, purchase, service, trial, referral, support, renewal,
  traffic, time, link, active, inactive) plus `ticket`, `date`, `user`, `location`,
  which the existing default bodies already drew with their own emoji. Agent MENU
  validates its button slots against this list by string.
- `APPEARANCE_SLOT_FALLBACKS` — one Unicode emoji per slot. Each is one grapheme
  (`⚠️` and `ℹ️` are two code points; the entity covers both), chosen to match what the
  default bodies drew before, so a tenant with nothing configured sees no change.
- the marker `{icon:<slot>}`: braces like a placeholder so an operator meets one
  syntax, a COLON so the placeholder scanner cannot read it as a token. The i18n
  renderer leaves it literal, `auditCatalogue` does not report it as undeclared, and
  `validateTemplateBody` gains `UNKNOWN_ICON` for a marker naming no slot — the one
  place a typo is caught before a customer reads `{icon:paymnt}`. The scanner matches
  the whole `{icon:…}` form (anything but a brace), so `{icon:success1}`,
  `{icon:Payment}` and `{icon: payment}` are refused too, not passed unseen (Codex #121,
  finding 4).
- `CUSTOM_EMOJI_ID_PATTERN = /^[0-9]{1,32}$/`, kept as a string (the ids exceed 2^53).
- the test vocabulary: `APPEARANCE_TEST_OUTCOMES` (`SENT`, `REJECTED`, `UNREACHABLE`,
  `RATE_LIMITED`) and `APPEARANCE_TEST_ERROR_CODES` (`custom_emoji_refused`,
  `chat_unavailable`, `telegram_rejected`, `telegram_unreachable`, `rate_limited`) — a
  closed code, never Telegram's sentence (which can quote a chat id) and never a payload.
- the HTTP shapes, `APPEARANCE_ROUTES` (`GET /appearance`, `POST /appearance/slots/:slot`,
  `POST …/reset`, `POST /appearance/test`), `APPEARANCE_ERROR_CODES`, and the permissions:
  `settings.view` / `settings.edit`, the bot-buttons and ops-group precedent. No new
  permission key, so no backfill migration.
- `bot.appearance.test_message`, the one template the page sends.

Persian slot labels live in `apps/web/src/i18n/web.fa.ts` (`web.appearance_slot_*`),
not in contracts: `docs/conventions.md` puts every Persian string in a catalogue file
and `check-i18n-keys.mjs` would refuse it anywhere else. `SLOT_LABEL` in the page maps
each slot to its key, and the web test walks every slot.

Migration `0149_premium_ui_appearance` (generated by drizzle-kit; the SQL was read):

- `bot_appearance_slots` — `(tenant_id, slot)` unique, `slot` CHECK-pinned to the
  catalogue, `custom_emoji_id` nullable and CHECK-pinned to digits, `enabled`,
  `version`, timestamps, `updated_by_admin_id` with the tenant-scoped admin FK. Per
  TENANT: the icons are the brand; every bot of the tenant draws them, subject to its
  own eligibility. No row means "fallback, switched on".
- `bot_instances.custom_emoji_tested_at / _test_outcome / _test_error_code` — the last
  test's verdict, per bot, all three CHECK-pinned and bound to one fact by a shape
  CHECK (all NULL, or tested-at and outcome set with the error code NULL iff `SENT`).
  No raw answer is stored.

## 4. The shared renderer and the messenger

`apps/api/src/modules/commerce/messaging/application/appearance-render.ts`:

- `decorateAppearance(rendered, format, decoration)` — pure and total. Walks the
  markers once over the WHOLE rendered body, appends the fallback, and where the
  decoration names a custom emoji for the slot pushes `{ type: 'custom_emoji', offset:
text.length, length: fallback.length, custom_emoji_id }` — `text.length` is UTF-16
  code units, which is what Telegram counts — or, for HTML, writes the `<tg-emoji>` tag.
  An unknown slot stays literal.
- `appearanceFallbackText` — every marker as its fallback, nothing decorated. Used by
  button labels and toasts (neither can carry an entity), by the template PREVIEW
  (`TemplateManagementService.preview`), and by the tests.
- `entitiesWithin(entities, start, end)` — the entities lying WHOLLY inside a range,
  re-based. A custom emoji entity is never clipped: half an emoji is not "a valid emoji".
- `locateParts(text, parts)` — where the splitter's parts sit in the decorated text, so
  a long message's entities are re-based per part instead of guessed. Null when a part
  cannot be found, and the caller then sends plain.
- `undoHtmlDecoration` — the tags this renderer wrote, undone, for the one retry.

The messenger cuts a body with its markers MASKED and decorates each part AFTER the
cut (`maskAppearanceMarkers`, Codex #121, findings 1 and 2): every `{icon:…}` becomes one
private-use code point — a surrogate pair, never wider than the emoji it becomes — so
the splitter cannot cut a marker, the bound is measured on what Telegram counts
("characters after entities parsing", never the `<tg-emoji>` tags a decoration adds), a
generated tag can never be cut, and every entity's offset is relative to the part it is
sent in. Once a decorated part has been refused, every later part is rendered with
`NO_DECORATION` — tags and entities alike — so the tag-free text is always derived from
the decorated one. `renderCaption` decorates first and places the provider's caption
entities on the result. Every wire body builder in `send-message.ts` takes `entities` /
`captionEntities` and drops them for an HTML body (`entitiesInside`), so a caller cannot
send both.

**Decoration failure never costs the message.** `deliverDecorated` is the one Telegram
call for a body that may be decorated: a definite refusal (4xx) of a decorated request
is answered by the SAME request with the decoration removed — the same text minus the
entities, or minus the tags — exactly once. If that lands, the decoration was the cause:
the ops event `telegram.appearance_decoration_failed` is recorded (WARN, deduplicated per
bot, resolved by the next successful test through `telegram.appearance_decoration_ok`)
and `AppearanceReader.recordRuntimeRefusal` marks the bot `REJECTED` so decoration
stops for it on the very next message instead of costing every message a refused
request and a retry. If the plain request is refused too, the decoration was not the
cause, nothing about it is recorded, and the second answer is the message's. An
UNKNOWN outcome (timeout, 5xx, unreadable 2xx) is never retried — Telegram may have
delivered the first request — and "message is not modified" is success without a retry.

**Where a marker in a VALUE goes.** Values are substituted before the renderer sees the
body, so a customer who types `{icon:success}` into a ticket message gets the fallback
emoji in the support notification, or the tenant's own custom emoji if the sending bot is
eligible. Bounded and cosmetic — a customer can only make one of the tenant's icons
appear — and recorded here rather than solved by altering customer text on the way
through the i18n renderer. `OQ-P-UI-01` in `docs/open-questions.md`.

## 5. System-owned UI, and a tenant's own body

The DEFAULT bodies in `packages/i18n/src/catalogue.fa.ts` carry markers; an override
does not unless the operator typed one. Because the resolver replaces a body whole (§1),
a tenant's override is sent exactly as stored: no marker, no emoji, no entity, whatever
the bot's eligibility — `appearance-http.test.ts` sets an override without markers and
asserts the wire text equals it byte for byte with no `entities`.

Marked (payment success/failure, wallet, purchase, service status, trial, referral,
renewal, support/tickets, common alerts): `bot.order.settled`,
`bot.order.refunded_to_wallet`, `bot.order.unavailable`, `bot.payment.rejected`,
`bot.payment.expired`, `bot.payment.cancelled`, `bot.payment.received_for_review`,
`bot.wallet.topup_credited`, `bot.wallet.low_balance`, `bot.wallet.insufficient`,
`bot.service.provisioning`, `bot.service.delivered` (HTML), `bot.service.subscription`
(HTML), `bot.service.expired`, `bot.service.expiry_{early,first,second,day}`,
`bot.service.usage_{first,second,final}`, `bot.service.action_{succeeded,failed,unavailable,not_allowed}`,
`bot.service.renew_{paid,unavailable}`, `bot.service.renewed`, `bot.service.gift_applied`,
`bot.trial.{issued,unavailable,choose_panel,not_delivered}`, `bot.referral.invite`,
`bot.support.contact`, `bot.ticket.{created,reply_sent,line_customer,line_support}`.
Where a body already drew an emoji the marker's fallback is that same emoji, so the
plain rendering is byte-identical to before. Where the fallback would differ (`⌛`, `⏱`,
`📦` in the delivered and gift bodies) the literal emoji was kept. `bot.wallet.balance` is
NOT marked: the payment screen prefixes it with its own `💰`. `bot.service.detail` (the
card) is not marked: the R3 card is rendered into a Telegram message that is edited in
place many times, and a unit test of the line-dropping rule renders it through the
i18n renderer directly; the status messages around it are.

Five integration tests compared a wire text to `CATALOGUE_FA[key]` for keys that now
carry markers; they compare to `appearanceFallbackText(CATALOGUE_FA[key])`, the sentence
a customer reads, and `notification-capture.ts` renders through the same fallback.

## 6. Eligibility: never assumed

`AppearanceService.sendTest` sends `bot.appearance.test_message` — the tenant's editable
copy rendered as FALLBACK, then a FIXED line the messenger appends carrying every slot's
marker (`APPEARANCE_PROBE_BLOCK`) — through the chosen ACTIVE bot to the signed-in
administrator's own chat (`admins.telegram_user_id`; refused `ADMIN_NOT_BOUND` when there
is none), with EVERY configured, switched-on slot decorated whatever the bot's earlier
verdict, because the test is how the verdict is found. The block is what makes an
override that omits a marker unable to let a `SENT` vouch for a slot the message never
carried (Codex #121, finding 6); `decoratedSlots` is exactly the configured count. The request's key is CLAIMED in a committed
transaction before the send and the answer stored under `<key>#result`, as the
ops-group test does, so two presses send one message. The answer is recorded on the
bot: `SENT`, or `REJECTED` / `UNREACHABLE` / `RATE_LIMITED` with a closed code derived
once (`classifyProbeRefusal`) from the transport's taxonomy and the refusal's wording —
custom-emoji wording matched broadly because the exact sentence an ineligible bot
receives is not documented; "chat not found" / "bot was blocked" named as
`chat_unavailable` so the page can say "start the bot first".

With no slot configured the test is refused (`NOTHING_TO_TEST`): a message carrying no
`custom_emoji` entity proves nothing, and a recorded `SENT` from it would switch
decoration on for a bot nothing tested. The service guards the same case again after
the send. The verdict the test's audit row names as `before` is read UNDER THE LOCK in
the result transaction (`lockBot`), not before the claim and the Telegram call (Codex
#121, finding 7). And because a runtime refusal opens a per-bot condition that only the
next accepted test closes, removing the last custom emoji — after which the probe
refuses — closes every open condition with the same recovery, or the warning would stay
open for ever (finding 8).

**Writes carry their predicate.** A slot with no row locks nothing under
`findSlot(..., FOR UPDATE)`, so two first saves both pass the version check: the insert
is `ON CONFLICT DO NOTHING` and the loser is `control.version_conflict`, never an
overwrite; an update and a delete are `WHERE version = <the one read>`; a reset names
the version the operator read (finding 3, finding 5).

`CachedAppearanceReader.decorationFor(scope, bot)` decorates only a bot whose recorded
outcome is `SENT`; untested is a refusal. Cached thirty seconds per tenant and bot, and
forgotten by this process on every save or test (`AppearanceService.invalidate`).

What a 2xx proves: that Telegram ACCEPTED a message carrying the entity. Whether the
custom emoji is drawn is what the operator sees in their own chat — which is why the
test goes there and nowhere else. `OQ-P-UI-02`.

## 7. Web Admin

`apps/web/src/pages/appearance.tsx`, «🎨 ظاهر ربات», under the configuration group on
`settings.view`. One row per slot: Persian name, fallback emoji, the marker, the custom
id field (digits only, validated in the row), the switch, a preview that says which of
the two the customer will see, save against the version read, and a reset for a stored
row. Below it, the bots with each one's last verdict and Persian remedy, a bot chooser
when more than one is active, and «ارسال پیام آزمایشی» — withheld, with the reason
shown, while the operator has no Telegram bound or nothing is configured.

## 8. Tests and mutation evidence

| Rule                                                    | Test                                                                                                                                 | Mutation                                                         | Result   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | -------- |
| UTF-16 offsets after Persian text and an astral emoji   | `appearance-render.test.ts` "places a custom_emoji entity in UTF-16 units…"                                                          | `offset: text.length` → `offset: [...text].length` (code points) | see §8.1 |
| a two-code-point fallback is covered whole              | same file, "covers a two-code-point fallback whole"                                                                                  | `length: fallback.length` → `length: 1`                          | see §8.1 |
| fallback without a custom id                            | same file, "falls back — the emoji, no entity"                                                                                       | decorate when `customEmojiId === undefined` too                  | see §8.1 |
| an unknown marker stays literal                         | same file, "leaves an unknown marker literal"                                                                                        | `text += match[0]` → `text += ''`                                | see §8.1 |
| a cut never clips a custom emoji entity                 | same file, "re-bases each entity…never clipping it"                                                                                  | `entitiesWithin` clips instead of drops                          | see §8.1 |
| a marker naming no slot is refused at save              | same file, "refuses a body whose marker names no slot"                                                                               | `UNKNOWN_ICON` loop removed                                      | see §8.1 |
| decoration only after a `SENT` verdict                  | `telegram-messenger-appearance.test.ts` "fallback…is what a bot with no proof gets"; `appearance-http.test.ts` "only then decorates" | `outcome !== 'SENT'` → `outcome === null` in `decorationFor`     | see §8.1 |
| send/edit parity                                        | messenger test "carries the SAME text and entities through editMessageText"                                                          | `edit` decorates with `NO_DECORATION`                            | see §8.1 |
| refused decoration is re-sent once, plain, and recorded | messenger test "re-sends ONCE without decoration…"                                                                                   | `deliverDecorated` returns `first` on refusal                    | see §8.1 |
| UNKNOWN is never retried                                | messenger test "never retries an UNKNOWN outcome"                                                                                    | retry on `FAILED_RETRYABLE` too                                  | see §8.1 |
| tenant and bot isolation                                | `appearance-http.test.ts` "keeps one tenant's slots…"; "…its untested sibling still does not"                                        | `listBots` drops the tenant predicate                            | see §8.1 |
| a tenant's own body is untouched                        | `appearance-http.test.ts` "never rewrites a tenant's own body"                                                                       | (property of whole-body override; the test guards the wire)      | see §8.1 |
| a test with nothing configured is refused               | `appearance-http.test.ts` "sends a real decorated test…"                                                                             | `configured.length === 0` check removed                          | see §8.1 |

### 8.1 Mutation runs

Each mutation was applied to the working tree by an exact-string replacement, the named
file run with `pnpm exec vitest run --project <unit|integration> <file>`, the source
restored with `git checkout -- <file>` (byte for byte; `git status` clean afterwards), and
the file run green again. The integration runs used `nexa_pui` and Redis index 8.

| Id  | Mutation (file, change)                                                                  | Test file                               | Result under mutation | Restored  |
| --- | ---------------------------------------------------------------------------------------- | --------------------------------------- | --------------------- | --------- |
| M1  | `appearance-render.ts`: `offset: text.length` → `offset: [...text].length` (code points) | `appearance-render.test.ts`             | 3 failed, 7 passed    | 10 passed |
| M2  | `appearance-render.ts`: `length: fallback.length` → `length: 1`                          | `appearance-render.test.ts`             | 3 failed, 7 passed    | 10 passed |
| M3  | `appearance-render.ts`: decorate a slot with no id (`?? '0'`)                            | `appearance-render.test.ts`             | 2 failed, 8 passed    | 10 passed |
| M4  | `appearance-render.ts`: an unknown marker becomes `''` instead of staying literal        | `appearance-render.test.ts`             | 1 failed, 9 passed    | 10 passed |
| M5  | `appearance-render.ts`: `entitiesWithin` clips an entity instead of dropping it          | `appearance-render.test.ts`             | 1 failed, 9 passed    | 10 passed |
| M6  | `templates.ts` (contracts): the `UNKNOWN_ICON` refusal never fires                       | `appearance-render.test.ts`             | 1 failed, 9 passed    | 10 passed |
| M7  | `drizzle-appearance.repository.ts`: an untested or refused bot decorates                 | `appearance-http.test.ts`               | 2 failed, 3 passed    | 5 passed  |
| M8  | `telegram-customer-messenger.ts`: `edit` decorates with `NO_DECORATION`                  | `telegram-messenger-appearance.test.ts` | 1 failed, 11 passed   | 12 passed |
| M9  | `telegram-customer-messenger.ts`: the refused decorated request is not re-sent plain     | `telegram-messenger-appearance.test.ts` | 3 failed, 9 passed    | 12 passed |
| M10 | `telegram-customer-messenger.ts`: a retryable (UNKNOWN) outcome is retried too           | `telegram-messenger-appearance.test.ts` | 1 failed, 11 passed   | 12 passed |
| M11 | `drizzle-appearance.repository.ts`: `listBots` drops the tenant predicate                | `appearance-http.test.ts`               | 2 failed, 3 passed    | 5 passed  |
| M12 | `appearance.service.ts`: a test with nothing configured is sent                          | `appearance-http.test.ts`               | 1 failed, 4 passed    | 5 passed  |

### 8.2 Codex review of PR #121 (review 5364620272)

Nine findings, all confirmed against the code and fixed; each with a test that fails
when the rule is reverted, run the same way as §8.1.

| Id  | Finding | Mutation (file, change)                                                               | Test file                               | Under mutation      | Restored  |
| --- | ------- | ------------------------------------------------------------------------------------- | --------------------------------------- | ------------------- | --------- |
| M13 | 1       | `telegram-customer-messenger.ts`: later parts keep decorating after a refusal         | `telegram-messenger-appearance.test.ts` | 1 failed, 14 passed | 15 passed |
| M14 | 2       | `telegram-customer-messenger.ts`: split the raw text, markers unmasked                | `telegram-messenger-appearance.test.ts` | 1 failed, 14 passed | 15 passed |
| M15 | 3       | `drizzle-appearance.repository.ts`: first insert `ON CONFLICT DO UPDATE`              | `appearance-http.test.ts`               | 1 failed, 6 passed  | 7 passed  |
| M16 | 4       | `appearance.ts` (contracts): scanner back to `[a-z_]+`                                | `appearance-render.test.ts`             | 1 failed, 10 passed | 11 passed |
| M17 | 5       | `appearance.service.ts`: reset without the version check                              | `appearance-http.test.ts`               | 1 failed, 6 passed  | 7 passed  |
| M18 | 6       | `telegram-customer-messenger.ts`: probe sends the editable copy alone, no fixed block | `telegram-messenger-appearance.test.ts` | 2 failed, 13 passed | 15 passed |
| M19 | 7       | `appearance.service.ts`: audit `before` from the pre-claim read                       | `appearance-service.test.ts`            | 1 failed, 2 passed  | 3 passed  |
| M20 | 8       | `appearance.service.ts`: conditions never closed                                      | `appearance-service.test.ts`            | 1 failed, 2 passed  | 3 passed  |
| M21 | 9       | `appearance.tsx`: the "sent" toast for every outcome                                  | `appearance.test.tsx`                   | 1 failed, 5 passed  | 6 passed  |

Two first attempts at M1 and M2 matched nothing (an indentation mismatch in the
replacement pattern) and ran the unmutated file — 10 passed — which is exactly the false
"survived" a mutation record must not carry; both were re-run with the exact text and are
the rows above. "A tenant's own body is untouched" has no mutation row: it is a property of
the resolver replacing a body whole, guarded on the wire by `appearance-http.test.ts`
"never rewrites a tenant's own body"; the only code that could break it is the renderer
decorating a body, and M3 covers the renderer's side.

## 9. Still needs a real bot

- A bot that HAS purchased a Fragment username, and one that has not, each sent the
  test: what Telegram answers the second (the exact `description`, whether it is a 400
  at all or a silent strip of the entity) decides whether `classifyProbeRefusal`'s
  custom-emoji arm ever fires, or whether such a bot records `SENT` and the operator
  sees the fallback in their chat (`OQ-P-UI-02`).
- The HTML path on a real bot: `<tg-emoji>` inside `bot.service.delivered`, a caption of
  a real subscription QR (`sendPhoto` with `parse_mode: HTML`).
- A custom emoji id from a real sticker set, through the page, end to end.

## 10. Rollback

See `docs/deployment.md`, "What a rollback leaves as text: appearance markers (round P)".
