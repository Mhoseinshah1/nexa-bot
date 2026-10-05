# Intelligent Support Agent — execution board

Maintained by the Lead/Integrator. One row per package, updated whenever a package's state
changes. Shared files (`schema.ts`, the migration journal, `permissions.ts`,
`packages/contracts/src/index.ts`, `container.ts`, web nav and routes, `deploy/`) are
serialised: only the package marked **owner** may edit them at a time.

**Final state (TB10, 2026-10-05).** Every package is implemented, each on a branch stacked on
the one before it (`tb1-work` → … → `tb10-work`). TB0 is merged. Nothing else is merged: a
merge to `main` is the owner's explicit call after review, with CI green on the reviewed head
(`CLAUDE.md`, `OQ-TB-10`). The PR number is shown where a PR is known, and `PR #—` where the
integrator has not opened one yet.

| Package                            | Depends on    | Branch                                    | Migrations     | Status                                                                                                                           | Falsification                      | Review                                                                        | Merge             | Next action                                     |
| ---------------------------------- | ------------- | ----------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------- | ----------------- | ----------------------------------------------- |
| TB0 audit + ADRs 0033–0035         | —             | `claude/elegant-noether-g9v8x9` (PR #195) | —              | merged                                                                                                                           | —                                  | Codex unavailable (usage limits); 1 substitute review, 11 findings, all fixed | merged `efd7e1d7` | —                                               |
| TB1 connection + transport         | TB0           | `tb1-work` (PR #—)                        | `0196`         | implemented                                                                                                                      | 9 of 9 (`tb1-falsification.md`)    | pending                                                                       | —                 | open or update the PR; review; CI on its head   |
| TB2 conversation + takeover        | TB1           | `tb2-work`, `tb2-web` (PR #197)           | `0197`, `0198` | implemented, substitute review fixed                                                                                             | 9 of 9 + review rows               | substitute review of PR #197, every fix falsified                             | —                 | owner's review                                  |
| TB3 support context                | TB0, TB2      | `tb3-work` (PR #198)                      | —              | implemented, review fixed                                                                                                        | 23 of 23                           | review of PR #198                                                             | —                 | owner's review                                  |
| TB4 provider foundation            | TB0, TB3      | `tb4-work` (PR #199)                      | `0199`, `0200` | implemented, substitute review fixed                                                                                             | 38 of 38                           | substitute review of PR #199                                                  | —                 | owner's review; real-provider acceptance        |
| TB5 assist                         | TB2, TB3, TB4 | `tb5-work`, `tb5-web` (PR #—)             | `0201`, `0202` | implemented                                                                                                                      | 9 of 9                             | pending                                                                       | —                 | open the PR                                     |
| TB6 vision                         | TB5           | `tb6-work` (`tb6-work-r` restack) (PR #—) | `0203`         | implemented                                                                                                                      | 18 of 18                           | pending                                                                       | —                 | open the PR; `getFile` on business media        |
| TB7 auto reply + handoff + tickets | TB5, TB6      | `tb7-work` (`tb7-work-r` restack) (PR #—) | `0205`         | implemented                                                                                                                      | 23 of 23 (on the TB6 restack)      | pending                                                                       | —                 | open the PR; Product Owner on Production use    |
| TB8 controlled learning            | TB7           | `tb8-work` (PR #—)                        | `0206`, `0207` | implemented                                                                                                                      | 27 of 27                           | pending                                                                       | —                 | open the PR                                     |
| TB9 NEXA knowledge build           | TB3, TB8      | `tb9-work` (PR #—)                        | `0208`         | implemented                                                                                                                      | 17 of 17                           | pending                                                                       | —                 | open the PR                                     |
| TB10 polish + analytics + QA       | all           | `tb10-work` (PR #—)                       | `0210`         | implemented: notifications, inbox polish, provider health, analytics, RTL, runbook, acceptance pack (`tb10-polish-analytics.md`) | 33 of 33 (`tb10-falsification.md`) | pending                                                                       | —                 | open the PR; run the acceptance pack on staging |

Migration numbers were allocated serially by the integrator, never assumed. `0204` and `0209`
were left unused when a package needed no grant migration, and are not reused.

## Release defaults (binding across every package)

- Every tenant's support AI is `OFF`. No migration writes `support_ai_configs`, and none
  enables `AUTO_REPLY_SAFE`.
- The automatic-topic allowlist is empty by default, and an empty allowlist sends nothing.
- Entering `AUTO_REPLY_SAFE` needs `support_ai.auto_reply` (CRITICAL, owner only). For a
  Production tenant it also needs the **Product Owner's written approval** after the manual
  acceptance pack (`acceptance-pack.md`) has passed.
- No prompt and no provider response is stored. Customer text is purged after 30 days.

## Open questions, in summary

All are in `docs/open-questions.md` under OQ-TB. None blocks a review. The ones that block
**Production use of automatic replies** are marked ▲.

| Area                   | Questions                         | State                                                                                                                              |
| ---------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Telegram behaviour     | OQ-TB-02, -03, -05, -19, -32, -33 | ▲ to be observed by the acceptance pack: connection identity on reconnect, echo fields on edits, `getFile` on business media.      |
| Takeover race          | OQ-TB-04, -47                     | ▲ the residual window after the send stamp; documented, acceptance pack F3.                                                        |
| Providers              | OQ-TB-08, -20, -21, -22, -30, -31 | ▲ fixtures not yet proven against the real APIs (OQ-TB-20); Z.AI declared blind; no SDKs by decision.                              |
| Cost                   | OQ-TB-07                          | open: tokens reported, no money; no tenant price table in this release.                                                            |
| What "resolved" means  | OQ-TB-09                          | open: replies and handoffs are counted, never resolutions.                                                                         |
| Merge authority        | OQ-TB-10                          | settled by `CLAUDE.md`: the owner merges.                                                                                          |
| Support context        | OQ-TB-11 … -18                    | decisions recorded (wallet left out, review facets, drafts, incidents, FAQ, bounds).                                               |
| Auto reply and tickets | OQ-TB-40 … -46                    | decisions recorded (unlinked customer gets no ticket, `NO_ACTION` hands off, loop window constant).                                |
| Learning               | OQ-TB-50 … -57                    | decisions recorded (FAQ live beside knowledge, no ranking, no digest, thresholds are constants).                                   |
| Knowledge build        | OQ-TB-60 … -65                    | decisions recorded (no price, no RETIRE proposal, source bounds).                                                                  |
| TB10                   | OQ-TB-70 … -76                    | ops-group SUPPORT topic, handoff digest, analytics permission, wait semantics, window by creation, presets only, acceptance unrun. |
