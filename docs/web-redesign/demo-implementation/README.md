# Web Admin — approved demo implementation: screenshots

Captured from the production build of `feat/web-admin-demo-implementation`, served with the
production CSP against the fixture API (`tests/web/shots/`), clock frozen at `SHOT_NOW`, by the
same Chromium/CDP harness as `pnpm web:shots`. 1440×900 (dark and light) and 390×844 (dark,
touch). JPEG, to keep the repository light; `pnpm web:sweep --shots` regenerates PNGs of every
route in all three views into `.web-shots/sweep/` (git-ignored).

| Screen                                                                                  | Files                     |
| --------------------------------------------------------------------------------------- | ------------------------- |
| Users list: compact filter line, saved filters                                          | `users.*`                 |
| Users list: «فیلترها» panel open (bottom sheet on a phone)                              | `users-filters.*`         |
| Customer 360: nine tabs, action panel                                                   | `customer-360.*`          |
| Service detail: grouped action panel, sensitive strip, folded «چرا N دکمه غیرفعال است؟» | `service.*`               |
| Order detail: balanced columns, tail full width                                         | `order.*`                 |
| Payments list and payment detail                                                        | `payments.*`, `payment.*` |
| Bulk operation: the shared condition-list audience builder                              | `bulk-new-audience.*`     |
| Campaign editor: tabs with unsaved dots                                                 | `campaign-new-tabs.*`     |
| Bot buttons: builder with the three-column editor under the preview                     | `bot-buttons.*`           |
| Settings: tabs with unsaved dots                                                        | `settings-tabs.*`         |
| Tickets list                                                                            | `tickets.*`               |
| Incident detail: summary beside scope and history, action panel                         | `incident.*`              |
| Product detail: tabs                                                                    | `product.*`               |
| Audit log: Jalali date field open inside the filter panel                               | `audit-log-datefield.*`   |
| System: build info without the commit row                                               | `system.*`                |
| Discounts                                                                               | `discounts.*`             |
