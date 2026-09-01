# Research corpus — evidence, not specification

This directory holds a **distilled, sanitized** subset of the reverse-engineering
investigation into MirzaBot, the legacy PHP system Nexa Bot replaces. 92 files:
the per-phase `MASTER.md`, `business-rules.md`, `unknowns.md`, `incidents.md`,
`source-bugs.md`, `entities-*.md`, the cross-surface crossmaps, and the
log-group rebuild recommendation. Raw capture logs, screenshots and superseded
checkpoints are deliberately excluded.

## How to read it

**This is evidence of observed behaviour. It is not a specification, and it is
not a design.** Three rules follow from that, and they matter:

### 1. `NOT_EXPOSED` means the UI did not show it — nothing more

When a document says a thing is `NOT_EXPOSED`, it means the investigation could
not reach it through the user interface. It is **not** evidence that the
underlying entity, column, table or capability does not exist. The legacy system
has many things that exist in its database and are simply unreachable from any
screen — the investigation records exactly that distinction, and so must we.

Reading `NOT_EXPOSED` as "there is no such thing" is the single easiest way to
build the wrong model from this corpus.

The same care applies to the other evidence labels: `VERIFIED_BY_UI`,
`VERIFIED_BY_MATH`, `VERIFIED_BY_OWNER`, `INFERRED`, `UNKNOWN`,
`NOT_SAFELY_TESTABLE`. A rule marked `INFERRED` has not been observed.

### 2. An `UNKNOWN` is never resolved by guessing

Items marked `UNK-*` are open questions about the legacy product's behaviour.
They are carried into `docs/open-questions.md` and stay there until someone with
product authority answers them. Implementing a plausible answer and moving on is
how an undocumented rule becomes an undocumented rule in a second system.

Where this project has made a **design decision** in place of an unknown — the
pricing precedence is the clearest case — that is recorded as our decision in an
ADR, labelled as such, and never presented as an observation.

### 3. Defects here are things to avoid, not things to reproduce

`source-bugs.md` and `incidents.md` catalogue real defects in the legacy system.
Several of them shaped this codebase's conventions directly, and the code
comments say so. None of them is a requirement.

## Sanitization

Identifiers belonging to the observed deployment have been redacted before
committing: Telegram user ids, bot and support account usernames, provider panel
hosts and labels, panel administrator names, and the vendor admin endpoint.
Redaction markers such as `[TELEGRAM_USER_ID_REDACTED]` appear in their place.

The redaction is reproducible and reviewable: see `scripts/sanitize-research.mjs`,
which lists every rule and what it removes, and fails the import if anything
token-, email-, IP- or card-shaped survives. `pnpm check:boundaries` re-runs that
scan over the committed files.

Findings, figures, business rules and defect analysis are untouched. Where a
figure is itself the finding — the 38% revenue understatement, the two
incompatible "buyer" counts of 56,792 and 27,732 — it is preserved exactly.

## Provenance

Sixteen investigation phases covering: Telegram customer behaviour, store and
product settings, user management, financial and gateway configuration, pending
receipts, Marzban and 3X-UI panels, bot capabilities, general settings, admin
management, bot text management, global trial limits, robot statistics, the Web
Admin V2 surface, and the Telegram log group.
