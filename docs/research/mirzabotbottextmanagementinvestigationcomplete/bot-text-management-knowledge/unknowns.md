# Unknown register — Bot Text Management

Statuses: `OPEN` · `PARTIALLY_RESOLVED` · `RESOLVED` · `NOT_EXPOSED` · `OUT_OF_SCOPE`

### UNK-TXT-001 — The greeting's bare `?`  → **RESOLVED**
- **Answer (owner-confirmed, 1 Sep 2026):** the `?` is the **display name of the Telegram account
  performing this audit**. `{first_name}` was resolved live by the bot when it echoed the template.
- **Therefore:** the greeting is **not** broken; the placeholder works. What is actually true — and
  more consequential — is that **`متن فعلی` shows the RENDERED text, not the raw template**, for any
  variable that resolves in the editing admin's context.
- **New consequences recorded:** TBR-TXT-004 (revised), TBR-TXT-013, SOURCE_UX-RISK-TEXT-012.
- **Status:** **RESOLVED.**

### UNK-TXT-012 — Which variables resolve in admin context during the echo?
- **Evidence:** `{first_name}` demonstrably resolves. Service-scoped tokens (`{username}`, `{config}`,
  `{price}`, `{volume}`, …) demonstrably do **not** — they echo as literal braces.
- **Missing:** whether `{last_name}`, `{time}` and `{version}` also resolve, and whether any other
  template besides the start text is affected.
- **Safe verification:** compare the Telegram echo of a given template with the same string's raw
  value in the Web panel's `/settings/text/` textarea. Read-only on both sides.
- **Priority:** P2 — it decides how much of the echo can be trusted as a source of truth.
- **Status:** PARTIALLY_RESOLVED.

### UNK-TXT-002 — Is HTML supported in these templates?
- **Evidence:** the Web page's help text says `<b>` and HTML must be preserved. Telegram mentions no
  formatting and none of the 20 templates read contains a tag.
- **Missing:** a Telegram-side statement, or a template that uses one.
- **Safe verification:** read a Web string that contains a tag and check whether the same template is
  in Telegram's 36; or read the source.
- **Priority:** P1 for a rebuild's renderer. **Status:** OPEN.

### UNK-TXT-003 — Is there a length limit, and what happens past it?
- **Evidence:** the Web shows `n/8192`; Telegram shows nothing. Telegram's own 4096-char message limit
  would bite first for a single-message send.
- **Safe verification:** source. Do **not** probe by sending a long string.
- **Priority:** P2. **Status:** OPEN.

### UNK-TXT-004 — Where are the other seven cron message bodies edited?
- **Evidence:** eight crons exist; only `متن کرون تست` is here. The Web has a `cron(11)` group.
- **Missing:** confirmation that the Web `cron` group holds the expiry-warning, on-hold, volume,
  deletion and inactivity messages.
- **Safe verification:** open `/settings/text/` → `cron` and read the 11 keys. Read-only.
- **Priority:** **P1** — these messages go to customers today and cannot be changed from Telegram.
- **Status:** OPEN, cheaply closable.

### UNK-TXT-005 — How do the 36 Telegram labels map to Web `group.Key` identifiers?
- **Evidence:** both surfaces edit customer copy; the Web log verb `ویرایش متن‌های ربات` exists.
- **Missing:** any shared identifier. Telegram never shows a key.
- **Safe verification:** compare a distinctive current value (e.g. the bot-off notice) against the Web
  search box; matching bodies would establish the mapping without any write.
- **Priority:** **P1** for the rebuild's catalogue. **Status:** OPEN.

### UNK-TXT-006 — Why does the WGDashboard delivery template omit `{config}`?
- **Evidence:** every other delivery template includes a connection link; BTX-023 does not.
- **Missing:** whether WireGuard configs are delivered by a separate message or file.
- **Safe verification:** source, or a WG panel in a clone.
- **Priority:** P2. **Status:** OPEN.

### UNK-TXT-007 — Does saving actually happen on the next message, with no confirmation?
- **Evidence:** the flow has no Save button and the prompt asks for the new text directly; this
  matches the value-capture contract documented product-wide (CBR-012).
- **Missing:** the actual behaviour — **deliberately never tested**.
- **Safe verification:** a clone bot. **Never on production.**
- **Priority:** P1 for operators. **Status:** OPEN, intentionally.

### UNK-TXT-008 — Is there any reset / restore-default in Telegram?
- **Evidence:** none found on any of the 36 items or on the section screen. The Web panel has both
  «بازگردانی» and «نمایش پیش‌فرض», and the Web log vocabulary contains
  `بازگردانی متن‌های ربات به پیش‌فرض`.
- **Status:** **NOT_EXPOSED** in Telegram — a feature absence, not an open question. (Which is a
  safety *benefit*: the one-tap mass reset is not reachable from the phone.)

### UNK-TXT-009 — Are these templates per-bot or shared across reseller sub-bots?
- **Evidence:** reseller sub-bots exist; this section shows no scope selector.
- **Safe verification:** open a reseller sub-bot's own text section and compare a value.
- **Priority:** P2. **Status:** OPEN.

### UNK-TXT-010 — Do the 16 un-probed items differ structurally?
- **Evidence:** 20 of 36 probed, covering every label pattern (button caption, description, delivery,
  invoice, payment, warning, cron, gate). All 20 used the identical component.
- **Missing:** the 16 remaining bodies and their placeholder lists.
- **Safe verification:** probe them the same way — safe, read-only, ~30 seconds each.
- **Priority:** P3 — structure is settled; only content is missing.
- **Status:** PARTIALLY_RESOLVED.

### UNK-TXT-011 — Are admin-facing or report-group templates editable anywhere?
- **Evidence:** all 36 items are customer-facing. Nothing here writes to the notification group
  configured by `📣 گزارشات ربات`.
- **Status:** **NOT_EXPOSED** in Telegram. The Web's `users(608)` group is the likely home.
