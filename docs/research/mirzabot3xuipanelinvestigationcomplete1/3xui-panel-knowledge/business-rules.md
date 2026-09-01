# 3X-UI Panel Business Rules (XUI-BR)

**XUI-BR-001**
- Rule: A 3X-UI panel is created from exactly four inputs — provider type, name, address, **token**.
- Scope: Add Panel, provider `3x-ui`
- Setting: creation wizard
- Precondition: admin is in `🖥 اضافه کردن پنل`
- Effect: a panel record is persisted
- Evidence: `creation-flow.md` (steps 1–5, verbatim prompts)
- Confidence: VERIFIED_BY_UI

**XUI-BR-002**
- Rule: MirzaBot performs **no connection validation at creation time** for a 3X-UI panel. A record is
  created for a host that cannot resolve, with a credential that is not a credential.
- Scope: Add Panel
- Precondition: any syntactically-plausible URL and any non-empty token
- Effect: `تبریک پنل شما با موفقیت اضافه گردید`
- Evidence: `https://test-3xui.invalid` + `audit_test_token` accepted with no delay; panel appears in the list
- Confidence: VERIFIED_BY_UI

**XUI-BR-003**
- Rule: The live panel check happens at **panel-open time**, not at creation time. Opening an
  unreachable panel returns `❌ خطایی رخ داده است کد خطا :  0` **in place of** the entire statistics /
  connection-status block, while the management menu still opens normally.
- Scope: `✏️ مدیریت پنل` → panel selection
- Effect: administration remains fully possible on a dead panel; connection status is unreadable
- Evidence: `panel-profile.md`
- Confidence: VERIFIED_BY_UI

**XUI-BR-004**
- Rule: A new 3X-UI panel has **two activation gates**: an inbound/protocol template
  (`⚙️ تنظیم پروتکل و اینباند`) and a subscription-link domain (`🔗 دامنه لینک ساب`). Without both,
  `کانفیگ ساخته نخواهد شد` — no config is built.
- Scope: panel lifecycle
- Evidence: post-creation note, verbatim, `creation-flow.md`
- Confidence: VERIFIED_BY_UI (the rule as stated by the bot); NOT_TESTED (its runtime enforcement)

**XUI-BR-005**
- Rule: The inbound/protocol template is set by **naming an existing client on the 3X-UI panel**, not by
  choosing an inbound ID, a protocol, or a port. MirzaBot exposes no protocol picker at all.
- Scope: `⚙️ تنظیم پروتکل و اینباند`
- Evidence: `inbound-protocol-settings.md`, verbatim prompt
- Confidence: VERIFIED_BY_UI

**XUI-BR-006**
- Rule: For 3X-UI the customer subscription URL is **not derived from the panel address**. The admin
  supplies a sample subscription link and MirzaBot infers the domain from it.
- Scope: `🔗 دامنه لینک ساب`
- Evidence: verbatim prompt referencing `پنل ثنایی` (Sanaei / 3x-ui)
- Confidence: VERIFIED_BY_UI (control) / STRONGLY_INFERRED (mechanism)

**XUI-BR-007**
- Rule: A brand-new 3X-UI panel ships with 16 capabilities, **12 OFF / 4 ON**; the ON set is
  `ارسال لینک اشتراک`, `دکمه کانفیگ در سرویس`, `دکمه لینک ساب در سرویس`, `اولین اتصال اکانت تست`.
  Both visibility (`نمایش پنل`) and delivery (`ارسال کانفیگ`) are OFF, so a new panel is inert.
- Scope: `⚙️ وضعیت قابلیت ها پنل`
- Evidence: `capability-baseline.md`
- Confidence: VERIFIED_BY_UI

**XUI-BR-008**
- Rule: Capability cells are **immediate toggles with no confirmation** — the state cell and the label
  cell are both callback buttons and either one flips the capability.
- Scope: capability board
- Evidence: inline-keyboard structure (16 rows × 2 callback cells); not exercised
- Confidence: STRONGLY_INFERRED (structure + Marzban-phase parity); NOT_TESTED by design

**XUI-BR-009**
- Rule: 3X-UI does **not** expose inactive-account handling. Neither the `اکانت غیرفعال` capability nor
  the `⚙️ اینباند اکانت غیرفعال` screen exists, unlike Marzban.
- Scope: panel feature surface
- Evidence: 24-button menu inventory; 16-capability board
- Confidence: VERIFIED_BY_UI (absence)

**XUI-BR-010**
- Rule: Panel selection is **button-based**: `✏️ مدیریت پنل` renders every panel as a reply-keyboard
  button. (Corrects the earlier "search-by-exact-name only" record.)
- Scope: panel management entry
- Evidence: `panel-profile.md`
- Confidence: VERIFIED_BY_UI

**XUI-BR-011**
- Rule: Every per-panel SETTER overwrites blindly — no screen echoes its current value, none asks for
  confirmation, and the next ordinary message is consumed as the new value.
- Scope: all 15 SETTER screens
- Evidence: `menu-tree.md`
- Confidence: VERIFIED_BY_UI

**XUI-BR-012**
- Rule: `📍 تغییر گروه کاربری` accepts a comma-separated subset of `f,n,n2` or the literal `all`, typed
  as free text (not a picker).
- Scope: visibility
- Evidence: verbatim prompt
- Confidence: VERIFIED_BY_UI

**XUI-BR-013**
- Rule: Trial parameters are per-panel and split by unit — duration in **hours**, volume in **megabytes**
  — and are independent of whether a trial is offered (`🎁 نمایش تست`).
- Scope: trial
- Evidence: `trial-settings.md`
- Confidence: VERIFIED_BY_UI

**XUI-BR-014**
- Rule: Renewal offers the same five mutually-exclusive strategies as Marzban; there is no
  provider-specific renewal behaviour and no "recreate user" option.
- Scope: renewal
- Evidence: `service-settings.md`
- Confidence: VERIFIED_BY_UI

**XUI-BR-015**
- Rule: Device/IP limiting is **abstracted away**. MirzaBot exposes an on/off `محدودیت کاربر` capability
  and a purchasable-extra-user model, but no numeric IP/device field, even though 3x-ui has a native one.
- Scope: limits
- Evidence: `service-settings.md`
- Confidence: VERIFIED_BY_UI (absence) / INFERRED (interpretation)

**XUI-BR-016** — *(source: VERIFIED_BY_OWNER; NOT_EXPOSED in the admin UI)*
- Rule: MirzaBot runs a background health loop that **pings every registered panel every 3 minutes** and,
  when a panel is unreachable, sends an admin alert:
  `🚨 ادمین عزیز پنل با اسم <panel name> متصل نیست.`
- Scope: all panels, all providers — not 3X-UI-specific
- Setting/Capability: **none.** The interval, the enable state, the recipient and the message are not
  configurable or visible anywhere in the admin surface; the owner confirms it lives only in the code.
- Precondition: a panel record exists and the ping fails
- Effect: an admin-facing alert naming the panel
- Evidence: owner statement (authoritative). Not observed in the admin DM during ~9 cycles after
  creating an unreachable panel — see `panel-monitoring.md` for the delivery-destination analysis.
- Confidence: VERIFIED_BY_OWNER (the rule) · STRONGLY_INFERRED (delivery to the `📣 گزارشات ربات` group)
- Consequence: this is the mechanism that actually catches the bad panels that XUI-BR-002 lets through.
