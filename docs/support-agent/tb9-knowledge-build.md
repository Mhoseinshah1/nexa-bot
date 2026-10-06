# TB9 — One-click knowledge build from NEXA

**Status: implemented.** Program: Intelligent Support Agent, §30 and §39. Decided by ADR-0035
§5. Builds on TB8 (`tb8-controlled-learning.md`): the knowledge store, its revisions and the
review permission.

«ساخت/به‌روزرسانی دانش پشتیبان از اطلاعات NEXA» is one button. It **proposes**; a reviewer
applies. Running it changes no article, and nothing a reviewer wrote or edited is ever
overwritten without an explicit choice.

## The source allowlist

`SUPPORT_KNOWLEDGE_BUILD_SOURCE_TYPES` (a contract; a unit test pins it exactly), implemented
once in `NexaKnowledgeSources` (`support-knowledge/infrastructure/nexa-knowledge-sources.ts`),
which maps each record to its customer-facing fields and drops everything else before a
proposal exists.

| Source             | Read                                                                                                                   | Key             | Never                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| `PRODUCT`          | what the customer catalogue lists: title, description, duration, traffic, device limit, display features and locations | product id      | price, panel, reseller-only or hidden products, a hidden/inactive/no category, no eligible panel |
| `LOCATIONS`        | the labels of enabled service locations, as one article                                                                | `all`           | location key, panel, price                                                                       |
| `CLIENT_APP`       | `ENABLED`: name, description, rendered guide, and a fixed line pointing to the bot's app list                          | app id          | icon, every URL (official, help, alternative), delivery kinds                                    |
| `TUTORIAL`         | `bot.tutorial.android/ios/windows/macos/linux`, the tenant override or the default, RAW                                | template key    | any template that declares a placeholder                                                         |
| `FAQ`              | `ACTIVE` entries: question and answer                                                                                  | FAQ id          | inactive entries                                                                                 |
| `TERMS`            | the current PUBLISHED version: title and body                                                                          | `current`       | a draft                                                                                          |
| `SUPPORT_ACCOUNTS` | the `support.accounts` setting                                                                                         | the setting key | —                                                                                                |
| `PAYMENT_METHOD`   | `ACTIVE` routes: the operator's display name and instructions, only if they declare no placeholder                     | provider        | bounds, thresholds, fees, rates, any account number, gateway configuration                       |

Never read by the build: a credential or any column in `SECRET_COLUMNS`, a panel's name or
address, a raw id in any text (the source key stays on the server to match an article and is
not in any view), an admin or CRM note, an incident, reseller terms, gateway configuration,
and any customer row.

**Products come from the customer catalogue, never the operator's list** (substitute review of
PR #204, B1). `ProductService.publicCatalogue` takes the public `catalogueView` (the eligible
panels `PanelSalesGate` decides, through placement) and `listCustomerVisibleProducts`, which is
the browse's own `customerVisibleProduct` predicate and category join: product `ACTIVE`, not
`HIDDEN` or `RESELLERS_ONLY`, priced, on an eligible panel, in an `ACTIVE` and `VISIBLE`
category. A product in a "private sale" (hidden) or stopped category, an uncategorised one, or
one no eligible panel can take is not something every customer may be told, so it is not
knowledge.

Each source is bounded (`SUPPORT_KNOWLEDGE_BUILD_LIMITS.perSource` = 100, 400 proposals per
build). The bounds are counted, never silent (N2): an item whose title or body was clipped to
the article bounds is `truncated`; an item a bound dropped is `capped` (at least: the catalogue
read knows only "there is more"). Both are in the run's audit row (`after.truncated`,
`after.capped`) and on the build, and the page shows them. The labels the adapter writes around raw facts («مدت», «حجم», …) are scaffolding for
the reviewer; a proposal is reviewed before it is knowledge and is free text from then on.
A tutorial is persisted RAW: it declares no placeholder, so nothing is rendered (CLAUDE.md's
"nothing may persist a rendered string").

## The change-set

`support_knowledge_builds` and `support_knowledge_build_proposals` (migration `0209`). A run:

1. reads the sources outside any transaction;
2. in ONE transaction, reads every `NEXA_BUILD` article, diffs, supersedes the tenant's open
   build (a partial unique index allows one `OPEN` build per tenant), writes the build and its
   proposals, audits `support_knowledge.build.run`, and remembers the idempotency key. Two runs
   at once each supersede what they can see; the index lets one commit, and the other is
   refused `support_knowledge.build_running` (409), never a 500 (N1).

The diff (`domain/build-diff.ts`, pure) matches a source item to an article **only** by
`(source type, source key)`. Only `NEXA_BUILD` articles carry a key (a CHECK), so `MANUAL`
and `LEARNED` knowledge is never matched or touched.

| Case                                                                                   | Kind        |
| -------------------------------------------------------------------------------------- | ----------- |
| No article holds the source                                                            | `ADD`       |
| The article is `RETIRED` (a reviewer retired it; the build never brings it back)       | `UNCHANGED` |
| The content hash equals the article's `built_hash` (as last built, or acknowledged)    | `UNCHANGED` |
| Changed, and `revision = built_revision` (nobody edited it since the last build apply) | `UPDATE`    |
| Changed, and the article was edited since                                              | `CONFLICT`  |
| A built, non-retired article whose source the allowlist no longer yields               | `RETIRE`    |

The content hash is SHA-256 over the canonical JSON of title, body, category and tags. The
edit test is revision arithmetic, never a text comparison: `built_revision` is the revision the
last build apply wrote, and any reviewer edit makes a new revision.

`RETIRE` (substitute review of PR #204, S2) is the signal for a leak that develops over time: a
product switched to reseller-only or withdrawn, its category hidden, an app disabled, a FAQ entry
deactivated, a payment route switched off. It is **only proposed** — never automatic, never part
of «apply all» — and carries the article's own text, so the reviewer sees exactly what would
leave the agent's knowledge. An article edited since the last build is still only proposed. A
source excluded by the scrubber is still present (no RETIRE), and a source type whose read a
bound cut short gets no RETIRE at all: a missing key proves nothing there.

Each proposal records the article it is about, that article's revision and its text at build
time (`base_revision`, `base_title`, `base_body`): the diff's other side, and the base every
apply is conditional on.

## Apply and resolve

All under `support_knowledge.review`, idempotent, audited, with `ScopeActivityReader` read
inside the transaction and the build row locked; a `SUPERSEDED` build applies nothing.

- **Apply** — the named proposals, or (`proposalIds: null`) every pending `ADD` and `UPDATE`.
  A `CONFLICT` is never applied here, named or not; a `RETIRE` only when named. The answer is
  `{ applied, conflicted, skipped }`, and the build's counts are recounted from its proposals'
  kinds afterwards (N3).
  - `ADD`: the proposal is claimed (`PENDING → APPLIED`, conditional), then an `APPROVED`
    `NEXA_BUILD` article is inserted with revision 1, `built_revision` 1 and its hash, plus a
    `BUILD` revision row. An article that appeared for the source meanwhile is never doubled:
    the proposal is closed `PENDING → SKIPPED` and audited (S4), never left pending.
  - `UPDATE`: the article is rewritten **only** where `revision = base_revision AND
built_revision = base_revision AND state = 'APPROVED'`; the new revision becomes the built
    revision. An article edited since the build is left alone and the proposal becomes a
    `CONFLICT` against the article **as it is now** — `base_revision`, `base_title` and
    `base_body` are refreshed (S1), so both choices work and the page shows the current text. An
    article retired since is left retired and the proposal is `SKIPPED`.
  - `RETIRE`: the article goes `DRAFT | APPROVED → RETIRED` through the normal retire write
    (conditional on its version, audited `support_knowledge.article.retire`), only from the
    revision the build saw. An article edited since is never retired over the edit: the proposal
    is `SKIPPED`, and the next run proposes again against the new text.
- **Resolve** a `CONFLICT`, the reviewer's explicit choice:
  - `TAKE_BUILD` — a new revision with the build's text, conditional on the base revision (an
    edit after the build refuses with `support_knowledge.base_moved`: run again).
  - `KEEP_CURRENT` — the edited text stays untouched; the source's hash is recorded as
    acknowledged, so the same source text is `UNCHANGED` next time and a later change is a
    conflict again.

## The TB3 context

Approved, enabled built articles are knowledge like any other. An FAQ entry the build brought
in is read **once**, as the reviewed article: the live FAQ row is skipped when an approved,
enabled `NEXA_BUILD` article holds `FAQ:<id>`. A disabled or retired built FAQ article lets
the live FAQ entry show again (OQ-TB-61).

## Web Admin

«ساخت دانش از NEXA» (`/knowledge-build`, `support_knowledge.view`): run (a fresh key per click),
the counts (with «بازنشسته‌کردن»), the clipped and capped counts when non-zero, each change with
the current text beside the proposed one, a `RETIRE` with its own label, explanation and button
«بازنشسته‌کردن این مطلب», «اعمال همهٔ موارد بدون
تعارض» (disabled when only conflicts are pending), apply one, and for a conflict only
«جایگزینی با متن ساخته‌شده» or «نگه‌داشتن ویرایش فعلی». A superseded build offers nothing.
`UNCHANGED` items are counted, not listed. All text is `web.kb_*`.

## Decisions made in this package

1. **No price in knowledge.** The pricing boundary is the one answer to "what does this cost";
   a price in an article would be a second, stale one (OQ-TB-60).
2. **A source that disappears is a `RETIRE` proposal, never an automatic retirement.** Retiring
   a built article stays a reviewer's act; the build only says it is due (OQ-TB-62).
3. **No new permission.** Running, applying and resolving are `support_knowledge.review`
   (ADR-0035 §5); viewing is `.view`. No grants migration.
4. **The build is synchronous.** It reads at most 400 bounded items with no provider call, so
   it runs in the request; no job and no process role.
5. **Payment instructions with placeholders are skipped**, not rendered with sample values.
6. **Built knowledge carries no link, and nothing the scrubber matches (fail closed).** TB8's
   review (PR #203) made every article write pass `assertClean`, and the scrubber counts every
   URL as `HOST` or `URL_TOKEN`. The scrubber is not weakened and there is no allowlist of
   "public" URLs: an operator-configured link is still a link the agent would repeat, and a
   reviewed path for that belongs in a template field, not in knowledge. So:
   - an app's official and help URLs are never copied; the article says the links are in the
     bot's app list (the TB3 context already gives the agent the normalised links, live);
   - any other item the scrubber matches — an FAQ answer with a link or a phone, payment
     instructions with a card or an account, somebody's personal `@handle` — is EXCLUDED from
     the change-set. Only the count and the kinds are recorded, in the run's audit row
     (`after.excluded`), never the text;
   - L3 (2026-10-06): the installation's OWN support handles (the `support.accounts` setting)
     are not personal data. The scrubber is given them as `allowedHandles` here, at apply, and
     in every knowledge write (`assertClean`), and leaves exactly those handles as they are —
     `@name` or `t.me/name`, case-insensitively, never a longer handle that starts with one.
     So the `SUPPORT_ACCOUNTS` item, until then excluded on every run, is proposed; every other
     handle, and every other kind, is still scrubbed. The learning scrub (customer
     conversations) is unchanged;
   - apply and «TAKE_BUILD» call `assertClean` again as a backstop, so a proposal that is not
     clean is refused (`support_knowledge.sensitive_content`) and publishes nothing.
     What this loses is OQ-TB-66.

## Tests

- `tests/unit/support-knowledge-build.test.ts` (16): every diff case, the hash, the exact
  source list, the tutorial keys' empty placeholders, and the adapter over fake records carrying
  panel ids, prices, location keys, alternative URLs, icons and gateway rates, none of which
  reaches an item; RETIRE and when it is not proposed; the adapter's truncated and capped counts.
- `tests/integration/support-knowledge-build.test.ts` (25): a run changes nothing and ADDs;
  apply publishes, replays and is audited, and a second build is all `UNCHANGED`; the TB3
  context reads a built FAQ once; `UPDATE` is a new revision and the new built revision; an
  edited article is a `CONFLICT` that apply never touches, `KEEP_CURRENT` keeps it and
  `TAKE_BUILD` replaces it; an edit after the build turns an `UPDATE` into a `CONFLICT`; a
  superseded build applies nothing; no panel name, host or id, product or FAQ id, price, or
  reseller-only or inactive product appears in any view or stored proposal; permissions with
  denials audited; tenant isolation; and the PR #204 regressions — B1 (hidden, inactive and no
  category, an unsellable panel), S1 (both choices after an apply-time conflict), S2 (RETIRE),
  S3 (the TAKE_BUILD backstop, stopped scope, payload mismatch, an edit racing an apply in both
  orders, the ADD that found an article), S4, N1, N2, N3.
- `tests/web/knowledge-build.test.tsx` (13).

Mutation results are in `tb9-falsification.md`.
