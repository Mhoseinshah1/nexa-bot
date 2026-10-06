# Phase 2 UX wave: Item 2, premium emoji on product categories

This document covers the owner's master prompt of 2026-10-05, Phase 2, Item 2 (premium custom
emoji before and after a category's name). Branch `phase2/b-category-icons`, built on Item 3's
inline-icon transport (`phase2/a-button-icons`, `docs/phase2/button-icons.md`).

## What existed (audit §2)

- `product_categories.emoji`: an optional PLAIN text prefix (at most 8 code points, no control
  characters), drawn as `"<emoji> <name>"`. Kept exactly as it is.
- `bot.category_colors`: a style per category id. Kept exactly as it is.
- Appearance slots: premium emoji in MESSAGE text only. Not usable here.
- **A category's only customer surface is its inline button** (`bot-runtime.ts`, the
  catalogue keyboard, `inlineDataLabel('catalog.category', …)`). No customer template prints a
  category name.

So the item was PARTIAL: nothing premium existed for a category.

## What Telegram allows on that surface

From the published Bot API types (`@grammyjs/types` `markup.d.ts`; `core.telegram.org` is not
reachable from this sandbox):

- `InlineKeyboardButton.icon_custom_emoji_id`: ONE custom emoji, shown **before** the text,
  and only from a bot that may use custom emoji (Fragment usernames, or a Premium owner).
- Button `text` carries **no entities**. A premium emoji can never be put inside or after a
  label.

## The model

The setting is `bot.category_icons` (contracts `inline-buttons.ts`, `categoryIconsSchema`),
keyed by category id like `bot.category_colors`:

```json
{ "<category id>": { "before": "5368324170671202286", "after": "🔥" } }
```

| Field    | Meaning                                                                                          | Validation                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `before` | The button's **premium** icon (`icon_custom_emoji_id`), shown before the text                    | `customEmojiIdSchema`: digits only, 1..32 (the appearance-slot and Item 3 rule)                                                                                          |
| `after`  | An **ordinary Unicode emoji** appended to the text. NOT premium: Telegram cannot draw that there | `isValidCategoryAfterEmoji`: only emoji code points (pictographs, modifiers, flags, ZWJ, VS16, keycaps, tags), at least one real emoji, at most 8 code points, no markup |

- Both optional and independent. An entry with neither, or with any other field, is refused:
  removing both is removing the key. At most 1000 categories (the colours' bound).
- An id of a category since deleted is kept and harmless: no button is drawn for it.
- Versioned, audited (`settings.set` with before/after values), announced in the outbox,
  permissioned by `settings.edit`, tenant-scoped. No table and no migration; an older release
  ignores an unknown setting row, so a rollback is safe.

### Why `after` is an ordinary emoji

It is the closest correct representation of what was asked, and it is never presented as
premium: the Web Admin calls it «ایموجی بعد», the preview draws it as text, and the setting's
description says Telegram cannot draw a premium emoji after a button's text. `OQ-P2-CAT-01`
invites the PO to confirm it.

Unlike `isValidCategoryEmoji` (deliberately any short text), this IS an emoji check, because
the owner asked for an emoji and the value goes on the wire. `Extended_Pictographic` also
reserves the unassigned code points of the emoji blocks, so an emoji newer than the runtime's
Unicode tables is still accepted.

## Rendering (`telegram-customer-messenger.ts`, `labelButtons`)

For each `catalog.category` button, with the setting read once per keyboard that lists
categories:

1. **text** = `categoryButtonText(label, after)`: the label as today (`"<emoji> <name>"` or
   `"<name>"`), then `" <after>"` when set. Every bot draws it; it is plain text.
2. **icon** = `categoryButtonIconOf`: the category's own `before`, else the generic
   `catalog.category` icon from `bot.inline_button_icons` (Item 3), else none. It is drawn
   ONLY when the SENDING bot may carry custom emoji (`mayCarryCustomEmoji`, a recorded `SENT`
   appearance test). Any other bot of the same tenant draws no icon.
3. **style**, **row** and **callback data**: unchanged (`categoryButtonStyleOf`, the caller's
   route). The category order is unchanged.
4. **Neither** configured: the request is byte for byte the one before Item 2.

A refused icon reuses Item 3's rule, not a copy of it: the keyboard is "iconed", so a refusal
is retried ONCE without icons (`withoutButtonIcons`), keeping the text (with its after emoji),
style and callbacks. Only a definite custom-emoji denial switches the bot's eligibility off
(owner rule B5). A timeout, an unreadable 2xx, a 5xx or a 429 is never re-sent. An after
emoji alone never makes a keyboard owe the retry.

## Web Admin

On «دسته‌بندی‌ها» (`/product-categories`), under the list, a section «آیکون دسته‌بندی‌ها»
(`apps/web/src/pages/category-icons.tsx`), drawn with `settings.view`, editable with
`settings.edit`:

- per category: «آیکون پریمیوم قبل» (id) and «ایموجی بعد» (Unicode), each with a remove button;
- validation before save with the contract's own predicates; an invalid field says why, is
  never previewed, and keeps Save disabled;
- a preview of the button: its colour, the label with the after emoji, and a dashed ✦ marker
  where the premium icon goes — never a fake of the custom emoji;
- one line on Telegram's limits (one premium icon, before, only from an eligible bot; after the
  name only an ordinary emoji);
- one settings write, with the version the draft was edited from.

## Tests

| Case (master prompt)             | Test                                                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before only                      | `telegram-category-icons.test.ts` › BEFORE only; `telegram-order-flow.test.ts` › draws the premium icon before and the emoji after on an ELIGIBLE bot                |
| After only                       | `telegram-category-icons.test.ts` › AFTER only                                                                                                                       |
| Both                             | `telegram-category-icons.test.ts` › BOTH; `category-icons.test.ts` (integration) › decorates a category created after the release                                    |
| Neither (legacy identical)       | `telegram-category-icons.test.ts` › NEITHER: the request is byte for byte the legacy one                                                                             |
| Invalid id rejected              | `category-icons-contract.test.ts` › refuses an id…; `category-icons.test.ts` (integration) › refuses an invalid id and an invalid after; web › refuses an invalid id |
| Invalid after (markup, too long) | `category-icons-contract.test.ts` › refuses an after that is markup…; web › refuses markup, text or an over-long after emoji                                         |
| Tenant isolation                 | `telegram-category-icons.test.ts` › is each tenant's own; `category-icons.test.ts` (integration) › is the tenant's own                                               |
| Callback unchanged               | `telegram-category-icons.test.ts` › every callback is unchanged; `telegram-order-flow.test.ts` (eligible case)                                                       |
| Ineligible bot draws none        | `telegram-category-icons.test.ts` › an INELIGIBLE bot…; `telegram-order-flow.test.ts` › an INELIGIBLE bot draws no premium icon                                      |
| Denial → retry without icon      | `telegram-category-icons.test.ts` › a custom-emoji DENIAL…; `telegram-order-flow.test.ts` › a refused icon is sent once more without it                              |

Falsification: `docs/phase2/category-icons-falsification.md`, driver
`scripts/mutate-p2-category-icons.py`.

## Not verified here

A real client's rendering of an inline-button icon, and an ineligible bot's exact refusal, are
`OQ-P2-ICON-01` (a real-bot acceptance), which this button shares.
