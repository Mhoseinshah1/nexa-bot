#!/usr/bin/env python3
"""Check shared project skills; --native also asks the installed Codex loader."""

import argparse
import json
from pathlib import Path
import re
import selectors
import shutil
import subprocess
import tempfile
import time
import tomllib


SKILLS = (
    "nexa-ci-watch", "nexa-code-navigation", "nexa-conventions",
    "nexa-gateway-integration", "nexa-handoff", "nexa-log-digest",
    "nexa-migrations", "nexa-pr-workflow", "nexa-round-pipeline",
    "nexa-test-selection", "nexa-web-design",
)
ROLES = {"spec_guardian": "spec-guardian", "research_lookup": "research-lookup"}


def validate(root):
    """Fail on divergent copies, broken support files, or unsafe role adapters."""
    root = Path(root).resolve()
    source = root / ".claude/skills"
    aliases = root / ".agents/skills"
    assert {p.name for p in source.iterdir() if p.is_dir()} == set(SKILLS), "source skill inventory changed"
    assert {p.name for p in aliases.iterdir()} == set(SKILLS), "Codex skill inventory differs"
    for name in SKILLS:
        link = aliases / name
        canonical = source / name
        assert link.is_symlink(), f"{name}: must share the original, not a copy"
        assert not Path(link.readlink()).is_absolute(), f"{name}: link must be relative"
        assert link.resolve(strict=True) == canonical.resolve(), f"{name}: wrong link target"
        body = (link / "SKILL.md").read_text()
        assert body.startswith("---\n"), f"{name}: missing skill frontmatter"
        header = body.split("---", 2)[1]
        assert re.search(rf"^name: {re.escape(name)}$", header, re.M), f"{name}: wrong skill name"
        description = re.search(r"^description: (.+)$", header, re.M)
        assert description and 0 < len(description[1]) <= 1024, f"{name}: invalid description"
        for relative in re.findall(r"references/[\w./-]+\.md", body):
            assert (link / relative).is_file(), f"{name}: missing {relative}"
        for path in canonical.rglob("*"):
            if path.is_file():
                shared = link / path.relative_to(canonical)
                assert shared.resolve() == path.resolve(), f"{name}: inaccessible support file {path.name}"

    settings = json.loads((root / ".claude/settings.json").read_text())
    assert settings["hooks"]["SessionStart"], "Claude startup hook missing"
    assert settings["permissions"]["deny"], "Claude permission restrictions missing"
    config = tomllib.loads((root / ".codex/config.toml").read_text())
    assert set(config) == {"agents"}, "project config must not change global permissions or hooks"
    assert set(config["agents"]) == set(ROLES), "native role inventory differs"
    for role, filename in ROLES.items():
        adapter = root / ".codex" / config["agents"][role]["config_file"]
        data = tomllib.loads(adapter.read_text())
        assert data["sandbox_mode"] == "read-only", f"{role}: role must remain read-only"
        original = f".claude/agents/{filename}.md"
        assert original in data["developer_instructions"], f"{role}: authoritative prompt missing"
        assert (root / original).is_file(), f"{role}: source prompt missing"

    for target in re.findall(r"\]\(([^)#]+)(?:#[^)]*)?\)", (root / "AGENTS.md").read_text()):
        if "://" not in target:
            assert (root / target).exists(), f"AGENTS.md: missing link {target}"


def native_discovery(root):
    """No model request, hook execution, credential access, or persistent trust edit."""
    with tempfile.TemporaryDirectory(prefix="nexa-codex-discovery-") as scratch:
        # This control has no .claude directory: discovery must follow .agents links.
        control = Path(scratch) / "symlink-control"
        shared = control / "shared-skills"
        shutil.copytree(root / ".claude/skills", shared)
        (control / ".agents/skills").mkdir(parents=True)
        for name in SKILLS:
            (control / ".agents/skills" / name).symlink_to(f"../../shared-skills/{name}")
        with (Path(scratch) / "stderr.log").open("w+") as errors:
            proc = subprocess.Popen(
                ["codex", "--strict-config", "-c", f'sqlite_home="{scratch}/state"',
                 "-c", f'log_dir="{scratch}/logs"', "app-server", "--listen", "stdio://"],
                cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors,
                text=True, bufsize=1,
            )
            selector = selectors.DefaultSelector()
            selector.register(proc.stdout, selectors.EVENT_READ)

            def request(number, method, params):
                proc.stdin.write(json.dumps({"id": number, "method": method, "params": params}) + "\n")
                proc.stdin.flush()
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    if not selector.select(1):
                        continue
                    line = proc.stdout.readline()
                    if not line:
                        errors.seek(0)
                        raise RuntimeError("Codex app-server exited: " + errors.read()[-2000:])
                    response = json.loads(line)
                    if response.get("id") == number:
                        assert "error" not in response, response.get("error")
                        return response["result"]
                raise TimeoutError(f"Codex {method} did not answer within 30 seconds")

            try:
                request(1, "initialize", {"clientInfo": {"name": "nexa_compat_check", "version": "1.0"}})
                proc.stdin.write('{"method":"initialized","params":{}}\n')
                proc.stdin.flush()
                result = request(2, "skills/list", {"cwds": [str(root), str(control)], "forceReload": True})
                for cwd, canonical in [(root, root / ".claude/skills"), (control, shared)]:
                    entry = next(item for item in result["data"] if Path(item["cwd"]).resolve() == cwd)
                    assert not entry["errors"], entry["errors"]
                    found = {skill["name"]: skill for skill in entry["skills"] if skill["name"] in SKILLS}
                    assert set(found) == set(SKILLS), f"Codex did not discover {set(SKILLS) - set(found)}"
                    for name, skill in found.items():
                        assert skill["enabled"], f"{name}: disabled in Codex"
                        path = Path(skill["path"])
                        assert path.resolve() == (canonical / name / "SKILL.md").resolve(), name
                        assert path.read_text(), f"{name}: loader path cannot be read"
                print(f"Codex native discovery: {len(SKILLS)} enabled skills in repository and isolated symlink control; no loader errors")
            finally:
                selector.close()
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                proc.stdin.close()
                proc.stdout.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native", action="store_true", help="require local Codex app-server discovery too")
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[2]
    validate(repository)
    print("Shared skills, support files, instructions, Claude settings and read-only roles: valid")
    if args.native:
        native_discovery(repository)
