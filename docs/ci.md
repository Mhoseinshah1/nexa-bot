# CI and the release gate

How `.github/workflows/ci.yml` runs, what `release.yml` accepts as proof that a
commit passed it, and what to do when a release says it cannot find that proof.

## What triggers CI

| Event                         | Runs for                          | Concurrency group          | Cancelled by a newer run?         |
| ----------------------------- | --------------------------------- | -------------------------- | --------------------------------- |
| `pull_request`                | the PR's merge ref, once per head | `CI-pr-<number>`           | **yes** — a newer head of that PR |
| `push` to `main`              | exactly that main commit          | `CI-refs/heads/main-<sha>` | **never**                         |
| `workflow_dispatch` (any ref) | exactly the head of that ref      | `CI-<ref>-<sha>`           | **never**                         |

Pushes to other branches do not run CI. They used to, and every PR head ran
twice — once on `push`, once on `pull_request` — doubling the load on a runner
pool that was already the bottleneck. A branch with no PR gets CI by opening the
PR, or by **Actions → CI → Run workflow** on that branch. A PR with merge
conflicts gets no `pull_request` run at all (GitHub cannot build the merge ref);
resolve the conflict, or dispatch CI on the branch.

### Why main is never cancelled

The old group was `CI-<ref>` with `cancel-in-progress: true` for every event.
Two merges a minute apart cancelled the first merge's run, so that SHA was left
with no completed CI — and when `v0.4.3` was tagged on such a commit, the
release gate correctly refused it. A re-run of an older main SHA landed in the
same group as the newest main run and cancelled it, or was cancelled by it.

Each main commit now has its own group. A shared group with
`cancel-in-progress: false` would not have been enough: GitHub keeps at most one
**pending** run per group, so a third merge still cancels the second one's
queued run. `tests/unit/ci-workflow.test.ts` evaluates the group and
`cancel-in-progress` expressions for push, dispatch and pull-request contexts
and fails if two main commits share a group or any main run can be cancelled.

## Jobs

```
changes ──────────┬──────────────────── Changed paths (which jobs this PR needs)
static ───────────┼──────────────────── Typecheck, lint and boundaries
build ──┬── unit ─┼─────────┐
        ├── web ──┼─────────┤
        ├── integration 1..18 (skippable)
        ├── legacy-mysql ×1–2 (skippable)
        └── legacy-rehearsal┼────────── Unit and integration tests (aggregate)
deploy-logic ─────┼─────────┤
deploy ───────────┼─────────┤ (skippable) Deployment smoke + Mirza rehearsal smoke
deploy-update ────┴─────────┘ (skippable) Deployment update and rollback smoke
audit ──────────────────────────────── Dependency audit (skippable)
```

- **build** compiles once (stamped with the SHA), runs the built-output smoke,
  `check:runtime` and the migration drift check, and uploads the four `dist`
  directories as the `dist` artifact. `unit`, `web` and every integration shard
  download it instead of building again, so every test job runs the same bytes.
- **integration** is an 18-way matrix over `vitest --shard=i/18`. The shard a
  file lands in is decided by `tests/support/timed-sequencer.mts`, which the
  root vitest config installs: longest file first, each into the shard with the
  least measured work so far, weights from `tests/support/integration-timings.json`.
  Every shard computes the same partition from the same file list, so every
  file runs in exactly one shard — `timed-sequencer.test.ts` checks that for
  every count from 1 to 24, and a file missing from the table (a new one) still
  runs, weighted at the median. Each shard has its own PostgreSQL and Redis, so
  suites inside a shard still run one file at a time against a database nothing
  else touches. Each shard applies the compiled migrations without application
  secrets before its tests — the same guard the single job had.
- **Unit and integration tests** is the old job's name, kept as the one check
  that ALWAYS reports. It runs `if: always()` and is green only when `changes`,
  `unit`, `web`, `deploy-logic`, every shard, both legacy jobs and both
  deployment smokes succeeded. The only other result it accepts is `skipped`
  for a job `changes` left out: the event is `pull_request`, `changes`
  succeeded, said `full=false` AND said that job's own scope is `false`
  (`scripts/ci-aggregate.sh`). A job that was in scope and skipped or
  cancelled is a failure on every event.
- **Deployment logic** (shellcheck, botctl against a fake docker, the shell
  check's own test, the release gate against a fake `gh`), **Deployment smoke**
  (the real image, install, serve, back up; then the Mirza rehearsal kit) and
  **Deployment update and rollback smoke** (A → B, two releases that never
  become ready, B → A) are independent and run side by side. The update smoke
  is its own job because it is eleven minutes on its own, most of it the
  readiness timeouts it exists to exercise.

Coverage is unchanged: every command the workflow ran before the split is still
run, and `ci-workflow.test.ts` lists them.

### Which jobs a pull request runs

`changes` runs `scripts/ci-scope.sh`, which reads the merge commit against its
first parent (`--no-renames`, so a rename counts both sides) and prints one
output per job group: `full`, `unit`, `web`, `integration`, `legacy`, `deploy`,
`deploy_logic`, `audit`, and `legacy_engines` (the legacy-mysql matrix). Every
changed path is classified; the PR runs the **union** of its paths' jobs. Static
and build run on every run.

| A changed path under …                                                                                                                                        | adds                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `docs/**/*.md`, `README.md`, `CLAUDE.md`, `PROGRESS.md`                                                                                                       | unit, web, deploy-logic (today's docs-only rule)   |
| `apps/web/**`, `apps/miniapp/**`, `tests/web/**`, `scripts/web-shots/**`                                                                                      | unit, web                                          |
| `apps/api/src/**`, `packages/i18n/**`                                                                                                                         | unit, web, integration                             |
| the importer (`apps/api/src/modules/*/legacy*`, `nxpkg`, `legacy-*.ts`, `cutover-*`), `tests/legacy-mysql/**`, `tests/fixtures/legacy/**`, `scripts/legacy-*` | + legacy-mysql (MySQL 8.0 only) + legacy-rehearsal |
| entry points, `*.cli.ts`, the migrator, backup, the recovery role                                                                                             | + legacy, + both deployment smokes                 |
| `deploy/**`, `Dockerfile*`, compose files, `scripts/install*`, `scripts/*deploy*`, the smoke scripts                                                          | + both deployment smokes, deploy-logic             |
| `tests/unit/**` / `tests/integration/**`                                                                                                                      | unit / unit, integration                           |
| `pnpm-lock.yaml`, any `package.json`, `pnpm-workspace.yaml`, `.npmrc`                                                                                         | + dependency audit                                 |
| **fail-safe:** `packages/contracts/**`, `apps/api/drizzle/**` (every migration), `pnpm-lock.yaml`, any `package.json`, `.github/**`, `scripts/ci-*`           | **everything**                                     |
| **anything no rule names**, or a diff that cannot be read                                                                                                     | **everything**                                     |

Two choices the table encodes:

- **Unit runs on every run.** The unit project reads files of every class (the
  web and mini-app sources, `deploy/`, the Dockerfile, the legacy fixtures,
  `scripts/`, `docs/`), so no path can show it does not need unit.
- **A migration is fail-safe**, not just "+ deployment smokes": `apps/api/drizzle/**`
  runs everything, the smokes included.

On a pull request the dependency audit runs only when the dependency graph
changed, and the legacy-mysql matrix holds MySQL 8.0 only (MirzaBot's production
engine). A push to main, a dispatch and the nightly run the audit and both
engines (MariaDB 10.11 and MySQL 8.0).

`tests/unit/ci-workflow.test.ts` holds a table test (a sample changed-file list
per rule → the expected outputs, unknown path → full, push/dispatch/schedule →
full), scans what each skippable job reads so a class cannot leave out a job
that reads its files, and drives `scripts/ci-aggregate.sh` with every result ×
scope × event. `scripts/mutate-ci-scope.py` reverts each rule in turn (the
fail-safe rule, the unknown-path rule, the aggregate's scope/event/full checks,
an accepted cancel, a dropped job, the engine matrix, the nightly wiring and its
report) and confirms a test goes red.

### The nightly run

`.github/workflows/nightly.yml` (formerly `exhaustive.yml`) runs at 03:00 UTC
on main: the whole of `ci.yml` as a reusable workflow (event `schedule`, so
full: every shard, both smokes, both legacy engines, the audit) plus the
exhaustive notification orderings. When either is red it opens one issue titled
«CI شبانه قرمز است» listing the failing jobs, or comments on the open one
(`scripts/ci-nightly-report.sh`, REST only; the `report` job is the only one
with `issues: write`). The release gate never counts a nightly run: its path is
`nightly.yml`, and the gate accepts only push and dispatch runs of `ci.yml`.

**A push to main, a dispatched run and the nightly never skip anything.** Those runs are what
`release.yml` accepts as evidence, so a release can never rest on a skipped job.
The aggregate refuses a skip on any event but `pull_request`, independently of
the script, and both halves have a test that fails when the rule is reverted.

### Refreshing the shard timings

Every shard uploads `integration-timings-<n>` (vitest's JSON report). When the
shards drift apart, download every shard's report from one or two green runs and run
`node scripts/integration-timings.mjs <reports…>`; it averages per file and
keeps every file it was not given. The table only moves files between shards —
it never decides what runs.

### Timeouts and how to read a long run

Every job has `timeout-minutes` (none had one; the default is six hours), and
the integration test step has its own 40-minute limit so the log names the step
that ran out. Inside vitest, `testTimeout` and `hookTimeout` (60 s each for the
integration project) are unchanged.

The integration shards and the nightly exhaustive job run vitest with three
reporters:

- `default` — each file and its failures when the file finishes;
- `tests/support/ci-progress-reporter.ts` — `▶ file` and `· test` as each
  STARTS, `◀ file (duration)` as it ends, and a heartbeat every 30 s naming what
  is still running;
- `hanging-process` — lists the handles keeping the process alive when vitest's
  teardown timeout expires.

| What the log shows                                       | What it is                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `· test` lines still arriving                            | slow, making progress                                                             |
| one `· test`, then `… still in "<test>" after 30s, 60s`  | stuck in that test; `testTimeout` fails it and names it                           |
| `… <file> has run Ns, between tests (a hook is running)` | a `beforeAll`/`afterAll` is slow or stuck; `hookTimeout` ends it                  |
| `■ run finished`, then silence                           | every test is done; an open handle holds the process — `hanging-process` names it |
| a PostgreSQL `deadlock detected` in a failure            | a real deadlock: PostgreSQL broke it and the test failed                          |

A run that is merely slow should not be cancelled.
Cancel only a run that is superseded or that the log shows is stuck.

## Why the integration suite was slow, and what changed

Measured on main `5b4d372f` (run 37142991758): the unit-and-integration job took
96 min, of which the integration step was 91 min — 209 files run one at a time,
`tests 5134 s`, `setup 291 s`. Every other job finished within 21 min. A PR run
of the same shape took 64 min. Individual tests were taking ~1 s regardless of
what they did.

The ~1 s is the reset. Every test calls `resetDatabase`, one `TRUNCATE … RESTART
IDENTITY CASCADE` over ~150 tables, and a TRUNCATE replaces each table's files.
With `fsync` on, that is hundreds of synced file creations per test. On a
private PostgreSQL 16 cluster with this schema:

| measurement                         | fsync on | fsync off |
| ----------------------------------- | -------: | --------: |
| one reset (TRUNCATE of every table) |  ~650 ms |   ~145 ms |
| `rbac` + `orders` suites, test time |   65.7 s |    19.3 s |

So the CI database now runs with `fsync`, `full_page_writes` and
`synchronous_commit` off (`scripts/ci-test-postgres.sh`, read back and verified
after the reload). These decide only whether a committed write survives an OS
crash or power loss; the container is discarded with the job and no test kills
the server. No query, lock, isolation level or result changes. The script
refuses to run outside GitHub Actions.

**Expected effect (not yet measured on GitHub):** the integration test time
falls by roughly 3× (≈ 25–30 min serially), and four shards bring each to about
8–12 min including service start, install and migrations. The critical path
becomes the deployment smoke (~14 min). Wall time per run: ~15 min instead of
64–96 min. Runner minutes per PR head: ~70 instead of ~240 (one run instead of
two, each about 60% of the old one), which also shortens the queue when many PRs
are open. The first green run on main after this lands is the measurement; the
progress reporter's `◀ file (duration)` lines give per-file times for
rebalancing if one shard is consistently longest.

The pnpm store was already cached (`setup-node` `cache: pnpm`); installs took
under a second of wall time in every job.

## The 2026-10 measurement and what changed

Ten green runs before this change (`39035286900` … `38711220030`, seven pull-request
heads and three main commits): wall time 27.6–35.0 min, median 33.
The critical path was always `build` (1.2 min) → the slowest of four integration
shards (median 31.2, max 33.6 min). The four shards' own medians were 24.9,
26.2, 23.6 and 31.2 min, and one commit's shards finished between 16 and 33 min:
equal file counts over files from 0.6 s to 207 s. Next were the deployment
smoke at 14.8–17.6 min (its update-and-rollback step alone 11–12.8 min), the
deployment logic at 6.3–7.1 min (one botctl case waited out the 180 s default
readiness timeout), the legacy rehearsal at 5.4, static at 4.5, web at 3.8 and
unit at 3.0 min.

Measured per file, the integration project is about 5 100–5 400 s of tests plus
about 2 s of setup per file, and the same file varies by up to 1.7× between
runners — which no timing table can balance away, so the slowest shard is
always 30–60% above the fastest.

### Choosing the shard count

Each count was run once (twice for 8) as a `workflow_dispatch` of this branch,
one at a time so no run competed with another for runners. Minutes:

| shards |     wall | slowest shard | update/rollback smoke | peak concurrent jobs | run         |
| -----: | -------: | ------------: | --------------------: | -------------------: | ----------- |
|      6 |     23.1 |          21.8 |                  12.9 |                   15 | 39044601290 |
|      8 |     16.6 |          15.1 |                  11.7 |                   17 | 39039650728 |
|      8 |     17.3 |          15.8 |                  13.0 |                   17 | 39041309854 |
| **10** | **14.3** |          13.2 |                  13.1 |               **19** | 39042598450 |
|     12 |     12.5 |          11.1 |                  11.3 |                   21 | 39043649200 |
|     14 |     13.3 |          10.5 |                  13.0 |                   23 | 39046370143 |
|     16 |     13.8 |           8.1 |                  13.5 |                   25 | 39047381046 |

Past ten, the wall time is the update-and-rollback smoke (11–13.5 min, most of it
readiness timeouts the smoke exists to wait out), and more shards only add
jobs: 12's 12.5 min is a fast smoke run, not a faster suite. Ten is the knee,
and the largest count whose run stays under the free plan's 20 concurrent jobs
with nothing else running; twelve already peaks at 21, so a second pull
request at the same moment would queue behind it.

### Choosing the shard count, 2026-11

With the update/rollback smoke path-scoped, it no longer sets the floor for an
application PR, so the count was re-decided for the case that matters: two pull
requests at once under the free plan's ~20-job pool. Inputs are the per-job
medians of twelve green CI runs (`43087039037` … `43179546656`): the suite is
~198 shard-minutes, ~0.75 min fixed cost per shard, ~17 % per-shard noise
(sd 3.3 min around 19.8 at ten shards), and the heaviest file (570 s) as the
floor. A pool model (FIFO over 20 runners, 300 draws per cell) gives the mean
wall time of the slower run, minutes:

| scenario                    | 10 shards | 16 shards | **18 shards** | 20 shards |
| --------------------------- | --------: | --------: | ------------: | --------: |
| one push to main            |      27.3 |      19.4 |          19.7 |      23.1 |
| one application PR          |      27.4 |      18.4 |      **16.7** |      18.9 |
| two application PRs at once |      31.1 |      31.0 |      **28.9** |      30.5 |
| two app PRs, 3 min apart    |      29.8 |      28.2 |      **26.1** |      28.1 |
| push to main + app PR       |      35.7 |      31.5 |      **31.2** |      33.6 |
| two full PRs                |      37.9 |      33.1 |      **32.6** |      34.6 |

Eighteen is best or within 0.3 min of best in every row; twenty already loses
to queueing. The cost is ~6 runner-minutes of fixed setup per full run
(8 × 0.75). Measured before/after numbers on real runs are in the CI-slimming
round report.

## The 2026-11 image cache, and the docs-only question

### Was a 33-minute run on a docs-only merge a bug? No — by design

PR #440 changed one file, `docs/round-reports/web-redesign.md`. Its
`pull_request` run (`42550059160`) took 10.5 min and **skipped** the ten
integration shards, both legacy jobs and both deployment smokes — `changes`
printed `heavy=false` (`docs/**/*.md` matches nested paths: the shell `case`
pattern `docs/*.md` lets `*` cross `/`, so `docs/round-reports/x.md` is docs).
What it still ran is what reads Markdown: its longest job was `web`
(7 min), then `static` (5.8) and `deploy-logic` (4.4).

The 33-minute run (`42551072700`, 02:27 → 03:01) is the **`push` to main** of
its merge commit. A push is what `release.yml` accepts as evidence that a commit
passed CI, so `ci-docs-only.sh` (since replaced by `ci-scope.sh`) returned `heavy=true` for every event but
`pull_request` and nothing is skipped; the aggregate refuses a skip on a push
independently of the script. That is unchanged: a main commit whose evidence is
partial could be tagged and released. (A merge-commit push that is provably
identical in content to a tree whose full run already passed would be safe to
skip, but the release gate matches runs by SHA and the new SHA has no run;
making that sound needs the gate to learn "evidence by tree", which is its own
change, not a CI-speed tweak.)

### The layer cache

Before, both deployment jobs ran a plain `docker build` on a fresh runner: every
run re-downloaded the apt packages and re-installed every dependency, and the
update smoke built the image twice with different build arguments, which
invalidated the apt layer (it sat after `ENV BUILD_*`) both times.

- The `Dockerfile` now has two stages that depend on neither the sources nor the
  build identity — `deps` (the pnpm install) and `system` (PostgreSQL client and
  7-Zip) — and the apt layer no longer follows `ARG`/`ENV BUILD_*`.
- Both deployment jobs set up buildx (the pin `release.yml` already uses) and
  warm those two stages through `docker/build-push-action` with the GitHub
  Actions cache (scopes `nexa-image-deps`, `nexa-image-system`).
  A `run` step cannot read the Actions cache credentials without an extra
  third-party action, so the warm-up is done by actions already pinned here
  rather than by `--cache-to type=gha` in the scripts; `scripts/image-build.sh`
  also passes `--cache-from type=gha` when the credentials are present.
- `scripts/deployment-smoke.sh` and `scripts/deployment-update-smoke.sh` still
  build the FULL image, with their own build arguments, and run every assertion
  on it; with `NEXA_CI_BUILDX` unset (a laptop) it is the plain `docker build`.
- `release.yml` is untouched. Reusing one built image between the two jobs was
  not done: the two jobs start together, so a hand-over would serialise one
  behind the other on the critical path.

`tests/unit/ci-workflow.test.ts` fails if the warm-up is dropped, runs after the
smoke, or the apt layer moves behind the build identity.

### Measurement

Wall times in minutes, from `created_at` to `updated_at` of the CI run, and the
two deployment jobs from their own job timestamps. Every run is a full
(`heavy=true`) run.

| run                  | event / what                           | wall | update smoke | smoke |
| -------------------- | -------------------------------------- | ---: | -----------: | ----: |
| before `42571534164` | PR head, full                          | 30.6 |         13.3 |   5.7 |
| before `42547476576` | PR head, full                          | 28.1 |         13.3 |   5.8 |
| before `42551072700` | main push                              | 33.4 |         14.0 |   6.4 |
| after `42576456052`  | PR head, full, first push (cold cache) | 28.7 |         14.8 |   6.7 |
| after `42579611929`  | dispatch, full, same head (warm cache) | 24.2 |         14.7 |   5.5 |

Read honestly: the image cache did **not** shorten the critical path. The warm-up
steps cost 0.4 + 0.3 min, the deployment smoke dropped by at most 0.3 min
(5.5 against 5.7–6.4) and the update smoke did not move (14.7 against 13.3–14.0;
its 13.6 min are the readiness timeouts it exists to exercise, and its builds
were already a small part). The wall time fell from 28.1–33.4 to 24.2 min in the
warm run, and that difference is the integration shards (slowest 22.3 min against
25.1 in the cold run and 26.4–28.6 before, from the refreshed timing table and
runner noise), not the cache. A comparison of one cold and one warm run cannot
separate those two; the table is what was measured. Docs-only pull requests are
unchanged (10.5 min for #440, `web` is their longest job).

The slowest integration shard was 28.6 and 26.4 min in the two PR runs, the
fastest 11.4 and 12.8: the suite, not the image build, is the critical path of
a full run today. `tests/support/integration-timings.json` was refreshed from the
shard logs of main runs `42551072700` and `42550025488` (the artifact download
host is not reachable from the authoring session; the logs carry the same
per-file durations).

## Where pnpm comes from

One pin: `packageManager` in the root `package.json`. Every job that needs pnpm
runs `pnpm/action-setup` with **no** `version:` input, right after the root
checkout, so the action reads that field; there is no `PNPM_VERSION` in any
workflow to drift from it. It runs **before** `actions/setup-node`, because
`cache: pnpm` calls `pnpm store path`.

setup-node v5 also caches **without being asked**: given no `cache:` input it
reads `packageManager` from the workspace's `package.json`, sees pnpm, and does
the same thing. A job that needs Node but not pnpm — the release `gate` — must
say `package-manager-cache: false`. That job had none, and v0.4.4's release
(run 37178958984) stopped at its setup-node step with "Unable to locate
executable file: pnpm" before the CI gate ran: #168 had given the gate a root
checkout of the workflow commit, which is what put a `package.json` there. CI
never runs that job, so CI was green.

`tests/unit/release-workflow.test.ts` ("pnpm provisioning in every workflow")
checks every job of every workflow: a setup-node with a pnpm cache, explicit or
automatic, or a `run:` that calls `pnpm`, needs an earlier `pnpm/action-setup`
in the same job, and that step carries no `version:`.

## The release gate

`release.yml`'s `gate` job will not let anything be built until:

1. the requested tag is a release tag (`v` + what botctl accepts as a version —
   `validateReleaseTag` in `scripts/release-ci-gate.mjs`);
2. the tag resolves, ONCE, to a 40-hex commit, and every later job is pinned to
   that SHA;
3. `scripts/release-ci-gate.sh` finds a run of `.github/workflows/ci.yml` whose
   `head_sha` is **exactly** that SHA, whose event is `push` or
   `workflow_dispatch`, and whose status is `completed` with conclusion
   `success`;
4. the version has never been published.

| Run found for the tagged SHA                          | Gate                           |
| ----------------------------------------------------- | ------------------------------ |
| push/dispatch, success, attempt 1                     | pass                           |
| push/dispatch, success **after a re-run** (attempt n) | pass                           |
| push/dispatch, still queued or in progress            | refuse — "still running, wait" |
| push/dispatch, cancelled / failure / timed_out / …    | refuse                         |
| `pull_request`, success                               | refuse (see below)             |
| success for any **other** SHA                         | refuse                         |
| success of any other workflow                         | refuse                         |
| none                                                  | refuse                         |
| the runs API does not answer                          | refuse                         |

A `pull_request` run reports the PR head as its `head_sha` but tests
`refs/pull/N/merge` — the head merged into the base as it was then. Its green is
evidence about a different commit, so it is not accepted. A merge to main has
its own push run, and that is the one the gate wants.

The API reports each run's **latest** attempt, so a run cancelled or failed and
then re-run to green counts, and a green run that somebody has re-run again
counts only once that attempt finishes. One accepted success is enough; other
runs of the same SHA are printed beside it.

The gate script is taken from the commit that holds the running workflow
(`github.workflow_sha`), never from the tag being judged, so a dispatched
release of an arbitrary tag cannot bring its own permissive gate.

Tests: `tests/unit/release-ci-gate.test.ts` (each rule alone, every conclusion
and status), `tests/deploy/release-ci-gate.test.sh` (the wrapper against a fake
`gh` that serves the API pages in `tests/fixtures/release-gate/` through the
real `--jq` filter, ignores the `head_sha` filter on purpose, paginates, and
fails on demand), and `tests/unit/release-workflow.test.ts` (the workflow calls
it with the resolved SHA, before login, from its own commit).
`scripts/mutate-ci-release.py` reverts each rule in turn and confirms a test
goes red.

### When the release says it found no passing CI

1. Read the gate's output: it lists every run it saw for the SHA and why each
   was not accepted.
2. **A run exists but was cancelled or failed** — open it and choose **Re-run
   all jobs** (or **Re-run failed jobs**). When it finishes green, re-run the
   release (**Re-run all jobs** on the Release run, or **Run workflow** on
   Release with the tag). Do not re-run the release before CI is green.
3. **The run is still in progress** — wait for it, then re-run the release.
4. **Only a `pull_request` run exists** (the tag is on a PR head that main never
   ran) — either tag the main merge commit instead, or run CI for exactly that
   commit: **Actions → CI → Run workflow**, choosing the branch whose head is
   that commit. The dispatched run tests that SHA and the gate accepts it.
5. **Nothing exists** — the same as 4.

The gate never falls back to "the latest green main". A release is published
only from the bytes that passed.

### When the release failed before the gate decided

A tag-push run uses the workflow file **at the tagged commit**, and so does
**Re-run** on it: re-running a release whose workflow was broken repeats the
same failure. Once the fix is on main, the options are:

- **Run workflow** on Release from `main` with the existing tag (for v0.4.4:
  `v0.4.4`). The workflow and the gate script then come from main; the tag is
  still checked out separately and resolved once to its SHA (`f439eee7…` for
  v0.4.4), the gate still needs a green push run of CI for exactly that SHA,
  and the image is built from that SHA, not from main. Nothing was published
  for v0.4.4 — the run stopped before the build — so the immutability check
  does not refuse it.
- Or release a **new version** from a main commit that includes the fix, once
  CI is green for it.

Neither moves or recreates the tag.

## Service start, retry and the runner image (Round 5C-2)

The integration and exhaustive jobs start PostgreSQL and Redis from a step,
`scripts/ci-start-services.sh`, not from a `services:` block. A service
container that fails to pull or to turn healthy fails the job at "Initialize
containers", before any step exists, so nothing can retry it; on `main` that
was 2/10 integration shards on one commit and 7/10 and 9/10 on another. The
script pulls with a bounded retry, waits for health, and removes and restarts a
container that never answers (4 attempts, 60 s each), then confirms a real
`SELECT 1`. Images, credentials, ports and probes are the ones the blocks had;
the container is named `nexa-ci-postgres`, which `ci-test-postgres.sh` is given.
The other jobs with service containers (`legacy-mysql`, `legacy-rehearsal`) are
unchanged.

Every job runs on `ubuntu-24.04`, never `ubuntu-latest`, which migrates to a
newer Ubuntu on GitHub's schedule and would change the toolchain under a green
commit that the release workflow requires.
