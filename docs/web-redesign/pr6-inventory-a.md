# PR-6 (part a): before/after inventory — resellers, tiers, plans

Presentation only: every query, mutation, permission prop, confirm dialog, reason field, validation and idempotency key is the
page's own, unchanged. No endpoint was added. Kit pieces used: `QuickFilters`, `Disclosure`, `ListFreshness`. No count chip is
drawn on any list here: `GET /resellers` returns a cursor page and `GET /reseller-tiers` the whole roster, neither a server total.

**Reseller detail.** The app has no `/resellers/:id` route: a reseller's standing is the wide drawer of `/resellers`
(`ResellerStandingView` in `reseller-edit.tsx`: summary head, six tabs, credit, minimum, expiry, products, danger zone with the
reason dialogs). It already has the demo's header card + KPI figures + grouped tabs, and its money actions (credit, minimum
override, suspend, tier change) are left byte-for-byte as they were. Only the way into it changed (the name, below). Decision: not
turned into a new page, because that would move money actions and their confirms.

## `/resellers` — `pages/resellers.tsx`

| Before                                                                                                          | After                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subtitle `resellers_intro`; card title `resellers_list_title` + hint `resellers_list_hint`                      | Fold «قاعده‌هایی که این صفحه رعایت می‌کند» under the head holding the intro, the hint, the three rules and the tiers / plans links; table keeps its caption                       |
| Bottom muted card with the three rules and the two links (`resellers-foot`)                                     | Moved into the same fold (no text deleted); the dead `.resellers-foot` CSS removed                                                                                                |
| Head actions: «سطوح نمایندگی», «پلن‌ها…», «ثبت نماینده» (`resellers.edit`, asks before discarding an open form) | Same buttons, same guards; «زمان خواندن» + refresh (`ListFreshness`) added in front                                                                                               |
| Status chips (همه / فعال / معلق) inside the «فیلترها» panel                                                     | `QuickFilters` over the table (same `status` state and request param); group label is the new key `reseller_status_filter` (the plain «وضعیت» clashed with the edit form's label) |
| Search box (debounced apply, apply / clear) and tier select in `ListFilterBar`                                  | Unchanged (tier select stays in the panel)                                                                                                                                        |
| Name linked to the customer page `/users/:id`                                                                   | The name is a link-styled button that opens the standing drawer (same unsaved-edit guard); the customer page is a row link «صفحهٔ مشتری» (`reseller_customer_page`)               |
| «وضعیت» (eye) row button                                                                                        | Removed as a column button: the name opens the same drawer                                                                                                                        |
| «ویرایش» row button (`resellers.edit`)                                                                          | Unchanged                                                                                                                                                                         |
| Columns reseller / tier / status / pricing / actions                                                            | + «پایان نمایندگی» (`row.expiresAt`, already sent; the standing summary shows the same value)                                                                                     |
| Standing drawer, register dialog, edit-denied card, empty / filtered-empty / denied states, cursor pager        | Unchanged                                                                                                                                                                         |

## `/reseller-tiers` — `pages/reseller-tiers.tsx`

| Before                                                                                        | After                                                                                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Subtitle `reseller_tiers_intro`; list card title + hint                                       | Fold «قاعده‌هایی که این صفحه رعایت می‌کند» with the intro, the hint, the four rules and the resellers link          |
| Rules card beside the create form (`grid-2 tiers-foot`)                                       | Rules moved into the fold; the create form (`resellers.edit`) or the denied banner now stands alone below the table |
| Head links «نمایندگان», «پلن‌ها»                                                              | Same; «زمان خواندن» + refresh added                                                                                 |
| Name (plain text)                                                                             | Link-styled button: opens the edit drawer (`resellers.edit`), or the read-only grants drawer without the key        |
| Row buttons edit / grants / product prices (tier prices) / history; their drawers and dialogs | Unchanged                                                                                                           |
| Columns, pager, empty and denied states                                                       | Unchanged                                                                                                           |

## `/reseller-plans` — `pages/reseller-plans.tsx`

| Before                                                                                                         | After                                                               |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Subtitle `reseller_plans_intro`                                                                                | Fold «حداقل فروش ماهانه چگونه حساب می‌شود» holding the intro        |
| Bottom muted rules card (five minimum rules + links to features, settings, resellers)                          | Moved into the same fold, no text deleted                           |
| Head links, none freshness                                                                                     | Same links; «زمان خواندن» + refresh added                           |
| Name (plain text)                                                                                              | Link-styled button opening the tier's products / permissions drawer |
| Row buttons «محصولات» and «حداقل» (`resellers.edit`), grants and minimum drawers, progress card, policy drawer | Unchanged                                                           |
| Tiers card title + hint, pricing note, pager, empty / denied states                                            | Unchanged                                                           |

## Tests

Structure assertions updated, none weakened: the status chip is now a quick filter, the standing opens from the name, the customer
page link is its own link, the tier / plan name is a button. Added: the tier name opens the edit drawer.
