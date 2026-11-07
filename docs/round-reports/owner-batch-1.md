# Round report — owner batch 1

| PR | Link | Merge commit |
|---|---|---|
| PR-4 secrets, one Save, readable values | https://github.com/Mhoseinshah1/nexa-bot/pull/419 | `6de9bd557` |
| PR-1 Mirza menu defaults, search switches | https://github.com/Mhoseinshah1/nexa-bot/pull/420 | `1f1d5545d` |

PR-1 needed three CI-fix commits after a clean Codex review: two cited test titles restored
(ae137154, f238167c), two reply-keyboard tests updated to the new default (c6d81a2b), and a race in
`custom-menu-buttons` web test made robust (f238167c). No force-push.
| PR-2 reseller requests | https://github.com/Mhoseinshah1/nexa-bot/pull/421 | `795cfa85c` |

PR-2: one Codex fix commit (c4e4afc1, added migration 0323 for the draft step key) and two CI-fix
commits (cfd3d9a0, e4382d8a: stale menu counts in two integration tests). Migrations 0322, 0323.
| PR-3 automatic deletion of finished accounts | https://github.com/Mhoseinshah1/nexa-bot/pull/422 | `5d0c286c1` |

PR-3: migration 0324 (renumbered from 0322; not byte-identical — the kind CHECK also lists #421's two kinds,
hand edits unchanged). One Codex fix commit (0ae59175: lifecycle lock before blockers; blocked runs excluded
before the batch limit). Deployment smoke died twice in the image build at apt.postgresql.org; one re-run, green.
| PR-5 late-payment policy | https://github.com/Mhoseinshah1/nexa-bot/pull/423 | `649e18d69` |

PR-5: migration 0325 (renumbered from 0322, SQL byte-identical, data only). One Codex fix commit (7b1a0dde:
payment → transfers → customer lock order on every late-delivery path; a test reproduces the 40P01 deadlock
without it). Deployment smoke died in the image build at apt.postgresql.org; one re-run, green.

## Owner test checklist

1. See the new menu labels.
2. Features page: turn `services_search_label_button` / `services_search_button` on and off.
3. «نمایندگان» → «درخواست‌های نمایندگی» → «سؤال‌ها»: add 3 questions; turn on `reseller_requests`; send a
   request with a test account; «💬 پیام به متقاضی» from the group, answer it in the bot, then «✅ تأیید».
4. Set the `service.auto_delete.*` days, check the preview, enable `service_auto_delete` (confirm repeats N),
   and watch one test service get the warning and then be deleted.
5. Open a gateway dialog, fill both fields and Save once.
6. Confirm Chrome no longer offers saved passwords there.
7. Check that the features page shows the referral gift total as money.
8. Set a gateway to `DELIVER`, pay a test invoice after its deadline, and see the service delivered.
9. Set a gateway to `REVIEW` and deliver from the group (the button opens the Web Admin decision dialog).
10. `sudo botctl roles disable provisioner monitor`

## Decisions taken (round-level)

- Contract changes went in their own commits, as CLAUDE.md requires; that safety rule outranks "one fix commit"
  wherever a fix needed a contract change.
- CI-only fix commits after the single Codex fix: PR-1 three, PR-2 two; recorded above. No force-push.
- Remote branches could not be deleted (the session's permission check refused it):
  feat/menu-mirza-defaults, fix/webadmin-secrets-forms-json, feat/reseller-request, feat/service-auto-delete,
  feat/late-payment-policy.
- The report and handoff live on the session branch, as in phase 6A.

## Usage

| PRs | Agents | Tiers | CI cycles |
|---|---|---|---|
| 5 merged | 14 (5 implementers, 1 approve-path, 4 merge/renumber, 3 CI triage, 1 CI checker) | lead; money: PR-2 approve, PR-3, PR-5; default: PR-1, PR-2 UI, PR-4, merges, triage; cheapest: CI checker | PR-1 4, PR-2 4, PR-3 2 (+1 re-run), PR-4 2, PR-5 2 (+1 re-run) |
