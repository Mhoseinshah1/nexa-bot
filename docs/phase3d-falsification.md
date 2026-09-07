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

**39 mutation runs, 39 killed, 0 survivors** — recorded in
`falsify/results-all.json`. The table below has 38 rows because it is keyed by
RULE and the runner is keyed by MUTATION, and one rule is reverted from two
directions in a single row. The two numbers are given separately rather than
rounded to one, because "39 mutations" beside a 38-row table is the kind of
small unreconciled claim that this document has already been caught making
once. Contract-package mutations rebuild
`@nexa/contracts` before the run: the suites import the package's `dist`
through the workspace link, not its source, so a mutation without a rebuild
tests nothing. That is itself a finding — the first attempt at the T08 mutation
reported a survivor and was a stale build.

| #     | Rule                                                                   | Mutation                                                           | Named test                                                                                              |
| ----- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| R-01  | The dashboard claims a partial fleet only from the server's cursor     | back to `panels.length === DASHBOARD_PANEL_PAGE`                   | `dashboard.test.tsx` › claims a partial fleet only when the server left a panel out                     |
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
| R-19  | A malformed route parameter is an unmatched route                      | drop the try/catch around `decodeURIComponent`                     | `router.test.tsx` › treats /panels/%s as unmatched rather than throwing (it.each, 7 cases)              |
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

---

# Round 3 — reviewing the fixes as hard as the bugs

Round 2 closed 34 findings and was verified green. Two independent reviews of
those 34 fixes then found **23 more**: thirteen from a fresh-context
adversarial pass over the five remediation commits, ten from Codex, four of
them the same defect seen twice.

The number that matters is not 23. It is **two**: two of the findings were
regressions that round 2's own fixes introduced, and a third was a rule that
round 2 certified as falsified and that was nonetheless wrong. That is the
third time on this branch that a fix has needed a fix, and it is the reason
this file exists rather than a summary in a commit message.

## The two regressions

**The over-fetch made the maximum page unreachable.** Round 2 changed both list
endpoints to ask for `size + 1` so `nextCursor` could mean what it says. The
ops-log service ceiling was raised to 201 to leave room; the notification
service ceiling was left at 200 — the wire maximum. So `GET /notifications?limit=200`
asked for 201, got 200, computed `found.length > size` as `200 > 200`, and
answered `nextCursor: null` with rows still behind it. The fix traded a false
cursor for an unreachable page, which is the worse of the two: an empty page
can be navigated away from.

**The restore control orphaned the retirement row.** Round 2 gave the Web Admin
an archive/restore pair and chose to restore to `DISABLED` rather than `ACTIVE`,
so that nothing silently resumes dialling a machine an operator archived. That
choice is right and it broke `RESTORED_CODE`, which was keyed on
`status === 'ACTIVE'`: the transition closed nothing, and the later
`DISABLED -> ACTIVE` step saw a `before` that was no longer archived and did not
close it either. The retirement row was then open for the life of the
installation with no path that could ever close it — and the panel was being
probed while the operations log said it was archived and unmonitored, which is
verbatim the state that code exists to prevent. Reached through the only
control that offers a restore.

Both were invisible to a green suite, and neither was a mistake in the change
that was reviewed. They were mistakes in the seam between that change and the
code around it.

## Three of round 3's own tests could not fail

Caught by the harness before they were committed, which is the whole point of
running it rather than citing it.

| test                              | why it could not fail                                                                                                              | what it is now                                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| the concurrent-rename regression  | it re-rendered with the same query key, so the cache served the old row and the "concurrent" change never arrived                  | driven through a real refetch — a status change invalidates the panel query, which is how the row actually arrives under an open form |
| the CSP dashboard stub            | removing `nextCursor` again left it green: the card rendered its error state and the `[style]` assertion passed over a broken page | asserts no skeleton and no error state before asserting anything about style attributes                                               |
| the credentials stale-value guard | see below — it was testing something that cannot happen                                                                            |

## A finding that was real in shape and not reachable

The review held that `PanelDetailPage`, not being keyed by panel id, could carry
a typed API token from one panel to another whose provider does not accept it.
The guard was added; the test written for it passed with the guard removed.

The reason is that the scenario cannot occur: changing the id changes the query
key, the query goes pending, `StateSwitch` renders a skeleton, and the whole tab
subtree unmounts with its draft state. A probe established this rather than an
argument.

So the guard stays — it costs nothing and it is correct — and **no test claims
to falsify it**. What is committed instead is a test that pins the fact the
guard depends on: if a future change keeps previous data across the id, or drops
the loading branch, that test fails and the guard stops being redundant. A
guard whose justification is a behaviour elsewhere should fail when that
behaviour changes, not when it does not.

## The mutations: 21 runs, 19 distinct, 18 in the table

All killed, each requiring a failure for the named reason, a byte-for-byte
restore, and a pass afterwards. The three numbers differ for reasons worth
stating rather than averaging away:

- **21 runs**, across `results-round3.json` and `results-round3b.json`. Two
  mutations were run twice — `V07-csp-stub` and `U08-draft-basis` — because the
  first run showed their tests could not fail, and the re-run is against the
  repaired test.
- **19 distinct mutations**, once those two re-runs are collapsed.
- **18 rows below**, because `U13-credentials-stale` names a scenario that was
  then proved unreachable; its test was deleted rather than kept green, and what
  replaced it is `U13-unmount-fact`. The finding is written up above rather than
  listed here as a rule that holds.

| #    | rule                                                            | mutation                           | test that dies                                                             |
| ---- | --------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| V01  | the notification service ceiling leaves room for the over-fetch | 201 -> 200                         | _still reports a next cursor at the maximum page size_                     |
| V02  | retirement closes on any exit from ARCHIVED                     | back to `status === 'ACTIVE'`      | _closes the retirement when an archived panel is restored to DISABLED_     |
| V03  | the one-shot list is DERIVED from the admin codes               | re-type four literals, drop one    | _carries every administrator code the recorder can write_                  |
| V04  | an archived panel offers no save                                | drop the status guard              | _offers no save on an archived panel_                                      |
| V04b | an archived panel offers no credential write                    | `mayWrite = mayRotate`             | _offers no credential write on an archived panel_                          |
| V05  | failures and recoveries are disjoint and paired                 | add a recovery to the failure list | _the condition lifecycle_                                                  |
| V06  | "open" narrows to the conditions scope                          | back to a fixed `MANAGEMENT`       | _asks for the conditions scope when narrowed to open items_                |
| V07  | the CSP dashboard test detects a broken card                    | drop `nextCursor` from the stub    | _renders a dashboard with no style attribute_                              |
| V07b | the route sweep detects a broken card                           | drop the panel-detail stub         | `csp.test.tsx` › renders %s with no style attribute the policy would drop  |
| U02  | a recovery renders as recovered                                 | drop the recovery branch           | _marks a recovery as recovered rather than unresolved_                     |
| U04  | half a cursor is a 400                                          | `if (false)`                       | _refuses half an ops-log cursor_                                           |
| U04b | ...and on the contract side                                     | neutralise the refinement          | _refuses half a notification cursor_                                       |
| U05  | the style scan sees computed access                             | add `node['style'].width = …`      | _has no source that sets a style attribute, by any spelling_               |
| U07  | initial credentials need the rotate permission                  | `if (false)`                       | _refuses initial credentials from an actor who may not rotate them_        |
| U07b | ...and the form does not offer them                             | drop `mayRotate` from `accepts`    | _offers no credential field to an actor who may not rotate credentials_    |
| U08  | the edit compares against the draft basis                       | back to the live prop              | _does not revert a concurrent rename when only the other field was edited_ |
| U09  | an unusable stored credential stays visible                     | `shows = accepts`                  | _keeps an unusable stored credential visible and removable_                |
| U13  | the loading state unmounts the credentials draft                | render children while loading      | _unmounts the credentials draft when the panel changes_                    |

Plus V07b, which earned its place immediately: the panel-detail stub in the
route sweep was returning the LIST shape, so that route had been rendering its
error state throughout the sweep and nobody had looked. The assertion added to
catch a hypothetical caught a real one on its first run.

## What this round changes about the method

Round 2's record already said that a mutation test tells you a rule is
load-bearing, not that it is right. Round 3 adds the other half: **a fix is a
change to a seam, and the seam is what needs reviewing.** Every one of the two
regressions above was correct in the file it was written in. One was wrong
about a ceiling in a different module; the other was wrong about a guard three
hundred lines away. Neither would have been found by re-reading the diff.

## Round 4 — two mutations, and one half-fixed rule

Codex's fourth review reported ten findings against `aafebab`, and nine of them
named work that was already in the tree when it read the branch. The tenth did
not: _"Gate all edit and credential controls on the archived state, not just
the test button."_ The fix written for round 3 removed the **Save button** on an
ARCHIVED panel and left the **name and base-URL inputs enabled**.

That is a smaller version of exactly the same untruth. An operator can still
type a new name into a form that has no way to submit it, on a panel
`PanelService.update` answers 412 for. The gate is now one `mayWrite`, and the
two inputs and the button share it.

The test that was supposed to protect this rule asserted only
`queryByRole('button', { name: 'ذخیره' })` — so it passed on a half-fix, which
is how the half-fix shipped. It now asserts the fields as well, and a second
test asserts the opposite direction, because widening a gate is one character
away from disabling the form for everybody.

| #   | rule                                         | mutation                          | test that dies                                            |
| --- | -------------------------------------------- | --------------------------------- | --------------------------------------------------------- |
| W01 | the identity INPUTS follow the archived gate | inputs back to `!mayEdit`         | _offers no save on an archived panel_ (`toBeDisabled`)    |
| W02 | ...and only on an archived panel             | invert to `status === 'ARCHIVED'` | _leaves the identity fields editable on a live panel_ + 3 |

W01 was killed for its named reason (`expect(element).toBeDisabled()` on the
name field, with the Save assertion above it still passing — the half-fix
reproduced exactly). W02 killed five tests, the two above plus the three
existing draft-basis tests, which is the correct blast radius for disabling the
form outright. `apps/web/src/pages/panels.tsx` was restored to
`b24b219e0362cc59cf49cf20266da62f024dc1b8a9eb6a7687e219e2c9b38d93` after each,
and the suite returned to 35 passed.

**The lesson, which is round 3's lesson applied to itself:** an assertion that
names one control does not cover a rule about controls. Four review rounds have
now each found their defect inside the fix written for the round before, and
this one was found inside a fix whose own falsification record says "killed".
A mutation test proves a rule is load-bearing. It cannot prove the rule is
_wide enough_, because the mutation and the assertion are written from the same
understanding.

## A correction to this record

Auditing every test this document names — 54 citations across rounds 2, 3 and 4 —
found **one that no commit contains**. Row U09 claimed the mutation
`shows = accepts` was killed by a test called _keeps an unusable stored credential
visible and removable_.

The first version of this correction said the test was never written. That was
wrong, and the truth is worse. `results-round3.json` records U09 with
`failed_for_intended_reason: true`, and the runner sets that flag only when the
named string appears in the test output — so the test **did** exist and the
mutation **was** genuinely killed by it, in the working tree, at the moment the
harness ran. It then never reached a commit. `git log -S` over the whole history
finds the name in exactly one commit: the one that added it back, afterwards.

So the harness was honest and the repository was not. Reverting `shows` to
`accepts` on the committed tree left the entire web suite green — 187 passed —
which is the state the branch was actually pushed in. The rule was load-bearing
in a checkout nobody else had.

That is the failure `CLAUDE.md` names in one line: **commit the probe or do not
cite it.** A mutation run against an uncommitted test is a claim with no evidence
behind it, and it reads exactly like a claim with evidence.

Two things follow, and both are now in place. The test is committed, and the
mutation was re-run against the committed tree — it fails on the missing
`حذف — توکن API` button, with the source restored to sha256
`b24b219e0362cc59cf49cf20266da62f024dc1b8a9eb6a7687e219e2c9b38d93` and 36
passing afterwards. And `scripts/check-falsification-citations.mjs` now resolves
every test name this document cites against the committed test sources, on the
`pnpm verify` path, so a citation that names nothing fails the gate rather than
waiting for somebody to audit it by hand.

One further citation, R-19, named its test in the interpolated form
(`/panels/%E0`) rather than the `it.each` template (`/panels/%s`), so a literal
search for it failed. The test exists; the citation is now written as it appears
in the source, because a citation nobody can grep for is halfway to a citation
that is not true.

## What the harness could not see

The runner checks the right things about a mutation — that the suite fails, that
it fails for the named reason, that the file is restored byte-for-byte, that the
suite is green again. Every one of those is a statement about the **working
tree**. None of them is a statement about what gets pushed, and the gap between
those two is where U09 lived. A verification harness that never looks at the
commit cannot tell a rule that is tested from a rule that was tested once on a
machine that no longer exists.

# Round 5 — a fresh-context read-only review, and a checker with its own disease

A reviewer with no history on this branch read the whole diff and returned seven
findings. **All seven were confirmed against the code.** The most useful of them
is the one about the check the previous round added.

## The checker had the disease it was written to cure

`scripts/check-falsification-citations.mjs` was added in `fd57d79` so that a
cited test which no commit contains fails the gate. Its first version recognised
two spellings of a citation and **silently skipped everything else** — no count,
no warning. The record's two newest rows are written in a third spelling:

```
| _offers no save on an archived panel_ (`toBeDisabled`)    |
| _leaves the identity fields editable on a live panel_ + 3 |
```

Both failed the anchored italic regex and were dropped. The commit message said
"52 citations, all resolving", which was true of the 52 it looked at and said
nothing about the evidence for the newest production rule on the branch. A
checker that decides for itself what to ignore can be green and wrong, which is
precisely the property it existed to remove.

It no longer guesses. It finds the tables that HAVE a citation column, by their
header, and **a row in one that yields no test name is a failure, not a skip**.
It also resolves a `` `file` › name `` citation in the file it names, rather
than in a concatenation of every test source — a name found in some other file
is not evidence for the row citing it.

Turning the skips into failures immediately found two more record defects that
the first version had passed over in silence: R-01 cited `dashboard.tsx`, the
production file, where the test lives in `dashboard.test.tsx`; and V07b's cell
was prose (`the sweep, on /panels/:id`) naming no test at all. The count is now
**55**, and the three extra citations are the ones nobody was checking.

## The six mutations

| #   | rule                                                        | mutation                               | test that dies                                                                                               |
| --- | ----------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Y1  | no connection test when credentials cannot authenticate     | drop `!probeable(data)`                | `panels.test.tsx` › offers no connection test when the stored credentials cannot authenticate                |
| Y2  | an either/or shape is satisfied by EITHER                   | `\|\|` → `&&` in `shapeIsSatisfiedBy`  | `panels.test.tsx` › offers the connection test when either half of an either/or shape is set                 |
| Y3  | the strong empty state belongs to the unfiltered open view  | `openOnly && severity === ''` → `true` | `settings-and-alerts.test.tsx` › does not deny that anything is open when a severity filter emptied the page |
| Y4  | the banner promises no alert class the scope cannot return  | put the notification clause back       | `settings-and-alerts.test.tsx` › promises no alert class the management scope cannot return                  |
| Y5  | the ceiling note says which ceilings have no alarm          | delete the exception clause            | `settings-and-alerts.test.tsx` › says which ceilings have an alarm behind them and which does not            |
| Y6  | `panel.probe.limited` is excluded from the management scope | add it to the failure list             | `web-money-and-scope.test.ts` › keeps the routine operational stream out                                     |
| Y7  | ...and only on the FIRST page                               | drop `cursor === undefined`            | `settings-and-alerts.test.tsx` › does not deny that anything is open from a page after the first             |

Y3 killed four tests and Y6 three — Y6 taking the failure/recovery pairing and
the every-code-has-a-recorder invariants with it, which is the correct blast
radius for admitting an unpaired code to a lifecycle list. Three checks of the
citation checker itself were run the same way: a row naming no test, a citation
naming the wrong file, and a test that does not exist each fail it, and the
record restored to sha256 `fdd10555…` afterwards.

## What this round says about the method

The previous four rounds each found their defect inside the previous round's
fix. This one found its defect inside the previous round's **verification** —
one level up. The check was correct about everything it examined and wrong about
what it examined, and no amount of reviewing its output would have shown that,
because its output was a number that looked right.

## Y7, which is this round's fix containing this round's defect

Row Y7 was not one of the seven findings. It came from re-reading the round-5
fixes with the branch's own question — _what does this now do that it did not do
before, and in which state is that wrong?_ — and the answer was that the
empty-state condition `openOnly && severity === ''` is true on page three as
well as page one. The pager only offers "older" when the server sent a cursor,
so an empty older page needs a condition to resolve between two requests; but it
is reachable, and the claim it printed was the strong one, from a view that had
just shown several open conditions.

Five rounds, five times a fix contained the next defect. This is the first time
it was caught inside the same round rather than by the next reviewer, which
says the QUESTION is doing the work rather than the reviewer.

The lesson is narrow and worth stating exactly: **a check that skips is a check
that must say what it skipped.** Silence in a verifier is indistinguishable from
success, which is the same sentence this codebase already has about the alerts
page, arrived at from the other end.

# Round 6 — the fifth Codex review's seven findings

All seven were confirmed against production code, and two of them were not what
the review said they were. Recording that first, because in both cases fixing
what was reported would have changed nothing.

**F3 was reported as a raw 23505.** It is not: `DrizzlePanelRepository.setStatus`
already maps `panels_tenant_name_live_key` to a modelled `PANEL_NAME_TAKEN`. The
defect is exactly what the review's title said — the 409 tells the operator to
"rename it before restoring this one", and `update` refuses every edit to an
archived panel, so that remedy does not exist. My first commit message for this
round overstated it; this record is the correction.

**F4 was reported in `NotificationsPage`.** It is not there. The test-send button
renders outside the denied card and is gated on `settings.edit` alone, exactly as
intended. The defect is the NAV entry, which required `opslog.view` — so the page
was correct and unreachable.

## Two tests that could not fail, found by mutating them

Both were written this round, and both would have shipped as evidence.

**The cross-panel draft test.** Its first version navigated `/panels/A` ->
`/panels/B` with B uncached. A first visit is `pending`, which renders a skeleton
and unmounts the subtree — so the draft reset for a reason that has nothing to do
with the fix, and removing the route key left the test green. It now visits
B -> A -> B so both are cached, which is the only state where the defect exists.

**The archived index predicate test.** Its first version read the index
definition out of PostgreSQL and asserted the predicate. Mutating the declared
predicate in the source left it green — because `CREATE INDEX CONCURRENTLY IF
NOT EXISTS` matches on NAME, so the database kept the index it already had. That
is a real gap and not only a test defect: **editing a definition in
`ONLINE_INDEXES` changes nothing on an installation that already has that index**.
The test now compares DECLARED against ACTUAL, which fails on a source edit the
database has not adopted.

## The mutations

| #   | rule                                                         | mutation                              | test that dies                                                                                              |
| --- | ------------------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| N01 | the panel detail subtree is keyed by panel id                | drop `key={panel['id']}`              | `router.test.tsx` › does not carry one panel’s draft onto another                                           |
| N02 | ...including credential drafts and the open tab              | (same mutation)                       | `router.test.tsx` › does not carry a credential draft or the open tab across panels                         |
| N03 | a replacement name travels WITH the status, in one statement | drop the name from the UPDATE set     | `panels-http.test.ts` › restores under a replacement name, and the rename lands with the status             |
| N04 | ...so competing restores contend on the same name            | (same mutation)                       | `panels-http.test.ts` › never lets two competing restores escape as an unmodelled database error            |
| N05 | a name outside a restore is refused, not dropped             | `if (false)` on the guard             | `panels-http.test.ts` › refuses a replacement name on a transition that is not a restore                    |
| N06 | the archived mode selects archived rows                      | predicate back to `<> 'ARCHIVED'`     | `panels-http.test.ts` › drops an archived panel from the working fleet and keeps it in the archive          |
| N07 | the notifications nav accepts either capability              | back to `permission: 'opslog.view'`   | `permissions-and-refresh.test.tsx` › offers the page to an actor who may only send a test                   |
| N08 | a permission list means ANY, not ALL                         | `some` → `every`                      | `permissions-and-refresh.test.tsx` › treats a list of permissions as any, not all                           |
| N09 | the dashboard re-reads its open conditions                   | drop `refetchInterval`                | `permissions-and-refresh.test.tsx` › re-reads the open management conditions while the dashboard stays open |
| N10 | the panel detail re-reads its own row                        | drop `refetchInterval`                | `permissions-and-refresh.test.tsx` › re-reads its own row so a new health result appears                    |
| N11 | create navigates only where the actor may go                 | `if (mayView)` → `if (true)`          | `permissions-and-refresh.test.tsx` › keeps an edit-only creator on the form and names what was created      |
| N12 | the archive index predicate is the live one's mirror         | `=` → `<>` in the declared definition | `online-indexes.test.ts` › has an index in the database matching every declared definition                  |

N03 and N06 each kill three or four tests; N08 kills three. Every mutation was
required to fail for the reason its row names, every source was restored and
hash-verified, and every suite was green again afterwards.

## One mutation that killed nothing, and why that is recorded rather than hidden

Removing the route key does NOT break _stops polling the panel the operator
navigated away from_. React Query drops the previous query's last observer when
the key changes, so the old interval stops whether or not the subtree remounted.
The test is still load-bearing — N10 kills it — but for the polling rule, not for
the key. The comment above it now says so, because a polling interval added
beside a keyed subtree invites exactly the assumption that one protects the
other.

# Round 7 — the fresh-context review of round 6's fixes

Seven findings, all confirmed. Two P2s, and the first is the one that matters:
**round 6 built the server half of the restore fix and left the Web Admin unable
to use it.**

`setPanelStatus` in the API client had no `name`, and the Restore button posted a
bare status. So the contract field, the `leavingArchive` branch and the
single-statement rename were all unreachable from the only surface this release
ships — while the archive browser added in the same round meant an operator could
now FIND the retired panel and be told, in a server message, to rename it. The
dead end was intact; it had merely been better signposted. That is the exact
defect class this branch exists to remove, reintroduced by a fix for it.

The second P2 was a consequence nobody would have predicted from the diff: the
new polling intervals, pointed at a tab whose permissions were revoked after it
loaded, write an `access.permission_denied` row on every tick. `denialEvent`
carries no `dedupeKey`, `operational_events` has no retention, and the session
permission list is fetched once per tab — so one wall display would have written
thousands of rows a day into the very feed the alerts page argues must be kept
clear. Before the polling, each of those queries ran once per page load.

## The mutations

| #   | rule                                           | mutation                                         | test that dies                                                                                     |
| --- | ---------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| P01 | a refused restore offers a replacement name    | drop `setRenameOnRestore`                        | `panels.test.tsx` › offers a replacement name when a restore is refused because the name was taken |
| P02 | ...and the retry actually sends it             | drop the `name` from the command                 | `panels.test.tsx` › offers a replacement name when a restore is refused because the name was taken |
| P03 | a cursor belongs to the list that minted it    | `trail.mode === mode ? … : []` → `trail.cursors` | `permissions-and-refresh.test.tsx` › does not carry a cursor from one list into the other          |
| P04 | the panels nav accepts either capability       | back to `permission: 'panels.view'`              | `permissions-and-refresh.test.tsx` › is offered to an actor who may create but not list            |
| P05 | a restore records the rename in its audit row  | drop `name` from before/after                    | `panels-http.test.ts` › records the rename in the audit row and names the panel as it now is       |
| P06 | the restore event names the panel as it now is | `updated.name` → `before.panel.name`             | `panels-http.test.ts` › records the rename in the audit row and names the panel as it now is       |

P03 kills two tests. Every mutation failed for the reason its row names, every
source was restored and hash-verified, every suite green afterwards.

## A third test of mine that could not fail

_refuses a live cursor against the archive_ (round 6) archived nothing, so
`crossed.panels` was empty and its `for … expect` loop ran **zero assertions**
while claiming the server refuses a crossed cursor. It does not refuse: the
keyset and the status predicate are applied independently, so a crossed cursor
SILENTLY SKIPS every archived row older than it. The test now archives a panel
older than the live cursor and asserts it is missing — the real behaviour, and
the reason the surface has to bind its trail to a mode.

That is three vacuous tests in two rounds, all mine, all found by mutation and
none by reading. The pattern is the same each time: an assertion written from
the same understanding that produced the code.

## Also fixed, from the same review

- `setPanelStatusRequestSchema.name` reuses `panelNameSchema` instead of
  hand-spelling the bounds, so a change to `PANEL_NAME_MIN_LENGTH`/`MAX_LENGTH`
  cannot apply everywhere except a restore.
- The idempotency request hash includes `name` only when it is present, so a key
  minted before this release and replayed after it — what `settleOn` deliberately
  holds a key for across a rolling restart's 5xx — is still recognised as a
  replay rather than answered as a payload mismatch.
- The five new i18n keys were inserted between a comment and the key it
  documents, leaving that comment describing the wrong line. Moved.

# Round 8 — a claim in a commit message that was not true

Round 7's commit `e53463e` says, of the polling defect its own review had just
found, that _"the intervals now stop on a failed query"_. **They did not.** All
four `refetchInterval` values were still plain numbers when that sentence was
written; the fix had been described and not made. Nothing else in the round was
affected — the sentence was the only artefact of it — but a reader taking the
message at its word would have believed a bound existed that did not, which is
the failure mode `docs/conventions.md` calls a claim with no evidence behind it,
committed rather than merely said. The commit cannot be rewritten (no
force-push), so the correction lives here, and the fix is this round.

`apps/web/src/polling.ts` now holds the rule, once, in two forms:
`pollUnlessFailing(ms)` for an interval with no other condition, and
`pollUnlessFailingWhile(ms, unsettled)` for one that has its own. The second
exists because the alerts page's interval already looked bounded — it polls only
while a row is `PENDING` — and is not: React Query RETAINS the last successful
`data` across a failed refetch, so a list holding a pending row when a session is
revoked satisfies its own condition for ever. The error check has to come first
for the condition to mean anything.

Applied at every polling site: three on the dashboard, one on the panel detail,
one on the system page's readiness, and the two on the alerts page.

One thing the first attempt got wrong and typecheck caught: annotating the
callback with React Query's own `Query` — which is generic in four parameters —
is not assignable to `refetchInterval` on a typed `useQuery`, and spelling it
`Query<unknown, …>` there silently collapses the call's own inference. That is
how `readiness.data` became `{}` on the system page. The helpers take a
structural supertype of every `Query` instead, so they accept them all and infer
nothing.

## The mutations

| #   | rule                                     | mutation                                 | test that dies                                                                                       |
| --- | ---------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| U10 | a failed poll stops the interval         | return `ms` unconditionally              | `permissions-and-refresh.test.tsx` › stops re-reading the conditions once the server starts refusing |
| U11 | ...before its own condition is consulted | drop the error check, keep the condition | `permissions-and-refresh.test.tsx` › stops the pending-delivery poll once the server starts refusing |

U10 died with `expected 5 to be 1`, U11 with `expected 11 to be 1` — the count of
requests the server refused after the permission was taken away, which is exactly
the row count the defect would have written into `operational_events`. Each
mutation killed one test and only one; `apps/web/src/polling.ts` was restored
byte-for-byte (sha256 `86726c89…`) and the suite was green again afterwards.

The dashboard test also asserts that `/system/readiness` is STILL being polled
after `/ops-log` has stopped, so a suite-wide timer failure cannot pass itself
off as the rule under test.

## The create confirmation, which no URL can reach

The visual harness is route-driven, and the banner an edit-only creator sees
after a successful create is not a route: everyone holding `panels.view` is
navigated to the new panel's detail page instead. So the previous round's claim
to have verified the create screen covered the empty form and nothing else.

`capture.mjs` now has a second, interactive pass — a session with `panels.view`
removed, a filled form, a real submit answered by a real `201` — and it MEASURES
the two things that state exists for rather than leaving them to the screenshot:
that the actor stayed on `/panels/new`, and that the panel they made is named
back to them. 73 captures across three views, no problems.

| #   | rule                                       | mutation                               | what dies                                                                                                     |
| --- | ------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| V08 | an edit-only creator is not navigated away | give the fixture session `panels.view` | the `panel-created` capture, with `navigated away to /panels/<id>` and `the created panel was not named back` |

That is the check the harness could not previously make: with the permission
restored the pass reported both failures, and with it removed again the run is
clean. `scripts/visual/capture.mjs` was restored from a pre-mutation copy and
re-run green.

Its column is headed _what dies_ rather than _test that dies_ on purpose, and
that is worth saying out loud: `check-falsification-citations.mjs` resolves the
second heading against a real vitest name and would fail this row, because V08's
evidence is a harness run rather than a test. Naming the column differently keeps
the checker's guarantee meaning exactly what it says — every _test that dies_
citation names a test that exists — instead of quietly widening it to cover a
row it cannot verify. The evidence for this row is reproducible by hand: make
the one-line change the mutation column names and re-run the harness.
