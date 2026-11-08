# PR-9 sweep, part A — before / after

| Item | Before | After |
| --- | --- | --- |
| Page-head subtitle, create pages (`/broadcasts/new`, `/bulk-operations/new`, `/campaigns/new`) | the list page's intro repeated under the title | no subtitle; the same text stays in the list page's «دربارهٔ این صفحه» fold |
| Page-head subtitle, settings, bot buttons, notification centre | long intro under the title | `Disclosure` «دربارهٔ این صفحه» under the head, same text (new fold keys `web.settings_about_fold`, `web.bot_buttons_about_fold`, `web.nc_about_fold`) |
| Subtitles kept (single informative lines) | recovery, hosting, account, features, reseller requests, new panel, planned pages, detail pages' meta lines | unchanged |
| `QuickActionBar` | a group whose only action was a fragment of absent actions was drawn empty (campaign detail, finished campaign: empty «مدیریت کمپین») | `drawnActions` opens arrays and fragments; an empty group is not drawn; two new tests |
| Dead components removed | `SectionTabs`, `SectionNavItem`, `AttentionList`/`AttentionClear` (file), `BalancedColumns`, `ClientPager`, `AlertStatCard`, `Callout`, `EmptyState`, `LoadingState`, `SwitchSettingRow`, kit `Pagination`/`Table` aliases, `PeriodControl`, `CodeValue`, `auditLogFirstScreen`, `EMPTY_ACTIVATION_DRAFT`, `PERIOD_LABEL` | removed with the tests that covered only them |
| Dead CSS | 60 classes with no use in src or tests (list in the commit) | rules removed; shared selector lists keep their live members |
| i18n | `pnpm check:i18n`: every key rendered | unchanged |
