# MASTER — Pending Receipts (`💵 رسید های تایید نشده`) — AUTHORITATIVE

## PHASE_STATUS
**DONE for what is observable; the runtime behaviour is UNKNOWN because the queue is empty.**
This is not an incomplete investigation — it is a complete investigation of an empty state, plus
everything the surrounding configuration legitimately establishes.

## Scope
`👨‍💼 پنل مدیریت` → `💵 رسید های تایید نشده`. Read-only.

## COMPLETED
Entry-screen behaviour · empty-state message · absence of any keyboard, pagination, filter or back
button · placement in the admin hierarchy · the card-to-card linkage · PRBR-001..005.

## UNKNOWN
List format · detail fields · media delivery · approve flow · reject flow · notifications · status
enum · reviewer identity · what approval actually credits. All eleven are catalogued in `unknowns.md`
with the single experiment that would close them.

## NOT_EXPOSED
No approved/rejected **history** is reachable from this section — it shows pending items only, and
nothing else. Whether history exists elsewhere is UNKNOWN.

## TEST_DATA
None created.

## CHANGES_MADE
**None.**

## AUTHORITATIVE_FILES
`menu-tree.md` · `receipt-list.md` · `receipt-detail.md` · `approval-rejection-flow.md` ·
`business-rules.md` · `entities-relations.md` · `unknowns.md` · `incidents.md` · this file, plus the
root report `pending-receipts-investigation-report.md`.
