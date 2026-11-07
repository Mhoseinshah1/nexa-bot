# Capacity after the worker fan-out (phase 6A PR-6)

PR-6 made every per-tenant worker loop serve every ACTIVE tenant (`TenantFanOut`,
`apps/api/src/infrastructure/lifecycle/tenant-pass.ts`) instead of the installation's tenant
only, and binds each outbox consumer to its event's tenant under row-level security. That changes
how much the worker does, so the PR-0 harness was re-run once: the steady scenario, the same
parameters as `baseline.md` and `after-guards.md` (50 tenants × 2 customers, a 50 000-recipient
broadcast on the installation tenant, one real `backup run`), commit `8a8d3e000`. Raw output:
`load-results/2026-11-07T09-56-36-379Z-pr6-steady/` (git-ignored).

The machine was quieter than for the PR-2 runs (load average 1.5 before the run, against 3 to 4.5),
so the webhook numbers are better for that reason, not because of this change. Read the worker
rows, which this change is about.

| measure               | after guards (PR-2) | after fan-out (PR-6)   |
| --------------------- | ------------------- | ---------------------- |
| req/s                 | 62.5                | 86                     |
| p50 / p95 / p99 ms    | 554 / 1208 / 1593   | 133 / 333 / 475        |
| errors                | 0 %                 | 0 %                    |
| API RAM / CPU         | 580 MB / 101 %      | 638 MB / 93 %          |
| **worker RAM / CPU**  | 295 MB / 13 %       | **558 MB / 44 %**      |
| worker pool queued    | —                   | 5.2 % (max wait 34 ms) |
| outbox lag            | 0 s                 | 0 s                    |
| notifications pending | —                   | 0                      |
| broadcast sends/s     | 17.9 (owner 25/s)   | 16.7                   |
| backup                | exit 0              | exit 0 in 9.8 s        |

What it means for the 4 vCPU / 8 GB server:

- The worker now does each loop's pass 50 times, so it costs about three times the CPU (44 % of
  one core on average, 83 % at the peak) and about 260 MB more memory, with no queue behind it:
  outbox and notification lag stayed at zero, and no loop was reported stalled.
- The worker's memory limit from PR-2 is `NEXA_MEM_WORKER`, 819 MB by default on an 8 GB host
  (`deploy/compose.yml`). The peak here was 588 MB, so 50 bots fit with about 230 MB to spare; an
  install that grows past that should raise `NEXA_MEM_WORKER` before adding bots.
- The estimate from `after-guards.md` (how many bots fit within p95 < 1 s) is unchanged by this PR:
  the limit there was the API and PostgreSQL under webhook load, and the worker's extra core-fraction
  is inside the headroom that estimate left. Re-measure on the real server (the owner's checklist).
