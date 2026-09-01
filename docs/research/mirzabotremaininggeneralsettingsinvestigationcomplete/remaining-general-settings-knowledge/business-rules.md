# Business rules (RGS-BR-###)

## RGS-BR-001 — Three of the seven "settings" are immediate actions, not settings
- **Rule:** `⛏️تنظیم کامند ربات`, `🔄 آپدیت همگانی ربات های نماینده` and
  `🔗 وبهوک مجدد ربات های نماینده` execute the moment they are pressed — no screen, no prompt, no
  confirmation, no preview, no target count.
- **Section:** General Settings · **Scope:** bot-wide / all reseller bots
- **Evidence:** all three answered with a result message immediately on press.
- **Security effect:** they are visually indistinguishable from the value prompts beside them, so an
  admin browsing the menu triggers production maintenance by looking.
- **Confidence:** VERIFIED_BY_UI.

## RGS-BR-002 — Bot commands are hard-coded; the section only re-publishes them
- **Rule:** `⛏️تنظیم کامند ربات` exposes no command list, labels, descriptions, scope or mapping. It
  registers the product's built-in commands with Telegram and tells the admin to close and reopen the
  chat for the client to refresh.
- **Evidence:** `✅ کامند های ربات تنظیم گردید برای استفاده یکبار از صفحه ربات خارج و مجددا وارد ربات شوید.`
- **Effect:** it is a repair tool, not configuration. A rebuild that models "configurable commands"
  would be inventing a feature MirzaBot does not have.
- **Confidence:** VERIFIED_BY_UI (the absence); the `setMyCommands` mechanism is STRONGLY_INFERRED.

## RGS-BR-003 — The global start gift is a wallet credit, currently 25,000 Toman, and `0` disables it
- **Rule:** `💝 هدیه استارت` sets `مبلغ هدیه شروع ربات`; the prompt states `(0 = غیرفعال)` and echoes
  `مبلغ فعلی : 25000`.
- **Evidence:** the prompt, verbatim; plus Robot Statistics, which lists `هدیه شروع` as a wallet
  top-up source alongside real payment gateways.
- **Effect:** every new user is credited 25,000 Toman on arrival, and that spend is tracked as a
  funding source in the financial reports.
- **Confidence:** VERIFIED_BY_UI (value and `0` semantics); wallet-credit nature VERIFIED via the
  statistics line item.

## RGS-BR-004 — The global start gift is NOT the referral start gift
- **Rule:** `💝 هدیه استارت` (global signup credit) and `🌟 مبلغ هدیه استارت` (per-referral payment to
  the **referrer**, inside the `🎁 زیرمجموعه` settings) are different settings on different screens
  with different recipients. A third control, `🎁 هدیه استارت` in the same referral submenu, is a
  probable toggle and was never pressed.
- **Evidence:** the two prompts, verbatim, captured in this phase and the Bot Capabilities phase.
- **Effect:** a referred signup may cost the shop **twice** — the global gift to the newcomer and the
  per-referral amount to the referrer.
- **Confidence:** VERIFIED (that they are distinct); the third control's function is UNKNOWN.

## RGS-BR-005 — Reseller membership is priced as a paid *request*
- **Rule:** `💰 مبلغ عضویت نمایندگی` sets `قیمت درخواست عضویت برای نمایندگی` — the price attached to
  applying for reseller status, paired with the customer-side `👨‍💻 درخواست نمایندگی` button and a
  free-text justification.
- **Evidence:** the prompt, plus the customer-side request button and description text captured in the
  Bot Text phase.
- **Not established:** the amount (never shown), which tier transition it buys, whether an admin still
  approves, and whether it recurs.
- **Confidence:** STRONGLY_INFERRED.

## RGS-BR-006 — Resellers must buy ≥ 1,000,000 Toman per month or lose reseller status
- **Rule:** `📊 کف خرید ماهانه نمایندگی` is **enabled**. A `نماینده عادی` who does not reach
  **1,000,000 تومان** of payment in a month is **removed from reseller status**. `نماینده پیشرفته`
  has a floor of **0**, i.e. no requirement. A warning is sent **3 days** before month end.
- **Evidence:** the panel text and its three displayed values, verbatim.
- **Confidence:** VERIFIED_BY_UI.

## RGS-BR-007 — Demotion stops the reseller's sales bot but does not delete it
- **Rule:** `در صورت خروج نماینده، ربات فروش او (در صورت وجود) نیز متوقف می شود (حذف نمی شود)`.
- **Effect:** the bot and its token survive; the reseller can presumably be reinstated without
  rebuilding. A rebuild must model "stopped" as a distinct state from "deleted".
- **Confidence:** VERIFIED_BY_UI (stated by the bot).

## RGS-BR-008 — Reseller expiry and the monthly floor are independent policies
- **Rule:** `⏱️ زمان انقضا نمایندگی` (per-user, date-based, User Management) and this monthly floor
  (bot-wide, amount-based) are separate mechanisms on separate surfaces with different units.
- **Evidence:** both observed; neither references the other.
- **Confidence:** VERIFIED (independence); whether demotion also clears the expiry is UNKNOWN.

## RGS-BR-009 — This deployment has zero reseller bots
- **Rule:** both bulk maintenance actions answered `❌ رباتی وجود ندارد`.
- **Evidence:** two independent executions, 04:51 and 04:52. Corroborated by the Web-Admin phase,
  which found the reseller-bot list empty while two reseller-panel entitlements existed.
- **Effect:** the reseller-bot subsystem is provisioned but unused. Its runtime behaviour could not be
  observed and is not claimed.
- **Confidence:** VERIFIED.

## RGS-BR-010 — The two bulk actions are separate operations
- **Rule:** update and webhook-reset are distinct buttons that each evaluate the reseller-bot set
  independently.
- **Evidence:** two presses, two independent responses.
- **Effect:** do not assume the update re-points webhooks. Whether it does internally is UNKNOWN.
- **Confidence:** VERIFIED (they are separate controls); the internal dependency is UNKNOWN.
