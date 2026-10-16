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
