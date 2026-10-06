# Phase 2 item 5 — the optional tutorial a panel sends after delivery

Master prompt item 5; audit `phase2-ux-wave-audit.md` §5. Branch `phase2/d-delivery-tutorial`.

## What it is

An operator may give each PANEL a tutorial that the bot sends a customer automatically, once,
right after a service on that panel was delivered — after a purchase, after a trial, or both.
Example (the owner's): «کاربر گرامی، اتصال سرویس فقط از طریق Sing-box امکان‌پذیر است. لطفاً
حتماً از آخرین نسخه برنامه استفاده کنید.»

Modes: `DISABLED` (the default, and what "no row" means), `TEXT`, `VIDEO`, `VIDEO_TEXT`.

## Scope and model (decisions)

- **Per panel.** What the tutorial says («only Sing-box») is a property of the panel's
  connection, so it is configured on the panel page, tab «آموزش پس از تحویل».
- **Its own table, `delivery_tutorials`** (migration `0211`), never `panels.policy`: that jsonb
  is parsed strictly, and a rollback meeting an unknown key would refuse every customer action
  on the panel. Tenant-leading primary key, composite foreign key to the panel, a mode CHECK
  from `DELIVERY_TUTORIAL_MODES`, and a content CHECK that demands only what the mode sends.
- **Fields the mode does not use are kept.** Switching to DISABLED, or from TEXT to VIDEO,
  loses nothing the operator wrote.
- **`applies_to_purchase` / `applies_to_trial`.** "Purchase" is every non-trial service the
  automatic lane delivers (`services.is_trial = false`); "trial" is `is_trial = true`.

## Reuse instead of a second subsystem

- **Text** is the client-app guide's plain-text subset: `clientAppTextProblem` refuses markup,
  executable schemes and unsafe links at save; `renderClientAppGuide` draws bullets, steps and
  `[label](https://…)` links at send. Bounded at 2500 characters, like a guide.
- **Customer text comes from a template key**: `bot.service.delivery_tutorial` = `{text}`,
  PLAIN_TEXT — the `bot.faq.page {content}` / `bot.apps.detail {guide}` precedent for
  operator-authored content. A tenant may override the template (e.g. add a heading).
- **Video** is an existing client app's tutorial video (`client_app_videos`): the bot-scoped
  `file_id` an administrator already sets through the bot («تنظیم ویدیو», or the Web Admin's
  «افزودن ویدیو از تلگرام» prompt). The tutorial names the APP; the send asks
  `ClientAppVideoService.videoFor(app, deliveringBot)`, which answers only for an ENABLED app
  and only the `file_id` THIS bot holds. No second video-capture flow was built.
  - The delivering bot holds no video for that app (or the app was deleted or disabled):
    `VIDEO_TEXT` sends the text alone; `VIDEO` sends nothing (and claims nothing).
  - `video_client_app_id` is deliberately not a foreign key, so deleting an app neither deletes
    nor blocks the tutorial.
- **Existing tutorial entry points are untouched**: the delivery card's «📖 آموزش» button, the
  `tu:`/`to:` connection guide, client-app guides and videos, and their settings.

## When it is sent

`DeliveryService.deliverDue` (the automatic lane), after `sendFilesAfter`, only when:

1. this sweep's send was `DELIVERED` and recorded (`record.recorded && state === DELIVERED`);
2. the service has NOT rotated (`rotations.hasRotated` — a rotation's new link is not a new
   service);

and never from `redeliver` (the customer asking again, the link view, an operator's resend).
Order: delivery card → connection files → tutorial.

## Exactly once

`DeliveryTutorialSender` claims `delivery_tutorial:<serviceId>` in the `WORKER` idempotency
namespace (`request_idempotency`'s unique key), inside a transaction that first reads
`ScopeActivityReader`, and commits the claim BEFORE sending. A Telegram replay, a second
replica, or anything that re-arms the service's delivery finds the claim and sends nothing. A
sender that died mid-send leaves the claim standing: a tutorial that may already be on the
screen is never sent twice. A stopped tenant claims and sends nothing.

Outcomes are never retried: `UNKNOWN` may have arrived and `RATE_LIMITED` is Telegram declining
a courtesy message. The sender never throws into delivery, and the sweep swallows anything that
does.

**PO-visible choice — at most once, never at least once.** The claim is committed before the
send, so a tutorial Telegram answers with a 429 (`RATE_LIMITED`) or with an ambiguous outcome
(`UNKNOWN`) is NOT sent again later: that customer simply does not get it. This is deliberate —
a duplicate tutorial (or a tutorial resent after the customer already read it) is the failure
the claim exists to rule out — and the customer can still open the connection guide from the
delivery card's «📖 آموزش» button. In the too-long `VIDEO_TEXT` arrangement, a bare video
answered `RATE_LIMITED` is not followed by the text either: the limit is per chat, so the text
would only burst into a second 429.

Two more consequences of "first automatic delivery only", stated so nobody reads them as bugs:

- A first delivery that ends `UNCONFIRMED` (the card's send was ambiguous) sends **no** tutorial —
  the hook runs only for a send recorded `DELIVERED`, and an unconfirmed row is never re-claimed
  by the sweep.
- A customer who fetched their link through `redeliver` (the service card, «🔗 لینک اشتراک», an
  operator's resend) before the sweep delivered it gets **no** tutorial at all: `redeliver` never
  calls the hook, and it records the delivery itself, so the sweep has nothing left to deliver.

## Rendering

- `TEXT`: one `sendMessage`.
- `VIDEO`: one `sendVideo` by `file_id`, no caption.
- `VIDEO_TEXT`: A4a's whole-or-nothing rule — one `sendVideo` with the text as its caption
  when the rendered, decorated caption fits Telegram's 1024-character bound (`captionWhole`,
  refused locally with `CAPTION_OVER_BOUND` otherwise, no request spent); else the bare video
  and then the text as its own message. Never a cut caption. A video Telegram refuses still
  lets the text go.

## Premium emoji

Written as the allowlisted appearance marker `{icon:slot}` (the slots of «ظاهر ربات»); an
unknown slot is refused at save, and raw `<tg-emoji>` is refused as markup. The messenger
decorates the rendered body exactly as it does every template: on a bot that proved
custom-emoji eligibility the marker becomes the slot's fallback emoji covered by a
`custom_emoji` ENTITY (in `entities` for a text, `caption_entities` for a caption); elsewhere it
is the plain fallback emoji. No parse mode, so operator text can never inject entities.

### Telegram limitations (recorded, not faked)

- A `file_id` is valid only for the bot that received it, so a video is sent only by a bot that
  holds it; the editor shows on how many bots each app's video exists.
- A caption is at most 1024 characters after entity parsing; a longer `VIDEO_TEXT` arrives as
  two messages (video, then text), by design.
- Premium (custom) emoji render only on a bot eligible for them; otherwise the ordinary
  fallback emoji is shown (the appearance machinery's existing, documented behaviour).

## Web Admin

Panel page → tab «آموزش پس از تحویل»: mode, purchase/trial switches, text with the icon
markers and a length count, the video's app (apps that hold a video on at least one bot, with
the count), a preview, a caption-fallback notice, and the trial tab's revision rule (a stale
save is refused with `panel.delivery_tutorial_stale`). Validation before save uses the
contract's own text rule. Read `panels.view`; write `panels.edit`; read-only on an archived
panel. Every change is audited (`panel.delivery_tutorial_update`, values before and after).

## Deferred

- A tutorial video of its own per panel (captured through the bot for the panel rather than
  borrowed from a client app). The client-app video covers the owner's example and avoids a
  second capture flow; it can be added later behind the same `videoFor` seam.
- A per-product scope. The panel scope matches the domain («the connection requirement is a
  property of the panel»); a product override would be a second row keyed by product.
