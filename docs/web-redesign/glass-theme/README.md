# Liquid Glass «mono» — the real Web Admin beside the approved demo

Evidence for the theme the owner approved on 2026-10-18
(`.claude/skills/nexa-web-design/references/redesign-status.md`). Each image is one view,
taken on the same day: **left**, the production build of `apps/web` on this branch against
the fixture API (`pnpm web:shots`, clock frozen); **right**, the approved demo
`nexa-admin-demo-polish.html` with the «mono» palette. Both are at the same width, scaled to half
(1440) or three quarters (390). The demo itself stays outside the repository.

The two sides show different sample data. The app shows its fixtures and the demo shows its
own invented rows. Compare the design (glass shell, capsule controls, mono palette, coloured
charts), not the figures.

| Screen                        | App route                              | Demo route                     | 1440 dark                                | 1440 light                                 | 390 dark                                    |
| ----------------------------- | -------------------------------------- | ------------------------------ | ---------------------------------------- | ------------------------------------------ | ------------------------------------------- |
| Users list, filter panel open | `/users` + `.lfb-open`                 | `#/users` + filters            | [dark](users-filters--1440-dark.jpg)     | [light](users-filters--1440-light.jpg)     | [390 dark](users-filters--390-dark.jpg)     |
| Customer 360                  | `/users/:id`                           | `#/users/584332434`            | [dark](customer-360--1440-dark.jpg)      | [light](customer-360--1440-light.jpg)      | [390 dark](customer-360--390-dark.jpg)      |
| Service detail                | `/services/:id`                        | `#/services/SV-1084`           | [dark](service-detail--1440-dark.jpg)    | [light](service-detail--1440-light.jpg)    | [390 dark](service-detail--390-dark.jpg)    |
| Payments                      | `/payments`                            | `#/payments`                   | [dark](payments--1440-dark.jpg)          | [light](payments--1440-light.jpg)          | [390 dark](payments--390-dark.jpg)          |
| Bulk operation audience       | `/bulk-operations/new`                 | `#/bulk-operations` → new      | [dark](bulk-audience--1440-dark.jpg)     | [light](bulk-audience--1440-light.jpg)     | [390 dark](bulk-audience--390-dark.jpg)     |
| Bot buttons                   | `/bot-buttons`                         | `#/bot-buttons`                | [dark](bot-buttons--1440-dark.jpg)       | [light](bot-buttons--1440-light.jpg)       | [390 dark](bot-buttons--390-dark.jpg)       |
| Settings                      | `/settings`                            | `#/settings`                   | [dark](settings--1440-dark.jpg)          | [light](settings--1440-light.jpg)          | [390 dark](settings--390-dark.jpg)          |
| Audit log date picker         | `/audit-log` + filters + `#audit-from` | `#/audit-log` + filters + date | [dark](audit-date-picker--1440-dark.jpg) | [light](audit-date-picker--1440-light.jpg) | [390 dark](audit-date-picker--390-dark.jpg) |
| Dashboard                     | `/`                                    | `#/dashboard`                  | [dark](dashboard--1440-dark.jpg)         | [light](dashboard--1440-light.jpg)         | [390 dark](dashboard--390-dark.jpg)         |

What the demo shows that the app deliberately does not draw (see "Not carried over" in the
approval record):

- The demo's state bar («نمایش حالت‌ها»), its «دادهٔ نمونه» badges, and its palette and
  identity switchers.
- The phone's bottom-navigation capsule. The app has no bottom navigation, and adding one
  would be a new navigation surface rather than a restyle. Navigation on a phone stays the
  menu button and the floating sidebar sheet.
- The incident banner at the top of the demo. It is the demo's sample incident; the app draws
  the same banner only when a real incident asks to be seen.
