"""Falsification for the no-Canonical-dependency rules: revert one rule at a time, confirm
tests/unit/ci-tool-installs.test.ts goes red, restore byte-for-byte.
Run from anywhere: python3 scripts/mutate-ci-no-ubuntu.py"""
import os
import subprocess
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + '/'
CI = ROOT + '.github/workflows/ci.yml'
Z = ROOT + 'scripts/ci-install-7zip.sh'
D = ROOT + 'scripts/ci-fetch-debs.sh'
OLD7 = 'run: command -v 7z || (sudo apt-get update -qq && sudo apt-get install -y -qq 7zip)'
M = [
  ('old apt 7zip line (unit)', CI, '        run: bash scripts/ci-install-7zip.sh\n\n      - name: Unit tests', '        ' + OLD7 + '\n\n      - name: Unit tests'),
  ('apt-get download for mysql', CI, 'bash scripts/ci-fetch-debs.sh "$HOME/.cache/nexa-ci-tools/mysql8-debs" \\', 'apt-get download \\'),
  ('7zip checksum dropped', Z, 'SHA256="4ca3b7c6f2f67866b92622818b58233dc70367be2f36b498eb0bdeaaa44b53f4"', 'SHA256=""'),
  ('7zip verification dropped', Z, 'sha256sum --check', 'sha256sum'),
  ('debs trusted=yes', D, 'signed-by=%s', 'trusted=yes signed-by=%s'),
  ('no kernel.org fallback', D, 'https://mirrors.edge.kernel.org/ubuntu}', '}'),
  ('block step not gated', CI, "if: ${{ inputs.block_ubuntu_hosts }}", "if: ${{ true }}"),
  ('cache not bypassable', CI, "        if: ${{ !inputs.bypass_tool_cache }}\n        uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0\n        with:\n          path: ~/.cache/nexa-ci-tools/7zip", "        uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0\n        with:\n          path: ~/.cache/nexa-ci-tools/7zip"),
]
def red():
    r = subprocess.run(['pnpm', '-s', 'vitest', 'run', '--project', 'unit', 'tests/unit/ci-tool-installs.test.ts'], cwd=ROOT, capture_output=True)
    return r.returncode != 0
bad = 0
for name, path, old, new in M:
    original = open(path, 'rb').read()
    text = original.decode()
    if text.count(old) < 1:
        print('MISSING anchor:', name); bad += 1; continue
    try:
        open(path, 'w').write(text.replace(old, new, 1))
        killed = red()
    finally:
        open(path, 'wb').write(original)
    print(('KILLED   ' if killed else 'SURVIVED ') + name)
    bad += 0 if killed else 1
raise SystemExit(1 if bad else 0)
