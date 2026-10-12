#!/usr/bin/env bash
# Self-test for trace.sh against this repository.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
# The real repository: every layer is reachable and the cap is reported.
set +e; out="$(bash "$here/trace.sh" import 1)"; rc=$?; set -e
if [[ "$rc" == 0 ]]; then echo "ok   a huge result exits 0"; else echo "FAIL a huge result exits $rc"; fail=1; fi
for layer in "## web page" "## application" "## tests: integration"; do
  if grep -qF "$layer" <<<"$out"; then echo "ok   reaches '$layer'"; else echo "FAIL never reached '$layer'"; fail=1; fi
done
if grep -qF "more (narrow the term" <<<"$out"; then echo "ok   the cap is reported"; else echo "FAIL the cap is not reported"; fail=1; fi
# A layer whose file list is larger than a pipe buffer (64 KiB), in a
# throwaway repository: a `head` that stops reading would end the script
# under pipefail before the later layers print.
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/docs" "$tmp/tests/unit" && git -C "$tmp" init -q
for i in $(seq 1 1500); do echo needle >"$tmp/docs/a-rather-long-document-name-to-fill-the-pipe-buffer-$i.md"; done
echo needle >"$tmp/tests/unit/z.test.ts"
set +e; big="$(cd "$tmp" && bash "$here/trace.sh" needle 2)"; rc=$?; set -e
if [[ "$rc" == 0 ]] && grep -qF "## tests: unit (1)" <<<"$big"; then
  echo "ok   a layer larger than a pipe buffer does not end the trace"
else
  echo "FAIL a layer larger than a pipe buffer ended the trace (exit $rc)"; fail=1
fi

set +e; bash "$here/trace.sh" >/dev/null 2>&1; rc=$?; set -e
if [[ "$rc" == 2 ]]; then echo "ok   no term is a usage error"; else echo "FAIL no term exits $rc"; fail=1; fi
exit "$fail"
