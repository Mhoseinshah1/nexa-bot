# Phase 3D — falsification record

Every production rule this branch added or changed, the mutation that reverts
it, and what the suite did. A rule with no test is a rule that will be silently
reverted; a test that stays green under mutation is not a test.

Each row was run: revert the rule, run the named suite, restore, re-run.

| #    | Rule                                                                       | Mutation                                                 | Named test                                                                                       | Result                                                                                                    |
| ---- | -------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| F-A  | The panel test-connection button is drawn only for `panels.edit`           | Drop `!mayEdit \|\|` from the `actions` guard            | `panels.test.tsx` › does not offer a connection test to an actor who may only view               | **killed**                                                                                                |
| F-B  | A feature flag offers no toggle without `features.edit`                    | `{mayEdit && (` → `{true && (`                           | `control-plane-pages.test.tsx` › draws no toggle at all for an actor who may only view           | **killed**                                                                                                |
| F-C1 | No source sets a `style` attribute                                         | Restore `style={{ width }}` on the distribution bar      | `csp.test.tsx` › has no source that sets a style attribute                                       | **killed**                                                                                                |
| F-C2 | No rendered element carries a `style` attribute                            | (same mutation)                                          | `csp.test.tsx` › renders a dashboard with no style attribute the policy would drop               | **killed**                                                                                                |
| F-D  | An ambiguous 5xx keeps the idempotency key                                 | `error.status < 500` → unconditional `settle()`          | `submission-key.test.tsx` › KEEPS the key when a 5xx leaves the outcome unknown                  | **killed**                                                                                                |
| F-E  | The notification cursor breaks ties on `(createdAt, id)`                   | Drop the `or(...)` for a bare `lt(createdAt, cursor.at)` | `web-admin-v2.test.ts` › walks the whole history with a cursor, seeing every intent exactly once | **killed** — 3 of 7 intents lost                                                                          |
| F-F  | Every declared management code has a production recorder                   | (none needed)                                            | `web-money-and-scope.test.ts` › declares no code that nothing records                            | **caught a real error on its first run** — the map named the wrong file for `settings.stored_value_valid` |
| F-G  | The reserve floor rounds UP                                                | `Math.ceil` → `Math.floor` in the schema                 | `monitor-profile.test.ts` › rounds the reserve floor up                                          | behavioural: driven at the one pair (limit 2, reserve 51 %) where the two rules disagree about acceptance |
| F-H  | ~~"Older" is offered only on a FULL page~~ **SUPERSEDED** — see R-06 below | `rows.length === ALERTS_PAGE_SIZE` → `rows.length > 0`   | `settings-and-alerts.test.tsx` › offers no older page when the page came back short              | killed at the time; **the rule itself was wrong** and is gone                                             |
| F-I  | A planned surface is reachable at the path its nav entry links to          | Typo in `PLANNED_SURFACES[].path`                        | `planned-and-absent.test.tsx` › is reachable at the path its navigation entry links to           | **SURVIVED at first** — see below. After the fix: killed                                                  |
| F-I2 | (same rule, other side)                                                    | Typo in `NAV[].path`                                     | (same test)                                                                                      | **killed**                                                                                                |
| F-J  | The visual harness detects a page that fails to render                     | `blastRadius: 'LOCAL'` → an invalid enum value           | `scripts/visual/capture.mjs`                                                                     | **killed** — `/features` came back `showingError: true`                                                   |

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

Falsified as a tool, not just used as one (F-J). It has now caught fixture
drift from the frozen schemas **three times** on this branch — a feature flag
missing `source` and carrying an invalid `blastRadius`, the new
`schedulerCapacityExceeded` field, and the `nextCursor` the notification
response gained. Every time the symptom was identical: one route rendering its
error state or a skeleton in all three views, with nothing else wrong. The
`stillLoadingAfterSettle` and `showingErrorState` counters are load-bearing,
not decorative. It also had a defect of its
own: it printed its summary and wrote nothing, so a `verification.json` from an
earlier run sat on disk looking current — and its numbers were nearly reported
as a clean pass for a run that had produced none. It now writes the summary
into the output directory, beside the captures it describes.

---

# Round 2 — the thirty-four Codex threads

The first round's table above is kept as written, including F-H, which this
round deleted. That row is the reason this section exists: a rule can be
falsified cleanly and still be the wrong rule. `rows.length === PAGE_SIZE`
dies under `rows.length > 0`, which is what F-H proved — and it is also true
of a page that is full and final, which is the defect Codex found as T06. A
mutation test tells you a rule is load-bearing. It does not tell you the rule
is right.

Every row below was run by `scratchpad/falsify/run.py`, which for each rule
applies the mutation, runs the named suite, requires a FAILURE, restores the
file and verifies the hash matches byte-for-byte, then re-runs and requires a
PASS. A rule whose mutation left the suite green, or failed it for a different
reason than the one named, is not listed as killed — two did on the first
attempt and are recorded under "Two mutations that were wrong" below.

**39 mutations, 39 killed, 0 survivors.** Contract-package mutations rebuild
`@nexa/contracts` before the run: the suites import the package's `dist`
through the workspace link, not its source, so a mutation without a rebuild
tests nothing. That is itself a finding — the first attempt at the T08 mutation
reported a survivor and was a stale build.

| #     | Rule                                                                   | Mutation                                                           | Named test                                                                                              |
| ----- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| R-01  | The dashboard claims a partial fleet only from the server's cursor     | back to `panels.length === DASHBOARD_PANEL_PAGE`                   | `dashboard.tsx` › claims a partial fleet only when the server left a panel out                          |
| R-04  | `/system/monitor` reports the EFFECTIVE probe cooldown                 | `probeCore.probeCooldownMs` → `config.PANEL_PROBE_COOLDOWN_MS`     | `web-admin-v2.test.ts` › reports the cooldown the probes actually obey                                  |
| R-05  | The revert button is gated on the draft basis                          | `revertable !== null` → `template.version !== null`                | `control-plane-pages.test.tsx` › offers no revert while the draft is based on no override               |
| R-06  | The alerts pager reads the server's `nextCursor`                       | back to a page-length comparison                                   | `settings-and-alerts.test.tsx` › offers no older page on a FULL page the server reports as the last one |
| R-06s | The ops-log reader over-fetches one row                                | `limit: size + 1` and `> size` → `limit: size` and `=== size`      | `web-admin-v2.test.ts` › reports no next cursor on a page that is exactly full                          |
| R-07  | A credential row names the credential it removes                       | drop the `aria-label` from the remove button                       | `panels.test.tsx` › names which credential each remove button destroys                                  |
| R-08  | `wallet.topup.minimum` refuses a negative amount                       | drop the refinement, leaving the generic `moneySchema`             | `web-money-and-scope.test.ts` › refuses a negative top-up minimum                                       |
| R-09  | List-editor controls are named by row                                  | `move up — N` → `move up`                                          | `settings-and-alerts.test.tsx` › edits support accounts as an ordered list                              |
| R-10  | The selected class is the class the stylesheet styles                  | `'on'` → `'active'`                                                | `stylesheet-contract.test.tsx` › styles the class Tabs marks the selected tab with                      |
| R-12a | The service refuses a credential outside the provider's shape (create) | delete the `assertCredentialsFitShape` call in `create`            | `panels-http.test.ts` › refuses an API token on a provider that authenticates with a password           |
| R-12b | ...and on the ROTATE path                                              | delete the call inside the lock in `setCredentials`                | `panels-http.test.ts` › refuses the same credential on the ROTATE path                                  |
| R-12c | The detail form offers only fields the shape names                     | `shapeAcceptsCredential(...)` → `true`                             | `panels.test.tsx` › offers no field the provider credential shape does not name                         |
| R-12d | The create form does the same                                          | (same, on the create page)                                         | `panels.test.tsx` › offers only the credential fields the chosen provider accepts                       |
| R-13  | A provider-catalogue failure is reported, not rendered as empty        | `queryState(...)` → `'ready'`                                      | `panels.test.tsx` › reports a provider-catalogue failure instead of an empty picker                     |
| R-14  | `open` is parsed as an explicit true/false                             | back to `query.open === 'true'`                                    | `web-admin-v2.test.ts` › refuses an open filter that is neither true nor false                          |
| R-15  | The conditions scope admits FAILURE codes only                         | add the two recovery codes to `MANAGEMENT_CONDITION_FAILURE_CODES` | `web-admin-v2.test.ts` › never returns a recovery as an open condition                                  |
| R-16  | A one-shot record renders as history, not as unresolved                | `isOneShotManagementCode(row.code)` → `false`                      | `settings-and-alerts.test.tsx` › marks a one-shot record as recorded rather than unresolved             |
| R-17  | The notification reader over-fetches one row                           | back to `limit: size` with `found.length === size`                 | `web-admin-v2.test.ts` › reports no next cursor on a page that is exactly full                          |
| R-18  | A cursor id is validated as an identifier                              | `uuidV7Schema` → `z.string().max(64)`                              | `web-admin-v2.test.ts` › refuses a notification cursor id that is not an identifier                     |
| R-19  | A malformed route parameter is an unmatched route                      | drop the try/catch around `decodeURIComponent`                     | `router.test.tsx` › treats /panels/%E0 as unmatched rather than throwing                                |
| R-20  | Archive and restore are offered                                        | `panel.status !== 'ARCHIVED' &&` → `false &&`                      | `panels.test.tsx` › offers archiving on a live panel                                                    |
| R-21  | The tenant-turn bound rounds DOWN                                      | `Math.floor` → `Math.ceil`                                         | `monitor-cadence.test.ts` › rounds DOWN, because a partial turn is not a turn                           |
| R-21p | The profile reports the tenant-turn ceiling, not a panel ceiling       | swap in `schedulerFreshPanelUpperBound`                            | `web-admin-v2.test.ts` › reports the cadence and the capacity this deployment actually has              |
| R-23  | An untouched panel form submits nothing                                | back to sending `{ name, baseUrl }` unconditionally                | `panels.test.tsx` › sends nothing, and says so, when the operator changed nothing                       |
| R-24  | Keyboard tab activation moves focus                                    | delete the `queueMicrotask(... .focus())`                          | `stylesheet-contract.test.tsx` › focuses the newly selected tab on an arrow key                         |
| R-25  | `.ltr` carries `unicode-bidi: isolate`                                 | delete the property from `styles.css`                              | `stylesheet-contract.test.tsx` › gives the class Ltr emits a real isolate                               |
| R-26  | The admin service records an operational event per change              | rename `recordAdminChange`, so no call site records                | `web-admin-v2.test.ts` › records an operational event for each real administrator change                |
| R-27a | The style scan sees a JSX `style` prop with an identifier              | add `<div style={someStyle} />` to an unrendered component         | `csp.test.tsx` › has no source that sets a style attribute, by any spelling                             |
| R-27b | ...a `style` key in an object                                          | add `const props = { style: { width: 10 } }`                       | (same)                                                                                                  |
| R-27c | ...a DOM style write                                                   | add `node.style.width = '10px'`                                    | (same)                                                                                                  |
| R-27d | ...`setAttribute('style', …)`                                          | add it to the router                                               | (same)                                                                                                  |
| R-28  | The needs-attention card asks the CONDITIONS scope                     | `MANAGEMENT_CONDITIONS` → `MANAGEMENT`                             | `dashboard.test.tsx` › asks only for open management conditions                                         |
| R-29  | A failed intent renders differently from a sent one                    | map `FAILED` to the SENT label                                     | `control-plane-pages.test.tsx` › distinguishes an abandoned intent from a delivered one                 |
| R-30  | The template editor shows the raw stored body                          | `value={draft}` → `value={''}`                                     | `control-plane-pages.test.tsx` › puts the raw stored body in the editor itself                          |
| R-31  | `systemConditionIsOpen` really reads the null-tenant rows              | short-circuit it to `false`                                        | `web-admin-v2.test.ts` › reports an installation capacity condition that is really open                 |
| R-32  | A non-wide flag draws no input at all                                  | drop `&& wide`, so the reason field renders for every flag         | `control-plane-pages.test.tsx` › offers only enable and disable, never a value to type                  |
| R-33  | The capability the panel HOLDS reads as available now                  | `held.has(row)` → `false`                                          | `panels.test.tsx` › says the capability the panel HOLDS is available now                                |
| R-34  | `isCurrent` is not a prefix match                                      | back to a bare `currentPath.startsWith(entryPath)`                 | `planned-and-absent.test.tsx` › does not mark the dashboard current on a nested route                   |

## Two mutations that were wrong, and what they taught

**The contracts package is imported as `dist`.** The first T08 mutation edited
`packages/contracts/src/settings.ts` and reported a SURVIVOR: the negative
amount was still refused. It was refused by the previous build. Vitest has no
alias for `@nexa/contracts`, so every suite resolves it through the workspace
link to `packages/contracts/dist/index.js`; a contract mutation without a
rebuild changes nothing the tests can see. Every contract-level row above now
rebuilds first. (`pnpm typecheck` emits that `dist` as a side effect, which is
why it can look fresh without anyone having run `pnpm build`.)

**A half-reverted rule fails for the wrong reason.** The first T17 mutation
changed `limit: size + 1` back to `limit: size` and left the
`found.length > size` test in place. The suite failed — but on
"walks the whole history with a cursor", because the half-mutation drops one
row per page, not on the full-page case the rule is about. `nextCursor` came
back `null`, which is what the fix wants, for a reason the fix does not have.
The mutation now restores the original expression exactly, and kills the
intended test.

Both are the same lesson from the other side: a mutation that fails is not
evidence until you have read WHY it failed.
