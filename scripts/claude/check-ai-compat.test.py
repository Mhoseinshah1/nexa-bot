#!/usr/bin/env python3
"""Regression checks for the shared-skill and read-only-role guarantees."""

import importlib.util
import json
from pathlib import Path
import re
import shutil
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("compat", Path(__file__).with_name("check-ai-compat.py"))
compat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compat)
REPO = Path(__file__).resolve().parents[2]


class CompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="nexa-ai-compat-test-")
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        for folder in [".claude/skills", ".claude/agents", ".codex"]:
            shutil.copytree(REPO / folder, self.root / folder)
        shutil.copyfile(REPO / ".claude/settings.json", self.root / ".claude/settings.json")
        shutil.copyfile(REPO / "AGENTS.md", self.root / "AGENTS.md")
        (self.root / ".agents/skills").mkdir(parents=True)
        for name in compat.SKILLS:
            (self.root / ".agents/skills" / name).symlink_to(f"../../.claude/skills/{name}")
        for target in re.findall(r"\]\(([^)#]+)(?:#[^)]*)?\)", (self.root / "AGENTS.md").read_text()):
            if "://" not in target and not (self.root / target).exists():
                path = self.root / target
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture\n")

    def test_repository_is_valid(self):
        compat.validate(REPO)

    def test_copies_cannot_silently_diverge(self):
        link = self.root / ".agents/skills/nexa-conventions"
        link.unlink()
        shutil.copytree(self.root / ".claude/skills/nexa-conventions", link)
        with self.assertRaisesRegex(AssertionError, "not a copy"):
            compat.validate(self.root)

    def test_wrong_symlink_target_is_rejected(self):
        link = self.root / ".agents/skills/nexa-conventions"
        link.unlink()
        link.symlink_to("../../.claude/skills/nexa-handoff")
        with self.assertRaisesRegex(AssertionError, "wrong link target"):
            compat.validate(self.root)

    def test_missing_reference_is_rejected(self):
        (self.root / ".claude/skills/nexa-conventions/references/domain-invariants.md").unlink()
        with self.assertRaisesRegex(AssertionError, "missing references"):
            compat.validate(self.root)

    def test_missing_skill_is_rejected(self):
        (self.root / ".agents/skills/nexa-handoff").unlink()
        with self.assertRaisesRegex(AssertionError, "inventory differs"):
            compat.validate(self.root)

    def test_write_enabled_role_is_rejected(self):
        path = self.root / ".codex/agents/spec-guardian.toml"
        path.write_text(path.read_text().replace('"read-only"', '"workspace-write"'))
        with self.assertRaisesRegex(AssertionError, "remain read-only"):
            compat.validate(self.root)

    def test_claude_hook_removal_is_rejected(self):
        path = self.root / ".claude/settings.json"
        settings = json.loads(path.read_text())
        settings["hooks"]["SessionStart"] = []
        path.write_text(json.dumps(settings))
        with self.assertRaisesRegex(AssertionError, "startup hook missing"):
            compat.validate(self.root)


if __name__ == "__main__":
    unittest.main()
