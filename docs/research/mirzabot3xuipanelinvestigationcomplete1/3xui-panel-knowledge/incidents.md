# Investigation Incidents — 3X-UI phase

## No capability or setting was accidentally changed.

- No capability cell was pressed at any point.
- No value was submitted to any SETTER screen.
- No option was selected on either CHOICE screen (`روش تمدید سرویس`, `روش ساخت نام کاربری`).
- The composer was used **exactly three times**, all of them required steps of the authorized creation:
  the panel name, the panel address, the token. Nothing else was ever typed.

## INCIDENT-3XUI-NAV-001 — over-navigation (benign, no state change)

While backing out of `➕ قیمت حجم اضافه`, one `▶️ بازگشت به منوی قبل` press landed in the **Store
Settings** menu (`🏬 تنظیمات فروشگاه`) instead of the panel menu — the same back-stack quirk recorded in
the Marzban phase. Nothing was opened there and no value was sent; the session was re-navigated via
`🏠 بازگشت به منوی مدیریت` → `✏️ مدیریت پنل` → `TEST_3XUI_AUDIT`. The probe loop was then hardened to
verify it is on the 24-button panel keyboard before every step.

Impact: **none.** Recorded because the standing rule is to report navigation errors rather than hide them.

## Tooling note — browser bridge outage

The `claude-in-chrome` connection dropped after the last panel screen was captured and before the final
state-integrity re-read could be performed. See `../3xui-panel-state-integrity-check.md` for exactly
what was and was not re-verified.
