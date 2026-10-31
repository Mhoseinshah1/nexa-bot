#!/usr/bin/env bash
# ci-status.sh — one-line CI status for a PR or sha, over REST only.
# GraphQL is blocked (403) in these sessions, so this never calls `gh pr`,
# `gh run` or `gh api graphql`; only `gh api repos/<owner>/<repo>/...`.
# JSON is parsed with node (always present), never jq, so there is one path.
set -euo pipefail

usage() {
  cat <<'USAGE'
usage: ci-status.sh <pr-number|sha> [--fail-logs] [--gate]
       ci-status.sh --codex <pr>
       ci-status.sh --wait <pr|sha> [--every SECS] [--max SECS]
       ci-status.sh -h

Prints: <sha8> green=N pending=N red=N skipped=N [red: job1, job2]
Exit:   0 all green, 1 any red, 2 any pending (red wins over pending), 3 error.
Env:    CI_STATUS_REPO=owner/repo   CI_STATUS_GATE_NAME=<regex; default: this repo's aggregate
        check 'Unit and integration tests' (ci.yml job test), or a name containing gate>
USAGE
}

NODE_PROG=$(
  cat <<'JS'
const fs = require('fs');
const [mode, ...args] = process.argv.slice(1);
const read = () => { try { return JSON.parse(fs.readFileSync(0, 'utf8') || 'null'); } catch { return null; } };
// `gh api --paginate` prints one JSON array per page back to back ("[..][..]"), or a single
// merged array; accept both, and flatten them into one array. null when nothing parses.
const readPages = (file) => {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const pages = []; let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '[' || ch === '{') { if (depth++ === 0) start = i; }
    else if (ch === ']' || ch === '}') {
      if (--depth === 0) { try { pages.push(JSON.parse(text.slice(start, i + 1))); } catch { return null; } }
      else if (depth < 0) return null;
    }
  }
  if (depth !== 0 || !pages.length || !pages.every(Array.isArray)) return null;
  return pages.flat();
};
const RED = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'];
const classify = (r) => {
  if (r.status !== 'completed') return 'pending';
  if (r.conclusion === 'success') return 'green';
  if (r.conclusion === 'skipped' || r.conclusion === 'neutral') return 'skipped';
  return 'red'; // listed conclusions, and anything unknown: do not call it green
};
const runsOf = (j) => (j && Array.isArray(j.check_runs) ? j.check_runs : []);
if (mode === 'head-sha') { const j = read(); process.stdout.write((j && j.head && j.head.sha) || ''); }
else if (mode === 'summary') {
  const c = { green: 0, pending: 0, red: 0, skipped: 0 }; const reds = [];
  for (const r of runsOf(read())) { const k = classify(r); c[k]++; if (k === 'red') reds.push(r); }
  console.log(`COUNTS ${c.green} ${c.pending} ${c.red} ${c.skipped}`);
  for (const r of reds) console.log(`RED\t${r.id}\t${r.name}`);
} else if (mode === "run-id") { const j = read(); if (j && j.run_id != null) console.log(j.run_id); }
else if (mode === "gate") {
  const re = new RegExp(args[0] || '^(unit and integration tests|.*gate.*)$', 'i'); const runs = runsOf(read());
  const gates = runs.filter((r) => classify(r) === 'red' && re.test(r.name));
  const others = runs.filter((r) => !gates.includes(r));
  if (gates.length && others.every((r) => ['green', 'skipped'].includes(classify(r)))) console.log(gates[0].id);
} else if (mode === 'codex') {
  const head8 = args[0] || '';
  // Only the real Codex GitHub App counts: this exact login AND account type Bot. A substring
  // match let any human whose login contains "codex" forge a review state (or a clean verdict).
  const isCodex = (c) => !!c.user && c.user.login === 'chatgpt-codex-connector[bot]' && c.user.type === 'Bot';
  const comments = (read() || []).filter(isCodex);
  let thr = null;
  if (args[2]) { try { thr = JSON.parse(fs.readFileSync(args[2], 'utf8')); } catch { thr = null; } }
  if (thr && !Array.isArray(thr)) thr = thr.threads || thr.review_threads || null;
  let tpart = 'threads=unknown';
  if (Array.isArray(thr)) {
    const n = thr.filter((t) => {
      const res = t.isResolved ?? t.is_resolved ?? t.resolved ?? false;
      const cs = Array.isArray(t.comments) ? t.comments : (t.comments && t.comments.nodes) || [];
      const login = cs[0] && ((cs[0].user && cs[0].user.login) || (cs[0].author && cs[0].author.login));
      return !res && (!login || /codex/i.test(login));
    }).length;
    tpart = `unresolved=${n}`;
  }
  const latest = comments.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).pop();
  let rev = latest && latest.commit_id ? latest.commit_id.slice(0, 8) : 'none';
  // Codex also posts "Codex Review Summary" as an ISSUE comment carrying a hidden
  // <!-- codex-review-state:v1 {json} --> marker, and posts no review comment at all
  // when it finds nothing. The marker's commit_sha is what it reviewed.
  const iss = args[1] ? readPages(args[1]) : null;
  let state = null;
  if (Array.isArray(iss)) {
    const stamp = (c) => String(c.updated_at || c.created_at);
    for (const c of iss.filter(isCodex).sort((a, b) => stamp(a).localeCompare(stamp(b)))) {
      const m = String(c.body || '').match(/<!--\s*codex-review-state:v1\s+(\{[\s\S]*?\})\s*-->/);
      if (!m) continue;
      try { const cr = JSON.parse(m[1]).code_review; if (cr && typeof cr === 'object') state = cr; } catch { /* unreadable marker: keep the previous one */ }
    }
  }
  let extra = '';
  if (state) {
    if (typeof state.commit_sha === 'string' && state.commit_sha) rev = state.commit_sha.slice(0, 8);
    if (state.has_any_findings === false) extra += ' findings=none';
    else if (state.has_any_findings === true) extra += ' findings=yes';
    if (state.status) extra += ` status=${state.status}`;
  }
  // The receipt Codex posts when a review finishes: "Didn't find any major issues" (clean) and
  // "**Reviewed commit:** `<sha>`". The latest one from the real bot wins.
  let receipt = null;
  if (Array.isArray(iss)) {
    const stamp = (c) => String(c.updated_at || c.created_at);
    for (const c of iss.filter(isCodex).sort((a, b) => stamp(a).localeCompare(stamp(b)))) {
      const b = String(c.body || '');
      if (!/codex-review-receipt:v1/.test(b)) continue;
      const m = b.match(/Reviewed commit:\**\s*`([0-9a-f]{7,40})`/i);
      if (m) receipt = { sha: m[1].slice(0, 8), clean: /Didn['\u2019]t find any major issues/i.test(b) };
    }
  }
  if (receipt) {
    if (!state) { rev = receipt.sha; if (receipt.clean) extra += ' findings=none'; }
    extra += ` receipt=${receipt.sha}:${receipt.clean ? 'clean' : 'findings'}`;
  }
  // Codex's 👍 on the PR means "reviewed, nothing found". A reaction carries no commit, so it
  // counts for the head only when it is newer than the head commit (thumbsup=head), else stale.
  // The reactions API reports the app's user as type User; its exact "[bot]" login cannot be
  // taken by a person, so the login alone identifies it here.
  const reactions = args[3] ? readPages(args[3]) : null;
  if (Array.isArray(reactions)) {
    const ups = reactions.filter((r) => r && r.content === '+1' && r.user && r.user.login === 'chatgpt-codex-connector[bot]');
    if (ups.length) {
      let headAt = '';
      try { const cm = JSON.parse(fs.readFileSync(args[4], 'utf8')); headAt = String((cm.commit && cm.commit.committer && cm.commit.committer.date) || ''); } catch { headAt = ''; }
      const last = ups.map((r) => String(r.created_at)).sort().pop();
      extra += !headAt ? ' thumbsup=undated' : last >= headAt ? ' thumbsup=head' : ' thumbsup=stale';
    }
  }
  console.log(`codex comments=${comments.length} ${tpart} reviewed=${rev} head=${head8 || 'unknown'}${extra}`);
  for (const c of comments) {
    const body = String(c.body || '');
    const m = body.match(/\bP([0-9])\b/); const pr = m ? `P${m[1]}` : 'P?';
    let t = body.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/<[^>]+>/g, '').replace(/\*\*/g, '').replace(/^\s*P[0-9]\b[\s:.-]*/, '').trim();
    t = t.split('\n').map((s) => s.trim()).find((s) => s) || '';
    const i = t.indexOf('. '); if (i >= 0) t = t.slice(0, i + 1);
    if (t.length > 160) t = t.slice(0, 160);
    console.log(`${pr} ${c.path || '?'}:${c.line ?? c.original_line ?? '?'} — ${t}`);
  }
}
JS
)
jx() { node -e "$NODE_PROG" "$@"; }

die() { echo "ci-status: $*" >&2; exit 3; }

repo_slug() {
  if [[ -n "${CI_STATUS_REPO:-}" ]]; then echo "$CI_STATUS_REPO"; return; fi
  local url
  url="$(git remote get-url origin 2>/dev/null)" || die "no origin remote; set CI_STATUS_REPO=owner/repo"
  url="${url%/}"; url="${url%.git}"
  # last two components, whether separated by / (https, proxy prefix) or : (scp-style)
  echo "$url" | sed -E 's#^.*[/:]([^/:]+)/([^/:]+)$#\1/\2#'
}

target="" ; codex_pr="" ; want_logs=0 ; want_gate=0 ; want_codex=0 ; wait=0 ; every=30 ; max=1800
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --fail-logs) want_logs=1 ;;
    --gate) want_gate=1 ;;
    --wait) wait=1 ;;
    --every) every="${2:?--every needs seconds}"; shift ;;
    --max) max="${2:?--max needs seconds}"; shift ;;
    --codex)
      want_codex=1
      if [[ "${2:-}" =~ ^[0-9]+$ ]]; then codex_pr="$2"; shift; fi ;;
    -*) usage >&2; exit 3 ;;
    *) target="$1" ;;
  esac
  shift
done
[[ "$every" =~ ^[0-9]+$ && "$max" =~ ^[0-9]+$ ]] || die "--every and --max take whole seconds"
if [[ -z "$target" && -z "$codex_pr" ]]; then usage >&2; exit 3; fi
if [[ -z "$codex_pr" && $want_codex == 1 && "$target" =~ ^[0-9]{1,6}$ ]]; then codex_pr="$target"; fi


R="$(repo_slug)"
OWNER="${R%%/*}" ; NAME="${R##*/}"

api() { gh api "$@"; }

is_pr() { [[ "$1" =~ ^[0-9]+$ && ${#1} -lt 7 ]]; }

head_of_pr() {
  local j
  j="$(api "repos/$R/pulls/$1")" || die "cannot read PR $1"
  j="$(jx head-sha <<<"$j")"
  [[ -n "$j" ]] || die "PR $1 has no head sha"
  echo "$j"
}

checks_json=""
summary_line() { # sha -> sets checks_json, prints the line, returns the exit code
  local sha="$1" out counts reds="" g p r s names=()
  checks_json="$(api "repos/$R/commits/$sha/check-runs?per_page=100")" || die "cannot read check runs for $sha"
  out="$(jx summary <<<"$checks_json")"
  counts="$(sed -n 's/^COUNTS //p' <<<"$out")"
  read -r g p r s <<<"$counts"
  while IFS=$'\t' read -r _ _ nm; do names+=("$nm"); done < <(grep '^RED' <<<"$out" || true)
  if ((r > 0)); then
    reds=" [red: $(printf '%s, ' "${names[@]}" | sed 's/, $//')]"
  fi
  echo "${sha:0:8} green=$g pending=$p red=$r skipped=$s$reds"
  # No check run yet (just pushed) is pending, never "all green".
  if ((r > 0)); then return 1; elif ((p > 0 || g + s == 0)); then return 2; fi
  return 0
}

fail_logs() {
  local out id nm log n start
  out="$(jx summary <<<"$checks_json")"
  while IFS=$'\t' read -r _ id nm; do
    echo "--- $nm ($id)"
    if log="$(api "repos/$R/actions/jobs/$id/logs" 2>&1)" && [[ -n "${log//[[:space:]]/}" ]] \
      && [[ "$(sed -n '1,3p' <<<"$log" | grep -Eic 'redirect|blob|302' || true)" == 0 ]]; then
      n="$(grep -nEm1 '##\[error\]|FAIL|Error:|✗|AssertionError' <<<"$log" | cut -d: -f1 || true)"
      if [[ -n "$n" ]]; then
        start=$((n > 5 ? n - 5 : 1))
        sed -n "${start},$((start + 19))p" <<<"$log"
      else
        tail -n 20 <<<"$log"
      fi
    else
      echo "logs unavailable via gh api (proxy blocks blob redirect); use MCP: mcp__github__get_job_logs owner=$OWNER repo=$NAME job_id=$id return_content=true tail_lines=200"
    fi
  done < <(grep '^RED' <<<"$out" || true)
}

gate_check() {
  local id run
  id="$(jx gate "${CI_STATUS_GATE_NAME:-}" <<<"$checks_json")"
  if [[ -z "$id" ]]; then echo "gate-only-red: no"; return; fi
  run="$(api "repos/$R/actions/jobs/$id" | jx run-id 2>/dev/null || true)"
  [[ -n "$run" ]] || { echo "gate-only-red: yes, but run id unavailable for job $id"; return; }
  echo "gate-only-red: rerun with gh api -X POST repos/$R/actions/runs/$run/rerun-failed-jobs"
}

codex_report() {
  local pr="$1" head comments tdir
  head="$(head_of_pr "$pr")"
  comments="$(api "repos/$R/pulls/$pr/comments?per_page=100")" || die "cannot read review comments"
  # Both extra payloads go to node as FILES, never environment variables: a long discussion
  # (or pasted logs) can exceed the per-string environment limit and node would not start.
  tdir="$(mktemp -d)"
  api "repos/$R/pulls/$pr/ccr/review_threads" >"$tdir/threads.json" 2>/dev/null || : >"$tdir/threads.json"
  # Issue comments: where Codex's "Codex Review Summary" and its state marker live. Every page,
  # so a summary past the first 100 comments is seen. Unreadable is not fatal; the review
  # comments above still say what they say.
  api "repos/$R/issues/$pr/comments?per_page=100" --paginate >"$tdir/issue.json" 2>/dev/null || : >"$tdir/issue.json"
  # Codex's 👍 reaction, and the head commit's date to tell whether the 👍 is newer.
  api "repos/$R/issues/$pr/reactions?per_page=100" --paginate >"$tdir/reactions.json" 2>/dev/null || : >"$tdir/reactions.json"
  api "repos/$R/commits/$head" >"$tdir/head.json" 2>/dev/null || : >"$tdir/head.json"
  jx codex "${head:0:8}" "$tdir/issue.json" "$tdir/threads.json" "$tdir/reactions.json" "$tdir/head.json" <<<"$comments" || { rm -rf "$tdir"; return 1; }
  rm -rf "$tdir"
}

rc=0
if [[ -n "$target" ]]; then
  if is_pr "$target"; then sha="$(head_of_pr "$target")"; else sha="$target"; fi
  if [[ $wait == 1 ]]; then
    while :; do
      rc=0; summary_line "$sha" || rc=$?
      [[ $rc != 2 ]] && break
      ((SECONDS >= max)) && break
      sleep "$every"
    done
  else
    summary_line "$sha" || rc=$?
  fi
  [[ $want_gate == 1 ]] && gate_check
  [[ $want_logs == 1 ]] && fail_logs
fi
[[ $want_codex == 1 && -n "$codex_pr" ]] && codex_report "$codex_pr"
exit "$rc"
