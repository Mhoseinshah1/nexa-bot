# PR-7 (part A): before/after inventory — panels, panel detail, panel health, providers

Presentation only: every query, mutation, permission prop, confirm dialog, reason field, validation and idempotency key is the
page's own, unchanged. No endpoint was added (the Overview reads the existing `/advanced` endpoint the capabilities tab already
uses). Kit pieces used: `QuickFilters`, `QuickActionBar`/`QuickAction`, `AttentionStrip`, `KpiRow`, `CardRows`, `Disclosure`,
`ListFreshness`. No count chip is drawn on any list here: none of these endpoints returns a server total.

## `/panels` — `PanelsPage`

| Before                                                                          | After                                                                                                                  |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Subtitle `panels_intro`                                                         | Fold «دربارهٔ این فهرست» under the head (same text)                                                                    |
| «پنل تازه» (`mayEdit`)                                                          | Same button, head actions, next to freshness + refresh (new)                                                           |
| Live / archived chips in a filter bar (`archived=only` URL param)               | `QuickFilters` chips over the table, same param and query keys; not drawn while the list cannot be read                |
| Provider: type badge + the probe's version beside it                            | Provider NAME only (owner decision); the version is no longer drawn on the list (it stays in Diagnostics / Health tab) |
| Separate columns «سلامت» and «نوع خطا»                                          | One cell: health badge (+ stale badge), the failure kind badge (short pill, sentence as title) under it                |
| Separate columns «آخرین بررسی» and «تأخیر»                                      | One cell: last check, latency under it, so the table fits at 1440 without sideways scroll                              |
| Name (link) + host, capacity, status + sellability verdict, pager, empty states | Unchanged                                                                                                              |

## `/panels/:id` — `PanelDetailPage`

| Before                                                                                                                               | After                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Head buttons: «تست اتصال» (same conditions) and the lifecycle buttons (disable / enable / archive / restore)                         | Grouped quick-action bar: «بررسی» (test) and «چرخهٔ عمر پنل» (lifecycle). Archive is red and ends in «…» (the same confirm modal, restore rename drawer, idempotency keys). The disable button keeps its hint title                                       |
| (none)                                                                                                                               | Freshness + refresh in the head                                                                                                                                                                                                                           |
| Banners: last failure (+ «سلامت» button), stale, draining                                                                            | Attention strips with the same text and button (red/yellow by retryability)                                                                                                                                                                               |
| Six stat cards                                                                                                                       | `KpiRow`: health (+ check time), latency, last healthy, sellable (+ reason), capacity, services                                                                                                                                                           |
| Overview in two independent columns                                                                                                  | `CardRows`: configuration form beside identity / sellability / capacity (equal height). The form, its draft, unsaved-changes guard and save are unchanged                                                                                                 |
| Provider configuration: Marzban protocols + tags; 3X-UI domain + inbound; custom timeout; RickPanel fell through to the 3X-UI fields | Marzban / 3X-UI unchanged. RickPanel and the custom bridge: no protocol / domain / inbound inputs; a read-only rules block (`prule_*`: protocols, inbounds, subscription link) from the existing advanced read; the custom bridge keeps its timeout field |
| Sellability card: «وضعیت پیکربندی» row and the missing-fields warning for every provider                                             | Shown only for providers that need operator activation (Marzban, 3X-UI); RickPanel / custom get neither the row nor the «پیکربندی ناقص» warning                                                                                                           |
| Tabs (workload, health, credentials, capabilities incl. rules card, trial, delivery tutorial, connection files)                      | Unchanged. The capabilities tab still holds the full rules card; «توضیح فایل‌های اتصال» (connection-files tab) untouched and complete                                                                                                                     |
| Credential form: fields by the provider's credential shape                                                                           | Unchanged (it already follows `credentialShape`; only fields the shape accepts, plus stored-but-unusable ones, are drawn)                                                                                                                                 |

## `/panel-health` — `PanelHealthPage`

| Before                                                                                         | After                                                                |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Subtitle `ph_subtitle` and note `ph_page_note`                                                 | Fold «دربارهٔ سلامت پنل‌ها» holding both texts                       |
| Summary stat cards (groups + draining)                                                         | `KpiRow` with the same figures (group label kept for assistive tech) |
| (none)                                                                                         | Freshness + refresh                                                  |
| Per-panel cards, probe, services link, drain dialog, balancing-group dialog, conditions, pager | Unchanged                                                            |

## `/providers` — `ProvidersPage`

| Before                                                             | After                                                          |
| ------------------------------------------------------------------ | -------------------------------------------------------------- |
| Subtitle `providers_intro` + info banner                           | Fold «دربارهٔ ارائه‌دهنده‌ها» holding the intro and the banner |
| (none)                                                             | Freshness + refresh                                            |
| Table: provider, credential shape, capabilities, activation fields | Unchanged                                                      |
