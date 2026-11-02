# Phase 2 — discount hotfix and R12 fixes (F1, F2, F3)

Each PR merged with a merge commit, with CI green on the exact head and the one Codex review
acted on in at most one fix commit. Full detail (per-item findings, tests, mutation tables, owner
checklists) is in each PR description.

| PR                                                        | Item                                                      | Merge   | Codex (head reviewed) → fix     | Notes                                                                                                                                                     |
| --------------------------------------------------------- | --------------------------------------------------------- | ------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#357](https://github.com/Mhoseinshah1/nexa-bot/pull/357) | Hotfix: discount button — one isolated price, no strike   | 767576f | clean                           | New key `bot.pricing.personal_discount_button_suffix`                                                                                                     |
| [#359](https://github.com/Mhoseinshah1/nexa-bot/pull/359) | F2 security and reliability (items 1–6, 8; 7 accept side) | d29b130 | 1×P1 + 1×P2 (6e2efa8) → 03dfee9 | CI fix b906d4f (shellcheck SC1090; this sandbox had no shellcheck)                                                                                        |
| [#360](https://github.com/Mhoseinshah1/nexa-bot/pull/360) | F1 money edges (items 1–6)                                | 1ef32e2 | 1×P1 + 2×P2 (09cdc44) → 9aaea18 | Codex posted a duplicate second review repeating two findings; ignored per the rule                                                                       |
| [#361](https://github.com/Mhoseinshah1/nexa-bot/pull/361) | F2 item 7: per-bot webhook secret (registration side)     | 4a40484 | clean (e3936e6)                 | Stacked on #359. `wp20-outbox-retry` query-plan assertion failed once (outbox code not touched; main green); one re-run; main merged in, green on faee862 |
| this PR                                                   | F3 UX quick wins (items 1–10; 7 partial)                  | —       | see the PR                      | Opus lead review before push: 1 required + 3 fixes (cadb38c, f705087, a06dd61)                                                                            |

## Decisions taken

1. F2 item 7 was split: the accept side shipped in #359, the registration side in #361 (stacked).
   The registered fingerprint is compared in four places; switching registration alone would have
   reported every bot `WEBHOOK_SECRET_CHANGED`. The master secret stays accepted for every bot for
   this whole release; a later release stops accepting it once `botctl telegram status` shows no
   bot on it.
2. F2 item 4 refuses Docker's own networks (the edge subnet, 172.17.0.0/16), not all of RFC 1918:
   refusing every private address would cut off LAN panels on update. A panel on Docker's bridge
   now needs the owner's allow-list (`security.outbound_private_targets`, owner-only).
3. F2 item 2: `/health/ready` answers 404 from off-host. An external monitor on it must move to
   `/health/live`.
4. F2 item 3 (Codex P1): a role exits only when it is not _alive_ (no progress inside its
   allowance), not when it is merely unready — a slow panel call inside its timeout never kills the
   provisioner or monitor. Recovery never exits.
5. F2 item 6: volumes only; env is not split per role (monitor, provisioner and assistant all
   decrypt with `SECRETS_KEYS`).
6. F1 item 3: a full refund of a NEW_SERVICE / CUSTOM_SERVICE / RENEW order plans a SUSPEND (the
   plan's wording). For RENEW this suspends the whole service, including time bought before the
   renewal; the Web Admin warns before confirming (OQ-R12-F1-01).
7. F1: money returned for a cancelled attempt, or for an order already paid another way, is
   credited to the wallet whatever the late-credit switch says, on every inquiry route, never
   Stars; a cancelled attempt is polled until its own deadline and no longer.
8. F1 (Codex P2): a full refund that races a service transfer takes the service row with SKIP
   LOCKED; a row held elsewhere is not suspended and is audited `SERVICE_BUSY`.
9. F3: `bot.start.welcome` restored exactly (no brand/trial rewrite; OQ-R12-F3-01 open). The
   rate-limited cancel keeps an accurate sentence, and «press ❌ again» shows only while the button
   exists (new key `bot.payment.gateway_cancel_rate_limited_closed`). The owner's preferred wording
   (“retried automatically”) is not true on main for a provider-rate-limited cancel; the owner was
   asked on issue #358 (OQ-R12-F3-02).
10. Merging a base into a PR that already had its one clean Codex review (#361) did not re-request
    Codex: the PR's own code was unchanged.

## Process notes

- The container restarted mid-phase; all uncommitted work survived on disk and the agents resumed.
  Owner rule since then: WIP snapshots go to `wip/<branch>` (fast-forward only). This session's
  proxy refuses branch deletion (HTTP 403), so the owner deletes the `wip/fix/r12-*` branches.
- For #360 and #361 the lead passed a hand-written full SHA to the merge tool that was not the
  head; the tool did not refuse it. Both merged heads were verified afterwards to be the CI-green
  heads (9aaea18, faee862). From now on the SHA comes from `git rev-parse`.
- Four agents were briefly active at once (two implementers plus two one-commit Codex fixers),
  over the 3-implementer cap; afterwards the owner set the cap to 2.

## Follow-ups (not done)

- F3 item 7: «پرداخت مابه‌التفاوت» (pay the difference) would be a new money path — not built.
- F1: the CentralPay bound-reference check in the credit path and the suppression of the «pay
  more» message for a cancelled card-transfer attempt have no test (both move no money).
- OQ-R12-F3-02 (owner): make a provider-rate-limited customer cancel retry inside the window, then
  switch to the owner's wording.

## Usage

| PRs | Agents                                           | Model per agent                                                         | CI cycles                                 | CLI usage (agent tokens)                                                           |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| 5   | 6 (hotfix, F1, F2, F2.7, F3, F3 reviewer) + lead | hotfix, F1, F2, F2.7, reviewer: money/security; F3: default; lead: lead | #357 1, #359 3, #360 2, #361 3, F3 see PR | F1 ≈ 714k, F2 ≈ 617k, F3 ≈ 438k, F2.7 ≈ 313k, reviewer ≈ 167k; hotfix not recorded |
