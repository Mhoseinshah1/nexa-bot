import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_EVENTS,
  AUTHORITATIVE_WORKFLOW,
  decideReleaseGate,
  parseRuns,
  validateReleaseTag,
} from '../../scripts/release-ci-gate.mjs';

/**
 * The release gate's decision, over every shape of workflow run it can be
 * shown. `tests/deploy/release-ci-gate.test.sh` drives the same fixtures
 * through the shell wrapper and a fake `gh`; this file pins the decision rules
 * one at a time, so a mutation of any single rule turns exactly one case red.
 */
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const FIXTURES = join(__dirname, '../fixtures/release-gate');

function fixture(name: string): Record<string, unknown>[] {
  const dir = join(FIXTURES, name);
  return readdirSync(dir)
    .filter((f) => f.startsWith('page-'))
    .sort()
    .flatMap(
      (f) =>
        (
          JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
            workflow_runs: Record<string, unknown>[];
          }
        ).workflow_runs,
    );
}

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    path: AUTHORITATIVE_WORKFLOW,
    head_sha: SHA,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    html_url: 'https://github.com/example/nexa-bot/actions/runs/1',
    ...overrides,
  };
}

describe('the release CI gate', () => {
  it.each([
    ['rerun-success', true],
    ['success-on-second-page', true],
    ['dispatch-success', true],
    ['cancelled', false],
    ['failure', false],
    ['in-progress', false],
    ['other-sha-green', false],
    ['pull-request-green', false],
    ['other-workflow-green', false],
    ['no-runs', false],
  ])('decides the %s fixture: pass=%s', (name, expected) => {
    expect(decideReleaseGate({ sha: SHA, runs: fixture(name) }).ok).toBe(expected);
  });

  it('accepts a success reached on a re-run, whatever the attempt number', () => {
    // The API reports a run's LATEST attempt. Attempt 1 cancelled by a newer
    // push and attempt 2 green is exactly the case the gate must find.
    for (const attempt of [1, 2, 7]) {
      expect(decideReleaseGate({ sha: SHA, runs: [run({ run_attempt: attempt })] }).ok).toBe(true);
    }
  });

  it.each([
    'cancelled',
    'failure',
    'timed_out',
    'skipped',
    'neutral',
    'stale',
    'action_required',
    'startup_failure',
    null,
  ])('rejects a completed run that concluded %s', (conclusion) => {
    const decision = decideReleaseGate({ sha: SHA, runs: [run({ conclusion })] });
    expect(decision.ok).toBe(false);
    expect(decision.accepted).toBeNull();
  });

  it.each(['queued', 'in_progress', 'waiting', 'requested', 'pending'])(
    'rejects a run whose status is %s, even with a stale success conclusion on it',
    (status) => {
      // A re-run in progress of a run that passed before: the API shows the
      // new attempt's status. Not a pass until it finishes.
      const decision = decideReleaseGate({
        sha: SHA,
        runs: [run({ status, conclusion: 'success' })],
      });
      expect(decision.ok).toBe(false);
      expect(decision.reason).toContain('still running');
    },
  );

  it('rejects a green run of another commit, even when the query filter let it through', () => {
    const decision = decideReleaseGate({ sha: SHA, runs: [run({ head_sha: OTHER })] });
    expect(decision.ok).toBe(false);
    // Nor does a SHA prefix match.
    expect(decideReleaseGate({ sha: SHA, runs: [run({ head_sha: SHA.slice(0, 7) })] }).ok).toBe(
      false,
    );
  });

  it('rejects a green pull_request run: it tested a merge of the commit, not the commit', () => {
    expect(ACCEPTED_EVENTS).toEqual(['push', 'workflow_dispatch']);
    const decision = decideReleaseGate({ sha: SHA, runs: [run({ event: 'pull_request' })] });
    expect(decision.ok).toBe(false);
    for (const event of ['pull_request_target', 'schedule', 'merge_group', 'release']) {
      expect(decideReleaseGate({ sha: SHA, runs: [run({ event })] }).ok, event).toBe(false);
    }
  });

  it('rejects a green run of any other workflow', () => {
    for (const path of [
      '.github/workflows/exhaustive.yml',
      '.github/workflows/release.yml',
      'ci.yml',
      '.github/workflows/ci.yaml',
    ]) {
      expect(decideReleaseGate({ sha: SHA, runs: [run({ path })] }).ok, path).toBe(false);
    }
  });

  it('passes on one accepted success beside failed, cancelled and foreign runs', () => {
    const decision = decideReleaseGate({
      sha: SHA,
      runs: [
        run({ id: 1, conclusion: 'cancelled' }),
        run({ id: 2, event: 'pull_request' }),
        run({ id: 3, head_sha: OTHER }),
        run({ id: 4, run_attempt: 3 }),
      ],
    });
    expect(decision.ok).toBe(true);
    expect(decision.accepted?.id).toBe(4);
    // Every run is reported, so the operator sees the failed ones too.
    expect(decision.considered).toHaveLength(4);
  });

  it('refuses anything but a full lowercase SHA', () => {
    for (const sha of [SHA.slice(0, 7), SHA.toUpperCase(), `${SHA}\n`, '', 'v1.0.0']) {
      expect(decideReleaseGate({ sha, runs: [run({ head_sha: sha })] }).ok, sha).toBe(false);
    }
  });

  it('parses one run per line and refuses a listing it cannot read', () => {
    expect(
      parseRuns(`${JSON.stringify(run())}\n\n${JSON.stringify(run({ id: 2 }))}\n`),
    ).toHaveLength(2);
    expect(() => parseRuns('{"id": 1}\nnot json\n')).toThrow(/line 2/);
  });

  it('validates the release tag the way botctl validates a version', () => {
    for (const tag of ['v0.4.3', 'v1.0.0-rc.1', 'v2026.10.03_1']) {
      expect(validateReleaseTag(tag), tag).toBeNull();
    }
    for (const tag of [
      '0.4.3',
      'v',
      'v..1',
      'v1/2',
      'v1.0.0\nmain',
      'refs/tags/v1',
      `v${'1'.repeat(64)}`,
    ]) {
      expect(validateReleaseTag(tag), JSON.stringify(tag)).not.toBeNull();
    }
  });
});
