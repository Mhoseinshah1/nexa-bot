# Web Admin redesign — status

| Field              | Value                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| State              | **APPROVED** — the owner approved the Web Admin demo (`nexa-admin-demo-polish.html`)           |
| Since              | 2026-10-16 (owner instruction; previously paused since 2026-10-12)                             |
| Approved reference | the owner's implementation pack (demo + `spec/*.md`); kept OUTSIDE the repository              |
| Allowed now        | the changes the pack's specs list (W1–W6), implemented on `feat/web-admin-demo-implementation` |

## What the approved reference covers (2026-10-16)

- **Routes:** every route in `nav.ts` plus the detail routes, grouped as core, svc, sup, cat,
  mkt, fin, lgr, bot, inf and sys in the pack's `spec/` files.
- **It decides (presentation only):** compact filter bars and local saved filters, Jalali date
  fields, a Persian file picker, action panels, tabs and drawers instead of in-page scroll
  jumps, layout without holes, 10 rows per page, Persian errors, and removed meta notes.
- **`main` keeps deciding:** function, data, wire formats, permissions and security — the
  demo was built from the real code, and where they disagree on a capability the code wins.
- **Not carried over:** the quick receipt review (on hold), rich-message bot buttons, shared
  («all admins») saved filters, the demo's state bar and its sample-scenario boxes, and any
  figure the API has no field for (e.g. saved-filter result counts).

## Theme: Liquid Glass «mono» — APPROVED (2026-10-18)

| Field              | Value                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| State              | **APPROVED** — the owner approved the Liquid Glass «mono» theme of `nexa-admin-demo-polish.html`, dark and light |
| Since              | 2026-10-18 (owner instruction)                                                                                   |
| Approved reference | the owner's glass-theme pack (the demo + its `skin.css` and mono palette); kept OUTSIDE the repository           |
| Allowed now        | the theme change on `feat/web-admin-glass-theme`; side-by-side evidence in `docs/web-redesign/glass-theme/`      |

- **It decides (presentation only):** the mono palette (black and white UI; status colours kept
  coloured for meaning; charts kept coloured), the glass shell (mesh background, floating glass
  sidebar and top bar, the phone's glass bottom-navigation capsule), capsule controls (buttons,
  icon buttons, search, chips, toggles, segmented controls, tab rails), card styles (solid
  legible panels on work pages, glass cards on the dashboard), radii (20px cards, 12px inputs,
  999px controls, 24–26px drawers and dialogs) and motion (press scale, drawer easing), with
  `prefers-reduced-transparency` and `prefers-reduced-motion` honoured.
- **`main` keeps deciding:** function, data, wire formats, permissions and security. No page
  logic, request, route, gate, idempotency key, confirmation or text key changes with the theme.
- **Not carried over:** the demo's other palettes, its palette and identity switchers, its state
  bar and sample-scenario boxes, and its sample data.
- The rules of `SKILL.md` still bind the theme: colours through `tokens.css` only, no `style=`
  attributes (CSP `style-src 'self'`), logical properties, 44px touch targets, and AA contrast
  pinned by `tests/unit/web-token-contrast.test.ts` (glass surfaces over the mesh included).

## When a reference is approved

The owner will supply it. Record here, in the same commit that adds it:

- where the reference lives (path under this directory, or a link) and its
  approval date;
- which routes or page families it covers;
- what it decides (presentation only) versus what `main` keeps deciding
  (function, data, permissions, security — as in the previous wave,
  `docs/web-redesign/foundation.md` §0/§6);
- anything the reference shows that NEXA has no data for — listed as
  "not carried over", never drawn with sample values.

Do not add unapproved design files here.

## Demo parity: layout and composition — APPROVED (2026-10-18)

| Field              | Value                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| State              | **APPROVED** — the owner's master prompt (2026-10-18): the approved demo is the specification for layout |
| Since              | 2026-10-18 (owner instruction)                                                                           |
| Approved reference | `docs/web-redesign/demo-parity/reference/` (the demo HTML and its screenshots) and `DIFFS.md`            |
| Allowed now        | the composition changes `DIFFS.md` lists (95 MAJOR, 116 MINOR, X1–X11), on `feat/web-admin-demo-parity`  |

- **It decides (presentation only):** composition, order, sizes and placement on every route — the shell (top
  bar, page header with breadcrumb, sidebar), the dashboard's blocks, and each page's layout, not only colours.
- **`main` keeps deciding:** function, data, wire formats, permissions and security. Where `DIFFS.md`
  conflicts with a tested rule of `SKILL.md` (counted pagers without a server total, client-side paging or
  counts, sample data, `style=` attributes), the rule wins and `AUDIT.md` records the item as ⛔ with the rule.
- **Not carried over:** the quick receipt review banner (on hold), the demo-only state bar and «داده نمونه»
  badge, the incident banner's sample content, and any figure the API has no field for.
- Every item's outcome is in `docs/web-redesign/demo-parity/AUDIT.md`. Do not merge without the owner's
  visual review.
- **Latin digits (owner decision, R11 — reverses the earlier "Persian digits" choice):** every number
  and date the admin draws uses Latin digits (`1,250,000`, `1405/07/14 19:30`); `font-feature-settings:
'ss01'` is gone and every formatter is `fa-IR-u-nu-latn`. The Jalali CALENDAR stays. A web test
  (`tests/web/latin-digits.test.tsx`) fails if U+06F0-U+06F9 appear in rendered DOM.
