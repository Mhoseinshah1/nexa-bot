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

| Source             | Read                                                                                                               | Key             | Never                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ | --------------- | -------------------------------------------------------------------------- |
| `PRODUCT`          | `ACTIVE`, audience `EVERYONE`: title, description, duration, traffic, device limit, display features and locations | product id      | price, panel, reseller-only or hidden products                             |
| `LOCATIONS`        | the labels of enabled service locations, as one article                                                            | `all`           | location key, panel, price                                                 |
| `CLIENT_APP`       | `ENABLED`: name, description, rendered guide, and a fixed line pointing to the bot's app list                      | app id          | icon, every URL (official, help, alternative), delivery kinds              |
| `TUTORIAL`         | `bot.tutorial.android/ios/windows/macos/linux`, the tenant override or the default, RAW                            | template key    | any template that declares a placeholder                                   |
| `FAQ`              | `ACTIVE` entries: question and answer                                                                              | FAQ id          | inactive entries                                                           |
| `TERMS`            | the current PUBLISHED version: title and body                                                                      | `current`       | a draft                                                                    |
| `SUPPORT_ACCOUNTS` | the `support.accounts` setting                                                                                     | the setting key | —                                                                          |
| `PAYMENT_METHOD`   | `ACTIVE` routes: the operator's display name and instructions, only if they declare no placeholder                 | provider        | bounds, thresholds, fees, rates, any account number, gateway configuration |

Never read by the build: a credential or any column in `SECRET_COLUMNS`, a panel's name or
address, a raw id in any text (the source key stays on the server to match an article and is
not in any view), an admin or CRM note, an incident, reseller terms, gateway configuration,
and any customer row.

Each source is bounded (`SUPPORT_KNOWLEDGE_BUILD_LIMITS.perSource` = 100, 400 proposals per
build). The labels the adapter writes around raw facts («مدت», «حجم», …) are scaffolding for
the reviewer; a proposal is reviewed before it is knowledge and is free text from then on.
A tutorial is persisted RAW: it declares no placeholder, so nothing is rendered (CLAUDE.md's
"nothing may persist a rendered string").

## The change-set

`support_knowledge_builds` and `support_knowledge_build_proposals` (migration `0209`). A run:

1. reads the sources outside any transaction;
2. in ONE transaction, reads every `NEXA_BUILD` article, diffs, supersedes the tenant's open
   build (a partial unique index allows one `OPEN` build per tenant), writes the build and its
   proposals, audits `support_knowledge.build.run`, and remembers the idempotency key.

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

The content hash is SHA-256 over the canonical JSON of title, body, category and tags. The
edit test is revision arithmetic, never a text comparison: `built_revision` is the revision the
last build apply wrote, and any reviewer edit makes a new revision.

Each proposal records the article it is about, that article's revision and its text at build
time (`base_revision`, `base_title`, `base_body`): the diff's other side, and the base every
apply is conditional on.

## Apply and resolve

All under `support_knowledge.review`, idempotent, audited, with `ScopeActivityReader` read
inside the transaction and the build row locked; a `SUPERSEDED` build applies nothing.

- **Apply** — the named proposals, or (`proposalIds: null`) every pending `ADD` and `UPDATE`.
  A `CONFLICT` is never applied here, named or not.
  - `ADD`: the proposal is claimed (`PENDING → APPLIED`, conditional), then an `APPROVED`
    `NEXA_BUILD` article is inserted with revision 1, `built_revision` 1 and its hash, plus a
    `BUILD` revision row. An article that appeared for the source meanwhile is never doubled.
  - `UPDATE`: the article is rewritten **only** where `revision = base_revision AND
built_revision = base_revision AND state = 'APPROVED'`; the new revision becomes the built
    revision. An article that moved since the build (edited, retired) is left alone and the
    proposal becomes a `CONFLICT` for a reviewer to decide.
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
the counts, each change with the current text beside the proposed one, «اعمال همهٔ موارد بدون
تعارض» (disabled when only conflicts are pending), apply one, and for a conflict only
«جایگزینی با متن ساخته‌شده» or «نگه‌داشتن ویرایش فعلی». A superseded build offers nothing.
`UNCHANGED` items are counted, not listed. All text is `web.kb_*`.

## Decisions made in this package

1. **No price in knowledge.** The pricing boundary is the one answer to "what does this cost";
   a price in an article would be a second, stale one (OQ-TB-60).
2. **A source that disappears leaves its article.** The build proposes no removal; retiring a
   built article is a reviewer's act (OQ-TB-62).
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
     instructions with a card or an account, the `support.accounts` handles — is EXCLUDED from
     the change-set. Only the count and the kinds are recorded, in the run's audit row
     (`after.excluded`), never the text;
   - apply and «TAKE_BUILD» call `assertClean` again as a backstop, so a proposal that is not
     clean is refused (`support_knowledge.sensitive_content`) and publishes nothing.
     What this loses is OQ-TB-66.

## Tests

- `tests/unit/support-knowledge-build.test.ts` (12): every diff case, the hash, the exact
  source list, the tutorial keys' empty placeholders, and the adapter over fake records carrying
  panel ids, prices, location keys, alternative URLs, icons and gateway rates, none of which
  reaches an item.
- `tests/integration/support-knowledge-build.test.ts` (10): a run changes nothing and ADDs;
  apply publishes, replays and is audited, and a second build is all `UNCHANGED`; the TB3
  context reads a built FAQ once; `UPDATE` is a new revision and the new built revision; an
  edited article is a `CONFLICT` that apply never touches, `KEEP_CURRENT` keeps it and
  `TAKE_BUILD` replaces it; an edit after the build turns an `UPDATE` into a `CONFLICT`; a
  superseded build applies nothing; no panel name, host or id, product or FAQ id, price, or
  reseller-only or inactive product appears in any view or stored proposal; permissions with
  denials audited; tenant isolation.
- `tests/web/knowledge-build.test.tsx` (10).

Mutation results are in `tb9-falsification.md`.
