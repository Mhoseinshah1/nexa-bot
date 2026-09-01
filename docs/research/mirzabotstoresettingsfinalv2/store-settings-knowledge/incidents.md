# Incidents — Store Settings Phase

Per brief §32: any accidental navigation or unintended state change must be documented immediately, never hidden. Two incidents this phase, both minor, both self-corrected within minutes, neither touched any real/production entity's own data.

## INCIDENT-001 — Browser-tool connectivity outage (~13:02–14:38 Telegram time)

**What happened**: The claude-in-chrome MCP browser-automation tool became completely unresponsive (every call — screenshot, click, get_page_text, tabs_context — timed out after 60s) for approximately 90 minutes of wall-clock time, starting immediately after opening the "وضعیت فروش محصول" (Product Sale Status) edit prompt for TEST_STORE_PRODUCT.

**Impact**: None on data. The sale-status prompt was open with two unclicked buttons (فعال/غیرفعال) when the outage began — nothing had been submitted. The Telegram session itself was untouched by the outage (it's server-side state, independent of the local browser tool); when the tool reconnected, the exact same prompt was still on-screen, unchanged.

**Resolution**: Waited for reconnection (user was informed, asked to check the browser tab/extension), confirmed reconnection via `tabs_context_mcp`, verified the on-screen state via screenshot before clicking anything, then proceeded normally.

**No corrective action needed** — no incorrect state was ever created.

## INCIDENT-002 — Accidental brief category reassignment to a REAL category (self-corrected)

**What happened**: While editing TEST_STORE_PRODUCT's `دسته بندی` (Category) field for a second time (to exercise/confirm the field is individually editable), a coordinate-based click (issued right after the browser-tool reconnection, before this session had adjusted to a viewport-size change) landed on the wrong button in the category picker. Instead of `TEST_STORE_CATEGORY`, it selected `یکماهه تک لوکیشن ویژه` — a REAL, production category. The bot accepted this and TEST_STORE_PRODUCT's category briefly became `یکماهه تک لوکیشن ویژه` (14:38–14:41, Telegram client time).

**Root cause**: The browser viewport/screenshot dimensions changed between tool calls during this session (observed as 1339x917, then 1394x876, then 1115x701 across consecutive screenshots) without warning, so a button position remembered from an earlier screenshot no longer corresponded to the same button. This is a repeat of a lesson already noted earlier in this phase (stale refs / re-render drift) — it recurred here specifically because a coordinate (not a fresh `find`-derived element ref) was reused across the reconnection boundary.

**Scope check — was any production entity actually modified?** No. Selecting a real category for a product only sets that PRODUCT's category foreign-key/reference; it does not write to, rename, or alter the category entity `یکماهه تک لوکیشن ویژه` itself in any way — that category's own name, product list, and any other property were completely unaffected and remain exactly as they were before and after this incident. The only record whose data changed was `TEST_STORE_PRODUCT`, which this phase is fully authorized to modify freely. This is a real, if minor, breach of the intended TEST-record self-consistency (and momentarily made the test product reference a real category in the live bot for ~3 minutes), but it did not violate the phase's core safety boundary (§1: never modify any existing/production product, category, discount code, pricing, etc.) since the category record itself was never written to.

**Resolution**: Immediately noticed on the next screenshot/summary check (the Edit Product summary explicitly echoes the current category), and corrected within the same investigative step: re-opened `دسته بندی`, this time selecting `TEST_STORE_CATEGORY` via a fresh `find`-derived element reference (not a remembered coordinate). Verified via the Edit Product summary reprint and via `get_page_text` transcript that the category is now correctly `TEST_STORE_CATEGORY` again (14:43).

**Corrective action taken for the remainder of this phase**: switched to exclusively using `find`-derived element references (never bare remembered pixel coordinates) for every reply-keyboard button click from this point forward, and re-running `find` fresh immediately before each click rather than reusing a ref or coordinate from an earlier screenshot.

## INCIDENT-003 — Stale `find`-ref clicks landed on "بازگشت به منوی مدیریت" (navigation only, no data impact)

**What happened**: Twice in a row, clicking a `find`-derived element reference intended for the `نمایش برای خرید اول` inline toggle button instead triggered `بازگشت به منوی مدیریت` (Back to admin root menu), fully exiting the Edit Product flow both times. Root cause identified: the toggle is an INLINE button attached directly to a specific bot message bubble, not a bottom reply-keyboard button — but the bottom reply-keyboard (opened via "Show bot keyboard") was visually overlapping/stacked on top of it in screenshots, and both `find` and coordinate clicks were ambiguously landing on the wrong layer or on a stale cached element.

**Impact**: None on data — both mis-clicks were pure navigation (back to the admin root menu), not selections of any value. No product/category/setting was read or written incorrectly as a result.

**Resolution**: Recognized the inline-vs-reply-keyboard distinction; from that point on, closed the bottom reply-keyboard (Escape, or simply not opening it for message-attached inline buttons) and clicked the inline button directly from a same-turn screenshot's coordinates. This succeeded immediately. Also once used Escape to dismiss what was assumed to be only the keyboard overlay, but it instead closed the entire chat view back to the chat list — recovered in one click by reopening the Zed Proxy chat, no data impact.

**Corrective action for the remainder of this phase**: distinguish inline (message-attached) buttons from bottom reply-keyboard buttons before every click; take a fresh screenshot immediately before each click and use same-turn coordinates rather than any `find` ref or coordinate carried over from a prior step; treat Escape as closing the whole chat view, not just a keyboard overlay, and avoid it when only the keyboard needs dismissing (scroll or click elsewhere instead).

## INCIDENT-004 — Second browser-tool connectivity outage (claude-in-chrome MCP server fully disconnected)

**What happened**: Shortly after successfully testing `رنگ محصول` (Product color, CHANGE-017) and while attempting to re-enter the admin menu (typed `پنل مدیریت` as plain text, got no bot reply after 10+ seconds; a subsequent `type` action for `/start` failed with a transient tool-classifier timeout), the entire `claude-in-chrome` MCP server dropped from the available server list (`RefreshMcpTools` no longer lists it at all, vs. the specific-tool timeouts seen in INCIDENT-001). This is a full server disconnect, not merely slow responses.

**Impact assessment so far**: None on data. The last confirmed state (per `progress.md`) is TEST_STORE_PRODUCT with رنگ محصول successfully set to `default` (confirmed via bot reply "رنگ دکمه با موفقیت تغییر کرد" before the disconnect). No click or submission was in-flight when the disconnect occurred — the interrupted actions were only an unanswered plain-text message (`پنل مدیریت`, which the bot never even acknowledged) and a `type` call for `/start` that never reached the page.

**Resolution**: Waiting for the MCP server to reconnect (as in INCIDENT-001, which recovered after ~90 minutes), using the same protocol: do not guess at UI state, re-verify via fresh screenshot/get_page_text once tools return, before clicking anything.

**No corrective action needed yet** — will update this entry once reconnected with the total outage duration and confirmation that no state was affected.

## INCIDENT-005 — Accidental click on a stale inline button after tool reconnect (no functional change)

**What happened**: Immediately after the `claude-in-chrome` MCP server reconnected (ending INCIDENT-004) in a brand-new tab, the first screenshot rendered as an odd tab-switcher/thumbnail overlay. A click intended to dismiss that overlay (at a coordinate that seemed like empty chat background) landed on the still-visible inline button `هر دو (خرید و تمدید)` belonging to the OLD `نوع استفاده محصول` prompt from earlier in the session (14:53). A toast/info banner appeared reading "به «هر دو (خرید و تمدید)» تغییر کرد ✅" (changed to "both").

**Impact**: None, functionally. `get_page_text` immediately after showed NO new message logged in the chat transcript beyond the pre-outage state (`پنل مدیریت`, 14:58) — and even if the click did register server-side, `هر دو (خرید و تمدید)` was already TEST_STORE_PRODUCT's existing, unchanged value for `نوع استفاده محصول` (never modified from its creation default). So this was, at worst, a no-op re-confirmation of the already-current value. Verified via a subsequent fresh Edit Product summary reprint that `نوع استفاده` still reads `هر دو (خرید و تمدید)` as before.

**Root cause**: Same class of issue as INCIDENT-003 — an old inline button remained visually present and clickable in the chat scrollback after a tool reconnect, and a coordinate click landed on it instead of empty background.

**Corrective action**: Reconfirmed the "fresh screenshot immediately before every click, same-turn coordinates" discipline; additionally, after any tool reconnect, the first interaction should be a `get_page_text` read (not a click) to establish state before touching the page at all.

## INCIDENT-006 — Unintended ❤️ reactions added to messages in the production bot chat

**What happened**: Over the course of this session, four ❤️ reactions appeared on messages in the
Zed Proxy chat — on the bot's own `جهت مدیریت و مشاهده تیکت از دکمه زیر استفاده نمایید.` message
(19:52), on the bot's Edit-Product summary message, on my own outgoing `🎛 تنظیم اینباند` message, and
on the bot's `محصولی که میخوای ویرایش کنی را انتخاب کن` message. None was intended.

**Root cause**: Telegram Web K adds a quick ❤️ reaction on a double-click anywhere on a message
bubble. Clicking a reply-keyboard button closes the keyboard on mouse-down, so the click can land on
the message bubble underneath; when a batched action sequence issues a second click shortly after,
the pair is registered as a double-click on that bubble.

**Impact**: None on any business entity — a reaction is chat metadata, not store data. No product,
category, panel, discount code, price, setting, user, order or payment was touched by it. It is,
however, visible to anyone with access to that chat, so it is logged rather than quietly ignored.

**Attempted correction**: clicking the reaction badge to toggle it off was tried twice on the 19:52
message; the badge opened the hover reaction-picker rather than removing the reaction, and the chat
auto-scrolled before it could be dismissed cleanly. Left in place rather than risking further stray
clicks. **The reactions are still there and should be removed by hand** (long-press / click the ❤️
badge on each of the four messages) — this is the only outstanding clean-up from this session.

**Corrective action adopted mid-session**: stop clicking reply-keyboard buttons altogether where
possible. With the exact button strings now recovered from the DOM (see `product-fields.md`), the
same navigation is done by **typing the exact button label as free text**, which never touches a
message bubble. Inline (message-attached) buttons still have to be clicked, but only once per turn,
with a wait after it.

## INCIDENT-007 — Third browser-tool outage (claude-in-chrome MCP server disconnected)

**What happened**: Immediately after the exact Edit-Product button strings were read out of the DOM
and the string `👤محدودیت کاربر` was typed into the composer, the `claude-in-chrome` MCP server
dropped (`Not connected`, and the server no longer appears in `RefreshMcpTools`). Same failure class
as INCIDENT-001 and INCIDENT-004.

**Impact assessment**: The last *confirmed* state change is CHANGE-019 (`🎛 تنظیم اینباند` →
`mirzabot_audit_test`, confirmed by `✅محصول بروزرسانی شد`). The `👤محدودیت کاربر` message was typed
but its send was not confirmed before the disconnect. Worst case, it was delivered and the bot is now
waiting for a user-limit value — which changes nothing until a value is sent. **The next session must
read the chat transcript before clicking anything**, exactly as after INCIDENT-004.

**Resolution**: Documentation for everything completed up to the disconnect was written to the
knowledge base immediately rather than held in memory; the user was told plainly what was blocked.

## INCIDENT-008 — TEST_STORE_PRODUCT's location was corrupted to `/al` and the product is now unreachable from the Telegram admin UI

**What happened**: While trying to satisfy the `/all` gate on `مخفی کردن پنل`, the string sent to
`موقعیت محصول` arrived at the bot as **`/al`** (one character short of `/all` — the composer dropped a
character). The bot **accepted it without any validation**, answered `✅ موقعیت محصول بروزرسانی شد`, and
the Edit-Product summary then read `📍 موقعیت: /al`.

**What made it worse**: every subsequent attempt to set the location back — free text
`TEST_MARZBAN_[PANEL_NAME_REDACTED]`, and the genuine reply-keyboard buttons `TEST_MARZBAN_[PANEL_NAME_REDACTED]` and
`🚀 مولتی لوکیشن` — each answered `✅ موقعیت محصول بروزرسانی شد` while the stored value stayed `/al`.

**Impact**: `TEST_STORE_PRODUCT` no longer appears under ANY location filter in `✏️ ویرایش محصول`.
Verified empty under `همه پنل ها`, `🚀 مولتی لوکیشن` and `TEST_MARZBAN_[PANEL_NAME_REDACTED]` (all with the
`نماینده پیشرفته` user-type filter, which is the product's own tier). The bulk-price tool's per-group
counters also report `0 محصول` for `TEST_MARZBAN_[PANEL_NAME_REDACTED]`, independently confirming the orphaning.

**Blast radius**: confined to the TEST product. It has sale-status `غیرفعال` and 0 sales, it is bound to
a test panel, and no production category, product, panel, discount code, order, payment, user or global
setting was touched. Nothing customer-facing is affected.

**Why it is being reported rather than fixed**: recovering it would require either the admin **web**
panel (`[VENDOR_ADMIN_HOST_REDACTED]`, a different phase, and an edit that has not been authorised) or a direct
database change. Neither is inside this phase's safety boundary, and the test record is explicitly not
to be deleted without the user's say-so. **It is left exactly as it is, pending the user's decision.**

**The genuine product finding underneath the incident** is recorded as SBR-028: the location edit path
has no input validation and silently accepts a value that permanently orphans the product. On a real
production product this would be a serious data-integrity bug — an admin could make a live product
invisible to the entire admin UI with one typo.

**Corrective action**: never send a free-text value to `موقعیت محصول`; always use the reply-keyboard
button. Where a value must be typed (`/all`), screenshot the composer to confirm the exact string
before pressing Enter.

## INCIDENT-009 — Further accidental ❤️ reactions, and a stray `/start`

**What happened**: (a) Two more ❤️ quick-reactions were added to bot messages by the same
click-through mechanism described in INCIDENT-006. (b) A click intended for the message composer landed
on the chat-list **search box**, so `👤محدودیت کاربر` was typed into search instead of the chat, and a
stray `/start` reached the bot. (c) `مخفی کردن پنل` was delivered three times, and `موقعیت محصول` was
once split into two messages (`موقعیت ` + `محصول`), because batched keystrokes raced the composer's
focus.

**Impact**: cosmetic and navigational only. `/start` merely reset the bot to its root menu; repeated
`مخفی کردن پنل` returned the same gate message each time; the split message was ignored by the bot. No
store, product, user, order or payment state was changed by any of it.

**Corrective action**: click the composer and take a screenshot to confirm focus and content before
pressing Enter, and send **one** message per batch rather than chaining several sends.

## Session 4 — no new incidents, one disclosed state side effect

Session 4 (the read-only sweep of custom-service pricing, both bulk-price tools, both delete pickers and
the customer purchase funnel) produced **no new incidents**. Nothing was written, and every walk was
ended with `/start` rather than left half-submitted.

One state side effect is disclosed rather than omitted: obtaining a custom-service price required the
bot to generate a **pre-invoice** (`💳 سفارش شما آماده پرداخت است`), so an unpaid order record may exist
in a pending state. No payment button was pressed, no wallet balance was spent, no gateway was opened,
and no service was provisioned. It is an abandoned checkout, nothing more.

### Note on classification

INCIDENT-008 describes what happened to `TEST_STORE_PRODUCT`'s location. The **cause** is a defect in
MirzaBot itself and is now tracked as **SOURCE_BUG-001** in `source-bugs.md`. The incident entry is kept
for the timeline, but the defect is not this investigation's doing: the bot accepted an invalid value
without validation, reported success, and then reported success three more times without persisting a
repair. A mistyped character is what triggered it; the missing validation is what made it permanent.

## No other incidents beyond the nine logged above

All other navigation this phase (menu traversal, category/product creation, sale-status toggle, first-purchase toggle, location reassignment, color field, discount-code creation, inbound field) proceeded as intended with no unintended state changes to any production entity.
