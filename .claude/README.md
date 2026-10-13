# Project-scoped Claude configuration

Everything here is committed, so it reproduces in every Claude Code session —
web, terminal or desktop — and for every collaborator.

## What is here, and why

### `settings.json`

**`hooks.SessionStart`** is the highest-value item. Claude Code cloud sessions
start with no Docker daemon and no running PostgreSQL or Redis, although both
servers are installed. Without the hook, every session opens by rediscovering
that it cannot run the integration tests. `scripts/claude-session-start.sh`
installs dependencies when the lockfile has moved, starts the services (Docker
if a daemon is reachable, natively otherwise), writes a development `.env` with
a freshly generated key-encryption key, builds the internal packages and applies
migrations. It is idempotent and always exits 0.

**`permissions.allow`** covers the commands a session runs constantly, so it
stops prompting for the same fifteen. **`permissions.deny`** blocks pushing to
`main`, force-pushing, and reading `.env`.

**`env`** points at the local development services.

### `skills/`

- **`nexa-conventions`** — the money, time, tenancy, event, audit, idempotency,
  text and secret rules in the form Claude applies while writing code. This is
  what stops the twelfth session from inventing a `balance` float column.
- **`nexa-migrations`** — how to write and verify a migration here, including
  the things `drizzle-kit` does not model.
- **`nexa-code-navigation`** — the layer map and `scripts/trace.sh <term>`,
  which lists the files behind a feature, layer by layer, in one call, so a
  session searches instead of reading directories.
- **`nexa-test-selection`** — which tests to run while iterating, which guard
  suites (money, migration, security, legacy import, deploy) are never
  narrowed, and when the full gate runs. `scripts/select-tests.sh` prints the
  commands; it never skips or removes a test.
- **`nexa-pr-workflow`** — branch → PR → CI → review → merge, with
  `scripts/branch-check.sh` for conflicts, contract changes and
  migration-number collisions. Merging, tagging and releasing stay the owner's
  explicit call.
- **`nexa-handoff`** — a short structured handoff between sessions;
  `scripts/handoff-facts.sh` generates the git half.
- **`nexa-web-design`** — Web Admin rules (RTL, Vazirmatn, tokens, CSP, touch,
  accessibility, permissions, no demo data). The visual redesign is paused;
  `references/redesign-status.md` records that and is where an approved
  reference will be registered.

Skills load progressively: only each `description` is in context until a task
matches it; the body and any `references/` file are read on demand. Keep
descriptions specific and bodies short, and point at `docs/` rather than
copying it. The scripts are read-only helpers; each has a `*.test.sh` beside it
(run by hand — they are not part of `pnpm verify`).

### `agents/`

- **`spec-guardian`** — reviews a diff against the frozen contracts and the four
  domain boundaries. It reviews and does not implement, deliberately: an agent
  reviewing in the same context it implemented in shares the same blind spots.
- **`research-lookup`** — answers questions against `docs/research/` with
  citations and confidence labels, so the corpus does not have to be read into
  the main context repeatedly.

Subagents in `.claude/agents/` are picked up automatically in cloud sessions.

## Plugins

`enabledPlugins` declares two from the official Anthropic marketplace:

- **`security-guidance`** — reviews each change as it is written and fixes what
  it finds in the same session, with support for project-specific rules. This
  codebase holds gateway credentials, panel tokens, wallet ledgers and Telegram
  secrets; it is the best fit in the catalogue.
- **`code-review`** — multi-agent pull request review, complementing the CI gate
  rather than replacing it.

**Caveat worth knowing:** a plugin from an external source that is only enabled
by a project's `settings.json` may not auto-install. Claude Code reports it as
not installed and prints the `claude plugin install` command to run. That is why
the load-bearing project knowledge lives in the skills and agents above, which
are reliably project-scoped, rather than depending on a plugin being present.

### Deliberately not enabled

- **`typescript-lsp`** — genuinely useful in the terminal or desktop app, and
  **inert in cloud sessions**, which do not start plugin language servers.
  Install it at _user_ scope if you also work from the CLI.
- **Ghost Security (`ghostsecurity/skills`)** — a real AppSec skill set
  (SAST, dependency exploitability, secret context, DAST). Held back for two
  reasons: it is a third-party marketplace outside Anthropic's official and
  screened community catalogues, so it carries the full "plugins execute
  arbitrary code with your privileges" warning; and its DAST skills want a live
  application, which does not exist yet. Revisit at the staging milestone, and
  if adopted, pin the marketplace to a reviewed commit and install at user scope
  first.
- **The knowledge-work `engineering` and `design` plugins** — they bundle MCP
  servers (Jira, Linear, Datadog, PagerDuty, Slack) this project does not use.
  Context cost with no return.

Also worth knowing: `security-review`, `code-review` and `simplify` exist as
built-in skills in Claude Code and need no installation at all.
