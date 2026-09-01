# Open Questions — Panel Management Phase

Format: ID / Question / Why It Matters / Current Evidence / Missing Evidence / Safe Verification Method / Approval Required / Priority

---

### UNK-P001 — ✅ RESOLVED 2026-08-30 (user decision + completed)
Question: To complete "تنظیم پروتکل و اینباند" (Configure Protocol & Inbound), MirzaBot's own instructions require creating a config directly inside the external Marzban panel and feeding its username back — conflicting with the user's earlier "نباید توی پنل بری" instruction.
Resolution: Asked the user directly via AskUserQuestion. **User answered: "اجازه دارم یک کانفیگ تستی بسازم"** (I'm allowed to create one test config) — i.e. proceed into the external panel ONE time, Zedweb account only, one lightweight test config. Executed exactly that: logged into [PANEL_HOST_REDACTED] as Zedweb (VERIFIED_BY_BOTH match against MirzaBot's own live stats — see protocol-inbound-config.md), created user `mirzabot_audit_test` (1GB/1day/Active), did not touch either pre-existing user, sent the username back to MirzaBot, received "✅ اینباند و پروتکل های شما با موفقیت تنظیم گردیدند." (success). TEST_MARZBAN_[PANEL_NAME_REDACTED]'s protocol/inbound gate is now cleared — see protocol-inbound-config.md for the full record.
Priority: RESOLVED — closed. (Downstream tabs that were waiting on this, e.g. test-account-behavior.md's live test, are now unblocked, though "ارسال کانفیگ" capability is still OFF — see panel-capabilities.md — so end-to-end config delivery is still not fully live yet.)

### UNK-P004 (new)
Question: Did "تنظیم پروتکل و اینباند" actually read and store `mirzabot_audit_test`'s real Marzban-assigned inbounds/protocols as the panel's template, or did it merely verify a user with that username exists (without inspecting its specific protocol/inbound set)?
Why It Matters: Determines whether the panel is now genuinely fully configured for config delivery, or only nominally so — affects how much confidence to place in PBR-002.
Current Evidence: Bot returned a flat, non-detailed success message with no echoed protocol/inbound list — VERIFIED_BY_TELEGRAM for "success reported", not VERIFIED for "which protocols were actually captured".
Missing Evidence: What protocol/transport an actual delivered config uses, once "ارسال کانفیگ" capability is turned on and a real config is fetched.
Safe Verification Method: Turn on "ارسال کانفیگ" (capability #5, currently OFF) and, if the user is comfortable extending the one-test-account authorization, request a config/subscription link for `mirzabot_audit_test` via whatever Telegram flow would apply, then compare its protocol/transport against the panel's 41-config list observed in protocol-inbound-config.md.
Approval Required: YES — extends the "one test config" authorization into an actual config-delivery test; not done without asking first.
Priority: LOW-MEDIUM — nice-to-have confirmation, not blocking the rest of the Panel Management inventory.

### UNK-P005 (new)
Question: Is Panel Management button #18 `اینباند اکانت غیرفعال` (Inactive-account inbound, a protocol-picker: vless/vmess/trojan/shadowsocks) actually the configuration screen tied to capability #15 `اکانت غیرفعال` (Inactive account, OFF by default in panel-capabilities.md)?
Why It Matters: If confirmed, this fully explains what "inactive account" handling does on this panel — redirect an expired/inactive user's inbound to a specific protocol rather than cutting them off — a genuinely new business rule (PBR-010) worth including in the final deliverables with confidence rather than as a guess.
Current Evidence: Naming match (both are exclusively about "inactive accounts"); both screens use nearly identical terminology (`اکانت غیرفعال` / `اینباند اکانت غیرفعال`). VERIFIED_BY_TELEGRAM for each screen's own prompt text, but the LINK between them is INFERRED only.
Missing Evidence: Actual runtime behavior — would require toggling capability #15 ON, picking a protocol at #18, expiring the one test user (`mirzabot_audit_test`), and observing what inbound it ends up on.
Safe Verification Method: Toggle capability #15 ON and set a protocol at #18 (both reversible, panel-scoped, low-risk config changes) — but confirming the actual runtime effect would require expiring the test account, which is a bigger step.
Approval Required: YES — expiring/manipulating the one authorized test account beyond its original purpose should be confirmed with the user first, consistent with UNK-P004's same caution.
Priority: LOW — a plausible, well-evidenced INFERENCE is enough for the final deliverables' confidence labeling; not required to unblock anything else.

### UNK-P002
Question: Why does the panel's live overview show only 2 total/active users, when the pre-existing authenticated `[PANEL_HOST_REDACTED]` browser session (different admin account, "[ADMIN_USERNAME_REDACTED] / ADMIN") showed 11,972+ users earlier this session?
Why It Matters: Could indicate MirzaBot's Marzban API credentials (Zedweb) are scoped to a different admin-visibility tier than the browser session's own login, or that they are simply two different Marzban "admin" accounts on the same panel with different sudo/visibility scope. Affects how much of the "real" panel this investigation is actually seeing through MirzaBot.
Current Evidence: Panel Management overview screen (VERIFIED_BY_TELEGRAM + VERIFIED_BY_MARZBAN, live data): total users = 2, active = 2. Earlier browser observation (this session, different sub-task): 11,972+ users under a different, unrelated login.
Missing Evidence: Direct comparison of the two admin accounts' scopes — not obtainable without going back into the external panel's UI/API, which is exactly the action item blocked by UNK-P001.
Safe Verification Method: n/a until UNK-P001 is resolved.
Approval Required: Bundled with UNK-P001.
Priority: MEDIUM (interesting/explanatory, not blocking).

### UNK-P003 — ✅ LIKELY RESOLVED (low priority, no further action)
Question: Is "پنل پاسارگارد" (mentioned in the parent brief as a capability to investigate) a toggle inside a Marzban-type panel's "وضعیت قابلیت ها پنل" (panel capability status) screen, or is it entirely unrelated to that — i.e. purely the separate top-level "پاسارگارد" panel TYPE seen in the Add-Panel type list (see add-panel-flow.md Step 1)?
Why It Matters: Resolves whether the brief's §15 interest in "پنل پاسارگارد" is even reachable from a Marzban-type test panel at all, or whether it would require creating a SECOND test panel of type پاسارگارد (out of scope — brief authorizes only ONE test panel).
Resolution: Opened `وضعیت قابلیت ها پنل` (all 15 toggles — see `panel-capabilities.md`) and, this pass, also `اینباند اکانت غیرفعال` (button #18) — neither contains anything named or resembling "پاسارگارد". Every one of the 25 Panel Management buttons has now been opened or intentionally skipped (رename and delete only), and none reference Pasargad. Working conclusion (INFERRED, not 100% provable without creating a second, out-of-scope پاسارگارد-type panel): "پنل پاسارگارد" in the brief refers exclusively to the separate top-level panel TYPE choice at Add-Panel Step 1, not to any setting reachable from within a Marzban-type panel's own management screen.
Priority: RESOLVED for this phase's purposes — downgraded from "next action item" since the full button inventory is now done and turned up nothing further.
