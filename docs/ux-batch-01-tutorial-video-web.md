# UX Batch 01 item 6 — «افزودن ویدیو از تلگرام» from the Web Admin

A client app's tutorial video is Telegram's own reference to a video (`file_id`, valid only
for the bot that received it), stored per (app, bot) in `client_app_videos` (spec §7,
`docs/package-h-tutorials-marketing-stars.md`). Until this item it could be set only from the
Telegram management panel («تنظیم ویدیو»). This adds the Web Admin's entry point without a
second session system.

## The session is the existing prompt row

The web opens the SAME `CLIENT_APP_VIDEO` prompt the Telegram panel opens: one row in
`admin_amount_captures` naming the tenant, ONE administrator (the web session's), ONE bot and
ONE app, with a deadline (`CLIENT_APP_VIDEO_CAPTURE_TTL_MS`, 15 minutes). So the properties
the Telegram prompt already has hold for the web one, from the same code:

- **Server-side and short-lived.** The row is the session; the deadline is checked against
  the server's clock. Nothing lives in a browser or in process memory.
- **Single use.** The first accepted video closes it `CONFIRMED`; a further video finds no
  open prompt. A redelivered update answers from the idempotency store.
- **One at a time.** Opening a prompt supersedes this administrator's open prompt on that bot,
  from either surface (the one-open-prompt partial index and the per-administrator lock).
- **Bound to tenant + admin + target.** The bot resolves the sender and offers the video only
  to that administrator's open prompt on that bot (`ClientAppVideoService.receiveVideo`).

No migration: the table already carries everything the web needs.

## How the bot knows the video is that administrator's

Through the binding the product already has: `admins.telegram_user_id`, set by an operator
from the administrators screen (`AdminManagementService.setTelegramBinding`) and resolved on
every update by `TelegramAdminService.resolve` — the numeric Telegram id, never a username,
with revocation taking effect on the next update. No one-time code is needed, because the
binding already proves the Telegram account is the administrator's; a code typed into a chat
would be a second, weaker identity proof beside it.

An administrator with no binding is told so on the card and cannot open a prompt
(`control.client_app_video_telegram_unlinked`): nothing they send could complete it.

## What completes it, and what does not

Completes: a Telegram `video` message, from the bound account, to the named bot, while the
prompt is open, dated no earlier than the prompt's opening less
`CLIENT_APP_VIDEO_WEB_CLOCK_SKEW_MS` (30 s). A web-opened prompt has no tap `update_id` to be
newer than (WP19's rule for Telegram-opened prompts), so Telegram's message `date` stands in:
a video sent before the button, delivered late, cannot complete it.

Never completes: another administrator's video (their own prompt, if any, is a different
row); a customer's video; any message to another bot; a clip sent as a document, a photo,
text; anything after the deadline (closed `EXPIRED`), after a cancel, or after a newer prompt.

## The page

The client app's editor shows each of the tenant's bots, the video it holds (metadata only —
the `file_id` is a sending handle and is not sent to the page), and «افزودن ویدیو از تلگرام»
for an active bot. Opening a prompt shows the instructions, a `https://t.me/<bot>` link and the
deadline, and polls the prompt every 3 s until it is no longer `OPEN`; a `CONFIRMED` prompt
shows the stored video with no copying. Cancel is a button.

## Permissions and audit

`client_apps.edit` to open and cancel, `client_apps.view` to read; a prompt is readable and
cancellable only by the administrator it names, under the app it was opened for (anything else
is `control.client_app_video_session_not_found`, also across tenants). Audit rows:
`client_app.video_session_open`, `client_app.video_session_cancel`,
`client_app.video_session_expired` (written when a cancel finds the deadline already passed; a poll never writes — it reports EXPIRED from the clock, and a late video closes the row on the bot's path), and
the existing `client_app.video_set` written by the bot as the `TELEGRAM_ADMIN` actor.

Tests: `tests/integration/client-app-video-web.test.ts`, `tests/web/client-app-video.test.tsx`.

## Manual acceptance (real Telegram)

With an administrator bound to their Telegram id, press the button, send a real video to the
bot, and watch the card turn to «تنظیم شده» without a reload; then open the app as a customer
and confirm the video plays.
