# Unknowns Register — Phase 3 (Telegram Bot)

Format per item: ID / Question / Why It Matters / Current Evidence / Missing Evidence / Safe Verification Method / Approval Required (YES/NO) / Priority

IDs continue as UNK-T001, UNK-T002, ... (kept separate from the Admin Panel's UNK-### series in project-knowledge/unknowns.md).

---
### UNK-T001 — RESOLVED BY USER DECISION 2026-08-30
Question: Is the ONE Telegram account available in this browser session the ONLY account accessible for this investigation? It is confirmed Normal User tier (گروه کاربری: عادی) — is there any safe way to compare Normal Reseller / Advanced Reseller Telegram UX without a second/third account?
Why It Matters: Brief §15 marks the 3-tier comparison HIGHEST PRIORITY; without additional accounts, reseller-users.md's comparison matrix cannot be filled in from direct observation at all.
Current Evidence: /wallet confirmed this account's گروه کاربری = عادی (Normal). No second Telegram account/chat with the bot from a reseller-tier account is visible in this browser's chat list (checked: only one chat with [BOT_USERNAME_REDACTED] exists).
Missing Evidence: Access to a Normal Reseller and an Advanced Reseller Telegram account.
Safe Verification Method: None available from within this session as configured.
USER DECISION: "Skip the 3-tier comparison for now" — continue investigating everything else safely reachable from this Normal-User account; leave the reseller comparison as a tracked, deliberately-deferred gap rather than a blocker. reseller-users.md and feature-gap-checklist.md items #4/#17/#18 are marked DEFERRED (not BLOCKED) to reflect this is now an intentional scope decision, not a stall.
Approval Required: NO (resolved — user chose to defer, not to provide additional accounts)
Priority: still HIGH as an eventual gap to close before the investigation can be called COMPLETE per brief §43, but no longer an active blocker to progress elsewhere.

### UNK-T002 — PARTIALLY RESOLVED 2026-08-30 (prompt read, user approved opening it, no target ID entered)
Question: What does "🚚 انتقال سرویس به کاربر دیگر" (Transfer service to another user) actually do — target-user lookup method, limits, reversibility, price (if any), effect on the transferring user's own service count?
Why It Matters: Entirely new feature, not documented anywhere in project-knowledge/ (Admin Panel investigation never surfaced it) — could be an important part of the reseller/customer-management story (brief §27).
Current Evidence: Opened the button (user-approved, read-only) and read its prompt in full — see services.md for the verbatim text. Key structural facts now known: (1) transfer requires knowing the TARGET account's own numeric bot-user ID (the same ID shown on that person's own /wallet screen — i.e. the recipient must separately open /wallet and share their ID with the sender out-of-band); (2) the bot's own help text is explicit that the transfer is ONE-WAY and DESTRUCTIVE to the sender: "بعد از انتقال اشتراک به کاربر مقصد، اشتراک از پنل شما حذف خواهد شد" (after transferring, the subscription will be REMOVED from your own panel) — confirms this is not a "share/duplicate" feature, it's a genuine ownership transfer; (3) the prompt is a free-text numeric-ID entry with no visible target-account preview/confirmation step shown before that entry — consistent with brief §10's caution that a "confirm" step should never be assumed to exist. Safely exited via the "🔙 بازگشت" button without entering any ID.
Missing Evidence: What happens after a valid target ID is entered (confirmation screen? immediate execution? invalid-ID error?) — NOT tested, would need a second real account ID and explicit approval to test further given the stated irreversibility.
Safe Verification Method: n/a beyond what was done — further testing needs a second consenting account and explicit approval.
Approval Required: YES for going further (entering any ID)
Priority: MEDIUM (structure now understood; exact post-entry behavior remains open but is lower urgency since the mechanism is now clear)

### UNK-T003
Question: Does an Unpaid/pending Order row actually get created server-side (visible from the Admin Panel's `/invoice/` list) at the moment a checkout screen is shown / an extra-volume invoice message is displayed, even though "My Services" never shows it and no payment was made?
Why It Matters: Would confirm or refine project-knowledge/orders.md BR-013 and BR-011's Unpaid-status semantics with a live, known example.
Current Evidence: Telegram-side: "My Services" count unchanged after 2 abandoned checkouts (1 fresh-purchase attempt, 1 extra-volume "invoice created" message). Admin-side (Phase 2): BR-013 established Unpaid orders exist as a real status but didn't pin down exactly WHEN the row is created.
Missing Evidence: A look at the Admin Panel's `/invoice/` list filtered to "پرداخت نشده" (Unpaid) immediately after one of these Telegram-side abandoned checkouts, to see if a new matching row appears.
Safe Verification Method: Read-only Admin Panel check (would require briefly reopening the Admin Panel, which was declared complete/read-only for this phase — flagged rather than done unilaterally, since the user's Phase 3 brief scoped this phase as Telegram-only).
Approval Required: NO for the check itself (read-only), but crosses this phase's stated Telegram-only focus — flagging for the user's call rather than assuming permission to step back into the Admin Panel.
Priority: MEDIUM

### UNK-T004 — RESOLVED 2026-08-30 (VERIFIED_BY_TELEGRAM, upgraded from largely-explained/INFERRED)
Question: Is the location-change action genuinely absent for this account/service/panel, or reachable through a path not yet found (e.g. only for certain categories, or via /help)?
Why It Matters: Brief §24 requires mapping location-change; project-knowledge/vpn-panels.md documents a real per-panel toggle for it, so its total absence from the one real service checked is either a meaningful per-panel/category finding or a gap in this pass's exploration.
Current Evidence: Checked exhaustively — /help (tutorial menu only, no location content), every purchase path (2 fixed categories + custom-service, all "...مولتی لوکیشن ویژه"/multi-location-labeled), and the one real service's action grid: NO location-choice or location-change step/button anywhere. Leading explanation (INFERRED, see location-change.md): every category on this bot is explicitly "multi-location" — the service likely includes ALL locations simultaneously by design (consistent with /support FAQ Q5's "25 countries simultaneously, one subscription"), so there is nothing to "choose" or "change" per service. This would fully explain the absence without it being a hidden/unexplored gap.
Missing Evidence: NONE remaining — direct bot-text confirmation found: a product-description bullet explicitly states "🌍 لوکیشن‌های ما در 33 کشور" (our locations: 33 countries) followed by the full real country/city list attached to the purchase/renewal checkout flow (see location-change.md). This confirms a single service purchase includes ALL 33 listed locations at once — there is no per-service location CHOICE because none is needed.
Safe Verification Method: n/a — resolved via passive re-review of existing chat history, no further action needed.
Approval Required: NO.
Priority: RESOLVED — closed.

### UNK-T005 (cross-reference, not a new question)
Question: See project-knowledge/unknowns.md UNK-003 (pricing precedence) and UNK-005 (admin role enforcement). UNK-003 is now PARTIALLY further de-risked by this phase (see pricing-checkout.md, business-rules.md TBR-004/005) but the full stacking order (discount code × reseller discount × cashback, all together) remains open — likely unresolvable without either a real approved purchase using a valid discount code, or reseller-tier account access (see UNK-T001). UNK-005 is Admin-Panel-specific and not something Telegram evidence can resolve at all — carried over unchanged, no Telegram angle exists.
Priority: HIGH (UNK-003 aspect), N/A (UNK-005 aspect, out of this phase's reach entirely)

### UNK-T006
Question: Where does the Admin Panel's SupportTicket entity (13 categories) actually originate, if not from [BOT_USERNAME_REDACTED]'s own conversational flow?
Why It Matters: /support's only outbound action ("ارسال پیام به پشتیبانی") is a Telegram URL button (external-link icon), not an in-bot ticket-creation state — so the bot itself appears to have no in-conversation ticket flow at all, which is surprising given the Admin Panel's rich 13-category SupportTicket model.
Current Evidence: support.md — /support's FAQ + button structure fully mapped; the support-message button is confirmed to be a URL/external-link button by its icon, not clicked.
Missing Evidence: What the external link actually points to (a human-agent chat? a different bot? a web form?) — would require clicking an external link, low priority/low safety concern but not yet done since it leaves the current chat.
Safe Verification Method: Could click the link to see its destination (reading a URL is safe/non-state-changing) — deprioritized so far in favor of higher-priority areas (Mini App, referral, test account).
Approval Required: NO (reading a link destination is safe) — but flagging before doing it since it's a lower priority than remaining core flows.
Priority: LOW-MEDIUM.

### UNK-T008
Question: Does [BOT_USERNAME_REDACTED] also have a completely separate group-management/ads feature set (group ID registration for "ارسال اعلان" announcements, "myidbot"-based group-ID lookup instructions, mandatory-channel-join configuration, group admin/topic-mode settings) — and if so, is it in-scope for this investigation (business logic exposed through Telegram) or an unrelated bot capability?
Why It Matters: Encountered while scrolling this account's older chat history looking for passive notification examples (per brief's notifications.md task) — found several messages that read like GROUP-OWNER/ADMIN configuration instructions (e.g. "در این بخش می‌توانید آیدی عددی گروه را برای ارسال اعلان گروه ارسال نمایید", "برای فعال کردن قابلیت اجباری عضویت یک کانال اضافه کنید", "ربات خودتان را ادمین گروه کنید"), entirely unrelated to VPN purchase/service/wallet functionality. This does NOT look like normal end-user VPN-customer content.
Current Evidence: A handful of historical messages in this same chat thread with [BOT_USERNAME_REDACTED], structurally distinct in tone/purpose from every other flow investigated this phase. NOT reproduced/re-triggered (did not click into or interact with this content — purely passive observation while scrolling for notification examples).
Missing Evidence: Whether this is (a) a real, current, in-scope bot feature (e.g. resellers/advanced users can register a Telegram group to receive service announcements or promote referrals), (b) leftover content from a much older/different bot configuration or rebrand, or (c) something this account set up incidentally and unrelated to the VPN business.
Safe Verification Method: Could investigate further by checking whether a corresponding command/button exists in the bot's CURRENT menu surface (none found in menu-tree.md's 6-command list, so if real, it must be reached some other way, e.g. a deep-link or an old inline button no longer surfaced) — deprioritized this pass given it doesn't map to VPN purchase/service/reseller business logic, which is the brief's core focus.
Approval Required: NO for further passive investigation; flagging rather than pursuing given uncertain relevance and to conserve investigation budget per §41.
Priority: LOW — likely out of the brief's core scope (VPN service business logic), but noted in case it turns out to be relevant to resellers' group-based promotion features (which WOULD be in scope per §12/§27).

### UNK-T007
Question: Where is the Telegram Mini App (WebApp) storefront brief §20 asks about — is it reachable at all from this bot, and if so, does it show a TOTAL price distinct from a PAYABLE amount (pricing-precedence evidence for UNK-003)?
Why It Matters: Brief flags Mini App as HIGH PRIORITY for pricing-precedence evidence; TOTAL vs PAYABLE would show whether discounts/wallet-credit/cashback are pre-computed server-side into a single payable figure.
Current Evidence: Ruled OUT: wallet top-up ("افزایش موجودی") is a plain free-text amount prompt, not a WebApp launch (see payments-wallet.md). Not yet checked: the payment-gateway selection step reached from any checkout (fresh purchase, renewal, extra-volume, extra-time, or wallet deposit) — clicking "🚫 پرداخت با درگاه" is the next untried candidate, but doing so from ANY checkout is a real step into a financial flow (submitting a deposit amount was already auto-blocked by the session's own safety classifier as a state-changing financial action).
Missing Evidence: Whether any button anywhere on this bot opens an actual Telegram WebApp (visually distinct: opens as an in-Telegram browser overlay, not a chat message) — none observed so far across purchase, renewal, extra-volume, extra-time, or wallet-deposit entry prompts.
Safe Verification Method: None found yet that stays clear of the financial-action boundary. Would need explicit user approval per the brief's TEST/WHY NEEDED format to proceed into a payment-gateway-selection screen on any flow.
Approval Required: YES, before clicking "پرداخت با درگاه" (pay via gateway) on any checkout.
Priority: HIGH (brief §20 priority) but currently unactionable without approval — flagging rather than guessing.
