# v0.9.5 — fixes from the v0.9.4 test round

Round of 2026-11-03. Seven PRs (PR-0 to PR-6, numbered as in the round prompt) against
`Mhoseinshah1/nexa-bot`, owner issue #358. Merged under the round prompt's explicit approval
(push, one Codex review, one fix commit, green CI on the exact head, merge commit).
Per-PR detail (changes, tests, mutation checks, Codex fixes, decisions) is in each PR description.

## PRs

| PR   | Branch                           | Link                                              | Merge commit | What changed                                                                       |
| ---- | -------------------------------- | ------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------- |
| PR-0 | `chore/v095-token-diet`          | https://github.com/Mhoseinshah1/nexa-bot/pull/383 | efda52ab     | Budget rules in the round skills; test-only fix of the nightly reminder test       |
| PR-2 | `chore/v095-custom-naming`       | https://github.com/Mhoseinshah1/nexa-bot/pull/384 | 23d1b891     | `custom_panel_provider` flag removed; «پنل کاستوم» / «درگاه کاستوم»; doc links     |
| PR-1 | `feat/v095-features-page`        | https://github.com/Mhoseinshah1/nexa-bot/pull/386 | af406ddc     | قابلیت‌ها page: one page, category boxes, fuller per-flag descriptions             |
| PR-5 | `fix/v095-miniapp-layout`        | https://github.com/Mhoseinshah1/nexa-bot/pull/385 | 8ebb7f19     | Mini app: compact shop and wallet cards, rules list at full width                  |
| PR-6 | `fix/v095-reseller-edit`         | https://github.com/Mhoseinshah1/nexa-bot/pull/387 | dc65ab47     | Reseller edit page: summary card, tabs, allowed-products grouping                  |
| PR-3 | `feat/v095-custom-panel-files`   | https://github.com/Mhoseinshah1/nexa-bot/pull/388 | aa8bad55     | Custom panel protocol v1.1: optional `files` operation and delivery options        |
| PR-4 | `feat/v095-phone-and-exemptions` | https://github.com/Mhoseinshah1/nexa-bot/pull/389 | 83109e52     | Phone gate, allowed numbers, gateway rule, exemptions, account buttons, late Stars |

Migrations: PR-3 `0307`, PR-4 `0308` and `0309` (PR-4 renumbered after PR-3; SQL byte-identical).
PR-2 needed no migration (flag lists are built from the registry; an old stored row is ignored).
Contract changes are their own commits in PR-2, PR-3 and PR-4.

Codex: #383, #384, #386, #388 clean. #385 one finding (long plan title overflow) and #387 one
finding (tab switch lost sub-editor edits), each fixed in one commit. #389: one finding (old Telegram clients below Bot API 6.9: contact request), fixed in 006db306; CI fix e658c363 (mini-app Stars test moved to decision G).
Evidence screenshots: branch `evidence/v095` (never merged), linked from #386, #385 and #387.

## Decisions taken

- The approved demo was copied and registered in PR-2 (PR-0 had already merged).
- PR-0 also carried the fix for `tests/integration/customer-reminder-opt-out.test.ts`, which failed
  every night 20:30-00:30 UTC on main (a `now()+20h` landing on the same Tehran day). Test-only.
- PR-6 kept no reason dialog for sensitive reseller actions: the API has no reason field (OQ-V095-01).
- PR-3 put the delivery options on the panel page (OQ-C2-10).
- PR-4: OQ-V095-P4-01..05, in its description and in `docs/open-questions.md`. G closes OQ-R11-B5-04.

## CI notes

- main went red once at dc65ab47: `list-search-plan.test.ts` `beforeAll` hook timeout on a slow
  runner; passed on its one re-run.
- A `custom-menu-buttons` web test timed out once on #388 (1 s `waitFor` under load); re-run once, passed.
- Locally, the 7-Zip backup unit tests fail in cloud containers (no `7z` binary); CI has it.

## Owner checklist (in order)

1. After you tag `v0.9.5` on main (the lead pushes no tags), update the server:
   `sudo botctl update v0.9.5` and `sudo botctl version`.
2. `sudo botctl status`: ready, and the `capabilities:` section lists no new problem.
3. `sudo botctl roles enable provisioner monitor`, then `sudo botctl roles status` (both running).
4. Web Admin «قابلیت‌ها»: one page, category boxes with on/total, search, filter, a toggle updates its count.
5. Panels, new panel: «پنل کاستوم» is offered with no flag; the protocol doc box links to GitHub.
6. A custom panel whose bridge announces `files`: the file options are enabled; deliver a file to a test service.
7. Mini app on a phone: shop 4-5 products per screen, wallet tight, pre-invoice rules list full width.
8. Resellers, edit one: summary, tabs, allowed products by group, one sticky Save/Cancel.
9. «قابلیت‌ها» → «مشتری و حساب»: turn «تأیید شماره تلفن» (`phone_verification`) on with a test account; `/start` asks for «📞 Share Contact».
10. Customer 360 «محدودیت‌ها و کنترل‌ها»: grant «معاف از تأیید شماره»; that customer is not asked.
11. A gateway with the phone rule set: an unverified customer sees it, is asked, then continues to pay.
12. Turn `phone_verification` off again unless wanted; the account page has no «تأیید شماره» or «تراکنش‌ها».
13. End: `sudo botctl roles disable provisioner monitor`.

## Usage

| Item                      | Count | Tier                                                                                                                               |
| ------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------- |
| PRs                       |     7 | (PR-0, PR-1 to PR-6)                                                                                                               |
| Lead                      |     1 | money                                                                                                                              |
| Implementers PR-0/1/2/5/6 |     5 | default                                                                                                                            |
| Implementers PR-3/4       |     2 | money                                                                                                                              |
| Merge-main / fix / triage |   ~10 | default                                                                                                                            |
| CI checkers               |   ~10 | cheapest                                                                                                                           |
| Codex reviews             |     7 | one per PR; 3 findings, 3 fix commits                                                                                              |
| CI cycles                 |   ~10 | one checker per run; 2 single re-runs (slow runner), 2 CI fixes (PR-3 stale pin, PR-4 Stars test to G), 1 reminder-test fix (PR-0) |

CLI usage numbers: not shown to the lead in this session.
