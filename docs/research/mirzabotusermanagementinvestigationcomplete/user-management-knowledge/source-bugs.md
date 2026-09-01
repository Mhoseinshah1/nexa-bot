# Source Bugs — User Management

A **SOURCE_BUG** is a defect in MirzaBot itself. Things this investigation did wrong belong in
`incidents.md` and are never filed here.

IDs: `SOURCE_BUG-UM-###`.

## None recorded yet in this phase

Carried forward from earlier phases and still relevant when reasoning about user data integrity:

- **SOURCE_BUG-001** — the product-location edit path accepts an arbitrary unvalidated value, reports
  success, and permanently orphans the record. Relevant here as evidence that this bot does not
  consistently validate free-text input before writing it.
- **SOURCE_BUG-002** — a success message can be printed when nothing was persisted. Relevant here as a
  standing reason to verify every claimed state change by re-reading the record afterwards rather than
  trusting the confirmation text.

## SOURCE_BUG-UM-001 — Misspelled sentinel written into the phone field

`تایید دستی شماره تلفن` writes the literal string **`confrim number by admin`** into the user's
`شماره موبایل` field. "confrim" is a misspelling of "confirm". Because the value is a stored sentinel
rather than a display string, any consumer matching on the correct spelling will silently fail.

Severity: low on its own, but it reveals a **design problem**: the phone column is overloaded to hold
either a real phone number or an admin-verification marker. A rebuild should separate
`phone_number` from `phone_verified_by_admin`.

Evidence: field read `none` before, `confrim number by admin` after. VERIFIED_BY_UI.
