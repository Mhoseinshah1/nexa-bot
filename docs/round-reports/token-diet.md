# Token diet — skills slimmed (tooling only)

Branch `chore/token-diet`. Scope: `.claude/skills/**` and this directory. Rationale,
examples and history moved VERBATIM to each skill's `references/`; `SKILL.md`
keeps decision rules and exact commands. No script, test, CI file or product code
changed.

## Sizes (bytes of every `SKILL.md`)

| Skill                      | Before | After |  Delta |
| -------------------------- | -----: | ----: | -----: |
| `nexa-ci-watch`            |   2894 |  3024 |   +130 |
| `nexa-code-navigation`     |   9579 |  5117 |  -4462 |
| `nexa-conventions`         |   7224 |  5112 |  -2112 |
| `nexa-gateway-integration` |   5197 |  5197 |      0 |
| `nexa-handoff`             |   3794 |  3794 |      0 |
| `nexa-log-digest`          |   3606 |  3606 |      0 |
| `nexa-migrations`          |   8284 |  4400 |  -3884 |
| `nexa-pr-workflow`         |   6268 |  5067 |  -1201 |
| `nexa-round-pipeline`      |   8991 |  6806 |  -2185 |
| `nexa-test-selection`      |   9634 |  5073 |  -4561 |
| `nexa-web-design`          |   4619 |  4619 |      0 |
| **Total**                  |  70090 | 51815 | -18275 |

Over the 5120-byte target: `nexa-round-pipeline` (6806) — it is almost all
safety and pipeline rules, and the requested §1/§3/§4/§9 additions add text;
nothing further could move without dropping or burying a rule.
`nexa-conventions` is 5112 (8 under).

## What moved where (verbatim)

| Skill                  | Moved to                           | Sections                                                                                                                                 |
| ---------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `nexa-code-navigation` | `references/navigation-detail.md`  | why-search-first prose; runtime/ and snapshot prose; Step 0/1 notes; planes; Step 3 "read narrowly"; "What this skill does not cover"    |
| `nexa-test-selection`  | `references/test-details.md`       | Heavy suites; Other commands; Running integration safely; A failure is information; selector limits; runner output                       |
| `nexa-round-pipeline`  | `references/round-details.md`      | Round 10 pause history; lead hold/status detail; never-wait-blindly; renumbering long form; agent-setup commands                         |
| `nexa-migrations`      | `references/migrations-detail.md`  | The journal's `when` IS the ordering (full); renumber script behaviour and manual steps; Forward-only worked example; Append-only tables |
| `nexa-conventions`     | `references/conventions-detail.md` | write path; Events/audit/operational events; Idempotency; Secrets; full domain-invariant bullets incl. Import silence                    |
| `nexa-pr-workflow`     | `references/git-rule.md`           | §0 the rule in full (from CLAUDE.md § Git); migration-collision story; REST endpoint list; release candidates                            |

Each reference is linked once from its `SKILL.md`. Section numbers are unchanged
(`nexa-round-pipeline` §1, §1a, §2–§9; `nexa-pr-workflow` §0–§7; the headings
`nexa-migrations` § Renumbering / § Things drizzle-kit does not model,
`nexa-test-selection` § Heavy suites, `nexa-code-navigation` § Layout all still exist).

## Requested content edits

- `nexa-round-pipeline` §1: max 3 implementer agents at once unless the round prompt
  sets another number; Sonnet stays default.
- §3 and `nexa-ci-watch` (text only): waiting for CI is ONE foreground blocking call
  with a timeout (`ci-status.sh --wait <pr> --max 540`, under the Bash tool's 600 s
  limit), never an agent polling in a loop. The round prompt's alternative
  `gh pr checks --watch` is not named: CLAUDE.md forbids `gh pr …` (GraphQL is
  blocked, 403); the script's own `--wait` is the same blocking call over REST.
  The `--wait` example went from `--max 5400` (cannot run as one foreground call)
  to `--every 60 --max 540`.
- §4: small unrelated non-money, non-migration changes may share one PR.
- §9: the per-PR report goes to the PR description and `docs/round-reports/<round>.md`
  (nothing dropped); chat message is a summary of at most 20 lines with links; a usage
  table (PRs, agents, model per agent, CI cycles, CLI usage numbers) ends the file.
- `nexa-handoff`: untouched (template section names unchanged).

## Lead review fixes (on top of the agent's commit)

- §3 / `nexa-ci-watch`: dropped `gh pr checks --watch` (above).
- `nexa-code-navigation`: the two backticked paths that had moved to
  `references/` (`apps/api/src/modules/`, `docs/research/`) are named again in
  Step 2, so PATH_FILES checks 40 paths as before (not 38).
- `nexa-code-navigation`: the closing "Writing rules / migrations / tests" pointer
  removed to stay under 5 KB; the same map is CLAUDE.md § Where to look.

## Safety checklist: old rule -> where it is now

Round pipeline (old `SKILL.md`):

| Old rule                                                                                                                                                                                                                   | Now                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| own worktree per implementer, never two agents in one checkout                                                                                                                                                             | round-pipeline §1                                                    |
| separate databases; one integration run at a time round-wide                                                                                                                                                               | round-pipeline §1, §1a                                               |
| fresh agent per PR; lead does not run/read those steps                                                                                                                                                                     | round-pipeline §1                                                    |
| private database per agent, BOTH `TEST_DATABASE_URL`/`DATABASE_URL`; drop at round end                                                                                                                                     | round-pipeline §1 (setup commands: `round-details.md` § Agent setup) |
| agents quote the digest, never raw output                                                                                                                                                                                  | round-pipeline §1a                                                   |
| No global test pause, ever; every run through `run-gate.sh`, foreground                                                                                                                                                    | round-pipeline §1a                                                   |
| max 2 runs, exit 75, nobody bypasses / waits for "resume"                                                                                                                                                                  | round-pipeline §1a                                                   |
| lead's tool is a priority hold, not a pause (TTL, `--status`, short reason)                                                                                                                                                | §1a short; TTL/`--status` text in `round-details.md` § 1a            |
| never wait on a background command blindly (`pgrep -af`)                                                                                                                                                                   | round-pipeline §1a                                                   |
| local gate = affected suites; full integration suite CI-only; money PR keeps `pnpm verify` + guard suites + lead review                                                                                                    | §1a (trap and tiers via `nexa-test-selection`)                       |
| `pnpm test:integration -- <files>` runs the WHOLE suite (trap)                                                                                                                                                             | `nexa-test-selection` Step 2 Trap; pointer in §1a                    |
| subagent report at most 25 lines, content list, no code/logs/narration                                                                                                                                                     | §2                                                                   |
| lead reads each report once, full diff once, no reviewer mutation left                                                                                                                                                     | §2                                                                   |
| Non-money shortcut and its limits (money/ledger/payment/gateway/pricing/provisioning/migration; unclear = money; git diff read never skipped)                                                                              | §2 + `nexa-test-selection` Step 2                                    |
| lead narration only on merge/break/decision                                                                                                                                                                                | §2 (shortened)                                                       |
| one CI checker, one Codex review, one fix commit, merge commit                                                                                                                                                             | §3                                                                   |
| Codex "running" > 1 h: report to owner; only the owner posts `@codex review`                                                                                                                                               | §3                                                                   |
| round prompt "merge on green" = approval, exact head, Nothing else is approval                                                                                                                                             | §3                                                                   |
| merge order; merge (never rebase) main into next branch                                                                                                                                                                    | §4                                                                   |
| renumber with tooling, rebuild contracts first, byte-identical SQL, `identical=no` stops merge                                                                                                                             | §4 (long form `round-details.md` § 4)                                |
| contracts change its own commit; every rule has a reverting test; pin counts                                                                                                                                               | §5                                                                   |
| no customer message from migration/import/backfill; never push main/force/tag; test-server checklist ends `botctl roles disable provisioner monitor`; dev-services before integration; clean checkout for repo-wide checks | §6                                                                   |
| ambiguity: take the reading that moves no money, record it                                                                                                                                                                 | §7                                                                   |
| budget: finish, merge, handoff, refresh after each merge / ~50 %, re-read after compact                                                                                                                                    | §8                                                                   |
| remove worktrees and test databases; final report content                                                                                                                                                                  | §9                                                                   |

PR workflow (old `SKILL.md`):

| Old rule                                                                                          | Now                                      |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| never push implementation to `main`; never force-push                                             | pr-workflow §0 (full text `git-rule.md`) |
| `main` moves only by owner-approved PR, CI green on exact head; leave PR open absent approval     | §0, §6                                   |
| round prompt "push, open a PR, merge on green" is approval for that round only                    | §0, §6                                   |
| restart merged branch from `origin/main`; merge, never rebase a pushed branch                     | §1                                       |
| `branch-check.sh` before push; contracts change own commit; migration collision                   | §2                                       |
| renumber on the second branch with the script; never hand-edit `_journal.json`                    | §2                                       |
| title prefix; PR body content; no model names in commits/PRs; no PR unless asked                  | §3                                       |
| pin count rises only by the citations added                                                       | §3                                       |
| CI on merge ref; read the log first; GraphQL blocked, use REST                                    | §4 (endpoint list `git-rule.md` § 4)     |
| one Codex review; diagnose every red; "flake" not a cause, one re-run                             | §4                                       |
| never skip/quarantine/weaken a test to get green                                                  | §4                                       |
| fix reviewed as hard as the bug; `git status`/`git diff` after agent work                         | §4                                       |
| stacked PR order; shared migration range/`main.recovery.ts`/`app.tsx`/contracts need agreed order | §5                                       |
| merge prep: re-fetch, head SHA, clean `branch-check`, merge commit, watch push CI                 | §6                                       |
| tags / releases are the owner's decision; tag needs green push CI                                 | §7 (detail `git-rule.md` § 7)            |

Migrations:

| Old rule                                                                                                                   | Now                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| read the generated SQL; `db:check` must pass; affected integration through `run-gate.sh`                                   | normal path 3-5                                                                               |
| never edit an applied migration; forward-only                                                                              | Rules 1                                                                                       |
| `drizzle-kit push` banned outside a throwaway DB                                                                           | Rules 2                                                                                       |
| destructive = expand/contract over two releases                                                                            | Rules 3, checklist                                                                            |
| status CHECK via `enumCheck()`; `tenant_id NOT NULL` + leading index; `timestamptz`; no `balance`; money bigint + currency | Rules 4-6, checklist                                                                          |
| `when` = current time, never future; hand-registered entries `Date.now()`                                                  | `when` section, Things drizzle-kit does not model, checklist; story in `migrations-detail.md` |
| remove bad stamp row from `drizzle.__drizzle_migrations`                                                                   | `when` section                                                                                |
| renumber on the second branch; rebuild contracts FIRST; byte-identical; private DB with both env vars                      | Renumbering                                                                                   |
| manual renumber steps 0-4; branch renumbered inside merge commit                                                           | `migrations-detail.md`                                                                        |
| append-only tables; `TRUNCATE` bypasses triggers deliberately                                                              | Rules (last bullet); full text `migrations-detail.md`                                         |
| `0002` forward-only worked example                                                                                         | `migrations-detail.md`                                                                        |

Conventions: money (bigint + currency, no cross-currency, no `balance`, `ConvertedMoney` only for FX, `formatMoney`), time (Clock, no `new Date()`, half-open), tenancy (`tenant_id`, `requireTenantId`, `SystemContext`, Tenant vs BotInstance), the seven-step write path (deny by default for every actor incl. `SYSTEM_JOB`, audit denial), events/audit/operational events kept separate, idempotency (namespaced key, different payload rejected), text (template keys, no literals), secrets (`SecretCipher`, one redaction implementation), all 12 domain invariants incl. Import silence, and the "Never" list stay in `nexa-conventions/SKILL.md`; the long wording is in `conventions-detail.md` and `domain-invariants.md`.

Test selection: never skip/delete/weaken/`.skip`/`.todo` -> top of `SKILL.md`; selector commands and limits -> Step 1 (+ `test-details.md`); three tiers and money-PR `pnpm verify` -> Step 2; runner binding in a round, exit 75 -> Step 2; trap -> Step 2; non-money shortcut limits + "when unsure, it is a money PR" -> Step 2; guard classes -> own section; heavy suites -> own section (+ `test-details.md`); private database per agent, stale history, services up first -> "Running integration safely"; "flake is not a root cause" -> last paragraph.

Code navigation: 800-line rule, big-file paths, runtime/ flow list, snapshot ban, `bot-runtime.ts` must-stop-growing rule, Layout tree (referenced by `CLAUDE.md`), every Step 0/1/2 command and path list -> `SKILL.md`; prose, planes, docs/research lookup tips -> `navigation-detail.md`.

## Usage table

| PRs | Agents               | Model per agent                  | CI cycles  | CLI usage                                |
| --- | -------------------- | -------------------------------- | ---------- | ---------------------------------------- |
| 1   | 1 implementer + lead | implementer: default; lead: lead | see the PR | implementer ≈ 188k tokens, 72 tool calls |
