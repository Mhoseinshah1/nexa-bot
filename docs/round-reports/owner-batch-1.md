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
