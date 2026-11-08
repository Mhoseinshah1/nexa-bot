# PR-8 (c): before/after inventory — «رخدادها و نگهداری»

Presentation only: every query (`['incidents', cursor]`, `['incident', id]`, the notice preview, the target pickers),
mutation (create, edit, start, resolve, cancel, apply effects, notice), permission prop (`incidents.view`,
`incidents.manage`, `incidents.notify`, `panels.view`), confirm dialog, version check and idempotency key is the page's
own, unchanged. No endpoint was added and no API code changed. Kit pieces used: `PageHead`, `ListFreshness`,
`Disclosure`, `Drawer`, `ActionPanel` (unchanged). No count chip and no quick-filter chips: `GET /incidents` returns
neither a total nor a status filter, and a count or filter over one loaded page would be a client-side figure.

## The «view» report (brief §2.5)

Not reproducible on this head. Every way in — the list's title link, the banner's «جزئیات», the inbox's «مشاهده» — reads
`GET /incidents/:id` with the row's own id, and that answers 200 for every listed incident (active, scheduled,
resolved, stop-sales), parsed by the client's own schema: `tests/integration/incidents-http.test.ts`, over HTTP. The
list now opens the incident in a drawer that reads it by its own id (never looks it up among the loaded rows), pinned by
`tests/web/incidents.test.tsx` «the incident side drawer», including a row on an older page.

## `/incidents` — `pages/incidents.tsx` `IncidentsPage`

| Before                                                                        | After                                                                                                                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Subtitle `inc_subtitle`                                                       | Fold «دربارهٔ این صفحه» under the list, same text                                                                                           |
| (none)                                                                        | «زمان خواندن» + refresh (`ListFreshness`) in the head's actions row; one muted hint «برای دیدن جزئیات، روی عنوان رخداد بزنید.»              |
| «رخداد تازه» (`incidents.manage`) → form modal → navigates to the detail page | Same button, same modal and request; on save the new incident opens in the drawer                                                           |
| Title link → `/incidents/:id` (full page)                                     | Same link and `href` (new tab / copied address reach the full page); a plain click opens the side drawer; the open row is marked `selected` |
| Columns title, kind, severity, status, when, scope (count + «توقف فروش»)      | Unchanged                                                                                                                                   |
| Keyset pager «تازه‌تر / قدیمی‌تر», empty state, denied state (no request)     | Unchanged                                                                                                                                   |

## The drawer and `/incidents/:id` — `IncidentDetail` (one body for both)

| Before (detail page)                                                                                        | After                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Page head: title + subtitle «kind · severity»                                                               | Page: title only; drawer: the title in the drawer's head. Both: chips row status / severity / kind; in the drawer a «صفحهٔ کامل رخداد» link |
| Money note banner (ACTIVE + stop sales), apply error banner                                                 | Unchanged, both places                                                                                                                      |
| Action groups «رخداد» (edit, start, resolve), «فروش و مشتریان» (apply effects, notice), sensitive «لغو»     | Unchanged (`ActionPanel`), same permission keys, in the page and the drawer; their dialogs open above the drawer                            |
| Summary card (status, schedule, started, resolved, stop sales, admin banner, description, customer message) | Unchanged; in the drawer the summary and side cards stack in one column                                                                     |
| Scope card (targets by panel name with `panels.view`, effects table), timeline                              | Unchanged                                                                                                                                   |
| Edit / action / notice modals, version-conflict refill, previewed-count notice                              | Unchanged                                                                                                                                   |
| Admin banner above every page, «جزئیات» → full page (`incidents.view`)                                      | Unchanged                                                                                                                                   |
