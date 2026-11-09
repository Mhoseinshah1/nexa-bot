# Small-fix round (SFR) and CI speed

Three PRs, all merged to `main`. Issue #358 carries the Persian comment for each.

## PR-A: recovery, import, hosted bots

PR https://github.com/Mhoseinshah1/nexa-bot/pull/441, merge `d35a4d53`.

- A1 Recovery Kit removed (UI, endpoints, restore fallback). Contract commit `8f83f98` drops 3 permissions;
  migration 0328 deletes their grants. Old kit audit actions stay CRITICAL so old rows still read.
- A1 `--kit` is refused with a Persian reason. A backup that needs a kit is never half-restored.
  A backup of the current release restores with only the file and its password (tested).
- A1 `installation_keys` kept, read-only: an older kit restore may hold secrets sealed under imported keys.
- A2 Recovery container limit is now 20% of host RAM (min 1536 MB, max 3072 MB); a cap, not a reservation.
  Heap is 75% of that, pinned in `deploy/compose.yml` (wins over a `NODE_OPTIONS` in `nexa.env`).
  `botctl status` shows both; update and restart recompute them. A dry run closed for attempts now
  carries a Persian memory reason.
- A2 item 5 (streaming) skipped: the crash is in the importer's full snapshot load after `read_sets`,
  not a local change. The limits are the fix.
- A3 Upload sweep at recovery start-up and every 6 h: a refused, unconfirmed upload is removed after a day,
  orphans idle for a day; a run in progress is never touched.
- A4 `print.css` makes the dry-run report fit the page in RTL; `pnpm web:print-shots` captures it.
- A5 Re-activating a SUSPENDED or DELETED hosted bot needs a token entered after the stop. EXPIRED is not gated.
- Mutation checks: all done and confirmed. Codex: clean.
- CI fix on the branch: the recovery-upload-sweep test used `/var/lib/nexa` and partial confirmation columns.

## PR-B: bot and Web Admin

PR https://github.com/Mhoseinshah1/nexa-bot/pull/443, merge `10a25021`.

- B1 `bot.unknown_command` default no longer names `/help`; the main menu follows with no extra tap. Overrides win.
- B2 RLM (U+200F) added at the renderer, opt-in, customer messenger only. Never in code, pre or URL lines,
  never doubled, never for non-Persian.
- B3 Flag `persistent_bottom_menu`, default OFF (`is_persistent:false`). Phone-gate keyboards stay persistent.
  The flag is its own contract commit.
- B4 Default texts name the current main-menu labels. Overrides untouched.
- B5 Template page first render 3.3 s to 0.07 s; DOM nodes 68510 to 270; editors mounted 1007 to 1.
  List payload not slimmed (search matches body text).
- B6 Icon, short description, compatibility, protocol and panel type removed from form, API and bot filter.
  Columns kept with permissive defaults, no migration; an insert writes the app name into `description`.
  Button labels were already template keys; defaults now «📥 دانلود» and «🔗 لینک جایگزین».
- B7 `backup.daily_time` uses `TimeField24`.
- B8 Ops-group test send is paced (1 s gap, 429 waits `retry_after`, 3 attempts), «در صف» per topic.
- B9 NOT done: the report is not in #358 comments or `docs/project-status.md`; ambiguous, not guessed.
- Codex: 1 P2 (RLM broke table and bullet parsing), fixed in one commit. Mutation checks: all confirmed.
- Open issue: `hosting-panel.test.ts` ("refuses an action with no code...") failed once in CI, passed on
  rerun. Probable timing flake, not root-caused.

## PR-C: CI speed and flakes

PR https://github.com/Mhoseinshah1/nexa-bot/pull/442, merge `eb2892dc`.

- C1 Dockerfile `deps` and `system` stages, buildx warm-up in both deploy jobs, `scripts/image-build.sh`,
  integration timings refreshed (421 files, from shard logs).
- C1 The image cache did NOT shorten the critical path: the update smoke (~13.6 min) is readiness timeouts.
- C1 Wall time before (two runs plus one) 30.6 / 28.1 / 33.4 min; after 28.7 / 24.2 / 26.8 min.
- C1 The #440 question: its PR run was docs-only (heavy=false, 10.5 min); the 33 min run was the push
  to `main`, heavy=true by design.
- C2 apt retries around the pgdg fetch and the `apt-get` calls.
- C3 `capacity-guards` clock frozen, with a minute-boundary test (no mutation possible).
- C4 `curl --retry` in the install and update commands and scripts.

## Owner checklist

1. `sudo botctl update vX.Y.Z` (the owner tags the release himself).
2. Remove the temporary lines, then restart and check the new recovery limit and heap:
   `sudo sed -i '/^NODE_OPTIONS=/d' /etc/nexa/nexa.env` and
   `sudo sed -i '/^NEXA_MEM_RECOVERY=/d' /etc/nexa/deploy.env`, then `sudo botctl restart`,
   then `sudo botctl status`.
3. `sudo rm -f /etc/nexa/deploy.env.bak /etc/nexa/nexa.env.bak`
4. `sudo botctl roles disable provisioner monitor`
5. After the update run `sudo botctl secrets verify`; run `rewrap` if anything reads only through an old imported key.
