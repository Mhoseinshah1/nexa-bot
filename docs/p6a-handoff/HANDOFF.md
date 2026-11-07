# Handoff — NEXA phase 6A (hosted bots part 1) — stopped at the context budget, 2026-11-07

Lives on `claude/elegant-noether-g9v8x9` only; never merged to main. Binding prompts:
`docs/p6a-handoff/NEXA-PHASE6A.md` (the phase brief; merge permission per PR on green + one Codex
fix commit; never push main, never force-push, never tag; don't stop to ask) and the resume brief
`NEXA-PHASE6A-RESUME.md` (owner upload, same rules). Owner rules from earlier sessions still bind:
refresh this handoff after every merge; build beside existing code, no rewrites; diff-check before
every merge and say so in the PR text.

## Merged (main)
- PR-0 #409 load harness — `eaf41d1e8`.  PR-2 #410 capacity guards — `6e2ac88f1`.
- PR-1 https://github.com/Mhoseinshah1/nexa-bot/pull/411 — RLS, off-site backups, owner alerts, harden check — `8d578033c`. Migrations 0317/0318.
- PR-3 https://github.com/Mhoseinshah1/nexa-bot/pull/415 — creator panel «میزبانی‌ها» — `6cce12807`. Migrations 0319/0320.
- PR-4 https://github.com/Mhoseinshah1/nexa-bot/pull/416 — activation (token, DNS, SSL, webhook, one-time link) — `ac695dffa`. Migration 0321.

- PR-5 https://github.com/Mhoseinshah1/nexa-bot/pull/417 — isolation proof (tests only) — `be9c1ab73`. Create gate still CLOSED.
- main @ `be9c1ab73`; newest migration 0321_hosted_bot_activation.

## Open
- Nothing open. PR-6 not started.

## Next step (exact)
1. (done: #417 merged)
2. PR-6 `fix/p6a-hardening-followups` (money tier), from the latest main:
   a. **The worker must serve every active tenant**, not only `installationTenantId`: notifications,
      reminders, payment expiry, gateway inquiry, broadcasts, provisioning and the other per-tenant
      loops. Use the PR-2 round-robin/fair share, take each tenant's scope in its own transaction,
      read ScopeActivityReader, and never fall back to PRIMARY. This is the `it.fails` case in
      `tests/integration/isolation-proof/worker-jobs.test.ts`; turn it into a passing `it`.
   b. Bind each outbox consumer's transaction to its event's tenant (RLS), not the system role.
      This is the second `it.fails`.
   c. Enable the `describe.skip` PR-4 activation/Host-sign-in block in the isolation suite.
   d. ONLY then flip the create gate's release marker. Revert commit 4a80bdca1 on the PR-5 branch is
      the reference; the gate lives in `apps/api/src/modules/platform/hosting/domain/create-gate.ts`.
   e. Re-run the PR-0 load test only if PR-6 changes the worker loops materially, and note it in the report.
3. End of phase (brief §4): `docs/round-reports/phase-6a.md` (≤150 lines, with load numbers before
   and after from docs/capacity/*.md); the #358 comment «فاز 6A — میزبانی‌ها، بخش ۱» with the owner's
   test steps, ending `sudo botctl roles disable provisioner monitor`; this handoff; cleanup; STOP.

## Decisions taken
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
No worktrees left, and the private test databases are dropped.
Known flaky unit test, not phase work: `tests/unit/rickpanel-load-protection.test.ts` "two reads of the same panel at once
never overlap". It compares real 15 ms timer pacing with only 1 ms of slack, and failed once on CI for #417.
Candidate for a small fix: use a fake clock.
Remote branches to delete after the phase: test/p6a-load-harness, feat/p6a-capacity-guards,
feat/p6a-d0-hardening-ops, feat/p6a-d0-tenant-hardening, feat/p6a-d1-creator-panel(-ui),
feat/p6a-d2-activation, and test/p6a-d3-isolation-proof once merged.
