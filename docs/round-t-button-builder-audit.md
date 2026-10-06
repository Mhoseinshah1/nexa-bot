# Round T — T0 audit: the Telegram Button Builder as an extension of the main menu

Status: **T0 architecture audit, read-only.** Base: `main` at `25e717a`. Every claim below
cites the file and line it was read from at that commit. Where something could not be
verified it is marked **UNKNOWN** or **UNVERIFIED**, never guessed.

The round's risk, restated: the builder must not become a second menu system. There is one
registry of buttons (`MAIN_MENU_BUTTONS`), one evaluator (`MainMenuLayout`), one route table,
one transport body builder (`textMessageBody`), one appearance eligibility state per bot, and
one settings write discipline (versioned, idempotent, audited, outbox). Round T adds rows,
styles, icons and a draft/publish/revision lifecycle **to those**, and this document fixes
where each addition goes.

---

## 1. Source of truth today

| Thing                                        | Where                                                                                           | Evidence                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Arrangement (order, on/off, appearance slot) | registry setting `bot.main_menu` in `setting_values`                                            | `packages/contracts/src/settings.ts:876-892`                                                                  |
| Setting schema                               | `mainMenuLayoutSchema`                                                                          | `packages/contracts/src/bot-commands.ts:396-420`                                                              |
| Entry schema                                 | `mainMenuLayoutEntrySchema` — **`.strict()`**                                                   | `bot-commands.ts:359-378` (`.strict()` at `:372`)                                                             |
| Default                                      | `DEFAULT_MAIN_MENU_LAYOUT` (every declared button, ON, explicit target, `appearanceSlot: null`) | `bot-commands.ts:423-425`; registry default `settings.ts:886`                                                 |
| Button registry (closed)                     | `MAIN_MENU_BUTTONS` (8 entries), `MAIN_MENU_BUTTON_IDS`                                         | `bot-commands.ts:125-134`, `:221-300`                                                                         |
| Targets (closed)                             | `MAIN_MENU_TARGETS` = catalog, services, wallet, help, trial, referral, apps, tickets           | `bot-commands.ts:102-112`                                                                                     |
| Gates                                        | `feature: 'referrals' \| null`, `needsTrialOffer`                                               | `bot-commands.ts:156`, `:163`; `mainMenuButtonIsGated` `:178-180`                                             |
| Row packing                                  | `packMainMenuRows`: two per row, a `wide` button alone (apps, tickets are wide)                 | `bot-commands.ts:315-335`, `wide` at `:285`, `:295`                                                           |
| Completion of a stored value                 | `resolveMainMenuLayout`: stored order, then every undeclared-in-value button appended **ON**    | `bot-commands.ts:431-448`                                                                                     |
| Resolved → stored                            | `mainMenuEntryOf`                                                                               | `bot-commands.ts:451-458`                                                                                     |
| Labels                                       | templates `bot.menu.*` (PLAIN_TEXT, no placeholders)                                            | `packages/contracts/src/templates.ts:229-276`; defaults `packages/i18n/src/catalogue.fa.ts:194-200,1036,1240` |
| Evaluator                                    | `MainMenuLayout` (`describeFor` / `buttonsFor` / `rowsFor` / `routesFor`)                       | `apps/api/src/modules/commerce/messaging/application/main-menu.ts:69-169`                                     |

Schema rules in force (all in `mainMenuLayoutSchema`): at most 8 entries (`:398`), each
button once (`:399-401`), each target once (`:408-413`), target must equal the declared one
(`:373-378`), at least one **ungated** button enabled after completion (`:414-420`).
`zeroMeaning: 'LITERAL'` — an empty list means "every button in its default place"
(`settings.ts:888-889`).

Note: rows are **not** stored anywhere today. They are recomputed on every render by packing
the _shown_ subset (`main-menu.ts:138-147`), so hiding a button reflows the rows below it.

## 2. Readers and writers (every call site at `25e717a`)

**Writers of `bot.main_menu`** — exactly one path:

- `apps/web/src/pages/bot-buttons.tsx:242-247,286-290` → `saveSetting({key:'bot.main_menu', value, expectedVersion, idempotencyKey})`
  → `SettingsService.set` (`apps/api/src/modules/control/settings/application/settings.service.ts:203-431`)
  → `DrizzleSettingRepository.upsert` (`.../infrastructure/drizzle-settings.repository.ts:95-148`).
- No Telegram-surface writer, no migration writer after `0142` (grep of `main_menu` in `apps/api/drizzle/*.sql`: none; only the journal tag).
- No `SettingChangeGuard` is registered for `bot.main_menu` (guards are passed at `apps/api/src/container.ts:3012-3030`; none names this key).

**Readers:**

| Reader                           | Purpose                                                                                 | Evidence                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `MainMenuLayout.describeFor`     | the one decision per item (enabled ∧ gate)                                              | `main-menu.ts:79-128` (reads the setting at `:92-95`)                          |
| `MainMenuLayout.rowsFor`         | keyboard rows as rendered labels                                                        | `main-menu.ts:138-147`                                                         |
| `MainMenuLayout.routesFor`       | label → `/command` for EVERY declared button                                            | `main-menu.ts:150-168`                                                         |
| `TelegramCustomerMessenger.send` | draws the keyboard on the last part of a reply                                          | `telegram-customer-messenger.ts:326-347`, `:410`                               |
| `BotRuntime.menuFor`             | route table for a text update                                                           | `apps/api/src/surfaces/telegram/bot-runtime.ts:5063-5067`                      |
| `BotMenuService.config`          | Web Admin read model (`GET /bot-menu`)                                                  | `apps/api/src/modules/platform/tenancy/application/bot-menu.service.ts:93-132` |
| `BotCommandSyncConsumer`         | `SettingChanged` on `bot.main_menu` queues a command-menu re-derive                     | `.../tenancy/application/bot-command-sync.consumer.ts:51-54`                   |
| Web settings page                | hides the key (`SETTINGS_MANAGED_ELSEWHERE`)                                            | `apps/web/src/settings-presentation.ts:104,315-322`                            |
| Web `/bot-buttons`               | draft/preview using `resolveMainMenuLayout`, `packMainMenuRows`, `mainMenuLayoutSchema` | `bot-buttons.tsx:240,260,295-304,365`                                          |

Wiring: one `MainMenuLayout` instance (`container.ts:3659-3684`) is given to the messenger
(`:3732`), to `BotMenuService` (`:3705`) and to the runtime as `menuRoutes` (`:5162`). The
shared-default route map is built in the container from `CATALOGUE_FA` (`:5141-5158`).

## 3. Routing today

1. A reply-keyboard tap arrives as a plain text message whose body is the button's `text`
   (`send-message.ts:401-408` comment; `ports.ts:150-160`).
2. `BotRuntime.menuFor` builds `new Map([...sharedDefaults, ...tenantRoutes])`
   (`bot-runtime.ts:5066`): the tenant's current labels are spread LAST, so they win over a
   shared default with the same text; a shared default the tenant renamed away from still
   routes, so a keyboard already sitting in a chat keeps working (`main-menu.ts:60-64`).
3. `routesFor` renders **every declared** button's label, shown or not
   (`main-menu.ts:150-168`). A hidden button still routes; the turn answers from the
   feature's own state (`main-menu.ts:66-67`).
4. Duplicates: the first declared button keeps the label (`main-menu.ts:165`); the web warns
   (`bot-buttons.tsx:170-172,217-220`).
5. Slash-looking labels: a label starting with `/` routes nothing (`main-menu.ts:164`), and
   `intentOf` never consults the menu for a `/…` message (`bot-runtime.ts:3197-3198`), so a
   label cannot steal `/start`.
6. Matching is on the whole trimmed message (`bot-runtime.ts:3192`).

**Round T consequence (load-bearing):** the button's `text` must stay exactly the rendered
`bot.menu.*` label. An icon is carried ONLY in `icon_custom_emoji_id`; nothing may prepend a
fallback emoji to `text`, or every tap would stop routing. Whether Telegram echoes only
`text` (and not the icon) when an iconed button is tapped is **UNKNOWN** from the repo — it
must be confirmed in real acceptance (§13, R-ACC-3).

## 4. Telegram wire format today

- The only reply-keyboard producer is `textMessageBody` (`apps/api/src/infrastructure/telegram/send-message.ts:374-445`):
  `keyboard: readonly (readonly string[])[]` → `{ keyboard: rows.map(row => row.map(text => ({text}))), resize_keyboard: true, is_persistent: true, one_time_keyboard: false, selective: false }` (`:436-443`).
- Inline `buttons` take precedence — `reply_markup` holds one markup (`:434-435`); a message
  with inline buttons drops the reply keyboard.
- The only caller passing `keyboard` is `TelegramCustomerMessenger.send`
  (`telegram-customer-messenger.ts:402-411`), on the LAST part only (`:410`), with the admin
  row appended for `MAIN_MENU_ADMIN` (`:342-347`). The other `textMessageBody` callers pass no
  keyboard: ops group (`control/ops-group/infrastructure/telegram-ops-group.ts:78`),
  notifications (`control/notifications/infrastructure/telegram-transport.ts:123`), broadcasts
  (`commerce/broadcasts/infrastructure/telegram-broadcast.transport.ts:181`, inline only), the
  appearance probe (`telegram-customer-messenger.ts:1022`).
- Callers requesting it: `bot-runtime.ts:9765,9880,10203` (`MAIN_MENU` / `MAIN_MENU_ADMIN`).
- Outcome taxonomy (`send-message.ts:186-277`): 2xx+ok → SUCCEEDED; 2xx unreadable →
  FAILED_RETRYABLE `telegram.unreadable_response`; 429 → FAILED_RETRYABLE
  `telegram.rate_limited`; ≥500 → FAILED_RETRYABLE; network/timeout → FAILED_RETRYABLE
  `telegram.unreachable`; other 4xx → FAILED_PERMANENT.
- Test fake: `tests/support/fake-telegram-bot-api.ts` does not model `reply_markup` at all
  (grep for `keyboard|reply_markup|custom_emoji`: no match).

### Telegram Bot API facts (verification)

`WebFetch https://core.telegram.org/bots/api` → **EGRESS_BLOCKED** in the audit session. The
owner **CONFIRMED** the facts on 2026-10-01 (update to PR #133); they are no longer open:

- `KeyboardButton.style` accepts exactly `primary`, `success` and `danger` (Bot API 9.4);
  omitted is the client default. Nexa's stored enum `default|primary|success|danger` stays,
  `default` = omit. No custom colours.
- `KeyboardButton.icon_custom_emoji_id` is official, for bots able to use custom emoji
  (purchased Fragment usernames, or in applicable cases an owner with Premium). Nexa's
  per-BotInstance empirical appearance test stays the runtime authority; a tenant's
  eligibility never implies every bot. The icon stays a separate `iconSlot` (§7).
- With no special field other than `text`, `icon_custom_emoji_id` and `style`, a press sends
  `text`. The icon is not prepended, so `bot.menu.*` routing stays valid. Real-Telegram
  acceptance (R-ACC-3) still confirms it.
- Row length: no Telegram-derived cap is stored. `MAIN_MENU_ROW_LENGTH_MAX` and
  `MAIN_MENU_ROWS_MAX` are both the registry size — Nexa domain bounds, NOT Telegram maxima
  (owner, B4).
- Outdated repo statement corrected by T1 (docs only): `docs/command-menu-audit.md` and
  `packages/contracts/src/menu-appearance.ts` said a reply-keyboard button can carry no
  decoration. True of `text`; no longer of the whole `KeyboardButton`.

## 5. Label ownership

- Labels are templates `bot.menu.{catalog,services,wallet,help,trial,referral,apps,tickets}`
  (`templates.ts:229-276` and later entries), edited through the existing template endpoints,
  permission `templates.edit` (`apps/api/src/modules/control/templates/application/template-management.service.ts:48`).
  Template history is `template_revisions` (`apps/api/src/infrastructure/persistence/schema.ts:1257-1300`).
- The page already embeds the texts screen's `TemplateCard` per button
  (`bot-buttons.tsx:159-205`), gated on `templates.view` / `templates.edit`
  (`apps/web/src/app.tsx:957-968`).
- **Decision:** the builder's Inspector label field IS `TemplateCard` (or a thin wrapper
  calling the same `/templates` mutation). Labels are **not** part of the draft: a template
  save is live immediately, and the Inspector says so. The draft never stores a label string.
- The default labels already begin with a Unicode emoji (`catalogue.fa.ts:194-200`). An icon
  on top produces "icon + emoji + text"; the Inspector shows a non-blocking warning when an
  icon slot is set and the rendered label starts with an emoji (presentation only).

## 6. Gate evaluator

- Evaluated in exactly one place: `MainMenuLayout.describeFor` (`main-menu.ts:79-128`).
  Trial = `trials.anyOffered` → `trialOffersFor` over panels (`container.ts:3666-3683`);
  referral = feature flag `referrals` (`bot-commands.ts:276`, `main-menu.ts:111-118`).
  `shown = enabled ∧ (gate = null ∨ gateOpen = true)` (`main-menu.ts:124`).
- The web learns gate state today from `GET /bot-menu` items' `gate` / `gateOpen` / `shownNow`
  (`packages/contracts/src/bot-menu.ts:74-90`), with gates read for switched-off items too
  (`gatesForHidden: true`, `bot-menu.service.ts:97`). The page applies `gateOpen` to its own
  draft switches (`bot-buttons.tsx:292-304`) — that is consumption, not a second gate.
- **Proposed projection (T1):** the builder read returns per registry item
  `{ id, gate, gateOpen }` from the same `describeFor({gatesForHidden:true})`, and the
  contracts export ONE pure function `customerRowsOf(layout, gateOpenById)` that both the
  runtime (with the live gate answers) and the web preview (with the server's `gateOpen`) call.
  "Hidden now" for an item = `placed ∧ enabled ∧ gate ≠ null ∧ gateOpen ≠ true`. React never
  reads a flag or a panel.

## 7. Appearance infrastructure and the icon-slot decision

- Slots: `APPEARANCE_SLOTS` (21, `appearance.ts:43-65`), fallbacks (`:83-105`), stored per
  tenant in `bot_appearance_slots` (custom_emoji_id + enabled + version), via
  `DrizzleAppearanceRepository` (`apps/api/src/modules/control/appearance/infrastructure/drizzle-appearance.repository.ts`).
- Per-bot eligibility: `bot_instances.custom_emoji_test_{tested_at,outcome,error_code}`
  (`drizzle-appearance.repository.ts:51-58,235-256`). Only `SENT` enables decoration
  (`:299-305`). Set by «ارسال پیام آزمایشی» (`telegram-customer-messenger.ts:983-1048`).
- Runtime one-shot fallback: `deliverDecorated` (`telegram-customer-messenger.ts:1070-1098`):
  a decorated request refused with FAILED_PERMANENT (not "not modified") is re-sent ONCE plain;
  if that succeeds, ops event `APPEARANCE_DECORATION_FAILED_CODE` and
  `recordRuntimeRefusal` marks the bot `REJECTED / appearance.custom_emoji_refused`
  (`drizzle-appearance.repository.ts:322-329`); FAILED_RETRYABLE (timeout, 5xx, unreadable 2xx, 429) is never retried. Cache: 30 s per tenant+bot, dropped on refusal and on save/test
  (`:262,272-337`; `container.ts:3755`).
- `decorationFor(scope, botInstanceId)` already returns `{ customEmoji: Map<slot, id> }` for an
  eligible bot and `NO_DECORATION` otherwise — exactly the lookup an icon needs.

### Current semantics of `appearanceSlot` on a menu item

- Documented as the slot for "the screen the item OPENS", explicitly NOT what the keyboard
  shows (`menu-appearance.ts:12-14`; `bot-commands.ts:164-170`; `docs/command-menu-audit.md:115-129`).
- **Every button has a non-null default** (`purchase, service, wallet, support, trial,
referral, link, support` — `bot-commands.ts:229-298`).
- **No runtime consumer**: the only reader of `item.appearanceSlot` in `apps/api/src` is the
  read model (`bot-menu.service.ts:112-113`). It is stored, shown and inert.

### DECISION: a distinct `iconSlot`, not `appearanceSlot`

Reusing `appearanceSlot` as the button icon is **unsafe**:

1. **It changes every unpublished keyboard on upgrade.** Every item resolves to a non-null
   default slot (`resolveMainMenuLayout`, `bot-commands.ts:443`). The moment T2 shipped, every
   ACTIVE bot whose test is `SENT` and whose tenant configured e.g. `wallet` would grow an icon
   on its wallet button with no operator action — violating "legacy layouts produce an identical
   keyboard until publish".
2. **It changes documented meaning** of a stored field (screen decoration → button icon)
   across a contract that three documents state.
3. **It cannot express "no icon"** without `null` meaning "default slot", which it already
   means (`bot-commands.ts:369-370,438-444`).

So each item gains `iconSlot: AppearanceSlot | null` (null = no icon, the default for every
button and for every converted legacy layout). `appearanceSlot` is kept unchanged and
round-tripped. The icon resolves at send time: `iconSlot` → `decorationFor(scope,
sendingBot).customEmoji.get(iconSlot)` → `icon_custom_emoji_id`, else omitted. The label text
is never altered (§3). The builder shows the slot's fallback emoji + "will show only on
eligible bots" indicator; never fake custom-emoji art.

## 8. Audit and history today

- `audit_logs` (`schema.ts:791-824`): action is a free machine code string
  (`packages/contracts/src/ports.ts:177-186`; not an enumerated contract), before/after values,
  DENIED rows written too. Settings writes audit `settings.set` with before/after VALUES
  (`settings.service.ts:363-377`); the menu actions audit `bot_menu.sync` / `bot_menu.check`
  (`bot-menu.service.ts:140-163`).
- Outbox: `SettingChanged` (in the closed `EVENT_TYPES`, `packages/contracts/src/events.ts:70`).
- Settings have **no history table**: `setting_values` holds one row per key
  (`schema.ts:1322-1344`); prior values exist only in `audit_logs.before/after`.
- Precedent for content history: `template_revisions` — append-only by trigger
  (`apps/api/drizzle/0011_control_plane_guards.sql:19`), monotonic `revision` per key, "lives as
  long as the tenant", written in the same transaction as the audit row (`schema.ts:1257-1300`).

## 9. Concurrency and version semantics of settings writes

- `expectedVersion` is **required** (`settings.service.ts:42-55`); null means "I read it unset".
- Pre-check before the no-op shortcut (`:293-299`), then the predicate inside the statement
  (`drizzle-settings.repository.ts:131-147`; first write is `INSERT … ON CONFLICT DO NOTHING`,
  `:114-128`). Zero rows → `control.version_conflict` (409) (`settings.service.ts:352-361`;
  `packages/contracts/src/errors.ts:431`).
- No-op write consumes the idempotency key and reports `changed: false` (`:305-320`).
- Replays return the first result from a JSON snapshot (`SettingReplayRecord`, `:82-124`).
- Scope activity is read inside the transaction (`:269-274`).
- `SettingChangeGuard` vetoes run in-tx after the no-op shortcut (`:145-153,331-337`).

## 10. Upgrade / rollback risks — proven

**Claim: adding any field to a `bot.main_menu` entry breaks the previous release's parser.**

Proof from the code:

1. `mainMenuLayoutEntrySchema` is `.strict()` (`bot-commands.ts:372`): zod refuses unknown keys.
2. Every read goes through `SettingsResolver.resolveOne`, which `safeParse`s the stored row
   (`settings-resolver.ts:132`). On failure it records the WARN ops event
   `settings.stored_value_invalid` and **returns the registry default**, flagging
   `storedValueInvalid` (`:133-167`). It does not throw.
3. Therefore, after a rollback, the old release would draw `DEFAULT_MAIN_MENU_LAYOUT` — every
   button, declared order — silently discarding the operator's order and switches, and raise
   an operator warning on every read. This is exactly what happened across round P and is
   documented: `docs/deployment.md:1700-1707`.
4. Worse: the documented workaround ("save the arrangement once on the old release",
   `docs/deployment.md:1706-1707`) **overwrites** the newer value with the old shape, losing
   the newer fields on roll-forward.

ADR-0022's policy is "release N's code writes both shapes and reads the new one"
(`docs/adr/0022-deployment-topology.md:191-205`). The design below follows it literally.

Other storage risks:

- New tables are invisible to the old release (it neither reads nor writes them) — safe.
- A new `CHECK`-pinned enum in an existing table would be the notification-kind hazard
  (`docs/deployment.md:823-871`). **The design adds no value to any existing CHECK.**
- A new `EVENT_TYPES` entry would be a contract change and an outbox row the old relay does
  not know. **The design emits only the existing `SettingChanged`.**
- A row written by a FUTURE release with a newer snapshot shape, read by Round T after a
  rollback: handled by the snapshot's `v` field + projection floor (§11.2).

## 11. RECOMMENDED DESIGN

### 11.1 Persistence model

`bot.main_menu` stays, **unchanged in schema**, as the **compatibility projection**. The
explicit model lives in adjacent tables. `mainMenuLayoutSchema` / `mainMenuLayoutEntrySchema`
are frozen by Round T (a test pins them, §13).

Migration **`0156_round_t_button_builder`** (T1 owns numbering; `0155` is the last journal
entry, `apps/api/drizzle/meta/_journal.json`):

```
main_menu_layouts                     -- one row per tenant; draft + published head
  tenant_id            uuid PK → tenants
  draft                jsonb NOT NULL  CHECK (jsonb_typeof(draft)='object')
  draft_version        int  NOT NULL DEFAULT 1 CHECK (>= 1)
  draft_updated_at     timestamptz NOT NULL
  draft_updated_by_admin_id uuid NULL  (FK tenant_id,admin → admins)
  draft_restored_from_revision_id uuid NULL → main_menu_revisions(id)
  published            jsonb NULL      CHECK (published IS NULL OR jsonb_typeof(published)='object')
  published_revision   int NULL        CHECK (published_revision IS NULL OR >= 1)
  published_at         timestamptz NULL
  published_by_admin_id uuid NULL
  projection_setting_version int NULL  -- setting_values.version written by that publish
  CHECK ((published IS NULL) = (published_revision IS NULL)
     AND (published IS NULL) = (projection_setting_version IS NULL))

main_menu_revisions                   -- append-only (UPDATE/DELETE refused by trigger, as 0011)
  id uuid PK, tenant_id uuid → tenants
  revision int NOT NULL CHECK (>= 1)  UNIQUE (tenant_id, revision)
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object')
  restored_from_revision_id uuid NULL → main_menu_revisions(id)
  created_at timestamptz NOT NULL, created_by_admin_id uuid NULL (FK tenant,admin)
  index (tenant_id, revision DESC)
```

Only a **publish** writes a revision. Draft saves, reset and restore change only the draft
(audited). No row exists for a tenant until its first draft save; absence = "legacy, never
used the builder".

### 11.2 The explicit layout (contracts, new file `packages/contracts/src/bot-menu-builder.ts`)

```ts
export const MAIN_MENU_BUTTON_STYLES = ['default', 'primary', 'success', 'danger'] as const;
export const MAIN_MENU_ROWS_MAX = MAIN_MENU_BUTTON_IDS.length;       // domain bound, not Telegram's
export const MAIN_MENU_ROW_LENGTH_MAX = MAIN_MENU_BUTTON_IDS.length; // domain bound, not Telegram's
export const MAIN_MENU_LAYOUT_V = 1;

mainMenuButtonConfigSchema = z.object({
  button: z.enum(MAIN_MENU_BUTTON_IDS),
  enabled: z.boolean(),
  style: z.enum(MAIN_MENU_BUTTON_STYLES),
  iconSlot: z.enum(APPEARANCE_SLOTS).nullable(),
  appearanceSlot: z.enum(MENU_APPEARANCE_SLOTS).nullable(),   // round-tripped, unchanged meaning
}).strict();

explicitMainMenuSchema = z.object({
  v: z.literal(1),
  rows: z.array(z.array(z.enum(MAIN_MENU_BUTTON_IDS)).min(1).max(8)).max(8),
  buttons: z.array(mainMenuButtonConfigSchema).max(8),   // one per declared id
}).strict()
 .refine(each id at most once across rows)
 .refine(each id at most once in buttons; buttons cover every declared id)
 .refine(every placed id has a config)
 .refine(≥ 1 placed ∧ enabled ∧ ungated button)   // same rule as mainMenuLayoutSchema :414-420
```

Targets are not stored (they are the registry's, `mainMenuTargetOf`); the projection writes
them explicitly as today.

Semantics:

- **Removed (unplaced)**: the id is in `buttons` but in no row. It sits in the Available pool,
  is not drawn, and keeps its style/icon config for when it is placed again.
- **Disabled**: placed in a row, `enabled: false`. Keeps its position; not drawn; shown
  dimmed in the editor preview, absent in the customer preview.
- **Gated & closed**: placed, enabled, gate closed now → not drawn; "hidden now" badge.
- **Rendering rule (`customerRowsOf`)**: for each row, keep buttons that are enabled and
  whose gate is open; drop a row that becomes empty; **no reflow** between rows. Rows are the
  operator's, not a packing.
- A button declared by a LATER release and absent from `buttons` resolves as **unplaced,
  enabled** (in the pool, "new" badge) — never auto-drawn on an explicit layout (OQ-T-2).
- **Unreadable published snapshot** (unknown `v`, or fails parse after a rollback from a later
  release): runtime falls back to the projection (`bot.main_menu`) via the legacy path and
  records `settings.stored_value_invalid`-style ops event under a NEW code
  `bot_menu.published_unreadable` (contract constant; T1).

### 11.3 Legacy → explicit conversion (seeding the draft)

`explicitFromLegacy(stored: MainMenuLayoutEntry[])`:
`resolveMainMenuLayout(stored)` → placed = the ENABLED items in that order, packed with the
existing `packMainMenuRows` (wide alone, two per row); disabled legacy items become
**unplaced** (legacy "off" = not on the keyboard); every item `style: 'default'`,
`iconSlot: null`, `appearanceSlot` carried (null when not overridden, via `mainMenuEntryOf`).

Property (tested): for every legacy value and every gate assignment in which all gates are
open, `customerRowsOf(explicitFromLegacy(v), allOpen) === rowsFor-legacy(v)`. When a gate is
closed the two can differ (legacy reflows, explicit does not) — which is why the runtime
keeps the **legacy path verbatim** for any tenant without a published explicit layout. The
conversion only seeds a draft; nothing changes for customers until Publish, and the customer
preview shows the explicit result before the operator commits.

### 11.4 Projection (`legacyProjectionOf(explicit)`)

Placed buttons in row-major order with their `enabled`, then unplaced buttons with
`enabled: false`, each with explicit `target` and its `appearanceSlot` (null when default).
`style`, `iconSlot` and row breaks are **not** projected. Guaranteed to parse under the
frozen `mainMenuLayoutSchema` (≤ 8, unique, targets pinned, ≥ 1 ungated enabled follows from
the explicit refine). The previous release reads it as: same order, same visibility, its own
two-per-row packing, no styles/icons. That is a graceful degradation, not a reset.

### 11.5 Runtime reads only Published

`MainMenuLayout` gets a source port `MainMenuSource.currentFor(scope)` returning either
`{ kind: 'EXPLICIT', layout }` or `{ kind: 'LEGACY', entries }`:

- `main_menu_layouts.published` present, parses, and
  `projection_setting_version === setting_values.version(bot.main_menu)` → EXPLICIT.
- No published layout → LEGACY from `bot.main_menu` (today's path, byte-identical).
- Published present but the setting's version moved (written by an older release during a
  rollback — the only remaining writer, since §11.7 closes the new one) → LEGACY from the
  setting (the operator's latest act wins), and the builder read reports
  `superseded: true` so the page says "the live keyboard was changed by an older release;
  review the draft and publish again". No silent overwrite in either direction.
  (Corrected by the T4 review, F-3: the draft cannot publish until it is reseeded from the
  live keyboard — and a revision restored, to bring the published layout back; the page,
  the contracts comment and `docs/deployment.md` now say so.)
- Draft is never read by the runtime. `describeFor`, `rowsFor`, `routesFor` keep their
  contracts; `routesFor` still routes EVERY declared button (placed or not, §3).

### 11.6 Publish atomicity

`POST publish {idempotencyKey, expectedDraftVersion, expectedPublishedRevision}` runs in ONE
`runAuthorizedMutation` transaction (`settings.edit`):

1. `scopeActivity.scopeIsActive(scope, tx)`; 2. `SELECT … FOR UPDATE` the tenant's
   `main_menu_layouts` row; 3. compare `draft_version` and `published_revision` with the
   expectations → `control.version_conflict`; 4. re-parse the draft with
   `explicitMainMenuSchema` server-side; 5. no-op if draft ≡ published (consume key,
   `changed: false`, no revision); 6. resolve `bot.main_menu` in-tx and
   `SettingRepository.upsert(projection, expectedVersion = its version)` — null result →
   conflict; 7. insert `main_menu_revisions` (revision = n+1, `restored_from_revision_id` =
   draft's); 8. conditional UPDATE of the layout row (`published`, `published_revision`,
   `published_at/by`, `projection_setting_version = written.version`,
   `draft_restored_from_revision_id = NULL`) naming the version read in step 2; 9. audit
   `bot_menu.published` (before/after = published snapshots and revision numbers);
2. outbox `SettingChanged {key:'bot.main_menu', from, to}` (existing event → the command-sync
   consumer keeps working, `bot-command-sync.consumer.ts:51-54`); 11. `rememberOnce`.
   Any failure rolls back all of it: there is never a published row without its projection or
   vice versa.

### 11.7 Single writer of `bot.main_menu`

Register a `SettingChangeGuard` for `bot.main_menu` that refuses every real change through
`SettingsService.set` ("managed by the button builder; publish there"). Publish writes the
repository directly inside its own transaction. This closes the second write path that would
otherwise make the projection and the published table disagree.

### 11.8 Draft, reset, restore, revisions

- `PUT draft {idempotencyKey, expectedDraftVersion|null, layout}`: parse server-side, no-op
  detection, conditional UPDATE (or first INSERT `ON CONFLICT DO NOTHING`), audit
  `bot_menu.draft_saved`. Drags are local; only Save Draft is audited.
- `POST reset {idempotencyKey, expectedDraftVersion}` → draft := `explicitFromLegacy(DEFAULT_MAIN_MENU_LAYOUT)`
  (from the authoritative registry), audit `bot_menu.reset`. Confirmation is the web's.
- `POST revisions/:id/restore {idempotencyKey, expectedDraftVersion}` → draft := snapshot
  (tenant-scoped lookup; another tenant's id is 404), `draft_restored_from_revision_id` set,
  audit `bot_menu.restored`. Publishing it creates a NEW revision carrying `restored_from`.
- `GET revisions?before=<revision>&limit≤50` — newest first.
- **Retention**: follow `template_revisions` — append-only by trigger, kept for the tenant's
  life (`schema.ts:1265-1268`). Bounded by construction: ≤ 8 buttons per snapshot (a few
  hundred bytes) and one row per human publish. (OQ-T-3 if the owner wants a cap.)
- Undo/redo: local web state only, never persisted.

### 11.9 Idempotency, permissions, audit codes

- Every write takes `idempotencyKey` (8–255), request-hash checked, first result replayed
  from a JSON snapshot (the `SettingReplayRecord` lesson, `settings.service.ts:58-81`).
- Read: `settings.view`. Draft/publish/reset/restore: `settings.edit`. Labels:
  `templates.edit` via the existing template endpoints, unchanged. Denials audited with the
  same action codes (`recordMutationDenial`).
- Audit actions (declared as constants in contracts, own commit, even though `AuditEntry.action`
  is a string): `bot_menu.draft_saved`, `bot_menu.published`, `bot_menu.reset`,
  `bot_menu.restored`. Entity `MainMenuLayout`, entity id = tenant id.
- Ops event code (contract, own commit): `bot_menu.published_unreadable`.
- No new `EVENT_TYPES`, no new permission, no CHECK widening on an existing table.

### 11.10 API (contracts `BOT_MENU_BUILDER_ROUTES`, controller beside `bot-menu.controller.ts`)

| Method | Path                                      | Body                                                                | Permission    |
| ------ | ----------------------------------------- | ------------------------------------------------------------------- | ------------- |
| GET    | `/bot-menu/builder`                       | —                                                                   | settings.view |
| PUT    | `/bot-menu/builder/draft`                 | `{idempotencyKey, expectedDraftVersion, layout}`                    | settings.edit |
| POST   | `/bot-menu/builder/publish`               | `{idempotencyKey, expectedDraftVersion, expectedPublishedRevision}` | settings.edit |
| POST   | `/bot-menu/builder/reset`                 | `{idempotencyKey, expectedDraftVersion}`                            | settings.edit |
| GET    | `/bot-menu/builder/revisions`             | `?before&limit`                                                     | settings.view |
| POST   | `/bot-menu/builder/revisions/:id/restore` | `{idempotencyKey, expectedDraftVersion}`                            | settings.edit |

`GET` response: `{ source: 'LEGACY'|'EXPLICIT', superseded, draft: {layout, version|null,
updatedAt, restoredFromRevision|null, differsFromPublished}, published: {layout, revision,
publishedAt, by}|null, items: [{id, target, wide, label, defaultLabel, labelOverridden,
defaultAppearanceSlot, gate, gateOpen, duplicateLabel, slashLabel}], live: {rows (customer
rows as drawn now)}, iconEligibility: [{botInstanceId, username, status, eligible}] }`.
When there is no draft row, `draft.layout = explicitFromLegacy(current setting)` with
`version: null`. Existing `GET /bot-menu` stays (sync card, commands card).

### 11.11 Amendments after T1's review (PR #133, owner update 2026-10-01)

- **Durable legacy baseline.** `main_menu_layouts.draft_legacy_setting_version` records the
  `bot.main_menu` version the draft was derived from: stated by the page on the FIRST save
  (the version it seeded from), set to the current version by a reset (`seed: 'DEFAULT'`, or
  `'LIVE'` to reseed from the live arrangement), and moved to the projection's version by
  every publish. While nothing is published, or the published layout is superseded, a
  publish requires the setting to still be at that baseline, else `control.version_conflict`
  — never an overwrite, never a silent rebase on reload. Once a published head is current
  the guard closes the legacy path and draft-version / published-revision concurrency is the
  authority. The read exposes `draft.legacyBaselineVersion` and
  `draft.legacyChangedSinceDraft`.
- **One state read.** `readMenuState` returns the builder row and the `bot.main_menu` row in
  ONE statement; `PublishedMainMenuSource.fromState` turns it into the snapshot (source
  answer + resolved legacy value) for BOTH the runtime (`snapshotFor`) and the builder's
  read, and `MainMenuLayout` computes items and rows from that snapshot (`pinned`) without
  reading the menu state again. Only gate answers are read live.

## 12. File ownership

Sequencing: **T1 merges first**; T2 and T3 then run in parallel on disjoint files.

### T1 — contracts, persistence, publish, revisions, migration (owns migration numbering)

May modify / create:

- `packages/contracts/src/bot-menu-builder.ts` (new), `packages/contracts/src/index.ts`
  (export), `packages/contracts/src/menu-appearance.ts` (comment correction only),
  `packages/contracts/src/bot-menu.ts` (routes constant only, if co-located),
  `packages/contracts/src/errors.ts` (only if a new code is unavoidable — prefer existing
  `control.version_conflict` / `control.invalid_value`).
- `apps/api/src/infrastructure/persistence/schema.ts`, `apps/api/drizzle/0156_round_t_button_builder.sql`,
  `apps/api/drizzle/meta/_journal.json`, `apps/api/drizzle/meta/0156_snapshot.json`.
- `apps/api/src/modules/control/bot-menu-builder/**` (new: service, ports, drizzle repo,
  `MainMenuSource`, `bot.main_menu` change guard).
- `apps/api/src/modules/commerce/messaging/application/main-menu.ts` — source switch only
  (§11.5), strings unchanged.
- `apps/api/src/surfaces/web/bot-menu-builder.controller.ts` (new), `apps/api/src/app.module.ts`,
  `apps/api/src/container.ts` (builder wiring, change guard registration, `MainMenuSource`).
- `apps/web/src/api/client.ts` — **T1 adds the typed client functions** so T3 never edits it.
- Tests: `tests/unit/bot-menu-builder-*.test.ts`, `tests/integration/bot-menu-builder*.test.ts`,
  additions to `tests/unit/main-menu-layout.test.ts`.
- Docs: `docs/deployment.md` (new "What a rollback changes: the button builder (round T)"),
  `docs/command-menu-audit.md:233-234` correction.

T1 contract surface T2/T3 depend on: `MAIN_MENU_BUTTON_STYLES`, `explicitMainMenuSchema`,
types `ExplicitMainMenu`, `MainMenuButtonConfig`, `customerRowsOf(layout, gateOpenById)`,
`explicitFromLegacy`, `legacyProjectionOf`, builder request/response schemas,
`BOT_MENU_BUILDER_ROUTES`, audit action constants, and in the API the port
`MainMenuSource` plus a `MainMenuLayout` that knows each drawn button's `style`/`iconSlot`
(exposed as `keyboardFor` returning `{text, style, iconSlot}[][]` — T1 adds it with
`rowsFor` derived from it, so T2 only consumes it).

### T2 — Telegram runtime and wire

May modify:

- `apps/api/src/infrastructure/telegram/send-message.ts`: central descriptor
  `TelegramReplyKeyboardButton = { text; style?: 'primary'|'success'|'danger'; iconCustomEmojiId?: string }`;
  `textMessageBody.keyboard` accepts descriptors (string accepted for the admin row);
  `default` → `style` omitted; no other markup fields changed.
- `apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger.ts`:
  call `menu.keyboardFor`, resolve `iconSlot` per SENDING bot from the same
  `decorationFor` result already fetched at `:375`; `isDecorated` at `:397` becomes
  `text decorated ∨ keyboard carries an icon`; the `plain` request strips entities AND icons,
  keeps text and styles; admin row unchanged.
- `apps/api/src/modules/commerce/messaging/application/ports.ts` (only if a port widens).
- **Fallback rule (owner, PR #133 update — binding on T2):** a generic permanent Telegram
  400 on a request carrying a keyboard icon must NOT mark the bot's whole custom-emoji
  capability rejected; the shared per-bot state is downgraded only on a reliably classified
  eligibility denial. On a definite, icon-attributable rejection: at most ONE retry without
  `icon_custom_emoji_id`, preserving `text` and any valid `style`. A timeout, an unreadable
  2xx, transport uncertainty or anything that may have landed: NO second send (the UNKNOWN
  discipline).
- `tests/support/fake-telegram-bot-api.ts` (record `reply_markup`), `tests/unit/telegram-messenger-appearance.test.ts`,
  `tests/unit/telegram-messenger-parts.test.ts`, new `tests/unit/telegram-reply-keyboard-*.test.ts`,
  `tests/integration/telegram-customer-turn.test.ts` (additions).

### T3 — Web builder

May modify: `apps/web/src/pages/bot-buttons.tsx` (same route), new
`apps/web/src/pages/bot-buttons/**` components, `apps/web/src/i18n/web.fa.ts`,
`apps/web/src/styles.css` / `apps/web/src/styles/**` for the canvas (no kit API change without the kit owner),
`apps/web/src/pages/telegram-phone.tsx` (preview of styles/icons), `tests/web/bot-buttons.test.tsx`,
new `tests/web/bot-buttons-builder*.test.tsx`, `scripts/visual/fixtures.mjs` (fixtures only).
DnD: implement with pointer + keyboard handlers in-repo or a library only if already a
dependency (`apps/web/package.json` has no DnD library today; adding one is a Lead decision).

### Nobody touches concurrently

`packages/contracts/**` after T1 merges (T2/T3 request changes through the Lead);
`apps/api/drizzle/**` and `schema.ts` (T1 only); `apps/api/src/container.ts` (T1 only;
T2 needs no new wiring if `keyboardFor` exists); `apps/web/src/api/client.ts` (T1 only);
`packages/i18n/**` (no package needs it — labels are unchanged); `bot-runtime.ts` (no
package needs it — routing is unchanged, which is the point); `CLAUDE.md`, `docs/conventions.md`.

## 13. Required tests and falsification targets

**T1 (contracts / persistence / publish / revisions)**

- C-1 legacy: `explicitFromLegacy` × every legacy value fixture (R1 shape, round P shape,
  empty, reordered, disabled) with all gates open → rows equal legacy `rowsFor`.
- C-2 projection compat: `legacyProjectionOf(x)` parses under a **frozen verbatim copy** of
  today's `mainMenuLayoutEntrySchema`/`mainMenuLayoutSchema` kept in the test file (the
  "previous release's parser"), for generated explicit layouts; and a test that the live
  schema still equals the frozen copy on fixtures (Round T must not widen it).
- C-3 placement safety: refuses duplicate placement, unknown id, unknown style, unknown icon
  slot, extra keys, rows > 8, empty row, no ungated enabled placed button, missing config.
- P-1 publish atomic: inject a failure after the projection upsert → no revision, no
  published change, setting unchanged.
- P-2 conflicts: stale `expectedDraftVersion`, stale `expectedPublishedRevision`, a setting
  version moved underneath → `control.version_conflict`, nothing written.
- P-3 idempotent replay returns the first result after a colleague's later publish;
  same key + different body → refused.
- P-4 runtime reads only published: a saved unpublished draft does not change `rowsFor`.
- P-5 superseded: setting written behind a published layout → LEGACY rows + `superseded`.
- P-6 direct `PUT /settings/bot.main_menu` is refused by the guard.
- H-1 revisions tenant-scoped (restore another tenant's id → 404); append-only trigger refuses
  UPDATE/DELETE; restore → draft → publish creates revision n+1 with `restored_from`.
- H-2 audit rows for draft_saved/published/reset/restored, DENIED for a viewer.
- Scope: stopped tenant refused inside the transaction.
- **Mutation targets**: remove the version predicate from the layout UPDATE; drop the
  projection write from publish; drop the guard registration; make `customerRowsOf` reflow;
  make the source switch read `draft`; drop the `projection_setting_version` comparison.

**T2 (runtime / wire)**

- R-1 styles: `default` omits `style`; primary/success/danger emitted verbatim.
- R-2 icons per bot: bot A `SENT` + slot configured → `icon_custom_emoji_id`; bot B untested
  → omitted, same tenant, same message (BotInstance isolation).
- R-3 text unchanged with an icon; tap of that text still routes (`intentOf`).
- R-4 fallback: 4xx on an iconed keyboard → exactly one retry with icons stripped, styles and
  text kept; bot marked REJECTED; ops event. Second refusal → message's answer, no marking.
- R-5 no blind resend: timeout, unreadable 2xx, 5xx, 429 → exactly one request.
- R-6 inline buttons still win over the keyboard; admin row appended unstyled.
- Gates: trial/referral closed → button absent from the explicit rows; still routes.
- Routing: renamed label, default label, duplicate, slash label — unchanged behaviour on an
  explicit layout.
- **Mutation targets**: `isDecorated` ignoring keyboard icons; the plain request keeping icons;
  retrying on FAILED_RETRYABLE; resolving icons from `configuredDecoration` instead of
  `decorationFor(sendingBot)`; prepending the fallback emoji to `text`.

**T3 (web)**

- Every control and state: Saved / Unsaved / Draft differs / Publishing / Published /
  Conflict (409 → reload offer, no silent overwrite) / Invalid (server issues shown).
- Remove vs disable produce different drafts; pool lists unplaced; target read-only.
- Non-drag fallback (move row/button via buttons + keyboard), unsaved-changes guard, reset
  confirm, history list + restore, viewer without `settings.edit` sees no actions, without
  `templates.view` sees the label banner.
- Preview uses `customerRowsOf` with server `gateOpen` (no gate logic in React — test that
  flipping `gateOpen` in the fixture is the only thing that hides a gated button).
- Visual QA at 1440/900/390, light/dark, RTL (`scripts/visual`).

**Real Telegram acceptance (not CI; checklist for the Lead)**

- R-ACC-1 style values render and the request is accepted on the production Bot API.
- R-ACC-2 `icon_custom_emoji_id` accepted by an eligible bot; refused (what code?) by an
  ineligible one, and the one-shot fallback lands.
- R-ACC-3 tapping an iconed/styled button sends exactly the label `text` (routing).
- R-ACC-4 rollback to the previous release on staging: keyboard shows same order/visibility
  from the projection, no `settings.stored_value_invalid` event.

## 14. Open questions for the owner (each with a default the round proceeds on)

- **OQ-T-1 Labels are live, not drafted.** Editing a label in the Inspector saves the
  `bot.menu.*` template immediately (existing mechanism), outside Draft/Publish.
  _Default: yes, with an explicit "applies immediately" note in the Inspector._
- **OQ-T-2 A button a future release adds**, on a tenant with an explicit published layout:
  _Default: lands unplaced in the pool with a "new" badge; never auto-drawn._
- **OQ-T-3 Revision retention.** _Default: keep all, append-only, as `template_revisions`;
  history read is paginated._
- **OQ-T-4 Icon eligibility is shared with message decoration** (one per-bot state; a refused
  icon also turns text decoration off for that bot until re-tested). _Default: shared — one
  eligibility truth per bot; revisit only if real acceptance shows Telegram grants the two
  differently._

UNKNOWNs to log in `docs/open-questions.md` by T1: Bot API `KeyboardButton.style` /
`icon_custom_emoji_id` exact semantics and eligibility (not verifiable from this session —
egress blocked), reply-keyboard per-row limits, and what a tap on an iconed button sends.

## 15. T2 — as built (runtime and wire)

Branch `round-t/t2-telegram-wire`; falsification record `docs/round-t-t2-falsification.md`.

**Wire.** `send-message.ts` holds the one descriptor, `TelegramReplyKeyboardButton
{ text; style?; iconCustomEmojiId? }`, and `replyKeyboardButtonMarkup` turns each into a
`KeyboardButton`. `textMessageBody.keyboard` accepts a string (`{ text }`, the admin row) or a
descriptor. `style` is written only when it is one of `primary | success | danger`; an empty
icon id is never written. Nothing else in the markup changed (`resize_keyboard`,
`is_persistent`, `one_time_keyboard`, `selective`; inline buttons still win).

```jsonc
// published layout, eligible bot (wallet: success + icon; catalog: primary; help: default)
{ "keyboard": [[{ "text": "<bot.menu.wallet>", "style": "success", "icon_custom_emoji_id": "5368…286" },
                { "text": "<bot.menu.catalog>", "style": "primary" }],
               [{ "text": "<bot.menu.help>" }]], "resize_keyboard": true, … }
// same message from a second bot of the tenant whose appearance test is not SENT: no icon
// never-published tenant, any bot: exactly the pre-round-T bytes — [{ "text": … }] only
```

**Per-bot icons.** `TelegramCustomerMessenger.send` reads `menu.keyboardFor(scope)` and the
SENDING bot's `decorationFor(scope, botInstanceId)` once, for the text and the keyboard alike
(`replyKeyboardFor`). An icon is set only when the button has an `iconSlot`, the bot's last
appearance test is `SENT`, and the tenant has a switched-on custom emoji for that slot.

**Fallback (owner rule B5).** An iconed keyboard makes the last part decorated, so the
existing one-shot retry (`deliverDecorated`) covers it; its plain request strips entities,
`<tg-emoji>` tags AND icons, keeps every label and style. Outcome table:

| first answer to an iconed request                          | second send?                                              | bot's shared custom-emoji state              | operator                                                            |
| ---------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| 2xx `ok`                                                   | no                                                        | unchanged                                    | —                                                                   |
| 4xx naming custom emoji (`isCustomEmojiDenial`) + retry ok | one, without icons                                        | `REJECTED / appearance.custom_emoji_refused` | `telegram.appearance_decoration_failed`, `eligibilityChanged: true` |
| any other 4xx + retry ok                                   | one, without icons                                        | unchanged                                    | same condition, `eligibilityChanged: false`                         |
| any 4xx + retry refused                                    | one (already made); its answer is the message's (REFUSED) | unchanged                                    | the customer-send condition, as before                              |
| timeout / dropped connection / unreadable 2xx / 5xx        | NO (UNKNOWN)                                              | unchanged                                    | the customer-send condition, `UNCERTAIN`                            |
| 429                                                        | NO (RATE_LIMITED)                                         | unchanged                                    | —                                                                   |

A refused decoration on an earlier part of a split message strips the last part's icons, so
one send makes at most one retry. Text-only decoration keeps its pre-T2 reading (a landed
retry switches the bot off). The decoration condition's context carries the bot id, template
key, Telegram error CODE and (for an iconed request) `keyboardIcons` / `eligibilityChanged`
only — never a token, a description or an emoji id.

**Not changed:** routing (`bot-runtime.ts`), contracts, migrations, the container, the web.
`main-menu.ts`'s comment on `rowsFor` ("until the transport carries styles", T1's file) is
now historical; `rowsFor` still serves the builder's read and the bot-menu page.

**Real-Telegram acceptance (not CI; the fakes prove only agreement with themselves):**

- R-ACC-1 publish a layout using `primary`, `success`, `danger` and `default`; `/start` on a
  real bot: the request is accepted and each style renders; `default` renders unstyled.
- R-ACC-2 configure the icon slot; send from a bot whose appearance test is `SENT`: the icon
  renders and the label text is unchanged. From a bot known to be ineligible (forced to carry
  the icon), record the HTTP status and the exact `description` (`OQ-T-API-05`); confirm one
  icon-less retry lands, styles intact, and whether the bot was switched off.
- R-ACC-3 tap every styled and iconed button: Telegram sends exactly the label `text`, and
  the command reached is the button's.
- Confirm on the real client that an icon from an eligible bot is not ALSO drawn as the
  label's leading emoji twice (operator-facing warning in the builder, audit §5).

## 16. Owner order 2026-10-02 — the button icon retired, the drag refined

The owner removed «آیکون دکمه» (`iconSlot`) and «آیکون معنایی» (`appearanceSlot`) from
«دکمه‌های ربات», and asked for a quality pass on the drag (it already worked on a real phone).
Appearance (`/appearance`, «ظاهر ربات») is NOT touched: it stays the one mechanism for message
icons and custom emoji.

### 16.1 Compatibility decision — and why

| Question                                                                                                 | Decision                                                                                                                                                                                                                                                                                          | Why                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does the runtime still draw an icon a published layout stored?                                           | **No.** Rows and styles are drawn exactly as published; the icon is ignored on every bot.                                                                                                                                                                                                         | Keeping it would leave customers with an icon the operator can no longer see or remove from the page that made it — the surprising option. Ignoring it makes the operator's preview, the live keyboard and the Telegram keyboard agree again. |
| Do stored snapshots break?                                                                               | **No.** `iconSlot` stays in `explicitMainMenuSchema`, required and nullable; every stored layout still parses.                                                                                                                                                                                    | The previous release's `.strict()` parser requires the key in every snapshot this release writes; dropping it would make each new layout "unreadable" after a rollback (§10).                                                                 |
| What happens to a stored icon?                                                                           | `normalizeExplicitMainMenu` canonicalises it to `null` — and every builder read, write and the runtime source go through it. `customerRowsOf` no longer has an icon field, so neither the runtime nor the preview can draw one. A draft or revision written from now on carries `iconSlot: null`. | One place decides; an icon alone is never a "pending change" (`explicitMainMenusEqual`).                                                                                                                                                      |
| Are rows rewritten or columns dropped?                                                                   | **No** (expand/contract). The JSONB snapshots keep what they hold; no migration.                                                                                                                                                                                                                  | A rollback to `v0.4.x` without a new publish draws the stored icons again — the previous release's behaviour, untouched. After a publish from this release, the snapshot carries `null` and the old release draws no icon either.             |
| Does the API still accept an icon?                                                                       | **Yes** — accepted, canonicalised to `null`, never stored. `iconEligibility` stays in the read.                                                                                                                                                                                                   | A page loaded from the previous release mid-rollout still sends `iconSlot` and parses `iconEligibility`; refusing either would break that page. The new page uses `iconEligibility` only to name the bot in the preview phone.                |
| `appearanceSlot` («آیکون معنایی»)?                                                                       | Control removed; value **round-tripped unchanged** and still projected into `bot.main_menu`.                                                                                                                                                                                                      | It never had a runtime consumer (§7): removing the control changes nothing a customer sees, and keeping the value keeps the projection the previous release reads byte-identical.                                                             |
| The transport's icon handling (`replyKeyboardFor`, the one-shot icon-less retry, `isCustomEmojiDenial`)? | **Kept**, still driven by `tests/unit/telegram-reply-keyboard-wire.test.ts`; the main menu no longer feeds it (`MainMenuLayout.keyboardFor` passes `iconSlot: null`).                                                                                                                             | It lives in the messenger, which other work changes concurrently; it is a tested capability, not dead code reachable by mistake.                                                                                                              |

**Contract phase (a later release, not this one):** once no supported rollback target requires
the key, `iconSlot` can become optional in the schema, `iconEligibility` can leave the read,
and the transport's icon path can go — together, as one contract change.

Tests: `tests/unit/bot-menu-builder-contracts.test.ts` › "the retired button icon";
`tests/unit/main-menu-layout.test.ts` (a layout naming an icon draws none);
`tests/integration/bot-menu-builder.test.ts` › "keeps drawing a layout an earlier release
published WITH icons"; `tests/integration/telegram-reply-keyboard.test.ts` (no icon on any bot;
a snapshot stored with icons drawn without them; a bot that refuses custom emoji is no longer
refused, retried or switched off because of the keyboard). The end-to-end cases of the old
icon path were replaced by these: they described behaviour that no longer exists.

### 16.2 Drag quality

What a drop DOES is decided by one pure function, `applyDrop` (`model.ts`), over the same
primitives the Inspector and the keyboard call; it answers `null` for a drop that changes
nothing. The pointer code (`dnd.ts`) only feeds it.

- **No accidental reorder.** A press moves nothing until the pointer travels 6 px
  (`DRAG_THRESHOLD_PX`); a no-op drop draws no placeholder and announces nothing; Escape,
  `pointercancel` and a lost pointer capture abandon the drag.
- **No jumpiness.** The gaps between rows are always laid out; every placeholder (the caret
  before a key, the caret at a row's end, the new-row line and its note) is a CSS
  pseudo-element over the layout, so nothing resizes under a still pointer. Before/after is
  the half of the key under the pointer in READING order (`chipSide`), with a 6 px dead band so
  the caret does not flicker.
- **Smooth tracking.** An SVG ghost of the key follows the pointer, moved once per animation
  frame through its `transform` attribute — the production CSP (`style-src 'self'`) forbids
  every inline style, and `csp.test.tsx` refuses every spelling of one. The target is
  hit-tested on that frame; near the top or bottom edge the page scrolls.
- **Obvious target row.** The row a drop lands in is outlined.
- **Touch.** The grip is a real `<button>` (34 × 44 px hit area, out of the tab order,
  `aria-hidden`) — QA-2's fix direction. `scripts/web-shots/bot-buttons-drag.mjs` drives
  Chromium over CDP (a finger at 390 px, a mouse at 1440 px) and passes; it does not
  reproduce QA-2's retargeting with the OLD grip either, so R-ACC-9 on a real phone remains
  the evidence for that defect.
- **Keyboard fallback** unchanged: Alt+arrows by reading direction (tested in RTL and LTR),
  Delete, Alt+Enter, the Inspector's move buttons.
- **RTL / 390.** Logical CSS properties throughout (`inset-inline-*`); no horizontal overflow at
  390 (`pnpm web:shots /bot-buttons --width 390`).

Tests: `tests/web/bot-buttons-dnd.test.tsx` (pure) and "the button builder — drag quality" in
`tests/web/bot-buttons-builder.test.tsx`.

### 16.3 Round-T follow-ups, audited against `main` at `6d00f094`

| Item                                                        | Status at `6d00f094`                                                                           | Outcome                                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| QA-3 doubled emoji (icon marker beside a label's own emoji) | present                                                                                        | **Obsolete** — the icon is retired; the warning and the marker are removed with it.                                       |
| QA-4 history names the publisher by an id prefix            | present (`history.tsx:93`)                                                                     | **Fixed** — revisions carry `createdByAdminName` (tenant-scoped join on `admins`); the drawer shows the name, or no line. |
| QA-5 "live menu changed" banner squeezed at 390             | present                                                                                        | **Fixed** — a builder banner's action stacks under its text below 560 px.                                                 |
| QA-6 «published» read for a moment after a restore          | present: a pending restore or reset was not a state, so the page kept the state from before it | **Fixed** — a pending reset or restore reads «saving».                                                                    |
| F-8 / OQ-T-2 "new button" badge                             | not reachable: no release has added a main-menu button                                         | **Unchanged** — the obligation in `docs/open-questions.md` OQ-T-2 stands for the release that adds one.                   |
| QA-2 touch on a key's grip                                  | not reproducible through CDP touch emulation (§16.2)                                           | Grip rebuilt as a button; real-phone check stays in R-ACC-9.                                                              |

### 16.4 Superseded on 2026-10-05: the button icon restored (Phase 2 UX wave, Item 3)

The owner's master prompt of 2026-10-05 (Item 3, "premium custom emoji / sticker support for bot
buttons") is newer than the 2026-10-02 order in §16, and the PO confirmed that it **lifts the
retirement** of «آیکون دکمه». The retirement of «آیکون معنایی» (`appearanceSlot`) is NOT
lifted. That field still has no control and no runtime consumer.

| What                        | 2026-10-02 (§16.1)       | Since Phase 2 Item 3                                                                                                                                            |
| --------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iconSlot` in the schema    | kept, required, nullable | unchanged. No shape changed in either direction.                                                                                                                |
| `normalizeExplicitMainMenu` | forced `iconSlot: null`  | carries it as given. An icon alone is a change to publish.                                                                                                      |
| `customerRowsOf` / runtime  | no icon                  | `iconSlot` is drawn. It is resolved per SENDING bot (`replyKeyboardFor`), with the one icon-less retry (owner rule B5) and UNKNOWN never resent, as in §15.     |
| Inspector                   | no icon control          | «آیکون دکمه» (optional, «بدون آیکون» by default), the per-bot eligibility list, the doubled-emoji warning and the dashed marker in every preview are restored.  |
| Inline buttons              | no icon                  | NEW: `bot.inline_button_icons`, a custom emoji id per registry key, drawn as `InlineKeyboardButton.icon_custom_emoji_id`. It is gated and retried the same way. |

The rollback consequences are in `OQ-P2-ICON-05`. The Telegram limitations (one icon, before
the text, no entities in button text) and the acceptance still owed are in `OQ-P2-ICON-01`
and `-03`, and in `docs/phase2/button-icons.md`. The QA-3 row of §16.3 is live again: the
doubled-emoji warning is restored with the icon.
