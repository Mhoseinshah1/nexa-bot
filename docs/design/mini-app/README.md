# Mini app design (reference)

The owner's design for the customer-facing Telegram Mini App, committed verbatim from
`nexa-miniapp-design.zip` (Round 9, item C5). It is a **design**, not data and not code:
nothing under `project/` is built, served or imported.

- `project/*.dc.html` — 19 artboards, 390×844 (the service screen is taller), Persian RTL,
  the dark Liquid Glass look of the Web Admin, plus two light variants (`MainLight`,
  `ServiceLight`) that follow the customer's Telegram theme colours.
- `project/canvas.json` — the screen titles and their order on the canvas.
- Each artboard references a `support.js` that is not part of the zip; it is the design
  tool's runtime and is not needed to read the markup.
- The artboards load Vazirmatn from Google Fonts. The shipped app does not: it self-hosts the
  same variable font the Web Admin uses, under a CSP that allows no third-party font.

## Placeholders are never shipped copy

Bracketed text — `[نام برنامه ۱]`, `[نام صاحب کارت]`, `[درصد پاداش]`, `@[username]`,
`https://[your-domain]/sub/…` — marks where a real value goes. The real value always comes
from the API; a bracketed string never appears in `apps/miniapp`. The same holds for every
figure drawn in the artboards (balances, prices, counters, dates): they illustrate a layout
and are never rendered as data.

## The hard rule

The mini app exposes only capabilities Nexa already has. An element whose capability does not
exist is hidden (or, where hiding breaks the layout, kept as a neutral placeholder), never
built and never faked. The element-by-element map — which service backs each element and
which elements are hidden and why — is in the C5 pull request description, and it is the
reference when a later screen is built.
