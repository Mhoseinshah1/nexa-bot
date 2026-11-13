import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * CI must not depend on *.ubuntu.com (docs/ci.md, "No dependency on Canonical's mirrors").
 *
 * Canonical's DNS outage on 2026-11-11 turned CI red for hours because jobs ran
 * `apt-get update && apt-get install 7zip` / `apt-get download mysql-…` against the runner's
 * default sources. A workflow cannot be run locally, so the rule is checked on the file: no
 * job step touches apt against the default sources, the 7-Zip install is pinned to a
 * checksum, and the one script that does use apt names its own signed sources.
 */
interface Step {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
}
interface Workflow {
  on: { workflow_dispatch?: { inputs?: Record<string, { type?: string; default?: unknown }> } };
  jobs: Record<string, { steps: Step[] }>;
}

const root = join(__dirname, '../../');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
/** A script's code, without the comment lines that explain what it replaced. */
const code = (path: string): string =>
  read(path)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
const workflow = parse(read('.github/workflows/ci.yml')) as Workflow;

const APT_USE = /\bapt(?:-get)?\s+(?:-\S+\s+)*(?:install|update|download|upgrade|source)\b/u;
const steps = (): { job: string; step: Step }[] =>
  Object.entries(workflow.jobs).flatMap(([job, { steps: list }]) =>
    list.map((step) => ({ job, step })),
  );

describe('CI tool installs do not depend on Canonical', () => {
  it('has no job step that runs apt against the default sources', () => {
    const offenders = steps()
      .filter(({ step }) => APT_USE.test(step.run ?? ''))
      .map(({ job, step }) => `${job}: ${step.name ?? step.run}`);
    expect(offenders, 'a step reaches *.ubuntu.com through apt').toEqual([]);
  });

  it('has no other workflow that does either', () => {
    for (const file of ['release.yml', 'nightly.yml']) {
      expect(read(`.github/workflows/${file}`), file).not.toMatch(APT_USE);
    }
  });

  it('installs 7-Zip from the pinned script in every job that runs the backup suites', () => {
    const jobs = steps()
      .filter(({ step }) => step.name === '7-Zip for the backup archive tests')
      .map(({ job, step }) => ({ job, run: step.run }));
    expect(jobs.map((entry) => entry.job).sort()).toEqual(['integration', 'unit']);
    for (const entry of jobs) expect(entry.run, entry.job).toBe('bash scripts/ci-install-7zip.sh');
  });

  it('pins the 7-Zip tarball to a version, a GitHub release URL and a sha256 it verifies', () => {
    const script = code('scripts/ci-install-7zip.sh');
    expect(script).toMatch(/^VERSION="\d+\.\d+"$/mu);
    expect(script).toMatch(/^SHA256="[0-9a-f]{64}"$/mu);
    expect(script).toContain('https://github.com/ip7z/7zip/releases/download/${VERSION}/');
    expect(script).toContain('sha256sum --check');
    expect(script).toContain('ln -sf 7zz "$DEST/bin/7z"'); // BACKUP_SEVEN_ZIP_BIN defaults to `7z`
    expect(script).not.toMatch(APT_USE);
  });

  it('fetches the MySQL packages through the mirror-fallback script, cached by package list', () => {
    const rehearsal = workflow.jobs['legacy-rehearsal']!.steps;
    const fetch = rehearsal.find((step) => step.name?.startsWith('MySQL 8.0 binaries'));
    expect(fetch?.run).toContain('scripts/ci-fetch-debs.sh');
    expect(fetch?.run).toContain('mysql-server-core-8.0');
    const cache = rehearsal.find((step) => step.name === 'Cache the MySQL 8.0 packages');
    expect(cache?.uses).toMatch(/^actions\/cache@[0-9a-f]{40}$/u);
  });

  it('keeps the fetch script on signed sources of its own, with a non-Canonical fallback', () => {
    const script = code('scripts/ci-fetch-debs.sh');
    expect(script).toContain('signed-by=');
    expect(script).toContain('Dir::Etc::sourcelist=');
    expect(script).toContain('Dir::Etc::sourceparts=');
    expect(script).toContain('mirrors.edge.kernel.org/ubuntu');
    expect(script).not.toMatch(/trusted=yes|allow-unauthenticated|AllowInsecure|--force-yes/iu);
  });

  it('can run the outage drill: both inputs exist, default off, and gate the block step', () => {
    const inputs = workflow.on.workflow_dispatch?.inputs ?? {};
    for (const name of ['block_ubuntu_hosts', 'bypass_tool_cache']) {
      expect(inputs[name]?.type, name).toBe('boolean');
      expect(inputs[name]?.default, name).toBe(false);
    }
    const toolJobs = steps()
      .filter(({ step }) => /ci-install-7zip|ci-fetch-debs/u.test(step.run ?? ''))
      .map(({ job }) => job);
    expect([...new Set(toolJobs)].sort()).toEqual(['integration', 'legacy-rehearsal', 'unit']);
    for (const job of new Set(toolJobs)) {
      const list = workflow.jobs[job]!.steps;
      const block = list.findIndex((step) => step.run === 'bash scripts/ci-block-ubuntu-hosts.sh');
      const install = list.findIndex((step) =>
        /ci-install-7zip|ci-fetch-debs/u.test(step.run ?? ''),
      );
      expect(block, `${job}: the block step comes before the install`).toBeGreaterThanOrEqual(0);
      expect(block).toBeLessThan(install);
      expect(list[block]!.if).toContain('inputs.block_ubuntu_hosts');
    }
    for (const { step } of steps().filter(({ step }) => step.uses?.startsWith('actions/cache@'))) {
      expect(step.if, step.name).toContain('inputs.bypass_tool_cache');
    }
  });
});
