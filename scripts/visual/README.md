# Visual verification

`capture.mjs` serves the **real production build** of the Web Admin —
`apps/web/dist`, byte for byte what a release publishes — answers `/api` and
`/health` from `fixtures.mjs`, and visits every route in three views: desktop
dark, desktop light, and a 390px mobile viewport. Nothing about the page is
mocked: the router, the query client, the components and the stylesheet are
the shipped ones.

It is a **measurement**, not an impression. Each visit records:

| Field                            | What a non-zero value means                       |
| -------------------------------- | ------------------------------------------------- |
| `horizontalOverflow`             | the page body scrolls sideways                    |
| `documentScrolledInsteadOfShell` | the whole document scrolled, not the content area |
| `stillLoadingAfterSettle`        | a skeleton was photographed instead of a screen   |
| `showingErrorState`              | the page rendered its error state                 |
| `consoleOrPageErrors`            | a console error or an uncaught exception          |
| `themeMismatches`                | the requested theme was not the one applied       |
| `nonRtl`                         | the document was not right-to-left                |

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
