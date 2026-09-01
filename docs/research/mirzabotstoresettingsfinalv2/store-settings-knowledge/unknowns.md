> # ⚠️ HISTORICAL — superseded by the root `store-unknowns.md`
> Several items below are now RESOLVED (discount-code structure, configure inbound, user limit,
> premium emoji, product↔panel selector, cashback classification, product colour meaning).
> Use `store-unknowns.md` in the repo root for the current register and its status roll-up.

---

# Unknowns — Store Settings Investigation

Consolidated list of everything flagged UNKNOWN or NOT_TESTED across all Store Settings knowledge files, as of this checkpoint. Each entry states what's known, what's missing, and why it wasn't resolved (safety boundary, time constraint, or genuinely requires a capability this phase doesn't have).

## Product-level unknowns

1. **`نمایش برای خرید اول` (first-purchase-only) — exact customer-facing runtime behavior.** Mechanism is confirmed (SBR-012): it's a per-product boolean, currently ON for TEST_STORE_PRODUCT. What's NOT confirmed: does it hide the product entirely from a repeat customer's purchase list, or does it only affect something else (e.g. pricing, a badge, eligibility at checkout)? Requires a live Telegram customer-side cross-check (read-only, no real order) — planned but not yet executed this phase.
2. **`مولتی لوکیشن` mode value — does it trigger genuine multi-panel ROUTING, or is it just a descriptive label with single-panel behavior underneath?** SBR-010 confirms it's mechanically a single-select value, interchangeable with a specific panel name, but this account only has one real usable test panel (`TEST_MARZBAN_[PANEL_NAME_REDACTED]`), so true multi-panel fulfillment can't be observed directly. Would require either a second real panel or inspecting backend/DB-level behavior (both out of this phase's Telegram-only, read-mostly scope).
3. **`تنظیم اینباند` (Configure inbound)** — not yet opened. Suspected to link a product to a specific Marzban inbound/protocol config (per prior Panel Management phase's `protocol-inbound-config.md`), but completely unverified. HIGH VALUE, next priority once the browser tool reconnects.
4. **`مخفی کردن پنل` / `حذف کلی پنل های مخفی` (Hide panel / Remove all hidden panels)** — not yet opened. Likely lets an admin exclude specific panels from a product's multi-location pool, with a bulk-clear counterpart. Unverified; the "حذف" (remove/delete) wording warrants caution even though it should only ever affect the TEST product's own panel-visibility list.
5. **`محدودیت کاربر` (User limit)** — not yet opened. Shown as "بدون محدودیت" (unrestricted) by default in the Edit summary; likely a concurrent-connection or device cap. Unverified.
6. **`ایموجی پریمیوم محصول` (Product premium emoji)** — not yet opened. Presumed decorative/marketing field.
7. **Description/rich-text field** — no field for a long-form product description was ever prompted, in either creation or the 18-field Edit menu observed so far. May genuinely not exist in the Telegram-bot data model (vs. web-panel-only), or may be hiding behind an unopened field. Still open.
8. **Display order (ردیف نمایش)** — no such field observed anywhere in Product Edit's field list so far (18 buttons enumerated, none labeled as order/priority). May not be exposed via Telegram at all. Not yet conclusively ruled out — full field list has been ENUMERATED but not every single field has been individually opened yet.
9. **افزایش گروهی قیمت / کاهش گروهی قیمت (Bulk group price increase/decrease)** — two store-wide pricing tools discovered in the Product Management menu (menu-level only, never opened, to avoid any risk to production pricing). Full field structure (which products/categories/groups it targets, percentage vs. fixed amount, preview-before-apply or not) is completely unknown. Flagged for a READ-ONLY-only pass later (open, read the prompt, back out without submitting) — never actually submit a value against this, since it could touch every real product's price.

## Category-level unknowns

10. **Does Category have ANY indirect pricing effect** via a separate group-pricing mechanism keyed by category name/ID? Category itself carries no price field (confirmed, SBR-004) — but a downstream pricing table could still reference a category as a lookup key. Not yet tested; would require the pricing.md investigation (not yet started).
11. **`دسته بندی زمان` (Time-based category)** — a DISTINCT capability toggle from plain `دسته بندی`, seen in `store-capabilities.md`'s 16-toggle table, currently OFF. Possibly a second/legacy category mode. Completely unexplored — its own menu/screen (if any, while off) has not been located.
12. **Category Delete flow** — never opened (would present the same full picker as Edit, including real categories, and unlike Edit a mis-selection here is destructive). Field structure is presumed identical to Edit's picker but this is unconfirmed. Deferred; will only be inspected READ-ONLY (open, view, cancel) unless the user explicitly authorizes deleting TEST_STORE_CATEGORY.

## Discount code unknowns (entire area — HIGH PRIORITY, not yet started)

13. **Full field list for discount-code creation** (`ساخت کد تخفیف`) — genuinely never observed anywhere before this phase (the web-panel CRUD for this was a confirmed persistent backend bug in a prior phase). Expected candidate fields, all UNCONFIRMED: expiry date/duration, max total uses, per-user use limit, minimum purchase amount, user-group restriction, percentage vs. fixed-amount discount, applicability to specific products/categories vs. store-wide. This is the single highest-priority unexplored area remaining in the brief (§19).
14. **Discount-code deletion flow** (`حذف کد تخفیف`) — not opened. Presumed to present a code picker; unconfirmed whether it lists real codes (in which case must be READ-ONLY only) or requires typing the code (safer, could open freely).

## Pricing unknowns (entire area — not yet started)

15. **Custom/range pricing (`بازه قیمت` / "سرویس دلخواه")** — CRUD screen and full field list never directly observed this phase (only inferred from a prior phase's partial web-panel exploration: min, max, range-type, base-price, user-group, panel-or-all, optional specific-user). Not yet cross-verified from the Telegram admin side.
16. **Group pricing precedence** — when multiple pricing layers could apply to the same purchase (fixed product price vs. custom-range price vs. group-specific price vs. any promotional/discount-code layer), the ORDER of precedence/application is unknown. Never empirically tested from a reseller Telegram account (deliberately deferred gap carried over from prior phases).
17. **Formula behind "سرویس دلخواه" (custom service) pricing** — confirmed in a prior phase to differ from both the fixed price-band curve and the flat extra-volume rate, but the exact formula was never derived.

## Cashback unknowns

18. **Whether the FOUR known cashback surfaces stack, override, or apply independently**: (a) per-gateway cashback%, (b) per-user-group shop-topup cashback% (3 tiers), (c) کش بک تمدید (Renewal Cashback, SBR-001, global %), (d) `دکمه بازگشت وجه` (refund button, currently OFF per store-capabilities.md — its actual mechanism is also unconfirmed). No live test has combined more than one of these in a single transaction.

## Ordering/sorting unknowns

19. **Product ordering** — web-panel prior-phase claim was an explicit `ردیف نمایش` (display-order) field; not yet located in the Telegram-side Edit-Product field list (see #8 above). Whether products are shown to customers in insertion order, price order, or an explicit order field is unconfirmed from the Telegram side.
20. **Category ordering** — confirmed insertion-order for the ADMIN-side picker (SBR-005), but whether the CUSTOMER-facing store menu uses the same ordering, a different one, or an explicit priority field is unconfirmed.

## Reseller / Telegram customer-side unknowns

21. **Reseller Telegram UX** — a deliberately deferred gap carried over from prior phases: none of the group-pricing (f/n/n2) behavior has ever been empirically observed from an actual reseller account's Telegram session, only from the admin side's field definitions.
22. **Live customer-facing Telegram store view** — the read-only customer-side cross-check (browsing the store as a buyer would, to see category/product visibility, first-purchase-only behavior, sale-status effects, etc., WITHOUT creating a real order) has not yet been performed this phase.

## Explicitly OUT OF SCOPE (not unknowns to resolve, just noting the boundary)

- Reseller Bots settings — explicitly out of scope per the governing brief.
- Any change to a real/production category, product, discount code, pricing rule, cashback setting, gateway setting, or user/order/payment data — per the phase's safety boundary (§0), these are inspected read-only at most, never modified, and are therefore permanently "unknown" at the level of "what happens if you change this," which is the correct, intended outcome, not a gap.
