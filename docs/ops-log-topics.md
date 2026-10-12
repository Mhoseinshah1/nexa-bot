# Operations log topics

The connected operations log group («گروه گزارش‌های مدیریتی», WP-A4) has one forum topic
per operational concern. Nexa creates them, names them in Persian, recreates one an
operator deletes, and routes each operational event to one of them by its code. This
page is the routing table and the reasoning behind it (spec §12).

The source of truth is `packages/contracts/src/ops-log-group.ts`
(`OPS_LOG_TOPIC_CATEGORIES`, `OPS_LOG_TOPIC_ROUTES`, `OPS_LOG_TOPIC_NAME_TEMPLATES`);
`tests/unit/ops-log-group.test.ts` pins every prefix below to its topic.

## The topics

| Key        | Name (template default) | What lands there                                                                                            | Code prefixes                                                                                               |
| ---------- | ----------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `SYSTEM`   | ⚙️ سیستم                | The platform's own loops and plumbing — and **anything no other route claims** (the fallback).              | `outbox.`, `notification.`, `settings.`, `ops_group.`, `tenant.`, `system.`, …                              |
| `ERRORS`   | 🚨 خطاها                | Failures nobody anticipated: unhandled exceptions, errors the API answered.                                 | `internal.`, `http.`, `request.`                                                                            |
| `PAYMENTS` | 💳 پرداخت‌ها            | Payments, gateways, refunds, wallet, the exchange rate — and the financial log (WP18).                      | `payments.`, `payment.`, `refunds.`, `refund.`, `wallet.`, `gateway`, `order.refunded_undeliverable`, `fx.` |
| `SERVICES` | 🧩 سفارش‌ها و سرویس‌ها  | What a customer bought: provisioning on a panel and the order around it.                                    | `provisioning.`, `order.`, `service.`                                                                       |
| `PANELS`   | 🖥 پنل‌ها                | Panel health, probes and capacity.                                                                          | `panel.`                                                                                                    |
| `BOT`      | 🤖 ربات و پیام‌رسانی    | The bots themselves: sends to customers, menus and commands, channel checks, token replacement.             | `telegram.`, `bot.`, `bot_menu.`, `channels.`, `support.`                                                   |
| `SECURITY` | 🛡 امنیت و دسترسی        | Who may do what: refusals, sign-in lock-outs, administrator changes, spam protection.                       | `access.`, `auth.`, `admin.`, `antispam.`, `payments.gateway_webhook_`                                      |
| `BACKUPS`  | 💾 بکاپ‌ها              | The encrypted backup archives themselves, the notice for one too large to send, and backup/recovery events. | `backup.`, `recovery.`                                                                                      |

First match wins, in the order of `OPS_LOG_TOPIC_ROUTES`; `order.refunded_undeliverable`
is listed before `order.` on purpose — a refund is the payments log's even though its
code names the order. Two more are ordered on purpose (FIX-03, batch 2026-10-10):
`payments.gateway_webhook_` before `payments.`, because a webhook whose signature did
not verify is a refused request — presented as SECURITY, so it is read in SECURITY, its
recovery beside it; and `support.assistant.` (SYSTEM, beside the other process roles'
stalls) before `support.` (BOT: business-chat updates, business connections and
hand-offs are failures of a bot's conversations). `tests/unit/ops-error-topics.test.ts`
pins every code in `OPS_ERROR_EVENTS` to its topic.

The names are templates (`ops.group.topic_name.*`), editable in the Web Admin; a new
name applies when a topic is next created or recreated.

## What did not get a topic, and why

The owner's list also named `SUPPORT`, `BROADCAST` and `AUDIT`. Support's own codes
(`support.business_*`, `support.handoff_*`) go to BOT, the bot whose conversations they
are about; broadcasts pass the recorder only to record a permission DENIAL, which is
`access.permission_denied` and belongs in SECURITY; and the audit log is a separate
store (`audit_logs`) that is never projected to Telegram. A topic nothing routes to
would be created in every group and stay empty for
ever. Adding one later is an entry in each of the three tables above and nothing else —
the database pins only the shape of a category key.

## Provisioning, recreation, and two worker replicas

- **Auto-provisioning.** The permission check creates every topic before declaring a
  group healthy; a healthy group's maintenance pass (every 15 seconds) creates any topic
  it is owed and lacks — a category an upgrade added, or one deleted and not yet sent
  to. A pass that finds every topic present makes no Telegram call.
- **Recreation.** A send Telegram refuses with "message thread not found" marks the
  topic MISSING only while the row still names that thread, and the next caller
  recreates it — once per stale thread, however many senders met it.
- **No duplicate topic storms.** Every creation goes through `OpsTopicProvisioner`: a
  unique row per (chat, category) and a conditional claim with a one-minute lease, so
  two replicas, five concurrent senders or a backup delivery racing the dispatcher
  create a topic exactly once. A creation Telegram refuses is not retried every pass:
  the group is sent back for a full check, which records `TOPIC_CREATE_FAILED` and is
  rechecked on the five-minute problem schedule.
- **Fallback.** An event whose code no route claims goes to SYSTEM. A stored category a
  later release wrote (and this one does not know) is read as SYSTEM too, so a rollback
  keeps delivering rather than failing the message. With no group connected at all, an
  event is still queued and preserved, and delivered once a group is connected (HF-A4);
  the manual chat-id settings remain the advanced fallback for an installation that
  never connects one.

## Upgrading

An installation upgraded from the two-topic release keeps its SYSTEM and PAYMENTS
topics (and their thread ids); the other six are created by the first maintenance pass
after the worker starts. Events that previously went to SYSTEM — panels, provisioning,
security, backups — go to their own topics from then on; messages already queued keep
the topic they were queued for. The existing SYSTEM topic keeps the name it was created
with («⚙️ سیستم و خطاها»); rename it in Telegram if you like — Nexa tracks topics by
thread id, never by name.
