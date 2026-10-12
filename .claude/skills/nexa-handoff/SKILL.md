---
name: nexa-handoff
description: Write or read a short, structured NEXA session handoff — branch and commit, PR and CI state, what was done, unresolved problems, the owner's binding decisions, and the next step — so the next Claude session resumes without replaying the conversation. Use when ending or pausing a session, before the context is likely to be compacted, when handing work to another session, or when resuming work someone else started.
---

# Session handoff

Cloud containers are reclaimed; the conversation is not available to the next
session. A handoff is the minimum the next session needs to act correctly,
not a transcript. Target: under ~40 lines.

## Writing one

1. Generate the mechanical facts (read-only, no fetch):

   ```bash
   git fetch origin main
   bash .claude/skills/nexa-handoff/scripts/handoff-facts.sh
   ```

2. Fill the judgement sections yourself, from verified state — look up the PR
   and CI with the GitHub tools rather than recalling them:

   ```markdown
   # Handoff — <task in one line>

   <output of handoff-facts.sh>

   ## PR and CI

   - PR: <full URL> — open/draft/merged; head <sha>; CI on that head: green/red (<failing job>)
   - Review threads open: <n> (<who, what>)

   ## Done

   - <outcome, with commit sha> (one line each; no narration)

   ## Unresolved

   - <problem> — <what is known, where (path:line), what was tried>

   ## Owner decisions (binding)

   - <date> <decision, verbatim or near-verbatim> — <where recorded>

   ## Not done on purpose

   - <thing a reader might assume should have happened, and why it did not>

   ## Next step

   - <the single next action, concrete enough to start without asking>
   ```

3. Put it where the next session will look:
   - **A PR exists** → a `## Handoff` section in the PR body (replace the
     previous one; never append history), or one PR comment if the body is
     the owner's.
   - **No PR** → the final message of the session, and push the branch so the
     facts are reproducible.
   - Never commit a handoff file to `main`, and never put secrets, tokens,
     customer data or server addresses in one.

## Rules for the content

- Facts, not plans you did not carry out; say "not verified" where true.
- Commit SHAs and full PR URLs, not "the last commit" or "#123".
- Owner decisions are copied, not paraphrased into something softer. Durable
  ones belong in `CLAUDE.md` or the relevant `docs/` record — the handoff
  points there rather than restating it.
- Do not repeat what `CLAUDE.md`, a skill or an audit doc already says; link.
- Uncommitted work is either committed and pushed before the handoff, or
  listed explicitly as lost-on-reclaim.

## Reading one

Re-verify before acting: `git fetch`, compare the handoff's SHAs to the remote,
re-read the PR's CI and threads. A handoff is a snapshot; the remote is the
truth. If they disagree, the remote wins and the discrepancy goes in your own
handoff.
