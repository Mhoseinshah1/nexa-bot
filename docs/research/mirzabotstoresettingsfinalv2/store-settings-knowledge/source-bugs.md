# MirzaBot Source-Bug Register (Store area)

A **SOURCE_BUG** is a defect in MirzaBot itself, reproducible by any admin using the bot normally.
An **INVESTIGATION_INCIDENT** is something this audit did (a mis-click, a tool outage, a stray message).
They are tracked separately on purpose: the incidents live in `incidents.md`, the bugs live here.
Nothing in this file is the investigation's fault.

---

## SOURCE_BUG-001 — Product location accepts an arbitrary unvalidated value, orphaning the product

**Severity: high.** Data-integrity defect with no admin-side recovery path.

**What happens**: the `موقعیت محصول` (product location) edit path performs **no validation** on the
value it receives. Sending the free-text string `/al` — one character short of the real `/all` command —
was accepted, answered with `✅ موقعیت محصول بروزرسانی شد`, and stored verbatim. The Edit-Product
summary then displays `📍 موقعیت: /al`.

**Why it is serious**: after that, the product matches **no** location filter. It disappears from
`✏️ ویرایش محصول` under every filter (`همه پنل ها`, `🚀 مولتی لوکیشن`, and the named panel — all verified
empty), and the bulk-price tool counts it as 0 products for that panel. And it cannot be repaired from
the bot: three further location changes — free text, and the genuine reply-keyboard buttons for both the
named panel and `🚀 مولتی لوکیشن` — each answered `✅ موقعیت محصول بروزرسانی شد` while the stored value
stayed `/al`.

**Net effect**: one typo permanently removes a product from the Telegram admin UI, and the bot reports
success at every step. On a live product this would silently orphan a real sellable item.

**Reproduced on**: `TEST_STORE_PRODUCT` (Inactive, 0 sales, test panel). No production entity affected.

**Recommended fix for the rebuild**: validate the location against the known set (panel ids plus the
`مولتی لوکیشن` / `تک لوکیشن - اختصاصی` / `/all` tokens), reject anything else, and make the
success message conditional on the write actually changing the row.

**Recorded as** SBR-028. Marked in this project's state files as
`TEST_PRODUCT_LOCATION_CORRUPTED_BY_SOURCE_BOT_VALIDATION_BUG`.

---

## SOURCE_BUG-002 — Success message printed when no change was persisted

**Severity: medium.** Closely related to SOURCE_BUG-001 but worth separating: the bot answers
`✅ موقعیت محصول بروزرسانی شد` even when the underlying value is unchanged. A confirmation that does not
reflect the stored state makes any admin UI untrustworthy, and it is the reason the corruption above
went three attempts before being detected.

---

## SOURCE_BUG-003 — Admin web panel's discount-code page never opens

**Severity: high** (carried forward from Phase 2, UNK-006). The discount-code CRUD screen on
`[VENDOR_ADMIN_HOST_REDACTED]` has never been opened successfully across repeated attempts in an earlier phase. This
is why the Telegram-side creation flow is the only place the real discount field structure has ever
been seen. Not re-tested this phase.

---

## Anomalies that are NOT bugs (recorded so nobody re-files them)

- **The Edit-Product summary omits several stored fields** (inbound, premium emoji, colour,
  first-purchase flag). Confusing, but consistent and presumably intentional.
- **The discount-code success summary echoes only 6 of the 10 captured fields** (SBR-022). Same class:
  poor feedback, not a defect.
- **`/all` is creation-time only** (SBR-027). Refused explicitly with a clear message, so this is a
  designed restriction, not a bug — though combined with SOURCE_BUG-001 it is what makes the corruption
  unrecoverable.
- **`رنگ محصول` and `تنظیم اینباند` are free-text where sibling fields are buttons.** An inconsistency
  in the UI, not a malfunction.
