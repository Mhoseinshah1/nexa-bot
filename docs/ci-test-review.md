# CI test review: slow and duplicate integration tests

Round "CI slimming", PR 3. Evidence first, then what changed, then what did not.

## 1. Measurement

Baseline = `tests/support/integration-timings.json` (mean per-file seconds of two main CI runs),
422 files, **11 108 s** of summed per-file time over all shards. After = the same sum with
the files this PR changed re-estimated from before/after runs on one machine (the ratio of
that machine to CI was taken from the unchanged baseline of the same files).

| Change                                                                                                           | Measured here (before → after)        | Estimated CI effect                                                       |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| `nxpkg-live-panel-inventory` G (a hung panel, 5 attempts x 30 s page floor, two walks, five failure kinds)       | 307 s → 15 s for that one test        | about -257 s                                                              |
| `restore-secret-keys` (migrated template instead of 346 migrations per case)                                     | 152 s → 102 s                         | about -34 s                                                               |
| other recovery suites (`recovery-executor`, `recovery-failure-drills`, `restore-secret-reentry`) on the template | 616 → 630, 384 → 367, no clear change | within noise; their time is `pg_dump`/`pg_restore` and the cutover itself |
| **Total**                                                                                                        |                                       | **about -291 s, 2.6 %** of 11 108 s                                       |

**The 25 % target was not reached, and this PR does not claim it.** Reaching it needs about
2 800 s. Where the rest of the time goes (measured, not guessed):

- Every case resets the database with one `TRUNCATE ... RESTART IDENTITY CASCADE` over 246
  tables: about 1.3 s locally per `ctx.reset()`, with `seed` only 20 ms. The time is relation
  files (`synchronous_commit` made no difference), and it cannot be narrowed to the non-empty
  tables: `tenants` is always populated and `CASCADE` pulls in every table referencing it, and
  without `CASCADE` PostgreSQL demands every referencing table be listed. A real saving would
  need a different reset (e.g. a per-file template database, or fewer tables), which is a
  harness redesign and its own PR.
- The recovery/restore/backup suites (about 1 900 s of the sum) spend their time in real
  `pg_dump`/`pg_restore` of a 246-table schema and the executor's cutover. They guard backup
  and restore and may not shrink by deletion; they are slow on purpose.
- Real `setTimeout` sleeps in the integration tests total a few seconds per file (25-400 ms
  each); replacing them with the `Clock` port would not move the total.

## 2. The 50 slowest integration files (CI mean, before this PR)

| #   | File                                        | s (CI mean) | tests | What it guards (its `describe`)                                                            |
| --- | ------------------------------------------- | ----------- | ----- | ------------------------------------------------------------------------------------------ |
| 1   | `nxpkg-live-panel-inventory.test.ts`        | 570.4       | 27    | Web Admin .nxpkg over a live RickPanel that keeps selling (per-name inventory)             |
| 2   | `recovery-executor.test.ts`                 | 401.9       | 26    | the recovery executor                                                                      |
| 3   | `recovery-failure-drills.test.ts`           | 278.4       | 9     | recovery and backup failure drills (E4)                                                    |
| 4   | `support-auto-reply.test.ts`                | 169.2       | 153   | AUTO_REPLY_SAFE, handoff and tickets (TB7)                                                 |
| 5   | `web-disaster-recovery.test.ts`             | 161         | 33    | web disaster recovery                                                                      |
| 6   | `usage-sync-load.test.ts`                   | 159.6       | 2     | Blocker C2: usage-sync load and priority                                                   |
| 7   | `services-started-plan.test.ts`             | 129.5       | 2     | the services list plans over 200 000 services                                              |
| 8   | `panel-monitor.test.ts`                     | 129.3       | 133   | the panel health monitor                                                                   |
| 9   | `service-refund-requests.test.ts`           | 123.8       | 86    | WP19 — a customer asks for their money back                                                |
| 10  | `tonpays-gateway.test.ts`                   | 119.9       | 91    | TonPays, through the one settlement path                                                   |
| 11  | `nxpkg-case-variant-p1.test.ts`             | 110.4       | 10    | P1: no presence and no absence without a gap-free walk (Web Admin .nxpkg, production-like) |
| 12  | `service-management.test.ts`                | 109.6       | 58    | a customer manages the service they bought                                                 |
| 13  | `tonpays-telegram-round6.test.ts`           | 105.3       | 46    | TonPays Telegram Round 6: remainder, refund, cancel                                        |
| 14  | `restore-secret-keys.test.ts`               | 102.3       | 3     | a restore never brings back secrets this install cannot read                               |
| 15  | `post-import-notification-baseline.test.ts` | 100         | 7     | Round 4 PR-H: the first sweeps after an import send nothing historical                     |
| 16  | `legacy-migration-nxpkg.test.ts`            | 98.4        | 13    | legacy migration: the executor over a real package                                         |
| 17  | `codex-findings-round-2.test.ts`            | 96.1        | 85    | an account stored below the current cost profile can still sign in                         |
| 18  | `backup.test.ts`                            | 93.6        | 24    | backup against a real database                                                             |
| 19  | `restore-secret-reentry.test.ts`            | 88.3        | 5     | after a restore refused for unreadable secrets                                             |
| 20  | `customer-ux-services.test.ts`              | 87.4        | 65    | a customer looks after the services they bought                                            |
| 21  | `r5a-imported-usage-notices.test.ts`        | 86.6        | 5     | Round 5A item 1: imported services and usage notices                                       |
| 22  | `r5a2-imported-notice-guard.test.ts`        | 79.2        | 7     | Round 5A-2: imported services and reseller periods are not announced                       |
| 23  | `referrals.test.ts`                         | 75.9        | 64    | the referral program: attribution, the promise, the credit and its reversal                |
| 24  | `reporting-plan.test.ts`                    | 75.9        | 2     | the reporting query plans                                                                  |
| 25  | `panels.test.ts`                            | 73.2        | 75    | panels                                                                                     |
| 26  | `service-transfer.test.ts`                  | 70.9        | 41    | Package F — a customer transfers a service to another customer                             |
| 27  | `ops-log-group.test.ts`                     | 70.8        | 63    | the operations log group (WP-A4)                                                           |
| 28  | `legacy-migration-resume.test.ts`           | 70          | 10    | legacy migration: interrupt, resume and rerun over a real package                          |
| 29  | `admin-security.test.ts`                    | 69.8        | 49    | enrolment                                                                                  |
| 30  | `provisioning-delivery.test.ts`             | 68.7        | 49    | a provisioned service announces itself                                                     |
| 31  | `legacy-importer.test.ts`                   | 68.5        | 46    | Migration P7: the legacy importer                                                          |
| 32  | `telegram-admin-services.test.ts`           | 66.9        | 44    | the services section of the Telegram management panel                                      |
| 33  | `payments.test.ts`                          | 64.1        | 68    | payments and settlement                                                                    |
| 34  | `tonpays-telegram-gateway.test.ts`          | 63.7        | 39    | TonPays Telegram, through the one settlement path                                          |
| 35  | `tonpays-telegram-review-window.test.ts`    | 62.9        | 42    | the TonPays Telegram provider review window                                                |
| 36  | `recovery-kit-restore.test.ts`              | 58          | 0     | ?                                                                                          |
| 37  | `location-change.test.ts`                   | 56.7        | 31    | service location change (WP-A6)                                                            |
| 38  | `panels-http.test.ts`                       | 56.3        | 51    | panel HTTP surface                                                                         |
| 39  | `imported-customer-ops-logs.test.ts`        | 54          | 17    | R10 B5: what an imported customer does after the import reaches the operations group       |
| 40  | `hosted-activation.test.ts`                 | 53.8        | 47    | hosted bot activation (phase 6A PR-4)                                                      |
| 41  | `payment-accounts.test.ts`                  | 53.4        | 44    | payment accounts and the destination a payment freezes                                     |
| 42  | `telegram-stars.test.ts`                    | 51.5        | 45    | Telegram Stars (Package A)                                                                 |
| 43  | `telegram-payment-flow.test.ts`             | 51.2        | 43    | the customer payment flow over Telegram                                                    |
| 44  | `r2-wizard-edit-in-place.test.ts`           | 50.4        | 33    | the wizard is one message, edited in place                                                 |
| 45  | `resellers.test.ts`                         | 50          | 45    | resellers (WP9-B)                                                                          |
| 46  | `tickets.test.ts`                           | 49.5        | 35    | WP-A7 — support tickets                                                                    |
| 47  | `refunds.test.ts`                           | 48.7        | 37    | refunds                                                                                    |
| 48  | `wp20-anti-spam.test.ts`                    | 48.6        | 18    | anti-spam                                                                                  |
| 49  | `support-sai-tickets.test.ts`               | 48.4        | 45    | Phase 4 PR-4: the support AI in tickets                                                    |
| 50  | `service-operations-http.test.ts`           | 48.2        | 25    | operator service actions over HTTP                                                         |

## 3. Pairs that look alike (same title in two files), and the verdict

Found by listing every `it(...)` title of 25+ characters that occurs in more than one file
(56 titles). A title is not a behaviour: a TRUE duplicate needs the same function, the same
input and the same expectation. Read in full for the pairs below:

- `category-colors` / `category-icons` "refuses a stale version rather than overwriting a
  colleague": same title, different setting (`setColors` vs `setIcons`), different stored
  value and read-back. Not a duplicate.
- `service-auto-renew` (integration and unit) "a period renewed by hand since the claim is
  never bought again": the unit test drives the pure decision, the integration test the
  transaction; both guard money. Not a duplicate, and not deletable anyway.
- `r5a-imported-usage-notices` / `r5a2-imported-notice-guard` "the send-time precondition
  refuses the same notices before the reconcile has run": legacy-import guard, kept.
- `payments` / `telegram-payment-flow` "refuses a second settlement of an order already paid":
  money, kept; the two reach it through different entry points (settlement service vs the
  Telegram flow).
- `customers-prune`, `orders`, `payments`, `wallet` "refuses an installation that has stopped
  accepting work": one case per write path, which is the rule in CLAUDE.md ("every write path
  reads `ScopeActivityReader` inside its transaction"); each exercises a different service.
- the `refuses an anonymous caller` family (`control-plane-http`, `panels-http`,
  `web-admin-v2`, `orders-http`, `rbac-http`, `services-http`): one per route group, security.

Result: **no true duplicate was found, so nothing was deleted.** The remaining same-title pairs
are different subjects (different modules, adapters or settings keys) and sit in the guard
classes this review may not touch (money, security, legacy import, backup/restore).

## 4. Deletions

None. («removed X - covered by Y»: no entries.)

## 5. What changed

- `RICKPANEL_INVENTORY_PAGE_TIMEOUT_FLOOR_MS` (default 30000, refused below 30000 in
  production): the inventory client's 30 s page floor was a constant, so the test's
  `PANEL_HTTP_TIMEOUT_MS=1000` never applied to it and every attempt at a hung page cost 30 s
  (G: 10 reads x 5 attempts x 30 s). The harness lowers it to 1000 outside production.
  Production behaviour is unchanged.
- `tests/support/migrated-database.ts`: the recovery and restore suites clone a migrated
  template database (keyed by a hash of the migration files, built under an advisory lock and
  renamed when complete) instead of running every migration into each case.
- Nothing moved from the integration project to unit: the only two integration files that import
  no harness (`r2-review-message`, `wp20-interaction-counter`) use PostgreSQL and Redis.

## 6. Flaky tests

- **`hosting-panel.test.ts` (TOTP).** The wall-clock dependence was already removed on main by
  `e50590722` (clock frozen mid-step, `offsetMs` the only thing that moves it, the step boundary
  forced explicitly). Checked again here: no `Date.now()`/`new Date()` remains in the hosting or
  identity application code or in the test beyond the frozen anchor (which is aligned to a step),
  and the file passed 17/17 on three consecutive runs. No further change was needed.
- **Nightly 2026-11-11, "notification ordering".** Run 43002850905, job 130462963114, file
  `tests/exhaustive/notification-orderings.test.ts`, case "holds every invariant when a send is
  still in flight": `Test timed out in 600000ms` (the 2026-11-12 run failed the same way). Not an
  ordering failure: no invariant broke. The case enumerates 3 preludes x 3 landings x 125
  windows = 1 125 orderings, each real database work, inside ONE 600 s budget that a slow runner
  crossed (the 3-step case beside it takes 243 s). Fix: one test per (prelude, landing) pair, each
  with its own 600 s budget (about 125 orderings, a ninth of the work), the coverage claims
  asserted over the sum in a final test. One case measured 281 s locally (budget 600 s), so each now has more than 2x headroom; the whole block was not run end to end here (about 40 minutes locally). Same orderings, same invariants. No retry.

## 7. Guard: a migration must not drop CHECK values

`tests/unit/migration-check-values.test.ts` (unit project; it reads files only, runs in well
under a second). It is not wired into the `static` job: the unit project runs on every CI run
and wiring it into `static` would have meant a `ci.yml` change other PRs are making. Applied
migrations are immutable (`nexa-migrations`), so the 14 historic drops (0084, 0093, 0094) are an
explicit allowlist with reasons in the test; a new drop is annotated in its own migration with
`-- nexa:check-drop <constraint> <value> <reason>`. `scripts/mutate-check-guard.py` adds a
scratch migration that drops a value from a recent CHECK list: the guard fails; annotated, it
passes; the journal is restored.
