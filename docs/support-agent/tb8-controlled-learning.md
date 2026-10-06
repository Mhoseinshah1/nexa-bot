# TB8 — Controlled learning

**Status: implemented.** Program: Intelligent Support Agent, §29 and §38. Decided by ADR-0035
§1–§3. Builds on TB2 (conversations, the lane, the handback), TB3 (the support context), TB4
(the provider chain, operation `LEARNING_EXTRACT`) and TB5 (the `assistant` role).

Never blind self-training. The flow is:

```
human support reply → learning job → LEARNING_EXTRACT → candidate → reviewer → knowledge
                                                                      │
                                       approve │ edit + approve │ reject (terminal)
```

Only an approval publishes. Nothing becomes knowledge on a timer, by count or by confidence.

## Knowledge has one home

`support_knowledge_articles` (current state) and `support_knowledge_revisions` (append-only,
every body ever published, with its reviewer) — ADR-0035 §1, migration `0207`.

| Column     | Values                                                                                |
| ---------- | ------------------------------------------------------------------------------------- |
| `source`   | `MANUAL` (a reviewer wrote it), `LEARNED` (an approved candidate), `NEXA_BUILD` (TB9) |
| `state`    | `DRAFT`, `APPROVED`, `RETIRED`                                                        |
| `enabled`  | a reviewer's on/off switch                                                            |
| `revision` | the live revision (0 for a draft never published)                                     |
| `version`  | the optimistic-concurrency stamp every write names                                    |

The support agent reads **only** `state = 'APPROVED' AND enabled`, and the predicate is in the
SQL of `DrizzleSupportKnowledgeRepository.activeForContext`, not in a filter after the read. A
draft, a retired article, a disabled article and a learning candidate are unreachable from it.

The TB3 payload keeps its shape: `knowledge: [{ source, question, answer }]`. `source` was widened
from `FAQ` to `FAQ | KNOWLEDGE` (a contract commit). Approved articles come first (`question` =
title, `answer` = body), then the live ACTIVE FAQ, together bounded by `SUPPORT_CONTEXT_LIMITS
.knowledge` (20). Since D2 the twenty are the most RELEVANT to the customer's latest messages
(`tb3-support-context.md`, "Byte budget and truncation"); on a tie, reviewed knowledge comes
before the FAQ, and truncation drops from the tail.

The FAQ is still read live, as before TB8. It remains the customer FAQ screen's own data — the
bot shows it — and is not a second knowledge store: the agent sees exactly what the customer's
FAQ screen shows. TB9 builds knowledge proposals from it; see `tb9-knowledge-build.md` for how
the two meet.

## Learning jobs

`support_learning_jobs` (`0207`). A job names ONE human reply: a `business_outbound_messages` row
of origin `OPERATOR` or `ASSIST`, `DELIVERED`, with its text still held, in that conversation —
or, since D8, a `business_messages` row of origin `HUMAN` (a reply the business owner TYPED in
the Telegram app), text, not deleted, in that conversation (`source_message_id`, key
`learning:message:<id>`; the table's CHECK holds exactly one source). A customer's message
(`INBOUND`), our own echo, an away message and another bot's are never a source.

D8 adds the button, not a trigger: «پیشنهاد به‌عنوان دانش» on a `HUMAN` transcript row. No
administrator wrote it, so proposing it always needs `support_knowledge.review` (as for another
person's reply), and it is scrubbed, extracted and reviewed exactly like any other proposal.
A handback still learns only from Web Admin replies: what the owner types on the phone is sent
to a provider only when a reviewer chose it.

| Trigger             | When                                                                                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HANDBACK`          | An operator returns a conversation to the AI («سپردن دوباره به هوش مصنوعی»). Inside the resume's transaction, the latest eligible reply is enqueued. Never throws.                                                                            |
| `OPERATOR_PROPOSAL` | An operator presses «پیشنهاد به‌عنوان دانش» on one of THEIR delivered replies (`support_knowledge.propose`); another person's reply needs `support_knowledge.review`, and that refusal is audited as the review permission's denial. Audited. |

Bounds, all counted in the enqueuing transaction, under the tenant's learning-enqueue lock
(`pg_advisory_xact_lock(0x4c4a, hashtext(tenant_id))`, taken first): two proposals racing on one
conversation cannot both see an empty window, and the hourly cap is a cap, not a bound that N
racers pass together (PR #203 review, finding 3).

1. **One job per reply.** The key is `learning:outbound:<id>`, whatever the trigger, so a
   handback and a proposal of the same reply coincide. A proposal's own idempotency key is
   bound to its payload (conversation and reply, `hashRequest`/`rememberOnce`): a replay
   returns the job it made, and the same key for another reply is
   `platform.idempotency_payload_mismatch` (PR #203 review, finding 5).
2. **One job per conversation per 24 hours** (ADR-0035 §3). A proposal refused by it is
   `support_knowledge.learning_rate_limited`; a handback refused by it enqueues nothing.
3. **At most 30 jobs per tenant per hour** (`SUPPORT_LEARNING_MAX_JOBS_PER_HOUR`).
4. **AI OFF learns nothing.** A handback enqueues nothing, a proposal is refused
   (`support_knowledge.ai_off`), and a job queued before the switch is resolved `dropped_mode`
   without a provider call. The chain itself also refuses under OFF.

The `assistant` role claims due jobs after its draft and automatic jobs (a customer waits on
those; nobody waits on a lesson), up to two per pass and ONE per claim, each leased from its own
claim for TB5's worst case (PR #200 review, finding 4: a pair leased up front would wait out its
lease behind its sibling's provider call), and gives up after three claims (`attempts_exhausted`).

## Extraction

`SupportLearningService.produce`, OUTSIDE any transaction:

1. The reply and the last 12 messages of the conversation are **scrubbed**
   (`domain/scrubber.ts`) and sent as labelled data with a fixed policy
   (`domain/learning-prompt.ts`, `SUPPORT_LEARNING_POLICY_VERSION`). The provider never reads a
   phone, a card, a link or an id.
2. The chain answers under operation `LEARNING_EXTRACT`, with the closed JSON schema
   `SUPPORT_LEARNING_EXTRACTION_JSON_SCHEMA`. The output is parsed by the strict zod schema
   `supportLearningExtractionSchema` (proposal, title, body, category, tags, rationale,
   confidence). The source reference is never the model's: the server records which reply it read.
3. `NONE` — the model found no general lesson — is `declined`. Invalid output is
   `output_invalid`; a chain failure is `ai_unavailable`.
4. Everything the model wrote is **scrubbed again**. A proposal that still matches is stored
   `REJECTED` with reason `SENSITIVE_CONTENT`, by nobody, with its text REDACTED and only the
   KINDS of what matched (`auto_rejected`). It never reaches the review queue.
5. Duplicates are merged (below), otherwise a `PENDING` candidate is inserted. One transaction
   writes the candidate and resolves the job from `QUEUED`; a job resolved elsewhere meanwhile
   rolls the candidate back. A tenant that stopped meanwhile writes nothing: its job is left
   QUEUED under its lease ("Refusing is not ending", `docs/conventions.md`). The same holds at
   the claim, before the provider call, at every other job resolution and at the retention
   pass — each checks scope activity in its own transaction, and a stopped tenant's learning is
   left exactly as it is. `dropped_scope` stays in the contract's vocabulary and is no longer
   written.

### The scrubber

A deterministic VALUE scrubber over free text. It is not `infrastructure/redaction.ts`, which
redacts by KEY inside structured values bound for logs; neither can stand in for the other.

- Persian (۰-۹) and Arabic-Indic (٠-٩) digits are folded to ASCII before matching.
- Digit groups may be separated by RUNS of up to three spaces, hyphens, en and em dashes, dots,
  Arabic decimal and thousands separators and zero-width characters: `6037  9975  1234  5678`
  and `6037 – 9975 – 1234 – 5678` are cards.
- Kinds: `EMAIL`, `PHONE` (Iranian mobile and landline, international), `CARD` (16 digits),
  `IBAN`, `SUBSCRIPTION_LINK` (`vless://`, `vmess://`, `trojan://`, `ss://`, `hysteria2://`, …,
  `/sub/` URLs, and `/sub/` paths without a scheme: `panel.example.com/sub/…`), `URL_TOKEN`
  (ANY URL with a query, a fragment, userinfo or a token-shaped path segment — a digit, or
  mixed case — and Telegram invite links), `IP_ADDRESS`, `HOST` (a server by name: any
  domain, with or without a port or a path, a `ws://` URL, and any URL with no token in it),
  `UUID`, `SECRET` (`password: …`, a secret word followed by a value in prose — «password is
  hunter2», «رمزتون abc123 هست», «کلمه عبور شما xyz789 است», «کد 4821» — `sk-…`, long
  base64/hex runs), `USERNAME` (`@handle`, `t.me/<name>`), `AMOUNT` (a figure with a currency
  word or sign: «۲۵۰ هزار تومان», «۲۵۰٫۰۰۰ تومان», `$12`, `10 USDT`; a figure in `k` or
  millions: `150k`, «۲ میلیون»; an amount in words: «صد و پنجاه هزار تومان», «fifty dollars»),
  `LONG_NUMBER` (7+ digits: Telegram ids, order and transaction numbers), and `REDACTION_MARK`
  (the scrubber's own marker in a model's output — a lesson written about a redacted value is
  about one customer).
- Every URL is a hit, so a store link with a query (`play.google.com/…?id=…`) is too. A secret
  word must be followed by a Latin, digit or symbol value, so «رمز عبور را عوض کنید» and «کد
  تخفیف را وارد کنید» are help text and stay clean (the unit test's negative controls).
- It over-matches on purpose. A false positive costs a candidate; a false negative teaches the
  agent a customer's data.

### Duplicates (ADR-0035 §3)

1. **Exact**, by the normalised title. `normalized_title` is unique per tenant across every
   state but one, so a lesson matching a pending, approved **or reviewer-rejected** candidate is
   merged into it as an extra source (`source_refs`, bounded to 20; `source_count`), never
   duplicated, and a lesson a reviewer rejected is not proposed again. The index decides, so two
   replicas racing produce one candidate. A `SENSITIVE_CONTENT` rejection is outside the index
   (it is partial: `WHERE reject_reason IS DISTINCT FROM 'SENSITIVE_CONTENT'`) and outside the
   near-duplicate read: the scrubber's rejection is not a decision about the lesson, so the
   same lesson proposed cleanly later is its own PENDING candidate (PR #203 review, finding 7). Normalisation folds Arabic ي/ك/ة/ۀ and hamza alefs to Persian, digits to ASCII,
   strips diacritics, tatweel and zero-width joiners, lower-cases Latin, and collapses every
   non-letter, non-digit run.
2. **Near**, by character-trigram Jaccard similarity of normalised titles ≥ 0.8, against the
   tenant's 200 most recent candidates, checked before the insert. Best-effort (a read, then a
   write); rule 1 is the backstop.

A merge does not advance the candidate's version, so it never turns a reviewer's approval into
a conflict.

## Review

Permissions (contract commit; grants in `0208`):

| Key                         | Risk   | Roles                              | Requires                 |
| --------------------------- | ------ | ---------------------------------- | ------------------------ |
| `support_knowledge.view`    | LOW    | owner, operator, support, observer | —                        |
| `support_knowledge.propose` | MEDIUM | owner, operator, support           | `business_chats.view`    |
| `support_knowledge.review`  | HIGH   | owner                              | `support_knowledge.view` |

Review is HIGH and owner-only by default, like publishing the terms: an approved article is what
the agent — and `AUTO_REPLY_SAFE` — repeats to every customer.

Every command (`SupportKnowledgeService`): authorize (a denial is audited), replay by the
idempotency key (a replay answers with the row as it is now), then ONE transaction that
re-checks the session and the permission, reads `ScopeActivityReader`, applies a conditional
UPDATE naming its `from` states and the version read, audits and remembers.

| Command          | Transition                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------- |
| approve          | candidate `PENDING → APPROVED`; inserts a `LEARNED` article (revision 1) and its revision row |
| edit + approve   | the same, publishing the reviewer's text                                                      |
| reject           | candidate `PENDING → REJECTED` (`REVIEWER`); terminal                                         |
| create           | `MANUAL` article, `APPROVED` with revision 1, or a `DRAFT`                                    |
| update           | `APPROVED`: a new revision; `DRAFT`: the draft changes; `RETIRED`: refused                    |
| publish          | `DRAFT → APPROVED`, the next revision                                                         |
| retire           | `DRAFT \| APPROVED → RETIRED`                                                                 |
| enable / disable | `enabled` flips; already so is a no-op with no audit row                                      |

Whatever becomes or stays knowledge is scrubbed as it is written: an approval (edited or
not), an article created or edited, and a draft published — whatever the article's source,
`MANUAL` included (OQ-TB-54; PR #203 review, finding 2). Text the scrubber matches is refused
(`support_knowledge.sensitive_content`). A candidate whose text was purged can be approved only
with an edit. A reviewer's reject note is scrubbed before it is written to the audit row.

## Retention

A candidate never approved (`PENDING` or `REJECTED`) has its title, body, rationale and tags
purged 30 days after it was created (`SUPPORT_LEARNING_TEXT_RETENTION_DAYS`), by the
`assistant` role's retention pass (PR #203 review, finding 6). Only the normalised title
survives, as the duplicate check's match key: it is the twice-scrubbed title folded (letters
unified, digits ASCII, punctuation collapsed) and no view, export or audit row carries it.
Replacing it with a keyed hash would keep the exact rule and lose the near-duplicate (trigram)
rule, which needs the folded text; that trade was not taken. Approved candidates and every
article and revision are kept.

## Web Admin

- **«دانش پشتیبان»** (`/support-knowledge`, `support_knowledge.view`): list with source and state
  filters, create (publish or draft), edit (the drawer says an approved edit is a new
  revision), publish, enable/disable, retire, and the revision history with the live revision
  marked.
- **«پیشنهادهای یادگیری»** (`/support-learning`): the queue by state (PENDING by
  default), approve, «ویرایش و تأیید» (the EDITED text is what is sent), reject. An auto-rejected
  candidate shows only the kinds found. A purged candidate cannot be approved as is.
- **«پیشنهاد به‌عنوان دانش»** on each delivered operator or Assist reply of a business
  conversation (`support_knowledge.propose`).

All text is `web.sk_*` Persian keys. Knowledge text itself is operator-reviewed free text — the
AI/operator free-text exception; no template is involved.

## Decisions made in this package

1. **The FAQ stays live in the context** and approved articles come first (OQ-TB-50).
2. **Proposal is its own permission** (`support_knowledge.propose`, MEDIUM) rather than
   `business_chats.reply`: proposing spends provider budget and feeds the review queue.
3. **The 24-hour window binds explicit proposals too** (ADR-0035 §3 is per conversation).
4. **Learning jobs have their own table**, not a fourth `support_ai_jobs` kind: that table's
   CHECKs pin the shape of a draft (a decision on READY), which a learning job does not have.
5. **Only lane replies teach.** A message the owner typed on their phone (`HUMAN`) is not
   attributable to an admin and is not a learning source (OQ-TB-52).
6. **No digest.** The optional daily digest is not built (OQ-TB-53).

## Tests

- `tests/unit/support-learning-scrubber.test.ts` (91): 37 PII shapes including Persian and
  Arabic-Indic digits and zero-width separators, the 37 shapes the PR #203 review found or
  implied (separator runs, any URL, hosts, scheme-less /sub/ paths, secrets in prose, t.me
  links, amounts in k, in words and with Arabic separators), ten negative controls of plain
  Persian help text, digit folding, the strict output schema and its JSON twin, the prompt's
  scrubbing of transcript and reply, title normalisation, trigram similarity and duplicate
  selection.
- `tests/integration/support-learning.test.ts` (31): the PR #203 review's findings — a
  republished LEARNED or MANUAL article and a published draft scrubbed; two proposals racing on
  one conversation make one job; thirty jobs in the hour refuse the next; approve and reject
  racing, in both orders, and each conditional UPDATE's two predicates; the proposal key bound
  to its reply; the purge of title and tags; a scrubber rejection never absorbs a clean
  proposal; the reject note scrubbed; a stop during the provider call; only the author (or a
  reviewer) proposes. And the original eighteen: nothing active without approval; the
  provider never reads the customer's phone; approve publishes one article and a replay
  publishes once; edit + approve and reject; a stale version; a sensitive approval refused; an
  output scrubber hit auto-rejected and stored redacted; AI OFF; idempotent proposal and the
  24-hour window; ineligible sources; exact and near duplicates merge (into a rejected one too);
  declined and invalid output; permissions with the denial audited; tenant isolation (and the
  TB3 context of tenant B); drafts, disabled and retired articles never in the context, an edit
  is a new revision, revisions append-only; retention; a stopped tenant.
- `tests/web/support-knowledge.test.tsx` (17): both pages, the propose button, navigation.
- `tests/unit/support-context-payload.test.ts`: the builder's knowledge reader is a dependency.

Mutation results are in `tb8-falsification.md`.
