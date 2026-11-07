# Handoff — NEXA owner batch 1 (after Phase 6A), 2026-11-07

Lives on `claude/elegant-noether-g9v8x9` only. Binding prompt: `docs/ob1-handoff/NEXA-OWNER-BATCH-1.md`
(merge permission per PR on green + one Codex fix commit; never push main, never force-push, never tag;
don't stop to ask; order PR-1/PR-4 → PR-2 → PR-3 → PR-5). Worktrees under `/home/user/wt/<pr>`.

## Merged (main)

- PR-4 https://github.com/Mhoseinshah1/nexa-bot/pull/419 — SecretInput, one Save, value formatter — `6de9bd557`.
- PR-1 https://github.com/Mhoseinshah1/nexa-bot/pull/420 — Mirza menu defaults, search switches — `1f1d5545d`.
- PR-2 https://github.com/Mhoseinshah1/nexa-bot/pull/421 — reseller requests — `795cfa85c`. Migrations 0322/0323.
- PR-3 https://github.com/Mhoseinshah1/nexa-bot/pull/422 — automatic deletion — `5d0c286c1`. Migration 0324.

## Open

- PR-5 `feat/late-payment-policy` — built, `pnpm verify` green, lead-reviewed; branch pushed, NO PR yet. Migration
  0322_late_payment_policy (data only, hand-registered) must become 0325 after PR-3 merges. Body draft:
  `docs/ob1-handoff/pr5-body-draft.md`.

## Next step (exact)

PR-5 (merge-main agent running): merge main, renumber its hand-registered migration to 0325 (journal `when` =
Date.now()), db:check, migration suites, push, open PR with the draft body, `@codex review`, one fix commit, merge.

## Decisions taken

- PR-4: password-type allowlist = app.tsx, pages/account.tsx, pages/hosted-activate.tsx. One Save only where a
  dialog had several separately-saved secrets (gateway key drawer); existing endpoints called in turn, no batch
  endpoint. SecretInput blocks copy/cut while masked (automated security note; CSS masking is the owner's design).
- PR-1: `{تست}` is literal because the engine only substitutes ASCII `{name}`. A stored `bot.main_menu` row keeps the
  old packing. Stale search tap refused only when both flags are off. `tickets` stays after support.
- The report and handoff live on the session branch (as in phase 6A), not on main.
- PR-2: own message table, not tickets (a ticket has category/priority/assignee/AI hold and a customer reply
  reopens it). Approve reuses `ResellerAdminService.registerWithin` in the approval's transaction; an applicant who
  became a reseller another way is refused, request stays PENDING. No new permission (resellers.view/edit).
- PR-3: a transferred service keeps state_since; its scheduled run is cancelled and the new owner gets a full warning.
- PR-5: keys kept, value type boolean→WALLET|REVIEW|DELIVER. Terminal order → a fulfilment order tied to the payment
  (copies the frozen line and totals). Exactly once: one ledger key `<paymentId>:late-credit` (unique) under the payment's
  FOR UPDATE; DELIVER writes it inside the purchase tx, any failed check rolls back to the WALLET credit. Both operator
  choices need `payments.reconcile` (no payments-approve permission exists). Ops-group buttons are URL buttons to the
  Web Admin decision dialog.
