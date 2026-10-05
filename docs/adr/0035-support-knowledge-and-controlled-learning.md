# ADR 0035 — Support knowledge, and why nothing is learned without a reviewer

**Status: accepted for implementation (TB3, TB8, TB9).** Program: Intelligent Support
Agent. Evidence: `docs/support-agent/tb0-audit.md` §2, §5.

## Context

The program wants the agent to improve from what human support says, and to bootstrap
its knowledge from what NEXA already knows. Either one can teach the agent a falsehood,
a one-off concession, or another customer's data, and auto-reply would then repeat it
to every customer. So this ADR decides what may ground an automatic answer.

## Decision

### 1. One tenant-scoped knowledge base; only APPROVED and enabled grounds auto-reply

`support_knowledge_articles` holds an article's current state:

- `DRAFT`, `APPROVED` or `RETIRED`;
- `enabled`;
- a source: `MANUAL`, `LEARNED` or `NEXA_BUILD`.

`support_knowledge_revisions` is append-only and holds every body ever approved, with
its reviewer. The auto-reply retriever's query names `state = 'APPROVED' AND enabled`
in SQL, not in a filter after the read. A unit test and an integration test pin that a
draft, a candidate and a retired article are unreachable from it. Assist Mode may show
drafts to an operator, labelled as unapproved, but never to a customer.

### 2. Learning produces candidates, never knowledge

After a human support reply in a conversation, a `LEARNING_EXTRACT` job may propose a
candidate: title, body, category, tags, rationale, confidence and source reference. The
extractor runs **after** a deterministic redactor that removes credential-shaped
strings, phone numbers, amounts, ids and usernames. Its prompt instructs it to refuse
one-off financial decisions, personal data and guesses. A candidate is
`PENDING → APPROVED | REJECTED`, by a reviewer holding `support_knowledge.review`.
Approve and "edit then approve" publish one article revision in the same transaction.
Reject is terminal and never enters knowledge. Nothing becomes active on a timer, by
count or by confidence.

### 3. Volume is bounded

At most one candidate per conversation per 24 hours. Candidates whose normalised title
matches a pending, approved **or rejected** item are merged into it as an extra source rather than
duplicated. A rejection by the scrubber (`SENSITIVE_CONTENT`) is not a decision about the lesson
and absorbs nothing (amended after the substitute review of PR #203). The optional daily digest is one operator notification per tenant per day,
and only when there is at least one new candidate.

### 4. Retrieval starts boring

TB3 retrieval scores approved articles by category and tag match, then by a
PostgreSQL `simple`-configuration `tsvector` over title and body. That is enough at
the expected scale of tens to low hundreds of articles per tenant. Persian has no
built-in stemmer, so the `simple` configuration is deliberate (`OQ-TB-06`). Embeddings
and a vector store are added **only** if a recorded measurement shows retrieval
missing articles that exist. If they are added, they come with tenant isolation,
versioned embeddings, delete consistency and the text retriever as the fallback.

### 5. The one-click build is a proposal, from an allowlist

«ساخت/به‌روزرسانی دانش پشتیبان از اطلاعات NEXA» creates a `support_knowledge_builds`
change-set. Each proposed addition or update records the base revision it would
replace.

**Sources** (allowlist, read through the existing application services):

- active catalogue products, by their public name and customer-visible properties;
- client apps, using `name`, `description`, `guide`, `help_url` and `official_url`;
- `support_faqs` where `status` is active;
- the current terms version;
- the customer-facing `bot.*` catalogue and tenant template overrides, rendered
  without placeholders;
- the `support.accounts` setting;
- payment-method customer instructions;
- customer-visible location labels.

**Never read:**

- credentials and any secret column (the build reads no table registered in
  `SECRET_COLUMNS`);
- panel names, addresses or panels hidden from customers;
- raw ids;
- admin notes and CRM notes;
- incident `description`;
- reseller terms;
- gateway configuration;
- any customer row.

A test pins the source list exactly, so a new source is a reviewed change.

Applying the build requires `support_knowledge.review`. An update whose base revision
is not the article's current revision is a **conflict** and is shown as one. It is
never applied over a manual edit.

## Consequences

- The agent improves only as fast as a reviewer approves. That is the point.
- A rejected candidate is kept, so the same lesson is not proposed again. Its body is
  redacted text and is purged by the same 30-day rule as conversation text if it was
  never approved — its title, rationale and tags with it (amended after the substitute
  review of PR #203). Only its normalised title survives the purge, because that is what
  the duplicate check matches.

## Considered and rejected

- **Automatic publication above a confidence threshold.** The model's confidence is
  not evidence of truth.
- **Fine-tuning or provider-side memory.** Neither is reviewable, revertible or
  tenant-isolated by construction.
- **Building knowledge by reading the database schema.** It would be one forgotten
  column away from publishing a secret. The allowlist reads services, not tables.
