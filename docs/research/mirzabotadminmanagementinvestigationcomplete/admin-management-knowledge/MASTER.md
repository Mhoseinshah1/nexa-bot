# MASTER — Admin Management (`👨‍🔧 بخش ادمین`) — AUTHORITATIVE

## PHASE_STATUS
**COMPLETE for everything the Telegram UI can answer.** The section is small and now fully mapped.
The one question it cannot answer from the owner's session — **whether the roles are enforced** —
remains NOT_TESTED, deliberately and honestly.

## Scope
`👨‍💼 پنل مدیریت` → `⚙️ تنظیمات عمومی` → `👨‍🔧 بخش ادمین`.
(The brief said `پنل مدیریت → ادمین`; there is no such button on the admin root.)

## CHANGES_MADE
Two, both on the owner-authorised test account `[TELEGRAM_USER_ID_REDACTED]`:
1. created it as an admin with role `🧾 تأییدکنندهٔ رسید`;
2. attempted a role change to `🎧 پشتیبان` — **the bot wrote nothing**.
**No existing admin was touched. Nothing was deleted.**

## HEADLINE FINDINGS

1. **The whole admin API is LIST, CREATE, DELETE. There is no UPDATE.** No detail screen, no edit
   screen, no role change, no status. The row label that looks like a detail button is inert.

2. **Four roles, not the seven documented on the Web panel** — `👑 مدیر کل`, `🛒 فروشنده`,
   `🎧 پشتیبان`, `🧾 تأییدکنندهٔ رسید` — and only `مدیر کل` shares a name with the web list. Both
   findings stand; see `contradictions.md`.

3. **Re-adding an existing admin silently fails while reporting success.** The bot answers
   `🥳 ادمین با موفقیت اضافه گردید` and writes nothing. An owner who tries to demote someone this way
   will believe it worked. The admin keeps the old privilege.

4. **An admin record is `(numeric Telegram id, role)` and nothing else** — no username, status,
   expiry, creator or timestamp. Identity is the **numeric id**, never a username.

5. **All four pre-existing production admins hold `👑 مدیر کل`.** None of the three restricted roles
   is in use anywhere, so no privilege boundary has ever been exercised in this deployment.

6. **Permissions are role-only (model A).** No toggles, no overrides, no per-section grants.

7. **Admin role and customer tier are independent — confirmed a second time.** `[TELEGRAM_USER_ID_REDACTED]` is a
   `نماینده عادی (n)` customer **and** a `تأییدکنندهٔ رسید` admin; the grant changed nothing on the
   customer record, which has no admin field at all.

8. **Revoking access means deleting the admin**, via a single `❌` beside the row that, on the
   evidence available, carries no confirmation.

## NOT_EXPOSED
Admin detail screen · edit/update · status/enable/disable · expiry · created-at · created-by ·
last-activity · per-admin permissions · search/filter/sort/pagination/count · admin action log
(Telegram side) · bot/scope column · any self-protection indicator.

## UNKNOWN
See `unknowns.md` — 13 items. The P1 ones: role enforcement (UNK-ADM-001), menu-hiding vs backend
authorization (002), whether admins are global or per-sub-bot (004), whether a restricted admin can
escalate (005), whether admin mutations are logged at all (006), delete confirmation (007),
self-protection rules (008), and whether restricted roles reach the mass financial tools (011).

## BLOCKERS
Enforcement testing needs a Telegram session for `[TELEGRAM_USER_ID_REDACTED]`, which this environment does not and
should not have. A 5-minute owner-side procedure that resolves it is written out in
`telegram-access-test.md`.

## INCIDENTS
**NONE.** See `incidents.md`.

## AUTHORITATIVE_FILES
`menu-tree.md` · `admin-list.md` · `admin-create.md` · `admin-profile.md` · `admin-edit.md` ·
`admin-status.md` · `roles.md` · `permissions.md` · `role-permission-matrix.md` ·
`access-enforcement.md` · `telegram-access-test.md` · `admin-log-crossmap.md` ·
`user-tier-crossmap.md` · `business-rules.md` (ABR-001..012) · `entities-relations.md` ·
`validation-errors.md` · `unknowns.md` · `contradictions.md` · `incidents.md` · `evidence-index.md` ·
`test-admin-state.md` · `progress.md`
