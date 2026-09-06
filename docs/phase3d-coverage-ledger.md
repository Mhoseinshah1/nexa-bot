# Phase 3D — Web Admin V2 coverage ledger

The first-pass inventory, written before UI work began, and kept true as the
work landed. One row per route. `Maturity` is what the ROUTE may claim, and it
is decided by what the backend on `main` actually does — never by what the
preview drew.

Base: `main` @ `e299396487e262e03c50ae634f062548856cd820`.

## The vocabulary

| Maturity                 | Means                                        | The route may                                       |
| ------------------------ | -------------------------------------------- | --------------------------------------------------- |
| **AVAILABLE NOW**        | A real endpoint executes it today            | read and write for real                             |
| **BACKEND READY**        | The server side exists; no HTTP consumer yet | show the concept, never act                         |
| **PLANNED**              | Not in this release                          | describe, never draw a control that appears to work |
| **PROVIDER UNSUPPORTED** | The panel software itself lacks it           | say so against the provider                         |
| **NOT APPLICABLE**       | Deliberately absent by owner decision        | not exist at all                                    |

## What the backend actually exposes

Enumerated from `apps/api/src/surfaces/web/*.controller.ts` on the base SHA.
This is the complete list; anything not here has no HTTP surface.

| Area          | Endpoints                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth          | `POST /auth/login`, `GET /auth/session`, `POST /auth/logout`, `POST /auth/password`                                                                                        |
| Admins        | `GET /admins`, `GET /roles`, `POST /admins`, `POST /admins/:id/status`, `POST /admins/:id/roles`                                                                           |
| Settings      | `GET /settings`, `POST /settings/:key`                                                                                                                                     |
| Features      | `GET /features`, `POST /features/:key`                                                                                                                                     |
| Templates     | `GET /templates`, `GET /templates/:key`, `GET /templates/:key/revisions`, `POST /templates/:key`, `POST /templates/:key/revert`, `POST /templates/:key/preview`            |
| Ops log       | `GET /ops-log`                                                                                                                                                             |
| Notifications | `GET /notifications`, `GET /notifications/:id`, `POST /notifications/test`                                                                                                 |
| Panels        | `GET /providers`, `GET /panels`, `GET /panels/:id`, `POST /panels`, `POST /panels/:id`, `POST /panels/:id/credentials`, `POST /panels/:id/status`, `POST /panels/:id/test` |
| System        | `GET /system/readiness`, `GET /health/live                                                                                                                                 | ready | info` |

There is no customer, service, order, product, payment, wallet, reseller,
discount, campaign, report, receipt, gateway, channel or bot-runtime endpoint.
That is not an omission in this ledger; it is the state of the system.

## Route inventory

As implemented. `Maturity` is what the route may claim, and it is decided by
what the backend on `main` actually does.

| Route                     | Backend capability                                | Endpoint                                                           | UI action                     | Maturity                                    | Test                                                                               |
| ------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `/` Dashboard             | readiness, panel page, open management conditions | `system/readiness`, `panels`, `ops-log?scope=MANAGEMENT&open=true` | read                          | AVAILABLE NOW                               | `tests/web/dashboard.test.tsx`                                                     |
| `/panels`                 | panel list, keyset paging                         | `GET /panels`                                                      | read, create                  | AVAILABLE NOW                               | `tests/web/panels.test.tsx`                                                        |
| `/panels/new`             | create                                            | `POST /panels`                                                     | write                         | AVAILABLE NOW                               | `tests/web/panels.test.tsx`                                                        |
| `/panels/:id`             | detail, edit, credentials, status, test           | `GET                                                               | POST /panels/:id[/credentials | /status                                     | /test]`                                                                            | read, write | AVAILABLE NOW | `tests/web/panels.test.tsx` |
| `/providers`              | provider catalogue                                | `GET /providers`                                                   | read                          | AVAILABLE NOW                               | rendered in `panels.test.tsx` fixtures                                             |
| `/settings`               | settings registry, all nine keys                  | `GET/POST /settings[/:key]`                                        | read, write                   | AVAILABLE NOW; four keys' consumers PLANNED | `tests/web/settings-and-alerts.test.tsx`, `tests/integration/web-admin-v2.test.ts` |
| `/features`               | feature flags                                     | `GET/POST /features[/:key]`                                        | read, write                   | AVAILABLE NOW                               | `tests/web/control-plane-pages.test.tsx` + control-plane integration               |
| `/content`                | templates, revisions, preview, revert             | `GET/POST /templates…`                                             | read, write                   | AVAILABLE NOW                               | `tests/web/control-plane-pages.test.tsx` + control-plane integration               |
| `/alerts`                 | operational log, management scope                 | `GET /ops-log?scope=MANAGEMENT`                                    | read                          | AVAILABLE NOW                               | `tests/web/settings-and-alerts.test.tsx`, `tests/integration/web-admin-v2.test.ts` |
| `/notifications`          | intent and attempts, test send                    | `GET /notifications…`, `POST /notifications/test`                  | read, test-send               | AVAILABLE NOW                               | `tests/web/control-plane-pages.test.tsx` + control-plane integration               |
| `/system`                 | readiness detail, build info                      | `system/readiness`, `health/info`                                  | read                          | AVAILABLE NOW                               | `tests/web/settings-and-alerts.test.tsx`                                           |
| `/system?section=monitor` | effective monitor configuration and capacity      | `GET system/monitor`                                               | read                          | AVAILABLE NOW (read-only)                   | `tests/unit/monitor-profile.test.ts`, `tests/integration/web-admin-v2.test.ts`     |
| `/system?section=admins`  | administrators and their roles                    | `GET /admins`                                                      | read                          | AVAILABLE NOW                               | existing admin suites                                                              |
| `/users`                  | —                                                 | none                                                               | none                          | PLANNED                                     | `tests/web/planned-and-absent.test.tsx`                                            |
| `/services`               | —                                                 | none                                                               | none                          | PLANNED                                     | same                                                                               |
| `/orders`                 | —                                                 | none                                                               | none                          | PLANNED                                     | same                                                                               |
| `/products`               | —                                                 | none                                                               | none                          | PLANNED                                     | same                                                                               |
| `/payments`               | —                                                 | none                                                               | none                          | PLANNED                                     | same                                                                               |
| `/discounts`              | —                                                 | none                                                               | none                          | PLANNED                                     | same                                                                               |
| `/resellers`              | —                                                 | none                                                               | none                          | PLANNED                                     | same                                                                               |
| `/reports`                | —                                                 | none                                                               | none                          | PLANNED                                     | same                                                                               |
| `/bots`                   | —                                                 | none                                                               | none                          | PLANNED                                     | same                                                                               |
| any other path            | —                                                 | —                                                                  | not-found                     | AVAILABLE NOW                               | `tests/web/planned-and-absent.test.tsx` (through `resolve`)                        |

Every `PLANNED` route renders one page that draws no `button`, `input`,
`select`, `table` or link at all. That is asserted per route rather than
assumed.

## Surfaces deliberately absent

| Concept                                                | Why it does not exist                                       | Owner revision |
| ------------------------------------------------------ | ----------------------------------------------------------- | -------------- |
| Receipt storage, viewer, archive, upload, review queue | Telegram-native by owner decision; no Web Admin persistence | 17             |
| General logs page / operator log browser               | Telegram Log/Report Group is the human stream               | 25             |
| User tags                                              | Not part of the intended product                            | 15             |
| User Detail recent activity                            | Low-value interaction events                                | 16             |
| Protocol in normal Services UI                         | Subscription link is the service abstraction                | 12             |
| Least-loaded panel routing                             | Product model is fixed panel or customer choice             | 10             |
| Location column / location distribution                | A panel may be multi-location                               | 2, 19          |

Each of these is covered by a regression test asserting its ABSENCE, because an
absence with no test is an absence that comes back.

## A correction to this ledger

Four rows above previously cited coverage that did not exist. `/features`,
`/content` and `/notifications` were marked as covered by "existing
control-plane suites" — API-level integration tests, none of which renders any
of those three components. The `tests/web/` suite's own stated rationale is
that the risk it covers is production WIRING, which an API test cannot see; the
ledger was claiming that risk was covered when nothing addressed it. The
not-found row cited "the screenshot pass", which committed no probe at all
until `scripts/visual/` was added.

Each of those four now names a test that renders the route.
