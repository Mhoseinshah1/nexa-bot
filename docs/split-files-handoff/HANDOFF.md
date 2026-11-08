# Handoff — NEXA-CHORE-SPLIT-FILES (finished)

- Session branch `claude/elegant-noether-g9v8x9` (handoffs only; never merged to main).
- Base `origin/main` @ `af9271eaf` (Merge pull request #425). No migration added; newest on main is still `0327_secret_reentry_items.sql`.

## PR and CI

- PR: https://github.com/Mhoseinshah1/nexa-bot/pull/425 — MERGED as merge commit `af9271eaf`; head `a9b7b0cc0`; CI green 23/23 on that head.
- Codex: one `@codex review` used; review of `a9b7b0cc` clean ("Didn't find any major issues"). No fix commit.
- Issue comment «شکستن فایل‌های بزرگ»: https://github.com/Mhoseinshah1/nexa-bot/issues/358#issuecomment-6720628462
- Push CI on main for `af9271eaf`: green 23/23 after ONE re-run of Integration (5/10) (see Unresolved).
- Gate holds: none.

## Done

- `apps/web/src/i18n/web.fa.ts` 12,800 → 64-line index + 21 slices in `web.fa/` (largest 922). Same 10,353 keys/values; no duplicates existed.
- `apps/api/src/infrastructure/persistence/schema.ts` 19,092 → 38-line index + 33 parts in `schema/` (largest 980). Same 232 exports; drizzle snapshot JSON and SQL identical; `db:check` green; no part-file import cycle.
- Path readers updated: `check-i18n-keys.mjs` (reads slices; refuses a key in two slices), `module-map.sh` (+ fixture), `trace.sh`, `select-tests.sh` (+ 2 self-tests), `mutate-customer-search.py`, 4 unit tests, CLAUDE.md, 4 skills, every `schema.ts:N` / `web.fa.ts:N` doc citation.
- One-off proof: `apps/api/node_modules/.bin/tsx scripts/claude/split-equivalence.mts <ref-before-split>` (use `d917ad148`; `origin/main` no longer holds the single files).
- `.claude/settings.json`: `code-review@claude-plugins-official` false.

## Owner decisions (binding)

- 2026-11-08 NEXA-CHORE-SPLIT-FILES: pure move, no behaviour/SQL/text change; merge on green + Codex fixed — done under that permission.

## Decisions taken (also in the PR body)

- PR branch `chore/split-large-files` as the prompt named it.
- The lead model could not be switched in-session; splits done by deterministic scripts, one Sonnet agent for doc citations, one Haiku CI checker.
- WEB_FA key order is now grouped by slice (nothing in apps/web iterates it).
- `/settings` dark screenshot differs by 16 px at the sidebar card edge: nondeterministic, either build produces either image.

## Unresolved

- `tests/integration/capacity-guards.test.ts` "over the new-customer rate" failed once on main's push run (201, expected 429), passed on re-run. Root cause: `NewCustomerGate` (`apps/api/src/modules/platform/capacity/application/new-customer-gate.ts`) windows by the real wall-clock minute, and the test's two `/start` calls can straddle a minute boundary. Pre-existing (Phase 6A), not touched by #425. Proposed fix (not done: this round's merge permission was #425 only): in that test, wait out the minute boundary when fewer than ~10 s remain before the two calls, or give the gate a controllable clock.

## Not done on purpose / open

- Audit rows phase6b #9 ("capacity ABSENT") and wp5 G2 ("no category column") were stale before the split; re-pointed, wording untouched.
- `_prompts/` (git-ignored, local) fails `prettier --check` inside `pnpm verify` locally; CI is unaffected.

## Next step

- Owner: decide whether to fix the capacity-guards timing test (Unresolved) in its own PR.
