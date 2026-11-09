# Phase 6B — tenant backup, restore, move, export and the creator's door

Round of 2026-11. Ten PRs against `Mhoseinshah1/nexa-bot`, issue #358, all merged under the round prompt's
approval (push → Codex → one fix commit → green CI on the exact head → merge commit). The design and every
"As built" decision are in [ADR-0039](../adr/0039-tenant-backup-and-server-move.md); the owner's per-PR check
lists are the #358 comments titled «فاز 6B — PR-N». `origin/main` at the end of the round: `d77d8b6b`.

| PR      | Branch                                  | Number | Merge commit |
| ------- | --------------------------------------- | ------ | ------------ |
| PR-0    | `docs/adr-0039-tenant-backup-move`      | #445   | c959a054     |
| PR-6    | `fix/6b-hosting-followups`              | #446   | 69a6845c     |
| PR-1    | `feat/6b-tenant-archive`                | #447   | f250c321     |
| F1      | `fix/6b-installation-only-backup-perms` | #448   | c44cdadf     |
| PR-3    | `feat/6b-data-export`                   | #449   | 97b4d923     |
| PR-1 rv | `fix/6b-tenant-archive-review`          | #450   | 57ce6a33     |
| PR-2    | `feat/6b-hosted-backups`                | #451   | 0be952b1     |
| PR-5    | `feat/6b-enter`                         | #452   | c6d5d98b     |
| replace | `feat/6b-tenant-replace`                | #454   | e4b426fb     |
| PR-4    | `feat/6b-server-move`                   | #453   | d77d8b6b     |

## PR-0 (#445) — ADR-0039

- Design of the tenant archive, restore, delivery, server move, open export and erasure (§ 10, design only).
- Codex 2×P2: the move import compares the canonical DECRYPTED digest, not the ciphertext SHA; the rewrite
  allowance's role check sits in the SECURITY INVOKER guard.
- Not done in the design: § 6 the owner's installation backup still contains hosted rows (against ADR-0025's
  exclusion rule and ADR-0028's cutover); hosted archives never go to the owner's topic.

## PR-6 (#446) — 2FA reset and a flaky test

- `botctl admin reset-hosting-2fa --username --reason`: removes the factor, recovery codes and section
  sessions; audits `hosting.totp_reset` in the owner's log.
- The flaky hosting-panel test froze the clock mid-step; it is now a step-boundary test.
- Codex P2: `withFreshProof`'s action transaction re-locks the factor (a reset between proof and action).

## PR-1 (#447) — the tenant archive engine

- Inventory of 227 tables with a test that fails on a new table; export as `nexa_app`; scratch-database
  verification; head policy; restore as a new HOSTED child; rewrap of keys under the target's key.
- Codex P1 (confirm before heavy-job admission), P2 (plaintext left behind on a failed open).
- Security fixes before merge: host policy never taken from the archive; kind forced HOSTED; sequence bound;
  extraction caps; unpublished outbox restored EXHAUSTED (never relayed).
- Merged with only a lead spot-check; the owner then asked for a focused Opus review (#450).

## F1 (#448) — pre-existing hole

- A hosted or reseller tenant's owner could download the installation archive, set the backup password and
  start a whole-installation restore. Closed by `INSTALLATION_ONLY_PERMISSIONS` and `requireInstallationScope`.
- Codex P2: delegation filtering (`delegableIn`).

## PR-1 review (#450) — five Opus findings on #447

- PII in failure messages → `storedFailureMessage`; plaintext and scratch-DB sweeps for killed runs.
- Restore holds a lease with a heartbeat; restore refuses an RLS bypass.
- The confirmation is bound to a private, SHA-checked copy of the upload. Codex clean.

## PR-3 (#449) — open data export

- ZIP of CSVs (UTF-8 BOM) plus `README.fa.md`; inventory test; heavy queue; 24 h link.
- Codex 2×P2: per-attempt file names; debris sweep. Lead: the host door moved onto the system path with four
  pinned reasons.
- Not done: a second fresh code for the host's download; media-library files; ZIP64 (over 4 GiB the export
  ends `data_export.too_large`).

## PR-2 (#451) — hosted backups

- Schedule 04:30, keep 7; owner password; «بکاپ الان» (a request taken by the worker, never an HTTP-request
  archive); list and download (POST, fresh code); restore from file; delivery to the bot's own group; the
  hosted owner's view.
- Codex 2×P2: the dry-run slug is kept; a confirmed row that fails before the claim. Lead: raw error text →
  `storedFailureMessage`.

## PR-5 (#452) — «ورود به پنل»

- 15-minute single-use token bound to the hosted domain; HOST admin only; banner and exit; no row in the
  hosted audit log (the owner's log has it); denied permissions; the session ends with the section session.
- Codex clean. Lead/auto-review: `data.export` is denied to entered sessions.

## Replace (#454) — owner-added: restore over the same hosted bot

- Includes a DELETED bot; a PRE_REPLACE archive first; one transaction; 12 DELETE guards whose branches are
  bound to `nexa_system` + reason + authority row + the current transaction.
- Codex P1 (the lead's must-fix): an owner or sweep reactivation during a replace could delete new customer
  rows → locked re-check with per-table counts and checksums (`FOR UPDATE`), exact DELETE counts, an
  empty-tables check; panel transitions refused (`hosting.replace_in_progress`,
  `tenant_archive.changed_during_replace`).

## PR-4 (#453) — server move

- `botctl move export|import|verify|abort`; `docs/server-move.md`.
- Codex 2×P1: an export retry completes the freeze; import pauses worker/api/assistant during hosted
  verification. CI: a real failure in its own test (`RECOVERY_WORK_DIR` unset → EACCES on an unprivileged
  runner), fixed.
- Not done: restoring a hosted tenant missing from the installation backup during import (kept in
  `move-unrestored/`, exit 2); `botctl telegram register-hosted`.
