# Legacy service candidates — outcomes and the operator's review (Mirza PR5)

Area D of the Mirza migration; owner decision 8 (2026-10-07). Code:
`apps/api/src/modules/platform/legacy-service-review/` (the review),
`apps/api/src/modules/platform/legacy-importer/application/service-outcomes.ts` (outcomes,
evidence, the approval gate, the report section), the importer's adoption phase, and the Web
Admin page `/legacy-services`. Tables: `legacy_service_candidates` (migrations 0229–0231).

Everything here was exercised against SYNTHETIC data only (`tests/integration/legacy-service-review.test.ts`,
fake RickPanels on real sockets, the real P6). Nothing was run against the real Mirza dump,
RickPanel or a production database: those steps are **NOT RUN** (§7).

## 1. Owner decision 8 — an empty `code_panel` is never adopted automatically

Before PR5 an invoice whose `code_panel` was empty or NULL was searched by its lowercase
username across every configured production RickPanel and adopted on a unique hit — a panel
guessed from a name. That search is gone (`matchLegacyService`, `legacy-service-matching.ts`):

- `code_panel` empty or NULL → the matcher answers `NO_PANEL`, whatever the inventories hold
  (one holder, several, none, or an incomplete walk). The candidate's outcome is `NO_PANEL`; its
  map row is `MANUAL_REVIEW / PANEL_UNMAPPED` (the map keeps its closed review vocabulary — no
  map CHECK changed).
- A code the operator **declared** missing (`missingPanels` in the panel map) is still searched:
  that is an explicit, fingerprinted operator statement, not a guess from an empty cell. Whether
  it should also become review-only is `OQ-LSR-02`.
- Only an explicit operator **ADOPT approval** may adopt a `NO_PANEL` invoice (§4), and only onto
  a panel the map maps explicitly whose complete inventory holds exactly that account.

**Panel 8255** (or any code nobody has decided) stays unmapped unless the operator maps it
explicitly: never listed in `missingPanels` to "see what the search finds", never guessed from
the holders the evidence shows. Recommended entry until the owner decides:
`"unresolvedPanels": [{ "codePanel": "8255", "reason": "OWNER_DECIDES_LATER" }]` — its invoices
then stay `PANEL_UNMAPPED`, counted and reviewable, and the audit does not block on a forgotten
code. If the owner ever maps it, add `{ "codePanel": "8255", "panelId": "<NEXA RickPanel uuid>" }`
to `panels` (the panel must be an ACTIVE, non-archived RickPanel of the tenant and in
`productionPanels`), remove it from `unresolvedPanels`, and re-approve the new map fingerprint:
a changed map is a changed `--expected-panel-map-fingerprint`, and a resume under a different
map is refused.

What changed deliberately in tests that pinned the search: `tests/unit/legacy-service-matching.test.ts`
(the "panel missing" cases now use a declared-missing code; a NULL code is `NO_PANEL`),
`tests/unit/legacy-importer-decisions.test.ts`, `SYNTHETIC_EXPECTED.services.categories`
(`NO_PANEL: 3`, `ADOPTION_ELIGIBLE: 4 → 3`, `PROVIDER_MISSING: 2 → 1`, `AMBIGUOUS_PANEL: 1 → 0`
— the dataset itself, and so every fingerprint, is unchanged) and the importer's integration
counts. The synthetic rehearsal compares adopted with the dry-run's eligible count, so it moves
with the plan.

## 2. One deterministic outcome per live invoice

Every live invoice of the snapshot gets exactly ONE outcome per APPLY run, recorded on its
`legacy_service_candidates` row (unique per `(tenant, invoice_key)`; a rerun updates the same
row, never a second one). The closed set is `LEGACY_SERVICE_OUTCOMES`
(`packages/contracts/src/legacy-service-review.ts`):

| Outcome                                                                                                       | Meaning                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ADOPTED`                                                                                                     | adopted by this run (automatically, or an approval it executed); the map says IMPORTED/SERVICE          |
| `ALREADY_ADOPTED`                                                                                             | adopted by an earlier run; **never unadopted** (a later blocker is reported as `blocker`, for a person) |
| `ADOPTION_ELIGIBLE`                                                                                           | every check holds and nothing adopted it (adoption not wired, or kept as history)                       |
| `NO_PANEL`                                                                                                    | owner decision 8                                                                                        |
| `PANEL_UNMAPPED`, `PROVIDER_MISSING`, `AMBIGUOUS_PANEL`, `USERNAME_CASE_COLLISION`, `INVENTORY_INCOMPLETE`    | the matcher's outcomes (an incomplete walk — `TOTAL_CHANGED` included — decides nothing)                |
| `AMBIGUOUS_OWNERSHIP`                                                                                         | live invoices of different owners claim one account, or P6 found the name or customer taken             |
| `CUSTOMER_NOT_IMPORTED`, `ORPHAN`                                                                             | the owner was not imported / no legacy user owns it                                                     |
| `PRODUCT_UNRESOLVED`, `UNSUPPORTED_SHAPE`, `SUBSCRIPTION_REF_BLOCKED`, `PROVIDER_READ_FAILED`                 | the product/shape/account cannot be held; an unreadable account is read again by the next run           |
| `INVOICE_KEY_INVALID`, `TEST_INVOICE_SKIPPED`, `TEST_PANEL_SKIPPED`, `INVALID_SOURCE_ROW`, `INVALID_USERNAME` | history by rule                                                                                         |
| `REVIEW_CLOSED`                                                                                               | a person closed the map row in the terminal review queue; no run acts on it                             |

Order of precedence (`candidateOutcome`): an invoice the map already holds as a SERVICE is
`ALREADY_ADOPTED`; a map row closed in the terminal queue is `REVIEW_CLOSED`; an eligible
invoice is what P6 answered — and "adopted" is what the **map** says after P6, never P6's word
alone (`ADOPTION_UNCONFIRMED` otherwise); everything else is its category, the map's reason as
`blocker`. Ambiguous ownership (`withOwnershipRule`, `plan.ts`): two or more eligible invoices of
DIFFERENT legacy owners resolving to the same panel and lowercase name are all
`AMBIGUOUS_OWNERSHIP` (map `CONFLICTING_EXISTING_ENTITY`); an invoice kept as history is no
claim, so keeping the wrong claims as history lets the next run adopt the right one. Invoices of
ONE owner naming one account keep P6's rule (the first adopts; the rest find the name taken) —
`OQ-LSR-03`.

**Nothing is discarded.** A candidate that is not a service is archived history: its row names
the latest VISIBLE invoice-archive revision (`archive_id`, PR3) when the archive holds one. Run
`invoices-read` BEFORE `import` so the link exists; the report counts `notLinkedToArchive`.

**Evidence** (`legacy_service_candidates.evidence`, `LegacyServiceEvidence`): the class of the
panel code and the panel the map gives it; whether the owner was imported; every production
panel whose COMPLETE inventory holds the lowercase name (spellings, the state when unique, and
whether the panel is mapped); the incomplete panels; the product path and whether it resolved;
how many live invoices carry the same name. Codes, NEXA ids and counts only — never a legacy
username, a Telegram id, a provider spelling or a subscription link. A change of evidence is a
new version (`evidence_hash`).

## 3. The review states and who writes what

| State             | Set by                    | Meaning                                                                                               |
| ----------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `OPEN`            | the importer, or a reopen | nobody decided                                                                                        |
| `ACKNOWLEDGED`    | operator                  | seen; a later run may still adopt it; a run with a different outcome puts it back OPEN                |
| `KEPT_AS_HISTORY` | operator                  | never adopted (auto or otherwise) and no claim on its account, until reopened                         |
| `ADOPT_APPROVED`  | operator                  | an explicit ADOPT approval, bound to the invoice checksum, the outcome seen and (when needed) a panel |
| `ADOPTING`        | the importer (a claim)    | a run claimed the approval; a crash leaves it here and the resume executes it                         |
| `ADOPTED`         | the importer              | a NEXA service; terminal (0230 refuses any change of state or service, and any DELETE)                |

The importer is the ONE writer of outcomes and evidence (`maintenance.run`). The operator writes
only the review columns (`legacy.services.decide`), each decision ONE conditional UPDATE naming
its from-states AND the version the operator saw, inside a transaction that re-checks the
session and permission, reads `ScopeActivityReader`, takes the invoice's advisory lock (the one
P6 takes first), refuses an invoice the map already holds as a service, is idempotent by key and
audited (codes and ids only; DENIED too). `version` advances on every decision and whenever a
run changes something a decision rests on (outcome, blocker, checksum, evidence, archive link,
service, state) — never for the run id alone. A KEEP and an adoption of the same invoice are
serialised by that lock: P6 re-reads `KEPT_AS_HISTORY` under it and adopts nothing.

**Not the terminal Manual Review Queue.** The queue (`legacy-review-queue.service.ts`) stays
terminal-only and charged to the CRITICAL `maintenance.run`; its boundary test is unchanged. This
is its own service, like PR2–PR4's: it neither reads nor writes the queue's review columns. The
two interact only through the map: an invoice whose map row a person closed in the queue is
`REVIEW_CLOSED` here, and an approval executed onto it is refused `REVIEW_CLOSED`.

## 4. The explicit ADOPT

1. **Request** (`POST /legacy-services/:id/adopt`, `legacy.services.decide`, HIGH): from OPEN or
   ACKNOWLEDGED, at the version shown, for an outcome a person can clear
   (`LEGACY_SERVICE_ADOPTABLE_OUTCOMES`: `ADOPTION_ELIGIBLE`, `NO_PANEL`, `PANEL_UNMAPPED`,
   `PROVIDER_MISSING`, `AMBIGUOUS_PANEL`, `PRODUCT_UNRESOLVED`, `INVENTORY_INCOMPLETE`,
   `PROVIDER_READ_FAILED`, `CUSTOMER_NOT_IMPORTED`). When the map gives the invoice no panel the
   operator MUST name one, and it must be a mapped panel whose complete inventory held exactly one
   spelling of the account in the latest run (`adoptPanelsOf`); when the map gives one, naming a
   different panel is refused — an explicit mapping is never overridden by a click. **Nothing is
   adopted by the request**: no service, order or map row, no provider call.
2. **Execution** — by the next `import` or `resume` (the CLI, SYSTEM_JOB, `maintenance.run`),
   which walks every production panel's inventory twice as it always does:
   - the gate (`approvalGate`): a SYNTHETIC approval against a production-like target is left
     untouched and audited (`approval_synthetic_refused`, attention); an approval of the other
     source class likewise; the invoice must still be live (`NOT_LIVE`) and its checksum the one
     approved (`SOURCE_CHANGED`); the panel must be one the run's panel map maps explicitly
     (`PANEL_NOT_MAPPED`) and not one the invoice's own code maps elsewhere
     (`PANEL_CONFLICTS_WITH_MAP`);
   - the claim: ADOPT_APPROVED → ADOPTING, conditional on the version (a person's reopen in between
     wins; counted `claimLost`);
   - EVERY adoption check again, through the one plan and the one adopter: `decideServiceCandidate`
     on the operator's panel (`matchOnPanel`: test code, comparable username, the panel's
     COMPLETE inventory holds exactly one spelling — an incomplete walk or `TOTAL_CHANGED` is
     `INVENTORY_INCOMPLETE`), the owner imported, the ownership rule, the product and shape, then
     P6 (`adoptCandidate`): runtime state, customer, product compatibility, the panel's lock and
     type, the username not already a NEXA service or reservation, all under the invoice lock;
   - settle: ADOPTED with the service the map names, or back to OPEN with
     `last_approval_refusal` = the refusing code. Audited (`approval_executed` /
     `approval_refused`), codes and ids only.
3. **No provider write, ever.** The inventory reader is read-only by construction and P6 holds no
   provider client (`legacy-adoption-boundary`, `legacy-service-review-boundary`); the integration
   suite asserts every request to the fake panels is a GET (or the token exchange) and that no
   account was created or modified.

**Inventory freshness — why the run, not the request, executes.** P6 adopts only from the runtime
facts of a complete double walk inside a RUNNING `APPLY` run, and the map refuses any write
outside one. So the approval binds to what the operator saw (checksum, outcome, version, panel)
and the adoption uses the run's own fresh walk; a panel that changes during the walk fails the
approval closed (`INVENTORY_INCOMPLETE`), and the evidence then shows no holder on it, so a new
approval waits for a run with a complete inventory.

## 5. Concurrency, crash and resume (all tested)

- Two operators deciding one candidate at one version: one wins, the other is refused
  (`VERSION_CONFLICT` / `NOT_IN_STATE`), never applied over the newer state.
- An operator alongside a running import: a KEEP landing mid-run is honoured by P6 under the
  invoice lock (no service); an approval landing after the run read the approvals waits for the
  next run; a KEEP racing P6 on one invoice never yields both a keep and a service.
- Crash after P6 committed and before the approval settled: the candidate stays ADOPTING (a
  person cannot reopen it); the resume finds the map IMPORTED (`ALREADY_ADOPTED`) and settles it —
  exactly one service.
- A rerun writes no second row; an adopted candidate stays adopted when the account later
  disappears (blocker `PROVIDER_MISSING`, and the map's refusal makes the verdict
  `COMPLETED_WITH_FAILURES`).

## 6. The report section (`serviceOutcomes`, for PR6)

`reconcile` (in `sections`) and `report` (beside the closed v1 document, like `usersWallets`)
print `nexa-legacy-service-outcomes/v1` (`buildServiceOutcomesSection`). PII-free: counts and
codes only, never an invoice key, username or Telegram id. It reads the candidate rows of this
snapshot's live invoices and reports only what it read:

```json
{
  "version": "nexa-legacy-service-outcomes/v1",
  "sourceFingerprint": "<v1>",
  "synthetic": false,
  "runId": "<the latest APPLY run>",
  "candidates": 0,
  "recorded": 0,
  "outcomes": { "<every LEGACY_SERVICE_OUTCOMES member>": 0 },
  "invariant": {
    "statement": "every service candidate assigned exactly one deterministic outcome",
    "holds": true,
    "missing": 0,
    "unrecordable": 0,
    "decidedByAnotherRun": 0,
    "fromAnotherSource": 0,
    "checksumDiffers": 0
  },
  "adopted": 0,
  "archivedHistory": { "notAdopted": 0, "linkedToArchive": 0, "notLinkedToArchive": 0 },
  "review": { "<every LEGACY_SERVICE_REVIEW_STATES member>": 0 }
}
```

`reconcile` adds the check `services.outcomes.closure` (the invariant) to its equations, so a
missing or stale outcome makes the verdict `DISCREPANCY`. The apply report carries the run's own
tallies: `applied.services.outcomes` (Σ = live invoices), `candidates`
(INSERTED/UPDATED/UNCHANGED, `sourceClassMismatch`, `unrecordable`) and `approvals`
(`executed`, `refused` by code, `left` by reason, `claimLost`); `attention` counts
`candidateSourceClassMismatch`, `candidateUnrecordable` and `approvalLeft`.

## 7. NOT RUN (needs the real dump, RickPanel and a staging copy)

- [ ] Re-run `audit`/`dry-run` on the real staging snapshot: record how many live invoices are
      `NO_PANEL` now (they were searched before PR5), as a dated baseline — never an oracle.
- [ ] Owner decision on panel 8255 (§1); until then `unresolvedPanels` with `OWNER_DECIDES_LATER`.
- [ ] An `import` on staging; reconcile `services.outcomes.closure` holds; `/legacy-services` lists
      every candidate; the archive link holds (`notLinkedToArchive = 0`) when `invoices-read` ran first.
- [ ] One explicit ADOPT of a real `NO_PANEL` invoice on staging, executed by a `resume`; the
      service's panel and username checked in the RickPanel UI (read only); no provider write in the
      panel's own logs.
