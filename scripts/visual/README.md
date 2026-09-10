# Visual verification

`capture.mjs` serves the **real production build** of the Web Admin —
`apps/web/dist`, byte for byte what a release publishes — answers `/api` and
`/health` from `fixtures.mjs`, and visits every route in three views: desktop
dark, desktop light, and a 390px mobile viewport. Nothing about the page is
mocked: the router, the query client, the components and the stylesheet are
the shipped ones.

It is a **measurement**, not an impression. Each visit records:

| Field                                    | What a non-zero value means                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `horizontalOverflow`                     | the page body scrolls sideways                                                            |
| `documentScrolledInsteadOfShell`         | the whole document scrolled, not the content area                                         |
| `stillLoadingAfterSettle`                | a skeleton was photographed instead of a screen                                           |
| `showingErrorState`                      | the page rendered its error state                                                         |
| `consoleOrPageErrors`                    | a console error or an uncaught exception                                                  |
| `themeMismatches`                        | the requested theme was not the one applied                                               |
| `nonRtl`                                 | the document was not right-to-left                                                        |
| `capturesRenderingSomethingSecretShaped` | a connection string, a key envelope, a token or a PEM block appeared in the rendered text |

`stillLoadingAfterSettle` and `showingErrorState` are the load-bearing pair.
Between them they have caught fixture drift **three times** on this branch
alone — a missing `source` on a feature flag, a `blastRadius` of `OPERATIONAL`
where the enum says `LOCAL`, a new `schedulerCapacityExceeded` field, and a
required `nextCursor` the notification response had gained. Each time the
symptom was the same: a route rendering its error state or a skeleton in all
three views, with nothing else wrong.

Treat a non-zero count in either as fixture drift until proven otherwise, and
check the response schema for the affected route first. They exist because they
have both already fired for real. A `fixtures.mjs` that had drifted from the frozen
schemas — a missing `source`, a `blastRadius` of `OPERATIONAL` where the enum
says `LOCAL` — made four routes render a loading skeleton, and the captures
were reported as a clean pass because nobody had compared them. The check is
falsifiable: change one fixture field to a value its schema rejects and that
route comes back `showingError: true`.

The secret scan runs on EVERY capture rather than on the routes that obviously
handle secrets, because a secret reaches a page through a RESPONSE SHAPE and not
through a route — so the route that leaks one is by definition the route nobody
thought to check. It matches against the rendered text, so a database name an
operator needs to see (`nexa_pre_restore_...`) is not a hit while a URL carrying
a password is.

## Interactive states

Two captures are REACHED rather than visited, because no URL addresses them:

- **`panel-created`** — the create confirmation an edit-only actor gets, which
  exists only for an actor holding `panels.edit` and NOT `panels.view`.
- **`recovery-confirm-armed`** — the restore confirmation, which exists only
  after an archive has been uploaded and has PASSED a restore test, and whose
  button is disabled until the exact phrase is typed. The pass drives upload →
  verify → a near-miss phrase → the exact phrase → confirm, capturing each, and
  MEASURES the three properties a screenshot cannot prove: disabled at rest,
  still disabled for `restore nexa`, enabled only for `RESTORE NEXA`.

## Running it

Playwright is **not** a dependency of this repository, and this script is not
on the `pnpm verify` path. Install it out of tree:

```bash
pnpm --filter @nexa/web build
npm i --no-save playwright && npx playwright install chromium
node scripts/visual/capture.mjs apps/web/dist /tmp/screens
```

The summary is written to `<output-dir>/verification.json` alongside the PNGs,
so a stale summary cannot be mistaken for a current one. Any commit message or
report citing these numbers must cite that file from the run it describes.

## Keeping the fixtures honest

`fixtures.mjs` shapes its responses to the schemas in `@nexa/contracts`. When a
contract changes, this file changes with it — and the two loading/error
counters above are what tell you it did not.
