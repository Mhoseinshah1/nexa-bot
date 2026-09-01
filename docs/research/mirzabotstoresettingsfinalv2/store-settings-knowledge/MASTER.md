# MASTER — MirzaBot Store Settings Phase (AUTHORITATIVE)

> This file is the authoritative index for the Store phase. If any other file in this folder
> disagrees with it, **this file wins**. Read it before anything else.

## PHASE_STATUS

**PARTIAL — actively worked, not complete.** Everything safely reachable through the Telegram admin bot
has been investigated. What remains needs either an explicit risky test authorised by the owner or a
capability this phase does not have. Do **not** restart this phase; continue from the gaps listed below.

## CURRENT_FINAL_REPORT

`store-settings-investigation-report.md` (repo root, one level above this folder), with
`store-completeness-matrix.md` as its status matrix.

## COMPLETED_AREAS

Store menu · 16 store capability toggles · all 3 global store settings · category system (add/edit) ·
product creation wizard · all 18 product-edit fields enumerated, 15 individually tested (inbound, user
limit, premium emoji, colour, usage type, first-purchase, sale status, category, location, note, volume
reset, tier, price, volume, duration) · **discount-code creation, fully documented** · user-tier
(f/n/n2) Store model · custom-pricing scope dimensions · custom-service limits and margin ·
customer-side purchase list and pre-invoice · entity relationships · business rules SBR-001..SBR-042 ·
source-bug register.

## PARTIAL_AREAS

Hidden panels (the `/all` gate is proven; the selection UI was never reachable) · bulk price
increase/decrease (scoping and percentage-vs-fixed proven; the value step deliberately not reached) ·
discount deletion (selection method proven; confirmation semantics unknown) · category deletion (same
shape) · custom pricing (scope proven; what the rule stores is unknown) · custom service (limits and one
price point; formula unknown) · cashback (three mechanisms characterised; stacking unknown) ·
customer-side cross-check (list behaviour proven; per-field isolation not done).

## UNKNOWN_AREAS

`PRICING_PRECEDENCE = UNKNOWN` · cashback stacking · `دسته بندی زمان` (needs a global toggle) ·
whether `مولتی لوکیشن` performs real multi-panel routing (needs a second panel) · what makes
`تک لوکیشن - اختصاصی` "dedicated" · whether a discount's total-uses cap counts users or redemptions ·
where the premium emoji renders · whether `👤محدودیت کاربر` maps to users, devices or connections.

## TEST_DATA

| Record | State |
|---|---|
| `TEST_STORE_CATEGORY` | exists, in place, name-only |
| `TEST_STORE_PRODUCT` | exists, in place, **`TEST_PRODUCT_LOCATION_CORRUPTED_BY_SOURCE_BOT_VALIDATION_BUG`** — location stuck at `/al`, product unreachable from the admin UI |
| `testaudit7x3q` (discount code) | exists, in place, **never redeemed**, 1-hour lifetime already expired |
| `TEST_MARZBAN_[PANEL_NAME_REDACTED]` | test panel from the earlier phase, untouched here |

**Do not delete any of these.** No production category, product, discount code, panel, service, user,
order, payment or global setting has ever been modified in this phase.

## IMPORTANT_SOURCE_BUGS

See `source-bugs.md`. Headline: **SOURCE_BUG-001** — the product-location edit path performs no
validation, accepted `/al`, reported success, and permanently orphaned the product from every admin
filter; three later repair attempts all reported success without changing anything
(**SOURCE_BUG-002**). Also carried forward: the admin web panel's discount-code page has never opened
(**SOURCE_BUG-003**).

## AUTHORITATIVE_FILES

Root deliverables: `store-settings-investigation-report.md` · `store-completeness-matrix.md` ·
`store-menu-tree.md` · `store-category-specification.md` · `store-product-specification.md` ·
`store-pricing-specification.md` · `store-discount-specification.md` ·
`store-custom-pricing-specification.md` · `store-user-group-pricing.md` ·
`store-entity-relationship-map.md` · `store-telegram-crossmap.md` · `store-test-results.md` ·
`store-unknowns.md`.

In this folder: `business-rules.md` · `product-fields.md` · `products.md` · `categories.md` ·
`discount-codes.md` · `store-capabilities.md` · `store-global-settings.md` ·
`product-panel-relationship.md` · `menu-tree.md` · `test-data.md` · `incidents.md` · `source-bugs.md` ·
`feature-gap-checklist.md` · `unknowns.md` · `progress.md`.

## STALE_FILES

- `store-settings-investigation-report-FINAL.md` — **STALE / SUPERSEDED**, kept only as historical
  evidence. It still claims the discount code was never created and inbound was never tested.
- `store-settings-investigation-report-INTERIM.md` — **STALE**, an even earlier snapshot.
- `unknowns.md` — historical narrative; the current register is the root `store-unknowns.md`.
- `_session3_raw_notes.md` — raw capture notes, superseded by the specifications.

## NEXT_PHASE

Nothing new should be started until the owner decides on the six authorised-test items in
`store-settings-investigation-report.md` §5. The remaining genuinely-new area across the whole project
is **Reseller / Agent child bots**, which has been out of scope in every phase so far.

## Scope boundary (unchanged, still binding)

Only `TEST_STORE_CATEGORY`, `TEST_STORE_PRODUCT` and `testaudit7x3q` may be created or modified. Every
production entity and every global setting is read-only: open → inspect → record → back out, never save.
Do not redeem the test discount code, do not create a real order, do not delete the test records.
Any unintended change is logged immediately in `incidents.md`; defects in the bot itself go to
`source-bugs.md`.
