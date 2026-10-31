# chore/codex-self-request — the lead requests the Codex review itself

Owner instruction, 2026-10-31. It overrides the old "never request Codex again;
the owner comments `@codex review`" rule, for this round and every later phase.

## What changed

- `nexa-round-pipeline` §3: the pipeline now includes "request Codex". The
  lead (or the CI checker) posts exactly `@codex review` over REST, right after
  opening the PR or pushing a head that needs its one review, and once more
  after 1 h of "running". At most 2 such comments per PR. A clean review is the
  receipt "Didn't find any major issues" for the head, or Codex's 👍 newer than
  the head. Only the first complete review of a head is acted on, and nothing
  is requested after the fix commit.
- `nexa-ci-watch`: the Codex bullet now matches; it explains `receipt=` and
  `thumbsup=`. The `gh pr checks` line wrap is fixed.
- `nexa-pr-workflow` §4 and the `nexa-handoff` template: the two other places
  that still said "never request another" / "owner to comment". Changed so no
  skill contradicts §3 (decision taken: the owner named only §3 and ci-watch).
- `scripts/claude/ci-status.sh --codex`: the only script change, as the owner
  allowed. It now reads
  - the `codex-review-receipt:v1` comment, giving `receipt=<sha8>:clean|findings`
    (and `reviewed`/`findings=none` when there is no state marker);
  - the PR's reactions, giving `thumbsup=head|stale|undated` for Codex's 👍
    compared with the head commit's date.
    Only the exact `chatgpt-codex-connector[bot]` login counts. The reactions API
    reports it as type `User`, and a person cannot take a `[bot]` login.

## Why the parser was needed

On [#352](https://github.com/Mhoseinshah1/nexa-bot/pull/352) the automatic
review did not start ("create an environment"). The review that ran after
`@codex review` left a receipt and a 👍, and `--codex` reported `reviewed=none`
until the summary marker appeared.

## Tests

`bash scripts/claude/ci-status.test.sh`: 41 ok, 0 FAIL. New scenarios:
`codex-receipt` (clean receipt for the head, the bot's 👍 newer than the head,
lookalike receipt and 👍 ignored), `codex-stale` (receipt for an older head,
the bot's 👍 older than the head, a lookalike's newer 👍 ignored),
`codex-receipt-findings`, and "no receipt, no reaction: neither claimed". CI
does not run this self-test; it was run locally.

Mutation checks (each rule broken alone, then restored):

| #   | Rule broken            | Result                          |
| --- | ---------------------- | ------------------------------- |
| M1  | 👍 from any login      | KILLED (codex-stale)            |
| M2  | 👍 never stale         | KILLED (codex-stale)            |
| M3  | receipt from any login | KILLED (codex-receipt)          |
| M4  | every receipt clean    | KILLED (codex-receipt-findings) |

## Usage

| PRs | Agents    | Model per agent | CI cycles  | CLI usage |
| --- | --------- | --------------- | ---------- | --------- |
| 1   | lead only | lead            | see the PR | not shown |
