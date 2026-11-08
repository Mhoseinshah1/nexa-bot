# Handoff — NEXA-FIX-RESTORE-SECRETS (finished)

- Session branch `claude/elegant-noether-g9v8x9` (handoffs only; never merged to main).
- Base `origin/main` @ `d917ad148` (Merge pull request #424). Newest migration on main: `0327_secret_reentry_items.sql`.

## PR and CI

- PR: https://github.com/Mhoseinshah1/nexa-bot/pull/424 — MERGED as merge commit `d917ad148`; head `f1bebec1f`; CI green 23/23 on that head.
- Codex: one `@codex review` used. One finding (P2, atomic list merge in the unreadable-secret reporter) fixed in `50a061c32` (contracts) + `f1bebec1f`; reply posted on the thread.
- Issue comment «رفع مشکل رمزها بعد از ریستور»: https://github.com/Mhoseinshah1/nexa-bot/issues/358#issuecomment-6718689473
- Gate holds: none.

## Done

- Self-contained 7z backups (`keys.json`, password-wrapped keys), restore trial decryption, pre-cutover rewrap, same-id candidates, refusal `recovery.candidate_secrets_unreadable` with retest / acknowledge-and-clear, `secret_reentry_items` + Web Admin strip, `botctl secrets verify`, truthful `status`, byte-based `rewrap`, one alert per unreadable kind, `backup.password_unreadable`, unique install key ids, docs (backup.md, cutover 08, ADR-0038 6B note). Detail: PR #424 body.

## Decisions taken (also in the PR body)

- PR on `fix/restore-secret-key-mismatch` (the prompt's name); the session branch carries unmerged handoff commits and reusing it would need a force-push.
- The bundle carries the active KEK (owner §2.0 as written); docs say to rotate the key if an archive AND its password leak.
- Codex fix is two commits (contracts rule wins over "one commit").
- Refund card is never cleared: that restore needs the old Recovery Kit.
- Executor clearing has no separate audit row; the acknowledgment is audited (critical) and the result is on the request row.

## Not done on purpose / open

- Per-tenant backups (Phase 6B, ADR-0038 note).
- No sweeper for an upload kept by a refused restore never retried.
- Removing an imported key that shares a configured id is refused (dependency counts by id).
- Two imported keys under one id are still refused (unique `key_id`).
- A STOPPED bot (cleared token) can be re-activated before its token is re-entered; the alert then fires.
- Older releases cannot open a 7z containing `keys.json`.

## Next step

- Owner: the server steps in the #358 comment (`sudo botctl secrets verify` … restore on a second server), ending with `sudo botctl roles disable provisioner monitor`.
