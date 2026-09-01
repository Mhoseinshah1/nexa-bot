# Panel Business Rules (PBR) Catalog — TEST_MARZBAN_[PANEL_NAME_REDACTED]

Consolidated from findings scattered across other files in this directory. Each entry cites its source file for full detail/evidence.

**PBR-001**: A newly-added panel is not functional for issuing configs until its protocol/inbound is configured via `تنظیم پروتکل و اینباند` (Panel Management button #7) — this is a hard functional dependency, not just a suggestion. Source: `add-panel-flow.md`, `protocol-inbound-config.md`.

**PBR-002**: `تنظیم پروتکل و اینباند` works by the admin supplying the USERNAME of a real, already-existing user on the underlying Marzban panel; MirzaBot appears to copy/infer that user's assigned inbound/protocol set as the panel-wide template for all future MirzaBot-issued configs on this panel. There is no manual protocol/inbound picker inside MirzaBot itself. Source: `protocol-inbound-config.md`.

**PBR-003**: Default service-renewal behavior (`روش تمدید سرویس`) on a new panel is "ریست حجم و زمان" (reset volume and time) — a renewal does NOT carry over unused quota unless the admin explicitly picks one of 4 alternative carry-over/rollover methods. Source: `events-behavior.md`.

**PBR-004**: MirzaBot supports connecting to a Marzban panel through a SOCKS proxy (`set proxy`, Panel Management button #16), explicitly surfaced for panels hosted inside Iran ("در صورتی که پنل که ایران دارید..."). Format `host:port:user:password`; send `1` to disable. Implies MirzaBot's own server is not itself hosted in Iran, or at minimum that direct connections from wherever MirzaBot runs to an Iran-hosted panel are not always reliable/possible without a SOCKS relay. Source: `general-settings.md`.

**PBR-005**: A panel becomes usable/visible to a real customer only when ALL of a 4-gate layered condition is met: (1) capability `نمایش پنل` is ON, (2) the customer's user group is included in the panel's `تغییر گروه کاربری` setting (or it is `all`), (3) the customer is not on the panel's per-user hidden list (`مخفی کردن پنل برای یک کاربر`), and (4) capability `ارسال کانفیگ` is ON for actual config delivery (a separate DELIVERY gate from the first three VISIBILITY gates). Source: `visibility-access.md`, `panel-capabilities.md`.

**PBR-006**: "لوکیشن" (location) in MirzaBot's internal data model means a PANEL, not a city/country. "تغییر لوکیشن" (location change) is a panel-to-panel service-migration feature — moving a customer's existing service from one panel to a different one — independently gated by a capability toggle (`تغییر لوکیشن`, OFF by default) and priced via `قیمت تغییر لوکیشن`. This resolves the earlier-phase `telegram-knowledge/unknowns.md` UNK-T004 contradiction. Source: `location-behavior.md`.

**PBR-007**: Username-generation (`روش ساخت نام کاربری`) has built-in collision handling regardless of which of the 8 generation methods is selected: if the admin's chosen text/word is already taken as a username, a random number is appended automatically. Default method is "نام کاربری دلخواه + عدد رندوم" (custom desired username + random number). Source: `events-behavior.md`.

**PBR-008**: Test-account trial parameters are set independently in TIME (hours, via `زمان سرویس تست`) and DATA (megabytes, via `حجم اکانت تست`), separate from whether a trial is offered at all (capability `نمایش تست`, OFF by default) and separate from first-connection tracking for trial accounts (capability `اولین اتصال اکانت تست`, ON by default). Source: `test-account-behavior.md`, `panel-capabilities.md`.

**PBR-009**: Extra-capacity pricing (volume top-ups, time top-ups, and additional-user surcharges) is fully per-panel — `قیمت حجم اضافه`, `قیمت زمان اضافه`, and `قیمت هر کاربر` are three independent free-text pricing fields, each explicitly scoped "برای این پنل" (for this panel), confirming different panels can carry entirely different surcharge structures. Source: `subscription-config.md`.

**PBR-010** (INFERRED, not confirmed): Capability #15 `اکانت غیرفعال` (Inactive account) is likely gated together with Panel Management button #18 `اینباند اکانت غیرفعال`, where the admin picks which protocol (vless/vmess/trojan/shadowsocks) an inactive/expired account gets redirected to, rather than being cut off outright. Not independently confirmed since neither the capability nor the protocol pick was actually submitted. Source: `panel-capabilities.md` (UNK-P005).
