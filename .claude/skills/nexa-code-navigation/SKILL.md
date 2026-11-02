---
name: nexa-code-navigation
description: How to find the files behind a NEXA feature without reading the repository — scripts/claude/module-map.sh (a module's services, tables it writes, contracts, tests), the layer map (web page → controller → application → domain → schema → migration), a trace script, the 800-line never-read-whole rule, and where a bot handler lives. Use when you need to locate where something is implemented, follow a request path, or decide which file to open next.
---

# Finding code in NEXA

Search first, then open the one file the search names, at the lines it names.
Read `references/navigation-detail.md` for rationale, planes and docs/research
lookup tips; `references/big-files.md` is the full >800-line list.

**Never read a file over 800 lines whole** — `grep -n`, then `Read` with
`offset`/`limit`; `wc -l <file>` when unsure. Biggest (2026-10-26):

- `apps/api/src/infrastructure/persistence/schema.ts` ~17k;
  `packages/contracts/src/templates.ts` ~13.6k; `apps/web/src/i18n/web.fa.ts`
  ~11k; `apps/api/src/container.ts` ~8.8k;
  `packages/contracts/src/http.ts` ~7k
- `apps/api/src/modules/commerce/payments/application/payment.service.ts` ~6k;
  `apps/web/src/api/client.ts` ~5.5k; `apps/web/src/i18n/templates.fa.ts` ~4k;
  `apps/web/src/pages/panels.tsx`, `apps/web/src/pages/payments.tsx` ~3.2k
- `apps/api/src/surfaces/telegram/bot-runtime.ts` ~2.5k (router);
  `packages/contracts/src/settings.ts` ~2.3k; `apps/web/src/app.tsx` ~2k;
  `apps/api/src/surfaces/telegram/runtime/intent-of.ts`,
  `packages/i18n/src/catalogue.fa.ts` ~1.6k
- Under `apps/api/src/surfaces/telegram/runtime/` (~1–1.6k each):
  `admin-services-flow.ts`, `admin-review-flow.ts`, `admin-customers-flow.ts`,
  `card-receipt-flow.ts`, `service-card-flow.ts`, `purchase-flow.ts`,
  `payment-screens.ts`, `admin-flow.ts`, `callbacks.ts`
- Never open `apps/api/drizzle/meta/<NNNN>_snapshot.json` (37k+ lines).

`bot-runtime.ts` must stop growing: a new bot screen is a free function
`fn(rt: BotRuntime, …)` in `apps/api/src/surfaces/telegram/runtime/<flow>-flow.ts`,
only **wired** in `bot-runtime.ts` (one line in `act`, or `adminTurn` for an
`ADMIN_*` intent). No forwarding method on `BotRuntime`; flows import each
other's functions, `bot-runtime.ts` type-only (`docs/telegram-runtime.md`).

## Layout

```
packages/contracts   frozen spec: types, schemas, catalogs, ports. Depends on nothing.
packages/i18n        the shared Persian catalogue, used by BOTH server and web
apps/api             src/modules/<context>/{domain,application,infrastructure}
                     src/surfaces/{telegram,web}   src/infrastructure/  (adapters)
                     entrypoints: main.ts (api), main.worker.ts (worker),
                                  main.monitor.ts (panel health monitor),
                                  main.recovery.ts (the destructive restore lane),
                                  main.provisioner.ts (creates services on panels)
apps/web             React admin shell; may import @nexa/contracts and @nexa/i18n only
```

## Step 0 — the module map

```bash
bash scripts/claude/module-map.sh --all               # one line per module
bash scripts/claude/module-map.sh <module>            # services, tables written, contracts, tests
bash scripts/claude/module-map.sh --who-writes <table>
bash scripts/claude/module-map.sh --who-calls <symbol>
bash scripts/claude/module-map.sh --bot               # router and runtime/ files, sizes
bash scripts/claude/module-map.sh --bot <handler>     # where a handler is defined, who calls it
```

`<module>`: a key like `commerce/orders` or a bare unique name (`orders`).

## Step 1 — one call that lists every layer

```bash
bash .claude/skills/nexa-code-navigation/scripts/trace.sh <term> [max-per-layer]
```

Read-only; file names by layer, in request order. Good terms survive renames
(enum value, permission, route segment, table, template key, error code); a
generic word (`payment`) returns noise.

## Step 2 — open the right layer, not all of them

- Admin UI / permission: `apps/web/src/pages/<page>.tsx`, `apps/web/src/nav.ts`
- HTTP route, guard: `apps/api/src/surfaces/web/<area>.controller.ts`
- Bot button or command: `module-map.sh --bot <handler>`; `apps/api/src/surfaces/telegram/runtime/*-flow.ts`
- Gateway webhooks: `apps/api/src/surfaces/gateway/`
- Business rule, transaction: `apps/api/src/modules/<plane>/<context>/application/*.service.ts`
- Pure decision: `.../domain/*.ts`; SQL: `.../infrastructure/*.ts`
- A column: `grep -n "<table>" apps/api/src/infrastructure/persistence/schema.ts`, then ~60 lines
- Shared shapes, permissions, states, events: `packages/contracts/src/<concept>.ts`
- Persian text: `packages/i18n/src/*.fa.ts`, `apps/web/src/i18n/*.fa.ts`
- Which process runs it: `apps/api/src/main*.ts`; topology: `deploy/compose.yml`, `deploy/bin/botctl`
- Planes under `apps/api/src/modules/` (`ls` a plane, never guess); research corpus `docs/research/` → the `research-lookup` agent

"What did we decide about X": grep `docs/`, read the one audit or ADR
(`docs/adr/`) it names.
