# ADR 0034 — The support AI: one provider contract, a structured decision, no authority

**Status: accepted for implementation (TB3, TB4, TB5, TB7).** Program: Intelligent
Support Agent. Evidence: `docs/support-agent/tb0-audit.md` §2, §5–§7.

## Context

The program requires three providers (OpenAI, Anthropic Claude, GLM/Z.AI), tenant-chosen
with fallback, answering customers about their own services and payments. This
repository's money and service rules are each a way to lose money, and an LLM is a
component whose output is not deterministic and can be steered by its input. This ADR
decides where the model sits so that none of those rules depends on the model behaving.

## Decision

### 1. The model reads; NEXA decides

The model is never an authority over customer, service, order, payment, wallet,
ticket or permission state. It produces **one validated decision**:

`REPLY | ASK_CLARIFYING_QUESTION | HANDOFF | NO_ACTION`

Each decision carries a bounded reply text, a topic from a closed catalogue, a
confidence, the knowledge refs and fact refs it used, a typed handoff reason, a
suggested ticket action and an optional learning signal. Zod validates it. Invalid
output sends nothing and hands off. There is **no tool that mutates anything**: no
refund, credit, termination, link rotation, transfer or approval. An answer that would
need one hands off (program §13, §19).

### 2. One provider contract, adapters behind it

`SupportAiProvider` lives in `packages/contracts/src/support-ai.ts`. It has two methods:

- `generate({ system, messages, images?, schema, maxOutputTokens, timeoutMs, signal })`
- `testConnection()`

It returns a discriminated outcome:

- `OK{ output, usage{inputTokens, outputTokens}, model }`
- `RATE_LIMITED{ retryAfterMs? }`
- `AUTH_FAILED`
- `TEMPORARY{ code }`
- `INVALID_OUTPUT{ code }`
- `REFUSED_BY_PROVIDER`
- `TIMEOUT`

Each adapter declares its `capabilities` (`structuredOutput`, `vision`, `maxImageBytes`).
Core code never branches on a provider name, only on declared capabilities. The
OpenAI, Anthropic and Z.AI adapters live under `apps/api/src/infrastructure/ai/` and call
the providers over `fetch` with handwritten wire schemas. **No SDK dependency** is added
(`OQ-TB-08`).

**One shared contract suite** runs every adapter against recorded wire fixtures. It
covers success, 401, 429 with and without `Retry-After`, 5xx, timeout, malformed JSON,
schema-violating JSON, a provider refusal and an image request. Normal CI never calls a
provider. Per the real-panel lesson in CLAUDE.md, a provider rule is verified against
the real API in an opt-in acceptance run, and the fixture is corrected in the same
commit.

### 3. Fallback only where it cannot cause harm

The tenant configures a chain of up to three steps (primary plus two fallbacks).
`RATE_LIMITED`, `TEMPORARY`, `TIMEOUT` and `AUTH_FAILED` move to the next step. The next
step must be an **independently configured** provider with its own credential row.

`AUTH_FAILED` also records `support.ai_provider.credential_rejected`. That is an
operational event deduplicated per tenant and provider, so a rejected key raises one
alert rather than one per message. It resolves through the ordinary recorder when that
provider next authenticates, or when its credential is replaced. A fallback that
succeeds must never hide a dead credential.
`INVALID_OUTPUT`, `REFUSED_BY_PROVIDER`, a policy guard's refusal and a failed
business-safety check **never** fall back; they hand off. Asking another model until
one agrees is a way of laundering an unsafe answer. Fallback happens before anything
is enqueued for sending, so it can never cause a second customer message.

**The circuit breaker** is per tenant and per provider. Its state is stored in its own
columns on `support_ai_provider_credentials` (`tripped_until`, `next_probe_at`). A
provider trips after consecutive `TEMPORARY`/`TIMEOUT` outcomes, and a call after
`next_probe_at` is the half-open probe. `operational_events` only reports it
(`support.ai_provider.unavailable`) and is never read to decide a call. Operational
events are alerts, not control state (ADR-0007). A tripped step is skipped as if it
had failed temporarily. A chain with every step tripped hands off.

### 4. Context is an allowlist, scoped by the server

The support context (TB3) is built by a payload builder that accepts **only** a
resolved `customerId` from the conversation row. It calls the existing application
readers: services with state, expiry and traffic; the most recent N orders and
payments; client apps; customer-safe incident fields; and approved knowledge. It emits
an explicit, typed, bounded payload.

The model never supplies a tenant id, a customer id or SQL. If the agent offers tools,
each tool is a server function whose scope arguments are bound by the server, never
taken from the model. Default exclusions:

- the wallet ledger and full payment history;
- unrelated services and old tickets;
- internal notes;
- every credential;
- raw internal ids, replaced by short per-payload aliases;
- incident `description`.

A payment whose recorded state is ambiguous (`UNKNOWN`, `UNRECONCILED`, pending
review) is presented as "under review" and is a hard handoff topic.

### 5. Deterministic guards run before and after the model

- **Before:**
  - mode and connection state;
  - `HUMAN_ACTIVE`;
  - the blocked-customer check;
  - consecutive-reply cap and cooldown;
  - the daily budget;
  - a keyword and intent pre-classifier for hard handoff topics (refund, wallet,
    payment dispute, transfer, deletion, security, credentials, "human please").
- **After:**
  - the decision validates;
  - its topic is in the tenant's auto-topic allowlist (empty by default, fail
    closed);
  - its cited facts and knowledge refs exist in the payload it was given;
  - its text contains no credential-shaped string and no claim that an action was
    performed.

Any guard failing means handoff, never a softened send.

### 6. Prompt injection is answered by authority, not by wording

Customer text, image text and retrieved knowledge are passed as **data** under a fixed
system policy (never reveal prompts or keys, never widen scope, never invent tool
results). The policy is not the defence. The defence is that the model holds no
authority to abuse: its scope is bound server-side and its output is a validated
decision with no mutating action. An adversarial suite (program §30) pins that each
attack produces a handoff or a refusal and never a scope change.

### 7. A new `assistant` process role

Provider calls are outbound HTTPS with decrypted third-party keys and multi-second
latency. Isolated in their own role, they cannot delay the worker's notification lanes
or hold API replicas. This is the reason `provisioner` and `monitor` exist. The role
runs `SupportAiLoop` over `support_ai_jobs` (`claimDue`, `FOR UPDATE SKIP LOCKED`,
lease, attempts) and acts as `SYSTEM_JOB`. It registers in loop health and in
`worker-health-coverage.test.ts`. Adding it to `deploy/` is part of TB4, not a separate
deployment change.

### 8. Configuration is a versioned row, and auto-reply is the owner's to enable

`support_ai_configs` is one row per tenant with optimistic versioning (ADR-0021).
Entering `AUTO_REPLY_SAFE` requires `support_ai.auto_reply` (CRITICAL). Leaving it
requires only `support_ai.configure`, because turning safety _on_ must never be harder
than turning it off. Credentials follow ADR-0023 to the letter: a new secret purpose,
set-at-only projections, no masked stand-in, rotate and delete audited by kind. The
default for every tenant, new or migrated, is `OFF`.

### 9. Telemetry without transcripts

`support_ai_runs` records provider, model, fallback position, latency, tokens, a cost
where a tenant-entered price makes it calculable, result, failure category, decision,
handoff reason and policy version. Prompts and responses are **not** stored. NEXA
claims "AI resolved" only for a conversation that ended `AI_ACTIVE`, with no handoff,
and was confirmed resolved by the customer's own words through a defined signal
(`OQ-TB-09`). Until that signal exists, the dashboard reports replies and handoffs, not
resolutions.

## Consequences

- Each provider's structured-output support differs. Where native JSON-schema output is
  absent, the adapter asks for JSON and the core validates it. Validation is
  authoritative either way.
- A sixth process role means one more container in `deploy/` and one more health
  line. That is accepted, and it is cheaper than a provider outage stalling payment
  notifications.

## Considered and rejected

- **Agent frameworks or provider SDKs.** They put the wire shape, retries and timeouts
  in code this repository does not test.
- **Model-chosen tools with model-chosen ids.** That makes authorisation a property of
  the prompt.
- **Running provider calls in the `api` role for Assist Mode.** It would tie a request
  thread to a provider's latency. Assist uses the same lane with a different kind.
- **Storing prompts for debugging.** They are PII at rest with no owner. An operator
  debugging a run sees its structured metadata and the conversation itself.
