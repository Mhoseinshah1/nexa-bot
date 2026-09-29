# Round N — service UX: RickPanel files as albums, and one service card (F2 + F4)

The owner's post-v0.3.6 brief, items F2 and F4. F2: connection files arrive as Telegram
albums, in the panel's order, with the caption the panel wrote for each file. F4: every
service operation works from, and answers on, the same service card whenever Telegram can
edit it.

## 1. Audit: how it worked at v0.3.6

**Files (Package E, R3).** `SubscriptionFileService` read `GET /api/user/{username}/files`
once and sent every usable file as its own `sendDocument`, in the panel's order. The
adapter already carried each file's `caption` (cleaned, bounded to 900 characters,
`ProviderSubscriptionFile.caption`) — R3 item 8 had simply stopped showing it and captioned
every file «👤 نام کاربری: {username}» instead, because the panel's caption reached the
customer with raw `<code>` tags. One path serves all four deliveries: the delivery lane's
`sendAfterDelivery` after a purchase, a trial and a link change, and the manual
«📁 دریافت فایل‌های اتصال».

**The card (R3).** Refresh and the link-change question already edited the tapped card
(`PendingReply.edit`). Disable and enable recorded the card in `operation_card_messages`
and `OperationCardEditor` edited it after a SUCCEEDED operation; the tap itself sent
nothing, so the card showed the old state (and its switch) until the panel answered, and a
failure arrived as a separate lane message. The link change put the card back unchanged
and delivered the new link as a new message. «🔗 لینک اشتراک» sent the delivery card again
as a new message. Renew, add traffic/time, extra users, location, note, refund and transfer
screens were all new messages, and their «back» (`s:`) sent yet another card.

## 2. F2 — albums with the panel's captions

- **Grouping** (`media-group.ts`). The Bot API's rules: 2–10 items per album; documents only
  with documents, photos and videos together, audio alone. `planMediaBatches` keeps the
  panel's order and uses the fewest consecutive albums: each run of one album class is cut
  into `ceil(n/10)` albums of as-equal size as possible, so no album is left with one file
  when two could be made (11 → 6 + 5). A batch of one — the only case that cannot be an
  album — is sent by `sendDocument` in its place. Every connection file is sent as a
  document (as Package E did), so all of a panel's files are one class; at most 20 files
  means at most two albums.
- **Stopping.** The first batch Telegram does not certainly accept stops the delivery,
  exactly as the one-by-one loop did; nothing is retried. An album is delivered whole or not
  at all, so its outcome is one outcome.
- **Captions.** The panel's caption is the source of truth again
  (`bot.service.file_caption`, `{caption}`, PLAIN_TEXT). Its markup is read by a closed
  grammar (`caption-markup.ts`): Telegram's attribute-free formatting tags become
  `caption_entities` (bold, italic, underline, strikethrough, spoiler, code, pre,
  blockquote); `<a href>` and other attribute-bearing tags are dropped with their text kept;
  every other character — a `<3`, a stray `<` — is text; the HTML entities Telegram decodes
  are decoded. Nothing a panel writes is ever parsed by Telegram as HTML, so one bad tag
  cannot refuse an album. The entities are placed on the value only where it occurs exactly
  once in the rendered caption (so a tenant's wording around `{caption}` is safe), and a
  caption over Telegram's 1024 is cut with an ellipsis with its entities clipped.
- **No caption.** A file the panel sent without one (or whose caption was only markup) gets
  this installation's identifying line, `bot.service.connection_file_caption` (the username)
  — the line R3 introduced, never a replacement for a caption the panel did send. The
  owner's sample is not hard-coded anywhere.
- **Transport.** `encodeMultipartFiles` (several parts, one boundary), `mediaGroupUploadBody`
  (`media` JSON with `attach://fileN`), `caption_entities` on single uploads, and the
  messenger's `sendMediaGroup` (optional on the port; a stand-in without it sends the files
  one by one). Bytes and captions stay in memory and in the request; nothing is logged.

## 3. F4 — one service card

### The mechanism, and why this one

The card's stored identity is R3's `operation_card_messages` behind `OperationCardEditor`,
extended — not R2's `TelegramMessageStateService`, and not a third store:

- everything that answers a card LATER is keyed by a provisioning operation (the
  provisioner's result, the delivery lane's new link), and that table is exactly
  operation → card with a told-once claim, a 429 hold and a crash sweep;
- everything answered IN the turn needs no stored identity at all — the callback carries the
  message, and `PendingReply.edit` is the one place such an edit happens;
- R2's `telegram_wizards` is a step-gated store for the purchase and top-up wizards; a quote
  still opens that wizard as its own message, so the two never share a message.

### The answers

| action                                 | answer                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `🔗 لینک اشتراک`                       | The card becomes the link (`bot.service.subscription`, `<code>`, tap to copy) with «🔙 بازگشت به مشخصات سرویس» restoring the same card. Through `DeliveryService.redeliver(…, {card})`: the same `markSendStarted` stamp and delivery record, so an UNCONFIRMED announcement is now recorded as told.                                                                                                                                                 |
| `♻️ بروزرسانی اطلاعات`                 | Unchanged from R3: one bounded read, the same card edited, or a notice on the button.                                                                                                                                                                                                                                                                                                                                                                 |
| disable / enable                       | The tap turns the card «working» (`bot.service.state_working`, no action buttons) BEFORE the operation is planned, then plans it with the card. Success: `OperationCardEditor` edits the card to the new state. Terminal failure (FAILED with no retry, ABANDONED): the card is redrawn as the service still is with `bot.service.notice_action_failed`, and the announcer stamps the operation without the separate `SERVICE_ACTION_FAILED` message. |
| change link                            | The confirmation turns the card «working», plans the rotation with the card. Success: the delivery lane claims the card (`claimRotationCard`) and edits it into `bot.service.link_rotated` — the link changed, the previous one no longer works, the new link — with a way back; then the files as an album. Never the purchase card. Failure: as disable. A refusal (cooldown, …) is edited over the «working» card.                                 |
| renew, add traffic / time, extra users | The menus are edited into the card, with «back» restoring it. A chosen package's quote is the payment wizard (R2) and is its own message. The renewal's result is R2's `SERVICE_RENEWED` notification, unchanged — no second result is added.                                                                                                                                                                                                         |
| location change                        | The choice, the target and the free move's confirmation and «requested» answer are edited into the card; while the move is unsettled the card reads «working». The move's outcome is still told by the lane (its operation carries no card).                                                                                                                                                                                                          |
| note                                   | The prompt is edited into the card. The typed note's answer IS the card — the note as it now stands, «📝 یادداشت ذخیره شد.» under the status — sent as one new message, because a typed message carries no reference to the card that asked for it.                                                                                                                                                                                                   |
| refund request, transfer               | The ask, the confirmation and the prompts are edited into the card; the transfer's confirm screen (the answer to a typed id) is a new message, and its result is edited into that message.                                                                                                                                                                                                                                                            |
| a stale switch                         | A switch tapped from a keyboard that is out of date redraws the card as it is, with the refusal as a notice on the button.                                                                                                                                                                                                                                                                                                                            |

`back` everywhere is `sv:` (`backToServiceButton` → `backToCardButton`): the card drawn
into the message that was tapped. On a message of its own (a typed step's answer) it turns
that message into the card.

### Loading, ambiguity and the one race

- **«working» is decided from the operation rows** (`ProvisioningService.changeInProgress`:
  a SUSPEND, RESUME, ROTATE_SUBSCRIPTION or CHANGE_LOCATION that is PLANNED, IN_FLIGHT or
  UNKNOWN), so any message that draws the card draws the same truth, and an `UNKNOWN`
  rotation reads «working» until reconciliation decides it — never success, never failure.
- **The tap's «working» edit happens before the operation exists.** The provisioner can only
  answer an operation that exists, so its final edit can never be overwritten by the turn's
  loading edit. The «working» edit is best effort: if Telegram cannot edit the card, the
  provisioner's own fallback sends the final card once.
- **Told once.** Every card answer is a conditional claim of `answered_at` taken before the
  edit (R3's rule); `claimRotationCard` takes the latest successful customer rotation's card
  the same way, and gives it back with Telegram's wait on a 429.

### Fallbacks, documented

- A card Telegram cannot edit (deleted, too old, a photo): the same content once as a new
  message (R3's one fallback), for the operation answers, the link view and the new link.
- A text card cannot become a photo, so the link view and the changed link are text; the
  QR stays with the delivery card of a purchase.
- A typed step's answer is a new message (the note's card, the refund's registration, the
  transfer's confirmation); every later tap edits that message.
- A second card message tapped for a change already in flight reads «working» until it is
  redrawn (refresh, or reopened): only the card the operation was planned from is answered.

## 4. Tests

- `tests/unit/caption-markup.test.ts` — the caption grammar, entity placement and bounding,
  and the album plan (order, fewest albums, no singleton, classes never mixed).
- `tests/integration/subscription-files.test.ts` — one album with the panel's captions in
  order; `<code>` as an entity and never raw, no parse mode; the username fallback; twelve
  files as 6 + 6 in order; the manual re-download as an album.
- `tests/integration/r3-service-card.test.ts` — purchase and trial files as one album after
  the details; disable and enable «working» then final on the same card; a failure answered
  on the card with no lane message; «working» wherever drawn while unsettled; every
  sub-screen edited into the card with `sv:` back.
- `tests/integration/customer-rotate-link.test.ts` — the change-link card «working», then
  the new link ON the same card, then the files as an album; never «service created»; a
  failed rotation answered on the card.
- `tests/integration/provisioning-delivery.test.ts` — «🔗 لینک اشتراک» edits the tapped card
  with a way back, and sends no separate message.
- `tests/unit/operation-outcome-announcer.test.ts` — a failure asked from a card is stamped
  without a message; the announcer's list is the card editor's list.

## 5. Still needs a real bot and a real panel

`OQ-N-FILES` (`docs/open-questions.md`): the real caption vocabulary of RickPanel's `/files`
and a real `sendMediaGroup` of its documents. And, as R3 recorded, Telegram's
`editMessageText` against a real chat for every card answer above, including a card the
customer deleted.

## 6. Rollback

`docs/deployment.md`, "What a rollback changes back: albums, panel captions and the
same-card answers (round N, F2 + F4)". No migration.
