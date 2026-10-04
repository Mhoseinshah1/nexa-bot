# Web redesign — OPS-A (infrastructure and bot/config pages, part A)

Phase 1 deliverable (Phase 2 record in §14): an exact inventory of what each page does on `main` (`f465d58`), the
mapping onto the reference preview (`refs/reference/preview-v2`), and the kit components
the rebuild needs. No code changes yet; Phase 2 starts after WEB-FOUNDATION merges.

Routes owned: `/panels`, `/panels/new`, `/panels/:id` (tabs: overview, workload, health,
credentials, capabilities, trial), `/providers`, `/bots`, `/bot-buttons`, `/appearance`,
`/payment-gateways` (with the FX section), `/payment-accounts`, `/client-apps`.

Files: `apps/web/src/pages/{panels,panel-activation,panel-advanced,panel-trial,bots,
bot-buttons,appearance,payment-gateways,fx-section,payment-accounts,client-apps}.tsx`,
`apps/web/src/appearance-labels.ts`, and `tests/web/{panels,bots,bot-buttons,appearance,
payment-gateways,payment-accounts,client-apps}.test.tsx` (109 + 16 + 15 + 6 + 20 + 5 + 22
cases). Other suites that render these pages: `csp.test.tsx` (every NAV route plus
`/panels/:id` and `/panels/new`), `permissions-and-refresh.test.tsx` (panel detail poll),
`router.test.tsx`, `planned-and-absent.test.tsx` (`isCurrent('/panels', …)`).

## 0. Rules that bind every page here

These are the constraints the rebuild must not lose. Each is enforced today by code, and
most by a named test.

1. **Credentials travel one way.** Panel credentials are rendered as presence
   (`configured`) plus `lastReplacedAt` only; the response carries no value. No masked
   stand-in anywhere (`********` could be resubmitted). Every replace input starts empty,
   an empty input means "leave what is stored", clearing is a separate per-row Remove.
   Same rule for the bot token (password input, never prefilled, cleared `onSettled`
   whatever the answer) and the TonPays API key (password input, empty on every open,
   cleared on success). Tests: panels "never renders a credential value…", "starts every
   replace field empty…", bots "offers the token form only with settings.destructive,
   sends it once and clears it", gateways "shows a missing key… and no field holding any
   key".
2. **Health is a projection.** State, failure, latency, check time, staleness are the
   monitor's latest write; `stale` is the server's own verdict shown as its own badge;
   no trend chart (test: "states that health is latest-state-only rather than drawing a
   trend it does not have" asserts no `svg.chart`).
3. **Enable requires a validated connection.** The UI does not pre-check it; the server
   refuses and the toast maps the error. The Enable button is drawn for `DISABLED`
   panels to `panels.edit`; the sellability card shows `connectionValidated`.
4. **Buttons are drawn from permissions, and that is a courtesy.** Every write control is
   gated on the same key the server charges (table per page below). A control that can
   only be refused is not drawn, because a refusal writes a DENIED audit row and an
   `access.permission_denied` event.
5. **CSP: no `style` attribute on any rendered route** (`csp.test.tsx` walks every NAV
   route and both panel sub-routes). The reference uses inline styles heavily
   (`style={{…}}` for widths, progress bars, colours); none of that can be copied.
   Magnitudes go into SVG geometry attributes or classes.
6. **Idempotency.** Every write carries a key from `useSubmissionKey`; the key survives
   an ambiguous failure so a retry is the same command. The panel detail holds the test
   and credential keys at page level so a tab click cannot drop them.
7. **Money** through `formatMoneyText`/`Money`; numbers through `Num`/`formatNumber`;
   times through `formatTimestamp`; technical values through `Ltr`/`Copyable`.

---

## 1. `/panels` — panel list (`PanelsPage`)

**Permissions.** Nav entry shown for `panels.view` OR `panels.edit`. Route passes
`denied = !panels.view`, `mayEdit = panels.edit`.

**Query.** `['panels', 'live'|'archived', cursor|null]` → `fetchPanels` (`PANEL_ROUTES.list[?cursor][&archived=only]`);
`enabled: !denied`; `refetchInterval: pollUnlessFinal(90_000)` (same cadence as detail).

**URL state.** `?archived=only` via `setQuery` (replace, not push). The cursor trail is
stored together with its mode, so a trail minted for one list can never apply to the
other (sidebar navigation to `/panels` drops the query without the filter's onChange).

**Columns** (every one from the response; owner rev. 19 removed location, users, load,
sales — none exist in `panelSummarySchema`):

| column     | render                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| name       | link to `/panels/:id` (`onLink`)                                                                                           |
| provider   | `providerName`                                                                                                             |
| health     | `HealthBadge`: state badge (`HEALTH_TONES` from dashboard) + separate `stale` warn badge with hint title                   |
| failure    | `FailureBadge`: LTR code; warn if `PROVIDER_FAILURE_RETRYABLE`, danger otherwise; title retryable/permanent; `—` when null |
| last check | `formatTimestamp(checkedAt)` or `—`                                                                                        |
| latency    | `Num` + `ms`, end-aligned, `—` when null                                                                                   |
| capacity   | `used / max` (`∞` with title when uncapped) + `(reservations)` only when > 0                                               |
| status     | ACTIVE ok / DISABLED neutral / ARCHIVED neutral badge                                                                      |

**Toolbar.** `Pills` live/archived; hidden unless `mayRequest(panels, denied)` (tests
query `.toolbar` at lines 158 and 222 — switch to a role/label query).
**Empty.** Live: `panels_empty` + hint; archived: `panels_archived_empty`. Error and
permission refusal distinct from empty (StateSwitch).
**Pager.** `CursorPager` only when `!denied && ready`; next = `web.newer`, previous =
`web.older` (the keyset ascends).
**Head action.** "پنل جدید" link to `/panels/new` when `mayEdit`.

**Reference mapping (`dark-panels`, `mobile-panels`).**

- Take: PageHead with subtitle and primary "افزودن پنل" action; dense table in a card
  with the toolbar row above it and filter chips row; two-line name cell (`cell-main`:
  name + LTR `baseUrl` host) — `baseUrl` is in `panelSummarySchema` and already shown on
  the detail to the same permission; provider as an outlined `ProviderBadge` with
  `providerVersion` (in `health`); health as dot-badge; last check two-line; latency num.
- Nexa-only, stays: live/archived pills (as the filter row, `Pills`/`Chip`), capacity
  column, status column, stale badge, cursor pager with newer/older.
- Add (real data): a **"قابل فروش"** column from `sellability.sellable` as a read-only
  badge with the reason as title — this is the reference's "فروش" column, but real and
  NOT a switch.
- Reference-only, NOT added: client-side search box, provider/lifecycle selects, health
  filter chips with counts (the server has no filter; filtering one keyset page in the
  browser hides rows the cursor has already walked past — the dashboard records the same
  rule), "بار / کاربران", "لوکیشن", "مانیتور/Schedule" column (no monitor schedule in the
  contract), the unreachable/auth-failed/capacity banners with fleet counts, the 6-card
  health KPI strip (fleet-wide counts do not exist; a per-page count presented as the
  fleet is the RSV2-BR-021 defect the dashboard documents), "وضعیت مانیتور" link, add-panel
  wizard modal, state switcher, maturity legend.
- Optional, truthful only: the KPI strip may be drawn **only when the whole fleet is on
  screen** (`nextCursor === null` and no cursor trail), exactly the dashboard's rule;
  otherwise it is omitted. Proposed as optional — the lead decides; default is omit.

## 2. `/panels/new` — create form (`NewPanelPage`)

**Permissions.** `denied = !panels.edit` (renders the lock Empty), `mayView = panels.view`
(where success may go), `mayRotate = panels.credentials.rotate` (initial credentials are
a CRITICAL credential write).

**Query.** `['providers']` → `fetchProviders` (`PANEL_ROUTES.providers`); StateSwitch so a 503 is an error with retry,
not an empty picker; empty catalogue → `providers_none`.

**Fields.** name (required); provider `<select>` from the catalogue (`canonicalName`);
base URL (LTR mono, required, hint); after a provider is chosen: info banner with the
credential shape (Persian) and warn banner with required activation fields (Persian
labels, LTR fallback); credential inputs **only if `mayRotate` and the chosen shape
accepts them**: username (LTR, autocomplete off), password (password, new-password),
API token (password). Non-empty accepted fields only are sent; a field left in state after
switching provider is never sent.

**Submit.** idempotency key; toast `saved`; invalidate `['panels']`; if `mayView`
navigate to the new detail, else stay, show `panel_created` banner with the name, clear
fields. Error → toast `messageFor`.

**Reference mapping.** The reference is a 6-step modal wizard. Take its visual pieces:
provider as radio cards (provider badge, credential-shape outline badge, required
activation-field warn badges), a connection section, a credentials section with the
one-way hint. Keep it a **route page** (the route, its permission and `csp.test` depend on
it) with one submit. Reference-only, NOT added: the "test connection" step (a probe needs
a panel row; the server has no pre-create probe), location, sellable/proxy toggles, bot
button colour, user group, idempotency-key display, step progress bar (inline widths).

## 3. `/panels/:id` — panel detail (`PanelDetailPage`)

**Keyed by panel id** in `resolve` (load-bearing: prevents a draft for panel A being
saved onto panel B). **Permissions.** `denied = !panels.view`, `mayEdit = panels.edit`,
`mayRotate = panels.credentials.rotate`, `mayViewTechnical = panels.technical.view`.

**Query.** `['panel', id]` → `fetchPanel` (`PANEL_ROUTES.detail`); poll 90 s. `view = denied ? 'denied' :
queryState(panel)`; the head reads `shownData(...)` so a final refusal takes the name and
Test button down with the body.

**Head.** title = name (fallback `panel_detail`), subtitle = `providerName`. Action
**Test connection** only when `mayEdit && status !== 'ARCHIVED' && probeable(panel)`
(`shapeIsSatisfiedBy(descriptor.credentialShape, configured flags)`); key held at page
level; toast `ok panel_tested` when `probed`, `info panel_test_replayed` when not;
invalidates `['panel', id]` and `['panels']`.

**Tabs** (`Tabs` + `TabPanel`, ARIA ids `panel-detail-panel-tab-*`): overview (HIDDEN, not
unmounted — keeps the draft, basis and written revision across tab clicks), workload,
health, credentials, capabilities, trial.

### 3.1 Overview tab

- **Identity KV:** id (`Copyable`), provider name + LTR type, status badge, created,
  updated.
- **Sellability card:** sellable yes/no, activation complete, connection validated
  (three badges, said separately); reason banner with Persian label + remedy from the
  exhaustive `SELLABILITY_REASON_LABELS/HELP`; missing activation fields banner (LTR).
- **Capacity card:** services, reservations, used, max (or unlimited), available.
- **Configuration form** (`mayWrite = mayEdit && status !== 'ARCHIVED'` disables every
  input and hides Save): name; base URL (LTR); max services as TEXT (`''` = no cap,
  invalid → danger toast `panel_max_services_hint`, not sent); **activation** fields —
  Marzban: protocol checkboxes + one tag box per ticked protocol; 3X-UI: subscription
  domain + inbound id; parsed with `PANEL_ACTIVATION_SCHEMAS`, invalid → banner + toast
  naming the schema paths; **username policy**: allow custom checkbox, allow automatic
  checkbox, strategy select (Persian names), prefix (PREFIX_RANDOM), template
  (CUSTOM_TEMPLATE) + token list + best/worst length bounds + issues, preview from
  synthetic values, NO_MODE / shared-reason banners; validated with the shared
  `validateUsernamePolicy`.
- **Save** sends changed fields only (vs `basis`); policy whole-or-nothing; "no changes"
  warn toast; success adopts the stored row and records `written = updatedAt`.
- **Concurrent-change notice:** `changedElsewhere` (suppressed while the query is
  `behind` this session's own write) with three wordings — read-only / will overwrite /
  untouched — computed per field with server-equivalent comparison (trimmed name,
  normalised URL, cap, policy field-by-field); "load the fresh value" link re-adopts
  every field.
- **Lifecycle card** (`mayEdit` only): Disable (ACTIVE), Enable (DISABLED), Archive
  (non-archived) → inline second press: danger banner + services count + confirm/cancel,
  cleared on both exits; Restore (ARCHIVED) sends DISABLED, and after a 409
  `panel.name_taken` shows a rename field seeded with the old name (button disabled only
  while it is empty; a second refusal is allowed and explained); status success folds in
  only the name when one was sent; archive hint text.

### 3.2 Health tab

Info banner "latest state only"; warn banner when not probeable; `DiagnosticsCard`
(advanced query `['panel', id, 'advanced']`, poll 90 s: overall badge, checks table with
Persian verdicts, failure with remedy, last check, last success, missing fields, required
capabilities available/missing); health KV (health + stale, failure, last check, latency,
upstream HTTP status LTR, provider version LTR, last healthy, freshness window from
`PANEL_HEALTH_FRESH_FOR_MS`). No chart.

### 3.3 Credentials tab

One-way warn banner; "unsupported field" hint only when a field is missing; "stored but
unusable" hint; `Secret` rows for `shows(field)` (accepted OR configured) with meta
(`lastReplacedAt`, "unusable") and a labelled Remove (`mayWrite = mayRotate && !ARCHIVED`)
sending `{field: null}`; replace form (`mayWrite`) with only accepted fields, all empty,
cleared on success; nothing-to-do warn toast; key owned by the page.

### 3.4 Workload tab

Products (`fetchProducts({ panelId, limit: 10 })`) and services (`fetchServices({ panelId, limit: 10 })`)
first pages, links to `/products/:id` and `/services/:id`, status badges from the owning
pages' maps, "there is more" only when `nextCursor` is non-null, empty vs failed distinct,
no subscription URL/ref/client id.

### 3.5 Capabilities tab (`panel-advanced.tsx`)

`['panel', id, 'advanced']`. Registry table (capability + hint title, supported/gap,
customer availability/blocker, operator-only note). Policy card: per supported customer
action a "customer enabled" checkbox (aria-labelled per action) and its knob (cooldown
minutes / max GB / max days / max devices); LOCATION_CHANGE shown disabled with the gap
reason when unsupported; delivery-mode radios; schema-validated locally (invalid paths
banner); KV revision + updated; save with `expectedRevision`, `changed` → ok / else info
`unchanged`, `panel.policy_stale` → warn toast + refetch; read-only note without edit;
editable only when `mayEdit && !ARCHIVED`; stored restrictions for no-longer-supported
actions are kept. Provider rules card (five Persian rules, current activation KV,
location note). Technical card only with `panels.technical.view`: show/hide toggle, lazy
query, JSON `<pre dir="ltr">`; refetched after a policy save.

### 3.6 Trial tab (`panel-trial.tsx`)

`['panel-trial', id]`; form keyed by revision; unconfigured banner (starts from 100 MB /
72 h); `Switch` enabled; traffic amount + unit (GB/MB) input group; hours (min/max) with
unit; label (maxLength); client-side `updatePanelTrialRequestSchema` check → invalid
banner, no request; save with `expectedRevision`; `commerce.trial_config_stale` → warn +
refetch; invalidates `['trial-panels']`; read-only without edit or on ARCHIVED.
(Tests live in `bot-buttons.test.tsx` "the panel's «سرویس تست» tab".)

**Reference mapping for the detail (`dark-panel-detail-overview/health/sanaei`,
`light-…`, `mobile-…`).**

- Take: PageHead with the **status badge and health badge beside the title**, subtitle
  `ProviderBadge + version · LTR baseUrl · LTR id`; Test connection as the primary head
  action; a **stat strip** above the tabs; tabs underline style; `two-col` layouts inside
  tabs; KV cards; latest-state card with an outlined "latest-state-only" chip; Secret
  table for credentials.
- Stat strip, real fields only: Health (label + "checked …" / never), Latency (ms),
  Last healthy, Sellable (yes/no + reason label), Capacity (used / max, reservations),
  Services on panel (`capacity.services`). Reference-only, NOT added: "next check",
  backoff step, deferral, "executable capability N of 16", users on panel, monitor
  scheduling card, remedies table, events/audit tab, protocols/features tab, the
  "metadata & sales policy" card (location, colour, proxy, groups), the permissions KV,
  latency trend.
- Head banners, real data only: stale health (`health.stale`), and the failure with its
  Persian remedy (`FAILURE_LABELS` from `panel-advanced`), plus the existing sellability
  reason banner. No invented "monitor deferred" banner.
- Lifecycle placement: **keep** Disable/Enable/Archive/Restore in the Overview tab's
  lifecycle card, visually isolated as the destructive section (§7 "destructive actions
  isolated"), rather than moving them into the head as the reference does. The status
  mutation shares draft state with the configuration form (restore-with-rename folds the
  name into `basis`), and the two-press archive with the services count and the rename
  field are covered by ~15 tests; moving them into the head means lifting that state out
  of `OverviewTab`. If the lead wants head placement, the archive confirmation becomes
  `ConfirmDialog` with the services count as `detail` and the same two-step semantics
  (NOT a typed phrase — the code comment records why).
- The reference's "edit" modal is not taken: the configuration form stays inline.

## 4. `/providers` — provider catalogue (`ProvidersPage`)

No permission (`PANEL_ROUTES.providers` needs a session only; nav `permission: null`). Query
`['providers']`. Info banner "a provider type is code, not a row". Table: provider
`canonicalName`, credential shape (Persian), supported capabilities as ok badges (Persian
registry labels), required activation fields (Persian, `—` when none). Empty/error via
StateSwitch.

Mapping: list page composition — PageHead, banner, dense table card; provider cell as
`ProviderBadge`. Reference `CapabilityMatrix` (✓/— grid of every capability) is optional
visual; the current badge list carries the same information (supported only). No
maturity legend, no Mirza names.

## 5. `/bots` — bot instances (`BotsPage`)

**Permissions.** Nav `settings.view`. Route: `denied = !settings.view`, `mayOperate =
settings.edit` (stop, start, live check), `mayReplaceToken = settings.destructive`
(passed separately; a destructive-only role gets the token form without edit).

**Query.** `['bots']` → `fetchBots` (`BOT_ROUTES.list`), `enabled: !denied`, no polling. Empty → `bots_empty`

- hint. A static card records the add-flow decision (no add, no move, no webhook
  register — there is no "add bot" button, and a test asserts none).

**Per bot (currently one card each):**

- Header: `@username`; status badge (ACTIVE ok / STOPPED warn / DISABLED danger);
  readiness badge (REGISTERED / NOT_REGISTERED / HELD).
- KV: tenant display name + LTR slug + "fixed" note; Telegram bot id (LTR) or unknown;
  webhook registered-at + LTR URL, or "never"; webhook secret state (MATCHES / DIFFERS /
  UNKNOWN / NOT_CONFIGURED — a state, never the secret); command menu state
  (CURRENT/STALE/UNKNOWN); bot id `Copyable`.
- Readiness causes list (`data-testid="bot-causes-<id>"`), one remedy sentence each.
- Actions (`mayOperate`): Stop (ACTIVE) → inline confirm banner (title, body, confirm
  danger, cancel); Start (STOPPED, no confirm); Live check (ACTIVE only).
- Token replacement (`mayReplaceToken`): password input (autocomplete off, spellcheck
  off, maxLength 256, never prefilled) + submit disabled while empty/busy; cleared
  `onSettled`; success toast done/same + a second toast for the command-menu sync
  (SYNCED ok / FAILED warn); shows the returned verification at once.
- Diagnostic view (`data-testid="bot-diagnostic"`, `role=status`): checked-at; verdict
  badge ready/not ready (`bot-verdict`); problems with remedies; identity outcome, id and
  username mismatch; webhook outcome; when READ: expected URL, actual URL with
  exact/not-exact or recorded match badges, pending update count, last error time +
  message (LTR). Cleared when a status change or token replacement makes it stale.
- Failure banner: `botMessageFor` (16 mapped codes) + `ReplacementFailureView`
  (compensation, expected URL, actual URL at VERIFY_WEBHOOK, Telegram reason) —
  `data-testid="bot-replacement-failure"`.

**Reference mapping (`dark-bots`, `dark-bot-detail`).** Reference = a list table plus a
`/bots/:id` detail page (PageHead with status badge, sub `@username · tenant`, head
actions, 4 stat cards, tabs overview / webhook & token / errors / settings, two-col KV

- events).

* **Decision needed (lead):** (A) keep the single `/bots` route and render each bot as a
  detail-composed section (head row with badges and actions, KV card + webhook card in
  two columns, token card, diagnostics), preceded by a compact summary table when there
  is more than one bot; or (B) add `/bots/:id` in `app.tsx` (not in nav, crumbs
  `bots › @username`), make `/bots` a dense table (username LTR, status, readiness,
  webhook registered-at, secret state, menu state, causes count) linking to it, and move
  the operate/token/diagnostic features to the detail page, fed by the same `['bots']`
  query (no new endpoint). **Recommendation: (A).** An installation has one bot in the
  common case, B adds a click to every operation, adds a hot-file route, and moves all
  16 tests to a new page for no capability gain. B is the closer visual match.
* Reference-only, NOT added under either option: owner/kind (reseller bots), updates/
  errors/users 24h, pending-updates column, sparkline, events timeline, "open in
  Telegram", "reset webhook", delete, disable, settings tab toggles (new-user
  acceptance, forced join, maintenance), add-bot modal, "check all webhooks".
* Real data that CAN fill a stat strip: status, readiness, webhook registered-at,
  command-menu state. Pending update count exists only inside a live check result.
* Stop confirmation may move from the inline banner to the kit `ConfirmDialog`
  (labelled confirm/cancel, focus returns). Tests click the last "توقف" button; they
  would switch to the dialog's role query while asserting the same thing (no stop on the
  first press).

## 6. `/bot-buttons` — main menu, command menu, labels (`BotButtonsPage`)

**Permissions.** Nav `settings.view`. Route: `denied = !settings.view`, `mayEdit =
settings.edit`, `mayViewTemplates = templates.view`, `mayEditTemplates = templates.edit`.

**Queries.** `['bot-menu']` → `fetchBotMenu` (`BOT_MENU_ROUTES.config`, `enabled: !denied`); `['templates']`
(`enabled: !denied && templates.view`).

**Layout card** (keyed by `layout.version`): stored-invalid banner; table (`tr[data-button]`)
with position, button label (+ default label when overridden, gate note + closed-gate
badge), target `/command` badge (LTR), appearance-slot select (menu slots, default marked;
label per row), shown `Switch`, move up/down (aria-labelled per button, disabled at ends);
slot hint; "one required" danger banner when invalid (`mainMenuLayoutSchema`); unsaved
hint when dirty; Save (disabled unless editable, valid, dirty) sends the whole
arrangement with `expectedVersion` to `saveSetting('bot.main_menu')`, invalidates
`bot-menu` and `settings`; Restore defaults; `ErrorReport` on failure; saved/unchanged
banner.
**Preview card** (`.menu-preview`, `aria-label`): `packMainMenuRows` of enabled buttons
whose gate is open (a gated button is drawn only once the server says its gate is open).
**Commands card** (`data-testid="bot-commands"`, `tr[data-command]`): `/command` +
description for the customer scope; hash (LTR).
**Sync card** (`data-testid="bot-menu-sync"`): bot selector when > 1 (defaults to the
first ACTIVE); state badge (CURRENT/PENDING/FAILING/STALE/UNKNOWN/STOPPED); KV username,
desired version + hash, last success, last attempt, last error (Persian hint + LTR code
via `syncErrorHint`), attempts, next attempt; state hints; actions (`mayEdit` and bot
ACTIVE): «همگام‌سازی دوباره» (idempotent) and «بررسی وضعیت»; results as banners; check
view (`data-testid="bot-menu-check"`) with match/mismatch and the registered list.
**Labels card:** without `templates.view` an info banner; otherwise one `<details>` per
menu button with `TemplateCard` (duplicate-label warning), then the command texts
`<details>`; saving a label re-reads the menu.

**Reference mapping (`dark-keyboard`, `dark-bot-designer`, `light-bot-designer`,
`mobile-bot-designer`).** Take the keyboard page composition: PageHead with Save as the
primary head action (the layout card's Save), a main column with the order editor and a
side column with a **phone-style Telegram preview** (reply keyboard rows) and a rules/
hints card; command menu and sync as cards below; labels card last. Reference-only, NOT
added: menu hierarchy tree, inline/reply mode switch, message body editor, custom
buttons (URL/callback, styles), per-button custom-emoji picker (Nexa sets emoji per
semantic slot on `/appearance` and the slot per button here), emoji library, "send test
to myself", Bot API JSON output, drag handles (up/down buttons stay — they are the
keyboard-accessible reorder the tests drive), add-row. Test hooks to keep:
`tr[data-button]`, `.menu-preview` (or switch to its `aria-label`), `tr[data-command]`,
the testids above, and `closest('section')` on cards.

## 7. `/appearance` — custom emoji per semantic slot (`AppearancePage`)

**Permissions.** Nav `settings.view`; route `denied = !settings.view`, `mayEdit =
settings.edit` (save, reset and test).

**Query.** `['appearance']` → `fetchAppearance` (`APPEARANCE_ROUTES.view`).

**Slots table** (one `tr[data-slot]` per `APPEARANCE_SLOTS`, keyed by version): slot
Persian name (`APPEARANCE_SLOT_LABEL`, shared with bot-buttons) + LTR marker; fallback
emoji; custom emoji id input (LTR, numeric, `CUSTOM_EMOJI_ID_PATTERN`, inline error);
enabled `Switch`; preview (fallback glyph + custom/fallback badge + LTR id); Save
(disabled unless valid and dirty) with `expectedVersion`, toast saved/unchanged; Reset
only for a stored row; per-row error banner (`appearanceMessageFor`). Viewer: nothing to
press.
**Test card:** each bot with its last test outcome badge, time, Persian error; with
`mayEdit`: not-bound warn, nothing-configured info, no-active-bot warn; bot select when

> 1 active; Send disabled while pending / no bot / unbound / nothing configured; toast
> tone per outcome with the decorated slot count; error banner.

**Reference mapping.** No dedicated reference screen; nearest is the designer's custom
emoji library table. Composition: settings-type page — PageHead, the slots as a dense
table card, the test card beside it (two-col on wide screens, stacked below 1100 px).
Nothing reference-only to exclude beyond the emoji-pack import.

## 8. `/payment-gateways` — payment routes and FX (`PaymentGatewaysPage`, `FxSection`)

**Permissions.** Nav `payments.gateways.view` only; route `denied = !payments.gateways.view`,
`mayEdit = payments.gateways.edit` (edit, status, API key, FX refresh).

**Query.** `['payment-gateways']`; no create (the roster is what the release can operate).

**Table columns:** name (display name or Persian provider name + "default name" badge),
state, min, max (`formatMoneyText`, `0` = unbounded), eligibility (three conditions or
`—`), top-up gift %, customer fee % (basis points), Stars rate (`rateRequired` →
missing warn badge / `x = ⭐ 1`), purposes (service purchase / wallet top-up, amber
"none" badge), credential (not needed / missing warn / configured ok + set-at — never a
value), updated, actions (`mayEdit`: Edit, Replace key when required, Enable/Disable).
**Callback URL card:** for key-taking routes, the server-built callback URL (LTR) or
"none".
**API key card** (open per route): password input (new-password, spellcheck off, maxLength
512), empty on open, cleared on success; save disabled while empty; cancel; error banner.
**Toggle error banner** (e.g. TonPays without a key) when no form is open.
**Edit card** (open per route): display name (60), instructions textarea (1000), min/max
(minor units text, `minorOf` accepts grouping and Persian/Arabic digits), activate-after
payments, deactivate-after payments, activate-after account days, top-up gift %
(`percentOf`, inline error), customer fee % (only GATEWAY-settled routes,
`parsePercentBasisPoints`, inline error), Stars rate (only fixed-rate routes,
`conversionRateOf`, inline error), purpose switches, sort order; Save disabled on any
inline error; server refusals (crossing bounds) shown as a banner, deliberately not
pre-checked.

**FX section** (own query `['fx-status']`, own StateSwitch, so a rate outage never blanks
the routes; no polling): head action Refresh (`mayEdit`) → `refreshFx()`, sets the cache
from the answer, toast by outcome (REFRESHED ok, FAILED danger, fallback/disabled/busy
warn), error banner. KV: enabled, primary source, fallback source, state badge
(FRESH ok / STALE_ALLOWED warn / UNAVAILABLE danger via `stateTone`), current rate (LTR +
currency label) or "no quote", current source, last refresh, source time, age, fresh TTL,
max stale, last attempt, last error (LTR), quote id (LTR), policy version. Stars KV:
pricing mode, stars per USDT (or unset), fixed rate, central rate per star. Sources table:
last success, last failure + LTR code, retry after, consecutive failures. Pointer to the
settings page. **No tests exist for `FxSection` today** — Phase 2 adds them (state tone,
refresh outcomes, no refresh without edit, rates LTR, an outage leaves the routes table).

**Reference mapping.** No reference gateway page; compose as a list page: PageHead,
dense table card (actions as a compact row-action group), and the edit / API-key forms as
**kit `Modal` dialogs** if FOUND ships an accessible one, otherwise as the current inline
cards restyled. If a portal modal is used, `payment-gateways.test.tsx:285`
(`container.querySelectorAll('input[type="password"]')` has length 0) must query
`document` instead, or it would pass for nothing. FX as a status card in the style of the
reference `dark-system-health` KV cards: a small stat strip (state, current rate, age,
last refresh — all real fields) over a two-column KV (quote / Stars) and the sources
table.

## 9. `/payment-accounts` — card-to-card destinations (`PaymentAccountsPage`)

> **UX Batch 01 (items 7 and 8).** This screen is now `CardAccountsSection`, drawn on the
> card-to-card method's own view at `/payment-gateways/card-to-card`; `/payment-accounts`
> redirects there (history replace) and has no nav entry. Each payment method has its own
> view at `/payment-gateways/<slug>` (`apps/web/src/payment-method-routes.ts`), with its
> settings, actions, forms, callback URL and health; the list links to them and edits
> nothing in place. API, permissions and write semantics are unchanged: the form now opens
> from «افزودن کارت» or a row's «ویرایش» instead of standing open. What follows is the
> original OPS-A record.

**Permissions.** Nav `payments.accounts.view` only; route `denied =
!payments.accounts.view`, `mayEdit = payments.accounts.edit`. The form is outside the
StateSwitch on purpose: an edit-only role (list denied) still gets the form.

**Query.** `['payment-accounts']`. Limit `PAYMENT_ACCOUNT_MAX_PER_TENANT` (warn banner,
create disabled at the limit).
**Columns:** label + default badge, bank, holder, card number **masked** (`•••• ×3 +
last 4`, LTR), state, updated, actions (`mayEdit`: Edit; Make default when enabled and
not default; Enable/Disable when not default — the default cannot be disabled).
**Form** (one form, create or edit): label (80), bank (80), holder (120), card number (40,
numeric, sent as typed — normalised server-side), IBAN (40, optional), sort order; "make
default" checkbox on create only; Save disabled while busy, at limit (create) or any
required field empty; Cancel when editing; editing id `Copyable`; error banner.

**Reference mapping.** List page with the form in a side card (two-col on wide screens) or
a `Modal` — same caveat as gateways for portal queries. Masked card number stays in the
table.

## 10. `/client-apps` — client apps and connection guides (`ClientAppsPage`)

**Permissions.** Nav `client_apps.view`; route `denied = !client_apps.view`, `mayEdit =
client_apps.edit`.

**Query.** `['client-apps']`. All writes share mutation key `client-app-write`, so no
write can start while another is in flight (tests R3).
**Columns:** platform (Persian), name (icon + name), order, compatibility (delivery
kinds, protocols, provider names, or "any"), status, updated, actions (`mayEdit`: Edit,
Enable/Disable with `expectedVersion`, Delete with `window.confirm` and
`expectedVersion`). New button in the card head (and in the empty state).
**Editor card** (create/edit): platform select; name, icon, description (one-line,
`clientAppTextProblem`), official URL (required), alternative and help URL (optional;
`normalizeClientAppUrl`, LTR), guide textarea (markup/unsafe-link refusal), delivery
kinds, protocols (LTR), provider types checkboxes, sort order; errors shown after the
first submit (`touched`); **preview** rendered as TEXT from the same template the bot
sends (`data-testid="client-app-preview"`, never markup, bare unsafe links neutralised),
stored image first, download/alternative/help button captions; changed-elsewhere banner
(version moved or `version_conflict`) with reload; Save disabled while busy or invalid
after touch; Cancel; fault banner (conflict, limit, else shared).
**Image card:** "save first" before an entry exists; stored image served from the API on
this origin (`client-app-image-stored`) with type, size, dimensions; file input (PNG/JPEG,
inspected client-side before any request, selection ticket against out-of-order reads),
picked preview (`client-app-image-picked`), upload / clear with `expectedVersion`; server
reason mapped.
**Page banners:** toggle and delete errors.

**Reference mapping.** List page + editor. Take: dense table card with head action, the
editor as a two-column card (form left in RTL order, a phone-style **Telegram preview**
right, using the same preview component as bot-buttons), image card beside the preview.
Delete may move from `window.confirm` to the kit `ConfirmDialog`; the test that spies on
`window.confirm` would then assert the dialog (declined → no request; confirmed → one
request with the version) — the same claim.

---

## 11. Kit components needed

Present on `main` and reused: `PageHead`, `Card`, `Badge`, `Banner`, `KV`, `Tabs`/`TabPanel`,
`Pills`, `Field`, `Switch`, `Secret`, `Copyable`, `Ltr`, `Num`, `Money`, `Empty`,
`Skeleton`, `StateSwitch`, `DataTable`/`Column`, `CursorPager`, `useToast`,
`ConfirmDialog`, `Icon`.

Needed from WEB-FOUNDATION (in the brief's list; flagged if the current kit lacks it):

| need                                                                                                           | used by                                                 | current kit                                                             |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| `PageHead` with a **badge slot beside the title** and a ReactNode subtitle (provider badge · LTR url · LTR id) | panel detail, bots                                      | title/subtitle strings only — **missing**                               |
| `StatCard` (label, value, unit, sub line, `alert`/`warnish` tone) and a stat grid (4/6 columns, reflowing)     | panel detail, bots, FX, optional panel list             | `Stat` exists; grid — check                                             |
| `Card` with `actions` in the head and a `tight` variant (table flush to the edges)                             | all                                                     | actions yes, tight — **missing**                                        |
| two-column content layout (`two-col`, collapses on tablet)                                                     | panel detail tabs, bot-buttons, appearance, client-apps | **missing**                                                             |
| `Badge` dot and outline variants; `StatusDot`                                                                  | health/status everywhere                                | **missing**                                                             |
| `DataTable`: dense rows, sticky head, `cell-main` two-line cell, toolbar and filter-chip slots, row link       | panels, providers, gateways, accounts, apps             | dense/two-line — **missing**                                            |
| `Chip`/`FilterBar`                                                                                             | panels live/archived (or keep `Pills`)                  | `Pills` only                                                            |
| `Tabs` with an optional count                                                                                  | panel detail                                            | **missing**                                                             |
| `Banner` with an action slot                                                                                   | panel detail (failure → Health tab)                     | **missing** (title, body, icon, role only)                              |
| accessible `Modal`/`Dialog` (focus trap, Escape, return focus)                                                 | gateway edit/API key, account form (optional)           | only `ConfirmDialog` — **missing**                                      |
| `ToggleRow` (title + description + switch)                                                                     | trial, gateway purposes, policy                         | **missing**                                                             |
| `CodeBlock` for technical JSON                                                                                 | panel technical view                                    | **missing** (plain `<pre>`)                                             |
| `TelegramPreview` (phone frame, message bubble, reply-keyboard rows)                                           | bot-buttons preview, client-apps preview                | **missing** — reference kit has one; OPS-A can ADD it if FOUND does not |
| `ProviderBadge` (outlined, LTR name + version)                                                                 | panels, providers                                       | page-level widget; may live in the family file                          |
| CSP-safe meter (SVG geometry, no `style`)                                                                      | optional capacity bar                                   | **missing** (dashboard uses `svg.bar`)                                  |
| icons: `pause`, `play`, `refresh`, `edit`, `external`, `activity`                                              | head actions                                            | **missing** from `ui/icons.tsx`                                         |

## 12. Test impact (none weakened)

- Class/structure queries to re-point: `panels.test.tsx:158,222` (`.toolbar` → role or
  label of the pills group), `panels.test.tsx:706` (`.skel` skeleton class — keep if the
  kit keeps it), `panels.test.tsx:756` (`tbody tr`/`td` of the registry table — keep a real
  table), `panels.test.tsx:1066` (`svg.chart` absent — keep asserting no chart),
  `bot-buttons.test.tsx:186,192` (`closest('section')`), `:232,245,268` (`.menu-preview`),
  `appearance.test.tsx:51,74,93` (`tbody tr`, `closest('tr')`), `csp.test.tsx:268`
  (`.tbl .al-start`, a DataTable class FOUND owns).
- Portal dialogs: any absence assertion on `container` must move to `document`.
- New tests to add in Phase 2: `FxSection` (none today); any new stat strip (derived only
  from the fields named above, and absent when the data is); the optional "sellable"
  column; `/bots/:id` if option B is chosen; route inventory entries for `/panels/new`
  and `/panels/:id`.

## 13. Open decisions for the lead

1. Bots: option A (single route, detail-composed) vs B (`/bots/:id`). Recommend A.
2. Panel detail lifecycle controls: keep in the Overview lifecycle card (recommended) vs
   move to the head with `ConfirmDialog`.
3. Panel list KPI strip: omit (recommended) vs draw only when the whole fleet is on one
   page.
4. Gateway / account / client-app forms: kit `Modal` vs inline cards — depends on
   whether FOUND ships an accessible `Modal`.
5. `TelegramPreview`: FOUND adds it to the kit, or OPS-A adds it (new component, no
   change to existing APIs).

## 14. Phase 2 record

Built on the WEB-FOUNDATION kit (`apps/web/src/ui/`), page CSS only in
`apps/web/src/styles/pages/ops-a.css` (page-prefixed classes: `panels-*`, `panel-*`,
`providers-*`, `bot-*`, `bot-buttons-*`, `appearance-*`, `gateways-*`, `fx-*`,
`accounts-*`, `client-apps-*`, and the shared phone frame `tg-phone*`), no `style`
attribute anywhere, no contract or backend change.

### 14.1 Decisions taken (the §13 open questions)

No lead answer arrived before Phase 2, so the Phase 1 recommendations were applied:

1. **Bots: option A.** `/bots` stays one route; each bot renders as a detail-composed
   section (`DetailHead` + stats strip, causes banner, two-column details / token). No
   `/bots/:id`, no route-table change.
2. **Panel lifecycle stays in the Overview tab**, as an isolated danger-zone card
   (`Card tone="danger"`). Only Test connection moved into the head. Moving
   Disable/Enable/Archive/Restore would lift the restore-with-rename fold into `basis`
   and the two-press archive out of `OverviewTab`; ~20 tests pin that interplay.
3. **Panel list KPI strip: omitted.** Fleet counts do not exist; a per-page count is the
   RSV2-BR-021 defect.
4. **Forms stay inline cards, not `Modal`s.** A modal closed by Escape or the backdrop
   would silently drop a dirty form; inline cards keep `useUnsavedChanges` the single
   guard. (So `payment-gateways.test.tsx`'s `container` password query stays valid.)
5. **`TelegramPhone` is page-level** (`apps/web/src/pages/telegram-phone.tsx`), shared
   by bot-buttons and client-apps; no kit API change.

Panel detail tabs: `?tab=` per D1, but through `Tabs` + `TabPanel` + `navigate()`
rather than `RoutedTabs`, because Overview must stay **hidden, not unmounted** (its
draft, basis and written revision) and a tab switch must therefore not be guarded.
Leaving the page is guarded by the Overview form itself.

### 14.2 Per route — what changed

| Route                  | Presentation now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/panels`              | Primary "افزودن پنل" with icon; flush dense table; name over LTR host (`CellMain`); outlined provider badge + probed version; dot health badge + outlined stale badge; failure badge; small last-check; latency; capacity fraction + CSP-safe `Progress` bar (capped panels only); status dot badge with the server's "قابل فروش نیست" marker beneath (reason as title; not on archived rows). Live/archived as `FilterChip`s in the gated `FilterBar` (`.toolbar`, `hidden` rule unchanged). Archived empty state uses the archive glyph. |
| `/panels/new`          | Two columns: sectioned form (identity; initial credentials only when `mayRotate` and the shape accepts them) beside a provider card (shape, required activation fields, a sentence when the actor cannot write credentials). Still one route, one submit.                                                                                                                                                                                                                                                                                  |
| `/panels/:id`          | `DetailHead`: name with status and health (+stale) badges, meta = provider badge · version · LTR base URL, Test connection as primary action, strip of six response fields (health + check time, latency, last healthy, sellable + reason, capacity + bar, services). Banners above the tabs: last failure with its remedy (`FAILURE_LABELS`) and an "open Health" action; server staleness. Tabs in `?tab=`.                                                                                                                              |
| — Overview             | Two columns: sectioned configuration form (connection & capacity, provider activation, username policy, foot with changed-elsewhere notice, Save and an unsaved hint, or a read-only sentence) beside identity, sellability and capacity (now with a `Meter`). Lifecycle card isolated as the danger zone. Dirty form guards leaving.                                                                                                                                                                                                      |
| — Health               | Latest-state banner; not-probeable banner; diagnostics (main) beside the latest-state KV card with a "بدون روند" chip. Still no chart.                                                                                                                                                                                                                                                                                                                                                                                                     |
| — Credentials          | One-way banner and hints unchanged; presence card beside the replace form.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| — Workload             | Products and services cards side by side.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| — Capabilities / Trial | Unchanged components inside the new frame (Marzban protocol checkboxes spaced).                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `/providers`           | Flush dense table; provider as outlined badge; capabilities as wrapping dot badges.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `/bots`                | Per bot: `DetailHead` (@username LTR, status + readiness badges, tenant meta, actions Live check / Start / Stop with icons, strip: webhook registered-at, secret state, menu state, Telegram id); causes as a banner; failure banner; details card (+ diagnostic card after a live check) beside the token card. **Stop asks through `ConfirmDialog`**. Add-flow card muted. Viewer gets a read-only sentence.                                                                                                                             |
| `/bot-buttons`         | Designer layout: order table (dense, gate notes wrap, icon up/down moves with the same per-button names) with Restore defaults and Save in the card head; side column = phone-frame preview (`.menu-preview` as the reply keyboard, bot @username in the title bar) and a rules card. Commands and sync side by side; labels card last. Unsaved arrangement guards leaving.                                                                                                                                                                |
| `/appearance`          | Dense slots table; custom-id cell is a labelled (visually hidden) LTR input with inline error; shared hint under the table; row actions; per-row dirty guard; test card below.                                                                                                                                                                                                                                                                                                                                                             |
| `/payment-gateways`    | Dense table: name + default badge over "last changed"; status over purposes; both bounds in one named cell; eligibility; gift / fee / Stars rate in one named cell; credential state; wrapping actions. Key card and a sectioned edit card (display, amounts, eligibility, money, purposes as `ToggleRow`s, **advanced disclosure** for sort order, foot with error, Save/Cancel, unsaved hint). Dirty guard for the form and a typed key.                                                                                                 |
| — FX                   | Card with Refresh (icon) in its head; error banner first; **four-figure strip** (state badge, current rate LTR + currency, age, last refresh); two-column KV (sources & windows / Stars); sources table; **technical disclosure** holding last error code, quote id and policy version.                                                                                                                                                                                                                                                    |
| `/payment-accounts`    | Dense table (label + default badge, masked card LTR, dot state, row actions); form card below with a two-column grid, make-default `Checkbox`, sort order under an advanced disclosure. Dirty guard.                                                                                                                                                                                                                                                                                                                                       |
| `/client-apps`         | Dense table, "+" new button in the card head, row actions, delete through **`ConfirmDialog`** (was `window.confirm`). Editor = two columns: sectioned form (app, links, guide, compatibility in three columns, advanced disclosure for order, foot) beside the phone-frame preview (stored image, text bubble with `data-testid="client-app-preview"`, inline button captions) and the image card. Dirty guard.                                                                                                                            |

### 14.3 Capability checklist (every §1–§10 item)

Legend: ✅ preserved and exercised by a test; ✅◦ preserved, structural (no dedicated test
beyond the page suite passing).

**Rules (§0)** — 1 credentials one-way: ✅ (panel secrets, bot token, TonPays key inputs
unchanged; `panels` "never renders a credential value", "starts every replace field
empty", bots token test, gateways key test). 2 health is a projection: ✅ (no chart
test; stale badge + new stale banner are the server's flag). 3 enable requires
validation: ✅◦ (no pre-check added). 4 buttons from permissions: ✅ (all gates kept;
new `bot_read_only` case). 5 CSP: ✅ (`csp.test.tsx` walks every route; `Progress`/
`Meter` are SVG). 6 idempotency: ✅ (no key handling changed; panel test/credential keys
still page-level). 7 money/numbers/times/LTR: ✅◦.

**/panels** — query key, cursor trail per mode, `?archived=only` via `setQuery`,
90 s poll ✅; every column from the response ✅ ("renders no location column",
"renders every column…"); stale as own fact ✅; failure badge ✅◦; capacity with
reservations/∞ ✅◦; status ✅; toolbar hidden on refusal ✅ (both `.toolbar` tests);
empty vs error ✅; pager newer/older + gated ✅; head action on `mayEdit` ✅◦. New:
host + not-sellable marker ✅, chip group ✅.

**/panels/new** — denied lock, `mayView` navigation vs banner, `mayRotate` fields,
provider StateSwitch (503 ≠ empty), shape/activation banners, only accepted non-empty
credentials sent ✅ (new-panel suite unchanged, 100 %).

**/panels/:id** — keyed by id ✅◦ (`app.tsx` untouched); `shownData` head ✅ (refusal
tests); Test connection gate + replay toast ✅; tabs ✅ (now `?tab=`: new tests); Overview
hidden-not-unmounted ✅ ("keeps the draft and the revision across a tab click");
identity/sellability/capacity cards ✅ (sellability suite, scoped to the card); config
form: changed-fields-only, cap text, activation schema, policy validator/preview,
concurrent-change notice with three wordings and reload ✅ (≈40 cases unchanged);
lifecycle Disable/Enable/two-press Archive with services count/Restore + rename ✅
(unchanged, incl. `closest('div.stack')`); Health tab banners, diagnostics poll, KV,
no chart ✅; Credentials tab presence/remove/replace/nothing-to-do/key at page level ✅;
Workload first pages + "more" ✅; Capabilities registry/policy/rules/technical ✅;
Trial ✅ (bot-buttons suite). New: failure/stale banners, head strip, leave guard ✅.

**/providers** — no permission, info banner, Persian columns, StateSwitch ✅◦.

**/bots** — denied, operate/destructive split, no add control ✅; per-bot KV incl. secret
and menu state, `bot-causes-<id>` testid, Stop confirm (now dialog; same "nothing sent
until confirmed"), Start, Live check (ACTIVE only), token form (password, cleared
`onSettled`, two toasts), diagnostic (`bot-diagnostic`, `bot-verdict`, cleared on status
change), failure + `bot-replacement-failure` ✅ (16 cases unchanged). New: dialog
cancel/Escape send nothing ✅.

**/bot-buttons** — queries and gates ✅; layout keyed by version, `tr[data-button]`,
invalid banner, slot select, shown switch, up/down (names unchanged), Save
(valid+dirty, `expectedVersion`), Restore defaults, saved/unchanged, `ErrorReport` ✅;
preview `.menu-preview` gated by open gates ✅; commands `tr[data-command]` + hash ✅;
sync card (`bot-menu-sync`, bot select, actions on ACTIVE, results, `bot-menu-check`) ✅;
labels `<details>` + `TemplateCard` + denied banner ✅ (15 cases unchanged). New: leave
guard ✅.

**/appearance** — `tr[data-slot]` per slot, fallback, id input with inline error
(`role="alert"`), switch, preview badge, Save/Reset with `expectedVersion`, viewer sees
no controls, test card with bot select and outcome toasts ✅ (6 cases unchanged).

**/payment-gateways** — no create, name/default badge, state, bounds (`0` = none),
eligibility, gift %, fee bp (GATEWAY routes only), Stars rate + missing badge, purposes +
"none" badge, credential state without value, updated, Edit / Replace key / toggle on
`mayEdit`, callback URL card, key card (empty, cleared, save disabled while empty),
toggle error banner, edit form with every field and inline errors, server refusals as a
banner ✅ (28 cases unchanged). **FX** (Phase 1 had no tests): strip + tone, technical
disclosure, unavailable state, refresh only with edit and its outcome toast, outage
leaves the routes table ✅ (5 new cases). New: dirty guards ✅.

**/payment-accounts** — form outside the StateSwitch (edit-only role), limit banner +
create disabled, masked card LTR, default badge, Edit / Make default / Enable-Disable
rules, one create-or-edit form with its fields, make-default on create only, editing id
`Copyable`, error banner ✅ (5 cases unchanged). New: dirty guard ✅.

**/client-apps** — one write in flight (`client-app-write`), columns, Edit, toggle with
`expectedVersion`, delete with `expectedVersion` only after confirmation (dialog now) ✅;
editor validation after first submit, preview as TEXT (`client-app-preview`, no
markup, no link), buttons, changed-elsewhere + reload, faults ✅; image card (save first,
stored/picked previews, upload/clear with version, ticket against out-of-order reads) ✅
(26 cases; one updated from `window.confirm` to the dialog, now also asserting exactly
one delete). New: dirty guard ✅.

### 14.4 Tests

- New: `tests/web/ops-a-redesign.test.tsx` (21 cases).
- Changed where markup legitimately changed, no assertion weakened:
  `panels.test.tsx` resets the address before each case (the tab is in the URL now) and
  asks two sellability questions of the sellability card, because the head strip
  repeats the verdict; `client-apps.test.tsx` drives the dialog instead of spying on
  `window.confirm`.
- Mutation spot-checks: removing the accounts page's `useUnsavedChanges` and
  guarding the panel tab switch each fail their new test.
- Shots fixtures (`tests/web/shots/fixtures/ops-a.ts`): panels (incl. a sellable one and
  a failing one), the advanced read, trial, workload lists, bots, bot menu + templates,
  appearance, gateways, FX, accounts, client apps — every OPS-A route shoots with no
  WARN.

### 14.5 Intentionally unchanged

- `app.tsx`, the route table and permissions: untouched (the detail reads its tab with
  `useRoute()`).
- Mobile lists stay scrollable tables (kit `DataTable`) rather than the reference's
  card lists; a per-row card renderer is a kit feature, not a page one.
- Reference-only items listed in §1–§10 (fleet KPI cards, monitor schedule, bot
  owner/kind, inline/reply designer, emoji library, add-bot, add-panel wizard, …) remain
  out: no contract field backs them.
