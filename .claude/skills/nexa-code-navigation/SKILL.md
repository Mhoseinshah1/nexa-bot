---
name: nexa-code-navigation
description: How to find the files behind a NEXA feature without reading the repository — scripts/claude/module-map.sh (a module's services, tables it writes, contracts, tests), the layer map (web page → controller → application → domain → schema → migration), a trace script that lists them in one call, and the files never to read whole (bot-runtime.ts, schema.ts, templates.ts). Use when you need to locate where something is implemented, follow a request path, or decide which file to open next.
---

# Finding code in NEXA

The repository is large (a 17k-line `schema.ts`, 240+ migrations, 750+ test
files, hundreds of docs). Reading directories or whole files to orient yourself
is the most expensive thing a session does. Search first, then open the one
file the search names, at the lines it names.

**Never read these whole** — `grep -n`, then `Read` with `offset`/`limit`:
`apps/api/src/surfaces/telegram/bot-runtime.ts` (~18.7k lines),
`apps/api/src/infrastructure/persistence/schema.ts` (~16.9k),
`packages/contracts/src/templates.ts` (~13.3k).

`bot-runtime.ts` must stop growing: a new bot screen goes in its own file under
`apps/api/src/surfaces/telegram/` and is only **wired** in `bot-runtime.ts`.

## Step 0 — the module map

```bash
bash scripts/claude/module-map.sh --all               # one line per module
bash scripts/claude/module-map.sh <module>            # services, tables written, contracts, tests
bash scripts/claude/module-map.sh --who-writes <table>
bash scripts/claude/module-map.sh --who-calls <symbol>
```

Pure shell, read-only, nothing generated is committed. `<module>` is a key like
`commerce/orders` or a bare unique name (`orders`). Start here when you know the
module; use Step 1 when you only know a term.

## Step 1 — one call that lists every layer

```bash
bash .claude/skills/nexa-code-navigation/scripts/trace.sh <term> [max-per-layer]
```

Read-only. Prints file names grouped by layer, in request order, capped per
layer (default 8). Good terms are domain words that survive renames: an enum
value (`LATE_COMPLETION`), a permission (`legacy.migration.apply`), a route
segment (`payment-gateways`), a table name (`gateway_attempts`), a template
key, an error code. A generic word (`payment`) returns noise — narrow it.

## Step 2 — open the right layer, not all of them

| Question                                                  | Start in                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| What does the admin see / which permission hides it       | `apps/web/src/pages/<page>.tsx`, `apps/web/src/nav.ts`, `router.ts`                              |
| Which HTTP route, which guard                             | `apps/api/src/surfaces/web/<area>.controller.ts`                                                 |
| What a bot button or command does                         | `apps/api/src/surfaces/telegram/` (`bot-runtime.ts`, `wizard-*.ts`)                              |
| Gateway callbacks / webhooks                              | `apps/api/src/surfaces/gateway/`                                                                 |
| The business rule, the transaction, the lock order        | `apps/api/src/modules/<plane>/<context>/application/*.service.ts`                                |
| A pure decision (pricing, eligibility, state machine)     | `.../domain/*.ts`                                                                                |
| SQL, repositories, readers                                | `.../infrastructure/*.ts`                                                                        |
| A column or constraint                                    | `grep -n "<table>" apps/api/src/infrastructure/persistence/schema.ts`, then read ~60 lines there |
| Shapes shared by API and web, permissions, states, events | `packages/contracts/src/<concept>.ts` (frozen spec)                                              |
| Persian text                                              | `packages/i18n/src/*.fa.ts`, `apps/web/src/i18n/*.fa.ts`                                         |
| Which process runs it                                     | `apps/api/src/main*.ts` (api, worker, monitor, recovery, provisioner, assistant, migration)      |
| Production topology                                       | `deploy/compose.yml`, `deploy/bin/botctl`                                                        |

Planes under `apps/api/src/modules/`: `commerce` (customers, orders, payments,
wallet, pricing, provisioning, resellers, referrals, legacy-_), `control`
(settings, features, notifications, appearance, support-ai, ops-group),
`platform` (identity, access, panels, backup, recovery, legacy-migration and the other legacy-_ import contexts).
Run `ls apps/api/src/modules/<plane>` rather than guessing.

## Step 3 — read narrowly

- `grep -n` the symbol, then `Read` with `offset`/`limit` around the hit.
  Never read `bot-runtime.ts`, `schema.ts`, `templates.ts`, `app.tsx`,
  `catalogue.fa.ts` or a migration journal whole.
- Follow imports one hop at a time; stop when you have the answer.
- For "what did we decide about X", grep `docs/` for the term and read the one
  audit or ADR it names (`docs/adr/`). Docs are big; read the section, not the
  file.
- For the Mirza reverse-engineering corpus (`docs/research/`), use the
  `research-lookup` agent instead of reading it into this context.
- For a broad sweep across many naming conventions, delegate to an `Explore`
  agent and keep only its conclusion.

## What this skill does not cover

The rules for _writing_ code (money, tenancy, outbox, idempotency) are in
`nexa-conventions`; migrations are in `nexa-migrations`; which tests to run is
`nexa-test-selection`.
