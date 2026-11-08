# PR-4: before/after inventory — products, categories, custom service, extra packages, locations, trials

Presentation only: every query, mutation, permission prop, confirm dialog, reason field and validation is the page's own, unchanged.
No endpoint added. Kit pieces used: `QuickFilters`, `QuickActionBar`, `AttentionStrip`, `KpiRow`, `CardRows`, `Disclosure`, `PageHead`
(`count`, `onRefresh`), `ListFreshness`. No page here has a time input (no `TimeField24` needed).
Common change: the row's «ویرایش» button became the row's name (a link-style button, `.link strong`, only when the actor may edit); the
action it carried is the same handler. The restating subtitle moved into the fold «دربارهٔ این فهرست» (no text deleted).

## `/products` — `pages/products.tsx` (list)

| Before                                                                                 | After                                                                                   |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Subtitle `products_intro`                                                              | Fold «دربارهٔ این فهرست» under the list                                                 |
| No count / freshness                                                                   | No count chip (keyset pages, no server total); «زمان خواندن» + refresh in the head      |
| Tabs «محصولات جاری / آرشیو» (`view` URL key)                                           | Quick-filter chips, same keys, same server `view`; no counts (no server total per view) |
| Archive intro line, title search, status / audience / category chip filters, clear all | Unchanged                                                                               |
| Columns: title (link) / status / catalogue / audience / volume / price / sort          | status + catalogue merged into one cell; the rest unchanged                             |
| Link to categories, «محصول جدید» (`catalog.edit`) drawer, no-permission card, pager    | Unchanged                                                                               |

## `/products/:id` — `ProductDetailPage`

| Before                                                              | After                                                                                               |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Action panel (move category; activate / deactivate with hint title) | `QuickActionBar`, same buttons, same mutations, group «کاتالوگ»                                     |
| Gap banner (warn)                                                   | Yellow `AttentionStrip` with the same text and title (the info-level «unlisted» gap stays a banner) |
| (none)                                                              | KPI row: price, duration, traffic, device limit (same values the identity card shows)               |
| Edit form and identity card in two independent columns              | `CardRows`: form + identity card, equal height                                                      |
| Technical ids, move drawer, edit form, identity KV                  | Unchanged                                                                                           |

## `/product-categories` — `pages/product-categories.tsx`

| Before                                                                      | After                                                                               |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Subtitle `categories_subtitle` and the muted notes card (inactive / hidden) | One fold «دربارهٔ این فهرست» (subtitle + both notes)                                |
| No count / freshness                                                        | Count chip = the whole list (not paged); freshness + refresh                        |
| (none)                                                                      | Quick-filter chips: all / active / inactive / hidden, counts from the complete list |
| Row «ویرایش» button                                                         | The name opens the edit drawer (same handler and discard guard)                     |
| Activate / deactivate, hide / show, move up / down, delete (+ confirm)      | Unchanged                                                                           |
| Link to products, «دستهٔ جدید», form drawer, category icons section         | Unchanged                                                                           |

## `/custom-service` — `pages/custom-service.tsx`

| Before                                                                                 | After                                                                                                                                        |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Subtitle `custom_service_intro`                                                        | First paragraph of the fold «قاعدهٔ انتخاب قیمت»                                                                                             |
| Specificity card (intro, four levels, four notes)                                      | Same text in that boxed fold                                                                                                                 |
| Feature-flag banner                                                                    | Unchanged                                                                                                                                    |
| (none)                                                                                 | Refresh in the head (re-reads both lists)                                                                                                    |
| Locations: panel, label, status; row «ویرایش» / «ارائه» / delete                       | Label is the edit link (offered rows); «ارائه» stays for panels not yet offered; delete unchanged                                            |
| Rules: dimension, label, range, unit price, audience, panel, status; «ویرایش» / delete | dimension + label merged (label is the edit link, dimension badge under it); audience + panel merged; range, price, status, delete unchanged |
| Location and rule drawers, deletes with confirm                                        | Unchanged                                                                                                                                    |

## `/extra-devices` — `pages/extra-packages.tsx`, `pages/extra-devices.tsx`

| Before                                                                                    | After                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Head subtitle (per tab)                                                                   | Title only; the same sentence is in the fold «دربارهٔ این فهرست» under the tab panel |
| Tabs traffic / time / devices                                                             | Unchanged (three kinds of one catalogue, not filter chips)                           |
| Toolbar: scope note + «افزودن»                                                            | + freshness / refresh                                                                |
| Row «ویرایش» button                                                                       | The title opens the edit drawer                                                      |
| Enable / disable, price, amount, sort, state + inactive warning, updated, pagers, drawers | Unchanged                                                                            |
| Standalone (non-embedded) devices page                                                    | Same changes; subtitle in the fold, add + freshness in the head                      |

## `/service-locations` — `pages/service-locations.tsx`

| Before                                                                          | After                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------ |
| Subtitle `service_locations_subtitle`                                           | Fold «دربارهٔ این فهرست»                         |
| No count / freshness                                                            | Count chip = the whole list; freshness + refresh |
| (none)                                                                          | Quick-filter chips all / on / off with counts    |
| Row «ویرایش» button                                                             | The label opens the edit drawer                  |
| Delete (+ confirm, in-use refusal), capable-panels banner, columns, form drawer | Unchanged                                        |

## `/trials` — `pages/trials.tsx`

| Before                                                                                         | After                                                                                          |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| No freshness                                                                                   | Freshness + refresh (the panels read) beside the reset button                                  |
| Panel list unfiltered                                                                          | Quick-filter chips all / offered / not offered / disabled, counts over the complete panel list |
| Overrides list, reset drawer (preview, typed count, reason), history, per-section denied notes | Unchanged                                                                                      |

## Money

`/products` (price shown, price field in the form), `/custom-service` (unit price per rule), `/extra-devices` (rate / package prices) and
`/service-locations` (location price) edit catalogue prices through their own forms; none of those forms was touched. No discount value, wallet
credit, gift-card balance or refund lives here. `/trials` has the destructive global reset (`executeTrialReset`, `settings.destructive`),
unchanged.
