# Investigation incidents — Admin Management phase

## Summary
**NONE.**

- No existing admin was modified, disabled, re-roled or deleted.
- No admin was deleted at all.
- The only mutations were on the owner-authorised test account `[TELEGRAM_USER_ID_REDACTED]`.
- No customer record was modified.

## Changes made (all authorised, all on the test account)

| # | Change | Authorisation | Net effect on production |
|---|---|---|---|
| ADM-CHANGE-001 | created admin `[TELEGRAM_USER_ID_REDACTED]` with role `🧾 تأییدکنندهٔ رسید` | owner brief §0 | one new admin holding the narrowest role |
| ADM-CHANGE-002 | re-submitted the same id selecting `🎧 پشتیبان` | owner, in-session | **none** — the bot wrote nothing |

## A judgement call worth recording

The brief authorised creating the test admin but did not name a role. `👑 مدیر کل` was **not**
chosen. Granting full control of a production bot serving ~13,700 users was unnecessary for any
question in the brief, and `🧾 تأییدکنندهٔ رسید` — the narrowest role — answers the same structural
questions. If the owner wants the enforcement test run against a *middle* role instead, that requires
delete + re-create, and should be an explicit decision.

## A decision referred to the owner rather than taken unilaterally

Because the section has no edit path, the only way to attempt a role change was to re-submit the same
id through Add Admin — and it was not knowable in advance whether that would update the role or create
a conflicting duplicate row. The brief's own instruction was "if uncertain, do not submit duplicate".
Rather than guess, the situation was put to the owner mid-phase, who chose "بفرست و ببین". The test
then produced ABR-006 / SOURCE_SECURITY-ADM-002 — a finding that would otherwise have stayed unknown.
No duplicate was created.

## Buttons deliberately not pressed

| Button | Why |
|---|---|
| `❌` on any row, including the test admin | deletion; forbidden by the brief for existing admins, and the test admin was to be left in place |
| `👑 مدیر کل` at role selection | unnecessary privilege on a production bot |
| Any control on a production admin row | read-only by the brief |

These are documented gaps (UNK-ADM-007, UNK-ADM-008), not omissions.

## PII handling

Production admin numeric ids are **masked to their first five digits** throughout this knowledge base
and referred to as ADMIN_A…ADMIN_D. The test admin's id is recorded in full because it is the
owner-designated test account, already documented in the User Management phase. The test account's
phone number and display name, visible on its customer record, are **not** copied here.
