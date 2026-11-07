# Handoff — NEXA owner batch 1 (after Phase 6A), 2026-11-07

Lives on `claude/elegant-noether-g9v8x9` only. Binding prompt: `docs/ob1-handoff/NEXA-OWNER-BATCH-1.md`
(merge permission per PR on green + one Codex fix commit; never push main, never force-push, never tag;
don't stop to ask; order PR-1/PR-4 → PR-2 → PR-3 → PR-5). Worktrees under `/home/user/wt/<pr>`.

## Merged (main)

- PR-4 https://github.com/Mhoseinshah1/nexa-bot/pull/419 — SecretInput, one Save, value formatter — `6de9bd557`.
- PR-1 https://github.com/Mhoseinshah1/nexa-bot/pull/420 — Mirza menu defaults, search switches — `1f1d5545d`.

## Open

- PR-2 `feat/reseller-request` — bot/UI done (migration 0322); money-tier agent implementing approve (§7).
- PR-3 `feat/service-auto-delete` — money-tier agent implementing.

## Next step (exact)

Merge main into PR-2, renumber its migration if needed, then the approve agent;
then PR-3 (money tier), then PR-5 (money tier).

## Decisions taken

- PR-4: password-type allowlist = app.tsx, pages/account.tsx, pages/hosted-activate.tsx. One Save only where a
  dialog had several separately-saved secrets (gateway key drawer); existing endpoints called in turn, no batch
  endpoint. SecretInput blocks copy/cut while masked (automated security note; CSS masking is the owner's design).
- PR-1: `{تست}` is literal because the engine only substitutes ASCII `{name}`. A stored `bot.main_menu` row keeps the
  old packing. Stale search tap refused only when both flags are off. `tickets` stays after support.
- The report and handoff live on the session branch (as in phase 6A), not on main.
