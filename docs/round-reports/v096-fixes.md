# v0.9.6 — fixes from the v0.9.4 import incident and the v0.9.5 questions

Round NEXA-FIX-V096 of 2026-11-03. Four PRs against `Mhoseinshah1/nexa-bot`, owner issue #358.
Merged under the round prompt's explicit approval (push, one Codex review, one fix commit, green CI
on the exact head, merge commit); all four are merged. Per-PR detail (changes, tests,
mutation checks, Codex fixes, decisions) is in each PR description.

## PRs

| PR   | Branch / subject                         | Link                                              | Merge commit | What changed                                                                                      |
| ---- | ---------------------------------------- | ------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| PR-4 | reseller sensitive changes need a reason | https://github.com/Mhoseinshah1/nexa-bot/pull/391 | 683a07147b5d | Suspend, tier change and credit change need a 3-500 character reason; dialog; audit and history   |
| PR-1 | import demotion tolerance                | https://github.com/Mhoseinshah1/nexa-bot/pull/392 | e85973e55b73 | An account gone since the dry run no longer refuses the whole import; demotions listed, capped    |
| PR-3 | owner answers OQ-V095-P4-01..05          | https://github.com/Mhoseinshah1/nexa-bot/pull/393 | ac54b50f3b4d | Support and `/help` behind the phone gate; late Stars to wallet; transfer preview phone exemption |
| PR-2 | faster `.nxpkg` import (stacked on PR-1) | https://github.com/Mhoseinshah1/nexa-bot/pull/394 | 1d42a60e5112 | Batched adoption, per-panel concurrency, PostgreSQL bulk-load sizing                              |

Migration: PR-1 `0310_legacy_import_demotions` (three nullable columns on `legacy_import_run_inputs`).
PR-2 adds no migration. PR-4 and PR-3 add none.
Contract changes are their own commits in PR-4 (reason field, error code), PR-1 (two owner-only
settings, demotion schemas) and PR-2 (concurrency setting), and PR-3 (transfer preview field).

Codex: #391 and #393 clean. #392 two P2 findings (a resume kept the demotions; an approved panel
mapping), fixed in adb9d68b1. #394 clean.

## Import timing (synthetic package, private PostgreSQL sized as `botctl` sizes an 8 GB host)

| Package                        | Before | After (PR-2) | Change | `apply.services.adopt` |
| ------------------------------ | ------ | ------------ | ------ | ---------------------- |
| 50k customers / 34k invoices   | 292 s  | 161 s        | -45 %  | 191 s -> 66 s          |
| 20k customers / 13.6k invoices | 123 s  | 66 s         | -46 %  | 81 s -> 28 s           |

Target (halve the total) NOT reached on this rig: -45 % to -46 %, adoption alone -65 % to -68 %.
The real server (the incident: about 1 h, `apply.services.adopt` 426 s) was not re-measured; any
figure for it is a projection. Its remaining share (verify, dry run, HISTORY, reconcile at 200k
customers) is UNKNOWN until a rehearsal with this release logs its `legacy import section timed` lines.
Next lever: fewer statements per adoption (about 22 each), see PR-2 "Open problems".

## Decisions taken

- PR-3 was started alongside PR-1 rather than after its merge (independent code); merge order kept.
- PR-2 was stacked on PR-1's branch while PR-1 awaited merge, then merged with main.
- Merges were blocked by the auto-mode classifier until the owner added a permission rule.
- A session restart killed two agents mid-work; fresh agents resumed from their uncommitted edits.
- PR-4: the reason lives in the audit row's `reason` column, not the payload. Tiers are unranked, so
  every tier change needs a reason. Reseller credit was removed, so a credit change can only be refused.
- PR-1: cap = max(50, floor(0.5 % of approved adoptable services)), as two owner-only settings
  (12,123 approved -> cap 60). Only ADOPTION_ELIGIBLE -> PROVIDER_MISSING / INVENTORY_INCOMPLETE counts.
  The list names invoices and usernames, operator-only, outside `final` and `finalV2`.
  A dry run recorded before 0310 has no stored adoptions: run a new dry run.
- PR-2: HISTORY after go-live not built (2-3 % of the time); design in `docs/open-questions.md`
  OQ-V096-P2-01. `synchronous_commit=off` not used. Per-panel concurrency kept (default 4) with an order gate.

## CI notes

- #393: a planner-statistics flake in `tests/integration/public-codes.test.ts`; re-run once, green.
- Locally, the 7-Zip backup unit tests fail in cloud containers (no `7z` binary); CI has it.

## Owner checklist (in order)

1. After you tag `v0.9.6` on main (the lead pushes no tags):
   `sudo botctl update v0.9.6` and `sudo botctl version`.
2. The outgoing botctl does not size PostgreSQL: run `sudo botctl restart` once, then
   `sudo botctl status`: ready, no new problem under `capabilities:`, and a `database tuning` section
   showing `max_wal_size`, `checkpoint_timeout`, `maintenance_work_mem`, `wal_compression`.
3. `sudo botctl roles enable provisioner monitor`, then `sudo botctl roles status` (both running).
4. Fresh-server one-click import test: on a fresh server (or a rehearsal host), install v0.9.6, open
   the Web Admin restore page, upload the `.nxpkg`, run the dry run, approve it, then apply. Note the
   total time and compare with the table above (`sudo botctl logs | grep "legacy import section timed"`).
5. In the import result, open the demotions table: count, cap, approved adoptable services, and each
   legacy invoice -> panel username -> outcome. If an account was deleted between dry run and apply
   it is listed and the import still COMPLETED (RECONCILED). A promotion or a changed balance must
   still refuse `DRY_RUN_MISMATCH`.
6. After the import: `sudo botctl restart background`, then `sudo botctl status`.
7. Resellers, edit one: suspend it («عملیات حساس» -> «تعلیق نمایندگی») and change its tier. Each opens
   a dialog; Confirm stays disabled until the reason is 3-500 characters. A pricing-only save has no
   dialog. The reason shows in the reseller history and the customer timeline.
8. «قابلیت‌ها» -> `phone_verification` on, with an unverified test account: «پشتیبانی» in the menu,
   `/help` and `/paysupport` answer; `/start`, `/wallet` and a top-up stay held until the phone is shared.
9. Late Stars: with a test Stars order whose attempt was cancelled (or settled from the wallet), a
   later charge goes to the customer's wallet once, with the late-payment notice. A second charge for
   the same order goes to the operator, not the wallet.
10. Customer 360, transfer account: grant «معاف از تأیید شماره» to the source; the preview names the
    phone exemption as staying with the source; after the transfer the destination has neither exemption.
11. Turn `phone_verification` off again unless wanted.
12. End: `sudo botctl roles disable provisioner monitor`.

## Usage

| Item                        | Count | Tier                                                     |
| --------------------------- | ----: | -------------------------------------------------------- |
| PRs                         |     4 | all merged                                               |
| Lead                        |     1 | money                                                    |
| Implementers PR-1/PR-2/PR-3 |     3 | money                                                    |
| Implementer PR-4            |     1 | default                                                  |
| Codex-fix agent (PR-1)      |     1 | money                                                    |
| Report drafter              |     1 | default                                                  |
| CI checkers                 |     4 | cheapest                                                 |
| Restarts                    |     2 | PR-1 fix agent and PR-2 implementer re-spawned once each |
| Codex reviews               |     4 | one per PR; 2 findings on #392, 1 fix commit             |
| CI cycles                   |     - | #391 1, #392 2, #393 2 (one flake re-run); #394 1        |

CLI usage numbers: not shown to the lead in this session.
