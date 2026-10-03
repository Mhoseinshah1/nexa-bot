# Round T (T3) — Web builder falsification record

Each rule below was reverted alone in the T3 worktree with `scripts/falsify.sh` (project
`web`): the harness applied the one mutation to the committed file, ran the one test file,
restored the file with `git checkout` and checked it byte-identical before the next row.
No database is involved — the web suite stubs `fetch` only. Every cited test passes on the
unmutated tree. `docs/round-t-button-builder-audit.md` §13 (T3) names the targets.

T3-01b re-runs F5-12's citation (`docs/f5-falsification.md`), whose test was rewritten
onto the builder's customer preview when the legacy order table was replaced: the rule it
holds — the trial is left out while the server says no panel offers one — is unchanged.

| #      | rule                                                                   | mutation                                                           | tests that die                                                                                                            | result |
| ------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------ |
| T3-01  | the preview's gate answers are the server's `gateOpen`, passed through | `gateAnswersOf` computes a gate in React (open unless TRIAL_OFFER) | `bot-buttons-builder.test.tsx` › draws a gated button exactly when the server says its gate is open                       | KILLED |
| T3-01b | the same, on the page's listing (F5-12)                                | as T3-01                                                           | `bot-buttons.test.tsx` › lists every main-menu button, the trial and the referral included, with its label and its gate   | KILLED |
| T3-02  | an unknown gate answer is not open                                     | `hiddenNowByGate` hides only on `gateOpen === false`               | `bot-buttons-builder.test.tsx` › draws a gated button exactly when the server says its gate is open                       | KILLED |
| T3-03  | a drop on a button places before it, as the Inspector's moves do       | the chip drop appends to that button's row instead                 | `bot-buttons-builder.test.tsx` › drag and drop and the non-drag controls produce the identical draft                      | KILLED |
| T3-04  | the one placement primitive puts a button BEFORE its target            | `placeBefore` splices one place later                              | `bot-buttons-builder.test.tsx` › drag and drop and the non-drag controls produce the identical draft                      | KILLED |
| T3-05  | switching off keeps the button's place                                 | `setEnabled(false)` removes the button to the pool                 | `bot-buttons-builder.test.tsx` › switching a button off keeps its place — unlike removing it                              | KILLED |
| T3-06  | the pool keeps a removed button's configuration                        | `removeToPool` resets the button's configuration to the default    | `bot-buttons-builder.test.tsx` › removes a button to the pool and restores it with its configuration kept                 | KILLED |
| T3-08  | the first save states the baseline the page was seeded from            | the save sends `legacyBaselineVersion: null`                       | `bot-buttons-builder.test.tsx` › first save states no draft version and the baseline the page was seeded from, with a key | KILLED |
| T3-09  | a save names the draft version it read                                 | the save always sends `expectedDraftVersion: null`                 | `bot-buttons-builder.test.tsx` › first save states no draft version and the baseline the page was seeded from, with a key | KILLED |
| T3-10  | a 409 never silently replaces the operator's edit                      | a save conflict reloads the server's draft at once                 | `bot-buttons-builder.test.tsx` › a 409 keeps the edit, says so, never retries, and reloads only when asked                | KILLED |
| T3-11  | publish is asked first                                                 | the Publish button publishes directly                              | `bot-buttons-builder.test.tsx` › publishes only after confirmation, with the diff and both versions it read               | KILLED |
| T3-12  | an unsaved edit cannot be published                                    | `publishable` drops `!dirty`                                       | `bot-buttons-builder.test.tsx` › cannot publish an unsaved edit or an unsaved draft                                       | KILLED |
| T3-13  | restore is asked first                                                 | choosing a revision restores it at once                            | `bot-buttons-builder.test.tsx` › restores a revision INTO THE DRAFT after confirmation, and publishes nothing             | KILLED |
| T3-14  | reset is asked first                                                   | the Reset button resets to DEFAULT at once                         | `bot-buttons-builder.test.tsx` › resets only after confirmation, from the seed chosen                                     | KILLED |
| T3-15  | a draft the live menu moved under cannot be published from the page    | `publishable` ignores `legacyChangedSinceDraft`                    | `bot-buttons-builder.test.tsx` › blocks publishing a draft the live menu moved under, and offers the reseed from live     | KILLED |
| T3-16  | a read older than the draft held never replaces it                     | `olderThan` always answers false                                   | `bot-buttons-builder.test.tsx` › never lets a read older than the draft it just saved replace that draft                  | KILLED |
| T3-17  | no write control is drawn without settings.edit                        | the toolbar's write buttons are drawn for everyone                 | `bot-buttons-builder.test.tsx` › a viewer without settings.edit sees the menu and its history, and no control that writes | KILLED |
| T3-18  | an unsaved draft holds the leave guard                                 | `useUnsavedChanges` is never armed                                 | `bot-buttons-builder.test.tsx` › guards leaving while the draft is unsaved                                                | KILLED |
| T3-18b | the same, on the OPS-A guard suite                                     | as T3-18                                                           | `ops-a-redesign.test.tsx` › guards a moved main-menu arrangement until it is saved or restored                            | KILLED |
| T3-19  | the style picker offers exactly the contract's four                    | the picker drops `danger`                                          | `bot-buttons-builder.test.tsx` › offers exactly the four styles and saves the one chosen                                  | KILLED |
| T3-20  | a row emptied by a move is dropped, never saved empty                  | `withRows` keeps empty rows                                        | `bot-buttons-builder.test.tsx` › drag and drop and the non-drag controls produce the identical draft                      | KILLED |

## The review of PR #134

Rows T3-21 to T3-27 answer the one Codex review of PR #134 (findings 1–6 and 8; finding 7
was rejected because the read cannot express it — every stored layout is returned
normalised, so a button a later release added is indistinguishable from one the operator
configured). Same procedure as above; each cited test was written to fail before its fix.

| #     | rule                                                                      | mutation                                                              | tests that die                                                                                                           | result |
| ----- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| T3-21 | nothing is editable while a builder write is in flight                    | `editable` ignores the pending write                                  | `bot-buttons-builder.test.tsx` › #1 allows no edit while a write is in flight, so its answer drops nothing               | KILLED |
| T3-22 | a write's answer outranks the snapshot that was on screen when it landed  | the sync ignores which snapshot the answer superseded                 | `bot-buttons-builder.test.tsx` › #2 keeps a publish’s answer over the snapshot that was on screen before it              | KILLED |
| T3-23 | only the latest write's refusal is shown                                  | the error shown is the first errored mutation's                       | `bot-buttons-builder.test.tsx` › #3 forgets an earlier write’s refusal once a later write succeeds                       | KILLED |
| T3-24 | a failed re-read never replaces the edit with cached data                 | the reload adopts the result's data whether or not the read failed    | `bot-buttons-builder.test.tsx` › #4 keeps the edit and the conflict when the re-read after a 409 fails                   | KILLED |
| T3-25 | the live keyboard shows the published layout's styles (re-run 2026-10-02) | every live key is drawn `default`                                     | `bot-buttons-builder.test.tsx` › #5 draws the live keyboard with the published layout’s styles, and no icon              | KILLED |
| T3-26 | a publish over an unreadable layout is not the first publication          | the unreadable case falls through to the first-publication message    | `bot-buttons-builder.test.tsx` › #6 never calls a publish over an unreadable layout the first publication                | KILLED |
| T3-28 | over a superseded layout the publish dialog never says "no layout change" | the dialog's superseded branch is removed (falls through to the diff) | `bot-buttons-builder.test.tsx` › F-2 never says "no layout change" over a superseded layout: customers’ keyboard changes | KILLED |

Row T3-28 was added by the T4 final review's fix for F-2 (`docs/round-t-final-review.md`,
Fixes addendum), run the same way in the T4 worktree.

## 2026-10-02 — the icon retirement and the drag pass (owner order)

**Rows retired.** T3-07 (the icon slot independent of the appearance slot) and T3-27 (an icon
beside a label's own emoji is warned about) were removed from the tables above: both controls
and the warning are gone, so their rules no longer exist. Their tests were replaced by the
assertions that no icon control is drawn and that no second symbol is drawn beside a label
(`bot-buttons-builder.test.tsx`). T3-25 was re-run against its renamed test.

Run in the `wp/c-button-builder` worktree, one mutation at a time, the file restored with
`git checkout` (or from a copy taken before the edit) and `git status` checked clean before
the next row. Only the named test files were run. `docs/round-t-button-builder-audit.md` §16.

| #     | rule                                                                  | mutation                                                 | tests that die                                                                                                                                                                                                 | result |
| ----- | --------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| R-01  | a stored icon is canonicalised to null on every read and write        | `normalizeExplicitMainMenu` keeps `config.iconSlot`      | `bot-menu-builder-contracts.test.ts` › canonicalises every icon to null, and keeps the screen slot exactly as stored; › decides "nothing changed" without the icon, so an icon alone is never a pending change | KILLED |
| T3-29 | a press that does not travel is not a drag                            | `DRAG_THRESHOLD_PX = 0`                                  | `bot-buttons-dnd.test.tsx` › a press becomes a drag only after the pointer travels the threshold; `bot-buttons-builder.test.tsx` › a press on a grip that does not travel moves nothing, whatever is under it  | KILLED |
| T3-30 | a drop that changes nothing is null (no placeholder, no announcement) | `applyDrop` returns the unchanged layout instead of null | `bot-buttons-dnd.test.tsx` › answers null for every drop that would leave the layout as it is (no accidental reorder)                                                                                          | KILLED |
| T3-31 | the gaps are laid out before a drag, so starting one moves nothing    | the gaps are rendered only while `drag.source !== null`  | `bot-buttons-builder.test.tsx` › keeps the layout still when a drag starts, and draws the placeholder and target row over it                                                                                   | KILLED |
| T3-32 | a pending restore or reset never reads as the state before it (QA-6)  | the `saving` state covers the draft save only            | `bot-buttons-builder.test.tsx` › QA-6 never reads «published» while a restore is replacing the draft; › QA-6 the same for a reset                                                                              | KILLED |

T3-30 is held by the pure test only: the page's own "nothing changed" check in `onMove`
masks the mutation for a key dropped where it already is, so the page-level case
(› a drop where the key already is, or a cancelled drag, changes nothing and says nothing)
survives it — it pins the outcome, the pure test pins the rule.
