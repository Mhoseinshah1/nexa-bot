# Marzban ↔ 3X-UI Panel Crossmap

Baseline for Marzban: `panel-management-knowledge/` (TEST_MARZBAN_[PANEL_NAME_REDACTED], captured at an earlier
bot version). Baseline for 3X-UI: this directory (TEST_3XUI_AUDIT, bot 7.5.10).

⚠️ **Version caveat:** the two captures are from different bot versions, so a few deltas below could be
version drift rather than provider difference. Rows where that is a live risk are marked
`(version-ambiguous)`.

| Area | Marzban | 3X-UI | Verdict | Evidence |
|---|---|---|---|---|
| **Creation fields** | type, name, URL, **username**, **password** (5 steps) | type, name, URL, **token** (4 steps) | **DIFFERENT** | `creation-flow.md` |
| URL format rules | 4 stated rules | **identical 4 rules, identical wording** | SAME | verbatim prompts |
| Creation-time validation | none observed | **none — provably none** (`.invalid` host accepted) | SAME | XUI-BR-002 |
| Post-creation activation note | 1 gate: `تنظیم پروتکل و اینباند`; wording "config will not be GIVEN" | 2 gates: `تنظیم شناسه اینباند` + `دامنه لینک ساب`; wording "config will not be BUILT" | **DIFFERENT** | `creation-flow.md` |
| **Connection model** | username + password login | single opaque token | **DIFFERENT** | `connection-settings.md` |
| Edit username screen | `👤 ویرایش نام کاربری` present | **absent** | MARZBAN_ONLY | menu inventory |
| Edit password screen | `🔒 ویرایش رمز عبور` | `🔐 ویرایش رمز عبور` present **despite no password being collected** | SAME (present) / semantics UNKNOWN | UNK-XUI-002 |
| Edit address screen | present | present, same prompt | SAME | |
| Connection status display | live block: `✅ پنل متصل است` + users/version/RAM/traffic/sales/group | **none — replaced by `❌ خطایی رخ داده است کد خطا :  0`** | DIFFERENT *(but confounded: the Marzban panel was reachable and this one is not — the difference may be reachability, not provider)* | `panel-profile.md` |
| Explicit connection-test button | absent | absent | SAME | |
| **Capabilities count** | 15 | 16 | DIFFERENT (version-ambiguous) | `capabilities.md` |
| `محدودیت کاربر پنل` | absent | present | 3XUI_ONLY (version-ambiguous) | |
| `خرید کاربر اضافه` | absent | present | 3XUI_ONLY (version-ambiguous) | |
| `اکانت غیرفعال` capability | present | **absent** | MARZBAN_ONLY | XUI-BR-009 |
| `⚙️ اینباند اکانت غیرفعال` screen | present | **absent** | MARZBAN_ONLY | menu inventory |
| Default capability states | 11 OFF / 4 ON; same 4 ON | 12 OFF / 4 ON; **the same four ON** | SAME (the ON set is identical) | `capability-baseline.md` |
| Capability control style | inline toggle board | inline toggle board, 2 cells per row | SAME | |
| **Inbound / protocol** | name an existing panel user; no picker | **name an existing panel client; no picker — same prompt** | SAME | `inbound-protocol-settings.md` |
| Protocol enum exposed | no (a separate `اینباند اکانت غیرفعال` screen did offer vless/vmess/trojan/shadowsocks) | **no such screen at all** | MARZBAN_ONLY | |
| **Subscription-link domain** | not required (same origin as the panel) | **`🔗 دامنه لینک ساب` required** | **3XUI_ONLY** | `3xui-specific-settings.md` |
| **Username/client naming** | 8 methods + collision suffix | **identical 8 methods, identical notes** | SAME | `service-settings.md` |
| Client email / UUID / subId / flow | not exposed | not exposed | SAME | |
| **Renewal** | 5 methods | **identical 5 methods** | SAME | |
| Current-selection indicator on renewal/username | highlighted per the Marzban notes | **no indicator observed** | DIFFERENT (low confidence — may be a capture difference) | UNK-XUI-006 |
| **Account limit** | numeric or `unlimited` | numeric or `unlimited`, same prompt | SAME | |
| Device / IP limit numeric field | not exposed | not exposed | SAME | |
| **Pricing** (extra volume / time / user / location) | 4 fields, no units, no current value | **identical 4 fields, identical prompts** | SAME | `pricing-settings.md` |
| **Trial** (hours + megabytes) | present | **identical** | SAME | `trial-settings.md` |
| **Visibility** four-gate model | present | **identical** | SAME | `visibility-settings.md` |
| **User groups** f/n/n2/all | free text | **identical prompt** | SAME | |
| Per-user hide / unhide pair | present, identical prompts | **present, identical prompts** | SAME | |
| **SOCKS proxy** | `🔗 set proxy`, `host:port:user:password`, `1` disables | **identical** | SAME | `advanced-settings.md` |
| **Location migration** | capability + inbound price | **identical** | SAME | |
| **Cosmetics** — panel color | 4 style words | **4 style words, free text (no buttons)** | SAME (the Marzban note's "single-select" reading is corrected here) | `menu-tree.md` XUI-MENU-018 |
| **Post-purchase guide** | photo/text/file, `0` disables | **identical** | SAME | |
| **Rename** | free-text prompt | free-text prompt | SAME | |
| **Delete** | button present, never opened | button present, **never opened** | SAME (both untested) | UNK-XUI-001 |
| **Menu size** | 25 buttons | 24 buttons | DIFFERENT | |
| Panel selection model | recorded as search-by-name | **button list** (and this is the true model for both) | SAME — prior record corrected | XUI-BR-010 |

## Summary counts

- SAME: 24 rows
- DIFFERENT: 7 rows (2 of them version-ambiguous, 1 confounded by reachability)
- 3XUI_ONLY: 3 rows (1 firm — `دامنه لینک ساب`; 2 version-ambiguous)
- MARZBAN_ONLY: 3 rows (edit-username, inactive-account capability, inactive-account inbound)
- UNKNOWN: the semantics of `🔐 ویرایش رمز عبور` on 3X-UI

## The honest headline

**3X-UI is not a separate feature model — it is the same panel model with a different credential shape
and one extra required field.** Everything about pricing, trials, renewal, visibility, user groups,
naming, limits, proxy, migration and cosmetics is byte-for-byte the same surface. The genuine
provider-specific facts are: (1) token instead of username+password, (2) a required subscription-link
domain, (3) no inactive-account handling.
