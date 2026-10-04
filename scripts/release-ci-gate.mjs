#!/usr/bin/env node
/**
 * The release gate's decision: did CI pass for EXACTLY this commit?
 *
 * `release.yml` publishes an image that every installation may pull, so it
 * refuses to build until GitHub itself says the repository's own CI succeeded
 * for the commit the tag resolves to. This file is that decision, and nothing
 * else: it reads workflow runs that somebody else fetched (`release-ci-gate.sh`
 * asks the API) and says yes or no, with the reason.
 *
 * It is a pure function over data so it can be tested against every shape the
 * API returns — `tests/unit/release-ci-gate.test.ts` and
 * `tests/deploy/release-ci-gate.test.sh` share the fixtures in
 * `tests/fixtures/release-gate/`. The previous gate was a `while read` loop
 * inside the workflow, which no test could reach.
 *
 * What counts as evidence, and why each rule exists:
 *
 * - The run's `path` is the authoritative workflow file. A green run of some
 *   other workflow proves nothing about CI.
 * - The run's `head_sha` equals the tag's commit, compared HERE, not trusted to
 *   the query filter. A green run of an older or newer commit is a different
 *   program.
 * - The run's `event` is `push` or `workflow_dispatch`. Both check out and test
 *   `head_sha` itself. A `pull_request` run reports the PR head as `head_sha`
 *   but tests `refs/pull/N/merge` — the PR merged into whatever the base was at
 *   that moment — so its green is evidence about a commit that is NOT the one
 *   being released. Accepting it would be "this commit merged with something,
 *   once, passed", which is not the gate.
 * - `status` is `completed` and `conclusion` is `success`. Nothing else is a
 *   pass: cancelled, failure, timed_out, skipped, neutral, stale,
 *   action_required, startup_failure, and any run still queued or in progress.
 * - The run's attempt number does not matter. The API reports the LATEST
 *   attempt of each run, so a cancelled or flaky first attempt that was re-run
 *   to success is a success, and a success whose re-run is still going is not
 *   yet anything — wait for it to finish.
 *
 * One accepted success is enough. A second accepted run of the same commit
 * that failed is reported alongside it, so the operator sees it, but it does
 * not veto: the same bytes passed every required job once, in full.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The workflow whose success is the precondition for a release. */
export const AUTHORITATIVE_WORKFLOW = '.github/workflows/ci.yml';

/** Events whose run tests `head_sha` itself, rather than a merge of it. */
export const ACCEPTED_EVENTS = Object.freeze(['push', 'workflow_dispatch']);

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The shape a release tag must have.
 *
 * `v` plus what `nexa_valid_version` in deploy/bin/nexa-lib.sh accepts as a
 * version, because the tag becomes the image tag and botctl's version string.
 * A value outside both is refused here, before anything is built under it.
 */
export function validateReleaseTag(tag) {
  if (typeof tag !== 'string') return 'the tag is not a string';
  if (!/^v[0-9A-Za-z][0-9A-Za-z._-]{0,62}$/.test(tag)) {
    return `"${tag}" is not a release tag: releases are tagged v<version> (letters, digits, dot, dash, underscore)`;
  }
  if (tag.includes('..')) return `"${tag}" contains "..", which botctl refuses as a version`;
  return null;
}

/**
 * Decide the gate.
 *
 * @param {{ sha: string, workflowPath?: string, runs: ReadonlyArray<Record<string, unknown>> }} input
 * @returns {{ ok: boolean, reason: string, accepted: Record<string, unknown> | null, considered: Array<{ run: Record<string, unknown>, verdict: string }> }}
 */
export function decideReleaseGate({ sha, workflowPath = AUTHORITATIVE_WORKFLOW, runs }) {
  if (typeof sha !== 'string' || !FULL_SHA.test(sha)) {
    return {
      ok: false,
      reason: `"${String(sha)}" is not a full 40-character commit SHA; the gate compares exact SHAs only`,
      accepted: null,
      considered: [],
    };
  }

  const considered = [];
  let accepted = null;
  let pending = null;

  for (const run of runs) {
    const verdict = verdictFor(run, sha, workflowPath);
    considered.push({ run, verdict });
    if (verdict === 'accepted' && accepted === null) accepted = run;
    if (verdict === 'pending' && pending === null) pending = run;
  }

  if (accepted !== null) {
    return {
      ok: true,
      reason: `${workflowPath} passed for ${sha}: ${describe(accepted)}`,
      accepted,
      considered,
    };
  }

  const relevant = considered.filter((c) => !c.verdict.startsWith('ignored'));
  let reason;
  if (pending !== null) {
    reason =
      `${workflowPath} is still running for ${sha} (${describe(pending)}). ` +
      'Wait for it to complete successfully, then re-run the release.';
  } else if (relevant.length === 0) {
    reason =
      `no push or workflow_dispatch run of ${workflowPath} exists for ${sha}. ` +
      'A pull_request run does not count: it tested a merge of this commit, not this commit. ' +
      'Run CI for this exact commit (Actions -> CI -> Run workflow on the branch whose head it is), ' +
      'or tag a commit that main has already tested.';
  } else {
    reason =
      `no SUCCESSFUL push or workflow_dispatch run of ${workflowPath} exists for ${sha}. ` +
      'Re-run the failed or cancelled run (Re-run all jobs) and re-run the release once it is green.';
  }
  return { ok: false, reason, accepted: null, considered };
}

/** One run's verdict. Anything that is not `accepted` is not a pass. */
export function verdictFor(run, sha, workflowPath = AUTHORITATIVE_WORKFLOW) {
  if (run === null || typeof run !== 'object') return 'ignored: not a workflow run';
  if (run.path !== workflowPath) return `ignored: a run of ${String(run.path)}`;
  if (run.head_sha !== sha) return `ignored: a run of another commit (${String(run.head_sha)})`;
  if (!ACCEPTED_EVENTS.includes(/** @type {string} */ (run.event))) {
    return `ignored: a ${String(run.event)} run does not test this exact commit`;
  }
  if (run.status !== 'completed') return 'pending';
  if (run.conclusion !== 'success') return `rejected: concluded ${String(run.conclusion)}`;
  return 'accepted';
}

function describe(run) {
  if (run === null || typeof run !== 'object') return String(run);
  const attempt = run.run_attempt === undefined ? '' : `, attempt ${String(run.run_attempt)}`;
  const branch = run.head_branch ? ` on ${String(run.head_branch)}` : '';
  return `${String(run.event)} run${branch}${attempt} ${String(run.html_url ?? run.id ?? '')}`.trim();
}

/** Parses the fetcher's output: one JSON workflow run per line. */
export function parseRuns(text) {
  const runs = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    try {
      runs.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`line ${index + 1} of the workflow-run listing is not JSON`, {
        cause: error,
      });
    }
  }
  return runs;
}

function main(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i], argv[i + 1]);
  if (args.has('--validate-tag')) {
    const problem = validateReleaseTag(args.get('--validate-tag'));
    if (problem === null) return 0;
    process.stderr.write(`refusing to release: ${problem}\n`);
    return 1;
  }
  const sha = args.get('--sha');
  const file = args.get('--runs');
  const workflowPath = args.get('--workflow') ?? AUTHORITATIVE_WORKFLOW;
  if (!sha || !file) {
    process.stderr.write(
      'usage: release-ci-gate.mjs --sha <40-hex> --runs <jsonl> [--workflow <path>]\n' +
        '       release-ci-gate.mjs --validate-tag <tag>\n',
    );
    return 2;
  }
  let runs;
  try {
    runs = parseRuns(readFileSync(file, 'utf8'));
  } catch (error) {
    process.stderr.write(`refusing: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const decision = decideReleaseGate({ sha, workflowPath, runs });
  for (const { run, verdict } of decision.considered) {
    process.stdout.write(`  ${verdict}  ${describe(run)}\n`);
  }
  if (decision.ok) {
    process.stdout.write(`PASS  ${decision.reason}\n`);
    return 0;
  }
  process.stderr.write(`FAIL  ${decision.reason}\n`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
