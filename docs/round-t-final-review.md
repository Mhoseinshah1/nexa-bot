# Round T — T4 hostile final review (Telegram Button Builder)

Status: **review record, no source change.** Reviewer: T4 (did not write the code). Every
experiment below was run in the reviewer's own worktree (`/home/user/wt-round-t4`, branch
`round-t/t4-final-review`) against its own database (`nexa_test_t4`, Redis db 10), with every
source mutation restored byte for byte (SHA-256 checked by the driver) before the next one.
This file is the only committed output.

## 1. Scope

| Item                | Value                                                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewed head       | `main` at **`f9be46f1`** (merge of PR #135)                                                                                                                                                                             |
| Base (pre-Round-T)  | `25e717a`                                                                                                                                                                                                               |
| PRs in scope        | #133 T0+T1 (merge `5070a21a`), #134 T3 web (merge `9229da43`), #135 T2 wire (merge `f9be46f1`)                                                                                                                          |
| Diff reviewed       | `git diff 25e717a..f9be46f` — 51 files, +35 780 / −633 (24 886 of the added lines are the generated `0156_snapshot.json`)                                                                                               |
| Inputs read         | `CLAUDE.md`, `docs/conventions.md`, the owner brief, `docs/round-t-button-builder-audit.md`, `docs/round-t-t{1,2,3}-falsification.md`, `docs/open-questions.md` (OQ-T-API-01..05), `docs/deployment.md` round T section |
| Owner's stated risk | "a beautiful second menu system that drifts from Nexa's real Telegram routing, gates, appearance, rollback guarantees and source of truth"                                                                              |

**Verdict: no BLOCKER, no HIGH.** One MEDIUM (an unprotected idempotency rule) and ten LOW.
The design holds where the owner feared it would not: there is one source selection, one
rendering rule, one route table independent of the layout, a projection the previous
release parses (proven over 161 616 generated layouts against the real `25e717a` parser),
and a wire change that is byte-identical for every tenant that has not published.

## 2. Gate results (this worktree, at `f9be46f1`)

| Gate                    | Result                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`            | PASS                                                                                                                                            |
| `pnpm verify`           | PASS (exit 0): typecheck, lint, format, boundaries, i18n, citations, shell, unit **179 files / 2 860 tests**, web **68 / 1 408**, deploy, build |
| `pnpm db:check`         | PASS — "schema and migrations agree"                                                                                                            |
| `pnpm test:integration` | PASS — **174 files / 3 567 tests**, against `nexa_test_t4` only, no other suite on that database                                                |
| Rollback probe (§6)     | PASS — 161 616 valid layouts out of 196 608 generated; every projection parses under the `25e717a` schema                                       |
| Mutation (§7)           | 22 mutations: 19 KILLED, 3 SURVIVED (findings F-1, F-4, F-5)                                                                                    |

A first `pnpm verify` run failed at `eslint` on the reviewer's own temporary probe directory
(`packages/contracts/.t4old`), which had been created while it ran; the directory was removed
and the gate re-run from clean (the PASS above). Not a defect of Round T.

## 3. Definition of Done

The brief numbers its Definition of Done 1–30 in chat; the scratch copy carries the bullets,
not the numbering. The 30 rows below are the brief's bullets in its own order, one criterion
each.

| #   | Criterion                                                                                                                                     | Verdict | Evidence                                                                                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Extends the existing main menu; no parallel engine, registry, labels, router or preview                                                       | PASS    | One registry (`MAIN_MENU_BUTTONS`), one evaluator (`MainMenuLayout`), `customerRowsOf` shared by runtime (`main-menu.ts:255`) and web (`builder.tsx:537,544`); `routesFor` unchanged and layout-independent (`main-menu.ts:287-305`); M01/M02/M03 KILLED                                          |
| 2   | T0 read-only audit with source of truth, readers/writers, routing, wire, labels, gates, appearance, history, concurrency, rollback, ownership | PASS    | `docs/round-t-button-builder-audit.md` §1–§15                                                                                                                                                                                                                                                     |
| 3   | Main reply keyboard only; Telegram `style` / `icon_custom_emoji_id` understood                                                                | PASS    | Only `textMessageBody.keyboard` changed (`send-message.ts:408-423,486-496`); inline markup untouched; OQ-T-API-01/02/04 owner-confirmed                                                                                                                                                           |
| 4   | Drag/drop rows, any practical number per row, reorder rows and buttons                                                                        | PASS    | `model.ts` placement primitives, `dnd.ts`; row length bound = registry size, not a Telegram cap (OQ-T-API-03)                                                                                                                                                                                     |
| 5   | Available pool from the declared registry only; no arbitrary callbacks, URLs or commands                                                      | PASS    | `explicitMainMenuSchema` closed enums + `.strict()` (M04 KILLED); targets not stored, taken from the registry                                                                                                                                                                                     |
| 6   | Remove (unplaced) and disable are distinct; explicit row/column model                                                                         | PASS    | `customerRowsOf`; T3-05/T3-06; M16 KILLED (legacy OFF → unplaced)                                                                                                                                                                                                                                 |
| 7   | Legacy layouts produce an identical keyboard until publish                                                                                    | PASS    | `keyboardFor` legacy branch (`main-menu.ts:268-274`); wire: strings/descriptors without style/icon are `{text}` (`send-message.ts:408-423`); integration "keeps a never-published tenant's keyboard byte for byte on an ELIGIBLE bot"                                                             |
| 8   | Backward/rollback compatibility proven                                                                                                        | PASS    | §6 probe against the real `25e717a` parser (161 616 layouts); `bot.main_menu` schema untouched; migration 0156 additive only. Doc nuance F-3                                                                                                                                                      |
| 9   | Targets closed, read-only, server-validated                                                                                                   | PASS    | Server re-parses on save and again on publish (`bot-menu-builder.service.ts:218,400`); projection pins the declared target                                                                                                                                                                        |
| 10  | Labels stay `bot.menu.*` templates, edited through the existing template mechanism                                                            | PASS    | No label in the draft; no `bot.menu.*` text duplicated into `apps/web/src` (scanned the diff); `templates.edit` unchanged                                                                                                                                                                         |
| 11  | Renamed/default labels still route; duplicate warnings; slash labels cannot steal commands                                                    | PASS    | `routesFor` untouched in substance; `duplicateLabel` / `slashLabel` in items; integration R-3; M01 KILLED                                                                                                                                                                                         |
| 12  | Styles: closed enum, `default` omitted                                                                                                        | PASS    | `MAIN_MENU_BUTTON_STYLES`; `replyKeyboardButtonMarkup` whitelist; T2-01/02/12                                                                                                                                                                                                                     |
| 13  | Icons via Appearance; distinct `iconSlot` documented; per-bot eligibility at send for the SENDING bot                                         | PASS    | Audit §7; `decorationFor(scope, message.botInstanceId)` (`telegram-customer-messenger.ts:405`); T2-03/T2-14. Builder-side eligibility is a second copy of the predicate (F-4)                                                                                                                     |
| 14  | Definite rejection → one icon-less retry keeping text/style; reliable denial only marks the bot; UNKNOWN never resent                         | PASS    | `deliverDecorated` (`:1181-1214`); T2-04..09, T2-11, T2-13; R-5 integration. Cost noted in F-10                                                                                                                                                                                                   |
| 15  | One structured descriptor in the shared transport; no fork                                                                                    | PASS    | `TelegramReplyKeyboardButton` in `send-message.ts`; no second body builder                                                                                                                                                                                                                        |
| 16  | Gates backend-authoritative; builder shows placed/enabled/hidden-now; no fake buttons                                                         | PASS    | `gateAnswersOf` is a pass-through (`model.ts:274-284`); T3-01/02; M03 KILLED; never-empty keyboard (§4.4)                                                                                                                                                                                         |
| 17  | Durable versioned draft; optimistic concurrency                                                                                               | PASS    | `main_menu_layouts.draft_version`, predicate in the statement (T1-01); P-2                                                                                                                                                                                                                        |
| 18  | Runtime reads only Published                                                                                                                  | PASS    | `PublishedMainMenuSource` (T1-06); P-4                                                                                                                                                                                                                                                            |
| 19  | Atomic publish, projection consistent                                                                                                         | PASS    | One transaction (`publish`, `:377-551`); P-1; T1-03; M11 KILLED                                                                                                                                                                                                                                   |
| 20  | Revisions append-only (id, tenant, snapshot, actor, timestamp, restoredFrom); retention per conventions                                       | PASS    | Migration 0156 triggers; composite tenant FKs; "keeps revisions append-only by trigger"; retention = tenant life (OQ-T-3, audit only — F-9)                                                                                                                                                       |
| 21  | Restore → draft → publish = new revision; Reset → draft (confirmed); default from the registry                                                | PASS    | `restore`, `reset` (`confirm: z.literal(true)`); H-1 tests; M12/M17 KILLED                                                                                                                                                                                                                        |
| 22  | `/bot-buttons` same route: pool, phone canvas DnD, Inspector (label, enabled, style, icon, target read-only, gate, warnings, advanced)        | PASS    | `bot-buttons.tsx`, `bot-buttons/{builder,canvas,inspector}.tsx`; web suite                                                                                                                                                                                                                        |
| 23  | Save/Publish/Reset/History; states Saved/Unsaved/Differs/Publishing/Published/Conflict/Invalid; unsaved guard                                 | PASS    | `builder.tsx:490-506`; T3-10..T3-18. Superseded wording in the publish dialog: F-2                                                                                                                                                                                                                |
| 24  | Non-drag accessible fallback; touch                                                                                                           | PASS    | Keyboard moves (`builder.tsx:330-337`, RTL-aware), Inspector move buttons, pointer events with `touch-action: none` on grips (`dnd.ts:8-12,113-116`)                                                                                                                                              |
| 25  | Responsive 1440/900/390, light+dark, RTL; no fake premium emoji; customer vs editor preview                                                   | PARTIAL | No fake emoji (`IconMark` draws the slot's fallback in a dashed outline, `canvas.tsx:32-43`); three modes `edit`/`customer`/`live`; RTL handled. **No recorded visual QA** at the three widths in light/dark — fixtures only (`tests/web/shots/fixtures/ops-a.ts`). Needs a human screenshot pass |
| 26  | `settings.view` / `settings.edit`; template edit keeps its permission                                                                         | PASS    | `BOT_MENU_BUILDER_*_PERMISSION`; H-2; M10 KILLED                                                                                                                                                                                                                                                  |
| 27  | Audit draft saved / published / reset / restored, not drags                                                                                   | PASS    | `BOT_MENU_BUILDER_AUDIT_ACTIONS`; denials audited; M12 KILLED                                                                                                                                                                                                                                     |
| 28  | Tenant and BotInstance isolation tests                                                                                                        | PASS    | "isolates tenants, and serves one published layout to every bot"; T2 "icon only from the bot that proved eligibility"; M09 KILLED                                                                                                                                                                 |
| 29  | Mutation/falsification tests for critical invariants                                                                                          | PARTIAL | 61 prior rows (T1 19, T2 15, T3 27) all KILLED by their authors; this review's 22: 3 SURVIVED — F-1 (MEDIUM), F-4, F-5                                                                                                                                                                            |
| 30  | Process: one Codex review per PR, exact-head CI green, no tag/release/deploy; real-Telegram acceptance checklist                              | PARTIAL | No tag contains a Round T commit (`git tag --contains 25e717a`: none). Codex/CI history not re-verified here. Acceptance list exists (audit §13) and is extended in §8 below; **not yet run**                                                                                                     |

## 4. What was attacked, and what held

### 4.1 Source of truth / drift

- **One selection.** `PublishedMainMenuSource.fromState` (`main-menu-source.ts:93-127`) is
  the only decision of EXPLICIT vs LEGACY. The runtime calls it through `snapshotFor`; the
  builder's `view` calls it with the same one-statement state read (`readMenuState`,
  `drizzle-main-menu-builder.repository.ts:285-341`) and pins `describeFor`/`rowsFor` to that
  snapshot. T1-18/T1-19 and P-8 hold; M02 additionally kills P-8.
- **Drawn vs routed cannot disagree.** `routesFor` renders every declared button regardless
  of source, placement, switch or gate (`main-menu.ts:287-305`). Mutating it to route only
  drawn labels (M01) is killed by three tests, including the explicit-layout one.
- **Text equals route key.** The keyboard text is the rendered template, never decorated;
  an icon is a separate field (T2-10). `replyKeyboardFor` copies `text` verbatim.
- **`/bot-menu` and command sync.** `BotMenuService.config` reads `describeFor`, which on
  EXPLICIT describes the projection (placed row-major, unplaced off) — the same shown set
  `customerRowsOf` draws. The command menu (`command-menu.ts:54-64`) derives only from
  `bot.command.*` templates, so it cannot drift from the keyboard; the publish's
  `SettingChanged` merely queues a harmless re-derive (M11 KILLED).
- **No second writer from the web.** `apps/web/src` no longer calls `saveSetting` for
  `bot.main_menu`; it is listed in `SETTINGS_MANAGED_ELSEWHERE`.

### 4.2 Rollback / upgrade

- Proven by experiment (§6), not by the frozen copy alone: every layout the builder accepts
  projects to a value the real `25e717a` `mainMenuLayoutSchema` parses, and the old
  release's visible order with every gate open equals the new keyboard's row-major order.
- Superseded detection (`main-menu-source.ts:46`) and the legacy-baseline 409
  (`bot-menu-builder.service.ts:417-431`) hold: M21, M22, T1-07, T1-14, T1-15.
- Migration 0156 is additive (two tables, own triggers, composite tenant FKs); no CHECK
  widened, no event type added. Its rollback note is accurate; the "publishes again" wording
  in it and in `docs/deployment.md` omits the required reseed (F-3).

### 4.3 Concurrency

- Draft/publish/reset/restore: row `FOR UPDATE`, version predicates in the statements
  (T1-01/02), revision numbered under the lock. Same key + different body on **publish** is
  refused (P-3); on **draft** it is not tested (F-1).
- The direct-settings guard closes the legacy path only after a publish. That is safe:
  before a publish the setting IS the keyboard, and a publish over a legacy write made after
  the draft was seeded is refused by the durable baseline (P-7). The guard's `FOR UPDATE`
  is defence in depth — the setting's own version predicate is what actually serialises a
  racing settings write against a publish (F-5).

### 4.4 Gates and the never-empty keyboard

`explicitMainMenuSchema`'s last refine demands a placed, enabled, UNGATED button
(`bot-menu-builder.ts:149-157`), and the published snapshot is re-parsed by that schema
before it is drawn (`readPublishedHead`). With every gate closed the keyboard therefore
keeps at least one button: confirmed by the §6 probe (`customerRowsOf(layout, {})` non-empty
for all 161 616 layouts). Even an empty row list would not reach Telegram as an empty
keyboard — `textMessageBody` omits `reply_markup` for `keyboard.length === 0`. Trial and
referral are hidden by `customerRowsOf` unless the server's answer is exactly `true` (M03
KILLED); React only passes `gateOpen` through (T3-01/02).

### 4.5 Wire

Legacy byte-identical (T2-12, integration); `default` omitted, only the three Telegram
styles emitted (T2-01, M19 for the empty icon); icon only from `decorationFor(sending bot)`
(T2-03); B5: one retry on FAILED_PERMANENT only, capability downgrade only on the probe's
classifier (T2-07/08/09/13); inline buttons win and suppress the iconed-retry logic
(T2-15, M14); admin row plain (M13).

### 4.6 Permissions, tenancy, scope

Read `settings.view`, writes `settings.edit` checked early and in the transaction
(`runAuthorizedMutation`); denials audited (M10). Revision lookup tenant-scoped (M09). Scope
activity read inside the transaction (T1-08). `templates.edit` untouched.

### 4.7 Owner "Do NOT" list

No Mini App / `web_app` / `callback_data` / `login_url` / `request_*` field added anywhere in
the diff; no reseller, AI Support or Virtual Services file touched (the only matches are the
regenerated drizzle snapshot); no arbitrary targets; no label strings duplicated; history is
server-side (`main_menu_revisions`), not browser-only; the old compatibility path
(`bot.main_menu`, `GET /bot-menu`, sync and commands cards) is kept.

## 5. Findings

Owner column: who should fix it. No finding blocks the round.

### F-1 — MEDIUM — draft-save idempotency: "same key, different layout" is an unprotected rule

- **Where:** `apps/api/src/modules/control/bot-menu-builder/application/bot-menu-builder.service.ts:232-237`.
- **Evidence:** M08 removed `layout` from the draft request hash. The whole builder
  integration file stayed green. P-3 tests key reuse for **publish** only.
- **Failure scenario (if the rule regresses):** the page retries a save under the same key
  after a dropped response, and the operator has edited in between. The server replays the
  first answer (`changed: true`, the older draft) with no error; the page adopts it and the
  newer edit is gone without a word — the "reports success for a write that did not happen"
  pattern. The code is correct today; nothing would notice its reversion.
- **Fix:** one integration test — `saveDraft` twice with one key and two different layouts,
  expect the idempotency-conflict refusal and a single `bot_menu.draft_saved` audit row.
- **Owner:** T1.

### F-2 — LOW — publish dialog says "no layout change" while the customer keyboard changes (superseded)

- **Where:** `apps/web/src/pages/bot-buttons/builder.tsx:891-917` (`PublishDialog`).
- **Scenario:** an older release wrote `bot.main_menu` during a rollback; on roll-forward
  the layout is superseded and customers see the older release's arrangement. The operator
  reseeds LIVE, restores revision 1 and publishes — exactly P-5's path. The dialog diffs the
  draft against `view.published.layout` (revision 1) and prints
  `web.bb_publish_no_layout_change`, although the publish replaces what customers see. The
  dialog's two keyboards (live vs new) do show the difference, which is why this is LOW.
- **Fix:** add a `view.superseded` branch beside the unreadable one (T3-26's pattern): a warn
  banner "customers currently see the arrangement an older release wrote; publishing
  replaces it", and no "no change" sentence.
- **Owner:** T3.

### F-3 — LOW — "review the draft and publish again" is not the procedure

- **Where:** `docs/deployment.md:1795-1799`, `apps/api/drizzle/0156_round_t_button_builder.sql:12-14`,
  `packages/contracts/src/bot-menu-builder.ts:440-443`, `web.bb_superseded` (`web.fa.ts:5271`).
- **Scenario:** after a superseding legacy write, a publish of the existing draft is refused
  with `control.version_conflict` (the durable baseline, P-5). The operator must first
  reseed from the live keyboard (and, to bring the explicit layout back, restore a revision)
  — the page offers the reseed banner, but the runbook sends them straight to Publish.
- **Fix:** docs/text only — "reseed the draft from the live keyboard (and restore a revision
  if you want the published layout back), then publish".
- **Owner:** T1 (docs), T3 (text).

### F-4 — LOW — builder icon eligibility is a second copy of the runtime predicate, untested

- **Where:** `bot-menu-builder.service.ts:178` vs `drizzle-appearance.repository.ts:293-297`.
- **Evidence:** M15 (`eligible: bot.test != null`, i.e. a FAILED/REJECTED bot shown eligible)
  SURVIVED both builder and wire suites.
- **Scenario:** the Inspector lists a bot as "eligible" that the runtime will never decorate —
  a small instance of the drift the owner named.
- **Fix:** export one predicate (e.g. `isCustomEmojiEligible(bot)`) used by `decorationFor` and
  `view`, plus an assertion in "reports each button's gate…" style that a REJECTED bot reads
  `eligible: false`.
- **Owner:** T1/T2.

### F-5 — LOW — the settings guard's `FOR UPDATE` is untested (and is not what serialises)

- **Where:** `apps/api/src/modules/control/bot-menu-builder/application/main-menu-setting-guard.ts:20-24,35`.
- **Evidence:** M07 (`findLayout(scope, tx, false)`) SURVIVED.
- **Analysis:** benign. A racing settings write and publish both write `setting_values` under
  `version = expected`; at READ COMMITTED the loser's predicate re-evaluates after the
  winner commits and matches nothing. The comment, however, credits the row lock.
- **Fix:** either a two-transaction integration test, or reword the comment to name the
  version predicate as the guarantee and the lock as defence in depth.
- **Owner:** T1.

### F-6 — LOW — a system scope now gets the default keyboard instead of an error

- **Where:** `main-menu-source.ts:78-84`.
- **Analysis:** before Round T the legacy read went through `settings.find` →
  `requireTenantId`, which throws `TENANT_CONTEXT_MISSING` for a system scope (fail closed).
  The new special case answers `DEFAULT_MAIN_MENU_LAYOUT` (fail open). No caller passes a
  system scope today (the messenger and runtime are tenant-scoped), so it is unreachable.
- **Fix:** delete the special case; `readMenuState` already calls `requireTenantId`.
- **Owner:** T1. (Known nit, confirmed.)

### F-7 — LOW (nit) — stale comment on `rowsFor`

- **Where:** `apps/api/src/modules/commerce/messaging/application/main-menu.ts:277-281` —
  "what the transport draws until it carries styles and icons (round T, T2)". T2 merged; the
  messenger reads `keyboardFor`. `rowsFor` now serves only the text views (`/bot-menu`,
  builder `live`). Reword. (Known nit, confirmed.) **Owner:** T2.

### F-8 — LOW — no "new" badge for a button a later release adds (Codex #134 finding 7)

- **Where:** OQ-T-2 default (audit §11.2, §14) promises a "new" badge; `canvas.tsx` has none.
- **Severity reasoning:** unreachable in this release — the registry is unchanged, so no
  tenant can hold a layout missing a declared button except through the normalisation path
  that M05 shows is tested (unplaced, never drawn). The cost lands only when a release adds a
  ninth button, and the customer impact is nil (it stays in the pool and still routes).
  Rejecting it for this round is acceptable **provided** the obligation is recorded where the
  next round will find it.
- **Fix:** add to `docs/open-questions.md` under OQ-T-2: "the release that adds a button must
  ship the pool badge".
- **Owner:** Lead.

### F-9 — LOW — OQ-T-1..OQ-T-4 live only in the audit

- **Where:** `docs/round-t-button-builder-audit.md` §14; absent from `docs/open-questions.md`
  (which carries OQ-T-API-01..05 only).
- **Fix:** copy the four owner decisions (labels live, future button unplaced, revisions kept
  for the tenant's life, icon eligibility shared with decoration) with their status.
- **Owner:** Lead.

### F-10 — LOW — B5's cost: a generic 400 on an iconed message also suspends the old text-decoration downgrade

- **Where:** `telegram-customer-messenger.ts:1194` (`denied = !iconed || isCustomEmojiDenial(...)`).
- **Scenario:** a message carries BOTH decorated text and an iconed keyboard; Telegram refuses
  it with a description that does not name custom emoji. Before Round T a decorated-text
  refusal switched the bot's decoration off; now nothing is switched off, so every such
  message costs a refused request plus a retry, indefinitely (the ops condition is
  deduplicated, so the operator sees it once). This is literally what owner rule B5 asks for
  and is disclosed in OQ-T-API-05; it is listed so R-ACC-2 measures it.
- **Fix:** none now; widen `isCustomEmojiDenial` only from an observed Telegram sentence.
- **Owner:** Lead (acceptance).

### F-11 — INFO — visual QA not evidenced

DoD 25: no screenshots at 1440/900/390 × light/dark were recorded; only the shot fixtures
exist. Run `scripts/web-shots` against `/bot-buttons` and attach the set to the release
notes. **Owner:** T3/QA.

## 6. Rollback experiment (old parser, real `25e717a` source)

Method: `git archive 25e717a packages/contracts/src` into a temporary directory inside this
worktree (so `zod` resolves), and a vitest file importing the OLD `bot-commands.ts` beside the
NEW contracts. 3 × 256 × 256 iterations: every placed subset × every enabled subset × three
random orders/row breaks, random styles, icon slots, appearance slots, and 20% of layouts with
configs missing. For each layout the NEW `explicitMainMenuSchema` accepts:

1. `legacyProjectionOf(layout)`, JSON round-tripped, parses under the OLD
   `mainMenuLayoutSchema`;
2. the OLD `resolveMainMenuLayout` enabled order equals the NEW `customerRowsOf` row-major
   order with every gate open (same buttons, same order; only row breaks degrade);
3. the OLD value keeps an ungated enabled entry, and the NEW keyboard with every gate closed
   is non-empty.

Result: **tried 196 608, valid 161 616, 0 failures.** The temporary directory was deleted.
The probe, so the claim leaves its test behind (CLAUDE.md, "commit the probe"):

```ts
// placed at packages/contracts/.t4old/rollback.test.ts; old/ = git archive 25e717a packages/contracts/src
import { test, expect } from 'vitest';
import * as oldC from './old/bot-commands.js';
import {
  explicitMainMenuSchema,
  legacyProjectionOf,
  customerRowsOf,
  MAIN_MENU_BUTTON_IDS,
  MAIN_MENU_BUTTON_STYLES,
  APPEARANCE_SLOTS,
  MENU_APPEARANCE_SLOTS,
} from '../src/index.js';

let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;

test('every publishable layout parses under the 25e717a schema and keeps visibility+order', () => {
  let valid = 0;
  for (let placedMask = 0; placedMask < 256; placedMask++)
    for (let enMask = 0; enMask < 256; enMask++)
      for (let k = 0; k < 3; k++) {
        const ids = [...MAIN_MENU_BUTTON_IDS].sort(() => rnd() - 0.5);
        const placed = ids.filter((id) => placedMask & (1 << MAIN_MENU_BUTTON_IDS.indexOf(id)));
        const rows: string[][] = [];
        for (const id of placed)
          if (rows.length === 0 || rnd() < 0.4) rows.push([id]);
          else rows[rows.length - 1]!.push(id);
        const omitSome = rnd() < 0.2;
        const buttons = MAIN_MENU_BUTTON_IDS.filter(
          (id) => !omitSome || placed.includes(id) || rnd() < 0.5,
        ).map((id) => ({
          button: id,
          enabled: !!(enMask & (1 << MAIN_MENU_BUTTON_IDS.indexOf(id))),
          style: pick(MAIN_MENU_BUTTON_STYLES),
          iconSlot: rnd() < 0.5 ? null : pick(APPEARANCE_SLOTS),
          appearanceSlot: rnd() < 0.5 ? null : pick(MENU_APPEARANCE_SLOTS),
        }));
        const p = explicitMainMenuSchema.safeParse({ v: 1, rows, buttons });
        if (!p.success) continue;
        valid++;
        const old = oldC.mainMenuLayoutSchema.safeParse(
          JSON.parse(JSON.stringify(legacyProjectionOf(p.data))),
        );
        expect(old.success).toBe(true);
        const oldShown = oldC
          .resolveMainMenuLayout(old.data!)
          .filter((i) => i.enabled)
          .map((i) => i.button);
        const allOpen = Object.fromEntries(MAIN_MENU_BUTTON_IDS.map((id) => [id, true]));
        expect(oldShown).toEqual(
          customerRowsOf(p.data, allOpen)
            .flat()
            .map((b) => b.button),
        );
        expect(
          oldC
            .resolveMainMenuLayout(old.data!)
            .filter((i) => i.enabled && !oldC.mainMenuButtonIsGated(oldC.mainMenuButton(i.button)))
            .length,
        ).toBeGreaterThan(0);
        expect(customerRowsOf(p.data, {}).flat().length).toBeGreaterThan(0);
      }
  expect(valid).toBeGreaterThan(10000); // observed: 161 616
});
```

Recommendation (non-blocking): the repository's own C-2 uses a hand-frozen copy
(`tests/support/frozen-main-menu-schema.ts`); the copy and the real old file agree today, but
only this probe proves it. Keeping the generator in `tests/unit` against the frozen copy
would preserve the 161 616-case breadth.

## 7. Mutation table (this review, own driver)

Driver: a Python script that replaces one exact anchor (asserting it occurs once), rebuilds
`@nexa/contracts` `dist` when the file is under `packages/contracts`, runs the named suites
(unit `U` = builder-contracts, main-menu-layout, reply-keyboard-wire, messenger-appearance,
messenger-parts; web `W` = bot-buttons-builder, bot-buttons; `I1` = integration
bot-menu-builder; `I2` = integration telegram-reply-keyboard), restores the file, checks its
SHA-256 and rebuilds again. None of these rows repeats a T1/T2/T3 row's mutation.

| #   | Rule                                                                   | Mutation                                               | Suites    | Result       | Killed by (first)                                                                                            |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------ | --------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| M01 | every DECLARED button routes, drawn or not                             | `routesFor` keeps only labels `keyboardFor` draws      | U, I2     | KILLED       | main-menu-layout › ignores bot.main_menu while a layout is published, and routes every declared button still |
| M02 | the explicit keyboard applies the server's gate answers                | `keyboardFor` passes `true` for every gate             | U, I1, I2 | KILLED       | main-menu-layout › draws the operator's rows…; integration P-8                                               |
| M03 | an unknown gate answer is closed (contract)                            | `customerRowsOf` hides only on `=== false`             | U, W, I1  | KILLED       | builder-contracts › decides gates only from the answer it is given; web › draws a gated button exactly when… |
| M04 | a button config refuses undeclared keys                                | `.strict()` → `.passthrough()`                         | U, I1     | KILLED       | C-3 › refuses an unknown id, style or icon slot, and any undeclared key                                      |
| M05 | a button missing from `buttons` is unplaced, never auto-drawn (OQ-T-2) | `normalizeExplicitMainMenu` appends it as a new row    | U, W, I1  | KILLED       | builder-contracts › completes an UNPLACED button with no configuration into the pool                         |
| M06 | the projection is placed row-major, THEN unplaced                      | unplaced entries first                                 | U, I1     | KILLED       | main-menu-layout › describes placed buttons row-major, then the pool switched off                            |
| M07 | the settings guard reads the builder row `FOR UPDATE`                  | `findLayout(…, false)`                                 | I1        | **SURVIVED** | — (F-5; benign)                                                                                              |
| M08 | a draft key replayed with another layout is refused                    | `layout` dropped from the draft request hash           | I1        | **SURVIVED** | — (F-1)                                                                                                      |
| M09 | a revision is found only in its own tenant                             | `findRevision` drops the tenant predicate              | I1        | KILLED       | H-1 › answers another tenant's revision as not found                                                         |
| M10 | builder writes require `settings.edit`                                 | edit permission constant = `settings.view`             | I1        | KILLED       | H-2 › lets settings.view read and refuses every write without settings.edit                                  |
| M11 | publish emits the existing `SettingChanged`                            | outbox write skipped                                   | I1        | KILLED       | publish › draws the published rows, writes a projection… and SettingChanged                                  |
| M12 | reset is audited                                                       | reset's audit skipped                                  | I1        | KILLED       | H-1 › resets the DRAFT to the registry default only when confirmed                                           |
| M13 | the admin row is unstyled                                              | admin row gets `style: 'danger'`                       | U, I2     | KILLED       | wire › R-6 appends the admin row unstyled and without an icon                                                |
| M14 | inline buttons take precedence over the reply keyboard                 | keyboard wins when both are given                      | U, I2     | KILLED       | wire › R-6 lets inline buttons win over the reply keyboard                                                   |
| M15 | builder eligibility = runtime eligibility (`SENT` only)                | `eligible: bot.test != null`                           | I1, I2    | **SURVIVED** | — (F-4)                                                                                                      |
| M16 | legacy OFF converts to UNPLACED                                        | `explicitFromLegacy` places disabled items too         | U, W, I1  | KILLED       | C-1 › R1 shape / disabled / 500 generated legacy values                                                      |
| M17 | reset `LIVE` reseeds from the live setting                             | `LIVE` never matches (always DEFAULT)                  | I1        | KILLED       | P-7; P-6                                                                                                     |
| M18 | an explicit layout refuses an empty row                                | row `.min(1)` → `.min(0)`                              | U, I1     | KILLED       | C-3 › refuses an empty row and too many rows                                                                 |
| M19 | an empty icon id never reaches the wire                                | `iconCustomEmojiId !== ''` check removed               | U, I2     | KILLED       | wire › carries icon_custom_emoji_id beside an unaltered text, and never an empty one                         |
| M20 | the publish no-op compares the draft with what is published            | equality term dropped                                  | I1        | KILLED       | P-3; P-8; H-1 restore; revisions paging                                                                      |
| M21 | a superseded layout republishes even when the draft is unchanged       | projection-current term dropped from the no-op         | I1        | KILLED       | P-5                                                                                                          |
| M22 | superseded = setting version ≠ projection version                      | superseded only when the setting is ≥ 2 versions ahead | I1        | KILLED       | P-5                                                                                                          |

After the run: `git status --short` empty; contracts `dist` rebuilt from the restored source.

## 8. Open items needing real-Telegram acceptance (R-ACC)

None of these can be proven from the repository; all are for a staging bot, not production.

| ID      | Check                                                                                                                                                                         | Pass condition                                                                                                                                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-ACC-1 | Publish a layout using `primary`, `success`, `danger` and `default` on one keyboard; send `/start` on desktop, Android, iOS.                                                  | 200 from `sendMessage`; three visibly styled buttons, one default; no client drops the keyboard.                                                                                                                                                |
| R-ACC-2 | From a bot whose appearance test is `SENT`, set an icon slot; then from a bot known ineligible, force an icon (temporarily test-marked). Record status + exact `description`. | Eligible: icon drawn. Ineligible: either a 400 whose text the classifier recognises (bot marked) or a generic 400 (one retry, bot NOT marked, F-10's cost observed) — record which; widen the classifier only from that sentence (OQ-T-API-05). |
| R-ACC-3 | Tap every styled and every iconed button.                                                                                                                                     | The update's `text` is exactly the label; each reaches its command (catalog, services, wallet, help, apps, tickets, trial, referral).                                                                                                           |
| R-ACC-4 | Roll staging back to the pre-Round-T release after a publish.                                                                                                                 | Same order and visibility, two-per-row packing, no `settings.stored_value_invalid`.                                                                                                                                                             |
| R-ACC-5 | On the rolled-back release save «دکمه‌های ربات» once; roll forward.                                                                                                           | Keyboard follows the old save; builder shows superseded; Publish refused until reseed (F-3's procedure); after reseed → restore → publish, explicit again.                                                                                      |
| R-ACC-6 | One row with all 8 buttons; 8 rows of one.                                                                                                                                    | Telegram accepts both and the clients render them legibly (OQ-T-API-03 is a domain bound, not Telegram's).                                                                                                                                      |
| R-ACC-7 | A trial-gated and a referral-gated button placed, with the gates closed then opened.                                                                                          | Closed: absent, row shortened, no reflow; opened: present after the next reply. Tap on the hidden label still routes.                                                                                                                           |
| R-ACC-8 | An iconed keyboard on a message with inline buttons (e.g. an order screen).                                                                                                   | Inline markup only; one request; no retry, nothing marked.                                                                                                                                                                                      |
| R-ACC-9 | Visual pass of `/bot-buttons` at 1440/900/390, light and dark, RTL, with keyboard-only operation (F-11).                                                                      | Screenshots attached; every move reachable without a pointer.                                                                                                                                                                                   |

## 9. Recommendation

Merge-ready as it stands; the round's central guarantee — one menu system, not two — holds
under attack. Before the round is called accepted: land F-1's test (one test, T1), fix F-2/F-3
wording, and run R-ACC-1..5 on staging. F-4..F-9 can ride the next maintenance PR. Tag /
release / deploy: **not done and not recommended by this review.**
