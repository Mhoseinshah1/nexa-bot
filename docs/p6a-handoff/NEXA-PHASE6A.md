# NEXA-PHASE6A — hosted bots, part 1: isolation, creator panel, activation, capacity safeguards

The v0.9.7, v0.9.8 and v0.9.9 rounds are finished (last merge #408). Run this in a **new session**. No other session works on `nexa-bot` meanwhile. Base: latest `main`.

Before PR-0, read `docs/round-reports/v099-fixes.md` and the latest handoff, so you know what v0.9.8–v0.9.9 changed: the phone status (migration `0314`), the server step and the Web Admin customer page.

**Branches.** Use the branch names below. If this session can push only one branch (as the last session could), open the PRs from that branch one at a time, in the order below, and record it under "Decisions taken".

## 0. How this phase runs

- **Read first.** Read `CLAUDE.md`, then follow `nexa-round-pipeline` (budget rules), `nexa-pr-workflow`, `nexa-conventions`, `nexa-migrations`, `nexa-test-selection`, `nexa-ci-watch`, `nexa-handoff` and `nexa-web-design`. Where this prompt is silent, the skills decide. A skill's *safety* rule wins over this prompt; record any conflict under "Decisions taken".
- **Merge permission.** You have my explicit permission to push, open a PR and **merge every PR of this phase yourself**, as a merge commit, once CI is fully green on the exact head and the single Codex review's findings are fixed in one commit. Never stop to ask about a merge. Never push to `main`, never force-push, never push a tag.
- **Codex.** Right after opening each PR, post `gh api repos/Mhoseinshah1/nexa-bot/issues/<pr>/comments -f body='@codex review'`. Act on the first complete review of that head only. Never re-request after the fix commit; at most 2 requests per PR.
- **Agents.** The lead stays on Opus and stays thin. Spawn every subagent with an explicit model:
  - **Opus:** PR-1, PR-2, PR-3, PR-5 and PR-6 (security, tenancy, money-adjacent).
  - **Sonnet:** PR-0, PR-4 (UI), CI triage, Codex replies, PR text and reports.
  - **Haiku:** the single CI checker and pure lookups.

  At most **2 implementers at a time**.
- **Do not stop.** Work without stopping and without asking questions. Take the safest reading and record it under "Decisions taken".
- **Contract changes** each go in their own commit with the reason.

## 1. What we are building (owner decisions, binding)

- **Hosting model.** One Nexa install on one big server hosts the owner's own bot **plus Nexa bots for anyone he chooses** («میزبانی‌ها»).
  - Each hosted bot is a full Nexa: its own Telegram bot, Web Admin, panels, gateways, products, customers and ops group. It is fully independent; he sells the software, not VPN capacity.
  - Billing is out of scope.
  - Every hosted bot gets all features.
- **Creator panel.** The owner manages hosted bots from a **creator panel**, a «میزبانی‌ها» section visible only to him.
  - Statuses: **active / manually suspended / expired**.
  - A manual expiry date per bot (empty = none). On expiry the bot is auto-suspended and he is notified.
- **Owner access.** The owner has **full access** to every hosted bot: he can see each bot's Web Admin username and use «ورود به پنل» to enter it. **His actions inside hosted bots are not written to their audit logs.** (This last part is in 6B, D5; design for it now.)
- **2FA.** TOTP 2FA is **mandatory only for the «میزبانی‌ها» section**: a 12 h session, sensitive actions always ask again, recovery codes. The rest of Web Admin is unchanged.
- **Hosted-bot owners.** They create their own Web Admin username and password through a one-time activation link.
- **Tenant isolation.** Isolation is enforced by **PostgreSQL row-level security** with a non-bypass application role (owner-approved 2026-11-01). This **supersedes ADR-0004**: write a new ADR saying so and why (the deployment model changed from "one install per customer" to many unrelated owners on one install).

## 2. PRs

### PR-0 · `test/p6a-load-harness` (Sonnet) — measure before building

Build a repeatable load test (`scripts/load/`; not part of CI's required checks):
- simulate N tenants (default 50) with M concurrent customers each, sending webhook updates (`/start`, menu taps, buy flow up to the invoice, wallet);
- one broadcast of 50k recipients on one tenant;
- a backup running at the same time.

Record per run:
- p50, p95 and p99 webhook response time;
- the error rate;
- DB pool waits;
- RAM per container;
- CPU;
- the worker queue lag;
- the point where it breaks.

Run it on today's single-tenant code to get a **baseline**. Put the results in `docs/capacity/baseline.md`. Later PRs re-run it.

### PR-1 · `feat/p6a-d0-tenant-hardening` (Opus) — D0, before anything else ships

1. **Row-level security.** Enable RLS on **every** tenant-owned table, with a policy `tenant_id = current_setting('app.current_tenant_id')`.
   - The app connects as a **non-owner, non-BYPASSRLS** role.
   - Every tenant-scoped query runs in a transaction that sets the tenant (`SET LOCAL`).
   - `SystemContext` work uses a separate, audited path.
   - Migrations: follow `nexa-migrations`; no long table locks on big tables.
   - **Prove completeness:** a test lists every table with a `tenant_id` column and fails if any lacks the policy. A cross-tenant read through the app role returns zero rows.
2. **Off-site, write-only backups.** A whole-install backup to S3-compatible object storage with object lock / write-only credentials, so a compromised server cannot delete history. Configurable in `deploy.env`; off by default until the owner sets credentials.
3. **Owner security alerts** to the owner's ops group only:
   - Web Admin login from a new IP;
   - any data export;
   - unusually large reads.
4. **`botctl harden check`:** checks SSH password login, root login, the firewall (only 80/443/SSH open), the Docker socket, file modes of `/etc/nexa` and unattended upgrades. Prints PASS/WARN per item, in Persian.

### PR-2 · `feat/p6a-capacity-guards` (Opus) — the worst case on one 4-vCPU / 8 GB server with ~50 bots

1. **Memory.**
   - Container memory limits in compose, derived from host RAM in `deploy.env`.
   - Protect PostgreSQL from the OOM killer (`oom_score_adj`).
   - Heavy jobs (backup, import, export, large report) are refused or queued when free RAM is below a threshold.
2. **Per-bot fair share.** Every limit below is a per-bot setting the owner can change, including **«نامحدود»**. The defaults are a starting point only:

   | Resource | Rule | Hosted default | Owner's own bot |
   |---|---|---|---|
   | Customer updates | Concurrent processing per bot; excess waits in that bot's queue | 8 | unlimited |
   | DB connections | A bot's share of the pool | 3 | unlimited |
   | Background jobs (outbox, notifications, reminders) | Round-robin across bots, so one long queue cannot starve others | equal turn | double turn |
   | Broadcast | Messages per second | 10/s | 25/s |
   | Heavy jobs | **One installation-wide queue**, one at a time (setting: 1–2) | queued | front of the queue |
   | New users and `/start` | New customers per minute, against spam | 60/min | unlimited |
   | Support AI | Monthly request/cost cap | setting | unlimited |
   | Storage | Data and backup size cap | setting | unlimited |

   When a bot hits a limit, its customers are only **slower**: nothing is lost, and other bots are unaffected. If a bot keeps hitting a limit, alert the **owner** (not the bot's owner).
3. **Spread scheduled work.** Each bot's reminders, nightly report, FX refresh, retention and backup times are offset by a stable hash of the bot id, so 50 bots never fire at the same minute.
4. **Disk and RAM alerts, owner only.** At 80% and 90% disk, low free RAM, and a growing worker lag, alert **only the owner's** ops group. Hosted bots never see these.
5. Re-run PR-0's load test and write `docs/capacity/after-guards.md`: how many bots of which size this server holds within p95 < 1 s.

### PR-3 · `feat/p6a-d1-creator-panel` (Opus backend + Sonnet UI) — D1 «میزبانی‌ها»

- **Bot list:** status, expiry, customer count, a resource-use summary against limits, and the last backup.
- **Actions:** create, suspend, activate, delete (soft; data kept until purge with confirmation), and set expiry. Expiry auto-suspends and notifies the owner.
- **Per-bot limits editor** (PR-2's table), each with «نامحدود».
- **Server capacity card:** CPU, RAM, disk and an estimate of how many more bots fit.
- **Mandatory TOTP 2FA** for this section only, with a 12 h session, re-asking on sensitive actions, and recovery codes.
- Persian UI following `nexa-web-design`. Add the section to the new sidebar menu, visible only to the owner.

### PR-4 · `feat/p6a-d2-activation` (Sonnet, with lead review) — D2

1. The owner creates a bot record. The hosted owner supplies a **bot token** and a **domain**, and points a CNAME at the owner's hostname.
2. Nexa verifies the token and the DNS, issues TLS automatically (Caddy), registers the webhook with a per-bot secret, and produces a **one-time activation link** (24 h, single use) where the hosted owner sets their Web Admin username and password.
3. Clear Persian status per step: «توکن تأیید شد»، «دامنه وصل شد»، «SSL صادر شد»، «لینک فعال‌سازی ساخته شد».

### PR-5 · `test/p6a-d3-isolation-proof` (Opus) — D3

An integration suite proving no cross-tenant access through **every** surface: Web Admin API, bot runtime, mini app, worker jobs, exports, search, reports and file/media access. Each test creates two tenants and tries to read or modify one from the other, and must get nothing. Mutation-check: remove one RLS policy and the suite turns red.

### PR-6 · `fix/p6a-hardening-followups` (Opus, only if needed)

Fix anything PR-5 or the load test exposed. If nothing was exposed, skip this PR and say so.

## 3. Order

1. PR-0.
2. PR-1 and PR-2 in parallel.
3. PR-3 and PR-4.
4. PR-5.
5. PR-6.

Hosted bots must not be creatable in production until PR-1 and PR-5 are merged. Gate the create action behind that.

## 4. End

1. Write `docs/round-reports/phase-6a.md` (at most 150 lines) with the load-test numbers before and after.
2. Post a Persian summary as a **new comment on issue #358** titled «فاز ۶الف — میزبانی ربات‌ها»:
   - PR links;
   - a Persian release note;
   - the owner's test checklist (create a hosted bot end to end on the test server with a spare bot token and a test domain; 2FA; limits; isolation spot-check; ending with `sudo botctl roles disable provisioner monitor`);
   - how many bots this server can hold.
3. Update the handoff.
4. Clean up, and list the branches you could not delete.
5. **STOP.** Phase 6B (D4 limits UI polish, D5 owner access without audit, D6 server move, D7 per-bot backups with the shared queue) starts in a new session.
