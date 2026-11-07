# Handoff — NEXA phase 6A (hosted bots part 1) — PHASE COMPLETE, 2026-11-07

Lives on `claude/elegant-noether-g9v8x9` only; never merged to main. Binding prompts:
`docs/p6a-handoff/NEXA-PHASE6A.md` (the phase brief; merge permission per PR on green + one Codex
fix commit; never push main, never force-push, never tag; don't stop to ask) and the resume brief
`NEXA-PHASE6A-RESUME.md` (owner upload, same rules). Owner rules from earlier sessions still bind:
refresh this handoff after every merge; build beside existing code, no rewrites; diff-check before
every merge and say so in the PR text.

## Merged (main)

- PR-0 #409 load harness — `eaf41d1e8`. PR-2 #410 capacity guards — `6e2ac88f1`.
- PR-1 https://github.com/Mhoseinshah1/nexa-bot/pull/411 — RLS, off-site backups, owner alerts, harden check — `8d578033c`. Migrations 0317/0318.
- PR-3 https://github.com/Mhoseinshah1/nexa-bot/pull/415 — creator panel «میزبانی‌ها» — `6cce12807`. Migrations 0319/0320.
- PR-4 https://github.com/Mhoseinshah1/nexa-bot/pull/416 — activation (token, DNS, SSL, webhook, one-time link) — `ac695dffa`. Migration 0321.

- PR-5 https://github.com/Mhoseinshah1/nexa-bot/pull/417 — isolation proof (tests only) — `be9c1ab73`.
- PR-6 https://github.com/Mhoseinshah1/nexa-bot/pull/418 — worker serves every active tenant (`TenantFanOut`),
  outbox consumers under their event's tenant's RLS, PR-5's placeholders made real, **create gate released** — `6e43b80c1`.
- main @ `6e43b80c1`; newest migration still 0321_hosted_bot_activation (PR-6 added none).

## Open

- Nothing. Phase 6A is finished; the session STOPPED after the report, the #358 comment and cleanup.

## Next step (exact)

Phase 6B in a NEW session (brief §4.5): D4 limits UI polish, D5 owner access without audit, D6 server
move, D7 per-bot backups through the shared heavy-job queue. Read `docs/round-reports/phase-6a.md`
(on this branch) first. Open threads for 6B: a second API process is the throughput ceiling
(after-guards.md); per-bot backups replace the installation-only backup loops PR-6 left alone.

## Decisions taken

- PR-6 (this session): loops reused unchanged, only their `scope` input became a `TenantFanOut` pass.
  Owner's bot first every pass, others rotate, one-interval budget, owner + at least one other bot always
  served; one hosted bot's failure never fails the pass. ACTIVE tenants only, no fallback, except
  `tenants: 'all'` for the gift-card plaintext purge and the provisioner (announcer exception).
- PR-6 needed three CI-fix commits after the single Codex fix (citations, provisioner/stopped, a test
  window): recorded in the report, no force-push.
- The phase report lives on this session branch (beside the handoff), not on main.
- `feat/p6a-d0-hardening-ops` is fully contained in #411; left unused. Delete it with the other merged branches.
- Installation tenant guard FAILS CLOSED (owner, 2026-11-07): each role records the cached tenant's kind
  when it sets it (boot, backup CLI, restore re-resolve). Only a vanished tenant recorded as PRIMARY may
  re-resolve to findPrimary() (#413 restore). Any other kind, or UNKNOWN: no fallback, writes refused,
  scope stopped, one CRITICAL owner-only ops alert (`tenancy.cached_tenant_vanished`); UNKNOWN also exits 1.
  The earlier "first-check edge case" acceptance is withdrawn.
- That fix shipped as a contract commit plus a fix commit, not one commit: CLAUDE.md requires a contract
  change in its own commit (that safety rule wins over the prompt). The same applies to PR-4's
  `hosting.activation_token_differs`.
- prune-empty decides on the system path (reason "customer prune: dependents in every tenant");
  customers are confined by an explicit tenant predicate; the DELETE runs under the tenant's own binding.
- PR-3: `hosting.manage` is dropped from login/session permission lists unless the session is the
  installation tenant's `owner`. The server-side HostingOwnerGuard already enforces this.
- PR-4: a different valid token for the same Telegram bot is refused, not silently ignored. A domain
  change revokes open links in the same transaction, and redemption requires the current verified host
  with its DNS, SSL and webhook marks.
- **The create gate stays closed** (lead, PR-5): the implementer flipped it, and the lead reverted the flip,
  because the worker does not serve hosted tenants yet. PR-6 flips it.
- The container restarted twice; the worktrees and uncommitted PR-5 files survived both times.
- `gh pr`/GraphQL are blocked. `gh api` REST and the GitHub MCP tools work, for PRs, merges and `@codex review`.

## Local state

No agent worktrees left; nexa_test was recreated this session (stale migration 0296), nexa_load holds
the PR-6 load fixture (safe to drop).
Known flaky unit test, not phase work: `tests/unit/rickpanel-load-protection.test.ts` "two reads of the same panel at once
never overlap". It compares real 15 ms timer pacing with only 1 ms of slack, and failed once on CI for #417.
Candidate for a small fix: use a fake clock.
Remote branches to delete after the phase: test/p6a-load-harness, feat/p6a-capacity-guards,
feat/p6a-d0-hardening-ops, feat/p6a-d0-tenant-hardening, feat/p6a-d1-creator-panel(-ui),
feat/p6a-d2-activation, and test/p6a-d3-isolation-proof once merged.
