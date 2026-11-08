# PR-5: before/after inventory — the marketing group

Presentation only: every query, mutation, permission prop, confirm dialog, reason field, validation and idempotency key is the
page's own, unchanged. No endpoint was added. Kit pieces used: `QuickFilters`, `QuickActionBar`, `AttentionStrip`, `KpiRow`,
`CardRows`, `Disclosure`, `Tabs`, `ListFreshness`, `TimeField24`. No count chip is drawn on any list here: none of these
endpoints returns a server total.

## `/gift-cards` — `pages/gift-cards.tsx`

| Before                                                                                                                      | After                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subtitle `gift_cards_intro`                                                                                                 | Fold «دربارهٔ این فهرست» under the table (intro and the list hint, no text deleted)                                                                                   |
| «ساخت دستهٔ کارت هدیه» (`gift_cards.create`, disabled when feature off / no currency)                                       | Same button, same dialog and request, in the head's actions row                                                                                                       |
| (none)                                                                                                                      | «زمان خواندن» + refresh (`ListFreshness`)                                                                                                                             |
| Feature-off banner, "batch created" banner with the CSV download                                                            | Unchanged                                                                                                                                                             |
| Card hint `gift_cards_list_hint`                                                                                            | Inside the fold                                                                                                                                                       |
| Columns (label, amount, count, redeemed, remaining, credited, expiry, state, actions)                                       | Unchanged; download (`gift_cards.export`) and «غیرفعال‌سازی…» (`gift_cards.disable`, counted dry run, reason, confirm) stay in the row, as a batch has no detail page |
| Create dialog (label, amount, count, expiry, per-customer limit, reason, face-total banner, typed count) and disable dialog | Unchanged                                                                                                                                                             |

## `/discounts` — `pages/discounts.tsx`

| Before                                                                                                                                               | After                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subtitle `discounts_intro`; bottom muted card «قاعده‌هایی که این صفحه رعایت می‌کند» (3 notes)                                                        | One fold under the head, same title, holding the intro and the three notes                                                                                                                                                 |
| «کمپین‌ها» link                                                                                                                                      | Same link, head actions                                                                                                                                                                                                    |
| Three cards stacked: discount rules, cashback rules, price preview                                                                                   | Three tabs (`Tabs`): قاعده‌های تخفیف / قاعده‌های کش‌بک / پیش‌نمایش قیمت. All three stay mounted (a closed one is `hidden`), so an open drawer draft, a filter and a cursor survive a tab switch; the queries run as before |
| Rule name (plain text)                                                                                                                               | The name is the way in: a link-styled button opening the same edit drawer (read-only text without the edit key). The pencil and activate / deactivate stay in the row                                                      |
| Kind / status filter chips (`ListFilterBar`), «افزودن» button, tables, pagers, create/edit drawers, no-edit-key banners, `catalog.view` denied state | Unchanged                                                                                                                                                                                                                  |
| Price preview form and result (`PricePreview`)                                                                                                       | Unchanged, in its own tab                                                                                                                                                                                                  |

## `/campaigns` — `pages/campaigns.tsx`

| Before                                                                          | After                                                                                                      |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Subtitle `campaigns_intro` + info banner «کمپین چه کاری می‌کند…» (3 paragraphs) | One fold «دربارهٔ کمپین‌ها و قاعده‌ها» holding the intro and the three paragraphs                          |
| «تخفیف‌ها» and «کمپین تازه» (`campaigns.manage`)                                | Same, head actions, next to freshness + refresh                                                            |
| State filter: chips inside the filter panel (`state` URL param)                 | Quick-filter chips over the table (same `state` param, no counts); «همه» clears it                         |
| Columns name / status / window / actions (kinds) / confirmed audience           | name (link; the kinds of action under it, header «اقدام‌ها» merged) / status / window / confirmed audience |
| Pager, empty and denied states                                                  | Unchanged                                                                                                  |
| New campaign page                                                               | Unchanged                                                                                                  |

### `/campaigns/:id` — `CampaignDetailPage`

| Before                                                                                                      | After                                                                                          |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Head buttons: «ویرایش» (draft), preview/confirm (draft), pause / resume / launch pending / cancel (confirm) | Grouped action bar «مدیریت کمپین» with the same buttons, conditions, titles and cancel confirm |
| (none)                                                                                                      | Yellow strip while a live campaign has actions still PENDING or FAILED                         |
| (none)                                                                                                      | Key-figure row: confirmed audience, number of actions                                          |
| Frozen-note line, edit form, confirm drawer                                                                 | Unchanged                                                                                      |
| Two independent columns (actions + results / summary)                                                       | `CardRows`: actions beside the summary (equal height), results in a row of its own             |
| Campaign edit window times (`type=time`-style `DateField`)                                                  | `TimeField24` (same `HH:MM` value, same state, same validation)                                |

## `/broadcasts` — `pages/broadcasts.tsx`

| Before                                                                | After                                                                                                |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Subtitle `bc_page_intro`                                              | Fold «دربارهٔ این فهرست» under the table                                                             |
| «ارسال جدید» (`broadcasts.send`)                                      | Same, with freshness + refresh                                                                       |
| Columns title (link) / state / kind / recipients / progress / created | title (link; the kind badge under it, header «نوع» merged) / state / recipients / progress / created |

### `/broadcasts/:id` — `BroadcastDetailPage`

| Before                                                                                    | After                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Head: title, state badge, kind and purpose line                                           | Unchanged                                                                                                                             |
| (none)                                                                                    | After the draft stage: yellow strip (paused; failed recipients with their count) and a key-figure row (recipients, progress, started) |
| Report card: counts, progress, pause / resume / retry failed / cancel with their confirms | Unchanged (same mutations, confirms and error banner)                                                                                 |
| Two independent columns                                                                   | `CardRows`: report beside the summary, per-bot split beside the history, failures, recipients                                         |
| Recipients: state `<select>` in the filter panel                                          | Quick-filter chips (same `state` request param, «همه» first, no counts)                                                               |
| Draft: composer, media, launch card (count, test, launch), summary, history               | Unchanged                                                                                                                             |

## `/reminders` — `pages/reminders.tsx`

| Before                                                                                            | After                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subtitle `reminders_intro`                                                                        | Fold «دربارهٔ این صفحه»                                                                                                                                 |
| (none)                                                                                            | «زمان خواندن» + refresh; the unsaved-count badge stays beside the title                                                                                 |
| Five family cards with main switch, summary, «پیکربندی» and «متن‌ها» sheets, every row's own save | Unchanged                                                                                                                                               |
| Quiet-hours start / end: `DateField mode="time"`                                                  | `TimeField24` (hour 00-23, minutes in 5 steps, Persian digits, day part; value is still `HH:MM`, the same `QUIET_HOURS_TIME_PATTERN` check and request) |

## `/referrals` — `pages/referrals.tsx`

| Before                                                                                                                                          | After                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Subtitle `referrals_intro`; bottom muted card «قاعده‌هایی که این صفحه رعایت می‌کند»                                                             | One fold under the head, same title, holding the intro and the three notes |
| Referrer-id filter (debounced apply, «اعمال», clear), analytics (owner), attributions, commissions ledger with its row detail, unrecovered note | Unchanged                                                                  |
| Commission state chips inside the filter panel                                                                                                  | Quick-filter chips over the ledger (same state request, no counts)         |
| Banner card (`settings.view` / edit) beside the notes card in a grid                                                                            | Banner card on its own row (the notes moved to the fold)                   |
