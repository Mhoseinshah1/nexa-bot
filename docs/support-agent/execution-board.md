# Intelligent Support Agent — execution board

Maintained by the Lead/Integrator. One row per package, updated whenever a package's state
changes. Shared files (`schema.ts`, the migration journal, `permissions.ts`,
`packages/contracts/src/index.ts`, `container.ts`, web nav and routes, `deploy/`) are
serialised: only the package marked **owner** may edit them at a time.

**Final state (TB10, 2026-10-05).** Every package is implemented. TB0–TB9 are merged to `main`,
one pull request each (#195–#204), each merged by the owner (`CLAUDE.md`, `OQ-TB-10`). Each PR was opened from the integrator's branch
`claude/elegant-noether-g9v8x9`; the package's working branch is named beside it. TB10 is
PR #205, **open**: merging it is the owner's call. The merge commits below are GitHub's
`merge_commit_sha` for each PR.

| Package                            | Depends on    | Working branch        | PR   | Migrations             | Falsification                     | Review                                  | Merge                          | Next action                                   |
| ---------------------------------- | ------------- | --------------------- | ---- | ---------------------- | --------------------------------- | --------------------------------------- | ------------------------------ | --------------------------------------------- |
| TB0 audit + ADRs 0033–0035         | —             | —                     | #195 | —                      | —                                 | 1 substitute review, 11 findings, fixed | merged `efd7e1d7` (2026-10-04) | —                                             |
| TB1 connection + transport         | TB0           | `tb1-work`            | #196 | `0196`                 | 9 of 9 (`tb1-falsification.md`)   | no substitute review recorded           | merged `920db42e` (2026-10-04) | —                                             |
| TB2 conversation + takeover        | TB1           | `tb2-work`, `tb2-web` | #197 | `0197`, `0198`         | 20 of 20 (`tb2-falsification.md`) | substitute review of PR #197, all fixed | merged `244c0fab` (2026-10-04) | —                                             |
| TB3 support context                | TB0, TB2      | `tb3-work`            | #198 | —                      | 23 of 23 (`tb3-falsification.md`) | substitute review of PR #198, all fixed | merged `f0508a92` (2026-10-05) | —                                             |
| TB4 provider foundation            | TB0, TB3      | `tb4-work`            | #199 | `0199`, `0200`         | 38 of 38 (`tb4-falsification.md`) | substitute review of PR #199, all fixed | merged `429134ff` (2026-10-05) | real-provider acceptance (`OQ-TB-20`)         |
| TB5 assist                         | TB2, TB3, TB4 | `tb5-work`, `tb5-web` | #200 | `0201`, `0202`, `0203` | 32 of 32 (`tb5-falsification.md`) | substitute review of PR #200, all fixed | merged `ab07af0a` (2026-10-05) | —                                             |
| TB6 vision                         | TB5           | `tb6-work`            | #201 | `0204`                 | 28 of 28 (`tb6-falsification.md`) | substitute review of PR #201, all fixed | merged `51b03dc3` (2026-10-05) | `getFile` on business media (acceptance pack) |
| TB7 auto reply + handoff + tickets | TB5, TB6      | `tb7-work`            | #202 | `0205`, `0206`         | 48 of 48 (`tb7-falsification.md`) | substitute review of PR #202, all fixed | merged `51bccc1b` (2026-10-05) | Product Owner on Production use               |
| TB8 controlled learning            | TB7           | `tb8-work`            | #203 | `0207`, `0208`         | 59 of 59 (`tb8-falsification.md`) | substitute review of PR #203, all fixed | merged `1de160d5` (2026-10-05) | —                                             |
| TB9 NEXA knowledge build           | TB3, TB8      | `tb9-work`            | #204 | `0209`                 | 47 of 47 (`tb9-falsification.md`) | substitute review of PR #204, all fixed | merged `a32f91f4` (2026-10-05) | —                                             |
| TB10 polish + analytics + QA       | all           | `tb10-work`           | #205 | `0210`                 | `tb10-falsification.md`           | substitute review of PR #205, all fixed | **open**                       | owner's review; run the acceptance pack       |

Full merge commits: #195 `efd7e1d76cd6f444cfeec5b3d2d9a9f41bb3493d`, #196
`920db42e32f149ab49573493f28a02ecba21fb8c`, #197 `244c0fab17846b351bff58fe7cb0b5888d78445a`,
#198 `f0508a9245d8507aaf8e55e1389dc43a9b576a31`, #199 `429134ff129c34b26c8c1655c79b12dc98473352`,
#200 `ab07af0a36d8ffffaa7b10ca1acf33fb27ea8157`, #201 `51b03dc30404cb20278e3d9ecf78929a783f9471`,
#202 `51bccc1be230047567afe5463d882db88e7a3408`, #203 `1de160d5818ba783b6b5df3e066fa362b24852ee`,
#204 `a32f91f423da875d18ada4414733205c571ea65a`.

Migration numbers were allocated serially by the integrator, never assumed. On the restack onto
the reviewed TB5 (PR #200), TB5's `request_hash` took `0203` and TB6 moved to `0204`; on the
restack onto the reviewed TB7 (PR #202), TB7's `reply_stale` took `0206`, so TB8 is `0207`
(generated) and `0208` (grants, hand-written), TB9 `0209` and TB10 `0210`. The numbers are
contiguous, each file's prefix is its journal `idx`, and every later `when` was re-stamped so the
journal advances.

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
