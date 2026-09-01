# Unknowns

All of the following are **OPEN** and all share one cause: the queue was empty.

| ID | Question |
|---|---|
| UNK-PR-001 | The pending-list format, its per-item fields, ordering and pagination |
| UNK-PR-002 | Every field of the receipt detail view |
| UNK-PR-003 | How the receipt media is delivered — photo, document, caption, forward, download link |
| UNK-PR-004 | The approve button's label, confirmation and whether the amount is editable |
| UNK-PR-005 | The reject button's label, whether a reason is required, free-text or predefined |
| UNK-PR-006 | Whether the customer is notified on approval and on rejection |
| UNK-PR-007 | What approval actually does — wallet credit, order settlement, or payment confirmation |
| UNK-PR-008 | Whether approval or rejection is reversible |
| UNK-PR-009 | The status enum, and whether approved/rejected history is visible anywhere |
| UNK-PR-010 | Whether the reviewing admin's identity and review time are recorded |
| UNK-PR-011 | Current values of the four card-to-card auto-approval settings |

## The one experiment that would close almost all of them

Enable `🔌 کارت به کارت` with auto-approval off, have a test user submit a small receipt, then open the
section. That requires changing a production gateway setting and creating a real payment record, so it
needs explicit authorisation and was **not** done.
