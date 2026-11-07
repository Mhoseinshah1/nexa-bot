# Phase 6A report — hosted bots, part 1 (isolation, creator panel, activation, capacity)

Brief: `docs/p6a-handoff/NEXA-PHASE6A.md`. Seven PRs, all merged as merge commits on green CI after
one Codex review and one fix commit each (PR-6 also needed three CI-fix commits, below). Phase 6B (D4–D7) starts in a new session.

## PRs

| PR        | Branch                         | What                                                                                                                                                       | Merge       |
| --------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| PR-0 #409 | `test/p6a-load-harness`        | Repeatable load test (`scripts/load/`), baseline                                                                                                           | `eaf41d1e8` |
| PR-1 #411 | `feat/p6a-d0-tenant-hardening` | RLS on every tenant table (ADR-0037, supersedes ADR-0004), off-site write-only backups, owner security alerts, `botctl harden check`. Migrations 0317/0318 | `8d578033c` |
| PR-2 #410 | `feat/p6a-capacity-guards`     | Memory limits, per-bot fair share, spread schedules, disk/RAM/lag alerts                                                                                   | `6e2ac88f1` |
| PR-3 #415 | `feat/p6a-d1-creator-panel`    | «میزبانی‌ها» creator panel, TOTP 2FA section. Migrations 0319/0320                                                                                         | `6cce12807` |
| PR-4 #416 | `feat/p6a-d2-activation`       | Token, DNS, SSL, webhook, one-time activation link. Migration 0321                                                                                         | `ac695dffa` |
| PR-5 #417 | `test/p6a-d3-isolation-proof`  | Cross-tenant isolation proof, every surface; mutation-checked                                                                                              | `be9c1ab73` |
| PR-6 #418 | `fix/p6a-hardening-followups`  | Worker serves every active tenant; consumers under RLS; placeholders made real; create gate released                                                       | `6e43b80c1` |

## PR-6 in detail (this session)

PR-5 left three marked gaps and the create gate deliberately closed:

1. **The worker served the installation tenant only.** Every per-tenant loop was built with one fixed
   scope, so a hosted bot's reminders, notifications, gateway inquiries, broadcasts and provisioning
   never ran (fail-closed, no leak). Fix: `TenantFanOut` (`infrastructure/lifecycle/tenant-pass.ts`).
   The loops are reused unchanged; only their `scope` input is now a pass over the ACTIVE tenants, and
   the same body runs once per tenant in that tenant's scope.
   - Fair: owner's bot first every pass (PR-2's priority), the rest in a rotation that resumes where
     the last pass stopped; a one-interval budget, after which unreached bots go first next pass; the
     owner plus at least one other bot always served.
   - Contained: one hosted bot's failure is logged; the pass (and worker readiness) fails only when
     the owner's bot or every bot failed.
   - No fallback to the installation tenant. Non-ACTIVE tenants are not served; their work waits.
     Two exceptions take `tenants: 'all'`: the gift-card sweep (its plaintext-export purge keeps the
     24-hour promise for a stopped bot) and the provisioner (its outcome announcer tells a paying
     customer what became of work already done; its other lanes refuse a stopped scope themselves).
   - 20 loops converted; per-pass state that was implicitly single-tenant (reminder last-run, FX
     back-off, retention streaks, gateway inquiry health, assistant timers) keyed by tenant.
     Installation-wide work (backup, recovery, compaction, capacity monitor, restart/stall reports)
     unchanged — per-bot backups are 6B D7.
2. **Outbox consumers ran on the system role.** `withTenantScopeIn` binds each consumer's effect to
   its event's tenant as `nexa_app`; mutation check: without it the role is `nexa_system`.
3. **Placeholders.** Both `it.fails` worker cases now pass as `it`; the PR-4 `describe.skip`/`it.todo`
   block is five real tests (sign-in by host, wrong-host credentials, one-time link on a foreign
   domain, activation routes, certificate ask), red under two mutations.
4. **Create gate released** only after 1–3, in its own commit. `HOSTED_BOTS_CREATE_ENABLED` remains
   the operator's second key; it is off by default.

Codex (one review) found one real P2: a pass always serves two tenants, so the gateway and FX stall
windows must allow two tenants' bounds; fixed in `abd3c0c82`. Three more commits fixed red CI checks
after it, each recorded here because the brief allows one fix commit: falsification citations that
named the renamed test (`29b0a307b`); the provisioner now covers stopped tenants as it always had,
because its announcer is the stated exception in `docs/conventions.md` (`d4cca5baf`); and an
integration test that still sized the dead-lane window from one bound (`3a7073ffd`). No force-push.

Found in lead review and fixed before the PR: the budget was checked right after the owner's bot, so
an owner pass longer than the budget would have starved every hosted bot; and an ACTIVE-only sweep
would have kept a stopped bot's plaintext gift-card codes past 24 h.

## Load numbers (sandbox: 4 vCPU 2.1 GHz VM, 50 tenants, steady 100 customers, broadcast + backup)

| measure               | baseline (PR-0)           | after guards (PR-2)       | after fan-out (PR-6) |
| --------------------- | ------------------------- | ------------------------- | -------------------- |
| req/s                 | 62.5                      | 62.5                      | 86                   |
| p50 / p95 / p99 ms    | 555 / 1212 / 1496         | 554 / 1208 / 1593         | 133 / 333 / 475      |
| errors                | 0 %                       | 0 %                       | 0 %                  |
| API RAM / CPU         | 580 MB / 105 %            | 580 MB / 101 %            | 638 MB / 93 %        |
| worker RAM / CPU      | 264 MB / 11 %             | 295 MB / 13 %             | 558 MB / 44 %        |
| outbox lag            | 0 s                       | 0 s                       | 0 s                  |
| breaking point (ramp) | 100 concurrent, p95 1.4 s | ~75 with backup+broadcast | not re-ramped        |

The PR-6 machine was quieter (load 1.5 vs 3–4.5), so its webhook numbers are better for that reason.
What PR-6 changes is the worker: ~3× CPU and +260 MB at 50 tenants, no queue, inside the 819 MB
default worker limit. Details: `docs/capacity/{baseline,after-guards,after-fan-out}.md`.

**How many bots this server holds (p95 < 1 s, backup and broadcast running):** about 75 concurrently
active customers in total — e.g. the owner's bot at ~25 plus 50 small hosted bots at ~1 each, or the
owner plus ~15 medium bots at 3, or 5 large at 10. Without the backup/broadcast windows about 100.
Fifty medium bots need a second API process (6B question), not a limit. Re-measure on the real server.

## Decisions taken (phase)

- One push branch per PR, opened in order; the session branch carries only the handoff and this report.
- Contract changes went in their own commits (CLAUDE.md wins over the brief's "one fix commit").
- Installation tenant guard fails closed (owner, 2026-11-07).
- The create gate stayed closed after PR-5 (lead reverted the flip) and was released by PR-6.
- PR-6 serves ACTIVE tenants (stopped ones too only for the gift-card purge and the provisioner) and
  never falls back to the installation tenant.
- The owner's bot is served first on every pass; hosted bots rotate and are never starved.
- Load test re-run once (steady) for PR-6 because it changes the worker materially; no ramp re-run.

## Known issues / for 6B

- Flaky unit test `tests/unit/rickpanel-load-protection.test.ts` ("two reads of the same panel at
  once never overlap"): 15 ms real-timer pacing with 1 ms slack; needs a fake clock.
- A stopped hosted bot's queued background work waits until it is reactivated (by design).
- Per-bot backups (D7), limits UI polish (D4), owner access without audit (D5), server move (D6).
- One API process is the throughput ceiling (~60–67 req/s here).
