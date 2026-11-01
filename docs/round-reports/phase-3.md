# Phase 3 — README + one-line installer (NEXA-PROMPT-README.md)

Not yet on main. This file lives on `docs/r11-handoff`; the next phase's first PR carries it to
`docs/round-reports/phase-3.md` on main (Phase 1/2 reports went in the same way).

## PR-1 #363 `ci/release-installer-assets` — merge commit 3a1b499 (head a06a072)
- `release.yml`: new `installer` job (after gate → publish → verify). From the gate SHA it builds
  `install.sh` (the tagged file + exactly 3 stamp lines: version, repo, bundle sha256; enforced by
  `scripts/release-installer-assets.sh check-stamp`), `install.sh.sha256` and
  `nexa-deploy-<tag>.tar.gz` (`git archive` of deploy/). It refuses if the tag moved, then attests
  with keyless `actions/attest-build-provenance` v4.2.2 (pinned SHA, checked with ls-remote), then
  uploads to the tag's release. It creates the release only on a definite "not found".
- `deploy/install.sh` standalone mode: root first; it refuses another `--version`; https-only
  download; sha256 checked before extraction; refuses `..`, absolute paths, links and non-regular
  entries; private /tmp dir; cleanup; exit code propagated. Clone mode is unchanged. Missing
  `--domain`/`--acme-email` are asked for on a terminal.
- Tests: `tests/deploy/standalone-installer.test.sh` (25 checks, including the documented
  one-liner run literally); `release-workflow.test.ts` pins the job and its step order; CI runs a
  clean `ubuntu:24.04` container smoke (`install.sh: OK`, bundle sha256 matched, the inner
  installer ran).
- Mutation checks: skipping the hash compare → the tampered-bundle case fails and its marker shows
  the bundle ran; check-stamp disabled → 6 failures; path check disabled → traversal/absolute
  cases fail; the old `-fsSLO` one-liner → the literal one-liner case fails.
- Codex (1): P1, `curl -fsSLO …{,.sha256}` saved only install.sh (`-O` applies to the first URL
  only). The lead's security review found the same. Fixed in ONE commit (05a92fc), which also
  moved the tag check before the attestation, fixed /tmp instead of $TMPDIR, made redirects
  https-only, and fixed shellcheck SC2015. One more CI-only commit (a06a072): a second SC2015 that
  CI's newer shellcheck flagged and the sandbox's 0.11 did not.

## PR-2 #364 `docs/readme-pro` — merge commit e3f67a8 (head d7a2200)
- README.md (English, technical), README.fa.md (Persian for non-technical readers, RTL, Latin
  digits), SECURITY.md (GitHub private vulnerability reporting), `pnpm check:readme` in verify and
  CI. Every `botctl` command in both READMEs must match the `usage()` text, and the one-liner in
  both READMEs must be byte-identical to docs/deployment.md.
- Mutation checks: `rollbak`, `--bogus`, a changed one-liner in the Persian file, a drifted
  docs/deployment.md, and `botctl admin nonexistent` each fail the check.
- Codex (1): P2, command words with digits (`check-2fa`) were cut short, so any `admin …` passed.
  Fixed in ONE commit (d7a2200).

## Decisions taken
- The one-liner is `curl -fsSL --remote-name-all …/install.sh{,.sha256} && sha256sum -c install.sh.sha256 && sudo bash install.sh`.
  The plan's `-fsSLO` form cannot work. This is the plan's intent with the flag corrected.
- "Exactly the tagged install.sh" plus "version embedded at release" → the tagged file plus 3
  stamp lines, with the diff enforced. The stamped bundle hash chains trust from install.sh to the
  bundle.
- Standalone `--help` needs root, because it shows the pinned release's own help.
- Owner scope for PR-2: no screenshots, script, demo seed or chat mocks; a text wordmark; no
  headings-count sync.
- README corrections against the code: passwords use scrypt, not argon2id. No CPU/RAM figure is
  documented, so the table marks those as a recommendation only.
- This session's lead ran on the session's configured model; it could not switch itself to
  Sonnet.

## Recorded, not fixed (low)
- `gh release upload --clobber` on a re-run of the release workflow replaces assets. The bytes
  are reproducible from the same SHA; differing gzip output would fail closed.
- A draft release the owner created may not be found by `gh release view`, which could lead to a
  duplicate create.
- The publish job's step summary still prints the clone-mode install command.

## Usage
| PR | agents | tier | CI cycles |
|---|---|---|---|
| #363 | implementer, security reviewer, fix agent | money/security tier ×3; lead | 3 |
| #364 | implementer | default; lead | 2 |
