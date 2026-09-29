# R3 — service delivery, connection files and the service card

The owner's v0.3.5 real-test brief, items 6–10: what a customer sees after a provisioning
or a service operation, and the service card's refresh, link change and on/off switch.

## 1. Audit: how it worked before R3

**A successful provisioning.** `ProvisionerService` marks `PROVISION` `SUCCEEDED`, the
service `ACTIVE` and its delivery `PENDING` in one transaction. In the same provisioner
tick `DeliveryService.deliverDue` claims the service and sends the delivery card
(`bot.service.delivered`, «✅ سرویس با موفقیت ایجاد شد», as the caption of the link's QR
unless the panel's policy says text). `OperationOutcomeAnnouncer` stamps `PROVISION`
without a message: the delivery is the answer. The lane does not know what bought the
service, so a trial (an order of purpose `TRIAL`) is delivered exactly like a purchase.

**RickPanel connection files (Package E).** `SubscriptionFileService.send` re-checks
ownership, the state, the panel's operability and URL policy, the adapter's
`SUBSCRIPTION_FILES` capability and the panel's policy, spends the tenant's probe budget,
calls `GET /api/user/{username}/files` once, and sends each file as a document from memory.
The caption was the panel's own (`bot.service.file_caption`, `{caption}`), which on a real
panel carried «Limit», «Expires» and raw `<code>` markup. Files were sent only when the
customer tapped «📁 دریافت فایل‌های اتصال». The panel limits the bytes to once a minute
per user and answers 429 inside that window.

**The service card and its actions.** The card is `bot.service.card`, drawn by
`BotRuntime.serviceDetail`. Every reply of the bot was a NEW message; nothing edited one.

| action           | before R3                                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ♻️ refresh       | planned `SYNC_USAGE` (a read operation), replied «درخواست به‌روزرسانی ثبت شد…»; the lane later sent «…اعمال شد» or «…نشد»                                                     |
| ⚙️ change link   | «ask» message, `ROTATE_SUBSCRIPTION` planned, «درخواست شما ثبت شد…» sent; on success the PURCHASE card («سرویس با موفقیت ایجاد شد») was re-sent and the lane sent «…اعمال شد» |
| disable / enable | `SUSPEND` / `RESUME` planned, «درخواست شما ثبت شد…» sent; the lane later sent «…اعمال شد» or «…نشد»                                                                           |

The card's chat and message were never recorded, so an asynchronous result had no way to
reach the card.

**Capabilities.** Marzban: read usage, disable, enable, renew, add volume/time — no
rotation, no files. RickPanel: all of those plus `ROTATE_SUBSCRIPTION_LINK` and
`SUBSCRIPTION_FILES`. 3X-UI (frozen): create, read usage, deliver link, limit devices.
R3 declares nothing new; every button is still drawn from the capability and re-decided.

## 2. Decisions

### Item 6 — files after every automatic delivery

`DeliveryService.deliverDue` calls `SubscriptionFileService.sendAfterDelivery` right after
a send it recorded `DELIVERED`. That is the only hook, so it covers a purchase, a trial and
a link change alike, and a delivery that may not have arrived (`UNCONFIRMED`) or that
somebody else recorded is never followed by files. `sendAfterDelivery` keeps every rule of
`send` except ownership (the service is the one the sweep just announced) and charges the
same permission as `SYSTEM_JOB`. It never throws into the sweep and never writes: a panel
that cannot build files, a 429 or a Telegram refusal leaves the service `ACTIVE` and its
delivery `DELIVERED`. The manual button stays for a re-download (subject to the panel's
one-minute limit, which the automatic read has just spent).

### Item 7 — refresh: a bounded read on the tap

`ServiceRefreshService.refresh` reads usage from the panel while the customer waits and
the bot edits the same card with the answer; on failure the card is untouched and the
button answers `bot.service.refresh_failed` as a notice. Chosen over "operation, then edit
the stored card" because the operation model exists for mutations and `UNKNOWN`; a read
cannot be `UNKNOWN`, and the async path could only report a failure as a new message
minutes later (the callback expires). The bounds are Package E's: network outside every
transaction, the tenant's probe budget (reserve 0), `SafeHttpClient`, the URL policy, the
minimum interval (inside it the stored figure is shown without a read), and the same
conditional `recordUsage` the `SYNC_USAGE` executor writes. The scheduled `SYNC_USAGE` is
unchanged.

The interval is not only read, it is RESERVED (Codex review of #110): a conditional UPDATE
of `services.usage_refresh_started_at` (no read in flight, or one older than three panel
timeouts plus a margin and so presumed dead; and usage not read within the interval) runs
in the transaction that takes the budget, before the panel is dialled. Two taps or a
redelivered update therefore make one read; the other redraws the card from what is
stored. A refused budget rolls the reservation back; the read's end clears it.

### Item 8 — captions

Every file carries `bot.service.connection_file_caption`: «👤 نام کاربری: {serviceUsername}».
The panel's caption is still parsed and bounded, never shown.

### Item 9 — change link

`ROTATE_SUBSCRIPTION` and its adapter-side ambiguity rule are unchanged. The ask replaces
the card in place (with a way back, `sv:`), the confirmation puts the card back and sends
nothing. When the panel has minted the new link, the delivery lane — which the rotation
re-arms — sees a `SUCCEEDED` rotation for the service and sends `bot.service.link_rotated`
(the owner's sentence, with the new link) instead of the purchase card, then the new files.
The announcer no longer adds «…اعمال شد» for a rotation's success; its failure and
abandonment are still told. That the old link stops working is the owner's decision for
this sentence; no real panel has been observed refusing it (`OQ-RP-07`).

### Item 10 — disable / enable on the same card

The tap records the card (`operation_card_messages`: bot, chat, message id) beside the
operation in its planning transaction and sends nothing. `OperationCardEditor.answer`, run
by the provisioner loop right after the announcer, claims the card only for a `SUCCEEDED`
`SUSPEND`/`RESUME` a customer asked for (a conditional UPDATE of `answered_at`), renders the
card from the database through the bot's own `serviceDetail`, and edits it: 🟢 ↔ 🔴 and the
switch turned round. The announcer stamps such a success without a message. A failure is
told through the lane (`SERVICE_ACTION_FAILED`) and the card is not touched, because
nothing changed; `SUSPEND`/`RESUME` are idempotent mutations, so there is no `UNKNOWN` to
misreport. A sweep after a 60 s grace answers cards a crash left behind.

### The one fallback

When Telegram cannot edit the card (deleted, too old, not a text message) the same card is
sent ONCE as a new message. The claim is committed before the edit, so two replicas cannot
both fall back. A 429 gives the claim back and holds the card until Telegram's `retry_after` has
passed (`next_attempt_at`, bounded to 10 s – 1 h, 60 s when none is named), so neither the
loop nor the sweep asks a rate-limited bot again sooner; an `UNKNOWN` edit is not retried.
The same rule applies to the in-turn edits (refresh, the link-change ask).

## 3. Rollback

`docs/deployment.md`, "What a rollback changes back: the service card and connection files
(R3)".

## 4. Still needs a real bot and a real panel

- Telegram's `editMessageText` against a real chat, including "message is not modified"
  and a card the customer deleted (the fallback send).
- RickPanel's `/files` right after a create (whether the files exist yet) and after
  `revoke_sub` (whether they carry the new token), and whether the old link stops working.
