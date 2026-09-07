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

# Round 9 — the fix for round 8 was worse than the defect

A fresh-context reviewer read round 8 and found seven defects, one of them an
inversion of exactly the kind this document keeps recording.

## The inversion

`pollUnlessFailing` stopped an interval on ANY error, and the docblock
rationalised it: _"the user has a Retry control and a reload, both of which
reset the query and start the interval again."_ That sentence is true only where
a user is present — and the scenario the intervals were added for is the one
where nobody is.

What it did to a dashboard left open on a wall: one 502 from the edge during a
rolling restart exhausts `retry: 1` and sets `state.error`. The interval returns
`false` and the timer is cleared. `refetchOnWindowFocus` is off globally, so
looking at the tab does not restart it; there was no offline/online transition,
so `refetchOnReconnect` never fires; and React Query clears `error` only on a
SUCCESSFUL fetch — `fetchState` clears it while STARTING one only when
`data === undefined`, which is never true of a screen that has been serving
figures. The single thing that would clear the error is the fetch the stopped
timer no longer makes. The screen froze into an error box until somebody walked
up to it, where before the fix it healed itself on the next tick.

The hazard that motivated the rule is a **403** from a revoked session, because
that is what writes the unbounded `access.permission_denied` rows. `ApiError`
carries `status` and the codebase already discriminates on it. So the rule is
now `pollUnlessRefused` — stop on 401 or 403, which no amount of waiting
resolves; keep polling through everything else, which waiting is the cure for.
Renamed, because a reader meeting `pollUnlessFailing` would assume the old
meaning.

The gate could not tell the two rules apart: every test asked only "does a
refusal stop it?", and both versions answer yes. The missing test is the
inverse, and it is now U12.

## A fourth test of mine that could not fail

_has an index in the database matching every declared definition_ computed
`declared` and then used it only inside `predicateOf(declared)`, checking the
columns with an order-insensitive `toContain` over three hard-coded names. Its
own docblock said _"this compares DECLARED against ACTUAL"_. Reordering the
keyset to `(created_at, id, tenant_id)` — which destroys the index, since the
leading column would no longer be the one every query filters on — left it
green. The mutation that had been run against it was a predicate typo, the one
dimension it did cover.

It now compares the whole normalised shape: method, column order and predicate.

## The other five

- The notification detail was the only polled query with no way back from a
  failure: a message and no button, a stale attempts card still showing the
  pre-failure list, and re-clicking the same row setting `selected` to the value
  it already held, so React bails out and nothing refetches. It has a retry now.
- The restore-rename field is seeded with the name the server just refused — it
  is the string being edited, not a suggestion — but the button beside it stayed
  enabled, so the operator's most natural next action was a press that could
  only fail. It now refuses the refused value and re-enables the moment the
  field changes. The second refusal also dropped the remedy sentence; it says
  what to do again.
- `/providers` needs a session and no permission, and the shell gated it on
  `panels.view` — hiding it from the `panels.edit`-only actor this release built
  the create form for, whose create form fetches that same catalogue and renders
  it in its picker. Hiding what the server serves is the truthfulness defect
  seen from the other side.
- The interactive visual pass asserted `pageScrolledBy: 0` and
  `stillLoading: false` instead of measuring them, exempting the one capture
  with the most going on from the shell-scroll check the loop calls "measured on
  every route". Both are measured now, and the summary reports `routes` and
  `interactiveStates` separately rather than `PAGES.length + 1`, which read as
  if `captured` should be `routes x views`.
- A docblock on the panel pager still described an index-only walk of
  `(name, id)`; the keyset moved to `(created_at, id)` and 0026 retired that
  index.

## The mutations

| #   | rule                                            | mutation                                                   | test that dies                                                                                          |
| --- | ----------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| U12 | a transient failure does NOT stop the interval  | `refused` → `error !== null`                               | `permissions-and-refresh.test.tsx` › keeps polling through a transient failure, and recovers on its own |
| U13 | a declared index matches the built one in shape | reorder the archived keyset to `(created_at,id,tenant_id)` | `online-indexes.test.ts` › has an index in the database matching every declared definition              |
| U15 | the shell does not hide what the server serves  | gate `/providers` on `panels.view` again                   | `permissions-and-refresh.test.tsx` › is offered to an actor who may create a panel but not list one     |
| U16 | a failed detail can be re-asked                 | drop the retry button from the error banner                | `permissions-and-refresh.test.tsx` › offers a retry that actually re-asks                               |

**U14 has been removed from this table.** It protected round 9's rule that the
restore button is disabled for a name the server already refused, and round 10
reverted that rule — the disabled control was a dead end worse than the pointless
press it prevented. The mutation and its test are both gone, and a row citing a
test no commit contains is exactly the defect `check-falsification-citations.mjs`
exists to catch; it caught this one. The area is covered by U20 below.

U15 kills two tests. U12 died with `expected 1 to be greater than 1`; U13 with
`panels_tenant_archived_page_idx shape: expected 'on panels using btree
tenant_id,creat…' to be 'on panels using btree created_at,id,t…'`. Every
mutation killed only the tests its row names, every source was restored and
sha256-verified, and every suite was green again afterwards.

## What this round says about the method

Round 8 was falsified — U10 and U11 both died as intended — and the rule was
still wrong. Mutation proves a test can distinguish a rule from its absence; it
says nothing about whether the rule is the right one, because the mutation is
chosen by the same person who chose the rule. Both of U10 and U11 asked "does a
refusal stop it?", which is the question the author already believed the answer
to. What caught it was a reader who asked what the fix now does that it did not
do before, and in which state that is wrong — the question `CLAUDE.md` says to
ask, applied by somebody who had not written the answer.

# Round 10 — the same rule, wrong for the third time

A second fresh-context reviewer read round 9 and found seven more. Two of them
are the polling rule again, and one is a fix of mine that reintroduced this
branch's signature defect.

## The partition was still not exhaustive

Round 9 replaced "stop on any error" with "stop on 401 or 403, poll through
everything else, which waiting is exactly the cure for". That last clause is
false. `authedGet` throws in **two** places: `toApiError` for every
`!response.ok`, and `schema.parse` on the SUCCESS path — a `ZodError`, with no
status, which is neither 401 nor 403 and so was polled for ever.

That state is not hypothetical here. `capture.mjs` already carries a note about
it: four routes were once photographed showing a loading skeleton because the
fixtures had drifted from the frozen schemas and `schema.parse` threw. In
production it is a tab holding the previous release across a deploy, hitting it
on every tick, for as long as the tab is open. Round 8 gave that tab one request
and silence; round 9 gave it a request every fifteen seconds for ever. A 404 and
a 400 were polled the same way.

So the rule is now enumerated rather than partitioned by a rule of thumb, over
the three failure classes that actually exist:

- `ApiError` — always carries a status. A 4xx is an ANSWER (401 and 403 need a
  human, 404 and 400 need a different request), except 408 and 429, which are
  the server asking to be asked again. A 5xx is transient.
- `ZodError` — the server answered and this bundle cannot read the answer. Only
  a reload resolves it.
- anything else — a dropped connection, an abort. The network, which waiting
  cures.

Unrecognised failures fall to the last case and keep polling, because a request
the server shrugs off is cheaper than a frozen screen nobody is watching.

## And a backoff that was not one

The same round left the alerts list polling a failing server every three
seconds, indefinitely: its "only while something is PENDING" condition is
satisfied by RETAINED data, so an outage cannot clear it. Twenty minutes of one
is about four hundred POLLS per open tab, and `retry: 1` makes that some eight
hundred requests — the same order as the 403 flood the helper exists to stop,
landing in the load balancer's logs instead of in `operational_events`.

The first fix for that scaled the interval by `fetchFailureCount`. It does not
work: React Query zeroes that field when a fetch STARTS, so it counts the
retries inside one attempt and never the consecutive failures across polls. The
result would have been a flat multiplier wearing a backoff's docblock — and the
test written for it passed, because at 15 s a flat doubling and a real backoff
both land inside "fewer than eight in two minutes". It was caught by working the
arithmetic out rather than by the green suite.

What shipped instead is a single slow lane: while a query is in error, no faster
than thirty seconds. Twenty minutes of outage costs forty polls rather than four
hundred — some eighty requests rather than eight hundred, since `retry: 1`
doubles each — and a recovered server is picked up within half a minute. The test
moved to the alerts list, where the declared cadence is 3 s, so thirty attempts
against a handful is a sharp discrimination rather than a soft one.

## A fix of mine that reintroduced the dead end

Round 9 answered "the restore button re-offers the name the server just refused"
by remembering every refused name and DISABLING the button for it. That is wrong
twice over. A 409 is a property of the database at an instant, not of the string:
the colliding panel can be renamed or archived a minute later, which frees the
name — and the button was dead on a request that had become valid, with no
message, no tooltip, and no way back but a reload. **A dead control with no
explanation is the dead end this entire screen exists to remove**, reintroduced
by a fix for a much smaller version of it.

Reverted. The button stays live, because pressing it again is legitimate, and
the second refusal is answered with the message that says what to do — which was
round 9's other half and is the part that was actually needed.

## The rest

- The `ProvidersPage` `denied` prop could only ever be `false` once its gate was
  removed. Deleted, per the same rule that removed C12 in round 7.
- The index-shape normaliser collapsed `, ` to `,` on the BUILT text only, so a
  declaration written with the natural space after each comma would fail on an
  index that is correct; and stripping every parenthesis made
  `(a AND b) OR c` and `a AND (b OR c)` normalise equal. Now symmetric, and only
  the predicate's outer pair — the one PostgreSQL adds — is unwrapped.
- `interactiveStates` counted captures by looking for a parenthesis in a
  hand-written display string. It is a `kind` field on the finding now.
- The vacuous half of round 9's restore test went with the test itself.

## The mutations

| #   | rule                                             | mutation                                        | test that dies                                                                                                 |
| --- | ------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| U17 | a response this bundle cannot parse is an answer | `finalAnswer` returns false for a parse failure | `permissions-and-refresh.test.tsx` › stops polling a response this bundle cannot parse                         |
| U18 | a failing query drops into the slow lane         | `paced` returns `ms` unconditionally            | `permissions-and-refresh.test.tsx` › drops a failing endpoint into a slow lane instead of its declared cadence |
| U19 | every 4xx but 408 and 429 is an answer           | narrow it back to 401/403                       | `permissions-and-refresh.test.tsx` › stops polling a route the server says is not there                        |
| U20 | the restore button stays live after a refusal    | disable it whenever a rename is offered         | `panels.test.tsx` › offers a replacement name when a restore is refused because the name was taken             |

U20 kills two tests. Sources restored and sha256-verified; every suite green
again afterwards.

## U19 killed nothing the first time, which is the finding

Round 9's rule was 401/403. This round widened it to every 4xx but 408 and 429 —
and the first run of U19, which narrows it straight back, **passed 25 of 25**.
The widening was a rule with no test, which `CLAUDE.md` says is a rule that will
be silently reverted, and it was three review rounds' worth of scar tissue on
this exact function.

Recorded rather than quietly fixed, because the useful part is the shape: the
mutation that kills nothing is the only signal that a rule was changed without
being tested, and it fires precisely when the change felt too obvious to test.
The 404 test now exists and U19 dies with `expected 5 to be 1`.

# Round 11 — the fourth version of one forty-line file

A third fresh-context reviewer read round 10 and found six more. The headline is
the same defect for the fourth consecutive round, arrived at from a new
direction.

## A 401 that means "wait"

Round 10's rule was "a 4xx is an ANSWER, except 408 and 429". That is false for
one 401 this codebase issues deliberately. When a tenant is stopped,
`AuthenticationService.authenticate` throws `auth.tenant_suspended` on every
request and **does not revoke the session** — its own comment says why: _"a
tenant can be started again, and the sessions its operators held are not the
thing that was suspended"_, and _"a DIFFERENT code from an invalid session,
because the two call for opposite responses: sign in again versus wait"_. The
message it sends is _"This installation is paused. Try again once it has been
started."_

So the server explicitly asks to be asked again, and round 10 classified that as
final. A wall display met a maintenance window, every interval stopped, and the
screen stayed frozen after the installation came back — the round-8 defect, for
the third time, reached through the status code instead of the error class.

`client.ts` already had this distinction written down, in a comment about
showing a sign-in form for a paused installation: _"told an operator to
authenticate their way out of something authentication cannot fix"_. Two files
in this repository knew, and the third asserted the opposite about the same
status. The rule now reads the CODE before the status.

That is the fourth version of `polling.ts`. Each was falsified, each passed its
mutations, each was wrong. What the four have in common is that the mutation
was chosen by whoever chose the rule, so it could only ever test the boundary
the author had already thought of; every round the defect lived in the case
that had not been enumerated at all.

## And two more rules with no test

U19 killed nothing last round. This round **U24 killed nothing**: the
`data === undefined` branch of `pollUnlessFinalWhile` — a tab whose FIRST load
fails during a rolling restart, which under the shipped code never polls again —
had no test, and neither did the 408/429 carve-out (removing both exemptions
left all 227 web tests green).

Twice in two rounds, the mutation that kills nothing has been the only signal
that a rule was changed without being tested. It is worth stating as a rule of
its own: **a mutation that kills nothing is a finding, not a failed experiment.**

## The rest

- The slow-lane test's upper bound was eight, which passes anything at or above
  a 13-second lane — twice the request volume the docblock promises. Measured
  and tightened to four, which pins the declared thirty.
- `unwrap` in the index-shape comparison stripped the first and last characters
  whenever both were parentheses, without checking they were a matching PAIR. A
  declaration written `WHERE (a) AND (b)` became `a) and (b` and failed against
  a correct index. It now walks the depth and strips only a genuine wrapper.
- The "about four hundred requests" figures in rounds 9 and 10 counted POLLS.
  `retry: 1` doubles each, so the real numbers are ~800 and ~80. Corrected in
  place, because a number in this record is a claim like any other.
- "That name is taken as well" read oddly for an operator who had resent the
  same name. Reworded.

## The mutations

| #   | rule                                                | mutation                                   | test that dies                                                                                                 |
| --- | --------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| U21 | a paused installation is asked again                | drop the `AUTH_TENANT_SUSPENDED` exemption | `permissions-and-refresh.test.tsx` › keeps asking while the installation is merely paused                      |
| U22 | 408 and 429 are asked again                         | drop both from the 4xx test                | `permissions-and-refresh.test.tsx` › keeps asking after a 408                                                  |
| U23 | the slow lane is thirty seconds, not merely slower  | `FAILING_INTERVAL_MS` → `13_000`           | `permissions-and-refresh.test.tsx` › drops a failing endpoint into a slow lane instead of its declared cadence |
| U24 | a first load that failed transiently retries itself | `data === undefined` → `false`             | `permissions-and-refresh.test.tsx` › retries on its own, and shows the data once the server returns            |

U22 kills two tests. Sources restored and sha256-verified; every suite green
afterwards.

# Round 12 — the frozen screen was one layer above every fix for it

A fourth fresh-context reviewer read round 11 and returned the verdict that
`polling.ts` is finally correct: it enumerated every 4xx code in
`packages/contracts/src/errors.ts` against its throw site, confirmed
`auth.tenant_suspended` is the only self-resolving one reachable on a polled
read, traced React Query's state machine for the `data === undefined` branch,
and reproduced U21-U24 exactly. Four rounds of that file are done.

And the defect is still shipping, because it was never only in that file.

## The eighth polling site

`App` resolves the session with
`useQuery({ queryKey: ['session'], queryFn: fetchSession, retry: false })`. No
`refetchInterval`. `retry: false`, which overrides the global `retry: 1` and
gives the shell FEWER attempts than any page gets. And `fetchSession`
deliberately THROWS on `auth.tenant_suspended` rather than returning `null`, so
a paused installation lands in the `unavailable` branch: a paragraph, and a
Retry button.

Which is exactly the sentence round 9 established is false — _"the user has a
Retry control and a reload. True only where a user is present"_ — reappearing
one layer above every call site the four rounds fixed. Any tab whose PAGE LOAD
falls inside a maintenance window is affected: a kiosk that power-cycles, a tab
the browser discards and restores, a `botctl update` that swaps the bundle and
forces a reload, an operator's morning refresh. The reviewer rendered the real
`App`, stubbed a suspended 401, then made the server healthy and advanced ten
minutes: **one request in total, zero after recovery.**

No test in `tests/web/` rendered `App` at all. Only the pure `sessionView`
mapping was covered — which asserts what each state RENDERS, never that the
shell can leave one. That is the same shape as U19 and U24: the rule nobody
could revert because nothing could tell the difference.

`retryWhileFailing` is the narrow fix: nothing while healthy, nothing when the
answer is final, the 30-second lane while a failure is transient. A signed-out
browser is a SUCCESS here — `fetchSession` returns `null` for an ordinary 401 —
so it arms nothing there either.

## The rest

- `unwrap` still sliced blind when the depth walk never balanced, which is the
  behaviour the round-11 fix existed to remove, narrowed to unbalanced input.
  It now returns the string untouched and lets the comparison fail loudly. Its
  comment claimed only the outer pair was stripped while the code recursed
  through every layer; corrected, and the string-literal limitation it cannot
  see is now written down instead of implied away.
- Round 11 said the "four hundred requests" figures were "corrected in place".
  They were corrected in the RECORD only — the same wrong number survived in
  `polling.ts`'s docblock, which is the primary artefact, and in the test that
  pins the lane. A claim repaired in the account of the work and not in the work
  is the failure mode this document is supposed to catch.

## The mutations

| #   | rule                                     | mutation                                      | test that dies                                                                               |
| --- | ---------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| U25 | the shell recovers without a human       | drop `refetchInterval` from the session query | `shell-recovery.test.tsx` › recovers by itself when the paused installation is started again |
| U26 | ...and costs nothing while it is healthy | poll whenever the answer is not final         | `shell-recovery.test.tsx` › does not poll when the server simply says there is no session    |

## A deletion I nearly shipped

Restoring `polling.ts` after U26, I copied back a scratch file from the PREVIOUS
round. It silently removed `retryWhileFailing` — the entire fix — while
`app.tsx` kept importing it, and `git status` showed one modified file and
looked unremarkable.

**Correction, added in round 13: the sentence that stood here claimed the
deletion "type-checked". It does not.** `pnpm typecheck` runs
`tsc -p apps/web/tsconfig.json`, and the import in `app.tsx` fails it with
`TS2305: Module './polling' has no exported member 'retryWhileFailing'`. The
gate catches this deletion immediately. A false claim about which checks are
blind, used to argue that only sha256 verification would have caught it, is the
failure this document exists to catch — and it is the second time in this branch
that I put an unverified claim into an artefact rather than into a test.

`CLAUDE.md` says to run `git status`, read every line of `git diff`, and confirm
no reviewer mutation is still in the tree, "deletions especially, because an
added line is conspicuous and a removed predicate is not". This was that
failure, self-inflicted by a careless restore rather than by an agent. Every
restore is now sha256-verified against a copy taken in the same round, which is
worth doing on its own account — but the honest version of the lesson is
narrower than the one first written here: the gate would have caught it, and
what actually failed was that I reported the near-miss without checking the
claim I made about it.

# Round 13 — the shell had the defect too, from the inside

A fifth fresh-context reviewer confirmed round 12's shell fix works for the
cases it was written for, and found that it declined the one case that mattered
most — on a premise the contracts contradict.

## "A resolved session does not go stale on a timer"

That is what `retryWhileFailing`'s docblock said, and it is false.
`sessionResponseSchema` carries `expiresAt`, and `auth.session_invalid` exists
precisely because sessions expire and are revoked. So the round-12 rule —
poll only while FAILING, nothing while healthy — left this:

An operator signs in and leaves the tab open. The session expires, or an owner
revokes it. Every endpoint answers 401. Every PAGE correctly stops polling,
which is the rule four rounds of `polling.ts` established. And the shell, which
alone could notice, never asks. After ten simulated minutes the reviewer
measured a complete, fully drawn admin console — the operator's name, the whole
nav, every panel — that could do nothing, said nothing about signing in again,
and had no way back but a manual reload.

That is the worst screen this branch produced, and it was produced by the commit
that added an interval to that very query and reasoned its way out of the
healthy case.

`pollSession` now re-asks every sixty seconds while signed in, drops to the
shared thirty-second lane while failing, and asks nothing at all when signed out
— because `fetchSession` reports an ordinary 401 as a resolved `null`, which is
an answer, not a failure. Re-asking also bounds the hazard the rest of the file
only mitigates: a permission list fetched once per tab is now believed for at
most one cadence rather than until a reload.

One thing the fix got wrong on the first attempt, caught by a test rather than
by reading: reusing `paced(ms, error)` for the failing branch. `paced` returns
`max(ms, lane)`, a FLOOR for a page polling faster than the lane — and the
session's healthy cadence is slower than it, so the max made a failing shell
recover at sixty seconds instead of thirty, doubling how long a paused
installation stays frozen. The failing branch uses the lane directly.

## And the opposite mistake, which the fix would have made worse

`sessionView` returned `unavailable` on `isError` even when `data` held a good
session — a comment on the test said "an error means we do not know". True of
the LOOKUP, false of the session. `refetchOnReconnect` is on by default, so a
laptop waking, a kiosk NIC flap or a Caddy reload fires `online` a moment before
the API is reachable, and the failed refetch replaced the whole signed-in tree
with an error paragraph: every open form unmounted, everything typed into them
lost, for a blip the next poll resolves. Adding a healthy cadence would have
turned that from an occasional event into a scheduled one.

Data now wins over a stale error. A revoked session is not this case — it comes
back as a resolved `null` and lands in `signed-out`.

## A false claim in this document

Round 12's near-miss section said the accidental deletion of `retryWhileFailing`
"type-checked". **It does not.** `pnpm typecheck` fails it with `TS2305` on the
import in `app.tsx`. I asserted a blindness in the gate that does not exist, and
used it to argue for a process rule. Corrected in place, in the round-12 section
where it stands.

That is the second time on this branch that I put an unverified claim into an
artefact instead of into a test — the first being the commit message that
described a polling fix I had not made. Both were caught by somebody else
checking. The rule this actually supports is narrower and worse for me than the
one I wrote: **a claim about what the tooling would or would not have caught is
a claim, and has to be run.**

## Two more, both mine

- `tests/web/shell-recovery.test.tsx`'s recovery assertion was that the
  "unavailable" paragraph left the DOM. It passed just as well when the recovery
  answered "no session" and signed the operator out — the exact conflation
  `fetchSession`, `sessionView` and `auth.tenant_suspended` exist to prevent.
  It now asserts the operator is signed in.
- `setup.ts`'s `matchMedia` stub returned `matches: false` under a comment
  calling it "the light-scheme answer". The query is
  `(prefers-color-scheme: light)`, so `false` is DARK, and a headless browser
  reports light. Nothing depended on it yet, which is exactly when a comment
  like that survives to mislead the first test that does.

## The mutations

| #   | rule                                        | mutation                                 | test that dies                                                                                                 |
| --- | ------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| U27 | the shell re-asks while signed in           | never poll a resolved session            | `shell-recovery.test.tsx` › tells the operator to sign in again instead of leaving a console that does nothing |
| U28 | a resolved session survives a stale error   | `isError` before `data` in `sessionView` | `session-view.test.ts` › keeps a resolved session when a later lookup fails                                    |
| U29 | a failing shell recovers on the shared lane | `paced(ms, …)` in the failing branch     | `shell-recovery.test.tsx` › recovers by itself when the paused installation is started again                   |
| U30 | the healthy cadence is the one declared     | `SESSION_REFRESH_MS` → `300_000`         | `shell-recovery.test.tsx` › tells the operator to sign in again instead of leaving a console that does nothing |

U27, U28, U29 and U30 each kill two tests. Sources restored and sha256-verified;
every suite green afterwards.

# Round 14 — the fix opened the door it had just closed

A sixth reviewer confirmed round 13's diagnosis and its `pollSession` half, and
found that its OTHER half put the same console back on screen through every
failure class but the one it was written for.

## Two rules that disagreed about which failures are worth waiting through

Round 13 changed `sessionView` so a resolved session survives a stale error —
written against a reconnect blip, and right for that. It applied to EVERY error.
And `pollSession`, in the same commit, STOPS on a final answer.

Composed: the shell asks, learns the lookup is permanently broken, throws that
away, keeps the console drawn, and never asks again. A 403 on the session route,
or a `ZodError` from a tab holding a previous release across a deploy — the
class `polling.ts`'s own docblock enumerates — and the operator has a complete,
fully drawn admin console that does nothing, says nothing, has no Retry, and no
way back but a manual reload. **Word for word the defect round 13 was written to
remove**, reached through the door round 13's own fix opened. The reviewer
measured it: one request, then eleven minutes of silence with the console up.

The rule is now: data wins over a RETRYABLE error, and only over one. The two
halves ask the same question — `finalAnswer` — because a fix that stops asking
and a screen that keeps rendering have to agree about what is permanent.

## The same root cause, on the way out

`SignedIn`'s sign-out did `signOut()` then `invalidateQueries(['session'])`.
React Query retains the previous `data` across a failed refetch, so with data
winning, a follow-up lookup that failed left the signed-in console drawn as
though sign-out had not happened — on a shared or kiosk machine, and for good if
the failure was final.

Sign-out is KNOWN, not derived: `client.setQueryData(['session'], null)`. The
invalidate went with it, because re-asking an answered question can only return
something worse — a failed lookup after a successful sign-out rendered "session
unavailable", telling an operator who had just signed out that something was
wrong.

## And the headline scenario was still the one that failed

Round 13's own words: "an operator signs in and leaves the tab open".
`refetchInterval` does not run while a tab is HIDDEN —
`refetchIntervalInBackground` is `false` by default — and
`refetchOnWindowFocus` is off globally. So the interval covered the wall display
and not the case the commit described: ten minutes in another tab produced zero
polls and no re-ask on return, leaving exactly the dead console, corrected up to
a minute later.

`refetchOnWindowFocus: true`, on the session query alone.

## Also

`setup.ts`'s `matchMedia` stub answered `true` to everything, so it claimed
light AND dark at once and claimed a narrow viewport while `window.innerWidth`
said 1024. `app.tsx` is a real second caller with `(max-width: 980px)`. Both
inert by accident. It answers the query now.

## The mutations

| #   | rule                                                | mutation                                     | test that dies                                                                               |
| --- | --------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| U31 | data wins over a retryable error, and only over one | drop the `!finalAnswer` guard                | `session-view.test.ts` › gives up a resolved session once the lookup is permanently broken   |
| U32 | signing out is set, not re-derived                  | `setQueryData` → `invalidateQueries`         | `shell-recovery.test.tsx` › signs out at once, without re-asking a question already answered |
| U33 | a returning tab re-asks at once                     | drop `refetchOnWindowFocus` from the session | `shell-recovery.test.tsx` › re-asks the moment the operator comes back to the tab            |

U31 kills two. Sources restored and sha256-verified; suites green afterwards.

## What seven rounds of one defect actually say

The same frozen screen has now been fixed seven times, in five different places:
the page intervals, the interval's error partition, the interval's cadence, the
shell's missing interval, the shell's healthy cadence, the shell's render rule,
and the sign-out path. Every round was falsified. Every round's mutations
passed. Every round was wrong.

What survived each time was not a case anybody got wrong — it was a case nobody
enumerated, because the mutation is chosen by whoever chose the rule and can
only probe the boundary they already had in mind. Six of the seven were found by
a reader with no stake in the fix asking what it now does that it did not do
before. That is the only technique in this document with a seven-for-seven
record, and it is the one `CLAUDE.md` already names.

# Round 15 — the two pieces round 14 added were the two pieces that were wrong

A seventh reviewer confirmed round 14's `sessionView`/`pollSession` half and
could not break it. Both of the NEW pieces in that commit reopened the same
defect.

## `setQueryData` does not cancel

`Query#setData` dispatches a success and never touches the retryer. So a
`GET /auth/session` already IN FLIGHT when the operator signs out — sent with a
cookie that was still valid — lands afterwards and overwrites the `null` with
the session it fetched. The console came back, for a full refresh cadence, on
the shared machine the fix was written for.

`refetchOnWindowFocus: true`, added by the same commit, is what makes the race
ordinary rather than a one-in-sixty coincidence: returning to a tab and
immediately signing out is a normal sequence. The old `invalidateQueries` did
not have this failure — it refetches with `cancelRefetch` — it had the different
one round 14 describes. Both were wrong. `cancelQueries` first, then set.

## A signed-out browser is not a console

`sessionView`'s data-wins rule was truthiness-gated, so a resolved `null` — the
server's own "nobody is signed in" — was not treated as a resolved answer at
all, and fell through to `unavailable`. Before round 14 that column was
unreachable, because a signed-out tab never fetched again. `refetchOnWindowFocus`
made it routine.

So a browser sitting at the sign-in form, returning to its tab mid-deploy, was
put on the terminal "you may still be signed in" screen — provably false, the
cache held `null` — with no interval and no way back; twenty minutes and zero
requests in the reviewer's probe. The retryable variant of the same path
unmounted the form mid-typing and lost the username already in it, which is
verbatim the harm the data-wins comment claims to prevent.

The asymmetry is the point, and it is now stated in the code: a session is
surrendered on a final answer because a console that cannot be confirmed lies; a
sign-in form never does.

## A rule with no test, and a test that could not fail

Two more from the same review, and they are the two failure shapes this document
keeps recording:

- `pollSession`'s "stop on a final answer" branch — the load-bearing half of
  round 14's central claim that both halves ask `finalAnswer` — had **no test**.
  Deleting it left all 959 tests green. Every test asserted what was DRAWN and
  none how often it was asked.
- `error?: unknown` was optional on `sessionView`, so six call sites silently
  got the previous release's rule. Making it required turned all six into
  compile errors, which is what a parameter that changes behaviour should do.

## And one of mine, found by mutating it

U35 killed nothing on its first run. The in-flight race test I had just written
ended with
`await waitFor(() => expect(queryByText('مدیر اصلی')).toBeNull())` — and the
console is already gone at that point, so the condition holds on entry and the
wait returns before the released response is anywhere near being applied. **It
passed against the very defect it was written to name.** A direct probe showed
the defect reproducing (`CONSOLE BACK AFTER RELEASE: true`) while the test in
the suite stayed green.

That is the fifth vacuous test of mine on this branch and the third mutation
this session that killed nothing. Both counts are worth keeping, because they
are the two things a green suite cannot tell you.

## The mutations

| #   | rule                                                  | mutation                              | test that dies                                                                              |
| --- | ----------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------- |
| U34 | a resolved sign-out survives a later failure          | drop the `data === null` branch       | `session-view.test.ts` › stays signed out when a later lookup fails permanently             |
| U35 | sign-out cancels the lookup already in flight         | drop `cancelQueries`                  | `shell-recovery.test.tsx` › cannot be undone by a session lookup that was already in flight |
| U36 | a final answer stops the asking, not just the drawing | drop `finalAnswer` from `pollSession` | `shell-recovery.test.tsx` › stops showing a console it can no longer confirm                |

U34 kills two. Sources restored and sha256-verified; suites green afterwards.

# Round 16 — a clean verdict, and the four small things under it

An eighth reviewer enumerated all sixty cells of `sessionView × pollSession`,
verified `cancelQueries`'s revert ordering against the real `query-core`
(`onCancel` dispatches the revert SYNCHRONOUSLY, so the subsequent
`setQueryData` wins), ran U34-U36, and ran the web project five times serially
and the shell suite six times concurrently looking for flake. **Verdict: round
15 is correct.** No HIGH or MEDIUM finding.

Four LOW items came with it, and two are the shapes this document exists for.

## A rule expressed where nothing reads it

`sessionView`'s comment claimed that answering `signed-in` in its unreachable
cell "would render exactly the state the line above just refused". It would not:
`App` read `view` only for `loading` and `unavailable`, and rendered the console
from `session.data` directly. So the `signed-in`/`signed-out` half of that
function had **no consumer at all** — the reviewer made it return `signed-out`
in every case and all 239 web tests passed.

Which means the `data === null` rule this branch spent a round arguing about
works only via the `unavailable` branch, and the distinction it draws could be
edited in good faith to no effect. `App` renders from `view` now, and the
comment says only what is true.

## The named harm had no test that could see it

The `data === null` rule is justified — in the code and in round 15's commit —
by "a failing focus refetch unmounted the form mid-typing and lost the username
already in it". That was covered by two PURE-FUNCTION cases, which cannot see an
unmount. `shell-recovery.test.tsx` now types a username, fails a focus refetch,
and asserts both the form and the typed value survive; U38 kills it.

## A zero with nothing anchoring it

`expect(session calls).toBe(0)` after a final answer was satisfied equally by
"the shell stopped asking" and by "this stub was never wired up". The first
control I reached for — some other request proving the stub live — **does not
exist in that state**: the unavailable screen unmounts `SignedIn`, so every page
interval is gone and the stub sees no traffic whatsoever. The control is now a
deliberate trigger: coming back to the tab must reach the stub, which leaves the
zero meaning only what it claims.

Worth recording because the first control FAILED, and its failure is the proof
that the assertion had been unanchored.

## One left alone, deliberately

`{data: null, error: auth.tenant_suspended}` now renders the sign-in form, which
`client.ts` deliberately avoids for that code — "authenticate their way out of
something authentication cannot fix". Reaching it needs a second tab to sign in
while this one sits at the form and the installation to pause in between; the
tab still polls at thirty seconds and recovers on `botctl start`. Documented
rather than fixed, because every fix in this area for eight rounds has cost more
than the case it addressed.

## The mutations

| #   | rule                                               | mutation                                                         | test that dies                                                                               |
| --- | -------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| U37 | the shell renders the verdict, not the raw data    | `sessionView`'s `signed-in` arm → `signed-out`, wiring untouched | `shell-recovery.test.tsx` › recovers by itself when the paused installation is started again |
| U38 | a failing lookup does not unmount the sign-in form | drop the `data === null` branch                                  | `shell-recovery.test.tsx` › keeps the form and the username already typed into it            |

U38 kills three: two `session-view` cases and the new render test.

U37 kills **seven**, and the number that matters is the one before it: the SAME
mutation, run against the previous commit, killed **nothing** — 239 of 239. That
is the finding rather than the footnote, and it is why the mutation has to be
the narrow one. An earlier draft of this row bundled reverting the fix into the
mutation; that kills the same two unit tests on both commits and so demonstrates
nothing about what the round bought. A mutation that contains the fix is a
mutation of the old code.

# Round 18 — a full review of the push candidate, which was not clean

A ninth reviewer took `3edccc3` as a full head rather than a delta and found one
confirmed production defect, one more the same fix uncovered, a false comment,
and five rules held by nothing.

## A screen promising a refusal the contract cannot make

The panel identity form rendered `web.changed_elsewhere`, whose second sentence
is "saving will run into a conflict error". `updatePanelRequestSchema` carries
NO `expectedVersion`. Settings and content send one and are told about a real
conflict; panels cannot be. So an operator who saw another administrator's
rename arrive under their draft, and pressed Save expecting to be stopped,
silently discarded that rename instead — the exact harm `VERSION_CONFLICT`
exists to name, under a message saying it was safe to try.

The comment ten lines above says the true thing — "nothing on the server can
refuse the overwrite" — so the file contradicted the string it rendered. There
is a second key now, `web.changed_elsewhere_overwrite`, which says saving will
overwrite.

**The existing test could not see it.** It matched `/جای دیگری تغییر کرده/`, the
prefix BOTH strings share, stopping one word before the clause that was false.
U43 killed nothing on its first run; the assertion now names the clause.

## And a fix of mine that the suite caught

`status.onSuccess` ignored the row it was handed, so a restore carrying a
replacement name left `basis.name` stale and `changedElsewhere` fired against
the operator's OWN action — a notice about concurrent editing, with no
concurrency in the flow.

The obvious fix, `adopt(result.panel)` as `save` does, is wrong, and
`does not revert a concurrent rename when only the other field was edited`
failed immediately: a status change is not an identity save, and an operator who
had typed a new base URL and then pressed Disable would have had that draft
replaced by the stored value. It folds in the ONE field the command is
responsible for, and only when the command carried it.

That is the first time on this branch that the existing suite caught a defect in
a new fix before a reviewer did. Worth recording as the thing the last ten
rounds were for.

## Five rules held by nothing

Each survived mutation with all 963 tests green:

- **The archive browser never asked for the archive.** Deleting `archived=only`
  from either the API client or the page changed no test. Every assertion about
  the parameter was a `not.toContain` — satisfied by a client that never sends
  it. On this branch's headline feature, the failure is the operator being shown
  the LIVE fleet under the archived heading.
- **The delivery poll's "only while something is PENDING" bound.** Both existing
  tests seed a pending row, so both are satisfied by an interval that never
  consults its condition. Without it every open `/notifications` tab asks every
  three seconds for as long as it is open.
- **A filter change starts from the newest page.** Without `setTrail([])` the
  stale cursor is reused and every matching newer row is silently omitted — page
  three of a list whose page one was never shown, on the surface whose stated
  rule is that silence is the one outcome it may not produce.
- **The attention card counts what it did not draw.** "Six rows with no count
  read as 'there are six'."
- The `key={panel.id}` remount made a comment on the credentials guard false:
  it justified the guard by a cross-route staleness the key had already removed.
  The guard stays — `shape` can change under an open tab — but for the real
  reason.

## The mutations

| #   | rule                                                | mutation                                      | test that dies                                                                                         |
| --- | --------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| U39 | the archive browser asks for the archive            | drop `archived` from the API client           | `permissions-and-refresh.test.tsx` › asks the server for the archive when the archive is what is shown |
| U40 | a settled delivery list costs nothing               | drop the `unsettled` check                    | `permissions-and-refresh.test.tsx` › stops polling a delivery list once nothing is pending             |
| U41 | a filter change starts from the newest page         | drop `setTrail([])`                           | `settings-and-alerts.test.tsx` › starts again from the newest page when the filter changes             |
| U42 | the attention card counts what it did not draw      | `events.length > ATTENTION_SHOWN` → `false`   | `permissions-and-refresh.test.tsx` › says how many conditions the attention card did not draw          |
| U43 | the panel form promises an overwrite, not a refusal | swap in `web.changed_elsewhere`               | `panels.test.tsx` › does not revert a concurrent rename when only the other field was edited           |
| U44 | a restore-rename is the operator's own action       | drop the name fold-in from `status.onSuccess` | `panels.test.tsx` › does not blame a third party for a rename the operator just made                   |

U43 killed nothing on its first run, which is the fourth time this session that
a mutation killing nothing was the only signal a rule was untested. Sources
restored and sha256-verified; suites green afterwards.

## One integration failure this round could not root-cause

`panel-monitor.test.ts › gives two replicas disjoint tenants` failed **once**,
in the twelfth of thirteen full integration runs this session:
`AssertionError: expected 2 to be 4`. It passed on the re-run (837/837), passes
in isolation (105/105), and every other full run this session was green.

Recorded rather than called a flake, because this document's own rule is that
"flake" is not a root cause. What can be said with evidence:

- The code is Phase 3C's monitor claim, untouched by this branch.
- In that same failing run the STRONGER sibling — 600 real races asserting
  `doubled === 0`, written for exactly the double-claim hazard — **passed**. The
  invariant held; the weaker single-shot test is what observed something odd.
- The assertion is `Set(all).size === all.length` over two `claimTenants(now, 1)`
  calls against two tenants, so `all.length` cannot exceed 2 from this test's own
  fixtures. A length of 4 means rows this test did not create were claimable,
  which points at residual state under full-suite load rather than at the claim
  logic.

Not fixed here: it is outside Phase 3D, and widening the branch into Phase 3C's
scheduler to chase a one-in-thirteen observation would cost more than it buys.
It is written down so the next reader has the signature, the frequency and the
one fact that narrows it, rather than a green tick that hides it.

# Round 19 — the fix for the false promise made the opposite false promise

A tenth reviewer found round 18's correction wrong in the other direction, plus
a defect neither of us had looked for.

## "Saving will overwrite their change" — when it would not

`changedElsewhere` is FORM-level: it fires when either field differs from the
basis, regardless of which one the operator has edited. `onSubmit` sends
CHANGED FIELDS ONLY. So the notice promised an overwrite in exactly the case
where saving leaves the other administrator's field untouched — and in the case
where saving sends nothing at all.

The harm is not hypothetical. The operator, not wanting to clobber a colleague,
presses the notice's own «گرفتن مقدار تازه» — which is `adopt(panel)`, and
resets the WHOLE form. They discard their own unsaved base URL to avoid a loss
that could not have happened.

**Round 18's own new test contained the contradiction.** It asserted the notice
says "will overwrite", and twelve lines later asserted that the renamed field is
ABSENT from the write. The test proved the message it had just asserted was
false, and passed.

The notice now asks the narrower question — does the operator's draft touch a
field that also changed remotely — and there are two strings: the overwrite
promise, and `web.changed_elsewhere_untouched`, which says saving sends only the
fields they changed themselves.

## And it fired against the operator's own write

`save` and `status` adopt the row they were handed BEFORE `refresh()` resolves,
so for the width of that round trip `basis` holds the new values and the query
still holds the old ones — which reads as a concurrent change. The suite could
not see it because the stub answers in a microtask; with real latency the
operator got "somebody else changed this" on top of their own "saved" toast.

On the restore-with-rename path that means the notice the round-14 test is named
for — _does not blame a third party for a rename the operator just made_ — was
displayed, blaming a third party for the rename the operator had just made. That
test proved the settled state and not the claim in its own final comment.

`settling` covers it: no accusation while our own write or its refetch is in
flight. The regression test holds the refetch open, which is the window, and
distinguishes the save POST from the detail GET by METHOD — matching on the path
alone made the write wait on its own gate and deadlocked.

## A comment wrong twice about the same guard

Round 18 replaced a false justification for the credentials `accepts` guard with
a second false one: "`shape` is read from a query that can change under an open
tab". It is not — `shape` is a lookup into a frozen module-level catalogue keyed
on `providerType`, which no request in the contract can change. The guard is
unreachable here and kept deliberately, as a mirror of the create form's
identical line where the picker really does change the shape. That is what it
says now.

## The mutations

| #   | rule                                                  | mutation                 | test that dies                                                                               |
| --- | ----------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------- |
| U45 | the overwrite promise is made only when one is coming | `willOverwrite` → `true` | `panels.test.tsx` › does not revert a concurrent rename when only the other field was edited |
| U46 | our own write is never a concurrent change            | `settling` → `false`     | `panels.test.tsx` › does not accuse anybody while the operator own write is still settling   |

Sources restored and sha256-verified; suites green afterwards.

## What three rounds on one notice say

Rounds 18 and 19 are the same sentence, wrong twice: it promised a refusal that
could not happen, and then an overwrite that would not happen. Both versions had
a test, both tests passed, and the round-18 test contained its own refutation
twelve lines down.

The pattern is not carelessness about the code — it is that a message describing
what a BUTTON WILL DO was written from the state that raised it rather than from
the request that would follow. The check that finds it is the one this branch
keeps rediscovering: read the sentence and the code that runs after it as one
claim, and ask whether they agree.

# Round 20 — the suppression that hid the warning it was meant to sharpen

An eleventh reviewer found round 19's `settling` term actively dangerous, and
three more.

## `isFetching` un-drew a warning that was correct

`settling` folded in the detail query's `isFetching`. That is true for the
90-second BACKGROUND POLL as well as for our own write — so a genuine
concurrent change, already detected and already on screen, was un-drawn for the
width of every poll, and indefinitely while one stalled. `client.ts` sets no
timeout and no abort, so that stall has no bound. Save stayed enabled
throughout, and the "load the fresh value" link that is the only way out lives
INSIDE the notice being suppressed.

The reviewer executed it: warning correctly shown, poll stalls, warning
disappears, operator presses Save, the write carries `name` and silently
overwrites the other administrator's rename. That is the data loss this whole
sequence of rounds exists to prevent, caused by the term added to prevent it.

And the term was REDUNDANT. `refresh()` is awaited inside `onSuccess`, so
`isPending` already spans the refetch; dropping `refreshing` costs no coverage
and removes the defect. Its own comment — "the detail query has a request in
flight, so the two rows may disagree" — was false: `basis` only moves when the
operator adopts or writes, so a background GET cannot MAKE the rows disagree,
only reveal a disagreement somebody else caused.

## The overwrite test needed three conditions, not one

`willOverwrite` asked only "did the operator edit a field that also changed
remotely". Two administrators asked to fix the same typo type the same
correction, and the second was warned they were about to overwrite the first —
so they pressed "load the fresh value", which resets the whole form, and lost
their own unsaved base URL to avoid a write that would have stored the identical
string.

All three conditions are load-bearing, and each now has a mutation that kills
only its own test: the field changed remotely, the operator is sending it, and
sending it actually replaces a different value.

## And the notice outlived the form it described

It rendered outside `mayWrite`, so when another administrator archived and
renamed the panel under an open draft, the operator was told "saving will
overwrite their changes" on a screen with no Save button, about a request
`PanelService.update` refuses with a 412.

## The same defect in two siblings

`settings.tsx` and `content.tsx` had round 19's settling bug unfixed, and
`settings.tsx:118` asserted the opposite of what its code did: "Adopt our own
write before the refetch lands, so the row does not report itself as having
changed elsewhere." Adopting is what MAKES it report itself as changed
elsewhere. Both now guard on their own mutations' `isPending`.

## The mutations

| #   | rule                                                     | mutation                     | test that dies                                                                               |
| --- | -------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| U47 | an overwrite needs somebody else to have moved the field | drop `changedRemotely`       | `panels.test.tsx` › does not revert a concurrent rename when only the other field was edited |
| U48 | ...and the operator to be sending it                     | drop `draft !== base`        | `panels.test.tsx` › does not revert a concurrent rename when only the other field was edited |
| U49 | ...and the send to actually replace a different value    | drop `draft !== stored`      | `panels.test.tsx` › does not call an identical correction an overwrite                       |
| U50 | the notice never outlives the form it describes          | render it outside `mayWrite` | `panels.test.tsx` › says nothing about saving a panel that can no longer be saved            |

Round 19's table had ONE mutation for `settling`, and the reviewer showed it
could not distinguish the three disjuncts: dropping `refreshing` alone left
44/44 green, which is how the defect got in. A conjunction or disjunction needs
one mutation per term, and this round's table has them.

# Round 21 — the fix left the defect in, under the other flag

A twelfth reviewer found that round 20 removed `isFetching` from `settling` and
left `status.isPending`, which is the same defect with a different name.

`save.isPending` is safe to suppress on because `save.isPending` also DISABLES
the Save button — no write is reachable inside the window it hides.
`status.isPending` disables nothing: across a Disable, Enable or Archive round
trip the notice was gone while Save stayed live, and a stalled status POST (no
timeout, no abort in `client.ts`) hid a correct warning with no bound. The
reviewer executed it: warning shown, Disable pressed, request never answers,
warning gone, Save pressed, the write carries the stale name and clobbers the
other administrator.

It bought nothing, either. Disable, Enable and Archive adopt NOTHING, so there
is no self-inflicted false positive to hide; and the one path that does adopt —
a restore carrying a replacement name — runs while the panel is still ARCHIVED,
where `mayWrite` is false and the notice is not rendered at all.

> **That last sentence was false when it was written, and round 22 removes the
> rule it was used to justify.** The same commit that wrote it also stopped
> gating the notice on `mayWrite` — so on the restore-with-rename path the
> notice IS rendered, and it was rendered saying somebody else had made the
> rename the operator had just supplied. The claim and its refutation were
> committed together, in two files a hundred lines apart. See round 22.
> `apps/web/src/pages/panels.tsx` carried the identical sentence in a comment
> and it is gone with the rule.

## The round was named after an expression it did not test

Round 20's table had one mutation per term of `willOverwrite` and one for
`mayWrite`, and **none for `settling`** — the expression the round was named
after. Re-adding the removed term left 250 of 250 green. The closing paragraph
of that section states the rule — "a conjunction or disjunction needs one
mutation per term" — and the table beneath it does not follow it for the one
expression the round changed. That is the third time on this branch a lesson has
been written down in the same commit that fails to apply it.

## Gating the notice on `mayWrite` was itself a defect

Round 20 moved the notice inside `mayWrite` because an archived panel has no
Save button. But the inputs are DISABLED, not gone — they are still on screen
holding the operator's draft — and the query keeps refreshing underneath. So
hiding the notice removed both the only signal that the row had moved and the
"load the fresh value" link that re-syncs it, for archived panels and for every
viewer without `panels.edit`. The comment claiming the inputs were "gone"
described the button, not the fields.

The notice renders whenever the row moved now; only the CLAIM depends on
`mayWrite`, and `web.changed_elsewhere_readonly` makes none.

## And the comparison was against un-normalised text

`draft !== stored` decided "this replaces something different" on raw text,
while `panelNameSchema` trims and `validateUrl` stores
`new URL(...).toString()`. Two administrators making the same base-URL
correction in equivalent spellings — `https://p.example:443/v2` and
`https://p.example/v2` — were warned they were overwriting each other, and the
escape from that warning resets the whole form. Compared through the server's
own normalisation now.

## The mutations

| #   | rule                                                   | mutation                  | test that dies                                                                                  |
| --- | ------------------------------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------- |
| U51 | a status command in flight does not hide a real change | re-add `status.isPending` | `panels.test.tsx` › keeps warning about a concurrent change while a status command is in flight |
| U52 | our own identity save does not accuse anybody          | `settling` → `false`      | `panels.test.tsx` › does not accuse anybody while the operator own write is still settling      |
| U53 | a read-only screen makes no claim about saving         | drop the `!mayWrite` arm  | `panels.test.tsx` › says nothing about saving a panel that can no longer be saved               |
| U54 | equivalent URLs are not an overwrite                   | compare raw text          | `panels.test.tsx` › does not call an equivalent url an overwrite                                |

**U51 killed nothing on its first two runs.** The first version of the test had
no way for the concurrent change to reach the form — a rename with no refetch —
and the second asserted immediately after the click, reading the render before
`isPending` had flushed. Both passed for reasons unrelated to the rule. It kills
now, having been made to wait for the request to be genuinely in flight.

That is the fifth mutation this session that killed nothing on its first run,
and the second where the test itself had to be repaired twice before it could
discriminate. The count is worth keeping precisely because each one looked like
a finished test.

---

# Round 22 — the same false accusation, from the two directions round 21 opened

A thirteenth reviewer confirmed round 21's fix reintroduced, for the **sixth
consecutive round**, the defect every one of those rounds was written to remove:
the panel form telling an operator that somebody else had changed a row when
nobody had. Round 21 removed BOTH guards that were independently suppressing it
— `status.isPending` left `settling`, and the notice stopped being gated on
`mayWrite` — and each removal was defensible on its own. Together they were not.

## Why six rounds of this

Every one of those fixes suppressed the notice on **a mutation's `isPending`
flag**, and every one was falsified in a state where the flag was the wrong one
or had already cleared. That is not six people getting the same thing wrong; it
is one wrong question asked six times.

`remote` compares `basis` against `panel`. Those two values arrive on different
clocks: `basis` moves the moment a write answers, `panel` only when the query
refetches. So every write opens a window in which the operator's own new value
is compared against the old one the query still holds. A pending flag is a
_proxy_ for that window, and it is wrong at both ends:

- it covers requests that open no window (`status.isPending` across a Disable,
  which adopts nothing) — so a stalled POST hid a genuine warning with no bound,
  and the "load the fresh value" link that is the only escape lives inside the
  suppressed notice;
- and it stops covering while the window is still open.

Two states prove the second half, and both are reproduced in the suite:

1. **Restore under a replacement name.** `status.onSuccess` moves `basis.name`
   to the row the server stored. `panel.status` comes only from the query, so
   for the width of the awaited refetch the panel is still ARCHIVED, `mayWrite`
   is false, and — since round 21 un-gated the notice — the read-only string
   renders, telling the operator a third party made the rename they had just
   typed. Its only control is `adopt(panel)` with the **stale** cached row, so
   pressing it reverts the field to the name the server had already refused as
   taken and makes the notice permanent.
2. **A poll racing the write.** `invalidateQueries` does not supersede a fetch
   already in flight; it awaits it. A poll issued before the save commits is
   what `refresh()` — and with it `save.isPending`, which spans the awaited
   `onSuccess` — resolves on. The cache is left holding the row the save
   REPLACED, until the next poll ninety seconds later, with no mutation pending
   at any point. No server misbehaviour is required.

## The rule that replaces the flag

The window is not "a request is in progress". It is "the query has not
delivered my write yet" — so ask that:

```ts
const behind = written !== null && Date.parse(panel.updatedAt) < Date.parse(written);
const changedElsewhere = !behind && (remote.name || remote.baseUrl);
```

`written` is the newest revision this session's own writes have stored, set in
the two `onSuccess` handlers that move `basis` and nowhere else. `update` and
`setStatus` both stamp `updatedAt` from the `Clock` and return the row they
wrote (`drizzle-panel.repository.ts:290`, `:332`), so a query row older than
that revision predates this operator's write and nothing else can. It closes on
its own terms rather than a flag's, and a genuine concurrent change — which is
necessarily NEWER — is never suppressed by it.

`settling` is gone. It is not a second guard beside the new one; it is the
proxy the new rule replaces.

## What the reviewer found that was NOT a defect

The reviewer also reported that a **failed** refetch after a successful save
produces the same false accusation. It does not: `queryState` maps `isError` to
the error state, so the form is not on screen to say anything. Reproducing it
required routing GET and POST to the same stub response — which is the same
URL-only routing collision that made the first version of this round's own test
pass for the wrong reason. Recorded as disproved rather than fixed, and the test
that would have covered it was rewritten to cover the poll race instead, which
is reachable.

## A fixture that was not modelling this server

`does not accuse anybody while the operator own write is still settling` failed
under the new rule until its fixture was corrected. It returned the write's
answer with the **same** `updatedAt` as the read — a server that does not stamp
its writes. The correction is toward the real server, not away from the test:
the rule is now sensitive to something the fixtures have to get right, which is
a property to want.

## The mutations

Eleven, each killing a **distinct** set of tests, so the suite can tell the
versions of these expressions apart rather than merely noticing that one of them
matters.

| #   | rule                                                        | mutation                                | tests that die                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U55 | the notice waits for the query to deliver our own write     | `behind` → `false`                      | `panels.test.tsx` › does not accuse anybody while the operator own write is still settling; › does not blame a third party for the rename the operator gave a restore; › does not accuse anybody when a poll in flight answers with the replaced row |
| U56 | a restore that renames records the revision it stored       | drop `setWritten` in `status.onSuccess` | `panels.test.tsx` › does not blame a third party for the rename the operator gave a restore                                                                                                                                                          |
| U57 | an identity save records the revision it stored             | drop `setWritten` in `save.onSuccess`   | `panels.test.tsx` › does not accuse anybody while the operator own write is still settling; › does not accuse anybody when a poll in flight answers with the replaced row                                                                            |
| U58 | a viewer is told the row moved                              | `changedElsewhere && mayEdit`           | `panels.test.tsx` › tells a viewer the row moved without offering them a write                                                                                                                                                                       |
| U59 | a viewer is offered no identity write                       | `mayWrite` drops `mayEdit`              | `panels.test.tsx` › tells a viewer the row moved without offering them a write                                                                                                                                                                       |
| U60 | a name is compared the way `panelNameSchema` trims it       | `a.trim() === b.trim()` → `a === b`     | `panels.test.tsx` › does not call a name an overwrite when the server would trim it to the stored one                                                                                                                                                |
| U61 | only a field somebody ELSE moved can be overwritten         | drop `changedRemotely`                  | `panels.test.tsx` › does not revert a concurrent rename when only the other field was edited; › calls no overwrite on the field the operator alone changed                                                                                           |
| U62 | a half-typed base URL is not the stored value               | `sameUrl` catch → `true`                | `panels.test.tsx` › compares a half-typed base URL as text rather than guessing                                                                                                                                                                      |
| U63 | only a field the save CARRIES can be overwritten            | drop `draft !== base`                   | `panels.test.tsx` › does not revert a concurrent rename when only the other field was edited                                                                                                                                                         |
| U64 | an identical correction replaces nothing                    | drop `!same(draft, stored)`             | `panels.test.tsx` › does not call an identical correction an overwrite; › does not call an equivalent url an overwrite; › does not call a name an overwrite when the server would trim it to the stored one                                          |
| U65 | a viewer is not told an edit they never began has been lost | restore the `ویرایش شما` wording        | `panels.test.tsx` › tells a viewer the row moved without offering them a write                                                                                                                                                                       |

U61, U63 and U64 are the three terms of `overwrites`. They do not each kill a
single distinct test — two independent fields share one disjunction, so a
dropped term can fire through either — but their failure SETS are distinct,
which is the property that matters: no two versions of that expression look the
same to the suite.

## One branch that is asserted to be unreachable rather than tested

`sameUrl`'s catch returns `a === b`, and only the `false` answer is reachable
against this server: `b` is `panel.baseUrl`, which the server writes as
`new URL(raw).toString()`, so it always parses, and an `a` that does not parse
is never equal to it. U62 covers the reachable answer. The equality is kept —
the contract types `baseUrl` as `z.string()`, so a row that ever held something
else deserves the right answer — and is recorded here as untested-because-
unreachable rather than covered by a test that would pass for the wrong reason.

## Two false statements removed rather than argued with

- `panels.tsx` claimed the restore-with-rename path "runs while the panel is
  still ARCHIVED, where `mayWrite` is false and the notice is not rendered at
  all", in the same commit that made the notice render regardless of `mayWrite`.
  This document repeated it. Both are gone.
- `tests/web/panels.test.tsx`'s archived-panel test opened with "An ARCHIVED
  panel has no Save button **and no inputs**", nine lines above its own body
  comment saying the disabled inputs are still on screen. That false premise is
  what an earlier round used to argue the notice could be dropped there.

## The count

Six of this session's mutations killed nothing on their first run; none of
round 22's did. Three tests in this round failed before the fix and pass after
it — the two reproductions above and the read-only wording — and the fourth
change to the suite was correcting a fixture, not adding an assertion.

## The check that was green because it had stopped looking

Writing round 22's table turned `check:falsification-citations` green at **the
same count as before the table existed** — 124, unchanged, with eleven new rows
in the record. `CITATION_HEADERS` held `test that dies` and not `tests that
die`, so the whole table was not a citation table as far as the check was
concerned, and every row in it was skipped in silence.

That is the disease named in this script's own opening comment, for the second
time in the same script: _a checker that decides for itself what to ignore is a
checker that can be green and wrong._ Adding the plural fixes one table. Three
things were done instead, so the class is closed:

1. the plural is recognised, and a cell may cite **several** tests — one
   mutation killing three is stronger evidence than naming one of them, but only
   if all three are checked;
2. a header row whose last column mentions a test and is **not** recognised is a
   failure now, not a skip, so the next round that invents a fourth spelling
   gets a red run;
3. a continuation citation (`› second name`) inherits the FILE of the citation
   before it. It had been inheriting the empty string, which `endsWith('')`
   matches for every test file in the tree — so a continuation naming a test
   that lives somewhere else entirely resolved, against the rule stated twenty
   lines below it in the same file.

| #   | rule                                                       | mutation                                                                                           | what the check prints                                                   |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| U66 | every citation in a multi-test cell is checked             | rename the third citation of U55 to an absent test                                                 | `check-falsification-citations.mjs` exits 1: `a test nobody ever wrote` |
| U67 | an unrecognised test-column header fails rather than skips | record header → `tests which die`                                                                  | `check-falsification-citations.mjs` exits 1: unrecognised header        |
| U68 | the plural header is load-bearing                          | drop `'tests that die'` from `CITATION_HEADERS`                                                    | `check-falsification-citations.mjs` exits 1: unrecognised header        |
| U70 | a continuation resolves in the file its row NAMES          | continuation → `counts each panel exactly once per breakdown`, a real test in `dashboard.test.tsx` | `check-falsification-citations.mjs` exits 1: `(panels.test.tsx)`        |

These four rows cite a SCRIPT rather than a test, so this table's last column is
headed `what the check prints` and the check does not read it — deliberately: a
citation table that cited its own checker would be the check asserting itself.

That header was `tests that die` first, and the check refused the table
immediately, on the same run that added it: four rows in a citation table naming
no test. Which is the check doing the job the rest of this section is about, to
the section that describes it.

The guard in (2) was wrong on its first attempt in the way these guards usually
are — too eager rather than too lax. It tested the last cell of EVERY row of a
non-citation table, so `a real test in dashboard.test.tsx`, an ordinary sentence
in an ordinary data row of the table above, was reported as a misspelled header.
A table declares its columns in the row above the separator and nowhere else, so
that is where the decision is made now.

U69 is not in the table because it proved nothing the others do not: it renamed
a continuation to a string absent everywhere, which U66 already covers. It is
named here rather than renumbered so the labels in this document keep matching
the order they were run in.
