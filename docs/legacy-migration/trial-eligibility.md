# Legacy trial-eligibility preservation (Item 15)

**Status: DONE (mechanism), import HOLD.** A migrated customer must never receive a
fresh trial merely because NEXA is new to them. What exists is the decision rule, the
service that applies it to one customer under the customer's lock, and the record that
explains it. Nothing imports customers; the P7 importer that will call this per legacy
user is on hold, and no surface calls it.

The legacy distribution this is sized against is the earlier audit's
(`limit_usertest`: `1` → 195,389, `0` → 2,071, `9` → 1). The final evidence is Q2 of
[`sql-evidence.md`](sql-evidence.md) (`limit_usertest × had_trial`), MANUAL ACCEPTANCE.

## 1. The audit: the model already exists

ADR-0015 makes a trial allowance a LIMIT and a USED count. `trialAllowanceFor` is the
one evaluator: `effectiveLimit` is the customer's `trial_limit_overrides` row when there
is one (`0` = no trials, never unlimited) or `trial.limit_per_customer`; `used` is the
customer's `trial_grants` that are neither released nor reset. `TrialService.claim`
decides under the customer's row lock; `TrialAdminService` writes overrides under the
same lock.

So there is nothing to build but an input: a per-customer override of `0` is exactly
"this customer may not take a trial", read by the evaluator every claim already uses.
No second trial subsystem, no second evaluator, no counter reset.

## 2. The decision table

`decideLegacyTrial` (`apps/api/src/modules/commerce/trials/application/legacy-trial-eligibility.ts`),
in order — the first matching row wins:

| #   | Legacy facts / NEXA state                                 | Decision                  | Effect                                      |
| --- | --------------------------------------------------------- | ------------------------- | ------------------------------------------- |
| 1   | the customer already has a NEXA override                  | `KEPT_EXISTING_OVERRIDE`  | untouched — never loosened, never rewritten |
| 2   | `limit_usertest` not a whole number (NULL, text, decimal) | `LEGACY_LIMIT_UNREADABLE` | override `0`                                |
| 3   | `limit_usertest ≤ 0`                                      | `LEGACY_NO_TRIALS`        | override `0`                                |
| 4   | `limit_usertest ≥ 1` and a test invoice existed           | `LEGACY_TRIAL_CONSUMED`   | override `0`                                |
| 5   | `limit_usertest ≥ 1` and no test invoice                  | `INHERIT_NEXA_POLICY`     | no override                                 |

Row 4 is the program's "do not assume `limit_usertest = 1` means unused": the actual
history (`invoice.is_test = 1`, any status) decides. A customer who also used a NEXA
trial before the import keeps that grant counted whatever the row says, because the
evaluator counts grants independently of the override.

## 3. The decision for "allowed, no evidence of use" (row 5)

The program leaves this row to be decided conservatively. Chosen: **no override; NEXA's
current policy applies**, exactly as it does to any customer who never had a trial.

- It is not a fresh trial "merely because NEXA is new": the legacy bot itself said this
  customer may take a trial and they never did, so the entitlement being honoured is
  theirs. Rows 2–4 are the ones the program's rule is about.
- It never grants more than NEXA grants anyone: the limit is `trial.limit_per_customer`,
  and every panel's own trial switch still applies.
- It never pins a number: writing `min(legacy, global)` would freeze today's global
  limit into a per-customer row, so turning trials down globally later would leave
  migrated customers above everyone else.
- The odd legacy value `9` (one user) is therefore treated as "allowed" and gets NEXA's
  limit, which is lower — tightening, never loosening.

If Q2 shows a large row-5 population and the owner wants it closed too, the change is
one branch here (row 5 → override `0`), recorded in `docs/open-questions.md` as
`OQ-I15-01`.

## 4. The mechanism

`LegacyTrialEligibilityService.preserve(scope, actor, { idempotencyKey, customerId, legacy })`:

1. Authorize `users.trial.edit` — the permission an operator's override write takes,
   because this writes the same row for the same reason. A denial is audited.
2. Replay by idempotency key (namespaced by the actor's surface).
3. In one transaction: scope activity; the customer's row lock (the claim's lock, so an
   import never lands between a claim's count and its insert; an unknown or other-tenant
   customer is `CUSTOMER_NOT_FOUND`); the decision; the override (only ever `0`, only
   ever over no override); the record; an audit row `trial.legacy.preserve` with
   before/after as values.

The record (`legacy_trial_eligibility`, migration 0183) is one row per
`(tenant, customer)`: the legacy limit and had-trial as values, the decision, the
override before and after, and a SHA-256 of the normalised legacy facts. CHECKs keep the
decision and the override consistent (it cannot misexplain itself); 0184 makes it
append-only.

**Reruns.** The same facts again — under the same key or another — are `REPLAYED`, and
change nothing, even if an operator has since lifted the override: the import decides
once and never re-imposes. Different facts for a decided customer are a `CONFLICT`, and
change nothing either; that is a person's question about the archive, not a rewrite.

**Provenance.** The record explains why a customer is or is not eligible. Item 7's
`legacy_import_map` (branch `wp3/i7-p4-import-metadata`) is not duplicated: P7 will
write one map row per legacy user pointing at the customer, and this row is reachable by
that customer id. Telegram ids and the legacy row are not stored here.

**Identity.** The caller passes the NEXA customer: P7 maps legacy `user.id` →
`customers.telegram_user_id` per tenant (§19) before calling this.

## 5. Tests

- `tests/unit/legacy-trial-eligibility.test.ts` — every row of the table; `limit = 1`
  with a trial is consumed; unreadable values; an existing override kept in both
  directions; the rule never produces an override above 0 of its own; input hashing.
- `tests/integration/legacy-trial-eligibility.test.ts` — through the real claim: a
  control showing an un-imported customer WOULD get a trial; legacy no-trial, consumed
  and unreadable are refused `LIMIT_REACHED`; allowed-no-evidence gets exactly NEXA's one
  trial; an existing NEXA override (3, and 0) is kept and a customer's existing NEXA grant
  still counts; rerun idempotency, no re-imposition after an operator lifts it, and a
  conflict that changes nothing; a real concurrent race on one customer (barrier on the
  customer row); tenant isolation; denial without `users.trial.edit`; the record is
  append-only.

Mutation checked: removing the customer lock fails the race case; removing the
`had_trial` branch fails the unit table; skipping the already-decided read fails the
rerun case.

## 6. What is deliberately not done

- No import, no CLI, no surface (P7 HOLD).
- A **global trial reset** stamps grants and does not clear overrides, so customers
  closed by rows 2–4 stay closed through one. That is the conservative reading of "never
  a fresh trial because of the migration"; an operator lifts one customer's override
  through the existing per-customer screen.
- Live legacy trial accounts are not adopted (registered decision); they expire on the
  provider.

## 7. Final validation — program 4, Item 5 (2026-10-04)

No defect was found in the rule or its mechanism. The table below maps each program rule
to the code and the test that fails when it is reverted ("M" = mutation-checked).

| Program rule                                                                         | Code                                                                                                        | Test(s)                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limit_usertest = 0` ⇒ no trial                                                      | `decideLegacyTrial` row 3 → override 0                                                                      | unit "limit 0 means no trials", literal table rows 3; integration "legacy no-trial (limit 0) stays no-trial in NEXA" (through the real claim)                                                                                                                                             |
| historical `is_test = 1` ⇒ prior trial                                               | row 4 → `LEGACY_TRIAL_CONSUMED`, override 0                                                                 | unit "allowed and already used is consumed", literal rows 4; integration "legacy allowed but already used is consumed" — M (removing the `had_trial` branch fails the unit table)                                                                                                         |
| `limit_usertest = 1` alone does not prove an unused trial                            | row 5 → no override, NEXA's own policy (`OQ-I15-01` default, kept) — never a per-customer allowance above 0 | unit literal rows 5, "no row of the rule grants a per-customer allowance above zero"; integration "legacy allowed with no evidence of use defers to NEXA policy, and NEXA counts the trial" (exactly one trial, not one per system)                                                       |
| Unreadable limit is not evidence of an unused trial                                  | row 2 → override 0                                                                                          | unit "an unreadable limit is no trials"; integration "an unreadable legacy limit gives no trial"                                                                                                                                                                                          |
| Existing NEXA override reconciled, never overwritten                                 | row 1 `KEPT_EXISTING_OVERRIDE`; the service writes only over NO override                                    | unit literal rows 1; integration "respects an existing NEXA customer's current state", "an operator's override racing the import is never overwritten by it" — M (deciding as if no override existed fails three cases)                                                                   |
| Existing NEXA trial GRANT reconciled, never forgotten                                | the override only tightens; `trialAllowanceFor` counts grants independently                                 | integration "respects …" (used NEXA trial + row 5), "tightens over an existing NEXA grant without forgetting it" (row 4 over a grant: `used = 1`, limit 0)                                                                                                                                |
| No fresh trial because NEXA is new                                                   | rows 2–4 close; row 5 grants nothing NEXA would not grant anyone                                            | integration control case + every refusal case above                                                                                                                                                                                                                                       |
| Reruns: same facts replay, never re-impose; different facts conflict, change nothing | record read under the customer lock; `inputHash`                                                            | integration "is idempotent on rerun, never re-imposes a lifted override", "a kept operator override is not re-imposed by a rerun after the operator removes it" — M (skipping the already-decided read)                                                                                   |
| Concurrency                                                                          | the customer row lock (the claim's lock)                                                                    | integration "serialises two concurrent imports of one customer" — M (removing `lockCustomer`); "a NEXA claim racing the import never yields a second trial (both orders)" pins the outcome (the record's FK alone also queues it, so it is not the lock's falsifier — stated in the test) |
| Tenant isolation, deny by default, scope activity, append-only record                | scoped lock; `users.trial.edit`; `scopeIsActive(tx)`; 0184                                                  | integration "keeps tenants apart", "denies an actor without users.trial.edit", "refuses once the tenant has stopped accepting work", "keeps the decision record append-only"                                                                                                              |

`OQ-I15-01` stays the owner's: if Q2 shows the row-5 population should be closed too, it
is one branch of `decideLegacyTrial` and the literal row-5 cases in the unit table. Q2/Q2b
remain MANUAL ACCEPTANCE (`sql-evidence.md`).
