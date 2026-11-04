# Handoff — NEXA phase 6A (hosted bots part 1)

Lives on `claude/elegant-noether-g9v8x9` only; never merged to main. The round prompt is copied
beside it: `docs/p6a-handoff/NEXA-PHASE6A.md` (binding: merge permission per PR on green + one
Codex fix commit; never push main, never force-push, never tag; don't stop to ask).
Owner (2026-11-04): after every merge, refresh this handoff; after a compact, re-read this and the
prompt and continue with the same rules.

## Facts
- main @ `eaf41d1e8` (Merge #409). Newest migration on main: 0314.

## Merged
- PR-0 https://github.com/Mhoseinshah1/nexa-bot/pull/409 — load harness + baseline, merge `eaf41d1e8`.
  Codex 3 findings fixed in `54dd9661f`.

## Open / in progress (local worktrees, not pushed)
- PR-1a RLS: branch `feat/p6a-d0-tenant-hardening`, worktree /home/user/wt-p6a-rls, DB nexa_test_rls (Opus agent).
- PR-1b ops: branch `feat/p6a-d0-hardening-ops`, worktree /home/user/wt-p6a-ops, DB nexa_test_ops (Opus agent):
  off-site write-only S3 backups, owner security alerts, `botctl harden check`. Lead merges it into
  PR-1's branch, renumbers its migration after RLS's, then one PR-1.
- Not started: PR-2 capacity guards (Opus), PR-3 creator panel, PR-4 activation, PR-5 isolation proof, PR-6.

## Decisions taken
- Push to the named branches works this session (tested), so each PR has its own branch.
- `gh auth status` reports the token invalid, but `gh api` REST (ci-status.sh) works; PRs, merges,
  and the `@codex review` comment go through the GitHub MCP tools.
- `ci-status.sh --wait` returns early here; wait with a background until-loop on `ci-status.sh <pr>`.
- PR-0 CI: the first head's "Deployment update and rollback smoke" failed in the Docker apt step
  (not touched by the PR). It went green on the fix head without a rerun.
- PR-1 is split across two implementers (RLS / ops) to keep 2 busy; it ships as one PR.

## Next step
- When an implementer reports: review its diff, then start PR-2 (Opus) in the freed slot.
