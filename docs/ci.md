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
changes ──────────┬──────────────────── Changed paths (docs-only pull request?)
static ───────────┼──────────────────── Typecheck, lint and boundaries
build ──┬── unit ─┼─────────┐
        ├── web ──┼─────────┤
        ├── integration 1..10 (skippable)
        ├── legacy-mysql ×2 ┤ (skippable)
        └── legacy-rehearsal┼────────── Unit and integration tests (aggregate)
deploy-logic ─────┼─────────┤
deploy ───────────┼─────────┤ (skippable) Deployment smoke + Mirza rehearsal smoke
deploy-update ────┴─────────┘ (skippable) Deployment update and rollback smoke
audit ──────────────────────────────── Dependency audit
```

- **build** compiles once (stamped with the SHA), runs the built-output smoke,
  `check:runtime` and the migration drift check, and uploads the four `dist`
  directories as the `dist` artifact. `unit`, `web` and every integration shard
  download it instead of building again, so every test job runs the same bytes.
- **integration** is a 10-way matrix over `vitest --shard=i/10`. The shard a
  file lands in is decided by `tests/support/timed-sequencer.mts`, which the
  root vitest config installs: longest file first, each into the shard with the
  least measured work so far, weights from `tests/support/integration-timings.json`.
  Every shard computes the same partition from the same file list, so every
  file runs in exactly one shard — `timed-sequencer.test.ts` checks that for
  every count from 1 to 16, and a file missing from the table (a new one) still
  runs, weighted at the median. Each shard has its own PostgreSQL and Redis, so
  suites inside a shard still run one file at a time against a database nothing
  else touches. Each shard applies the compiled migrations without application
  secrets before its tests — the same guard the single job had.
- **Unit and integration tests** is the old job's name, kept as the one check
  that ALWAYS reports. It runs `if: always()` and is green only when `changes`,
  `unit`, `web`, `deploy-logic`, every shard, both legacy jobs and both
  deployment smokes succeeded. The only other result it accepts is `skipped`
  for a skippable job, and only when `changes` succeeded, said `heavy=false`,
  and the event is `pull_request`.
- **Deployment logic** (shellcheck, botctl against a fake docker, the shell
  check's own test, the release gate against a fake `gh`), **Deployment smoke**
  (the real image, install, serve, back up; then the Mirza rehearsal kit) and
  **Deployment update and rollback smoke** (A → B, two releases that never
  become ready, B → A) are independent and run side by side. The update smoke
  is its own job because it is eleven minutes on its own, most of it the
  readiness timeouts it exists to exercise.

Coverage is unchanged: every command the workflow ran before the split is still
run, and `ci-workflow.test.ts` lists them.

### Docs-only pull requests

`changes` runs `scripts/ci-docs-only.sh`, which prints `heavy=false` only when
the event is `pull_request` AND every path the merge commit changes against its
first parent (`--no-renames`, so a rename counts both sides) is Markdown under
`docs/`, or `README.md`, `CLAUDE.md` or `PROGRESS.md` at the root — the three
`.dockerignore` keeps out of the image. Anything else, an unreadable diff
included, is `heavy=true`.

On `heavy=false` the integration shards, both legacy jobs and both deployment
smokes are skipped. Everything that READS Markdown still runs: `static`
(prettier, `check:citations`, `check:boundaries`), `unit` (the legacy runbook
tests), `web` (`docs/open-questions.md`) and `deploy-logic` (botctl's test greps
`docs/deployment.md`). `ci-workflow.test.ts` scans what the skippable jobs run
for a read of a Markdown file and fails if one appears; a JSON schema under
`docs/` is not Markdown and makes a run heavy.

**A push to main and a dispatched run never skip anything.** Those runs are what
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
