# Web Admin redesign — foundation (round W, wave 1)

The shared layer every page family builds on: tokens, typography and theme,
the stylesheet layout, the UI kit, the application shell, the route inventory,
and the screenshot harness. **Visual authority** is the reference preview
(`refs/reference/preview-v2`, `apps/web/preview/src`); **functional authority**
is `main` — no route, permission, query or mutation changed here.

Page agents: read §5 (kit API) and §7 (harness) before touching a page; put
page CSS only in your family file (§3); never restyle a kit class from a page.

---

## 1. Tokens, typography, theme

The current app already carried the reference's palette token for token, so the
colour diff is **nil**; what changed is that every value the reference used as
a literal is now a named token, and one broken reference was fixed.

| Token group                      | Reference (`preview.css`)                       | `main` before                                                    | Now (`styles/tokens.css`)                                                                                    |
| -------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--bg-0…4`, `--line`, `--line-2` | dark + light sets                               | identical                                                        | identical                                                                                                    |
| `--fg`, `--fg-2`, `--fg-3`       | dark + light                                    | identical                                                        | identical                                                                                                    |
| `--accent*`, semantic `*-soft`   | ok/warn/danger/info/violet/teal                 | identical                                                        | identical                                                                                                    |
| `--chart-1…6`, `--chart-grid`    | yes                                             | identical                                                        | identical — the chart classes `s1…s6` read them                                                              |
| `--shadow`, `--shadow-sm`        | yes                                             | identical                                                        | identical                                                                                                    |
| on-colour white, overlay, brand  | literals (`#fff`, `rgba(4,6,10,.55)`)           | literals                                                         | `--on-solid`, `--overlay` (per theme), `--brand-from/to`                                                     |
| type scale                       | literals 10.5–13.5px                            | literals                                                         | `--font-ui`, `--font-mono`, `--fs-body` 13.5, `--fs-ui` 12.75, `--fs-sm` 12, `--fs-xs` 11.5, `--fs-2xs` 10.5 |
| radii                            | 10px card / 7px control / 5px badge             | literals                                                         | `--radius-card` 10, `--radius-ctl` 7, `--radius-sm` 5, `--radius-pill`                                       |
| sizes                            | 32/26px controls, 248/60px sidebar, 52px topbar | literals                                                         | `--ctl-h`, `--ctl-h-sm`, `--sidebar-w-full`, `--sidebar-w-rail`, `--topbar-h`, `--gap`                       |
| `--text-3`                       | —                                               | **referenced, undefined** (neutral distribution bar had no fill) | fixed to `--fg-3`                                                                                            |

- **Font**: Vazirmatn variable, served from `apps/web/public/fonts` with its
  `OFL.txt` (unchanged). Body 13.5px / 1.6, `ss01`.
- **Digits**: the body's `ss01` draws digits in Persian shapes, which the
  reference also did inside Latin usernames (`@saeed_ir۲`). `.ltr` now resets
  `font-feature-settings`, so a technical value keeps Latin digits
  (`@user_7`, `127.0.0.1`, `v0.4.0`). Tabular numerals: tables, stat values,
  money, `.num`.
- **Theme**: one model — `theme.ts` always writes `data-theme` on `<html>`
  (`system` resolves through `prefers-color-scheme` and follows OS changes).
  The sidebar's theme button cycles system → dark → light; switching only sets
  the attribute, so nothing remounts and no form state is lost (pinned by
  `tests/web/shell.test.tsx`).
- **Motion**: decorative only, and `prefers-reduced-motion: reduce` turns it off.

## 2. Component inventory — reference vs `main` vs now

| Brief §3 item                     | Reference preview                                                                   | `main` before                                   | Now (`src/ui/`)                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| AppShell / Sidebar / Topbar       | `app.tsx` (mock nav, tenant menu)                                                   | shell in `app.tsx`, flat groups                 | `app.tsx` `SignedIn` + `src/shell.tsx` `Sidebar`, `Topbar`, `CommandSearch`                                                            |
| Breadcrumbs                       | inline in `app.tsx`                                                                 | inline in `app.tsx`                             | `Breadcrumbs`                                                                                                                          |
| PageHead                          | `PageHead` (title, sub, badge, actions)                                             | `PageHead` (title, subtitle, maturity, actions) | `PageHead` + `badge`, node title/subtitle                                                                                              |
| Card                              | `Card` (title, right, tight, foot)                                                  | `Card` (title, hint, actions, foot)             | `Card` + `tone: 'danger' \| 'muted'`, `tight`, `id`                                                                                    |
| StatCard / AlertStatCard          | `Stat` (card, delta, spark)                                                         | `Stat` (strip cell)                             | `StatCard`, `AlertStatCard`; `Stat` kept as the strip cell                                                                             |
| Badge / StatusDot                 | `Badge` dot/pulse/outline, `Status`                                                 | `Badge`                                         | `Badge` + `dot`, `outline`, `pulse`; `StatusDot`; `MaturityBadge` kept                                                                 |
| Button / ButtonGroup / IconButton | classes only                                                                        | classes only                                    | `Button`, `IconButton`, `ButtonGroup` (`segmented`); `.btn` classes unchanged                                                          |
| Input / Textarea / Select         | `.input`                                                                            | `.input`                                        | `Input`, `Textarea`, `Select`; bare `<input>`/`<select>`/`<textarea>` styled too                                                       |
| Checkbox / Radio / Switch         | `.check`, `Switch`, `ToggleRow`                                                     | `Switch`                                        | `Checkbox`, `Radio`, `Switch` (+`danger`), `ToggleRow`                                                                                 |
| Period controls                   | `DateRange` (fake custom inputs)                                                    | —                                               | `PeriodControl` (presets + compare; custom inputs are the caller's slot)                                                               |
| Search / FilterBar / chips        | `SearchBox`, `Chip`, `.filter-row`                                                  | `.toolbar` class                                | `SearchInput`, `FilterBar`, `FilterChips`, `FilterChip`, `ChipDivider`                                                                 |
| Table                             | `DataTable` (client sort + paging)                                                  | `DataTable` (server order)                      | `DataTable`/`Table` + `toolbar`, `filters`, `dense`, `sticky`, `rowClassName`, column `wrap`; `CellMain`, `RowActions`, `IdentityCell` |
| Pagination                        | `CursorPager` with a fake cursor                                                    | `CursorPager` (keyset)                          | `CursorPager`/`Pagination` — same keyset semantics                                                                                     |
| Tabs                              | `Tabs` + counts                                                                     | `Tabs`, `TabPanel`, `Pills`                     | + counts, `vertical`; `useQueryTab`, `RoutedTabs` (`?tab=`, lazy panels)                                                               |
| Modal / Drawer / Menu             | `Modal`, `Drawer`, `Menu` (no focus trap)                                           | —                                               | `Modal`, `Drawer`, `Menu`, `useFocusTrap` (`ui/overlays.tsx`)                                                                          |
| ConfirmDialog                     | `Confirm`, `DangerDialog`                                                           | `ConfirmDialog`                                 | `ConfirmDialog` unchanged in behaviour, restyled                                                                                       |
| Toast                             | `ToastProvider` (title/text)                                                        | `ToastProvider`, `useToast`                     | unchanged API and timers, restyled                                                                                                     |
| Empty / Loading / Error / Denied  | `Empty`, `Skeleton`, demo `StateSwitch`                                             | `Empty`, `Skeleton`, `StateSwitch`              | + `EmptyState`, `LoadingState`, `ErrorState`, `PermissionDeniedState`; `StateSwitch` uses them                                         |
| ChartCard / Sparkline / charts    | `Sparkline`, `LineChart`, `ColumnChart`, `Donut`, `HBars`, `Legend` (inline styles) | `TrendChart`, `Distribution`                    | `ChartCard`, `Legend`, `Sparkline`, `LineChart`, `BarChart`, `Donut` (`ui/charts.tsx`); `TrendChart`, `Distribution` kept              |
| Metric / DefinitionList           | `KV`                                                                                | `KV`                                            | `Metric`, `KV`/`DefinitionList` (+`inline`)                                                                                            |
| Code / CopyButton                 | `.code`, `Copyable` (toast only)                                                    | `Copyable` (real clipboard)                     | `CodeValue`, `CopyButton`, `Copyable` kept                                                                                             |
| Progress / meter                  | `Progress` (inline width)                                                           | —                                               | `Progress`, `Meter` — SVG geometry, exact for bigints                                                                                  |
| Detail head / layout              | `.head-card`, `.head-stats`, `.two-col`                                             | classes                                         | `DetailHead` (stats strip), `TwoColumn`, `Timeline`                                                                                    |
| Dirty-state protection            | —                                                                                   | —                                               | `useUnsavedChanges`, `LeaveGuardHost` (`ui/unsaved.tsx`) + router guard                                                                |

Not ported, deliberately: the preview's `StateSwitch` («حالت نمایش»), the
`پیش‌نمایش` note, `useMockAction`, `mock/*`, `router.ts` (hash routing), the
tenant switcher (the session has one tenant and no way to switch),
`TelegramPreview` (page-specific), client-side sorting and numbered paging (the
API is keyset and server-ordered).

## 3. Stylesheet layout — who edits what

`apps/web/src/styles.css` is only an entry point:

```
styles/tokens.css           FOUND   colours, radii, sizes — dark and light
styles/base.css             FOUND   document, typography, utilities, layout primitives
styles/kit.css              FOUND   every class a src/ui/ component emits + generic classes
styles/shell.css            FOUND   sidebar, topbar, content frame, sign-in, responsive shell
styles/pages/dashboard.css  DASH
styles/pages/commerce-a.css COMMERCE-A
styles/pages/commerce-b.css COMMERCE-B
styles/pages/ops-a.css      OPS-A
styles/pages/ops-b.css      OPS-B
[hidden] { display: none !important }   — stays LAST, in the entry
```

Rules: page files hold page-scoped classes only (prefix them with the page's
name); never restyle `.btn`, `.card`, `.tbl`… from a page file — add a kit
variant instead (ask the lead). No `style` attributes anywhere: the production
CSP is `style-src 'self'` (see §6). `stylesheet-contract.test.tsx` expands the
imports in place and pins their order.

Layout primitives in `base.css`: `.stack` / `.stack-sm` (vertical rhythm),
`.row`, `.grow`, `.spacer`, `.grid` + `.c2/.c3/.c4/.c6`, `.grid-2`, `.span2/3`,
`.full`, `.two-col`, `.list-split`, `.three-col`, `.checks`, `.form-grid`
(+`.c3`), `.field-row`, `.form-actions`. Page content, tab panels, modal and
drawer bodies, and class-less `<form>`s already space their children.

## 4. Navigation and shell

Every current route stays reachable with its permission gate unchanged (the
table moved from `app.tsx` to `src/nav.ts` and is re-exported from `app.tsx`).
Groups follow the reference's semantic sections, extended to hold every
surface the product has now: عملیات · فروش · نمایندگی · زیرساخت · ارتباط ·
پیکربندی · سامانه.

| Group    | Path                  | Label                   | Icon           | Permission (unchanged)                                                   |
| -------- | --------------------- | ----------------------- | -------------- | ------------------------------------------------------------------------ |
| عملیات   | `/`                   | نمای کلی                | `dashboard`    | `null`                                                                   |
| عملیات   | `/orders`             | سفارش‌ها                | `orders`       | `'orders.view'`                                                          |
| عملیات   | `/services`           | سرویس‌ها                | `services`     | `['services.view', 'refunds.view']`                                      |
| عملیات   | `/users`              | کاربران                 | `users`        | `'users.view'`                                                           |
| عملیات   | `/payments`           | پرداخت‌ها و کیف پول     | `payments`     | `'payments.view'`                                                        |
| عملیات   | `/compensations`      | جبران‌های خودکار        | `undo`         | `'payments.view'`                                                        |
| عملیات   | `/tickets`            | تیکت‌های پشتیبانی       | `message`      | `'tickets.view'`                                                         |
| عملیات   | `/bulk-operations`    | عملیات گروهی            | `grid`         | `'bulk_operations.view'`                                                 |
| فروش     | `/products`           | محصولات                 | `products`     | `['catalog.view', 'catalog.edit']`                                       |
| فروش     | `/product-categories` | دسته‌بندی‌ها            | `folder`       | `['catalog.view', 'catalog.edit']`                                       |
| فروش     | `/extra-devices`      | افزایش کاربر / دستگاه   | `userPlus`     | `['catalog.view', 'catalog.edit']`                                       |
| فروش     | `/service-locations`  | تغییر لوکیشن            | `globe`        | `['catalog.view', 'catalog.edit']`                                       |
| فروش     | `/custom-service`     | سرویس دلخواه            | `sliders`      | `'catalog.view'`                                                         |
| فروش     | `/trials`             | سرویس آزمایشی           | `gift`         | `['users.view', 'settings.destructive', 'settings.view', 'panels.view']` |
| فروش     | `/discounts`          | تخفیف‌ها و کش‌بک        | `discounts`    | `'catalog.view'`                                                         |
| فروش     | `/campaigns`          | کمپین‌ها                | `megaphone`    | `'campaigns.view'`                                                       |
| فروش     | `/referrals`          | معرفی و پورسانت         | `link`         | `'referrals.view'`                                                       |
| فروش     | `/reports`            | گزارش‌ها                | `reports`      | `'reports.view'` (Super Admin only)                                      |
| نمایندگی | `/resellers`          | نمایندگان               | `resellers`    | `'resellers.view'`                                                       |
| نمایندگی | `/reseller-tiers`     | سطوح نمایندگی           | `layers`       | `'resellers.view'`                                                       |
| نمایندگی | `/reseller-plans`     | پلن‌ها و حداقل فروش     | `target`       | `'resellers.view'`                                                       |
| زیرساخت  | `/panels`             | پنل‌ها                  | `panels`       | `['panels.view', 'panels.edit']`                                         |
| زیرساخت  | `/providers`          | ارائه‌دهندگان           | `plug`         | `null`                                                                   |
| زیرساخت  | `/bots`               | ربات‌ها                 | `bots`         | `'settings.view'`                                                        |
| زیرساخت  | `/payment-accounts`   | حساب‌های دریافت         | `bank`         | `'payments.accounts.view'`                                               |
| زیرساخت  | `/payment-gateways`   | روش‌های پرداخت          | `wallet`       | `'payments.gateways.view'`                                               |
| ارتباط   | `/broadcasts`         | ارسال همگانی            | `send`         | `'broadcasts.view'`                                                      |
| ارتباط   | `/content`            | متن‌ها                  | `content`      | `'templates.view'`                                                       |
| ارتباط   | `/reminders`          | یادآورها                | `clock`        | `'settings.view'`                                                        |
| ارتباط   | `/support`            | پشتیبانی                | `help`         | `'settings.view'`                                                        |
| ارتباط   | `/client-apps`        | برنامه‌ها و آموزش اتصال | `devices`      | `'client_apps.view'`                                                     |
| پیکربندی | `/settings`           | تنظیمات                 | `settings`     | `'settings.view'`                                                        |
| پیکربندی | `/features`           | قابلیت‌ها               | `toggle`       | `'settings.view'`                                                        |
| پیکربندی | `/bot-buttons`        | دکمه‌های ربات           | `keyboard`     | `'settings.view'`                                                        |
| پیکربندی | `/appearance`         | ظاهر ربات               | `palette`      | `'settings.view'`                                                        |
| سامانه   | `/alerts`             | هشدارهای مدیریتی        | `alertOctagon` | `'opslog.view'`                                                          |
| سامانه   | `/notifications`      | اعلان‌ها                | `bell`         | `['opslog.view', 'settings.edit']`                                       |
| سامانه   | `/ops-group`          | گروه گزارش‌ها           | `radio`        | `'settings.view'`                                                        |
| سامانه   | `/system`             | سامانه و عملیات         | `system`       | `null`                                                                   |
| سامانه   | `/recovery`           | بکاپ و بازیابی          | `database`     | `'backup.view'`                                                          |

Routes served outside the navigation (reached from their list pages):
`/users/:id`, `/products/:id`, `/orders/:id`, `/services/:id`,
`/payments/:id`, `/panels/:id`, `/panels/new`, `/broadcasts/new`,
`/broadcasts/:id`, `/bulk-operations/new`, `/bulk-operations/:id`,
`/tickets/:id`, `/campaigns/new`, `/campaigns/:id`. Panel sub-views
(activation, advanced, trial) and payment timeline, service refund requests,
reseller standing, system diagnostics and administrators are views inside
those pages, not routes. `ROUTE_PATTERNS` in `app.tsx` is the inventory.

Shell behaviour:

- **Sidebar** (right, RTL): 248px, 60px rail when collapsed, animated; own
  scroll; group labels become dividers on the rail and links carry `title`s.
  The collapse is remembered per browser (`localStorage['nexa.sidebar']`) at
  desk width; below 980px it is a rail that opens as a drawer over the page
  (scrim, closes on navigation); below 640px the rail hides and the topbar's
  menu button opens the drawer.
- **Identity card** (top): no contract carries a store or tenant display
  name, so the title is the product name (`web.title`) and the line beneath
  is the environment and service name from `GET /health/info` (session-only,
  fetched once), LTR with Latin digits. Never the host. There is no switcher.
- **Footer**: `v<version> · <commit7>` from the same `/health/info`, the theme
  button, the collapse toggle. On failure nothing is drawn — never a guess.
- **Counters**: `useNavCounters()` (`src/nav-counters.ts`) returns none today;
  the sidebar draws whatever it returns (`{ [navId]: { count, tone? } }`),
  outside the link's accessible name (as its description). DASH wires it to a
  lightweight summary endpoint; never count a page of rows (lead D2).
- **Topbar**: breadcrumbs, the page search (button or Ctrl/Cmd+K) over exactly
  the entries the actor's sidebar shows, and the account menu (name, roles,
  sign-out). No attention chip until DASH has real data for one.
- **Sign-in, session-unavailable, not-found** use the same screen card.
- **Lazy loading**: not introduced. The route table resolves synchronously and
  the inventory test walks it; splitting it is left for the consistency wave.

## 5. Kit API — what page agents use

Import everything from `../ui/kit` (it re-exports overlays, charts, the
unsaved-changes hook and `ConfirmDialog`). Existing exports keep their
signatures; new props are optional.

**Text and values**

- `Ltr({ children, mono = true })` — isolated technical value.
- `Ident({ name, id? })` — name — id, never concatenated.
- `IdentityCell({ name, username?, id?, href? })` — list identity cell: name
  (optionally the row link) over `@username` and id, both LTR.
- `Money({ value: MoneyWire })`, `Num({ value })`, `Duration({ ms })`.
- `Copyable({ value, display? })`, `CopyButton({ value, label? })`,
  `CodeValue({ value, copy = true, wrap = false })`.

**Status**

- `Badge({ tone?, children, title?, dot?, outline?, pulse? })`, tones
  `ok | warn | danger | info | violet | teal | neutral`.
- `StatusDot({ tone?, children })` — the label is required.
- `MaturityBadge({ value })`.

**Actions**

- `Button({ variant?: 'default'|'primary'|'danger'|'danger-solid'|'ghost', size?: 'md'|'sm', icon?, …button props })` — `type` defaults to `button`.
- `IconButton({ icon, label, variant = 'ghost', size?, …})` — `label` is the name.
- `ButtonGroup({ children, segmented?, label? })`.
- Classes still work: `btn`, `primary`, `ghost`, `danger`, `solid`, `sm`, `icon`, `link`.

**Page structure**

- `PageHead({ title, subtitle?, badge?, maturity?, actions? })`.
- `Card({ title?, hint?, actions?, foot?, tone?: 'danger'|'muted', tight?, className?, id?, children })` — `<section class="card">` with an `<h2>`.
- `DetailHead({ title, badge?, meta?, actions?, initial?, stats?: {label, value}[] })`.
- `TwoColumn({ main, side })`; `Timeline({ items: {key, at, title, detail?, tone?}[] })`.
- `StatCard({ label, value, unit?, icon?, delta?: {text, direction: 'good'|'bad'|'neutral', trend?: 'up'|'down', caption?}, hint?, tone?: 'alert'|'warn', children? })`, `AlertStatCard(same)`; `.stat-grid` lays them out.
- `Stat({ label, value, unit?, tone?, hint? })` — a cell inside `.head-stats`.
- `Metric({ label, value })`; `KV`/`DefinitionList({ items, inline? })`.
- `Progress({ value, max, label, tone?, size? })` (number or bigint; tone defaults by ratio), `Meter({ label, used, total, value, max, tone? })`.
- `Banner`/`Callout({ tone?, title?, children?, icon?, role?, action? })`.

**Forms**

- `Field({ label, hint?, error?, htmlFor?, compact?, required?, children })` — `compact` for exact-match inputs in a table toolbar.
- `Input({ size?, …input props })`, `Textarea(…)`, `Select({ size?, children, …})`.
- `Checkbox({ label, checked, onChange, disabled?, name? })`, `Radio({ label, name, value, selected, onChange, disabled? })`.
- `Switch({ checked, onChange, label, disabled?, danger? })`, `ToggleRow({ title, description?, checked, onChange, disabled?, danger? })`.
- `Secret({ label, configured, meta?, onReplace?, onRemove? })` — presence only.
- `ListEditor(…)` unchanged.
- `useUnsavedChanges(dirty: boolean, message?: string)` — see §6.

**Lists**

- `DataTable`/`Table({ columns, rows, rowKey, caption, dense?, sticky?, toolbar?, filters?, rowClassName? })`; `Column { key, header, render, align?: 'start'|'end', wrap? }`. The `<caption>` stays the accessible name; the table never sorts.
- `CellMain({ primary, secondary? })` two-line cell; `RowActions({ children })` in an `align: 'end'` column.
- `FilterBar({ children, hidden? })` (a `.toolbar`), `SearchInput({ value, onChange, label, placeholder?, id?, dir? })`.
- `FilterChips({ children, label? })`, `FilterChip({ pressed, onClick, children, count? })`, `ChipDivider()` — a `count` must be a real server total (D2).
- `CursorPager`/`Pagination({ onPrevious, onNext, hasPrevious, hasNext, shown, nextLabel?, previousLabel? })` — renders `.pager`, keyset only.
- `Distribution({ slices })` unchanged.

**States**

- `StateSwitch({ query, denied?, isEmpty?, empty?, children })` unchanged.
- `Empty`/`EmptyState({ title, hint?, action?, icon?, variant?: 'error'|'denied'|'compact' })`, `Skeleton({ rows?, cols? })` (renders `.skel`), `LoadingState`, `ErrorState({ query })`, `PermissionDeniedState()`.

**Tabs**

- `Tabs({ value, onChange, items: {id, label, count?}[], panelId, vertical? })`, `TabPanel({ id, labelledBy, children })`, `Pills(…)` unchanged.
- `useQueryTab(route, ids, param = 'tab') → [value, set]` and `RoutedTabs({ route, items, panelId, param?, children: (tab) => node })` — lead decision D1: the tab is in `?tab=`, Back/Forward works, only the open panel is mounted (move "X is requested on open" assertions behind opening the tab).

**Period**

- `PeriodControl({ value, onChange, presets?, compare?, onCompareChange?, custom? })`; `PERIOD_PRESETS = ['today','7d','30d','month','custom']`.

**Overlays** (portals into `document.body` — a test asserting one is ABSENT must query `screen`/`document`, not the render container)

- `Modal({ open, onClose, title, children, foot?, size?: 'md'|'lg', danger? })`.
- `Drawer({ open, onClose, title, children, foot?, wide? })`.
- `Menu({ label, trigger, items, triggerClassName?, placement? })`, items `{key, label, icon?, onSelect, danger?, checked?, disabled?}` | `{key, separator: true}` | `{key, heading}`.
- `ConfirmDialog(…)` unchanged; `useFocusTrap(ref, active, onEscape, initial?)`.
- `Toast`: `useToast()({ tone, message })` unchanged.

**Charts** (`ui/charts.tsx`; SVG, token colours via series `tone` 1–6, no style attributes, `null` is a gap, a hidden data table + hover/focus readout on each)

- `ChartCard({ title, hint?, legend?, actions?, children, className? })`, `Legend({ items: {label, tone?, dashed?}[] })`.
- `LineChart({ labels, series: {name, values, tone?, dashed?, area?}[], caption, format?, height? })` — a `dashed` series is the previous-period comparison.
- `BarChart({ labels, series: {name, values, tone?}[], caption, stacked?, format?, height? })`.
- `Donut({ slices: {key, label, value, tone?}[], caption, format?, center? })`.
- `Sparkline({ values, label, tone? })` — nothing from fewer than two points.
- The time axis runs left to right, as the reference draws it; labels and legends stay RTL.
- `TrendChart` (reports) is kept as is.

**Shell hooks**: `useNavCounters()` (`src/nav-counters.ts`), `NAV`/`GROUP_ORDER`/`navPermitted`/`isCurrent` (`src/nav.ts`, re-exported by `app.tsx`).

**Shared page helpers other families already import — keep their signatures**:
`messageFor(error: unknown): string`, `issuesFrom(error: unknown): string[]`,
`ErrorReport({ error })` from `pages/settings.tsx`; `TemplateCard({ template,
mayEdit, onChanged? })` from `pages/content.tsx`.

**Icons**: `Icon({ name, size?, …svg props })`; names in `ICON_NAMES` — every
nav glyph plus `search x menu sun moon monitor filter refresh download upload
external calendar clock activity pause play edit eye more circle shield user
userPlus chevron chevronLeft chevronRight arrowUp arrowDown trendUp trendDown
plus check alert alertOctagon info lock key copy trash inbox tag link send zap
layers message archive logout sidebar`. Add a glyph to `icons.tsx` rather than
importing a library.

## 6. Rules the kit enforces (and page agents must keep)

- **CSP**: `style-src 'self'` blocks `style` attributes in production.
  `tests/web/csp.test.tsx` walks every route. Continuous values are SVG
  attributes (`Progress`, charts, `Distribution`); everything else is a class.
- **RTL**: logical properties only; `dir="ltr"`/`Ltr` only on technical values.
- **Dirty state** (`useUnsavedChanges`): while dirty, `beforeunload` prompts;
  `navigate()` — sidebar, breadcrumb, command search, `useLinkHandler` links —
  to a different PATH is held and `LeaveGuardHost` (mounted by the shell) asks
  via `ConfirmDialog`; a `?tab=` switch through `useQueryTab` is guarded too;
  a same-page filter (`setQuery`) is not. Back/Forward cannot be cancelled
  before it happens, so the page's URL is pushed back and the operator asked;
  confirming visits the destination. With no host mounted nothing is blocked —
  page tests that exercise it mount `<LeaveGuardHost />` beside the page.
  Sign-out forces past the guard.
- **Counts** shown anywhere come from a server total (D2).
- **Portals**: `Modal`, `Drawer`, `ConfirmDialog` render into `document.body`.

## 7. Visual QA — `pnpm web:shots`

```
pnpm web:shots                                   # default set, dark + light, 1440×900
pnpm web:shots /users /panels/<id> --theme dark
pnpm web:shots /settings --width 900 --collapsed
pnpm web:shots / --full --no-build --out <dir>
pnpm web:shots /panels/<id> --click '[role=tab]:nth-child(3)'   # a state reached by clicking
```

It builds `apps/web`, serves `dist` with the production CSP, answers
`/api/admin/v1/*` and `/health/info` from `tests/web/shots/`, and drives
Chromium (`/opt/pw-browsers`, or `NEXA_CHROMIUM`) over the DevTools protocol
with the clock frozen at `SHOT_NOW` and motion reduced. Each shot is reported
(`ok`/`WARN`) with unfixtured requests by name, console errors, a skeleton or
error card still drawn, and page overflow; PNGs and `report.json` go to the
git-ignored `.web-shots/` or `--out`. Keep PNGs out of the repo; list their
paths in your report. Not in `pnpm verify` or CI.

**Adding fixtures for your pages** — edit your family file
`tests/web/shots/fixtures/<family>.ts`:

```ts
import { orderListResponseSchema } from '@nexa/contracts';
import { ago, fixture, type ShotFixture } from '../fixture.ts';

export const COMMERCE_A: readonly ShotFixture[] = [
  fixture('/orders', orderListResponseSchema, { orders: [/* … */], nextCursor: null }),
  fixture('/orders/:id', orderResponseSchema, { order: {/* … */} }),
  fixture(
    '/panels',
    panelListResponseSchema,
    { panels: [], nextCursor: null },
    { query: { archived: 'only' } },
  ),
];
```

`path` is after `/api/admin/v1` (`absolute: true` for `/health/…`), `:name`
matches a segment, `query` constrains parameters (more constraints win, then
more literal segments). Every body is parsed by the schema you name in
`tests/web/shots-fixtures.test.tsx`, so drift fails the web suite. Use only
erasable TypeScript and `.ts` import specifiers (Node loads these files
directly). A `WARN … unfixtured: GET /api/admin/v1/x` line tells you what to add.

Foundation captures (scratchpad, not committed):
`/tmp/claude-0/-home-user-nexa-bot/e4d3bf08-3acd-5e0a-8cdc-f703a5f6773a/scratchpad/found/final/`.

## 8. Page-family ownership

| Agent      | Routes / files                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FOUND      | tokens, theme, font, stylesheet split, `ui/*`, `shell.tsx`, `nav.ts`, `nav-counters.ts` (stub), sign-in, not-found, planned, route inventory test, visual harness                                                                                                                                                                                                              |
| DASH       | `/` (`dashboard.tsx`), dashboard aggregates, the nav-counters endpoint and `useNavCounters`                                                                                                                                                                                                                                                                                    |
| COMMERCE-A | `/users` (+`:id`), `/trials`, `/services` (+`:id`, service-refund-requests), `/orders` (+`:id`), `/payments` (+`:id`, payment-timeline), `/compensations`                                                                                                                                                                                                                      |
| COMMERCE-B | `/products` (+`:id`), `/product-categories`, `/extra-devices`, `/service-locations`, `/custom-service`, `/discounts`, `/campaigns` (+`:id`, `new`), `/broadcasts` (+`:id`, `new`), `/bulk-operations` (+`:id`, `new`), audience-builder, `/referrals`, `/resellers` (+ reseller-standing), `/reseller-tiers`, `/reseller-plans`, `/reports` (`business.tsx`, `report-view.ts`) |
| OPS-A      | `/panels` (+`:id` and panel-activation, panel-advanced, panel-trial, `new`), `/providers`, `/bots`, `/bot-buttons`, `/appearance`, `/payment-gateways` (+ fx-section), `/payment-accounts`, `/client-apps`                                                                                                                                                                     |
| OPS-B      | `/settings`, `/features`, `/reminders`, `/content`, `/support`, `/tickets` (+`:id`), `/ops-group`, `/alerts`, `/notifications`, `/system` (+ system-diagnostics, administrators), `/recovery`                                                                                                                                                                                  |

Each family owns its `styles/pages/<family>.css` and
`tests/web/shots/fixtures/<family>.ts`.

## 9. What this wave did not change

- No page body was rewritten; every page renders inside the new shell with the
  restyled kit. The one test edit to existing suites: sign-out now sits in the
  account menu, so `shell-recovery.test.tsx` opens the menu before choosing it
  (the three assertions are unchanged).
- No backend or contract change. Build identity comes from the existing
  `GET /health/info`.
- `scripts/visual/` (the Playwright-based capture of an earlier round) is left
  in place; `pnpm web:shots` needs no Playwright and supersedes it.
