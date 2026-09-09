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

One row of that table cites a probe that is not a vitest test, so it is kept
separately rather than inside a column headed `Named test`. It sat in the table
above for twenty rounds, naming a script where every other row names a test, and
nothing noticed — because the table itself was never being read (see the round-23
section at the end of this document).

| #   | Rule                                                   | Mutation                                       | what dies                                                                |
| --- | ------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------ |
| F-J | The visual harness detects a page that fails to render | `blastRadius: 'LOCAL'` → an invalid enum value | `scripts/visual/capture.mjs`: `/features` came back `showingError: true` |

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
| the credentials stale-value guard | see below — it was testing something that cannot happen                                                                            | removed — the case it guarded is unreachable                                                                                          |

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
| V05  | failures and recoveries are disjoint and paired                 | add a recovery to the failure list | `web-money-and-scope.test.ts` › keeps failures and recoveries disjoint     |
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

| #    | rule                                            | mutation                                                   | test that dies                                                                                          |
| ---- | ----------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| U12  | a transient failure does NOT stop the interval  | `refused` → `error !== null`                               | `permissions-and-refresh.test.tsx` › keeps polling through a transient failure, and recovers on its own |
| U13b | a declared index matches the built one in shape | reorder the archived keyset to `(created_at,id,tenant_id)` | `online-indexes.test.ts` › has an index in the database matching every declared definition              |
| U15  | the shell does not hide what the server serves  | gate `/providers` on `panels.view` again                   | `permissions-and-refresh.test.tsx` › is offered to an actor who may create a panel but not list one     |
| U16  | a failed detail can be re-asked                 | drop the retry button from the error banner                | `permissions-and-refresh.test.tsx` › offers a retry that actually re-asks                               |

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

**The transcribed message cannot be right, and that is established rather than
suspected.** `expected 2 to be 4` means `new Set(all).size === 2` and
`all.length === 4` — two rows from each `claimTenants(now, 1)`. The statement
cannot return two: the inner select carries `LIMIT ${limit}` with `limit = 1`,
and the `UPDATE … FROM due` joins on `t.tenant_id = due.tenant_id` where
`panel_monitor_tenants.tenant_id` is the PRIMARY KEY, so at most one row can
match and be returned per call. `git show` of the commit that recorded this
confirms the test was byte-identical then, so the shape was the same.

So the message was mis-transcribed, and this record cannot say what the failure
was. The two shapes the assertion can actually produce are `expected 1 to be 2`
— both replicas handed the SAME tenant, which is a real double-claim and the
defect this test exists to catch — and, before the vacuity below was closed,
`expected 0 to be 0`, which passes. The first is the one a mis-transcription of
`expected 2 to be 4` most plausibly came from, and it is not something to
record as "could not root-cause" while the digits say something impossible.

**The test was also vacuous when both claims returned nothing.**
`new Set([]).size === 0 === [].length`, so a claim predicate that stopped
claiming altogether left it green — the most likely regression, agreed with
rather than caught. It now asserts at least one claim succeeded, which is the
form it should have had when the failure above was recorded, and which would
have distinguished the two shapes.

What can still be said with evidence:

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

> **"The class is closed" was itself false, and round 23 says how.** The three
> fixes below all keyed on the LAST column of a header. The record's oldest and
> largest table is headed `| # | Rule | Mutation | Named test | Result |` — a
> recognised name, one position from the end — so all twelve of its rows stayed
> unread through every one of them. The escape had moved from lexical to
> positional, and the sentence claiming otherwise was written in the same commit
> that left it open.

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

---

# Round 23 — the state was put inside the component the tab strip unmounts

A fourteenth reviewer found round 22's rule undone by an ordinary tab click, and
three holes in the check that is supposed to prove these tables.

## The rule's memory did not survive the window the rule exists for

`written`, `basis`, `name` and `baseUrl` all lived in `OverviewTab`, and the tab
strip rendered it as `{tab === 'overview' && <OverviewTab … />}`. A tab click
therefore destroyed every one of them and re-seeded the draft from whatever row
the query happened to be holding — **inside** the window round 22 was written to
cover.

So: type a new name, press Save, glance at Health while the confirming refetch
is in flight, come back. The name field shows the OLD name — the operator's own
save, apparently reverted — and when the refetch lands with the row they
themselves wrote, `basis` (re-seeded, stale) differs from `panel` (fresh) and
the form accuses a third party of the change they just made. `written` was
`null` by then and could suppress nothing.

This is the same lesson as row **U13** — _the loading state unmounts the
credentials draft_ — and `app.tsx` already keys `PanelDetailPage` by panel id
for the same class of reason. Round 22 read neither, and put new state in the
one child that gets unmounted by a control sitting directly above it.

The overview is now `hidden` rather than unmounted, and it is the only tab
treated that way: it is the only one holding state that must outlive the click.
`CredentialsTab`'s three fields are typed SECRETS, and dropping them on the way
out is the behaviour to want.

> **That last sentence was half right, and round 24 says which half.** The
> secrets should indeed die with the tab. The rotation's idempotency KEY had to
> survive it and did not — see round 24.

## The check had a second escape, one column to the left

`check:falsification-citations` decided whether a table cites tests by reading
**the last cell** of its header. The record's first and largest evidence table
is headed `| # | Rule | Mutation | Named test | Result |`. `Named test` was
always on the recognised list. It simply is not last — so `declared` was
`result`, the table was not a citation table, and **all twelve of its rows went
unchecked**, exactly as the eleven of round 22's table had. Round 22 widened the
list of names; the escape had already moved to position.

Two more, found while fixing it:

- **The row parser split on escaped pipes.** A mutation cell routinely contains
  one — `` `\|\|` → `&&` `` is how an or-to-and mutation is written — and
  markdown escapes it as `\|`. Three rows were therefore parsed two columns
  wider than their header. Reading only the last cell hid this completely: the
  last cell is the last cell however many phantom ones precede it.
- **Row F-J cited a script, not a test**, in a column headed `Named test`, and
  had done since the first round. Nothing noticed because that table was never
  read. It is now in its own table headed `what dies`, the treatment round 22
  gave the checker's own probes.

And the guard added in round 22 was **too eager** in the other direction: it
failed the whole run on any non-citation table whose last column mentioned a
test, so an ordinary `| area | tests added |` summary was reported as a
misspelled header. It now keys on something meaningful — a table with a
`mutation` column and no citation column is an error **unless it declares
itself** with a name on `NON_CITING_HEADERS`.

The count went from 141 to **152**, and the path is worth stating because the
first version of this sentence got both the figure and the reason wrong. The old
script against the new record gives 142 — that is round 23's own new row. The
new script against it gives 152. So: **+1 for the row this round added, +10 for
the table that had never been read** (twelve rows, of which one is a `(same
test)` continuation that is not counted and one is the F-J row moved out). "141
to 151, the ten citations of the recovered table" was wrong twice over in one
line, and round 24 found it by instrumenting the script rather than by reading
the sentence.

## Fake timers leaked out of a failing test

`tests/web/setup.ts` restored globals and mocks and not timers, and the three
tests in `panels.test.tsx` that install fake timers call `vi.useRealTimers()` as
their LAST statement — which a failed assertion skips. The test after a failure therefore
ran on a clock nothing advanced. That matters most exactly where it is hardest
to see: a mutation run, where the first failure is expected and every test after
it is the evidence that the mutation killed nothing else. `afterEach` restores
them now.

No mutation in this session is known to have been distorted by it — U58, U59 and
U65 each killed exactly one test with no cascade — and the hazard is recorded
rather than the claim that it never bit.

> The count was wrong: there are **three** such tests in `panels.test.tsx`, not
> two, and it was three when the sentence was written. The other files that use
> fake timers (`permissions-and-refresh`, `shell-recovery`) restore through a
> `describe`-level `afterEach` and were never at risk. Round 24 also gave this
> rule the test it did not have — see U79.

## The mutations

| #   | rule                              | mutation                               | tests that die                                                                        |
| --- | --------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------- |
| U71 | the overview outlives a tab click | `hidden` → `{tab === 'overview' && …}` | `panels.test.tsx` › keeps the draft and the revision across a tab click during a save |

The checker's own four are again outside the citation tables, for the reason
round 22 gives:

| #   | rule                                                  | mutation                               | what the check prints                                |
| --- | ----------------------------------------------------- | -------------------------------------- | ---------------------------------------------------- |
| U72 | the citation column is found by NAME, at any position | read the last cell instead             | exits 1: unrecognised header (table 1 skipped again) |
| U73 | rows split on UNESCAPED pipes only                    | `.split(/(?<!\\)\|/)` → `.split('\|')` | exits 1: 2 rows in a citation table name no test     |
| U74 | a misspelled citation header fails                    | record header → `tests which die`      | exits 1: unrecognised header                         |
| U75 | the `what dies` opt-out is load-bearing               | drop it from `NON_CITING_HEADERS`      | exits 1: 2 unrecognised headers                      |

~~Dropping the `declared.includes('mutation')` term of the guard kills
**nothing**, and is recorded as such rather than dressed up: no table in the
record currently violates it, so the term protects a future state and only the
record-side probe (U74) can demonstrate it.~~

> **False, and round 24 removed the term.** Dropping it fails the run
> immediately, on this record: `| test | why it could not fail | what it is now |`
> — three rows whose first column is literally headed `test` — was being skipped
> for precisely that reason. The narrowing I called a protection was an
> exemption, and it was already exempting something. Every table now declares
> itself or the run fails.

This makes the check STRICTER than the round-23 version, deliberately, and it
reverses that round's other answer: the reviewer's `| area | tests added |`
probe was reported there as a false positive to be removed, and under this rule
it fails again — because it is an undeclared table, not because its header
mentions a test. That is the intended direction for this document, whose entire
purpose is evidence: a table either cites tests or says what it holds instead.
The cost is one word in a header the next person adds; the alternative is an
exemption that silently ate three rows for twenty rounds.

The error message was rewritten to match, since "names a test column this check
does not recognise" is not what is wrong with a table that names no column of
the kind at all.

---

# Round 24 — the tab click was one unmount path of three

A fifteenth reviewer found that round 23 fixed the unmount it was shown and left
two others reaching the same state, and disproved three claims round 23 made
about itself.

## A failing background poll threw the page away, with no operator action

`queryState` mapped `isError` straight to the error state, and TanStack Query
sets `status: 'error'` on a failed BACKGROUND refetch while `data` is still
present. `StateSwitch` renders the error card INSTEAD of its children, so one
transient 5xx from the ninety-second poll unmounted the whole tab subtree — the
`hidden` overview included — and took the operator's unsaved draft, their basis
and the revision their own writes had stored.

This is strictly worse than the tab click round 23 fixed: it needs nobody to do
anything, it happens on a timer, and it lands inside the same window rounds 22
and 23 exist for. Round 22 had actually looked straight at this code and drawn
the opposite conclusion — it recorded that a failed refetch "does NOT produce
this ... the form is not on screen to say anything" — which was true about the
false accusation and missed that the form leaving takes the draft with it.

`queryState` now returns the error state only when there is **nothing to show**.
A query that has data keeps rendering it — and says so, because a page that has
quietly stopped refreshing is the legacy system's defining defect and the one
this admin exists to remove. `staleAfterError` names that state and
`StateSwitch` draws the warning ABOVE the data rather than over it. Every one of
the fourteen call sites passes it: a silently stale page is the same defect on
every screen.

## The credentials tab held something that had to outlive a tab click after all

Round 23 asserted, in a comment and in its commit message, that the other three
tabs "genuinely hold nothing that must outlive the click", because the
credential fields are typed secrets and dropping them is what you want.

The secrets, yes. The rotation's **idempotency key**, no. `useSubmissionKey`
deliberately keeps its key when nothing came back — a 5xx is "did that work?",
not "do it twice" — and the key was a `useRef` inside `CredentialsTab`. The
natural response to an ambiguous rotation failure is to go and look at Health to
see whether it landed, which is exactly the action that destroyed it. The retry
then carried a NEW key with an identical payload, which the server cannot
dedupe: a second credential write, a second CRITICAL audit row, and the panel's
probe eligibility reset, for one operator intention.

The key is owned by `PanelDetailPage` now, which a tab click cannot unmount. The
secrets still die with the tab. The lesson is that "state" here is not only what
the operator can see.

## Three claims round 23 made about itself, disproved

- **"Dropping the guard's `mutation` term kills nothing."** It fails the run
  immediately. See the struck-through paragraph in round 23 — the narrowing was
  an exemption, and it was already exempting a real table.
- **"141 to 151, the ten citations of the recovered table."** Wrong figure and
  wrong reason; the corrected arithmetic is in round 23's section.
- **"the two tests that install fake timers."** Three, and three when written.

## The check, again

Two more holes, both found by enumerating the record's tables by hand rather
than by reading the script:

- a table declaring a recognised citation column that is **not last** was still
  read correctly, but a table declaring nothing was skipped unless it had a
  `mutation` column. Every table now declares itself or the run fails, and the
  opt-out names are matched at any position — the same positional fix the
  citation column got in round 23, applied to the list that had kept the bug.
- **no row was ever checked against its header's width.** The escaped-pipe bug
  produced exactly that shape and nothing looked; so did one hand-written row in
  the one table nothing was reading. A cell count is the cheapest check for both
  and it does not care whether the table cites anything. It found the row at
  once.

## The mutations

| #   | rule                                                   | mutation                                  | tests that die                                                                                                                            |
| --- | ------------------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| U76 | a failed refetch does not discard a page that has data | `queryState` → `if (query.isError)`       | `panels.test.tsx` › keeps the page and the draft when a background poll fails; › says so when the data on screen is older than the server |
| U77 | and the page says it is stale rather than pretending   | `staleAfterError` → `false`               | `panels.test.tsx` › says so when the data on screen is older than the server                                                              |
| U78 | a credential rotation's key outlives a tab click       | `useSubmissionKey()` back inside the tab  | `panels.test.tsx` › keeps a credential rotation idempotency key across a tab click                                                        |
| U79 | the shared `afterEach` restores real timers            | drop `vi.useRealTimers()` from `setup.ts` | `setup-hygiene.test.tsx` › starts the next test on real timers anyway                                                                     |

U76 and U77 are two rules and were one test until the mutation run showed both
killing the same thing. Split, their failure sets differ, which is the property
that lets the suite tell the versions apart.

The check's own probes, outside the citation tables as before:

| #   | rule                                 | mutation                                         | what the check prints                                                    |
| --- | ------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------ |
| U80 | every table declares itself          | append an undeclared `\| area \| tests added \|` | exits 1: 1 table(s) declare neither a citation column nor what they hold |
| U81 | every row matches its header's width | (the record's own malformed row, before repair)  | exits 1: 1 row(s) do not match their table's column count                |

## What round 23's test was not testing

`keeps the draft and the revision across a tab click during a save` named the
revision and did not exercise it: its only concurrency assertion ran AFTER the
refetch was released, by which point `basis` and `panel` agree and the assertion
holds however `behind` is defined. Mutating `behind` to `false` did not kill it.
The assertion moved inside the held refetch, where it discriminates.

That is the fourth test this session that had to be repaired before it could
fail — and the second whose NAME was the only thing asserting the rule.

An illustration of the shape, in prose:

```
| column a | column b |
| -------- | -------- |
| one      | two      |
```

---

# Round 25 — the rule was right at one screen and absent at six

A sixteenth reviewer found round 24's fix applied where it was being looked at
and nowhere else, disagreeing with a rule this codebase had already reached
twice, and three more ways the check could be green and wrong.

## `queryState` did not agree with `sessionView`, which says it must

`app.tsx` states the rule and the reason in full: _"Data wins over a RETRYABLE
error, and only over a retryable one … `pollSession` STOPS on a final answer …
Letting data win there kept a complete, fully drawn console on screen for ever,
with nothing to press and nothing said: the exact defect the round before this
one was written to remove, reached through the door its own fix opened. **The
two rules have to agree about which failures are worth waiting through.**"_

Round 24 wrote the second rule and did not agree. It let data win over EVERY
error, while `pollUnlessFinal` stops the timer on exactly the ones it ignored.
So a `panels.view` revoked mid-session, or a `ZodError` from a tab holding a
previous release across a deploy, left the detail screen fully drawn — tab
strip, editable identity form, credential rotation form, Test-connection button
— all asserting capabilities the server had just refused, permanently, with no
poll coming and a Retry button that could only write another
`access.permission_denied` event. That is the branch's central claim broken by
the commit that widened this, in the same session that wrote the comment
warning against it.

## Six of eighteen call sites, and a count that was wrong

Round 24 claimed the warning was drawn "at all fourteen call sites". There are
**eighteen**, and **twelve** had it. The six without it had been given the
weakened error rule and none of the compensating notice — including both
dashboard distribution cards, on a POLLING query, on the page whose own comment
reads _"One stale card next to a live one is worse than two stale cards, because
nothing on screen says which is which."_ That is what the commit produced, since
the readiness card beside them does announce its own failure.

Deleting `stale=` from seventeen of the eighteen sites, with
`state-switch-contract.test.tsx` removed as well, leaves **265 of 265 green** —
every remaining web test. Re-measured in round 27 on this exact head: the figure
holds.

> **But the conclusion drawn from it did not.** "Nothing but that scan was
> holding the property" is false: deleting only the PANEL-DETAIL prop fails
> `panels.test.tsx › says so when the data on screen is older than the server`
> as well as the scan. A behaviour test held one of the eighteen sites all
> along; the scan held the other seventeen. Measured in round 27:
> `2 failed | 265 passed (267)`.
>
> And the round-26 correction of this paragraph was itself wrong on its stated
> reason — "since only twelve sites were then wired". Twelve was round 24's
> state (`894be2a`: 2+1+2+1+2+1+3). At round 25's own head all eighteen were
> wired (2+1+4+1+4+1+5). The reviewer's original experiment ran against round
> 24, which is why theirs deleted eleven. Three successive statements about one
> experiment, each correcting the last, and each wrong about something else.

> The first version of this paragraph said "the other seventeen … 264 of 264",
> which described an experiment nobody had run: at the time the reviewer ran
> theirs only twelve sites were wired, so seventeen deletions were impossible,
> and 264 was their web count, not a figure from this tree. Restating somebody
> else's experiment in your own numbers is the same defect as citing a probe you
> threw away. The figure above was measured here, on this head, after the
> correction: baseline 267, and 265 with the seventeen props and the scan gone.

Lint is not the backstop either: an unused `staleAfterError` import only appears
where EVERY site in a file goes, so the one file that keeps a site — the one the
rendered test covers — reports nothing. The rule is asserted over the SOURCES
now, in `state-switch-contract.test.tsx`,
which is the only shape of test that catches a nineteenth site being added
without it. The scan also asserts it found the call sites at all — a scan
matching nothing passes every assertion under it.

## `data?` optional, one release after the same mistake was documented

`sessionView`'s own parameter carries: _"REQUIRED, though it may be `undefined`.
Optional, a caller that forgot it silently got the previous release's rule."_
`queryState` and `staleAfterError` shipped with `data?: unknown`. Both are
required now, and making them so immediately surfaced a narrowed prop type in
`AttentionCard` that omitted `error` — the card would have decided a permanent
refusal was worth waiting through while every other card on the page decided
otherwise.

## A term no rendered test could falsify

`staleAfterError`'s `!finalAnswer(...)` killed nothing: `StateSwitch` returns
the error state before it ever reads `stale`, so through any rendered page the
term is unreachable. Rather than delete a correct guard or keep dead logic
dressed as a rule, both functions are now unit-tested directly beside
`sessionView`, which is where the agreement between them belongs.

## Three more ways the check was green and wrong

- **One blank line inside a table dropped 18 of 157 citations, exit 0.** The
  declaration rule fires only at a separator row; a blank line ends the table,
  and every row after it is treated as a header candidate in a table that never
  reaches a separator — so it is checked for nothing at all. Third consecutive
  round in which this script skipped part of the record silently.
- **A table whose separator comes first escaped completely** — no declaration
  check, no width check, and a fabricated citation inside it never looked up.
- **A markdown table inside a fenced code block failed the run.** The record
  documents table shapes; writing one out properly was a red run. Two such lines
  already existed and escaped only by not having a separator under them.

And the guarantee the check prints was wider than the one it made: `includes`
over whole file text let a `describe` name, a comment or a sentence of prose
satisfy "resolves to a committed test", and row V05 was doing exactly that.
Citations are matched against extracted `it`/`test` titles now.

## The mutations

| #   | rule                                                           | mutation                                  | tests that die                                                                                                                                                                     |
| --- | -------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U85 | data wins over a retryable error and only over a retryable one | drop `finalAnswer` from `queryState`      | `session-view.test.ts` › gives up the data on a final refusal, because no poll is coming; `panels.test.tsx` › takes the screen down when the refusal is final, rather than warning |
| U86 | and a final refusal is not reported as staleness               | drop `finalAnswer` from `staleAfterError` | `session-view.test.ts` › calls data stale only while the failure is worth waiting through                                                                                          |
| U87 | every `StateSwitch` says whether its data is stale             | drop one `stale=` prop                    | `state-switch-contract.test.tsx` › hands StateSwitch a query rather than a state it computed                                                                                       |

The check's own probes:

| #   | rule                                          | mutation                       | what the check prints                                                    |
| --- | --------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------ |
| U82 | a table without a header/separator pair fails | insert a blank line mid-table  | exits 1: 1 table(s) have no header/separator pair                        |
| U83 | so does a separator with no header above it   | append a separator-first table | exits 1: 2 table(s) have no header/separator pair                        |
| U84 | a fenced block is prose, not a table          | ignore fences                  | exits 1: 1 table(s) declare neither a citation column nor what they hold |

U86 killed nothing on its first run, which is what sent it to a unit test. That
is the seventh mutation this session to kill nothing on the first attempt, and
the reason the count is kept: each one looked like a finished rule.

---

# Round 26 — three props derived from one value cannot be kept in agreement by care

A seventeenth reviewer found the round-25 rule correct and incompletely applied,
and the scan written to prevent exactly that unable to see either gap.

## The heading outlived the screen, Test-connection button included

`PageHead` renders ABOVE `StateSwitch` and read `panel.data?.panel` directly.
React Query keeps `data` through a failed refetch, so on a FINAL refusal the tab
strip and the form came down while the panel's name, its provider and its
**Test-connection button** stayed on screen over the error card. Pressing that
button records an `access.permission_denied` operational event and a DENIED
audit row — a control that can never work, manufacturing precisely the noise the
alerts page exists to keep clear.

Round 25's commit message listed that button among what the OLD rule left drawn.
It was still drawn, and the test written for that round asserted the tabs and the
name field and never the button. `shownData` gates it now, on a state derived
from the same pure function `StateSwitch` uses, so the heading and the body
cannot disagree.

## One view never adopted the rule, and the scan structurally could not see it

The notification detail rendered a hand-rolled ladder — `{detail.isError &&
<Banner/>}` beside `{detail.data && <Card/>}` — with no `queryState` anywhere.
`isError` does not distinguish a blip from an answer, so on a final refusal it
kept the pre-failure attempts list on screen as though current AND offered a
retry that could only be refused again. Both halves of the defect the branch
spent five rounds removing, in the one view that computed its own states.

The round-25 scan grepped for `queryState(`, so this site was invisible to it by
construction.

## The scan asserted a token, not the property

`window.includes('stale=')` over a few lines around each call. Three ways to be
green and wrong, all executed by the reviewer: `stale={false}` at every one of
the eighteen sites passed; a site wired to a DIFFERENT query than its state
passed; a call site one directory over was never looked at.

That is not fixable by a better grep. `state`, `stale` and `onRetry` were three
derivations of one query, passed by hand eighteen times — which is why six were
missed for a whole round and why a wrong-query wiring was undetectable.
**`StateSwitch` takes the query now** and derives all three itself, so the
disagreement is unrepresentable and the compiler refuses a site that omits it.
`view-state.ts` holds the rules; `retryOf` makes "no retry after a final answer"
automatic rather than eighteen more hand-passed props.

The scan is aimed at what types cannot catch instead: a query-driven view that
never uses `StateSwitch` at all. Mutations are exempt from it deliberately — a
mutation's `isError` reports one submission the operator just made, with no poll
and no staleness, and lumping the two together would demand a rewrite of eight
correct error reports.

## A fifth silent-drop channel, and the one line that closes the class

Fence-skipping — added last round to stop a documented table shape failing the
run — is itself a skip channel: wrapping a real citation table in a fence drops
its citations at exit 0. That is the fifth distinct way this script has stopped
reading part of the record, after a plural header, a non-final citation column,
escaped pipes and a blank line.

Every one of them was a DROP in the number checked, and every one exited 0
because nothing compared that number to anything. `FLOOR` does. Whatever the
sixth way turns out to be, the count falls and the run goes red.

## The mutations

| #   | rule                                                     | mutation                              | tests that die                                                                                                                                                                                 |
| --- | -------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U89 | the heading shows only what the screen is showing        | `shownData` → `panel.data?.panel`     | `panels.test.tsx` › takes the screen down when the refusal is final, rather than warning                                                                                                       |
| U90 | a final answer is offered no retry                       | `retryOf` never returns undefined     | `panels.test.tsx` › takes the screen down when the refusal is final, rather than warning; `control-plane-pages.test.tsx` › drops a stale attempts list on a final refusal, and offers no retry |
| U91 | the notification detail asks the same rule as every view | drop `queryState(detail) !== 'error'` | `control-plane-pages.test.tsx` › drops a stale attempts list on a final refusal, and offers no retry                                                                                           |

| #   | rule                                    | mutation                    | what the check prints                                          |
| --- | --------------------------------------- | --------------------------- | -------------------------------------------------------------- |
| U88 | the record's citation count has a floor | fence a real citation table | SUPERSEDED by round 27 — see there for the reproducible output |

## One test I had to repair three times before it could discriminate

`drops a stale attempts list on a final refusal` first clicked the row text
rather than the button that selects it; then opened a detail whose fixture
omitted `releasedClaims`, so the real schema refused it and the error state
rendered for the wrong reason; then tried to force a refetch through a control
that only exists when the rule is already broken. It uses the 3-second PENDING
poll now, which is how the refusal actually reaches an open panel with nobody
touching anything.

That the fixture was rejected by the contract is the harness working: these
tests parse through the same schemas the server validates against.

---

# Round 27 — the same shape, three more places it had not been looked for

An eighteenth reviewer found round 26's rule right and its sweep incomplete,
for the third round running, plus three ways the checker and its scan still
accepted less than they claimed.

## Controls that outlive the screen, again

Round 26 fixed `PageHead` on the panel detail: a control ABOVE `StateSwitch`
that the state never reaches. The same shape was left standing in three more
places, all found by looking rather than by any check:

- **The alerts page's own Refresh button.** After a revoked permission the card
  below correctly offered no retry while the most obvious button on the page
  went on firing the refused request — one `access.permission_denied` event and
  one DENIED audit row per press, two in production because `main.tsx` retries
  once.
- **All three `CursorPager`s.** Siblings of their switch, fed from
  `query.data`, so the error card replaced the table while the pager reported
  "showing N" for rows nobody could see and offered an enabled "older" that
  pushed a cursor — changing the query key and issuing a fresh refused request.
- **The template revisions pane**, which had no error state at all: it rendered
  `{revisions.data && …}` and nothing else, so a refused history drew an EMPTY
  pane. An operator reads that as "this template has no revision history" — a
  false statement about the record, from the module whose own comment says
  silence is the one outcome this subsystem may not produce.

That last one is the important one, because the scan written in round 26 to
catch exactly this class could not see it: the scan matches spellings of
`isError`, and this site's defect was the ABSENCE of that spelling. A scan over
spellings cannot find an absence, and the file now says so rather than implying
coverage it does not have.

## The error card described a failure that did not happen

For a 403 the server answered correctly in microseconds, the card said "خطا در
ارتباط با سرور — ارتباط با سرور برقرار نشد. دوباره تلاش کنید": a false account
of what happened, next to an instruction to retry, next to no button — because
round 26 had correctly withheld it. `StateSwitch` had the right copy for a
permission failure all along; a MID-SESSION revocation never reaches it, since
`denied` comes from the permission list fetched at sign-in rather than from the
403 in hand.

## The detail panel had no loading state

Three blocks keyed on staleness, error and data — jointly incomplete, because
`isPending` matched none. Selecting a notification left the DOM byte-identical
until the request answered: a click that appears to do nothing.

## The scan's exemption failed OPEN

Round 26 exempted mutations by flagging only names matched by `const X =
useQuery(` in the same file — so everything else was exempt by default,
including a genuine polled query arriving as a prop. Inserting
`{query.isError && …}` into `AttentionCard` left the scan green. An exemption
that fails open exempts the cases nobody thought of, which are the ones a scan
is for. It is inverted now: everything is a query unless a `useMutation` in the
same file proves otherwise, and two further spellings the single pattern missed
(a ternary, and `status === 'error'`) are matched too.

## A floor is not a bound

`FLOOR = 160` against 165 actual was measured by the reviewer against every one
of the record's 25 citation tables: fencing 17 of them still exited 0, because
the slack absorbed the drop. One was the table certifying the commit that
introduced the floor. It is an EXACT expectation now — adding rows fails the run
and the failure says what to set it to, which is the point: the number is a
claim about this file and should be re-stated deliberately, not drifted into.

Row **U88** cited `only 157 citations were checked`. No single-table fence on
the committed record produces 157; the figure came from a pre-round-26 state.
The row is corrected below to what the check actually prints.

## `it.todo` counted as evidence

`titles()` accepted `.skip` and `.todo`, so a citation resolved to a name that
never runs — defeating this script's one sentence of purpose in the cheapest
possible way. Both are rejected now; `.only`, `.concurrent` and `.fails` do run
and remain accepted.

## The mutations

| #   | rule                                                 | mutation                                         | tests that die                                                                                |
| --- | ---------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| U94 | the page's own refresh goes when the answer is final | restore the ungated button                       | `settings-and-alerts.test.tsx` › withdraws its own refresh once the refusal is final          |
| U95 | the pager goes with the rows it describes            | `queryState(notifications) !== 'error'` → `true` | `control-plane-pages.test.tsx` › takes the pager down with the rows it was describing         |
| U96 | a refusal is not reported as a connection failure    | always use the connection copy                   | `panels.test.tsx` › takes the screen down when the refusal is final, rather than warning      |
| U97 | a refused revision history is not an empty one       | drop the revisions `StateSwitch`                 | `control-plane-pages.test.tsx` › says the history could not be read, rather than showing none |
| U98 | selecting a notification does something visible      | drop the detail skeleton                         | `control-plane-pages.test.tsx` › shows the detail is loading rather than nothing at all       |
| U93 | the scan's mutation exemption fails CLOSED           | a query arriving as a prop renders off `isError` | `state-switch-contract.test.tsx` › renders no view off a bare isError unless it is a mutation |

| #    | rule                                        | mutation                    | what the check prints                                                |
| ---- | ------------------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| U88b | the record's citation count is exact        | fence a real citation table | exits 1: 161 citations were checked; this record declares 165 (then) |
| U92  | a citation must resolve to a test that RUNS | cite an `it.todo` stub      | exits 1: 1 of 166 cited tests do not exist                           |

**U94 killed nothing on its first run.** The assertion was vacuous: it looked
for the Refresh button on `NotificationsPage`, which never had one — the button
is on `AlertsPage`. Written against the wrong component, it could only pass.
That is the eighth mutation this session to kill nothing on the first attempt,
and the third whose test was aimed at the wrong thing entirely.

---

# Round 28 — a claim about the checker that was never applied at all

A nineteenth reviewer returned **thirteen** confirmed findings. The theme holds
for a fifth round: every rule is correct at the site the author was looking at
and absent at one or more others — twice, this time, on the very page the
previous commit edited.

## The worst one is not a defect in code

Round 27's message says of the citation checker: "It is an EXACT expectation
now." **It was never applied.** The script that made the change asserted on a
later pattern and threw before writing, so `const FLOOR = 160;` survived
untouched — and the `ok 171` printed by the very next command was read as
confirmation of a change that did not exist. Measured afterwards by the
reviewer: fencing 17 of the record's 25 citation tables still exited 0 under the
floor, one of them the table certifying that commit.

This is the third round in which a claim about this script was stronger than the
script, and the first in which the claim described an edit that had silently
no-opped. The count is exact now, and probed.

## Three rounds of gating controls on the wrong test

`retryOf` was used to decide whether a control that issues a request may be
drawn. It is not that test. A DENIED query is `enabled: false`, so it stays
`isPending` for ever and is never `isError` — `retryOf` hands back a callback,
the control is drawn above the "you do not have access" card, and pressing it
calls `refetch()`, which **does** fetch a disabled query in react-query 5.

Reachable directly: `navPermitted` only hides the nav link, and `resolve()`
renders the page for anyone who types the path. **No test in the suite had ever
rendered `AlertsPage` with `denied` true** — every call site passed
`denied={false}` — which is why the round that claimed to remove this control
left it working. (The sentence originally said "all fourteen call sites". That
number was already wrong when it was written: `git grep -c "<AlertsPage" 031e93d
-- tests/` returns 15, and the count has moved again since. The substantive
claim — that none of them passed `true` — held; the count did not, and a number
nobody could reproduce is exactly the kind of citation this record exists to
stop.)

`mayRequest(query, denied)` is the rule, and it now covers what three separate
rounds gated one at a time: the refresh button, the severity filter, the
open/all pills, the live/archived pills, and the pagers. Every one of them mints
or repeats the query the card below has just said cannot be answered.

## The same screen gave two diagnoses of one refusal

The notification detail's hand-rolled error card — three lines below the
skeleton round 27 added, inside a block whose comment claims it follows "the
SAME rule as every other query-driven view" — still hard-coded the connection
copy. On one 403 the list card above said "no permission" and this said "the
connection failed, try again", beside a retry deliberately removed.

## Reopening a pane was an unbounded retry

`enabled: showHistory` flipped false→true on every close-and-reopen of the
revisions `<details>`, which re-triggers an errored query — so the `<summary>`
element was a retry button the rule does not know about, at one request per
reopen, while the card inside withheld Retry because the answer was final. The
first open is sticky now; closing does not disable, so reopening cannot
re-trigger. The query has no interval, so staying enabled costs nothing.

## A test whose scenario was fictional

The revisions test registered `{url: '/revisions', status: 503}` beside
`{url: '/templates'}`. Both are ten characters and both are substrings of the
revisions URL, so the longest-match sort ties and the first-registered wins: the
revisions request was answered with the template list, and the error card the
test asserted came from a `ZodError`, not the 503 it names. It still killed its
mutation, so it was not vacuous — but it proved a different thing than it said.

## The scan's fourth escape

`{!detail.isError && detail.data && (` — the negated spelling, and the natural
way to write the ladder the scan hunts. Prettier-clean, scan-clean, suite-clean,
and it reverts round 24's rule (a failed poll keeps the page) at that site. Now
matched, along with `status !== 'error'`.

## Two more places the state did not reach

- All three pagers rendered in `denied` and `loading`, so a "showing 0" pager
  sat under a no-permission card.
- The dashboard's by-provider card HINT read `panels.data` directly and went on
  saying "this count covers only the first 200 panels" over a card saying the
  fleet could not be read.

## A false rationale, and an orphaned docblock

`refused()`'s comment claimed `StateSwitch`'s permission copy is one "a
MID-SESSION revocation never reaches, because `denied` comes from the permission
list fetched at sign-in". The shell polls the session every 60 seconds; round 25
fixed exactly that and `polling.ts` says so. The window is real (≤ one cadence,
plus 403s that are not permission drift) but the stated reason was false. And
`refused` had been inserted BETWEEN `retryOf`'s docblock and `retryOf`, so TSDoc
attached the retry rule to the wrong function.

## `describe.skip`, one level up

Round 27 closed `it.skip`/`it.todo` and left the class open: a citation
resolving to a test inside a skipped SUITE still counted. Skipped suites
contribute no titles now.

## The mutations

| #   | rule                                                   | mutation                               | tests that die                                                                                                                                       |
| --- | ------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | a denied page draws no request-issuing control         | `mayRequest` → `retryOf`               | `settings-and-alerts.test.tsx` › draws no request-issuing control at all when the actor is denied                                                    |
| V2  | the filters go with the rest                           | un-gate the toolbar                    | `settings-and-alerts.test.tsx` › draws no request-issuing control at all when the actor is denied; › withdraws its filters once the refusal is final |
| V3  | the detail names the refusal, not a connection failure | hard-code the connection copy          | `control-plane-pages.test.tsx` › drops a stale attempts list on a final refusal, and offers no retry                                                 |
| V4  | reopening the history pane is not a retry              | `setShowHistory(open)`                 | `control-plane-pages.test.tsx` › does not refetch a failing history each time the pane is reopened                                                   |
| V5  | a card header states nothing the card withheld         | read `panels.data` directly            | `dashboard.test.tsx` › says nothing about a fleet it could not read                                                                                  |
| V6  | the scan sees the NEGATED spelling                     | `{!detail.isError && detail.data && (` | `state-switch-contract.test.tsx` › renders no view off a bare isError unless it is a mutation                                                        |

| #    | rule                                     | mutation                    | what the check prints                                         |
| ---- | ---------------------------------------- | --------------------------- | ------------------------------------------------------------- |
| U99  | the record's citation count is EXACT     | fence the round's own table | exits 1: 364 citations were checked; this record declares 377 |
| U100 | a table at END OF FILE is structured too | append a header-only table  | exits 1: 1 table(s) have no header/separator pair             |

## One flake, recorded rather than re-run away

During V1's run, `safe-http-dns-pin.test.ts › keeps trusting the public roots
when a private CA is configured` failed on its 10-second timeout. In isolation
it passes in **809 ms**. It opens a real TLS socket against a 10 s bound, and a
mutation run saturates the machine, so the bound is what broke rather than the
behaviour. Not reproduced since, not fixed, and named here so the next reader
does not have to rediscover it. It is Phase 3C code untouched by this branch —
the second such flake this session, both in real-socket tests under load.

# Round 29 — the fix that did nothing in a browser, and a checker two characters could defeat

The twentieth fresh-context review returned thirteen findings against round 28,
and the two severe ones are the same failure at different layers: a rule that
was correct in the source, believed by every test, and absent in the thing that
actually runs.

## The toolbars were never hidden

Round 28 withdrew the request-issuing filter toolbars from a denied or
finally-refused page with `<div className="toolbar" hidden={…}>`, and its
commit message said the harm — one refused request and one
`access.permission_denied` per filter change — had been removed. It had not.
`[hidden] { display: none }` is a USER-AGENT rule, so the author's
`.toolbar { display: flex }` beats it no matter how weak the selector. Measured
in jsdom against the real stylesheet: `display: flex`, the `<select>` in the
DOM, and a severity change still issuing
`GET /ops-log?limit=25&severity=ERROR&scope=MANAGEMENT`.

Two independent blindfolds kept the suite green, and neither is specific to
this rule. `styles.css` is not loaded by the web vitest project, so jsdom's own
UA rule won there. And `getByRole` consults the `hidden` IDL property and
short-circuits before computed style, so a role query returns `null` whether or
not the element is painted — an assertion written that way is structurally
incapable of failing on this, for ever.

The rule is now `[hidden] { display: none !important; }`, LAST in the file, and
both halves are load-bearing against different engines. `!important` is what a
browser needs, because `.tabs.vertical button` is (0,3,1) and beats `[hidden]`
at (0,1,0) on specificity whatever the order. Last-in-file is what jsdom needs,
because its cascade is source order only and drops `!important` entirely
(probed: `.t{display:flex}` written after `[hidden]{display:none!important}`
still computes `flex`). Put the rule anywhere earlier and the test that proves
it cannot run.

## `describe.skipIf(true)` defeated the citation checker completely

The checker strips skipped suites so a citation cannot resolve to a test that
never runs. It matched the literal spelling `describe.skip(`. `describe.skipIf`
is a first-class vitest API, and `skip` there is followed by `If`, not `(`.
Probed on `panels.test.tsx`, the file this record cites 46 times: the suite
reported `12 passed | 47 skipped` and the checker printed `ok 178`, exit 0.

It no longer matches a spelling. It reads the modifier chain after `describe` —
every `.name`, with any call group between them consumed — and asks whether any
link in it skips. `runIf` counts, because whether it runs is a runtime value
this script cannot read and the two ways of being wrong are not symmetric.

## Three rules the round shipped with no test at all

A whole-project mutation run by the reviewer deleted the panels toolbar gate,
reverted the panels pager gate and reverted the notifications pager gate, one
at a time. All 277 tests passed each time. The round's prose said the rule had
been applied at "the three places nothing looked"; its mutation table named
one. The pattern the commit message opens with — correct at the site the author
was looking at, absent at the others — reproduced by the fix for that pattern.

The notifications pager needed a second attempt. Written against a 403 the test
passed either way, because `queryState` is `'error'` there and the reverted
gate hides the pager too. The discriminating state is `denied`: a denied query
is `enabled: false`, so it is `isPending` FOR EVER and never `isError`, and the
old gate reads `'loading' !== 'error'` and draws the pager above the "you do
not have access" card.

## One channel closed, a worse one opened

Round 28 made `showHistory` sticky so reopening the revisions pane could not
re-trigger an errored query, and its comment said staying enabled "costs
nothing: this query has no interval". The cost was never an interval. It is
`invalidate()`, which the save mutation runs on success AND on error and which
invalidates that exact key — so a query that used to be `enabled: false` behind
a closed pane became one that refetches on the operator's PRIMARY action, in
the same final 403 for which `retryOf` withholds the Retry button. Measured:
three saves took the revisions request count from 1 to 4, pane shut, unbounded.

The `enabled` callback now states the rule `retryOf` states — after a final
answer there is nothing to fetch — and that immediately made round 28's own
test non-discriminating, because its 403 is covered by the new rule whether or
not `showHistory` is sticky. It is rewritten against a 503, where sticky is the
only thing holding the line. A fix that silently disables the test of the rule
beside it is the same defect class as everything above.

## The 403 arm was fixed and the others left wrong

`refused()` was widened for a 403 and stopped there. `finalAnswer` is broader:
a `ZodError` on the SUCCESS path — which `polling.ts` calls its headline case,
a tab holding a previous release across a deploy — plus 404 and 400. For all of
those the card said "خطا در ارتباط با سرور" and "ارتباط با سرور برقرار نشد.
دوباره تلاش کنید." beside no retry button at all: two false statements, and an
instruction to press something the screen had deliberately removed.

Both sites that draw an error card carried the identical triple of ternaries,
and the round fixed one arm at both. They now call one `errorCopy(query)` that
returns all three keys together. Reverting only the alerts detail to its own
ternaries left all 281 tests green, so that site got its own test before the
structural fix was believed.

## The tail of a file is not part of the skipped suite

Round 28 closed the `describe.skip` hole by deleting from the suite's opener to
END OF FILE: `text.replace(/\bdescribe\s*\.\s*(?:skip|todo)\s*\([\s\S]*/g, '')`.
Nothing under `tests/` skips a suite today, so it never bit. Had one appeared,
every LIVE suite after it would have stopped existing as far as this check is
concerned, and every citation into them would have been reported as fabricated.
That is the same "the instance fixed, the class left open" shape the round it
was fixing is about, reproduced inside its own fix — found by re-reading round
28's own claims against the tree rather than by a test.

A skipped suite now ends where its parenthesis closes. Counting bare parens is
not enough, and the direction it goes wrong in is the dangerous one: a `)`
inside a test title ends the walk EARLY, the tail of the skipped suite survives
the strip, and a citation into a test that never runs resolves. So the walk
skips strings, template literals and comments rather than counting the parens
inside them. Regex literals are not parsed — `\)` is covered by honouring
backslash escapes, and `/[)]/` is stated in the code as the residue rather than
half-handled.

**How these were run.** A file was added to a COPY of `tests/` (`zz-probe.test.tsx`)
holding a `describe.skip` with two tests — the first titled `mentions a stray
paren ) in its title`, the second after it — followed by a live `describe`. The
copy's `EXPECTED` was raised to 179 so that existence, not the count, is what
each run decides. Nothing in the repository tree was modified to run them.

Read VZ's row carefully: its mutation makes the check EXIT 0. The check going
green is the failure being demonstrated, not the mutation surviving.

| #   | rule                                               | mutation                               | what the check prints                                                     |
| --- | -------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| VX  | a test inside a skipped SUITE is still not citable | cite the skipped suite's first test    | exits 1: 1 of 179 cited tests do not exist                                |
| VY  | and only THAT suite is stripped                    | restore round 28's `[\s\S]*` strip     | exits 1: 1 of 179 cited tests do not exist — naming the LIVE suite's test |
| VZ  | a `)` inside a title does not end the suite early  | count bare parens, skipping no strings | exits **0**: green, with a citation into a skipped test resolving         |

## Two more the reviewer found in the checker

`WX` is the `describe.skipIf` hole above. `WY` is the end-of-table rule: round
28 added a COPY of it after the loop for tables at EOF, and the copy could not
fire — `split('\n')` on a file with a trailing newline already yields a final
`''`, a non-`|` line, so the in-loop check had always handled EOF for any file
git and prettier would accept. Its certifying row passed with the rule
reverted, which is the definition of a test that is not a test. There is one
rule now, reached through a sentinel blank line, and it can be falsified.

| #   | rule                                                | mutation                                 | what the check prints                                                            |
| --- | --------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| WX  | a skipped suite is skipped however it is spelled    | match the literal `describe.skip(` again | exits **0**: `ok 178`, with 47 tests skipped and every citation resolving (then) |
| WY  | a table with no separator is checked for at EOF too | drop the one in-loop end-of-table rule   | exits **0**: `ok 178`, with a header-only table appended and unread (then)       |

Read WX and WY the same way as VZ: the mutation makes the check EXIT 0. Green
is the failure being demonstrated.

## The mutations

Every one applied to the tree as committed, run against the whole `web`
project, reverted, and the seven touched files verified byte-identical by
sha256 afterwards. W12 was rewritten after its first attempt left the ternary
unbalanced: it failed, but for a parse error rather than for the scan, and 181
tests never ran. The version below compiles (`tsc --noEmit` exit 0).

| #   | rule                                                       | mutation                                        | tests that die                                                                                                                                                                      |
| --- | ---------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | `hidden` paints nothing, whatever else says `display`      | delete the `[hidden]` rule                      | `stylesheet-contract.test.tsx` › paints nothing for a styled element carrying hidden; › declares that rule important, and last                                                      |
| W2  | …and carries `!important` for a real browser's specificity | drop `!important` (jsdom cannot see this)       | `stylesheet-contract.test.tsx` › declares that rule important, and last                                                                                                             |
| W3  | …and is LAST, or the jsdom half cannot fail                | move it above `.toolbar`                        | (same two)                                                                                                                                                                          |
| W4  | a denied fleet draws no archive filter                     | delete the panels toolbar gate                  | `panels.test.tsx` › withdraws the archive filter from an actor who may not read the fleet                                                                                           |
| W5  | the panels pager goes with the rows                        | gate on `queryState(panels) !== 'error'`        | `panels.test.tsx` › takes the pager down with the fleet it was describing                                                                                                           |
| W6  | the notifications pager goes with the rows                 | gate on `queryState(notifications) !== 'error'` | `control-plane-pages.test.tsx` › takes the notification pager down with the rows it was describing                                                                                  |
| W7  | a final answer is not a connection failure                 | `errorCopy` loses its final-answer arm          | `settings-and-alerts.test.tsx` › does not call a rejected answer a connection failure; `control-plane-pages.test.tsx` › does not call a rejected detail a connection failure either |
| W8  | …at the detail card too, not just the list                 | revert only that site to its own ternaries      | `control-plane-pages.test.tsx` › does not call a rejected detail a connection failure either                                                                                        |
| W9  | a final answer ends the revisions query                    | `enabled: showHistory`                          | `control-plane-pages.test.tsx` › does not refetch a refused history when an unrelated save invalidates it                                                                           |
| W10 | reopening the pane is still not a retry                    | `setShowHistory(open)`                          | `control-plane-pages.test.tsx` › does not refetch a failing history each time the pane is reopened                                                                                  |
| W11 | an empty fleet is named, not left to the generic copy      | drop `isEmpty` from both dashboard cards        | `dashboard.test.tsx` › names the empty thing when the fleet is empty                                                                                                                |
| W12 | the scan sees the negated TERNARY                          | `{!detail.isError ? detail.data && (…) : null}` | `state-switch-contract.test.tsx` › renders no view off a bare isError unless it is a mutation                                                                                       |
| W13 | …and a condition prettier split off the brace line         | `{\n  !detail.isError &&\n  detail.data && (`   | `state-switch-contract.test.tsx` › renders no view off a bare isError unless it is a mutation                                                                                       |
| W14 | "nothing else can fire it" is PRESSED, not asserted        | add one ungated control that refetches          | `settings-and-alerts.test.tsx` › withdraws its own refresh once the refusal is final; › withdraws its filters once the refusal is final                                             |

## Two corrections to this record

`U99`'s row recorded `165 citations were checked; this record declares 171`.
Against the committed tree the same mutation prints `171 … declares 178`: the
transcript had been copied from an intermediate state before `EXPECTED` reached
its final value. A commit whose thesis is that a claim leaving no test behind is
worse than no claim shipped a certifying transcript that did not match its own
tree. Corrected above, and re-run to produce the number now written there.

The "all fourteen call sites" sentence in round 28 is corrected in place, where
it appears.

## What is still not covered

`stylesheet-contract.test.tsx` now guards `[hidden]` against the real cascade,
but only for the four selectors it names. jsdom is not a browser: it decides on
source order and ignores `!important` entirely, so no test in this repository
can observe the specificity half. That half rests on the textual assertion and
on the rule being last in the file, and both are stated in `styles.css` beside
the declaration rather than left to be rediscovered.

# Round 30 — the round that fixed thirteen findings introduced six of its own

The twenty-first fresh-context review returned thirteen confirmed findings
against round 29. Six were defects in round 29's own fixes, and one of those was
severe. The pattern is worth stating plainly rather than buried: a fix written
against a reviewer's evidence tends to cover the state the evidence used and no
other, and the round that is proudest of closing a class is the likeliest to
close one instance of it.

## A rule with half a test is a rule that can be reverted

Round 29 gave the revisions query an `enabled` callback so that a FINAL answer
ends it. Only that half was tested. Replacing `finalAnswer(...)` with the
cruder `query.state.status !== 'error'` passed lint, prettier, `tsc` and all 286
tests — and turns one transient 5xx into a revisions pane dead for the life of
the card, because a disabled query can never be re-triggered by anything. That
is the frozen-screen defect this branch spent four rounds removing, reached
through a simplification no test could see. Worse: with that mutation in place
the sticky-pane test round 29 had just rewritten to be discriminating stopped
discriminating again. One untested half disarmed the test beside it.

The same shape, three more times. The panels toolbar gate, the panels pager
gate and the alerts pager gate were all tested with `denied` only, so
`hidden={denied}` and `{!denied && (` were suite-clean while restoring exactly
the regression they were written to close: on a final refusal — a permission
revoked mid-session — `denied` is still false, the archive filter stays on
screen beside the refusal card, and the pager goes on printing "showing 0" over
rows nobody can see.

## Two error cards nobody swept, one of them the shell's

`errorCopy` was introduced in round 29 so two sites could not give one screen
two diagnoses of one failure. There were four sites, not two.

The shell's session screen is the one that gates every other screen, and it
said the connection could not be established, beside a live Retry, for a **200**
the schema rejected. `pollSession` had already stopped, so that button issued
two doomed requests (`main.tsx` retries once) and nothing would ever ask again.
It now asks `finalAnswer` — the same rule, in the shell's own vocabulary,
because a 403 on the session lookup is not "you may not see this section" and
`refused()`'s copy would be a worse lie than the one being removed.

`messageFor` in `settings.tsx` was the third: `post()` schema-parses a
mutation's response, so a save can throw a `ZodError`, and the fall-through
returned the connection sentence for it.

`app.tsx` has a function of the same name that is NOT a fourth copy, and it is
recorded here because the resemblance is a trap for the next reader. It
collapses every credential failure to one message so the sign-in screen cannot
distinguish an unknown username from a wrong password. Making it "consistent"
with the others would undo that on purpose.

## The checker was defeated twice more, by the class it had just closed

Round 29 replaced the literal `describe.skip(` matcher with a modifier-chain
reader and said the class was closed. It was not:

- `describe['skip']('the panel list', …)` — `ok 194`, exit 0, 56 tests skipped
  in the file this record cites 46 times.
- `describe /*x*/ .skip(…)` — same, because the chain walk skipped whitespace
  and not comments.

Both are now read. A bracket key this script cannot evaluate counts as
skipping, because being wrong that way fails citations loudly and the other way
is the check being green and wrong.

Two more holes the reviewer found in the same script. `/[)]/` — an ordinary
regex assertion — ended the paren walk early and left the tail of a skipped
suite in the text; round 29's comment had called this a "residue… left stated
rather than half-handled", which is documenting a hole rather than closing it.
Regex literals are parsed now. And `it.only` was accepted on the grounds that
".only does run": true of the marked test, false of its sixty siblings, and one
of them produced `ok 194`, exit 0, against `1 passed | 60 skipped`. The checker
refuses `.only` outright, and `vitest.config.mts` sets `allowOnly: false` so a
local gate fails the way CI already did.

## Two assertions that could not fail, again

`declares that rule important, and last` asserted three things, none of which
was lastness: appending `.dist-row { display: grid }` below `[hidden]` left all
286 tests green while re-opening the jsdom seam for that class. It now asserts
that nothing follows.

The "press what is left" loop introduced in round 29 pressed
`queryAllByRole('button')`, which on that screen is the empty list — so it
pressed nothing and compared a number to itself, exactly as the vacuous version
it replaced. It now asserts the SET of operable controls is empty, by name,
including the `<select>` the second test is named for and excluding `hidden`
subtrees, which a person cannot press.

## The mutations

Each applied to the tree as committed, run against the whole `web` project,
reverted, and the six touched files verified byte-identical by sha256 after.
X6 failed to kill on its first run — the `messageFor` fix had shipped with no
test — and the row below is the re-run after one was written.

| #   | rule                                                        | mutation                                                    | tests that die                                                                                                                                                                           |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | a RETRYABLE failure leaves the revisions query enabled      | `enabled: (q) => showHistory && q.state.status !== 'error'` | `control-plane-pages.test.tsx` › asks again after a retryable failure once something invalidates it                                                                                      |
| X2  | the panels toolbar goes on a final refusal, not just DENIED | `hidden={denied}`                                           | `panels.test.tsx` › withdraws the filter and the pager when the fleet is finally refused                                                                                                 |
| X3  | the panels pager likewise                                   | `{!denied && (`                                             | `panels.test.tsx` › withdraws the filter and the pager when the fleet is finally refused                                                                                                 |
| X4  | the alerts pager likewise                                   | `{!denied && (`                                             | `settings-and-alerts.test.tsx` › withdraws the pager once the refusal is final; › withdraws its own refresh once the refusal is final; › withdraws its filters once the refusal is final |
| X5  | the shell does not blame the connection for an answer       | restore the unconditional copy and Retry                    | `shell-recovery.test.tsx` › stops showing a console it can no longer confirm                                                                                                             |
| X6  | nor does a mutation's error report                          | `return t('web.error');`                                    | `settings-and-alerts.test.tsx` › does not blame the connection for a save the server answered                                                                                            |

## The checker probes

Read these the way VZ and WX are read: the mutation makes the check EXIT 0, and
green is the failure being shown.

| #   | rule                                                  | mutation                            | what the check prints                                                         |
| --- | ----------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| K1  | a suite skipped by bracket access is skipped          | read the chain in dot notation only | exits **0**: green, against `52 passed \| 12 skipped (64)`                    |
| K2  | a comment inside the chain does not hide it           | skip whitespace but not comments    | exits **0**: green, with the suite unstripped                                 |
| K3  | `/[)]/` does not truncate the strip                   | leave regex literals unparsed       | exits **0**: green, with the skipped suite's tail citable                     |
| K4  | `.only` makes every citation in that file meaningless | accept `.only` as "it runs"         | exits **0**: green, against `1 passed \| 63 skipped (64)` under `--allowOnly` |

## A standing note about transcripts that quote the count

`U99`'s row was corrected in round 29 to `171 … declares 178` and was stale
again the moment that same commit moved `EXPECTED` to 194. Any row whose
transcript quotes the citation count is a claim about `EXPECTED`, so it must be
re-run in every commit that changes it. The row below is re-run against this
tree, and this paragraph is here so the next round does not have to rediscover
why it drifted.

# Round 31 — five rules revertible with the whole gate green

The twenty-second review reverted four of round 30's rules SIMULTANEOUSLY and
ran everything — typecheck, lint, format, boundaries, i18n, citations, 727 unit
and 290 web tests — all green. That is the strongest form this branch's
recurring finding can take, and the shape of it is worth stating plainly: round
30 was the round about half-tested fixes, and it shipped five of them.

## The half nobody supplied

- **`showHistory`.** The revisions query's `enabled` has three terms and two had
  tests. Dropping the first left 290 green, and costs one
  `GET /templates/:key/revisions` per template card on page load, panes shut —
  against the endpoint the test beside it exists to keep quiet.
- **`denied` over cached rows.** Three pager gates carry `denied ? 'denied' :`
  and nothing exercised it. Round 29's test supplies `denied` from the first
  render, where the query is `enabled: false` and therefore `'loading'`, so the
  gate closes for the wrong reason. Round 30's supplies `denied={false}` with a 403. The state the rule exists for is neither: the shell re-reads permissions
  every 60 seconds, so `denied` flips true while rows fetched a moment ago are
  still on screen.
- **`loading`.** Round 29's record names this as a defect it fixed. Widening the
  gate to accept `'loading'` left 290 green.
- **403 and 404 on the session lookup.** The shell rule is `finalAnswer` and
  only its `ZodError` arm was tested; a `name === 'ZodError'` substitute passed
  everything and restored the connection copy plus a live Retry for answers the
  server gave.
- **`messageFor`'s connection arm.** Round 30 recorded that this fix had shipped
  untested and that a test was written. One arm got a test.

## The checker, defeated five more ways

`onlyMarkers` matched `.only` in dot notation with whitespace only — twenty
lines below the bracket-and-comment-aware reader the same commit had just
written for `describe`. So `it['only']`, `it /*x*/ .only` and `it.only.each`
printed `ok 202`, exit 0. The `describe` reader itself broke on `?.` and never
followed an alias, so `describe?.skip` and `const zz = describe.skip; zz(…)`
went unstripped.

Both scanners share ONE reader now, run over a copy of the source with every
comment, string and regex body blanked. That also removes the `.only`
false-positive on prose — the word in a comment no longer fails the run, which
matters because this file's comments have to be able to name what they forbid.

## Two assertions that still could not fail

`declares that rule important, and last` anchored on
`CSS.lastIndexOf('[hidden]')`, so appending `.dist-row[hidden] { display: grid }`
— the likeliest thing anyone writes near that rule — moved the anchor past the
rule, kept 290 green, and re-opened the jsdom seam for that class. It now
matches the bare `[hidden]` RULE, requires exactly one, and asserts nothing
follows it.

The operable-control set was `button, select, input, a[href]`. A
`<div role="button" tabIndex={0} onClick={refetch}>` and a `<textarea>` both
survived all three "no request-issuing control" tests.

## Row labels are primary keys

Found while renaming: the record carried `Y1`–`Y4` twice, `U13` twice and `U88`
twice, so a citation to any of them resolved to two different rules and neither
could be looked up. One collision was created by the round that wrote the table.
The later duplicates are suffixed, round 30's checker probes are relabelled
`K1`–`K4`, and the check is mechanical now rather than a thing to remember.

## The mutations

| #   | rule                                                 | mutation                                             | tests that die                                                                                                                          |
| --- | ---------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Z1  | the revisions pane is not fetched until it is opened | drop `showHistory` from `enabled`                    | `control-plane-pages.test.tsx` › asks for no revision history until a pane is opened                                                    |
| Z2  | the panels pager goes when the permission goes       | delete `denied ? 'denied' :`                         | `panels.test.tsx` › withdraws the pager when the permission is lost over rows already shown                                             |
| Z3  | …and is not drawn before the first page arrives      | accept `'loading'` in the gate                       | `panels.test.tsx` › draws no pager before the first page has arrived                                                                    |
| Z4  | the alerts pager, when the permission goes           | delete `denied ? 'denied' :`                         | `settings-and-alerts.test.tsx` › withdraws the pager when the permission is lost over rows already shown                                |
| Z5  | …and its loading state                               | accept `'loading'` in the gate                       | `settings-and-alerts.test.tsx` › draws no pager before the first page of alerts has arrived                                             |
| Z6  | a refused session lookup is not a connection failure | `settled = error.name === 'ZodError'`                | `shell-recovery.test.tsx` › says the server refused a %s session lookup, and offers no retry                                            |
| Z7  | …and a 503 still IS one                              | `settled = true`                                     | `shell-recovery.test.tsx` › keeps the connection copy and the retry for a 503                                                           |
| Z8  | a request that never arrived blames the connection   | `finalAnswer(error) \|\| error instanceof TypeError` | `settings-and-alerts.test.tsx` › does blame the connection when the request never arrived                                               |
| Z9  | `[hidden]` is the last RULE, not the last mention    | append `.dist-row[hidden] { display: grid }`         | `stylesheet-contract.test.tsx` › declares that rule important, and last                                                                 |
| Z10 | a keyboard-operable control counts as operable       | add an ungated `<div role="button" tabIndex={0}>`    | `settings-and-alerts.test.tsx` › withdraws its own refresh once the refusal is final; › withdraws its filters once the refusal is final |

## The checker probes

| #   | defeat                                 | before         | what the check prints |
| --- | -------------------------------------- | -------------- | --------------------- |
| Z11 | `const zz = describe.skip; zz(…)`      | `ok`, exit 0   | exit 1                |
| Z12 | `describe?.skip(…)`                    | `ok`, exit 0   | exit 1                |
| Z13 | `it['only'](…)`                        | `ok`, exit 0   | exit 1                |
| Z14 | `it /*x*/ .only(…)`                    | `ok`, exit 0   | exit 1                |
| Z15 | `it.only.each([1])(…)`                 | `ok`, exit 0   | exit 1                |
| Z16 | the word `it.only(` in a PROSE comment | exit 1 (wrong) | exit 0                |
| Z17 | a row label used twice                 | silent         | exit 1                |

Positive controls re-run and still correct: `describe` + newline + `.skip`,
`describe["skip"]`, `describe['sk'+'ip']`, `describe.skipIf` with `/[)]/` inside,
`it.only(`, `test.only(`, `describe.onlyish(` (must not fire), and `a / b / c`
division inside a suite.

## The K transcripts, corrected

Round 30 added the rule that any row quoting the citation count must be re-run
when `EXPECTED` changes, applied it to `U99`, and left the four rows four lines
above it quoting `ok 194` after moving `EXPECTED` to 202. Two numbers there were
wrong in kind rather than degree: "56 tests skipped" was the count of
unresolvable CITATIONS, not of skipped tests, and `1 passed | 60 skipped`
predates both `allowOnly: false` and the tests added since. All four are
re-measured.

# Round 32 — the rewrite regressed the thing it rewrote

The twenty-third review found eight defects. The first is the worst kind
available: round 31's checker rewrite made the checker BLIND, and the commit it
replaced would have caught what it now misses.

## A rewrite that regressed its own parent

`startsRegex` decided a `/` opened a regex whenever the preceding character was
not `)`, `]`, `}` or an identifier character. `<` and `"` are neither — and they
are JSX: `</QueryClientProvider>` and `display="…" />`. `endOfRegex` then ran to
the newline, returned END OF FILE, and `maskLiterals` blanked everything after
it. Measured over the committed tree: **4 of 113 test sources went dark from
some line to EOF**, taking all four `describe(` calls in `shell-recovery.test.tsx`
with them — a file round 31 was editing. A `describe.skip` on the suite holding
round 31's own Z6 and Z7 rows printed `ok 213`, exit 0. The PARENT commit's
checker printed `fail 7 of 213`.

Two changes, and the second matters more than the first. `startsRegex` is an
ALLOW-list now — a regex may follow an operator, a bracket, a comma, a semicolon
or a keyword, and nothing else. And `endOfRegex` returns "not a regex" when it
meets a newline instead of returning the end of the file, so a mis-detection can
never blank more than nothing.

**The root cause was that 269 rewritten lines had no test.** The script was
verified by hand-run transcripts pasted into this record, and a transcript is
run on the file its author is looking at. `tests/unit/falsification-checker.test.ts`
is the first test this script has ever had: 22 cases over JSX, offset
preservation, every skip spelling, every alias shape, every `.only` spelling,
the prose false-positives, and a scan of the real test tree asserting nothing is
blanked. Reverting `startsRegex` and `endOfRegex` to their round-31 forms kills
two of them by name.

## Five more spellings, and one bug the alias feature introduced

`const zz = describe; zz.skip(…)`, `const { skip } = describe; skip(…)`,
`let d; d = describe.skip; d(…)` and `it['on' + 'ly'](…)` all went unread. So
did `const $d = describe.skip; $d(…)` — and that one was new, created by round
31's own alias feature: `$` is a legal identifier character and NOT a word
character, so the generated `\b$d\b` could never match. The opener pattern uses
identifier-char lookaround now. A computed key is one sentinel honoured by both
scanners, rather than fail-closed for `describe` and fail-open for `.only`.

## The third pager gate, and the arm nobody supplied

Round 31's commit message says "**three** pager gates carry `denied ? 'denied' :`
and nothing exercised it", and then tested two of them. Deleting the term at
`NotificationsPage` left the whole gate green — 299 web, 727 unit, lint, format,
typecheck, boundaries, i18n, citations.

The `'empty'` arm was untested at all three. Narrowing `['ready', 'empty']` to
`['ready']` everywhere stayed green, and it hides the design claim's other
direction: page forward onto rows that have since been resolved and the state is
`'empty'`, so the pager vanishes and takes the "تازه‌تر" button — the only way
back — with it.

408 and 429 had no leg either. `finalAnswer` excludes them because a timeout and
a rate limit are what waiting cures; classing them final made the shell say the
server rejected the request while `pollSession` was still asking.

## Two checks that were themselves half-built

The duplicate-label check added last round was a second pass over the raw lines
with no fence tracking, so a fenced ILLUSTRATION of a table row failed the run —
the same rule stated forty lines below for the table loop, absent in the loop
the same commit added. Its pattern also required a digit, so `VX`, `VY`, `VZ`,
`WX` and `WY` were invisible to it and a duplicate among them stayed silent.

The operable-control set was widened to exactly the two shapes the reviewer's
evidence used, and a `<summary>` still survived — which is not hypothetical,
because `content.tsx` records that this codebase once shipped a `<summary>` that
was a retry button. `[tabindex]` is narrowed the other way: `kit.tsx` renders
`<div role="tabpanel" tabIndex={0}>` as a scroll container, so counting it would
have failed these tests for a div and then clicked it. What the selector still
cannot see — a bare `<div onClick>` — is stated in the comment rather than
implied away.

## A note replaced by a check

Round 30 wrote a standing note asking every future round to re-run any
transcript quoting the citation count. Rounds 30, 31 and 32 each left one stale
anyway. The checker enforces it now: a row quoting `ok N` or `declares N` must
match `EXPECTED`, unless it says `(then)` — which is how a superseded transcript
records what the check printed AT THE TIME. Turning it on found three stale rows
nobody had flagged.

## The mutations

| #   | rule                                                  | mutation                                                  | tests that die                                                                                            |
| --- | ----------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| AA1 | masking leaves JSX alone                              | `startsRegex`/`endOfRegex` back to round 31               | `falsification-checker.test.ts` › leaves JSX alone; › reads the real test tree without blanking any of it |
| AA2 | the notifications pager goes when the permission goes | delete `!denied &&` from the gate                         | `control-plane-pages.test.tsx` › withdraws the notification pager when the permission is lost over rows   |
| AA3 | …and is not drawn before the first page arrives       | accept `'loading'` in the gate                            | `control-plane-pages.test.tsx` › draws no notification pager before the first page has arrived            |
| AA4 | an empty page keeps the way back (notifications)      | add `rows.length > 0 &&` to the gate                      | `control-plane-pages.test.tsx` › keeps the way back when a page turns out to be empty                     |
| AA5 | an empty page keeps the way back (panels)             | add `rows.length > 0 &&` to the gate                      | `panels.test.tsx` › keeps the way back when a fleet page turns out to be empty                            |
| AA6 | an empty page keeps the way back (alerts)             | add `rows.length > 0 &&` to the gate                      | `settings-and-alerts.test.tsx` › keeps the way back when an alerts page turns out to be empty             |
| AA7 | a timeout and a rate limit are not final answers      | class 408/429 as final                                    | `shell-recovery.test.tsx` › keeps asking after %s                                                         |
| AA8 | a `<summary>` counts as an operable control           | inject an ungated `<summary onClick>` into the error card | `settings-and-alerts.test.tsx` › withdraws its own refresh once the refusal is final                      |

## The checker probes

| #    | defeat or hazard                         | before         | what the check prints         |
| ---- | ---------------------------------------- | -------------- | ----------------------------- |
| AA9  | `describe.skip` under a JSX-blanked tail | green, exit 0  | exit 1: 8 of 222 do not exist |
| AA10 | `it.only` under a JSX-blanked tail       | green, exit 0  | exit 1: 1 `.only` marker      |
| AA11 | `const zz = describe; zz.skip(…)`        | `ok`, exit 0   | exit 1                        |
| AA12 | `const { skip } = describe; skip(…)`     | `ok`, exit 0   | exit 1                        |
| AA13 | `const $d = describe.skip; $d(…)`        | `ok`, exit 0   | exit 1                        |
| AA14 | `let d; d = describe.skip; d(…)`         | `ok`, exit 0   | exit 1                        |
| AA15 | `it['on' + 'ly'](…)`                     | `ok`, exit 0   | exit 1                        |
| AA16 | a fenced ILLUSTRATION of a table row     | exit 1 (wrong) | exit 0                        |
| AA17 | a duplicate among digit-less labels      | silent         | exit 1                        |
| AA18 | a transcript quoting a superseded count  | silent         | exit 1 (3 found)              |

Control: `describe.onlyish(` still does not fire.

## Three of this round's own rows did not discriminate, and why

`AA4`, `AA5` and `AA6` were written against the reviewer's mutation —
narrowing `['ready', 'empty']` to `['ready']` — and all three left 1895 tests
passing. The reviewer was right that the mutation stays green; the reason was
not the one either of us assumed.

None of the three pager gates passes `isEmpty` to `queryState`, and it defaults
to `false`. `'empty'` was therefore **unreachable at every one of them**: an
empty list yields `'ready'`, the pager draws, and the `'empty'` token was dead.
So the mutation removed dead code, and tests written to catch it could not.

The token is gone and the gates read `!denied && queryState(q) === 'ready'`,
which is what they always meant. The rule the tests actually pin — a zero-row
page keeps its pager, because the "تازه‌تر" button is the only way back — is
falsified by adding `rows.length > 0 &&`, which kills one named test per gate.

`AA8` was backwards on its first run: the selector was narrowed AND an ungated
`<summary>` injected, which is the state where the test is SUPPOSED to pass.
Injecting the `<summary>` with the selector unchanged kills two named tests.

## One flake, recorded rather than re-run away

During the `AA8` run, `web-asset-publication.test.ts › re-copies after a
publication is killed mid-copy, rather than activating what it left` failed at
**8116 ms**. In isolation it passes: 3 runs, 20/20 each time. It failed once,
under a full-suite run concurrent with a mutation sweep. Not reproduced since,
not fixed, and named here so the next reader does not rediscover it. It is the
third load-dependent flake recorded on this branch and the first outside the
real-socket tests; the failure output beyond the name was not captured, which
is a gap in how the sweep collects evidence rather than a claim about the test.

# Round 33 — the fix for the blind spot was one character wide

The twenty-fourth review found ten defects. The first is round 32's own fix,
failing in the direction round 32 created.

## An allow-list with one character missing

Round 32 replaced the deny-list in `startsRegex` with an allow-list and wrote
that "a mis-detection can never blank more than nothing". That was true only of
mis-detections in the direction it had just closed. `>` was not in the list, so
`(v) => /['"]/.test(v)` — a concise arrow body, the commonest idiom in the
language — did not read as a regex; the `'` inside the character class opened a
PHANTOM STRING, and masking ran to the next quote anywhere in the file.
Measured: a `describe.skip` that the checker caught (`fail 8 of 222`) went back
to `ok 222`, exit 0, when one such line was added above it.

The real guard is not the allow-list. **A `'` or `"` string cannot span a
line**, and `endOfQuote` now says so, exactly as `endOfRegex` already did. That
makes the claim true in both directions at once: whatever the heuristic decides,
the damage cannot leave the line. Only once that held was `>` admitted, which is
what makes an arrow body work.

## A renamed sentinel that left its guard behind

`readChain` re-reads a bracket key from the source when the masked copy yields
the computed-key sentinel — and the guard still tested for the literal `'skip'`,
which is what the sentinel used to be called before round 32 renamed it. So the
re-read never ran, every bracket key stayed `COMPUTED`, and
`describe['skip'](…)` was reported as **a `.only` marker**: a false statement
about a file, printed by the check whose entire subject is false statements. It
also made two of round 32's new unit cases pass for the wrong reason.

## Rules pinned only in pairs, and rules pinned not at all

Round 32's row `AA1` reverted `startsRegex` and `endOfRegex` together. With
either half present the other is unreachable, so each reverted alone with the
whole gate green. Seven checker rules are now falsified one at a time, and the
seven mutations kill seven named tests.

Four more had no test at all: the alias-of-bare-`describe` rule, and all three
record-level rules (fence tracking in the label loop, fence tracking in the
stale-count loop, the label pattern). Those two loops sat in the script body
where no test could reach them; they are one pure `recordIssues` function now,
with fixtures.

## Two checks that made false claims about the record

The stale-count pattern had no left boundary, so `took 812 ms` read as
`ok 812` — and this record's genre is timings. The label pattern, widened last
round to admit `VX`/`WY`, also asserted that every capitalised first cell is a
row label, so a `| verdict |` table with two `Green` rows failed for a duplicate
that is not one. A label is now the first cell of a row in a table whose first
column is `#`.

## One more spelling

`import { describe as d }` needs no local binding and reached neither alias
pattern. A `d.skip(` suite skipped nine tests with the check reporting `ok`,
exit 0.

## Two rows in this record were false

`AA2`'s mutation column named `denied ? 'denied' :`, a token the same commit had
deleted from all three gates — the row reproduces once translated, but as
written it could not be applied to the tree it certifies. `AA8` cited the
mutation that was run FIRST, found to be backwards, and then left in the table
while the corrected experiment went into the prose. Both are restated.

## The mutations

| #   | rule                                               | mutation                               | tests that die                                                                                         |
| --- | -------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| AB1 | a regex opens after `=>`                           | drop `>` from the allow-list           | `falsification-checker.test.ts` › recognises a regex in a concise arrow body                           |
| AB2 | a `'`/`"` string cannot span a line                | delete the newline arm of `endOfQuote` | `falsification-checker.test.ts` › lets an unterminated quote blank nothing past its own line           |
| AB3 | a literal bracket key is read from the source      | guard the re-read on `'skip'` again    | `falsification-checker.test.ts` › reads a literal bracket key rather than calling everything computed  |
| AB4 | an alias of bare `describe` is not always-skipping | `always.push` for every alias          | `falsification-checker.test.ts` › treats an alias of bare describe as describe, not as always-skipping |
| AB5 | an import rename rebinds `describe`                | drop the import-rename reader          | `falsification-checker.test.ts` › finds a suite skipped through an import rename                       |
| AB6 | a label lives in a `#` table                       | treat any table as a label table       | `falsification-checker.test.ts` › does not treat a capitalised word as a label outside a # table       |
| AB7 | `took 812 ms` is not a citation count              | drop the left boundary                 | `falsification-checker.test.ts` › leaves a row marked (then) alone, and does not read "took" as "ok"   |

Each applied alone and reverted; the script verified byte-identical by sha256
after each.

## Three of this round's own rows asserted the wrong function

The three fixtures added for the parser rewrite — JSX text, template literals,
and reading a `.ts` file as TypeScript — all passed with the rule they name
deleted. Not because the rules are dead: because the fixtures asserted through
`titles`, and `titles` reads the RAW text. `withoutSkippedSuites` returns the
source with skipped suites cut out of it, so a mask defect is invisible there
unless it happens to move a cut.

The mask feeds the CHAIN READERS. Measured over all 249 sources under `tests/`,
`apps/web/src` and `apps/api/src`, with each blanking kind removed one at a
time:

```
sources compared: 249
no-jsxtext         mask-differs:  4  titles-differ:  0  only-differ:  0
no-notemplate      mask-differs: 41  titles-differ:  0  only-differ:  0
no-templateparts   mask-differs:157  titles-differ:  0  only-differ:  0
always-tsx         mask-differs:  1  titles-differ:  0  only-differ:  0
always-ts          mask-differs: 16  titles-differ:  0  only-differ:  0
```

Zero in both observable columns is what a fixture aimed at `titles` was
measuring. The rules are still load-bearing — the inputs that show it are prose
quoting `it.only(`, which `onlyMarkers` then reports as a real marker, and a
generic arrow in a `.ts` file, after which a real `describe.skip` is inside the
blanked run and its parked titles resolve as though they run. Both are now the
assertion.

## A comment that measured something and then said something else

The `ScriptKind` comment claimed that parsing every file as TSX made "all five
`it(` calls in `notification-claim-exclusivity.test.ts` disappear from the mask,
so its titles were invisible". Measured on the current implementation: the mask
does lose 1451 of that file's 8891 characters — it is the only source on the
tree the mutation damages — and all five titles still resolve, because the
blanked run falls between them.

The claim was true of a version four rewrites ago and was carried forward
unchecked, which is the failure this record exists to catch, in this record's
own supporting file. The comment now states the measurement and names the real
cost, which is the false negative rather than a lost title.

## The one alias shape a single-file scan cannot follow

`import d from './helpers'` re-exporting `describe`, then `d.skip('x', …)`,
contains no token this script can bind — measured, the parked suite's titles
come back as `['hidden', 'shown']`. Following it needs the other file.

The namespace form needs nothing: `v.describe.skip(` still contains the token
`describe`, and the identifier lookaround admits it because the preceding
character is a dot. Verified rather than assumed.

Refusing to be silently wrong about the shape it cannot follow costs nothing.
Any skipping modifier called on an unresolvable receiver is now an error, the
same policy this script already applies to an unrecognised table header.
Measured over the 109 sources in `tests/`, across `skip`, `only`, `todo`,
`skipIf` and `runIf`: zero, so the guard starts green and a red run means a new
alias rather than a backlog.

## The mutations

| #    | rule                                                 | mutation                              | tests that die                                                                                             |
| ---- | ---------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| AC1  | JSX text is blanked                                  | drop `JsxText` from the blanked kinds | `falsification-checker.test.ts` › does not read an it.only written out as JSX TEXT                         |
| AC2  | a plain template body is blanked                     | drop `NoSubstitutionTemplateLiteral`  | `falsification-checker.test.ts` › does not read an it.only written out inside a template literal           |
| AC3  | an interpolated template's HEAD is blanked           | drop `TemplateHead`                   | `falsification-checker.test.ts` › blanks all three parts of an interpolated template, not just a plain one |
| AC4  | an interpolated template's MIDDLE is blanked         | drop `TemplateMiddle`                 | `falsification-checker.test.ts` › blanks all three parts of an interpolated template, not just a plain one |
| AC5  | an interpolated template's TAIL is blanked           | drop `TemplateTail`                   | `falsification-checker.test.ts` › blanks all three parts of an interpolated template, not just a plain one |
| AC6  | the script kind follows the extension                | force `ScriptKind.TSX` for every file | `falsification-checker.test.ts` › reads a .ts file as TypeScript rather than as TSX                        |
| AC7  | string bodies are blanked                            | drop `StringLiteral`                  | `falsification-checker.test.ts` › does not report a .only that is only mentioned in %s                     |
| AC8  | regex bodies are blanked                             | drop `RegularExpressionLiteral`       | `falsification-checker.test.ts` › recognises a regex in a concise arrow body                               |
| AC9  | an unresolvable modifier receiver is reported        | `continue` on every receiver          | `falsification-checker.test.ts` › reports a skip on a receiver it cannot resolve, rather than ignoring it  |
| AC10 | the resolved set carries the aliases and the globals | resolve only bare `describe`          | `falsification-checker.test.ts` › reports a skip on a receiver it cannot resolve, rather than ignoring it  |
| AC11 | the guard reads the MASK, not the source             | scan `text` instead of `masked`       | `falsification-checker.test.ts` › finds no unresolvable modifier in the committed test tree                |

Each applied alone with an anchor assertion that fails the run if the edit does
not land, and reverted; the script verified byte-identical by sha256 after each.

`typecheck:tests` refused this round's first gate. The suite now imports the
`.mjs` script instead of slicing it through a `data:` URL, and an untyped
import is `TS7016` under `noImplicitAny`. It is answered with `allowJs`, so
TypeScript infers the exports from the script rather than from a hand-written
`.d.mts` that would be free to drift from it. That the import is genuinely
typed is itself a claim, so it has a probe rather than a comment: a
`@ts-expect-error` in the suite fails the BUILD the day that module degrades to
`any`.
AC7 also kills `does not report a .only mentioned in a multi-line JSX attribute`,
and AC11 also kills AC9's test; both are stated rather than split into rows,
because a row is a rule and these are one rule each.

## A save nobody asked for, reachable from the preview box

`TemplateCard` wraps the editor, the placeholder table, the preview pane and
the revisions pane in one `<form onSubmit={onSubmit}>`, and `onSubmit`
unconditionally saves. The preview's per-placeholder sample fields are ordinary
enabled inputs inside that form, and the Preview control is `type="button"`, so
Enter never previewed.

For an actor with `templates.view` and not `templates.edit`, `mayEdit` removes
the only submit button. HTML's implicit-submission rule then applies: a form
with no submit button and exactly ONE field that blocks implicit submission
submits when Enter is pressed in that field. `bot.ping.reply` declares exactly
one placeholder, so that card is precisely that shape — Enter in its sample box
issued `POST /templates/bot.ping.reply`, which the server refuses on
`templates.edit`, writing a `DENIED` audit row and an
`access.permission_denied` operational event, and putting a red error about a
save they never asked for on a screen with no Save button.

With `templates.edit` it is worse in a quieter way: the first submit button in
tree order is Save, so Enter in any sample field stored the draft body instead
of rendering a preview.

Two rules, because one does not cover the other. Enter in a sample field now
PREVIEWS — which is what the operator typing a sample value is asking for — and
`preventDefault` is what stops the save; and the form refuses any submit that
no submit control produced, which is the backstop for the field somebody adds
next. The second was itself wrong on the first attempt: `submitter === null`
missed an event that is not a `SubmitEvent` at all, so the rule is stated as a
positive instead.

## An empty filter answered with more rows than were asked for

`?scope=` is an empty string, which is falsy, so the key was dropped and
`opsLogQuerySchema`'s `ALL` default applied: `?scope=BOGUS` was a 400 and
`?scope=` a 200 carrying the routine stream — one line below the comment
promising it could not be. The `open` parameter directly above it had been
moved to `=== undefined` one round earlier for exactly this reason, and
`scope`, `severity`, `code`, `since` and `until` were left on the truthiness
spelling. `?since=` was worse: `new Date('')` is an Invalid Date that reaches
the driver.

All five now say present-or-absent, `code` gained `min(1)` so an empty one is
refused rather than silently meaning "no filter", and the two timestamps are
parsed by a helper that answers 400 the way `cursorFrom` already did.

## Sixteen rules that reverted with the whole gate green

An adversarial reviewer applied one mutation at a time to `content.tsx`,
`settings.tsx`, `app.tsx`, `system.tsx` and `theme.ts`: 306 of 306 web tests
passing, every time. Nineteen other mutations in the same sweep each killed
between one and eight tests, so the harness was live and these rules simply had
nothing pointing at them. The whole template PREVIEW feature — button, sample
fields, staleness marker, unresolved list — had no case in `tests/web/` at all.

Two are worse than untested. This record says of round 19's settling bug:
"`settings.tsx` and `content.tsx` had round 19's settling bug unfixed … Both
now guard on their own mutations' `isPending`." The mutation table under that
sentence cites `panels.test.tsx` four times and neither sibling — the rule
fixed and covered where the author was looking, and shipped uncovered in the
two files the same paragraph names.

## Four of this round's own tests could not fail either

The first versions of `AD1`, `AD2`, `AD12` and `AD13` all passed with the rule
they name deleted, and the two reasons are worth keeping.

The basis-version pair moved the stubbed route body and pressed Save with
nothing REFETCHING in between, so `template` was still the row `basis` was
taken from and both spellings sent the same number. They now drive the refetch
the way production drives it — a conflicting save invalidates the query — and
wait for the conflict banner before pressing Save again.

The settling pair held the POST pending, which never reaches the adopt at all:
`basis` and the cached row stayed equal, so the banner could not appear with or
without the guard. They now let the save SUCCEED with a new version and hold
the refetch it awaits open instead, which is the actual window the guard exists
for.

## A citation could resolve against prose

`titles` was the one reader in `check-falsification-citations.mjs` that ran
over the raw source while every other ran over the mask, so an `it('…')` inside
a comment or a string counted as a committed test — the "resolves to prose, not
to a test" failure the script exists to prevent, in the script itself. Measured
over the committed tree: 23 `it(` calls live inside string fixtures in
`falsification-checker.test.ts` alone, and no citation depended on one, so the
channel was open rather than exercised. It now matches on the mask and reads
the title from the source, which keeps `it.each` placeholders and template
titles exact.

## Two claims that were false, and one that had no test

The panels archive comment said the mode lives in the URL so an operator can
"link to the archive, reload without losing it, and use Back". `setQuery`
navigates with `replace: true`, so switching mode overwrites the `/panels`
entry and Back leaves the page. Replacing is the right behaviour for a filter —
`/system` argues the same case correctly by stopping at linking and refresh —
so the comment is corrected and the behaviour now has a test that fails if it
changes.

`docs/phase3d-coverage-ledger.md` cited `ops-log?scope=MANAGEMENT` for `/`,
where the dashboard asks for `MANAGEMENT_CONDITIONS`. The difference is the fix
this branch made so the needs-attention card is not buried under one-shot
records nothing can resolve, and the ledger's own header says it is "kept true
as the work landed".

## One finding recorded rather than fixed

The `lastSeenAt`/`createdAt` keyset cursors on `/ops-log` and `/notifications`
serialise a `Date` to millisecond ISO, while `panels` deliberately renders its
cursor with `to_char(… .US …)` because "a cursor read as a Date is strictly
below the row it names". Every writer supplies those columns from the `Clock`,
which is millisecond precision, so the truncation is a no-op today and no
skipped row could be produced. It is a latent difference between two cursor
readers in one codebase, not a defect with a failing case, and it is written
down here rather than fixed on a guess.

## The mutations

| #    | rule                                                | mutation                             | tests that die                                                                                      |
| ---- | --------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| AD1  | a save carries the DRAFT BASIS version              | send `template.version`/`revision`   | `editor-rules.test.tsx` › sends the version the DRAFT was based on, not the row the query now holds |
| AD2  | the conflict notice waits for our own write         | drop both `isPending` terms          | `editor-rules.test.tsx` › does not blame somebody else for the write this card just made            |
| AD3  | changed-elsewhere reads the REVISION too            | drop the revision half of the `\|\|` | `editor-rules.test.tsx` › sees a revert as a change even though it restarts the version at 1        |
| AD4  | the preview input includes the sample values        | `JSON.stringify([draft])`            | `editor-rules.test.tsx` › calls the preview stale when the SAMPLE VALUES move, not only the body    |
| AD5  | the staleness marker comes from the VARIABLES       | read `previewInput` from the closure | `editor-rules.test.tsx` › marks a preview stale against the input the REQUEST used                  |
| AD6  | the unresolved-placeholder list                     | gate it on `false`                   | `editor-rules.test.tsx` › names the placeholders the preview left unresolved                        |
| AD7  | Enter in a sample field previews                    | delete the `onKeyDown`               | `editor-rules.test.tsx` › previews on Enter in a sample field, and does not save                    |
| AD8  | a submit needs a real submit control                | delete the `submitter` guard         | `editor-rules.test.tsx` › ignores a submit that no submit control produced                          |
| AD9  | a save that stored nothing says so                  | always render `web.saved`            | `editor-rules.test.tsx` › says a save stored nothing when the server says it changed nothing        |
| AD10 | the unsaved-changes notice and discard              | gate it on `false`                   | `editor-rules.test.tsx` › offers to discard an unsaved edit, and says there is one                  |
| AD11 | the suppressed-override warning                     | render nothing                       | `editor-rules.test.tsx` › warns when a stored override is being suppressed                          |
| AD12 | the settings save carries the BASIS version         | send `setting.version`               | `editor-rules.test.tsx` › sends the version the DRAFT was based on                                  |
| AD13 | the settings conflict notice waits                  | drop the `isPending` term            | `editor-rules.test.tsx` › does not blame somebody else for the write this editor just made          |
| AD14 | the settings field remounts on a new basis          | `key={setting.key}`                  | `editor-rules.test.tsx` › resets the typed value when the editor is re-based on a fresh row         |
| AD15 | `?section=` is narrowed to known sections           | accept any non-null value            | `editor-rules.test.tsx` › falls back to the status section for a `section` it does not know         |
| AD16 | `system` follows the operating system               | always return `'dark'`               | `editor-rules.test.tsx` › follows the operating system only while the choice is `system`            |
| AD17 | the sidebar stops following once the operator picks | drop the `touched` guard             | `editor-rules.test.tsx` › follows the viewport until the operator decides, and then stops           |
| AD18 | `scope` is present-or-absent                        | back to `query.scope ? … : {}`       | `web-admin-v2.test.ts` › refuses an empty filter rather than widening the read                      |
| AD19 | `severity` is present-or-absent                     | back to truthiness                   | `web-admin-v2.test.ts` › refuses an empty filter rather than widening the read                      |
| AD20 | `code` is present-or-absent                         | back to truthiness                   | `web-admin-v2.test.ts` › refuses an empty filter rather than widening the read                      |
| AD21 | `since`/`until` are parsed or refused               | back to `new Date(query.since)`      | `web-admin-v2.test.ts` › refuses an empty filter rather than widening the read                      |
| AD22 | an empty `code` is not a code                       | drop `min(1)` from the schema        | `web-admin-v2.test.ts` › refuses an empty filter rather than widening the read                      |
| AD23 | `titles` matches on the MASK                        | run the pattern over the raw text    | `falsification-checker.test.ts` › does not resolve a citation against an it( written in prose       |
| AD24 | `setQuery` replaces, never pushes                   | drop `{ replace: true }`             | `router.test.tsx` › replaces the history entry rather than pushing one                              |

Each applied alone with an anchor assertion that fails the run if the edit does
not land, and reverted; every touched file verified byte-identical by sha256
after each. AD18–AD22 share one test because they are five spellings of one
rule and the test asserts all five.

A note on this round's own harness. The mutation sweep was killed by a worker
restart between writing a mutation and restoring it, and left `content.tsx`
carrying AD7's revert. It was found by `git status` and the residue grep the
project rules require before any commit that follows agent work — which is
exactly the scenario that rule was written for, and the first time on this
branch it has actually fired.

## A repeated query parameter was a 500, in the line rewritten to stop 500s

`@Query()` was typed `Record<string, string | undefined>` in both list
controllers, and that was a lie. Fastify's default parser yields an ARRAY when
a key repeats, so `?severity=ERROR&severity=WARN` handed
`query.severity.split(',')` an array; the `TypeError` is not a `NexaError`, a
`ZodError` or an `HttpException`, so the error filter answered
`500 internal.unhandled`. Measured against the adapter this application
constructs, on fastify 5.12.1:

```
{"severity":["ERROR","WARN"],"code":"a","limit":""}
```

The expression that threw is the one the previous round rewrote to stop
`new Date('')` reaching the driver. Every other parameter survived the same
input only because it happened to reach a zod schema before anything called a
string method on it — luck, not a rule, and `severity` was the single site
where the luck ran out.

The type is honest now and `singleValued` is the only way from it to the record
the handlers want. It is shared, so `/panels` goes through it too: nothing there
calls a string method, so its schema already refused the array, and leaving that
one on the lie is exactly how the previous round's defect happened.

## The sixth sibling

`?limit=` is an empty string and was falsy, so `GET /ops-log` answered 200 with
the default page while `?limit=0`, `?limit=-1` and `?limit=many` were all 400 —
the same parameter on the same call, an empty value silently treated as unsent.
It is the sixth sibling of the five corrected in the round before, twenty lines
above the comment naming that defect class, and the `notifications` reader
below it already spelled it `=== undefined`.

## The fix for the last round's defect introduced this one

The Enter handler added to the preview sample fields called `runPreview`
directly, while the Preview button beside it carries
`disabled={preview.isPending}`. So Enter twice started two preview mutations at
once. react-query drops the older one's RESULT and still runs its `onSuccess`,
and `onSuccess` is what records `previewedInput` — so a late first response
marks the displayed second render as current for an input it was not rendered
from. That is "a preview that is not of the thing you are looking at", which is
the one confusion the staleness marker exists to end, reintroduced by the fix
for a different defect in the same file, in the same commit.

## Half of a two-part rule had no test, and could not have had that one

The Enter handler is two rules: it previews, and `preventDefault` is what stops
the save. `AD7` mutated only the handler as a whole, which the preview
assertion kills; deleting `event.preventDefault()` alone survived the entire
gate. The test named for it — "previews on Enter in a sample field, and does
not save" — cannot detect that, because **jsdom does not implement implicit
form submission at all**, so its no-save assertion is true in that fixture
whatever the production code does.

It matters most in the case the `submitter` backstop does NOT cover: when Save
is rendered, implicit submission clicks it, `submitter` is a legitimate element
and the guard passes. Cancelling the keystroke is the only thing between Enter
in a sample box and an unasked-for save. The assertion is now the cancellation
itself, on a real event object, plus a non-Enter key that must NOT be cancelled
so the handler is a rule rather than a blanket swallow.

## An assertion of this round's own that could not fail

The repeated-parameter test first asserted a 400 from `/panels`. Measured by
removing the panels guard and re-running: 36 of 36 still green, because
`panelListQuerySchema` refuses the array by itself. A status assertion there is
satisfied by the luck the guard exists to replace. It asserts the error CODE
and message now — that the refusal is the guard's, uniformly, rather than
whichever validator the value reached first — and that mutation kills it.

## The mutations

| #   | rule                                         | mutation                                   | tests that die                                                                              |
| --- | -------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| AE1 | a repeated query parameter is refused        | make the `singleValued` check never fire   | `web-admin-v2.test.ts` › refuses a repeated query parameter instead of throwing on it       |
| AE2 | `/panels` uses the SAME guard                | cast the raw record instead of guarding it | `web-admin-v2.test.ts` › refuses a repeated query parameter instead of throwing on it       |
| AE3 | `limit` is present-or-absent                 | back to `query.limit ? … : DEFAULT`        | `web-admin-v2.test.ts` › refuses an empty limit rather than answering with the default page |
| AE4 | Enter in a sample field is cancelled         | drop `event.preventDefault()`              | `editor-rules.test.tsx` › cancels the Enter key, which is what stops the save               |
| AE5 | the keyboard path respects the pending guard | drop `if (preview.isPending) return;`      | `editor-rules.test.tsx` › does not start a second preview while one is in flight            |

Each applied alone with an anchor assertion that fails the run if the edit does
not land, and reverted; every touched file verified byte-identical by sha256
after each.

`U99` was re-stated from an ASSUMPTION before it was measured. Its row quotes
the pair the checker prints when this round's own mutation table is fenced, and
the probe that produces it anchored on the FIRST such table in the file — which
is a previous round's, now that there are several. Run as written it printed
`245 / 269`, not the `264 / 269` already in the row. The probe takes the LAST
table now and the measured pair is the one recorded. The number happened to be
right; it was written before anything checked it, which is the order of
operations this record has a standing note about.

## A claim about the server that was never true

`apps/web/src/api/client.ts` told the next reader that "the server rejects a
cursor it did not mint, so a 'clever' client-side cursor is a 400 rather than a
subtle bug". It does not. `decodeCursor` returns `null` for every unreadable
cursor, a `null` cursor drops the keyset predicate, and
`GET /panels?cursor=<anything>` answers **200 with page one** — so a client
that truncates or invents a cursor loops on the first page and is never told,
which is precisely the subtle bug the sentence promised could not happen.

It was never true: `decodeCursor` has returned `null` since the commit that
introduced it, and that commit is an ancestor of the one that wrote the claim.

The behaviour is deliberate — `decodeCursor`'s own comment argues that refusing
a legal-but-unknown id would restart the traversal for ever instead of failing
it — and `panels-http.test.ts` pins it against fifteen malformed cursors (thirteen when
this was written; corrected in place rather than left to drift a fourth time).
It
is also the OPPOSITE of the rule this branch gave the other two cursors:
`/ops-log` and `/notifications` refuse an unreadable or half-supplied cursor
with a 400, and the comment there gives this exact looping as the reason.

Two defensible rules, described in two files that contradicted each other, with
no third place to settle it — the test's own comment said "the documented
behaviour ... is to restart the traversal" and nothing documented it.
`panelListQuerySchema` carries the rule now, says why the two differ, and says
that neither side may be changed to match the other without changing that
paragraph and the test that pins it. Both behaviours already have tests; what
was missing was a true sentence.

## An omission in a rationale that enumerates its exclusions

`panel.probe.limited` / `panel.probe.ok` are a real condition pair — dedupe-
keyed, opened when a tenant's outbound-probe budget is spent by
`testConnection`, closed by the next probe that succeeds. Their twin one lane
over, `panel.monitor.tenant_budget_*`, is in the conditions scope and appears
on both the Alerts page and the dashboard's needs-attention card. The probe
pair is in neither list and is not mentioned in the paragraph that enumerates
every entry and every deliberate exclusion.

Judged and kept excluded, with the reason now written down: the monitor lane
runs unattended, so a budget it exhausts is discoverable only from a durable
record, while the operator lane exhausts it by a person pressing a button and
answers that person with a `RATE_LIMITED` error in the same second. A
management page carries what nobody has been told.

The consequence is stated rather than hidden: an open `panel.probe.limited` row
is reachable from no Web Admin screen, because every screen asks for
`MANAGEMENT` or `MANAGEMENT_CONDITIONS` and owner revision 25 removed the
general log browser. And the decision is asserted rather than left to prose,
because the next person to add a condition will copy the twin.

## A refusal that did not say what to send instead

`severity` on `GET /ops-log` is genuinely multi-valued and takes a
COMMA-SEPARATED list, so the repeated-key encoding that `URLSearchParams.append`
and most HTTP clients emit is refused by the guard added a round earlier. Before
that guard it was a 500, so this is an improvement rather than a regression —
but the message stopped at "supplied more than once" and left the comma form
discoverable only by reading the source.

## The mutations

| #   | rule                                            | mutation                                  | tests that die                                                                                           |
| --- | ----------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| AF1 | the operator probe lane stays out of the scopes | add `panel.probe.limited` to the failures | `web-money-and-scope.test.ts` › keeps the operator probe lane out of the management scopes, deliberately |
| AF2 | the refusal names the accepted encoding         | empty the second sentence                 | `web-admin-v2.test.ts` › refuses a repeated query parameter instead of throwing on it                    |

Each applied alone with an anchor assertion that fails the run if the edit does
not land, and reverted; the contracts package rebuilt around the first, because
every suite resolves `@nexa/contracts` through the workspace link to its `dist`
and a contracts mutation without a rebuild tests nothing. Both files verified
byte-identical by sha256 afterwards.

AF1 kills four tests, not one: the completeness, pairing and routine-stream
assertions all notice the added code as well. That is the list working as
designed and is stated rather than presented as four separate rows.

The three corrections above this table are claims rather than rules, and two of
them are load-bearing prose with no mutation of their own: the cursor asymmetry
is already pinned from both sides by `panels-http.test.ts` and
`web-admin-v2.test.ts`, and what was wrong was the sentence describing them.
Saying so is the honest entry; inventing a row for a comment would not be.

## A shared component's docstring named the wrong keyset for all three of its callers

`CursorPager` — new on this branch, mounted by panels, alerts and notifications
— told the reader that "`nextCursor` encodes `(name, id)`". None of the three
does: panels keyset on `(created_at, id)`, alerts on `(first_seen_at, id)` —
`(last_seen_at, id)` when this was written, and corrected here in place, since
leaving it made this a seventh copy of the claim in the entry recording the
correction of the other six —
notifications on `(created_at, id)`. `(name, id)` is the keyset the panel page
was MIGRATED OFF, by 0026, because `name` is mutable and a rename moves a row
across a cursor so it is returned twice or never — which
`panels/application/ports.ts` spends six lines explaining. A reader who took the
docstring at face value would put the mutable column back.

The identical claim sat in the frozen spec, and this branch ORPHANED it: on
`main` it documented `panelListQuerySchema`, and two docblocks added to
`http.ts` in this branch pushed it away from that schema, so it documented
nothing at all — thirty lines above a new docblock in the same file describing
the same cursor correctly. Merged into the schema's own docblock, with the
claim removed. The pager's docstring no longer names the cursor's contents at
all, which is what made it wrong.

## The monitor config refused the value its own error message advised

`healthyCadenceFitsFreshness` requires `interval * 1.1 + tick < 900000`;
`maxHealthyIntervalMs` advertised `floor((900000 - tick) / 1.1)`. Two
expressions of one rule, and they disagree wherever floating point says they
do: `720000 * 1.1` is `792000.0000000001`, so with
`PANEL_MONITOR_TICK_MS=108000` the schema refused `HEALTHY_INTERVAL_MS=720001`,
advised "at most 720000", and then refused 720000 as well. The process does not
boot and the instruction it prints cannot be followed.

**This predates the branch** — both functions are unchanged from `main`. It is
fixed here because this branch re-sized the monitor defaults these functions
judge, and because `monitor-profile.test.ts` re-asserts the same round-trip at
the same single tick.

Rounding differently would only move the boundary, so the ceiling is no longer
a second formula: it is defined as the largest value the predicate accepts, and
walked down to it. The test asserts BOTH halves — accepted, and one more
refused, so a ceiling of `1` cannot pass — at 601 ticks across the admissible
range rather than the one tick that happened not to break.

## Two rules whose only definition was the line itself

Both reverted with the whole web suite green.

`panels.tsx` disables Restore while the replacement-name field is empty. That is
the guard against a press whose only possible outcome is a 400, since
`panelNameSchema` has a minimum length. `router.ts`'s `setQuery` treats `''` as
"delete the parameter" rather than writing `key=` — which matters the moment a
filter is driven by a text input, because every empty query parameter on the
list endpoints now answers 400 rather than widening the read, so a cleared
search box would become an error.

The restore test's first version failed for a reason worth keeping: it stubbed
`/panels/p1/status`, but `PanelDetailPage` is asked for `p1` and writes to the
id the SERVER returned, so the 409 arrived as an unrouted 404 and the rename
field never opened. A stub keyed on the route parameter tests the wrong URL.

## The webfont was served `no-store`, and its absence answered 200

`styles.css` names `/fonts/Vazirmatn-Variable.woff2`; `routes.caddy` matched
only `/assets/*`, so the font fell through to the SPA handler and inherited two
of its properties, both wrong for a 111 KB binary that never changes:
`Cache-Control "no-store"`, so every admin page load re-downloaded it, and
`try_files {path} /index.html`, so a font that failed to ship was answered with
the HTML document and a **200**. A missing font that returns 200 is an
invisible failure — the page renders in the fallback family and nothing says
why.

The font now has its own block with a week's cache and no `try_files`, so a
missing file is the 404 it is; `check-image.sh` asserts the file by name, which
is the last place a font that did not ship can be made loud; and the CSP comment
that said "one module script and one stylesheet" no longer stops one asset class
short of the truth.

## Two findings recorded rather than fixed, both raised twice now

**The two new cursors truncate microseconds.** `/ops-log` and `/notifications`
read a `timestamptz` into a JavaScript `Date` and re-send `toISOString()`, which
is millisecond precision. `PanelCursor` spends twenty lines on exactly this
hazard and the panel query was hardened against it — `to_char(… .US …)` and an
explicit `::timestamptz` — because "the driver TRUNCATES rather than rounds".
The two cursors this branch ADDED do the opposite of the sibling whose
rationale argues the case, which is this branch's own recurring shape.

Unreachable today, verified twice independently: `operational_events` has no
`defaultNow()` and `notifications.created_at` is written from `input.now`, both
from the `Clock` at millisecond precision. Not fixed here for one reason: the
fix is a change to both readers' SQL, and nothing in this system can produce a
sub-millisecond row, so there is no way to make the fix fail before it is
applied. A fix that cannot be falsified is what this record exists to refuse.

**The alerts pager keysets on a mutable column.** `last_seen_at` is rewritten by
every repeat occurrence of a deduped condition — that is what the occurrence
counter is for — so a row below the operator's cursor that recurs jumps above it
and is returned on no subsequent page. It is the argument that moved the panel
keyset off `name`, applied to the one subsystem whose stated rule is that
silence is the outcome it may not produce. Bounded in practice: within
`MANAGEMENT` only four codes dedupe, at most about ten mutable rows per tenant,
and they sort to the top anyway. `first_seen_at` is the immutable column, but
ordering by it changes what the page MEANS — most-recently-active first is the
product decision, not an implementation detail — so this is the owner's call
rather than a defect to fix quietly.

## A caveat about this branch's own review method

A reviewer mutating `packages/contracts/src/*.ts` inside a `git worktree` whose
`node_modules` is symlinked to the primary checkout tests **nothing**:
`@nexa/contracts` exports only `dist`, so the mutation is read from the primary
repository's build. Six contract mutations survived for that reason and were
re-run as shims inside the consumer, where all three died. `pnpm verify` and CI
are unaffected — contracts' `typecheck` script emits — but an ad-hoc
`pnpm test:web` after editing contract source reads the previous build. Written
down because this record is full of contract mutations and the next person to
run one in a worktree will otherwise record a survivor that is an artefact.

## The mutations

| #   | rule                                                | mutation                                   | tests that die                                                                                                   |
| --- | --------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| AG1 | the advertised ceiling is one the predicate accepts | return the parallel `floor(…/1.1)` formula | `monitor-cadence.test.ts` › keeps a healthy panel fresh, tick delay included                                     |
| AG2 | Restore is refused while the replacement is empty   | drop `\|\| renameOnRestore === ''`         | `panels.test.tsx` › refuses to send a restore whose replacement name is empty                                    |
| AG3 | `setQuery` deletes on an empty value                | drop `\|\| value === ''`                   | `router.test.tsx` › treats an empty value as removing the parameter                                              |
| AG4 | the font block has no SPA fallback                  | add `try_files` to it                      | `deployment-compose.test.ts` › serves the webfont from the release, cached, and 404s when it is missing          |
| AG5 | the webfont has a route of its own                  | rename the matcher and its path            | `deployment-compose.test.ts` › serves the webfont from the release, cached, and 404s when it is missing          |
| AG6 | the SPA handler is rooted at the activated release  | root it at the pool                        | `deployment-compose.test.ts` › serves the entry document from the activated release and its assets from the pool |

Each applied alone with an anchor assertion that fails the run if the edit does
not land, and reverted; every touched file verified byte-identical by sha256
after each. AG1's failure names the tick it found — `tick 112664: the schema
advises 715760 and then refuses it` — which is the property the single-tick
assertion above it could not see.

The two cursor-docstring corrections have no mutation of their own and the
record says so rather than inventing rows for them: they are prose about
behaviour already pinned from both sides. `check-image.sh` failing on a missing
font is the other half of AG4 and is not separately falsifiable here, because
this suite reads the routing file rather than building an image.

The routing test had to be repaired before AG6 could kill, for a reason this
record keeps meeting from the other direction. It sliced a fixed 400 characters
before `try_files` to find the SPA's root — which held only while nothing sat
between `@assets` and the SPA handler, so the font block pushed the root out of
the window and a correct routing file failed. Worse, that offset was found with
`indexOf` on the bare token, so the COMMENT explaining why the font block must
not have a fallback became the match: prose describing the shape, read as the
shape. Both are structural now — the nearest preceding root, and an anchor on
the tab-indented directive.

## The integration suite had never been mutation-tested, and six predicates were unfalsifiable

Sixteen adversarial rounds reviewed this branch and every one of them was
forbidden from running `tests/integration/**`, because they shared a database
with the working checkout. That is 45 files and 840 assertions — the only place
the real HTTP surface, the real schema and the real transactions are exercised
together — and not one of its assertions had ever been reverted to see whether
it could fail. The seventeenth reviewer was given its own database and 43
production rules across 21 files were mutated against it.

Six of them were the control plane's **compare-and-swap predicates**: settings,
both halves of the template save, both halves of the template revert, and
feature flags. Every one could be DELETED with the entire 840-test suite still
green.

They are not decoration. Every control-plane write reads the current version
with a plain `SELECT` — no `FOR UPDATE` — and then issues
`UPDATE … WHERE version = expectedVersion`. The port's docblock states what
rests on that: _"The check IS the write: the predicate lives in the statement,
so there is no window between deciding that a write is safe and performing
it."_ The reviewer demonstrated the consequence with a barrier probe — hold one
request between its read and its statement, let another commit, release the
first — and the second administrator's write is silently gone. No conflict, no
audit of the loss, and the Web Admin's "changed elsewhere" notice never fires,
because the server reported success.

The reason nothing caught it is this branch's own recurring shape: the services'
pre-check refuses every sequential case before the statement is reached, and the
pre-check has three tests. The rule was covered where the author was looking and
absent one expression over — under a comment asserting the guarantee.

`control-plane-review-round-3.test.ts` › _"refuses a save built on a version
that a revert has recycled"_ is named for the revision predicate and passes with
it deleted, for the same reason.

The new tests drive the REPOSITORIES rather than the services, deliberately: the
pre-check is exactly what makes a service-level test unable to see whether the
statement carries a predicate at all. Two sequential calls with the same
`expectedVersion` reproduce the interleaving without needing concurrency.

**Four of the first five could not fail either, and that is the part worth
keeping.** The realistic fixtures advance version and revision together, so the
stale revision refuses the write on its own and deleting the version predicate
changes nothing — measured, twice. Two predicates need two fixtures: one that
moves the version and holds the revision still, and one that moves the revision
and lets a revert recycle the version. One fixture cannot show which predicate
did the work.

## A session that expires between admission and its transaction

`isLive` has two halves and only one was tested. Its `isNull(revokedAt)` half is
covered by a barrier test; its `gt(expiresAt, now)` half was covered by nothing
— removing it left all 840 green. The docblocks promise revocation-freshness
explicitly and say nothing about expiry, so the asymmetry is invisible to a
reader.

## A claim that the integration suite asserts something it never asserted

`monitor-profile.service.ts` duplicates the monitor's scheduler-capacity code
rather than importing it, to keep the profile read off the monitor's module
graph — and said "the integration suite asserts the two agree". Nothing
compared them. Drift was caught only incidentally and one-sidedly: changing the
profile's copy failed a fixture in `web-admin-v2.test.ts` that happens to use
the literal, while `monitor-profile.test.ts` stayed green. The monitor's
constant is exported now and one line asserts the equality, which is what the
sentence claimed all along.

## The mutations

| #   | rule                                                 | mutation                                   | tests that die                                                                                         |
| --- | ---------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| AH1 | the settings write carries its version predicate     | delete `eq(settingValues.version, …)`      | `compare-and-swap.test.ts` › refuses a second setting write that names a version already spent         |
| AH2 | the template save carries its VERSION predicate      | delete `eq(templateOverrides.version, …)`  | `compare-and-swap.test.ts` › refuses a template save whose revision matches but whose version does not |
| AH3 | the template save carries its REVISION predicate     | delete `eq(templateOverrides.revision, …)` | `compare-and-swap.test.ts` › refuses a template save whose version matches but whose revision does not |
| AH4 | the template revert carries its VERSION predicate    | delete it from the `delete` statement      | `compare-and-swap.test.ts` › refuses a revert whose revision matches but whose version does not        |
| AH5 | the template revert carries its REVISION predicate   | delete it from the `delete` statement      | `compare-and-swap.test.ts` › refuses a revert whose version matches only because a revert recycled it  |
| AH6 | the feature-flag write carries its version predicate | delete `eq(featureFlagStates.version, …)`  | `compare-and-swap.test.ts` › refuses a second feature-flag write that names a version already spent    |
| AH7 | `isLive` checks EXPIRY, not only revocation          | delete `gt(adminSessions.expiresAt, now)`  | `transactional-authorization.test.ts` › treats an EXPIRED session as dead, not only a revoked one      |
| AH8 | the duplicated condition code equals the monitor's   | drop one character from the profile's copy | `monitor-profile.test.ts` › carries the same condition code the monitor opens                          |

Each applied alone with an anchor assertion that fails the run if the edit does
not land, and reverted; every touched file verified byte-identical by sha256
after each. AH2 and AH4 kill only because of the isolating fixtures described
above — with the realistic ones they survived, which is recorded because the
survival is the lesson.

`gives two replicas disjoint tenants` is not in the table: closing its vacuity
strengthened an assertion rather than adding a rule, and the correction to what
this record said about its one failure is above, under that round's heading.

## Two owner decisions, and the four tests of my own that could not fail

The two design questions this record has carried open — what an unreadable
panels cursor does, and which column the alerts keyset orders by — were decided
by the owner. Both are implemented here, and both changed behaviour the branch
previously pinned with a test, so the old tests are the falsification of the
old rules.

### An unreadable panels cursor is a 400

`decodeCursor` returned `null` for anything it could not read, a null cursor
dropped the keyset predicate, and `GET /panels?cursor=<anything>` answered
**200 with page one**. A client that truncated or invented a cursor looped on
the first page for ever and was never told, while the Web Admin's own client
docblock promised the 400 that had never existed.

One house rule now, the one `/ops-log` and `/notifications` always followed:
absent → first page, valid → next page, anything else → `control.invalid_value`
with a 400. The old argument — that refusing a legal-but-unknown id "would
restart the traversal for ever rather than fail it, which is the worse outcome"
— is inverted deliberately: failing loudly once beats looping silently, because
the loop is invisible to everyone including the operator watching it.

`400 where applicable` needed a boundary, and it is drawn at DECODABILITY. A
well-formed uuid at a well-formed instant naming no row is not malformed — it
is a legitimate position whose row may have been archived between two page
requests — so it stays a 200 with an empty page and a null cursor. Refusing it
would turn a routine race into an error nobody can act on. Asserted separately
from the fifteen-cursor refusal loop, because conflating "I cannot read this"
with "this names nothing" is what would make the loop pass for the wrong reason.

### The alerts keyset is `(first_seen_at, id)`

`last_seen_at` is rewritten by every repeat occurrence of a deduped condition —
that is what the occurrence counter is for — so a row below the operator's
cursor that recurred jumped above it and was returned on no later page. The
same argument that moved the panel keyset off `name`, in the one subsystem
whose stated rule is that silence is the outcome it may not produce.

`first_seen_at` never changes after the insert; the append-only guard refuses an
identity change, which is what makes it safe to traverse. `last_seen_at` is
still returned and still displayed as the latest occurrence, with `occurrences`,
severity and condition state beside it: metadata, not a traversal key.

This deliberately changes what the list MEANS — it is ordered by when a
condition first appeared, not by when it was last active. A most-recently-active
view is a separate design with its own pagination semantics for a mutable
ordering column, and is not bought by weakening this one. `since`/`until` stay
on `last_seen_at`, because they are an ACTIVITY filter and a condition that
first appeared last month and recurred this morning belongs in this morning's
window; filtering and ordering are independent predicates.

### The keyset moved and its index did not

Moving the alerts traversal to `(first_seen_at, id)` left it with no index. The
only one on `operational_events` was `operational_events_tenant_seen_idx` on
`(tenant_id, last_seen_at)`, so the new `ORDER BY first_seen_at DESC, id DESC`
matched nothing and the alerts page sorted the tenant's whole event history on
every request. Measured, on 2 000 rows: `Sort ... -> Seq Scan on
operational_events (actual rows=2000)`. This branch's own recurring shape — the
rule applied correctly where the author was looking and absent one expression
over.

`operational_events_tenant_first_seen_page_idx` on
`(tenant_id, first_seen_at, id)` is declared in `ONLINE_INDEXES`, so it is built
with `CREATE INDEX CONCURRENTLY` after the migrator like the two panel indexes,
for the same reason: `botctl update` migrates while the outgoing release is
still serving. Not partial — unlike panels there is no status split here. The
`(tenant_id, last_seen_at)` index stays, because `since`/`until` remain an
activity filter on `last_seen_at`.

**And nothing in this file had ever run `EXPLAIN`.** Every assertion in
`online-indexes.test.ts` compared a declaration against `pg_indexes`, which
proves an index EXISTS, not that anything uses it: an index whose column order
served no query would be present, VALID, matching, and useless. So the first
version of the new test asked the planner — and could not fail either.
Reversing the declaration to `(first_seen_at, tenant_id, id)` — which is not a
keyset index at all, because the leading column is not the one every query
filters on — left it GREEN: PostgreSQL scans that index backwards too, names it
in the plan, applies `tenant_id` as an `Index Cond`, and emits no `Sort`. Name
and plan shape cannot tell the two apart.

What tells them apart is the work done, and it only shows when ANOTHER tenant's
history is newer than this one's. The fixture now writes 2 000 rows for tenant A
aged a million seconds back and 6 000 for tenant B at the present, and asserts
on `EXPLAIN (ANALYZE, BUFFERS)`: the right index starts the scan inside tenant
A's own range, the reversed one walks the whole of tenant B's history first.
Measured 6 buffers with the keyset index and 81 with its columns reversed,
stable across repeated runs and growing with the other tenant's history.

(Two corrections in place, both from the next reviewer. This paragraph also
cited "49 in isolation": that figure came from a standalone SQL probe with a
differently named index and a different fixture, not from this test in
isolation, where it is 81 — a reviewer re-ran it and could not reproduce 49,
correctly. And the query this fixture measured was one NO CALLER ISSUES; see
round 37, which replaces it with the two the readers actually send.)

### Four of this round's own tests could not fail

The pattern is now familiar enough to be worth stating as a rule: **a fixture
proves the rule it was aimed at only if the two spellings of that rule produce
different values in it.**

- The HTTP walk recurred rows AFTER fetching page one. A cursor the server has
  already issued cannot be changed by a later mutation, so swapping
  `oldest.firstSeenAt` for `oldest.lastSeenAt` in the controller left it green.
  The boundary row has to recur BEFORE the fetch.
- Even recurring the OLDEST row before the fetch was not enough: page one's
  boundary row still had `first_seen_at == last_seen_at`, so both spellings
  produced the same cursor. The row the cursor is BUILT FROM is the one that
  has to have recurred.
- The reader tests build their own cursors, so they cannot see the controller's
  column at all — measured, all four stayed green under that mutation. They
  prove the predicate and the ordering; the HTTP walk proves the cursor.
- The `L3` tie-break fixture needed a SHARED `first_seen_at`, which the
  recorder never produces on its own, so those rows are inserted directly.

## The mutations

| #   | rule                                           | mutation                                     | tests that die                                                                                          |
| --- | ---------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| AJ1 | an unreadable panels cursor is REFUSED         | return a cursor instead of throwing          | `panels-http.test.ts` › refuses a malformed cursor with a 400 rather than restarting the traversal      |
| AJ2 | the alerts keyset PREDICATE is `first_seen_at` | compare `last_seen_at` in both arms          | `alerts-keyset.test.ts` › walks every row exactly once when a recurrence rewrites last_seen_at mid-walk |
| AJ3 | the alerts ORDERING is `first_seen_at`         | order by `last_seen_at`                      | `alerts-keyset.test.ts` › walks every row exactly once when a recurrence rewrites last_seen_at mid-walk |
| AJ4 | the id TIE-BREAK inside a shared instant       | drop the `or(...)` arm                       | `alerts-keyset.test.ts` › breaks a shared first_seen_at by id, deterministically                        |
| AJ5 | the SERVER cursor carries `first_seen_at`      | build it from `lastSeenAt`                   | `web-admin-v2.test.ts` › walks the ops log through the SERVER cursor without skipping a recurrence      |
| AK1 | the alerts keyset HAS an index                 | delete the entry from `ONLINE_INDEXES`       | `online-indexes.test.ts` › serves the alerts keyset from an index rather than sorting the tenant        |
| AK2 | that index LEADS with `tenant_id`              | reverse it to `(first_seen_at,tenant_id,id)` | `online-indexes.test.ts` › serves the alerts keyset from an index rather than sorting the tenant        |

Each applied alone with an anchor assertion that fails the run if the edit does
not land, and reverted; every touched file verified byte-identical by sha256
after each. AJ2 kills two tests, the skip and the duplicate, which are the two
directions of one defect. AK1 and AK2 were each run against a database created
empty for the mutation, because `CREATE INDEX CONCURRENTLY IF NOT EXISTS`
matches on NAME: an index already present from an earlier run would survive the
deletion of its own declaration and the mutation would prove nothing. AK2 was
run TWICE — once against the first version of the test, which it did not kill,
and again against the fixture written because it did not.

## Round 36 — the eighteenth reviewer, on the owner-decision commit itself

Eight findings against `256c3ca`, six of them the branch's own three shapes.

### `/ops-log` answered 500 for a Date-legal, `timestamptz`-illegal instant

`dateParam` and `cursorFrom` tested `Number.isNaN` and nothing else. A
JavaScript `Date` spans ±271821 years and `timestamptz` does not, so
`since=+275760-09-13T00:00:00.000Z` and `since=-005000-01-01T00:00:00.000Z`
parse, reach the driver, and raise `22008` at the cast — arriving as
`internal.unhandled`. Five caller-controlled shapes across `since`, `until`
and the `before` cursor half.

Defect class 1 AND class 3 at once. `panels.controller.ts` documents this exact
hazard at length and guards it — "the four-digit year is load-bearing" —
`/notifications` is guarded by `isoTimestamp` in its schema, and `/ops-log` is
the third cursor and the one left behind.

(Both halves of that sentence were FALSE, and the next reviewer proved it. The
four-digit year does not bound the range — year 0000 has four digits and
PostgreSQL has no year zero — and `z.iso.datetime()` is a shape check that
accepts `0000-01-01T00:00:00Z`. All three cursors answered 500 for that value,
INCLUDING the two cited here as correct prior art. Left standing and corrected
here rather than rewritten away, because "the fix cited its own siblings as
already right, and they were not" is the finding. See round 37.) And `dateParam` was ADDED by this
branch to stop `new Date('')` reaching the driver: its own docblock claimed
"parsed and refused if malformed" while refusing one of the two ways to be
malformed. The existing test refused `since=yesterday`, which is the
Invalid-Date shape only, so five callable 500s sat under a green suite.

The bound is checked on what the Date PARSED to rather than on the text:
`toISOString` renders anything outside year 0001-9999 in the expanded
`±YYYYYY` form, so one comparison covers both directions and every spelling.

### The cursor refusal pre-empts the permission guard

An unprivileged caller who appends an unreadable cursor gets 400 where the
same caller with no cursor gets 403 — and no `access.permission_denied` is
recorded, which is a security fact about people that an operator is meant to
be able to find.

Confirmed, and NOT patched, because the patch would be the inconsistency.
`limit=abc` and `archived=maybe` have always done exactly the same, through
the same `parse` on the same line, and so does every other surface here: the
query is parsed in the controller and the service that resolves the permission
is not called until it parses. What the cursor did was JOIN that class, not
create it — before the owner's decision it was silently ignored, so the request
reached the service and was denied there. A 400 also tells the caller nothing
about what they may read, which is why this ordering is the conventional one.

("and so does every other surface here" was FALSE. `POST /settings/:key`,
`POST /features/:key`, `POST /templates/:key` and `GET /panels/:id` hand the
raw value to the service and answer 403 to an unprivileged caller sending a
malformed one — the last of those one route below the one this argued about.
The true rule is narrower: a QUERY STRING is parsed in the controller and a
PATH PARAMETER or BODY is handed to the service, which authorizes first. The
conclusion survives the correction and the sentence did not. Round 37 pins
BOTH orders, because a uniformity claim with only one half tested is the same
defect one sentence shorter.)

So the rule is stated where it lives and PINNED for all three parameters at
once, from an unprivileged and a privileged caller, rather than one of them
being quietly given a different order.

### Four docblocks still named the keyset that moved, and one named the rule that inverted

The port contract (`OperationalEventQuery.before`), the reader's own header
comment five lines above the block that says the opposite, `CursorPager`'s
docstring — which exists SOLELY to stop a reader reintroducing a mutable
ordering column, and had come to name one — `fetchOpsLog`'s `before`, and a
test comment. Plus one the reviewer did not list: `panels.controller.ts`'s
cursor docblock still said an unreadable cursor "is treated as no cursor
rather than an error… refusing would turn a stale bookmark into a failed
request", two screens above the function that now refuses. All corrected in
place, the inverted one by naming the old sentence rather than deleting it,
because that sentence is precisely the argument a later reader would use to
put the silent restart back.

### A cited count that was three different numbers

`panels-http.test.ts` builds FOURTEEN malformed cursors. (Fifteen since round
37 added year zero — corrected here, in the entry about this very number
drifting, which round 37 changed the count in and did not come back to.) `client.ts` and this
record said thirteen; the commit message said fifteen. Defect class 4 — a claim
about testing whose probe was never run. Corrected, and the fixture now asserts
its own length, so a citation cannot go stale in silence again.

### Two dead branches, and a message that named the case it is not

`raw.length > CURSOR_MAX_LENGTH` could not fire: `panelListQuerySchema.cursor`
is `z.string().max(512)`, so a longer value is a `ZodError` first — the comment
about "a megabyte of base64" described a path that no longer existed. And
`Buffer.from(text, 'base64url')` never throws for any string; it SKIPS what it
cannot decode, so the `catch` was unreachable and `'!!!not base64!!!'` is
refused for having no separator, not by the guard its fixture was written for.
Both removed, leaving ONE length bound, in the schema, where the wire contract
states it — and with it the honest consequence, which the commit had not said:
an oversize cursor is `request.invalid` and every other unreadable one is
`control.invalid_value`. Two codes, both 400, now asserted separately.

Separately, the uuid arm refused with "does not name a row this server issued"
— which is the 200-with-an-empty-page case, stated three times in that same
commit. The messages now say what the code does: cannot be read.

### The attention card sorted by a column it did not draw

`dashboard.tsx` labelled each row with `lastSeenAt` while the server ordered by
`first_seen_at DESC`, so six rows carried six timestamps in no particular order
on the one card whose purpose is triage. Nothing claimed "most recent", so
nothing was literally false; the card was incoherent with its own ordering,
which reads as a bug in the data. It draws `firstSeenAt` now, labelled rather
than left bare.

The test for it puts the two columns in OPPOSITE orders on every row, because
the web harness's shared `event()` fixture writes them EQUAL — which is why no
existing test could tell the two spellings apart, and why the card's regression
was invisible for a commit.

## The mutations

| #   | rule                                           | mutation                                  | tests that die                                                                                        |
| --- | ---------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| AL1 | an instant outside `timestamptz` is REFUSED    | drop the four-digit-year comparison       | `web-admin-v2.test.ts` › refuses an empty filter rather than widening the read                        |
| AL2 | the attention card dates by `firstSeenAt`      | draw `lastSeenAt`                         | `dashboard.test.tsx` › dates each condition by when it FIRST appeared, which is the order it is in    |
| AL3 | the SCHEMA is the only cursor length bound     | raise `max(512)` to `max(8192)`           | `panels-http.test.ts` › refuses a malformed cursor with a 400 rather than restarting the traversal    |
| AL4 | a request that cannot be READ is refused first | decode `not-a-cursor` instead of throwing | `panels-http.test.ts` › does not decide 400-before-403 by a rule, and the cases are pinned one by one |

Each applied alone, reverted, and every touched file verified byte-identical by
sha256 after each — `packages/contracts` rebuilt on both sides of AL3, because
a worktree resolves that package to its `dist` and mutating the source alone
tests nothing. AL1 fails with `expected 500 to be 400`, which is the finding
itself. AL4 fails with `expected 403 to be 400`, which is the behaviour the
parent commit had.

## Round 37 — the nineteenth reviewer, on the round that fixed the eighteenth's

Three confirmed findings. Two of them are the fix from round 36 containing the
next defect, which is now the fourth consecutive round in which that has
happened.

### Year zero: the guard was wrong on all three cursors, including the two cited as right

Round 36 bounded `/ops-log` with a four-digit-year check and said so:

> `toISOString` renders anything outside year 0001-9999 in the expanded form
> `±YYYYYY`, so one comparison covers both directions and every spelling that
> reaches it.

False for exactly one year. `new Date('0000-01-01T00:00:00Z').toISOString()` is
`'0000-01-01T00:00:00.000Z'` — four digits, not expanded — and PostgreSQL has
no year zero:

```
ERROR:  date/time field value out of range: "0000-01-01T00:00:00.000Z"
```

A ~366-day window of caller-controlled values, on FIVE parameters across THREE
endpoints — because the same hole was in the two the fix cited as correct prior
art. `/panels`' `CURSOR_INSTANT` is `^(\d{4})-…`, and its rollover check
compares `0000-01-01T00:00:00` against itself and passes. `/notifications`'
`isoTimestamp` was `z.iso.datetime()`, which is a SHAPE check: verified, it
accepts `0000-01-01T00:00:00Z` and rejects `+275760-…`.

The fixture is again the author's tell. Round 36 tested `+275760` and `-005000`
— both extremes, neither zero — on both endpoints it touched.

So the rule is now `isStorableInstant` in `packages/contracts/src/time.ts`, and
it is THERE rather than in any surface because the defect is not the missing
`0000` case, it is three private copies of one rule. `isoTimestamp` refines
with it, `instantOrNull` delegates to it, `decodeInstant` calls it for the
range half. Mutating the one line kills three tests, one per cursor, each with
the driver's own error naming a different repository.

### The EXPLAIN test measured a query no caller issues

Round 35's test asked `WHERE tenant_id = $1 ORDER BY first_seen_at DESC`. No
caller sends that: `alerts.tsx` always sends a `scope` and `dashboard.tsx`
always sends `MANAGEMENT_CONDITIONS` + `open`, and both become `code = ANY (…)`
— the predicate that decides the plan, absent from the test written to prove
the plan. Defect shape 2 at the level of the QUERY rather than the fixture, and
one the previous round's own two mutations could not expose, because both
mutations and the test agreed on the wrong question.

The test now measures the two real shapes, built from the contract's own
catalogues rather than retyped, against a fixture whose codes are interleaved
as production's are. Measured on it:

- The dashboard shape (`MANAGEMENT_CONDITIONS` + `open`): **11 buffers** with
  the index, an Index Scan Backward; **921** without it, a Bitmap Heap Scan and
  a top-N sort over 6 858 rows.
- The alerts shape (`MANAGEMENT`, unfiltered): **7 buffers** with the index;
  **899** without it, a sequential scan over 40 000 rows and a top-N sort.

So round 35's claim survives for the real queries and its test did not. Stated
plainly because the reviewer reached the opposite conclusion — they measured
the real query against a fixture in which every one of a tenant's rows carried
a SINGLE code, saw a bitmap scan, and concluded the index serves nothing. That
did not reproduce here: re-running their fixture shape gives an Index Scan
Backward at 6 buffers. Two explanations fit and neither is established — their
scratch database may not have had the index built at all, or a distribution
that skewed differs from theirs in some way I could not recover — so this
records the disagreement rather than resolving it, and the honest summary is
that their CONCLUSION did not reproduce and their METHOD CRITIQUE was correct
and is what this round fixes.

The threshold moves from 20 to 40, which is between the measured 11 and the
measured 85 that a reversed index produces on the dashboard shape.

### "Every other surface does the same" was false

Round 36 declined to change the 400-before-403 ordering on the grounds that it
is uniform. Half of that was true. Verified over real HTTP, an unprivileged
caller sending a malformed value gets **403** from `POST /settings/:key`,
`POST /features/:key`, `POST /templates/:key` and `GET /panels/:id` — the last
one route below the one the claim was about. Those hand the raw value to the
service, which authorizes first.

The conclusion survives; the sentence did not. The real rule is that a QUERY
STRING is parsed in the controller — on `/panels`, `/ops-log` and
`/notifications` alike — and a PATH PARAMETER or BODY is handed to the service.
The test is renamed to say that and now pins BOTH orders, because a uniformity
claim with only one half tested is this branch's defect shape in miniature.

### Two corrections to the record itself

`(last_seen_at, id)` survived in the record's own restatement of the
`CursorPager` finding — a seventh copy of the claim, in the document that
records the correction of the other six. And round 35's "49 buffers in
isolation" came from a standalone SQL probe, not from that test in isolation,
where the figure is 81; the reviewer re-ran it, could not reproduce 49, and was
right to say so. Both corrected in place, where the claim is.

## The mutations

| #   | rule                                | mutation                                     | tests that die                                                                                                                                                                                                                                    |
| --- | ----------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AM1 | year zero is not a storable instant | drop `!iso.startsWith('0000-')`              | `web-admin-v2.test.ts` › refuses an empty filter rather than widening the read; › refuses a notification cursor at an instant it cannot store; `panels-http.test.ts` › refuses a malformed cursor with a 400 rather than restarting the traversal |
| AM2 | the alerts keyset has an index      | delete the entry from `ONLINE_INDEXES`       | `online-indexes.test.ts` › serves the alerts keyset from an index rather than sorting the tenant                                                                                                                                                  |
| AM3 | that index leads with `tenant_id`   | reverse it to `(first_seen_at,tenant_id,id)` | `online-indexes.test.ts` › serves the alerts keyset from an index rather than sorting the tenant                                                                                                                                                  |

AM1 is the whole finding in one line: it kills one test per cursor, and each
failure carries the driver's own `22008` naming
`drizzle-operational-event.reader.ts`, `drizzle-notification.repository.ts` and
`drizzle-panel.repository.ts` in turn. AM2 and AM3 were each run against a
database created empty for the mutation, because
`CREATE INDEX CONCURRENTLY IF NOT EXISTS` matches on NAME and an index left
over from an earlier run would survive the deletion of its own declaration.

A note for the next reviewer, because this one could not run AL3 or AM1: a
mutation to `packages/contracts/src` is INERT in a review worktree, whose
`node_modules` symlinks to the primary checkout and therefore to the primary's
`dist`. Either rebuild into the primary — which mutates the author's tree, so
do not — or run those two mutations in the primary checkout, which is where
both were run here.

## Round 38 — the twentieth reviewer, and the round that stops claiming a rule

Seven confirmed findings. The important one is that this branch has now
attempted THREE different rules for one behaviour and each was falsified by a
case on an endpoint the rule itself named.

### There is no rule for 400-before-403, and there was never going to be

Round 36 said the ordering is uniform. Round 37 corrected that to "a query
string is parsed in the controller; a path parameter or body is handed to the
service". Both false, and the second one in BOTH directions:

- `GET /notifications/:id` runs `uuidV7Schema.parse(id)` in the CONTROLLER, so
  a malformed path id is 400 before the guard — measured, with the same caller
  getting 403 on a well-formed id, and no `access.permission_denied` row for
  the malformed one.
- `/ops-log` splits INSIDE ITSELF. `limit`, `since`, `until`, `before` and
  `beforeId` are controller-parsed; `scope`, `severity`, `code` and `open`
  reach `OpsLogService.list`, which calls `guard.check` BEFORE
  `opsLogQuerySchema.parse`. So `?limit=abc` is 400 and `?scope=BOGUS` is 403,
  from one caller against one endpoint.

  (`open` is NOT service-parsed. It is `openFlag.parse(query.open)` in the
  argument list of the service call, so it is evaluated before the call, and
  `?open=maybe` is a 400 from either caller. Corrected in place: it is the
  fourth over-general claim in this sequence, it was the one parameter of the
  four with no assertion behind it, and it was written in the paragraph
  announcing that this branch would stop stating rules it had not tested.
  Round 39.)

Both counter-examples are on endpoints round 37's sentence enumerated as
examples of the rule.

The honest reading is that the ordering is per-PARAMETER and incidental — it
follows wherever each value happens to be validated, and nothing in this
codebase decides it. So the tests state no rule now: they pin the cases, in
both directions, including the two that killed the last one.

("per-PARAMETER" was itself too general, and round 39 corrected it: it is per
(parameter, MALFORMATION). `singleValued` refuses a REPEATED key in the
controller, so `?scope=ALL&scope=ALL` is a 400 from a caller for whom
`?scope=BOGUS` is a 403. Four attempts to state this as a rule, four
counter-examples, each on a case the rule itself named.) The consequence —
that a denial record can be suppressed by malforming the request — is written
down as **OQ-3D-02** rather than argued away a fourth time. What survives from
the argument is only the part that was always true: a 400 tells the caller
nothing about what they may read, so the exposure is the missing audit record
and not a disclosure.

Three rounds, three rules, three counter-examples, and each rule was narrower
than the last. That is the shape of guessing at an invariant a codebase does
not have.

### Numbers attributed to the wrong fixture, for the third time

Round 37 cited "11 and 7 buffers with the index, 921 and 899 without — a bitmap
scan and a sequential scan… a top-N sort over 6 858 rows… over 40 000 rows".
The test's fixture holds 8 000 rows and cannot produce any of those figures:
they came from a larger standalone probe, exactly as round 35's "49 buffers"
did. Re-measured on the test's own fixture, index built before the rows as the
migrator builds it:

- keyset index: **10** buffers (dashboard), **6** (alerts), no sort.
- no index: **183** and **63**, Bitmap Heap Scan with a top-N sort — not a
  sequential scan.
- reversed index: **85** and **81**.

So the margin is 18x and 10x, not two orders of magnitude. Still real, and it
grows with the table because the sort is over every matching row. The threshold
of 40 sits between 10 and 81.

And the test's own docblock asserted, as measured fact, that a single-code
fixture makes the planner choose `operational_events_code_idx` — while the
record two files away said the opposite. The record was right: a single-code
fixture gives the same Index Scan Backward at 6 buffers, and both mutations
still die without the interleaving. The interleaving is representativeness, not
discrimination; what discriminates is the second tenant. A comment that says
"measured" about something that was not is how a maintainer gets told they
broke a test they did not.

### A third dead branch, in the function two were removed from

`if (raw.length === 0) throw bad(...)` in `decodeCursor` could not be
distinguished from the line below it: `Buffer.from('', 'base64url')` is empty,
`''.indexOf(':')` is `-1`, and the separator branch throws the identical error
with the identical message. Removed, with the reachability written where the
branch was rather than left implicit.

### A second unbounded spelling of the rule, one screen below "ONE place"

`instantSchema` in `time.ts` was still `z.iso.datetime()`-based with no range
refinement — the very shape the previous commit indicts for `/notifications`.
It has no live caller today (`timePeriodSchema` is its only user and nothing
references that), which is precisely why it is the one a future surface would
have reached for. Bounded, and the rule now has a UNIT test at every boundary
that decides it, which it did not: the three integration tests prove the
wiring, and a boundary is what wiring gets wrong.

### Two of three fixtures in the new `/notifications` test could not fail

`+275760-…` and `-005000-…` are refused by the pre-existing `z.iso.datetime()`
shape check and survive the mutation that removes the range refinement. Only
the year-zero case exercises the new rule. The docblock framed all three as the
year-zero class; it now says which one discriminates and why the other two are
there.

### And the count entry drifted again, in the entry about the count drifting

Round 37 added a fifteenth malformed cursor, corrected `client.ts`, and left
the record's own "FOURTEEN" — inside the section written because that number
had been three different numbers. Corrected, along with the "thirteen" still
standing in the round-33 text and the seventh copy of `(last_seen_at, id)`.

## The mutations

| #   | rule                                | mutation                                     | tests that die                                                                                   |
| --- | ----------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| AN1 | year zero is not a storable instant | drop `!iso.startsWith('0000-')`              | `time.test.ts` › refuses what it cannot, including the four-digit year that is not a year        |
| AN2 | the alerts keyset has an index      | delete the entry from `ONLINE_INDEXES`       | `online-indexes.test.ts` › serves the alerts keyset from an index rather than sorting the tenant |
| AN3 | that index leads with `tenant_id`   | reverse it to `(first_seen_at,tenant_id,id)` | `online-indexes.test.ts` › serves the alerts keyset from an index rather than sorting the tenant |

AN1 is the same mutation as AM1 and now dies in the UNIT suite as well, at the
boundary rather than only through three endpoints. AN2 and AN3 were each run
against a database created empty for the mutation.

One caveat recorded rather than left to be found: AN3's margin is
page-split history. The reversed index costs 85 buffers when built BEFORE the
rows — the migrator's order, which the suite reproduces — and about 50 when
built after them on the same data, which would be 1.2x the threshold rather
than 2.1x. It kills either way, and anyone tightening the threshold should know
which number they are standing on.

## The one flake this branch produced, and the two wrong fixes for it

`web-asset-publication.test.ts` › re-copies after a publication is killed
mid-copy failed once, in an exact-head gate, on an otherwise unchanged tree —
and on its own PRECONDITION: `expected 0 to be greater than 0`, the anchor that
refuses a vacuous pass. The test spawns the publisher, waits to see a
partially-copied staging tree, and kills it there; `caught` staying 0 means it
could not tell a kill inside the copy from a kill after it.

The window is real and small: the child starts copying about 70ms in and the
staging tree exists for 20-90ms.

**Wrong fix one, and its false mechanism.** The loop was changed from
`await setImmediate` to a synchronous spin, on the argument that yielding "made
the detection depend on being SCHEDULED" and that spinning "keeps the parent
on-CPU". Both halves are false, and the next reviewer measured it: a
`setImmediate` loop never blocks on epoll — it is already a busy loop — and
over the same 8s it polled MORE often, 81 374 iterations against 74 606. It did
not remove the miss: the original failure reproduced under 32 spinners on 4
cores, because a user-space loop cannot keep a process on-CPU when the run
queue is oversubscribed. And it made the failure mode WORSE, because blocking
the event loop means the 10s `testTimeout` cannot fire — overruns were reported
at 26-40s with no diagnostic instead of at 10s with one. Reverted.

(That last clause is HALF true, and the next reviewer measured it: under 12
spinners on 4 cores the REVERTED version also timed out, at ~11.9s, and also
printed no anchor. The spin's overruns were longer; neither version reported a
diagnostic. Corrected in place — what actually made the diagnostic reachable is
in round 40 below, and it is neither loop.)

**Wrong fix two, and a cause that was never measured.** Before that, the bundle
was grown from 200 assets to 3 000 to widen the window, and abandoned with the
claim that "the publisher failed before staging anything". That claim was never
measured and is false: at 3 000 assets the publisher succeeds in 862ms and a
partial tree is caught in ~150ms. The 43 seconds that prompted the retreat were
the test's own per-asset byte comparison at the end, which scales with the
fixture and has nothing to do with the race. Defect class 4 — a claim about
testing whose probe was never run — inside the entry recording a measurement.

**The fix.** Retry the ARRANGEMENT. "Killed mid-copy" is fixture, not subject:
each attempt spawns, polls a 2s deadline, and starts over on a fresh root if
the copy finished before the parent looked. The anchor is untouched — no
attempt landing inside the copy still leaves `caught` at 0 and still fails —
and a miss now costs one short attempt instead of the whole budget.

And the retry has its own test, `recovers the arrangement when the first
attempt looks after the copy is over`, which forces the first attempt to look
only after the child has exited. Without it the retry would be a branch that
runs only on an unlucky machine, which is the machine this failed on. Capping
attempts at one kills that test and only that test.

## Round 39 — the twenty-first reviewer, and the fourth rule about one matrix

Seven findings. Two are the previous round's fix carrying the next defect, in
the paragraph written to stop that.

### `open` is controller-parsed, and it was the quarter with no assertion

Round 38 wrote that `scope`, `severity`, `code` **and `open`** reach
`OpsLogService.list` and are therefore a 403 for an unprivileged caller. Three
of those are true and had assertions. `open` is
`openFlag.parse(query.open)` INSIDE the argument list of the service call, so
it is evaluated before the call: `?open=maybe`, `?open=TRUE` and `?open=` are
all 400 from either caller. The test's service-parsed fixture was exactly the
three that hold, with `open` left out — so the false quarter of the sentence
was the quarter nothing checked, in the commit whose stated purpose was to stop
asserting rules the codebase does not have.

Corrected in four places and the three spellings added to the CONTROLLER-parsed
loop.

### "Per parameter" was the fourth over-general statement

It is per (parameter, MALFORMATION). `singleValued` refuses a REPEATED key in
the controller before either path above, so `?scope=ALL&scope=ALL` is a 400
from a caller for whom `?scope=BOGUS` is a 403 — same parameter, same endpoint,
same caller, different malformation. Pinned as a pair in the same test, because
the two answers side by side are the finding.

Four rules, four counter-examples, each on a case the rule itself named. What
is written down now is a matrix and an open question, not a rule.

### The flake fix was wrong in its mechanism, its effect and its side effect

Covered in full above: the synchronous spin polled LESS than the loop it
replaced, did not remove the miss it was written to remove, and blocked the
`testTimeout` that would have reported the overrun. Reverted. The abandoned
alternative was abandoned on a cause that was never measured and is false. The
arrangement is retried now, and the retry has a test that forces it.

### Eight of ten `instantSchema` assertions could not fail

Only the two year-zero spellings reach the new refinement; the rest are refused
by the `z.iso.datetime()` union in front of it and survive its removal. All ten
discriminate for `isStorableInstant` and `storableInstantOrNull`. The docblock
said the file pins the rule "at every boundary that decides it" without saying
for WHICH of the three — the same qualification the same commit had just added
to the `/notifications` test and did not add here.

## The mutations

| #   | rule                               | mutation                              | tests that die                                                                                                                            |
| --- | ---------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| AP1 | the arrangement is RETRIED         | cap the attempt loop at one           | `web-asset-publication.test.ts` › recovers the arrangement when the first attempt looks after the copy is over                            |
| AP2 | `open` is refused before the guard | `query.open === 'true'`, the old cast | `web-admin-v2.test.ts` › refuses an open filter that is neither true nor false; › splits 400-before-403 INSIDE one endpoint, by parameter |

AP1 fails with `a missed first attempt was not recovered: expected 0 to be
greater than 0` — the same anchor the whole sequence is about, now guarding the
recovery rather than the arrangement. AP2 fails with
`open=maybe is parsed in the controller: expected 403 to be 400`, which is the
finding itself: under the mutation `open` really does reach the guard first,
which is what round 38 said it already did.

## Round 40 — the twenty-second reviewer, and the retry that could not report

Eight findings. Two are the previous round's fix being materially worse than
what it replaced, which is the seventh consecutive round of that shape.

### The retry budget exceeded the timeout it was written to respect

Six attempts of a fixed 2s deadline is 12s against a 10s `testTimeout`. On the
all-miss path the loop never returned, so `expect(caught, 'the kill never
landed inside the copy')` was never evaluated and the failure was
`Test timed out in 10000ms` with no diagnostic — the exact outcome the revert
one round earlier was performed to avoid. Only five of the six attempts could
ever start; the sixth was unreachable.

And a timed-out arrangement is not CANCELLED. Vitest rejects the test promise
and leaves the async function running, so the loop kept spawning publishers and
rebuilding fixtures after teardown — through the module-level `workspace`,
which `beforeEach` had already pointed at the NEXT test's directory. Measured:
one leaked temp tree per timeout, eight of them, and an unrelated sibling
(`never publishes a pool asset half written`) failing in 2 of 7 runs because
the orphan's `rm -rf`s starved its polling loop. So on the machine where this
flakes the gate reported a timeout with no diagnostic PLUS a spurious failure
in a test that was fine.

Three things fix it, and only the third is the one that mattered:

- **Polling stops when the CHILD EXITS.** Once the run is over the staging tree
  is gone and no further looking can find it, so a miss costs the child's own
  lifetime rather than two seconds of spinning.
- **One wall-clock budget for the whole arrangement**, 2.5s, checked before
  each attempt and inside each poll, so it cannot overrun what the assertions
  need. Measured on a forced all-miss: the anchor now reports in 1.3s with its
  message, against a 10s timeout with none.
- **The tail was the real cost.** `expect(buffer).toEqual(buffer)` walks two
  Buffers element by element through deep equality: 200 assets of ~7KB is 1.4M
  comparisons, milliseconds of I/O and TENS OF SECONDS of matcher on a loaded
  machine. That is what timed the test out, not the race and not either loop.
  `Buffer.equals` is the identical assertion at 6ms. Under 12 spinners on 4
  cores the test went from 3/3 timeouts to 3/3 green.

The reviewer also showed the revert's cited justification was half wrong: the
reverted version timed out too, at ~11.9s, and also printed no anchor. Both
loops were indistinguishable in the failure mode the revert was argued on.
Corrected in place above.

Recorded and NOT fixed: at that same 4x oversubscription a different test,
`admits exactly one of many processes racing for an abandoned lock`, failed
once in three runs. It is a separate lock race, it is not in this change's
path, and CI does not run under that load. Named here so the next person who
sees it has somewhere to start rather than a re-run.

### The superseded rule survived in the other file

Round 39 corrected "per-PARAMETER" to per (parameter, malformation) — in
`web-admin-v2.test.ts`, and not in `panels-http.test.ts`, which still said
"Three rounds, three rules" and "the ordering is per-PARAMETER". OQ-3D-02 names
BOTH tests as the pair that must change together, and one of them changed. One
file over, in the sentence written to close exactly that. OQ-3D-02's own
lead-in also still said "Three successive attempts" above four bullets.

### `until` became the new entry with nothing behind it

The controller-parsed list names six parameters; the loop asserted five.
`until`'s 400s were pinned only with the privileged cookie, which cannot tell
controller parsing from service parsing — the identical gap that let round
38's `open` claim stand. Added.

### Two smaller ones

AP2 kills TWO tests, not the one its row named: the mutation also breaks
`refuses an open filter that is neither true nor false`, which had pinned
`open` at 400 all along. So `open` was never "the parameter with no assertion";
it had no assertion that discriminated WHICH SIDE of the guard it was parsed
on. And `time.test.ts`'s docblock claimed "thirty assertions and fourteen plus
sixteen", which is arithmetic no split of that file produces — thirteen
`instantSchema` assertions, two of which discriminate.

## The mutations

| #   | rule                                         | mutation                                     | tests that die                                                                                                                                                                                          |
| --- | -------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AQ1 | the anchor is REACHABLE on the all-miss path | `partiallyWritten` returns 0 unconditionally | `web-asset-publication.test.ts` › re-copies after a publication is killed mid-copy, rather than activating what it left; › recovers the arrangement when the first attempt looks after the copy is over |

AQ1 is the finding and its fix in one line. Under the previous version the same
mutation produced `Test timed out in 10000ms` twice, with no anchor and no
diagnostic; under this one it produces
`the kill never landed inside the copy: expected 0 to be greater than 0` and
`a missed first attempt was not recovered: expected 0 to be greater than 0`, in
1.3s. A mutation that changes a test from timing out to FAILING FOR ITS NAMED
REASON is the only evidence that an anchor is load-bearing rather than
decorative.

## Round 41 — the twenty-third reviewer, and the fifth counter-example is a real hole

Nine findings. One is a production defect with an audit consequence; two are
the previous round's fix being worse than what it replaced, for the eighth
round running.

### `PanelService` parsed every write body BEFORE it authorized

Create, update, credentials, status and test all ran `parseCommand` first, and
a `ZodError` is a 400 that never reaches the guard. So an authenticated caller
WITHOUT `panels.edit` who posted `{nonsense:true}` was answered 400 and left no
`access.permission_denied` row, while the same caller posting a well-formed
body was answered 403 and did. Measured: the row count moved 18 to 18 for the
malformed body and 18 to 20 for the well-formed one. That code is in
`MANAGEMENT_ONE_SHOT_CODES` because it is a security fact about people, and it
was suppressible by sending rubbish — including on
`POST /panels/:id/credentials`, the CRITICAL permission in that module.

This is the FIFTH counter-example to the 400-before-403 question, and the first
that is fixable rather than recordable: the same layer already authorized first
in settings, features, templates and the notification test. The panel service
was the last to follow a rule the others kept, and the sentence it falsified —
"a BODY is handed to the service, WHICH AUTHORIZES FIRST" — was true of the
three endpoints it named and false one module over. Fixed at all five sites.

("the panel service was the last" is FALSE, and round 42 below found two more:
`AdminManagementService.create` — the operation that mints a credential — and
the CRITICAL second guard inside `PanelService.create` itself. "Fixed at all
five sites" was true of the sites it counted and the count was wrong. Left
standing and corrected here, because a claim of completeness that was not
complete is the finding.)

The test asserts the RECORD, not the status, and compares the malformed delta
against the WELL-FORMED delta rather than a fixed number. A denial happens to
write two rows here — the guard records one and `recordMutationDenial` another
— and pinning that count would make the test about the recorder instead of
about the order. What it pins is that a caller cannot make the record
disappear by changing the body.

### The 2.5s budget turned a timeout into a spurious accusation

Round 40's budget was checked in the `for` condition, so when it expired the
loop exited with `caught === 0` and the anchor fired — with a message that
names a publisher regression. Measured at 24 spinners: the successful attempt
finished with 2057, 882, 1554, 616, 484 and **31** ms left; at 32 spinners the
forced-miss test failed 3 of 4 runs. Worse than the timeout it replaced,
because a timeout does not accuse anything.

The mechanism is that `missFirst`'s attempt 0 spends a mandatory FULL
publication out of the same budget the retries need — the budget consumed by
the work it exists to permit. The budget is now reset after that deliberate
miss, so the retries get their full allowance. 4 of 4 green at 32 spinners,
where the previous version failed 3 of 4.

### "The leak is closed by construction" was false

The leaked temp tree was never `source()`; it is `mkdirSync(rootDir)`
re-creating a workspace subtree `afterEach` has already deleted. Passing
`baseline` in closed the cross-test contamination half and the docblock claimed
both halves. Closed properly now by returning early when the workspace is gone
— which is exactly the state "this test has already been torn down" produces.

### Two more enumerated-but-unpinned entries, and two stale sentences

`before` was named in the controller-parsed list while the only assertion near
it exercised `cursorFrom`'s uuid check — one entry over in the loop written to
close that for `until`. And `open`'s retraction landed in the falsification
record but not in OQ-3D-02, which still said "the fourth did not"; `open` had
assertions all along, just none that discriminated which side of the guard it
was parsed on.

### Stated rather than fixed

`exited` — "polling stops when the child exits" — is an OPTIMISATION, not a
rule: removing it leaves the whole unit project green and only makes the
anchors take 2.6s instead of 0.8s. Correctness is the budget. Said plainly in
the docblock rather than left looking like a rule with no test.

## The mutations

| #   | rule                                      | mutation                                                              | tests that die                                                            |
| --- | ----------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| AR1 | a panel write AUTHORIZES before it parses | put `parseCommand` back in front of the guard on the credentials path | `panels-http.test.ts` › records the denial even when the body is nonsense |

AR1 was applied to ONE of the five sites, deliberately: it fails with
`/panels/<id>/credentials malformed: expected 400 to be 403`, naming the route
whose order was reverted. A mutation that had to change all five to be caught
would not have shown that the test discriminates per site.

## Round 42 — the twenty-fourth reviewer, and "fixed at all five sites" was not

Six findings. The shape is the same one for the ninth round running, and this
time it is a claim of COMPLETENESS that was not complete.

### The identical defect, one module over, in the module that mints credentials

`AdminManagementService.create` parsed `createAdminRequestSchema` before
`assertMayAttempt` — while `setStatus` and `setRoles`, in the SAME FILE,
authorize first. Measured: an unprivileged caller posting `{nonsense:true}`
got 400 with +0 operational events and +0 DENIED audit rows; the same caller
posting a well-formed body got 403 with +1 and +1.

`create` is the one operation that mints a NEW CREDENTIAL with roles attached,
described in its own comment as "the most privileged act on this surface". So
`admins.edit` was the last denial in the codebase a malformed body could
erase, in the round that stated in three documents that none remained.

### And once more inside the file that had just been fixed

`PanelService.create`'s second guard is `panels.credentials.rotate`, the
CRITICAL permission, and it is gated on `parsed.credentials !== undefined` —
so it necessarily ran after the parse. An actor holding `panels.edit` but not
the rotate permission could post credentials with a malformed idempotency key,
be answered 400, and leave nothing: measured +0 against +2 for the same body
with a valid key.

The previous round's test could not see it by construction, and that is worth
stating: its actor holds NO panel permission, so it is refused at the first
guard and never reaches the second. The cell needed a different actor —
`technical`, who has one permission and not the other.

Closed by authorizing on the RAW body's shape when it mentions credentials at
all. The parsed check stays, because "mentions" is not "carries":
`{credentials: null}` mentions them and parses to `undefined`.

### The new test's headline claim was not backed

`records the denial even when the body is nonsense` compared one aggregate
delta against another and said it "asserts the RECORD, not just the status".
It did not. Removing `recordMutationDenial` from the credentials path left the
whole file GREEN — both loops lose the same rows, so `malformed ===
wellFormed` still held, and the only discriminating assertion was the
`toBe(403)` inside the loops. A comparison cannot see a change that affects
both sides of it.

Now measured PER ROUTE, against both ledgers, with an absolute floor as well
as the comparison. The reviewer's exact mutation now fails with
`/panels/<id>/credentials: no DENIED audit row for a malformed body`.

### The leak guard was on the wrong variable, twice

`existsSync(workspace)` cannot fire: `workspace` is a module-level `let` that
`beforeEach` REASSIGNS, so an orphan resuming after teardown sees the NEXT
test's directory, which exists. `rootDir` is the parameter, captured at call
time, and is the right variable. Two rounds guarded the wrong one, in the check
written to close this.

("with `existsSync(rootDir)` it leaks none" was WRONG, and the next reviewer
measured it: 6 of 6 forced-timeout runs leaked under the old guard, 5 of 6
under the new one, and 2 of 6 with the retry block removed ALTOGETHER. So the
guard helps and does not close it — the dominant residue is the still-live
spawned publisher, which recreates its asset root after teardown, and no
`existsSync` on any variable can stop that. Corrected in place: the variable
choice was right and the measurement attached to it was not, in the same file
where the same round withdrew a different unreproducible figure.)

### A citation withdrawn

"removing `!exited` … makes the anchors take 2.6s instead of 0.8s" did not
reproduce; the reviewer measured the mutant as no slower. The figure only
holds on a run where the kill misses the copy. Withdrawn rather than left as
a number with nothing behind it — the green half, which is the part that
matters, is verified.

### Recorded, not fixed

Every panel denial writes the operational event TWICE: `permission-guard.ts`
records it whenever no transaction is passed, and `recordMutationDenial`
records it again. `PanelService.authorize` passes none, so both fire.
`access.permission_denied` never resolves, so an operator counting denials
counts double, permanently. Pre-existing and shared with every other
non-transactional caller of `recordMutationDenial`; flagged here because this
branch's previous round DOCUMENTED it as expected rather than noticing it.
Out of scope for a Web Admin branch, and named so the next person has
somewhere to start.

## The mutations

| #   | rule                                       | mutation                                                                   | tests that die                                                                     |
| --- | ------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| AS1 | `admin.create` AUTHORIZES before it parses | move the parse back in front of `assertMayAttempt`                         | `admin-http.test.ts` › records the denial on create even when the body is nonsense |
| AS2 | a denial leaves a row in BOTH ledgers      | replace `this.authorize` with a bare `guard.check` on the credentials path | `panels-http.test.ts` › records the denial even when the body is nonsense          |

AS2 is the reviewer's own mutation, which left the whole file green before this
round and now fails naming the route and the ledger that lost its row. AS1
fails with `a malformed body: expected 400 to be 403`, which is the finding.

## Round 43 — the twenty-fifth reviewer, and the second guard in the function just fixed

Six findings. For the tenth round running the defect is in the fix for the
round before, and this time it is in the same FUNCTION.

### The escalation gate was left one expression over

`AdminManagementService.create`'s SECOND guard is `admins.permissions.edit` —
the permission that governs privilege itself — and it is reached through
`roleKeys.includes(OWNER_ROLE_KEY)`, computed from the PARSED command. The
round before moved the first guard ahead of the parse and left this one behind
it, which is structurally the same defect it had just fixed in
`PanelService.create`, in the function it was editing.

Measured with an actor holding `admins.edit` and not
`admins.permissions.edit`: `roleKeys:['owner']` with an 11-character password
→ 400, +0 audit, +0 events; the same body with a long enough password → 403,
+1 and +1. An attempted owner escalation was erasable by sending a short
password.

Closed the same way as the panels one, on the raw body: `mentionsOwnerRole`
answers "could this request touch the owner role", not "does it", and the
authoritative decision is still the guard under the lock. `setRoles` gets the
same early check for the GRANT direction.

**That fix is REVERTED — see round 44.** It was wrong in both directions and
the second direction was harmful: the guess refused an operation the system
permits and wrote a false escalation record for it. "Left OPEN, and recorded"
was also untrue — nothing was written down; `docs/open-questions.md` gained
only OQ-3D-03 that round, and OQ-3D-02 was not touched. Both are corrected
below rather than rewritten away.

### The floor could not see either operational-event recorder

The previous round's test asserted "one of each ledger" and its docblock
claimed "the test fails if either recorder is lost". There are TWO
operational-event recorders — `permission-guard` when no transaction is passed,
and `recordMutationDenial` — so removing either left one behind and the floor
held. Measured: deleting `recordMutationDenial`'s `opsLog.record` left the
whole integration suite green, which made it a production rule with no test
ANYWHERE.

The counts are exact now, two and one, and the cost is stated: adding a third
recorder fails the test, and whoever adds one should have to say so. That the
number is two rather than one is itself a defect — recorded as **OQ-3D-03**,
not fixed here, because it is pre-existing, shared by every non-transactional
caller, and a question about which layer owns the record.

### A test that could be disarmed by an unrelated edit

`records the CREDENTIALS denial on create` described its precondition —
`technical` holds `panels.edit` and not `panels.credentials.rotate` — and never
asserted it. Measured: with `panels.edit` removed from that role AND the
raw-shape guard deleted, the test went GREEN under exactly the regression it
exists to catch, because both requests were then refused at the first guard.
The precondition is asserted in the test now, and the refusal is required to
name `panels.credentials.rotate` rather than any 403.

### A dead check kept by a false sentence

The retained `parsed.credentials !== undefined` guard was defended with
"'mentions' is not 'carries' — `{credentials: null}` mentions them and parses
to `undefined`". `panelCredentialsInputSchema.optional()` admits `undefined`
and not `null`, so `{credentials: null}` is a `ZodError` and never reaches it;
and `parsed.credentials !== undefined` implies `'credentials' in input`, so it
was unreachable as a gate. Measured: deleting it left the whole integration
suite green. Removed, with the reasoning kept where it was rather than
deleted.

### And the admin test was written to the older standard

It counted one ledger while its docblock and the commit message both said
"+1 and +1" — in the commit whose panel test was rewritten precisely because
one aggregate cannot see a recorder disappear. Both ledgers now.

### A measurement corrected, again in the file that had just corrected one

"with `existsSync(rootDir)` it leaks none" is wrong: 6 of 6 forced-timeout runs
leaked under the old guard, 5 of 6 under the new one, and 2 of 6 with the retry
block removed altogether. The guard helps and does not close it — the residue
is the still-live publisher recreating its asset root after teardown, which no
`existsSync` can stop.

## The mutations

| #   | rule                                               | mutation                                           | tests that die                                                            |
| --- | -------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| AT1 | BOTH operational-event recorders write on a denial | delete `opsLog.record` from `recordMutationDenial` | `panels-http.test.ts` › records the denial even when the body is nonsense |

AT1 is the finding: before this round the same mutation left the entire
integration suite green, and it now fails with
`/panels: operational events for a malformed body: expected 1 to be 2`.

## Round 44 — the twenty-sixth reviewer, and the round the fix was the defect

Ten findings. This is the first round where the previous round's fix did not
merely miss something — it BROKE something, and the honest outcome is a revert
rather than another patch.

### The guess refused what the system permits, and wrote a false record for it

`mentionsOwnerRole` fired on the body MENTIONING the owner role. The
authoritative guard fires on the locked DELTA adding or removing it. Those are
different predicates, and the difference is a legitimate request: an actor with
`admins.edit` editing an existing owner's OTHER roles has to keep `owner` in
the list — removing it trips the remove gate — so the pre-check refused them.

Measured, same actor, same body, parent against this branch:

- parent: RESOLVED, roles become `["owner","support"]`, +0 audit, +0 events.
- with the guess: REJECTED `Missing permission "admins.permissions.edit"`,
  roles unchanged, **+1 audit, +1 event**.

So the module whose thesis is audit fidelity wrote a `DENIED` row and an
`access.permission_denied` event describing an escalation attempt that, by the
system's own locked rule, was not one — on a row that reaches the Management
Alerts page and never resolves. The docblock defending it said "a false
positive costs one permission resolution on a request that was going to be
refused anyway". That sentence was false, and it was the justification.

It was also too NARROW: `roleKeys: 'owner'` as a bare string, rather than a
one-element array, went straight back to 400 with no record. The hole it was
written to close was one keystroke away.

**And it had no test.** Deleting both call sites left the entire corpus green —
integration and unit alike. The round was named after this rule and the only
mutation it recorded covered the PANELS test.

A false record is worse than a missing one, and a guess at an authoritative
predicate is what produced both. Reverted.

### What replaces it: the class, written down

Some refusals depend on a permission that is only known once the body is
parsed — `admins.permissions.edit` when a request grants or removes the owner
role, and `ADMIN_PRIVILEGE_ESCALATION` for every delegable role. There is no
permission to check before the parse, only a guess at one, and this round is
what a guess costs.

`docs/open-questions.md` now carries the whole class: the two cases that ARE
closed, the four that are not, the measured harm of the attempt, and the one
restructure that would close two of them authoritatively — moving the parse
inside the lock and gating on the locked `current`, which needs no unlocked
read at all. The previous round's stated reason for leaving them ("an unlocked
read whose answer can be stale") was itself wrong: nothing reads the target's
roles before the lock on either path.

### The rest

- The corrected sentence about the leak guard survived VERBATIM in the source
  comment it was copied from, one file over from the correction. Fixed where
  the next reader looks.
- Round 43's own numbers argue against keeping the retry block — 2 of 6 leaks
  without it against 5 of 6 with it — and it is kept anyway. Now stated as the
  trade it is: the leak is temp directories, the retry prevents a spurious
  anchor failure that ACCUSES the publisher, and a wrong red is worse than a
  stray directory.
- OQ-3D-03 listed templates among `recordMutationDenial`'s callers; templates
  went through `authorizedCommand`, which wrote an audit row only. (This
  sentence originally said "writes no operational event", which was false
  when written — the guard wrote the event on that path, so it was one and
  one — corrected in round 50. Templates joined the shared recorder in
  round 49.)
- "two rows and one audit row is what a denial writes here" holds for the
  PRE-TRANSACTION path only; inside `runAuthorizedMutation` it is one and one.
  The pinned counts are right for the path they measure and the sentence
  generalised past it.

## The mutations

| #   | rule                                       | mutation                                  | tests that die                                                                     |
| --- | ------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| AU1 | `admin.create` AUTHORIZES before it parses | move the parse back in front of the guard | `admin-http.test.ts` › records the denial on create even when the body is nonsense |

AU1 is the FIRST guard, which is the part of round 43 that survives. There is
deliberately no mutation row for `mentionsOwnerRole` this round, because there
is deliberately no `mentionsOwnerRole`: the rule it encoded was not the
system's rule, and the right record of that is an open question, not a test
pinning a guess.

## Round 45 — not a reviewer round: the owner closed OQ-3D-03

One instruction rather than a review: a single denied panel mutation must not
write `access.permission_denied` twice, the fix must be structural rather than
route-by-route, the tests must be exact single-request deltas pinned
separately for the audit row and the event, and the pre-authorization guesses
reverted in round 44 must stay reverted. OQ-3D-02 was to be classified, not
redesigned.

### The denial path, traced once

`PermissionGuard.check` records the event when no transaction is passed and
deliberately not otherwise (a second pool connection while holding one
deadlocks the process at pool exhaustion). `recordMutationDenial` recorded it
again, unconditionally. Its callers:

- PRE-transaction, `tx` undefined, so the guard had ALREADY written it:
  `PanelService.authorize` (create, update, credentials, status, test — all
  five panel writes), `SettingsService.set`, `FeatureFlagsService.set`,
  `NotificationService.test`. Two events each. Panels was the one measured,
  and the cause was never panels.
- IN-transaction, so the guard wrote nothing and the recorder was the only
  emitter: `runAuthorizedMutation`, and the panel monitor's
  `uow.run((tx) => guard.check(…, tx))`. One event each; correct, and
  unchanged.
- Not through the recorder at all: identity's `assertMayAttempt` (audit row
  only, the guard's event alongside — one and one already) and templates'
  `authorizedCommand` (audit row only).

### One authority

The guard marks the error it throws with whether it wrote the event — a
non-enumerable symbol property, `denialEventRecorded(error)`, that `details`
serialisation cannot reach — and `recordMutationDenial` writes the event only
when the guard says it could not. The audit row is the recorder's,
unconditionally, as before. No caller changed. The two rejected shapes were a
parameter through every caller (the route-by-route dedupe the instruction
ruled out, and the next site forgets it) and a field in `details` (which is
the 403 body).

### The floors this replaces

Round 43 had already found that a floor cannot see two recorders. This round
found the same floor in two more places: `transactional-authorization.test.ts`
asserted `events.some(code includes 'denied')` for settings' early refusal,
and `admin-http.test.ts` asserted `> 0` and `bad === good` — both requests
doubled alike, so equality held. All four pins are exact now, one and one, for
ONE request: five panel routes malformed and well-formed, settings, identity,
and both branches of the guard's decision at the unit level.

Round 43 wrote "the counts are exact now, two and one" and round 44 corrected
that sentence to the pre-transaction path only. Both were true of the code at
the time; neither is true now, and neither is rewritten. The panels-http
docblock that said two-and-one is the one place the old number was corrected
in place, because that is where the next reader looks.

### OQ-3D-02, classified

Open and not merge-blocking. Every remaining case answers `400` before the
guard, discloses nothing and changes no state, so it does not weaken
authorization; and every remaining case needs either the parse moved inside
the lock of two identity mutations or a permission that only the parsed body
can name — the one attempt to guess that permission from the raw body is what
round 44 reverted. Not redesigned.

## The mutations

Every mutation restored byte-identical to the file it mutated (`sha256`
prefix checked before and after: `authorized-mutation.ts` `df3bb6b970d8ad72`,
`permission-guard.ts` `cd953ba929b5f3fe`, `admin-management.service.ts`
`efa681dbe11fe485`). `permission-guard.ts` was then edited ONCE MORE before
the commit — a comment that wrongly listed the monitor among the
pre-transaction sites — so the committed file hashes to `460ba5b13dde6185`,
not to the prefix the mutations were checked against. Round 46 found that
gap and re-ran the guard mutations against the committed file.

| #   | rule                                                             | mutation                                       | tests that die                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AV1 | the recorder emits ONLY when the guard could not                 | emit unconditionally (the round-43 code)       | `authorization.test.ts` › PRE-transaction: the guard writes the event, the recorder writes only the audit row; `panels-http.test.ts` › records the denial even when the body is nonsense; `transactional-authorization.test.ts` › records an EARLY refusal the same way in every phase                                                                                              |
| AV2 | the recorder is the emitter INSIDE a transaction                 | delete the recorder's `opsLog.record`          | `authorization.test.ts` › IN-transaction: the guard writes nothing, the recorder writes the event and the audit row                                                                                                                                                                                                                                                                 |
| AV3 | the recorder writes the DENIED audit row                         | delete the recorder's `audit.record`           | `authorization.test.ts` › PRE-transaction: the guard writes the event, the recorder writes only the audit row; › IN-transaction: the guard writes nothing, the recorder writes the event and the audit row; `panels-http.test.ts` › records the denial even when the body is nonsense; `transactional-authorization.test.ts` › records an EARLY refusal the same way in every phase |
| AV4 | identity's early refusal writes the audit row and NOT the event  | emit `denialEvent` from `assertMayAttempt` too | `admin-http.test.ts` › records the denial on create even when the body is nonsense                                                                                                                                                                                                                                                                                                  |
| AV5 | the guard marks the error TRUTHFULLY — not when it wrote nothing | `defineProperty(…, { value: true })`           | `authorization.test.ts` › IN-transaction: the guard writes nothing, the recorder writes the event and the audit row                                                                                                                                                                                                                                                                 |
| AV6 | — and not when it did                                            | `defineProperty(…, { value: false })`          | `authorization.test.ts` › PRE-transaction: the guard writes the event, the recorder writes only the audit row; › keeps the marker off the wire; `panels-http.test.ts` › records the denial even when the body is nonsense; `transactional-authorization.test.ts` › records an EARLY refusal the same way in every phase                                                             |

Measured, per mutation, over `authorization.test.ts` (13) and the three
integration files (72):

- AV1 — unit `to have a length of 1 but got 2`; `/panels: operational events
for ONE malformed denial: expected 2 to be 1`; `ONE early refusal must emit
ONE operational event: expected [ 'access.permission_denied', …(1) ] to
deeply equal [ 'access.permission_denied' ]`. 1/13 and 2/72 fail.
- AV2 — unit `to have a length of 1 but got +0`; the integration files stay
  72/72.
- AV3 — both unit tests `to have a length of 1 but got +0`; `/panels: DENIED
audit rows for ONE malformed denial: expected +0 to be 1`; `the early
refusal left no audit evidence: expected [] to have a length of 1 but got
+0`; and the five revocation barrier tests, `the denial left no audit
evidence`. 2/13 and 8/72 fail.
- AV4 — `operational events for ONE malformed denial: expected 2 to be 1`;
  unit stays 13/13, because identity does not go through the recorder, which
  is why it has its own pin.
- AV5 — `the guard says it did NOT record: expected true to be false`;
  integration stays 72/72.
- AV6 — `the guard says it recorded: expected false to be true`; the panel
  and settings pins fail as in AV1. 2/13 and 2/72 fail.

AV2 and AV5 leaving the integration suite green is the measured version of a
sentence that would otherwise be a claim: over HTTP, no early check runs
inside a transaction, so the branch on which the recorder is the emitter is
reachable there only by a revocation landing between the early check and the
lock — the barrier tests — and those assert a floor on the audit row, not the
event. The unit pins are what hold that branch.

## Round 46 — the twenty-seventh reviewer, and the hash that was of a file never committed

Two confirmed findings, both documentary, and one observation that is the
class this branch keeps meeting — a rule present in one recorder and absent
one recorder over.

### The restore check was against a file that was then edited

Round 45 wrote "every mutation restored byte-identical" and cited three
`sha256` prefixes. The reviewer hashed every committed version of
`permission-guard.ts` back to its first commit: none hashes to the cited
`cd953ba929b5f3fe`. The mutations WERE checked against that prefix — and
then the file was edited once more, a comment correction, before the commit.
So the sentence cited a probe against a state of the file nobody can check
out. The record is corrected in place with both prefixes, and the guard
mutations were re-run this round against the committed file
(`460ba5b13dde6185`), below.

### "Five pre-transaction sites" counted the monitor

OQ-3D-03's resolution text said "the five pre-transaction sites". There are
four `recordMutationDenial` call sites that check before a transaction —
panels, settings, features, notifications — covering eight routes; the fifth
call site is the monitor's, which checks INSIDE `uow.run` and was never on
that path. The round-45 section and the commit message counted it correctly;
the open-questions text did not. Corrected.

### The recorder one module over

`AdminManagementService.runLockedMutation` is a second after-the-fact
recorder, and it wrote the event unconditionally. It was correct — every
guard check inside a locked identity mutation passes `tx`, so the guard writes
nothing and this is the emitter — but "the guard wrote nothing" is a fact about
today's six call sites, not a rule the function can see, and it is the exact
sentence that was true of `recordMutationDenial` inside a transaction and
false outside one. It now asks the guard's marker, like the shared recorder.

That change was called "unobservable in the code as committed" here, and the
record pinned it only as a PAIR: drop the check AND drop `tx` from one in-lock
site, and the identity-concurrency pin (now exact, replacing a `toContain`
floor) fails with two events; dropping `tx` alone, with the check in place,
stays green. Round 48 found the sentence false — a committed test can drop
`tx` itself, the way the one-connection test already re-aims the in-lock check
— and pinned the rule directly. AW3a's "all green" below was true of the tests
that existed, not of the rule.

## The mutations

All against the committed files: `permission-guard.ts` `460ba5b13dde6185`,
`admin-management.service.ts` `3de94021c6cee578` (this round's version).
Suites: `authorization.test.ts` (13) and the four integration files
identity-concurrency, admin-http, panels-http, transactional-authorization
(98). Each file restored to its prefix after each row.

| #   | rule                                               | mutation                                                                     | tests that die                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AW1 | the guard records on the pool, and only there      | `recorded = tx !== undefined` (a consistent inversion)                       | `authorization.test.ts` › is denied a permission outside that set; › records every denial as a WARN operational event naming the actor; › PRE-transaction: the guard writes the event, the recorder writes only the audit row; › IN-transaction: the guard writes nothing, the recorder writes the event and the audit row; › keeps the marker off the wire; › writes no audit row for a refusal that is not THIS permission; `admin-http.test.ts` › records the denial on create even when the body is nonsense; `identity-concurrency.test.ts` › settles a denied locked mutation with only ONE connection available |
| AW2 | the guard writes NOTHING from inside a transaction | `recorded = true`                                                            | `authorization.test.ts` › IN-transaction: the guard writes nothing, the recorder writes the event and the audit row; `identity-concurrency.test.ts` › settles a denied locked mutation with only ONE connection available                                                                                                                                                                                                                                                                                                                                                                                              |
| AW3 | `runLockedMutation` consults the guard's marker    | drop the check AND drop `tx` from the `setRoles` in-lock `admins.edit` check | `identity-concurrency.test.ts` › refuses a REMOVE-ONLY setRoles whose actor lost admins.edit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Measured:

- AW1 — unit 6/13 (`expected [] to include 'access.permission_denied'`,
  `expected undefined to be 'WARN'`, `the guard says it recorded: expected
false to be true`, `the guard says it did NOT record: expected true to be
false`); integration 2/98: `operational events for ONE malformed denial:
expected +0 to be 1`, and the one-connection test times out at 40 s — the
  guard writing on the pool from inside a transaction is the deadlock its
  transactional branch exists to prevent.
- AW2 — unit 1/13 (`the guard says it did NOT record: expected true to be
false`); integration 1/98, the same one-connection timeout.
- AW3a, the check dropped ALONE — 98/98 and 13/13 green. Recorded, not a row.
- AW3 (the pair) — 1/98: `ONE in-lock refusal must leave ONE operational
event: expected [ 'access.permission_denied', …(1) ] to deeply equal
[ 'access.permission_denied' ]`.
- AW3c, `tx` dropped with the check kept — 98/98 green.

## Round 47 — the twenty-eighth reviewer, and the recorder's other caller had no test

Three confirmed findings, all minor, one of them a production rule with no
test in the function round 46 had just changed.

### The escalation refusal's event was pinned by nothing

`runLockedMutation` catches two kinds of `PERMISSION_DENIED`: the guard's,
which now carries the marker, and the service's own escalation refusals
(`assertGrantsNoMorePrivilegeThanHeld`, `assertRestoresNoMorePrivilegeThanHeld`),
which carry none and for which this function is the ONLY emitter. Round 46's
justification for consulting the marker rests on that second case, and nothing
tested it: the reviewer narrowed the emission to denials that name a single
permission — which every escalation refusal does not — and the whole corpus
stayed green, 783/783 unit and every runnable integration test. The path the
code itself calls "the more serious of the two" could lose its operational
event with no failing test.

`codex-findings-round-2.test.ts` › names the permissions the actor tried to
confer, not "unknown" now also asserts EXACTLY one `access.permission_denied`
row for that refusal, naming the first excess permission.

### Two sentences one module too wide, and a docblock on the wrong function

- ADR-0014's addendum said `recordMutationDenial` is "shared by every early
  check in the control plane". Templates is control plane and goes through
  `authorizedCommand`, which writes an audit row only — round 45 listed it
  under "not through the recorder at all", one document over. And the three
  services that DO share the recorder each carried a comment saying it was
  "one recorder for every early refusal in the codebase", false for templates
  and identity since the day it was written. All four corrected.
- The docblock describing `runLockedMutation` sat above `assertMayAttempt`,
  followed by a second JSDoc, so it attached to nothing — and it still
  described the unconditional emission round 46 removed. Moved to the function
  it describes and rewritten for what it does now, including the non-guard
  case above.

The reviewer also refuted, on evidence: every in-lock check passes `tx`; no
path writes the guard's event and then reaches `runLockedMutation`; the
enumerable-or-not status of the marker is irrelevant to the 403 body because
the filter serialises `details` alone; every hash cited in rounds 45 and 46
matches its committed file; and OQ-3D-02's classification stands — no listed
case changes state or discloses anything.

## The mutations

`admin-management.service.ts` at `73b10ad89a2b4688` (this round's version),
restored to it after each row. Suites: `codex-findings-round-2.test.ts` and
`identity-concurrency.test.ts` (111).

| #   | rule                                                        | mutation                                              | tests that die                                                                                                                                                                                  |
| --- | ----------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AX1 | a NON-guard denial is recorded by `runLockedMutation` alone | emit only when the denial names a single `permission` | `codex-findings-round-2.test.ts` › names the permissions the actor tried to confer, not "unknown"                                                                                               |
| AX2 | `runLockedMutation` is the emitter for every in-lock denial | never emit                                            | `codex-findings-round-2.test.ts` › names the permissions the actor tried to confer, not "unknown"; `identity-concurrency.test.ts` › refuses a REMOVE-ONLY setRoles whose actor lost admins.edit |

Measured: AX1 — 1/111, `ONE refused escalation must leave ONE operational
event: expected [] to deeply equal [ 'access.permission_denied' ]`; before this
round the same mutation left 111/111 green. AX2 — 2/111, the same message and
`ONE in-lock refusal must leave ONE operational event: expected [] to deeply
equal [ 'access.permission_denied' ]`.

## Round 48 — the twenty-ninth reviewer, and "unobservable" was a sentence, not a measurement

Four confirmed findings, all minor, all in the identity recorder the two
previous rounds had just changed.

### Two rules in `runLockedMutation` with no committed test — and a reason that was false

Round 46 said the marker consult was "unobservable in the code as committed"
and pinned it only as a record-only pair. Round 47 added an audit pin beside
it and did not notice that the audit row's UNCONDITIONAL write had no test
either: moving it inside the `if` left 111/111 green. Both were observable
all along by the construction the one-connection test already uses — re-aim
the in-lock check and drop `tx`, so the guard writes the event itself and
marks the error. That is a committed test now:
`identity-concurrency.test.ts` › records ONE event and ONE audit row when the
in-lock check has already written the event. It dies under the unconditional
emission (two events) and under the conditional audit (zero rows). The
"unobservable" sentences in round 46 and OQ-3D-03 are corrected in place.

### The event's severity and actor were pinned by nothing

An `INFO` escalation refusal was green everywhere, and the alerts page
filters by severity: recorded, and never seen. Both in-lock pins now assert
`WARN` and the refused actor's id.

### The audit row and the event could name different permissions

Round 47's pin checked the event against `deniedPermissions[0]` and the audit
row against nothing; the audit row naming the LAST excess permission was
green. The pin now ties the two together: the audit row names the first
excess permission and the event names what the audit row names.

### The event was written before the audit row, in both recorders

"The audit row is the more important half" — and it was written second, so
an operational log that is down cost it. The two writes are not atomic, and
their order is the only thing that decides which survives. Both recorders
write the audit row first now; the event write's error still propagates,
because a recorder that swallowed it would hide an outage behind a clean 403. Pinned in both: the shared recorder at the unit level with a throwing
ops log, `runLockedMutation` through the container façade.

### A measurement that was of a broken build

The first sweep this round reported AY2 and AY5 killing ten tests each. They
had not: the script that moved the audit block anchored on the FIRST
`audit.record` in the file, which belongs to the password throttle, and the
ten failures were `adminId is not defined`. Re-anchored to
`runLockedMutation`, each kills exactly the one test written for it. Ten
failures for a one-line rule was the tell; a sweep that kills more than its
rule can explain is measuring something else.

## The mutations

`admin-management.service.ts` `abf0ab1b57fd732e`, `authorized-mutation.ts`
`77795cdc066015a3` (this round's versions), restored after each row. Suites:
`identity-concurrency.test.ts` + `codex-findings-round-2.test.ts` (113) and
`authorization.test.ts` (14).

| #   | rule                                                         | mutation                                                           | tests that die                                                                                                                                                                                  |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AY1 | `runLockedMutation` consults the guard's marker              | emit unconditionally (round 46's AW3a, no longer green)            | `identity-concurrency.test.ts` › records ONE event and ONE audit row when the in-lock check has already written the event                                                                       |
| AY2 | ...and writes the audit row UNCONDITIONALLY                  | audit row inside the `if`                                          | `identity-concurrency.test.ts` › records ONE event and ONE audit row when the in-lock check has already written the event                                                                       |
| AY3 | the in-lock denial event is WARN                             | `severity: 'INFO'` overriding the event inside `runLockedMutation` | `codex-findings-round-2.test.ts` › names the permissions the actor tried to confer, not "unknown"; `identity-concurrency.test.ts` › refuses a REMOVE-ONLY setRoles whose actor lost admins.edit |
| AY4 | the audit row and the event name the FIRST excess permission | `deniedPermission: attempted[attempted.length - 1]`                | `codex-findings-round-2.test.ts` › names the permissions the actor tried to confer, not "unknown"                                                                                               |
| AY5 | `runLockedMutation` writes the audit row BEFORE the event    | event first                                                        | `identity-concurrency.test.ts` › writes the DENIED audit row even when the operational-event write fails                                                                                        |
| AY6 | `recordMutationDenial` writes the audit row BEFORE the event | event first                                                        | `authorization.test.ts` › writes the audit row before the event, so a failing event write cannot cost it                                                                                        |

Measured: AY1 — 1/113, `the guard wrote the event; the recorder must not
write it again: expected [ 'access.permission_denied', …(1) ] to deeply equal
[ 'access.permission_denied' ]`. AY2 — 1/113, `the recorder writes the audit
row whether or not the guard wrote the event: expected [] to have a length of
1 but got +0`. AY3 — 2/113, `expected 'INFO' to be 'WARN'` twice. AY4 —
1/113, `expected 'users.wallet.credit' to be 'audit.view'`. AY5 — 1/113,
`the audit row must be written before the event: expected [] to have a length
of 1 but got +0`. AY6 — 1/14, the same message.

## Round 49 — the thirtieth reviewer, and the claim that was true of one branch and stated for both

Five confirmed findings, all minor; one of them is round 48's headline.

### "An operational log that is down costs the event and never the audit row" — on one path

True of the two after-the-fact recorders, and stated for both paths. On the
PRE-transaction path — the eight early routes, templates' two, identity's
three pre-lock checks, which is the path an ordinary unauthorized request
actually hits — the GUARD writes the event before it has decided to throw
the denial. If that write fails, `check` rejects with the write's error, no
`PERMISSION_DENIED` ever exists, and the recorders write nothing: the caller
sees the outage, not a 403, and the attempt leaves no audit row. Measured by
the reviewer with a probe (`caller sees: the operational log is down`, `audit
rows: 0`).

Not changed here. The structural fix — the guard catching its own write
failure, marking `recorded: false`, and throwing the denial — also turns a
VIEW check's refusal during an outage into a quiet 403 with no event, where
today the outage is loud. That is an operator-facing decision, recorded as
**OQ-3D-04**, and the limit is now stated by a test rather than a sentence:
`authorization.test.ts` › PRE-transaction with the operational log down: the
guard fails before any denial exists.

### A behaviour change nobody stated, and an order pin that pinned survival

Audit-first means an audit writer that is down now stops the recorder before
the event, where before 72dd2d3 the event survived. Accepted — an event
describing a refusal the audit log does not contain is the worse record —
and now stated by `authorization.test.ts` › an audit failure costs the event,
and is what the caller sees. And AY6's pin checked that the audit row was
PRESENT after the failing event write, not that it was written first: a
concurrent pair (`Promise.all`) left it green. The pin now captures the audit
count at the moment the event write runs.

### Templates' early check wrote a DENIED row for ANY throw

The last early check IN THE CONTROL PLANE on an inline catch-ANY recorder — identity's `assertMayAttempt` still audits inline, filtered on the denial kind, which round 50 measured cannot audit anything but this permission's refusal, and `RecordPingService` in the system module carried the same catch-ANY until round 52 — and its `catch (denial)` audited
whatever was thrown — an operational log that is down, a missing tenant
context — as a refusal of `templates.edit`: the false-record class round 45
removed from settings, features and notifications, one module over from
them. It shares the recorder now, and
`transactional-authorization.test.ts` › records a TEMPLATES early refusal as
one audit row and one event, and a non-denial as nothing pins both halves.

### The rest

- AY3's row named a mutation that could be read two ways; the reviewer
  measured both (2/113 inside `runLockedMutation`, 2/113 + 1/14 in the
  guard). The row now says which.
- `assertMayAttempt`'s docblock still said `runLockedMutation` "records it
  itself" unconditionally. Corrected to the marker.
- One 147-character prose line, wrapped.

## The mutations

`authorized-mutation.ts` `77795cdc066015a3`, `template-management.service.ts`
`db10d98df8dd5076` (this round's versions), restored after each row. Suites:
`authorization.test.ts` (16) and `transactional-authorization.test.ts` (9).

| #   | rule                                                        | mutation                                                               | tests that die                                                                                                                        |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| AZ1 | the shared recorder writes the audit row, THEN the event    | the two writes concurrently (`Promise.all`)                            | `authorization.test.ts` › an audit failure costs the event, and is what the caller sees                                               |
| AZ2 | templates audits only THIS permission's refusal             | back to the inline `catch`-any recorder                                | `transactional-authorization.test.ts` › records a TEMPLATES early refusal as one audit row and one event, and a non-denial as nothing |
| AZ3 | templates records its early refusal                         | delete the recorder call                                               | `transactional-authorization.test.ts` › records a TEMPLATES early refusal as one audit row and one event, and a non-denial as nothing |
| AZ4 | an audit failure stops the shared recorder before the event | start the audit write, write the event, then rethrow the audit failure | `authorization.test.ts` › an audit failure costs the event, and is what the caller sees                                               |

Measured: AZ1 — 1/16, `no event for a refusal the audit log does not hold:
expected [ { …(5) } ] to have a length of +0 but got 1`; the order-capture
assertion did NOT fire for this mutation, because the concurrent pair still
starts the audit write first — the audit-failure pin is what holds
concurrency out. AZ2 — 1/9, `an outage is not a denial: expected [ { …(18) },
{ …(18) } ] to have a length of 1 but got 2`. AZ3 — 1/9, `ONE early refusal,
ONE audit row: expected [] to have a length of 1 but got +0`. AZ4 — 1/16, the
AZ1 message.

## Round 50 — the thirty-first reviewer, and the pin round 48 gave one recorder and not the other

Eight confirmed findings, all minor: three missing pins, five sentences.

### The shared recorder's event content was pinned by nothing

Round 48 pinned `WARN`, the permission and the actor for identity's
recorder. The shared recorder — the ONLY emitter on the `runAuthorizedMutation`
branch, which is every control-plane and panel mutation refused under its
lock — kept code-only pins: an `INFO` event, an event naming `panels.view`
for a settings refusal, or an event naming nobody were all green, across
the whole corpus. An operator filtering the alerts page by `WARN` would not
have seen an in-transaction denial. Pinned now at the unit level and in every
revocation-barrier case (one parametrised test, cited below by its source
name; settings, features and templates each fail it), against the audit
row's own `deniedPermission`.

### Templates: a shape change nobody stated, and an order pinned by accident

Moving templates onto the shared recorder changed its early DENIED row from
`after: null` to `{ deniedPermission, reason }` — a behaviour change round 49
did not state; no consumer depends on the old shape (grepped), and the new
test now asserts the new one, `entityType: 'Template'` included (round 49's
test would have accepted `'Setting'`). And templates' authorize-before-parse
order was pinned only because one HTTP fixture happens to omit a required
field: the new test now sends `{ nonsense: true }` on purpose and expects a
403 with its record, as the panels test does.

### Five sentences one module too wide, three of them re-staled by round 49 itself

Round 47 corrected the settings/features/notifications comments; round 49
moved templates onto the recorder and made the same three comments wrong
again ("identity and templates audit theirs inline"). ADR-0014's list and
OQ-3D-03's "four sites, eight routes" likewise. And round 49's title — "the
last inline recorder" — overstated: identity's `assertMayAttempt` still
audits inline, filtered on the denial kind; the reviewer measured that the
resolver never throws `PERMISSION_DENIED` itself, so that inline recorder
cannot audit anything but this permission's refusal, which is why it is
wording rather than code. Round 44's "templates … writes no operational
event" was false when written (the guard wrote it) and is corrected in place.

## The mutations

`authorized-mutation.ts` `77795cdc066015a3`, `template-management.service.ts`
`db10d98df8dd5076`, restored after each row. Suites: `authorization.test.ts`
(16) and `transactional-authorization.test.ts` (9).

| #   | rule                                          | mutation                              | tests that die                                                                                                                                                                                                                         |
| --- | --------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BA1 | the shared recorder's event is WARN           | `severity: 'INFO'`                    | `authorization.test.ts` › IN-transaction: the guard writes nothing, the recorder writes the event and the audit row; `transactional-authorization.test.ts` › refuses ${testCase.name} when authority is revoked before the transaction |
| BA2 | ...and names the refused permission           | `denialEvent(actor, 'panels.view')`   | `authorization.test.ts` › IN-transaction: the guard writes nothing, the recorder writes the event and the audit row; `transactional-authorization.test.ts` › refuses ${testCase.name} when authority is revoked before the transaction |
| BA3 | ...and the refused actor                      | actor `id: null`                      | `authorization.test.ts` › IN-transaction: the guard writes nothing, the recorder writes the event and the audit row; `transactional-authorization.test.ts` › refuses ${testCase.name} when authority is revoked before the transaction |
| BA4 | templates' early DENIED row is a Template row | `entityType: 'Setting'`               | `transactional-authorization.test.ts` › records a TEMPLATES early refusal as one audit row and one event, and a non-denial as nothing                                                                                                  |
| BA5 | templates authorizes BEFORE it parses         | `parse()` moved in front of the check | `transactional-authorization.test.ts` › records a TEMPLATES early refusal as one audit row and one event, and a non-denial as nothing                                                                                                  |

Measured: BA1 — 1/16 (`expected { …(5) } to match object { severity: 'WARN',
context: { …(3) } }`) and 3/9 (`settings.set: ONE in-transaction refusal, ONE
WARN event: expected [ 'INFO' ] to deeply equal [ 'WARN' ]`, and the same for
features and templates). BA2 — 1/16 and 3/9 (`expected 'panels.view' to be
'settings.edit'`, `… to be 'templates.edit'`). BA3 — 1/16 and 3/9 (`expected
null to be '<the actor's id>'`). BA4 — 1/9 (`expected { …(18) } to match
object { entityType: 'Template', …(1) }`). BA5 — 1/9 (`expected ZodError …` —
the malformed body was parsed before the actor was refused).

## Round 51 — the thirty-second reviewer, and "every case" was three of five

Three confirmed findings, all sentences; no behaviour defect and no rule
without a discriminating test.

### The event pin was in the parametrised barrier test and not the literal ones

Round 50 wrote "pinned … in every revocation-barrier case". The file has six
barrier tests, five of which refuse on revoked AUTHORITY: three generated
from `CASES` and two written out — `notifications.test` and
`templates.revert` — which kept an audit floor and said nothing about the
event. (The sixth refuses a revoked SESSION before the guard runs and has no
denial to pin.) Deleting the shared recorder's event write
left those two green. One helper now (`expectOneWarnDenialEvent`), used by
all five, and the same mutation fails all five.

### A comment one module wide, in the file round 50 had just used as the example

Templates' early check said "the recorder shared by every other early
check"; identity's `assertMayAttempt` is an early check that audits inline.
Round 50 corrected exactly this over-width in the three sibling comments and
left the templates one. Corrected; and the siblings' parenthetical now says
what identity does (audits inline; the guard writes that event) rather than
what it does not.

### "Every pre-transaction denial was recorded twice"

ADR-0014's addendum, introduced in round 45, said so; it was true of the
four early checks on the shared recorder and false of identity's and
templates', which were one and one — round 45's own commit message said
that. Scoped in the ADR and in OQ-3D-03, whose pinned list now also names
the round 49–51 pins.

## The mutations

`authorized-mutation.ts` `77795cdc066015a3`, restored after the row. Suite:
`transactional-authorization.test.ts` (9).

| #   | rule                                                                 | mutation                        | tests that die                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BB1 | every barrier case leaves ONE WARN event — the literal ones included | the shared recorder never emits | `transactional-authorization.test.ts` › refuses ${testCase.name} when authority is revoked before the transaction; › refuses notifications.test when authority is revoked before the transaction; › refuses templates.revert when authority is revoked before the transaction |

Measured: 5/9 — `settings.set: ONE in-transaction refusal, ONE WARN event:
expected [] to deeply equal [ 'WARN' ]`, and the same for `features.set`,
`templates.set`, `notifications.test` and `templates.revert`. Before this
round the same mutation left the last two green.

## Round 52 — the thirty-third reviewer, and the recorder the sentence had forgotten

Two confirmed findings, both sentences, one of them naming a recorder no
round had counted; and two of the reviewer's preferences taken, because each
was a pin one line short of discriminating.

### `RecordPingService` still carried an inline catch-ANY recorder

Round 49 called templates' "the last early check on an inline catch-ANY
recorder". It was the last in the control plane. The system module's ping —
wired on the web and Telegram surfaces — audited whatever its early check
threw as a refusal of `maintenance.run`: an operational log that is down
became a DENIED row for a denial that never happened, the false-record
class rounds 45 and 49 removed one module over. The reviewer measured it
with a scratch probe (guard throwing a generic error → one DENIED row). It
shares the recorder now; the service gains `opsLog`, wired at its one
construction site. Round 49's sentence is scoped in place.

### "Five barrier tests" was six

Five refuse on revoked AUTHORITY and use the helper; the sixth refuses a
revoked SESSION before the guard runs and has no denial to pin. Round 51's
count sentence and OQ-3D-03's "every revocation-barrier case" now say so.

### Two pins one line short

The barrier helper floored the DENIED audit row at `> 0` — a doubled row
was green — and compared the event's permission against the audit row's,
so a consistent lie in both ledgers was green too. It asserts exactly one
row now and compares both against the case's LITERAL permission. That
literal immediately caught a wrong assumption of mine: feature flags are
edited under `settings.edit`, not a `features.edit` that does not exist —
their parameters are settings, and so is the permission.

## The mutations

`record-ping.service.ts` `4d47ec361885c122`, `authorized-mutation.ts`
`77795cdc066015a3` (this round's versions), restored after each row. Suites:
`write-path.test.ts` (8) and `transactional-authorization.test.ts` (9).

| #   | rule                                                     | mutation                                       | tests that die                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RP1 | the ping audits only THIS permission's refusal           | the inline catch-ANY recorder back             | `write-path.test.ts` › denies an actor without the permission, and records the denial; › audits nothing when the guard fails for a reason that is not a denial                                                                                                                                                                                                                                                                         |
| RP2 | the ping records its early refusal                       | delete the recorder call                       | `write-path.test.ts` › denies an actor without the permission, and records the denial                                                                                                                                                                                                                                                                                                                                                  |
| BC1 | every barrier case leaves EXACTLY one DENIED row         | the shared recorder writes the audit row twice | `transactional-authorization.test.ts` › refuses ${testCase.name} when authority is revoked before the transaction; › refuses notifications.test when authority is revoked before the transaction; › refuses templates.revert when authority is revoked before the transaction; › records an EARLY refusal the same way in every phase; › records a TEMPLATES early refusal as one audit row and one event, and a non-denial as nothing |
| BC2 | ...naming the case's LITERAL permission, in both ledgers | audit row and event both name `panels.view`    | `transactional-authorization.test.ts` › refuses ${testCase.name} when authority is revoked before the transaction; › refuses notifications.test when authority is revoked before the transaction; › refuses templates.revert when authority is revoked before the transaction; › records an EARLY refusal the same way in every phase; › records a TEMPLATES early refusal as one audit row and one event, and a non-denial as nothing |

Measured: RP1 — 2/8, `expected { …(18) } to match object { result:
'DENIED', …(4) }` (the row no longer names the permission) and `an outage is
not a denial: expected [ { …(18) } ] to have a length of +0 but got 1`. RP2
— 1/8, `expected [] to have a length of 1 but got +0`. BC1 — 7/9,
`settings.set: ONE in-transaction refusal, ONE DENIED audit row: expected
[ …, … ] to have a length of 1 but got 2` and the like; before this round
the five barrier cases stayed green under it. BC2 — 7/9, `settings.set: the
audit row names the refused permission: expected 'panels.view' to be
'settings.edit'` and the like; before this round the five barrier cases
stayed green under it.

## The microsecond truncation is still open, deliberately

Unchanged by this round, on the owner's instruction. `/ops-log` and
`/notifications` still read a `timestamptz` into a `Date` and re-send
`toISOString()` at millisecond precision, where `PanelCursor` renders
microseconds and casts explicitly. It remains unreachable — every writer
supplies those columns from the `Clock` — and the fix is SQL that cannot be
made to fail before it is applied. It is not hardened on a guess and the record
of it above is not erased.
