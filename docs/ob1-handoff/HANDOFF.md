# Handoff — NEXA owner batch 1 (after Phase 6A) — ROUND COMPLETE, 2026-11-07

Lives on `claude/elegant-noether-g9v8x9` only. Binding prompt: `docs/ob1-handoff/NEXA-OWNER-BATCH-1.md`.
Report: `docs/round-reports/owner-batch-1.md` (on this branch).

## Merged (main)

- PR-4 https://github.com/Mhoseinshah1/nexa-bot/pull/419 — SecretInput, one Save, value formatter — `6de9bd557`.
- PR-1 https://github.com/Mhoseinshah1/nexa-bot/pull/420 — Mirza menu defaults, search switches — `1f1d5545d`.
- PR-2 https://github.com/Mhoseinshah1/nexa-bot/pull/421 — reseller requests — `795cfa85c`. Migrations 0322/0323.
- PR-3 https://github.com/Mhoseinshah1/nexa-bot/pull/422 — automatic deletion — `5d0c286c1`. Migration 0324.
- PR-5 https://github.com/Mhoseinshah1/nexa-bot/pull/423 — late-payment policy — `649e18d69`. Migration 0325.
- main @ `649e18d69`; newest migration 0325_late_payment_policy.

## Open

- Nothing in this batch. Worktrees and test databases removed.
- Remote branches not deleted (the permission check refused the delete): feat/menu-mirza-defaults,
  fix/webadmin-secrets-forms-json, feat/reseller-request, feat/service-auto-delete, feat/late-payment-policy.

## Follow-ups noticed (not in scope)

- `bot.start.welcome` / `welcome_back` default texts still name the old menu labels.
- PR-5: a late completion logged while its payment is still PENDING (not yet swept) has no decision buttons.
- CI's deployment smoke image build depends on apt.postgresql.org, which failed on three heads today.

## Next step (exact)

The owner's next brief. Phase 6B (from the 6A handoff) is still pending.

## Decisions taken

- PR-4: password-type allowlist = app.tsx, pages/account.tsx, pages/hosted-activate.tsx. One Save where a dialog had
  several separately-saved secrets (gateway key drawer); existing endpoints called in turn. SecretInput blocks copy/cut
  while masked.
- PR-1: `{تست}` is literal (the engine substitutes only ASCII `{name}`). A stored `bot.main_menu` row keeps the old
  packing. A stale search tap is refused only when both flags are off. `tickets` stays after support.
- PR-2: its own message table, not tickets (a ticket has category/priority/assignee/AI hold, and a customer reply
  reopens it). Approve reuses `ResellerAdminService.registerWithin` inside the approval's transaction. An applicant who
  became a reseller another way is refused, and the request stays PENDING. No new permission (resellers.view/edit).
- PR-3: cause = TRAFFIC when usage ≥ a finite limit at expiry, otherwise TIME; stored at the transition. A service with
  no clock is stamped when the worker first sees it, never back-dated. A transferred service keeps `state_since`; its
  scheduled run is cancelled and the new owner gets a full warning. Renumber not byte-identical (the shared kind CHECK).
- PR-5: keys kept; value boolean→WALLET|REVIEW|DELIVER (true→WALLET, false→REVIEW). Terminal order → a fulfilment order
  tied to the payment. Exactly once via the unique `<paymentId>:late-credit` ledger key under the payment lock. Operator
  choices need `payments.reconcile`. Stars and card-to-card unchanged.
