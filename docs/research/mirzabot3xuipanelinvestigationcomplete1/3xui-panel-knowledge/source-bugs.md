# Source Bugs / UX Risks — 3X-UI panel surface

Only defects actually observed. Nothing invented.

**SOURCE_BUG-XUI-001 — a panel pointing at a provably unreachable host is accepted silently.**
`https://test-3xui.invalid` (a reserved TLD that can never resolve) plus a non-credential token produced
`تبریک پنل شما با موفقیت اضافه گردید`. There is no reachability check, no auth check, and no warning at
any point in the wizard. Impact: an admin can typo a URL or paste a wrong token and believe the panel is
live; the failure only surfaces later, as a generic error, when the panel is opened.

**Mitigation (VERIFIED_BY_OWNER, code-only):** a background loop pings every panel every 3 minutes and
alerts the admin with `🚨 ادمین عزیز پنل با اسم <name> متصل نیست.` So the failure is caught within
~3 minutes rather than never. The defect stands — creation should not report success for a host it
never contacted — but it is a delayed-detection problem, not a silent one. See `panel-monitoring.md`.

**SOURCE_BUG-XUI-002 — the post-creation instructions name a control that does not exist.**
The note says to configure `تنظیم شناسه اینباند`. No button by that name exists; the actual control is
`⚙️ تنظیم پروتکل و اینباند`, and it asks for a **username**, not an ID.

**SOURCE_UX-RISK-XUI-001 — credential-shape mismatch.** 3X-UI is created with a `توکن` but its
management menu offers `🔐 ویرایش رمز عبور` ("edit password") and no token editor. Whichever way it is
implemented, the admin is shown the wrong noun for the value they are about to overwrite.

**SOURCE_UX-RISK-XUI-002 — `❌ خطایی رخ داده است کد خطا :  0` is uninformative.** It does not
distinguish DNS failure, timeout, bad token, or an HTTP error; it names neither the panel nor the URL;
it offers no retry. It also *replaces* the entire statistics block rather than appearing beside it, so a
single connectivity blip makes every live figure invisible at once.

**SOURCE_UX-RISK-XUI-003 — provider type is never displayed after creation.** Nothing on the panel
screen says this is a 3X-UI panel. With several panels of different providers, an admin cannot tell
which model's rules apply to the screen in front of them.

**SOURCE_UX-RISK-XUI-004 — enum screens do not show the current selection.**
`🔋 روش تمدید سرویس` (5 options) and `💡 روش ساخت نام کاربری` (8 options) both present a bare list.

**SOURCE_UX-RISK-XUI-005 — the hide and unhide screens are textually identical.** Both say
`📌آیدی عددی کاربر را برای این پنل را ارسال نمایید.` An admin who mis-taps has no way to tell from the
prompt whether they are about to hide or unhide, and there is no list view to check afterwards.

**SOURCE_UX-RISK-XUI-006 — the back stack is not hierarchical.** `▶️ بازگشت به منوی قبل` pressed on the
panel menu lands in Store Settings rather than the panel list.

**SOURCE_UX-RISK-XUI-007 — every setter is read-blind and overwrite-first.** Not one of the ~15 value
screens echoes its stored value, and none asks for confirmation. The only way to learn a panel's current
extra-volume price, account limit, trial size, colour, proxy or post-purchase guide is to overwrite it.
This is the single largest usability defect in the panel surface and it applies to Marzban equally.

**SOURCE_UX-RISK-XUI-008 — the token is transmitted and stored as plain visible chat text.** Telegram
offers no masked input for bot conversations, so the credential remains in the admin's message history.
Same class of exposure as the Marzban password step; recorded as a finding, with no value reproduced.

**SOURCE_UX-RISK-XUI-009 — capability cells toggle immediately with no confirmation.** Both cells in a
row are live callbacks, so a mis-tap on what looks like a status label flips production state, including
`🖥 نمایش پنل` and `⚙️ ارسال کانفیگ`.
