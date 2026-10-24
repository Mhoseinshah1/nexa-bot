# Agent review lessons (moved verbatim from CLAUDE.md, 2026-10-24)

CLAUDE.md keeps the six rules in short form; this is the full text, with the incidents
that produced each one.

## Reviewing with agents

Five rules. The first two were learned the expensive way on the Phase 2 branch;
the last three on the deployment branch, where four review rounds each found
their defect inside the fix written for the round before.

**A reviewer that mutates code works in its own worktree.** Falsifiability
review — reverting a production rule to watch a test fail — is the standard
here, and it means reviewers edit source. A reviewer sharing the implementation
checkout twice clobbered real fixes mid-edit, once by silently deleting
`claimDue`'s attempt-count backstop while its author was three files away.
Reviewers never mutate the primary feature worktree; give each one
`git worktree add`, or make it read-only and have it write experiments up for
somebody else to run.

**Agents that share PostgreSQL are serialised or given separate databases.**
The integration suite truncates tables between tests. Two suites against one
database produced 122 false failures that looked exactly like real ones.

**A fix is reviewed as hard as the bug.** On the deployment branch the
readiness parser was rewritten three times, and the first two rewrites each
INVERTED the behaviour they were written to protect — the second preferred a
dead container over a healthy one, the third preferred a running one-off
reporting `starting` over the healthy container beside it. Three separate fixes
told the operator to run a command that could not work, each introduced by the
commit that removed the previous one. Reviewing a diff for "does it fix the
bug" catches none of this. Ask instead: what does this fix now do that it did
not do before, and in which state is that wrong?

**A rule with no test is a rule that will be silently reverted.** Five
production rules changed in one commit there had no test at all, so the suite
could not distinguish three successive versions of the same function — every
inversion above passed a green suite. Mutation is the only check that finds
this: revert the single rule a test names and watch that test fail. A test that
stays green under mutation is not a test.

**A claim about testing that leaves no test behind is worse than no claim.** A
commit message on that branch cited eleven parser shapes and twelve guard
probes. Both sets had been run and thrown away, so the next reader believed a
coverage that did not exist. Commit the probe or do not cite it.

**Before any commit that follows agent work**, run `git status`, read every
line of `git diff`, and confirm no reviewer mutation is still in the tree —
deletions especially, because an added line is conspicuous and a removed
predicate is not.
