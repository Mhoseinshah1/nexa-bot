# Web redesign — OPS-B (config, support and system pages, part B)

Round W, Wave 2. Branch `claude/w-ops-b`, from `main` `f465d58`.

This file is written in two phases. **Phase 1** (below) is the inventory of what every page
does today and how it maps onto the reference composition. It is the checklist Phase 2 is
held to. **Phase 2** adds the migration record, test changes and screenshot paths at the end.

Authorities: current `main` for function, data and security. The reference preview
(`refs/reference/preview-v2`, commit `66c5539`) for presentation only.

## Routes in scope

| Route                                                       | Component (file)                                                                                | Nav entry permission                  | Page gates                                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `/settings`                                                 | `SettingsPage` (`pages/settings.tsx`, `settings-presentation.ts`)                               | `settings.view`                       | `denied=!settings.view`, `mayEdit=settings.edit`                                                       |
| `/features`                                                 | `FeaturesPage` (`pages/features.tsx`, `features-catalogue.ts`)                                  | `settings.view`                       | same pair                                                                                              |
| `/reminders`                                                | `RemindersPage` (`pages/reminders.tsx`)                                                         | `settings.view`                       | same pair + `mayViewTemplates=templates.view`, `mayEditTemplates=templates.edit`                       |
| `/content`                                                  | `ContentPage`, `TemplateCard` (`pages/content.tsx`, `template-copy.ts`, `i18n/templates.fa.ts`) | `templates.view`                      | `denied=!templates.view`, `mayEdit=templates.edit`                                                     |
| `/support`                                                  | `SupportPage` (`pages/support.tsx`)                                                             | `settings.view`                       | `denied=!settings.view`, `mayEdit=settings.edit`                                                       |
| `/tickets`                                                  | `TicketsPage` (`pages/tickets.tsx`)                                                             | `tickets.view`                        | `denied=!tickets.view`, `mayAssign=tickets.assign`, `mayEditCategories=tickets.categories.edit`        |
| `/tickets/:id`                                              | `TicketDetailPage` (same file), keyed by id                                                     | (detail of `tickets`)                 | `denied=!tickets.view`, `mayReply=tickets.reply`, `mayAssign=tickets.assign`, `mayClose=tickets.close` |
| `/ops-group`                                                | `OpsGroupPage` (`pages/ops-group.tsx`)                                                          | `settings.view`                       | `denied=!settings.view`, `mayManage=settings.edit`                                                     |
| `/alerts`                                                   | `AlertsPage` (`pages/alerts.tsx`)                                                               | `opslog.view`                         | `denied=!opslog.view`                                                                                  |
| `/notifications`                                            | `NotificationsPage` (`pages/alerts.tsx`)                                                        | ANY of `opslog.view`, `settings.edit` | `denied=!opslog.view`, `mayTest=settings.edit`                                                         |
| `/system` (`?section=status\|diagnostics\|monitor\|admins`) | `SystemPage`, `DiagnosticsSection` (`pages/system.tsx`, `pages/system-diagnostics.tsx`)         | none (every session)                  | per tab: diagnostics `opslog.view`, monitor `panels.view`, admins `admins.view` / `admins.edit`        |
| `/recovery` (`?cursor=`)                                    | `RecoveryPage` (`pages/recovery.tsx`)                                                           | `backup.view`                         | `backup.view`, `backup.run`, `backup.download`, `recovery.restore`, each gated in the page             |

Every gate above is a courtesy. The server authorizes every read and write on its own; no
gate is removed, loosened or added client-only in Phase 2.

## Cross-area exports that must keep their API

These files are imported by pages other agents own. Phase 2 restyles them in place and
does **not** move or rename these exports.

| Export                                                                                            | Defined in                    | Imported by                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messageFor`, `ErrorReport`, `issuesFrom`                                                         | `pages/settings.tsx`          | ~30 pages across every family (alerts, appearance, bots, broadcasts, bulk-operations, campaigns, client-apps, custom-service, discounts, extra-devices, fx-section, ops-group, panel-_, panels, payment-_, payments, product-_, products, referrals, reseller-_, resellers, service-*, services, support, tickets, trials, users) |
| `registryLabel`, `decimalText`                                                                    | `pages/settings.tsx`          | features page; `tests/web/custom-service.test.tsx`                                                                                                                                                                                                                                                                                |
| `TemplateCard` (props `template`, `mayEdit`, `onChanged?`)                                        | `pages/content.tsx`           | reminders (mine), **bot-buttons (OPS-A)** — restyling the card changes bot-buttons' look; coordinate                                                                                                                                                                                                                              |
| `sortOrderOf`                                                                                     | `pages/support.tsx`           | tickets (mine), **client-apps (OPS-A)**                                                                                                                                                                                                                                                                                           |
| `featurePresentation`, `FEATURE_PRESENTATION`                                                     | `pages/features-catalogue.ts` | features, reminders                                                                                                                                                                                                                                                                                                               |
| `TICKET_STATUS_LABELS`, `REPLY_FILE_FAULTS`, `ticketFault`, `readReplyFile`, `dayStart`, `dayEnd` | `pages/tickets.tsx`           | tickets tests                                                                                                                                                                                                                                                                                                                     |
| `opsGroupPollsFast`                                                                               | `pages/ops-group.tsx`         | ops-group tests                                                                                                                                                                                                                                                                                                                   |

Imports FROM other families that my pages depend on: `severityTone` from
`pages/dashboard.tsx` (DASH) in alerts; `OPERATION_STATE_LABELS`, `OPERATION_TYPE_LABELS`
from `pages/services.tsx` (COMMERCE) in diagnostics. If DASH or COMMERCE moves either,
my imports follow; I do not change them.

---

## 1. Capability inventory

Notation: **Q** query (key, cadence), **M** mutation, **P** permission, **C** confirmation,
**T** toast/feedback, **E** error mapping.

### 1.1 `/settings` — product settings (WP-A1, F3, F5, WP-A4, R1)

- **Q** `['settings']` → `GET /settings`, no polling, `enabled: !denied`.
- Rows shown = every setting EXCEPT `OPS_GROUP_MANAGED_SETTING_KEYS` (edited on
  `/ops-group`), `SETTINGS_MANAGED_ELSEWHERE` (`bot.main_menu`, on `/bot-buttons`) and
  `SETTINGS_RETIRED` (`trial.product_id`).
- Grouped by `SETTING_GROUPS` in fixed order — sales, wallet, services, reminders, trial,
  referral, support, fx, ops — each under a Persian `<h2>` (`SETTING_GROUP_TITLES`). A key
  this bundle does not know goes to a trailing "other" group titled
  `web.settings_group_other`, never dropped. Empty groups are not drawn.
- Per row (today one `Card` = `section.card` per setting):
  - Persian title + Persian description from `settingPresentation(key)`; unknown key →
    `web.settings_unknown_title` / `web.settings_unknown_desc`.
  - Badges: `consumer === 'PLANNED'` → maturity "ready" + info banner
    `web.setting_no_consumer` (stored, nothing reads it); `mutability === 'RESTART_REQUIRED'`
    → warn badge `web.restart_required`.
  - `configures !== null` → note `web.settings_needs_feature`.
  - `storedValueInvalid` → danger banner `web.stored_value_invalid` (default in force).
  - **Value in force** line (`web.settings_current_value`) rendered per control kind: number
    - Persian unit, select option's Persian label, currency label, money via
      `formatMoneyText`, lists joined with `web.list_separator`, channels summarised with
      handle/chat id (LTR), required/optional, join URL.
  - Money off-currency warnings: `web.settings_money_currency_mismatch`,
    `web.settings_presets_currency_mismatch` when a stored non-zero amount is not in
    `sales.currency`.
  - **Editor by control kind** (`SettingControl`): `integer` (numeric input, Persian/Arabic
    digits and grouping normalised to Latin, unit addon, range hint from
    `settingIntegerRange`, "optional — empty means not set" hint; emptied optional sends
    `null`, never 0), `text` (LTR mono), `decimal` (normalises Persian digits and `٫`),
    `select` (Persian options; an unlisted stored value is kept as an option), `currency`
    (`SALES_CURRENCY_CODES` only: Toman, Rial), `money` (amount + currency; choices =
    selling currency + stored one, off-currency options labelled
    `web.settings_currency_not_sales`), `money_list` (top-up presets, `ListEditor`),
    `handle_list` (support accounts, ordered, add/remove/reorder), `channel_list`
    (handle, chat id, join URL, mandatory `Switch` per row, enforcement hint), and a raw
    fallback editor for an unknown key (JSON round-trip by previous type).
  - Every input has an accessible name (visually hidden label, ordinals in list rows).
  - **Save**: explicit per-row submit (`web.save` / `web.saving`), only when `mayEdit`;
    inputs `disabled` otherwise. `noValidate` — the server's schema decides.
  - **Versioning**: the draft is based on `basis` (the row as first read); the write sends
    `expectedVersion: basis.version`. When the cached row moves under the draft (and our
    own write is not pending) → warn banner `web.changed_elsewhere` + `web.reload_value`
    button which adopts the fresh row and remounts the editor.
  - **Idempotency**: `useSubmissionKey`; the whole command (value, expectedVersion,
    key) is snapshotted at the click and is the mutation variable, so a retry carries the
    same key and payload. `settle` on success, `settleOn(error)` on failure.
  - After success: adopt the returned row; invalidate `['settings']` and `['features']`.
    After failure: invalidate the same (so a conflict can be reloaded).
  - **T/E**: success banner `web.saved`, no-op banner `web.unchanged` (server `changed:
false`); `SaveError`: `control.invalid_value` → Persian `web.settings_invalid_value`
    (or `web.setting_sales_currency_refused` for the 409 store-currency guard, or the
    guard's own sentence when it is Persian), English issues only inside a closed
    `web.settings_technical_issues` disclosure; everything else through `ErrorReport` /
    `messageFor` (connection vs. answered: `web.rejected` vs `web.error`; 403 →
    `web.no_permission`; `control.version_conflict` → `web.conflict`; …).
  - `updatedAt` line (`web.updated_at`).
  - **Advanced / technical** (closed `<details>`, `web.settings_technical`): machine key
    (LTR) and source (`web.source_tenant` / `web.source_default`). The normal view never
    shows a raw key, the English registry description, "منبع", "پیش‌فرض" or zero/empty
    developer notes (asserted by `settings-presentation.test.tsx`).
- States: `StateSwitch` loading / error (with retry rules) / denied / empty.
- **Gap vs. brief §8**: there is no page-level dirty-state protection today (no
  unsaved-changes indicator across rows, no leave guard). Phase 2 adds one (see §3).

### 1.2 `/features` — feature flags (WP-A2)

- **Q** `['features']` → `GET /features`, no polling.
- One row per flag: Persian title/summary from `featurePresentation`; an unknown flag
  shows its key as title and the server description.
- On/off badge (`web.enabled`/`web.disabled`); `web.feature_last_changed` timestamp.
- **M** `saveFeatureFlag({key, enabled, expectedVersion, idempotencyKey})` — switch only
  for `mayEdit` (nothing drawn otherwise; no inputs at all on the page). Turning ON is one
  click. Turning OFF asks **C** `ConfirmDialog` (`web.feature_confirm_disable`, detail =
  the flag's `disableEffect`, yes/cancel) only for flags whose switch-off loses something,
  and for any unknown flag (`web.feature_unknown_off_effect`). No typed key, no reason.
- `confirmDialogOpen()` guard — one question at a time; switch disabled while pending or
  asking; focus returns to the switch after cancel and after a confirmed write settles.
- Related settings (read-only): the flag's `configuration` minus ops-group-managed keys,
  named by `registryLabel`, value shown (`web.feature_setting_unset` for empty, on/off for
  booleans, LTR otherwise), `stored_value_invalid` marker, "inert" note and dimmed list
  when the flag is off.
- Invalidates `['features']` + `['settings']` on success and on error. `ErrorReport` on
  failure.

### 1.3 `/reminders` — automated customer reminders (WP-A9, HF-A9)

- **Q** `['settings']`, `['features']`, `['templates']` (only with `templates.view`).
- Five cards, each: flag switch(es) + numeric/money/time rows + collapsed template block.
  - Expiry: flags `service_expiry_reminders`, `service_expiry_day_reminder` (with hint),
    `service_expired_notice`; days `reminders.expiry_early_days` (0–30),
    `expiry_first_days` (1–30), `expiry_second_days` (1–30); warn
    `web.reminders_early_inert` when early ≤ first; templates expiry_early/first/second/
    day/expired.
  - Usage: flag `service_usage_reminders`; three thresholds shown and typed as percent
    REMAINING, stored as percent USED (`usageRemainingPercent`), range 0–(max−1).
  - Wallet: flag `wallet_low_balance_reminders`; threshold money row in the selling
    currency only, current value via `formatMoneyText`, mismatch warning.
  - Pending payment: flag `payment_pending_reminders`; minutes within
    `PENDING_PAYMENT_REMINDER_MINUTES_MIN..MAX`; two templates.
  - Quiet hours: flag `reminder_quiet_hours`; start/end `type="time"` HH:MM
    (`QUIET_HOURS_TIME_PATTERN`); overnight note; warn when start = end.
- Flag rows reuse the Features page's rule (confirm before OFF when `disableEffect` or
  unknown; ON without a question; focus hand-back; `confirmDialogOpen` guard).
- Number/time/money rows: client validation (Save disabled until valid), version basis
  that follows a conflict (`useVersionBasis`: adopt the refreshed version after
  `VERSION_CONFLICT`, keep the draft, retry succeeds), idempotency via
  `useSubmissionKey`, `stored_value_invalid` banner, saved/unchanged banners,
  `ErrorReport`.
- Template block: closed `<details>`; without `templates.view` shows
  `web.reminders_templates_denied` instead of hiding; otherwise `TemplateCard`s.

### 1.4 `/content` — message templates

- **Q** `['templates']` → `GET /templates`.
- Toolbar: search (Persian-normalised via `matchesTemplateSearch` over Persian name,
  description, raw key and the editable body), group select (`TEMPLATE_GROUPS`), source
  pills all/customised/default (customised = `overrideBody !== null`, including a stored
  but suppressed override), "N of M" count, no-match card with "clear filters".
- Filters HIDE cards (`hidden`), never unmount them, so unsaved drafts survive a search.
- `TemplateCard` (exported, also used by reminders and bot-buttons):
  - Title = Persian name (`BidiText` isolates Latin runs) or the key (LTR) with the English
    catalogue description as one LTR run.
  - Technical key line, format tag (HTML/plain), customised/default tag.
  - `overrideSuppressed` warning.
  - Textarea holds the **raw** body (override, else default) — never a rendered string;
    `maxLength`, `dir="auto"`, disabled without `templates.edit`. Length "n of max" in
    words, format hint.
  - Placeholder token chips `{token}` + Persian label (`placeholderLabel`).
  - Changed-elsewhere (version OR revision moved) → reload; unsaved → discard.
  - Default body in a `<details>` when customised.
  - Placeholders table in a `<details>` (token LTR, Persian description, Persian type,
    required/repeatable) or `web.template_no_placeholders`.
  - **Preview** `<details>`: sample value per placeholder (type hint), **Enter previews
    and never saves** (preventDefault), one preview at a time, stale marker when body OR
    samples moved since the request, rendered output as TEXT in `<pre dir="auto">`,
    unresolved placeholders named with labels, sample refusals mapped to Persian.
  - **Revisions** `<details>`: query enabled only once opened (sticky) and never refetched
    after a final refusal; `StateSwitch` for loading/error/empty; table revision/action/
    body/time.
  - Save (`expectedVersion` + `expectedRevision` from the draft basis, idempotency key,
    whole command as variable; only real submitter clicks save) and Revert (only when the
    basis has an override; separate idempotency key); `web.revert_note`.
  - `TemplateErrorReport`: `TEMPLATE_INVALID` issues per kind (empty, too long, unknown/
    missing/repeated placeholder, unknown icon) with token labels; `INVALID_VALUE` →
    which sample value failed; `TEMPLATE_NOT_OVERRIDDEN`, `UNKNOWN_KEY`, request-schema
    empty body; else `ErrorReport`. Saved/unchanged notice.
  - Invalidates `['templates']`, `['revisions', key]`, then `onChanged?.()`.

### 1.5 `/support` — FAQ and the support destination link

- Card pointing to `/settings` for the support destination (in-app link).
- **Q** `['support-faqs']` → FAQ list in server order.
- Table: order, question, active/inactive badge, updated at, actions (edit, activate/
  deactivate) — actions column empty for view-only (header kept).
- Create/edit form card (only `mayEdit`): question (max length), answer textarea, sort
  order (Persian/Arabic digits and grouping accepted; `SUPPORT_FAQ_SORT_MIN..MAX`, inline
  error `web.support_faq_sort_invalid`); submit disabled on empty text or bad order;
  cancel.
- **M** create / update (`expectedVersion` from the row the editor opened); status
  toggle (`expectedVersion`); all with idempotency keys.
- Version conflict (`commerce.support_faq_version_conflict`) or the row moved → warn
  banner + reload; limit error `commerce.support_faq_limit`; toasts
  `web.support_faq_saved`, `web.support_faq_status_done`.
- Empty state with a create action for editors.

### 1.6 `/tickets` and `/tickets/:id` — support tickets (WP-A7, HF-A7)

List:

- URL-held filters: `status` (pills: all + 4 statuses), `categoryId`, `assigned`
  (all / me / none / each admin), `customer` (LTR text), `from`/`to` days (applied on
  submit, validated; sent as a half-open interval `[dayStart(from), dayEnd(to))`);
  apply + clear (clear resets all six). Filters hidden when the query may not be requested.
- **Q** `['tickets', filters, cursor]`, `['ticket-categories']`, `['ticket-assignees']`
  (only with `tickets.assign`). Cursor pager with a trail reset on filter change.
- Columns: `#number` (link), subject, category, status badge, priority badge, customer
  (link to `/users/:id`, name · @username · telegram id), assignee / unassigned, last
  message, created.
- Empty: filtered vs. unfiltered copy.
- Categories card (not when denied): table title/order/active; editors (rename, reorder,
  show/hide) only with `tickets.categories.edit`; create form (normalised title, sort
  order); toasts created/saved/no change; `ticketFault` mapping.

Detail (`/tickets/:id`):

- **Q** `['ticket', id]`.
- PageHead `ticket #n` + subject.
- Summary KV: status, priority, category, assignee, created, last message, closed at.
- Context card: customer link, telegram id (LTR), @username, customer status; linked
  service / order / payment (links, LTR short ids); links form (service/order/payment
  ids, LTR) with `tickets.assign`.
- Actions card (with `tickets.assign` or `tickets.close`): status transitions allowed by
  `ticketManualEvent` from the current status (close is `danger`; closed offers one
  reopen); assignee select; "assign to me" (viewer from the cached session); priority
  select. Toasts saved/no change; failures toast `ticketFault`; invalidate ticket + list.
- Conversation: ordered thread; system events; customer vs. support bubbles; support
  author; per-reply delivery badge (pending/delivered/unconfirmed/failed/superseded/none);
  attachments (photo/document, name, size via `splitBytes`, delivery badge, view/download
  through an object URL fetched on demand, revoked on unmount; alt text).
- Reply card (`tickets.reply`): text (normalised, bounded), optional file (type, size,
  name and content checked client-side via the contract; latest pick wins; READING blocks
  send), idempotency key over ticket + text + file content; closed ticket → info banner
  and no form; `ticketFault` incl. file refusals and a full staging area.

### 1.7 `/ops-group` — management reports group (WP-A4, WP18)

- **Q** `['ops-group']`, polled 3 s while a connect code is pending or a connected group
  is unverified, else 15 s (`pollUnlessFinalWhile`).
- Lane-off warning. Connection card: connected/disconnected badge; facts (group, bot,
  health badge + checked at, last delivery); problems list, each problem as its remedy.
- Manager actions (`settings.edit`): verify, test (per-topic sent/failed result list),
  reconnect (when a group exists), disconnect behind an inline **C** confirm banner.
  Shared submission key; an `IDEMPOTENCY_IN_FLIGHT` answer keeps the key.
- Topics card (SYSTEM, PAYMENTS: state badge + last delivery). Queue card: pending,
  preserved, requeue preserved (manager, connected, preserved > 0) with a count toast.
- Connect card (manager): three steps; bot select when > 1 bot; issue a code → deep link
  button + copyable `/command` + expiry; no chat-id field.
- Advanced manual fallback (closed `<details>`, loads `['settings']` only once opened):
  chat id, system topic id, payments topic id (numeric → number, empty → null); save per
  row with the row's version and an idempotency key; "manual in use" note.

### 1.8 `/alerts` — management alerts

- **Q** `['ops-log','management', severity, openOnly, cursor]` → `GET /ops-log` with
  scope `MANAGEMENT` or `MANAGEMENT_CONDITIONS` (+ `open: true`), page size 25, cursor pair
  (`before`, `beforeId`); polled 30 s only on the first page, stops on a final refusal.
- Scope banner (not the operational history). Refresh button, filters (open/all pills,
  severity select) and pager all withdrawn once the query may not be requested (denied,
  or refusal final); pager only when the rows are on screen.
- Columns: severity badge (`severityTone`), code (LTR), message, occurrences, first/last
  seen, state (recorded / recovered for one-shot and recovery codes, else resolved/
  unresolved).
- Empty copy distinguishes "nothing open" (only unfiltered open view, first page) from
  "nothing matched".

### 1.9 `/notifications` — operational notification deliveries (WP18)

- **Q** `['notifications', cursor]` page size 25; 3 s while any row is PENDING, else 30 s
  discovery on the first page only; detail `['notification', id]` 3 s while PENDING.
- Test sends (`settings.edit`): operations (`target: OPERATIONS`) and payments topic
  (`PAYMENTS`), each with its own idempotency key; created vs. replayed banner; error.
- Table: status badge, template key (button → detail, LTR), attempts n / max, updated.
  Pager only while ready.
- Detail: skeleton while loading; stale-after-error banner with retry only when
  retryable; error empty-state; attempts table (n, outcome, error code LTR, message,
  finished); released-claims table with intro.
- The page is reachable with either permission; without `opslog.view` the list is denied
  but the test sends remain.

### 1.10 `/system` — status, diagnostics, monitor, administrators

- Tabs in the URL (`?section=`), unknown value falls back to status; `#system-panel`
  tabpanel.
- **Status**: readiness `['readiness']` 15 s (dependency, up/down, latency ms, detail);
  build info `['info']` (version, commit copyable, environment, build time, node).
- **Diagnostics** (`opslog.view`, else denied with no request): `['system-diagnostics']`
  30 s. Stuck provisioning: counts per reason (with hint tooltips), sample table
  (reason badge, operation type · state, attempts, since, service link); outbox: pending,
  oldest, failing, exhausted + warn/danger banners, failing sample (event, aggregate,
  attempts, occurred, next attempt or "no more attempts", last error). Read-only — no
  control changes anything.
- **Monitor** (`panels.view`): `['monitor-profile']` 60 s: enabled, intervals, tick,
  freshness; capacity (ceiling note, tenant/installation ceilings, scheduler capacity
  exceeded badge — the only place that condition reaches an operator, turn ceiling, probe
  budget, reserve %, batch, concurrency); separation card (lightweight now, heavy/user
  sync planned).
- **Administrators** (`admins.view`; edits `admins.edit`): `['admins']` 60 s. Table: name
  - username, active/suspended, roles, last login, Telegram binding, manage.
  * Create (idempotency key; username, display name, password ≥ 12, ≥ 1 role; roles
    `['roles']` fetched when opened; username-taken mapping).
  * Manage (per row): live sessions `['admin-sessions', id]` 15 s while open via
    `StateSwitch` (current badge, last seen, issued, expires, IP, agent); reason required
    for every change; enable/disable, revoke sessions, role picker (may remove the last
    role), password reset ≥ 12 with sessions-revoked count; refusal mapping (self
    modification, privilege escalation, last owner). Row replaced in the cache.
  * Telegram binding: not connected / numeric id (LTR); connect / replace / remove with a
    reason; numeric-id validation before any request; taken-id mapping.
- "No logs page" card — its absence is a stated decision.

### 1.11 `/recovery` — backups and restore (ADR-0025, ADR-0028)

- **Q** (`backup.view`): `['backup-status']`, `['backup-history', cursor]` (10 per page,
  cursor in the URL), `['recoveries']` — all 15 s; `['recovery-capabilities']` once.
- Quiesce banner while a recovery holds the installation (derived from status).
- Status: schedule on/off (off → warning: a green history then means nothing), interval,
  last success or "never", unknown deliveries (+ warning), running run id; **Run now**
  (`backup.run`; disabled while running or quiesced; fresh idempotency key); outcomes
  BUSY (the invariant working, not a failure) / COMPLETED; server refusal shown as its
  message, never a raw exception.
- Last verified success: id, started, finished, dump size, verified, checksum, archive
  size, delivery (OUTCOME_UNKNOWN is its own state); cleanup-incomplete warning (plaintext
  may remain); download (`backup.download`) as a plain anchor, or "archive gone".
- History table (started, trigger, state, verified, delivery, size, download column only
  with `backup.download`), pager.
- Operations: upload disabled when the server says so; file choose, client size check
  against `maxUploadBytes`, upload; resulting request KV (state, stage, verification
  taken at / source DB / checksum, restore-test table count / migration verdict, failure
  code); **Verify** when UPLOADED; **Restore confirmation** when RESTORE_TEST_PASSED:
  refused without `recovery.restore`; danger banner; the constant phrase shown LTR beside
  an LTR input; wrong-phrase warning; confirm disabled until the exact phrase is typed and
  the artifact checksum is present; sends `phrase` + `artifactChecksum` + idempotency key
  (the SHA-256 binding); RESTORE_REQUESTED → confirmed + expiry.
- Recovery requests table (created, by, state, stage, failure, displaced DB copyable,
  cutover at).
- Foreign-installation archives: reported as unsupported, not hidden.
- No secret anywhere on the page; no HTTP request restores (the page only uploads,
  verifies and confirms — the destructive work is the `recovery` process role's).

---

## 2. Mapping to the reference composition

General rules for every page: kit `PageHead` (compact title + one-line subtitle + grouped
actions; status badge beside the title on detail pages), kit `Card`s with 1px borders and
10px radius, dense kit tables, `StatCard`s only for numbers the page already has, shared
empty/loading/error/denied states through `StateSwitch`, technical values LTR only.

| Page             | Reference                                        | Composition in Phase 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Reference-only (NOT added)                                                                                                                                                                                                                                                                                                                         | Nexa-only (kept)                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/settings`      | `dark-settings.png`, `pages/settings.tsx`        | `PageHead` (+ unsaved-changes badge). Two columns: a sticky **section sub-nav** (vertical list of the Persian group titles, `aria-current` on the section in view) and the content column with **one card per group**; inside it one **setting row per key** (reference `toggle-row` layout: Persian label + helper text on the start side, control + unit addon + per-row Save on the end side; value in force, banners and the closed technical disclosure under it). The sub-nav jumps to the section (every group stays rendered, so no route change and nothing is hidden).                                                                             | Store name, timezone/calendar/digits, proxy, login policy, secrets rotation, audit, maintenance mode, export/import, danger zone, the page-wide single Save/Cancel, the raw key under each label, "default/set" badges in the normal view — none has a registry key, and raw keys in the normal view are forbidden by the owner rule.              | Per-row save with version check and conflict reload; PLANNED / RESTART_REQUIRED / invalid-stored markers; currency narrowing; list editors; the "other" group.                                                                  |
| `/features`      | reference `ToggleRow` inside a card              | One card, a dense list of `ToggleRow`s (Persian title, one-line summary, badge + switch; last-changed and related settings as a secondary line/disclosure under each row).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | "Features" living under settings/advanced with raw flag keys; typed-key confirmation dialog.                                                                                                                                                                                                                                                       | Plain yes/cancel confirm only where the switch-off loses something; focus restoration; related settings, inert marker.                                                                                                          |
| `/reminders`     | settings composition                             | Same sub-nav + card layout as settings: one card per family with `ToggleRow`s for the flags and form rows for thresholds; templates stay in a closed disclosure per card.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —                                                                                                                                                                                                                                                                                                                                                  | Remaining-vs-used percent conversion, quiet-hours notes, version basis following a conflict.                                                                                                                                    |
| `/content`       | `dark-content.png`, `pages/content.tsx`          | **List-split**: start column = searchable, filterable list of templates grouped by section (Persian name + LTR key, customised marker, unsaved marker) with the all/customised/default chips and the count; end column = the selected template's editor card (raw body, token chips, reload/discard notices) with the preview beside or under it and revisions/default/placeholders as disclosures. All `TemplateCard`s stay MOUNTED (non-selected ones `hidden`) so drafts survive selection and search. When the selection is filtered out, the first visible template is selected.                                                                        | Menu & keyboard designer (bot-buttons is OPS-A's), import/export buttons, a WYSIWYG Telegram bubble with inline buttons and sample-name highlights, "usage" card (where sent / buttons count) — no API for those.                                                                                                                                  | Search over body and key, group select, preview stale/unresolved/Enter rules, sticky revisions query, revert rules, Persian error mapping. The rendered preview stays TEXT (never injected HTML), inside a bubble-styled `pre`. |
| `/support`       | list page composition                            | `PageHead` (New FAQ action), destination card compact, FAQ dense table with row actions, create/edit form as a card (or modal if the kit's is accessible) with inline validation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | —                                                                                                                                                                                                                                                                                                                                                  | Version-bound edit/toggle, conflict reload, limit error.                                                                                                                                                                        |
| `/tickets`       | `dark-orders.png` list pattern                   | `PageHead`; status `Chip`s + a `FilterBar` (category, assignee, customer search, date range, apply/clear); dense table; cursor pager; categories card below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Saved views, bulk actions, SLA timers.                                                                                                                                                                                                                                                                                                             | Half-open date range, URL-held filters, categories editor gated separately.                                                                                                                                                     |
| `/tickets/:id`   | `dark-order-detail.png` detail pattern           | `PageHead` "تیکت #n" with status + priority badges beside the title; two-column: conversation thread (chat bubbles, delivery badges, attachments) + reply card in the main column; summary KV, context/links and actions (status transitions, assignee, assign to me, priority) as side cards. Destructive "close" stays visually distinct.                                                                                                                                                                                                                                                                                                                  | Internal notes, canned replies, typing indicators.                                                                                                                                                                                                                                                                                                 | Transitions from `ticketManualEvent`, file checks, per-reply delivery.                                                                                                                                                          |
| `/ops-group`     | system cards                                     | `PageHead`; `StatCard`s for connection, health, pending, preserved; connection card (facts + problems + actions), topics card, connect card; manual fallback as the closed advanced disclosure.                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —                                                                                                                                                                                                                                                                                                                                                  | Everything in §1.7.                                                                                                                                                                                                             |
| `/alerts`        | `dark-system-health.png` ("رویدادهای سلامت پنل") | Card with open/all `Chip`s + severity select in the card head; dense table; pager; refresh in `PageHead` actions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Per-row resolve buttons, panel link column.                                                                                                                                                                                                                                                                                                        | Management-scope banner, filtered vs. true-empty copy, final-refusal withdrawal.                                                                                                                                                |
| `/notifications` | `dark-notifications.png`                         | `PageHead` (test-send actions); dense table (status dot badge, key LTR, attempts, updated); pager; detail opened from a row shown as a side card/drawer with attempts + released claims.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | The 4 KPI cards (sent 24h, queued, failed 24h, open alerts) — no endpoint gives those numbers; the kind chips and search — the list endpoint has no such filters (filtering one page client-side would mislead); **the compose wizard (`dark-notification-compose.png`) — broadcasts are COMMERCE's page and this route is the ops delivery log.** | Test sends to two targets, replay banner, released claims, retry rules.                                                                                                                                                         |
| `/system`        | `dark-system.png`, `-health`, `-monitor`         | `PageHead` with build identity in the subtitle (version · commit · environment · build time, from `/info`); the same four tabs. Status tab: `StatCard`s from real data (overall readiness "n of m up", version, environment) + readiness table with `StatusDot`s + build info. Diagnostics: `StatCard`s for the four stuck reasons and outbox numbers + the two tables. Monitor: danger banner at top when `schedulerCapacityExceeded`; `StatCard`s (monitor enabled, tick, tenant ceiling, installation ceiling); cadence and capacity as KV cards side by side; separation card. Admins: dense table; manage/binding forms in an expandable row or drawer. | Requests/min, p95 latency, process/replica table with CPU/mem/restarts, jobs & queues tab, bot errors, logs tab, keys/secrets tab, "advanced settings" and "check updates" buttons, env-var table of `PANEL_MONITOR_*`.                                                                                                                            | Status/diagnostics/monitor/admins exactly as today; the stated no-logs card.                                                                                                                                                    |
| `/recovery`      | system composition                               | `PageHead`; quiesce banner; `StatCard`s (schedule, last success, unknown deliveries, interval); last verified backup card; history table; operations card as a stepper-like sequence (upload → verify → confirm) with the restore confirmation isolated in a danger-zone card; requests table; foreign-archive note.                                                                                                                                                                                                                                                                                                                                         | —                                                                                                                                                                                                                                                                                                                                                  | Every ADR-0025/0028 rule in §1.11.                                                                                                                                                                                              |

Status labels: several tables print enum values raw today (alert severity, notification
attempt outcome, backup/recovery state). Phase 2 keeps them readable and does not change
what they say; where a Persian label already exists in the catalogue (e.g.
`web.setting_severity_*`) it may be reused, with the raw value kept in the badge's
accessible text only if a test asserts it.

## 3. Kit components needed from FOUND

Needed (existing names from today's kit or the reference kit):

- `PageHead` with a `badge` slot (status beside the title; unsaved-changes badge) and
  `actions`.
- `Card` with `title`, `hint`, `actions`, `foot`, a `tight` (flush table) variant, and a
  danger-zone variant.
- `StatCard` / `AlertStatCard` (label, value, unit, tone, hint) — system, monitor,
  diagnostics, ops-group, recovery.
- `StatusDot` (up/down, topic state) and `Badge` with a dot variant.
- `Tabs` (horizontal, URL-driven, `panelId`/`TabPanel` a11y as today) and a **vertical
  section nav** (reference `Tabs vertical`) for settings/reminders — as links/buttons with
  `aria-current`, not a `tablist`, since every section stays rendered.
- `ToggleRow` (title, description, switch, trailing badge) and a **form row** layout
  (label + hint | control + addon + action) — for settings, features, reminders.
- `Chip` / `FilterBar` / `SearchBox` (alerts, tickets, templates).
- `Field` (label, hint, inline error), `InputGroup` with addon, `Select`, `Textarea`,
  `Switch` (with a ref or a `returnFocus` hook — features/reminders need focus returned to
  the switch), `Checkbox` (role picker).
- `DataTable` + `CursorPager` (as today: `caption`, `align`, row keys).
- `Disclosure` (styled `<details>`/`<summary>`) for the technical/advanced areas — must
  stay a real `<details>` (tests and the "closed by default" rule rely on it).
- `ConfirmDialog` (exists, focus-trapped) and an accessible `Modal`/`Drawer` if FOUND
  provides one (notification detail, admin manage).
- `KV` / `DefinitionList`, `Copyable`/`CopyButton`, `Ltr`, `Num`, `Duration`, `Money`.
- `Empty`, `Skeleton`, `StateSwitch`, `useToast` (as today).
- `Timeline` (optional: template revisions, ticket system events).
- **Missing today, flagged**: a dirty-state guard. Brief §8 asks for dirty-state
  protection; the router has no blocking hook. Proposed kit/router addition:
  `useUnsavedChanges(dirty)` that registers `beforeunload` and makes `navigate()` /
  the link handler ask before leaving while any registered form is dirty. Settings,
  reminders, content, support and the ticket reply would register. If FOUND does not
  provide it, OPS-B adds a page-local `beforeunload` guard only and reports the in-app
  navigation gap.

## 4. Tests that are coupled to today's markup

These will be updated in Phase 2 to a role/label query that asserts the same thing:

- `settings-presentation.test.tsx`: `heading.closest('section.card')` as the row container
  (rows stop being one card each) → a labelled row container (`role="group"`,
  `aria-labelledby` the title). The first `details` in a row must stay the technical
  disclosure.
- `settings-presentation.test.tsx` (ops-group topic id): `field.closest('.field-row')`.
- `settings-and-alerts.test.tsx`: alert state read from `td` index 6 — column order kept,
  or the test reads the cell by column header.
- `templates-persian.test.tsx`: `hidden(key)` = "the card is inside `[hidden]`". Under the
  list-split every non-selected card is hidden, so "a search found it" becomes "its list
  item is shown"; the draft-survives-search assertion is kept as is.
- `ops-group.test.tsx`: the first `details` on the page is the manual fallback.
- `system-diagnostics.test.tsx`, `editor-rules.test.tsx`: `#system-panel`,
  `[aria-selected="true"]` on the system tabs — kept.
- `recovery.test.tsx`: zero `button, input, select, table, a` for a denied actor — kept.

---

## Phase 2 — migration record

_To be written after FOUND merges._
