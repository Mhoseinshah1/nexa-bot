# Reseller bot requests: list and history audit

The owner's `GET /api/admin/v1/hosting/reseller-bot-requests` previously returned only
200 requests. The repository already ordered them by `(created_at DESC, id DESC)`, but
neither the response nor Web Admin had a continuation mechanism.

The endpoint now accepts `limit` (1–200; default 200 for cached clients) and `cursor`
(the last returned request UUID). It returns `nextCursor`, or null on the last page.
The updated Web Admin requests 50 rows and offers «بارگذاری بیشتر». Failed continuation
retains already loaded rows; retry loads the same next page. Refresh restarts at page one.
Approval, rejection, creation and activation still use their existing commands.

The cursor's timestamp is resolved inside PostgreSQL, preserving microseconds. Its anchor
must belong to the same installation; foreign or unknown anchors return an empty page.
A strict tuple comparison avoids duplicates/skips caused by new rows ahead of the cursor.
Newer inserts appear on refresh. This is a live keyset traversal, not an MVCC snapshot:
backdated inserts behind the cursor may appear, and removal of the anchor ends traversal.
Requests currently have no normal deletion command. No state filter changes the traversal.

## History finding

`listByCustomer`, `listOwn` and `GET /api/reseller/v1/own-bot` already return every request
state and filter by both tenant and authenticated customer. There is no 200-row cap on this
path. Existing approval/rejection/cancellation/link/charge/stop/resume timeline construction
and chronological sorting are preserved; equal timestamps retain the existing construction
order, without inventing a more precise business chronology.

A real presentation defect was reproduced: `/r/bot` selected the newest PENDING/APPROVED
request as current, while its previous-requests list included only REJECTED/CANCELLED.
An earlier APPROVED request (including a linked bot) therefore disappeared from the page.
The committed Web regression failed on the previous implementation because
`@older_linked_bot` was absent. The page now shows every noncurrent request once and allows
its existing timeline to be expanded. The current-request selection and command paths are
unchanged. Coverage includes both a pending and an approved current request.

The reseller response deliberately remains complete and thus O(history) in memory/payload;
individual timelines are also complete. This audit does not introduce an unrequested
customer-history cap or change its wire contract. Very long histories can still be large.

## Bounded reads and repeatable measurements

Enrichment reads at most 100 request IDs per charge/lifecycle/hosted-state batch. Owner
customer summaries deduplicate customer IDs and read at most 100 at a time. These projections
select only the existing display fields; hosted-state reads select only ID/state. Every
statement uses `requireTenantId` and the scoped `nexa_app` pool. The reseller read does not
fetch owner-only customer summaries. Charge and lifecycle arrays are grouped once by request
ID instead of filtered repeatedly for every row. No billing/ledger write logic changed.

`tests/integration/reseller-bot-pages.test.ts` seeds 1, 50, 200 and 501 requests, all with
separate linked hosted bots and the same customer (exercising both former per-row lookups).
It compares the original enrichment read pattern against bounded reads for identical rows
and customer/hosted-state output, asserts query counts, and also measures the real current
`listOwn` and first owner page. The owner section check alone is stubbed in this scale test;
real section/auth checks and later-page approval/creation run in `reseller-bot.test.ts`.
Service counts include their remaining settings/reseller reads. SQL counts exclude connection scope-binding statements,
which are still executed by the application pool. The original admin endpoint stopped at
200: the 501-row baseline measures the old hydration algorithm, not a formerly available
501-row owner response. The simulated batching comparison repeats the one-customer lookup
per chunk; the actual owner service deduplicates across its entire bounded page.

To repeat on a private, migrated test database with both database bindings set:

```sh
NEXA_RESELLER_BENCHMARK_FILE=/tmp/reseller-request-benchmark.jsonl \
  bash scripts/claude/run-gate.sh --integration \
  pnpm exec vitest run --project integration tests/integration/reseller-bot-pages.test.ts
```

The optional JSONL file contains counts/timings only; use a new path for each sample. Timing
is diagnostic, not a CI threshold. The 501-row case also records `EXPLAIN ANALYZE` execution
time and buffer hits for a continuation query. No schema/index migration is included.
