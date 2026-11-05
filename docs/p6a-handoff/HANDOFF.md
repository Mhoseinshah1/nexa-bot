# Handoff — NEXA phase 6A (hosted bots part 1)

Lives on `claude/elegant-noether-g9v8x9` only; never merged to main. The round prompt is copied
beside it: `docs/p6a-handoff/NEXA-PHASE6A.md` (binding: merge permission per PR on green + one
Codex fix commit; never push main, never force-push, never tag; don't stop to ask).
Owner (2026-11-04): after every merge, refresh this handoff; after a compact, re-read this and the
prompt and continue with the same rules.

## Facts
- main @ `6e2ac88f1` (Merge #410). Newest migration on main: 0315_capacity_guards.

## Merged
- PR-0 https://github.com/Mhoseinshah1/nexa-bot/pull/409 — load harness + baseline, merge `eaf41d1e8`.
  Codex 3 findings fixed in `54dd9661f`.
- PR-2 https://github.com/Mhoseinshah1/nexa-bot/pull/410 — capacity guards, merge `6e2ac88f1`.
  Codex 2×P1 fixed `9051ec008`; CI fix `cd6e2150a` (new-customer rate hit fixtures); security
  review fix `a19e5071b` (Mini App intake rate-limited; required `intake` on resolveFromUpdate).

## Open / in progress (local worktrees, not pushed)
- PR-1a RLS: branch `feat/p6a-d0-tenant-hardening`, worktree /home/user/wt-p6a-rls, DB nexa_test_rls (Opus agent).
- PR-1b ops: branch `feat/p6a-d0-hardening-ops`, worktree /home/user/wt-p6a-ops, DB nexa_test_ops (Opus agent):
  off-site write-only S3 backups, owner security alerts, `botctl harden check`. Lead merges it into
  PR-1's branch, renumbers its migration after RLS's, then one PR-1.
- PR-1 = RLS branch `feat/p6a-d0-tenant-hardening` (pushed backup) + ops branch merged in; agent is
  merging ops + main, renumbering ops→0316, RLS→0317, pinning the system-path allowlist. ADR-0037.
- PR-3 backend: branch `feat/p6a-d1-creator-panel`, worktree /home/user/wt-p6a-panel, stacked on PR-2
  (Opus agent). UI (Sonnet) after it. Create action gated until PR-1 + PR-5 merge.
- Not started: PR-4 activation, PR-5 isolation proof, PR-6.

## Decisions taken
- Push to the named branches works this session (tested), so each PR has its own branch.
- `gh auth status` reports the token invalid, but `gh api` REST (ci-status.sh) works; PRs, merges,
  and the `@codex review` comment go through the GitHub MCP tools.
- `ci-status.sh --wait` returns early here; wait with a background until-loop on `ci-status.sh <pr>`.
- PR-0 CI: the first head's "Deployment update and rollback smoke" failed in the Docker apt step
  (not touched by the PR). It went green on the fix head without a rerun.
- PR-1 is split across two implementers (RLS / ops) to keep 2 busy; it ships as one PR.

- Container restarted once mid-round; worktrees survived; branches pushed to origin as backups after.
- Three agents were briefly active (RLS, PR-3, PR-2 CI/Codex fix); the fix counted as CI triage.
- RLS design: owner `nexa` migrates; serving processes connect as `nexa_app` (no BYPASSRLS) via
  DATABASE_APP_URL; system path = SET ROLE nexa_system with a bound reason; unscoped @ScopeBound
  adapter calls run on the system path with reason `Class.method` (lead asked for an allowlist pin).
- Owner (2026-11-05): build beside existing code; no rewrites; diff-check before each merge, say it in PR text.

## Next step
- When the RLS agent reports: review, push PR-1, Codex, CI, merge. Then PR-3 UI (Sonnet), PR-4, PR-5.
