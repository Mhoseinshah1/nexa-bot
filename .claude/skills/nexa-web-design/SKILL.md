---
name: nexa-web-design
description: Rules for changing the NEXA Web Admin (apps/web) — React + TypeScript, Persian RTL with Vazirmatn, dark/light tokens, responsive and touch targets, accessibility, CSP, and keeping APIs, permissions and business logic untouched while never showing demo or fabricated data. Use before editing anything under apps/web or tests/web, or when asked about the admin's look, layout, theme or a page's UX.
---

# Web Admin (apps/web)

**Status: the visual redesign is PAUSED.** No new design reference has been
approved. Until the owner approves one, do not change theme, palette, layout,
spacing, typography, iconography or page composition — only functional fixes
the owner asked for, in the existing look. The approval state and where the
approved reference will go are in `references/redesign-status.md`; read it
before any visual work.

## What the admin is

- React 19 + TypeScript, Vite, TanStack Query. `apps/web` may import only
  `@nexa/contracts` and `@nexa/i18n` (boundary check enforces it).
- `index.html` is `lang="fa" dir="rtl"`. Font: Vazirmatn (variable, self-hosted
  `/fonts/Vazirmatn-Variable.woff2`), falling back through `--font-ui`.
- Shell: `src/app.tsx` (`resolve()` routes and permission props), `src/shell.tsx`
  (sidebar, topbar, command search), `src/nav.ts`, `src/router.ts`.
- Kit: `src/ui/kit.tsx` (+ `overlays.tsx`, `confirm-dialog.tsx`, `unsaved.tsx`,
  `charts.tsx`). Use a kit component before writing markup; add to the kit
  rather than styling one page.
- Styles: `src/styles/tokens.css` (the only place a colour/size is decided),
  `base.css`, `kit.css`, `shell.css`, `styles/pages/<family>.css`.

## Rules that are tested — keep them

- **Theme:** dark is primary, light is a full second token set. `theme.ts`
  always writes `data-theme` on `<html>` (also for `system`); there is no
  `prefers-color-scheme` block in CSS. Every colour goes through a token; a
  literal colour exists in one theme only. Contrast is pinned by
  `tests/unit/web-token-contrast.test.ts` (AA on every surface).
- **RTL:** logical properties only (`margin-inline-start`, `inset-inline-end`,
  …). `dir="ltr"` / `Ltr` only around technical values (hashes, URLs, codes).
- **CSP:** `style-src 'self'` — no `style=` attributes. Continuous values go
  through SVG attributes (`Progress`, `Meter`, charts). `tests/web/csp.test.tsx`.
- **Touch:** on `(pointer: coarse) and (hover: none)` controls are 44px
  (`--ctl-h`). Raise a target inside that block so desktop stays dense.
  `tests/unit/web-touch-tokens.test.ts`, `pnpm web:responsive`.
- **Accessibility:** visible `:focus-visible` rings (base.css), reduced-motion
  honoured, real buttons/links, labelled inputs, dialogs via the kit (focus
  trap, portal). Keyboard reachability is part of done.
- **Text:** every visible string is a key in `src/i18n/web.fa.ts` (or the shared
  `@nexa/i18n` catalogue); `pnpm check:i18n`. No literals in pages.

## Behaviour a visual change must never alter

- **API and data:** the contracts schemas in `packages/contracts` are the
  wire; do not change a request, a query key, a mutation or an idempotency key
  to make a layout easier.
- **Permissions:** arrive as props from `resolve()`; never derived inside a
  page. A denied card shows an info banner naming the permission and issues
  **no request** (`enabled: mayX`). The server checks again; hiding a button is
  never the security.
- **Lists:** keyset cursors, server order. No client sorting, offset paging or
  client-side counts; any count shown is a server total.
- **Money:** `formatMoney`/`formatMoneyText` over `MoneyWire` (bigint minor
  units + currency). Missing data draws an em dash, never `0` — a fabricated
  zero is a wrong financial statement (FIX-12).
- **No demo data in production:** no mock modules, sample rows, `useMockAction`,
  preview banners or placeholder figures in `apps/web/src`. Fixtures live only in
  `tests/web/**` and `tests/web/shots/fixtures/**`. If the API has no field
  for something a design shows, it is not drawn.
- **Dirty state:** forms use `useUnsavedChanges`; leaving a dirty form asks.

## Checking a web change

- `bash .claude/skills/nexa-test-selection/scripts/select-tests.sh` for the
  targeted `tests/web` files, then `pnpm test:web` before the PR is ready.
- Visual evidence: `pnpm web:shots` (fixtures in `tests/web/shots/fixtures/`)
  and `pnpm web:responsive` (390px phone, tablet, coarse pointer).
- Per-page capability inventories from the last redesign wave are in
  `docs/web-redesign/<family>.md` (large — grep the route, read that section).
