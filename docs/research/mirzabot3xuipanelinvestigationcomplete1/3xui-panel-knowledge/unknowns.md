# 3X-UI Panel — Remaining UNKNOWNs

| ID | Question | Why unresolved | Priority |
|---|---|---|---|
| UNK-XUI-001 | Does `❌ حذف پنل` show a pre-confirmation screen for 3X-UI, or delete on press? | Deliberately not pressed — TEST_3XUI_AUDIT must survive, and the standing rule is to assume a button acts rather than opens | HIGH (rebuild must decide its own confirm UX) |
| UNK-XUI-002 | Does `🔐 ویرایش رمز عبور` write the same stored value the creation wizard called `توکن`, or a dead separate column? | Would require submitting a credential value — forbidden | HIGH |
| UNK-XUI-003 | What is the panel's current `گروه کاربری`? | Normally shown in the overview block, which failed with error code 0; the setter does not echo the current value | MEDIUM (defaults presumed `all` by Marzban parity) |
| UNK-XUI-004 | Does editing the address/token trigger an immediate reconnection test? | No value submitted | MEDIUM |
| UNK-XUI-005 | What happens when `⚙️ تنظیم پروتکل و اینباند` is given a username while the panel is unreachable — reject, generic error, or blind accept? | No value submitted; panel unreachable | MEDIUM |
| UNK-XUI-006 | Which renewal method and which username-generation method are currently selected? | Neither screen indicates a current selection | MEDIUM |
| UNK-XUI-007 | Where does the per-service user/device NUMBER come from, given `🚫 محدودیت کاربر` is only on/off? | No numeric field exists at panel level; likely product-level or global | MEDIUM |
| UNK-XUI-008 | Current SOCKS proxy value / enabled state for this panel | Prompt shows only the format, never the stored value | LOW |
| UNK-XUI-009 | Current values of all four pricing fields, the account limit, trial hours, trial MB, panel colour and post-purchase guide | **No SETTER in the entire panel menu echoes its current value.** The only way to read one is to overwrite it | MEDIUM (systemic) |
| UNK-XUI-010 | Exact 3x-ui API surface the Bot Agent uses, and what the `توکن` authenticates against | Not observable from the Telegram UI; the panel is unreachable | MEDIUM |
| UNK-XUI-011 | Would TEST_3XUI_AUDIT appear as a placement option in Store product creation? | Checking requires entering product creation — forbidden. Note capability `نمایش پنل` is OFF, so on the four-gate model it should not | LOW |
| UNK-XUI-012 | Is a customer purchase automatically blocked, and is the panel auto-hidden, when the panel is unreachable? | **PARTIALLY RESOLVED** — the owner confirms a 3-minute ping loop that *alerts* the admin (XUI-BR-016). Nothing indicates it hides the panel or blocks purchases automatically; that part remains untested | MEDIUM |
| UNK-XUI-013 | Are `🚫 محدودیت کاربر پنل` and `👤 خرید کاربر اضافه` genuinely 3X-UI-only, or bot-version additions that Marzban now also has? | The Marzban capture predates bot 7.5.10; re-reading a Marzban panel's capability board today would settle it | MEDIUM |
| UNK-XUI-014 | Does MirzaBot ever surface the provider type of an existing panel anywhere in the admin UI? | Not found on any screen visited | LOW |
| UNK-XUI-015 | What does error `کد خطا : 0` actually distinguish (DNS vs timeout vs auth vs HTTP status)? | The message carries no detail | MEDIUM |
| UNK-XUI-016 | Where is the `🚨 … متصل نیست` alert delivered, and does the 3-minute loop skip panels that are hidden / have never connected / already alerted? | The owner confirms the loop exists in code; no alert reached the admin DM in ~9 cycles after creating an unreachable panel. Most likely delivered to the `📣 گزارشات ربات` supergroup | MEDIUM |
| UNK-XUI-017 | Is the 3-minute interval fixed, and is there any de-duplication / back-off for a panel that stays down? | Not exposed in any UI; code-only | MEDIUM |
