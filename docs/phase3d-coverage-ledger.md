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

| Route                       | Backend capability                      | Contract / endpoint                                                                              | UI action       | Maturity                                  | Tests                                                                                                     |
| --------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `/` Dashboard               | readiness, panel list, ops log          | `systemReadinessResponseSchema`, `panelListResponseSchema`, `operationalEventListResponseSchema` | read            | AVAILABLE NOW                             | panel distribution by panel; money formatter never abbreviates; needs-attention excludes ordinary pending |
| `/panels`                   | panel list, keyset paging               | `PANEL_ROUTES.list`                                                                              | read, create    | AVAILABLE NOW                             | no Location column; only real columns; server paging not client sort                                      |
| `/panels/new`               | panel create                            | `PANEL_ROUTES.create`                                                                            | write           | AVAILABLE NOW                             | provider resolved before write; activation fields                                                         |
| `/panels/:id`               | detail, edit, credentials, status, test | `PANEL_ROUTES.detail                                                                             | update          | credentials                               | status                                                                                                    | test` | read, write | AVAILABLE NOW | credentials never render a value; empty replace fields; capability matrix truthful |
| `/providers`                | provider catalogue                      | `PANEL_ROUTES.providers`                                                                         | read            | AVAILABLE NOW                             | capabilities exactly as the descriptor declares                                                           |
| `/settings`                 | settings registry                       | `CONTROL_ROUTES.settings`                                                                        | read, write     | AVAILABLE NOW                             | value always readable; optimistic-concurrency conflict                                                    |
| `/settings/support`         | support account list setting            | new registry key                                                                                 | read, write     | AVAILABLE NOW (stored) / consumer PLANNED | add, remove, reorder, validate                                                                            |
| `/settings/channels`        | channel list setting                    | new registry key                                                                                 | read, write     | AVAILABLE NOW (stored) / consumer PLANNED | add, remove, reorder, mandatory flag                                                                      |
| `/settings/wallet`          | global minimum top-up                   | new registry key                                                                                 | read, write     | AVAILABLE NOW (stored) / consumer PLANNED | precedence resolver; per-gateway override BLOCKED (no gateway registry)                                   |
| `/features`                 | feature flags                           | `CONTROL_ROUTES.features`                                                                        | read, write     | AVAILABLE NOW                             | tenant-wide confirmation                                                                                  |
| `/content`                  | templates                               | `CONTROL_ROUTES.templates`                                                                       | read, write     | AVAILABLE NOW                             | raw body stored; preview stores nothing                                                                   |
| `/alerts` Management Alerts | ops log, filtered                       | `CONTROL_ROUTES.opsLog`                                                                          | read            | AVAILABLE NOW                             | management scope only; routine events excluded                                                            |
| `/alerts/notifications`     | notification intent + attempts          | `CONTROL_ROUTES.notifications`                                                                   | read, test-send | AVAILABLE NOW                             | intent and attempts stay distinct                                                                         |
| `/system`                   | readiness, build info                   | `CONTROL_ROUTES.systemReadiness`, `HEALTH_ROUTES.info`                                           | read            | AVAILABLE NOW                             | live vs ready distinction                                                                                 |
| `/system/admins`            | admins, roles                           | `ADMIN_ROUTES`                                                                                   | read, write     | AVAILABLE NOW                             | permission decides drawing, never allowing                                                                |
| `/system/monitor`           | monitor config as shipped               | config constants + `monitor-cadence.ts`                                                          | read            | AVAILABLE NOW (read-only)                 | cadence figures match the domain functions                                                                |
| `/users`                    | —                                       | none                                                                                             | none            | PLANNED                                   | route exists, no actionable control, no tags, no recent activity                                          |
| `/services`                 | —                                       | none                                                                                             | none            | PLANNED                                   | no Protocol anywhere; ordering rule stated                                                                |
| `/orders`                   | —                                       | none                                                                                             | none            | PLANNED                                   | no fake states                                                                                            |
| `/payments`                 | —                                       | none                                                                                             | none            | PLANNED                                   | expiry/refund rules recorded as unenforceable today                                                       |
| `/products`                 | —                                       | none                                                                                             | none            | PLANNED                                   | no least-loaded routing concept                                                                           |
| `/resellers`                | —                                       | none                                                                                             | none            | PLANNED                                   | —                                                                                                         |
| `/discounts`                | —                                       | none                                                                                             | none            | PLANNED                                   | —                                                                                                         |
| `/reports`                  | —                                       | none                                                                                             | none            | PLANNED                                   | —                                                                                                         |
| `/bots`                     | —                                       | none                                                                                             | none            | PLANNED                                   | add flow disabled; only reseller sales bot, not creatable                                                 |
| `*`                         | —                                       | —                                                                                                | —               | AVAILABLE NOW                             | not-found state                                                                                           |

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
