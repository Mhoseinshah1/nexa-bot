# Code navigation in full (moved verbatim from SKILL.md, token diet)

`SKILL.md` keeps the commands and the path lists; this is the surrounding prose.

## Why search first

The repository is large (a 17k-line `schema.ts`, 240+ migrations, 750+ test
files, hundreds of docs). Reading directories or whole files to orient yourself
is the most expensive thing a session does. Search first, then open the one
file the search names, at the lines it names.

## Big files and the telegram runtime

Under `apps/api/src/surfaces/telegram/runtime/`, `admin-services-flow.ts`,
`admin-review-flow.ts`, `admin-customers-flow.ts`, `card-receipt-flow.ts`,
`service-card-flow.ts`, `purchase-flow.ts`, `payment-screens.ts`,
`admin-flow.ts` and `callbacks.ts` are 0.9–1.6k each.

Never open an `apps/api/drizzle/meta/<NNNN>_snapshot.json` (37–41k lines each).
Most application services, repositories, web pages and integration suites are
800–4k lines too. The full list (about 340 source, test and script files, plus
docs) is a snapshot in `references/big-files.md`, with the command that
regenerates it.

`bot-runtime.ts` must stop growing: a new bot screen is a free function
`fn(rt: BotRuntime, …)` in `apps/api/src/surfaces/telegram/runtime/<flow>-flow.ts`
and is only **wired** in `bot-runtime.ts` (one line in `act`, or `adminTurn` for
an `ADMIN_*` intent). No forwarding method on `BotRuntime`; a flow imports
another flow's function, and imports `bot-runtime.ts` type-only. The map, the
pattern and the business logic still in the surface: `docs/telegram-runtime.md`.

## Step 0 — the module map (notes)

Pure shell, read-only, nothing generated is committed. `<module>` is a key like
`commerce/orders` or a bare unique name (`orders`). Start here when you know the
module; use Step 1 when you only know a term.

## Step 1 — trace.sh (notes)

Read-only. Prints file names grouped by layer, in request order, capped per
layer (default 8). Good terms are domain words that survive renames: an enum
value (`LATE_COMPLETION`), a permission (`legacy.migration.apply`), a route
segment (`payment-gateways`), a table name (`gateway_attempts`), a template
key, an error code. A generic word (`payment`) returns noise — narrow it.

## Step 2 — planes

Planes under `apps/api/src/modules/`: `commerce` (customers, orders, payments,
wallet, pricing, provisioning, resellers, referrals, legacy-_), `control`
(settings, features, notifications, appearance, support-ai, ops-group),
`platform` (identity, access, panels, backup, recovery, legacy-migration and the other legacy-_ import contexts).
Run `ls apps/api/src/modules/<plane>` rather than guessing.

## Step 3 — read narrowly

- `grep -n` the symbol, then `Read` with `offset`/`limit` around the hit.
  Never read a file over 800 lines whole (`bot-runtime.ts`, `schema.ts`,
  `templates.ts`, `app.tsx`, `catalogue.fa.ts`, … above), nor a migration journal.
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
