# 00 — Overview

**Status: PREPARED, NOT RUN.** Nothing here has been executed against the production host,
its database, its Telegram bot or its panels. A step labelled
**`OWNER ONLY — separate explicit approval`** needs the owner's own explicit approval for
that run. Merging the pull request that added these pages approves none of them.

Index and tools: [`README.md`](README.md). Open questions: `docs/open-questions.md` § OQ-CUT.

## Topology (Decision D1)

- **Nexa production is a new, empty installation** on its own host. The Fresh Migration
  refuses a non-empty tenant and deletes nothing (`../legacy-migration/nxpkg-importer.md`
  §0.1, §6). Never the staging host; never wipe a database to make it fresh.
- **MirzaBot (PHP) and its MySQL** run on the legacy host until the freeze, and stay frozen
  after a successful cutover. They are the rollback target until the final report is signed.
- **RickPanel** is shared. Mirza created its accounts; Nexa adopts them read-only at import
  (GETs and the token exchange only). After go-live it is the one system both bots can
  write to, which is why rollback stages R2 and R3 need a reconciliation list.
- **Same bot token.** Nexa is installed with `--skip-telegram` and holds no bot until the
  handover ([`06-token-handover.md`](06-token-handover.md)). The bot's username, chats,
  history and old Mirza keyboards stay; only the webhook URL changes.

## Roles

- **Owner** — the only person who approves, and the only one who runs an
  `OWNER ONLY` step (or names, in writing, the operator who types it while the owner
  watches). Holds `legacy.migration.apply` (CRITICAL) and `legacy.cutover.approve`.
- **Operator** — runs `read-only` steps, captures records, prepares commands for the owner.
- **Nobody else** — no agent, no CI and no scheduled task runs any step.

## Timeline

| When              | Phase                                                       | Customer-visible            |
| ----------------- | ----------------------------------------------------------- | --------------------------- |
| T−7 d … T−1 d     | 0 preconditions, rehearsal, production host, GO-1           | nothing                     |
| T−24 h, T−1 h     | owner's announcement (Mirza broadcast, manual)              | the announcement            |
| T0                | 1 freeze Mirza                                              | Mirza stops answering       |
| T0+               | 2 final export (Windows PC)                                 | —                           |
| T0+               | 3 import (dry run, GO-2, apply)                             | —                           |
| T0+               | 4 reconciliation on a copy, GO-3                            | —                           |
| T0+               | 5 token handover (GO-4)                                     | Nexa answers; sales stopped |
| T0+               | 6 provisioner → monitor → customer link → sales open (GO-5) | sales resume                |
| T+15 m, 1 h, 24 h | observe                                                     | normal                      |

The import of a ~200k-user package is the long pole. Measure it in the rehearsal and write
its duration into GO-1. If the window runs out before GO-4, roll back (R0/R1; trigger T7).

## Rules that apply to every page

- **Reseller credit.** Mirza agent credit (`maxbuyagent`) never becomes wallet money. It is
  listed, never credited; every Mirza agent becomes a Nexa reseller with no credit of any
  kind. [`05-reconciliation.md`](05-reconciliation.md) checks it.
- **Import silence.** The import sends no customer anything. Nothing in this runbook makes
  Nexa message a customer.
- **Rows held for review never count as matched.** A held row is counted with its money and
  reported as `RECONCILED_WITH_HELD`; the owner signs each held class off by name.
- **Negative balances.** A customer whose Mirza balance was negative holds a negative Nexa
  wallet. Every purchase on every rail is refused until a top-up brings it to zero; a
  top-up is never refused. Nothing ages or rewrites it, and no customer is told
  automatically (owner decision 2026-10-18).

## What this runbook never does

- Never execute a step without the owner's separate, explicit approval for that run
  (`OWNER ONLY` steps), and never in an agent session.
- Never point `cutover-reconcile` at the live database (it refuses `nexa`); never drop or
  edit rows to "fix" a difference; never `botctl rollback` to undo data (application only).
- Never call `setWebhook` / `deleteWebhook` from the Nexa host by hand; never type the token
  or the package key on a command line.
- Never send customers anything automatically: the incident's customer message stays empty,
  never press «اطلاع‌رسانی» (`incidents.notify`), no broadcast from Nexa.
- Never run the legacy compaction (`../legacy-migration/compaction.md`) during the cutover or
  before the final report is signed.
- Never unfreeze MirzaBot for writes after GO-4 unless rolling back (R1–R3).

## Conventions

- Each step lists **Precondition**, **Command**, **Verification**, **Rollback** and
  **Record** (what goes into [`11-records.md`](11-records.md)).
- **Labels.** A destructive or production-facing command (production database, Telegram
  bot, panels, or anything that changes what customers see) carries
  **`OWNER ONLY — separate explicit approval`** above its block. A local command that only
  reads carries **`read-only`**.
- `<PLACEHOLDER>`s stay unquoted so an unedited one is a syntax error. Never a global
  search-and-replace.
- Aggregates only leave the host. Never paste a Telegram id, username, token, key, phone,
  subscription link or one person's amount. `--list-differences` output is terminal only.
- Every time is UTC: `date -u +%FT%TZ | tee <step>.txt`.
- Web Admin labels are quoted exactly: «بکاپ و بازیابی ← عملیات بازیابی», «پنل‌ها»,
  «رخدادها و نگهداری», «تأیید انتقال نهایی» (`/legacy-cutover`), «تأیید بازیابی».
- A missing command is written `TBD — see OQ-CUT-xx`. It is never guessed.

Session setup (step S0; repeated at the top of 04, 05, 07 and 08):

**`read-only`**

```bash
set -o nounset
export DC="docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml"
mkdir -p ~/cutover && chmod 700 ~/cutover && cd ~/cutover
date -u +%FT%TZ | tee t0-start.txt
```

## Decisions

Each is the reading that moves no money and sends no customer message.

| #   | Decision                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Production Nexa is a new, empty installation: the `.nxpkg` Fresh Migration, not the older MySQL-dump (P7) path.                                                  |
| D2  | Nexa holds no bot until the handover (`--skip-telegram`), so no customer reaches an empty or half-imported Nexa.                                                 |
| D3  | Queued updates are dropped at Nexa's first registration (existing code behaviour); accepted pending OQ-CUT-01. No code change.                                   |
| D4  | The reconciliation runs on a restored copy (`nexa_cutover_scratch`), never the live database; the tool enforces it by name. NODE_ENV is not part of its refusal. |
| D5  | `finalDumpSha256` = the `.nxpkg` SHA-256, `freezeProofSha256` = its payload SHA-256, as the executor records them (OQ-CUT-05).                                   |
| D6  | Sales stay stopped (MAINTENANCE incident, empty customer message, never notified) from before the handover until GO-5. Order: provisioner, monitor, link, sales. |
| D7  | A held row is never a match: `RECONCILED_WITH_HELD` (exit 2), signed off by class (OQ-CUT-06).                                                                   |
| D8  | An agent is a Mirza user whose `user.agent` is set, or whose agent profile has tier `n`/`n2`. Its cap is listed, never summed into money.                        |
| D9  | The preflight's `background-roles` check expects both roles off. After B2 use `botctl roles status` and the step's own checks.                                   |

## Glossary

- **`.nxpkg`** — the sealed package Mirza2Nexa builds from the final Mirza backup.
- **Held** — a Mirza row the import put in manual review (invalid identity, duplicate
  source id, unreadable balance, held by import).
- **Scratch copy** — `nexa_cutover_scratch`, the post-import backup restored into a new
  database so `cutover-reconcile` never touches `nexa`.
- **GO-1 … GO-5** — the owner's decision points ([`09-go-no-go.md`](09-go-no-go.md)).
- **R0 … R3** — rollback stages ([`08-rollback.md`](08-rollback.md)).

## راهنمای فارسی

**وضعیت: آماده‌شده، اجرا نشده.** هر مرحلهٔ «فقط مالک — با تأیید صریح جداگانه» برای هر بار اجرا به
تأیید صریح مالک نیاز دارد. مراحل «فقط خواندنی» چیزی را تغییر نمی‌دهند.

- Nexa روی یک سرور **تازه و خالی** نصب می‌شود؛ میرزا و MySQL آن تا لحظهٔ فریز روی سرور قدیمی کار
  می‌کنند و بعد از انتقال هم فریز می‌مانند (هدف بازگشت). پنل RickPanel مشترک است و Nexa فقط
  می‌خواند. **توکن ربات همان است**؛ تنها نشانی وب‌هوک عوض می‌شود.
- مالک تنها کسی است که تأیید می‌کند و مراحل «فقط مالک» را اجرا می‌کند. هیچ عامل خودکار، CI یا
  کار زمان‌بندی‌شده‌ای هیچ مرحله‌ای را اجرا نمی‌کند.
- **اعتبار نمایندگی میرزا هرگز پول کیف پول نمی‌شود**؛ فقط فهرست می‌شود. انتقال هیچ پیامی به مشتری
  نمی‌فرستد. ردیف‌های نگه‌داشته‌شده برای بررسی هرگز «منطبق» حساب نمی‌شوند. موجودی منفی میرزا،
  کیف پول منفی در Nexa است و تا شارژ، هر خریدی را رد می‌کند.
- هرگز: اجرای مرحله بدون تأیید مالک، اشاره‌دادن `cutover-reconcile` به دیتابیس اصلی، حذف یا
  ویرایش ردیف برای «رفع» اختلاف، `setWebhook`/`deleteWebhook` دستی از سرور Nexa، نوشتن توکن یا
  کلید روی خط فرمان، فشردن «اطلاع‌رسانی»، فشرده‌سازی (compaction) پیش از امضای گزارش نهایی.
- هر مرحله: پیش‌شرط، دستور، راستی‌آزمایی، بازگشت، ثبت. دستورهای هر صفحه در بخش انگلیسی همان
  صفحه‌اند و در بخش فارسی تکرار نمی‌شوند. نام‌های صفحهٔ مدیریت دقیقاً همان‌هایی‌اند که در
  بالا آمده‌اند. هر دستور ناموجود «TBD — see OQ-CUT-xx» نوشته می‌شود و هرگز حدس زده نمی‌شود.
