# Telegram Business Rule Catalog (TBR-###)

STATUS: IN PROGRESS — 11 rules from the first exploration pass (root nav, onboarding, purchase, renewal, extra-volume)

Format: Rule / Evidence / Account Type / Preconditions / Result / Admin Relationship / Confidence. IDs continue as TBR-001, TBR-002, ... (kept separate from the Admin Panel's BR-### series in project-knowledge/business-rules.md — cross-reference by ID, do not renumber or merge the two catalogs).

## Rules

### TBR-001
Rule: The bot has NO persistent reply keyboard and NO buttons attached to its root/home state (neither /start's welcome message nor the "returned to main menu" confirmation carries any keyboard). The ☰ native Telegram bot-commands popup (6 commands: start/buy/services/wallet/help/support) is the ONLY root-level navigation surface; everything else is reached via inline keyboards attached to specific command responses.
Evidence: onboarding.md, menu-tree.md — direct observation, /start and the /wallet "return to main menu" button both tested.
Applies To: Root navigation / bot UX architecture
Preconditions: n/a
Result: A rebuild should NOT design around a persistent reply keyboard; model the root as a dead-end text state plus a command list.
Confidence: VERIFIED_BY_TELEGRAM

### TBR-002
Rule: Phone-number verification is NOT enforced for at least this account: /wallet shows "🔴 ارسال نشده است" (not sent) for phone, on an account with 1 purchased service and 8 paid invoices — i.e. a real, active, paying user with no phone on file. No verification step appeared at /start either.
Evidence: onboarding.md, payments-wallet.md.
Applies To: Onboarding / account requirements
Preconditions: n/a (negative finding — absence of a requirement)
Result: Rebuild should treat phone collection as optional/soft, not a purchase-blocking gate — at least for Normal User tier (untested for reseller tiers).
Confidence: VERIFIED_BY_TELEGRAM (for this account); INFERRED as a general rule (single sample).

### TBR-003
Rule: The "دسته بندی" (Category) concept, as actually configured on this live bot, segments products by PLAN DURATION (+ a "ویژه"/special qualifier), not by a generic product type/grouping.
Evidence: purchase-flow.md Step 1 (3 categories = 1/2/3-month "ویژه" plans).
Applies To: Products & Pricing engine, Category entity
Preconditions: n/a
Result: Resolves part of project-knowledge/products-pricing.md's open question ("does category affect pricing or is it pure grouping?") for THIS bot's real configuration — category is itself a pricing/duration dimension, at least here.
Admin Relationship: project-knowledge/entities.md Category entity.
Confidence: VERIFIED_BY_TELEGRAM (for this bot's actual category set); may not generalize to every possible admin configuration.

### TBR-004
Rule: Base (non-custom) product pricing for a given category is a discrete, individually-configured price-band table, not a continuous formula — the real per-GB marginal price decreases smoothly from 4,300→3,200 Toman/GB across 30–100GB but then jumps to an effective 3,780/GB average for the 150GB tier, breaking the smooth curve.
Evidence: purchase-flow.md Step 2 (full 9-row real price table).
Applies To: Pricing engine
Preconditions: n/a
Result: Confirms, from the live customer-facing side, project-knowledge/business-rules.md BR-004's admin-side inference that these are manually-set "بازه قیمت" rows.
Admin Relationship: BR-004, project-knowledge/entities.md CustomServicePricing (or the plain Product price field, ambiguous which mechanism produced this specific list — not cross-checked against the exact admin records).
Confidence: VERIFIED_BY_TELEGRAM (the curve itself); INFERRED (which admin mechanism specifically produced it).

### TBR-005
Rule: The checkout screen for a fresh purchase shows a single flat price (the product's list price) with NO automatic discount, reseller-discount%, or cashback applied — any such modifier must be actively invoked (e.g. via the discount-code button) rather than auto-applying.
Evidence: purchase-flow.md Step 3 (145,000 shown = exact list price).
Applies To: Pricing engine, Checkout (UNK-003 relevant)
Preconditions: Normal-User account (untested for reseller tiers — see unknowns.md UNK-T001)
Result: At least for Normal User, the "precedence" question partly resolves to "nothing stacks automatically — everything except the base price is opt-in at checkout."
Confidence: VERIFIED_BY_TELEGRAM for Normal User; UNKNOWN for reseller tiers.

### TBR-006
Rule: After an invalid discount code is submitted, the bot shows only an error message with NO recovery button (no "try again", no "back to checkout") — the user must know to type another code or escape via a slash command.
Evidence: discounts.md.
Applies To: Discount system UX, Error handling
Preconditions: A syntactically-accepted but non-existent code is submitted at the discount-code prompt.
Result: A rebuild should deliberately improve on this (e.g. offer a retry/cancel button) — documented here as the AS-IS behavior, not a recommendation to replicate the gap.
Confidence: VERIFIED_BY_TELEGRAM.

### TBR-007
Rule: "My Services" (/services) only lists provisioned (paid) services — an abandoned/unpaid checkout (product selected, invalid discount code tried, no payment made) does NOT appear there; the purchased-services count stayed at exactly 1 before and after the abandoned attempt.
Evidence: purchase-flow.md, services.md (cross-check).
Applies To: Order/service state machine, My Services
Preconditions: n/a
Result: Consistent with project-knowledge/orders.md BR-013 (provisioning gated on payment) — extends it with direct Telegram-side confirmation that unpaid orders are invisible from the end-user's own service list, not just lacking config data.
Admin Relationship: BR-013.
Confidence: VERIFIED_BY_TELEGRAM (for My Services visibility); still UNKNOWN whether an Unpaid Order row nonetheless exists server-side (would need Admin Panel access to confirm — out of this phase's scope).

### TBR-008
Rule: Renewal offers TWO paths — a "تمدید پلن فعلی" (renew current plan) shortcut at the identical price, AND the full category→product picker (letting a "renewal" become an upgrade/downgrade) — both reachable from the same "🍬 تمدید سرویس" entry point. The renewal checkout screen has one fewer button than the fresh-purchase checkout (no note-field option).
Evidence: renewal.md.
Applies To: Renewal flow
Preconditions: n/a
Result: Renewal and Purchase share the same underlying category/product-selection logic; only the checkout step differs slightly.
Confidence: VERIFIED_BY_TELEGRAM.

### TBR-009
Rule: Extra-volume purchases are priced as an EXACT flat linear rate (4,500 Toman/GB × requested GB, confirmed to the Toman with a real 5GB→22,500 Toman example) — a fundamentally different pricing mechanism from the tiered/discrete base-product price table (TBR-004). An invoice is created immediately on quantity entry, before any payment method is chosen. Purchased extra volume is explicitly bounded by the underlying service's EXISTING expiry date — it does not extend the service's lifetime.
Evidence: extra-traffic-time.md.
Applies To: Extra traffic, Pricing engine
Preconditions: n/a
Result: Confirms project-knowledge/products-pricing.md's `extravolumeinvoice` bot-text-only inference with a real live transaction; adds the not-previously-documented "does not extend expiry" constraint and the "invoice created pre-payment" mechanic.
Admin Relationship: project-knowledge users.Extra_volume bot-text group.
Confidence: VERIFIED_BY_TELEGRAM.

### TBR-010
Rule: End users have NO self-service "Delete service" option — the service-detail action grid offers only "❌ خاموش کردن اکانت" (disable), never a delete. Full deletion (project-knowledge/orders.md's حذف سرویس/حذف از دیتابیس actions) appears to be Admin-only.
Evidence: services.md.
Applies To: Permissions boundary (end-user vs admin), Order/service state machine
Preconditions: n/a
Result: Clean confirmation of a user/admin capability boundary — useful for the rebuild's permission model.
Admin Relationship: project-knowledge/orders.md "Actions available on an order", BR-015.
Confidence: VERIFIED_BY_TELEGRAM (absence of the button); INFERRED that this is a hard permission boundary rather than just a UI omission.

### TBR-011
Rule: A service has an editable free-text "note" field, offered at TWO points: at fresh-purchase checkout ("📝 ثبت یادداشت") and again from the service-detail screen ("📝 تغییر یادداشت") — but NOT at renewal or extra-volume checkout. Also NEW: a "🚚 انتقال سرویس به کاربر دیگر" (transfer service to another user) action exists on the service-detail grid, entirely undocumented anywhere in the Admin Panel investigation (project-knowledge/).
Evidence: services.md, purchase-flow.md, renewal.md, extra-traffic-time.md (cross-check across all 4 checkout variants).
Applies To: Order/service entity, User-to-user transfer (new feature)
Preconditions: n/a
Result: project-knowledge/entities.md Order/Invoice entity is missing a `note` field — should be added for the rebuild. The service-transfer feature needs its own dedicated investigation pass (structure, limits, whether it's reversible) — flagged in unknowns.md, NOT explored (state-changing risk).
Confidence: VERIFIED_BY_TELEGRAM (existence of both features); transfer feature's actual behavior is entirely UNKNOWN beyond the button existing.

### TBR-012
Rule: On renewal, unused remaining days from the CURRENT period are NOT lost — they carry over and stack on top of the new period's full duration. Per the bot's own /support FAQ (Q2, verbatim example): a 1-month account with 5 days left, renewed 5 days early, results in remaining 5 days + the new 30 days (not just a fresh 30-day period from the renewal moment).
Evidence: support.md (/support FAQ Q2).
Applies To: Renewal flow, Service expiry calculation
Preconditions: n/a
Result: Resolves renewal.md's open item on early-renewal/day-stacking — renewal is additive to the existing expiry date, not a reset. A rebuild's renewal logic should extend the existing expiry timestamp by the new plan's duration, not overwrite it.
Admin Relationship: none found yet in project-knowledge/ — likely an undocumented server-side calculation, worth a dedicated look if the Admin Panel is revisited.
Confidence: VERIFIED_BY_TELEGRAM (bot's own stated policy text); NOT independently confirmed via an actual completed renewal (would need approval).

### TBR-013
Rule: Refunds are only granted if the reported problem is NOT caused by/resolvable on the user's own side — i.e. service-caused failures only, not user error or local network/device issues. Per /support FAQ (Q9): "امکان بازگشت وجه در صورت حل نشدن مشکل از سمت ما وجود دارد" (a refund is possible if the issue is not resolved from OUR side).
Evidence: support.md (/support FAQ Q9).
Applies To: Payments, Refund policy
Preconditions: n/a
Result: New business rule not previously found in project-knowledge/payments.md — refunds are conditional/support-mediated, not a self-service wallet action anywhere observed in the bot's UI.
Confidence: VERIFIED_BY_TELEGRAM (stated policy text); actual refund mechanism/who executes it (admin-only, presumably) NOT independently observed.

### TBR-014
Rule: The in-bot "📩 ارسال پیام به پشتیبانی" (send message to support) button under /support is a Telegram URL button (carries the outbound-link ↗ indicator), not an in-bot ticket-creation state. This strongly suggests support/ticket interactions happen OUTSIDE [BOT_USERNAME_REDACTED]'s own conversational state machine (e.g. a separate human-agent chat or channel), rather than through a documented SupportTicket flow inside this bot.
Evidence: support.md (/support button inspection).
Applies To: Support/ticketing system, Admin↔Telegram relationship
Preconditions: n/a
Result: The Admin Panel's SupportTicket entity (13 categories, project-knowledge/entities.md) may originate from a different channel entirely (web panel direct login, or a separate support bot/chat) rather than from [BOT_USERNAME_REDACTED] — flagged as an open question in unknowns.md and admin-telegram-map.md, not resolved.
Confidence: VERIFIED_BY_TELEGRAM (button's link-icon existence); INFERRED (the conclusion about SupportTicket's true origin).

### TBR-015
Rule: "سرویس دلخواه" (Custom Service) is a genuinely distinct product path — it is the ONLY way to get a non-30-day duration (10-90 day range, free-text) or a volume above 150GB (up to 500GB, free-text) — and it uses a DIFFERENT, higher-margin pricing mechanism than either the fixed price-band table (TBR-004) or the extra-volume/extra-time flat rates (TBR-009): a real sample of 35GB/30-day priced at 187,500 Toman does not match any tested formula derived from those other two mechanisms (see purchase-flow.md Step 2b for the failed formula candidates).
Evidence: purchase-flow.md Step 2b.
Applies To: Pricing engine, Custom-service purchase path
Preconditions: n/a
Result: A rebuild needs THREE distinct pricing mechanisms, not two: (1) fixed price-band table per category/product, (2) flat linear per-unit rate for extra-volume/extra-time add-ons, (3) a separate (currently under-determined) formula for custom/CustomServicePricing that appears to charge a premium over both. Admin Relationship: project-knowledge/entities.md CustomServicePricing entity — this is likely its live behavior, finally observed from the customer side.
Confidence: VERIFIED_BY_TELEGRAM (the one real price point); the exact formula is UNKNOWN/INFERRED as "some kind of premium," not derived precisely.

### TBR-016
Rule: Category display NAMES do not reliably indicate the actual configured duration of the products inside them. The "دو ماهه" (two-month) category's 9 products are ALL actually "90 روزه" (90-day) duration, not ~60 days as the name implies. Separately, longer base durations are priced at a DISCOUNT relative to naive linear scaling: the 90-day category's 30GB price (205,000T) is only ~1.41× the 30-day category's 30GB price (145,000T), not 3×. This means the fixed price-band system has (at least) TWO independent bulk-discount dimensions — volume (TBR-004) and duration — that do not stack multiplicatively.
Evidence: purchase-flow.md Step 1b (full 9-row price table for the 90-day category, category-name-vs-duration mismatch).
Applies To: Category entity, Pricing engine, duration-based discounting
Preconditions: n/a
Result: A rebuild must NOT infer a product's duration from its category's display name — duration must be its own explicit, independently-configured field per product. Pricing for a rebuild should model volume-discount and duration-discount as two separate curves, not a single formula.
Confidence: VERIFIED_BY_TELEGRAM (the price table and label mismatch); UNKNOWN whether the name/duration mismatch is an admin configuration mistake or intentional.

### TBR-017
Rule: A product category can be entirely non-functional for purchase while still being visibly listed and clickable — the bot does not hide or disable categories lacking an assigned panel/location; it fails at the NEXT step (product listing) with a terse "❌ پنل انتخاب نشده" (panel not selected) error, reproduced consistently.
Evidence: errors-edge-cases.md, purchase-flow.md Step 1b (the "سه ماهه" category).
Applies To: Category/Product availability, Error handling, Category↔Panel assignment
Preconditions: A category's product(s) have no VPN panel/location assigned in the Admin Panel.
Result: A rebuild should validate panel-assignment at category-configuration time (or at minimum grey out/hide such categories at list-time) rather than surfacing a generic post-click error — documented as the AS-IS gap, not a design to replicate.
Confidence: VERIFIED_BY_TELEGRAM (error reproduced twice); INFERRED (the specific "no panel assigned" root cause, plausible from wording but not cross-checked against the Admin Panel).
