# Redesign kit (PR-0)

The shared patterns of the approved Web Admin redesign (`NEXA-WEB-REDESIGN`). Presentation only: a page keeps its own hooks,
permissions, mutations and confirm dialogs and passes its own buttons in.

| Pattern                                                                                       | Where                                                                |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Page head: title + count chip, freshness + refresh + actions in one row                       | `PageHead` props `count`, `freshness`, `onRefresh` (`ui/kit.tsx`)    |
| Quick-filter chips with (server) counts                                                       | `QuickFilters` (`ui/redesign.tsx`)                                   |
| Selection bar, only while rows are ticked                                                     | `SelectionBar`                                                       |
| Grouped quick-action bar; danger red and «…»; disabled reason on hover                        | `QuickActionBar`, `QuickAction`                                      |
| Yellow / red attention strip                                                                  | `AttentionStrip`                                                     |
| KPI row                                                                                       | `KpiRow`                                                             |
| Cards side by side, equal height, row by row                                                  | `CardRows`                                                           |
| Settings: collapsible sections, setting rows, one sticky save bar                             | `SettingsSection`, `SettingRow`, `SwitchSettingRow`, `StickySaveBar` |
| Side drawer                                                                                   | `Drawer` (`ui/overlays.tsx`, existing)                               |
| Persian 24-hour time picker (5-minute steps, Persian digits, day part)                        | `TimeField24` (`ui/time-field24.tsx`)                                |
| Layout drag and drop (pointer + keyboard): item, row end, between rows, «ردیف تازه», free box | `LayoutDnd`, `moveItem`, `keyboardMove` (`ui/layout-dnd.tsx`)        |

Styles: `styles/redesign-kit.css` (tokens only). Strings: `i18n/web.fa/redesign-kit.ts`. Tests: `tests/web/redesign-kit.test.tsx`.

Chip tones: ok / warn / danger / info / neutral already have dark and light values in `tokens.css` (`--*-soft` pairs, AA pinned by
`tests/unit/web-token-contrast.test.ts`); no hard-coded colour was added.
