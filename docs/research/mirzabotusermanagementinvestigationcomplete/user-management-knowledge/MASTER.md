# MASTER — MirzaBot Telegram Admin → User Management (AUTHORITATIVE)

> Authoritative index for this phase. If any other file disagrees, this one wins.

## PHASE_STATUS
**IN PROGRESS** — started 31 Aug 2026. Not complete.

## CURRENT_FINAL_REPORT
`user-management-investigation-report.md` (repo root) — not yet written.

## Scope
`👨‍💼 پنل مدیریت` → `👤 مدیریت کاربر` in the MirzaBot Telegram admin bot: every menu, field,
state transition, financial effect, tier/reseller behaviour, service control, permission rule and
relationship to the other MirzaBot domains. **Documentation only — no implementation.**

## AUTHORIZATION (explicit, from the owner)
**TARGET_TEST_USER_TELEGRAM_ID: [TELEGRAM_USER_ID_REDACTED].** Full behavioural testing is authorised on this account
only: open every section, press every functional button, change tier/reseller state, edit reseller
discount and expiry, edit credit/negative-balance limits, block/unblock, adjust wallet balance, test
per-user discounts, inspect and toggle service/config controls, save changes, observe before/after,
and restore values.

**Everyone else is READ-ONLY.** Lists, counts, menu structure and aggregates may be observed; nothing
belonging to another customer may be changed. No unnecessary real-user PII enters this knowledge base.

**Irreversible deletion is deferred**: the delete flow may be opened and its warnings documented, but
permanent deletion is not executed until every other part of User Management is documented, and only
if genuinely necessary.

## COMPLETED_AREAS
_(none yet)_

## PARTIAL_AREAS
_(none yet)_

## UNKNOWN_AREAS
Everything, pending investigation.

## TEST_DATA
| Record | State |
|---|---|
| Telegram user `[TELEGRAM_USER_ID_REDACTED]` | designated test user; baseline not yet captured |

Carried in from earlier phases and **not to be deleted**: `TEST_STORE_CATEGORY`, `TEST_STORE_PRODUCT`
(location corrupted by SOURCE_BUG-001), discount code `testaudit7x3q`, panel `TEST_MARZBAN_[PANEL_NAME_REDACTED]`.

## IMPORTANT_SOURCE_BUGS
See `source-bugs.md`. Carried forward from the Store phase: SOURCE_BUG-001 (product location accepts an
unvalidated value), SOURCE_BUG-002 (success message printed without persisting), SOURCE_BUG-003 (web
admin discount page never opens).

## AUTHORITATIVE_FILES
This folder, plus the root deliverables once written.

## STALE_FILES
_(none yet)_

## NEXT_PHASE
Undecided. Reseller / agent child bots remain out of scope in every phase so far.
