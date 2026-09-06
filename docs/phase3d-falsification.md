# Phase 3D — falsification record

Every production rule this branch added or changed, the mutation that reverts
it, and what the suite did. A rule with no test is a rule that will be silently
reverted; a test that stays green under mutation is not a test.

Each row was run: revert the rule, run the named suite, restore, re-run.

| #    | Rule                                                              | Mutation                                                 | Named test                                                                                       | Result                                                                                                    |
| ---- | ----------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| F-A  | The panel test-connection button is drawn only for `panels.edit`  | Drop `!mayEdit \|\|` from the `actions` guard            | `panels.test.tsx` › does not offer a connection test to an actor who may only view               | **killed**                                                                                                |
| F-B  | A feature flag offers no toggle without `features.edit`           | `{mayEdit && (` → `{true && (`                           | `control-plane-pages.test.tsx` › draws no toggle at all for an actor who may only view           | **killed**                                                                                                |
| F-C1 | No source sets a `style` attribute                                | Restore `style={{ width }}` on the distribution bar      | `csp.test.tsx` › has no source that sets a style attribute                                       | **killed**                                                                                                |
| F-C2 | No rendered element carries a `style` attribute                   | (same mutation)                                          | `csp.test.tsx` › renders a dashboard with no style attribute the policy would drop               | **killed**                                                                                                |
| F-D  | An ambiguous 5xx keeps the idempotency key                        | `error.status < 500` → unconditional `settle()`          | `submission-key.test.tsx` › KEEPS the key when a 5xx leaves the outcome unknown                  | **killed**                                                                                                |
| F-E  | The notification cursor breaks ties on `(createdAt, id)`          | Drop the `or(...)` for a bare `lt(createdAt, cursor.at)` | `web-admin-v2.test.ts` › walks the whole history with a cursor, seeing every intent exactly once | **killed** — 3 of 7 intents lost                                                                          |
| F-F  | Every declared management code has a production recorder          | (none needed)                                            | `web-money-and-scope.test.ts` › declares no code that nothing records                            | **caught a real error on its first run** — the map named the wrong file for `settings.stored_value_valid` |
| F-G  | The reserve floor rounds UP                                       | `Math.ceil` → `Math.floor` in the schema                 | `monitor-profile.test.ts` › rounds the reserve floor up                                          | behavioural: driven at the one pair (limit 2, reserve 51 %) where the two rules disagree about acceptance |
| F-H  | "Older" is offered only on a FULL page                            | `rows.length === ALERTS_PAGE_SIZE` → `rows.length > 0`   | `settings-and-alerts.test.tsx` › offers no older page when the page came back short              | **killed**                                                                                                |
| F-I  | A planned surface is reachable at the path its nav entry links to | Typo in `PLANNED_SURFACES[].path`                        | `planned-and-absent.test.tsx` › is reachable at the path its navigation entry links to           | **SURVIVED at first** — see below. After the fix: killed                                                  |
| F-I2 | (same rule, other side)                                           | Typo in `NAV[].path`                                     | (same test)                                                                                      | **killed**                                                                                                |
| F-J  | The visual harness detects a page that fails to render            | `blastRadius: 'LOCAL'` → an invalid enum value           | `scripts/visual/capture.mjs`                                                                     | **killed** — `/features` came back `showingError: true`                                                   |

## Three tests that could not fail when first written

Recorded because it changes what they are worth, and because the cause is the
same each time: **the test's input and its subject came from one place.**

**F-I — the planned-route test.** It read `path` from `PLANNED_SURFACES` and
then checked that `resolve` served that path. A typo moved both together, so
the assertion stayed true of a route no link points at. `NAV` hardcodes
`/users` and `resolve` looks the route up from `PLANNED_SURFACES`; those are
the two independent declarations, and the test now drives the NAV path — what
an operator clicks — and dies under a typo on either side.

**F-E — the notification cursor.** Two versions passed with the tie-break
reverted. `Clock.now()` is read per call, so intents queued normally get
distinct timestamps and a timestamp-only predicate walks them perfectly. The
committed version writes rows sharing one `created_at`, which is the only
state in which the two implementations differ.

**F-C — the CSP test.** Its first version waited on the dashboard card's
header, which renders while the query is still in flight. It photographed a
loading skeleton, found no `style` attribute in it, and passed for the wrong
reason. It now waits on the rendered data.

## The visual harness

Falsified as a tool, not just used as one (F-J). It also had a defect of its
own: it printed its summary and wrote nothing, so a `verification.json` from an
earlier run sat on disk looking current — and its numbers were nearly reported
as a clean pass for a run that had produced none. It now writes the summary
into the output directory, beside the captures it describes.
