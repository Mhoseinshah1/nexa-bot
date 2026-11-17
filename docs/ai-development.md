# Shared AI development configuration

Claude Code and Codex use the same project rules and skill bodies. Start with
[`CLAUDE.md`](../CLAUDE.md) or [`AGENTS.md`](../AGENTS.md); standing decisions in
[`project-status.md`](project-status.md) and [`conventions.md`](conventions.md)
remain authoritative. This configuration does not change application behavior,
the hosting system, database contents, dependency pins or production settings.

## Skills: one source, two discovery locations

`.claude/skills/` remains the editable source. Each directory under
`.agents/skills/` is a relative symlink to that source, including its
`references/` and `scripts/`. Do not replace links with independent copies.
Git records these as symlinks (mode `120000`); clients that check them out as
plain text files need a symlink-capable checkout. Verify rather than assuming
Windows, another filesystem or a different client behaves like this Linux host.

| Skill                      | Use                                                      |
| -------------------------- | -------------------------------------------------------- |
| `nexa-ci-watch`            | CI and the prescribed external review over REST          |
| `nexa-code-navigation`     | Layer map, traces and bounded reads                      |
| `nexa-conventions`         | Tenant, financial, transaction and security rules        |
| `nexa-gateway-integration` | Gateway invariants and required checks                   |
| `nexa-handoff`             | Verified, bounded session handoffs                       |
| `nexa-log-digest`          | Failure summaries with preserved exit status             |
| `nexa-migrations`          | Forward-only migrations and collision handling           |
| `nexa-pr-workflow`         | Branch, PR, review and owner-approved merge rules        |
| `nexa-round-pipeline`      | Explicitly invoked multi-agent rounds                    |
| `nexa-test-selection`      | Focused checks and mandatory guard suites                |
| `nexa-web-design`          | Admin RTL, tokens, CSP, accessibility and API boundaries |

All eleven were discovered, enabled and readable through Codex app-server's
`skills/list` with `forceReload: true` on Linux using `codex-cli
0.167.0-alpha.4`, with no loader errors. Their existing name/description
frontmatter needed no adaptation. Reload/restart a client that cached the skill
list before these links existed; the check below bypasses that cache.

Skill-local references resolve relative to the loaded skill directory. Commands
that explicitly name `.claude/skills/...` still work: that location is retained.
The shared instructions contain Claude tool names and model-tier conventions;
map those to the host's available capabilities without weakening any rule.
Unavailable tools, model-tier selection or external reviews must be reported,
not simulated or described as completed. A round's worktree/agent instructions
apply when that round is invoked, not automatically on every small task.

## Subagents

`.codex/config.toml` registers native role adapters; it changes no global
approval, network, model or sandbox policy. Each adapter uses a read-only sandbox
and tells the agent to read the original prompt before doing any work.

| Claude agent source                 | Native Codex role | Preserved behavior                                                                      |
| ----------------------------------- | ----------------- | --------------------------------------------------------------------------------------- |
| `.claude/agents/spec-guardian.md`   | `spec_guardian`   | Review only; frozen contracts, concept boundaries, security checks and precise findings |
| `.claude/agents/research-lookup.md` | `research_lookup` | Read-only evidence lookup with citations and confidence labels                          |

Codex clients must support custom roles and trust the checkout before loading
project `.codex/config.toml`. The tested managed app-server reports this project
layer as disabled until that trust is recorded in the user's Codex settings;
skill discovery still succeeds. This change does not grant trust or edit user
configuration. Role TOML and prompt references are structurally checked; no
claim is made that this managed chat's spawn tool automatically imports them.

In a trusted CLI/client, select the registered role through its native agent
workflow. If a managed host exposes only generic subagents, explicitly give a
read-only reviewer the corresponding original `.claude/agents/*.md` prompt and
the review scope. Honor its tool restrictions and finding format. This is an
explicit alternative, not automatic Claude-agent discovery. If no independent
reviewer is available, record that limitation; do not mark the review complete.

## Hooks, permissions and plugins

Claude continues to read `.claude/settings.json` unchanged:

- Its `SessionStart` hook invokes `scripts/claude-session-start.sh` for
  `startup|resume`. That script installs/builds, starts services, may create a
  local `.env`, applies migrations, and deliberately exits zero even after a
  failed prerequisite. Its exit status is not evidence that setup succeeded.
- `security-guidance@claude-plugins-official` is enabled; actual installation
  depends on Claude's client. `code-review@claude-plugins-official` is **disabled**
  in settings, despite the older `.claude/README.md` describing both as enabled.
- Claude's allow/deny tool rules remain Claude-specific, including secret-file
  reads and unsafe Git operations. Codex does not import that permission list.

Codex has native lifecycle hooks in versions that support them, with its own
trust/configuration requirements. It does **not** automatically execute Claude's
`SessionStart` configuration. No native hook is registered here: silently
porting the existing mutating, always-zero installer would hide failures and
could modify a database on an instructions-only task. The supported startup
alternative is the cloud environment's saved install/start instructions, or
the documented development commands when setup is actually authorized. Preserve
the existing local configuration; never reset an encryption key or seed an
existing database merely to load AI instructions.

The previous cloud setup retained Node/pnpm tools, ignored `.env`, generated
development credentials, logs, builds and `run-reaped.py` outside tracked files.
They are instance-specific setup state, not project configuration to commit.
The reaper addresses this container's non-reaping PID 1; it is not an application
change. Future machines must use the saved environment startup instructions.

Claude marketplace plugins are not Codex plugins. This change installs none.
Codex's review workflow, the original spec-guardian prompt, project security
conventions and required checks are practical alternatives, not a claim that
the Claude security plugin ran. Preserve the prescribed PR review request and
CI checks; the owner still approves every merge. Instruction files are not
sandbox enforcement: the host's permission controls remain necessary. Do not
copy Claude allow rules into a broader Codex approval or secret-read policy.

## Verification

Use Python 3.11+ for the standard-library TOML parser. No extra Python package
or external plugin is required. Run from the repository root:

```bash
python3 scripts/claude/check-ai-compat.py
python3 scripts/claude/check-ai-compat.py --native
bash scripts/claude/run-gate.sh python3 -B scripts/claude/check-ai-compat.test.py
```

The structural check rejects copied/divergent skill directories, wrong targets,
missing references, missing skills, write-enabled role adapters and broken
instruction links. Regression tests deliberately break those guarantees.
`--native` starts the installed Codex app-server, initializes its protocol and
asks its real loader for all eleven skills; it reads each returned skill path.
It also checks an isolated fixture with no `.claude` directory, so success
cannot come from a client's separate Claude discovery path. It makes no model
request, runs no startup hook and changes no persistent trust setting. Codex
still needs access to its normal writable user state directory;
report a sandbox/state-directory error rather than bypassing trust or claiming
native discovery passed. The non-native structural check is not a substitute
for that loader test.

Also run the four existing skill-helper self-tests through their `.agents`
paths, targeted Markdown formatting, `pnpm check:boundaries`, `pnpm check:i18n`
and `git diff --check`. Verify `.claude/`, `CLAUDE.md`, application source,
contracts and lockfiles are unchanged. Use `nexa-test-selection`'s non-money
tiers; the previous cloud build/typecheck/application-test results need not be
repeated for this AI configuration change. CI still decides its required jobs
on the exact PR head; unknown paths may select the full workflow (`ci.md`).

For a PR, use `nexa-pr-workflow` and `nexa-ci-watch`. A working Git proxy does
not imply REST API access. If `api.github.com` or authorization is unavailable,
keep the branch and exact PR body ready, report the specific blocker, and never
claim an open PR, successful review, green CI or merge without evidence.
