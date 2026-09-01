# Business rules — Admin Management (ABR-###)

## ABR-001 — An admin is a (numeric Telegram id, role) pair and nothing else
- **Rule:** the admin record has exactly two attributes. No username, name, status, expiry, notes,
  scope, creator or timestamp.
- **Evidence:** the add flow asks for two things; the list displays two things; no other screen exists.
- **Scope:** all admins. **Precondition:** none. **Action:** create. **Result:** a 2-field record.
- **Security effect:** there is no way to answer "who added this admin and when?" from the product.
- **Confidence:** VERIFIED_BY_UI.

## ABR-002 — Admin identity is the Telegram NUMERIC id, never a username
- **Rule:** creation asks `آیدی عددی ادمین جدید را ارسال نمایید`; the list renders the numeric id.
  `@username` is never requested, stored or displayed.
- **Evidence:** the prompt and the list rows, verbatim.
- **Security effect:** good — numeric ids are stable and cannot be transferred by releasing a
  username. The Web panel's admin log keys by *username* instead, which is the weaker identifier and
  does not join to this one (see `admin-log-crossmap.md`).
- **Confidence:** VERIFIED_BY_UI.

## ABR-003 — Exactly four roles exist on the Telegram side
- **Rule:** `👑 مدیر کل` · `🛒 فروشنده` · `🎧 پشتیبان` · `🧾 تأییدکنندهٔ رسید`.
- **Evidence:** the section legend and the creation keyboard, which agree exactly.
- **Scope:** Telegram admin surface. **Note:** the Web panel documents seven differently-named roles.
- **Confidence:** VERIFIED_BY_UI.

## ABR-004 — Role is mandatory at creation and there is no default
- **Rule:** creation cannot complete without pressing one of the four role buttons; nothing is
  pre-selected and no role is applied implicitly.
- **Evidence:** step 2 of the create flow.
- **Security effect:** positive in principle — no accidental privilege from a default. But the
  full-access role is the **first** button, which is the least safe ordering (see ADM-003).
- **Confidence:** VERIFIED_BY_UI.

## ABR-005 — The role can never be changed
- **Rule:** there is no edit path. The row label is inert, and re-adding the id does not update it.
- **Evidence:** direct test — `🧾 تأییدکنندهٔ رسید` → attempted `🎧 پشتیبان` → role unchanged, twice
  re-verified from freshly generated list messages.
- **Result:** changing a role requires **delete + re-create**.
- **Security effect:** demotion is impossible without a window in which the person is not an admin,
  and the only demotion path runs through an unconfirmed delete button.
- **Confidence:** VERIFIED_BY_UI.

## ABR-006 — Re-adding an existing admin is a silent no-op that reports success
- **Rule:** submitting an already-admin numeric id proceeds through the whole flow and answers
  `🥳 ادمین با موفقیت اضافه گردید`, while writing nothing.
- **Evidence:** the test above.
- **Result:** no duplicate row (uniqueness holds) **and** no update (the conflict is swallowed).
- **Security effect:** **an operator who believes they have demoted an admin has not.** This is the
  most dangerous behaviour found in the section. → `SOURCE_SECURITY-ADM-002`.
- **Confidence:** VERIFIED_BY_UI.

## ABR-007 — Admin records have no status; revocation is deletion
- **Rule:** no enable/disable/suspend/expiry exists. The lifecycle is create → (immutable) → delete.
- **Evidence:** the absence of any such control; the two-field record.
- **Security effect:** the ordinary need to suspend access temporarily has no safe representation, so
  operators are funnelled to the destructive path.
- **Confidence:** VERIFIED_BY_UI.

## ABR-008 — Deletion is a single ❌ beside the row
- **Rule:** the header instructs `برای حذف یک ادمین روی ❌ کنارش بزنید` — one tap, per row.
- **Evidence:** header text + the ❌ cell on every row. **Not pressed.**
- **Security effect:** the delete control sits immediately beside the (inert) row label, in the same
  keyboard, with no visual separation and — on the evidence of the instruction text and of every
  other screen in this section — no confirmation step.
- **Confidence:** VERIFIED_BY_UI that ❌ deletes; **STRONGLY_INFERRED** that it is one-tap with no
  confirmation (deliberately not tested).

## ABR-009 — Permissions are role-only; no toggles, no overrides
- **Rule:** model (A). An admin's capabilities are entirely determined by the single role value.
- **Evidence:** no permission surface exists anywhere in the section.
- **Confidence:** VERIFIED_BY_UI.

## ABR-010 — Admin role and customer tier are independent dimensions
- **Rule:** `AdminRole ∈ {مدیر کل, فروشنده, پشتیبان, تأییدکنندهٔ رسید}` and
  `UserTier ∈ {f, n, n2}` are orthogonal; neither record references the other.
- **Evidence:** `[TELEGRAM_USER_ID_REDACTED]` is `نماینده عادی (n)` **and** `🧾 تأییدکنندهٔ رسید`; its customer record,
  read after the grant, is unchanged and contains no admin field. Second data point confirming
  TBR-018 from the Web-Admin phase (`f` + full admin).
- **Confidence:** VERIFIED_BY_UI.

## ABR-011 — Every pre-existing admin in this deployment holds full access
- **Rule:** all four production admins are `👑 مدیر کل`. No restricted role is in use.
- **Evidence:** the admin list at baseline.
- **Security effect:** the least-privilege roles the product offers are unused, and no privilege
  boundary has ever been exercised here — which is also why enforcement cannot be observed from
  production behaviour. Corroborates the Web-Admin finding BR-016 from a second angle.
- **Confidence:** VERIFIED_BY_UI.

## ABR-012 — Admin Management is filed under General Settings
- **Rule:** the section is reached at `پنل مدیریت → ⚙️ تنظیمات عمومی → 👨‍🔧 بخش ادمین`; there is no
  admin entry on the admin root keyboard.
- **Evidence:** both keyboards, byte-exact.
- **Security effect:** the highest-privilege screen in the product sits in the same list as the
  QR-code background and the bot's text strings, with no separation or extra gate.
- **Confidence:** VERIFIED_BY_UI.
