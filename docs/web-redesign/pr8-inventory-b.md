# PR-8 (b): before/after inventory — System, Bulk operations, Recovery

Presentation only: every query, mutation, permission prop, confirm dialog, reason field, validation and idempotency key is
the page's own, unchanged. No endpoint was added.

## `/audit-log` becomes the «تاریخچهٔ تغییرات» tab of `/system`

| Before                                                                                   | After                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Own page, sidebar entry «گزارش ممیزی» (`audit.view`), `NAV_PREFETCH` entry               | Sixth tab of «سامانه» (`?section=audit`); sidebar entry and its (dead) prefetch entry removed                                                                                      |
| Old path `/audit-log?…`                                                                  | Redirects (replace) to `/system?section=audit&…`, every filter param kept; the Customer 360 link therefore still lands scoped, the Mirza link points at the tab directly           |
| Permission `audit.view` (denied card, no request without it); export `audit.export`      | Identical: the tab passes `denied={!audit.view}` and `mayExport={audit.export}`; the System page itself stays open to every admin and the other tabs keep their own keys           |
| Page head with title, intro subtitle, CSV export                                         | No second title (the tab is the title); a toolbar with «زمان خواندن» + refresh and the CSV export (same URL, same filters); the intro moves to the fold «دربارهٔ تاریخچهٔ تغییرات» |
| Filters (typed grid, security/actor/result chips), table, pager, no-secrets note, export | Unchanged                                                                                                                                                                          |

## `/system`

| Before                                                                            | After                                                                                    |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Subtitle `system_intro` + version/environment line                                | Version and environment as chips in the head actions; intro in a fold «دربارهٔ این صفحه» |
| Status tab                                                                        | + «زمان خواندن» and refresh on the readiness read; cards and dependency table unchanged  |
| Tabs status / diagnostics / monitor / admins / roles, the «logs» destination card | Same, plus the audit tab; the logs card is unchanged                                     |

## `/bulk-operations`

| Before                                                     | After                                                                            |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Subtitle `bulk_page_intro`                                 | Fold «دربارهٔ عملیات گروهی» under the table holding the same text                |
| (none)                                                     | «زمان خواندن» + refresh next to «عملیات تازه» (`bulk_operations.run`, unchanged) |
| Table, state badges, progress, pager, new and detail pages | Unchanged. No count chip: the API returns no total                               |

## `/recovery`

| Before                                                                                                          | After                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| On `recovery.candidate_secrets_unreadable` the kit import was only in the separate «کیت بازیابی» card higher up | The same `ImportForm` (same mutation, file/passphrase/account password/step-up code, idempotency key) is mounted inside the choice card «بارگذاری کیت بازیابی سرور قبلی», above «آزمون دوباره»; drawn with `recovery.kit.import`, otherwise the existing no-permission banner. The kit card and its dialog stay |
| Archive password field «رمز فایل 7-Zip»                                                                         | «رمز فایل بکاپ (همان رمزی که بکاپ با آن گرفته شده)» (`web.secret_unreadable_archive_password_label`); the kit hint now says the kit password is separate                                                                                                                                                        |
| Retest, «ادامه؛ این‌ها را دوباره وارد می‌کنم», confirm dialog, refund-card rule                                 | Unchanged                                                                                                                                                                                                                                                                                                       |
