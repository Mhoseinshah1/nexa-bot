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

`CLAUDE.md` is now short; the long-form owner decisions (money, pricing,
referral, reseller, gateway and recovery rules) live in `docs/project-status.md`.

### `skills/`

- **`nexa-conventions`** — the money, time, tenancy, event, audit, idempotency,
  text, secret and domain-invariant rules Claude applies while writing code.
- **`nexa-migrations`** — write, renumber and verify a migration, including what
  `drizzle-kit` does not model.
- **`nexa-code-navigation`** — layer map, `scripts/claude/module-map.sh` and
  `scripts/trace.sh <term>`: find the files behind a feature without reading
  directories, and which files never to read whole.
- **`nexa-test-selection`** — which tests to run while iterating, which guard
  suites are never narrowed, and when the full gate runs.
- **`nexa-pr-workflow`** — branch → PR → CI → review → merge, conflict and
  migration-collision checks; merging stays the owner's explicit call.
- **`nexa-handoff`** — a short structured handoff between sessions;
  `scripts/handoff-facts.sh` generates the git half.
- **`nexa-web-design`** — Web Admin rules (RTL, Vazirmatn, tokens, CSP, touch,
  accessibility, permissions, no demo data); the visual redesign is paused.
- **`nexa-round-pipeline`** — the owner's standing rules for a multi-agent work
  round: worktrees, 25-line reports, push → CI → Codex → fix → merge-commit.
- **`nexa-ci-watch`** — read and wait for CI and the Codex review cheaply with
  `scripts/claude/ci-status.sh` (REST only; GraphQL is blocked).
- **`nexa-log-digest`** — shrink test, typecheck, lint and `pnpm verify` output
  to the failures with `scripts/claude/log-digest.sh` before reading it.
- **`nexa-gateway-integration`** — checklist and required tests for adding or
  changing a payment gateway (inquiry-only approval, UNKNOWN, late credit).

Skills load progressively: only each `description` is in context until a task
matches it; the body and any `references/` file are read on demand. Keep
descriptions specific and bodies short, and point at `docs/` rather than
copying it. The scripts under `skills/*/scripts/` (`trace.sh`,
`select-tests.sh`, `branch-check.sh`, `handoff-facts.sh`) are read-only helpers;
each has a `*.test.sh` beside it (run by hand — not part of `pnpm verify`).

### `scripts/claude/`

Repository-level helpers the skills call (outside `.claude/`):

- **`ci-status.sh`** — one line per PR head (green/pending/red), trimmed failure
  logs and Codex findings, over the REST API.
- **`log-digest.sh`** — filters tool output down to failures, at most 40 lines.
- **`module-map.sh`** — a module's services, tables it writes, contracts and
  tests; also `--who-writes` and `--who-calls`.
- **`check-claude-md-moves.mjs`** — checks that every heading and bold span of the old
  `CLAUDE.md` still exists in the new one, `docs/project-status.md` or a skill.

Tests: `bash scripts/claude/<name>.test.sh` for the three shell scripts and
`node --test scripts/claude/check-claude-md-moves.test.mjs`. Run by hand — not
part of `pnpm verify`.

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
