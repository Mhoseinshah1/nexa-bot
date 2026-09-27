# Package B — mandatory Telegram channel membership: audit and design

The brief (`NEXA_AUTONOMOUS_POST_WP20_BRIEF.md`, Package B) turns the existing "required
channel" setting from display-only configuration into enforcement. This document is written
before the implementation, as the repository's convention requires, and records every
decision the brief leaves to the implementation.

## 1. What already exists, and what does not

- **The setting.** `telegram.channels` (`packages/contracts/src/settings.ts`) is a list of up
  to ten `{ handle, mandatory }` items, unique by handle, tenant-scoped, with
  `consumer: 'PLANNED'`. `mandatory` is required and not defaulted, so every stored channel
  already answers "required or optional" (brief B1). Nothing reads it except the Web Admin
  editor.
- **The editor.** `ChannelListEditor` in `apps/web/src/pages/settings.tsx`: add, remove,
  reorder, a handle input and a "required" switch.
- **No membership read.** The Telegram call module
  (`apps/api/src/infrastructure/telegram/send-message.ts`) has no `getChatMember`.
- **No gate.** `BotRuntime.handle` resolves the customer, applies anti-spam and the BLOCKED
  branch, and hands everything else to `act`. There is no place where a customer is stopped
  for a missing membership.
- **What fits.** The WP20 anti-spam service is the pattern for a check that must fail OPEN:
  a per-bot operational condition, throttled per process, recovered by the next good answer,
  and looked up once a minute when another process may have raised it
  (`anti-spam.service.ts`). The bot token of the receiving bot is available through
  `tokenForBotInstance`, as the Stars pre-checkout answerer uses it.

The brief forbids a second channel configuration system, so the existing setting is
extended, not replaced.

## 2. Design

### 2.1 The configuration (brief B4 "support")

Each `telegram.channels` item becomes:

| field       | meaning                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| `handle`    | the public `@username`, now OPTIONAL — a private channel has none                                     |
| `chatId`    | OPTIONAL numeric Telegram chat id (`-100…`), the identity `getChatMember` is asked about when present |
| `joinUrl`   | OPTIONAL `https://t.me/…` link the join button opens — a private channel's invite link                |
| `mandatory` | unchanged, required, not defaulted                                                                    |

Rules, in the schema:

- an item has a `handle` or a `chatId` — otherwise there is nothing to ask Telegram about;
- a REQUIRED item has a `handle` or a `joinUrl` — otherwise the customer is told to join a
  channel with no way to reach it;
- identities are unique: no two items share a handle, and no two share a chat id.

Every value stored before this package is still valid (a handle and a flag), so nothing is
migrated and a rollback reads the new optional fields as absent. The identity asked about is
`chatId` when present, else `@handle`; the join link is `joinUrl` when present, else
`https://t.me/<handle>`. Membership is never inferred from a join link (B2).

The setting's consumer becomes `ACTIVE`. The change is a contract change and is its own
commit.

### 2.2 Membership truth (brief B2)

`getChatMember(chat_id, user_id)` with the RECEIVING bot's token. The answer is mapped by one
pure function, `membershipOf`:

- `creator`, `administrator`, `member` → MEMBER;
- `restricted` → MEMBER only when `is_member === true`, otherwise NOT_MEMBER;
- `left`, `kicked` → NOT_MEMBER;
- anything else — an unreadable result, a status Telegram has not documented, any failed call
  — → UNKNOWN.

A failed call is never read as NOT_MEMBER. A 400 "chat not found", a 403 "bot is not a
member of the channel", a 5xx, a 429 and a timeout are all UNKNOWN: none of them is
Telegram saying the customer left.

### 2.3 The service

`ChannelMembershipService` (`commerce/customers/application`), because membership is a fact
about a customer's standing, next to anti-spam and blocking. One method:

`missingRequired(scope, { botInstanceId, telegramUserId, fresh })` → the REQUIRED channels
Telegram deterministically says the customer is not in.

It reads the setting through the settings resolver, keeps the mandatory items, and asks
about each in parallel, each call bounded by a short timeout (the turn is waiting). UNKNOWN
counts as satisfied: that is the fail-open rule (B5). Optional channels are never asked about
(B1).

### 2.4 The cache (brief B6)

In memory, per process, bounded (10,000 entries, the oldest evicted first). Keyed by
`tenant : bot : channel identity : Telegram user`, so one tenant's or one bot's answer never
serves another's.

| answer     | kept for |
| ---------- | -------- |
| MEMBER     | 60 s     |
| NOT_MEMBER | 10 s     |
| UNKNOWN    | 10 s     |

UNKNOWN is cached too, so a channel the bot cannot query does not cost a Telegram call on
every button press; ten seconds keeps recovery prompt. The manual "✅ بررسی عضویت" check
(`fresh: true`) ignores a cached NOT_MEMBER or UNKNOWN and asks again; a cached MEMBER is
kept. Nothing is cached forever, and two replicas each keeping their own cache is harmless —
it only means a second call.

### 2.5 Failure policy (brief B5)

An UNKNOWN answer raises the operational condition `channels.membership_unavailable`, per BOT
(dedupe key `channels.membership_unavailable:<bot>`), WARN. Its context names the bot, the
channels that could not be checked, and Telegram's error codes — never the token, and never
the customer. It is written at most once a minute per bot per process. The time of the last
write is kept apart from the fact that an outage is open here, so a channel that flaps between
an answer and none cannot defeat the throttle (Codex review of #86).

The first turn in which every REQUIRED channel of that bot answered records
`channels.membership_recovered`, which resolves it. The key is per bot rather than per channel
for the same review: an operator fixes a channel the bot cannot query by correcting its id or
handle, or by removing it, and a condition keyed by the old identity would never be asked
about again and would stay open for ever. When the outage was raised by another process (a
replica replaced by a rolling update), a good turn looks for the open condition at most once a
minute and resolves it too.

Concurrent turns for the same customer, bot and channel share one `getChatMember` in flight,
so a burst of taps costs one Telegram call per channel rather than one per tap — which would
spend the bot's API quota and turn later checks UNKNOWN.

### 2.6 The central guard (brief B3)

One place: `BotRuntime.handle`, in the branch that would call `act`, before `act`. Not in the
handlers. The guard runs when all of these hold:

- at least one channel is REQUIRED;
- the intent is not exempt;
- `missingRequired` returns a non-empty list;
- the Telegram account is not a bound administrator.

Exempt intents:

- `ADMIN_*` — the management panel;
- `MEMBERSHIP_CHECK` — the check itself;
- `SUPPORT` — the support screen, which `/paysupport` also opens;
- `HELP`.

Everything else is guarded, including `/start`, the main menu and free text. The customer row
is still resolved first — so a `/start ref-…` still attributes the referral — and anti-spam
still counts the interaction; only the business action is withheld.

A bound administrator is never locked out (B3). The binding is asked only when something is
missing, so an ordinary turn pays for no extra lookup — the order anti-spam uses.

### 2.7 The customer (brief B4)

When the guard stops a turn, the requested action does not run. The reply is one message,
`bot.channels.join_required`, with:

- one URL button per missing channel — `@handle` for a public channel,
  `bot.channels.join_private_button` ("کانال N") for a private one;
- the `✅ بررسی عضویت` button (`bot.channels.check_button`, callback `mc`).

Pressing the check button re-checks with `fresh: true`.

- If every required channel now passes, the customer gets the main menu. That is the safe
  entry point, and the action they first asked for is NOT replayed: a purchase, a payment or
  a termination is never run by a membership check.
- Otherwise they get `bot.channels.still_missing` with the same buttons.

### 2.8 Web Admin (brief B5)

The editor gains the chat id and join-link fields and says that the bot must be an
administrator of each required channel. A channel the bot cannot query shows as an OPEN
`channels.membership_unavailable` condition in the operations log, naming the bot and the
channel, until a check works again.

## 3. Rollback

- No migration.
- The setting's new fields are optional, so the release before this one still parses every
  stored value. It stops enforcing, which is the state it shipped with.
- Open `channels.membership_unavailable` conditions stay in the log until resolved.
- **One caveat (Codex review of #86).** A private channel saved with only a `chatId` and a
  `joinUrl` — no `handle` — is not a value the release before this one can parse: its schema
  requires a handle. After a rollback that release reads the whole setting as invalid and
  shows the default, an empty list, while the stored row is kept as it was. Nothing is lost
  unless an operator saves the channel list on the old release, which would overwrite it. So
  before rolling back, remove handle-less channels (or give each a handle), or do not save the
  channel list until rolling forward again. There is no truthful stand-in value that would
  keep the old schema happy: an invented handle would name a channel that is not this one.

## 4. Not done, deliberately

- **A per-bot channel list.** The setting is the tenant's, as it always was. Every bot
  enforces the same list, each with its own token, and each bot's failures are recorded under
  its own condition.
- **Replaying the blocked action after a successful check** (brief B4 forbids it for
  financial and destructive actions; the main menu is the one safe entry point for all of
  them).
- **Periodic re-verification of members in the background.** Membership is checked when the
  customer acts; a customer who leaves is stopped at their next action, within the positive
  cache window.
