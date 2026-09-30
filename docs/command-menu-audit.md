# Round P — COMMAND-MENU: the keyboard, the slash-command menu and the bot buttons, unified

The owner's round P brief, package COMMAND-MENU. One authoritative main-menu configuration;
a Reply Keyboard built from it plus real feature and capability state; the Telegram
command menu (`setMyCommands`) synced per bot instance — idempotent, retryable,
observable, triggered by what changes it — with diagnostics and two operator actions,
«همگام‌سازی دوباره» and «بررسی وضعیت». Branch `claude/p-menu` from `39c5d53`.

## 1. Audit: how it worked at the base

### 1.1 `BOT_COMMANDS` and every `setMyCommands` call site

`packages/contracts/src/bot-commands.ts` declared the one list (`start`, `catalog`,
`services`, `wallet`, `help`, `paysupport`, `apps`, `tickets`), each description a
`bot.command.*` template key. The runtime's `/help` rendered it; nothing else read it.

There was exactly ONE `setMyCommands` caller: `TelegramBotBootstrapGateway.registerCommands`
(over the shared call core `telegramSetMyCommands`), reached from
`BotBootstrapService.reconcileCommands`, which the bootstrap CLI runs on a fresh install
and on every rerun — `botctl telegram register`, and `botctl update` / `botctl rollback`
through `telegram_reconcile_menu` (`OQ-4H-02`). The gateway RENDERED the descriptions
itself from `CATALOGUE_FA` and DIGESTED that rendering (`commandsRevision()`), and the
bootstrap compared the digest with `bot_instances.commands_revision` to decide whether to
call. So:

- a tenant's own `bot.command.*` text (the texts screen accepts overrides for every key)
  never reached Telegram: the gateway rendered the shared defaults, always;
- the R4 token replacement (`docs/wp13-bots-management-audit.md` §7) touched the webhook
  and deliberately not the menu; the WP13 table lists "re-register the command menu" as
  not offered from the web, remedy `botctl telegram register`;
- the bots page's `commandMenu: CURRENT | STALE | UNKNOWN` compared the stored digest
  with the gateway's, and its STALE hint sent the operator to the CLI;
- a bot that became ACTIVE, a changed description, or a flag change queued nothing; the
  only reconciliation was the installer's, once per `botctl update`.

### 1.2 `/start`, `/paysupport`, help and support, admin commands

`bot-runtime.ts` (`intentOf`) parses `/start` (with the referral deep-link payload),
`/catalog`, `/services`, `/wallet`, `/help`, `/paysupport` (Package A: Telegram requires a
bot selling for Stars to answer it; it opens the existing support screen), `/tickets`
(WP-A7) and `/apps` (WP-A10); the two button-only commands `/trial` and `/referral` (R1,
deliberately unregistered: a per-bot list would advertise a trial to every customer of a
tenant offering none); and the management panel's `/admin`, `/link`, `/role`, `/service`,
`/customer`, `/category_new`, `/category_rename`, `/category_emoji`, `/panel_prefix`,
`/panel_template` — parsed for a bound administrator and answered as unknown text for
anyone else. `tests/unit/telegram-command-menu.test.ts` pinned "registered nowhere" for
four of them by a hand-kept set in the test; the underscore commands were outside its
regex and named in a second list. The runtime and the contract had no shared statement
of what is admin-only.

### 1.3 The Reply Keyboard

`MAIN_MENU_BUTTONS` (contracts) declares eight buttons, each `{ id, label: bot.menu.*,
command, wide, feature, needsTrialOffer }`. `bot.main_menu` (registry setting, R1) stores
`[{ button, enabled }]` in display order; `resolveMainMenuLayout` completes a stored
value with every declared button switched on. `MainMenuLayout` (commerce/messaging) is
the one object with two readers: `rowsFor` draws the keyboard — switched-on buttons whose
feature is on and, for the trial, while a panel offers one (`trialOffersFor`, F5 / #114)
— labelled through the tenant's templates and packed two to a row; `routesFor` matches a
tap against EVERY declared button's current label, so a hidden or renamed button still
routes. `TelegramCustomerMessenger` draws it on every reply; the runtime routes through it.

#114's rules held at the base: the trial button is drawn only while a panel offers a
trial and never from a flag; the referral button lives only in the main menu (the wallet
draws none, `referrals.test.ts` F5). Both are kept, and are now also stated per item by
the read model (§3.5).

### 1.4 `/bot-buttons` and its storage

`apps/web/src/pages/bot-buttons.tsx` read `/settings` (for `bot.main_menu`), `/features`
(the referral flag), `/trials/panels` (whether any panel offers a trial, needing
`panels.view`, else "unknown") and `/templates` (the `bot.menu.*` labels, edited with the
texts card). It saved the arrangement whole through `/settings/bot.main_menu` with its
version. It evaluated the gates ITSELF, a second time, in the browser.

### 1.5 Multiple bot instances

`Tenant ≠ BotInstance`; one tenant may own several bots (`bot_instances`), each with its
own token, webhook and `commands_revision`. Token replacement is per bot and leased
(`token_replacement_claim`, R4). Nothing at the base kept a per-bot desired menu, a retry
state, or an attempt count.

### 1.6 The retryable per-row lane pattern to reuse

The notification dispatcher (`claimDue` FOR UPDATE SKIP LOCKED with a lease as
`next_attempt_at`, attempts, tenant ACTIVE) and the bulk/broadcast lanes; every loop
exposes `isFresh` through `LoopProgress`, and `worker-health-coverage.test.ts` refuses a
loop the worker does not watch. The panel monitor's rule — "nothing about a probe is
decided in a process; two replicas is the normal case" — is the one this lane obeys.

## 2. Decisions

### D1 — One desired menu, one evaluator, one digest recipe

`CommandMenu.desiredFor(scope)` (tenancy/application) answers `BOT_COMMANDS` rendered
through the tenant's own `bot.command.*` texts (the resolver every customer message goes
through), trimmed and bounded to Telegram's 256, and its digest. The bootstrap's
reconcile, the bots page's `commandMenu` state, the lane and the menu page all read it.
The gateway no longer renders or digests: `registerCommands({ token, commands })` sends
what it is given and answers `REGISTERED | REFUSED(code) | UNREACHABLE(code)`.

The digest recipe is the gateway's old one (`sha256(JSON([{command, description}…]))`,
32 hex), pinned by a unit test, so an installation that never reworded a description
upgrades with its stored `commands_revision` still current and re-registers nothing.

### D2 — The customer scope is `BOT_COMMANDS`; `ADMIN_ONLY_COMMANDS` is the contract's "never"

The brief's list — `/start`, `/paysupport`, the real help and support commands — is
exactly what the runtime answers for a customer, and `BOT_COMMANDS` already was that
list. Nothing is added to it. What is added is `ADMIN_ONLY_COMMANDS`, so "no admin command
in the customer scope" is held by two tests: disjointness at the contract, and every
admin command the runtime parses ⊆ `ADMIN_ONLY_COMMANDS` (the regex now covers
underscores). The trial and referral commands stay button-only, as R1 decided.

### D3 — The item model: target from a closed set, pinned to the button; slot as a reference

A stored `bot.main_menu` entry gains `target` (from `MAIN_MENU_TARGETS`, the commands the
declared buttons stand for) and `appearanceSlot` (from `MENU_APPEARANCE_SLOTS`, nullable
= the button's default). The schema REFUSES a target that is not the button's declared
action: there is no way to make «کیف پول» open the catalogue, no arbitrary payload, and
"each target at most once" follows from "each button at most once" and is stated on its
own refinement. R1-shaped values (`{ button, enabled }`) stay valid; `resolveMainMenuLayout`
fills the declared target and the default slot.

A slot is a STRING reference into the PREMIUM-UI package's catalogue. `MENU_APPEARANCE_SLOTS`
is a local closed list naming exactly the brief's seventeen slots; Agent UI's branch was
not on `origin` when this was built, and the lead reconciles the two (§7). A Reply Keyboard
button is plain text (Bot API `KeyboardButton.text` carries no entities), so no slot
changes what the keyboard shows; the reference is for the screen the item opens.

### D4 — The keyboard's decision, made once and shown

`MainMenuLayout.describeFor` answers every item with `{ gate: FEATURE | TRIAL_OFFER |
null, gateOpen, shown }`; `buttonsFor` is its shown subset. The Web Admin's table reads
that same answer through `/bot-menu`, so the page no longer evaluates gates in the browser
and no longer needs `panels.view`. For the keyboard a gate is read only when the item is
on (the trial offer dials the panel repositories; a keyboard is drawn on every reply); the
page asks with `gatesForHidden`, so a switched-off item's gate is answered too and the
preview of switching it on is the keyboard's answer — and a gated item whose gate is not
KNOWN open is never previewed (Codex #6).

### D5 — The sync lane: per bot, by digest, leased, backed off, observable

`bot_command_syncs` (migration `0149`) holds per bot: `desired_hash`, `desired_version`
(moves on when the hash changes), `last_synced_at`, `last_attempted_at`,
`last_error_code` (a transport code, never Telegram's description — it quotes the token's
URL), `attempts` (consecutive failures), `next_attempt_at` (NULL = nothing queued) and
`claimed_until` (a lease). What Telegram was last given stays `bot_instances.commands_revision`,
the one column the installer, the bots page and this lane all read; the lane writes it in
the same transaction as the sync row.

`BotCommandSyncService`:

- `requestSync(scope, botId | null, { due }, tx)` — a DB write. `due: true` (a token was
  replaced, an operator asked, a bot became ACTIVE) queues NOW and resets the failure
  count; `due: false` (an event) queues only where the desired digest differs from
  `commands_revision` and nothing is queued yet. Decided under the bot row's lock.
- `attempt(row)` — the token through `tokenForBotInstance` (ACTIVE only, `OQ-5R-02`),
  the list rendered NOW, `setMyCommands` OUTSIDE any transaction on the shared gateway,
  then one transaction: the row FIRST, WHERE it still holds this attempt's claim (its
  `claimedUntil`; a lapsed claim taken over by another worker records nothing, Codex #4),
  then `commands_revision` (the digest SENT), an audit row `bot.commands.sync`, and the
  condition `bot.command_sync_failing` (WARN, deduped per bot, opened at the third
  consecutive failure) or `bot.command_sync_recovered` (only when the condition is open,
  read through the same transaction). A success clears the queue only while the row still
  wants the sent digest; a description edited in flight leaves it due (Codex #3). Back-off
  `30 s · 2^(n−1)`, capped at one hour, a 429's `retry_after` honoured when longer (the
  gateway carries it, Codex #2). Attempts are unbounded: a bot that never answers is
  asked once an hour and heals itself when Telegram answers.
- `tick(now)` — `claimDue` across ACTIVE tenants and ACTIVE bots, FOR UPDATE SKIP LOCKED,
  leased for one call plus a minute (never under two minutes); each row attempted in
  isolation. Two replicas split the batch.
- `reconcile()` — every five minutes, re-derive every ACTIVE bot's desired digest and
  queue what differs and is not queued; paged by bot id until a short page, so an
  installation of any size is swept whole (Codex #1). Covers a release that changed `BOT_COMMANDS` on
  an installation the installer's reconcile did not reach, and any lost event.
- `syncNow(scope, botId)` — `claimOne` then `attempt`; never throws; `SKIPPED` for a bot
  that is not ACTIVE or is held by a live claim.
- `check(scope, botId | null)` — `getMyCommands` (new on the call core; a read) against
  the desired list. Nothing is stored: a live answer is not a durable state.

`BotCommandSyncConsumer` (outbox, `tenancy.bot_command_sync`) queues on
`TemplateOverrideChanged` / `Reverted` for a `bot.command.*` key, `SettingChanged` for
`bot.main_menu`, any `FeatureFlagChanged`, `BotInstanceStatusChanged` to ACTIVE and
`BotInstanceRegistered`. A DB write inside the relay's claim; the call is the lane's.
No command is feature-gated today, so a flag or the arrangement re-derives an unchanged
digest and queues nothing — the trigger is wired for a release that gates one.

### D6 — Token replacement: the menu after the token, as a separate result

`replaceToken` queues the sync (`due: true`) INSIDE the storing transaction — a process
that dies before the sync runs leaves a due row the worker picks up — and runs `syncNow`
AFTER the claim is released. The answer gains `commandSync: { outcome, errorCode } | null`
(null on a replay: the first answer is remembered before the sync runs). A menu that could
not be registered never turns a verified replacement into a failure: no
`bot.token_replacement_incomplete`, no compensation, the token stored, a 201 — proven by
`bot-token-replacement.test.ts` against the R4 path with `setMyCommands` answering 500.

Whether Telegram keeps a bot's command list across a BotFather revocation is not
established here (`OQ-P-MENU-01`); the menu is re-registered with the new token either way.

### D7 — The menu page reads one endpoint and writes through none of its own

`GET /bot-menu` (`settings.view`): items (order, enabled, target, label, default label,
overridden?, slot, default slot, gate, gate open?, shown now), the keyboard rows as the
bot draws them now, the command list and its digest, every bot's sync view.
`POST /bot-menu/sync` and `POST /bot-menu/check` (`settings.edit`, the permission the
bots page's live check charges, because both use the bot's credential; denials audited).
The arrangement is still saved through `/settings/bot.main_menu` (versioned, audited,
`SettingChanged`), the labels and descriptions through `/templates`.

### D8 — What is deliberately NOT here

- A settable target. A button opens exactly the command it is declared for.
- A per-bot menu. The command list is the tenant's; every bot of the tenant gets it.
- Command scopes or languages (`BotCommandScope*`, `language_code`). This installation
  sends neither, so the default scope is the one modelled, registered and read.
- A `deleteMyCommands`. Nothing here empties a menu.
- A domain event from the lane. No state machine moved; the audit row and the condition
  record the act. `commandSync` on the replacement answer is a result, not an event.
- Anything that lets an operator type a callback payload.

## 3. Provider facts relied on (Telegram Bot API, `core.telegram.org/bots/api`)

- `setMyCommands(commands, scope?, language_code?)` — "Use this method to change the list
  of the bot's commands"; `commands` is a JSON-serialized list of `BotCommand`, at most
  100; returns True. Omitting `scope` means `BotCommandScopeDefault`.
- `BotCommand` — `command`: 1–32 characters, lowercase English letters, digits and
  underscores; `description`: 1–256 characters. The test fake models both bounds and
  answers 400 outside them; the desired list is trimmed and cut at 256.
- `getMyCommands(scope?, language_code?)` — returns an Array of `BotCommand`; "If
  commands aren't set, an empty list is returned." A read.
- `KeyboardButton.text` — plain text; a reply-keyboard button carries no entities, which
  is why an appearance slot cannot change what the keyboard shows (D3).
- What the docs do NOT say, and this package does not assume: whether the command list
  survives a token revocation (`OQ-P-MENU-01`).

## 4. Files

- Contracts (own commit): `bot-commands.ts` (`ADMIN_ONLY_COMMANDS`, `MAIN_MENU_TARGETS`,
  `BotMenuButton.appearanceSlot`, entry `target` / `appearanceSlot`, `MainMenuItem`,
  `mainMenuEntryOf`), `menu-appearance.ts` (the local slot list), `bot-menu.ts` (states,
  outcomes, gates, HTTP shapes, routes), `bot-management.ts` (`commandSync` on the
  replacement answer).
- Schema: `bot_command_syncs`; migration `0149_command_menu_sync`.
- API: `tenancy/domain/bot-command-sync.ts`, `tenancy/application/{command-menu,
bot-command-sync-ports, bot-command-sync.service, bot-command-sync.consumer,
bot-command-sync-loop, bot-menu.service}.ts`, `tenancy/infrastructure/drizzle-bot-command-sync.repository.ts`,
  `surfaces/web/bot-menu.controller.ts`; `send-message.ts` (`telegramGetMyCommands`);
  the gateway, the bootstrap and bot-management services, `MainMenuLayout.describeFor`,
  the container and `main.worker.ts`.
- Web: `pages/bot-buttons.tsx` (rewritten around `/bot-menu`), `pages/bots.tsx` (the
  replacement's sync notice), `api/client.ts`, `web.fa.ts`, `app.tsx`.
- Tests: `tests/unit/bot-command-sync.test.ts`, `main-menu-layout.test.ts`,
  `telegram-command-menu.test.ts`, `bot-bootstrap.test.ts`;
  `tests/integration/bot-command-sync.test.ts`, `bot-token-replacement.test.ts`,
  `bot-management.test.ts`, `bot-bootstrap-identity.test.ts`; `tests/web/bot-buttons.test.tsx`,
  `bots.test.tsx`; `tests/support/fake-telegram-bot-api.ts` (`setMyCommands`, `getMyCommands`).

## 5. Tests, and what each regression is pinned by

The brief's minimum, each named to its test:

| Requirement                                      | Test                                                                                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| order and labels reflected in the keyboard       | `main-menu-layout.test.ts` "reflects a rename and a reorder on the very next render"; "draws the operator's order"                                               |
| dead / disabled features absent                  | `main-menu-layout.test.ts` "describes every item…"; `bot-command-sync.test.ts` (integration) "reads the whole configuration" (referral on, flag off → not shown) |
| Trial only while a panel offers one (#114)       | `main-menu-layout.test.ts` "draws the trial button exactly while a panel offers a trial" (kept), `describeFor` case                                              |
| Referral only in the main menu, not the wallet   | `referrals.test.ts` "draws no referral button on /wallet" (kept, unchanged)                                                                                      |
| only real commands sent to `setMyCommands`       | unit "sends exactly the customer scope"; integration "registers exactly BOT_COMMANDS, worded by the tenant"                                                      |
| no admin command in the customer scope           | `telegram-command-menu.test.ts` (disjointness + every parsed admin command declared); the two above                                                              |
| token replacement triggers a safe menu sync      | `bot-token-replacement.test.ts` "registers the command menu with the new token after storing it"                                                                 |
| sync failure remains a recoverable warning       | `bot-token-replacement.test.ts` "keeps a replacement whose menu registration failed a SUCCESS…"                                                                  |
| duplicate targets refused at write               | `main-menu-layout.test.ts` "pins each button to its declared action and refuses any other target"; HTTP 400 case                                                 |
| idempotent by digest                             | integration "queues a sync when a bot.command.* text changes, and not when an unrelated text or the arrangement does"                                            |
| retryable, bounded back-off, observable, deduped | integration "retries a failed registration with bounded back-off, warns once after three, and recovers"                                                          |
| one bad instance never blocks the others         | integration "syncs every ACTIVE bot… one refused bot does not block the others"                                                                                  |
| stopped bot / stopped tenant never dialled       | integration "never claims a stopped bot or a stopped tenant…"                                                                                                    |
| two replicas, lapsed lease                       | integration "two workers claiming at once split the due rows, and a lapsed claim is retried"                                                                     |
| no token, no payload anywhere                    | integration "records no token, no description of Telegram's and no payload anywhere"                                                                             |
| «همگام‌سازی دوباره» / «بررسی وضعیت»              | integration "resyncs on request under settings.edit, idempotently, and checks what Telegram holds"; web sync-card case                                           |

### Mutation evidence

Each rule below was reverted once, its named test run alone, and the file restored with
`git checkout`. Output lines are the runner's own (`Tests  N failed`).

| #   | Mutation (the rule reverted)                                   | Test                                                                  | Result             |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------ |
| U1  | `commandSyncStateOf`: STOPPED judged after the queue           | unit "answers where a bot stands"                                     | 1 failed           |
| U2  | `commandSyncBackoffMs`: the one-hour cap removed               | unit "backs off exponentially"                                        | 1 failed           |
| U3  | `CommandMenu`: `/admin` appended to the desired list           | unit "sends exactly the customer scope"                               | 1 failed           |
| U4  | consumer: any template change queues                           | unit "queues on a bot.command.* text change"                          | 1 failed           |
| U5  | contracts: the target refinement replaced by `() => true`      | unit "pins each button to its declared action"                        | 1 failed           |
| U6  | `describeFor`: `shown = enabled`, the gate ignored             | unit `MainMenuLayout` describe block                                  | 3 failed, 4 passed |
| U7  | contracts: `link` left out of `ADMIN_ONLY_COMMANDS`            | unit "names every command the runtime answers"                        | 1 failed           |
| U8  | loop: the reconcile sweep runs once, never again               | unit "reconciles on its first tick and again only after the interval" | 1 failed           |
| I1  | `claimDue`: the ACTIVE-bot filter removed                      | integration "never claims a stopped bot"                              | 1 failed           |
| I2  | `replaceToken`: a FAILED menu sync throws                      | integration "keeps a replacement whose menu registration failed…"     | 1 failed           |
| I3  | success record: `commands_revision` not written                | integration "…records the digest of what it sent"                     | 1 failed           |
| I4  | warning threshold 3 → 1                                        | integration "warns once after three"                                  | 1 failed           |
| I5  | `replaceToken`: no sync after storing (`commandSync: null`)    | integration "registers the command menu with the new token…"          | 1 failed           |
| I6  | consumer: any template change queues (integration)             | integration "…not when an unrelated text or the arrangement does"     | **1 passed**       |
| I7  | `upsertDesired`: `queue = true`, the digest comparison ignored | integration "…not when an unrelated text or the arrangement does"     | 1 failed           |

I6 SURVIVED, and that is recorded rather than hidden: the consumer's `bot.command.`
prefix is an optimisation. The rule that nothing is sent for an unrelated change is held
by the digest comparison in `upsertDesired`, which I7 proves; U4 pins the filter itself.

### The Codex review round (PR #119, seven P2 findings — all confirmed and fixed)

| #   | Finding, and the rule now in force                                                                                                                                                 | Test                                                                                                                                 | Mutation, result                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 1   | The sweep read one page of 500 bots for ever. It pages by bot id (keyset) until a short page.                                                                                      | integration "reconciles every bot, page after page, not only the first page"                                                         | loop stops after the first page — 1 failed                       |
| 2   | A 429's `retry_after` was dropped by the gateway. `UNREACHABLE` carries `retryAfterMs`; the back-off takes the longer of the two.                                                  | unit gateway "carries a 429's retry_after…"; integration "waits out Telegram's retry_after…"                                         | gateway drops it — 1 failed; service ignores it — 1 failed       |
| 3   | `recordSuccess` cleared the queue unconditionally, erasing an edit consumed in flight. Cleared only while the row still wants the SENT digest.                                     | integration "keeps a row due when the description changed while the registration was in flight"                                      | unconditional NULL — 1 failed                                    |
| 4   | Success, failure and release were predicated on bot and tenant only. Every record names the claim (`claimedUntil`) and writes nothing without it.                                  | integration "records nothing for a claim another worker took over while the call was in flight"                                      | claim predicate removed — 1 failed                               |
| 5   | `slice(0, 256)` could split a surrogate pair. `boundDescription` steps the cut back one unit when it would.                                                                        | unit "bounds a description at 256 units without splitting a surrogate pair"                                                          | plain slice — 1 failed                                           |
| 6   | The preview read `gateOpen: null` as open. `describeFor` answers gates for switched-off items when the page asks; the preview draws a gated item only when its gate is KNOWN open. | unit "reads a switched-off item's gate only when asked to"; web "keeps a gated item out of the preview until its gate is known open" | option ignored — 1 failed; `!== false` in the preview — 1 failed |
| 7   | `TemplateCard` invalidated only its own queries. It gains `onChanged`; the page re-reads `['bot-menu']`.                                                                           | web "re-reads the menu after a label is saved through the texts card"                                                                | `onChanged` never run — 1 failed                                 |

## 6. Deployment and rollback

See `docs/deployment.md`, "What a rollback leaves queued: the command-menu sync (round P)".

## 7. Open items and what needs real acceptance

- **Slot list reconciliation.** `MENU_APPEARANCE_SLOTS` is local; the lead reconciles it
  against the PREMIUM-UI catalogue's names and the Persian labels
  (`web.appearance_slot_*`) at merge time. The stored value is a string, so a rename is a
  schema edit plus a data note, not a migration.
- **`boundDescription`** (Codex #5) cuts at 256 UTF-16 units without splitting a pair; the
  texts card saving a label or a description re-reads `/bot-menu` (Codex #7).
- **Real Telegram acceptance.** The fake models the documented bounds; a real bot must
  confirm (a) `setMyCommands` with the Persian descriptions as rendered, (b)
  `getMyCommands` answers the same list, (c) the client draws the menu button after a
  sync, (d) what a BotFather revocation does to the list (`OQ-P-MENU-01`).
- **`botctl telegram status`** is unchanged: it reports the installer's word. The lane's
  state is on the menu page and in the bots page's `commandMenu`.
- **A description override that renders empty** is sent as-is and refused by Telegram
  (400), recorded as `telegram.rejected.400` and shown with the remedy on the page. Not
  refused at the texts screen: that screen does not know which keys feed a menu.
