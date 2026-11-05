# Handoff — NEXA phase 6A (hosted bots part 1) — PAUSED by the owner

Lives on `claude/elegant-noether-g9v8x9` only; never merged to main. The round prompt is copied
beside it: `docs/p6a-handoff/NEXA-PHASE6A.md` (binding: merge permission per PR on green + one
Codex fix commit; never push main, never force-push, never tag; don't stop to ask).
Owner rules added mid-round: (2026-11-04) refresh this handoff after every merge; after a compact,
re-read this and the prompt and continue. (2026-11-05) build beside existing code, no rewrites;
diff-check (no deletions / wholesale rewrites) before every merge and say so in the PR text.
(2026-11-05) PAUSE: agents finished their step, all work committed and pushed, then STOP.

## Facts
- main @ `6e2ac88f1` (Merge #410). Newest migration on main: 0315_capacity_guards.
- No uncommitted work anywhere; every branch below equals its origin copy.

## Merged
- PR-0 https://github.com/Mhoseinshah1/nexa-bot/pull/409 — load harness + baseline, merge `eaf41d1e8`.
- PR-2 https://github.com/Mhoseinshah1/nexa-bot/pull/410 — capacity guards, merge `6e2ac88f1`.

## Open branches (last sha) and next step for each
1. PR-1 https://github.com/Mhoseinshah1/nexa-bot/pull/411 — `feat/p6a-d0-tenant-hardening` @ `4a8fbdc9b`
   (RLS + off-site backups + owner alerts + harden check; migrations 0316 ops, 0317 RLS; ADR-0037).
   Codex: its one review (P2, per-PUT signing time) is fixed in `080482022`. Do not request Codex again.
   Open CI failures on the previous head `080482022`:
   - Integration tests (9/10): `reminder-quiet-hours.test.ts` failed at 09:00 Tehran, because the new start
     equals the default end. Test fix `4a8fbdc9b` (writes the end first on collision). Not
     reproducible locally.
   - Legacy rehearsal (synthetic, MySQL 8.0): the panels helper died under tsx, because the harness
     imported the API bootstrap (decorators) at load. Fix `4014187f1` (lazy import); the helper start-up
     was verified locally, but the full MySQL rehearsal was not run (no MySQL here).
   NEXT: wait for CI on `4a8fbdc9b` (`bash scripts/claude/ci-status.sh 411`; `--wait` returns early, so loop).
   If green: diff-check, then merge as a merge commit. If the rehearsal is still red: read the helper log
   from that run. A second failure of a job counts as real.
2. PR-3 backend `feat/p6a-d1-creator-panel` @ `fd3724338`, UI `feat/p6a-d1-creator-panel-ui` @ `db4cfe4e6`
   (UI branch = backend + main merge + UI + lead typecheck fix). No PR yet. Migrations 0316_hosted_bots,
   0317_hosting_permission_grant → renumber after PR-1 (to 0318/0319). ADR-0038.
   NEXT (after PR-1 merges): merge main into the UI branch; route `HostedTenantSystemPath`
   (provision/closeForPurge) and the hosting repository's cross-tenant reads through the RLS system path
   (`withSystemScopeIn`, add them to tests/unit/system-path-allowlist.ts); run hosting-panel as nexa_app;
   open a single PR-3 from `feat/p6a-d1-creator-panel-ui`, request Codex, CI, merge.
3. PR-4 `feat/p6a-d2-activation` @ `0d0e3797d` (top is a WIP commit; stacked on the PR-3 UI branch).
   Spec items 1–6 are done (token, DNS, SSL probe, webhook, one-time link, /activate, Host→tenant
   sign-in, Caddy on-demand TLS `ask`). Migration 0318 (renumber after PR-3). It needs the system path
   for DrizzleHostedDomainDirectory, DrizzleHostedBotRegistrar and DrizzleHostedOwnerActivation.
   NEXT: finish its own check (full `pnpm test` + `pnpm test:deploy`; confirm `backup-cli.test.ts`
   fails on base too, since it runs as root locally), turn the WIP into a feature commit with a merge
   (never a rebase of pushed work), and the lead reviews it. After PR-3 merges: merge main, renumber,
   system path, open PR-4.
4. Not started: PR-5 isolation proof (Opus; must also flip PR-3's create-gate release marker), PR-6
   (only if PR-5 or the load test exposes something), the phase report, and the #358 comment.

## Decisions taken
- Push to the named branches works this session, so each PR has its own branch.
- `gh auth status` says the token is invalid, but `gh api` REST (ci-status.sh) works. PRs, merges and
  `@codex review` go through the GitHub MCP tools.
- `ci-status.sh --wait` returns early here, so wait with a background until-loop (ignore green=0 pending=0).
- PR-1 was built by two implementers (RLS / ops) and merged into one branch.
- RLS design (ADR-0037): the owner `nexa` migrates. Serving processes connect as `nexa_app` (no BYPASSRLS)
  via DATABASE_APP_URL. The system path is SET ROLE nexa_system with a bound reason. Unscoped
  @ScopeBound calls run on the system path as `Class.method`, pinned by tests/unit/system-path.test.ts.
  An unbound statement raises.
- Hosted bot = a new tenant kind HOSTED, a child of the installation tenant (ADR-0038). The creator panel
  has its own TOTP factor and a 12 h section cookie. The create gate = env flag AND a compiled marker
  that PR-5 sets.
- PR-4: the owner enters the token and domain in the panel on the hosted owner's behalf.
- The container restarted once mid-round; the worktrees survived, and the branches were pushed as backups.
- Three agents were briefly active (RLS, PR-3, PR-2 CI/Codex fix); the fix counted as CI triage.

## Local state (lost on reclaim, all pushed)
Worktrees /home/user/wt-p6a-{load,ops,cap,rls,panel,panel-ui,act}; remove them at round end. Remote
branches to delete after merge: test/p6a-load-harness, feat/p6a-capacity-guards,
feat/p6a-d0-hardening-ops (merged into PR-1).
